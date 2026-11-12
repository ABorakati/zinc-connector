/*
	zotero-next fork: the save popup (popup/popup.html), the toolbar button's own popup.

	Clicking the button opens the popup, and the popup starts the save at once (what the click did before). Saves started
	another way (context menu, the in-page Zinc button) ask the browser to open the same popup with action.openPopup(); when the
	browser refuses (no focused window, an older browser), upstream's in-page progress window shows instead, as before.

	How it gets the save's progress: the page's scripts report it with Zotero.Messaging.sendMessage("progressWindow.<event>")
	to the tab, through this background worker (common/inject/pageSaving.js -> messages.js "Messaging.sendMessage"). This wraps
	that function: every progressWindow.* event updates the tab's save state here, which is pushed to the open popup(s). While
	a popup owns the save, the event is not passed on to the page, so the in-page window stays hidden.

	What the popup can do with the save (all through the native host, zotero-next connector-host):
	  change the collection   updateSession (the connector call the in-page window uses)
	  Cancel / Remove         cancelSession / trashSession: the session's own items go to the Trash (never deleted)
	  Open in Zinc / item     revealInApp {key, open}
	  Open library            the library page (library/library.html) with the item selected
*/

Zotero.SavePopup = new function () {
	const PORT_NAME = 'zinc-save-popup';
	// A save the popup started but whose page never reported back (nothing to save here)
	const NOTHING_AFTER_MS = 6000;

	/** tabId -> the state of the tab's latest save */
	const states = new Map();
	/** port -> tabId */
	const ports = new Map();

	function newState(tabId, sessionID) {
		return {
			tabId,
			sessionID: sessionID || null,
			startedAt: Date.now(),
			starting: !sessionID, // the popup asked for a save; the page has not answered yet
			nothing: false, // the page never started a save
			owned: false, // the popup shows this save (the in-page window does not)
			headline: '',
			items: [], // progress rows: {id, title, iconSrc, itemType, parentItem, progress}
			done: null, // {ok, error}
			errors: [],
			target: null, // {id, name}
			targets: [],
			sessionCreated: false,
			pendingTarget: null,
			saved: [], // what the host says the session created: {key, title, itemType, attachments}
			cancelled: false,
			removed: null, // keys moved to the Trash by Remove
			busy: null, // 'cancel' | 'remove' | 'target' while a host call runs
			message: null, // last action's result for the popup's status line
			seenDone: false,
		};
	}

	function push(tabId) {
		const s = states.get(tabId);
		if (!s) return;
		for (const [port, t] of ports) {
			if (t !== tabId) continue;
			try {
				port.postMessage({ type: 'state', state: s });
				if (s.done || s.nothing) s.seenDone = true;
			}
			catch (e) {
				ports.delete(port);
			}
		}
	}

	async function host(method, data) {
		const xhr = await Zotero.NativeHost.request('POST', method, {
			body: JSON.stringify(data),
			headers: { 'Content-Type': 'application/json' },
			timeout: 60000
		});
		let json = null;
		try {
			json = xhr.responseText ? JSON.parse(xhr.responseText) : null;
		}
		catch (e) {}
		if (xhr.status >= 400) throw new Error((json && json.error) || `HTTP ${xhr.status}`);
		return json;
	}

	async function loadTargets(s) {
		try {
			const r = await Zotero.Connector.callMethod('getSelectedCollection', { switchToReadableLibrary: true });
			let id = r.id;
			if (!id) id = 'L' + r.libraryID;
			else if (typeof id != 'string') id = 'C' + id;
			s.targets = (r.targets || []).map(t => ({ id: t.id, name: t.name, level: t.level || 0, filesEditable: t.filesEditable }));
			if (!s.target) s.target = { id, name: r.name };
		}
		catch (e) {
			s.errors.push(`Could not load your collections: ${e.message}`);
		}
		push(s.tabId);
	}

	async function refreshSaved(s) {
		if (!s.sessionID) return;
		try {
			const r = await host('sessionItems', { sessionID: s.sessionID });
			s.saved = (r && r.items) || [];
		}
		catch (e) {
			// SESSION_NOT_FOUND: the save has not reached the library (yet)
		}
		push(s.tabId);
	}

	async function applyTarget(s, targetId) {
		s.busy = 'target';
		push(s.tabId);
		try {
			await Zotero.Connector.callMethod('updateSession', { sessionID: s.sessionID, target: targetId, tags: [], note: '' });
			s.message = { kind: 'ok', text: `Moved to ${s.target ? s.target.name : 'the collection'}` };
		}
		catch (e) {
			s.message = { kind: 'error', text: `Could not move it: ${e.message}` };
		}
		finally {
			s.busy = null;
		}
		await refreshSaved(s);
	}

	async function cancelOnHost(s) {
		if (!s.sessionID) return; // asked before the page reported the session: done when it does (onProgress 'show')
		s.busy = 'cancel';
		push(s.tabId);
		try {
			const r = await host('cancelSession', { sessionID: s.sessionID });
			const n = (r && r.trashed && r.trashed.length) || 0;
			s.message = { kind: 'ok', text: n ? `Cancelled: ${n === 1 ? 'the item was' : `${n} items were`} moved to the Trash` : 'Cancelled: nothing was kept' };
		}
		catch (e) {
			s.message = { kind: 'error', text: `Could not cancel: ${e.message}` };
		}
		finally {
			s.busy = null;
		}
		await refreshSaved(s);
	}

	/** Whether the popup shows this new save: one is open for the tab, or the browser opens one now. */
	async function claim(tab) {
		if ([...ports.values()].includes(tab.id)) return true;
		if (!browser.action.openPopup || !tab.active) return false;
		try {
			await browser.action.openPopup({ windowId: tab.windowId });
			return true;
		}
		catch (e) {
			Zotero.debug(`SavePopup: openPopup refused (${e.message}); the in-page window shows the save`);
			return false;
		}
	}

	/** One progressWindow.* event for a tab. Returns true when the popup owns the save (the page is not told). */
	async function onProgress(name, args, tab) {
		const tabId = tab.id;
		let s = states.get(tabId);
		switch (name) {
			case 'progressWindow.show': {
				const [sessionID, headline] = Array.isArray(args) ? args : [];
				if (!s || (sessionID && s.sessionID !== sessionID)) {
					const prev = s;
					s = newState(tabId, sessionID);
					// a Cancel pressed while the popup was still waiting for the page
					if (prev && !prev.sessionID && prev.cancelled) s.cancelled = true;
					states.set(tabId, s);
					s.owned = await claim(tab);
					loadTargets(s);
					if (s.cancelled) cancelOnHost(s);
				}
				s.starting = false;
				if (headline) s.headline = headline;
				break;
			}
			case 'progressWindow.itemProgress': {
				const d = args || {};
				if (!s || (d.sessionID && s.sessionID && d.sessionID !== s.sessionID)) return !!(s && s.owned);
				let row = s.items.find(r => r.id === d.id);
				if (!row) {
					row = { id: d.id };
					s.items.push(row);
				}
				for (const k of ['title', 'iconSrc', 'itemType', 'parentItem', 'progress']) {
					if (d[k] !== undefined) row[k] = d[k];
				}
				break;
			}
			case 'progressWindow.sessionCreated': {
				if (!s) return false;
				s.sessionCreated = true;
				if (s.pendingTarget) {
					const t = s.pendingTarget;
					s.pendingTarget = null;
					applyTarget(s, t);
				}
				refreshSaved(s);
				break;
			}
			case 'progressWindow.done': {
				if (!s) return false;
				const rv = Array.isArray(args) ? args : [args];
				s.done = { ok: !!rv[0], error: rv[0] ? null : (rv[1] || 'translationError') };
				refreshSaved(s);
				break;
			}
			case 'progressWindow.error': {
				if (!s) return false;
				const a = Array.isArray(args) ? args : [args];
				s.errors.push(String(a[0]));
				break;
			}
			case 'progressWindow.setSession': {
				if (s && args) s.sessionID = Array.isArray(args) ? args[0] : args;
				break;
			}
			default:
				break;
		}
		if (!s) return false;
		push(tabId);
		return s.owned;
	}

	// the hook: see the header comment
	const original = Zotero.Messaging.sendMessage.bind(Zotero.Messaging);
	Zotero.Messaging.sendMessage = async function (name, args, tab, frameId) {
		if (typeof name == 'string' && name.startsWith('progressWindow.') && tab && typeof tab == 'object' && tab.id >= 0) {
			let owned = false;
			try {
				owned = await onProgress(name, args, tab);
			}
			catch (e) {
				Zotero.logError(e);
			}
			if (owned) return name == 'progressWindow.show' ? true : undefined;
		}
		return original.apply(null, arguments);
	};

	async function tabFor(tabId) {
		if (typeof tabId == 'number') return browser.tabs.get(tabId);
		const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
		return tab;
	}

	async function onCommand(port, msg) {
		const tabId = ports.get(port);
		const s = states.get(tabId);
		switch (msg.cmd) {
			case 'init': {
				const tab = await tabFor(msg.tabId);
				if (!tab) {
					port.postMessage({ type: 'state', state: Object.assign(newState(-1, null), { starting: false, nothing: true }) });
					return;
				}
				ports.set(port, tab.id);
				port.postMessage({ type: 'tab', tab: { id: tab.id, title: tab.title, url: tab.url } });
				const cur = states.get(tab.id);
				// a save still running, or one whose result nobody has seen yet: show it instead of saving again
				if (cur && !cur.nothing && (msg.save === false || !cur.done || !cur.seenDone)) {
					cur.owned = true;
					push(tab.id);
					return;
				}
				const fresh = newState(tab.id, null);
				fresh.owned = true;
				states.set(tab.id, fresh);
				push(tab.id);
				if (msg.save === false) {
					fresh.starting = false;
					fresh.nothing = true;
					push(tab.id);
					return;
				}
				try {
					await Zotero.Connector_Browser.onZoteroButtonElementClick(tab);
				}
				catch (e) {
					fresh.errors.push(e.message);
				}
				setTimeout(() => {
					if (states.get(tab.id) === fresh && fresh.starting) {
						fresh.starting = false;
						fresh.nothing = true;
						push(tab.id);
					}
				}, NOTHING_AFTER_MS);
				return;
			}
			case 'setTarget': {
				if (!s) return;
				const t = s.targets.find(x => x.id === msg.id);
				if (!t) return;
				s.target = { id: t.id, name: t.name };
				if (s.sessionCreated || s.done) await applyTarget(s, t.id);
				else {
					s.pendingTarget = t.id;
					push(tabId);
				}
				return;
			}
			case 'cancel': {
				if (!s || s.cancelled) return;
				s.cancelled = true;
				push(tabId);
				await cancelOnHost(s);
				return;
			}
			case 'remove': {
				if (!s || !s.sessionID) return;
				s.busy = 'remove';
				push(tabId);
				try {
					const r = await host('trashSession', { sessionID: s.sessionID });
					s.removed = (r && r.trashed) || [];
					const n = s.removed.length;
					s.message = { kind: 'ok', text: n ? `Removed: ${n === 1 ? 'the item is' : `${n} items are`} in the Trash` : 'Nothing to remove' };
				}
				catch (e) {
					s.message = { kind: 'error', text: `Could not remove: ${e.message}` };
				}
				finally {
					s.busy = null;
				}
				await refreshSaved(s);
				return;
			}
			case 'openLibrary':
				await Zotero.Connector_Browser.openLibrary(msg.key);
				return;
			case 'openInZinc': {
				try {
					const r = await host('revealInApp', { key: msg.key, open: !!msg.open });
					port.postMessage({ type: 'result', ok: true, started: !!(r && r.started), opened: r && r.opened });
				}
				catch (e) {
					port.postMessage({ type: 'result', ok: false, error: e.message });
				}
				return;
			}
		}
	}

	browser.runtime.onConnect.addListener(port => {
		if (port.name !== PORT_NAME) return;
		ports.set(port, null);
		port.onMessage.addListener(msg => {
			onCommand(port, msg || {}).catch(e => Zotero.logError(e));
		});
		port.onDisconnect.addListener(() => ports.delete(port));
	});

	browser.tabs.onRemoved.addListener(tabId => states.delete(tabId));

	/** Tests and diagnostics */
	this._states = states;
};

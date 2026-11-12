/*
	zotero-next fork: the save popup's page. All state lives in the background (savePopup.js); this page renders it and sends
	commands over a port. ?tab=<id> shows the save of that tab instead of the active one (the headless check uses it), and
	?save=0 only shows, without starting a save.
*/
(function () {
	'use strict';
	const $ = (id) => document.getElementById(id);
	const params = new URLSearchParams(location.search);
	const RECENT_KEY = 'zincRecentTargets';
	const RECENT_MAX = 5;

	let state = null;
	let recent = [];
	let lastResult = null;
	let focusIndex = -1;

	const port = chrome.runtime.connect({ name: 'zinc-save-popup' });
	const send = (msg) => port.postMessage(msg);
	port.onMessage.addListener((msg) => {
		if (msg.type === 'state') {
			state = msg.state;
			render();
		}
		else if (msg.type === 'result') {
			lastResult = msg.ok
				? { kind: 'ok', text: msg.started ? 'Zinc is starting; it will show the item' : msg.opened ? 'Opened in Zinc' : 'Shown in Zinc' }
				: { kind: 'error', text: msg.error };
			render();
		}
	});
	const tabParam = params.get('tab');
	send({ cmd: 'init', tabId: tabParam ? Number(tabParam) : undefined, save: params.get('save') !== '0' });

	chrome.storage.local.get(RECENT_KEY).then((r) => {
		recent = Array.isArray(r[RECENT_KEY]) ? r[RECENT_KEY] : [];
		render();
	});

	// ---- helpers
	const el = (tag, cls, text) => {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	};
	const icon = (name, extra) => el('i', `i i-${name}${extra ? ' ' + extra : ''}`);
	const plural = (n, one, many) => (n === 1 ? one : many.replace('#', n));

	function itemIcon(row) {
		const t = String(row.itemType || '');
		if (row.parentItem) {
			if (/pdf/i.test(t) || /pdf/i.test(row.title || '')) return 'file';
			if (/snapshot|html|webpage/i.test(t) || /snapshot/i.test(row.title || '')) return 'globe';
			return 'paperclip';
		}
		if (/^book/.test(t)) return 'book';
		if (/webpage|blogPost|forumPost/.test(t)) return 'globe';
		return 'file-text';
	}

	const ERRORS = {
		translationError: 'The page could not be read. Try again, or save it as a web page from the right-click menu.',
		clientRequired: 'Zinc could not be reached. Check that the Zinc Connector host is installed, or save to this browser.',
		noTranslator: 'Nothing on this page can be saved.',
		upgradeClient: 'This page needs a newer Zinc.',
	};
	const errorText = (e) => ERRORS[e] || (typeof e === 'string' && e.length < 200 ? e : 'The save failed.');

	/** The targets as rows, each with the path of its parents (for search results). */
	function targetRows() {
		const out = [];
		const stack = [];
		for (const t of (state && state.targets) || []) {
			stack.length = t.level;
			out.push({ ...t, path: stack.filter(Boolean).join(' / ') });
			stack[t.level] = t.name;
		}
		return out;
	}

	function savedKey() {
		return state && state.saved && state.saved[0] ? state.saved[0].key : null;
	}
	function openable() {
		const s = state && state.saved && state.saved[0];
		const a = s && (s.attachments || []).find((x) => /pdf|epub|html/i.test(x.contentType || '') && x.linkMode !== 'linked_url');
		return a ? (/pdf/i.test(a.contentType) ? 'Open PDF' : /epub/i.test(a.contentType) ? 'Open EPUB' : 'Open snapshot') : 'Open item';
	}

	// ---- rendering
	function render() {
		if (!state) return;
		const s = state;
		const removed = !!(s.removed && s.removed.length);
		const target = s.target ? s.target.name : 'My Library';

		// status
		const status = $('status');
		const sIcon = $('status-icon');
		let cls = 'working', ic = 'loader-circle', head = `Saving to ${target}…`, sub = s.headline && !/^Saving/i.test(s.headline) ? s.headline : '';
		if (s.busy === 'cancel') { head = 'Cancelling…'; sub = ''; }
		else if (s.cancelled) { cls = 'muted'; ic = 'ban'; head = 'Cancelled'; sub = (s.message && s.message.text.replace(/^Cancelled: (.)/, (_, c) => c.toUpperCase())) || ''; }
		else if (removed) { cls = 'muted'; ic = 'trash-2'; head = 'Removed'; sub = 'Moved to the Trash. You can restore it from the Trash in Zinc.'; }
		else if (s.nothing && !s.sessionID) { cls = 'muted'; ic = 'circle-alert'; head = 'Nothing to save on this page'; sub = s.errors[0] || 'You can still open your library.'; }
		else if (s.done && !s.done.ok) { cls = 'error'; ic = 'circle-alert'; head = 'Could not save'; sub = errorText(s.done.error); }
		else if (s.done && s.done.ok) {
			cls = 'ok'; ic = 'check'; head = `Saved to ${target}`;
			const n = (s.saved || []).length;
			sub = n ? plural(n, 'One item added to your library', '# items added to your library') : '';
		}
		else if (s.starting) { head = 'Starting…'; }
		status.className = `status ${cls}`;
		sIcon.className = `i status-icon i-${ic}${ic === 'loader-circle' ? ' spin' : ''}`;
		$('headline').textContent = head;
		$('sub').textContent = sub;

		// items
		const list = $('items');
		list.textContent = '';
		const tops = s.items.filter((r) => !r.parentItem);
		for (const top of tops) {
			list.append(itemRow(top, false, removed || s.cancelled));
			for (const child of s.items.filter((r) => r.parentItem === top.id && r.progress !== -1)) list.append(itemRow(child, true, removed || s.cancelled));
		}

		// collection picker
		const noSession = (s.nothing && !s.sessionID) || s.cancelled || removed;
		$('folder').hidden = !!(s.nothing && !s.sessionID);
		$('picker').disabled = noSession || s.busy === 'target';
		$('picker-name').textContent = s.busy === 'target' ? `Moving to ${target}…` : target;
		$('picker-icon').className = `i ${s.target && /^L/.test(s.target.id) ? 'i-library-big' : 'i-folder'}`;
		if (noSession) closeChooser();
		if (!$('chooser').hidden) renderChooser();

		// where this save goes: the Zinc app or this browser's own library
		const lib = s.library === 'browser' ? 'browser' : 'app';
		$('target-name').textContent = lib === 'browser' ? (s.viaBrowser ? 'This browser (this save only)' : 'This browser') : 'Zinc app';
		const setting = s.viaBrowser ? 'app' : lib;
		for (const b of document.querySelectorAll('.target-opt')) b.setAttribute('aria-checked', String(b.dataset.target === setting));
		$('host-down').hidden = !(lib === 'app' && s.hostDown && !removed && !s.cancelled);

		// actions
		const key = savedKey();
		// there is no app to show an item in, when it was saved to this browser
		$('open-item').hidden = lib === 'browser';
		$('open-zinc').hidden = lib === 'browser';
		const ready = !!key && !removed && !s.cancelled;
		$('open-item').disabled = !ready;
		$('open-item').lastChild.textContent = ready ? openable() : 'Open item';
		$('open-zinc').disabled = !ready;
		$('open-library').classList.toggle('primary', ready);

		// footer
		$('cancel').hidden = !!(s.done || s.cancelled || removed || (s.nothing && !s.sessionID));
		$('cancel').disabled = !!s.busy;
		$('remove').hidden = !(s.done && s.done.ok && (s.saved || []).length && !removed && !s.cancelled);
		$('remove').disabled = !!s.busy;
		const m = lastResult || (s.cancelled || removed ? null : s.message);
		$('message').textContent = m ? m.text : '';
		$('message').className = `message${m ? ' ' + m.kind : ''}`;
	}

	function itemRow(r, child, struck) {
		const li = el('li', `item${child ? ' child' : ''}${r.progress === false ? ' failed' : ''}${struck ? ' removed' : ''}`);
		li.append(icon(itemIcon(r)), el('span', 't', r.title || (child ? 'Attachment' : 'Item')));
		const p = r.progress;
		if (p === false) li.append(el('span', 'pct', 'failed'));
		else if (p === 100 || p === undefined) li.append(child || p === 100 ? icon('check') : el('span'));
		else if (typeof p === 'number' && p >= 0) {
			li.append(el('span', 'pct', `${Math.round(p)}%`));
			const bar = el('div', 'bar');
			const fill = el('span');
			fill.style.width = `${Math.max(4, p)}%`;
			bar.append(fill);
			li.append(bar);
		}
		else li.append(el('span'));
		return li;
	}

	// ---- collection chooser
	function openChooser() {
		$('chooser').hidden = false;
		$('picker').setAttribute('aria-expanded', 'true');
		$('search').value = '';
		focusIndex = -1;
		renderChooser();
		$('search').focus();
	}
	function closeChooser() {
		$('chooser').hidden = true;
		$('picker').setAttribute('aria-expanded', 'false');
	}
	function choose(id) {
		const t = ((state && state.targets) || []).find((x) => x.id === id);
		if (!t) return;
		recent = [id, ...recent.filter((x) => x !== id)].slice(0, RECENT_MAX);
		chrome.storage.local.set({ [RECENT_KEY]: recent });
		lastResult = null;
		send({ cmd: 'setTarget', id });
		closeChooser();
	}

	function renderChooser() {
		const q = $('search').value.trim().toLowerCase();
		const rows = targetRows();
		const current = state.target && state.target.id;

		const chips = $('recent-chips');
		chips.textContent = '';
		const recentRows = q ? [] : recent.map((id) => rows.find((r) => r.id === id)).filter((r) => r && r.id !== current).slice(0, 4);
		for (const r of recentRows) {
			const b = el('button', 'chip');
			b.title = r.path ? `${r.path} / ${r.name}` : r.name;
			b.append(icon(/^L/.test(r.id) ? 'library-big' : 'folder'), el('span', '', r.name));
			b.addEventListener('click', () => choose(r.id));
			chips.append(b);
		}
		$('recent').hidden = !recentRows.length;

		const tree = $('tree');
		tree.textContent = '';
		const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : rows;
		if (!shown.length) tree.append(el('li', 'empty', rows.length ? 'No collection matches' : 'Loading collections…'));
		shown.forEach((r, i) => {
			const li = el('li', `row${i === focusIndex ? ' focus' : ''}`);
			li.setAttribute('role', 'option');
			li.setAttribute('aria-selected', String(r.id === current));
			li.dataset.id = r.id;
			if (!q) li.style.paddingLeft = `${8 + r.level * 14}px`;
			li.append(icon(/^L/.test(r.id) ? 'library-big' : 'folder'));
			const name = el('span', 'n', r.name);
			li.append(name);
			if (q && r.path) li.append(el('span', 'path', r.path));
			if (r.id === current) li.append(icon('check', 'tick'));
			li.addEventListener('click', () => choose(r.id));
			tree.append(li);
		});
		const f = tree.querySelector('.row.focus') || tree.querySelector('.row[aria-selected="true"]');
		if (f) f.scrollIntoView({ block: 'nearest' });
	}

	// ---- events
	// a real popup closes once a tab opens; opened as a tab (?tab=, the headless check) it stays
	const closeSoon = () => { if (!tabParam) setTimeout(() => window.close(), 150); };
	$('picker').addEventListener('click', () => ($('chooser').hidden ? openChooser() : closeChooser()));
	$('search').addEventListener('input', () => { focusIndex = 0; renderChooser(); });
	$('search').addEventListener('keydown', (e) => {
		const rows = [...$('tree').querySelectorAll('.row')];
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			focusIndex = Math.max(0, Math.min(rows.length - 1, focusIndex + (e.key === 'ArrowDown' ? 1 : -1)));
			renderChooser();
		}
		else if (e.key === 'Enter') {
			const r = rows[Math.max(0, focusIndex)];
			if (r) choose(r.dataset.id);
		}
		else if (e.key === 'Escape') {
			e.preventDefault();
			closeChooser();
			$('picker').focus();
		}
	});
	const closeTargetMenu = () => { $('target-menu').hidden = true; $('target-change').setAttribute('aria-expanded', 'false'); };
	$('target-change').addEventListener('click', () => {
		const open = $('target-menu').hidden;
		$('target-menu').hidden = !open;
		$('target-change').setAttribute('aria-expanded', String(open));
	});
	for (const b of document.querySelectorAll('.target-opt')) {
		b.addEventListener('click', () => { lastResult = null; send({ cmd: 'setSaveTarget', target: b.dataset.target }); closeTargetMenu(); });
	}
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('target-menu').hidden) { e.preventDefault(); closeTargetMenu(); $('target-change').focus(); } });
	// Zinc app not answering: this save goes to the browser, the setting stays
	$('save-in-browser').addEventListener('click', () => { lastResult = null; send({ cmd: 'saveToBrowserOnce' }); });
	$('cancel').addEventListener('click', () => send({ cmd: 'cancel' }));
	$('remove').addEventListener('click', () => send({ cmd: 'remove' }));
	$('open-library').addEventListener('click', () => { send({ cmd: 'openLibrary', key: savedKey() }); closeSoon(); });
	$('open-library-top').addEventListener('click', () => { send({ cmd: 'openLibrary', key: savedKey() }); closeSoon(); });
	$('open-zinc').addEventListener('click', () => { lastResult = { kind: '', text: 'Asking Zinc…' }; render(); send({ cmd: 'openInZinc', key: savedKey(), open: false }); });
	$('open-item').addEventListener('click', () => { lastResult = { kind: '', text: 'Asking Zinc…' }; render(); send({ cmd: 'openInZinc', key: savedKey(), open: true }); });

	// for the headless check
	window.znPopup = { get state() { return state; } };
})();

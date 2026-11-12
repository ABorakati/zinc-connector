/*
	zotero-next fork: transport to the "zotero-next host" native-messaging program.

	Upstream talks to the Zotero client over HTTP on 127.0.0.1:23119 (Zotero.Connector.callMethod ->
	Zotero.HTTP.request). This fork sends the same calls over Chrome native messaging
	(chrome.runtime.connectNative) to a small program that answers them against the zotero-next library, so
	neither Zotero nor the zotero-next app has to be running.

	Protocol (JSON messages, each direction):
	  -> {t:"req", id, method, http, query, headers, body}   body: {kind:"text",text} | {kind:"upload",uid}
	                                                              | {kind:"form",fields}
	                                                         form field: {text} | {b64,type?} (protocol 1)
	                                                              | {upload:uid, type?, asText?} (protocol 2)
	  -> {t:"up", uid, seq, last, data}                      base64 upload chunk (a body bigger than UPLOAD_CHUNK)
	  -> {t:"drop", uid}                                     forget an upload (the request timed out / failed)
	  <- {t:"res", id, status, headers, n}                   then n x
	  <- {t:"rc", id, seq, data}                             base64 body chunk (host->extension messages are
	                                                         limited to 1 MB by Chrome)
	  -> {t:"hello", id} / <- {t:"hello", id, version, db, proto}   diagnostics, and the protocol level of the host

	The port stays open while the service worker lives (an open native port keeps an MV3 worker alive), which is
	also what keeps the host's in-memory save sessions around between saveItems -> saveAttachment -> updateSession
	(the host additionally persists them, so a restarted host still knows them).

	Failure modes, as callMethod sees them:
	  status 0   the host cannot be started (not installed / not allowed): upstream's "client is offline", which
	             callers answer with the "is Zotero running" prompt (or saving to zotero.org)
	  status 502 the host died while a call was in flight: NOT "offline" (so a save is not sent to zotero.org),
	             error.value.error == 'HOST_CRASHED'
	  status 503 the library is busy (another program holds the write lock)
	Calls that only read (IDEMPOTENT) are retried once, after a reconnect, on 502 / 503.

	One library per computer (zotero-next docs/design/browser-edition.md, section 6). Which library a call goes to is
	the "save target", worked out from whether the app's native host is registered. It is not a stored choice:
	  app installed (the host answers)                         -> "app"
	  Chrome: "Specified native messaging host not found"      -> "browser" (the library in this browser, an
	      offscreen document answering extension ports named "zinc-db"; created empty the first time it is needed)
	  the host is registered but fails (crashes, busy)         -> still "app": the call fails with the host's
	      message, and nothing goes to the browser library. The popup offers Try again.
	The target is looked up when the browser starts and before each save (refreshTarget); other calls reuse the
	last answer for TARGET_TTL. A save session keeps the library it started in. Installing the app switches the
	extension to it, and uninstalling switches back.
	When the app is installed and the browser library holds items, moveBrowserLibrary() exports the browser library
	(the Export library zip), has the host merge it into the app's library (importBrowserLibrary), and, when that
	succeeded, empties the browser library. chrome.storage.local "zincBrowserLibrary" keeps {firstRunDone} for the
	library tab's welcome screen; "zincBrowserLibraryCreated" says the browser library exists.
	In browser mode getTranslators / getTranslatorCode fail locally (status 0, "no client"), so Zotero.Repo loads
	translators from repo.zotero.org, as upstream does when no Zotero client is running.
*/

Zotero.NativeHost = new function() {
	const HOST_NAME = 'com.zotero_next.connector_host';
	// Headless checks (zotero-next gpui-ui/web/popup-check.ts) point a test profile at a host registered under its own name,
	// so they never start the installed host or open the real library. See useHostForTests().
	let hostName = HOST_NAME;
	// Raw bytes per upload message. Chrome allows 64 MB per message to a host, but one port is one queue: a 20 MB
	// PDF posted as one burst makes every other call (ping, a save in another tab) wait behind it. So big bodies go
	// in small pieces, with a turn of the event loop between them for other calls to slip in.
	const UPLOAD_CHUNK = 1024 * 1024;
	// A string body up to this many characters goes in the request message itself (4 bytes/char < UPLOAD_CHUNK)
	const INLINE_TEXT_CHARS = UPLOAD_CHUNK / 4;
	// Extra time per MB uploaded on top of the call's own timeout, and the "no activity for this long" rule
	const MS_PER_UPLOAD_MB = 1000;
	// Calls without side effects: safe to send twice
	const IDEMPOTENT = new Set(['ping', 'getSelectedCollection', 'getClientHostnames', 'proxies',
		'getTranslators', 'getTranslatorCode', 'hasAttachmentResolvers', 'getRecognizedItem']);
	// ping is sent on every tab update: reuse an answer this fresh
	const PING_TTL = 5000;
	const RETRY_DELAY = 250;

	const LIBRARY_KEY = 'zincBrowserLibrary';
	const CREATED_KEY = 'zincBrowserLibraryCreated';
	const DB_PORT_NAME = 'zinc-db';
	// The browser library does not serve these (it answers 404): translators come from repo.zotero.org
	const NOT_IN_BROWSER_LIBRARY = new Set(['getTranslators', 'getTranslatorCode']);
	const OFFSCREEN_URL = 'offscreen/offscreen.html';
	// A save starts with one of these: the target is looked up again then (the user may have installed the app a minute ago)
	const SAVE_STARTING = new Set(['saveItems', 'saveSnapshot', 'saveStandaloneAttachment', 'import']);
	// Other calls reuse the last answer this long
	const TARGET_TTL = 30000;
	const MAX_SESSION_ROUTES = 200;

	// One channel per destination. port: the open chrome.runtime port; spoke: true once the current port has
	// delivered anything (a disconnect after that is a crash, not "not installed")
	const channels = {
		app: { route: 'app', port: null, spoke: false, protoPromise: null },
		browser: { route: 'browser', port: null, spoke: false, protoPromise: null, ready: null },
	};
	let nextId = 1;
	// id -> {resolve, reject, res, chunks, received, timer, timeout, uids, channel}
	const pending = new Map();
	let pingCache = null; // {key, at, promise}

	// ---- the save target
	let target = null; // {value: 'app' | 'browser', at, hostError: string | null}
	let targetPromise = null;
	// sessionID -> 'app' | 'browser': the library a save session started in
	const sessionRoutes = new Map();
	let moving = null; // the move in progress
	let createdFlag = null; // what this worker last wrote to CREATED_KEY (null: not written yet)

	const hasNativeBase64 = typeof Uint8Array.prototype.toBase64 == 'function';
	const hasNativeFromBase64 = typeof Uint8Array.fromBase64 == 'function';

	function bytesToBase64(bytes) {
		if (hasNativeBase64) return bytes.toBase64();
		let binary = '';
		const step = 0x8000;
		for (let i = 0; i < bytes.length; i += step) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
		}
		return btoa(binary);
	}

	function base64ToBytes(b64) {
		if (hasNativeFromBase64) return Uint8Array.fromBase64(b64);
		const binary = atob(b64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	/**
	 * SingleFile's 'binary-*' form entries are bytes that went through extension messaging: usually a plain
	 * {0: b, 1: b, ...} object (or an array), sometimes already a typed array.
	 */
	function toBytes(v) {
		if (v instanceof Uint8Array) return v;
		if (v instanceof ArrayBuffer) return new Uint8Array(v);
		if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
		if (Array.isArray(v)) return Uint8Array.from(v);
		let n = 0;
		for (let k in v) n++;
		let bytes = new Uint8Array(n);
		let i = 0;
		for (let k in v) bytes[i++] = v[k];
		return bytes;
	}

	function failAll(error, channel) {
		for (let [id, p] of [...pending]) {
			if (p.channel !== channel) continue;
			clearTimeout(p.timer);
			pending.delete(id);
			p.reject(error);
		}
	}

	function connect(channel) {
		if (channel.port) return channel.port;
		let browserMode = channel.route == 'browser';
		let thePort = channel.port = browserMode
			? chrome.runtime.connect({ name: DB_PORT_NAME })
			: chrome.runtime.connectNative(hostName);
		channel.spoke = false;
		channel.protoPromise = null;
		thePort.onMessage.addListener(function (msg) {
			if (thePort !== channel.port) return;
			channel.spoke = true;
			onMessage(msg);
		});
		thePort.onDisconnect.addListener(function () {
			let message = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'disconnected';
			Zotero.debug(`NativeHost: ${channel.route} disconnected (${message})`);
			let spoke = channel.spoke;
			if (thePort === channel.port) {
				channel.port = null;
				channel.protoPromise = null;
				channel.ready = null;
				pingCache = null;
			}
			else {
				return;
			}
			let who = browserMode ? 'Zinc browser library' : 'Zinc host';
			let neverStarts = /not found|forbidden|not allowed|receiving end/i.test(message);
			let calls = [...pending.values()].filter(p => p.channel === channel).length;
			if (spoke && !neverStarts && calls) {
				// The host was running and died with calls in flight. Not "offline": see the header comment.
				failAll(new Zotero.Connector.CommunicationError(
					`${who} stopped unexpectedly (${message}). Your save may not have completed: check Zinc.`,
					502, { error: 'HOST_CRASHED' }), channel);
			}
			else {
				// status 0 is what a dead HTTP connection gave upstream: callers treat it as "Zotero is offline"
				let error = new Zotero.Connector.CommunicationError(`${who} is not available: ${message}`, 0);
				// Chrome: "Specified native messaging host not found." = the app is not installed (nothing is registered).
				// Anything else (forbidden, "Native host has exited") is a host that is there and does not work.
				error.notInstalled = !browserMode && /host not found/i.test(message);
				failAll(error, channel);
			}
		});
		return thePort;
	}

	function arm(p, id) {
		clearTimeout(p.timer);
		if (!p.timeout) return;
		p.timer = setTimeout(function () {
			if (!pending.delete(id)) return;
			dropUploads(p.uids, p.channel);
			p.reject(new Zotero.Connector.CommunicationError(`Zinc host request timed out after ${p.timeout} ms without a response`, 0));
		}, p.timeout);
	}

	function onMessage(msg) {
		let p = pending.get(msg.id);
		if (!p) return;
		// any sign of life from the host restarts the clock: a big response is slow, not stuck
		if (msg.t == 'res' || msg.t == 'rc') arm(p, msg.id);
		if (msg.t == 'res') {
			p.res = msg;
			if (!msg.n) finish(msg.id);
		}
		else if (msg.t == 'rc') {
			p.chunks[msg.seq] = base64ToBytes(msg.data);
			p.received++;
			if (p.received == p.res.n) finish(msg.id);
		}
		else if (msg.t == 'hello') {
			clearTimeout(p.timer);
			pending.delete(msg.id);
			p.resolve(msg);
		}
	}

	function finish(id) {
		let p = pending.get(id);
		clearTimeout(p.timer);
		pending.delete(id);
		let bytes;
		if (p.chunks.length == 1) {
			bytes = p.chunks[0];
		}
		else {
			let size = p.chunks.reduce((n, c) => n + c.length, 0);
			bytes = new Uint8Array(size);
			let offset = 0;
			for (let c of p.chunks) {
				bytes.set(c, offset);
				offset += c.length;
			}
		}
		let responseText = bytes.length && !p.binary ? new TextDecoder().decode(bytes) : '';
		let headers = {};
		for (let k in p.res.headers) headers[k.toLowerCase()] = p.res.headers[k];
		// The slice of XMLHttpRequest / Zotero.HTTP.request's result that callMethod uses
		p.resolve({
			status: p.res.status,
			response: responseText,
			responseText,
			responseBytes: bytes,
			getResponseHeader: name => headers[name.toLowerCase()] ?? null,
			getAllResponseHeaders: () => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
		});
	}

	/** Tell the host to forget uploads nobody will claim (it also expires them itself after a while) */
	function dropUploads(uids, channel) {
		if (!channel.port || !uids || !uids.length) return;
		for (let uid of uids) {
			try {
				channel.port.postMessage({ t: 'drop', uid });
			}
			catch (e) {}
		}
	}

	/**
	 * @param {Object} msg - the message to send (gets an id)
	 * @param {Number|false} timeout - ms without any sign of life from the host; false for none
	 * @param {String[]} uids - uploads this request refers to (dropped if it fails)
	 * @param {Object} channel - channels.app | channels.browser
	 */
	function roundTrip(msg, timeout, uids, channel, binary) {
		uids = uids || [];
		return new Promise(function (resolve, reject) {
			let id = nextId++;
			let p = { resolve, reject, res: null, chunks: [], received: 0, timer: null, timeout, uids, channel, binary: !!binary };
			pending.set(id, p);
			arm(p, id);
			try {
				connect(channel).postMessage({ ...msg, id });
			}
			catch (e) {
				clearTimeout(p.timer);
				pending.delete(id);
				dropUploads(uids, channel);
				reject(new Zotero.Connector.CommunicationError(`Zinc host is not available: ${e.message}`, 0));
			}
		});
	}

	const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

	async function postUpload(thePort, uid, bytes) {
		let chunks = Math.max(1, Math.ceil(bytes.length / UPLOAD_CHUNK));
		for (let i = 0; i < chunks; i++) {
			if (i > 0) await yieldToEventLoop();
			thePort.postMessage({
				t: 'up',
				uid,
				seq: i,
				last: i == chunks - 1,
				// subarray: a view, no copy
				data: bytesToBase64(chunks == 1 ? bytes : bytes.subarray(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK))
			});
		}
	}

	/** The protocol level of the host (1: no upload form fields). Asked once per connection. */
	function hostProto(channel) {
		if (!channel.protoPromise) {
			// The browser library may not answer hello: short wait, then the plain (level 1) body encoding
			channel.protoPromise = roundTrip({ t: 'hello' }, channel.route == 'browser' ? 2000 : 5000, [], channel)
				.then(m => m.proto || 1, () => 1);
		}
		return channel.protoPromise;
	}

	/** Builds the wire body, sending big pieces as upload frames first. */
	async function encodeBody(body, headers, uids, channel) {
		if (body === null || body === undefined) return { wireBody: undefined, size: 0 };
		let size = 0;
		let newUid = () => {
			let uid = `u${Date.now().toString(36)}${nextId++}`;
			uids.push(uid);
			return uid;
		};
		if (headers['Content-Type'] == 'multipart/form-data') {
			// body is the plain {name: value} object callMethod was given (SingleFile 'binary-*' entries are bytes)
			let proto = await hostProto(channel);
			let thePort = connect(channel);
			let fields = {};
			for (let name in body) {
				let v = body[name];
				if (name.startsWith('binary-')) {
					let bytes = toBytes(v);
					size += bytes.length;
					if (proto >= 2) {
						let uid = newUid();
						await postUpload(thePort, uid, bytes);
						fields[name] = { upload: uid };
					}
					else {
						fields[name] = { b64: bytesToBase64(bytes) };
					}
				}
				else {
					let text = typeof v == 'string' ? v : JSON.stringify(v);
					size += text.length;
					if (proto >= 2 && text.length > INLINE_TEXT_CHARS) {
						let uid = newUid();
						await postUpload(thePort, uid, new TextEncoder().encode(text));
						fields[name] = { upload: uid, asText: true };
					}
					else {
						fields[name] = { text };
					}
				}
			}
			return { wireBody: { kind: 'form', fields }, size };
		}
		if (typeof body == 'string' && body.length <= INLINE_TEXT_CHARS) {
			// the common case (JSON): no TextEncoder pass, no copy
			return { wireBody: { kind: 'text', text: body }, size: body.length };
		}
		let bytes = typeof body == 'string'
			? new TextEncoder().encode(body)
			: (body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
		let uid = newUid();
		await postUpload(connect(channel), uid, bytes);
		return { wireBody: { kind: 'upload', uid }, size: bytes.length };
	}

	async function send(httpMethod, method, options, channel) {
		let { body, headers = {}, queryString = '', timeout = 15000, path, binary } = options;
		let browserMode = channel.route == 'browser';
		if (browserMode) await ensureBrowserLibrary();
		let uids = [];
		let wireBody, size;
		try {
			({ wireBody, size } = await encodeBody(body, headers, uids, channel));
		}
		catch (e) {
			dropUploads(uids, channel);
			if (e instanceof Zotero.Connector.CommunicationError) throw e;
			throw new Zotero.Connector.CommunicationError(`Zinc host is not available: ${e.message}`, 0);
		}
		// The timeout counts from the last sign of life, but sending a big body takes the host time too
		if (timeout) timeout += Math.ceil(size / (1024 * 1024)) * MS_PER_UPLOAD_MB;
		let xhr = await roundTrip({
			t: 'req',
			method,
			http: httpMethod,
			// `path`: the "api" method (the library tab's own /api requests); the other methods have none
			...(path ? { path } : {}),
			query: queryString.replace(/^\?/, ''),
			headers,
			body: wireBody
		}, timeout, uids, channel, binary);
		return browserMode && method == 'ping' ? withoutTranslatorHashes(xhr) : xhr;
	}

	/**
	 * Browser mode: there is no translator list to compare with. A hash in the ping answer would make the
	 * connector re-load translators from the repository on every ping, so it is dropped.
	 */
	function withoutTranslatorHashes(xhr) {
		try {
			let json = JSON.parse(xhr.responseText);
			if (json && json.prefs && (json.prefs.translatorsHash || json.prefs.sortedTranslatorHash)) {
				delete json.prefs.translatorsHash;
				delete json.prefs.sortedTranslatorHash;
				let text = JSON.stringify(json);
				return { ...xhr, response: text, responseText: text };
			}
		}
		catch (e) {}
		return xhr;
	}

	const isTransient = e => e instanceof Zotero.Connector.CommunicationError && e.status == 502;

	// ---- the save target (see the header comment)

	const storage = () => (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;
	const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

	/**
	 * Asks the app's host. {state: 'ok'}: it answers. {state: 'missing'}: Chrome has no such host registered, so the app
	 * is not installed. {state: 'failed', message}: it is registered and does not work (it exits at once, is forbidden,
	 * does not answer in time).
	 */
	async function probeHost() {
		try {
			let xhr = await send('GET', 'ping', { timeout: 5000 }, channels.app);
			return xhr.status > 0 ? { state: 'ok' } : { state: 'failed', message: 'The Zinc app did not answer.' };
		}
		catch (e) {
			if (e && e.notInstalled) return { state: 'missing' };
			return { state: 'failed', message: e && e.message ? e.message : 'The Zinc app did not answer.' };
		}
	}

	/** Looks the target up now. Calls that ask at the same time share one probe. */
	function lookUpTarget() {
		if (!targetPromise) {
			targetPromise = (async function () {
				let r = await probeHost();
				let previous = target && target.value;
				target = {
					value: r.state == 'missing' ? 'browser' : 'app',
					at: Date.now(),
					hostError: r.state == 'failed' ? r.message : null
				};
				if (previous && previous != target.value) {
					pingCache = null;
					Zotero.debug(`NativeHost: saving to ${target.value == 'app' ? 'the Zinc app' : 'this browser'} now`);
				}
				return target;
			})();
			targetPromise.then(() => { targetPromise = null; }, () => { targetPromise = null; });
		}
		return targetPromise;
	}

	/** {value: 'app' | 'browser', hostError}. `fresh`: ask the host again instead of using an answer from the last TARGET_TTL. */
	async function getTarget(fresh) {
		if (!fresh && target && Date.now() - target.at < TARGET_TTL) return target;
		// An open port to the host that has answered is the proof already: the host is registered and running
		let app = channels.app;
		if (app.port && app.spoke) {
			target = { value: 'app', at: Date.now(), hostError: null };
			return target;
		}
		return lookUpTarget();
	}

	/** Earlier builds stored a choice ("saveTarget"); there is none now: the host decides. firstRunDone stays. */
	async function dropStoredChoice() {
		let st = storage();
		if (!st) return;
		let stored = (await st.get(LIBRARY_KEY))[LIBRARY_KEY];
		if (stored && typeof stored == 'object' && 'saveTarget' in stored) {
			let { saveTarget, ...rest } = stored;
			await st.set({ [LIBRARY_KEY]: rest });
		}
	}
	dropStoredChoice().catch(e => Zotero.debug(`NativeHost: ${e.message}`));

	function rememberSession(sessionID, route) {
		sessionRoutes.delete(sessionID);
		sessionRoutes.set(sessionID, route);
		while (sessionRoutes.size > MAX_SESSION_ROUTES) sessionRoutes.delete(sessionRoutes.keys().next().value);
	}

	/** The save session a call belongs to: in the query string, or in a JSON / form body. */
	function sessionIdOf(options) {
		let q = /[?&]session(?:ID)?=([^&]+)/.exec('&' + String(options.queryString || '').replace(/^\?/, ''));
		if (q) return decodeURIComponent(q[1]);
		let body = options.body;
		if (typeof body == 'string') {
			let m = /"sessionID"\s*:\s*"([^"]+)"/.exec(body);
			return m ? m[1] : null;
		}
		if (body && typeof body == 'object' && typeof body.sessionID == 'string') return body.sessionID;
		return null;
	}

	/**
	 * 'app' or 'browser': where this call goes. A save session keeps the library its first call went to; a call that
	 * starts a save looks the target up again first. When the app is registered but fails, this is still 'app': the
	 * call fails with the host's message and nothing is saved to the browser.
	 */
	async function routeFor(method, options) {
		let sid = sessionIdOf(options);
		if (sid && sessionRoutes.has(sid)) return sessionRoutes.get(sid);
		let t = await getTarget(SAVE_STARTING.has(method));
		if (sid) rememberSession(sid, t.value);
		return t.value;
	}


	// ---- the offscreen document that owns the browser library
	// Chrome allows ONE offscreen document per extension. The connector already has one, for the translator frames
	// (offscreen/offscreen.html), so the library database lives in a frame of that page (offscreen.js adds it
	// when the target is "browser"): one document, reasons DOM_PARSER + WORKERS.
	let offscreenPromise = null;

	async function hasOffscreenDocument() {
		if (chrome.runtime.getContexts) {
			let contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
			return contexts.length > 0;
		}
		if (typeof self !== 'undefined' && self.clients && self.clients.matchAll) {
			return (await self.clients.matchAll()).some(c => c.url.includes(OFFSCREEN_URL));
		}
		return false;
	}

	/** Creates the offscreen document unless there is one. Tolerates "already exists". */
	function ensureOffscreen() {
		if (!offscreenPromise) {
			offscreenPromise = (async function () {
				if (await hasOffscreenDocument()) return;
				try {
					await chrome.offscreen.createDocument({
						url: OFFSCREEN_URL,
						reasons: ['DOM_PARSER', 'WORKERS'],
						justification: 'Zinc library database, and running Zotero translators in isolated frames'
					});
				}
				catch (e) {
					if (!/only a single|already|exists/i.test(e.message)) throw e;
				}
			})();
			offscreenPromise.then(() => { offscreenPromise = null; }, () => { offscreenPromise = null; });
		}
		return offscreenPromise;
	}

	/**
	 * Offscreen document up, and the database answering on "zinc-db". The database frame needs a moment to load
	 * (sqlite WebAssembly), so a ping is tried until it answers.
	 */
	function ensureBrowserLibrary() {
		return startBrowserLibrary().then(ok => {
			// the library exists in this browser (again, after a move emptied it): the move offer checks it (browserLibraryState)
			if (createdFlag !== true) {
				createdFlag = true;
				let st = storage();
				if (st) st.set({ [CREATED_KEY]: true }).catch(() => {});
			}
			return ok;
		});
	}

	function startBrowserLibrary() {
		let channel = channels.browser;
		if (channel.ready) return channel.ready;
		let ready = (async function () {
			await ensureOffscreen();
			let last;
			for (let i = 0; i < 60; i++) {
				// the database frame is added when it is asked for (this message), not when the connector starts
				try {
					let sent = chrome.runtime.sendMessage({ zincAttachDb: true });
					if (sent && sent.catch) sent.catch(() => {});
				}
				catch (e) {}
				try {
					let r = await roundTrip({ t: 'req', method: 'ping', http: 'GET', query: '', headers: {} }, 4000, [], channel);
					if (r.status) return true;
				}
				catch (e) {
					last = e;
				}
				await delay(500);
			}
			throw new Zotero.Connector.CommunicationError(
				`Zinc browser library did not start${last ? `: ${last.message}` : ''}`, 0);
		})();
		channel.ready = ready;
		ready.catch(() => { if (channel.ready === ready) channel.ready = null; });
		return ready;
	}

	/**
	 * Same shape as Zotero.HTTP.request() with successCodes: false: resolves to an XHR-like object for any status,
	 * rejects (status 0) when the host cannot be reached.
	 *
	 * @param {String} httpMethod - "GET" | "POST"
	 * @param {String} method - connector method, e.g. "saveItems"
	 * @param {Object} options - {body, headers, queryString, timeout}
	 */
	this.request = async function (httpMethod, method, options) {
		let route = await routeFor(method, options);
		if (route == 'browser' && NOT_IN_BROWSER_LIBRARY.has(method)) {
			// As if there were no client: Zotero.Repo goes to repo.zotero.org for translators
			throw new Zotero.Connector.CommunicationError(
				`Connector: ${method} is not served by the browser library (translators come from repo.zotero.org)`, 0);
		}
		let channel = channels[route];
		if (!IDEMPOTENT.has(method)) {
			return send(httpMethod, method, options, channel);
		}
		// ping: reuse a fresh answer (and share one in-flight call) instead of a round trip per tab update
		if (method == 'ping') {
			let key = `${route}:${httpMethod}:${options.queryString || ''}:${typeof options.body == 'string' ? options.body : ''}`;
			if (pingCache && pingCache.key == key && Date.now() - pingCache.at < PING_TTL) {
				return pingCache.promise;
			}
			let entry = { key, at: Date.now(), promise: null };
			entry.promise = sendWithRetry(httpMethod, method, options, channel).then(
				xhr => {
					if (xhr.status != 200 && pingCache === entry) pingCache = null;
					return xhr;
				},
				e => {
					if (pingCache === entry) pingCache = null;
					throw e;
				}
			);
			pingCache = entry;
			return entry.promise;
		}
		return sendWithRetry(httpMethod, method, options, channel);
	};

	/** One automatic retry, after a reconnect, when the host crashed or the library was busy */
	async function sendWithRetry(httpMethod, method, options, channel) {
		try {
			let xhr = await send(httpMethod, method, options, channel);
			if (xhr.status != 503) return xhr;
		}
		catch (e) {
			if (!isTransient(e)) throw e;
		}
		Zotero.debug(`NativeHost: retrying ${method} once`);
		await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
		return send(httpMethod, method, options, channel);
	}

	/** Diagnostics: the native host's version and the library it opened. */
	this.hello = function () {
		return roundTrip({ t: 'hello' }, 5000, [], channels.app);
	};

	/** Tests only: use another registration of the host (com.zotero_next.*), from the next call on. */
	this.useHostForTests = function (name) {
		if (!/^com\.zotero_next\.[a-z0-9_.]+$/.test(name)) throw new Error(`not a Zinc host name: ${name}`);
		hostName = name;
		let ch = channels.app;
		if (ch.port) ch.port.disconnect();
		ch.port = null;
		pingCache = null;
		ch.protoPromise = null;
		target = null; // the new registration decides again
	};

	// ---- what the popup, the options and the library tab use

	/** "app" | "browser": where saves go now (see the header comment). */
	this.getSaveTarget = async function () {
		return (await getTarget(false)).value;
	};

	/**
	 * Looks the target up again, from the host: {target: 'app' | 'browser', hostError}. hostError is the host's
	 * message when the app is registered but does not work (target stays 'app'); null otherwise. The popup and the
	 * library tab call this when they open, and "Try again" does.
	 */
	this.refreshTarget = async function () {
		let t = await getTarget(true);
		return { target: t.value, hostError: t.hostError };
	};

	/** 'browser' | 'app': where the calls of this save session go. */
	this.routeOfSession = async function (sessionID) {
		return sessionRoutes.get(sessionID) || (await getTarget(false)).value;
	};
	this.ensureBrowserLibrary = ensureBrowserLibrary;
	this.ensureOffscreen = ensureOffscreen;

	// ---- moving the browser library into the app

	function errorOf(xhr) {
		try {
			let j = JSON.parse(xhr.responseText || new TextDecoder().decode(xhr.responseBytes));
			return j && j.error ? String(j.error) : null;
		}
		catch (e) {
			return null;
		}
	}

	async function setCreated(value) {
		createdFlag = value;
		let st = storage();
		if (st) await st.set({ [CREATED_KEY]: value });
	}

	/**
	 * Is there a browser library to move into the app? {offer, items}: offer is true when the app is installed and
	 * answers, the browser library exists, and it holds items. A browser that never used its library does not start
	 * the database to look.
	 */
	this.browserLibraryState = async function () {
		let none = { offer: false, items: 0, collections: 0 };
		let t = await getTarget(false);
		if (t.value != 'app' || t.hostError) return none;
		let st = storage();
		if (!st || !(await st.get(CREATED_KEY))[CREATED_KEY]) return none;
		try {
			let xhr = await send('GET', 'api', { path: '/api/browser/state', timeout: 30000 }, channels.browser);
			let j = JSON.parse(xhr.responseText);
			// top-level items: the ones the user counts (an attachment or a note is part of its item)
			let items = Number(j.topLevelItems ?? j.items) || 0;
			return { offer: xhr.status == 200 && items > 0, items, collections: Number(j.collections) || 0 };
		}
		catch (e) {
			Zotero.debug(`NativeHost: browser library state: ${e.message}`);
			return none;
		}
	};

	/**
	 * Moves the browser library into the app: export (the Export library zip), the host merges it into the app's
	 * library, and only when that answered 200 the browser library is emptied. Items the app already has (same key)
	 * are skipped. Resolves to the host's counts plus {emptied}. Rejects with a message for the user; nothing is
	 * emptied then. One move at a time: a second call gets the first one's promise.
	 *
	 * @param {Function} [onProgress] - ({phase: 'export' | 'send' | 'empty', text})
	 */
	this.moveBrowserLibrary = function (onProgress) {
		if (moving) return moving;
		let progress = (phase, text) => {
			try {
				if (onProgress) onProgress({ phase, text });
			}
			catch (e) {}
		};
		moving = (async function () {
			let t = await getTarget(true);
			if (t.value != 'app') throw new Error('The Zinc app is not installed.');
			if (t.hostError) throw new Error(t.hostError);
			progress('export', 'Exporting your browser library');
			let exported = await send('GET', 'api', { path: '/api/browser/export', timeout: 120000, binary: true }, channels.browser);
			if (exported.status != 200) throw new Error(errorOf(exported) || `The browser library could not be exported (HTTP ${exported.status}).`);
			progress('send', 'Sending it to Zinc');
			let imported = await send('POST', 'importBrowserLibrary', {
				body: exported.responseBytes,
				headers: { 'Content-Type': 'application/zip' },
				timeout: 180000
			}, channels.app);
			if (imported.status != 200) throw new Error(errorOf(imported) || `Zinc could not take the library (HTTP ${imported.status}).`);
			let result = JSON.parse(imported.responseText);
			// The items are in the app now. Only then is the browser library emptied.
			progress('empty', 'Emptying the browser library');
			try {
				let emptied = await send('POST', 'api', {
					path: '/api/browser/empty',
					body: JSON.stringify({ confirm: true }),
					headers: { 'Content-Type': 'application/json' },
					timeout: 60000
				}, channels.browser);
				result.emptied = emptied.status == 200;
				if (!result.emptied) result.emptyError = errorOf(emptied) || `HTTP ${emptied.status}`;
			}
			catch (e) {
				result.emptied = false;
				result.emptyError = e.message;
			}
			if (result.emptied) await setCreated(false);
			return result;
		})();
		let clear = () => { moving = null; };
		moving.then(clear, clear);
		return moving;
	};

	const fromExtensionPage = sender => !!sender && typeof sender.url == 'string'
		&& typeof chrome !== 'undefined' && !!chrome.runtime.getURL && sender.url.startsWith(chrome.runtime.getURL(''));

	// The target is looked up when the browser starts, and when the extension is installed or updated
	if (typeof chrome !== 'undefined' && chrome.runtime) {
		for (let event of ['onStartup', 'onInstalled']) {
			if (!chrome.runtime[event]) continue;
			chrome.runtime[event].addListener(function () {
				getTarget(true).catch(e => Zotero.debug(`NativeHost: target look-up failed: ${e.message}`));
			});
		}
	}

	// Messages from the extension's own pages:
	//   {zincEnsureDb: true}      the library tab (browser mode) asks for the database to be started -> {ok: true}
	//   {zincMoveState: true}     -> {ok: true, offer, items, collections}: is there a browser library to move into the app?
	//   {zincMoveLibrary: true}   moves it -> {ok: true, result} | {ok: false, error}; progress goes out as {zincMoveProgress: {phase, text}}
	if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
		chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
			if (!msg) return false;
			if (msg.zincEnsureDb === true) {
				ensureBrowserLibrary().then(
					() => sendResponse({ ok: true }),
					e => sendResponse({ ok: false, error: e.message })
				);
				return true;
			}
			if (msg.zincMoveState === true && fromExtensionPage(sender)) {
				Zotero.NativeHost.browserLibraryState().then(
					s => sendResponse({ ok: true, ...s }),
					e => sendResponse({ ok: false, error: e.message })
				);
				return true;
			}
			if (msg.zincMoveLibrary === true && fromExtensionPage(sender)) {
				Zotero.NativeHost.moveBrowserLibrary(p => {
					let sent = chrome.runtime.sendMessage({ zincMoveProgress: p });
					if (sent && sent.catch) sent.catch(() => {});
				}).then(
					result => sendResponse({ ok: true, result }),
					e => sendResponse({ ok: false, error: e.message })
				);
				return true;
			}
			// {zincStorage: {op, name, value}}: the browser library's database worker keeps the zotero.org API key here. An offscreen
			// document has no chrome.storage, so it asks this service worker (zotero-next gpui-ui/web/browser-db/CONTRACT.md, "zotero.org
			// sync"). Only from the library's offscreen page, only the names sync uses, and only the key is writable: no tab ever gets it.
			if (msg.zincStorage) {
				let { op, name, value } = msg.zincStorage;
				let fromLibraryOffscreen = sender && sender.id === chrome.runtime.id
					&& /^chrome-extension:\/\/[a-p]{32}\/library\/offscreen\.html(\?|#|$)/.test(sender.url || '');
				if (!fromLibraryOffscreen || !['zincZoteroApiKey', 'zincTestZoteroApiBase'].includes(name) || (op !== 'get' && name !== 'zincZoteroApiKey')) {
					sendResponse({ ok: false, error: 'refused' });
					return false;
				}
				let done = op === 'get' ? chrome.storage.local.get(name).then(o => ({ ok: true, value: o[name] }))
					: op === 'set' ? chrome.storage.local.set({ [name]: value }).then(() => ({ ok: true }))
					: op === 'remove' ? chrome.storage.local.remove(name).then(() => ({ ok: true }))
					: Promise.resolve({ ok: false, error: 'unknown op' });
				done.then(sendResponse, e => sendResponse({ ok: false, error: e.message }));
				return true;
			}
			return false;
		});
	}
};

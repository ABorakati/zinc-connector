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

	Browser library (no desktop app): the same frames go to the library database that lives in this browser (an
	offscreen document, answering extension ports named "zinc-db") instead of the native host. Which of the two a
	call goes to is the "save target", kept in chrome.storage.local under "zincBrowserLibrary":
	  {saveTarget: "app" | "browser", firstRunDone: boolean}
	The first call that needs it pings the native host: an answer picks "app", none picks "browser". After that the
	target changes only when the user changes it (setSaveTarget), never by itself. A single save can be sent to the
	browser without changing the setting (saveOnceInBrowser). In browser mode getTranslators / getTranslatorCode
	fail locally (status 0, "no client"), so Zotero.Repo loads translators from repo.zotero.org, as upstream does
	when no Zotero client is running.
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
	const DB_PORT_NAME = 'zinc-db';
	// The browser library does not serve these (it answers 404): translators come from repo.zotero.org
	const NOT_IN_BROWSER_LIBRARY = new Set(['getTranslators', 'getTranslatorCode']);
	const OFFSCREEN_URL = 'offscreen/offscreen.html';
	// How long a "save to this browser instead" stays armed for the save that follows
	const ONCE_MS = 120000;
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
	let settings = null; // {saveTarget, firstRunDone}
	let settingsPromise = null;
	let onceUntil = 0;
	// sessionID -> 'browser': saves sent to the browser while the target is the app
	const sessionRoutes = new Map();

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
				failAll(new Zotero.Connector.CommunicationError(
					`${who} is not available: ${message}`, 0), channel);
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
		let responseText = bytes.length ? new TextDecoder().decode(bytes) : '';
		let headers = {};
		for (let k in p.res.headers) headers[k.toLowerCase()] = p.res.headers[k];
		// The slice of XMLHttpRequest / Zotero.HTTP.request's result that callMethod uses
		p.resolve({
			status: p.res.status,
			response: responseText,
			responseText,
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
	function roundTrip(msg, timeout, uids, channel) {
		uids = uids || [];
		return new Promise(function (resolve, reject) {
			let id = nextId++;
			let p = { resolve, reject, res: null, chunks: [], received: 0, timer: null, timeout, uids, channel };
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
		let { body, headers = {}, queryString = '', timeout = 15000 } = options;
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
			query: queryString.replace(/^\?/, ''),
			headers,
			body: wireBody
		}, timeout, uids, channel);
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
	const validTarget = t => t === 'app' || t === 'browser';
	const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

	/** Does the native host answer? Any answer will do: it is installed and running. */
	async function probeHost() {
		try {
			let xhr = await send('GET', 'ping', { timeout: 5000 }, channels.app);
			return xhr.status > 0;
		}
		catch (e) {
			return !!(e && e.status && e.status != 0);
		}
	}

	function getSettings() {
		if (settings) return Promise.resolve(settings);
		if (!settingsPromise) {
			settingsPromise = (async function () {
				let st = storage();
				if (!st) {
					// no storage (tests): the app, as before the browser library existed
					return settings = { saveTarget: 'app', firstRunDone: false };
				}
				let stored = (await st.get(LIBRARY_KEY))[LIBRARY_KEY] || {};
				if (validTarget(stored.saveTarget)) {
					return settings = { ...stored, firstRunDone: !!stored.firstRunDone };
				}
				// First need: the host answers -> the app, else this browser
				let saveTarget = (await probeHost()) ? 'app' : 'browser';
				// another page may have written it meanwhile
				let again = (await st.get(LIBRARY_KEY))[LIBRARY_KEY] || {};
				if (validTarget(again.saveTarget)) {
					return settings = { ...again, firstRunDone: !!again.firstRunDone };
				}
				settings = { ...again, saveTarget, firstRunDone: true };
				await st.set({ [LIBRARY_KEY]: settings });
				Zotero.debug(`NativeHost: first run, saving to ${saveTarget === 'app' ? 'the Zinc app' : 'this browser'}`);
				return settings;
			})();
			settingsPromise.then(() => { settingsPromise = null; }, () => { settingsPromise = null; });
		}
		return settingsPromise;
	}

	if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
		chrome.storage.onChanged.addListener(function (changes, area) {
			if (area != 'local' || !changes[LIBRARY_KEY]) return;
			let v = changes[LIBRARY_KEY].newValue;
			settings = v && validTarget(v.saveTarget) ? { ...v, firstRunDone: !!v.firstRunDone } : null;
			pingCache = null;
		});
	}

	function rememberSession(sessionID) {
		sessionRoutes.delete(sessionID);
		sessionRoutes.set(sessionID, 'browser');
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

	/** 'app' or 'browser': where this call goes. */
	async function routeFor(method, options) {
		let s = await getSettings();
		if (s.saveTarget == 'browser') return 'browser';
		let sid = sessionIdOf(options);
		if (sid && sessionRoutes.has(sid)) return 'browser';
		if (Date.now() < onceUntil) {
			// "Save to this browser instead": this save, and the calls that belong to it
			if (sid) rememberSession(sid);
			return 'browser';
		}
		return 'app';
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
		let channel = channels.browser;
		if (channel.ready) return channel.ready;
		let ready = (async function () {
			await ensureOffscreen();
			let last;
			for (let i = 0; i < 60; i++) {
				// the database frame is added when the target is "browser"; this also covers a save sent to the browser once
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
	};

	// ---- what the popup, the options and the library tab use

	/** "app" | "browser": where saves go. The first call on a fresh install decides it (see the header comment). */
	this.getSaveTarget = async function () {
		return (await getSettings()).saveTarget;
	};

	/** The user's choice. Never called by anything but the user's own action. */
	this.setSaveTarget = async function (target) {
		if (!validTarget(target)) throw new Error(`not a save target: ${target}`);
		settings = { ...(await getSettings()), saveTarget: target, firstRunDone: true };
		pingCache = null;
		let st = storage();
		if (st) await st.set({ [LIBRARY_KEY]: settings });
		if (target == 'browser') ensureBrowserLibrary().catch(e => Zotero.debug(`NativeHost: ${e.message}`));
	};

	/** Does the native host answer right now? A fresh ping, not the cached one. */
	this.isHostReachable = async function () {
		pingCache = null;
		return probeHost();
	};

	/**
	 * "Save to this browser instead", for the next save only: its calls (and its session's later calls: move,
	 * cancel, remove) go to the browser library. The setting does not change.
	 */
	this.saveOnceInBrowser = function () {
		onceUntil = Date.now() + ONCE_MS;
		pingCache = null;
	};
	this.endSaveOnce = function () {
		onceUntil = 0;
	};
	/** Sends a save session's calls to the browser library (the popup knows the session id before any call has it). */
	this.routeSessionToBrowser = rememberSession;
	/** 'browser' | 'app': where the calls of this save session go. */
	this.routeOfSession = async function (sessionID) {
		return (await getSettings()).saveTarget == 'browser' || sessionRoutes.has(sessionID) ? 'browser' : 'app';
	};
	this.ensureBrowserLibrary = ensureBrowserLibrary;
	this.ensureOffscreen = ensureOffscreen;

	// A new install picks the target now rather than at the first save
	if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
		chrome.runtime.onInstalled.addListener(function () {
			getSettings().catch(e => Zotero.debug(`NativeHost: first run failed: ${e.message}`));
		});
	}

	// The library tab (browser mode) asks for the database to be started: {zincEnsureDb: true} -> {ok: true}
	if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
		chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
			if (!msg || msg.zincEnsureDb !== true) return false;
			ensureBrowserLibrary().then(
				() => sendResponse({ ok: true }),
				e => sendResponse({ ok: false, error: e.message })
			);
			return true;
		});
	}
};

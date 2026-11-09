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
*/

Zotero.NativeHost = new function() {
	const HOST_NAME = 'com.zotero_next.connector_host';
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

	let port = null;
	// true once the current port has delivered anything: a disconnect after that is a crash, not "not installed"
	let portSpoke = false;
	let nextId = 1;
	// id -> {resolve, reject, res, chunks, received, timer, timeout, uids}
	const pending = new Map();
	let pingCache = null; // {key, at, promise}
	let protoPromise = null;

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

	function failAll(error) {
		for (let [id, p] of pending) {
			clearTimeout(p.timer);
			p.reject(error);
		}
		pending.clear();
	}

	function connect() {
		if (port) return port;
		port = chrome.runtime.connectNative(HOST_NAME);
		portSpoke = false;
		protoPromise = null;
		let thisPort = port;
		port.onMessage.addListener(function (msg) {
			if (thisPort !== port) return;
			portSpoke = true;
			onMessage(msg);
		});
		port.onDisconnect.addListener(function () {
			let message = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'disconnected';
			Zotero.debug(`NativeHost: disconnected (${message})`);
			let spoke = portSpoke;
			if (thisPort === port) {
				port = null;
				pingCache = null;
				protoPromise = null;
			}
			else {
				return;
			}
			let neverStarts = /not found|forbidden|not allowed/i.test(message);
			if (spoke && !neverStarts && pending.size) {
				// The host was running and died with calls in flight. Not "offline": see the header comment.
				failAll(new Zotero.Connector.CommunicationError(
					`Zinc host stopped unexpectedly (${message}). Your save may not have completed: check Zinc.`,
					502, { error: 'HOST_CRASHED' }));
			}
			else {
				// status 0 is what a dead HTTP connection gave upstream: callers treat it as "Zotero is offline"
				failAll(new Zotero.Connector.CommunicationError(
					`Zinc host is not available: ${message}`, 0));
			}
		});
		return port;
	}

	function arm(p, id) {
		clearTimeout(p.timer);
		if (!p.timeout) return;
		p.timer = setTimeout(function () {
			if (!pending.delete(id)) return;
			dropUploads(p.uids);
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
	function dropUploads(uids) {
		if (!port || !uids || !uids.length) return;
		for (let uid of uids) {
			try {
				port.postMessage({ t: 'drop', uid });
			}
			catch (e) {}
		}
	}

	/**
	 * @param {Object} msg - the message to send (gets an id)
	 * @param {Number|false} timeout - ms without any sign of life from the host; false for none
	 * @param {String[]} [uids] - uploads this request refers to (dropped if it fails)
	 */
	function roundTrip(msg, timeout, uids = []) {
		return new Promise(function (resolve, reject) {
			let id = nextId++;
			let p = { resolve, reject, res: null, chunks: [], received: 0, timer: null, timeout, uids };
			pending.set(id, p);
			arm(p, id);
			try {
				connect().postMessage({ ...msg, id });
			}
			catch (e) {
				clearTimeout(p.timer);
				pending.delete(id);
				dropUploads(uids);
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
	function hostProto() {
		if (!protoPromise) {
			protoPromise = roundTrip({ t: 'hello' }, 5000).then(m => m.proto || 1, () => 1);
		}
		return protoPromise;
	}

	/** Builds the wire body, sending big pieces as upload frames first. */
	async function encodeBody(body, headers, uids) {
		if (body === null || body === undefined) return { wireBody: undefined, size: 0 };
		let size = 0;
		let newUid = () => {
			let uid = `u${Date.now().toString(36)}${nextId++}`;
			uids.push(uid);
			return uid;
		};
		if (headers['Content-Type'] == 'multipart/form-data') {
			// body is the plain {name: value} object callMethod was given (SingleFile 'binary-*' entries are bytes)
			let proto = await hostProto();
			let thePort = connect();
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
		await postUpload(connect(), uid, bytes);
		return { wireBody: { kind: 'upload', uid }, size: bytes.length };
	}

	async function send(httpMethod, method, options) {
		let { body, headers = {}, queryString = '', timeout = 15000 } = options;
		let uids = [];
		let wireBody, size;
		try {
			({ wireBody, size } = await encodeBody(body, headers, uids));
		}
		catch (e) {
			dropUploads(uids);
			if (e instanceof Zotero.Connector.CommunicationError) throw e;
			throw new Zotero.Connector.CommunicationError(`Zinc host is not available: ${e.message}`, 0);
		}
		// The timeout counts from the last sign of life, but sending a big body takes the host time too
		if (timeout) timeout += Math.ceil(size / (1024 * 1024)) * MS_PER_UPLOAD_MB;
		return roundTrip({
			t: 'req',
			method,
			http: httpMethod,
			query: queryString.replace(/^\?/, ''),
			headers,
			body: wireBody
		}, timeout, uids);
	}

	const isTransient = e => e instanceof Zotero.Connector.CommunicationError && e.status == 502;

	/**
	 * Same shape as Zotero.HTTP.request() with successCodes: false: resolves to an XHR-like object for any status,
	 * rejects (status 0) when the host cannot be reached.
	 *
	 * @param {String} httpMethod - "GET" | "POST"
	 * @param {String} method - connector method, e.g. "saveItems"
	 * @param {Object} options - {body, headers, queryString, timeout}
	 */
	this.request = async function (httpMethod, method, options) {
		if (!IDEMPOTENT.has(method)) {
			return send(httpMethod, method, options);
		}
		// ping: reuse a fresh answer (and share one in-flight call) instead of a round trip per tab update
		if (method == 'ping') {
			let key = `${httpMethod}:${options.queryString || ''}:${typeof options.body == 'string' ? options.body : ''}`;
			if (pingCache && pingCache.key == key && Date.now() - pingCache.at < PING_TTL) {
				return pingCache.promise;
			}
			let entry = { key, at: Date.now(), promise: null };
			entry.promise = sendWithRetry(httpMethod, method, options).then(
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
		return sendWithRetry(httpMethod, method, options);
	};

	/** One automatic retry, after a reconnect, when the host crashed or the library was busy */
	async function sendWithRetry(httpMethod, method, options) {
		try {
			let xhr = await send(httpMethod, method, options);
			if (xhr.status != 503) return xhr;
		}
		catch (e) {
			if (!isTransient(e)) throw e;
		}
		Zotero.debug(`NativeHost: retrying ${method} once`);
		await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
		return send(httpMethod, method, options);
	}

	/** Diagnostics: the host's version and the library it opened. */
	this.hello = function () {
		return roundTrip({ t: 'hello' }, 5000);
	};
};

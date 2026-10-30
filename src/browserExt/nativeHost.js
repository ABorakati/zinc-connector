/*
	zotero-next fork: transport to the "zotero-next host" native-messaging program.

	Upstream talks to the Zotero client over HTTP on 127.0.0.1:23119 (Zotero.Connector.callMethod ->
	Zotero.HTTP.request). This fork sends the same calls over Chrome native messaging
	(chrome.runtime.connectNative) to a small program that answers them against the zotero-next library, so
	neither Zotero nor the zotero-next app has to be running.

	Protocol (JSON messages, each direction):
	  -> {t:"req", id, method, http, query, headers, body}   body: {kind:"text",text} | {kind:"upload",uid}
	                                                              | {kind:"form",fields}
	  -> {t:"up", uid, seq, last, data}                      base64 upload chunk (a body bigger than UPLOAD_CHUNK)
	  <- {t:"res", id, status, headers, n}                   then n x
	  <- {t:"rc", id, seq, data}                             base64 body chunk (host->extension messages are
	                                                         limited to 1 MB by Chrome)
	  -> {t:"hello", id} / <- {t:"hello", id, version, db}   diagnostics

	The port stays open while the service worker lives (an open native port keeps an MV3 worker alive), which is
	also what keeps the host's in-memory save sessions around between saveItems -> saveAttachment -> updateSession
	(the host additionally persists them, so a restarted host still knows them).
*/

Zotero.NativeHost = new function() {
	const HOST_NAME = 'com.zotero_next.connector_host';
	// Raw bytes per upload message. Chrome allows 64 MB per message to a host; base64 adds a third.
	const UPLOAD_CHUNK = 4 * 1024 * 1024;

	let port = null;
	let nextId = 1;
	// id -> {resolve, reject, res, chunks, timer}
	const pending = new Map();

	function bytesToBase64(bytes) {
		let binary = '';
		const step = 0x8000;
		for (let i = 0; i < bytes.length; i += step) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
		}
		return btoa(binary);
	}

	function base64ToBytes(b64) {
		const binary = atob(b64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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
		let thisPort = port;
		port.onMessage.addListener(function (msg) {
			if (thisPort !== port) return;
			onMessage(msg);
		});
		port.onDisconnect.addListener(function () {
			let message = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'disconnected';
			Zotero.debug(`NativeHost: disconnected (${message})`);
			if (thisPort === port) port = null;
			// status 0 is what a dead HTTP connection gave upstream: callers treat it as "Zotero is offline"
			failAll(new Zotero.Connector.CommunicationError(
				`Zotero Next host is not available: ${message}`, 0));
		});
		return port;
	}

	function onMessage(msg) {
		let p = pending.get(msg.id);
		if (!p) return;
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
		let size = p.chunks.reduce((n, c) => n + c.length, 0);
		let bytes = new Uint8Array(size);
		let offset = 0;
		for (let c of p.chunks) {
			bytes.set(c, offset);
			offset += c.length;
		}
		let responseText = new TextDecoder().decode(bytes);
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

	/**
	 * @param {Object} msg - the message to send (gets an id)
	 * @param {Number|false} timeout - ms; false for none
	 */
	function roundTrip(msg, timeout) {
		return new Promise(function (resolve, reject) {
			let id = nextId++;
			let p = { resolve, reject, res: null, chunks: [], received: 0, timer: null };
			if (timeout) {
				p.timer = setTimeout(function () {
					pending.delete(id);
					reject(new Zotero.Connector.CommunicationError(`Zotero Next host request timed out after ${timeout} ms`, 0));
				}, timeout);
			}
			pending.set(id, p);
			try {
				connect().postMessage({ ...msg, id });
			}
			catch (e) {
				clearTimeout(p.timer);
				pending.delete(id);
				reject(new Zotero.Connector.CommunicationError(`Zotero Next host is not available: ${e.message}`, 0));
			}
		});
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
		let { body, headers = {}, queryString = '', timeout = 15000 } = options;
		let wireBody;
		if (body === null || body === undefined) {
			wireBody = undefined;
		}
		else if (headers['Content-Type'] == 'multipart/form-data') {
			// body is the plain {name: value} object callMethod was given (SingleFile 'binary-*' entries are bytes)
			let fields = {};
			for (let name in body) {
				let v = body[name];
				if (name.startsWith('binary-')) {
					fields[name] = { b64: bytesToBase64(new Uint8Array(Object.values(v))) };
				}
				else {
					fields[name] = { text: typeof v == 'string' ? v : JSON.stringify(v) };
				}
			}
			wireBody = { kind: 'form', fields };
		}
		else {
			let bytes = typeof body == 'string'
				? new TextEncoder().encode(body)
				: (body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
			if (bytes.length <= UPLOAD_CHUNK && typeof body == 'string') {
				wireBody = { kind: 'text', text: body };
			}
			else {
				let uid = `u${Date.now().toString(36)}${nextId++}`;
				let chunks = Math.max(1, Math.ceil(bytes.length / UPLOAD_CHUNK));
				let thePort = connect();
				for (let i = 0; i < chunks; i++) {
					thePort.postMessage({
						t: 'up',
						uid,
						seq: i,
						last: i == chunks - 1,
						data: bytesToBase64(bytes.subarray(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK))
					});
				}
				wireBody = { kind: 'upload', uid };
			}
		}
		return roundTrip({
			t: 'req',
			method,
			http: httpMethod,
			query: queryString.replace(/^\?/, ''),
			headers,
			body: wireBody
		}, timeout);
	};

	/** Diagnostics: the host's version and the library it opened. */
	this.hello = function () {
		return roundTrip({ t: 'hello' }, 5000);
	};
};

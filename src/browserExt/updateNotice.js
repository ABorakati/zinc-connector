/*
	zotero-next fork: the update notice for UNPACKED installs of the Zinc Connector.

	An unpacked extension cannot update itself. So, once a day and when the browser starts, the background asks a signed feed
	whether a newer version exists and, if so, stores {version, url, notes} under chrome.storage.local "zincUpdateAvailable".
	The save popup shows "Zinc <version> is available. Download" from that (popup/popup.js).

	  Store installs (Chrome Web Store, Edge Add-ons, unlisted) are updated by the browser. Their manifest has an update_url, and
	  this module does nothing for them: no request, no stored notice. Unpacked installs have none.
	  The feed is latest-extension.json, written and signed by zotero-next's gpui-ui/scripts/release.ts (--extension-zip):
	    { version, releasedAt, notes, url, sha256, size, signature }   url = the release asset Zinc-Connector-<version>.zip
	  Same signing as the desktop app's latest.json (core/src/update/manifest.ts): an Ed25519 signature over the manifest without
	  "signature" (UTF-8 JSON, keys sorted recursively, no whitespace). The public key is embedded at build time in updateKey.js
	  (scripts/gen-update-key.ts writes it from zotero-next's update-pubkey.txt). An unsigned, malformed or wrongly signed feed is
	  ignored with a console note: nothing is ever stored from it. No key built in: no check at all.
	  WebCrypto Ed25519 needs Chrome 137 or later (Edge likewise). On an older browser the check fails quietly: no notice.
	  Nothing here installs anything: the notice only links to the zip, which the user unpacks over the folder by hand.

	Throttle: at most one check a day (zincUpdateCheckedAt in chrome.storage.local), run when the service worker starts (which
	includes the browser start) and from a timer while it lives. A request that got no answer does not count as a check.
*/

// The one place to point the check elsewhere. Same release repository as the desktop app (https://github.com/<owner>/<repo>/releases/latest/download/<feed>).
const ZINC_UPDATE_FEED_URL = 'https://github.com/ABorakati/zinc/releases/latest/download/latest-extension.json';

(function () {
	try { importScripts('./updateKey.js'); } catch (e) { /* not generated: no key, no check */ }
})();

self.ZincUpdateNotice = new function () {
	const FEED_URL = ZINC_UPDATE_FEED_URL;
	const KEY_AVAILABLE = 'zincUpdateAvailable';
	const KEY_CHECKED = 'zincUpdateCheckedAt';
	const DAY_MS = 24 * 60 * 60 * 1000;
	const TIMER_MS = 60 * 60 * 1000;
	const FETCH_TIMEOUT_MS = 15000;
	const MAX_FEED_BYTES = 64 * 1024;
	const FIELDS = ['version', 'releasedAt', 'notes', 'url', 'sha256', 'size', 'minVersion', 'signature'];
	const note = (msg) => console.log('[zinc update] ' + msg);

	// ---- versions (same rules as zotero-next core/src/update/version.ts) ----
	const VERSION_RE = /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+([0-9a-fA-F]+)(?:-(\d{8}))?)?$/;
	function parseVersion(s) {
		if (typeof s !== 'string') return null;
		const m = VERSION_RE.exec(s.trim());
		if (!m) return null;
		return {
			release: m[1].split('.').map(Number),
			pre: m[2] ? m[2].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
			date: m[4] ? Number(m[4]) : 0,
		};
	}
	const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
	function comparePre(a, b) {
		if (!a.length && !b.length) return 0;
		if (!a.length) return 1;
		if (!b.length) return -1;
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			const x = a[i], y = b[i];
			if (x === undefined) return -1;
			if (y === undefined) return 1;
			if (x === y) continue;
			if (typeof x === 'number' && typeof y === 'number') return cmp(x, y);
			if (typeof x === 'number') return -1;
			if (typeof y === 'number') return 1;
			return x < y ? -1 : 1;
		}
		return 0;
	}
	/** True if `candidate` is strictly newer than `current`; false when either is not a version. */
	function isNewer(candidate, current) {
		const a = parseVersion(candidate), b = parseVersion(current);
		if (!a || !b) return false;
		for (let i = 0; i < Math.max(a.release.length, b.release.length); i++) {
			const c = cmp(a.release[i] || 0, b.release[i] || 0);
			if (c) return c > 0;
		}
		return (comparePre(a.pre, b.pre) || cmp(a.date, b.date)) > 0;
	}

	// ---- the signed feed (same canonical bytes and shape rules as zotero-next core/src/update/manifest.ts) ----
	function canon(v) {
		if (v === null || typeof v !== 'object') return JSON.stringify(v);
		if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
		return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
	}
	function canonicalBytes(m) {
		const rest = Object.assign({}, m);
		delete rest.signature;
		return new TextEncoder().encode(canon(rest));
	}
	const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

	function checkShape(raw) {
		const bad = (why) => { throw new Error('bad feed: ' + why); };
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('not an object');
		for (const k of Object.keys(raw)) if (!FIELDS.includes(k)) bad('unknown field "' + k + '"');
		const str = (k) => (typeof raw[k] === 'string' && raw[k].length ? raw[k] : bad('"' + k + '" missing'));
		if (!parseVersion(str('version'))) bad('version is not a version number');
		if (Number.isNaN(Date.parse(str('releasedAt')))) bad('releasedAt is not a date');
		if (typeof raw.notes !== 'string') bad('"notes" missing');
		let url;
		try { url = new URL(str('url')); } catch (e) { bad('url is not a URL'); }
		if (url.protocol !== 'https:') bad('url is not https');
		if (!/^[0-9a-f]{64}$/.test(str('sha256').toLowerCase())) bad('sha256 is not 64 hex digits');
		if (!Number.isSafeInteger(raw.size) || raw.size <= 0) bad('"size" is not a positive integer');
		if (raw.minVersion !== undefined && !parseVersion(raw.minVersion)) bad('minVersion is not a version number');
		str('signature');
		return raw;
	}

	/** Throws unless `raw` is a well-formed manifest with a valid Ed25519 signature by `publicKeyB64` (raw 32 bytes, base64). */
	async function verifyFeed(raw, publicKeyB64) {
		if (!publicKeyB64) throw new Error('this build has no update public key');
		const m = checkShape(raw);
		const keyBytes = unb64(String(publicKeyB64).trim());
		if (keyBytes.length !== 32) throw new Error('the update public key is not a 32-byte Ed25519 key');
		const key = await crypto.subtle.importKey('raw', keyBytes, 'Ed25519', false, ['verify']);
		let ok = false;
		try { ok = await crypto.subtle.verify('Ed25519', key, unb64(m.signature), canonicalBytes(m)); } catch (e) { ok = false; }
		if (!ok) throw new Error('the feed signature is not valid');
		return m;
	}

	// ---- the check ----
	/** Store installs have an update_url (the browser updates them); unpacked installs do not. */
	function isUnpacked() {
		return !chrome.runtime.getManifest().update_url;
	}
	function currentVersion() {
		const m = chrome.runtime.getManifest();
		return m.version_name || m.version;
	}

	let running = null;
	/** One check. Returns 'store-install' | 'no-key' | 'throttled' | 'unreachable' | 'invalid' | 'none' | 'available'. Never throws. */
	function check(opts) {
		if (!running) running = doCheck(opts || {}).catch((e) => { note('check failed: ' + (e && e.message || e)); return 'unreachable'; }).finally(() => { running = null; });
		return running;
	}

	async function doCheck(opts) {
		if (!isUnpacked()) return 'store-install';
		const publicKey = self.ZINC_UPDATE_PUBKEY || '';
		if (!publicKey || !FEED_URL) return 'no-key';
		const current = currentVersion();
		await dropStale(current);
		if (!opts.force) {
			const last = (await chrome.storage.local.get(KEY_CHECKED))[KEY_CHECKED];
			if (typeof last === 'number' && Date.now() - last >= 0 && Date.now() - last < DAY_MS) return 'throttled';
		}
		let text;
		try {
			const res = await fetch(FEED_URL, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			await chrome.storage.local.set({ [KEY_CHECKED]: Date.now() }); // an answer, even a bad one, counts; no answer does not
			if (!res.ok) { note('the feed answered HTTP ' + res.status); return 'invalid'; }
			text = await res.text();
		} catch (e) {
			note('the feed is not reachable: ' + (e && e.message || e));
			return 'unreachable';
		}
		let feed;
		try {
			if (text.length > MAX_FEED_BYTES) throw new Error('the feed is too large');
			feed = await verifyFeed(JSON.parse(text), publicKey);
		} catch (e) {
			note('ignoring the feed: ' + (e && e.message || e));
			return 'invalid';
		}
		if (!isNewer(feed.version, current)) {
			await chrome.storage.local.remove(KEY_AVAILABLE);
			return 'none';
		}
		await chrome.storage.local.set({ [KEY_AVAILABLE]: { version: feed.version, url: feed.url, notes: feed.notes } });
		note('Zinc ' + feed.version + ' is available');
		return 'available';
	}

	/** A stored notice for a version that is installed now (the user updated) is removed. */
	async function dropStale(current) {
		const got = (await chrome.storage.local.get(KEY_AVAILABLE))[KEY_AVAILABLE];
		if (got && !isNewer(got.version, current)) await chrome.storage.local.remove(KEY_AVAILABLE);
	}

	let started = false;
	/** Called once when the worker starts (that includes the browser start): check now, then hourly while the worker lives. */
	function start() {
		if (started) return;
		started = true;
		if (!isUnpacked()) return;
		check();
		chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(() => check());
		setInterval(() => check(), TIMER_MS);
	}

	this.check = check;
	this.start = start;
	this.verifyFeed = verifyFeed;
	this.isNewer = isNewer;
	this.canonicalBytes = canonicalBytes;
	this.KEY_AVAILABLE = KEY_AVAILABLE;
	this.KEY_CHECKED = KEY_CHECKED;
};

if (!self.ZINC_UPDATE_NO_AUTOSTART) self.ZincUpdateNotice.start();

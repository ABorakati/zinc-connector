// zotero-next fork: the update notice for unpacked installs (src/browserExt/updateNotice.js), with fake chrome.* APIs and a local feed
// served by Bun. The feed is signed the way zotero-next's release.ts signs it (Ed25519 over the canonical JSON without "signature"), with
// a throw-away key pair made here. Run: bun test test/native/updateNotice.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SOURCE = readFileSync(join(ROOT, "src/browserExt/updateNotice.js"), "utf8");
const AVAILABLE = "zincUpdateAvailable";
const CHECKED = "zincUpdateCheckedAt";
const DAY = 24 * 60 * 60 * 1000;

// ---- signing, written out here on purpose (core/src/update/manifest.ts: canon + Ed25519), not shared with the module under test
const canon = (v: any): string => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(",")}]`
	: `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
async function keyPair() {
	const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
	return { priv: kp.privateKey, pub: Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64") };
}
async function sign(body: Record<string, unknown>, priv: CryptoKey) {
	const sig = await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(canon(body)));
	return { ...body, signature: Buffer.from(sig).toString("base64") };
}
const feedBody = (version: string) => ({
	version, releasedAt: "2026-12-01T09:00:00Z", notes: "Fixes the popup.", url: `https://github.com/o/r/releases/download/v${version}/Zinc-Connector-${version}.zip`,
	sha256: "ab".repeat(32), size: 123456,
});

let good: Awaited<ReturnType<typeof keyPair>>, other: Awaited<ReturnType<typeof keyPair>>;
let serve: () => Promise<unknown>; // what the local feed answers
let hits: number;
let server: ReturnType<typeof Bun.serve>;
let store: Record<string, any>;

beforeAll(async () => {
	good = await keyPair();
	other = await keyPair();
	server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() { hits++; const body = await serve(); return new Response(typeof body === "string" ? body : JSON.stringify(body)); } });
});
afterAll(() => server.stop(true));
beforeEach(() => { hits = 0; store = {}; serve = async () => sign(feedBody("0.2.0+abcdef12-20261201"), good.priv); });

type Opts = { manifest?: Record<string, unknown>; pubkey?: string; feedUrl?: string };
/** Evaluate the module with fake chrome.* and return it. */
function load(o: Opts = {}) {
	const manifest = o.manifest ?? { version: "0.1.0", version_name: "0.1.0+11111111-20261101" };
	const chrome = {
		runtime: { getManifest: () => manifest, onStartup: { addListener() {} } },
		storage: { local: {
			get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
			set: async (o2: Record<string, any>) => { Object.assign(store, JSON.parse(JSON.stringify(o2))); },
			remove: async (k: string) => { delete store[k]; },
		} },
	};
	const self: any = { ZINC_UPDATE_NO_AUTOSTART: true, ZINC_UPDATE_PUBKEY: o.pubkey ?? good.pub };
	const src = SOURCE.replace(/const ZINC_UPDATE_FEED_URL = '[^']*'/, `const ZINC_UPDATE_FEED_URL = '${o.feedUrl ?? `http://127.0.0.1:${server.port}/latest-extension.json`}'`);
	new Function("self", "chrome", "importScripts", src)(self, chrome, () => { throw new Error("no updateKey.js here"); });
	return self.ZincUpdateNotice as { check(o?: { force?: boolean }): Promise<string>; isNewer(a: string, b: string): boolean };
}

describe("update notice", () => {
	test("a newer, validly signed feed is stored as {version, url, notes}", async () => {
		expect(await load().check()).toBe("available");
		expect(hits).toBe(1);
		expect(store[AVAILABLE]).toEqual({ version: "0.2.0+abcdef12-20261201", url: feedBody("0.2.0+abcdef12-20261201").url, notes: "Fixes the popup." });
		expect(typeof store[CHECKED]).toBe("number");
	});

	test("the same version stores nothing, and removes a notice for a version that is installed now", async () => {
		serve = async () => sign(feedBody("0.1.0+11111111-20261101"), good.priv);
		store[AVAILABLE] = { version: "0.1.0+11111111-20261101", url: "https://x/y.zip", notes: "" };
		expect(await load().check()).toBe("none");
		expect(AVAILABLE in store).toBe(false);
	});

	test("an older feed or a plain version number compare correctly", async () => {
		const m = load();
		expect(m.isNewer("0.1.0+aaaaaaaa-20261101", "0.1.0+11111111-20261101")).toBe(false);
		expect(m.isNewer("0.1.0+aaaaaaaa-20261102", "0.1.0+11111111-20261101")).toBe(true);
		expect(m.isNewer("1.10.0", "1.9.0")).toBe(true);
		expect(m.isNewer("0.2.0", "0.2.0-beta.1")).toBe(true);
		expect(m.isNewer("dev", "0.1.0")).toBe(false);
		serve = async () => sign(feedBody("0.0.9"), good.priv);
		expect(await load().check()).toBe("none");
		expect(AVAILABLE in store).toBe(false);
	});

	test("without a version_name the manifest version is the current version", async () => {
		expect(await load({ manifest: { version: "0.3.0" } }).check()).toBe("none"); // feed 0.2.0 is older than 0.3.0
		store = {};
		expect(await load({ manifest: { version: "0.1.0" } }).check()).toBe("available");
	});

	test("a bad signature stores nothing (wrong key, tampered fields, unsigned, garbage)", async () => {
		const signed = await sign(feedBody("0.2.0+abcdef12-20261201"), good.priv);
		const cases: Record<string, () => Promise<unknown>> = {
			"signed by another key": async () => sign(feedBody("0.2.0+abcdef12-20261201"), other.priv),
			"url changed after signing": async () => ({ ...signed, url: "https://evil.example/Zinc-Connector.zip" }),
			"version raised after signing": async () => ({ ...signed, version: "9.9.9" }),
			"unsigned": async () => feedBody("0.2.0+abcdef12-20261201"),
			"signature not base64 of 64 bytes": async () => ({ ...signed, signature: "AAAA" }),
			"an unknown field": async () => ({ ...signed, extra: 1 }),
			"not http(s) url, signed": async () => sign({ ...feedBody("0.2.0"), url: "javascript:alert(1)" }, good.priv),
			"http url, signed": async () => sign({ ...feedBody("0.2.0"), url: "http://example.com/z.zip" }, good.priv),
			"not JSON": async () => "<html>nope</html>",
		};
		for (const [name, make] of Object.entries(cases)) {
			store = {};
			serve = make;
			expect(await load().check(), name).toBe("invalid");
			expect(AVAILABLE in store, name).toBe(false);
		}
	});

	test("a build without a public key makes no request", async () => {
		expect(await load({ pubkey: "" }).check()).toBe("no-key");
		expect(hits).toBe(0);
		expect(Object.keys(store)).toEqual([]);
	});

	test("a store install (update_url set) makes no request and stores nothing", async () => {
		const m = load({ manifest: { version: "0.1.0", update_url: "https://clients2.google.com/service/update2/crx" } });
		expect(await m.check()).toBe("store-install");
		expect(await m.check({ force: true })).toBe("store-install");
		expect(hits).toBe(0);
		expect(Object.keys(store)).toEqual([]);
	});

	test("at most one check a day", async () => {
		const m = load();
		expect(await m.check()).toBe("available");
		expect(await m.check()).toBe("throttled");
		expect(hits).toBe(1);
		store[CHECKED] = Date.now() - (DAY - 60_000); // 23 h 59 min ago
		expect(await load().check()).toBe("throttled");
		expect(hits).toBe(1);
		store[CHECKED] = Date.now() - (DAY + 60_000);
		expect(await load().check()).toBe("available");
		expect(hits).toBe(2);
		expect(await load().check({ force: true })).toBe("available");
		expect(hits).toBe(3);
	});

	test("a bad feed counts as a check; no answer at all does not", async () => {
		serve = async () => "garbage";
		expect(await load().check()).toBe("invalid");
		expect(await load().check()).toBe("throttled");
		store = {};
		expect(await load({ feedUrl: "http://127.0.0.1:1/latest-extension.json" }).check()).toBe("unreachable");
		expect(CHECKED in store).toBe(false);
		expect(AVAILABLE in store).toBe(false);
	});

	test("a feed that cannot be reached leaves a stored notice alone", async () => {
		store[AVAILABLE] = { version: "0.2.0", url: "https://x/y.zip", notes: "" };
		expect(await load({ feedUrl: "http://127.0.0.1:1/latest-extension.json" }).check()).toBe("unreachable");
		expect(store[AVAILABLE].version).toBe("0.2.0");
	});
});

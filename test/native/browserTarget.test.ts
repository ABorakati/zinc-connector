// zotero-next fork: which library a call goes to (src/browserExt/nativeHost.js), with fake chrome.* APIs (no browser, no host
// program). One library per computer: the app's when its native host is registered, the browser's when Chrome says
// "Specified native messaging host not found", and a failing host is an error, never a fallback. Also: the switch when the app is
// installed or uninstalled, the move of the browser library into the app, the {zincEnsureDb} message, and the manifest and
// header-rule files. Run: bun test test/native/browserTarget.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const source = readFileSync(join(ROOT, "src/browserExt/nativeHost.js"), "utf8");
const KEY = "zincBrowserLibrary";
const CREATED = "zincBrowserLibraryCreated";
const EXT = "chrome-extension://zinc/";

type Sent = { target: "app" | "browser"; msg: any };
/** The app's host: 'ok' answers; 'missing' = Chrome: "Specified native messaging host not found"; 'exits' = registered, quits at once; 'crash' = answers ping, dies on the first save */
type AppMode = "ok" | "missing" | "exits" | "crash";
let sent: Sent[];
let store: Record<string, any>;
let created: any[];
let createError: string | null;
let appMode: AppMode;
let dbAnswers: boolean;
let runtimeMessages: any[];
let messageListeners: ((msg: any, sender: any, respond: (r: any) => void) => boolean | void)[];
let connectedNames: string[];
let appPorts: { disconnect: (message: string) => void }[];
// what the fake browser library answers for the move
let browserItems: number;
let exportBytes: Uint8Array;
let browserStatus: Record<string, number>; // path -> status to answer
// what the fake host answers to importBrowserLibrary
let importStatus: number;
let importBody: any;

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

function fakePort(target: "app" | "browser", mode: AppMode | "up" | "down") {
	const onMsg: ((m: any) => void)[] = [];
	const onDisc: (() => void)[] = [];
	const emit = (m: any) => setTimeout(() => onMsg.forEach((l) => l(m)), 0);
	const chrome = () => (globalThis as any).chrome;
	let spoke = false;
	const disconnect = (message: string) => {
		chrome().runtime.lastError = { message };
		onDisc.forEach((l) => l());
		chrome().runtime.lastError = undefined;
	};
	const respond = (id: any, status: number, body: string | Uint8Array, chunks = 1) => {
		const bytes = typeof body == "string" ? Buffer.from(body) : Buffer.from(body);
		const per = Math.ceil(bytes.length / chunks) || 1;
		emit({ t: "res", id, status, headers: { "Content-Type": "application/json", "X-Zotero-Version": "9.9.9" }, n: bytes.length ? Math.ceil(bytes.length / per) : 0 });
		for (let i = 0; i * per < bytes.length; i++) emit({ t: "rc", id, seq: i, data: b64(bytes.subarray(i * per, (i + 1) * per)) });
	};
	const port = {
		postMessage(msg: any) {
			sent.push({ target, msg });
			if (mode == "missing" || mode == "exits" || mode == "down") return;
			if (msg.t === "hello") return emit({ t: "hello", id: msg.id, proto: 2 });
			if (msg.t !== "req") return;
			spoke = true;
			if (mode == "crash" && msg.method != "ping") {
				// the host was running and dies with the save in flight
				setTimeout(() => disconnect("Native host has exited."), 0);
				return;
			}
			if (target == "browser" && msg.method == "api") {
				const status = browserStatus[msg.path] ?? 200;
				if (msg.path == "/api/browser/state") return respond(msg.id, status, JSON.stringify({ items: browserItems, collections: 1 }));
				if (msg.path == "/api/browser/export") return respond(msg.id, status, status == 200 ? exportBytes : JSON.stringify({ error: "export failed" }), 3);
				if (msg.path == "/api/browser/empty") return respond(msg.id, status, JSON.stringify(status == 200 ? { ok: true } : { error: "could not empty" }));
			}
			if (target == "app" && msg.method == "importBrowserLibrary") return respond(msg.id, importStatus, JSON.stringify(importBody));
			const body = msg.method === "ping"
				? JSON.stringify({ prefs: { supportsAttachmentUpload: true, translatorsHash: "abc", sortedTranslatorHash: "def" }, via: target })
				: JSON.stringify({ ok: true, via: target });
			respond(msg.id, 200, body);
		},
		disconnect() {},
		onMessage: { addListener: (l: any) => onMsg.push(l) },
		onDisconnect: { addListener: (l: any) => onDisc.push(l) },
	};
	if (target == "app") appPorts.push({ disconnect });
	if (mode == "missing") setTimeout(() => disconnect("Specified native messaging host not found."), 0);
	else if (mode == "exits") setTimeout(() => disconnect("Native host has exited."), 0);
	else if (mode == "down") setTimeout(() => disconnect("Could not establish connection. Receiving end does not exist."), 0);
	void spoke;
	return port;
}

function install() {
	sent = [];
	store = {};
	created = [];
	createError = null;
	appMode = "ok";
	dbAnswers = true;
	runtimeMessages = [];
	messageListeners = [];
	connectedNames = [];
	appPorts = [];
	browserItems = 3;
	exportBytes = new Uint8Array(Array.from({ length: 2500 }, (_, i) => i % 251));
	browserStatus = {};
	importStatus = 200;
	importBody = { topLevelItems: 2, items: 3, skippedItems: 1, collections: 1, files: 1 };
	const g = globalThis as any;
	g.chrome = {
		runtime: {
			lastError: undefined,
			getURL: (p: string) => EXT + p,
			connectNative: () => fakePort("app", appMode),
			connect: (info: { name: string }) => {
				connectedNames.push(info.name);
				return fakePort("browser", dbAnswers && created.length > 0 ? "ok" : "down");
			},
			sendMessage: (m: any) => {
				runtimeMessages.push(m);
				return Promise.resolve();
			},
			getContexts: async () => (created.length ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
			onMessage: { addListener: (l: any) => messageListeners.push(l) },
			onInstalled: { addListener() {} },
			onStartup: { addListener() {} },
		},
		storage: {
			local: {
				get: async (k: string) => (k in store ? { [k]: structuredClone(store[k]) } : {}),
				set: async (o: Record<string, any>) => Object.assign(store, structuredClone(o)),
			},
			onChanged: { addListener() {} },
		},
		offscreen: {
			createDocument: async (opts: any) => {
				if (createError) throw new Error(createError);
				created.push(opts);
			},
		},
	};
	g.Zotero = {
		debug() {},
		logError() {},
		Connector: {
			CommunicationError: class extends Error {
				status: number;
				value: unknown;
				constructor(message: string, status = 0, value: unknown = "") {
					super(message);
					this.status = status;
					this.value = value;
				}
			},
		},
	};
	(0, eval)(source);
	return g.Zotero.NativeHost;
}

const call = (nh: any, method: string, body: unknown = null, queryString = "") =>
	nh.request(body === null ? "GET" : "POST", method, { body: body === null ? null : JSON.stringify(body), headers: { "Content-Type": "application/json" }, queryString, timeout: 3000 });
const json = (xhr: any) => JSON.parse(xhr.responseText);
/** the methods sent to one side (the pings that look the target up and wait for the database are left out) */
const to = (target: "app" | "browser") => sent.filter((s) => s.target === target && s.msg.t === "req" && s.msg.method !== "ping").map((s) => s.msg.method + (s.msg.path ? ` ${s.msg.path}` : ""));
/** The app's host is uninstalled: its running process goes, and Chrome no longer knows the name */
const uninstallApp = () => {
	appMode = "missing";
	for (const p of appPorts) p.disconnect("Native host has exited.");
};
const onPage = { url: `${EXT}library/library.html` };

let nh: any;
beforeEach(() => {
	nh = install();
});

describe("no app: the browser library", () => {
	beforeEach(() => {
		appMode = "missing";
	});

	test("the host is not found: the target is this browser, and saves go to the zinc-db port", async () => {
		expect(await nh.getSaveTarget()).toBe("browser");
		const r = await call(nh, "saveItems", { sessionID: "S1", items: [] });
		expect(json(r).via).toBe("browser");
		expect(connectedNames).toEqual(["zinc-db"]);
		expect(created.length).toBe(1);
		expect(created[0].url).toBe("offscreen/offscreen.html");
		expect(created[0].reasons).toContain("WORKERS");
		expect(typeof created[0].justification).toBe("string");
		expect(to("browser")).toContain("saveItems");
		// the library is created empty the first time it is needed, and that is remembered (the move offer reads it)
		expect(store[CREATED]).toBe(true);
	});

	test("nothing about the target is stored, and a choice stored by an earlier build is dropped", async () => {
		store[KEY] = { saveTarget: "app", firstRunDone: true };
		nh = install();
		store[KEY] = { saveTarget: "app", firstRunDone: true };
		(0, eval)(source); // a service worker start reads the old key
		await Bun.sleep(20);
		expect(store[KEY]).toEqual({ firstRunDone: true });
		await nh.getSaveTarget();
		expect(JSON.stringify(store)).not.toContain("saveTarget");
	});

	test("there is no choice to make: the old controls are gone", () => {
		for (const gone of ["setSaveTarget", "saveOnceInBrowser", "endSaveOnce", "routeSessionToBrowser", "isHostReachable"]) expect(nh[gone]).toBeUndefined();
		const popupHtml = readFileSync(join(ROOT, "src/browserExt/popup/popup.html"), "utf8");
		expect(popupHtml).not.toContain("target-change");
		expect(popupHtml).not.toContain("Save to this browser instead");
		expect(popupHtml).toContain("Saving to:");
		expect(readFileSync(join(ROOT, "src/browserExt/savePopup.js"), "utf8")).not.toContain("saveOnceInBrowser");
	});

	test("getTranslators and getTranslatorCode fail locally, so Zotero.Repo uses repo.zotero.org", async () => {
		await expect(call(nh, "getTranslators", {})).rejects.toMatchObject({ status: 0 });
		await expect(call(nh, "getTranslatorCode", { translatorID: "x" })).rejects.toMatchObject({ status: 0 });
		expect(sent.filter((s) => s.msg.method === "getTranslators" || s.msg.method === "getTranslatorCode")).toEqual([]);
	});

	test("ping answers without the translator hashes", async () => {
		const r = json(await call(nh, "ping", {}));
		expect(r.via).toBe("browser");
		expect(r.prefs.supportsAttachmentUpload).toBe(true);
		expect(r.prefs.translatorsHash).toBeUndefined();
		expect(r.prefs.sortedTranslatorHash).toBeUndefined();
	});

	test("the offscreen document is created once, and 'already exists' is tolerated", async () => {
		await call(nh, "saveItems", { sessionID: "S3", items: [] });
		await call(nh, "updateSession", { sessionID: "S3", target: "L1" });
		expect(created.length).toBe(1);
		nh = install();
		appMode = "missing";
		createError = "Only a single offscreen document may be created.";
		// getContexts says there is none, createDocument says there is one: carry on
		(globalThis as any).chrome.runtime.connect = () => fakePort("browser", "ok");
		await expect(call(nh, "saveItems", { sessionID: "S4", items: [] })).resolves.toBeTruthy();
	});

	test("a multipart body goes over the browser port in frames", async () => {
		const r = await nh.request("POST", "saveSingleFile", { body: { sessionID: "S5", "binary-x": new Uint8Array([1, 2, 3]) }, headers: { "Content-Type": "multipart/form-data" }, timeout: 3000 });
		expect(json(r).via).toBe("browser");
		expect(sent.some((s) => s.target === "browser" && s.msg.t === "up")).toBe(true);
	});
});

describe("the app is installed: its library, always", () => {
	test("the host answers: the target is the app; saves, ping and translators go there; nothing is stored", async () => {
		expect(await nh.getSaveTarget()).toBe("app");
		expect(json(await call(nh, "saveItems", { sessionID: "A1", items: [] })).via).toBe("app");
		expect(json(await call(nh, "getSelectedCollection", {})).via).toBe("app");
		expect(json(await call(nh, "getTranslators", {})).via).toBe("app");
		expect(created.length).toBe(0);
		expect(connectedNames.length).toBe(0);
		expect(store[KEY]).toBeUndefined();
		expect(store[CREATED]).toBeUndefined();
	});

	test("an earlier browser library does not matter: the app's library is used", async () => {
		store[CREATED] = true;
		expect(json(await call(nh, "saveItems", { sessionID: "A2", items: [] })).via).toBe("app");
		expect(created.length).toBe(0);
	});

	test("refreshTarget reports the target and no host error", async () => {
		expect(await nh.refreshTarget()).toEqual({ target: "app", hostError: null });
		appMode = "missing";
		uninstallApp();
		expect(await nh.refreshTarget()).toEqual({ target: "browser", hostError: null });
	});
});

describe("the app's host is registered but fails: an error, no fallback", () => {
	test("the host quits at once: the target stays the app, with the host's message; the save fails and nothing goes to the browser", async () => {
		appMode = "exits";
		const t = await nh.refreshTarget();
		expect(t.target).toBe("app");
		expect(t.hostError).toMatch(/Native host has exited/);
		await expect(call(nh, "saveItems", { sessionID: "F1", items: [] })).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/Native host has exited/) });
		expect(created.length).toBe(0);
		expect(connectedNames).toEqual([]);
		expect(to("browser")).toEqual([]);
		expect(store[CREATED]).toBeUndefined();
	});

	test("the host crashes while saving: HOST_CRASHED (502), and the next save does not go to the browser either", async () => {
		appMode = "crash";
		await expect(call(nh, "saveItems", { sessionID: "F2", items: [] })).rejects.toMatchObject({ status: 502, value: { error: "HOST_CRASHED" } });
		expect(created.length).toBe(0);
		await expect(call(nh, "saveItems", { sessionID: "F3", items: [] })).rejects.toMatchObject({ status: 502 });
		expect(connectedNames).toEqual([]);
		expect(to("browser")).toEqual([]);
	});

	test("Try again: once the host works, the next save goes to the app (the target is looked up again)", async () => {
		appMode = "exits";
		await expect(call(nh, "saveItems", { sessionID: "F4", items: [] })).rejects.toBeTruthy();
		appMode = "ok";
		expect(await nh.refreshTarget()).toEqual({ target: "app", hostError: null });
		expect(json(await call(nh, "saveItems", { sessionID: "F5", items: [] })).via).toBe("app");
	});

	test("the host fails, then the app is uninstalled: only then does the browser library take over", async () => {
		appMode = "exits";
		expect((await nh.refreshTarget()).target).toBe("app");
		appMode = "missing";
		expect((await nh.refreshTarget()).target).toBe("browser");
	});

	test("forbidden (the host does not allow this extension) is a failing host, not 'not installed'", async () => {
		(globalThis as any).chrome.runtime.connectNative = () => {
			const onDisc: (() => void)[] = [];
			setTimeout(() => {
				(globalThis as any).chrome.runtime.lastError = { message: "Access to the specified native messaging host is forbidden." };
				onDisc.forEach((l) => l());
				(globalThis as any).chrome.runtime.lastError = undefined;
			}, 0);
			return { postMessage() {}, disconnect() {}, onMessage: { addListener() {} }, onDisconnect: { addListener: (l: any) => onDisc.push(l) } };
		};
		const t = await nh.refreshTarget();
		expect(t.target).toBe("app");
		expect(t.hostError).toMatch(/forbidden/);
	});
});

describe("installing and uninstalling the app switches the extension over", () => {
	test("no app -> app installed -> app uninstalled", async () => {
		appMode = "missing";
		expect(json(await call(nh, "saveItems", { sessionID: "W1", items: [] })).via).toBe("browser");
		// the app is installed: the next save (a new session) goes to it at once, without waiting for the target's cache to expire
		appMode = "ok";
		expect(json(await call(nh, "saveItems", { sessionID: "W2", items: [] })).via).toBe("app");
		expect(await nh.getSaveTarget()).toBe("app");
		// a save that started in the browser finishes there (its later calls keep their library) ...
		expect(json(await call(nh, "updateSession", { sessionID: "W1", target: "L1" })).via).toBe("browser");
		expect(await nh.routeOfSession("W1")).toBe("browser");
		expect(await nh.routeOfSession("W2")).toBe("app");
		// ... the app is uninstalled: back to the browser library
		uninstallApp();
		expect(json(await call(nh, "saveItems", { sessionID: "W3", items: [] })).via).toBe("browser");
		expect(await nh.getSaveTarget()).toBe("browser");
	});

	test("a save session keeps its library even if the host answers differently halfway", async () => {
		expect(json(await call(nh, "saveItems", { sessionID: "K1", items: [] })).via).toBe("app");
		appMode = "exits";
		uninstallApp();
		await expect(call(nh, "updateSession", { sessionID: "K1", target: "L1" })).rejects.toBeTruthy();
		expect(connectedNames).toEqual([]);
	});
});

describe("move the browser library into the app", () => {
	test("the offer: the app answers, the browser library exists and holds items", async () => {
		store[CREATED] = true;
		expect(await nh.browserLibraryState()).toEqual({ offer: true, items: 3, collections: 1 });
		expect(to("browser")).toEqual(["api /api/browser/state"]);
	});

	test("no offer without the app, with a failing host, without a browser library, or when it is empty", async () => {
		store[CREATED] = true;
		appMode = "missing";
		expect((await nh.browserLibraryState()).offer).toBe(false);
		expect(to("browser")).toEqual([]);
		nh = install();
		store[CREATED] = true;
		appMode = "exits";
		expect((await nh.browserLibraryState()).offer).toBe(false);
		nh = install();
		// never used the browser library: the database is not even started to look
		expect((await nh.browserLibraryState()).offer).toBe(false);
		expect(created.length).toBe(0);
		nh = install();
		store[CREATED] = true;
		browserItems = 0;
		expect((await nh.browserLibraryState()).offer).toBe(false);
	});

	test("export -> the host merges the zip -> only then the browser library is emptied", async () => {
		store[CREATED] = true;
		const phases: string[] = [];
		const r = await nh.moveBrowserLibrary((p: any) => phases.push(p.phase));
		expect(phases).toEqual(["export", "send", "empty"]);
		expect(r).toMatchObject({ topLevelItems: 2, skippedItems: 1, emptied: true });
		const order = sent.filter((s) => s.msg.t === "req" && s.msg.method !== "ping").map((s) => `${s.target}:${s.msg.method}${s.msg.path ? ` ${s.msg.path}` : ""}`);
		expect(order).toEqual(["browser:api /api/browser/export", "app:importBrowserLibrary", "browser:api /api/browser/empty"]);
		// the zip reached the host byte for byte, as upload frames, and the request refers to it
		const ups = sent.filter((s) => s.target === "app" && s.msg.t === "up");
		expect(ups.length).toBeGreaterThan(0);
		expect(Buffer.concat(ups.map((u) => Buffer.from(u.msg.data, "base64"))).equals(Buffer.from(exportBytes))).toBe(true);
		const req = sent.find((s) => s.target === "app" && s.msg.method === "importBrowserLibrary")!.msg;
		expect(req.body).toEqual({ kind: "upload", uid: ups[0]!.msg.uid });
		expect(req.http).toBe("POST");
		// the empty request names its confirmation
		expect(JSON.parse(sent.find((s) => s.msg.path === "/api/browser/empty")!.msg.body.text)).toEqual({ confirm: true });
		// no offer again: the browser library is empty and no longer marked as existing
		expect(store[CREATED]).toBe(false);
		expect((await nh.browserLibraryState()).offer).toBe(false);
	});

	test("when the host refuses the zip, the browser library is not emptied", async () => {
		store[CREATED] = true;
		importStatus = 400;
		importBody = { error: "That is not a usable Zinc export" };
		await expect(nh.moveBrowserLibrary()).rejects.toThrow("That is not a usable Zinc export");
		expect(to("browser")).toEqual(["api /api/browser/export"]);
		expect(store[CREATED]).toBe(true);
	});

	test("when the library is busy (503) or the host dies, nothing is emptied either", async () => {
		store[CREATED] = true;
		importStatus = 503;
		importBody = { error: "The Zinc library is busy" };
		await expect(nh.moveBrowserLibrary()).rejects.toThrow(/busy/);
		expect(to("browser")).not.toContain("api /api/browser/empty");
	});

	test("when the export fails, nothing is sent to the app", async () => {
		store[CREATED] = true;
		browserStatus["/api/browser/export"] = 500;
		await expect(nh.moveBrowserLibrary()).rejects.toThrow("export failed");
		expect(to("app")).not.toContain("importBrowserLibrary");
	});

	test("the app does not answer: the move does not start", async () => {
		store[CREATED] = true;
		appMode = "exits";
		await expect(nh.moveBrowserLibrary()).rejects.toThrow(/Native host has exited/);
		expect(to("browser")).toEqual([]);
		nh = install();
		appMode = "missing";
		await expect(nh.moveBrowserLibrary()).rejects.toThrow(/not installed/);
	});

	test("the items are in the app but the browser library could not be emptied: reported, and the offer stays out of the way", async () => {
		store[CREATED] = true;
		browserStatus["/api/browser/empty"] = 500;
		const r = await nh.moveBrowserLibrary();
		expect(r.emptied).toBe(false);
		expect(r.emptyError).toMatch(/could not empty/);
		expect(store[CREATED]).toBe(true);
	});

	test("one move at a time", async () => {
		store[CREATED] = true;
		const a = nh.moveBrowserLibrary();
		const b = nh.moveBrowserLibrary();
		expect(a).toBe(b);
		await a;
		expect(sent.filter((s) => s.msg.method === "importBrowserLibrary").length).toBe(1);
	});

	test("the extension's own pages can ask, a web page's content script cannot", async () => {
		store[CREATED] = true;
		const ask = (msg: any, sender: any) => new Promise<any>((res) => {
			const keep = messageListeners[0]!(msg, sender, res);
			if (!keep) res("ignored");
		});
		expect(await ask({ zincMoveState: true }, onPage)).toMatchObject({ ok: true, offer: true, items: 3 });
		expect(await ask({ zincMoveState: true }, { url: "https://example.org/" })).toBe("ignored");
		expect(await ask({ zincMoveLibrary: true }, {})).toBe("ignored");
		expect(await ask({ zincMoveLibrary: true }, { url: "https://example.org/" })).toBe("ignored");
		const moved = await ask({ zincMoveLibrary: true }, onPage);
		expect(moved).toMatchObject({ ok: true, result: { emptied: true } });
		expect(runtimeMessages.filter((m) => m.zincMoveProgress).map((m) => m.zincMoveProgress.phase)).toEqual(["export", "send", "empty"]);
	});
});

describe("{zincEnsureDb: true}", () => {
	test("makes sure the offscreen document exists, then answers {ok: true}", async () => {
		expect(messageListeners.length).toBe(1);
		const answer = await new Promise<any>((res) => {
			const keep = messageListeners[0]!({ zincEnsureDb: true }, {}, res);
			expect(keep).toBe(true);
		});
		expect(answer).toEqual({ ok: true });
		expect(created.length).toBe(1);
		// other messages are left alone
		expect(messageListeners[0]!({ something: 1 }, {}, () => {})).toBe(false);
		expect(messageListeners[0]!(["Zotero.msg", []], {}, () => {})).toBe(false);
	});
});

describe("{zincStorage}: the browser library's key storage", () => {
	const ask = (msg: any, sender: any) => new Promise<any>((res) => { messageListeners[0]!(msg, sender, res); });
	const g = globalThis as any;
	test("answers the library's offscreen page for the sync names only; only the key is writable; tabs are refused", async () => {
		g.chrome.runtime.id ??= "pakgagonakcalfbmckaolkpidcojacaf";
		g.chrome.storage.local.remove ??= async (k: string) => { delete store[k]; };
		const offscreen = { id: g.chrome.runtime.id, url: `chrome-extension://${g.chrome.runtime.id}/library/offscreen.html` };
		const tab = { id: g.chrome.runtime.id, url: `chrome-extension://${g.chrome.runtime.id}/library/library.html?mode=browser`, tab: { id: 3 } };
		expect(await ask({ zincStorage: { op: "set", name: "zincZoteroApiKey", value: "k1" } }, offscreen)).toEqual({ ok: true });
		expect(await ask({ zincStorage: { op: "get", name: "zincZoteroApiKey" } }, offscreen)).toEqual({ ok: true, value: "k1" });
		expect((await ask({ zincStorage: { op: "get", name: "zincZoteroApiKey" } }, tab)).ok).toBe(false);
		expect((await ask({ zincStorage: { op: "get", name: "zincBrowserLibrary" } }, offscreen)).ok).toBe(false);
		expect((await ask({ zincStorage: { op: "set", name: "zincTestZoteroApiBase", value: "http://127.0.0.1:1" } }, offscreen)).ok).toBe(false);
		expect((await ask({ zincStorage: { op: "get", name: "zincZoteroApiKey" } }, { id: "otherextensionid", url: offscreen.url })).ok).toBe(false);
		expect(await ask({ zincStorage: { op: "remove", name: "zincZoteroApiKey" } }, offscreen)).toEqual({ ok: true });
		expect(await ask({ zincStorage: { op: "get", name: "zincZoteroApiKey" } }, offscreen)).toEqual({ ok: true, value: undefined });
	});
});

describe("files", () => {
	const rules = JSON.parse(readFileSync(join(ROOT, "src/browserExt/zotero-api-key-rules.json"), "utf8"));
	const manifest = readFileSync(join(ROOT, "src/browserExt/manifest-v3.json"), "utf8");

	test("the header rule removes Zotero-API-Key everywhere except api.zotero.org", () => {
		expect(rules).toHaveLength(1);
		expect(rules[0].action).toEqual({ type: "modifyHeaders", requestHeaders: [{ header: "Zotero-API-Key", operation: "remove" }] });
		expect(rules[0].condition.excludedRequestDomains).toEqual(["api.zotero.org"]);
		expect(rules[0].condition.resourceTypes).toEqual(["xmlhttprequest", "other"]);
		expect(rules[0].condition.requestDomains).toBeUndefined();
	});

	test("it matches the rules the browser-library package ships, when that file exists", () => {
		const other = resolve(ROOT, "../zotero-next/gpui-ui/web/browser-db/dnr-rules.json");
		const alt = "C:/Users/abora/zotero-next/.claude/worktrees/connector-library-05fc7d/gpui-ui/web/browser-db/dnr-rules.json";
		const p = existsSync(alt) ? alt : existsSync(other) ? other : null;
		if (!p) return;
		expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(rules);
	});

	test("the manifest has the permissions and the rule resource", () => {
		const m = JSON.parse(manifest.replace("/*INJECT SCRIPTS*/", ""));
		for (const p of ["offscreen", "unlimitedStorage", "declarativeNetRequest", "storage", "nativeMessaging"]) expect(m.permissions).toContain(p);
		expect(m.declarative_net_request.rule_resources).toContainEqual({ id: "zoteroApiKey", enabled: true, path: "zotero-api-key-rules.json" });
		expect(m.host_permissions).toContain("https://repo.zotero.org/*");
		expect(m.host_permissions).toContain("https://api.zotero.org/*");
	});
});

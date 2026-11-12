// zotero-next fork: the save target and the routing in src/browserExt/nativeHost.js, with fake chrome.* APIs (no browser, no
// host program). Covers: the first-run choice, "never switches silently", saves going to the browser library over a
// "zinc-db" port, translators not asked of it, "save to this browser once", the {zincEnsureDb} message, and the manifest and
// header-rule files. Run: bun test test/native/browserTarget.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const source = readFileSync(join(ROOT, "src/browserExt/nativeHost.js"), "utf8");
const KEY = "zincBrowserLibrary";

type Sent = { target: "app" | "browser"; msg: any };
let sent: Sent[];
let store: Record<string, any>;
let created: any[];
let createError: string | null;
let hostInstalled: boolean;
let dbAnswers: boolean;
let runtimeMessages: any[];
let messageListeners: ((msg: any, sender: any, respond: (r: any) => void) => boolean | void)[];
let connectedNames: string[];

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** A fake extension port. `answer` decides how the other end replies to each frame. */
function fakePort(target: "app" | "browser", alive: boolean) {
	const onMsg: ((m: any) => void)[] = [];
	const onDisc: (() => void)[] = [];
	const emit = (m: any) => setTimeout(() => onMsg.forEach((l) => l(m)), 0);
	const port = {
		postMessage(msg: any) {
			sent.push({ target, msg });
			if (!alive) return;
			if (msg.t === "hello") return emit({ t: "hello", id: msg.id, proto: 2 });
			if (msg.t !== "req") return;
			const body = msg.method === "ping"
				? JSON.stringify({ prefs: { supportsAttachmentUpload: true, translatorsHash: "abc", sortedTranslatorHash: "def" }, via: target })
				: JSON.stringify({ ok: true, via: target });
			emit({ t: "res", id: msg.id, status: 200, headers: { "Content-Type": "application/json", "X-Zotero-Version": "9.9.9" }, n: 1 });
			emit({ t: "rc", id: msg.id, seq: 0, data: b64(body) });
		},
		disconnect() {},
		onMessage: { addListener: (l: any) => onMsg.push(l) },
		onDisconnect: { addListener: (l: any) => onDisc.push(l) },
	};
	if (!alive) {
		setTimeout(() => {
			(globalThis as any).chrome.runtime.lastError = { message: target === "app" ? "Specified native messaging host not found." : "Could not establish connection. Receiving end does not exist." };
			onDisc.forEach((l) => l());
			(globalThis as any).chrome.runtime.lastError = undefined;
		}, 0);
	}
	return port;
}

function install() {
	sent = [];
	store = {};
	created = [];
	createError = null;
	hostInstalled = true;
	dbAnswers = true;
	runtimeMessages = [];
	messageListeners = [];
	connectedNames = [];
	const g = globalThis as any;
	g.chrome = {
		runtime: {
			lastError: undefined,
			connectNative: () => fakePort("app", hostInstalled),
			connect: (info: { name: string }) => {
				connectedNames.push(info.name);
				return fakePort("browser", dbAnswers && created.length > 0);
			},
			sendMessage: (m: any) => {
				runtimeMessages.push(m);
				return Promise.resolve();
			},
			getContexts: async () => (created.length ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
			onMessage: { addListener: (l: any) => messageListeners.push(l) },
			onInstalled: { addListener() {} },
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
const to = (target: "app" | "browser") => sent.filter((s) => s.target === target && s.msg.t === "req").map((s) => s.msg.method);

let nh: any;
beforeEach(() => {
	nh = install();
});

describe("first run", () => {
	test("the host answers: the target is the app, and it is stored", async () => {
		expect(await nh.getSaveTarget()).toBe("app");
		expect(store[KEY]).toEqual({ saveTarget: "app", firstRunDone: true });
		expect(json(await call(nh, "getSelectedCollection", {})).via).toBe("app");
		expect(created.length).toBe(0);
		expect(connectedNames.length).toBe(0);
	});

	test("no host: the target is this browser, and saves go to the zinc-db port", async () => {
		hostInstalled = false;
		expect(await nh.getSaveTarget()).toBe("browser");
		expect(store[KEY]).toEqual({ saveTarget: "browser", firstRunDone: true });
		const r = await call(nh, "saveItems", { sessionID: "S1", items: [] });
		expect(json(r).via).toBe("browser");
		expect(connectedNames).toEqual(["zinc-db"]);
		expect(created.length).toBe(1);
		expect(created[0].url).toBe("offscreen/offscreen.html");
		expect(created[0].reasons).toContain("WORKERS");
		expect(typeof created[0].justification).toBe("string");
		expect(to("browser")).toContain("saveItems");
	});

	test("the target never switches by itself", async () => {
		// stored "browser", and a host that answers: still the browser
		store[KEY] = { saveTarget: "browser", firstRunDone: true };
		expect(json(await call(nh, "getSelectedCollection", {})).via).toBe("browser");
		expect(to("app")).toEqual([]);
		// stored "app", and a host that is gone: the call fails, the setting stays
		nh = install();
		hostInstalled = false;
		store[KEY] = { saveTarget: "app", firstRunDone: true };
		await expect(call(nh, "saveItems", { sessionID: "S2", items: [] })).rejects.toMatchObject({ status: 0 });
		expect(store[KEY].saveTarget).toBe("app");
		expect(created.length).toBe(0);
	});

	test("a firstRunDone flag without a target still probes the host", async () => {
		hostInstalled = false;
		store[KEY] = { firstRunDone: true };
		expect(await nh.getSaveTarget()).toBe("browser");
		expect(store[KEY].saveTarget).toBe("browser");
	});
});

describe("browser mode", () => {
	beforeEach(() => {
		store[KEY] = { saveTarget: "browser", firstRunDone: true };
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
		store[KEY] = { saveTarget: "browser", firstRunDone: true };
		createError = "Only a single offscreen document may be created.";
		// getContexts says there is none, createDocument says there is one: carry on
		dbAnswers = true;
		const fake = (globalThis as any).chrome;
		fake.runtime.connect = () => fakePort("browser", true);
		await expect(call(nh, "saveItems", { sessionID: "S4", items: [] })).resolves.toBeTruthy();
	});

	test("a multipart body goes over the browser port in frames", async () => {
		const r = await nh.request("POST", "saveSingleFile", { body: { sessionID: "S5", "binary-x": new Uint8Array([1, 2, 3]) }, headers: { "Content-Type": "multipart/form-data" }, timeout: 3000 });
		expect(json(r).via).toBe("browser");
		expect(sent.some((s) => s.target === "browser" && s.msg.t === "up")).toBe(true);
	});
});

describe("save to this browser once", () => {
	test("one save goes to the browser; the setting and the other sessions stay on the app", async () => {
		expect(await nh.getSaveTarget()).toBe("app");
		nh.saveOnceInBrowser();
		const r = await call(nh, "saveItems", { sessionID: "ONCE", items: [] });
		expect(json(r).via).toBe("browser");
		nh.endSaveOnce();
		// the same session keeps going to the browser (move, cancel, remove) ...
		expect(json(await call(nh, "updateSession", { sessionID: "ONCE", target: "L1" })).via).toBe("browser");
		expect(json(await call(nh, "saveAttachment", null, "?sessionID=ONCE")).via ?? "browser").toBe("browser");
		expect(await nh.routeOfSession("ONCE")).toBe("browser");
		// ... another session goes to the app, and the setting never changed
		expect(json(await call(nh, "saveItems", { sessionID: "OTHER", items: [] })).via).toBe("app");
		expect(store[KEY].saveTarget).toBe("app");
		expect(await nh.getSaveTarget()).toBe("app");
	});

	test("setSaveTarget is the only thing that changes the setting", async () => {
		await nh.getSaveTarget();
		await nh.setSaveTarget("browser");
		expect(store[KEY]).toEqual({ saveTarget: "browser", firstRunDone: true });
		await expect(nh.setSaveTarget("both")).rejects.toThrow();
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

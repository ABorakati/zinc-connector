// zotero-next fork: exercises the REAL src/browserExt/nativeHost.js and the patched Zotero.Connector.callMethod
// (src/common/connector.js) against the compiled zotero-next host, with a stand-in for chrome.runtime.connectNative
// that pipes the port's messages through native-messaging frames to the host process. Run: bun test test/native
// Needs the host built (zotero-next/connector-host: `bun run build`); path override: ZN_HOST_EXE.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const HOST_EXE = process.env.ZN_HOST_EXE ?? resolve(ROOT, "../zotero-next/connector-host/dist/zotero-next-host.exe");
const dir = mkdtempSync(join(tmpdir(), "znx-"));
const dbPath = join(dir, "library.sqlite");

// ---- chrome.runtime.connectNative over frames
let spawned = 0;
let lastPort: any;
function connectNative(name: string) {
	spawned++;
	const listeners: ((m: any) => void)[] = [];
	const disc: (() => void)[] = [];
	const proc = Bun.spawn([HOST_EXE], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, ZN_DB: dbPath, ZNH_APP_PORT: "0" } });
	let buf = Buffer.alloc(0);
	let maxFrame = 0;
	void (async () => {
		for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
			buf = Buffer.concat([buf, chunk]);
			while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
				const len = buf.readUInt32LE(0);
				maxFrame = Math.max(maxFrame, len);
				if (len > 1_000_000) throw new Error("host frame over 1 MB");
				const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
				buf = buf.subarray(4 + len);
				listeners.forEach((l) => l(msg));
			}
		}
	})();
	void proc.exited.then(() => {
		(globalThis as any).chrome.runtime.lastError = { message: "Native host has exited." };
		disc.forEach((d) => d());
	});
	const port = {
		name,
		proc,
		postMessage(msg: unknown) {
			const body = Buffer.from(JSON.stringify(msg));
			const head = Buffer.alloc(4);
			head.writeUInt32LE(body.length);
			if (body.length > 64 * 1024 * 1024) throw new Error("message to host over 64 MB");
			(proc.stdin as import("bun").FileSink).write(Buffer.concat([head, body]));
		},
		onMessage: { addListener: (l: (m: any) => void) => listeners.push(l) },
		onDisconnect: { addListener: (l: () => void) => disc.push(l) },
		get maxFrame() {
			return maxFrame;
		},
	};
	lastPort = port;
	return port;
}

function load(path: string) {
	(0, eval)(readFileSync(join(ROOT, path), "utf8"));
}

beforeAll(() => {
	const g = globalThis as any;
	g.chrome = { runtime: { connectNative, lastError: undefined } };
	g.ZOTERO_CONFIG = { CLIENT_NAME: "Zotero Next" };
	g.Zotero = {
		isSafari: false,
		isFirefox: false,
		version: "1.0.0",
		debug() {},
		logError() {},
		Prefs: { get: () => "" },
		HTTP: { StatusError: function () {} },
	};
	load("src/common/connector.js");
	load("src/browserExt/nativeHost.js");
});
afterAll(() => {
	lastPort?.proc.kill();
	rmSync(dir, { recursive: true, force: true });
});

const Z = () => (globalThis as any).Zotero;
const article = {
	id: "item1",
	itemType: "journalArticle",
	title: "Transport test article",
	creators: [{ firstName: "A", lastName: "Author", creatorType: "author" }],
	date: "2024",
	publicationTitle: "J",
	DOI: "10.1000/transport",
	url: "https://example.org/a",
	tags: ["t1"],
	notes: [],
	attachments: [{ id: "att1", title: "PDF", url: "https://example.org/a.pdf", mimeType: "application/pdf", parentItem: "item1" }],
	seeAlso: [],
};

describe("extension transport against the real host", () => {
	test("ping and getSelectedCollection through Zotero.Connector.callMethod", async () => {
		const ping = await Z().Connector.ping();
		expect(ping.prefs.supportsAttachmentUpload).toBe(true);
		expect(Z().Connector.isOnline).toBe(true);
		const hello = await Z().NativeHost.hello();
		expect(hello.db).toBe(dbPath);
		const sel = await Z().Connector.callMethod("getSelectedCollection", {});
		expect(sel.targets[0].id).toBe("L1");
	});

	test("a full save: saveItems, saveAttachment (9 MB, chunked), saveSingleFile, updateSession", async () => {
		const sessionID = "TS1";
		await Z().Connector.callMethod("saveItems", { sessionID, uri: "https://example.org/", items: [article] });
		const pdf = new Uint8Array(9 * 1024 * 1024).map((_, i) => (i * 7 + 3) & 0xff);
		pdf.set(new TextEncoder().encode("%PDF-1.4\n"));
		await Z().Connector.callMethod(
			{
				method: "saveAttachment",
				headers: { "Content-Type": "application/pdf", "X-Metadata": JSON.stringify({ id: "att1", url: "https://example.org/a.pdf", contentType: "application/pdf", parentItemID: "item1", title: "PDF" }) },
				queryString: `sessionID=${sessionID}`,
			},
			pdf.buffer,
		);
		const html = "<html><body>" + "snap ".repeat(1000) + "é€😀</body></html>";
		await Z().Connector.saveSingleFile({ method: "saveSingleFile", headers: { "Content-Type": "application/json" } }, { sessionID, items: [article], snapshotContent: html, url: "https://example.org/a", title: "Snapshot" });
		await Z().Connector.callMethod("updateSession", { sessionID, target: "L1", tags: ["viaTransport"], note: "" });

		const db = new Database(dbPath, { readonly: true });
		const top = db.query("SELECT key FROM items WHERE title = 'Transport test article'").get() as { key: string };
		expect(top).toBeTruthy();
		const atts = db.query("SELECT a.content_type, a.path FROM attachments a JOIN items i ON i.key = a.item_key WHERE i.parent_key = ?").all(top.key) as { content_type: string; path: string }[];
		const pdfPath = atts.find((a) => a.content_type === "application/pdf")!.path;
		expect(Buffer.compare(readFileSync(pdfPath), Buffer.from(pdf))).toBe(0);
		expect(readFileSync(atts.find((a) => a.content_type === "text/html")!.path, "utf8")).toBe(html);
		expect((db.query("SELECT count(*) n FROM item_tags WHERE item_key = ? AND tag = 'viaTransport'").get(top.key) as { n: number }).n).toBe(1);
		db.close();
		expect(readdirSync(join(dir, "storage")).length).toBe(2);
	});

	test("HTTP-style errors surface as CommunicationError with the status and body", async () => {
		const err = await Z().Connector.callMethod("updateSession", { sessionID: "missing", target: "L1" }).catch((e: any) => e);
		expect(err).toBeInstanceOf(Z().Connector.CommunicationError);
		expect(err.status).toBe(400);
		expect(err.value.error).toBe("SESSION_NOT_FOUND");
		// the host serves the translators bundled with Zinc (no repo.zotero.org round trip)
		const t = await Z().Connector.callMethod("getTranslators", {});
		expect(t.length).toBeGreaterThan(100);
		const code = await Z().Connector.callMethod("getTranslatorCode", { translatorID: t[0].translatorID });
		expect(code).toContain(t[0].translatorID);
		// what the host does not implement (client integration) is a 404
		const doc = await Z().Connector.callMethod("document/getActiveDocument", {}).catch((e: any) => e);
		expect(doc.status).toBe(404);
	});

	test("a multipart form with a big snapshot goes as upload frames and is saved", async () => {
		const sessionID = "TS2";
		await Z().Connector.callMethod("saveItems", { sessionID, uri: "https://example.org/", items: [{ ...article, id: "item2", title: "Form article", DOI: "10.1000/form", attachments: [] }] });
		const snapshotContent = "<html><body>" + "form snapshot ".repeat(200_000) + "</body></html>"; // 2.8M chars
		const posted: string[] = [];
		const realPost = lastPort.postMessage.bind(lastPort);
		lastPort.postMessage = (m: any) => (posted.push(m.t), realPost(m));
		await Z().Connector.callMethod(
			{ method: "saveSingleFile", headers: { "Content-Type": "multipart/form-data" } },
			{ sessionID, items: JSON.stringify([{ id: "item2" }]), url: "https://example.org/a", title: "Snapshot", snapshotContent },
		);
		expect(posted.filter((t) => t === "up").length).toBeGreaterThan(0);
		const db = new Database(dbPath, { readonly: true });
		const top = db.query("SELECT key FROM items WHERE title = 'Form article'").get() as { key: string };
		const att = db.query("SELECT path FROM attachments a JOIN items i ON i.key = a.item_key WHERE i.parent_key = ? AND a.content_type = 'text/html'").get(top.key) as { path: string };
		expect(readFileSync(att.path, "utf8")).toBe(snapshotContent);
		db.close(true);
	});

	test("a 20 MB PDF uploads in the background: the item is saved at once and other calls are not queued behind the upload", async () => {
		const sessionID = "TS3";
		const t0 = performance.now();
		await Z().Connector.callMethod("saveItems", { sessionID, uri: "https://example.org/", items: [{ ...article, id: "item3", title: "Big PDF article", DOI: "10.1000/big", attachments: [] }] });
		const itemSaved = performance.now() - t0;
		const pdf = new Uint8Array(20 * 1024 * 1024).map((_, i) => (i * 11 + 5) & 0xff);
		pdf.set(new TextEncoder().encode("%PDF-1.4\n"));
		const t1 = performance.now();
		let uploadDone = false;
		const upload = Z().Connector.callMethod(
			{
				method: "saveAttachment",
				headers: { "Content-Type": "application/pdf", "X-Metadata": JSON.stringify({ id: "att3", url: "https://example.org/big.pdf", contentType: "application/pdf", parentItemID: "item3", title: "Big PDF" }) },
				queryString: `sessionID=${sessionID}`,
			},
			pdf.buffer,
		).then(() => ((uploadDone = true), performance.now() - t1));
		await Bun.sleep(5);
		const t2 = performance.now();
		// a second save and a ping while the PDF is still going up
		const other = Z().Connector.callMethod("saveItems", { sessionID: "TS4", uri: "https://example.org/", items: [{ ...article, id: "item4", title: "Second article", DOI: "10.1000/second", attachments: [] }] }).then(() => performance.now() - t2);
		const secondSaved = await other;
		const uploadDoneWhenSecondSaved = uploadDone;
		const attachmentSaved = await upload;
		console.log(`item saved ${itemSaved.toFixed(0)} ms; second save during the upload ${secondSaved.toFixed(0)} ms; 20 MB attachment saved ${attachmentSaved.toFixed(0)} ms after it started`);
		expect(secondSaved).toBeLessThan(attachmentSaved);
		expect(uploadDoneWhenSecondSaved).toBe(false); // the second save came back before the upload finished
		const db = new Database(dbPath, { readonly: true });
		expect((db.query("SELECT COUNT(*) n FROM items WHERE title IN ('Big PDF article', 'Second article')").get() as any).n).toBe(2);
		expect((db.query("SELECT COUNT(*) n FROM attachments a JOIN items i ON i.key = a.item_key JOIN items p ON p.key = i.parent_key WHERE p.title = 'Big PDF article'").get() as any).n).toBe(1);
		db.close(true);
	});

	test("a dead host is reconnected on the next call", async () => {
		const before = spawned;
		lastPort.proc.kill();
		await lastPort.proc.exited;
		await Bun.sleep(50);
		expect(await Z().Connector.checkIsOnline()).toBe(true);
		expect(spawned).toBe(before + 1);
	});

	test("a missing host (connectNative disconnects at once) reads as offline", async () => {
		const g = globalThis as any;
		const real = g.chrome.runtime.connectNative;
		lastPort.proc.kill();
		await lastPort.proc.exited;
		await Bun.sleep(50);
		g.chrome.runtime.connectNative = () => {
			const d: (() => void)[] = [];
			queueMicrotask(() => {
				g.chrome.runtime.lastError = { message: "Specified native messaging host not found." };
				d.forEach((f) => f());
			});
			return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener: (f: () => void) => d.push(f) } };
		};
		expect(await Z().Connector.checkIsOnline()).toBe(false);
		g.chrome.runtime.connectNative = real;
	});
});


// A port that behaves as scripted, to exercise the failure paths deterministically.
function fakePort(onReq: (msg: any, port: any) => void, proto = 2) {
	const listeners: ((m: any) => void)[] = [];
	const disc: (() => void)[] = [];
	const sent: any[] = [];
	const port: any = {
		sent,
		reply: (m: any) => queueMicrotask(() => listeners.forEach((l) => l(m))),
		crash: (message = "Native host has exited.") =>
			queueMicrotask(() => {
				(globalThis as any).chrome.runtime.lastError = { message };
				disc.forEach((d) => d());
			}),
		postMessage(m: any) {
			sent.push(m);
			if (m.t === "hello") port.reply({ t: "hello", id: m.id, version: "t", proto });
			else if (m.t === "req") onReq(m, port);
		},
		onMessage: { addListener: (l: (m: any) => void) => listeners.push(l) },
		onDisconnect: { addListener: (l: () => void) => disc.push(l) },
	};
	return port;
}
const json = (id: number, status: number, body: unknown) => [
	{ t: "res", id, status, headers: { "Content-Type": "application/json", "X-Zotero-Version": "7" }, n: 1 },
	{ t: "rc", id, seq: 0, data: Buffer.from(JSON.stringify(body)).toString("base64") },
];

describe("extension transport: failure handling (scripted host)", () => {
	let real: any;
	beforeAll(async () => {
		real = (globalThis as any).chrome.runtime.connectNative;
		// close the real host's port first: the transport keeps one connection
		lastPort.proc.kill();
		await lastPort.proc.exited;
		await Bun.sleep(50);
	});
	afterAll(() => {
		(globalThis as any).chrome.runtime.connectNative = real;
	});
	let current: any = null;
	const use = (...ports: any[]) => {
		const rt = (globalThis as any).chrome.runtime;
		let i = 0;
		rt.connectNative = () => (current = ports[Math.min(i++, ports.length - 1)]);
		return () => i;
	};
	// every test starts from a closed port (the transport keeps one connection open)
	const reset = async () => {
		const p = current;
		current = null;
		if (p) {
			p.crash();
			await Bun.sleep(5);
		}
	};

	test("the host dying mid-save is a 502 HOST_CRASHED, not offline (status 0)", async () => {
		await reset();
		use(fakePort((_m, port) => port.crash()));
		await Z().NativeHost.hello(); // the port has spoken: a later death is a crash
		const err = await Z().NativeHost.request("POST", "saveItems", { body: "{}", headers: {} }).catch((e: any) => e);
		expect(err.status).toBe(502);
		expect(err.value.error).toBe("HOST_CRASHED");
	});

	test("a read-only call is retried once on a new connection after a crash", async () => {
		await reset();
		const first = fakePort((_m, port) => port.crash());
		const second = fakePort((m, port) => json(m.id, 200, { ok: 1 }).forEach((x) => port.reply(x)));
		const opened = use(first, second);
		await Z().NativeHost.hello();
		const xhr = await Z().NativeHost.request("POST", "getSelectedCollection", { body: "{}", headers: {} });
		expect(xhr.status).toBe(200);
		expect(opened()).toBe(2);
	});

	test("503 (library busy) is retried once for read-only calls, not for saves", async () => {
		await reset();
		let calls = 0;
		use(fakePort((m, port) => json(m.id, ++calls === 1 ? 503 : 200, { error: "busy" }).forEach((x) => port.reply(x))));
		const ok = await Z().NativeHost.request("POST", "getSelectedCollection", { body: "{}", headers: {} });
		expect(ok.status).toBe(200);
		expect(calls).toBe(2);
		calls = 0;
		const saved = await Z().NativeHost.request("POST", "saveItems", { body: "{}", headers: {} });
		expect(saved.status).toBe(503);
		expect(calls).toBe(1);
	});

	test("a timed-out upload is dropped on the host", async () => {
		await reset();
		const port = fakePort(() => {}); // never answers
		use(port);
		const err = await Z().NativeHost.request("POST", "saveAttachment", { body: new Uint8Array(1000).buffer, headers: {}, timeout: 60 }).catch((e: any) => e);
		expect(err.status).toBe(0);
		expect(err.message).toContain("timed out");
		const up = port.sent.find((m: any) => m.t === "up");
		expect(port.sent.some((m: any) => m.t === "drop" && m.uid === up.uid)).toBe(true);
	});

	test("the timeout restarts whenever the host shows life (a long response is not a timeout)", async () => {
		await reset();
		use(
			fakePort((m, port) => {
				const body = Buffer.from("x".repeat(30)).toString("base64");
				port.reply({ t: "res", id: m.id, status: 200, headers: {}, n: 3 });
				[0, 1, 2].forEach((seq, i) => setTimeout(() => port.reply({ t: "rc", id: m.id, seq, data: body }), 40 * (i + 1)));
			}),
		);
		// 120 ms in total, but never more than 40 ms between messages
		const xhr = await Z().NativeHost.request("POST", "saveItems", { body: "{}", headers: {}, timeout: 70 });
		expect(xhr.responseText.length).toBe(90);
	});

	test("ping is answered from a short cache, concurrent pings share one call", async () => {
		await reset();
		let reqs = 0;
		use(fakePort((m, port) => (reqs++, json(m.id, 200, { prefs: {} }).forEach((x) => port.reply(x)))));
		const [a, b] = await Promise.all([Z().NativeHost.request("POST", "ping", { body: "{}", headers: {} }), Z().NativeHost.request("POST", "ping", { body: "{}", headers: {} })]);
		await Z().NativeHost.request("POST", "ping", { body: "{}", headers: {} });
		expect(a).toBe(b);
		expect(reqs).toBe(1);
	});
});

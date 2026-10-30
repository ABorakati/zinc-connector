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
		// translators are not served by the host: upstream's repo fallback catches this
		const t = await Z().Connector.callMethod("getTranslators", {}).catch((e: any) => e);
		expect(t.status).toBe(404);
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

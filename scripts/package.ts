// zotero-next fork: packages the Zinc Connector as two zips from ONE build.
//
//   bun scripts/package.ts --tag v0.2.0 --library <dist-extension> [--out dist] [--skip-build]
//
//   Zinc-Connector-<version>.zip         unpacked installs ("Load unpacked" after unzipping). Keeps the manifest "key", so the
//                                        extension id is the pinned one (extension-id.txt) on every machine.
//   Zinc-Connector-<version>-store.zip   for a store upload (Chrome Web Store, Edge Add-ons). No "key": the store refuses one and
//                                        assigns its own id.
//
// <version> is the tag without the leading "v". Chrome wants 1 to 4 dot-separated integers (0-65535) in "version", so a
// pre-release such as v0.2.0-beta.1 gets version "0.2.0.1" and keeps the readable text in "version_name": "0.2.0-beta.1".
// (A pre-release therefore sorts AFTER its own release for the store: never upload a pre-release once the release is out.)
//
// The text after "Zinc-Connector-" in the zip name is exactly version_name (or version when there is no pre-release). It is also
// what zotero-next's gpui-ui/scripts/release.ts --extension-zip writes as "version" into latest-extension.json (it parses the zip
// name), and what browserExt/updateNotice.js compares the feed against (version_name || version). One string, three places.
//
//   --tag / --version  v0.2.0, 0.2.0 or 0.2.0-beta.1 (without one: 0.0.0, or the built manifest's own version with --skip-build)
//   --library <dir>    the library page build, as for build-win.ts (gpui-ui/dist-extension in zotero-next)
//   --out <dir>        where the zips go (default dist)
//   --skip-build       package the existing build/manifestv3 as it is (the version then comes from its manifest)
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

/** v0.2.0 -> { numeric: "0.2.0", name: "0.2.0" }; v0.2.0-beta.1 -> { numeric: "0.2.0.1", name: "0.2.0-beta.1" } */
export function versionFromTag(tag: string): { numeric: string; name: string } {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag.trim());
	if (!m) throw new Error(`not a version tag: "${tag}" (expected v1.2.3 or v1.2.3-beta.1)`);
	const [, a, b, c, pre] = m;
	const nums = [a, b, c].map(Number);
	let numeric = nums.join(".");
	if (pre) {
		const tail = /(\d+)(?!.*\d)/.exec(pre); // the last number of the pre-release: beta.2 -> 2, rc1 -> 1
		nums.push(tail ? Number(tail[1]) : 1);
		numeric = nums.join(".");
	}
	if (nums.some((n) => n > 65535)) throw new Error(`a version part is over 65535: ${numeric}`);
	return { numeric, name: `${a}.${b}.${c}${pre ? `-${pre}` : ""}` };
}

// ---- a small zip writer (deflate, fixed timestamp, forward slashes: the same input gives the same bytes) ----------------------------
type Entry = { name: string; data: Uint8Array };
export function makeZip(entries: Entry[]): Buffer {
	const DOS_TIME = 0;
	const DOS_DATE = (2020 - 1980) << 9 | 1 << 5 | 1; // 2020-01-01
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name, "utf8");
		const raw = Buffer.from(e.data);
		const packed = deflateRawSync(raw, { level: 9 });
		const useDeflate = packed.length < raw.length;
		const body = useDeflate ? packed : raw;
		const crc = crc32(raw) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
		local.writeUInt16LE(useDeflate ? 8 : 0, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		parts.push(local, name, body);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0);
		c.writeUInt16LE(20, 4); // made by
		c.writeUInt16LE(20, 6); // needed
		c.writeUInt16LE(0x0800, 8);
		c.writeUInt16LE(useDeflate ? 8 : 0, 10);
		c.writeUInt16LE(DOS_TIME, 12);
		c.writeUInt16LE(DOS_DATE, 14);
		c.writeUInt32LE(crc, 16);
		c.writeUInt32LE(body.length, 20);
		c.writeUInt32LE(raw.length, 24);
		c.writeUInt16LE(name.length, 28);
		c.writeUInt32LE(0o100644 << 16 >>> 0, 38); // external attributes: a regular file, rw-r--r--
		c.writeUInt32LE(offset, 42);
		central.push(c, name);
		offset += local.length + name.length + body.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, cd, end]);
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === "_metadata") continue; // written by Chrome into a folder it loaded; the stores reject it
			out.push(...listFiles(p));
		} else out.push(p);
	}
	return out;
}

if (import.meta.main) {
	const tag = opt("--tag") ?? opt("--version");
	const skipBuild = args.includes("--skip-build");
	const outDir = resolve(opt("--out") ?? join(ROOT, "dist"));
	const build = join(ROOT, "build", "manifestv3");

	let v: { numeric: string; name: string };
	if (tag) v = versionFromTag(tag);
	else if (skipBuild) {
		const mv = JSON.parse(readFileSync(join(build, "manifest.json"), "utf8"));
		v = { numeric: mv.version, name: mv.version_name ?? mv.version };
	} else v = { numeric: "0.0.0", name: "0.0.0" };

	if (!skipBuild) {
		const lib = opt("--library");
		const cmd = [process.execPath, "scripts/build-win.ts", "-v", v.numeric, ...(lib ? ["--library", lib] : [])];
		console.log(`building ${v.name} (manifest version ${v.numeric})...`);
		const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
		if (r.exitCode !== 0) throw new Error("build-win.ts failed");
	}
	if (!existsSync(join(build, "manifest.json"))) throw new Error(`no build at ${build}`);

	for (const need of ["library/library.html", "library/offscreen.html", "library/db-worker.js", "library/reader", "updateKey.js"]) {
		if (!existsSync(join(build, need))) throw new Error(`the build lacks ${need}: build with --library <zotero-next dist-extension> and an update public key`);
	}

	const manifest = JSON.parse(readFileSync(join(build, "manifest.json"), "utf8"));
	if (!manifest.key) throw new Error("the build has no manifest key: the unpacked zip would get a different id on every machine");
	manifest.version = v.numeric;
	if (v.name !== v.numeric) manifest.version_name = v.name;
	else delete manifest.version_name;
	const withKey = Buffer.from(JSON.stringify(manifest, null, "\t"));
	const { key: _key, ...rest } = manifest;
	const storeManifest = Buffer.from(JSON.stringify(rest, null, "\t"));

	const files = listFiles(build).sort();
	const entries = (manifestBytes: Buffer): Entry[] =>
		files.map((f) => {
			const name = relative(build, f).split(sep).join("/");
			if (/(^|\/)_(?!locales(\/|$))[^/]*/.test(name)) throw new Error(`the stores reject names starting with "_": ${name}`);
			return { name, data: name === "manifest.json" ? manifestBytes : readFileSync(f) };
		});

	mkdirSync(outDir, { recursive: true });
	const unpacked = join(outDir, `Zinc-Connector-${v.name}.zip`);
	const store = join(outDir, `Zinc-Connector-${v.name}-store.zip`);
	writeFileSync(unpacked, makeZip(entries(withKey)));
	writeFileSync(store, makeZip(entries(storeManifest)));
	for (const z of [unpacked, store]) console.log(`${z}  ${(statSync(z).size / 1048576).toFixed(2)} MB`);
	console.log(`manifest version ${v.numeric}${v.name !== v.numeric ? ` (version_name ${v.name})` : ""}; unpacked zip keeps the key, store zip has none`);
}

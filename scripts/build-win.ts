// zotero-next fork: Windows-friendly build of the Chrome (Manifest V3) extension with Bun.
//
// This is build.sh without its Unix-only tools (rsync, perl, jq, rsvg-convert, find, npx): the same steps in the
// same order for the Chrome build only, and the same gulp task (gulpfile.js, via scripts/run-gulp-task.cjs) for the
// script/manifest processing. Output: build/manifestv3 (load it unpacked in chrome://extensions).
//
//   bun scripts/build-win.ts [-d] [-v VERSION]
//     -d  debug build (unminified, keeps the translator tester and test data)
import { Resvg } from "@resvg/resvg-js";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const DEBUG = args.includes("-d");
const vi = args.indexOf("-v");
const VERSION = vi >= 0 ? args[vi + 1] : "1.0.0";

const SRC = join(ROOT, "src");
const BUILD = join(ROOT, "build");
const OUT_EXT = join(BUILD, "browserExt");
const OUT = join(BUILD, "manifestv3");
const SKIN = join(SRC, "zotero/chrome/skin/default/zotero");
const FORK_COLOR = "#0F8B8D"; // upstream's red Z (#DB2C3A) becomes teal, so the two extensions are told apart at a glance

const log = (m: string) => console.log(m);
const dirs = (p: string) => readdirSync(p, { withFileTypes: true });

/** rsync -r --exclude '.*' */
function copyTree(from: string, to: string) {
	mkdirSync(to, { recursive: true });
	for (const e of dirs(from)) {
		if (e.name.startsWith(".")) continue;
		const a = join(from, e.name);
		const b = join(to, e.name);
		if (e.isDirectory()) copyTree(a, b);
		else cpSync(a, b);
	}
}

function walk(dir: string, fn: (file: string) => void) {
	for (const e of dirs(dir)) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, fn);
		else fn(p);
	}
}

function renderPng(svg: string, width: number): Buffer {
	return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng());
}

const recolor = (svg: string) => svg.replace(/#DB2C3A/gi, FORK_COLOR);

// ---- 1. clean
for (const d of ["browserExt", "chrome", "manifestv3", "firefox", "safari", "bookmarklet"]) rmSync(join(BUILD, d), { recursive: true, force: true });
mkdirSync(OUT_EXT, { recursive: true });
mkdirSync(join(ROOT, "dist"), { recursive: true });

// ---- 2. images
log("Copying images...");
const images = join(OUT_EXT, "images");
mkdirSync(images, { recursive: true });
const cp2 = (from: string, toDir: string) => cpSync(from, join(toDir, basename(from)));
for (const f of readdirSync(join(SKIN, "item-type/16/light"))) if (f.endsWith("2x.svg")) cp2(join(SKIN, "item-type/16/light", f), images);
for (const f of ["collection.svg", "library.svg"]) cp2(join(SKIN, "collection-tree/16/light", f), images);
copyTree(join(SRC, "common/images"), images);
cp2(join(SKIN, "progress_arcs.png"), images);

// extension icons (chrome://extensions): a white Z on a teal tile, distinct from upstream's
const tile = (px: number) => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 16 16"><rect width="16" height="16" rx="3.2" fill="${FORK_COLOR}"/><g transform="translate(2.4 2.4) scale(0.7)"><path d="M13.863 2.73L13.027 1H2.137V3.8V3.921H8.822L1.289 13.233L2.137 15H13.863V12.142V12.021H6.448L13.863 2.73Z" fill="#fff"/></g></svg>`;
	return renderPng(svg, px);
};
for (const px of [16, 32, 64, 128]) writeFileSync(join(OUT_EXT, `Icon-${px}.png`), tile(px));

// toolbar icons (browser actions must be raster): NAME@16.png, NAME.png (32), NAME@48.png
const toolbarDir = join(images, "toolbar");
mkdirSync(toolbarDir, { recursive: true });
const toolbarSources = [
	join(ROOT, "icons/z.svg"),
	...readdirSync(join(ROOT, "icons/badged"))
		.filter((f) => f.endsWith(".svg") && !f.includes("@2x") && !f.endsWith("dark.svg"))
		.map((f) => join(ROOT, "icons/badged", f)),
	join(SKIN, "collection-tree/16/light/collection.svg"),
	join(SKIN, "collection-tree/16/light/library.svg"),
	join(SKIN, "16/universal/cross.svg"),
	join(SKIN, "16/universal/tick.svg"),
	join(SKIN, "16/light/loading.svg"),
];
for (const f of toolbarSources) {
	const name = basename(f, ".svg");
	const f2x = f.replace(".svg", "@2x.svg");
	const read = (p: string) => {
		let s = recolor(readFileSync(p, "utf8"));
		// resvg has no `context-fill`: the universal tick and cross icons get their colour directly
		if (name === "tick") s = s.replace(/context-fill/g, "#39bf68");
		if (name === "cross") s = s.replace(/context-fill/g, "#db2c3a");
		return s;
	};
	const small = read(f);
	const big = existsSync(f2x) ? read(f2x) : small;
	writeFileSync(join(toolbarDir, `${name}@16.png`), renderPng(small, 16));
	writeFileSync(join(toolbarDir, `${name}.png`), renderPng(big, 32));
	writeFileSync(join(toolbarDir, `${name}@48.png`), renderPng(big, 48));
}

// ---- 3. copyResources('browserExt')
log("Copying resources...");
cpSync(join(ROOT, "COPYING"), join(OUT_EXT, "COPYING"));
copyTree(join(SRC, "common"), OUT_EXT);
// The update notice's public key (src/browserExt/updateKey.js, git-ignored): written fresh for every build. A build without one would
// silently never show an update notice, so it fails here. ZN_ALLOW_NO_UPDATE_KEY=1 allows it, for a local build that does not need one.
Bun.spawnSync([process.execPath, "scripts/gen-update-key.ts"], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });
{
	const uk = join(SRC, "browserExt", "updateKey.js");
	const key = existsSync(uk) ? /ZINC_UPDATE_PUBKEY = "([^"]*)"/.exec(readFileSync(uk, "utf8"))?.[1] : undefined;
	if (!key && process.env.ZN_ALLOW_NO_UPDATE_KEY !== "1") {
		console.error("build-win: no update public key. Save zotero-next's gpui-ui/update-pubkey.txt (checked out next to this repo as ../zotero-next), or set ZN_UPDATE_PUBKEY_FILE / ZN_UPDATE_PUBKEY (see scripts/gen-update-key.ts). For a local build without an update notice set ZN_ALLOW_NO_UPDATE_KEY=1.");
		process.exit(1);
	}
}
copyTree(join(SRC, "browserExt"), OUT_EXT); // build.sh excludes ui/tree (does not exist here)
{
	const zj = join(OUT_EXT, "zotero.js");
	writeFileSync(zj, readFileSync(zj, "utf8").replace(/^(\s*this\.version\s*=\s*)"[^"]*"/m, `$1"${VERSION}"`));
}
copyTree(join(SRC, "translate/src"), join(OUT_EXT, "translate"));
copyTree(join(SRC, "utilities"), join(OUT_EXT, "utilities"));
copyTree(join(SRC, "zotero-google-docs-integration/src/connector"), join(OUT_EXT, "zotero-google-docs-integration"));
cpSync(join(SRC, "zotero-google-docs-integration/package.json"), join(OUT_EXT, "zotero-google-docs-integration/package.json"));

// locales
mkdirSync(join(OUT_EXT, "_locales/en"), { recursive: true });
cpSync(join(SRC, "messages.json"), join(OUT_EXT, "_locales/en/messages.json"));
const localeRoot = join(SRC, "zotero/chrome/locale");
for (const e of dirs(localeRoot)) {
	if (!e.isDirectory() || !/^(..|..-..)$/.test(e.name) || e.name === "en-US") continue;
	const connectorJson = join(localeRoot, e.name, "zotero/connector.json");
	if (!existsSync(connectorJson)) continue;
	const lang = e.name === "pt-PT" || e.name === "zh-TW" ? e.name : e.name.slice(0, 2);
	mkdirSync(join(OUT_EXT, "_locales", lang), { recursive: true });
	cpSync(connectorJson, join(OUT_EXT, "_locales", lang, "messages.json"));
}

// libs
const NM = join(ROOT, "node_modules");
const lib = join(OUT_EXT, "lib");
mkdirSync(lib, { recursive: true });
if (DEBUG) {
	for (const f of ["bluebird/js/browser/bluebird.js", "chai/chai.js", "mocha/mocha.js", "mocha/mocha.css", "sinon/pkg/sinon.js"]) cp2(join(NM, f), lib);
}
const libs: [string, string][] = [
	["react/umd/react.production.min.js", "react.js"],
	["react-dom/umd/react-dom.production.min.js", "react-dom.js"],
	["prop-types/prop-types.min.js", "prop-types.js"],
	["dompurify/dist/purify.min.js", "dompurify.js"],
	["react-dom-factories/index.js", "react-dom-factories.js"],
];
for (const [from, to] of libs) cpSync(join(NM, from), join(lib, to));

// .jsx are compiled by gulp; drop the sources and non-deployed files
walk(OUT_EXT, (p) => {
	if (p.endsWith(".jsx") || basename(p).startsWith(".git")) rmSync(p);
});
rmSync(join(OUT_EXT, "utilities/.github"), { recursive: true, force: true });
rmSync(join(OUT_EXT, "utilities/test"), { recursive: true, force: true });
for (const f of ["package.json", "package-lock.json", "COPYING", "README.md", "resource/README.md", "resource/schema"]) rmSync(join(OUT_EXT, "utilities", f), { recursive: true, force: true });

// SingleFile bundles
mkdirSync(join(lib, "SingleFile"), { recursive: true });
for (const f of ["single-file-bootstrap.js", "single-file-hooks-frames.js", "single-file.js"]) cpSync(join(ROOT, "lib/SingleFile", f), join(lib, "SingleFile", f));
cpSync(join(SRC, "zotero/chrome/content/zotero/xpcom/singlefile.js"), join(OUT_EXT, "singlefile-config.js"));
if (DEBUG) copyTree(join(SRC, "translate/testTranslators"), join(OUT_EXT, "tools/testTranslators")); // build.sh copies the .mjs files
else rmSync(join(OUT_EXT, "tools"), { recursive: true, force: true });

// ---- 4. the Chrome MV3 directory (gulp rewrites the processed files in place)
copyTree(OUT_EXT, OUT);
rmSync(OUT_EXT, { recursive: true, force: true });

// ---- 5. gulp: process-custom-scripts (JSX, manifest, script lists, schema)
log("Processing scripts (gulp)...");
const keyFile = join(ROOT, "extension-key.txt");
const env: Record<string, string | undefined> = { ...process.env };
if (existsSync(keyFile)) env.CHROME_EXTENSION_KEY = readFileSync(keyFile, "utf8").trim();
const gulpArgs = ["scripts/run-gulp-task.cjs", "process-custom-scripts", "--connector-version", VERSION, ...(DEBUG ? [] : ["-p"])];
const gulp = Bun.spawnSync([process.execPath, ...gulpArgs], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
writeFileSync(join(ROOT, "build.log"), gulp.stdout.toString() + gulp.stderr.toString());
if (gulp.exitCode !== 0) {
	console.error(gulp.stderr.toString() || gulp.stdout.toString());
	console.error("gulp failed (see build.log)");
	process.exit(1);
}

// gulp also emits the Firefox and Safari variants; this fork ships Chrome only
for (const d of ["firefox", "safari"]) rmSync(join(BUILD, d), { recursive: true, force: true });
rmSync(join(OUT, "manifest-v3.json"), { force: true });
if (!DEBUG) rmSync(join(OUT, "test"), { recursive: true, force: true });

// Chrome manifest: drop Firefox's `applications` (jq '. |= del(.applications)')
const mf = join(OUT, "manifest.json");
const manifest = JSON.parse(readFileSync(mf, "utf8"));
delete manifest.applications;
writeFileSync(mf, JSON.stringify(manifest, null, "\t"));

// ---- 6. the library page (library/library.html): the Zinc app built for the browser, whose data comes from the native
// host's "api" method. Built in zotero-next by `bun web/build.ts --target extension` (in gpui-ui); taken from --library <dir>,
// else ZINC_LIBRARY_DIST, else ../zotero-next/gpui-ui/dist-extension. Without it the extension builds as before and the
// toolbar menu has no "Open Zinc library" item.
{
	const li = args.indexOf("--library");
	const from = resolve(li >= 0 ? args[li + 1]! : process.env.ZINC_LIBRARY_DIST ?? join(ROOT, "..", "zotero-next", "gpui-ui", "dist-extension"));
	if (existsSync(join(from, "library.html"))) {
		copyTree(from, join(OUT, "library"));
		log(`library page: copied from ${from}`);
	} else log(`library page: none at ${from} (build it in zotero-next/gpui-ui: bun web/build.ts --target extension)`);
}

const size = (() => {
	let n = 0;
	walk(OUT, (p) => (n += statSync(p).size));
	return n;
})();
log(`done: ${OUT} (${(size / 1e6).toFixed(1)} MB, version ${manifest.version}${manifest.key ? ", pinned extension id" : ", NO key"})`);

# Zotero Next Connector

A fork of the [Zotero Connectors](https://github.com/zotero/zotero-connectors) browser extension (Chrome, Manifest V3
only) that saves into **zotero-next** instead of the Zotero desktop client, **without zotero-next or Zotero having to
be running**.

Licence: AGPL-3.0, same as upstream (`COPYING`). All translators, the save UI, SingleFile snapshots and the page
detection are upstream's; this fork only changes how the extension talks to its "Zotero".

## How it works

Upstream sends every call (`ping`, `getSelectedCollection`, `saveItems`, `saveAttachment`, `saveSingleFile`,
`updateSession`, ...) as an HTTP request to Zotero on `127.0.0.1:23119`. This fork sends the same calls over Chrome
**native messaging** (`chrome.runtime.connectNative`) to the *zotero-next host*, a small program Chrome starts on
demand and stops when the browser closes it. The host runs zotero-next's own Zotero-connector handlers
(`zotero-next/core/src/connector/handlers.ts`) against the library database, so what lands in the library is exactly
what a save through the app's Zotero port would produce (items, attachment files in `storage/`, collections, tags,
notes, and the sync outbox that pushes to Zotero the next time zotero-next syncs).

```
page ──translator──▶ extension ──native messaging──▶ zotero-next-host.exe ──▶ library.sqlite (+ storage/)
        (upstream)    nativeHost.js   4-byte-length JSON      core/src/connector/handlers.ts
```

Uploads (PDF bytes, SingleFile HTML, big multipart fields) are cut into 4 MiB chunks (Chrome allows 64 MB per message
to a host); responses larger than the 1 MB host-to-browser limit come back as base64 chunks. Small JSON bodies go in
the request message itself.

**Translators** come from the host too: it answers `getTranslators` / `getTranslatorCode` from the translators bundled
with Zinc (the app's `<library folder>/translators` when it has updated them, else `core/vendor/zotero/translators`),
so page detection works offline and on first run, and the extension no longer downloads the repository index from
repo.zotero.org. The extension re-asks every 24 h, so a translator update in the app reaches it within a day (or after
"Reset translators" in the options).

**Failures**: status 0 = the host cannot be started (not installed); 502 `HOST_CRASHED` = the host died with a call in
flight (not "offline", so a save is never sent to zotero.org by mistake); 503 = the library is busy. Read-only calls
are retried once after a reconnect. A timeout counts from the last sign of life and grows with the upload size;
uploads left behind by a failed call are dropped (the host also expires them after 10 minutes). `ping` answers are
reused for 5 s.

## What changed against upstream

| File | Change |
|---|---|
| `src/browserExt/nativeHost.js` | **new**: the transport (`Zotero.NativeHost`): chunked uploads, retries, ping cache |
| `src/common/connector.js` | `callMethod` calls `Zotero.NativeHost.request()` instead of `Zotero.HTTP.request()` (about 15 lines) |
| `gulpfile.js` | one line: load `nativeHost.js` in the background worker |
| `src/browserExt/manifest-v3.json` | name "Zotero Next Connector", `nativeMessaging` permission, Google Docs content scripts removed |
| `src/common/zotero_config.js` | `CLIENT_NAME` is "Zotero Next" (all UI strings use it) |
| `src/common/zotero.js` | no first-run "download Zotero" prompt |
| `scripts/build-win.ts`, `scripts/run-gulp-task.cjs` | **new**: Windows/Bun build (replaces `build.sh`, which needs rsync, perl, jq, rsvg-convert) |
| `scripts/gen-key.ts`, `extension-key.txt`, `extension-id.txt` | **new**: pins the extension id so the host can allow-list it |
| `test/native/transport.test.ts` | **new**: runs the real transport and `callMethod` against the compiled host |

Identity: the manifest `key` pins the id to `pakgagonakcalfbmckaolkpidcojacaf`, the icons are teal instead of red, and
the name differs, so it sits next to the official Zotero Connector without clashing (install only one of them on
sites where you do not want two "Save" buttons).

## Build

```
bun install
bun run build          # -> build/manifestv3  (bun scripts/build-win.ts [-d] [-v VERSION])
```

Needs no Node, npm, rsync, perl, jq or rsvg-convert: the toolbar icons are rendered with `@resvg/resvg-js` and gulp's
`process-custom-scripts` task is run through `scripts/run-gulp-task.cjs` (gulp 4's own runner never sees the stream
finish under Bun).

## Install

1. Build the host: in `zotero-next/connector-host`, `bun install` (once) and `bun run build`.
2. Register it: `powershell -File zotero-next\connector-host\install.ps1` (current user only, Chrome only).
3. Build the extension (above), then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
   `zotero-next-connector\build\manifestv3`.
4. Check the id shown is `pakgagonakcalfbmckaolkpidcojacaf`. Open any article page and use the toolbar button.

Uninstall: `uninstall.ps1`, then remove the extension.

## Not supported

* Word / LibreOffice / Google Docs citation integration (`document/*`), which needs a running client; the Google Docs
  scripts are not injected. (zotero-next has its own Word add-in.)
* Proxies (`getClientHostnames` answers an empty list). "Save to zotero.org" is still in the code but is not what
  you want here.
* Full-text indexing of saved PDFs happens when zotero-next next runs its indexer, not in the host.

## Merging upstream

Remotes: `origin` is upstream (`zotero/zotero-connectors`, default branch `main`, not `master`), `zn` is this fork
(`ABorakati/zinc-connector`, branch `zotero-next`). On branch `zotero-next`: `git fetch origin && git merge origin/main`
(shallow clone: `git fetch --unshallow origin` first if history is needed). Last merged: upstream `02271dc`. Conflicts, if any, are in `connector.js` `callMethod`, `manifest-v3.json` or `gulpfile.js`: the changes are
isolated for that. Submodules (`src/zotero`, `src/translate`, ...) are untouched and shallow.

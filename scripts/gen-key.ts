// zotero-next fork: one-off generator of the extension's pinned identity. Writes extension-key.txt (the public key
// that build-win.ts puts into manifest.json as "key") and prints the resulting Chrome extension id, which the
// native host manifest lists in allowed_origins. The private key is not kept: it is only needed to pack a .crx.
import { createHash, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ type: "spki", format: "der" });
const id = [...createHash("sha256").update(der).digest().subarray(0, 16)]
	.map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
	.join("");
writeFileSync(join(import.meta.dir, "..", "extension-key.txt"), der.toString("base64") + "\n");
writeFileSync(join(import.meta.dir, "..", "extension-id.txt"), id + "\n");
console.log(id);

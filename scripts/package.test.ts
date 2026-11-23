// bun test scripts/package.test.ts
import { describe, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { makeZip, versionFromTag } from "./package";

describe("versionFromTag", () => {
	test("a release tag: the tag without the v, same text both ways", () => {
		expect(versionFromTag("v0.2.0")).toEqual({ numeric: "0.2.0", name: "0.2.0" });
		expect(versionFromTag("1.12.3")).toEqual({ numeric: "1.12.3", name: "1.12.3" });
	});
	test("a pre-release: a fourth integer for the manifest, the readable text kept", () => {
		expect(versionFromTag("v0.2.0-beta.1")).toEqual({ numeric: "0.2.0.1", name: "0.2.0-beta.1" });
		expect(versionFromTag("v0.2.0-rc.12")).toEqual({ numeric: "0.2.0.12", name: "0.2.0-rc.12" });
		expect(versionFromTag("v0.2.0-rc1")).toEqual({ numeric: "0.2.0.1", name: "0.2.0-rc1" });
		expect(versionFromTag("v0.2.0-alpha")).toEqual({ numeric: "0.2.0.1", name: "0.2.0-alpha" });
	});
	test("a fix release: four integers, same text both ways", () => {
		expect(versionFromTag("v0.2.7.1")).toEqual({ numeric: "0.2.7.1", name: "0.2.7.1" });
	});
	test("numeric is always 1 to 4 integers of 0-65535", () => {
		for (const t of ["v0.0.1", "v9.9.9-beta.3", "v65535.0.0", "v1.2.3-x.y.7"]) {
			expect(versionFromTag(t).numeric).toMatch(/^\d+(\.\d+){0,3}$/);
			for (const n of versionFromTag(t).numeric.split(".")) expect(Number(n)).toBeLessThanOrEqual(65535);
		}
	});
	test("refuses what is not a version, and numbers Chrome would refuse", () => {
		for (const t of ["", "latest", "v1", "v1.2", "v1.2.3.4.5", "v1.2.3.4-beta.1", "v1.2.3-", "vx.y.z"]) expect(() => versionFromTag(t)).toThrow();
		expect(() => versionFromTag("v65536.0.0")).toThrow();
		expect(() => versionFromTag("v1.0.0-beta.70000")).toThrow();
	});
	test("a pre-release sorts after its release in a store (documented), and the update notice text round-trips", () => {
		expect(versionFromTag("v0.2.0-beta.1").name).toBe("0.2.0-beta.1");
	});
});

describe("makeZip", () => {
	test("stores names and contents readably and is deterministic", () => {
		const entries = [
			{ name: "manifest.json", data: Buffer.from('{"a":1}') },
			{ name: "library/x.js", data: Buffer.from("x".repeat(5000)) },
		];
		const a = makeZip(entries);
		expect(a.equals(makeZip(entries))).toBe(true);
		expect(a.readUInt32LE(0)).toBe(0x04034b50);
		expect(a.readUInt16LE(a.length - 22 + 10)).toBe(2); // entries in the end record
		// the second entry is deflated and inflates back
		const first = 30 + "manifest.json".length + 7;
		expect(a.readUInt16LE(first + 8)).toBe(8);
		const clen = a.readUInt32LE(first + 18);
		const nlen = a.readUInt16LE(first + 26);
		const body = a.subarray(first + 30 + nlen, first + 30 + nlen + clen);
		expect(inflateRawSync(body).toString()).toBe("x".repeat(5000));
	});
});

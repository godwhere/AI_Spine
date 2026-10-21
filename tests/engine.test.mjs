import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { sha256 } from "../shared/codec/sha256.mjs";
import { encodeBase64, decodeBase64 } from "../shared/codec/base64.mjs";
import { measureEngine } from "../scripts/measure-engine.mjs";

test("shared SHA-256 retains V1 byte/string fingerprints, including UTF-8 and padding boundaries", () => {
  for (const value of ["", "abc", "角色🦴", "a".repeat(1_000_000), ...[55, 56, 63, 64, 65, 255, 8193].map((size) => randomBytes(size))]) {
    assert.equal(sha256(value), createHash("sha256").update(value).digest("hex"));
  }
});

test("portable base64 retains browser padding, subarrays, whitespace and rejection rules", () => {
  for (const size of [...Array.from({ length: 130 }, (_, index) => index), 12287, 12288, 12289, 24577]) {
    const bytes = randomBytes(size + 7).subarray(7), expected = bytes.toString("base64");
    assert.equal(encodeBase64(bytes), expected);
    assert.deepEqual(decodeBase64(expected), Uint8Array.from(bytes));
    assert.deepEqual(decodeBase64(expected.replace(/=+$/, "")), Uint8Array.from(bytes));
  }
  for (const value of ["", "AA", "AAA", "AA==", "AAA=", " /+8=\r\n", "A", "A=", "AA=", "AA===", "=AAA", "AA*A", "角色"]) {
    let expected;
    try { expected = atob(value); } catch { assert.throws(() => decodeBase64(value), { name: "InvalidCharacterError" }); continue; }
    assert.deepEqual(decodeBase64(value), Uint8Array.from(expected, (char) => char.charCodeAt(0)));
  }
});

test("all 38 templates, pixels, rig sampling and exports preserve the baseline with reviewed adaptive bake output", async () => {
  const baseline = JSON.parse(await readFile(new URL("../docs/evidence/architecture-p2/engine-before.json", import.meta.url), "utf8"));
  // Keep the historical snapshot intact. Only the intentionally denser rig
  // timeline changes; source art, FK samples, metadata and exports stay pinned.
  baseline.rig.skeleton = "ba79f29bb802add307210736aa39d9e069dc27ffb395a4f16f6616a8678fe309";
  baseline.rig.files["rig.json"] = baseline.rig.skeleton;
  assert.deepEqual(await measureEngine(), baseline);
});

test("every shared and engine module imports with platform IO disabled and no DOM", async () => {
  async function modules(url) {
    return (await Promise.all((await readdir(url, { withFileTypes: true })).map((entry) => {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), url);
      return entry.isDirectory() ? modules(child) : /\.(mjs|js)$/.test(entry.name) ? [child.href] : [];
    }))).flat();
  }
  const files = [...await modules(new URL("../shared/", import.meta.url)), ...await modules(new URL("../engine/", import.meta.url))];
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    for (const name of ["window", "document", "navigator", "fetch", "indexedDB", "localStorage", "sessionStorage", "crypto", "Image", "File", "Blob", "OffscreenCanvas", "createImageBitmap"]) {
      Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error("Platform access: " + name); } });
    }
    for (const file of ${JSON.stringify(files)}) await import(file);
    process.stdout.write("pure imports passed");
  `], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "pure imports passed");
});

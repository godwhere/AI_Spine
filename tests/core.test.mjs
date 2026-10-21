import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { cleanPath, resolveFile } from "../engine/archive/paths.js";
import { parseBundle } from "../src/infrastructure/archive-files.js";
import { unpackZip, MAX_PACKAGE_FILES, MAX_PACKAGE_BYTES } from "../engine/archive/zip.js";
import { exportPackage } from "../engine/archive/package.js";
import { identityTransform } from "../engine/images/calibration.js";
import { buildGenerationRequest, createGenerationService } from "../src/infrastructure/generation-client.js";
import { template, synthetic } from "./helpers.mjs";

test("runtime export keeps skeleton and atlas byte-for-byte, then imports again", () => {
  const original = template("22"),
    result = unpackZip(exportPackage(original));
  assert.deepEqual(result["skeleton.json"], original.files["skeleton.json"]);
  assert.deepEqual(result["skeleton.atlas"], original.files["skeleton.atlas"]);
  const imported = parseBundle(result);
  assert.equal(imported.parts.length, 49);
  assert.equal(imported.animations.length, 7);
  assert.equal(imported.skins.length, 2);
});
test("editable project retains originals, replacement bytes and calibration independently of baked textures", () => {
  const original = template("1"),
    part = original.parts[0],
    replacement = original.files["skeleton.png"];
  const edits = {
    [part.id]: {
      image: replacement,
      fileName: "replacement.png",
      transform: { ...identityTransform(), x: 8, rotation: 22, flipX: true },
    },
  };
  const imported = parseBundle(
    unpackZip(
      exportPackage(
        original,
        { "skeleton.png": new Uint8Array([1, 2, 3]) },
        { editable: true, edits, name: "My character" },
      ),
    ),
  );
  assert.equal(imported.name, "My character");
  assert.deepEqual(imported.files, original.files);
  assert.deepEqual(imported.edits[part.id].image, replacement);
  assert.deepEqual(imported.edits[part.id].transform, edits[part.id].transform);
});
test("rejects unsafe archive paths and invalid/truncated ZIP", () => {
  for (const path of ["../secret", "/root/a", "a/../b", "C:\\private"])
    assert.throws(() => cleanPath(path));
  assert.throws(() => unpackZip(new Uint8Array([1, 2, 3])), /ZIP/);
  assert.throws(
    () => unpackZip(zipSync({ "../unsafe": new Uint8Array([1]) })),
    /路径/,
  );
});
test("rejects oversized decompressed data before allocating it", () => {
  const bytes = zipSync({ test: new Uint8Array([1]) }),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length - 46; i++)
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, 300 * 1024 * 1024, true);
      break;
    }
  assert.throws(() => unpackZip(bytes), /解压后超过/);
});
test("an editable package with 2049 actual ZIP members roundtrips every original file", () => {
  const bundle = synthetic();
  for (let i = Object.keys(bundle.files).length; i < 1024; i++)
    bundle.files[`pose-regions/part-${i}.bin`] = Uint8Array.of(i & 255, (i >> 8) & 255, 253);
  const bytes = exportPackage(bundle, {}, { editable: true });
  const unpacked = unpackZip(bytes);
  assert.equal(Object.keys(unpacked).length, 2049);
  assert.deepEqual(parseBundle(unpacked).files, bundle.files);
});
test("the same file-count limit accepts 4096 members and rejects larger imports and exports", () => {
  assert.equal(MAX_PACKAGE_FILES, 4096);
  const bundle = synthetic();
  for (let i = Object.keys(bundle.files).length; i < MAX_PACKAGE_FILES; i++)
    bundle.files[`pose-regions/part-${i}.bin`] = Uint8Array.of(i & 255);
  assert.equal(Object.keys(unpackZip(exportPackage(bundle))).length, MAX_PACKAGE_FILES);
  bundle.files["one-too-many.bin"] = Uint8Array.of(17);
  assert.throws(() => exportPackage(bundle), /文件数量过多/);
  assert.throws(() => unpackZip(zipSync(bundle.files)), /文件数量过多/);
  const editable = synthetic();
  for (let i = Object.keys(editable.files).length; i < 2048; i++) editable.files[`part-${i}.bin`] = Uint8Array.of(1);
  assert.throws(() => exportPackage(editable, {}, { editable: true }), /文件数量过多/);
});
test("export preflight keeps the 256 MiB uncompressed cap including editable originals", () => {
  assert.equal(MAX_PACKAGE_BYTES, 256 * 1024 * 1024);
  // Repeated references model total archived size without allocating 257 MiB
  // or invoking compression on an artifact that cannot be re-imported.
  const chunk = new Uint8Array(1024 * 1024), files = {};
  for (let i = 0; i < 257; i++) files[`large-${i}.bin`] = chunk;
  assert.throws(() => exportPackage({ files, name: "Oversized" }), /解压后超过 256 MB/);
  const original = Object.fromEntries(Object.entries(files).slice(0, 128));
  assert.throws(() => exportPackage({ files: original, name: "Oversized editable" }, {}, { editable: true }), /解压后超过 256 MB/);
});
test("missing textures and unsupported minor versions give actionable errors", () => {
  const original = template("1"),
    missing = { ...original.files };
  delete missing["skeleton.png"];
  assert.throws(() => parseBundle(missing), /找不到贴图/);
  const json = structuredClone(original.json);
  json.skeleton.spine = "4.2.99";
  assert.throws(
    () =>
      parseBundle({
        ...original.files,
        "skeleton.json": new TextEncoder().encode(JSON.stringify(json)),
      }),
    /4.2.99/,
  );
});
test("flat multi-file imports are canonicalized to the atlas relative path on export", () => {
  const original = synthetic({ nested: true });
  assert.equal(original.pages[0].file, "textures/page.png");
  assert.ok(unpackZip(exportPackage(original))["textures/page.png"]);
  assert.throws(
    () =>
      resolveFile(
        { "a/x.png": new Uint8Array(1), "b/x.png": new Uint8Array(1) },
        "r.atlas",
        "x.png",
      ),
    /找不到/,
  );
});
test("multiple skeletal JSON files require explicit selection", () => {
  const original = template("1"),
    files = {
      ...original.files,
      "other.json": original.files["skeleton.json"],
    };
  assert.throws(
    () => parseBundle(files),
    (error) => error.candidates?.length === 2,
  );
  assert.equal(
    parseBundle(files, { skeletonPath: "skeleton.json" }).skeletonPath,
    "skeleton.json",
  );
});
test("future generation boundary is explicit, cancellable, and disconnected by default", async () => {
  const bundle = synthetic(),
    request = buildGenerationRequest(bundle, {
      prompt: "blue armor",
      partIds: ["part"],
    });
  assert.equal(request.kind, "parts");
  assert.equal(request.parts[0].width, 10);
  assert.throws(
    () =>
      buildGenerationRequest(bundle, { prompt: "test", partIds: ["missing"] }),
    /没有这个部件/,
  );
  const service = createGenerationService();
  assert.equal(service.configured, false);
  await assert.rejects(() => service.generate(request), {
    code: "GENERATION_NOT_CONNECTED",
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => service.generate(request, { signal: controller.signal }),
    { name: "AbortError" },
  );
});

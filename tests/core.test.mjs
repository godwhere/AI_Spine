import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import {
  cleanPath,
  parseBundle,
  unpackZip,
  exportPackage,
  resolveFile,
} from "../src/core/archive.js";
import { identityTransform } from "../src/core/pixels.js";
import {
  buildGenerationRequest,
  createGenerationService,
} from "../src/core/generation.js";
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

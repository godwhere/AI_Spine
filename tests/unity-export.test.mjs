import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";
import { parseBundle } from "../src/infrastructure/archive-files.js";
import { skeletonCandidates } from "../engine/archive/bundle.js";
import { encodeText, decodeText } from "../shared/codec/text.mjs";
import { parseSkeleton } from "../engine/spine/parse.js";
import { measureAnimation } from "../engine/spine/geometry.js";
import { compilePages, extractPart } from "../src/infrastructure/calibration.js";
import { identityTransform } from "../engine/images/calibration.js";
import { synthetic, pixelEnv } from "./helpers.mjs";

function binaryFixture() {
  const folder = new URL("./fixtures/binary/", import.meta.url);
  const bundle = parseBundle(Object.fromEntries(["spineboy-pro.skel", "spineboy.atlas", "spineboy.png"]
    .map((name) => [name, new Uint8Array(readFileSync(new URL(name, folder)))])));
  const { data } = parseSkeleton(bundle);
  return { ...bundle, animations: data.animations.map((animation) => animation.name) };
}
const unityFiles = (bundle, pages = {}) => unpackZip(exportPackage(bundle, pages, { target: "unity" }));

test("Unity JSON export preserves skeleton, atlas, PNG, and unrelated user files byte-for-byte", () => {
  const original = synthetic(), note = encodeText("keep this user file");
  const bundle = { ...original, files: { ...original.files, "notes/author.txt": note } };
  const runtimeBefore = exportPackage(bundle), output = unityFiles(bundle);
  assert.deepEqual(Object.keys(output).sort(), ["README-Unity.md", "notes/author.txt", "page.png", "skeleton.atlas.txt", "skeleton.json"]);
  assert.deepEqual(output["skeleton.json"], bundle.files["skeleton.json"]);
  assert.deepEqual(output["skeleton.atlas.txt"], bundle.files["skeleton.atlas"]);
  assert.deepEqual(output["page.png"], bundle.files["page.png"]);
  assert.deepEqual(output["notes/author.txt"], note);
  const roundtrip = parseBundle(output);
  assert.equal(roundtrip.skeletonPath, "skeleton.json"); assert.equal(roundtrip.parts.length, bundle.parts.length);
  assert.equal(parseSkeleton(roundtrip).data.animations.length, bundle.animations.length);
  assert.deepEqual(exportPackage(bundle), runtimeBefore, "Unity export cannot mutate legacy runtime output");
  const readme = decodeText(output["README-Unity.md"]);
  for (const text of ["4.3", "major.minor", "SkeletonDataAsset", "Straight Alpha", "Gamma", "PMA", "Texture Unpacker", "Import Data", "Nonessential"])
    assert.ok(readme.includes(text), `missing instructions: ${text}`);
});

test("the real 4.3 binary fixture exports as skel.bytes and imports with every animation intact", () => {
  const bundle = binaryFixture(), runtimeBefore = exportPackage(bundle), output = unityFiles(bundle);
  assert.ok(!output["spineboy-pro.skel"]);
  assert.deepEqual(output["spineboy-pro.skel.bytes"], bundle.files["spineboy-pro.skel"]);
  assert.deepEqual(output["spineboy.atlas.txt"], bundle.files["spineboy.atlas"]);
  assert.deepEqual(output["spineboy.png"], bundle.files["spineboy.png"]);
  assert.deepEqual(skeletonCandidates(output), ["spineboy-pro.skel.bytes"]);
  const imported = parseBundle(output), { data } = parseSkeleton(imported);
  assert.equal(imported.binary, true); assert.equal(imported.parts.length, 40); assert.equal(data.animations.length, 11);
  assert.ok(measureAnimation(data, "walk", "default").width > 0);
  assert.deepEqual(exportPackage(bundle), runtimeBefore);
});

test("already Unity-named assets and unchanged generated instructions can be exported again", () => {
  const original = unityFiles(binaryFixture()), imported = parseBundle(original);
  const output = unityFiles(imported);
  assert.deepEqual(Object.keys(output).sort(), Object.keys(original).sort());
  for (const [path, bytes] of Object.entries(original)) assert.deepEqual(output[path], bytes);
  assert.ok(!Object.keys(output).some((path) => /\.bytes\.bytes$|\.txt\.txt$/i.test(path)));
});

test("multi-skeleton skel.bytes imports select the atlas with the matching basename", () => {
  const source = binaryFixture().files;
  const files = {
    "hero.skel.bytes": source["spineboy-pro.skel"], "other.skel.bytes": source["spineboy-pro.skel"],
    "hero.atlas.txt": source["spineboy.atlas"], "other.atlas.txt": source["spineboy.atlas"], "spineboy.png": source["spineboy.png"],
  };
  assert.throws(() => parseBundle(files), (error) => error.candidates?.length === 2);
  const imported = parseBundle(files, { skeletonPath: "hero.skel.bytes" });
  assert.deepEqual(imported.atlasPaths, ["hero.atlas.txt"]);
  assert.equal(parseSkeleton(imported).data.animations.length, 11);
});

for (const rotate of [0, 90]) for (const pma of [false, true])
  test(`Unity export preserves nested multi-page references, rotation ${rotate}, and pma ${pma}`, async () => {
    const base = synthetic({ rotate, pma, nested: true }), files = { ...base.files };
    files["skeleton.atlas"] = encodeText(`${decodeText(files["skeleton.atlas"])}\ntextures/other.png\nsize:24,24\nfilter:Linear,Linear\npma:${pma}\nother-part\nbounds:0,0,4,4\n`);
    files["textures/other.png"] = files["textures/page.png"];
    const bundle = parseBundle(files), part = bundle.parts[0];
    const image = await pixelEnv.encode(await extractPart(bundle, part, pixelEnv));
    const edits = { part: { image, transform: { ...identityTransform(), flipX: true } } };
    const pages = await compilePages(bundle, edits, pixelEnv), runtime = unpackZip(exportPackage(bundle, pages));
    assert.ok(pages["textures/page.png"]);
    const output = unityFiles(bundle, pages), imported = parseBundle(output);
    assert.equal(imported.pages.length, 2); assert.equal(imported.parts.length, 2);
    assert.deepEqual(imported.pages.map((page) => [page.name, page.pma]), bundle.pages.map((page) => [page.name, page.pma]));
    assert.equal(imported.parts[0].degrees, part.degrees);
    assert.deepEqual(output["skeleton.atlas.txt"], bundle.files["skeleton.atlas"]);
    assert.deepEqual(output["skeleton.json"], bundle.files["skeleton.json"]);
    for (const page of bundle.pages) assert.deepEqual(output[page.file], runtime[page.file]);
    assert.deepEqual(output["textures/other.png"], files["textures/other.png"]);
    assert.deepEqual(await compilePages(imported, {}, pixelEnv), {});
    assert.equal(parseSkeleton(imported).data.animations.length, 1);
  });

test("Unity export explicitly rejects filename, case, directory and README collisions", () => {
  const bundle = synthetic();
  for (const path of ["skeleton.atlas.txt", "PAGE.PNG", "README-Unity.md", "readme-unity.MD", "README-Unity.md/notes.txt"])
    assert.throws(() => unityFiles({ ...bundle, files: { ...bundle.files, [path]: encodeText("user content must survive") } }), /冲突/);
  const binary = binaryFixture();
  assert.throws(() => unityFiles({ ...binary, files: { ...binary.files, "spineboy-pro.skel.bytes": encodeText("different binary") } }), /冲突/);
  assert.throws(() => unityFiles(bundle, { "skeleton.json": encodeText("invalid overwrite") }), /非 Atlas/);
  assert.throws(() => unityFiles({ ...bundle, files: { ...bundle.files, ["__proto__"]: encodeText("user content") } }), /不支持这个文件名/);
  assert.throws(() => exportPackage(bundle, {}, { target: "unity", editable: true }), /分别导出/);
});

test("editable project exports keep their metadata and exact source names", () => {
  const bundle = binaryFixture(), output = unpackZip(exportPackage(bundle, {}, { editable: true, name: "Editable binary" }));
  assert.ok(output["spineboy-pro.skel"]); assert.ok(output["spineboy.atlas"]); assert.ok(output[".ai-spine/project.json"]);
  assert.ok(!output["spineboy-pro.skel.bytes"]); assert.ok(!output["README-Unity.md"]);
  const imported = parseBundle(output);
  assert.equal(imported.name, "Editable binary"); assert.equal(parseSkeleton(imported).data.animations.length, 11);
});

test("the real package worker returns Uint8Array and validates renamed JSON and binary exports", async (t) => {
  const previousSelf = globalThis.self, messages = [];
  globalThis.self = { postMessage: (message) => messages.push(message) };
  t.after(() => { globalThis.self = previousSelf; });
  await import(`../src/workers/package.worker.js?unity=${crypto.randomUUID()}`);
  for (const bundle of [synthetic(), binaryFixture()]) {
    self.onmessage({ data: { operation: "export", bundle, pages: {}, options: { target: "unity" } } });
    const response = messages.pop(); assert.equal(response.error, undefined);
    assert.ok(response.result instanceof Uint8Array);
    assert.equal(parseSkeleton(parseBundle(unpackZip(response.result))).data.animations.length, bundle.animations.length);
  }
});

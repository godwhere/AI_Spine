import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Skeleton, AnimationState, AnimationStateData, Physics } from "@esotericsoftware/spine-webgl";
import { addTemplateVariant, templateVariantBase, templateVariantEntries } from "../src/core/template-variants.js";
import { parseBundle, exportPackage, unpackZip } from "../src/core/archive.js";
import { parseSkeleton, attachmentVertices } from "../src/spine/runtime.js";
import { extractPart, renderReplacement, compilePages, identityTransform } from "../src/core/pixels.js";
import { template, synthetic, pixelEnv } from "./helpers.mjs";

const MANIFEST = ".ispine/template-variants/manifest.json", sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = (value) => structuredClone(value), near = (a, b, tolerance = .0001) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
const pixels = (canvas) => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
function image16(color = "#9d4d74") {
  const canvas = createCanvas(576, 576), context = canvas.getContext("2d");
  context.fillStyle = color; context.fillRect(108, 144, 372, 342); context.fillStyle = "rgba(250,90,40,.5)"; context.fillRect(120, 160, 70, 100);
  context.clearRect(220, 210, 40, 30); return new Uint8Array(canvas.toBuffer("image/png"));
}
function options(image = image16(), extra = {}) { return { partId: "face", image, name: "受击痛苦", animations: ["unit_damage", "unit_dead"], provenance: { jobId: "fixture-job", imageId: "fixture-image" }, ...extra }; }
function actor(bundle, name, skinIndex = 0) {
  const { data } = parseSkeleton(bundle), skeleton = new Skeleton(data); skeleton.setSkin(data.skins[skinIndex]); skeleton.setupPose();
  const state = new AnimationState(new AnimationStateData(data)); let track = state.setAnimation(0, name, false);
  return { data, skeleton, set(name) { track = state.setAnimation(0, name, false); }, sample(time, reset = true) { if (reset) skeleton.setupPose(); track.trackTime = time; state.apply(skeleton); skeleton.updateWorldTransform(Physics.none); return skeleton; } };
}
function jsonBundle(bundle, edit) { const json = clone(bundle.json); edit(json); return parseBundle({ ...bundle.files, [bundle.skeletonPath]: new TextEncoder().encode(JSON.stringify(json)) }, { skeletonPath: bundle.skeletonPath }); }
function stripAttachmentChanges(json, generatedIds = []) {
  const value = clone(json);
  for (const skin of value.skins) for (const attachments of Object.values(skin.attachments)) for (const id of generatedIds) delete attachments[id];
  for (const animation of Object.values(value.animations)) if (animation.slots) {
    for (const [slot, channels] of Object.entries(animation.slots)) { delete channels.attachment; if (!Object.keys(channels).length) delete animation.slots[slot]; }
    if (!Object.keys(animation.slots).length) delete animation.slots;
  }
  return value;
}
function compareQuad(original, derived, animation, time, originalId = "face") {
  const left = actor(original, animation).sample(time), right = actor(derived, animation).sample(time), a = attachmentVertices(left, left.findSlot(originalId)), b = attachmentVertices(right, right.findSlot(originalId));
  assert.equal(a.vertices.length, b.vertices.length); a.vertices.forEach((value, index) => near(value, b.vertices[index]));
  left.bones.forEach((bone, index) => { for (const key of ["worldX", "worldY", "a", "b", "c", "d"]) near(bone.appliedPose[key], right.bones[index].appliedPose[key]); });
}

test("real template16 face variant preserves rotated trimmed world quad, all non-attachment channels and actual death fade", async () => {
  const source = template("16"), before = clone(source.json), originalBytes = source.files[source.skeletonPath].slice(), input = image16(), out = await addTemplateVariant(source, options(input), pixelEnv);
  assert.deepEqual(templateVariantEntries(out.bundle), [{ regionId: out.partId, originalPartId: "face", name: "受击痛苦", animations: ["unit_damage", "unit_dead"] }]);
  assert.deepEqual(source.json, before); assert.deepEqual(source.files[source.skeletonPath], originalBytes);
  assert.equal(out.bundle.parts.length, source.parts.length + 1); assert.equal(out.bundle.pages.length, source.pages.length + 1);
  const old = source.parts.find((part) => part.id === "face"), next = out.bundle.parts.find((part) => part.id === out.partId);
  assert.deepEqual([old.width, old.height, old.originalWidth, old.originalHeight, old.offsetX, old.offsetY, old.degrees], [186, 171, 288, 288, 54, 45, 90]);
  for (const field of ["width", "height", "originalWidth", "originalHeight", "offsetX", "offsetY", "degrees"]) assert.equal(next[field], old[field]);
  assert.equal(next.pma, false); assert.deepEqual(stripAttachmentChanges(out.bundle.json, [out.partId]), stripAttachmentChanges(before));
  assert.equal(out.metadata.nativeSHA256, sha(input)); assert.deepEqual(out.bundle.files[out.metadata.nativePath], input); assert.deepEqual(out.edit.image, input);
  input[20] ^= 255; assert.notDeepEqual(out.bundle.files[out.metadata.nativePath], input, "native archive bytes must be independent of caller storage");
  for (const [animation, expected] of Object.keys(before.animations).map((id) => [id, options().animations.includes(id) ? out.partId : "face"])) {
    for (const time of [0, .123, .4, .45, .5]) { const runtime = actor(out.bundle, animation), skeleton = runtime.sample(time); assert.equal(skeleton.findSlot("face").appliedPose.attachment.name, expected); compareQuad(source, out.bundle, animation, time); }
    assert.equal(out.bundle.json.animations[animation].slots.face.attachment[0].time, 0);
  }
  const death = actor(out.bundle, "unit_dead"); near(death.sample(.4).findSlot("face").appliedPose.color.a, 1); near(death.sample(.45).findSlot("face").appliedPose.color.a, .5, .00001); near(death.sample(.5).findSlot("face").appliedPose.color.a, 0);
  death.set("unit_wait"); const restored = death.sample(.1, false); assert.equal(restored.findSlot("face").appliedPose.attachment.name, "face"); near(restored.findSlot("face").appliedPose.color.a, 1);
});
test("native logical-frame fitting and supplied calibration are applied once, with ordinary PartEditor page compilation", async () => {
  const source = template("16"), transform = { ...identityTransform(), x: 3, y: -2, scaleX: .94, scaleY: .94, rotation: 2 }, input = image16();
  const out = await addTemplateVariant(source, options(input, { transform }), pixelEnv), part = out.bundle.parts.find((part) => part.id === out.partId);
  assert.deepEqual(out.edit.transform, transform); const expected = await renderReplacement(part, out.edit, pixelEnv), actual = await extractPart(out.bundle, part, pixelEnv), a = pixels(expected), b = pixels(actual);
  const top = part.originalHeight - part.offsetY - part.height;
  for (let y = 0; y < part.originalHeight; y++) for (let x = 0; x < part.originalWidth; x++) {
    const index = (y * part.originalWidth + x) * 4, inside = x >= part.offsetX && x < part.offsetX + part.width && y >= top && y < top + part.height;
    if (!inside) assert.equal(b[index + 3], 0); else { near(a[index + 3], b[index + 3], 1.01); for (let c = 0; c < 3; c++) near(a[index + c] * a[index + 3] / 255, b[index + c] * b[index + 3] / 255, 2.01); }
  }
  const pages = await compilePages(out.bundle, { [out.partId]: out.edit }, pixelEnv), compiled = parseBundle({ ...out.bundle.files, ...pages });
  assert.deepEqual(pixels(await extractPart(compiled, compiled.parts.find((part) => part.id === out.partId), pixelEnv)), b);
  assert.equal(out.metadata.normalization.mode, "contain-logical-frame-then-calibrate"); assert.equal(out.metadata.nativeSHA256, sha(input));
});
test("repeated additions are stable, updates restore removed target motions and distinct nonconflicting variants coexist", async () => {
  const source = template("16"), first = await addTemplateVariant(source, options(), pixelEnv), repeated = await addTemplateVariant(first.bundle, options(), pixelEnv);
  assert.equal(repeated.partId, first.partId); assert.equal(repeated.bundle, first.bundle); assert.equal(repeated.metadata.unchanged, true);
  const updated = await addTemplateVariant(first.bundle, options(image16("#7639a4"), { animations: ["unit_dead"] }), pixelEnv);
  assert.equal(updated.partId, first.partId); assert.equal(updated.bundle.parts.length, first.bundle.parts.length);
  assert.equal(actor(updated.bundle, "unit_damage").sample(.1).findSlot("face").appliedPose.attachment.name, "face");
  const other = await addTemplateVariant(updated.bundle, options(image16("#27558b"), { name: "奔跑紧张", animations: ["unit_run"] }), pixelEnv);
  assert.equal(other.bundle.parts.length, source.parts.length + 2); assert.equal(actor(other.bundle, "unit_run").sample(.1).findSlot("face").appliedPose.attachment.name, other.partId);
  await assert.rejects(() => addTemplateVariant(first.bundle, options(image16(), { name: "另一个痛苦", animations: ["unit_damage"] }), pixelEnv), /另一个表情变体/);
  const restored = templateVariantBase(other.bundle); assert.deepEqual(restored.files, source.files); assert.deepEqual(restored.json, source.json); assert.equal(templateVariantBase(source), source);
});
test("runtime, Editable, Unity and roundtrip retain original/native bytes, template restoration and actual attachment switching", async () => {
  const source = template("16"), out = await addTemplateVariant(source, options(), pixelEnv), edits = { [out.partId]: { ...out.edit, transform: { ...out.edit.transform, x: 4 } } }, pages = await compilePages(out.bundle, edits, pixelEnv);
  const runtime = parseBundle(unpackZip(exportPackage(out.bundle, pages))), editable = parseBundle(unpackZip(exportPackage(out.bundle, pages, { editable: true, edits }))), unity = parseBundle(unpackZip(exportPackage(out.bundle, pages, { target: "unity" })));
  for (const bundle of [runtime, editable, unity, parseBundle(unpackZip(exportPackage(runtime)))]) {
    assert.deepEqual(bundle.files[out.metadata.nativePath], out.edit.image); assert.equal(JSON.parse(new TextDecoder().decode(bundle.files[MANIFEST])).variants[0].provenance.jobId, "fixture-job");
    compareQuad(source, bundle, "unit_damage", .12); assert.equal(actor(bundle, "unit_wait").sample(.1).findSlot("face").appliedPose.attachment.name, "face");
    const base = templateVariantBase(bundle); assert.deepEqual(base.files[source.skeletonPath], source.files[source.skeletonPath]);
    for (const atlas of source.atlasPaths) assert.deepEqual(base.files[atlas], source.files[atlas]);
    assert.deepEqual(base.files["skeleton.png"], source.files["skeleton.png"]); assert.equal(base.parts.length, source.parts.length);
  }
  assert.deepEqual(editable.edits[out.partId].transform, edits[out.partId].transform);
  const reupdatedUnity = await addTemplateVariant(unity, options(image16("#446688"), { animations: ["unit_dead"] }), pixelEnv); assert.equal(reupdatedUnity.partId, out.partId); compareQuad(source, reupdatedUnity.bundle, "unit_dead", .2);
});
test("90-degree/PMA/trim sources keep their geometry while the appended page uses independent straight alpha", async () => {
  const source = synthetic({ rotate: 90, pma: true }), canvas = createCanvas(20, 16), context = canvas.getContext("2d"); context.fillStyle = "rgba(60,140,220,.5)"; context.fillRect(4, 6, 12, 8);
  const out = await addTemplateVariant(source, { partId: "part", name: "variant", image: new Uint8Array(canvas.toBuffer("image/png")), animations: ["idle"], provenance: { jobId: "pma-fixture", imageId: "image" } }, pixelEnv);
  assert.equal(out.bundle.pages[0].pma, true); assert.equal(out.bundle.pages.at(-1).pma, false);
  compareQuad(source, out.bundle, "idle", 0, "slot");
  const part = out.bundle.parts.find((part) => part.id === out.partId), extracted = await extractPart(out.bundle, part, pixelEnv), p = pixels(extracted);
  assert.equal(p[(3 * 10 + 2) * 4 + 3], 127); assert.deepEqual(templateVariantBase(out.bundle).files, source.files);
});
test("binary, mesh, ambiguous binding, wrong motion, incompatible original/externally modified attachment timelines and path collisions reject atomically", async () => {
  const source = template("16"), saved = clone(source.files);
  await assert.rejects(() => addTemplateVariant({ ...source, binary: true, json: null }, options(), pixelEnv), /JSON/);
  const mesh = jsonBundle(source, (j) => { j.skins[0].attachments.face.face = { type: "mesh", path: "face", uvs: [0,0,1,0,1,1,0,1], triangles: [0,1,2,2,3,0], vertices: [-144,-144,144,-144,144,144,-144,144], hull: 4, width: 288, height: 288 }; });
  await assert.rejects(() => addTemplateVariant(mesh, options(), pixelEnv), /region.*mesh/);
  await assert.rejects(() => addTemplateVariant(jsonBundle(source, (j) => j.skins.push({ ...clone(j.skins[0]), name: "second" })), options(), pixelEnv), /多重绑定/);
  await assert.rejects(() => addTemplateVariant(source, options(image16(), { animations: ["missing"] }), pixelEnv), /存在且不重复/);
  await assert.rejects(() => addTemplateVariant(jsonBundle(source, (j) => { j.animations.unit_damage.slots = { face: { attachment: [{ time: 0, name: null }] } }; }), options(), pixelEnv), /不兼容/);
  const first = await addTemplateVariant(source, options(), pixelEnv), modified = jsonBundle(first.bundle, (j) => { j.animations.unit_damage.slots.face.attachment[0].name = "face"; });
  await assert.rejects(() => addTemplateVariant(modified, options(image16(), { name: "new", animations: ["unit_run"] }), pixelEnv), /外部修改/);
  const collision = parseBundle({ ...source.files, ".ispine/template-variants/native/collision.png": image16() });
  await assert.rejects(() => addTemplateVariant(collision, options(), pixelEnv), /缺少清单/);
  assert.deepEqual(source.files, saved);
});
test("missing or corrupt backups/native/page/atlas, unsafe manifests and invalid native PNGs fail without changing the original bundle", async () => {
  const source = template("16"), out = await addTemplateVariant(source, options(), pixelEnv), manifest = JSON.parse(new TextDecoder().decode(out.bundle.files[MANIFEST]));
  for (const file of [manifest.base.skeleton.backupPath, manifest.base.atlases[0].backupPath, out.metadata.nativePath, out.metadata.pageFile, out.metadata.atlasFile]) {
    const files = { ...out.bundle.files }; delete files[file]; assert.throws(() => templateVariantBase({ ...out.bundle, files }), /缺少/);
  }
  const corrupt = { ...out.bundle.files, [manifest.base.skeleton.backupPath]: new Uint8Array([1,2,3]) }; assert.throws(() => templateVariantBase({ ...out.bundle, files: corrupt }), /指纹不匹配/);
  const bad = clone(manifest); bad.variants[0].nativePath = "../private.png"; assert.throws(() => templateVariantBase({ ...out.bundle, files: { ...out.bundle.files, [MANIFEST]: new TextEncoder().encode(JSON.stringify(bad)) } }), /路径无效/);
  await assert.rejects(() => addTemplateVariant(source, options(new Uint8Array([1,2,3])), pixelEnv), /原生 PNG/);
  const blank = createCanvas(288, 288); await assert.rejects(() => addTemplateVariant(source, options(new Uint8Array(blank.toBuffer("image/png"))), pixelEnv), /没有有效可见像素/);
  await assert.rejects(() => addTemplateVariant(source, options(image16(), { transform: { ...identityTransform(), scaleX: 0 } }), pixelEnv), /缩放/);
});
test("decode/encode failures close image handles and release all temporary canvases", async () => {
  const source = template("16"), canvases = []; let closed = 0;
  const env = { createCanvas(w,h) { const canvas = createCanvas(w,h); canvases.push(canvas); return canvas; }, async loadImage(data) { const image = await loadImage(Buffer.from(data)); image.close = () => closed++; return image; }, encode: async () => { throw new Error("fixture encode failed"); } };
  await assert.rejects(() => addTemplateVariant(source, options(), env), /fixture encode failed/); assert.equal(closed, 1); assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
  assert.ok(!Object.hasOwn(source.files, MANIFEST));
});

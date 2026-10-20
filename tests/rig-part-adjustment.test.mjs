import test from "node:test";
import assert from "node:assert/strict";
import { Skeleton, AnimationState, AnimationStateData, Physics, MeshAttachment } from "@esotericsoftware/spine-webgl";
import { createCanvas } from "@napi-rs/canvas";
import { moveRigPart, resizeRigPart } from "../src/core/rig-part-adjustment.js";
import { createHumanoidDraft, getRigPartMesh, compileRigSkeleton, buildRigFiles, sampleRigPose, inspectRigMotion } from "../src/core/rig-authoring.js";
import { validateRigDocument } from "../shared/rig-schema.mjs";
import { parseBundle, exportPackage, unpackZip } from "../src/core/archive.js";
import { parseSkeleton, attachmentVertices } from "../src/spine/runtime.js";
import { attachRigAuthoring, readRigAuthoring, imageDataBytes } from "../src/core/rig-project.js";
import { pixelEnv } from "./helpers.mjs";

const close = (a, b, tolerance = 1e-4) => assert.ok(Math.abs(a - b) <= tolerance, `${a} versus ${b}`);
const rect = ({ x, y, width, height }) => ({ x, y, width, height });
function fixture() {
  const canvas = createCanvas(18, 22), context = canvas.getContext("2d");
  context.fillStyle = "#9872e8"; context.fillRect(3, 2, 11, 18);
  context.fillStyle = "#f3b17e"; context.fillRect(7, 5, 7, 8);
  const image = canvas.toDataURL("image/png"), document = createHumanoidDraft({ id: "manual-adjustment", width: 240, height: 360, sourceImage: image });
  for (const part of document.parts) Object.assign(part, { image, imageSource: "ai", completion: "ready", imageGeneration: { source: "ai", jobId: `job-${part.id}` } });
  const part = document.parts.find((entry) => entry.id === "torso");
  part.sourcePolygon = [{ x: part.x, y: part.y }, { x: part.x + part.width, y: part.y }, { x: part.x + part.width, y: part.y + part.height }];
  part.registrationBase = { image, ...rect(part), imageSource: "ai", completion: "ready" };
  part.registration = { sourceFingerprint: "a".repeat(64), outputImageSHA256: "b".repeat(64), lockedPixels: 24 };
  document.registration = { sourceFingerprint: "a".repeat(64), compositionFingerprint: "c".repeat(64), metrics: { after: { alphaIoU: .98 } } };
  document.motionStudies = { attack: { motionId: "attack", playback: "reference", frames: [{ id: "prior-reference", time: 0, image, origin: "ai-motion-frame", imageGeneration: { jobId: "reference-job" } }] } };
  const head = document.parts.find((entry) => entry.id === "head"); head.attachmentGroup = "face";
  document.parts.push({ ...structuredClone(head), id: "face_hurt", label: "Pain expression" });
  document.defaultAttachments = { face: "head" };
  return validateRigDocument(document);
}
function preserveBase(before, after, id) {
  assert.deepEqual(after.joints, before.joints); assert.deepEqual(after.motions, before.motions);
  assert.equal(after.sourceImage, before.sourceImage); assert.deepEqual(after.motionStudies, before.motionStudies);
  assert.deepEqual(after.defaultAttachments, before.defaultAttachments);
  for (const part of before.parts) if (part.id !== id) assert.deepEqual(after.parts.find((entry) => entry.id === part.id), part);
  const original = before.parts.find((entry) => entry.id === id), next = after.parts.find((entry) => entry.id === id);
  for (const field of ["image", "imageSource", "completion", "imageGeneration", "sourcePolygon", "registrationBase", "binding", "influences", "z", "attachmentGroup"])
    assert.deepEqual(next[field], original[field]);
}

test("setup translation changes only the selected attachment while keeping source coordinates, stable underlay, defaults and historical metrics", () => {
  const document = fixture(), before = structuredClone(document), part = document.parts.find((entry) => entry.id === "torso");
  const moved = moveRigPart(document, part.id, part.x + 7.25, part.y - 3.5), next = moved.parts.find((entry) => entry.id === part.id);
  assert.deepEqual(document, before); preserveBase(document, moved, part.id);
  assert.deepEqual(rect(next), { x: part.x + 7.25, y: part.y - 3.5, width: part.width, height: part.height });
  assert.equal(next.registration.outOfDate, true); assert.equal(moved.registration.outOfDate, true);
  assert.equal(moved.registration.compositionFingerprint, document.registration.compositionFingerprint);
  assert.deepEqual(moved.registration.metrics, document.registration.metrics);
  const variant = document.parts.find((entry) => entry.id === "face_hurt"), changed = moveRigPart(document, variant.id, variant.x + 2, variant.y + 3);
  preserveBase(document, changed, variant.id); assert.equal(changed.defaultAttachments.face, "head");
});

test("implicit mesh weights are frozen before moving or resizing; existing custom weights remain exact and grids retain normalized UVs", () => {
  const document = fixture(), originalMesh = getRigPartMesh(document, "torso"), part = document.parts.find((entry) => entry.id === "torso");
  const moved = moveRigPart(document, "torso", part.x + 11, part.y + 6), movedMesh = getRigPartMesh(moved, "torso");
  assert.deepEqual(movedMesh.weights, originalMesh.weights); assert.deepEqual(movedMesh.uvs, originalMesh.uvs); assert.deepEqual(movedMesh.triangles, originalMesh.triangles);
  originalMesh.vertices.forEach((coordinate, index) => close(movedMesh.vertices[index], coordinate + (index % 2 ? 6 : 11)));
  const custom = structuredClone(document), target = custom.parts.find((entry) => entry.id === "torso");
  target.mesh = { cols: 3, rows: 3, weights: Array.from({ length: 9 }, () => [{ joint: "root", weight: .25 }, { joint: "torso", weight: .75 }]) };
  const resized = resizeRigPart(custom, "torso", .8), resizedPart = resized.parts.find((entry) => entry.id === "torso"), resizedMesh = getRigPartMesh(resized, "torso");
  assert.deepEqual(resizedPart.mesh, target.mesh); preserveBase(custom, resized, "torso");
  close(resizedPart.x + resizedPart.width / 2, target.x + target.width / 2); close(resizedPart.y + resizedPart.height / 2, target.y + target.height / 2);
  close(resizedPart.width / resizedPart.height, target.width / target.height);
  const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 }, old = getRigPartMesh(custom, "torso");
  old.vertices.forEach((coordinate, index) => { const anchor = index % 2 ? center.y : center.x; close(resizedMesh.vertices[index], anchor + (coordinate - anchor) * .8); });
  assert.equal(part.mesh, undefined, "implicit input bindings are not mutated");
});

test("official Spine runtime inherits moved rigid and weighted placement through all motions at non-key times without changing bones or animation channels", async () => {
  const document = fixture();
  // Authored affine channels isolate attachment placement from the separate
  // procedural foot-IK bake approximation. Exercise inherited scale as well.
  document.motions = document.motions.map((motion) => ({ ...motion, poses: [
    { time: 0, angles: {}, ease: "linear", scales: { root: { x: 1, y: 1 } } },
    { time: motion.duration * .4, angles: { torso: 8, head: -6, leftUpperArm: 12 }, ease: "linear", root: { x: 5, y: -3 }, translations: { head: { x: 2, y: 1 } }, scales: { root: { x: 1.03, y: .97 } } },
    { time: motion.duration, angles: {}, ease: "linear", scales: { root: { x: 1, y: 1 } } },
  ] }));
  let adjusted = moveRigPart(document, "leftUpperArm", 45, 119);
  adjusted = resizeRigPart(adjusted, "leftUpperArm", .9); adjusted = moveRigPart(adjusted, "head", 52, 12);
  const originalJSON = compileRigSkeleton(document), compiled = compileRigSkeleton(adjusted);
  assert.deepEqual(compiled.bones, originalJSON.bones); assert.deepEqual(compiled.animations, originalJSON.animations);
  const files = await buildRigFiles(adjusted, pixelEnv), { data } = parseSkeleton(parseBundle(files));
  const skeleton = new Skeleton(data), state = new AnimationState(new AnimationStateData(data)); let weighted = 0, rigid = 0, maximumError = 0;
  skeleton.setupPose(); skeleton.updateWorldTransform(Physics.none);
  const mesh = getRigPartMesh(adjusted, "leftUpperArm"), setup = attachmentVertices(skeleton, skeleton.findSlot("slot_leftUpperArm"));
  mesh.vertices.forEach((coordinate, index) => close(index % 2 ? adjusted.height - setup.vertices[index] : setup.vertices[index], coordinate));
  for (const motion of adjusted.motions) {
    const track = state.setAnimation(0, motion.id, false);
    for (let i = 0; i < 23; i++) {
      const time = motion.duration * (i + .37) / 24, expected = sampleRigPose(adjusted, motion.id, time);
      skeleton.setupPose(); track.trackTime = time; state.apply(skeleton); skeleton.updateWorldTransform(Physics.none);
      for (const id of ["leftUpperArm", "head"]) {
        const part = adjusted.parts.find((entry) => entry.id === id), slotName = part.attachmentGroup ? `group_${part.attachmentGroup}` : `slot_${part.id}`;
        const shape = attachmentVertices(skeleton, skeleton.findSlot(slotName));
        if (shape.attachment instanceof MeshAttachment) {
          weighted++;
          for (let j = 0; j < shape.vertices.length; j += 2) maximumError = Math.max(maximumError, Math.hypot(shape.vertices[j] - expected.parts[id].vertices[j], adjusted.height - shape.vertices[j + 1] - expected.parts[id].vertices[j + 1]));
        } else {
          rigid++;
          const pairs = Array.from({ length: 4 }, (_, j) => [shape.vertices[j * 2], adjusted.height - shape.vertices[j * 2 + 1]]);
          for (let j = 0; j < expected.parts[id].vertices.length; j += 2) maximumError = Math.max(maximumError, Math.min(...pairs.map(([x, y]) => Math.hypot(x - expected.parts[id].vertices[j], y - expected.parts[id].vertices[j + 1]))));
        }
      }
    }
  }
  assert.ok(weighted && rigid);
  assert.ok(maximumError < .001, `official runtime placement differs by ${maximumError} px`);
});

test("native PNGs, source masks, preserved weights and new setup geometry survive runtime, editable and Unity authoring roundtrips", async () => {
  const source = fixture(), part = source.parts.find((entry) => entry.id === "torso"), document = resizeRigPart(moveRigPart(source, part.id, part.x + 3, part.y + 2), part.id, .9);
  const files = attachRigAuthoring(await buildRigFiles(document, pixelEnv), document), bundle = parseBundle(files);
  for (const options of [{ target: "spine" }, { editable: true }, { target: "unity" }]) {
    const bytes = exportPackage(bundle, {}, options), restored = readRigAuthoring(parseBundle(unpackZip(bytes)).files);
    assert.deepEqual(restored, document); assert.deepEqual(imageDataBytes(restored.parts.find((entry) => entry.id === part.id).image).bytes, imageDataBytes(part.image).bytes);
  }
});

test("weapon image-local grip coordinates follow uniform resize and translation does not silently hide a moved grip error", () => {
  const document = fixture(), hand = document.joints.find((joint) => joint.id === "rightHand"), image = document.parts[0].image;
  document.parts.push({ id: "staff", label: "Staff", bone: hand.id, x: hand.x - 10, y: hand.y - 15, width: 24, height: 30, binding: "rigid", influences: [hand.id], z: 50,
    image, imageSource: "uploaded", completion: "ready", grip: { primaryHand: hand.id, primaryLocalPoint: { x: 10, y: 15 } } });
  const source = validateRigDocument(document), enlarged = resizeRigPart(source, "staff", 1.2), weapon = enlarged.parts.at(-1);
  assert.deepEqual(weapon.grip.primaryLocalPoint, { x: 12, y: 18 }); assert.equal(weapon.image, image);
  const moved = moveRigPart(source, "staff", hand.x - 3, hand.y - 15);
  assert.deepEqual(moved.parts.at(-1).grip, source.parts.at(-1).grip); assert.deepEqual(moved.motions, source.motions);
  const report = inspectRigMotion(moved, "idle"); assert.ok(report.weaponGrips[0].primaryError > 6.9); assert.ok(report.issues.some((issue) => issue.includes("握点")));
});

test("invalid geometry and source crops fail atomically; no-op operations preserve identity and do not create authored changes", () => {
  const document = fixture(), before = structuredClone(document), part = document.parts[0];
  assert.equal(moveRigPart(document, part.id, part.x, part.y), document); assert.equal(resizeRigPart(document, part.id, 1), document);
  for (const [x, y] of [[NaN, 0], [Infinity, 0], [-1, 0], [240, 0], [0, 360]]) assert.throws(() => moveRigPart(document, part.id, x, y), /画布/);
  for (const scale of [0, -1, NaN, Infinity, 1000, 1e-8]) assert.throws(() => resizeRigPart(document, part.id, scale), /缩放|画布/);
  assert.throws(() => resizeRigPart(document, part.id, 1.1, { anchor: "corner" }), /中心/);
  assert.throws(() => moveRigPart(document, "missing", 1, 1), /找不到/);
  for (const source of ["source-crop", "placeholder"]) { const invalid = structuredClone(document); invalid.parts[0].imageSource = source; assert.throws(() => moveRigPart(invalid, part.id, part.x + 2, part.y), /独立图片/); }
  const missing = structuredClone(document); delete missing.parts[0].image; assert.throws(() => resizeRigPart(missing, part.id, .9), /独立图片/);
  assert.deepEqual(document, before);
});

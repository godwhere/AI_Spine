import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createRigContinuousLimb } from "../engine/images/rig-limb.js";
import { validateRigDocument } from "../shared/rig-schema.mjs";
import { compileRigSkeleton } from "../engine/rig/compile.js";
import { buildRigFiles } from "../engine/rig/build-files.js";
import { resolveRigAttachments } from "../engine/rig/attachments.js";
import { inspectRigMotion } from "../engine/rig/inspect.js";
import { attachRigAuthoring, readRigAuthoring } from "../engine/archive/rig-project.js";
import { parseBundle } from "../engine/archive/bundle.js";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";
import { createRigSession } from "../src/application/rig-session.js";
import { pixelEnv } from "./helpers.mjs";

function fixture() {
  const canvas = createCanvas(40, 100), ctx = canvas.getContext("2d");
  ctx.fillStyle = "#263044";ctx.fillRect(5, 0, 30, 100);
  const image = canvas.toDataURL("image/png");
  return validateRigDocument({ version: 1, id: "limb-fixture", name: "Limb fixture", width: 240, height: 360,
    joints: [{ id: "root", parent: null, x: 120, y: 150 }, { id: "rightThigh", parent: "root", x: 100, y: 160 },
      { id: "rightShin", parent: "rightThigh", x: 90, y: 230 }, { id: "rightFoot", parent: "rightShin", x: 85, y: 300 },
      { id: "rightToe", parent: "rightFoot", x: 65, y: 325 }],
    parts: [
      { id: "thigh", label: "Thigh", bone: "rightThigh", x: 70, y: 150, width: 40, height: 100, z: 0, influences: ["rightThigh", "rightShin"] },
      { id: "shin", label: "Shin", bone: "rightShin", x: 65, y: 215, width: 40, height: 100, z: 1, influences: ["rightShin", "rightFoot"] },
    ].map((part) => ({ ...part, binding: "mesh", image, imageSource: "uploaded", completion: "ready", imageGeneration: { imageId: part.id } })),
    motions: ["idle", "skill"].map((id) => ({ id, name: id, duration: 1, loop: id === "idle", origin: "manual",
      poses: [0, .5, 1].map((time) => ({ time, angles: {}, root: { x: 0, y: time === .5 ? 6 : 0 }, feet: { right: true },
        ...(time === 0 ? { drawOrder: ["slot_thigh", "slot_shin"] } : {}) })) })) });
}
const options = { motionId: "skill", upperId: "thigh", lowerId: "shin" };

test("a continuous limb preserves originals, body timelines and other motions, and can be undone", async () => {
  const before = fixture(), next = await createRigContinuousLimb(before, options, pixelEnv);
  const combined = next.parts.at(-1);
  for (const original of before.parts) {
    const { attachmentGroup, ...part } = next.parts.find((item) => item.id === original.id);
    assert.deepEqual(part, original);
  }
  assert.deepEqual(next.joints, before.joints);
  assert.equal(combined.binding, "mesh");assert.deepEqual(combined.mesh, { cols: 5, rows: 8 });
  assert.deepEqual(resolveRigAttachments(next, "idle", .5).visiblePartIds, ["thigh", "shin"]);
  assert.deepEqual(resolveRigAttachments(next, "skill", .5).visiblePartIds, [combined.id]);
  const oldSkeleton = compileRigSkeleton(before), skeleton = compileRigSkeleton(next);
  assert.deepEqual(skeleton.bones, oldSkeleton.bones);
  for (const id of ["idle", "skill"]) assert.deepEqual(skeleton.animations[id].bones, oldSkeleton.animations[id].bones);
  assert.ok(inspectRigMotion(next, "skill").maxFootSlide.right < 1e-6);
  const session = createRigSession(before);session.commit(next);session.undo();
  assert.deepEqual(session.getDocument(), before);
});

test("source-grid pixels, composition provenance and exclusive mesh playback survive a real export", async () => {
  const next = await createRigContinuousLimb(fixture(), options, pixelEnv), part = next.parts.at(-1);
  const image = await loadImage(part.image), canvas = createCanvas(image.width, image.height), ctx = canvas.getContext("2d");ctx.drawImage(image, 0, 0);
  assert.deepEqual([part.x, part.y, part.width, part.height], [65, 150, 45, 165]);
  // The overlapping knee is one uninterrupted opaque texture on the source grid.
  for (let y = 65; y < 100; y++) assert.equal(ctx.getImageData(20, y, 1, 1).data[3], 255);
  const files = await attachRigAuthoring(await buildRigFiles(next, pixelEnv), next), bundle = parseBundle(files);
  const zip = exportPackage(bundle, {}, {});
  const imported = parseBundle(unpackZip(zip)), restored = readRigAuthoring(imported.files);
  assert.deepEqual(restored.parts.at(-1).composition, part.composition);
  assert.deepEqual(restored.parts.at(-1).image, part.image);
  assert.deepEqual(resolveRigAttachments(restored, "skill", .5).visiblePartIds, [part.id]);
  assert.deepEqual(resolveRigAttachments(restored, "idle", .5).visiblePartIds, ["thigh", "shin"]);
});

test("repeated composition updates one variant and rejects invalid sources without mutating the draft", async () => {
  const before = fixture(), first = await createRigContinuousLimb(before, options, pixelEnv);
  const second = await createRigContinuousLimb(first, options, pixelEnv);
  assert.equal(second.parts.length, 3);assert.equal(second.parts.at(-1).id, first.parts.at(-1).id);
  await assert.rejects(createRigContinuousLimb(before, { ...options, lowerId: "thigh" }, pixelEnv), /独立肢体/);
  await assert.rejects(createRigContinuousLimb(before, { ...options, upperId: "shin", lowerId: "thigh" }, pixelEnv), /相邻骨链/);
  await assert.rejects(createRigContinuousLimb(before, { ...options, motionId: "missing" }, pixelEnv), /连续骨骼动作/);
  const failed = structuredClone(before);failed.parts[1].completion = "needs-inpaint";
  await assert.rejects(createRigContinuousLimb(failed, options, pixelEnv), /独立肢体/);
  assert.deepEqual(before, fixture());
});

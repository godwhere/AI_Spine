import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { Skeleton, AnimationState, AnimationStateData, Physics } from "@esotericsoftware/spine-webgl";
import { validateRigDocument, replaceRigMotion } from "../shared/rig-schema.mjs";
import { magicEffectOptions, withRigMagicEffects, withoutRigMagicEffects, retimeMotionEffects } from "../shared/domain/rig-effects.mjs";
import { prepareRigMagicEffects } from "../src/application/rig-effects.js";
import { createRigMagicEffectFrames } from "../engine/images/rig-effects.js";
import { compileRigSkeleton } from "../engine/rig/compile.js";
import { buildRigFiles } from "../engine/rig/build-files.js";
import { resolveRigAttachments } from "../engine/rig/attachments.js";
import { sampleRigPose } from "../engine/rig/sample.js";
import { deriveRigPartAnnotations } from "../engine/rig/part-annotations.js";
import { attachRigAuthoring, readRigAuthoring } from "../engine/archive/rig-project.js";
import { parseBundle } from "../engine/archive/bundle.js";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";
import { parseSkeleton } from "../engine/spine/parse.js";
import { attachmentVertices } from "../engine/spine/geometry.js";
import { rigAuthoringSummary } from "../shared/domain/rig-summary.mjs";
import { rigReadiness } from "../shared/domain/rig.mjs";
import { pixelEnv } from "./helpers.mjs";

function fixture() {
  const canvas = createCanvas(32, 32), ctx = canvas.getContext("2d");ctx.fillStyle = "#8aaee8";ctx.fillRect(0, 0, 32, 32);
  const image = canvas.toDataURL("image/png"), joints = [{ id: "root", parent: null, x: 500, y: 600 },
    { id: "rightHand", parent: "root", x: 321, y: 463 }, { id: "leftHand", parent: "root", x: 746, y: 517 }];
  const parts = joints.map((joint, z) => ({ id: joint.id + "Art", bone: joint.id, x: joint.x - 16, y: joint.y - 16,
    width: 32, height: 32, z, binding: "rigid", image, imageSource: "uploaded", completion: "ready" }));
  return validateRigDocument({ version: 1, id: "effects-fixture", name: "Synthetic effect fixture", width: 1024, height: 1024,
    sourceImage: image, joints, parts, defaultAttachments: {}, motions: ["idle", "attack", "death", "skill"].map((id) => ({ id, name: id,
      duration: 2.2, loop: id === "idle", origin: "manual", poses: [{ time: 0, angles: {}, root: { x: 0, y: 0 } },
        { time: .95, angles: { rightHand: 11, leftHand: -14 }, root: { x: 2, y: 3 },
          drawOrder: parts.map((part) => "slot_" + part.id) }, { time: 2.2, angles: {}, root: { x: 0, y: 0 } }] })) });
}
let shared;
async function prepared() {
  shared ||= (async () => { const before = fixture(), options = magicEffectOptions(before, "skill"),
    frames = await createRigMagicEffectFrames(options, pixelEnv), document = validateRigDocument(withRigMagicEffects(before, "skill", options, frames));
    return { before, options, frames, document }; })();
  return shared;
}
function apply(data, motion, time, state, skeleton) {
  skeleton ||= new Skeleton(data);if (!state) { skeleton.setSkin(data.skins[0]);skeleton.setupPose();state = new AnimationState(new AnimationStateData(data)); }
  state.setAnimation(0, motion, false).trackTime = time;state.apply(skeleton);skeleton.updateWorldTransform(Physics.none);return { skeleton, state };
}

test("magic effects retain authored body work and update their own two layers without duplicate resources", async () => {
  const { before, options, frames, document } = await prepared();
  assert.deepEqual(document.joints, before.joints);
  assert.deepEqual(document.parts.filter((part) => part.role !== "effect"), before.parts);
  assert.deepEqual(document.motions.slice(0, 3), before.motions.slice(0, 3));
  assert.deepEqual(document.motions.at(-1).poses, before.motions.at(-1).poses);
  assert.equal(document.motions.at(-1).effectTracks.length, 2);
  assert.equal(rigReadiness(document).ready, true, "Completed procedural effects must not be labelled unfinished body inpainting.");
  assert.ok(frames.length > 40 && frames.every((frame) => frame.width === 256 && frame.height === 256));
  assert.ok(document.parts.filter((part) => part.role === "effect").every((part) => part.imageSource === "procedural" && part.effect.generator === "ispine-starlight-v1"));
  const replaced = validateRigDocument(withRigMagicEffects(document, "skill", options, frames));
  assert.deepEqual(replaced, document);
  assert.deepEqual(validateRigDocument(withoutRigMagicEffects(document, "skill")), before);
  assert.throws(() => magicEffectOptions(before, "skill", { releaseTime: .05 }), /依次/);
  assert.throws(() => magicEffectOptions(before, "skill", { chargeX: -999 }), /画布/);
});

test("official runtime switches effect frames, follows hands and hides effects on all unrelated animations", async () => {
  const { before, document } = await prepared();
  const bundle = parseBundle(await buildRigFiles(document, pixelEnv)), { data } = parseSkeleton(bundle);
  const tracks = document.motions.at(-1).effectTracks, times = [0, .14999, .15, .55, .88, .95, 1.07, 1.3, 1.64999, 1.65, 2.2];
  for (const time of times) {
    const actual = apply(data, "skill", time).skeleton, expected = sampleRigPose(document, "skill", time);
    for (const track of tracks) {
      const slot = actual.findSlot("group_" + track.groupId), selected = expected.attachmentSelection[track.groupId];
      assert.equal(slot.appliedPose.attachment?.name ?? null, selected);
      if (selected) {
        const vertices = attachmentVertices(actual, slot).vertices, target = expected.parts[selected].vertices;
        const a = Array.from(vertices).filter((_, i) => i % 2 === 0), b = target.filter((_, i) => i % 2 === 0);
        assert.ok(Math.abs(Math.min(...a) - Math.min(...b)) < .02);
      }
    }
    for (const joint of before.joints) {
      const old = sampleRigPose(before, "skill", time).joints[joint.id], current = expected.joints[joint.id];
      assert.deepEqual(current, old);
    }
  }
  const cast = apply(data, "skill", .95);
  for (const id of ["idle", "attack", "death"]) {
    apply(data, id, 0, cast.state, cast.skeleton);
    for (const track of tracks) assert.equal(cast.skeleton.findSlot("group_" + track.groupId).appliedPose.attachment, null);
    assert.deepEqual(resolveRigAttachments(document, id, 1).visiblePartIds, before.parts.map((part) => part.id));
  }
  const compiled = compileRigSkeleton(document), original = compileRigSkeleton(before);
  assert.deepEqual(compiled.bones, original.bones);
  for (const id of Object.keys(original.animations)) assert.deepEqual(compiled.animations[id].bones, original.animations[id].bones);
});

test("actual packages preserve effect artwork, independent timings, provenance and truthful region counts", async () => {
  const { document, frames } = await prepared();
  const files = attachRigAuthoring(await buildRigFiles(document, pixelEnv), document), bundle = parseBundle(files);
  const zip = exportPackage(bundle, {}, {}), reopened = parseBundle(unpackZip(zip)), restored = readRigAuthoring(reopened.files);
  assert.deepEqual(restored, document);
  assert.equal(reopened.parts.length, document.parts.length);
  const summary = rigAuthoringSummary(reopened.files);
  assert.equal(summary.logicalParts, 3);assert.equal(summary.additionalAttachments, 0);
  assert.equal(summary.effectLayers, 2);assert.equal(summary.effectRegions, frames.length);
  const peak = document.parts.find((part) => part.effect?.kind === "release" && part.effect.time === .95);
  const annotation = deriveRigPartAnnotations(document, peak.id, { samples: 3 });
  assert.ok(annotation.motions.find((motion) => motion.motionId === "skill").intervals.some((interval) => interval.start === .95 && interval.representation === "effect-frame"));
  assert.ok(annotation.motions.filter((motion) => motion.motionId !== "skill").every((motion) => !motion.intervals.length));
});

test("retiming or replanning keeps effects independent from body poses and invalid references are rejected", async () => {
  const { document } = await prepared(), motion = document.motions.at(-1), retimed = retimeMotionEffects(motion, 4.4);
  assert.equal(retimed.magicEffects.options.releaseTime, 1.9);
  assert.equal(retimed.effectTracks[0].keys.at(-1).time, motion.effectTracks[0].keys.at(-1).time * 2);
  const replan = replaceRigMotion(document, { id: "skill", name: "skill", duration: 2.2, poses: motion.poses });
  assert.deepEqual(replan.motions.at(-1).effectTracks, motion.effectTracks);
  const invalid = structuredClone(document);invalid.motions.at(-1).effectTracks[0].keys[1].name = "leftHandArt";
  assert.throws(() => validateRigDocument(invalid), /同一显示组/);
  const fake = structuredClone(document);fake.parts[0].imageSource = "procedural";
  assert.throws(() => validateRigDocument(fake), /不能将角色裁片/);
  await assert.rejects(prepareRigMagicEffects(document, "skill", { endTime: 5 }, () => { throw Error("must not render invalid input"); }), /依次/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { Skeleton, AnimationState, AnimationStateData, Physics } from "@esotericsoftware/spine-webgl";
import { validateRigDocument, validateRigMotion } from "../shared/rig-schema.mjs";
import { createHumanoidDraft, buildRigFiles, compileRigSkeleton, sampleRigPose, inspectRigMotion,
  resolveRigAttachments, rigPartSlotName, replaceRigMotion, getRigPartMesh, setRigPartWeights } from "../src/core/rig-authoring.js";
import { parseBundle, exportPackage, unpackZip } from "../src/core/archive.js";
import { parseSkeleton, attachmentVertices } from "../src/spine/runtime.js";
import { attachRigAuthoring, readRigAuthoring, synchronizeRigAuthoring, imageDataBytes } from "../src/core/rig-project.js";
import { compilePages, identityTransform } from "../src/core/pixels.js";
import { pixelEnv } from "./helpers.mjs";

function artwork(color) {
  const canvas = createCanvas(40, 40), context = canvas.getContext("2d");
  context.fillStyle = color; context.fillRect(4, 8, 30, 23);
  return canvas.toDataURL("image/png");
}

function expressionDraft() {
  const doc = createHumanoidDraft({ id: "expression-rig", name: "Expression fixture", width: 240, height: 360, sourceImage: artwork("#afbaee") });
  const expression = (id, group, z, color, binding = "rigid") => ({ id, label: id, attachmentGroup: group, bone: "head",
    x: group === "eyes" ? 80 : 105, y: group === "eyes" ? 45 : 78, width: group === "eyes" ? 80 : 30, height: 20,
    z, binding, influences: ["head"], image: artwork(color), imageSource: "uploaded", completion: "ready" });
  doc.parts.push(expression("eyesOpen", "eyes", 20, "#1122ff"), expression("eyesClosed", "eyes", 20, "#7788bb"),
    expression("eyesAngry", "eyes", 20, "#dd1133", "mesh"), expression("mouthNeutral", "mouth", 21, "#aa7788"),
    expression("mouthShout", "mouth", 21, "#cc2299"));
  for (const part of doc.parts) { part.image ||= artwork("#8c65bc"); part.imageSource = "uploaded"; part.completion = "ready"; }
  doc.defaultAttachments = { eyes: "eyesOpen", mouth: null };
  Object.assign(doc.motions[0].poses[1], { attachments: { eyes: "eyesClosed", mouth: "mouthNeutral" } });
  Object.assign(doc.motions[0].poses[2], { attachments: { eyes: "eyesAngry" } });
  Object.assign(doc.motions[0].poses[3], { attachments: { eyes: "eyesOpen" } });
  Object.assign(doc.motions[0].poses[4], { attachments: { mouth: null } });
  Object.assign(doc.motions[1].poses[0], { attachments: { eyes: "eyesAngry", mouth: "mouthShout" } });
  Object.assign(doc.motions[1].poses[2], { attachments: { eyes: "eyesClosed" } });
  Object.assign(doc.motions[1].poses[4], { attachments: { eyes: "eyesOpen", mouth: null } });
  for (const [id, loop, finalEyes] of [["run", true, "eyesOpen"], ["cast", false, "eyesOpen"], ["death", false, "eyesClosed"], ["celebrate", true, "eyesOpen"]])
    doc.motions.push({ id, name: id, duration: 1, loop, description: "Authored expression test", poses: [
      { time: 0, angles: {}, attachments: { eyes: "eyesOpen" } },
      { time: .37, angles: { head: 3 }, attachments: { eyes: "eyesClosed", mouth: "mouthShout" } },
      { time: 1, angles: {}, attachments: { eyes: finalEyes, mouth: null } },
    ] });
  return validateRigDocument(doc);
}

function actualSelection(skeleton) {
  return Object.fromEntries(["eyes", "mouth"].map((id) => [id, skeleton.findSlot(`group_${id}`).appliedPose.attachment?.name ?? null]));
}

test("setup expressions select one attachment per group and keep all ordinary body parts visible", () => {
  const doc = expressionDraft(), original = structuredClone(doc), setup = resolveRigAttachments({ ...doc, motions: [] });
  assert.deepEqual(setup.attachmentSelection, { eyes: "eyesOpen", mouth: null });
  assert.equal(setup.visiblePartIds.length, 15);
  assert.ok(setup.visiblePartIds.includes("head")); assert.ok(setup.visiblePartIds.includes("eyesOpen"));
  assert.ok(!setup.visiblePartIds.includes("eyesClosed") && !setup.visiblePartIds.includes("mouthNeutral"));
  const noDefaults = { ...doc }; delete noDefaults.defaultAttachments;
  assert.deepEqual(resolveRigAttachments(noDefaults).attachmentSelection, { eyes: "eyesOpen", mouth: "mouthNeutral" });
  assert.deepEqual(resolveRigAttachments(doc, "idle", .75).attachmentSelection, { eyes: "eyesClosed", mouth: "mouthNeutral" });
  assert.deepEqual(resolveRigAttachments(doc, "idle", 1.25).attachmentSelection, { eyes: "eyesAngry", mouth: "mouthNeutral" });
  assert.deepEqual(resolveRigAttachments(doc, "idle", 2.75), resolveRigAttachments(doc, "idle", .75));
  assert.deepEqual(sampleRigPose(doc, "idle", .75).visiblePartIds, resolveRigAttachments(doc, "idle", .75).visiblePartIds);
  assert.deepEqual(doc, original);
  assert.equal(rigPartSlotName(doc.parts[0]), `slot_${doc.parts[0].id}`);
  assert.equal(rigPartSlotName(doc.parts.at(-1)), "group_mouth");
  assert.throws(() => resolveRigAttachments(doc, "missing"), /动作不存在/);
});

test("all seven exported motions perform discrete expression changes in the official Spine runtime", async () => {
  const doc = expressionDraft(), files = await buildRigFiles(doc, pixelEnv), bundle = parseBundle(files), json = compileRigSkeleton(doc);
  assert.equal(bundle.parts.length, doc.parts.length); assert.equal(json.slots.length, 16);
  assert.deepEqual(Object.keys(json.skins[0].attachments.group_eyes), ["eyesOpen", "eyesClosed", "eyesAngry"]);
  assert.deepEqual(Object.keys(json.skins[0].attachments.group_mouth), ["mouthNeutral", "mouthShout"]);
  assert.equal(json.slots.find((slot) => slot.name === "group_mouth").attachment, undefined);
  assert.deepEqual(json.animations.hit.slots.group_eyes.attachment, [{ time: 0, name: "eyesOpen" }]);
  assert.deepEqual(json.animations.hit.slots.group_mouth.attachment, [{ time: 0, name: null }]);
  for (const part of doc.parts) assert.ok(files[`images/${part.id}.png`], part.id);
  const { data } = parseSkeleton(bundle), setup = new Skeleton(data); setup.setupPose(); setup.updateWorldTransform(Physics.none);
  assert.deepEqual(actualSelection(setup), { eyes: "eyesOpen", mouth: null });
  let runtimeSamples = 0, selectedWeightedSamples = 0, weightedBakeSamples = 0;
  for (const motion of doc.motions) {
    const skeleton = new Skeleton(data), state = new AnimationState(new AnimationStateData(data)), track = state.setAnimation(0, motion.id, false);
    const times = [...new Set([0, ...Array.from({ length: 121 }, (_, i) => motion.duration * i / 120),
      ...motion.poses.flatMap((pose) => [Math.max(0, pose.time - .0001), Math.min(motion.duration, pose.time + .0001)])])].sort((a, b) => a - b);
    for (const time of times) {
      skeleton.setupPose(); track.trackTime = time; state.apply(skeleton); skeleton.updateWorldTransform(Physics.none);
      const expected = sampleRigPose(doc, motion.id, time);
      assert.deepEqual(actualSelection(skeleton), expected.attachmentSelection, `${motion.id}@${time}`);
      for (const slot of skeleton.drawOrder.appliedPose) {
        const shape = attachmentVertices(skeleton, slot);
        if (shape) assert.ok([...shape.vertices].every(Number.isFinite));
      }
      if (expected.attachmentSelection.eyes === "eyesAngry") {
        const shape = attachmentVertices(skeleton, skeleton.findSlot("group_eyes")), vertices = expected.parts.eyesAngry.vertices;
        assert.ok(shape.attachment.bones, "selected expression is a real weighted mesh");
        // The runtime linearly interpolates baked curves between keys. Compare
        // exact document FK at bake times; all subframes still verify the real
        // selected mesh and finite geometry independently of that approximation.
        const frame = time * Math.ceil(motion.duration * json.skeleton.fps) / motion.duration;
        if (Math.abs(frame - Math.round(frame)) < 1e-7) {
          for (let i = 0; i < vertices.length; i += 2) {
            assert.ok(Math.abs(shape.vertices[i] - vertices[i]) < .02, `${motion.id}@${time}: weighted expression x ${shape.vertices[i]} vs ${vertices[i]}`);
            assert.ok(Math.abs(doc.height - shape.vertices[i + 1] - vertices[i + 1]) < .02, `${motion.id}@${time}: weighted expression y ${doc.height - shape.vertices[i + 1]} vs ${vertices[i + 1]}`);
          }
          weightedBakeSamples++;
        }
        selectedWeightedSamples++;
      }
      runtimeSamples++;
    }
  }
  assert.equal(doc.motions.length, 7); assert.ok(runtimeSamples >= 847); assert.ok(selectedWeightedSamples > 40); assert.ok(weightedBakeSamples > 10);
});

test("a loop reports attachment discontinuity and unlocked feet have explicit zero contact counts", () => {
  const doc = expressionDraft(), valid = inspectRigMotion(doc, "idle");
  assert.deepEqual(valid.issues, []); assert.equal(valid.loop.attachmentsContinuous, true);
  assert.deepEqual(valid.footContactSamples, { left: 61, right: 61 });
  doc.motions[0].poses.at(-1).attachments.eyes = "eyesClosed";
  const invalid = inspectRigMotion(doc, "idle");
  assert.equal(invalid.loop.attachmentsContinuous, false); assert.deepEqual(invalid.loop.attachmentChanges, ["eyes"]);
  assert.ok(invalid.issues.some((issue) => issue.includes("首尾附件")));
  const airborne = inspectRigMotion(doc, "run");
  assert.deepEqual(airborne.footContactSamples, { left: 0, right: 0 });
  assert.deepEqual(airborne.maxFootSlide, { left: 0, right: 0 });
  doc.motions = [{ id: "contact_test", duration: 1, poses: [
    { time: 0, feet: { left: true, right: false } }, { time: .5, feet: { left: false, right: true } }, { time: 1, feet: { right: false } },
  ] }];
  assert.deepEqual(inspectRigMotion(doc, "contact_test").footContactSamples, { left: 30, right: 30 });
});

test("replacing or adding an expression motion preserves calibrated artwork, groups, defaults and painted weights", () => {
  let doc = expressionDraft();
  doc = setRigPartWeights(doc, "eyesAngry", 0, [{ joint: "head", weight: 1 }]);
  const before = structuredClone(doc), attack = { ...doc.motions[1], poses: doc.motions[1].poses.map((pose) => ({ ...pose, attachments: { eyes: "eyesClosed", mouth: null } })) };
  const changed = replaceRigMotion(doc, attack);
  assert.deepEqual(changed.parts, before.parts); assert.deepEqual(changed.defaultAttachments, before.defaultAttachments);
  assert.deepEqual(changed.sourceImage, before.sourceImage); assert.deepEqual(changed.joints, before.joints);
  assert.deepEqual(changed.motions.filter((motion) => motion.id !== "attack"), before.motions.filter((motion) => motion.id !== "attack"));
  assert.deepEqual(getRigPartMesh(changed, "eyesAngry").weights, getRigPartMesh(before, "eyesAngry").weights);
  const added = replaceRigMotion(changed, { id: "wink", duration: .7, poses: [{ time: 0, attachments: { eyes: "eyesClosed" } }, { time: .7, attachments: { eyes: "eyesOpen" } }] });
  assert.equal(added.motions.length, 8); assert.deepEqual(added.parts, before.parts); assert.deepEqual(doc, before);
});

test("hidden expression artwork calibration and every alternative survive runtime, editable and Unity re-import", async () => {
  const doc = expressionDraft(), originalFiles = attachRigAuthoring(await buildRigFiles(doc, pixelEnv), doc), bundle = parseBundle(originalFiles);
  const variant = bundle.parts.find((part) => part.id === "eyesClosed"), edits = { [variant.id]: { image: imageDataBytes(artwork("#118833")).bytes,
    fileName: "calibrated-expression.png", transform: { ...identityTransform(), x: 3, scaleX: .8 } } };
  assert.ok(!resolveRigAttachments(doc).visiblePartIds.includes(variant.id));
  const pages = await compilePages(bundle, edits, pixelEnv), files = await synchronizeRigAuthoring(bundle, edits, pixelEnv), synchronized = readRigAuthoring(files);
  assert.equal(synchronized.parts.find((part) => part.id === variant.id).imageSource, "calibrated");
  assert.deepEqual(synchronized.defaultAttachments, doc.defaultAttachments); assert.deepEqual(synchronized.motions, doc.motions);
  assert.deepEqual(synchronized.parts.map((part) => part.attachmentGroup), doc.parts.map((part) => part.attachmentGroup));
  assert.equal(synchronized.sourceImage, doc.sourceImage);
  for (const options of [{}, { editable: true }, { target: "unity" }]) {
    const restored = parseBundle(unpackZip(exportPackage({ ...bundle, files }, pages, options))), authoring = readRigAuthoring(restored.files);
    assert.deepEqual(authoring, synchronized); assert.equal(restored.parts.length, doc.parts.length);
    assert.deepEqual(restored.json.animations, bundle.json.animations);
    for (const part of doc.parts) assert.deepEqual(restored.files[`images/${part.id}.png`], files[`images/${part.id}.png`]);
    const data = parseSkeleton(restored).data;
    assert.equal(data.animations.length, 7);
    assert.equal(Object.keys(restored.json.skins[0].attachments.group_eyes).length, 3);
  }
  assert.deepEqual(readRigAuthoring(originalFiles), doc);
});

test("group IDs, shared slot constraints and cross-group default or motion references are validated", () => {
  const invalid = (change, pattern) => { const doc = expressionDraft(); change(doc); assert.throws(() => validateRigDocument(doc), pattern); };
  invalid((doc) => { doc.parts.at(-1).attachmentGroup = "嘴"; }, /附件组.*标识/);
  invalid((doc) => { doc.parts.at(-1).attachmentGroup = ""; }, /附件组.*标识/);
  invalid((doc) => { doc.parts.at(-1).bone = "neck"; }, /同组/);
  invalid((doc) => { doc.parts.at(-1).z++; }, /同组/);
  invalid((doc) => { doc.defaultAttachments.unknown = null; }, /不存在的附件组/);
  invalid((doc) => { doc.defaultAttachments.eyes = "mouthNeutral"; }, /不属于/);
  invalid((doc) => { doc.defaultAttachments.eyes = undefined; }, /不属于/);
  invalid((doc) => { doc.motions[0].poses[0].attachments = { eyes: "mouthShout" }; }, /不属于/);
  invalid((doc) => { doc.motions[0].poses[0].attachments = { missing: null }; }, /不存在的附件组/);
  const doc = expressionDraft(), motion = doc.motions[1];
  assert.deepEqual(validateRigMotion(motion, doc.joints, doc.parts), motion);
  assert.throws(() => validateRigMotion(motion, doc.joints), /需要提供部件/);
});

test("continuous turns switch body views and painful expressions while discrete slot order survives runtime and all archive formats", async () => {
  const doc = expressionDraft(), head = doc.parts.find((part) => part.id === "head");
  head.attachmentGroup = "headView";
  doc.parts.push({ ...head, id: "headSide", label: "Side head", image: artwork("#aabbee"), x: head.x - 2, width: head.width + 3 });
  doc.defaultAttachments.headView = "head";
  const order = [...new Set([...doc.parts].sort((a, b) => a.z - b.z).map(rigPartSlotName))], crossed = [...order].reverse();
  doc.motions.push({ id: "turn", duration: 1, loop: false, poses: [
    { time: 0, ease: "linear", attachments: { headView: "head", eyes: "eyesOpen", mouth: "mouthNeutral" } },
    { time: .37, ease: "linear", angles: { head: 14 }, translations: { head: { x: 4, y: 2 } }, scales: { head: { x: .9, y: 1.05 } }, drawOrder: crossed,
      attachments: { headView: "headSide", eyes: "eyesClosed", mouth: "mouthShout" } },
    { time: 1, angles: { head: 22 }, translations: { head: { x: 7, y: 4 } }, scales: { head: { x: .85, y: 1.02 } }, drawOrder: crossed },
  ] });
  const files = attachRigAuthoring(await buildRigFiles(doc, pixelEnv), doc), bundle = parseBundle(files), pages = Object.fromEntries(bundle.pages.map((page) => [page.file, files[page.file]]));
  for (const options of [{}, { editable: true }, { unity: true }]) {
    const archive = parseBundle(unpackZip(exportPackage(bundle, pages, options))), authoring = readRigAuthoring(archive.files), { data } = parseSkeleton(archive);
    assert.deepEqual(authoring.motions.at(-1), validateRigDocument(doc).motions.at(-1));
    assert.deepEqual(authoring.defaultAttachments, doc.defaultAttachments);
    const skeleton = new Skeleton(data), state = new AnimationState(new AnimationStateData(data)), track = state.setAnimation(0, "turn", false);
    for (const time of [0, .013, .3699, .37, .3701, .537, 1]) {
      skeleton.setupPose(); track.trackTime = time; state.apply(skeleton); skeleton.updateWorldTransform(Physics.none);
      assert.deepEqual(skeleton.drawOrder.appliedPose.map((slot) => slot.data.name), time < .37 ? order : crossed);
      assert.equal(skeleton.findSlot("group_headView").appliedPose.attachment.name, time < .37 ? "head" : "headSide");
      if (time >= .37) assert.deepEqual(actualSelection(skeleton), { eyes: "eyesClosed", mouth: "mouthShout" });
      assert.deepEqual(sampleRigPose(authoring, "turn", time).drawOrder, time < .37 ? order : crossed);
    }
    // Do not call setupPose: ordinary motions must reset transforms and order
    // left by a previous turning animation, just as the real player switches.
    state.setAnimation(0, "hit", false).trackTime = .1; state.apply(skeleton); skeleton.updateWorldTransform(Physics.none);
    assert.deepEqual(skeleton.drawOrder.appliedPose.map((slot) => slot.data.name), order);
    assert.equal(skeleton.findSlot("group_headView").appliedPose.attachment.name, "head");
    const expected = sampleRigPose(authoring, "hit", .1), actual = skeleton.findBone("head").appliedPose;
    assert.ok(Math.hypot(actual.worldX - expected.joints.head.x, authoring.height - actual.worldY - expected.joints.head.y) < .03);
  }
  const loop = structuredClone(doc); loop.motions.at(-1).loop = true;
  assert.ok(inspectRigMotion(loop, "turn").issues.some((issue) => issue.includes("绘制顺序")));
  const invalid = structuredClone(doc); invalid.motions.at(-1).poses[1].drawOrder[0] = "headSide";
  assert.throws(() => validateRigDocument(invalid), /绘制顺序/);
});

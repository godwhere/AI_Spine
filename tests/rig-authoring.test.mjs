import test from "node:test";
import assert from "node:assert/strict";
import { Skeleton, AnimationState, AnimationStateData, Physics, MeshAttachment } from "@esotericsoftware/spine-webgl";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { validateRigDocument, validateRigMotion } from "../shared/rig-schema.mjs";
import { createHumanoidDraft, buildRigFiles } from "../src/infrastructure/rig-authoring.js";
import { compileRigSkeleton } from "../engine/rig/compile.js";
import { getRigPartMesh, setRigPartWeights, bindRigWeapon } from "../engine/rig/geometry.js";
import { replaceRigMotion } from "../shared/rig-schema.mjs";
import { sampleRigPose } from "../engine/rig/sample.js";
import { inspectRigMotion } from "../engine/rig/inspect.js";
import { parseBundle } from "../src/infrastructure/archive-files.js";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";
import { parseSkeleton } from "../engine/spine/parse.js";
import { attachmentVertices } from "../engine/spine/geometry.js";
import { pixelEnv } from "./helpers.mjs";
import { packRigAtlasRegions } from "../engine/rig/atlas.js";
import { attachRigAuthoring, readRigAuthoring } from "../engine/archive/rig-project.js";
import { imageDataBytes } from "../shared/codec/image-data.mjs";
import { rigWithCalibratedParts } from "../src/infrastructure/rig-project.js";
import { extractPart, compilePages } from "../src/infrastructure/calibration.js";
import { identityTransform } from "../engine/images/calibration.js";

const draft = () => createHumanoidDraft({ id: "authored-rig", name: "独立人形", width: 240, height: 360 });
const nearly = (actual, expected, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} versus ${expected}`);
function runtime(data, motion) {
  const skeleton = new Skeleton(data), state = new AnimationState(new AnimationStateData(data));
  const track = state.setAnimation(0, motion, false);
  return { skeleton, sample(time) {
    skeleton.setupPose(); track.trackTime = time; state.apply(skeleton); skeleton.updateWorldTransform(Physics.none); return skeleton;
  } };
}
function staffDraft() {
  let doc = draft();
  const left = doc.joints.find((joint) => joint.id === "leftHand"), right = doc.joints.find((joint) => joint.id === "rightHand");
  doc.parts.push({ id: "staff", label: "长棍", bone: "rightHand", x: left.x - 10, y: left.y - 8,
    width: right.x - left.x + 20, height: 16, z: 20, binding: "rigid", influences: ["rightHand"] });
  doc = bindRigWeapon(doc, "staff", { hand: "rightHand", grip: { x: right.x - left.x + 10, y: 8 }, secondaryHand: "leftHand", secondaryGrip: { x: 10, y: 8 } });
  doc.motions = [{ id: "staff_swing", name: "双手挥棍", origin: "authored", description: "两手保持握棍，双脚着地。", duration: 1.2, loop: true,
    poses: [{ time: 0, angles: {} }, { time: .35, angles: { rightUpperArm: 12, rightForearm: 10 }, root: { x: 0, y: 1 } },
      { time: .65, angles: { rightUpperArm: 22, rightForearm: 15, torso: 3 }, root: { x: 0, y: 2 } },
      { time: .95, angles: { rightUpperArm: 8 } }, { time: 1.2, angles: {} }].map((pose) => ({ ...pose, feet: { left: true, right: true } })) }];
  return validateRigDocument(doc);
}

test("programmatic humanoid drafts have their own editable joints, parts, and clearly marked motions", () => {
  const doc = draft();
  assert.equal(doc.version, 1); assert.equal(doc.origin, "procedural-draft");
  assert.equal(doc.joints.length, 18); assert.equal(doc.parts.length, 14);
  assert.deepEqual(doc.motions.map((motion) => motion.id), ["idle", "attack", "hit"]);
  assert.ok(doc.motions.every((motion) => motion.origin === "procedural-draft"));
  assert.ok(doc.parts.every((part) => part.completion === "needs-inpaint" && part.imageSource === "placeholder"));
  assert.ok(doc.parts.some((part) => part.binding === "mesh") && doc.parts.some((part) => part.binding === "rigid"));
  const structure = validateRigDocument({ ...doc, origin: "ai-analysis", motions: [] });
  assert.equal(structure.origin, "ai-analysis"); assert.deepEqual(structure.motions, []);
  assert.equal(compileRigSkeleton(doc).skeleton.images, "images/");
});

test("new weighted meshes bind at their intended image coordinates in the real Spine runtime", async () => {
  const doc = draft(), bundle = parseBundle(await buildRigFiles(doc, pixelEnv)), { data } = parseSkeleton(bundle);
  const skeleton = new Skeleton(data); skeleton.setupPose(); skeleton.updateWorldTransform(Physics.none);
  assert.equal(data.bones.length, doc.joints.length); assert.equal(bundle.parts.length, doc.parts.length);
  for (const joint of doc.joints) {
    const pose = skeleton.findBone(joint.id).appliedPose;
    nearly(pose.worldX, joint.x); nearly(doc.height - pose.worldY, joint.y);
  }
  for (const part of doc.parts.filter((part) => part.binding === "mesh")) {
    const slot = skeleton.findSlot(`slot_${part.id}`), shape = attachmentVertices(skeleton, slot), mesh = getRigPartMesh(doc, part.id);
    assert.ok(shape.attachment instanceof MeshAttachment); assert.ok(shape.attachment.bones, "mesh must use actual weighted binding");
    for (let i = 0; i < mesh.vertices.length; i += 2) {
      nearly(shape.vertices[i], mesh.vertices[i]); nearly(doc.height - shape.vertices[i + 1], mesh.vertices[i + 1]);
    }
    assert.equal(mesh.weights.length, 9);
    for (const weights of mesh.weights) nearly(weights.reduce((sum, weight) => sum + weight.weight, 0), 1);
  }
});

test("dragging a joint changes the authored bone without shifting setup image vertices", async () => {
  const original = draft(), doc = structuredClone(original);
  doc.joints.find((joint) => joint.id === "leftForearm").x += 8;
  doc.joints.find((joint) => joint.id === "leftForearm").y -= 5;
  const originalJSON = compileRigSkeleton(original), json = compileRigSkeleton(doc);
  assert.notDeepEqual(json.bones.find((bone) => bone.name === "leftForearm"), originalJSON.bones.find((bone) => bone.name === "leftForearm"));
  const { data } = parseSkeleton(parseBundle(await buildRigFiles(doc, pixelEnv))), skeleton = new Skeleton(data);
  skeleton.setupPose(); skeleton.updateWorldTransform(Physics.none);
  const joint = doc.joints.find((joint) => joint.id === "leftForearm"), pose = skeleton.findBone(joint.id).appliedPose;
  nearly(pose.worldX, joint.x); nearly(doc.height - pose.worldY, joint.y);
  const mesh = getRigPartMesh(doc, "leftUpperArm"), shape = attachmentVertices(skeleton, skeleton.findSlot("slot_leftUpperArm"));
  for (let i = 0; i < mesh.vertices.length; i += 2) {
    nearly(shape.vertices[i], mesh.vertices[i]); nearly(doc.height - shape.vertices[i + 1], mesh.vertices[i + 1]);
  }
});

test("default motion baking keeps real runtime feet planted and all weighted vertices finite", async () => {
  const doc = draft(), { data } = parseSkeleton(parseBundle(await buildRigFiles(doc, pixelEnv)));
  let maximumFootError = 0;
  for (const motion of doc.motions) {
    const player = runtime(data, motion.id), report = inspectRigMotion(doc, motion.id);
    assert.deepEqual(report.issues, []); assert.equal(report.finite, true);
    for (let i = 0; i <= 111; i++) {
      const skeleton = player.sample(motion.duration * i / 111);
      for (const side of ["left", "right"]) {
        const original = doc.joints.find((joint) => joint.id === `${side}Foot`), actual = skeleton.findBone(original.id).appliedPose;
        maximumFootError = Math.max(maximumFootError, Math.hypot(actual.worldX - original.x, doc.height - actual.worldY - original.y));
      }
      for (const slot of skeleton.drawOrder.appliedPose) {
        const shape = attachmentVertices(skeleton, slot);
        if (shape) assert.ok([...shape.vertices].every((value) => Number.isFinite(value) && Math.abs(value) < 1500));
      }
    }
    const first = player.sample(0).bones.map((bone) => [bone.appliedPose.worldX, bone.appliedPose.worldY]);
    if (motion.loop) {
      player.sample(motion.duration);
      player.skeleton.bones.forEach((bone, index) => { nearly(bone.appliedPose.worldX, first[index][0]); nearly(bone.appliedPose.worldY, first[index][1]); });
    }
  }
  assert.ok(maximumFootError < .05, `baked subframe foot drift ${maximumFootError} px`);
});

test("a non-grid foot release keeps both real runtime feet locked through the Float32 left limit", async () => {
  const doc = draft(), release = .347;
  doc.motions = [{ id: "release_test", name: "Contact release", duration: 1.1, loop: false, poses: [
    { time: 0, feet: { left: true, right: true } },
    { time: .17, angles: { root: -2, torso: -7, leftThigh: -3, leftShin: 6, rightThigh: 4, rightShin: -6 }, root: { x: 2, y: 3 } },
    { time: release, angles: { root: 2, torso: 9, leftThigh: -23, leftShin: 49, leftFoot: -25, rightThigh: 19, rightShin: -39, rightFoot: 18 }, root: { x: 4, y: 20 }, feet: { left: false, right: false } },
    { time: .68, angles: { root: 6, torso: 30, leftThigh: -48, leftShin: 108, rightThigh: 34, rightShin: -91 }, root: { x: 14, y: 65 } },
    { time: 1.1, angles: { root: 8, torso: 40, leftThigh: -65, leftShin: 145, rightThigh: 45, rightShin: -125 }, root: { x: 18, y: 100 } },
  ] }];
  const original = structuredClone(doc), json = compileRigSkeleton(doc), frames = json.animations.release_test.bones.leftShin.rotate;
  const guardIndex = frames.findIndex((frame) => frame.curve === "stepped"), guard = frames[guardIndex], transition = frames[guardIndex + 1];
  assert.ok(guard.time < release && transition.time >= release && transition.time - release < 1e-6);
  assert.equal(Math.fround(guard.time), guard.time); assert.equal(Math.fround(transition.time), transition.time);
  const player = runtime(parseSkeleton(parseBundle(await buildRigFiles(doc, pixelEnv))).data, "release_test");
  const times = [...Array.from({ length: 2001 }, (_, i) => release * i / 2001), release - 1e-4, release - 1e-6,
    release - 1e-8, release - 1e-10, release - Number.EPSILON, guard.time];
  let maximumFootError = 0;
  for (const time of times) {
    const skeleton = player.sample(time), expected = sampleRigPose(doc, "release_test", time);
    for (const side of ["left", "right"]) {
      assert.equal(expected.feet[side], true);
      const actual = skeleton.findBone(`${side}Foot`).appliedPose, target = expected.footTargets[side];
      maximumFootError = Math.max(maximumFootError, Math.hypot(actual.worldX - target.x, doc.height - actual.worldY - target.y));
    }
  }
  assert.ok(maximumFootError < .5, `locked interval drift ${maximumFootError}px`);
  const released = player.sample(transition.time), expected = sampleRigPose(doc, "release_test", release);
  assert.deepEqual(expected.feet, { left: false, right: false });
  for (const side of ["left", "right"]) {
    const actual = released.findBone(`${side}Foot`).appliedPose, target = expected.joints[`${side}Foot`];
    assert.ok(Math.hypot(actual.worldX - target.x, doc.height - actual.worldY - target.y) < .001, "runtime activates the exact released pose at its representable transition time");
  }
  assert.deepEqual(doc, original);
});

test("weight painting reaches the compiled mesh and replacing one motion preserves all bindings", () => {
  const source = draft(), painted = setRigPartWeights(source, "torso", 0, [{ joint: "torso", weight: 2 }, { joint: "neck", weight: 1 }]);
  const before = structuredClone(painted), attack = { ...painted.motions.find((motion) => motion.id === "attack"), description: "更新指定动作", origin: "ai-analysis" };
  attack.poses = attack.poses.map((pose) => ({ ...pose, angles: { ...pose.angles, head: 3 } }));
  const changed = replaceRigMotion(painted, attack);
  assert.deepEqual(changed.joints, before.joints); assert.deepEqual(changed.parts, before.parts);
  assert.deepEqual(changed.motions.filter((motion) => motion.id !== "attack"), before.motions.filter((motion) => motion.id !== "attack"));
  assert.deepEqual(painted, before); assert.equal(changed.motions.length, 3);
  const json = compileRigSkeleton(changed), mesh = json.skins[0].attachments.slot_torso.torso;
  const torsoIndex = json.bones.findIndex((bone) => bone.name === "torso"), neckIndex = json.bones.findIndex((bone) => bone.name === "neck");
  assert.equal(mesh.vertices[0], 2); assert.equal(mesh.vertices[1], torsoIndex); nearly(mesh.vertices[4], 2 / 3);
  assert.equal(mesh.vertices[5], neckIndex); nearly(mesh.vertices[8], 1 / 3);
  assert.deepEqual(compileRigSkeleton(before).animations.idle, json.animations.idle);
});

test("smooth interpolation and motion IDs have deterministic semantics independent of labels", () => {
  const doc = draft();
  doc.motions = [{ id: "pose_test", name: "中文动作标签", duration: 1, loop: false,
    poses: [{ time: 0, angles: { head: 0 }, root: { x: 0, y: 0 }, ease: "smooth" }, { time: 1, angles: { head: 80 }, root: { x: 20, y: 0 } }] }];
  const smooth = sampleRigPose(doc, "pose_test", .25); nearly(smooth.angles.head, 12.5); nearly(smooth.root.x, 3.125);
  doc.motions[0].poses[0].ease = "linear";
  const linear = sampleRigPose(doc, "pose_test", .25); nearly(linear.angles.head, 20); nearly(linear.root.x, 5);
  assert.deepEqual(Object.keys(compileRigSkeleton(doc).animations), ["pose_test"]);
});

test("two hands hold the same staff through a sampled swing in actual exported Spine animation", async () => {
  const doc = staffDraft(), report = inspectRigMotion(doc, "staff_swing", { samples: 121 });
  assert.deepEqual(report.issues, []); assert.equal(report.weaponGrips[0].mode, "dual-hand-ik");
  assert.ok(report.weaponGrips[0].maxError < 1e-6);
  const { data } = parseSkeleton(parseBundle(await buildRigFiles(doc, pixelEnv))), skeleton = new Skeleton(data);
  skeleton.setupPose(); skeleton.updateWorldTransform(Physics.none);
  const weapon = doc.parts.find((part) => part.id === "staff"), setup = skeleton.findBone("rightHand").appliedPose;
  const setupPoint = { x: weapon.x + weapon.grip.secondaryLocalPoint.x, y: doc.height - weapon.y - weapon.grip.secondaryLocalPoint.y };
  const dx = setupPoint.x - setup.worldX, dy = setupPoint.y - setup.worldY, determinant = setup.a * setup.d - setup.b * setup.c;
  const local = { x: (setup.d * dx - setup.b * dy) / determinant, y: (-setup.c * dx + setup.a * dy) / determinant };
  const player = runtime(data, "staff_swing"); let maximumError = 0;
  for (let i = 0; i <= 121; i++) {
    const pose = player.sample(1.2 * i / 121), right = pose.findBone("rightHand").appliedPose, left = pose.findBone("leftHand").appliedPose;
    maximumError = Math.max(maximumError, Math.hypot(right.worldX + right.a * local.x + right.b * local.y - left.worldX,
      right.worldY + right.c * local.x + right.d * local.y - left.worldY));
  }
  assert.ok(maximumError < .3, `baked subframe secondary grip error ${maximumError} px`);
});

test("unreachable feet and grip targets and discontinuous loops are reported instead of accepted", () => {
  const feet = draft(); feet.motions[0].poses[1].root.y = -150;
  const footReport = inspectRigMotion(feet, "idle");
  assert.ok(footReport.issues.some((issue) => issue.includes("脚滑"))); assert.ok(footReport.maxFootSlide.left > 10);
  const grip = staffDraft(); grip.motions[0].poses[1].angles.rightUpperArm = -100;
  const gripReport = inspectRigMotion(grip, "staff_swing");
  assert.ok(gripReport.issues.some((issue) => issue.includes("握点"))); assert.ok(gripReport.weaponGrips[0].maxError > 10);
  const loop = draft(); loop.motions[0].poses.at(-1).angles.head = 20;
  assert.ok(inspectRigMotion(loop, "idle").issues.some((issue) => issue.includes("首尾")));
});

test("atlas assembly emits independently editable PNGs without claiming crops are finished art", async () => {
  const source = createCanvas(240, 360), context = source.getContext("2d");
  context.fillStyle = "#ff0000"; context.fillRect(0, 0, 240, 360);
  const doc = createHumanoidDraft({ id: "source-crop", width: 240, height: 360, sourceImage: source.toDataURL("image/png") });
  const independent = createCanvas(10, 10), independentContext = independent.getContext("2d");
  independentContext.fillStyle = "#00ff00"; independentContext.fillRect(0, 0, 10, 10);
  doc.parts[0].image = independent.toDataURL("image/png"); doc.parts[0].imageSource = "uploaded"; doc.parts[0].completion = "ready";
  const before = structuredClone(doc), files = await buildRigFiles(doc, pixelEnv), bundle = parseBundle(files);
  assert.deepEqual(doc, before);
  assert.equal(doc.parts[1].completion, "needs-inpaint"); assert.equal(doc.parts[1].imageSource, "source-crop");
  assert.equal(Object.keys(files).filter((path) => path.startsWith("images/")).length, doc.parts.length);
  const page = await loadImage(Buffer.from(files["rig.png"])), canvas = createCanvas(page.width, page.height), ctx = canvas.getContext("2d"); ctx.drawImage(page, 0, 0);
  for (const [index, expected] of [[0, [0, 255, 0, 255]], [1, [255, 0, 0, 255]]]) {
    const part = doc.parts[index], region = bundle.parts.find((region) => region.id === part.id);
    assert.deepEqual([...ctx.getImageData(region.x + 1, region.y + 1, 1, 1).data], expected);
    const image = await loadImage(Buffer.from(files[`images/${part.id}.png`]));
    assert.equal(image.width, Math.ceil(part.width)); assert.equal(image.height, Math.ceil(part.height));
  }
});

test("original-resolution regions paginate at 8192 for both shelf overflow and total area without overlap", () => {
  const cases = [[{ id: "wide-a", width: 4093, height: 4093 }, { id: "wide-b", width: 4093, height: 4093 }],
    Array.from({ length: 256 }, (_, index) => ({ id: `region_${index}`, width: 1024 + index % 7, height: 512 + index % 5 }))];
  for (const parts of cases) {
    const before = structuredClone(parts), pages = packRigAtlasRegions(parts), regions = pages.flatMap((page) => page.regions);
    assert.ok(pages.length > 1); assert.deepEqual(regions.map((part) => part.id), parts.map((part) => part.id));
    for (const page of pages) {
      assert.ok(page.width <= 8192 && page.height <= 8192);
      assert.ok(Number.isInteger(Math.log2(page.width)) && Number.isInteger(Math.log2(page.height)));
      for (const [index, region] of page.regions.entries()) {
        const original = parts.find((part) => part.id === region.id);
        assert.equal(region.width, original.width); assert.equal(region.height, original.height);
        assert.ok(region.x >= 2 && region.y >= 2 && region.x + region.width + 2 <= page.width && region.y + region.height + 2 <= page.height);
        for (const other of page.regions.slice(index + 1)) assert.ok(region.x + region.width <= other.x || other.x + other.width <= region.x ||
          region.y + region.height <= other.y || other.y + other.height <= region.y, `${region.id} overlaps ${other.id}`);
      }
    }
    assert.deepEqual(parts, before);
  }
  for (const size of [{ width: 8192, height: 1 }, { width: 1, height: 8189 }])
    assert.throws(() => packRigAtlasRegions([{ id: "oversized-original", ...size }]), /oversized-original.*8192.*无法分页/);
  for (const maxPageSize of [16384, 8193, 33, 0, NaN]) assert.throws(() => packRigAtlasRegions([{ id: "small", width: 1, height: 1 }], { maxPageSize }), /8192/);
});

function pagedArtworkDraft() {
  const parts = Array.from({ length: 24 }, (_, index) => {
    const width = 35 + index % 4 * 3, height = 28 + index % 3 * 2, canvas = createCanvas(width, height), context = canvas.getContext("2d");
    const pixels = context.createImageData(width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.data.set([
      (index * 41 + x * 7) % 256, (index * 29 + y * 11) % 256, (x * 13 + y * 3) % 256,
      x > 0 && y > 0 && x < width - 1 && y < height - 1 ? 255 : 0,
    ], (y * width + x) * 4);
    context.putImageData(pixels, 0, 0);
    return { id: `tile_${index}`, label: `Tile ${index}`, bone: "root", x: index % 4 * 50, y: Math.floor(index / 4) * 40,
      width, height, z: index === 20 ? 0 : index, binding: index === 7 ? "mesh" : "rigid", influences: ["root"],
      image: canvas.toDataURL("image/png"), imageSource: "uploaded", completion: "ready",
      ...([0, 20].includes(index) ? { attachmentGroup: "eyes" } : {}) };
  });
  return validateRigDocument({ version: 1, id: "paged-original-art", name: "Paged artwork", width: 256, height: 256,
    joints: [{ id: "root", label: "Root", parent: null, x: 128, y: 128 }], parts, defaultAttachments: { eyes: "tile_0" },
    motions: [{ id: "idle", name: "Idle", duration: 1, loop: true, poses: [{ time: 0 }, { time: 1 }] },
      { id: "switch", name: "Switch across pages", duration: 1, loop: false,
        poses: [{ time: 0, attachments: { eyes: "tile_0" } }, { time: .5, attachments: { eyes: "tile_20" } }, { time: 1 }] }] });
}

test("real PNG pages preserve every region pixel, mesh UV, cross-page attachment switch and all archive formats", async () => {
  const doc = pagedArtworkDraft(), before = structuredClone(doc), canvases = [];
  let maxActivePages = 0;
  const pixels = { ...pixelEnv, createCanvas(width, height) {
    const canvas = createCanvas(width, height); canvases.push({ canvas, page: width === 128 });
    maxActivePages = Math.max(maxActivePages, canvases.filter((item) => item.page && item.canvas.width > 1).length);
    return canvas;
  } };
  const files = attachRigAuthoring(await buildRigFiles(doc, pixels, { maxPageSize: 128 }), doc);
  assert.equal(maxActivePages, 1, "page encoding releases the prior canvas before allocating the next");
  assert.ok(canvases.every(({ canvas }) => canvas.width === 1 && canvas.height === 1), "decoded crops and atlas backing stores are released");
  const bundle = parseBundle(files), { data, atlas } = parseSkeleton(bundle);
  assert.ok(bundle.pages.length >= 3); assert.equal(bundle.pages[0].file, "rig.png");
  assert.deepEqual(bundle.pages.slice(1).map((page, index) => page.file), bundle.pages.slice(1).map((_, index) => `rig-${index + 2}.png`));
  assert.deepEqual(bundle.json, JSON.parse(JSON.stringify(compileRigSkeleton(doc)))); assert.equal(bundle.parts.length, doc.parts.length);
  for (const part of doc.parts) {
    const region = bundle.parts.find((region) => region.id === part.id), page = bundle.pages.find((page) => page.file === region.pageFile);
    assert.ok(page.width <= 128 && page.height <= 128); assert.equal(page.pma, false);
    assert.deepEqual(files[`images/${part.id}.png`], imageDataBytes(part.image).bytes, `independent PNG ${part.id}`);
    const expected = await pixelEnv.loadImage(imageDataBytes(part.image).bytes), original = createCanvas(expected.width, expected.height);
    original.getContext("2d").drawImage(expected, 0, 0);
    const cropped = await extractPart(bundle, region, pixelEnv);
    assert.equal(cropped.width, part.width); assert.equal(cropped.height, part.height);
    assert.deepEqual(cropped.getContext("2d").getImageData(0, 0, cropped.width, cropped.height).data,
      original.getContext("2d").getImageData(0, 0, part.width, part.height).data, `all source pixels ${part.id}`);
    const attachment = data.defaultSkin.getAttachment(data.findSlot(part.attachmentGroup ? "group_eyes" : `slot_${part.id}`).index, part.id);
    const actual = attachment.sequence.regions[0], uvs = attachment.sequence.uvs[0];
    assert.equal(actual.page.name, page.file); assert.equal(actual.name, part.id);
    nearly(actual.u, region.x / page.width); nearly(actual.v, region.y / page.height);
    const localUVs = part.binding === "mesh" ? attachment.regionUVs : [0, 1, 0, 0, 1, 0, 1, 1];
    for (let index = 0; index < localUVs.length; index += 2) {
      nearly(uvs[index], (region.x + localUVs[index] * part.width) / page.width);
      nearly(uvs[index + 1], (region.y + localUVs[index + 1] * part.height) / page.height);
    }
  }
  assert.notEqual(bundle.parts.find((part) => part.id === "tile_0").pageFile, bundle.parts.find((part) => part.id === "tile_20").pageFile);
  for (const options of [{}, { editable: true }, { target: "unity" }]) {
    const output = unpackZip(exportPackage(bundle, {}, options)), restored = parseBundle(output), value = parseSkeleton(restored);
    assert.deepEqual(restored.json, bundle.json); assert.deepEqual(readRigAuthoring(restored.files), doc);
    assert.equal(restored.pages.length, bundle.pages.length);
    for (const page of bundle.pages) assert.deepEqual(output[page.file], files[page.file]);
    for (const part of doc.parts) assert.deepEqual(output[`images/${part.id}.png`], files[`images/${part.id}.png`]);
    const player = runtime(value.data, "switch");
    assert.equal(player.sample(0).findSlot("group_eyes").appliedPose.attachment.sequence.regions[0].page.name, bundle.parts.find((part) => part.id === "tile_0").pageFile);
    assert.equal(player.sample(.5).findSlot("group_eyes").appliedPose.attachment.sequence.regions[0].page.name, bundle.parts.find((part) => part.id === "tile_20").pageFile);
    assert.equal(player.sample(1).findSlot("group_eyes").appliedPose.attachment.name, "tile_20");
  }
  assert.deepEqual(await rigWithCalibratedParts(doc, bundle, {}, pixelEnv), doc, "multi-page reads retain exact authoring images and weights");
  const edited = bundle.parts.find((part) => part.id === "tile_20"), replacement = createCanvas(edited.width, edited.height);
  replacement.getContext("2d").fillStyle = "#43c56e"; replacement.getContext("2d").fillRect(0, 0, replacement.width, replacement.height);
  const pages = await compilePages(bundle, { [edited.id]: { image: await pixelEnv.encode(replacement), transform: identityTransform() } }, pixelEnv);
  assert.deepEqual(Object.keys(pages), [edited.pageFile], "calibration only rewrites its own texture page");
  const changed = parseBundle({ ...bundle.files, ...pages }), extracted = await extractPart(changed, edited, pixelEnv);
  assert.deepEqual([...extracted.getContext("2d").getImageData(5, 5, 1, 1).data], [67, 197, 110, 255]);
  assert.deepEqual(doc, before);
});

test("a single oversize original region is rejected before allocating or decoding any pixels", async () => {
  const doc = { version: 1, id: "oversize-art", name: "Oversize original", width: 8192, height: 32,
    joints: [{ id: "root", parent: null, x: 4, y: 4 }],
    parts: [{ id: "original-too-wide", bone: "root", x: 0, y: 0, width: 8192, height: 16, binding: "rigid", influences: ["root"] }], motions: [] };
  let calls = 0;
  const unexpected = () => { calls++; throw new Error("Oversize preflight must not allocate pixels"); };
  await assert.rejects(buildRigFiles(doc, { createCanvas: unexpected, loadImage: unexpected, encode: unexpected }), /original-too-wide.*8192.*无法分页/);
  assert.equal(calls, 0);
});

test("authored rigs export and reimport with all animation, skin, binding, and image bytes preserved", async () => {
  const doc = staffDraft(), files = await buildRigFiles(doc, pixelEnv), original = parseBundle(files);
  const exported = unpackZip(exportPackage(original)), restored = parseBundle(exported);
  for (const path of Object.keys(files)) assert.deepEqual(exported[path], files[path]);
  assert.deepEqual(restored.json, original.json);
  const before = parseSkeleton(original).data, after = parseSkeleton(restored).data;
  assert.deepEqual(after.animations.map((motion) => motion.name), before.animations.map((motion) => motion.name));
  assert.equal(after.bones.length, doc.joints.length); assert.equal(restored.parts.length, doc.parts.length);
  assert.equal(after.skins.length, 1); nearly(after.findAnimation("staff_swing").duration, 1.2);
});

test("invalid parents, weights, motion targets, image data, and paths are rejected", () => {
  const invalid = (change, pattern) => { const doc = draft(); change(doc); assert.throws(() => validateRigDocument(doc), pattern); };
  invalid((doc) => { doc.joints[0].parent = "head"; }, /根关节|循环/);
  invalid((doc) => { doc.joints[2].parent = "missing"; }, /父级/);
  invalid((doc) => { doc.joints[3].x = NaN; }, /关节/);
  invalid((doc) => { doc.parts[0].id = "../secret"; }, /标识/);
  invalid((doc) => { doc.parts[0].image = "https://example.com/secret.png"; }, /本地/);
  invalid((doc) => { doc.parts[0].mesh = { cols: 3, rows: 3, weights: [] }; }, /权重数量/);
  invalid((doc) => { doc.motions[0].poses[0].angles.unknown = 5; }, /不存在/);
  invalid((doc) => { doc.motions[0].poses[1].time = 0; }, /递增/);
  invalid((doc) => { doc.joints.find((joint) => joint.id === "leftFoot").parent = "root"; }, /脚锁/);
  assert.throws(() => setRigPartWeights(draft(), "torso", 0, [{ joint: "torso", weight: 0 }]), /大于零/);
  assert.throws(() => setRigPartWeights(draft(), "torso", 0, [{ joint: "leftHand", weight: 1 }]), /关节/);
  assert.throws(() => validateRigMotion({ id: "bad", duration: 1, poses: [{ time: 0, angles: { head: Infinity } }] }, draft().joints), /角度/);
});

test("inherited affine translation and nonuniform scale match real weighted and rigid runtime geometry between baked times", async () => {
  const doc = draft(), idle = structuredClone(doc.motions[0]);
  doc.motions.push({ id: "affine", duration: 1, loop: false, poses: [
    { time: 0, angles: { torso: 6, head: 4 }, translations: { head: { x: 2, y: -1 } }, scales: { root: { x: 1.04, y: .96 }, torso: { x: .9, y: 1.1 } }, ease: "linear" },
    { time: .37, angles: { torso: -8, head: 14, leftUpperArm: 12 }, translations: { head: { x: 7, y: 3 }, leftForearm: { x: -2, y: 4 } }, scales: { root: { x: .95, y: 1.06 }, torso: { x: 1.12, y: .86 }, head: { x: 1.1, y: .9 } }, ease: "linear" },
    { time: 1, angles: { torso: 3, head: -7 }, translations: { head: { x: -3, y: 1 } }, scales: { root: { x: 1.08, y: .92 }, torso: { x: 1, y: 1 }, head: { x: .96, y: 1.04 } }, ease: "linear" },
  ] });
  const files = await buildRigFiles(doc, pixelEnv), bundle = parseBundle(files), { data } = parseSkeleton(bundle), player = runtime(data, "affine");
  assert.deepEqual(doc.motions[0], idle, "new channels never rewrite the protected idle document");
  assert.ok(bundle.json.animations.affine.bones.head.translate.length > 20);
  assert.ok(bundle.json.animations.affine.bones.root.scale.length > 20);
  let maximumError = 0, rigidCount = 0, weightedCount = 0;
  for (const time of [.013, .129, .239, .37, .371, .499, .733, .999]) {
    const expected = sampleRigPose(doc, "affine", time), actual = player.sample(time);
    for (const joint of doc.joints) {
      const bone = actual.findBone(joint.id).appliedPose, pose = expected.joints[joint.id];
      maximumError = Math.max(maximumError, Math.hypot(bone.worldX - pose.x, doc.height - bone.worldY - pose.y));
      nearly(bone.a, pose.a, 1e-5); nearly(-bone.c, pose.b, 1e-5); nearly(-bone.b, pose.c, 1e-5); nearly(bone.d, pose.d, 1e-5);
    }
    for (const part of doc.parts) {
      const shape = attachmentVertices(actual, actual.findSlot(`slot_${part.id}`)), vertices = expected.parts[part.id].vertices;
      if (part.binding === "mesh") {
        weightedCount++;
        for (let i = 0; i < vertices.length; i += 2) maximumError = Math.max(maximumError, Math.hypot(shape.vertices[i] - vertices[i], doc.height - shape.vertices[i + 1] - vertices[i + 1]));
      } else {
        rigidCount++;
        for (let i = 0; i < vertices.length; i += 2) maximumError = Math.max(maximumError, Math.min(...Array.from({ length: 4 }, (_, j) => Math.hypot(shape.vertices[j * 2] - vertices[i], doc.height - shape.vertices[j * 2 + 1] - vertices[i + 1]))));
      }
    }
  }
  assert.ok(rigidCount && weightedCount); assert.ok(maximumError < .001, `actual affine vertices differ by ${maximumError} px`);
  const reset = new Skeleton(data), state = new AnimationState(new AnimationStateData(data));
  state.setAnimation(0, "affine", false).trackTime = .53; state.apply(reset); reset.updateWorldTransform(Physics.none);
  state.setAnimation(0, "idle", false).trackTime = .23; state.apply(reset); reset.updateWorldTransform(Physics.none);
  const baseline = sampleRigPose(doc, "idle", .23);
  for (const joint of doc.joints) nearly(reset.findBone(joint.id).appliedPose.worldX, baseline.joints[joint.id].x, .02);
  const restored = readRigAuthoring(attachRigAuthoring(files, doc));
  assert.deepEqual(restored.motions.at(-1), validateRigDocument(doc).motions.at(-1));
});

test("translated joints and uniform scale preserve actual planted feet and primary and secondary weapon grips at subframes", async () => {
  const doc = staffDraft(), phases = [0, .6, 1, .3, 0];
  doc.motions[0].poses.forEach((pose, index) => { const amount = phases[index];
    pose.translations = { leftShin: { x: .3 * amount, y: .2 * amount }, leftForearm: { x: .2 * amount, y: -.1 * amount } };
    pose.scales = { root: { x: 1 - .01 * amount, y: 1 - .01 * amount }, leftUpperArm: { x: 1 + .01 * amount, y: 1 + .01 * amount }, head: { x: 1 + .03 * amount, y: 1 - .02 * amount } };
  });
  const report = inspectRigMotion(doc, "staff_swing", { samples: 121 }); assert.deepEqual(report.issues, []);
  const { data } = parseSkeleton(parseBundle(await buildRigFiles(doc, pixelEnv))), player = runtime(data, "staff_swing"), setup = player.sample(0), weapon = doc.parts.find((part) => part.id === "staff");
  const bind = setup.findBone(weapon.bone).appliedPose;
  const localPoint = (point) => { const x = weapon.x + point.x - bind.worldX, y = doc.height - weapon.y - point.y - bind.worldY, determinant = bind.a * bind.d - bind.b * bind.c;
    return { x: (bind.d * x - bind.b * y) / determinant, y: (-bind.c * x + bind.a * y) / determinant }; };
  const primary = localPoint(weapon.grip.primaryLocalPoint), secondary = localPoint(weapon.grip.secondaryLocalPoint);
  let footError = 0, gripError = 0;
  for (let i = 0; i <= 139; i++) {
    const pose = player.sample(1.2 * i / 139), hand = pose.findBone(weapon.bone).appliedPose;
    for (const side of ["left", "right"]) { const expected = doc.joints.find((joint) => joint.id === `${side}Foot`), actual = pose.findBone(expected.id).appliedPose;
      footError = Math.max(footError, Math.hypot(actual.worldX - expected.x, doc.height - actual.worldY - expected.y)); }
    for (const [point, id] of [[primary, weapon.grip.primaryHand], [secondary, weapon.grip.secondaryHand]]) { const follower = pose.findBone(id).appliedPose;
      gripError = Math.max(gripError, Math.hypot(hand.worldX + hand.a * point.x + hand.b * point.y - follower.worldX, hand.worldY + hand.c * point.x + hand.d * point.y - follower.worldY)); }
  }
  assert.ok(footError < .1, `actual planted foot drift ${footError} px`); assert.ok(gripError < .3, `actual primary/secondary grip drift ${gripError} px`);
  const unsupported = structuredClone(doc); unsupported.motions[0].poses[1].scales.root.y = .95;
  assert.throws(() => sampleRigPose(unsupported, "staff_swing", .35), /非均匀缩放/);
  assert.throws(() => compileRigSkeleton(unsupported), /非均匀缩放/);
  const unsupportedGrip = structuredClone(doc); unsupportedGrip.motions[0].poses.forEach((pose) => { pose.feet = { left: false, right: false }; });
  unsupportedGrip.motions[0].poses[1].scales.leftUpperArm.y = .97;
  assert.throws(() => sampleRigPose(unsupportedGrip, "staff_swing", .35), /leftHand.*非均匀缩放/);
  const collapsed = structuredClone(doc), upper = collapsed.joints.find((joint) => joint.id === "leftThigh"), lower = collapsed.joints.find((joint) => joint.id === "leftShin");
  // A fully cancelled offset is rejected, rather than solved with stale setup length.
  const setupJSON = compileRigSkeleton(draft()), setupLower = setupJSON.bones.find((bone) => bone.name === lower.id);
  collapsed.motions[0].poses[0].translations.leftShin = { x: -setupLower.x, y: setupLower.y };
  assert.ok(upper); assert.throws(() => sampleRigPose(collapsed, "staff_swing", 0), /有效骨长为零/);
});

test("local transform and draw order validation reject unsupported IDs, zero scales and incomplete permutations without rewriting legacy poses", () => {
  const doc = draft(); assert.deepEqual(validateRigDocument(doc), doc);
  const invalid = (fields, pattern) => { const next = structuredClone(doc); Object.assign(next.motions[0].poses[0], fields); assert.throws(() => validateRigDocument(next), pattern); };
  invalid({ translations: { root: { x: 1, y: 0 } } }, /root/);
  invalid({ translations: { missing: { x: 1, y: 0 } } }, /不存在/);
  invalid({ translations: { head: { x: 0, y: NaN } } }, /无效/);
  invalid({ scales: { head: { x: 0, y: 1 } } }, /缩放/);
  invalid({ scales: { head: { x: -1, y: 1 } } }, /缩放/);
  invalid({ drawOrder: ["slot_head"] }, /完整/);
  const loop = structuredClone(doc); loop.motions[0].poses.at(-1).scales = { head: { x: 1.1, y: 1 } };
  assert.ok(inspectRigMotion(loop, "idle").issues.some((issue) => issue.includes("缩放")));
});

test("reference-only action images retain authoring provenance while ordinary FK compilation and atlases ignore unreviewed or stale stepped data", async () => {
  const doc = draft(), canvas = createCanvas(12, 12); canvas.getContext("2d").fillRect(2, 2, 7, 7);
  const image = canvas.toDataURL("image/png"), before = compileRigSkeleton(doc), original = sampleRigPose(doc, "attack", .231);
  doc.motionStudies = { attack: { playback: "reference", motionId: "attack", frames: [{ id: "ref", time: 0, image, origin: "ai-motion-frame", review: { approved: false }, mappingReview: { approved: false }, jobId: "real-origin-kept" }],
    applied: { kind: "stepped-parts", contentFingerprint: "0".repeat(64) } } };
  assert.deepEqual(compileRigSkeleton(doc), before);
  assert.deepEqual(sampleRigPose(doc, "attack", .231), original);
  assert.equal(inspectRigMotion(doc, "attack").solver.sampler, "rig-document-fk");
  const files = await buildRigFiles(doc, pixelEnv), bundle = parseBundle(files);
  assert.equal(bundle.parts.length, doc.parts.length); assert.ok(Object.keys(files).filter((name) => name.startsWith("images/")).every((name) => !name.includes("ms_")));
  const restored = readRigAuthoring(attachRigAuthoring(files, doc));
  assert.equal(restored.motionStudies.attack.frames[0].image, image); assert.equal(restored.motionStudies.attack.frames[0].jobId, "real-origin-kept");
  assert.equal(restored.motionStudies.attack.frames[0].review.approved, false);
  const legacy = structuredClone(doc); delete legacy.motionStudies.attack.playback;
  assert.throws(() => compileRigSkeleton(legacy), /逐帧动作/);
  const invalid = structuredClone(doc); invalid.motionStudies.attack.playback = "pretend-complete";
  assert.throws(() => validateRigDocument(invalid), /播放方式/);
});

import { rigPartAppearanceView } from "../src/application/rig-view.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { transformWithEsbuild } from "vite";
import { Skeleton, AnimationState, AnimationStateData, Physics } from "@esotericsoftware/spine-webgl";
import { validateRigDocument } from "../shared/rig-schema.mjs";
import { deriveRigPartAnnotations } from "../engine/rig/part-annotations.js";
import { createHumanoidDraft, buildRigFiles } from "../src/infrastructure/rig-authoring.js";
import { rigPartSlotName } from "../engine/rig/attachments.js";
import { sampleRigPose } from "../engine/rig/sample.js";
import { getMotionStudyFingerprints } from "../shared/domain/motion-study.mjs";
import { prepareMotionStudyFrames, applyMotionStudy } from "../src/infrastructure/motion-study-images.js";
import { parseBundle } from "../src/infrastructure/archive-files.js";
import { parseSkeleton } from "../engine/spine/parse.js";
import { attachmentVertices } from "../engine/spine/geometry.js";
import { pixelEnv } from "./helpers.mjs";

function character() {
  const part = (id, bone, x, y, width, height, z, group) => ({ id, label: id, bone, x, y, width, height, z, binding: "rigid", influences: [bone], ...(group ? { attachmentGroup: group } : {}) });
  const doc = { version: 1, id: "annotated-character", name: "Annotation fixture", width: 100, height: 100,
    joints: [{ id: "root", parent: null, x: 45, y: 70 }, { id: "arm", parent: "root", x: 45, y: 40 }, { id: "tip", parent: "arm", x: 65, y: 25 }, { id: "head", parent: "root", x: 45, y: 20 }],
    parts: [part("body", "root", 38, 50, 20, 25, 0), { ...part("cloth", "arm", 36, 30, 22, 22, 1), binding: "mesh", influences: ["root", "arm"], mesh: { cols: 2, rows: 2,
      weights: Array.from({ length: 4 }, () => [{ joint: "root", weight: .25 }, { joint: "arm", weight: .75 }]) } },
      part("hand", "tip", 61, 21, 10, 10, 2), part("eyeOpen", "head", 40, 15, 10, 5, 4, "eyes"), part("eyeClosed", "head", 40, 15, 10, 5, 4, "eyes"), part("mouth", "head", 44, 23, 6, 3, 5, "mouths")],
    defaultAttachments: { eyes: "eyeOpen", mouths: null }, motions: [
      { id: "first", name: "First", duration: 1, poses: [{ time: 0 }, { time: .2, attachments: { eyes: "eyeClosed" } }, { time: .4, attachments: { mouths: "mouth" } },
        { time: .6, attachments: { eyes: null } }, { time: .8, attachments: { eyes: "eyeOpen" } }, { time: 1, attachments: { eyes: "eyeClosed" } }] },
      { id: "second", name: "Second", duration: 1, poses: [{ time: 0 }, { time: 1 }] },
      { id: "override", name: "Override", duration: 1, poses: [{ time: 0, attachments: { eyes: null } }, { time: .5, attachments: { eyes: "eyeOpen" } }, { time: 1 }] },
    ] };
  const order = [...new Set(doc.parts.map(rigPartSlotName))];
  doc.motions.push({ id: "draw", name: "Layer crossing", duration: 1, poses: [{ time: 0 }, { time: .3, drawOrder: [...order].reverse() }, { time: .65, angles: { arm: 10 } }, { time: 1 }] },
    { id: "trs", name: "Affine motion", duration: 1, poses: [{ time: 0, ease: "linear" }, { time: .37, ease: "linear", angles: { root: 15, arm: -30 },
      translations: { arm: { x: 4, y: -3 } }, scales: { root: { x: 1.3, y: .8 }, arm: { x: .9, y: 1.15 } }, drawOrder: [...order].reverse() },
      { time: 1, ease: "linear", angles: { root: -10, arm: 22 }, translations: { arm: { x: -3, y: 5 } }, scales: { root: { x: .85, y: 1.12 }, arm: { x: 1.2, y: .95 } } }] });
  return validateRigDocument(doc);
}
const ranges = (motion) => motion.intervals.map(({ start, end, endInclusive, terminalOnly }) => [start, end, endInclusive, terminalOnly]);
const near = (a, b, tolerance = .001) => assert.ok(Math.abs(a - b) < tolerance, `${a} versus ${b}`);

test("annotations respect exclusive defaults null hiding inheritance first-frame overrides and independent motion starts", () => {
  const doc = character(), before = structuredClone(doc), closed = deriveRigPartAnnotations(doc, "eyeClosed"), open = deriveRigPartAnnotations(doc, "eyeOpen"), mouth = deriveRigPartAnnotations(doc, "mouth");
  assert.equal(closed.source.defaultVisible, false); assert.equal(open.source.defaultVisible, true); assert.equal(mouth.source.defaultVisible, false);
  assert.deepEqual(ranges(closed.motions[0]), [[.2, .6, false, false], [1, 1, true, true]]);
  assert.equal(closed.motions[0].intervals.at(-1).terminalHold, true);
  assert.deepEqual(ranges(open.motions[0]), [[0, .2, false, false], [.8, 1, false, false]]);
  assert.deepEqual(ranges(mouth.motions[0]), [[.4, 1, true, false]]);
  assert.deepEqual(closed.motions[1].intervals, [], "a previous action's closed eyes never leak into the next one");
  assert.deepEqual(ranges(open.motions[1]), [[0, 1, true, false]]);
  assert.deepEqual(ranges(open.motions[2]), [[.5, 1, true, false]], "time-zero authored null overrides setup visibility");
  const fallback = structuredClone(doc); delete fallback.defaultAttachments.eyes;
  assert.equal(deriveRigPartAnnotations(fallback, "eyeOpen").source.defaultVisible, true, "an omitted default selects the first group member");
  assert.deepEqual(ranges(deriveRigPartAnnotations(doc, "body").motions[0]), [[0, 1, true, false]], "ordinary body parts span unrelated expression changes");
  assert.deepEqual(doc, before, "deriving rules must not modify the rig or any motion");
});

test("draw order changes split visible ranges while continuous world positions are real affine mesh and region bounds", async () => {
  const doc = character(), body = deriveRigPartAnnotations(doc, "body"), draw = body.motions.find((motion) => motion.motionId === "draw");
  assert.deepEqual(draw.intervals.map(({ start, end, layer }) => [start, end, layer.index]), [[0, .3, 0], [.3, 1, 4]]);
  assert.deepEqual(draw.layerChanges.map(({ time, index }) => [time, index]), [[0, 0], [.3, 4]]);
  assert.equal(draw.positionMode, "continuous"); assert.ok(draw.intervals[0].endPosition.time < .3); assert.equal(draw.intervals[0].endPosition.boundary, "before-switch");
  const { data } = parseSkeleton(parseBundle(await buildRigFiles(doc, pixelEnv))), skeleton = new Skeleton(data), state = new AnimationState(new AnimationStateData(data));
  const track = state.setAnimation(0, "trs", false); let checked = 0;
  for (const id of ["body", "cloth", "hand"]) {
    const annotation = deriveRigPartAnnotations(doc, id), motion = annotation.motions.find((item) => item.motionId === "trs");
    for (const interval of motion.intervals) for (const endpoint of [interval.startPosition, interval.endPosition]) {
      skeleton.setupPose(); track.trackTime = endpoint.time; state.apply(skeleton); skeleton.updateWorldTransform(Physics.none);
      const vertices = attachmentVertices(skeleton, skeleton.findSlot(rigPartSlotName(doc.parts.find((part) => part.id === id)))).vertices, xs = [], ys = [];
      for (let i = 0; i < vertices.length; i += 2) { xs.push(vertices[i]); ys.push(doc.height - vertices[i + 1]); }
      near(endpoint.bounds.x, Math.min(...xs)); near(endpoint.bounds.y, Math.min(...ys)); near(endpoint.bounds.width, Math.max(...xs) - Math.min(...xs)); near(endpoint.bounds.height, Math.max(...ys) - Math.min(...ys)); checked++;
    }
    assert.notDeepEqual(motion.intervals[0].startPosition.bounds, motion.intervals.at(-1).endPosition.bounds);
    assert.equal(annotation.boundsMeaning, "mesh-or-region-including-transparent-padding");
  }
  assert.ok(checked >= 8);
  const expression = deriveRigPartAnnotations(doc, "eyeClosed").motions[0], ended = expression.intervals[0].endPosition.time;
  const expressionTrack = state.setAnimation(0, "first", false); skeleton.setupPose(); expressionTrack.trackTime = ended; state.apply(skeleton); skeleton.updateWorldTransform(Physics.none);
  assert.equal(skeleton.findSlot("group_eyes").appliedPose.attachment.name, "eyeClosed", "end seek remains visible before the actual Float32 attachment event");
});

function solid(color, width, height) { const canvas = createCanvas(width, height), context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(0, 0, width, height); return canvas.toDataURL("image/png"); }
async function steppedCharacter() {
  const rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  const specs = [{ id: "body", bone: "root", box: [12, 20, 16, 20], color: "#3366bb" }, { id: "head", bone: "head", box: [14, 8, 14, 12], color: "#dd8899" }, { id: "hand", bone: "hand", box: [28, 20, 10, 6], color: "#e5bb88" }];
  const image = (pose) => { const canvas = createCanvas(64, 64), context = canvas.getContext("2d"); specs.forEach((part) => { if (pose && part.id === "hand") return; context.fillStyle = part.color; const [x, y, w, h] = part.box; context.fillRect(x + (pose ? 8 : 0), y + (pose ? 2 : 0), w, h); }); return canvas.toDataURL("image/png"); };
  const doc = validateRigDocument({ version: 1, id: "annotation-study", name: "Study annotation fixture", width: 64, height: 64, sourceImage: image(false),
    joints: [{ id: "root", parent: null, x: 20, y: 36 }, { id: "head", parent: "root", x: 20, y: 12 }, { id: "hand", parent: "root", x: 30, y: 23 }],
    parts: specs.map((part, index) => ({ id: part.id, bone: part.bone, x: part.box[0], y: part.box[1], width: part.box[2], height: part.box[3], z: index,
      binding: "rigid", influences: [part.bone], image: solid(part.color, part.box[2], part.box[3]), imageSource: "uploaded", completion: "ready" })),
    motions: [{ id: "idle", duration: 1, loop: true, poses: [{ time: 0 }, { time: 1 }] }, { id: "attack", duration: 1, poses: [{ time: 0 }, { time: 1, angles: { root: 12 } }] }] });
  const hash = (url) => createHash("sha256").update(Buffer.from(url.split(",")[1], "base64")).digest("hex");
  const frames = [{ id: "base", time: 0, image: doc.sourceImage }, { id: "pose", time: .4, image: image(true) }, { id: "end", time: 1, imageRef: "pose" }];
  frames.forEach((frame, index) => { const pose = index > 0; frame.sourceFingerprint = hash(pose ? frames[1].image : frames[0].image); frame.review = { approved: true }; frame.mappingReview = { approved: true };
    frame.mapping = { frameId: frame.id, sourceFingerprint: frame.sourceFingerprint, joints: doc.joints.map(({ id, x, y }) => ({ id, x: x + (pose ? 8 : 0), y: y + (pose ? 2 : 0) })),
      parts: specs.map((part, i) => ({ partId: part.id, visible: !(pose && part.id === "hand"), z: i, ...(pose && part.id === "hand" ? {} : { sourcePolygon: rect(part.box[0] + (pose ? 8 : 0), part.box[1] + (pose ? 2 : 0), part.box[2], part.box[3]) }) })) }; });
  doc.motionStudies = { attack: { motionId: "attack", ...await getMotionStudyFingerprints(doc), frames } };
  return (await applyMotionStudy((await prepareMotionStudyFrames(doc, "attack", undefined, { pixels: pixelEnv })).document, "attack", { pixels: pixelEnv })).document;
}

test("applied stepped annotations describe replacement regions and hidden parts while reference mode keeps ordinary continuous playback", async () => {
  const doc = await steppedCharacter(), before = structuredClone(doc), hand = deriveRigPartAnnotations(doc, "hand").motions.find((motion) => motion.motionId === "attack");
  assert.equal(hand.baseReplaced, true); assert.equal(hand.constraintsEvaluated, false); assert.equal(hand.positionMode, "stepped");
  assert.equal(hand.intervals.length, 1); assert.equal(hand.intervals[0].start, 0); assert.equal(hand.intervals[0].frameId, "base");
  assert.equal(hand.intervals[0].representation, "pose-segment"); assert.equal(hand.intervals[0].originalPartVisible, false); assert.equal(hand.terminalVisible, false);
  near(hand.intervals[0].startPosition.bounds.x, 28); near(hand.intervals[0].startPosition.bounds.width, 10);
  const reference = structuredClone(doc); reference.motionStudies.attack.playback = "reference";
  const regular = deriveRigPartAnnotations(reference, "hand").motions.find((motion) => motion.motionId === "attack");
  assert.equal(regular.baseReplaced, false); assert.equal(regular.positionMode, "continuous"); assert.equal(regular.intervals[0].representation, "base-part"); assert.equal(regular.terminalVisible, true);
  assert.deepEqual(doc, before); reference.motionStudies.attack.frames[0].mappingReview.approved = false;
  assert.equal(deriveRigPartAnnotations(reference, "hand").motions.find((motion) => motion.motionId === "attack").error, undefined, "unapplied reference mapping never replaces playback");
});

test("unreachable and unsupported constraints are surfaced without presenting an entire failed panel as successful", () => {
  const unreachable = createHumanoidDraft({ width: 200, height: 300 }); unreachable.motions[0].poses[1].root.y = -180;
  const result = deriveRigPartAnnotations(unreachable, "head"); assert.ok(result.issues.some((issue) => issue.message.includes("脚滑")));
  const unsupported = createHumanoidDraft({ width: 200, height: 300 }); unsupported.motions[0].poses[1].scales = { root: { x: .9, y: 1.1 } };
  const bad = deriveRigPartAnnotations(unsupported, "head").motions[0]; assert.match(bad.error, /非均匀缩放/); assert.deepEqual(bad.intervals, []);
  assert.throws(() => deriveRigPartAnnotations(character(), "missing"), /找不到/); assert.throws(() => deriveRigPartAnnotations(character(), "head", { samples: 1 }), /采样数/);
});

const componentSource = await readFile(new URL("../src/features/rig/PartAppearancePanel.jsx", import.meta.url), "utf8");
const { code } = await transformWithEsbuild(componentSource.replace(/^import[^\n]+\n/gm, "").replace("export function PartAppearancePanel", "function PartAppearancePanel"), "PartAppearancePanel.jsx", { loader: "jsx", jsx: "transform", jsxFactory: "jsx", jsxFragment: "Fragment" });
const jsx = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const Component = new Function("useMemo", "rigPartAppearanceView", "jsx", "Fragment", `${code}; return PartAppearancePanel;`)((callback) => callback(), rigPartAppearanceView, jsx, "fragment");
const descend = (node) => node && typeof node === "object" ? [node, ...(node.children || []).flatMap(descend)] : [];
const text = (node) => typeof node === "string" || typeof node === "number" ? String(node) : node && typeof node === "object" ? (node.children || []).map(text).join("") : "";

test("the accessible panel selects a component and seeks its real appearance interval without data writes", () => {
  const document = character(), before = structuredClone(document), selected = [], sought = [], tree = Component({ document, partId: "eyeClosed", onSelectPart: (id) => selected.push(id), onSeek: (...args) => sought.push(args) });
  const selector = descend(tree).find((node) => node.props["aria-label"] === "部件出现规则选择器"); assert.ok(selector); selector.props.onChange({ target: { value: "hand" } }); assert.deepEqual(selected, ["hand"]);
  const start = descend(tree).find((node) => node.type === "button" && node.props["aria-label"] === "定位 First eyeClosed 0.2s"); assert.ok(start); start.props.onClick(); assert.deepEqual(sought[0], ["first", .2]);
  const end = descend(tree).find((node) => node.type === "button" && node.props["aria-label"] === "定位 First eyeClosed 0.6s切换前"); end.props.onClick(); assert.ok(sought[1][1] < .6); assert.ok(sampleRigPose(document, "first", sought[1][1]).visiblePartIds.includes("eyeClosed"));
  assert.match(text(tree), /区间内位置随动作变化/); assert.match(text(tree), /起保持/); assert.deepEqual(document, before);
  const rows = descend(tree).filter((node) => node.props.className === "part-appearance-row");
  assert.ok(rows.some((node) => /Second.*隐藏/.test(text(node))), "default-hidden parts have explicit hidden rows rather than missing data");
  assert.ok(rows.some((node) => /First.*0\.2s–0\.6s.*第2列.*第1行/.test(text(node))));
  assert.ok(descend(tree).find((node) => node.type === "details" && !node.props.open));
  assert.equal(text(start), "在网格中定位");
  const disabled = Component({ document, partId: "eyeClosed", onSeek() {}, disabled: true }); assert.ok(descend(disabled).filter((node) => node.type === "button").every((node) => node.props.disabled));
  const missing = Component({ document, partId: "unknown" }); assert.ok(descend(missing).some((node) => node.props.role === "alert"));
  const invalid = createHumanoidDraft({ width: 200, height: 300 }); invalid.motions[0].poses[1].scales = { root: { x: .9, y: 1.1 } };
  const warning = Component({ document: invalid, partId: "head" }); assert.match(text(warning), /非均匀缩放/); assert.match(text(warning), /攻击/);
  assert.ok(descend(warning).some((node) => node.props.role === "alert"));
  const outside = character(); outside.motions[0].poses[0].translations = { head: { x: -100, y: -32 } };
  const outsideTree = Component({ document: outside, partId: "eyeOpen" }); assert.match(text(outsideTree), /第-1列.*第0行.*画布外/);
});

import { validateRigDocument, validateRigMotion, replaceRigMotion } from "../../shared/rig-schema.mjs";
export { validateRigDocument, validateRigMotion, replaceRigMotion };
import { motionStudyAssets, assertAppliedMotionStudy, motionStudyFramePose, motionStudyRegionName, motionStudySlotName,
  motionStudyKeyTime, sampleMotionStudyPose, inspectMotionStudy, isMotionStudyPlaybackActive } from "./rig-motion-studies.js";
import { rigGeometry } from "./rig-client.js";
import { packRigAtlasRegions } from "./rig-atlas.js";

const radians = (degrees) => degrees * Math.PI / 180;
const degrees = (value) => value * 180 / Math.PI;
const turn = (angle) => ((angle + 180) % 360 + 360) % 360 - 180;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const bearing = (a, b) => degrees(Math.atan2(b.y - a.y, b.x - a.x));
const rotate = (x, y, angle) => ({ x: x * Math.cos(radians(angle)) - y * Math.sin(radians(angle)), y: x * Math.sin(radians(angle)) + y * Math.cos(radians(angle)) });
const round = (value) => Math.round(value * 1e7) / 1e7;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function createHumanoidDraft({ id = `rig-${crypto.randomUUID()}`, name = "人形骨架初稿", width = 768, height = 1024, sourceImage } = {}) {
  const joint = (id, label, parent, x, y) => ({ id, label, parent, x: x * width, y: y * height });
  const joints = [joint("root", "骨盆", null, .5, .61), joint("torso", "胸腔", "root", .5, .49),
    joint("neck", "颈部", "torso", .5, .32), joint("head", "头部", "neck", .5, .20),
    joint("leftUpperArm", "左肩", "torso", .34, .38), joint("leftForearm", "左肘", "leftUpperArm", .25, .53), joint("leftHand", "左手", "leftForearm", .27, .66),
    joint("rightUpperArm", "右肩", "torso", .66, .38), joint("rightForearm", "右肘", "rightUpperArm", .75, .53), joint("rightHand", "右手", "rightForearm", .73, .66),
    joint("leftThigh", "左髋", "root", .43, .61), joint("leftShin", "左膝", "leftThigh", .35, .77), joint("leftFoot", "左脚踝", "leftShin", .40, .92), joint("leftToe", "左脚尖", "leftFoot", .33, .94),
    joint("rightThigh", "右髋", "root", .57, .61), joint("rightShin", "右膝", "rightThigh", .65, .77), joint("rightFoot", "右脚踝", "rightShin", .60, .92), joint("rightToe", "右脚尖", "rightFoot", .67, .94)];
  const part = (id, label, bone, x, y, w, h, z, influences = [bone], binding = "mesh") => ({
    id, label, bone, x: x * width, y: y * height, width: w * width, height: h * height, z,
    binding, influences, completion: "needs-inpaint", imageSource: sourceImage ? "source-crop" : "placeholder", critical: true,
  });
  const parts = [part("leftUpperArm", "左上臂", "leftUpperArm", .17, .33, .23, .25, 0, ["leftUpperArm", "leftForearm"]),
    part("leftForearm", "左前臂", "leftForearm", .15, .49, .22, .19, 1, ["leftForearm", "leftHand"]),
    part("leftHand", "左手", "leftHand", .17, .59, .20, .14, 2, ["leftHand"], "rigid"),
    part("leftThigh", "左大腿", "leftThigh", .28, .57, .23, .25, 3, ["leftThigh", "leftShin"]),
    part("leftShin", "左小腿", "leftShin", .28, .74, .22, .20, 4, ["leftShin", "leftFoot"]),
    part("leftFoot", "左脚", "leftFoot", .25, .87, .26, .12, 5, ["leftFoot"], "rigid"),
    part("rightThigh", "右大腿", "rightThigh", .49, .57, .23, .25, 6, ["rightThigh", "rightShin"]),
    part("rightShin", "右小腿", "rightShin", .50, .74, .22, .20, 7, ["rightShin", "rightFoot"]),
    part("rightFoot", "右脚", "rightFoot", .49, .87, .26, .12, 8, ["rightFoot"], "rigid"),
    part("torso", "躯干", "torso", .29, .32, .42, .34, 9, ["root", "torso", "neck"]),
    part("rightUpperArm", "右上臂", "rightUpperArm", .60, .33, .23, .25, 10, ["rightUpperArm", "rightForearm"]),
    part("rightForearm", "右前臂", "rightForearm", .63, .49, .22, .19, 11, ["rightForearm", "rightHand"]),
    part("rightHand", "右手", "rightHand", .63, .59, .20, .14, 12, ["rightHand"], "rigid"),
    part("head", "头部", "head", .20, .02, .60, .34, 13, ["head"], "rigid")];
  const pose = (time, angles = {}, root = { x: 0, y: 0 }) => ({ time, angles, root, ease: "smooth", feet: { left: true, right: true } });
  const motions = [
    { id: "idle", name: "待机", duration: 2, loop: true, origin: "procedural-draft", description: "程序初稿：轻微呼吸，两脚锁定。",
      poses: [pose(0), pose(.5, { torso: -1, leftUpperArm: 1, rightUpperArm: -1 }, { x: 0, y: -.003 * height }), pose(1), pose(1.5, { torso: 1, leftUpperArm: -1, rightUpperArm: 1 }, { x: 0, y: .003 * height }), pose(2)] },
    { id: "attack", name: "攻击", duration: 1.1, loop: false, origin: "procedural-draft", description: "程序初稿：蓄力、挥击、收势，需要按角色武器检查。",
      poses: [pose(0), pose(.28, { torso: -8, rightUpperArm: -65, rightForearm: -35, leftUpperArm: 20 }, { x: -.01 * width, y: .006 * height }),
        pose(.52, { torso: 12, rightUpperArm: 20, rightForearm: -55, leftUpperArm: -10 }, { x: .018 * width, y: .012 * height }), pose(.77, { torso: 4, rightUpperArm: 8, rightForearm: -15 }), pose(1.1)] },
    { id: "hit", name: "受击", duration: .6, loop: false, origin: "procedural-draft", description: "程序初稿：上身后仰后恢复，两脚锁定。",
      poses: [pose(0), pose(.16, { torso: -10, head: 6, leftUpperArm: -10, rightUpperArm: 12 }, { x: -.012 * width, y: .006 * height }), pose(.34, { torso: -3, head: 2 }), pose(.6)] },
  ];
  return validateRigDocument({ version: 1, id, name, width, height, ...(sourceImage ? { sourceImage } : {}), origin: "procedural-draft", joints, parts, motions });
}

const geometrySamplingCache = new WeakMap();
function geometry(document, cache = false) {
  const signature = cache ? JSON.stringify({ geometry: rigGeometry(document), motions: document.motions }) : null;
  const cached = cache && geometrySamplingCache.get(document);
  if (cached?.signature === signature) return cached.result;
  const doc = validateRigDocument(document), byId = new Map(doc.joints.map((joint) => [joint.id, joint]));
  const children = new Map(doc.joints.map((joint) => [joint.id, []]));
  for (const joint of doc.joints) if (joint.parent) children.get(joint.parent).push(joint);
  const ordered = [], setupAngles = {};
  const visit = (joint) => {
    ordered.push(joint);
    const child = children.get(joint.id)[0];
    setupAngles[joint.id] = !joint.parent ? 0 : child ? bearing(joint, child) : setupAngles[joint.parent];
    for (const child of children.get(joint.id)) visit(child);
  };
  const root = doc.joints.find((joint) => joint.parent === null); visit(root);
  const result = { doc, byId, children, ordered, root, setupAngles };
  result.meshes = Object.fromEntries(doc.parts.map((part) => [part.id, meshForPart(result, part)]));
  if (cache) geometrySamplingCache.set(document, { signature, result });
  return result;
}

function segmentDistance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / Math.max(dx * dx + dy * dy, 1e-9), 0, 1);
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

function meshForPart(g, part) {
  const cols = part.binding === "mesh" ? part.mesh?.cols ?? 3 : 2, rows = part.binding === "mesh" ? part.mesh?.rows ?? 3 : 2;
  const order = [];
  for (let x = 0; x < cols; x++) order.push(x);
  for (let y = 1; y < rows; y++) order.push(y * cols + cols - 1);
  for (let x = cols - 2; x >= 0; x--) order.push((rows - 1) * cols + x);
  for (let y = rows - 2; y > 0; y--) order.push(y * cols);
  const hull = order.length;
  for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) order.push(y * cols + x);
  const indices = new Map(order.map((value, index) => [value, index])), vertices = [], uvs = [], triangles = [];
  for (const cell of order) {
    const u = (cell % cols) / (cols - 1), v = Math.floor(cell / cols) / (rows - 1);
    vertices.push(part.x + part.width * u, part.y + part.height * v); uvs.push(u, v);
  }
  for (let y = 0; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
    const a = y * cols + x, b = a + 1, c = a + cols, d = c + 1;
    triangles.push(indices.get(a), indices.get(c), indices.get(b), indices.get(b), indices.get(c), indices.get(d));
  }
  const weights = order.map((_, index) => {
    if (part.binding === "rigid") return [{ joint: part.bone, weight: 1 }];
    if (part.mesh?.weights) return part.mesh.weights[index].map((item) => ({ ...item }));
    const point = { x: vertices[index * 2], y: vertices[index * 2 + 1] };
    const values = part.influences.map((id) => {
      const a = g.byId.get(id), b = g.children.get(id)[0] || a;
      return { joint: id, weight: 1 / Math.max(1, segmentDistance(point, a, b)) ** 2 };
    });
    const sum = values.reduce((total, item) => total + item.weight, 0);
    return values.map((item) => ({ ...item, weight: item.weight / sum }));
  });
  return { vertices, uvs, triangles, weights, cols, rows, hull };
}

export function getRigPartMesh(document, partId) {
  const g = geometry(document), result = g.meshes[partId];
  if (!result) throw new Error(`部件不存在：${partId}`);
  return result;
}

export function setRigPartWeights(document, partId, vertexIndex, weights) {
  const g = geometry(document), part = g.doc.parts.find((part) => part.id === partId), mesh = g.meshes[partId];
  if (part?.binding !== "mesh" || !Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= mesh.weights.length) throw new Error("请选择网格部件的有效顶点。");
  part.mesh = { cols: mesh.cols, rows: mesh.rows, weights: mesh.weights };
  part.mesh.weights[vertexIndex] = structuredClone(weights);
  return validateRigDocument(g.doc);
}

export function bindRigWeapon(document, partId, options = {}) {
  const doc = validateRigDocument(document), part = doc.parts.find((part) => part.id === partId);
  const hand = options.primaryHand || options.hand || "rightHand", grip = options.primaryLocalPoint || options.grip;
  const joint = doc.joints.find((joint) => joint.id === hand);
  if (!part || !joint || !grip) throw new Error("请选择武器部件、主手和图片内握点。");
  part.bone = hand; part.binding = "rigid"; part.influences = [hand]; delete part.mesh;
  part.x = joint.x - grip.x; part.y = joint.y - grip.y;
  part.grip = { primaryHand: hand, primaryLocalPoint: { ...grip } };
  if (options.secondaryHand) {
    part.grip.secondaryHand = options.secondaryHand;
    part.grip.secondaryLocalPoint = structuredClone(options.secondaryLocalPoint || options.secondaryGrip);
  }
  return validateRigDocument(doc);
}

function motionTime(motion, time) {
  let t = time;
  if (motion.loop && t > motion.duration) t %= motion.duration;
  return clamp(t, 0, motion.duration);
}

function attachmentTimelineTime(time) {
  // Spine stores timeline times as Float32. Round discrete events downward so
  // e.g. an authored final key at 1.1s is already active at that exact endpoint,
  // rather than delayed until the nearest Float32 value above it.
  const value = Float32Array.of(time);
  if (value[0] > time) new Uint32Array(value.buffer)[0]--;
  return value[0];
}

export const rigPartSlotName = (part) => part.attachmentGroup ? `group_${part.attachmentGroup}` : `slot_${part.id}`;

function attachmentState(doc, motion, time = 0) {
  const defaults = new Map();
  for (const part of doc.parts) if (part.attachmentGroup && !defaults.has(part.attachmentGroup)) defaults.set(part.attachmentGroup, part.id);
  const attachmentSelection = { ...Object.fromEntries(defaults), ...doc.defaultAttachments };
  if (motion) for (const pose of motion.poses) {
    if (pose.time > time) break;
    Object.assign(attachmentSelection, pose.attachments);
  }
  const visiblePartIds = doc.parts.filter((part) => !part.attachmentGroup || attachmentSelection[part.attachmentGroup] === part.id).map((part) => part.id);
  return { attachmentSelection, visiblePartIds };
}

// Without a motion ID, resolve the setup expression of a structure-only draft.
export function resolveRigAttachments(document, motionId, time = 0) {
  if (!Number.isFinite(time)) throw new Error("采样时间无效。");
  if (isMotionStudyPlaybackActive(document.motionStudies?.[motionId])) {
    const pose = sampleMotionStudyPose(document, motionId, time);
    return { kind: pose.kind, attachmentSelection: pose.attachmentSelection, visiblePartIds: pose.visiblePartIds };
  }
  const doc = validateRigDocument(document), motion = motionId == null ? null : doc.motions.find((item) => item.id === motionId);
  if (motionId != null && !motion) throw new Error(`动作不存在：${motionId}`);
  return attachmentState(doc, motion, motion ? motionTime(motion, time) : 0);
}

function rawPose(g, motion, time) {
  const t = motionTime(motion, time);
  let a = motion.poses[0], b = a;
  for (const pose of motion.poses) {
    if (pose.time <= t) a = pose;
    if (pose.time >= t) { b = pose; break; }
    b = pose;
  }
  const span = b.time - a.time;
  let mix = span > 0 ? clamp((t - a.time) / span, 0, 1) : 0;
  if (a.ease === "smooth") mix = mix * mix * (3 - 2 * mix);
  const angles = Object.fromEntries(g.ordered.map((joint) => [joint.id, (a.angles[joint.id] || 0) * (1 - mix) + (b.angles[joint.id] || 0) * mix]));
  const root = { x: a.root.x * (1 - mix) + b.root.x * mix, y: a.root.y * (1 - mix) + b.root.y * mix };
  const interpolate = (field, fallback) => Object.fromEntries(g.ordered.filter((joint) => field !== "translations" || joint.parent).map((joint) => [joint.id,
    Object.fromEntries(["x", "y"].map((axis) => [axis, (a[field]?.[joint.id]?.[axis] ?? fallback) * (1 - mix) + (b[field]?.[joint.id]?.[axis] ?? fallback) * mix]))]));
  return { angles, root, translations: interpolate("translations", 0), scales: interpolate("scales", 1), time: t };
}

function forward(g, angles, root, translations = {}, scales = {}) {
  const result = {};
  for (const joint of g.ordered) {
    const parent = joint.parent && result[joint.parent], setupParent = joint.parent && g.byId.get(joint.parent);
    const scale = scales[joint.id] || { x: 1, y: 1 }, rotation = g.setupAngles[joint.id] - (parent ? g.setupAngles[joint.parent] : 0) + (angles[joint.id] || 0);
    const cos = Math.cos(radians(rotation)), sin = Math.sin(radians(rotation));
    const local = { a: cos * scale.x, b: sin * scale.x, c: -sin * scale.y, d: cos * scale.y };
    if (!parent) result[joint.id] = { x: joint.x + root.x, y: joint.y + root.y, angle: rotation, ...local };
    else {
      const offset = rotate(joint.x - setupParent.x, joint.y - setupParent.y, -g.setupAngles[joint.parent]);
      offset.x += translations[joint.id]?.x || 0; offset.y += translations[joint.id]?.y || 0;
      const value = { x: parent.x + parent.a * offset.x + parent.c * offset.y, y: parent.y + parent.b * offset.x + parent.d * offset.y,
        a: parent.a * local.a + parent.c * local.b, b: parent.b * local.a + parent.d * local.b,
        c: parent.a * local.c + parent.c * local.d, d: parent.b * local.c + parent.d * local.d };
      value.angle = degrees(Math.atan2(value.b, value.a)); result[joint.id] = value;
    }
  }
  return result;
}

function solveChain(g, angles, root, endId, target, endAngle, translations = {}, scales = {}) {
  const end = g.byId.get(endId), lower = end && g.byId.get(end.parent), upper = lower && g.byId.get(lower.parent);
  if (!upper) return forward(g, angles, root, translations, scales);
  // The analytic two-bone solver assumes similarity transforms along this chain.
  // Nonuniform ancestors introduce shear: reject explicitly instead of reporting
  // a false foot/grip pass from setup lengths while the exported mesh moves away.
  for (let joint = end; joint; joint = joint.parent && g.byId.get(joint.parent)) {
    const scale = scales[joint.id];
    if (scale && Math.abs(scale.x - scale.y) > 1e-9) throw new Error(`约束 ${endId} 暂不支持骨骼 ${joint.id} 的非均匀缩放；请使用等比缩放或解除本段脚锁/副手握持。`);
  }
  const current = forward(g, angles, root, translations, scales), base = current[upper.id], length1 = distance(base, current[lower.id]), length2 = distance(current[lower.id], current[end.id]);
  if (length1 < 1e-6 || length2 < 1e-6) throw new Error(`约束 ${endId} 的有效骨长为零，请修正局部平移或缩放。`);
  const dx = target.x - base.x, dy = target.y - base.y;
  const reach = clamp(Math.hypot(dx, dy), Math.abs(length1 - length2) + 1e-7, length1 + length2 - 1e-7);
  const cross = (lower.x - upper.x) * (end.y - lower.y) - (lower.y - upper.y) * (end.x - lower.x);
  const bend = Math.sign(cross) || (endId.startsWith("left") ? -1 : 1);
  const elbow = bend * Math.acos(clamp((reach * reach - length1 * length1 - length2 * length2) / (2 * length1 * length2), -1, 1));
  const direction = Math.atan2(dy, dx) - Math.atan2(length2 * Math.sin(elbow), length1 + length2 * Math.cos(elbow));
  const upperWorld = current[upper.id].angle + degrees(direction) - bearing(base, current[lower.id]);
  const lowerWorld = current[lower.id].angle + degrees(direction + elbow) - bearing(current[lower.id], current[end.id]);
  const parentAngle = upper.parent ? current[upper.parent].angle : 0, parentSetup = upper.parent ? g.setupAngles[upper.parent] : 0;
  angles[upper.id] = turn(upperWorld - parentAngle - g.setupAngles[upper.id] + parentSetup);
  angles[lower.id] = turn(lowerWorld - upperWorld - g.setupAngles[lower.id] + g.setupAngles[upper.id]);
  if (endAngle !== undefined) angles[end.id] = turn(endAngle - lowerWorld - g.setupAngles[end.id] + g.setupAngles[lower.id]);
  return forward(g, angles, root, translations, scales);
}

function transformedPoint(g, joints, bone, x, y) {
  const setup = g.byId.get(bone), pose = joints[bone], local = rotate(x - setup.x, y - setup.y, -g.setupAngles[bone]);
  return { x: pose.x + pose.a * local.x + pose.c * local.y, y: pose.y + pose.b * local.x + pose.d * local.y };
}

function motionDrawOrder(g, motion, time) {
  let order = [...new Set([...g.doc.parts].sort((a, b) => a.z - b.z).map(rigPartSlotName))];
  for (const pose of motion.poses) { if (pose.time > time) break; if (pose.drawOrder) order = pose.drawOrder; }
  return [...order];
}

function sampled(g, motion, time, includeParts = true) {
  const raw = rawPose(g, motion, time), { angles, root, translations, scales } = raw;
  const attachments = attachmentState(g.doc, motion, raw.time), visibleParts = new Set(attachments.visiblePartIds);
  let joints = forward(g, angles, root, translations, scales);
  const feet = { left: false, right: false }, starts = {}, footTargets = {};
  for (const pose of motion.poses) {
    if (pose.time > raw.time) break;
    for (const side of ["left", "right"]) if (pose.feet?.[side] !== undefined) {
      if (pose.feet[side] && !feet[side]) starts[side] = pose.time;
      feet[side] = pose.feet[side];
    }
  }
  for (const side of ["left", "right"]) if (feet[side]) {
    const anchor = rawPose(g, motion, starts[side]), target = forward(g, anchor.angles, anchor.root, anchor.translations, anchor.scales)[`${side}Foot`];
    footTargets[side] = target;
    joints = solveChain(g, angles, root, `${side}Foot`, target, target.angle, translations, scales);
  }
  for (const part of g.doc.parts) if (part.grip?.secondaryHand && visibleParts.has(part.id)) {
    const target = transformedPoint(g, joints, part.bone, part.x + part.grip.secondaryLocalPoint.x, part.y + part.grip.secondaryLocalPoint.y);
    joints = solveChain(g, angles, root, part.grip.secondaryHand, target, undefined, translations, scales);
  }
  const weaponGrips = g.doc.parts.filter((part) => part.grip && visibleParts.has(part.id)).map((part) => {
    const primary = transformedPoint(g, joints, part.bone, part.x + part.grip.primaryLocalPoint.x, part.y + part.grip.primaryLocalPoint.y);
    const primaryError = distance(primary, joints[part.grip.primaryHand]);
    const secondary = part.grip.secondaryHand && transformedPoint(g, joints, part.bone, part.x + part.grip.secondaryLocalPoint.x, part.y + part.grip.secondaryLocalPoint.y);
    const secondaryError = secondary ? distance(secondary, joints[part.grip.secondaryHand]) : 0;
    return { partId: part.id, hand: part.grip.primaryHand, primaryError, secondaryError, maxError: Math.max(primaryError, secondaryError), mode: secondary ? "dual-hand-ik" : "single-hand-rigid" };
  });
  const parts = {};
  if (includeParts) for (const part of g.doc.parts) {
    const mesh = g.meshes[part.id], vertices = [];
    for (let i = 0; i < mesh.weights.length; i++) {
      let x = 0, y = 0, total = 0;
      for (const weight of mesh.weights[i]) {
        const value = transformedPoint(g, joints, weight.joint, mesh.vertices[i * 2], mesh.vertices[i * 2 + 1]);
        x += value.x * weight.weight; y += value.y * weight.weight; total += weight.weight;
      }
      vertices.push(x / total, y / total);
    }
    parts[part.id] = { vertices, triangles: mesh.triangles };
  }
  return { time: raw.time, joints, angles, root, translations, scales, drawOrder: motionDrawOrder(g, motion, raw.time), feet, footTargets, parts, weaponGrips, ...attachments };
}

export function sampleRigPose(document, motionId, time) {
  if (!Number.isFinite(time)) throw new Error("采样时间无效。");
  if (isMotionStudyPlaybackActive(document.motionStudies?.[motionId])) return sampleMotionStudyPose(document, motionId, time);
  const g = geometry(document, true), motion = g.doc.motions.find((motion) => motion.id === motionId);
  if (!motion) throw new Error(`动作不存在：${motionId}`);
  return sampled(g, motion, time);
}

export function inspectRigMotion(document, motionId, { samples = 61, tolerance = .5 } = {}) {
  if (!Number.isInteger(samples) || samples < 2 || samples > 601) throw new Error("验收采样数必须在 2 至 601 之间。");
  if (isMotionStudyPlaybackActive(document.motionStudies?.[motionId])) return inspectMotionStudy(validateRigDocument(document), motionId, { samples });
  const g = geometry(document), motion = g.doc.motions.find((motion) => motion.id === motionId);
  if (!motion) throw new Error(`动作不存在：${motionId}`);
  const issues = [], maxFootSlide = { left: 0, right: 0 }, footContactSamples = { left: 0, right: 0 }, gripReports = new Map();
  let finite = true, maxVertexDistance = 0;
  const first = sampled(g, motion, 0), last = sampled(g, motion, motion.duration);
  for (let i = 0; i < samples; i++) {
    const pose = sampled(g, motion, motion.duration * i / (samples - 1));
    for (const joint of Object.values(pose.joints)) finite &&= [joint.x, joint.y, joint.angle].every(Number.isFinite);
    for (const [id, part] of Object.entries(pose.parts)) for (let j = 0; j < part.vertices.length; j += 2) {
      const point = { x: part.vertices[j], y: part.vertices[j + 1] };
      finite &&= Number.isFinite(point.x) && Number.isFinite(point.y);
      maxVertexDistance = Math.max(maxVertexDistance, distance(point, { x: g.meshes[id].vertices[j], y: g.meshes[id].vertices[j + 1] }));
    }
    for (const side of ["left", "right"]) if (pose.feet[side]) {
      footContactSamples[side]++;
      maxFootSlide[side] = Math.max(maxFootSlide[side], distance(pose.joints[`${side}Foot`], pose.footTargets[side]));
    }
    for (const grip of pose.weaponGrips) {
      const previous = gripReports.get(grip.partId);
      if (!previous) gripReports.set(grip.partId, { ...grip });
      else for (const key of ["maxError", "primaryError", "secondaryError"]) previous[key] = Math.max(previous[key], grip[key]);
    }
  }
  const positionError = Math.max(...g.ordered.map((joint) => distance(first.joints[joint.id], last.joints[joint.id])));
  const angleError = Math.max(...g.ordered.map((joint) => Math.abs(turn(first.joints[joint.id].angle - last.joints[joint.id].angle))));
  const matrixError = Math.max(...g.ordered.flatMap((joint) => ["a", "b", "c", "d"].map((axis) => Math.abs(first.joints[joint.id][axis] - last.joints[joint.id][axis]))));
  const drawOrderContinuous = JSON.stringify(first.drawOrder) === JSON.stringify(last.drawOrder);
  const attachmentChanges = Object.keys(first.attachmentSelection).filter((id) => first.attachmentSelection[id] !== last.attachmentSelection[id]);
  if (!finite) issues.push("采样出现非有限关节或顶点。");
  if (maxVertexDistance > Math.hypot(g.doc.width, g.doc.height) * 3) issues.push("网格顶点位移超出合理范围。");
  for (const side of ["left", "right"]) if (maxFootSlide[side] > tolerance) issues.push(`${side} 脚锁目标不可达或存在脚滑：${maxFootSlide[side].toFixed(2)} px`);
  for (const grip of gripReports.values()) if (grip.maxError > tolerance) issues.push(`武器 ${grip.partId} 握点不可达或绑定未对齐：${grip.maxError.toFixed(2)} px`);
  if (motion.loop && (positionError > tolerance || angleError > tolerance)) issues.push("循环动作首尾不连续。");
  if (motion.loop && matrixError > 1e-4) issues.push("循环动作首尾缩放或继承变换不连续。");
  if (motion.loop && !drawOrderContinuous) issues.push("循环动作首尾绘制顺序不连续。");
  if (motion.loop && attachmentChanges.length) issues.push(`循环动作首尾附件不连续：${attachmentChanges.join("、")}`);
  return { motionId, duration: motion.duration, samples, finite, issues, maxVertexDistance, maxFootSlide, footContactSamples,
    loop: { enabled: motion.loop, positionError, angleError, matrixError, drawOrderContinuous, attachmentsContinuous: attachmentChanges.length === 0, attachmentChanges }, weaponGrips: [...gripReports.values()],
    solver: { feet: "two-bone-ik", twoHandGrip: true, sampler: "rig-document-fk", bakeRate: 30 } };
}

export function compileRigSkeleton(document, { sampleRate = 30 } = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate < 5 || sampleRate > 120) throw new Error("动作烘焙帧率必须在 5 至 120 之间。");
  const g = geometry(document), { doc } = g, boneIndices = new Map(g.ordered.map((joint, index) => [joint.id, index]));
  const bones = g.ordered.map((joint) => {
    const parent = joint.parent && g.byId.get(joint.parent), child = g.children.get(joint.id)[0];
    const offset = parent ? rotate(joint.x - parent.x, joint.y - parent.y, -g.setupAngles[parent.id]) : { x: joint.x, y: joint.y - doc.height };
    return { name: joint.id, ...(parent ? { parent: parent.id } : {}), x: round(offset.x), y: round(-offset.y),
      rotation: round(-g.setupAngles[joint.id] + (parent ? g.setupAngles[parent.id] : 0)), length: round(child ? distance(joint, child) : 0) };
  });
  const orderedParts = [...doc.parts].sort((a, b) => a.z - b.z), attachments = {}, slots = [], slotGroups = new Map();
  const setupAttachments = attachmentState(doc).attachmentSelection;
  for (const part of orderedParts) {
    const joint = g.byId.get(part.bone), slot = rigPartSlotName(part);
    let attachment;
    if (part.binding === "rigid") {
      const center = rotate(part.x + part.width / 2 - joint.x, part.y + part.height / 2 - joint.y, -g.setupAngles[joint.id]);
      attachment = { type: "region", path: part.id, x: round(center.x), y: round(-center.y), rotation: round(g.setupAngles[joint.id]), width: part.width, height: part.height };
    } else {
      const mesh = g.meshes[part.id], vertices = [];
      for (let i = 0; i < mesh.weights.length; i++) {
        vertices.push(mesh.weights[i].length);
        const total = mesh.weights[i].reduce((sum, weight) => sum + weight.weight, 0);
        for (const weight of mesh.weights[i]) {
          const bone = g.byId.get(weight.joint), local = rotate(mesh.vertices[i * 2] - bone.x, mesh.vertices[i * 2 + 1] - bone.y, -g.setupAngles[bone.id]);
          vertices.push(boneIndices.get(bone.id), round(local.x), round(-local.y), weight.weight / total);
        }
      }
      attachment = { type: "mesh", path: part.id, uvs: mesh.uvs, triangles: mesh.triangles, vertices, hull: mesh.hull, width: part.width, height: part.height };
    }
    if (!attachments[slot]) {
      attachments[slot] = {};
      const selected = part.attachmentGroup ? setupAttachments[part.attachmentGroup] : part.id;
      slots.push({ name: slot, bone: part.bone, ...(selected === null ? {} : { attachment: selected }) });
      if (part.attachmentGroup) slotGroups.set(part.attachmentGroup, slot);
    }
    attachments[slot][part.id] = attachment;
  }
  const animations = {};
  const translationBones = new Set(doc.motions.flatMap((motion) => motion.poses.flatMap((pose) => Object.keys(pose.translations || {}))));
  const scaleBones = new Set(doc.motions.flatMap((motion) => motion.poses.flatMap((pose) => Object.keys(pose.scales || {}))));
  const hasDrawOrder = doc.motions.some((motion) => motion.poses.some((pose) => pose.drawOrder));
  for (const motion of doc.motions) {
    const steps = Math.ceil(motion.duration * sampleRate);
    // Runtime timelines store Float32 times: merge indistinguishable grid/key
    // times before baking, while retaining exact authored endpoint poses.
    const timeMap = new Map();
    for (const time of [...Array.from({ length: steps + 1 }, (_, i) => motion.duration * i / steps), ...motion.poses.map((pose) => pose.time), motion.duration])
      timeMap.set(Math.fround(time), { time, sampleTime: time });
    const contacts = { left: false, right: false };
    for (const pose of motion.poses) {
      let changes = false;
      for (const side of ["left", "right"]) if (pose.feet?.[side] !== undefined) {
        changes ||= contacts[side] !== pose.feet[side]; contacts[side] = pose.feet[side];
      }
      if (!changes || pose.time === 0) continue;
      // IK contact is discrete. Preserve its left limit and step to the new
      // solution rather than blending an unlocked leg into the locked interval.
      // A transition uses the first Float32 time at or after the authored time:
      // the storage precision may delay it by one ULP, but can never release early.
      const value = Float32Array.of(pose.time), bits = new Uint32Array(value.buffer);
      if (value[0] < pose.time) bits[0]++;
      const transition = value[0]; bits[0]--; const before = value[0];
      timeMap.set(before, { time: before, sampleTime: before, stepped: true });
      timeMap.set(transition, { time: transition, sampleTime: pose.time });
    }
    const baked = [...timeMap.values()].sort((a, b) => a.time - b.time), times = baked.map((frame) => frame.time);
    const poses = baked.map((frame) => sampled(g, motion, frame.sampleTime, false)), timelines = {};
    for (const joint of g.ordered) {
      let previous;
      const frames = poses.map((pose, index) => {
        let value = -pose.angles[joint.id];
        if (previous !== undefined) value = previous + turn(value - previous);
        previous = value;
        return { time: times[index], value: round(value), ...(baked[index].stepped ? { curve: "stepped" } : {}) };
      });
      timelines[joint.id] = { rotate: frames };
      if (translationBones.has(joint.id)) timelines[joint.id].translate = poses.map((pose, index) => ({ time: times[index],
        x: round(pose.translations[joint.id].x), y: round(-pose.translations[joint.id].y), ...(baked[index].stepped ? { curve: "stepped" } : {}) }));
      if (scaleBones.has(joint.id)) timelines[joint.id].scale = poses.map((pose, index) => ({ time: times[index],
        x: round(pose.scales[joint.id].x), y: round(pose.scales[joint.id].y), ...(baked[index].stepped ? { curve: "stepped" } : {}) }));
    }
    timelines[g.root.id].translate = poses.map((pose, index) => ({ time: times[index], x: round(pose.root.x), y: round(-pose.root.y), ...(baked[index].stepped ? { curve: "stepped" } : {}) }));
    const slotTimelines = {};
    for (const [groupId, slot] of slotGroups) {
      const keys = new Map([[Math.fround(0), { time: 0, name: setupAttachments[groupId] }]]);
      for (const pose of motion.poses) if (Object.hasOwn(pose.attachments || {}, groupId)) {
        const time = attachmentTimelineTime(pose.time);
        keys.set(time, { time, name: pose.attachments[groupId] });
      }
      slotTimelines[slot] = { attachment: [...keys.values()].sort((a, b) => a.time - b.time) };
    }
    const drawOrder = [];
    if (hasDrawOrder) for (const pose of motion.poses) if (pose.time === 0 || pose.drawOrder) {
      const desired = motionDrawOrder(g, motion, pose.time), target = new Map(desired.map((slot, index) => [slot, index]));
      drawOrder.push({ time: attachmentTimelineTime(pose.time), offsets: slots.map((slot, index) => ({ slot: slot.name, offset: target.get(slot.name) - index })) });
    }
    // Every animation must reset order at zero, including old motions whose first
    // authored pose starts later, when switching from a crossing/turning action.
    if (hasDrawOrder && drawOrder[0]?.time !== 0) drawOrder.unshift({ time: 0, offsets: [] });
    animations[motion.id] = { bones: timelines, ...(slotGroups.size ? { slots: slotTimelines } : {}), ...(hasDrawOrder ? { drawOrder } : {}) };
  }
  const result = { skeleton: { spine: "4.3.23", x: 0, y: 0, width: doc.width, height: doc.height, images: "images/", fps: sampleRate },
    bones, slots,
    skins: [{ name: "default", attachments }], animations };
  compileMotionStudies(result, g);
  return result;
}

function compileMotionStudies(skeleton, g) {
  const { doc } = g, studies = Object.entries(doc.motionStudies || {}).filter(([, study]) => isMotionStudyPlaybackActive(study));
  if (!studies.length) return;
  const scaledBones = new Set(doc.motions.flatMap((motion) => motion.poses.flatMap((pose) => Object.keys(pose.scales || {}))));
  const originalSlots = [...skeleton.slots], allStudySlots = [];
  for (const [motionId] of studies) {
    const study = assertAppliedMotionStudy(doc, motionId), partIds = [...new Set(study.frames.flatMap((frame) => frame.segments.map((segment) => segment.partId)))];
    for (const partId of partIds) {
      const part = doc.parts.find((item) => item.id === partId), name = motionStudySlotName(motionId, partId);
      skeleton.slots.push({ name, bone: part.bone }); allStudySlots.push(name);
      skeleton.skins[0].attachments[name] = {};
    }
    const timelines = {}, slotTimelines = Object.fromEntries(partIds.map((partId) => [motionStudySlotName(motionId, partId), { attachment: [] }]));
    const drawOrders = [];
    for (const frame of study.frames) {
      const joints = motionStudyFramePose(doc, frame), time = motionStudyKeyTime(frame.time);
      for (const bone of skeleton.bones) {
        const joint = joints[bone.name], parent = bone.parent && joints[bone.parent];
        const position = parent ? rotate(joint.x - parent.x, joint.y - parent.y, -parent.angle) : { x: joint.x, y: joint.y - doc.height };
        const timeline = timelines[bone.name] ||= { rotate: [], translate: [] };
        timeline.rotate.push({ time, value: round(-joint.angle + (parent?.angle || 0) - bone.rotation), curve: "stepped" });
        timeline.translate.push({ time, x: round(position.x - bone.x), y: round(-position.y - bone.y), curve: "stepped" });
      }
      for (const partId of partIds) {
        const segment = frame.segments.find((value) => value.partId === partId), slot = motionStudySlotName(motionId, partId);
        const name = segment ? motionStudyRegionName(motionId, frame.id, partId) : null;
        slotTimelines[slot].attachment.push({ time, name });
        if (!segment) continue;
        const part = doc.parts.find((value) => value.id === partId), joint = joints[part.bone];
        const center = rotate(segment.x + segment.width / 2 - joint.x, segment.y + segment.height / 2 - joint.y, -joint.angle);
        skeleton.skins[0].attachments[slot][name] = { type: "region", path: name, x: round(center.x), y: round(-center.y), rotation: round(joint.angle), width: segment.width, height: segment.height };
      }
      drawOrders.push({ time, active: [...frame.segments].sort((a, b) => a.z - b.z).map((part) => motionStudySlotName(motionId, part.partId)) });
    }
    for (const name of scaledBones) if (timelines[name]) timelines[name].scale = [{ time: 0, x: 1, y: 1 }];
    skeleton.animations[motionId] = { bones: timelines, slots: slotTimelines, studyDrawOrders: drawOrders };
  }
  const names = skeleton.slots.map((slot) => slot.name);
  for (const [motionId, animation] of Object.entries(skeleton.animations)) {
    const isStudy = studies.some(([id]) => id === motionId); animation.slots ||= {};
    for (const slot of originalSlots) {
      if (isStudy) animation.slots[slot.name] = { attachment: [{ time: 0, name: null }] };
      else if (!animation.slots[slot.name]?.attachment) animation.slots[slot.name] = { ...animation.slots[slot.name], attachment: [{ time: 0, name: slot.attachment ?? null }] };
    }
    for (const name of allStudySlots) if (!animation.slots[name]) animation.slots[name] = { attachment: [{ time: 0, name: null }] };
    if (isStudy) {
      animation.drawOrder = animation.studyDrawOrders.map(({ time, active }) => {
        const activeIds = new Set(active), ordered = [...names.filter((name) => !activeIds.has(name)), ...active], target = new Map(ordered.map((name,index) => [name,index]));
        return { time, offsets: names.map((slot,index) => ({ slot, offset: target.get(slot) - index })) };
      });
      delete animation.studyDrawOrders;
    } else {
      animation.drawOrder ||= [{ time: 0, offsets: [] }];
      for (const bone of skeleton.bones) if (!animation.bones?.[bone.name]?.translate)
        (animation.bones[bone.name] ||= {}).translate = [{ time: 0, x: 0, y: 0 }];
    }
  }
}

function dataBytes(dataURL) {
  const text = atob(dataURL.slice(dataURL.indexOf(",") + 1));
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}
const browserPixels = {
  createCanvas: (width, height) => {
    if (!globalThis.document) throw new Error("图片装配需要 Canvas，请在浏览器中操作或提供像素适配器。");
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
  },
  loadImage: (bytes) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes])), image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("立绘或部件图片无法解码。")); };
    image.src = url;
  }),
  encode: (canvas) => new Promise((resolve, reject) => canvas.toBlob(async (blob) => {
    if (blob) resolve(new Uint8Array(await blob.arrayBuffer())); else reject(new Error("部件 PNG 编码失败。"));
  }, "image/png")),
};

export async function buildRigFiles(document, pixels = browserPixels, atlasOptions) {
  const doc = validateRigDocument(document), env = { ...browserPixels, ...pixels };
  const assets = [...doc.parts, ...motionStudyAssets(doc)], artwork = new Map(assets.map((part) => [part.id, part]));
  const layouts = packRigAtlasRegions(assets, atlasOptions), files = {}, pages = {}, atlasPages = [];
  const source = doc.sourceImage ? await env.loadImage(dataBytes(doc.sourceImage)) : null;
  try {
    for (const [index, layout] of layouts.entries()) {
      const file = index === 0 ? "rig.png" : `rig-${index + 1}.png`;
      const canvas = env.createCanvas(layout.width, layout.height), ctx = canvas.getContext("2d");
      try {
        for (const region of layout.regions) {
          const part = artwork.get(region.id), image = part.image ? await env.loadImage(dataBytes(part.image)) : null;
          const crop = env.createCanvas(region.width, region.height), context = crop.getContext("2d");
          try {
            if (image) context.drawImage(image, 0, 0, region.width, region.height);
            else if (source) context.drawImage(source, part.x * source.width / doc.width, part.y * source.height / doc.height,
              part.width * source.width / doc.width, part.height * source.height / doc.height, 0, 0, region.width, region.height);
            else { context.fillStyle = `hsl(${(doc.parts.indexOf(part) * 47) % 360},45%,68%)`; context.fillRect(0, 0, region.width, region.height); }
            ctx.drawImage(crop, region.x, region.y);
            files[`images/${part.id}.png`] = image && part.image.startsWith("data:image/png;") && image.width === region.width && image.height === region.height
              ? dataBytes(part.image) : new Uint8Array(await env.encode(crop));
          } finally { image?.close?.(); crop.width = 1; crop.height = 1; }
        }
        pages[file] = new Uint8Array(await env.encode(canvas));
        atlasPages.push([file, `size:${layout.width},${layout.height}`, "filter:Linear,Linear", "pma:false",
          ...layout.regions.flatMap((part) => [part.id, `bounds:${part.x},${part.y},${part.width},${part.height}`, `offsets:0,0,${part.width},${part.height}`])].join("\n"));
      } finally { canvas.width = 1; canvas.height = 1; }
    }
    const encoder = new TextEncoder();
    files["rig.json"] = encoder.encode(JSON.stringify(compileRigSkeleton(doc)));
    files["rig.atlas"] = encoder.encode(atlasPages.join("\n\n") + "\n"); Object.assign(files, pages);
    return files;
  } finally { source?.close?.(); }
}

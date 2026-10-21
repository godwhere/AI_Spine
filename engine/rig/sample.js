import { attachmentState } from "./attachments.js";
import { bearing } from "./math.js";
import { clamp } from "./math.js";
import { degrees } from "./math.js";
import { distance } from "./math.js";
import { geometry } from "./geometry.js";
import { isMotionStudyPlaybackActive } from "../../shared/domain/motion-study.mjs";
import { motionTime } from "./math.js";
import { radians } from "./math.js";
import { rigPartSlotName } from "./attachments.js";
import { rotate } from "./math.js";
import { sampleMotionStudyPose } from "./motion-study.js";
import { turn } from "./math.js";
import { extendEffectDrawOrder } from "../../shared/domain/rig-effects.mjs";

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
  return extendEffectDrawOrder(g.doc, order);
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

function sampleRigPose(document, motionId, time) {
  if (!Number.isFinite(time)) throw new Error("采样时间无效。");
  if (isMotionStudyPlaybackActive(document.motionStudies?.[motionId])) return sampleMotionStudyPose(document, motionId, time);
  const g = geometry(document, true), motion = g.doc.motions.find((motion) => motion.id === motionId);
  if (!motion) throw new Error(`动作不存在：${motionId}`);
  return sampled(g, motion, time);
}

export { motionDrawOrder, sampleRigPose, sampled };

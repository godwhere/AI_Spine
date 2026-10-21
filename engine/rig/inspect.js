import { distance } from "./math.js";
import { geometry } from "./geometry.js";
import { inspectMotionStudy } from "./motion-study.js";
import { isMotionStudyPlaybackActive } from "../../shared/domain/motion-study.mjs";
import { sampled } from "./sample.js";
import { turn } from "./math.js";
import { validateRigDocument } from "../../shared/rig-schema.mjs";

function inspectRigMotion(document, motionId, { samples = 61, tolerance = .5 } = {}) {
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

export { inspectRigMotion };

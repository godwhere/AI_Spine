import { validateRigDocument } from "../../shared/rig-schema.mjs";
import { sampleRigPose, inspectRigMotion, resolveRigAttachments, rigPartSlotName } from "./rig-authoring.js";
import { isMotionStudyPlaybackActive, motionStudyKeyTime, motionStudySlotName } from "./rig-motion-studies.js";

// Positions describe geometry in the source canvas's world pixel axes. They are
// not alpha bounds, camera/screen coordinates, or a promise of visual correctness.
function geometryPosition(pose, partId, time, boundary) {
  const vertices = pose.parts[partId]?.vertices;
  if (!vertices?.length || vertices.length % 2 || !Array.from(vertices).every(Number.isFinite)) throw new Error("部件的实际网格或图片顶点无效，无法标注位置。");
  const xs = [], ys = [];
  for (let i = 0; i < vertices.length; i += 2) { xs.push(vertices[i]); ys.push(vertices[i + 1]); }
  const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
  return { time, boundary, bounds: { x, y, width, height }, center: { x: x + width / 2, y: y + height / 2 } };
}
function before(time) {
  if (time <= 0) return 0;
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, time);
  view.setBigUint64(0, view.getBigUint64(0) - 1n); return view.getFloat64(0);
}
function beforeEvent(time, stepped) {
  if (stepped) return before(time);
  // Ordinary attachment/draw-order keys round downward to Float32 on export.
  // Seek before that actual key, not merely before its authored decimal time.
  const value = Float32Array.of(time);
  if (value[0] > time) new Uint32Array(value.buffer)[0]--;
  return before(value[0]);
}
function baseState(motion, part, defaults, setupSlots, time) {
  const selection = { ...defaults }; let order = setupSlots;
  for (const pose of motion.poses) {
    if (pose.time > time) break;
    Object.assign(selection, pose.attachments || {}); if (pose.drawOrder) order = pose.drawOrder;
  }
  return { visible: !part.attachmentGroup || selection[part.attachmentGroup] === part.id, representation: "base-part", originalPartVisible: true,
    layer: { slotId: rigPartSlotName(part), index: order.indexOf(rigPartSlotName(part)), total: order.length, scope: "rig-slots", z: part.z } };
}
function studyState(document, motion, part, study, poseAt, time) {
  const pose = poseAt(time), frame = study.frames.find((item) => item.id === pose.frameId), ordered = [...frame.segments].sort((a, b) => a.z - b.z);
  const segment = ordered.find((item) => item.partId === part.id);
  return { visible: Boolean(segment), representation: "pose-segment", originalPartVisible: false, frameId: frame.id, sourceFingerprint: frame.sourceFingerprint,
    layer: { slotId: motionStudySlotName(motion.id, part.id), index: ordered.findIndex((item) => item.partId === part.id), total: ordered.length, scope: "visible-pose-segments", z: segment?.z ?? null } };
}
const stateKey = (state) => JSON.stringify([state.visible, state.representation, state.layer.index, state.layer.total, state.layer.z, state.frameId]);

function annotateMotion(document, motion, part, defaults, setupSlots, samples) {
  const study = document.motionStudies?.[motion.id], stepped = isMotionStudyPlaybackActive(study), duration = stepped ? motionStudyKeyTime(motion.duration) : motion.duration;
  const result = { motionId: motion.id, name: motion.name, duration, authoredDuration: motion.duration, loop: motion.loop, baseReplaced: stepped,
    positionMode: stepped ? "stepped" : "continuous", intervals: [], issues: [], layerChanges: [], terminalVisible: false };
  try {
    const inspection = inspectRigMotion(document, motion.id, { samples });
    result.issues = [...inspection.issues]; result.constraintsEvaluated = inspection.kind !== "motion-study";
    result.sampler = inspection.solver.sampler;
    const poses = new Map(), poseAt = (time) => { if (!poses.has(time)) poses.set(time, sampleRigPose(document, motion.id, time)); return poses.get(time); };
    const stateAt = stepped ? (time) => studyState(document, motion, part, study, poseAt, time) : (time) => baseState(motion, part, defaults, setupSlots, time);
    const events = [...new Set([0, duration, ...(stepped ? study.frames.map((frame) => motionStudyKeyTime(frame.time)) : motion.poses.map((pose) => pose.time))])].sort((a, b) => a - b);
    const spans = [];
    for (let index = 0; index < events.length - 1; index++) {
      const start = events[index], end = events[index + 1], state = stateAt(start);
      if (!state.visible) continue;
      const previous = spans.at(-1);
      if (previous && previous.end === start && stateKey(previous.state) === stateKey(state)) previous.end = end;
      else spans.push({ start, end, state });
    }
    const terminal = stateAt(duration), previous = spans.at(-1);
    result.terminalVisible = terminal.visible; result.terminalHolds = terminal.visible && !motion.loop;
    if (terminal.visible) {
      if (previous && previous.end === duration && stateKey(previous.state) === stateKey(terminal)) previous.endInclusive = true;
      else spans.push({ start: duration, end: duration, endInclusive: true, terminalOnly: true, state: terminal });
    }
    result.intervals = spans.map(({ start, end, state, endInclusive = false, terminalOnly = false }) => {
      const safeEnd = endInclusive ? end : beforeEvent(end, stepped), endTime = Math.max(start, safeEnd), seekUnavailable = !endInclusive && safeEnd < start;
      if (seekUnavailable) result.issues.push("此显示时段短于运行时时间精度，请拉开关键帧后再定位。");
      return { start, end, startInclusive: true, endInclusive, terminalOnly, terminalHold: terminalOnly && !motion.loop,
        seekUnavailable,
        representation: state.representation, originalPartVisible: state.originalPartVisible, layer: state.layer,
        ...(state.frameId ? { frameId: state.frameId, sourceFingerprint: state.sourceFingerprint } : {}),
        startPosition: geometryPosition(poseAt(start), part.id, start, "at-key"),
        endPosition: geometryPosition(poseAt(endTime), part.id, endTime, endInclusive ? "at-key" : "before-switch") };
    });
    let previousLayer;
    for (const interval of result.intervals) {
      if (previousLayer !== interval.layer.index) result.layerChanges.push({ time: interval.start, index: interval.layer.index, total: interval.layer.total, scope: interval.layer.scope });
      previousLayer = interval.layer.index;
    }
  } catch (error) {
    result.error = error.message || "此动作无法计算部件位置。"; result.issues = [result.error]; result.intervals = [];
  }
  return result;
}

export function deriveRigPartAnnotations(input, partId, { samples = 61 } = {}) {
  if (!Number.isInteger(samples) || samples < 2 || samples > 601) throw new Error("标注检查采样数必须在 2 至 601 之间。");
  const document = validateRigDocument(input), part = document.parts.find((item) => item.id === partId);
  if (!part) throw new Error("找不到要标注的部件。");
  const setup = resolveRigAttachments(document), slots = [...new Set([...document.parts].sort((a, b) => a.z - b.z).map(rigPartSlotName))];
  const bone = document.joints.find((joint) => joint.id === part.bone), motions = document.motions.map((motion) => annotateMotion(document, motion, part, setup.attachmentSelection, slots, samples));
  return { partId: part.id, label: typeof part.label === "string" ? part.label : part.id, coordinateSpace: "source-canvas-world-pixels", boundsMeaning: "mesh-or-region-including-transparent-padding",
    source: { canvas: { width: document.width, height: document.height }, rect: { x: part.x, y: part.y, width: part.width, height: part.height },
      bone: { id: bone.id, label: typeof bone.label === "string" ? bone.label : bone.id }, binding: part.binding, attachmentGroup: part.attachmentGroup || null, defaultVisible: setup.visiblePartIds.includes(part.id),
      defaultAttachment: part.attachmentGroup ? setup.attachmentSelection[part.attachmentGroup] : part.id,
      layer: { slotId: rigPartSlotName(part), index: slots.indexOf(rigPartSlotName(part)), total: slots.length, z: part.z } },
    motions, issues: motions.flatMap((motion) => motion.issues.map((message) => ({ motionId: motion.motionId, motionName: motion.name, message }))) };
}

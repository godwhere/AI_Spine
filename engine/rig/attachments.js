import { isMotionStudyPlaybackActive } from "../../shared/domain/motion-study.mjs";
import { motionTime } from "./math.js";
import { sampleMotionStudyPose } from "./motion-study.js";
import { validateRigDocument } from "../../shared/rig-schema.mjs";

function attachmentTimelineTime(time) {
  // Spine stores timeline times as Float32. Round discrete events downward so
  // e.g. an authored final key at 1.1s is already active at that exact endpoint,
  // rather than delayed until the nearest Float32 value above it.
  const value = Float32Array.of(time);
  if (value[0] > time) new Uint32Array(value.buffer)[0]--;
  return value[0];
}

const rigPartSlotName = (part) => part.attachmentGroup ? `group_${part.attachmentGroup}` : `slot_${part.id}`;

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
function resolveRigAttachments(document, motionId, time = 0) {
  if (!Number.isFinite(time)) throw new Error("采样时间无效。");
  if (isMotionStudyPlaybackActive(document.motionStudies?.[motionId])) {
    const pose = sampleMotionStudyPose(document, motionId, time);
    return { kind: pose.kind, attachmentSelection: pose.attachmentSelection, visiblePartIds: pose.visiblePartIds };
  }
  const doc = validateRigDocument(document), motion = motionId == null ? null : doc.motions.find((item) => item.id === motionId);
  if (motionId != null && !motion) throw new Error(`动作不存在：${motionId}`);
  return attachmentState(doc, motion, motion ? motionTime(motion, time) : 0);
}

export { attachmentState, attachmentTimelineTime, resolveRigAttachments, rigPartSlotName };

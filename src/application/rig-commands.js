import { bindRigWeapon, getRigPartMesh, setRigPartWeights } from "../../engine/rig/geometry.js";
import { moveRigPart, resizeRigPart } from "../../engine/rig/part-adjustment.js";
import { rigWithPartAttachmentGroup, rigWithPartFields, rigWithDefaultAttachment, rigWithoutPart } from "../../shared/domain/rig.mjs";
import { isMotionStudyPlaybackActive } from "../../shared/domain/motion-study.mjs";

// Commands always read the current document. Views pass target IDs and fields,
// never a second mutable document or their own history stack.
export function createRigCommands(session, { createId, onChanged = () => {} }) {
  const current = session.getDocument;
  function commit(next, checkpoint = true) {
    const changed = session.commit(next, checkpoint);
    if (changed) onChanged();
    return changed;
  }
  function patchPart(id, fields) { return commit((document) => rigWithPartFields(document, id, fields)); }
  function patchMotion(id, fields) {
    if (!current().motions.some((motion) => motion.id === id)) return false;
    if (isMotionStudyPlaybackActive(current().motionStudies?.[id]) && ["poses", "duration", "loop"].some((key) => Object.hasOwn(fields, key)))
      throw new Error("此动作使用逐帧部件画面，请打开动作画面重制调整；原连续骨骼关键帧保持。");
    return commit((document) => ({ ...document, motions: document.motions.map((motion) => motion.id === id
      ? { ...motion, ...fields, ...(fields.poses ? { origin: "manual" } : {}) } : motion) }));
  }
  function patchPose(id, index, fields) {
    const motion = current().motions.find((item) => item.id === id);
    if (!motion?.poses[index]) return false;
    return patchMotion(id, { origin: "manual", poses: motion.poses.map((pose, at) => at === index ? { ...pose, ...fields } : pose) });
  }
  return {
    commit, patchPart, patchMotion, patchPose,
    patchJoint(id, fields, checkpoint = true) {
      return commit((document) => ({ ...document, joints: document.joints.map((joint) => joint.id === id ? { ...joint, ...fields } : joint) }), checkpoint);
    },
    movePart(id, x, y, checkpoint = true) { return commit(moveRigPart(current(), id, x, y), checkpoint); },
    resizePart(id, scale) { return commit(resizeRigPart(current(), id, scale)); },
    bindWeapon(id, options) { return commit(bindRigWeapon(current(), id, options)); },
    setPartGroup(id, group) { return commit(rigWithPartAttachmentGroup(current(), id, group)); },
    setDefaultAttachment(group, id) { return commit(rigWithDefaultAttachment(current(), group, id)); },
    removePart(id) { return commit(rigWithoutPart(current(), id)); },
    addPart({ duplicateId, boneId, group: selectedGroup }) {
      const document = current(), id = `part-${createId()}`, part = document.parts.find((item) => item.id === duplicateId);
      const bone = boneId || document.joints[0].id;
      const value = part ? { ...part, id, label: `${part.label || part.id} 变体`, image: undefined, imageSource: "placeholder", completion: "needs-inpaint", imageGeneration: undefined, previousCalibration: undefined, registrationBase: undefined, registration: undefined }
        : { id, label: `新部件 ${document.parts.length + 1}`, bone, x: Math.round(document.width * 0.4), y: Math.round(document.height * 0.4), width: Math.round(document.width * 0.2), height: Math.round(document.height * 0.2), z: document.parts.length, binding: "rigid", influences: [bone], critical: true, completion: "needs-inpaint", imageSource: "placeholder" };
      const group = part ? part.attachmentGroup : selectedGroup;
      let next = { ...document, parts: [...document.parts, value] };
      if (group) next = rigWithPartAttachmentGroup(next, id, group);
      commit(next); return { id, group };
    },
    setVertexWeight(partId, index, jointId, weight) {
      const document = current(), mesh = getRigPartMesh(document, partId);
      const vertex = mesh?.weights[Math.min(index, mesh.weights.length - 1)] || [];
      return commit(setRigPartWeights(document, partId, index, [...vertex.filter((item) => item.joint !== jointId), { joint: jointId, weight }]));
    },
    setInfluence(partId, id, checked) {
      const part = current().parts.find((item) => item.id === partId);
      const influences = checked ? [...new Set([...(part.influences || [part.bone]), id])] : (part.influences || [part.bone]).filter((item) => item !== id);
      if (!influences.length) throw new Error("至少保留一根影响骨骼。");
      if (influences.length > 8) throw new Error("每个网格最多选择 8 根影响骨骼。");
      const mesh = part.mesh ? { ...part.mesh } : undefined;
      if (mesh?.weights) mesh.weights = mesh.weights.map((weights) => {
        const kept = weights.filter((item) => influences.includes(item.joint)), total = kept.reduce((sum, item) => sum + item.weight, 0);
        return total ? kept.map((item) => ({ ...item, weight: item.weight / total })) : [{ joint: influences[0], weight: 1 }];
      });
      return patchPart(partId, { influences, ...(mesh ? { mesh } : {}) });
    },
    addPose(id, index) {
      const motion = current().motions.find((item) => item.id === id), pose = motion?.poses[index];
      if (!pose) return null;
      const times = [...new Set([0, ...motion.poses.map((item) => item.time), motion.duration])].sort((a, b) => a - b);
      let start = 0, gap = 0;
      for (let at = 1; at < times.length; at++) if (times[at] - times[at - 1] > gap) { start = times[at - 1]; gap = times[at] - start; }
      if (gap < 0.01) throw new Error("关键帧已足够密集，请先延长动作或调整现有帧。");
      const next = { ...structuredClone(pose), time: Math.round((start + gap / 2) * 1000) / 1000 };
      const poses = [...motion.poses, next].sort((a, b) => a.time - b.time);
      patchMotion(id, { poses }); return { index: poses.indexOf(next), time: next.time };
    },
  };
}

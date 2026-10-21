import { getRigPartMesh } from "../../engine/rig/geometry.js";
import { sampleRigPose } from "../../engine/rig/sample.js";
import { resolveRigAttachments, rigPartSlotName } from "../../engine/rig/attachments.js";
import { inspectRegistrationBounds } from "../../engine/images/registration.js";
import { deriveRigPartAnnotations } from "../../engine/rig/part-annotations.js";
import { rigDefaultVisiblePartIds } from "../../shared/domain/rig.mjs";

export const rigGeometryView = (document) => ({ ...document, sourceImage: undefined, appearanceReference: undefined, motionStudies: undefined,
  parts: document.parts.map((part) => ({ ...part, image: undefined, registrationBase: undefined })) });
export function rigMeshView(document, part, step) {
  try { return step === "binding" && part?.binding === "mesh" ? getRigPartMesh(document, part.id) : null; } catch { return null; }
}
export function rigPoseView(document, motion, time, step, canvasMode) {
  try { return { pose: canvasMode === "overlay" && (step === "motion" || step === "preview") && motion ? sampleRigPose(document, motion.id, time) : null, error: "" }; }
  catch (failure) { return { pose: null, error: failure.message }; }
}
export function rigVisiblePartsView(document, preview, groups, fallback) {
  const defaults = { ...document.defaultAttachments };
  for (const group of groups) if (group.parts.some((part) => part.id === preview[group.id])) defaults[group.id] = preview[group.id];
  try { return resolveRigAttachments({ ...document, defaultAttachments: defaults }).visiblePartIds; }
  catch { return rigDefaultVisiblePartIds(fallback, preview); }
}
export function rigRegistrationView(document, stage) {
  try { return stage?.baseDocument === document ? inspectRegistrationBounds(document, stage.polygons) : null; } catch { return null; }
}
export function rigParentCandidates(document, joint) {
  return document.joints.filter((candidate) => {
    if (!joint || candidate.id === joint.id) return false;
    const seen = new Set(); let current = candidate;
    while (current?.parent && !seen.has(current.id)) {
      if (current.parent === joint.id) return false;
      seen.add(current.id); current = document.joints.find((item) => item.id === current.parent);
    }
    return true;
  });
}
export function rigPartAppearanceView(document, partId) {
  if (!document || !partId) return {};
  try { return { annotation: deriveRigPartAnnotations(document, partId) }; }
  catch (error) { return { error: error.message || "无法读取部件标注。" }; }
}
export function rigPoseOrderView(document, motion, pose) {
  const root = document.joints.find((joint) => !joint.parent)?.id;
  const slots = [...new Map([...document.parts].sort((a, b) => a.z - b.z).map((part) => [rigPartSlotName(part), part])).entries()];
  let order = slots.map(([id]) => id);
  for (const key of motion.poses) if (key.time <= pose.time && key.drawOrder) order = key.drawOrder;
  return { root, slots, order };
}

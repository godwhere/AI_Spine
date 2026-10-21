import { isMotionStudyPlaybackActive } from "./motion-study.mjs";

const RIG_DOCUMENT_PATH = ".ispine/rig/document.json";

const summaryCache = new WeakMap();

// Library counts must not hydrate every image just to distinguish body parts
// from the hundreds of texture variants that can be produced by pose studies.
function rigAuthoringSummary(files) {
  const data = files?.[RIG_DOCUMENT_PATH];
  if (!(data instanceof Uint8Array) || data.length > 16 * 1024 * 1024) return null;
  if (summaryCache.has(data)) return summaryCache.get(data);
  let result = null;
  try {
    const document = JSON.parse(new TextDecoder().decode(data));
    if (Array.isArray(document.parts) && Array.isArray(document.joints)) {
      const bodyParts = document.parts.filter((part) => part.role !== "effect"), effects = document.parts.filter((part) => part.role === "effect");
      const logicalParts = new Set(bodyParts.map((part) => part.attachmentGroup ? `group:${part.attachmentGroup}` : `part:${part.id}`)).size;
      result = Object.freeze({
        baseParts: bodyParts.length, bones: document.joints.length,
        logicalParts, additionalAttachments: bodyParts.length - logicalParts,
        expressionVariants: bodyParts.filter((part) => part.attachmentGroup).length,
        ...(effects.length ? { effectLayers: new Set(effects.map((part) => part.attachmentGroup)).size, effectRegions: effects.length } : {}),
        poseRegions: Object.values(document.motionStudies || {}).filter(isMotionStudyPlaybackActive)
          .reduce((sum, study) => sum + (study.frames || []).reduce((count, frame) => count + (frame.segments?.length || 0), 0), 0),
      });
    }
  } catch { /* Ordinary resources remain browseable when author data is invalid. */ }
  summaryCache.set(data, result);
  return result;
}

const hasRigAuthoring = (files) => Boolean(files?.[RIG_DOCUMENT_PATH]);

export { RIG_DOCUMENT_PATH, hasRigAuthoring, rigAuthoringSummary };

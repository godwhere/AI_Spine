import { imageDataBytes } from "../codec/image-data.mjs";
import { validateRigAppearanceFields } from "../rig-schema.mjs";
import { validateRigDocument } from "../rig-schema.mjs";

function validateRigDraftDocument(document) {
  if (document?.joints?.length || document?.parts?.length || document?.motions?.length)
    return validateRigDocument(document);
  if (!document || document.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(document.id || "") ||
      typeof document.name !== "string" || !document.name.trim() ||
      ![document.width, document.height].every((value) => Number.isInteger(value) && value >= 1 && value <= 8192) ||
      ![document.joints, document.parts, document.motions].every((value) => Array.isArray(value) && value.length === 0))
    throw new Error("骨架草稿无效，请检查角色名称和立绘尺寸。");
  if (document.sourceImage) imageDataBytes(document.sourceImage);
  validateRigAppearanceFields(document);
  if (document.appearanceReference) imageDataBytes(document.appearanceReference.image);
  return structuredClone(document);
}

function rigDraftDestination(draft, resources) {
  if (!draft?.resourceId) return { resourceId: null, resourceUpdatedAt: null, forked: false, notice: "" };
  const resource = resources.find((record) => record.id === draft.resourceId && !record.deletedAt);
  if (resource && typeof draft.resourceUpdatedAt === "string" && draft.resourceUpdatedAt.trim() && draft.resourceUpdatedAt === resource.updatedAt)
    return { resourceId: resource.id, resourceUpdatedAt: resource.updatedAt, forked: false, notice: "" };
  return { resourceId: null, resourceUpdatedAt: null, forked: true,
    notice: "关联资源已更新、删除或版本无法确认，旧草稿将另存为新资源，保留最新校准。" };
}

export { rigDraftDestination, validateRigDraftDocument };

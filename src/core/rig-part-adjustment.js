import { validateRigDocument } from "../../shared/rig-schema.mjs";
import { getRigPartMesh } from "./rig-authoring.js";

const rectangle = ({ x, y, width, height }) => ({ x, y, width, height });
function selectedPart(document, id) {
  const part = document?.parts?.find((entry) => entry.id === id);
  if (!part) throw new Error("找不到要调整的部件。");
  return part;
}
function adjusted(document, part, nextRect, scale = 1) {
  if (Object.values(nextRect).some((value) => !Number.isFinite(value)) || nextRect.width < .01 || nextRect.height < .01 ||
      nextRect.x < 0 || nextRect.y < 0 || nextRect.x + nextRect.width > document.width + 1e-6 || nextRect.y + nextRect.height > document.height + 1e-6)
    throw new Error("调整后的部件必须完整位于立绘画布内，请减小位移或缩放。");
  if (Object.keys(nextRect).every((key) => nextRect[key] === part[key])) return document;
  // A source crop would sample a different source area after moving its rect.
  // Independent artwork remains unchanged; only its attachment geometry moves.
  if (typeof part.image !== "string" || ["source-crop", "placeholder"].includes(part.imageSource))
    throw new Error("请先为此部件上传或生成独立图片，再调整位置和大小。");
  const nextPart = { ...part, ...nextRect };
  if (part.binding === "mesh" && !part.mesh?.weights) {
    // Implicit weights depend on distance to the bones. Freeze their current
    // values before changing the normalized grid's placement or dimensions.
    const mesh = getRigPartMesh(document, part.id);
    nextPart.mesh = { ...part.mesh, cols: mesh.cols, rows: mesh.rows, weights: mesh.weights };
  }
  if (part.grip && scale !== 1) {
    const point = ({ x, y }) => ({ x: x * scale, y: y * scale });
    nextPart.grip = { ...part.grip, primaryLocalPoint: point(part.grip.primaryLocalPoint),
      ...(part.grip.secondaryLocalPoint ? { secondaryLocalPoint: point(part.grip.secondaryLocalPoint) } : {}) };
  }
  // Source polygons, stable underlays and their rects remain source provenance,
  // rather than following an edited attachment. Measurements become historical.
  if (part.registration) nextPart.registration = { ...part.registration, outOfDate: true };
  const result = { ...document, parts: document.parts.map((entry) => entry.id === part.id ? nextPart : entry),
    ...(document.registration ? { registration: { ...document.registration, outOfDate: true } } : {}) };
  // Validate without replacing the user's data with normalized copies: existing
  // weights, motions, other parts and unknown provenance must remain exact.
  validateRigDocument(result);
  return result;
}

/** Absolute top-left placement in setup pixels; all animations inherit it. */
export function moveRigPart(document, id, x, y) {
  const part = selectedPart(document, id);
  return adjusted(document, part, { ...rectangle(part), x, y });
}

/** Uniform scale relative to the current rectangle, with its center fixed. */
export function resizeRigPart(document, id, scale, { anchor = "center" } = {}) {
  const part = selectedPart(document, id);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("部件缩放比例必须是大于零的有限数值。");
  if (anchor !== "center") throw new Error("部件等比缩放仅支持以中心为基准。");
  const width = part.width * scale, height = part.height * scale;
  return adjusted(document, part, { x: part.x + (part.width - width) / 2, y: part.y + (part.height - height) / 2, width, height }, scale);
}

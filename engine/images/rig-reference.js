import { imageDataBytes, bytesToImageDataURL } from "../../shared/codec/image-data.mjs";
import { identityTransform, renderReplacement } from "./calibration.js";

export function createRigReferenceCalibration(prepared) {
  const { document, bytes, boardId } = prepared, board = document.production.boards.find((b) => b.id === boardId);
  const part = { id: boardId, name: board.label, pageFile: "reference.png", x: 0, y: 0, width: document.width, height: document.height,
    originalWidth: document.width, originalHeight: document.height, offsetX: 0, offsetY: 0, degrees: 0, pma: false, nativePixels: true };
  return { ...prepared, kind: "production-reference", part, bundle: { files: { "reference.png": imageDataBytes(document.sourceImage).bytes }, parts: [part] },
    edit: { image: bytes, fileName: `${boardId}-native.png`, transform: prepared.transform || identityTransform() } };
}
export async function bakeRigReferenceCalibration(session, edit, env) {
  if (edit.image !== session.bytes) throw new Error("请保留当前任务的原生图片，不能在校准中替换来源。");
  const t = { ...identityTransform(), ...edit.transform }, doc = session.document;
  if (!["x", "y", "scaleX", "scaleY", "rotation"].every((k) => Number.isFinite(t[k])) || t.scaleX <= 0 || t.scaleX > 8 || Math.abs(t.scaleX - t.scaleY) > 1e-6 || t.flipX || t.flipY)
    throw new Error("关键图只允许等比缩放、移动和旋转，保持身体比例与持握方向。");
  const image = await env.loadImage(session.bytes), canvas = env.createCanvas(image.width, image.height);
  try {
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data, angle = t.rotation * Math.PI / 180;
    const c = Math.cos(angle) * t.scaleX, s = Math.sin(angle) * t.scaleX, margin = (Math.abs(c) + Math.abs(s)) / 2;
    let outside = 0, visible = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (pixels[(y * image.width + x) * 4 + 3] > 8) {
      visible++;
      const dx = x + .5 - image.width / 2, dy = y + .5 - image.height / 2;
      const xx = doc.width / 2 + t.x + c * dx - s * dy, yy = doc.height / 2 + t.y + s * dx + c * dy;
      if (xx - margin < -1e-6 || yy - margin < -1e-6 || xx + margin > doc.width + 1e-6 || yy + margin > doc.height + 1e-6) outside++;
    }
    if (!visible || outside) throw new Error(outside ? `${outside} 个可见源像素会超出画布，请调整位置和等比缩放，完整保留人物与法杖。` : "原生图片完全透明。");
  } finally { image.close?.(); canvas.width = 1; canvas.height = 1; }
  const rendered = await renderReplacement(session.part, { ...edit, transform: t }, env);
  try { return { image: bytesToImageDataURL(await env.encode(rendered)), nativeImage: bytesToImageDataURL(session.bytes), transform: t }; }
  finally { rendered.width = 1; rendered.height = 1; }
}

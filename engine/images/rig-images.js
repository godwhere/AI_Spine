import { alphaBounds } from "./calibration.js";
import { bytesToImageDataURL } from "../../shared/codec/image-data.mjs";
import { decodeBase64 } from "../../shared/codec/base64.mjs";
import { identityTransform } from "./calibration.js";
import { renderReplacement } from "./calibration.js";
import { rigDefaultVisiblePartIds } from "../../shared/domain/rig.mjs";

function dataImageBytes(value) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value || "");
  if (!match) throw new Error("部件或立绘图片数据无效。");
  return decodeBase64(match[1]);
}

function independentPart(document, partId) {
  const part = document.parts.find((item) => item.id === partId);
  if (!part?.image || !["uploaded", "ai", "calibrated"].includes(part.imageSource) || part.completion !== "ready")
    throw new Error("请先补绘或上传完整独立部件图片，再进行校准。原图裁片不能作为已完成部件。");
  return part;
}

async function createRigPartCalibration(document, partId, env) {
  const original = independentPart(document, partId);
  if (!document.sourceImage) throw new Error("缺少原始立绘，无法取得部件校准参考。");
  const width = Math.ceil(original.width), height = Math.ceil(original.height);
  const source = await env.loadImage(dataImageBytes(document.sourceImage));
  let bytes;
  try {
    const canvas = env.createCanvas(width, height);
    canvas.getContext("2d").drawImage(source, original.x * source.width / document.width, original.y * source.height / document.height,
      original.width * source.width / document.width, original.height * source.height / document.height, 0, 0, width, height);
    bytes = new Uint8Array(await env.encode(canvas));
  } finally { source.close?.(); }
  const part = { id: original.id, name: original.label || original.id, pageFile: "reference.png", x: 0, y: 0, width, height,
    originalWidth: width, originalHeight: height, offsetX: 0, offsetY: 0, degrees: 0, pma: false };
  return { document, partId, part, bundle: { files: { "reference.png": bytes }, parts: [part] },
    edit: { image: dataImageBytes(original.image), fileName: `${original.id}.png`, transform: identityTransform() } };
}

async function bakeRigPartCalibration(document, partId, edit, env) {
  const part = independentPart(document, partId);
  if (!edit?.image) throw new Error("待校准图片无效，图片尚未应用。");
  const transform = { ...identityTransform(), ...edit.transform };
  if (!["x", "y", "scaleX", "scaleY", "rotation"].every((key) => Number.isFinite(transform[key])) || transform.scaleX <= 0 || transform.scaleY <= 0)
    throw new Error("校准参数无效，请检查平移、缩放和旋转。");
  const canvas = await renderReplacement({ originalWidth: Math.ceil(part.width), originalHeight: Math.ceil(part.height) }, { ...edit, transform }, env);
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  if (!alphaBounds(pixels)) throw new Error("校准后部件完全移出了矩形，请调整位置或缩放。图片尚未应用。");
  let transparent = false;
  for (let offset = 3; offset < pixels.data.length; offset += 4) if (pixels.data[offset] < 247) { transparent = true; break; }
  if (!transparent) throw new Error("校准结果没有透明像素，请使用独立透明部件图片。图片尚未应用。");
  const image = bytesToImageDataURL(new Uint8Array(await env.encode(canvas)));
  return { ...document, parts: document.parts.map((item) => {
    if (item.id !== partId) return item;
    const next = { ...item, image, imageSource: "calibrated", completion: "ready",
      ...(item.imageGeneration ? {} : item.imageSource === "ai" ? { imageGeneration: { source: "ai" } } : {}) };
    delete next.registrationBase; delete next.registration; return next;
  }) };
}

async function readRigReference(bytes, { name, type } = {}, env) {
  const image = await readRigImage(bytes, { type }, env);
  let mime;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) mime = "image/png";
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = "image/jpeg";
  else if (String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") mime = "image/webp";
  else throw new Error("请选择 PNG、JPEG 或 WebP 参考图。");
  return { ...image, reference: { image: bytesToImageDataURL(bytes, mime), width: image.sourceWidth, height: image.sourceHeight, ...(name ? { name } : {}) } };
}

async function readRigPartCandidate(bytes, { expectedWidth, expectedHeight } = {}, env) {
  if (!(bytes instanceof Uint8Array) || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47)
    throw new Error("部件候选必须是已映射的透明 PNG。");
  const verified = await readRigImage(bytes, { requireTransparent: true, maxDimension: 4096, expectedWidth, expectedHeight }, env);
  return { ...verified, dataURL: bytesToImageDataURL(bytes) };
}

async function composeRigSourceView(document, env) {
  const canvas = env.createCanvas(document.width, document.height), context = canvas.getContext("2d"), visible = new Set(rigDefaultVisiblePartIds(document));
  let source;
  try {
    for (const part of document.parts.filter((item) => visible.has(item.id)).sort((a, b) => a.z - b.z)) {
      if (part.image) {
        const image = await env.loadImage(dataImageBytes(part.image));
        try { context.drawImage(image, part.x, part.y, part.width, part.height); } finally { image.close?.(); }
      } else if (document.sourceImage) {
        source ||= await env.loadImage(dataImageBytes(document.sourceImage));
        context.drawImage(source, part.x * source.width / document.width, part.y * source.height / document.height,
          part.width * source.width / document.width, part.height * source.height / document.height, part.x, part.y, part.width, part.height);
      }
    }
    return { width: document.width, height: document.height, png: new Uint8Array(await env.encode(canvas)) };
  } finally { source?.close?.(); }
}

async function inspectRigPartAlpha(document, partId, env) {
  const part = document.parts.find((item) => item.id === partId);
  if (!part?.image) return null;
  const image = await env.loadImage(dataImageBytes(part.image));
  try {
    const canvas = env.createCanvas(image.width, image.height), context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    const bounds = alphaBounds(context.getImageData(0, 0, image.width, image.height));
    return bounds ? { x: part.x + bounds.x * part.width / image.width, y: part.y + bounds.y * part.height / image.height,
      width: bounds.width * part.width / image.width, height: bounds.height * part.height / image.height } : null;
  } finally { image.close?.(); }
}

async function readRigImage(bytes, { requireTransparent = false, maxDimension = 2048, expectedWidth, expectedHeight, type } = {}, env) {
  if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("图片超过 32 MB，请缩小后再导入。");
  if (type && !["image/png", "image/jpeg", "image/webp"].includes(type))
    throw new Error("请选择 PNG、JPEG 或 WebP 图片。");
  const image = await env.loadImage(bytes);
  try {
    if (image.width > 4096 || image.height > 4096 || image.width * image.height > 16_000_000)
      throw new Error("图片请控制在 4096 × 4096、1600 万像素以内。");
    if ((expectedWidth && image.width !== expectedWidth) || (expectedHeight && image.height !== expectedHeight))
      throw new Error("AI 图片尺寸与当前部件矩形不一致，未应用。");
    const ratio = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * ratio)), height = Math.max(1, Math.round(image.height * ratio));
    const canvas = env.createCanvas(width, height), context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let visible = false, transparent = false;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] > 8) visible = true;
      if (pixels[offset] < 247) transparent = true;
      if (visible && transparent) break;
    }
    if (!visible) throw new Error("图片完全透明，请选择有内容的图片。");
    if (requireTransparent && !transparent)
      throw new Error("这张部件图没有透明像素。请上传透明 PNG/WebP，或用 AI 补绘去除背景。");
    const png = await env.encode(canvas);
    if (png.byteLength > 18 * 1024 * 1024) throw new Error("PNG 图片超过 18 MB，请缩小后再导入。");
    return { dataURL: bytesToImageDataURL(png), width, height, transparent, resized: ratio < 1, sourceWidth: image.width, sourceHeight: image.height };
  } finally { image.close?.(); }
}

export { bakeRigPartCalibration, composeRigSourceView, createRigPartCalibration, inspectRigPartAlpha, readRigImage, readRigPartCandidate, readRigReference };

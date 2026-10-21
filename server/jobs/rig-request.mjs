import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigGeometry } from "../../shared/domain/rig.mjs";
import { validateRigSourcePolygon } from "../../shared/rig-schema.mjs";
import { MOTION_STUDY_KINDS } from "./handlers/motion-study.mjs";

export const ACTIVE = new Set(["queued", "analyzing", "generating"]);
export const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
export const KINDS = new Set(["appearance", "structure", "registration", "motion", "parts", ...MOTION_STUDY_KINDS]);
export const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const checkPNGSize = (bytes) => {
  if (bytes.subarray(0, 8).equals(PNG) && bytes.length >= 24 &&
    (bytes.readUInt32BE(16) > 4096 || bytes.readUInt32BE(20) > 4096)) throw new Error("图片画布需在 4096 × 4096 以内。");
};
export const string = (value, maximum, label, required = false) => {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.trim().length > maximum || (required && !value.trim())) throw new Error(`${label}无效。`);
  return value.trim();
};
export const base64 = (value) => {
  if (typeof value !== "string" || value.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("参考图片无效或超过 18 MB。");
  return Buffer.from(value, "base64");
};
const dataImage = (value) => {
  const match = typeof value === "string" && value.match(/^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error("请提供 PNG、JPEG 或 WebP 立绘。");
  return base64(match[1]);
};
export const fingerprint = (geometry) => createHash("sha256").update(JSON.stringify(geometry)).digest("hex");
export async function saveMotionPlanningReferences(request, folder) {
  const study = request.rig.motionStudies?.[request.motion.id], frames = study?.frames || [];
  request.motionReferences = []; request.motionReferenceExclusions = [];
  const exclude = (frame, reason) => request.motionReferenceExclusions.push({ frameId: frame.id, time: frame.time, reason });
  const baseFingerprint = request.rig.sourceImage ? createHash("sha256").update(dataImage(request.rig.sourceImage)).digest("hex") : null;
  request.motionReferenceBaseFingerprint = baseFingerprint;
  const unavailable = request.motion.id === "idle" ? "protected-idle" : study?.playback !== "reference" ? "not-reference-mode" :
    !baseFingerprint || study.baseFingerprint !== baseFingerprint || request.sourceFingerprint !== baseFingerprint ? "stale-base-fingerprint" : null;
  if (unavailable) { for (const frame of frames) if (!frame.imageRef) exclude(frame, unavailable); return; }
  const { loadImage } = await import("@napi-rs/canvas"), used = new Set();
  for (const frame of frames) {
    if (frame.imageRef) { exclude(frame, "image-alias"); continue; }
    if (frame.origin === "base" || frame.reuseBase || frame.sourceFingerprint === baseFingerprint) { exclude(frame, "shared-base-already-attached"); continue; }
    if (frame.review?.approved !== true || !["identity", "expression", "limbs", "scale", "grip"].every((key) => frame.review.checks?.[key] === true)) { exclude(frame, "incomplete-five-check-review"); continue; }
    if (!frame.image) { exclude(frame, "missing-image"); continue; }
    let bytes, image, width, height;
    try {
      bytes = dataImage(frame.image); checkPNGSize(bytes);
      if (createHash("sha256").update(bytes).digest("hex") !== frame.sourceFingerprint) { exclude(frame, "image-fingerprint-mismatch"); continue; }
      image = await loadImage(bytes);
      if (image.width !== request.rig.width || image.height !== request.rig.height) { exclude(frame, "different-canvas-size"); continue; }
      if (used.has(frame.sourceFingerprint)) { exclude(frame, "duplicate-source-image"); continue; }
      if (request.motionReferences.length >= 4) { exclude(frame, "maximum-four-reference-images"); continue; }
      width = image.width; height = image.height;
    } catch {
      // A bad reference never turns into a successful-looking image attachment.
      // The explicit omission stays in both public history and motion provenance.
      exclude(frame, "invalid-reference-image"); continue;
    } finally { image?.close?.(); }
    const index = request.motionReferences.length, extension = frame.image.match(/^data:image\/(png|jpe?g|webp);/)[1], file = `motion-reference-${index}.${extension}`;
    await writeFile(join(folder, file), bytes, { mode: 0o600 }); used.add(frame.sourceFingerprint);
    const generation = frame.imageGeneration || {}, safeId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : undefined;
    request.motionReferences.push({ frameId: frame.id, time: frame.time, label: frame.label || frame.id, sourceFingerprint: frame.sourceFingerprint,
      width, height, imageIndex: index + 2, file, jobId: safeId(generation.jobId), imageId: safeId(generation.imageId) });
  }
}
export async function registrationGrid(request, folder) {
  const { loadImage, createCanvas } = await import("@napi-rs/canvas"), image = await loadImage(await readFile(join(folder, "source.png")));
  const canvas = createCanvas(request.width, request.height), context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
  context.lineWidth = 1; context.strokeStyle = "rgba(95,68,180,0.25)";
  for (let x = 0; x < request.width; x += request.gridSize) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, request.height); context.stroke(); }
  for (let y = 0; y < request.height; y += request.gridSize) { context.beginPath(); context.moveTo(0, y); context.lineTo(request.width, y); context.stroke(); }
  context.font = "11px sans-serif"; context.fillStyle = "#34255e";
  for (let x = 0; x < request.width; x += request.gridSize * 2) context.fillText(String(x), x + 2, 12);
  for (let y = 0; y < request.height; y += request.gridSize * 2) context.fillText(String(y), 2, Math.max(24, y + 12));
  context.font = "9px sans-serif";
  for (const id of request.partIds) {
    const part = request.rig.parts.find((part) => part.id === id);
    context.strokeStyle = "rgba(0,126,160,0.65)"; context.strokeRect(part.x, part.y, part.width, part.height);
    context.fillStyle = "#005b74"; context.fillText(part.id, part.x + 2, Math.max(10, part.y + 10));
  }
  for (const joint of request.rig.joints) {
    context.fillStyle = "#dc5519"; context.beginPath(); context.arc(joint.x, joint.y, 2.5, 0, Math.PI * 2); context.fill();
    context.fillText(joint.id, Math.min(request.width - 30, joint.x + 4), Math.max(10, joint.y - 3));
  }
  const file = join(folder, "source-grid.png"); await writeFile(file, canvas.toBuffer("image/png"), { mode: 0o600 }); return file;
}
export function registrationResult(request, value) {
  const polygons = Object.create(null), requiredBounds = Object.create(null), warnings = [], expected = new Set(request.partIds);
  for (const entry of value.parts) {
    if (!expected.has(entry.id) || Object.hasOwn(polygons, entry.id)) throw new Error("原图坐标规划包含重复、未知或非默认可见部件。");
    const polygon = validateRigSourcePolygon(entry.sourcePolygon, request.width, request.height, `部件 ${entry.id} 原图轮廓`);
    polygons[entry.id] = polygon;
    const x = Math.min(...polygon.map((point) => point.x)), y = Math.min(...polygon.map((point) => point.y));
    const right = Math.max(...polygon.map((point) => point.x)), bottom = Math.max(...polygon.map((point) => point.y));
    const polygonBounds = { x, y, width: right - x, height: bottom - y }, part = request.rig.parts.find((part) => part.id === entry.id);
    requiredBounds[entry.id] = polygonBounds;
    const requiredExpansion = { left: Math.max(0, part.x - x), right: Math.max(0, right - part.x - part.width),
      top: Math.max(0, part.y - y), bottom: Math.max(0, bottom - part.y - part.height) };
    requiredExpansion.max = Math.max(...Object.values(requiredExpansion));
    if (requiredExpansion.max > request.maxBBoxExpansion + 1e-7) warnings.push({ partId: entry.id, kind: "rect-bounds", polygonBounds,
      rect: { x: part.x, y: part.y, width: part.width, height: part.height }, requiredExpansion,
      message: `${part.label || part.id} 的真实轮廓超过现有矩形 ${requiredExpansion.max.toFixed(2)} px，请修正矩形或轮廓后再应用；图片没有被拉伸。` });
  }
  if (Object.keys(polygons).length !== expected.size) throw new Error("原图坐标规划缺少默认可见部件。");
  return { polygons, requiredBounds, warnings, canApply: warnings.length === 0, gridSize: request.gridSize,
    maxBBoxExpansion: request.maxBBoxExpansion, sourceFingerprint: request.sourceFingerprint, partIds: request.partIds, notes: value.notes };
}

export async function restoreSourceIdentity(root, job) {
  if (job.request.kind !== "parts" || !Array.isArray(job.images)) return false;
  let hash = job.request.sourceFingerprint;
  if (!/^[a-f0-9]{64}$/.test(hash || "")) {
    if (!job.request.rig?.sourceImage || job.request.image?.file !== "source.png") return false;
    const original = dataImage(job.request.rig.sourceImage), saved = await readFile(join(root, job.id, "source.png"));
    if (!original.equals(saved)) {
      checkPNGSize(original); checkPNGSize(saved);
      const { loadImage, createCanvas } = await import("@napi-rs/canvas");
      const [a, b] = await Promise.all([loadImage(original), loadImage(saved)]);
      if (a.width !== b.width || a.height !== b.height || a.width > 4096 || a.height > 4096) return false;
      const pixels = (image) => { const canvas = createCanvas(image.width, image.height); canvas.getContext("2d").drawImage(image, 0, 0); return Buffer.from(canvas.getContext("2d").getImageData(0, 0, image.width, image.height).data); };
      if (!pixels(a).equals(pixels(b))) return false;
    }
    hash = createHash("sha256").update(original).digest("hex");
  }
  let changed = job.request.sourceFingerprint !== hash; job.request.sourceFingerprint = hash;
  for (const image of [...job.images, ...(Array.isArray(job.result?.images) ? job.result.images : [])])
    if (!image.sourceFingerprint) { image.sourceFingerprint = hash; changed = true; }
  return changed;
}

export async function sourceImage(input, rig) {
  const bytes = input.image ? base64(input.image.base64) : rig?.sourceImage ? dataImage(rig.sourceImage) : null;
  if (!bytes) return null;
  checkPNGSize(bytes);
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const image = await loadImage(bytes), width = image.width, height = image.height;
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16 * 1024 * 1024) throw new Error("立绘画布需在 4096 × 4096 以内。");
  if ((input.image?.width !== undefined && input.image.width !== width) || (input.image?.height !== undefined && input.image.height !== height) ||
    (rig && (rig.width !== width || rig.height !== height))) throw new Error("立绘尺寸与骨架画布不一致。");
  const sourceFingerprint = createHash("sha256").update(bytes).digest("hex");
  if (bytes.subarray(0, 8).equals(PNG)) return { bytes, width, height, sourceFingerprint };
  const canvas = createCanvas(width, height); canvas.getContext("2d").drawImage(image, 0, 0);
  return { bytes: canvas.toBuffer("image/png"), width, height, sourceFingerprint };
}
export function publicJob(job, includeResult = true) {
  const study = MOTION_STUDY_KINDS.has(job.request.kind);
  return { id: job.id, projectId: job.request.projectId, kind: job.request.kind, name: job.request.name,
    prompt: job.request.prompt, provider: job.request.provider, model: job.model, status: job.status, stage: job.stage,
    createdAt: job.createdAt, updatedAt: job.updatedAt, error: job.error,
    total: study ? job.request.frames.length : job.request.kind === "parts" ? job.request.partIds.length : 1,
    completed: study ? job.request.kind === "motion-frames" ? job.images.length : job.mappings?.length || 0 : job.request.kind === "parts" ? job.images.length : job.status === "completed" ? 1 : 0,
    concurrency: job.request.concurrency, partIds: job.request.partIds, currentParts: ACTIVE.has(job.status) ? job.currentParts || [] : [],
    rigFingerprint: job.rigFingerprint, geometry: job.geometry, images: job.images,
    sourceFingerprint: job.request.sourceFingerprint, sourceWidth: job.request.image?.width, sourceHeight: job.request.image?.height,
    detail: job.request.detail, parentJobId: job.parentJobId, gridSize: job.request.gridSize, maxBBoxExpansion: job.request.maxBBoxExpansion,
    ...(job.request.kind === "motion" ? { motionId: job.request.motion.id, motionReferences: job.request.motionReferences || [],
      motionReferenceExclusions: job.request.motionReferenceExclusions || [] } : {}),
    ...(study ? { motionId: job.request.motion.id, motion: job.request.motion,
      frames: job.request.frames.map(({ file, ...frame }) => frame), currentFrames: ACTIVE.has(job.status) ? job.currentFrames || [] : [],
      baseFingerprint: job.request.baseFingerprint, geometryFingerprint: job.request.geometryFingerprint,
      protectedIdleFingerprint: job.request.protectedIdleFingerprint, originalArtworkFingerprint: job.request.originalArtworkFingerprint,
      ...(job.request.kind === "pose-mapping" ? { mappings: job.mappings || [] } : {}) } : {}),
    ...(includeResult && job.status === "completed" && job.result ? { result: job.result } : {}) };
}


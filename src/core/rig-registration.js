import { validateRigDocument, validateRigSourcePolygon } from "../../shared/rig-schema.mjs";
import { resolveRigAttachments } from "./rig-authoring.js";
import { imageDataBytes, imageDataURL } from "./rig-project.js";
import { browserPixels } from "./pixels.js";

const SEMI_OPAQUE = 250;
const WEAK_ALPHA_MAX = 8;
const bounds = (points) => ({ x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)),
  width: Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)), height: Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)) });
const pixelRect = (part) => ({ x: Math.floor(part.x), y: Math.floor(part.y), width: Math.ceil(part.x + part.width) - Math.floor(part.x), height: Math.ceil(part.y + part.height) - Math.floor(part.y) });
const contains = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }; };
const rectOf = ({ x, y, width, height }) => ({ x, y, width, height });
const sameRect = (a, b) => ["x", "y", "width", "height"].every((key) => a[key] === b[key]);
const independentArtwork = (part) => Boolean(part.image && part.completion === "ready" && ["ai", "uploaded", "calibrated"].includes(part.imageSource));

function documentWithPolygons(document, polygons = {}) {
  const doc = validateRigDocument(document);
  if (!polygons || typeof polygons !== "object" || Array.isArray(polygons)) throw new Error("原图轮廓必须按部件 ID 映射。");
  for (const [id, polygon] of Object.entries(polygons)) {
    const part = doc.parts.find((item) => item.id === id);
    if (!part) throw new Error(`原图轮廓引用未知部件：${id}`);
    part.sourcePolygon = validateRigSourcePolygon(polygon, doc.width, doc.height, `部件 ${id} 原图轮廓`);
  }
  return doc;
}

export function inspectRegistrationBounds(document, polygons = {}, { maxBBoxExpansion = 2 } = {}) {
  if (!Number.isFinite(maxBBoxExpansion) || maxBBoxExpansion < 0 || maxBBoxExpansion > 64) throw new Error("允许的矩形微扩范围无效。");
  const doc = documentWithPolygons(document, polygons), parts = [];
  for (const part of doc.parts) if (part.sourcePolygon) {
    const polygonBounds = bounds(part.sourcePolygon), currentBounds = rectOf(part), requiredBounds = union(pixelRect(part), pixelRect(polygonBounds));
    const padding = { left: Math.max(0, currentBounds.x - polygonBounds.x), top: Math.max(0, currentBounds.y - polygonBounds.y),
      right: Math.max(0, polygonBounds.x + polygonBounds.width - currentBounds.x - currentBounds.width),
      bottom: Math.max(0, polygonBounds.y + polygonBounds.height - currentBounds.y - currentBounds.height) };
    const maxExpansion = Math.max(...Object.values(padding));
    parts.push({ partId: part.id, currentBounds, polygonBounds, requiredBounds, padding, maxExpansion,
      needsExpansion: !sameRect(currentBounds, requiredBounds), exceedsLimit: maxExpansion > maxBBoxExpansion + 1e-6 });
  }
  return { parts, maxBBoxExpansion, canApply: parts.every((part) => !part.exceedsLimit) };
}

function moveRect(part, next) {
  const previous = rectOf(part), dx = previous.x - next.x, dy = previous.y - next.y;
  Object.assign(part, next);
  // Preserve the world-space grasp when padding changes the local PNG origin.
  if (part.grip) for (const key of ["primaryLocalPoint", "secondaryLocalPoint"]) if (part.grip[key])
    part.grip[key] = { x: part.grip[key].x + dx, y: part.grip[key].y + dy };
  return { partId: part.id, previous, current: rectOf(part) };
}

async function decoded(bytes, env) {
  const image = await env.loadImage(bytes);
  try {
    const canvas = env.createCanvas(image.width, image.height), context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return { canvas, width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
  } finally { image.close?.(); }
}
async function sourcePixels(doc, env) {
  if (!doc.sourceImage) throw new Error("缺少固定的角色立绘，不能锁定原图像素。");
  const bytes = imageDataBytes(doc.sourceImage).bytes, source = await decoded(bytes, env);
  if (source.width !== doc.width || source.height !== doc.height) throw new Error("立绘尺寸与骨架坐标不一致，禁止缩放原图像素进行配准。");
  if (source.width * source.height > 16 * 1024 * 1024) throw new Error("原图坐标配准请控制在 1600 万像素以内。");
  let visible = false;
  for (let i = 3; i < source.data.length; i += 4) if (source.data[i]) { visible = true; break; }
  if (!visible) throw new Error("角色立绘完全透明，不能据此清空部件图片。");
  return { ...source, bytes };
}
async function sha256(bytes) {
  const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(result)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
function alphaBounds(data, width, height, threshold = 0) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > threshold) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); count++;
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: count };
}
function canvasFromData(data, width, height, env) {
  const canvas = env.createCanvas(width, height), context = canvas.getContext("2d"), image = context.createImageData(width, height);
  image.data.set(data); context.putImageData(image, 0, 0);
  return canvas;
}

const rectDistanceSquared = (r, x, y) => Math.max(r.x - x, 0, x - r.x - r.width) ** 2 + Math.max(r.y - y, 0, y - r.y - r.height) ** 2;
function sourceCoverage(doc, source) {
  const visible = new Set(resolveRigAttachments(doc).visiblePartIds), parts = doc.parts.filter((part) => visible.has(part.id));
  const rects = parts.map((part) => pixelRect(part)), rigid = parts.filter((part) => !part.attachmentGroup && part.binding === "rigid");
  const weak = [], histogram = {}, nearest = new Map(); let uncoveredPixels = 0, visiblePixels = 0, weakBounds = null, visibleBounds = null;
  for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) {
    const index = y * doc.width + x, alpha = source.data[index * 4 + 3];
    if (!alpha || rects.some((r) => contains(r, x + .5, y + .5))) continue;
    uncoveredPixels++; histogram[alpha] = (histogram[alpha] || 0) + 1;
    const point = { x, y, width: 1, height: 1 };
    if (alpha > WEAK_ALPHA_MAX) { visiblePixels++; visibleBounds = visibleBounds ? union(visibleBounds, point) : point; continue; }
    weakBounds = weakBounds ? union(weakBounds, point) : point;
    let owner = null, score = Infinity;
    for (const part of rigid) {
      const value = rectDistanceSquared(pixelRect(part), x + .5, y + .5);
      if (value < score) { score = value; owner = part; }
    }
    weak.push({ index, partId: owner?.id, alpha, distance: Math.sqrt(score) });
    if (owner) {
      const previous = nearest.get(owner.id) || { partId: owner.id, pixels: 0, bounds: point, maxDistance: 0 };
      previous.pixels++; previous.bounds = union(previous.bounds, point); previous.maxDistance = Math.max(previous.maxDistance, Math.sqrt(score)); nearest.set(owner.id, previous);
    }
  }
  return { weak, summary: { uncoveredPixels, weakPixels: weak.length, visiblePixels, alphaHistogram: histogram, weakBounds, visibleBounds,
    weakPixelOwnerPolicy: "nearest-rigid", weakAlphaMax: WEAK_ALPHA_MAX, nearestRigidParts: [...nearest.values()] } };
}

export async function inspectRigSourceCoverage(document, pixelEnv = browserPixels) {
  const doc = validateRigDocument(document), env = { ...browserPixels, ...pixelEnv };
  return sourceCoverage(doc, await sourcePixels(doc, env)).summary;
}

async function padPart(part, next, env) {
  const previous = rectOf(part);
  if (!part.registrationBase && independentArtwork(part)) part.registrationBase = { image: part.image, ...previous, imageSource: part.imageSource, completion: "ready" };
  if (part.image) {
    const image = await decoded(imageDataBytes(part.image).bytes, env), canvas = env.createCanvas(next.width, next.height);
    canvas.getContext("2d").drawImage(image.canvas, previous.x - next.x, previous.y - next.y, previous.width, previous.height);
    const bytes = await env.encode(canvas); part.image = imageDataURL(bytes);
    if (part.registrationBase) {
      part.registration = { ...part.registration };
      part.registration.outputImageSHA256 = await sha256(bytes);
      part.registration.outputPixelSHA256 = await sha256(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data);
      part.registration.outputImageWidth = canvas.width; part.registration.outputImageHeight = canvas.height;
    }
  }
  return moveRect(part, next);
}

export async function expandRigRegistrationBounds(document, polygons = {}, { partIds } = {}, pixelEnv = browserPixels) {
  const doc = documentWithPolygons(document, polygons), env = { ...browserPixels, ...pixelEnv }, inspection = inspectRegistrationBounds(doc);
  const selected = partIds === undefined ? null : new Set(partIds), adjustments = [];
  if (selected && [...selected].some((id) => !doc.parts.some((part) => part.id === id))) throw new Error("待扩展矩形包含未知部件。");
  for (const item of inspection.parts) if (item.needsExpansion && (!selected || selected.has(item.partId))) {
    const part = doc.parts.find((candidate) => candidate.id === item.partId);
    adjustments.push({ ...await padPart(part, item.requiredBounds, env), reason: "source-polygon" });
  }
  const source = await sourcePixels(doc, env), fingerprint = await sha256(source.bytes), coverage = sourceCoverage(doc, source);
  if (coverage.summary.visiblePixels) {
    const error = new Error(`仍有 ${coverage.summary.visiblePixels} 个 alpha>8 的主体像素不在默认部件矩形内，请修正轮廓或矩形。`);
    error.code = "RIG_REGISTRATION_VISIBLE_GAP"; error.diagnostics = coverage.summary; throw error;
  }
  if (coverage.weak.some((pixel) => !pixel.partId)) {
    const error = new Error("近透明离群像素没有可用的默认刚性物理部件，不能为它们改变现有网格绑定。");
    error.code = "RIG_REGISTRATION_NO_RIGID_OWNER"; error.diagnostics = coverage.summary; throw error;
  }
  const previousCoverage = doc.registration?.lowAlphaCoverage, assignments = new Map();
  if (previousCoverage?.sourceFingerprint === fingerprint && previousCoverage.weakPixelOwnerPolicy === "nearest-rigid")
    for (const entry of previousCoverage.assignments || []) {
      const part = doc.parts.find((candidate) => candidate.id === entry.partId && candidate.binding === "rigid" && !candidate.attachmentGroup);
      if (!part) continue;
      assignments.set(part.id, new Set((entry.pixelIndices || []).filter((index) => Number.isInteger(index) && index >= 0 && index < doc.width * doc.height &&
        source.data[index * 4 + 3] > 0 && source.data[index * 4 + 3] <= WEAK_ALPHA_MAX && contains(pixelRect(part), index % doc.width + .5, Math.floor(index / doc.width) + .5))));
    }
  for (const pixel of coverage.weak) {
    if (!assignments.has(pixel.partId)) assignments.set(pixel.partId, new Set()); assignments.get(pixel.partId).add(pixel.index);
  }
  for (const entry of coverage.summary.nearestRigidParts) {
    const part = doc.parts.find((candidate) => candidate.id === entry.partId), next = union(pixelRect(part), entry.bounds);
    if (!sameRect(rectOf(part), next)) adjustments.push({ ...await padPart(part, next, env), reason: "low-alpha-coverage", pixels: entry.pixels, maxDistance: entry.maxDistance });
  }
  const savedAssignments = [...assignments].map(([partId, pixels]) => ({ partId, pixelIndices: [...pixels].sort((a, b) => a - b) })).filter((entry) => entry.pixelIndices.length);
  const retainedPixels = savedAssignments.reduce((sum, entry) => sum + entry.pixelIndices.length, 0);
  const retainedAlphaHistogram = {}; let retainedBounds = null;
  for (const entry of savedAssignments) for (const index of entry.pixelIndices) {
    const alpha = source.data[index * 4 + 3]; retainedAlphaHistogram[alpha] = (retainedAlphaHistogram[alpha] || 0) + 1;
    const r = { x: index % doc.width, y: Math.floor(index / doc.width), width: 1, height: 1 }; retainedBounds = retainedBounds ? union(retainedBounds, r) : r;
  }
  const lowAlphaCoverage = { ...coverage.summary, sourceFingerprint: fingerprint, addedThisOperation: coverage.weak.length, retainedPixels, retainedAlphaHistogram, retainedBounds, assignments: savedAssignments };
  doc.registration = { ...doc.registration, boundsAdjustments: [...(doc.registration?.boundsAdjustments || []), ...adjustments], lowAlphaCoverage,
    visibleNoise: { weakPixelOwnerPolicy: "nearest-rigid", alphaMax: WEAK_ALPHA_MAX, pixels: retainedPixels, alphaHistogram: retainedAlphaHistogram,
      sourcePixelsDiscarded: 0, meshBoundsChangedForNoise: false } };
  return validateRigDocument(doc);
}

function segmentDistanceSquared(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / Math.max(1e-10, dx * dx + dy * dy)));
  return (x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2;
}
function polygonContains(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (segmentDistanceSquared(x, y, a, b) < 1e-12) return true;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function nearestScore(part, x, y, joints, children) {
  if (part.sourcePolygon) {
    let score = Infinity;
    for (let i = 0; i < part.sourcePolygon.length; i++) score = Math.min(score, segmentDistanceSquared(x, y, part.sourcePolygon[i], part.sourcePolygon[(i + 1) % part.sourcePolygon.length]));
    return score;
  }
  return Math.min(...part.influences.map((id) => {
    const a = joints.get(id), b = children.get(id)?.[0] || joints.get(a.parent) || a;
    return segmentDistanceSquared(x, y, a, b);
  }));
}
function eligibleInterior(source, x, y) {
  if (x < 1 || y < 1 || x + 1 >= source.width || y + 1 >= source.height) return false;
  for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++)
    if (source.data[(yy * source.width + xx) * 4 + 3] < SEMI_OPAQUE) return false;
  return true;
}

async function partImages(doc, env) {
  const images = new Map();
  for (const part of doc.parts) if (part.image) images.set(part.id, await decoded(imageDataBytes(part.image).bytes, env));
  return images;
}
async function registrationBases(doc, images, env) {
  const currentBases = new Set();
  for (const part of doc.parts) if (independentArtwork(part)) {
    const current = images.get(part.id);
    const changed = part.registration?.outputPixelSHA256 ?
      (current.width !== part.registration.outputImageWidth || current.height !== part.registration.outputImageHeight || await sha256(current.data) !== part.registration.outputPixelSHA256) :
      (part.registration?.outputImageSHA256 && await sha256(imageDataBytes(part.image).bytes) !== part.registration.outputImageSHA256);
    if (part.registrationBase && changed) { delete part.registrationBase; delete part.registration; }
    if (!part.registrationBase) {
      part.registrationBase = { image: part.image, ...rectOf(part), imageSource: part.imageSource, completion: "ready" };
      currentBases.add(part.id);
    }
  }
  const imagesById = new Map();
  for (const part of doc.parts) if (part.registrationBase)
    imagesById.set(part.id, part.registrationBase.image === part.image ? images.get(part.id) : await decoded(imageDataBytes(part.registrationBase.image).bytes, env));
  return { imagesById, currentBases };
}
const facialGroup = (part) => part.attachmentGroup && /eye|brow|mouth|眼|眉|嘴|口/.test(`${part.attachmentGroup} ${part.id} ${part.label}`.toLowerCase());
const blankFaceRequired = (doc, part) => {
  const identity = `${part.id} ${part.label}`.toLowerCase();
  return !part.attachmentGroup && /head|face|脸|面部|头部|(?:^|\s)头(?:$|\s)/.test(identity) && !/hair|cap|hat|helmet|gear|发|帽|头饰|冠/.test(identity) &&
    doc.parts.some((feature) => feature.bone === part.bone && facialGroup(feature));
};
function registrationGeometry(doc) {
  return { id: doc.id, width: doc.width, height: doc.height,
    joints: doc.joints.map(({ id, parent, x, y }) => ({ id, parent, x, y })),
    parts: doc.parts.map((part) => ({ id: part.id, bone: part.bone, ...rectOf(part), z: part.z, binding: part.binding,
      influences: part.influences, grip: part.grip || null, mesh: part.mesh || null, attachmentGroup: part.attachmentGroup || null,
      sourcePolygon: part.sourcePolygon || null, baseRect: rectOf(part.registrationBase || part) })),
    defaultAttachments: doc.defaultAttachments || {} };
}
async function completeOverlapPreparation(doc, source, bases) {
  const visible = new Set(resolveRigAttachments(doc).visiblePartIds), parts = [], issues = [];
  for (const part of doc.parts) {
    const base = part.registrationBase || part, image = bases.imagesById.get(part.id), partIssues = [];
    let visiblePixels = 0, transparentPixels = 0, significantPixels = 0;
    if (!independentArtwork(part)) partIssues.push("请先上传或生成已完成的独立透明图片，原图裁片不能作为完整部件。");
    if (image) for (let i = 3; i < image.data.length; i += 4) {
      visiblePixels += image.data[i] > 0; significantPixels += image.data[i] > WEAK_ALPHA_MAX; transparentPixels += image.data[i] === 0;
    }
    if (!significantPixels) partIssues.push("完整底图没有有效可见像素。");
    if (image && !transparentPixels) partIssues.push("完整底图没有透明像素，请检查背景或裁切边界。");
    const imageSHA256 = base.image ? await sha256(imageDataBytes(base.image).bytes) : null;
    const sourceLockForced = blankFaceRequired(doc, part) || Boolean(facialGroup(part));
    const savedParts = doc.registration?.completeOverlapReview?.parts;
    const previousLock = (Array.isArray(savedParts) ? savedParts.find((entry) => entry?.partId === part.id)?.sourceLock : undefined) || part.registration?.sourceLock;
    const sourceLock = sourceLockForced || previousLock === "underlay-only" ? "underlay-only" : "known-source";
    parts.push({ partId: part.id, label: part.label, bone: part.bone, attachmentGroup: part.attachmentGroup || null,
      defaultVisible: visible.has(part.id), image: base.image || null, imageSHA256, rect: rectOf(base), currentRect: rectOf(part),
      sourcePolygon: part.sourcePolygon || null, baseSource: bases.currentBases.has(part.id) ? "current-image" : "registration-base",
      imageSource: base.imageSource || null, requiresBlankFace: blankFaceRequired(doc, part), sourceLock, sourceLockForced,
      alpha: { visiblePixels, transparentPixels, significantPixels, bounds: image ? alphaBounds(image.data, image.width, image.height, WEAK_ALPHA_MAX) : null },
      issues: partIssues });
    issues.push(...partIssues.map((issue) => `${part.label}：${issue}`));
  }
  return { mode: "complete-overlap", sourceFingerprint: await sha256(source.bytes),
    geometryFingerprint: await sha256(new TextEncoder().encode(JSON.stringify(registrationGeometry(doc)))), parts, issues, ready: !issues.length };
}

// Images in this read-only result are the independent underlays, never the
// exclusive registration output or a source crop presented as completed art.
export async function prepareCompleteOverlapReview(document, pixelEnv = browserPixels) {
  const doc = validateRigDocument(document), env = { ...browserPixels, ...pixelEnv }, source = await sourcePixels(doc, env), images = await partImages(doc, env);
  return completeOverlapPreparation(doc, source, await registrationBases(doc, images, env));
}
function checkedCompleteOverlapReview(prepared, review) {
  const reject = (message, diagnostics) => {
    const error = new Error(message); error.code = "RIG_REGISTRATION_COMPLETE_REVIEW"; error.diagnostics = diagnostics; throw error;
  };
  if (!prepared.ready) reject("请先准备所有独立完整部件，再审阅重叠配准。", { issues: prepared.issues });
  if (!review || review.sourceFingerprint !== prepared.sourceFingerprint || review.geometryFingerprint !== prepared.geometryFingerprint)
    reject("立绘、骨架、轮廓、矩形或绑定已改变，请重新审阅完整底图。", { sourceFingerprint: prepared.sourceFingerprint, geometryFingerprint: prepared.geometryFingerprint });
  if (!Array.isArray(review.parts) || review.parts.length !== prepared.parts.length || new Set(review.parts.map((part) => part?.partId)).size !== prepared.parts.length)
    reject("完整重叠配准需要逐件审阅全部基础部件与表情附件。", { requiredPartIds: prepared.parts.map((part) => part.partId) });
  const parts = prepared.parts.map((part) => {
    const entry = review.parts.find((entry) => entry?.partId === part.partId);
    if (!entry || entry.imageSHA256 !== part.imageSHA256 || !["approved", "hiddenReviewed", "isolationReviewed", "sourceMaskReviewed"].every((flag) => entry[flag] === true) ||
        (part.requiresBlankFace && entry.blankFace !== true))
      reject(`请重新审阅 ${part.label} 的完整图、接头、独立性和源轮廓${part.requiresBlankFace ? "，并确认无五官空白脸底" : ""}。`, { partId: part.partId });
    const sourceLock = entry.sourceLock === undefined ? (part.sourceLockForced ? "underlay-only" : "known-source") : entry.sourceLock;
    if (!["known-source", "underlay-only"].includes(sourceLock) || (part.sourceLockForced && sourceLock !== "underlay-only"))
      reject(`部件 ${part.label} 的原图锁定方式无效${part.sourceLockForced ? "，完整脸底和独立五官必须保留底图" : ""}。`, { partId: part.partId, sourceLockForced: part.sourceLockForced });
    return { partId: part.partId, imageSHA256: part.imageSHA256, rect: part.rect, approved: true, hiddenReviewed: true,
      isolationReviewed: true, sourceMaskReviewed: true, sourceLock, ...(part.requiresBlankFace ? { blankFace: true } : {}) };
  });
  return { sourceFingerprint: prepared.sourceFingerprint, geometryFingerprint: prepared.geometryFingerprint, parts };
}
async function composite(doc, source, images, env) {
  const visible = new Set(resolveRigAttachments(doc).visiblePartIds), canvas = env.createCanvas(doc.width, doc.height), context = canvas.getContext("2d");
  for (const part of [...doc.parts].sort((a, b) => a.z - b.z)) if (visible.has(part.id)) {
    const image = images.get(part.id);
    if (image) context.drawImage(image.canvas, part.x, part.y, part.width, part.height);
    else context.drawImage(source.canvas, part.x, part.y, part.width, part.height, part.x, part.y, part.width, part.height);
  }
  return { canvas, data: context.getImageData(0, 0, doc.width, doc.height).data, png: await env.encode(canvas) };
}
function compare(source, assembly) {
  let sourcePixels = 0, assemblyPixels = 0, intersection = 0, unionPixels = 0, missingAlphaPixels = 0, extraAlphaPixels = 0;
  let maxAlphaError = 0, alphaError = 0, pixelError = 0, maxPremultipliedColorError = 0;
  for (let i = 0; i < source.data.length; i += 4) {
    const a = source.data[i + 3], b = assembly.data[i + 3];
    sourcePixels += a > 0; assemblyPixels += b > 0; intersection += a > 0 && b > 0; unionPixels += a > 0 || b > 0;
    missingAlphaPixels += a > 0 && b === 0; extraAlphaPixels += a === 0 && b > 0;
    const alpha = Math.abs(a - b); alphaError += alpha; maxAlphaError = Math.max(maxAlphaError, alpha);
    for (let c = 0; c < 3; c++) {
      const error = Math.abs(source.data[i + c] * a - assembly.data[i + c] * b) / 255;
      pixelError += error; maxPremultipliedColorError = Math.max(maxPremultipliedColorError, error);
    }
  }
  return { sourcePixels, assemblyPixels, alphaIoU: unionPixels ? intersection / unionPixels : 1, missingAlphaPixels, extraAlphaPixels,
    maxAlphaError, alphaMAE: alphaError / (source.data.length / 4), maxPremultipliedColorError, pixelMAE: pixelError / (source.data.length / 4 * 3) };
}

export async function measureRigSourceRegistration(document, pixelEnv = browserPixels) {
  const doc = validateRigDocument(document), env = { ...browserPixels, ...pixelEnv }, source = await sourcePixels(doc, env);
  const assembly = await composite(doc, source, await partImages(doc, env), env);
  return { metrics: compare(source, assembly), preview: { width: doc.width, height: doc.height, png: assembly.png } };
}

export async function registerRigSourcePixels(document, { polygons = {}, jobId, gridSize = 32, maxBBoxExpansion = 2, sourceFingerprint, mode = "exclusive", review } = {}, pixelEnv = browserPixels) {
  const doc = documentWithPolygons(document, polygons), env = { ...browserPixels, ...pixelEnv };
  if (!["exclusive", "complete-overlap"].includes(mode)) throw new Error("未知的原图配准模式。");
  const complete = mode === "complete-overlap";
  if (!Number.isInteger(gridSize) || gridSize < 1 || gridSize > 512) throw new Error("原图坐标网格尺寸无效。");
  const selection = resolveRigAttachments(doc), active = new Set(selection.visiblePartIds);
  const unfinished = doc.parts.filter((part) => active.has(part.id) && !independentArtwork(part)).map((part) => part.id);
  if (unfinished.length) {
    const error = new Error(`请先完成默认可见部件的独立补绘或上传，原图裁片不能代替隐藏补绘：${unfinished.join("、")}`);
    error.code = "RIG_REGISTRATION_ARTWORK"; error.diagnostics = { incompletePartIds: unfinished }; throw error;
  }
  const inspection = inspectRegistrationBounds(doc, {}, { maxBBoxExpansion });
  if (!inspection.canApply) {
    const failed = inspection.parts.filter((part) => part.exceedsLimit), error = new Error(`原图轮廓超出当前部件矩形，请先明确扩展：${failed.map((part) => part.partId).join("、")}`);
    error.code = "RIG_REGISTRATION_BOUNDS"; error.diagnostics = inspection; throw error;
  }
  const source = await sourcePixels(doc, env), fingerprint = await sha256(source.bytes);
  if (sourceFingerprint && sourceFingerprint !== fingerprint) throw new Error("原图已改变，坐标轮廓不属于当前立绘。");
  const images = await partImages(doc, env), bases = await registrationBases(doc, images, env), baseImages = bases.imagesById;
  const completeReview = complete ? checkedCompleteOverlapReview(await completeOverlapPreparation(doc, source, bases), review) : null;
  if (!complete) for (const part of doc.parts) if (part.registration?.mode === "complete-overlap")
    for (const key of ["mode", "preservedPixels", "visiblePreservedPixels", "retainedOutsideSourcePixels", "protectedFacePixels", "fallbackOwnedPixels", "sourceLockPolicy", "sourceLock", "policySuppressedPixels"]) delete part.registration[key];
  const emptyArtwork = doc.parts.filter((part) => {
    if (!active.has(part.id)) return false;
    const image = images.get(part.id);
    return !alphaBounds(image.data, image.width, image.height);
  }).map((part) => part.id);
  if (emptyArtwork.length) {
    const error = new Error(`独立补绘图片完全透明，不能用原图裁片替代：${emptyArtwork.join("、")}`);
    error.code = "RIG_REGISTRATION_ARTWORK"; error.diagnostics = { incompletePartIds: emptyArtwork }; throw error;
  }
  const before = compare(source, await composite(doc, source, images, env));
  const ordered = [...doc.parts].sort((a, b) => a.z - b.z);
  const ranks = new Map(ordered.map((part, i) => [part.id, i])), activeParts = ordered.filter((part) => active.has(part.id)), partIds = doc.parts.map((part) => part.id);
  const indices = new Map(partIds.map((id, i) => [id, i])), joints = new Map(doc.joints.map((joint) => [joint.id, joint])), children = new Map(doc.joints.map((joint) => [joint.id, []]));
  for (const joint of doc.joints) if (joint.parent) children.get(joint.parent).push(joint);
  const cols = Math.ceil(doc.width / gridSize), rows = Math.ceil(doc.height / gridSize), grid = Array.from({ length: cols * rows }, () => []);
  for (const part of activeParts) {
    const r = pixelRect(part);
    for (let gy = Math.max(0, Math.floor((r.y - maxBBoxExpansion) / gridSize)); gy <= Math.min(rows - 1, Math.floor((r.y + r.height + maxBBoxExpansion) / gridSize)); gy++)
      for (let gx = Math.max(0, Math.floor((r.x - maxBBoxExpansion) / gridSize)); gx <= Math.min(cols - 1, Math.floor((r.x + r.width + maxBBoxExpansion) / gridSize)); gx++) grid[gy * cols + gx].push(part);
  }
  const owners = new Int16Array(doc.width * doc.height); owners.fill(-1);
  const knownOwners = complete ? new Uint8Array(owners.length) : null;
  const weakOwners = new Map(), weakCoverage = doc.registration?.lowAlphaCoverage;
  if (weakCoverage?.sourceFingerprint === fingerprint && weakCoverage.weakPixelOwnerPolicy === "nearest-rigid") for (const entry of weakCoverage.assignments || []) {
    const part = doc.parts.find((candidate) => candidate.id === entry.partId && active.has(candidate.id) && candidate.binding === "rigid" && !candidate.attachmentGroup);
    if (!part) continue;
    for (const index of entry.pixelIndices || []) if (Number.isInteger(index) && index >= 0 && index < owners.length && source.data[index * 4 + 3] > 0 && source.data[index * 4 + 3] <= WEAK_ALPHA_MAX &&
      contains(pixelRect(part), index % doc.width + .5, Math.floor(index / doc.width) + .5)) weakOwners.set(index, part);
  }
  const ownedBounds = new Map(), visibleOwnedBounds = new Map(), knownOwnedCounts = new Map(), ownership = { polygonPixels: 0, fallbackPixels: 0, boneFallbackPixels: 0, bboxFallbackPixels: 0 };
  let missingPixels = 0, missingBounds = null;
  for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) {
    const p = y * doc.width + x; if (!source.data[p * 4 + 3]) continue;
    const candidates = grid[Math.floor(y / gridSize) * cols + Math.floor(x / gridSize)], px = x + .5, py = y + .5;
    let owner = weakOwners.get(p), known = owner ? 2 : 0;
    if (!owner) for (const part of candidates) if (part.sourcePolygon && polygonContains(part.sourcePolygon, px, py)) { owner = part; known = 1; }
    if (owner) { if (weakOwners.has(p)) ownership.fallbackPixels++; else ownership.polygonPixels++; }
    else {
      let available = candidates.filter((part) => contains(pixelRect(part), px, py));
      if (!available.length) {
        available = candidates.filter((part) => { const r = pixelRect(part); return px >= r.x - maxBBoxExpansion && py >= r.y - maxBBoxExpansion && px < r.x + r.width + maxBBoxExpansion && py < r.y + r.height + maxBBoxExpansion; });
        if (available.length) ownership.bboxFallbackPixels++;
      }
      let score = Infinity;
      for (const part of available) {
        const value = nearestScore(part, px, py, joints, children);
        if (value <= score + 1e-10) { score = value; owner = part; }
      }
      if (owner) { ownership.fallbackPixels++; if (!owner.sourcePolygon) ownership.boneFallbackPixels++; }
    }
    if (!owner) { missingPixels++; const point = { x, y, width: 1, height: 1 }; missingBounds = missingBounds ? union(missingBounds, point) : point; continue; }
    owners[p] = indices.get(owner.id);
    if (knownOwners) {
      knownOwners[p] = known;
      if (known) knownOwnedCounts.set(owner.id, (knownOwnedCounts.get(owner.id) || 0) + 1);
    }
    const old = ownedBounds.get(owner.id), point = { x, y, width: 1, height: 1 };
    ownedBounds.set(owner.id, old ? union(old, point) : point);
    if (source.data[p * 4 + 3] > WEAK_ALPHA_MAX) {
      const visible = visibleOwnedBounds.get(owner.id);
      visibleOwnedBounds.set(owner.id, visible ? union(visible, point) : point);
    }
  }
  if (missingPixels) {
    const alphaHistogram = {};
    for (let i = 0; i < owners.length; i++) if (owners[i] === -1 && source.data[i * 4 + 3]) { const alpha = source.data[i * 4 + 3]; alphaHistogram[alpha] = (alphaHistogram[alpha] || 0) + 1; }
    const error = new Error(`有 ${missingPixels} 个原图可见像素不在任何默认部件矩形内，请修正轮廓或明确扩展矩形。`);
    error.code = "RIG_REGISTRATION_GAP"; error.diagnostics = { missingPixels, missingBounds, alphaHistogram }; throw error;
  }
  const partDiagnostics = [], rectAdjustments = [], alignment = [], pendingVariants = [], emptyParts = [], completeParts = []; let hiddenPixels = 0;
  for (const part of doc.parts) {
    const original = rectOf(part), base = part.registrationBase || part, image = baseImages.get(part.id) || images.get(part.id), native = image && alphaBounds(image.data, image.width, image.height, 8), allAlpha = image && alphaBounds(image.data, image.width, image.height);
    const aiGlobal = native && { x: base.x + native.x * base.width / image.width, y: base.y + native.y * base.height / image.height,
      width: native.width * base.width / image.width, height: native.height * base.height / image.height };
    const locked = ownedBounds.get(part.id) || null, visibleLocked = visibleOwnedBounds.get(part.id) || null;
    partDiagnostics.push({ partId: part.id, defaultVisible: active.has(part.id), sourceVisibleBounds: visibleLocked, sourceAllAlphaBounds: locked, aiAlphaBounds: native || null,
      aiAllAlphaBounds: allAlpha || null, aiGlobalAlphaBounds: aiGlobal || null, currentBounds: original, baseBounds: rectOf(base),
      aiToSourceWidthRatio: visibleLocked && aiGlobal ? aiGlobal.width / visibleLocked.width : null,
      aiToSourceHeightRatio: visibleLocked && aiGlobal ? aiGlobal.height / visibleLocked.height : null,
      aiCenterOffset: visibleLocked && aiGlobal ? { x: aiGlobal.x + aiGlobal.width / 2 - visibleLocked.x - visibleLocked.width / 2,
        y: aiGlobal.y + aiGlobal.height / 2 - visibleLocked.y - visibleLocked.height / 2 } : null });
    if (!active.has(part.id) && !complete) continue;
    const reviewedPart = complete && completeReview.parts.find((entry) => entry.partId === part.id);
    const blankFace = complete && reviewedPart.blankFace === true;
    const facialAttachment = complete && Boolean(facialGroup(part)), preserveFacialUnderlay = blankFace || facialAttachment;
    const sourceLock = complete ? reviewedPart.sourceLock : "known-source", underlayOnly = sourceLock === "underlay-only";
    const sourceLockPolicy = preserveFacialUnderlay ? "disabled-preserve-independent-facial-underlay" : underlayOnly ? "disabled-preserve-independent-underlay" : "reviewed-source-pixels";
    let next = !underlayOnly && locked ? union(pixelRect(part), locked) : pixelRect(part);
    if (complete) next = union(next, pixelRect(base));
    const canvas = env.createCanvas(next.width, next.height), context = canvas.getContext("2d");
    if (image) context.drawImage(image.canvas, base.x - next.x, base.y - next.y, base.width, base.height);
    const result = context.getImageData(0, 0, next.width, next.height);
    let partHidden = 0, partLocked = 0, visibleLockedPixels = 0, visibleHiddenPixels = 0, preservedPixels = 0, visiblePreservedPixels = 0, retainedOutsideSourcePixels = 0, fallbackOwnedPixels = 0;
    const protectedFacePixels = preserveFacialUnderlay ? knownOwnedCounts.get(part.id) || 0 : 0;
    const policySuppressedPixels = underlayOnly ? knownOwnedCounts.get(part.id) || 0 : 0;
    for (let y = 0; y < next.height; y++) for (let x = 0; x < next.width; x++) {
      const global = (y + next.y) * doc.width + x + next.x, offset = (y * next.width + x) * 4, owner = owners[global];
      if (owner === indices.get(part.id) && (!complete || knownOwners[global]) && !underlayOnly) {
        result.data.set(source.data.subarray(global * 4, global * 4 + 4), offset); partLocked++; visibleLockedPixels += source.data[global * 4 + 3] > WEAK_ALPHA_MAX;
      }
      else if (complete) {
        // Full independent artwork is a support surface, not an exclusive
        // segmentation matte. Never erase its real joints or hidden shape.
        if (result.data[offset + 3]) {
          preservedPixels++; visiblePreservedPixels += result.data[offset + 3] > WEAK_ALPHA_MAX;
          retainedOutsideSourcePixels += source.data[global * 4 + 3] === 0;
          if (owner >= 0 && ranks.get(partIds[owner]) > ranks.get(part.id)) {
            partHidden++; visibleHiddenPixels += result.data[offset + 3] > WEAK_ALPHA_MAX;
          }
        }
        fallbackOwnedPixels += owner === indices.get(part.id) && !knownOwners[global];
      }
      else if (owner >= 0 && ranks.get(partIds[owner]) > ranks.get(part.id) && eligibleInterior(source, x + next.x, y + next.y)) {
        if (result.data[offset + 3]) partHidden++;
        visibleHiddenPixels += result.data[offset + 3] > WEAK_ALPHA_MAX;
      } else result.data.fill(0, offset, offset + 4);
    }
    context.putImageData(result, 0, 0); const outputBytes = await env.encode(canvas); part.image = imageDataURL(outputBytes);
    if (!sameRect(original, next)) rectAdjustments.push(moveRect(part, next));
    if (part.imageSource === "ai" && !part.imageGeneration) part.imageGeneration = { source: "ai" };
    part.imageSource = "calibrated";
    part.registration = { ...part.registration, lockedPixels: partLocked, visibleLockedPixels, hiddenPixels: partHidden, visibleHiddenPixels, sourceFingerprint: fingerprint,
      outputImageSHA256: await sha256(outputBytes), outputPixelSHA256: await sha256(context.getImageData(0, 0, next.width, next.height).data),
      outputImageWidth: next.width, outputImageHeight: next.height,
      ...(complete ? { mode, preservedPixels, visiblePreservedPixels, retainedOutsideSourcePixels, protectedFacePixels, fallbackOwnedPixels, sourceLockPolicy, sourceLock, policySuppressedPixels } : {}) };
    if (!visibleLockedPixels && !(complete ? visiblePreservedPixels : visibleHiddenPixels)) emptyParts.push({ partId: part.id, ...part.registration });
    if (complete) completeParts.push({ partId: part.id, defaultVisible: active.has(part.id), lockedPixels: partLocked, visibleLockedPixels,
      preservedPixels, visiblePreservedPixels, hiddenPixels: partHidden, retainedOutsideSourcePixels, protectedFacePixels, fallbackOwnedPixels,
      blankFace, facialAttachment, sourceLockPolicy, sourceLock, policySuppressedPixels, underlayImageSHA256: reviewedPart.imageSHA256 });
    hiddenPixels += partHidden;
  }
  if (emptyParts.length) {
    const error = new Error(`这些默认部件既没有可见原图像素，也没有有效隐藏补绘，请修正轮廓或独立底图：${emptyParts.map((part) => part.partId).join("、")}`);
    error.code = "RIG_REGISTRATION_EMPTY_PART"; error.diagnostics = { parts: emptyParts }; throw error;
  }
  for (const part of doc.parts) if (!complete && part.attachmentGroup && !active.has(part.id)) {
    const neutralId = selection.attachmentSelection[part.attachmentGroup], target = visibleOwnedBounds.get(neutralId), image = baseImages.get(part.id) || images.get(part.id), native = image && alphaBounds(image.data, image.width, image.height, 8);
    if (!target || !native || !independentArtwork(part)) { pendingVariants.push(part.id); continue; }
    const scale = target.width / native.width, center = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    const imageX = center.x - (native.x + native.width / 2) * scale, imageY = center.y - (native.y + native.height / 2) * scale;
    const visibleBounds = { x: imageX + native.x * scale, y: imageY + native.y * scale, width: native.width * scale, height: native.height * scale };
    if (visibleBounds.x < -1e-6 || visibleBounds.y < -1e-6 || visibleBounds.x + visibleBounds.width > doc.width + 1e-6 || visibleBounds.y + visibleBounds.height > doc.height + 1e-6) {
      const error = new Error(`表情 ${part.id} 等比对齐后超出立绘画布，不能静默裁掉或压扁。`);
      error.code = "RIG_REGISTRATION_VARIANT_BOUNDS"; error.diagnostics = { partId: part.id, requiredBounds: visibleBounds }; throw error;
    }
    const extent = { x: Math.max(0, Math.floor(imageX)), y: Math.max(0, Math.floor(imageY)),
      width: Math.min(doc.width, Math.ceil(imageX + image.width * scale)) - Math.max(0, Math.floor(imageX)),
      height: Math.min(doc.height, Math.ceil(imageY + image.height * scale)) - Math.max(0, Math.floor(imageY)) };
    const next = union(pixelRect(part), extent), canvas = env.createCanvas(next.width, next.height);
    canvas.getContext("2d").drawImage(image.canvas, imageX - next.x, imageY - next.y, image.width * scale, image.height * scale);
    const outputBytes = await env.encode(canvas); part.image = imageDataURL(outputBytes);
    part.registration = { ...part.registration, outputImageSHA256: await sha256(outputBytes), sourceFingerprint: fingerprint,
      outputPixelSHA256: await sha256(canvas.getContext("2d").getImageData(0, 0, next.width, next.height).data), outputImageWidth: next.width, outputImageHeight: next.height };
    if (!sameRect(rectOf(part), next)) rectAdjustments.push(moveRect(part, next));
    alignment.push({ partId: part.id, neutralPartId: neutralId, scale, center, aspectRatioPreserved: true,
      sourceNeutralBounds: target, alignedWidth: native.width * scale, alignedHeight: native.height * scale });
  }
  const assembly = await composite(doc, source, await partImages(doc, env), env), after = compare(source, assembly);
  const ownerPixels = new Uint8ClampedArray(owners.length * 4);
  for (let i = 0; i < owners.length; i++) if (owners[i] >= 0 && (!complete || knownOwners[i]))
    ownerPixels.set([((owners[i] + 1) * 67) % 251 + 4, ((owners[i] + 1) * 109) % 251 + 4, ((owners[i] + 1) * 149) % 251 + 4, 255], i * 4);
  const metrics = { ...after, before, after, ...ownership, hiddenPixels, semiOpaqueThreshold: SEMI_OPAQUE, hiddenEdgeInsetPixels: 1,
    ownedPixels: ownership.polygonPixels + ownership.fallbackPixels, defaultVisiblePartIds: selection.visiblePartIds,
    partDiagnostics, alignedVariants: alignment, pendingVariants, compositor: "cpu-canvas-source-over",
    weakPixelOwnerPolicy: weakCoverage?.weakPixelOwnerPolicy || null, weakPixelAssignments: weakOwners.size };
  if (complete) {
    let knownOwnerPixels = 0, knownPolygonPixels = 0, explicitWeakPixels = 0, unassignedSourcePixels = 0;
    for (let i = 0; i < knownOwners.length; i++) if (source.data[i * 4 + 3]) {
      knownOwnerPixels += knownOwners[i] > 0; knownPolygonPixels += knownOwners[i] === 1; explicitWeakPixels += knownOwners[i] === 2; unassignedSourcePixels += knownOwners[i] === 0;
    }
    const total = (field) => completeParts.reduce((sum, part) => sum + part[field], 0), lockedPixels = total("lockedPixels");
    metrics.completeOverlap = { mode, sourceFingerprint: fingerprint, geometryFingerprint: completeReview.geometryFingerprint,
      knownOwnerPixels, knownPolygonPixels, explicitWeakPixels, unassignedSourcePixels, fallbackPixels: ownership.fallbackPixels,
      lockedPixels, sourceLockCoverage: after.sourcePixels ? lockedPixels / after.sourcePixels : 1,
      preservedPixels: total("preservedPixels"), retainedOutsideSourcePixels: total("retainedOutsideSourcePixels"),
      protectedFacePixels: total("protectedFacePixels"), parts: completeParts,
      policySuppressedPixels: total("policySuppressedPixels"),
      underlayOnlyPartIds: completeParts.filter((part) => part.sourceLock === "underlay-only").map((part) => part.partId),
      knownSourcePartIds: completeParts.filter((part) => part.sourceLock === "known-source").map((part) => part.partId),
      preservedVariantIds: doc.parts.filter((part) => part.attachmentGroup && !active.has(part.id)).map((part) => part.id),
      hiddenSurfaceVerification: "human-reviewed", runtimeMotionVerification: "not-evaluated", requiresVisualReview: true,
      sourceLockPolicy: "per-part-reviewed-source-or-underlay-only", faceSourceLockPolicy: "disabled-preserve-complete-blank-face-and-independent-facial-attachments",
      fallbackPolicy: "reported-not-copied", hiddenSurfacePolicy: "preserve-independent-underlay" };
  }
  if (!complete && doc.registration) { delete doc.registration.mode; delete doc.registration.completeOverlapReview; }
  doc.registration = { ...doc.registration, sourceFingerprint: fingerprint, ...(jobId ? { jobId } : {}), gridSize, metrics, rectAdjustments,
    ownerMapSHA256: await sha256(new Uint8Array(owners.buffer)), ...(complete ? { mode, completeOverlapReview: completeReview } : {}) };
  return { document: validateRigDocument(doc), metrics, ownerMap: { width: doc.width, height: doc.height, partIds, owners,
    ...(complete ? { knownOwners, policy: "reviewed-source-only" } : {}),
    png: await env.encode(canvasFromData(ownerPixels, doc.width, doc.height, env)) }, preview: { width: doc.width, height: doc.height, png: assembly.png } };
}

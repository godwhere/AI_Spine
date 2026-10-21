import { assertProductionGate, productionChecks, productionFingerprint, productionPrompt, productionStageIssues, validateProduction } from "../../shared/domain/production.mjs";
import { rigSourceFingerprint, rigSourceRequest } from "../../shared/domain/generation.mjs";
import { sha256 } from "../../shared/codec/sha256.mjs";
import { imageDataBytes } from "../../shared/codec/image-data.mjs";
import { unpackZip } from "../../engine/archive/zip.js";
import { parseBundle } from "../../engine/archive/bundle.js";
import { readRigAuthoring, attachRigAuthoring } from "../../engine/archive/rig-project.js";
import { compileRigSkeleton } from "../../engine/rig/compile.js";
import { validateRigDraftDocument } from "../../shared/domain/draft.mjs";
import { validateRigDocument } from "../../shared/rig-schema.mjs";

export function includeMotionInProduction(document, motion, boardId) {
  const production = document.production;
  if (!production || production.motions.some((item) => item.id === motion.id)) return document;
  return { ...document, production: { ...production,
    motions: [...production.motions, { id: motion.id, name: motion.name, duration: motion.duration, loop: motion.loop,
      script: motion.description || "", expression: "", contacts: "", ending: "" }],
    boards: [...production.boards, { id: boardId, motionId: motion.id, label: `${motion.name}主姿势`,
      time: motion.duration / 2, prompt: "", reuseBase: false }],
  } };
}

export function confirmProduction(document, stage, id, checks, at) {
  document = validateRigDraftDocument(document);
  if (!document.production || !productionChecks[stage]) throw new Error("请先建立制作计划。");
  const issues = productionStageIssues(document, stage, id);
  if (stage === "board") {
    const b = document.production.boards.find((b) => b.id === id);
    if (!b || !(b.reuseBase ? document.sourceImage : b.image)) issues.push("请先提供这张关键画面。");
  }
  if (stage === "motion" && document.motions.find((m) => m.id === id)?.origin === "manual-placeholder") issues.push("请先完成当前动画。");
  if (issues.length) throw new Error(issues[0]);
  if (!Array.isArray(checks) || !productionChecks[stage].every((text) => checks.includes(text))) throw new Error("请逐项检查当前画面后确认。");
  const review = { fingerprint: productionFingerprint(document, stage, id), checks: [...productionChecks[stage]], at };
  const reviews = { ...document.production.reviews };
  if (stage === "board" || stage === "motion") {
    const key = stage === "board" ? "boards" : "motions";
    reviews[key] = { ...reviews[key], [id]: review };
  } else reviews[stage] = review;
  const next = { ...document, production: { ...document.production, reviews } };
  validateProduction(next);
  return next;
}

export function productionReferenceRequest(document, id) {
  assertProductionGate(document, "reference");
  const b = document.production.boards.find((b) => b.id === id);
  if (!b || b.reuseBase) throw new Error("复用设定图的画面不需要重复生成。");
  if (!b.prompt?.trim()) throw new Error("请描述这张关键画面的姿势、表情和接触。");
  return { version: 1, kind: "appearance", projectId: document.id, name: `${document.name} · ${b.label}`, rig: document,
    image: rigSourceRequest(document), prompt: productionPrompt(document, "reference", id),
    referenceTarget: id, referenceFingerprint: productionFingerprint(document, "board-request", id) };
}
export function recordProductionRequest(document, id, job) {
  if (job.projectId !== document.id || job.referenceTarget !== id || job.referenceFingerprint !== productionFingerprint(document, "board-request", id)) throw new Error("草稿已改变，生成记录不再对应当前分镜。");
  return { ...document, production: { ...document.production, boards: document.production.boards.map((b) => b.id === id ? { ...b, pending: { jobId: job.id, fingerprint: job.referenceFingerprint } } : b) } };
}
export async function prepareProductionReference(document, job, loadImage, readImage) {
  assertProductionGate(document, "reference");
  const b = document.production.boards.find((b) => b.id === job.referenceTarget), candidate = (job.result?.images || job.images || [])[0];
  if (!b || b.reuseBase || job.projectId !== document.id || b.pending?.jobId !== job.id || !candidate || job.status !== "completed" ||
    b.pending.fingerprint !== productionFingerprint(document, "board-request", b.id) || job.referenceFingerprint !== b.pending.fingerprint ||
    job.prompt !== productionPrompt(document, "reference", b.id) || job.sourceFingerprint !== await rigSourceFingerprint(document))
    throw new Error("分镜候选与当前图片、说明或目标不一致，未应用。");
  const bytes = await loadImage(job.id, candidate), image = await readImage(bytes, { requireTransparent: true, maxDimension: 4096 });
  return { document, boardId: b.id, jobId: job.id, imageId: candidate.id, bytes, image };
}
export async function prepareStoredProductionReference(document, id, readImage) {
  assertProductionGate(document, "reference");
  const board = document.production.boards.find((b) => b.id === id);
  if (!board?.image || board.reuseBase) throw new Error("请先选择独立关键图。");
  const bytes = imageDataBytes(board.nativeImage || board.image).bytes;
  const image = await readImage(bytes, { requireTransparent: true, maxDimension: 4096 });
  return { document, boardId: id, jobId: board.jobId, imageId: board.imageId, bytes, image, stored: true,
    transform: board.nativeImage ? board.calibration : undefined };
}
export function withProductionReference(document, prepared, image, nativeImage, transform) {
  if (document !== prepared.document || !prepared.stored && document.production.boards.find((b) => b.id === prepared.boardId)?.pending?.jobId !== prepared.jobId) throw new Error("当前分镜或候选已改变，校准尚未应用。");
  return { ...document, production: { ...document.production, boards: document.production.boards.map((b) => {
    if (b.id !== prepared.boardId) return b;
    const next = { ...b, image, ...(nativeImage ? { nativeImage, calibration: transform } : {}), jobId: prepared.jobId, imageId: prepared.imageId, origin: prepared.stored ? b.origin : transform ? "ai-reference-calibrated" : "ai-reference" };
    if (!nativeImage) { delete next.nativeImage; delete next.calibration; }
    delete next.pending; return next;
  }) } };
}
export async function applyProductionReference(document, job, loadImage, readImage) {
  const prepared = await prepareProductionReference(document, job, loadImage, readImage);
  if (prepared.image.width !== undefined && (prepared.image.width !== document.width || prepared.image.height !== document.height)) throw new Error("请先校准原生关键图到设定画布。");
  return withProductionReference(document, prepared, prepared.image.dataURL);
}

const canonical = (value) => JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
function withoutDelivery(document) {
  const copy = structuredClone(document);
  if (copy.production) copy.production.delivery = {};
  return copy;
}
export function verifyProductionPackage(document, currentBundle, bytes, kind, fileName) {
  document = validateRigDocument(document);
  assertProductionGate(document, "export");
  if (!["runtime", "project"].includes(kind)) throw new Error("请选择运行时或可编辑验收包。");
  const files = unpackZip(bytes), editable = Boolean(files[".ai-spine/project.json"]);
  if (editable !== (kind === "project")) throw new Error("上传的验收包类型不匹配。");
  // Editable imports normally restore their originals. Inspect both that view
  // and the actual top-level runtime files, so stale originals cannot hide a
  // damaged exported skeleton, atlas, or PNG.
  const bundles = [parseBundle(files)];
  if (editable) bundles.push(parseBundle(Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith(".ai-spine/")))));
  for (const bundle of bundles) {
    const authored = readRigAuthoring(bundle.files);
    if (!authored || canonical(withoutDelivery(authored)) !== canonical(withoutDelivery(document)) || Object.keys(bundle.edits || {}).length) throw new Error("验收包的角色、计划、参考图或作者数据与当前草稿不同。");
    if (canonical(bundle.json) !== canonical(JSON.parse(JSON.stringify(compileRigSkeleton(document))))) throw new Error("验收包的实际骨架或动画与当前草稿不同。");
    if (bundle.parts.length !== currentBundle.parts.length || bundle.pages.length !== currentBundle.pages.length) throw new Error("验收包缺少部件或贴图页。");
    for (const [path, expected] of Object.entries(currentBundle.files)) if (/\.(png|atlas)$/i.test(path) && (!bundle.files[path] || sha256(bundle.files[path]) !== sha256(expected))) throw new Error("验收包贴图像素或 Atlas 映射与当前草稿不同。");
  }
  const receipt = { snapshot: productionFingerprint(document, "delivery"), archive: sha256(bytes), fileName: String(fileName || "verified.zip").slice(0, 240) };
  return { ...document, production: { ...document.production, delivery: { ...document.production.delivery, [kind]: receipt } } };
}
export function productionExportBundle(document, bundle) {
  return { ...bundle, files: attachRigAuthoring(bundle.files, document) };
}

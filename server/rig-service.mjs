import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateRigDocument, validateRigMotion, validateRigSourcePolygon } from "../shared/rig-schema.mjs";
import { generateStructured, validateStructured } from "./codex-structured.mjs";
import { structureSchema, structurePrompt, motionSchema, motionPrompt, rigPartPrompt, RIG_PART_IMAGE_INSTRUCTIONS,
  appearancePrompt, RIG_APPEARANCE_IMAGE_INSTRUCTIONS, registrationSchema, registrationPrompt } from "./rig-planning.mjs";
import { MOTION_STUDY_KINDS, prepareMotionStudyRequest, saveMappingFrames, generateMotionFrames, mapMotionPoses } from "./rig-motion-study.mjs";

const ACTIVE = new Set(["queued", "analyzing", "generating"]), ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const KINDS = new Set(["appearance", "structure", "registration", "motion", "parts", ...MOTION_STUDY_KINDS]);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const checkPNGSize = (bytes) => {
  if (bytes.subarray(0, 8).equals(PNG) && bytes.length >= 24 &&
    (bytes.readUInt32BE(16) > 4096 || bytes.readUInt32BE(20) > 4096)) throw new Error("图片画布需在 4096 × 4096 以内。");
};
const string = (value, maximum, label, required = false) => {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.trim().length > maximum || (required && !value.trim())) throw new Error(`${label}无效。`);
  return value.trim();
};
const base64 = (value) => {
  if (typeof value !== "string" || value.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("参考图片无效或超过 18 MB。");
  return Buffer.from(value, "base64");
};
const dataImage = (value) => {
  const match = typeof value === "string" && value.match(/^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error("请提供 PNG、JPEG 或 WebP 立绘。");
  return base64(match[1]);
};
export function rigGeometry(rig) {
  return { width: rig.width, height: rig.height,
    joints: rig.joints.map(({ id, parent, x, y }) => ({ id, parent, x, y })),
    parts: rig.parts.map(({ id, bone, x, y, width, height, z, binding, influences, grip, mesh, attachmentGroup }) =>
      ({ id, bone, x, y, width, height, z, binding, influences, grip: grip || null, mesh: mesh || null, attachmentGroup: attachmentGroup || null })),
    defaultAttachments: rig.defaultAttachments || {} };
}
const fingerprint = (geometry) => createHash("sha256").update(JSON.stringify(geometry)).digest("hex");
function defaultVisiblePartIds(rig) {
  const selected = new Map();
  for (const part of rig.parts) if (part.attachmentGroup && !selected.has(part.attachmentGroup))
    selected.set(part.attachmentGroup, Object.hasOwn(rig.defaultAttachments || {}, part.attachmentGroup) ? rig.defaultAttachments[part.attachmentGroup] : part.id);
  return rig.parts.filter((part) => !part.attachmentGroup || selected.get(part.attachmentGroup) === part.id).map((part) => part.id);
}
async function saveMotionPlanningReferences(request, folder) {
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
async function registrationGrid(request, folder) {
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
function registrationResult(request, value) {
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

async function restoreSourceIdentity(root, job) {
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

async function sourceImage(input, rig) {
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
function publicJob(job, includeResult = true) {
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

export class RigJobs {
  constructor({ root, rpc, connections, plan = generateStructured } = {}) {
    this.root = resolve(root); this.rpc = rpc; this.connections = connections; this.plan = plan;
    this.jobs = new Map(); this.writes = new Map(); this.creating = new Set(); this.loading = this.restore();
  }
  isBusy() { return this.creating.size > 0 || [...this.jobs.values()].some((job) => ACTIVE.has(job.status)); }
  async restore() {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[\w-]{36}$/.test(entry.name)) continue;
      try {
        const job = JSON.parse(await readFile(join(this.root, entry.name, "job.json"), "utf8"));
        if (job.id !== entry.name || !KINDS.has(job.request?.kind)) continue;
        let changed = await restoreSourceIdentity(this.root, job).catch(() => false);
        if (ACTIVE.has(job.status)) { job.status = "failed"; job.stage = "failed"; job.error = "本地服务已重启，上次生成、分析或补绘已中断。已完成图片仍可检查，请明确重新提交剩余工作。"; changed = true; }
        if (changed) await this.persist(job);
        this.jobs.set(job.id, job);
      } catch { /* An incomplete manifest is never presented as a completed analysis. */ }
    }
  }
  async persist(job) {
    job.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify({ ...job, controller: undefined });
    const pending = (this.writes.get(job.id) || Promise.resolve()).catch(() => {}).then(async () => {
      const folder = join(this.root, job.id); await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "job.json.tmp"), snapshot, { mode: 0o600 });
      await rename(join(folder, "job.json.tmp"), join(folder, "job.json"));
    });
    this.writes.set(job.id, pending); await pending;
    if (this.writes.get(job.id) === pending) this.writes.delete(job.id);
  }
  async create(input, snapshot) {
    await this.loading;
    if (this.closed) throw new Error("分析服务已关闭。");
    if (!input || input.version !== 1 || !KINDS.has(input.kind) || !ID.test(input.projectId || "")) throw new Error("骨架任务或工程标识无效。");
    if (this.creating.has(input.projectId) || [...this.jobs.values()].some((job) => ACTIVE.has(job.status) && job.request.projectId === input.projectId)) throw new Error("这个工程已有进行中的分析或补绘，请等待或先取消。");
    this.creating.add(input.projectId);
    try {
    const request = { version: 1, kind: input.kind, projectId: input.projectId,
      name: string(input.name || input.rig?.name || "我的角色", 160, "角色名称", true), prompt: string(input.prompt, 4000, "分析或补绘要求") };
    if (input.kind === "structure") {
      request.detail = input.detail ?? "standard";
      if (!["standard", "detailed"].includes(request.detail)) throw new Error("请选择标准或精细结构拆分。");
    }
    if (["registration", "motion", "parts"].includes(input.kind) || MOTION_STUDY_KINDS.has(input.kind)) request.rig = validateRigDocument(input.rig);
    // New studies freeze the caller's exact authored JSON after validation. Normalizing
    // optional defaults must not silently change the protected idle fingerprint.
    if (MOTION_STUDY_KINDS.has(input.kind)) request.rig = structuredClone(input.rig);
    if (input.kind === "registration" && input.projectId !== request.rig.id) throw new Error("原图坐标规划与当前工程标识不一致。");
    const source = await sourceImage(input.kind === "registration" ? { ...input, image: undefined } : input, request.rig);
    if (input.kind !== "motion" && !source) throw new Error("请先导入角色立绘。");
    if (source) { request.width = source.width; request.height = source.height; request.sourceFingerprint = snapshot?.sourceFingerprint || source.sourceFingerprint; }
    if (MOTION_STUDY_KINDS.has(input.kind)) {
      if (!input.image || !source.bytes.subarray(0, 8).equals(PNG) || !base64(input.image.base64).equals(source.bytes))
        throw new Error("动作画面需要当前已批准原画布的 PNG 图片，不接受重新编码或替换的参考图。");
      prepareMotionStudyRequest(input, request, source, fingerprint(rigGeometry(request.rig)));
      request.partIds = defaultVisiblePartIds(request.rig);
    }
    if (input.kind === "registration") {
      if (input.image && createHash("sha256").update(base64(input.image.base64)).digest("hex") !== source.sourceFingerprint)
        throw new Error("原图坐标规划只能使用当前骨架的固定立绘，不能替换参考图。");
      if ((input.image?.width !== undefined && input.image.width !== source.width) || (input.image?.height !== undefined && input.image.height !== source.height))
        throw new Error("原图坐标规划的参考尺寸与固定立绘不一致。");
      if (input.sourceFingerprint !== undefined && input.sourceFingerprint !== source.sourceFingerprint) throw new Error("原图指纹已改变，请重新规划当前立绘。");
      if (input.rigFingerprint !== undefined && input.rigFingerprint !== fingerprint(rigGeometry(request.rig))) throw new Error("部件几何或默认表情已改变，请重新规划当前草稿。");
      request.gridSize = input.gridSize ?? 32; request.maxBBoxExpansion = 2;
      if (request.gridSize !== 32 || (input.maxBBoxExpansion !== undefined && input.maxBBoxExpansion !== 2)) throw new Error("原图坐标规划目前使用 32 像素网格，最多允许 2 像素矩形微扩。");
      request.partIds = defaultVisiblePartIds(request.rig);
      if (!request.partIds.length) throw new Error("当前没有默认可见部件可进行原图坐标规划。");
      if (input.partIds !== undefined && (!Array.isArray(input.partIds) || JSON.stringify(input.partIds) !== JSON.stringify(request.partIds))) throw new Error("原图坐标规划必须覆盖当前全部默认可见部件。");
    }
    if (input.kind === "parts") {
      if (!Array.isArray(input.partIds) || !input.partIds.length || input.partIds.length > 64 || new Set(input.partIds).size !== input.partIds.length) throw new Error("请选择 1–64 个不重复的部件。");
      request.partIds = input.partIds.map((id) => {
        const part = request.rig.parts.find((part) => part.id === id);
        if (!part) throw new Error(`部件映射不存在：${id}`);
        if (![part.x, part.y, part.width, part.height].every(Number.isInteger)) throw new Error("部件补绘需要整像素矩形，请先调整部件位置与尺寸。");
        return id;
      });
      request.concurrency = input.concurrency ?? 3;
      if (!Number.isInteger(request.concurrency) || request.concurrency < 1 || request.concurrency > 4) throw new Error("同时补绘数量必须为 1–4。");
    }
    if (["appearance", "parts", "motion-frames"].includes(input.kind)) request.provider = await this.connections.snapshot(snapshot?.provider);
    else {
      if (input.planner !== "codex-native") throw new Error("结构、原图坐标与动作分析目前只支持明确选择的 Codex 账号规划；API 连接目前仅支持形象与部件生图。");
      request.provider = { id: "codex-native", label: "Codex 账号规划", capability: "planning" };
      if (input.kind === "motion") {
        const motion = input.motion;
        if (!motion || !ID.test(motion.id || "") || typeof motion.loop !== "boolean" || !Number.isFinite(motion.duration) || motion.duration <= 0 || motion.duration > 30) throw new Error("动作标识、时长或循环设置无效。");
        request.motion = { id: motion.id, name: string(motion.name, 160, "动作名称", true), description: string(motion.description, 4000, "动作描述", true), duration: motion.duration, loop: motion.loop };
      }
    }
    if (this.closed) throw new Error("分析服务已关闭。");
    const id = randomUUID(), folder = join(this.root, id); await mkdir(folder, { recursive: true });
    if (source) { await writeFile(join(folder, "source.png"), source.bytes, { mode: 0o600 }); request.image = { file: "source.png", width: source.width, height: source.height }; }
    if (input.kind === "motion") await saveMotionPlanningReferences(request, folder);
    if (input.kind === "pose-mapping") await saveMappingFrames(input, request, folder);
    const geometry = request.rig && rigGeometry(request.rig);
    const job = { id, request, status: "queued", stage: "queued", images: [], createdAt: new Date().toISOString(),
      ...(snapshot?.parentJobId ? { parentJobId: snapshot.parentJobId } : {}),
      ...(geometry ? { geometry, rigFingerprint: fingerprint(geometry) } : {}) };
    this.jobs.set(id, job); await this.persist(job);
    if (!this.draining) { this.drainingPromise = this.drain(); void this.drainingPromise.catch(() => {}); }
    return publicJob(job);
    } finally { this.creating.delete(input.projectId); }
  }
  async list(projectId) { await this.loading; return [...this.jobs.values()].filter((job) => job.request.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((job) => publicJob(job, false)); }
  async get(id) { await this.loading; const job = this.jobs.get(id); return job ? publicJob(job) : null; }
  async retry(id, { concurrency } = {}) {
    await this.loading;
    const previous = this.jobs.get(id);
    if (!previous) throw new Error("骨架补绘记录不存在。");
    if (!["parts", "motion-frames", "pose-mapping"].includes(previous.request.kind) || !["failed", "cancelled"].includes(previous.status)) throw new Error("只能继续失败或已取消的部件补绘、动作画面或坐标分析。");
    if (MOTION_STUDY_KINDS.has(previous.request.kind)) {
      const completed = new Set((previous.request.kind === "pose-mapping" ? previous.mappings || [] : previous.images).map((image) => image.frameId));
      const frames = previous.request.frames.filter((frame) => !completed.has(frame.id));
      if (!frames.length) throw new Error("没有需要继续处理的动作画面。");
      const image = previous.request.image, source = await readFile(join(this.root, previous.id, image.file));
      const retryFrames = previous.request.kind === "pose-mapping" ? await Promise.all(frames.map(async ({ file, ...frame }) => ({ ...frame,
        image: `data:image/png;base64,${(await readFile(join(this.root, previous.id, file))).toString("base64")}` }))) : frames;
      return this.create({ version: 1, kind: previous.request.kind, projectId: previous.request.projectId, name: previous.request.name,
        prompt: previous.request.prompt, planner: "codex-native", rig: previous.request.rig, motion: previous.request.motion, frames: retryFrames,
        concurrency: concurrency ?? previous.request.concurrency, originalArtworkFingerprint: previous.request.originalArtworkFingerprint,
        baseFingerprint: previous.request.baseFingerprint, geometryFingerprint: previous.request.geometryFingerprint,
        protectedIdleFingerprint: previous.request.protectedIdleFingerprint,
        image: { base64: source.toString("base64"), width: image.width, height: image.height } },
      { provider: previous.request.provider, parentJobId: previous.id });
    }
    const completed = new Set(previous.images.map((image) => image.partId));
    const partIds = previous.request.partIds.filter((partId) => !completed.has(partId));
    if (!partIds.length) throw new Error("没有需要继续补绘的部件。");
    const image = previous.request.image;
    const source = await readFile(join(this.root, previous.id, image.file));
    return this.create({ version: 1, kind: "parts", projectId: previous.request.projectId, name: previous.request.name,
      prompt: previous.request.prompt, rig: previous.request.rig, partIds, concurrency: concurrency ?? previous.request.concurrency,
      image: { base64: source.toString("base64"), width: image.width, height: image.height } },
    { provider: previous.request.provider, sourceFingerprint: previous.request.sourceFingerprint, parentJobId: previous.id });
  }
  async cancel(id) {
    await this.loading; const job = this.jobs.get(id); if (!job) return null;
    if (ACTIVE.has(job.status)) { job.status = "cancelled"; job.stage = "cancelled"; job.controller?.abort(); await this.persist(job); }
    return publicJob(job);
  }
  async image(id, imageId) {
    await this.loading; const job = this.jobs.get(id), image = job?.images.flatMap((image) => [image, image.raw]).find((image) => image?.id === imageId);
    if (!image) return null;
    if (!/^image-\d+(?:-raw)?$/.test(image.id) || image.file !== `${image.id}.png`) throw new Error("图片记录无效。");
    return readFile(join(this.root, id, image.file));
  }
  async analyze(job) {
    const request = job.request, cwd = join(this.root, job.id), signal = job.controller.signal;
    const schema = request.kind === "structure" ? structureSchema(request.width, request.height, request.detail) :
      request.kind === "registration" ? registrationSchema(request.rig, request.partIds) : motionSchema(request.rig, request.motion);
    const references = request.image ? [join(cwd, "source.png")] : [];
    if (request.kind === "registration") references.push(await registrationGrid(request, cwd));
    if (request.kind === "motion") for (const reference of request.motionReferences || []) {
      const file = join(cwd, reference.file), bytes = await readFile(file);
      if (createHash("sha256").update(bytes).digest("hex") !== reference.sourceFingerprint) throw new Error("动作参考图的本地文件已改变，未提交规划。");
      references.push(file);
    }
    signal.throwIfAborted();
    const output = await this.plan(this.rpc, { cwd, signal,
      prompt: request.kind === "structure" ? structurePrompt(request) : request.kind === "registration" ? registrationPrompt(request) : motionPrompt(request.rig, request.motion, request.motionReferences),
      schema, references });
    signal.throwIfAborted();
    validateStructured(output.value, schema);
    if (request.kind === "structure") {
      if (!Array.isArray(output.value?.joints) || !output.value.joints.length || !Array.isArray(output.value?.parts) || !output.value.parts.length) throw new Error("AI 未返回可用的关节和部件，请调整要求后重试。");
      const defaultAttachments = {};
      for (const { groupId, partId } of output.value.defaultAttachments) {
        if (Object.hasOwn(defaultAttachments, groupId)) throw new Error("AI 返回了重复的默认附件分组，请重新分析。");
        Object.defineProperty(defaultAttachments, groupId, { value: partId, enumerable: true, configurable: true, writable: true });
      }
      const rig = validateRigDocument({ version: 1, id: request.projectId, name: request.name, width: request.width, height: request.height,
        sourceImage: `data:image/png;base64,${(await readFile(join(cwd, "source.png"))).toString("base64")}`,
        joints: output.value.joints, parts: output.value.parts.map(({ attachmentGroup, ...part }) => ({ ...part, ...(attachmentGroup ? { attachmentGroup } : {}), imageSource: "source-crop", completion: "needs-inpaint" })),
        ...(Object.keys(defaultAttachments).length ? { defaultAttachments } : {}), motions: [], origin: "ai-analysis", structureDetail: request.detail || "standard" });
      job.result = { rig, notes: String(output.value.notes || "").slice(0, 2000) };
    } else if (request.kind === "registration") job.result = registrationResult(request, output.value);
    else {
      if (output.value?.id !== request.motion.id || output.value?.name !== request.motion.name || output.value?.duration !== request.motion.duration || output.value?.loop !== request.motion.loop)
        throw new Error("AI 返回的动作与本次请求不一致，未替换原动作。");
      const planned = { ...output.value, poses: output.value.poses.map((pose) => {
        const result = { ...pose };
        for (const field of ["translations", "scales", "drawOrder"]) if (result[field] === null) delete result[field];
        return result;
      }) };
      const motion = validateRigMotion({ ...planned, origin: "ai-analysis" }, request.rig.joints, request.rig.parts);
      if (motion.poses.length < 3 || motion.poses[0].time !== 0 || motion.poses.at(-1).time !== motion.duration) throw new Error("AI 动作缺少完整的起始、关键姿势或结束时间。");
      const attachments = Object.create(null);
      for (const part of request.rig.parts) if (part.attachmentGroup && !Object.hasOwn(attachments, part.attachmentGroup))
        attachments[part.attachmentGroup] = Object.hasOwn(request.rig.defaultAttachments || {}, part.attachmentGroup) ? request.rig.defaultAttachments[part.attachmentGroup] : part.id;
      const attachmentStates = motion.poses.map((pose) => { Object.assign(attachments, pose.attachments || {}); return { ...attachments }; });
      if (motion.loop && JSON.stringify(attachmentStates[0]) !== JSON.stringify(attachmentStates.at(-1))) throw new Error("循环动作的首尾表情附件不一致，请重新规划。");
      if (new Set(motion.poses.map((pose, index) => JSON.stringify([request.rig.joints.map((joint) => pose.angles[joint.id] || 0), pose.root,
        pose.translations || {}, pose.scales || {}, pose.drawOrder || [], attachmentStates[index]]))).size < 2)
        throw new Error("AI 未返回有效的关键姿势变化，未替换原动作。");
      motion.provenance = { kind: "continuous-rig-motion", planner: "codex-native", jobId: job.id, ...(typeof output.model === "string" ? { model: output.model } : {}), baseFingerprint: request.motionReferenceBaseFingerprint ?? request.sourceFingerprint ?? null,
        rigFingerprint: job.rigFingerprint, referenceFrames: (request.motionReferences || []).map(({ file, ...reference }) => reference),
        referenceExclusions: request.motionReferenceExclusions || [] };
      // Existing studies for other motions remain in the request snapshot only;
      // validating a single returned motion must not make their IDs look foreign.
      const { motionStudies, ...baseline } = request.rig;
      job.result = { motion: validateRigDocument({ ...baseline, motions: [motion] }).motions[0] };
    }
    signal.throwIfAborted(); job.model = output.model;
  }
  async generatePart(job, partId, index) {
    const request = job.request, rig = request.rig, part = rig.parts.find((part) => part.id === partId), signal = job.controller.signal;
    const { createCanvas, loadImage } = await import("@napi-rs/canvas"), folder = join(this.root, job.id);
    const source = await loadImage(await readFile(join(folder, "source.png"))), crop = createCanvas(part.width, part.height);
    crop.getContext("2d").drawImage(source, part.x, part.y, part.width, part.height, 0, 0, part.width, part.height);
    const cropPath = join(folder, `reference-${index}.png`); await writeFile(cropPath, crop.toBuffer("image/png"), { mode: 0o600 });
    signal.throwIfAborted();
    const separateFeatures = rig.parts.some((feature) => feature.attachmentGroup && feature.bone === part.bone && /eye|brow|mouth|眼|眉|嘴|口/i.test(`${feature.attachmentGroup} ${feature.id} ${feature.label}`));
    const identity = `${part.id} ${part.label}`;
    const blankFace = !part.attachmentGroup && separateFeatures && /head|face|脸|面部|头部|(?:^|\s)头(?:$|\s)/i.test(identity) && !/hair|cap|hat|helmet|gear|发|帽|头饰|冠/i.test(identity);
    const overlapPrompt = [
      "PRODUCTION RIG: one complete independent part for continuous skeletal animation with joint overlap, not a visible-only cutout.",
      "Retain real hidden surfaces and rounded joint ends so adjacent limbs, sleeves, clothing and hair can overlap when rotated. Do not crop a joint flush to the visible source boundary or narrow the part to its exposed strip.",
      "Draw only this named part: do not include neighboring limbs, hair, clothing, skin, props or a whole-body substitute. Keep its original character proportions, setup orientation, local scale and attachment points; use the fixed logical rectangle without stretching.",
      ...(blankFace ? ["BLANK FACE BASE: make one complete filled face/ear support surface with continuous blank skin. No eyes, eyebrows or mouth; they are separate attachments. Do not punch holes, transparent eye sockets or mouth cutouts into the face. Do not include front hair, neck collar or other neighboring parts."] : []),
      ...(part.attachmentGroup ? ["This is one isolated expression attachment. Preserve its own complete strokes and transparent surroundings; do not add the full face or a skin-colored background patch."] : []),
      "Native transparent PNG only. Keep the full independent support shape inside the canvas. Human review and later calibration will verify hidden anatomy, isolation and overlap; do not claim automatic approval.",
    ].join("\n");
    const output = await this.connections.generate(request.provider, { cwd: folder, prompt: `${rigPartPrompt(rig, part, request.prompt)}\n\n${overlapPrompt}`,
      references: [cropPath, join(folder, "source.png")], signal, instructions: RIG_PART_IMAGE_INSTRUCTIONS });
    signal.throwIfAborted(); const bytes = base64(output.result);
    if (!bytes.subarray(0, 8).equals(PNG)) throw new Error("AI 未返回 PNG 部件图片。");
    checkPNGSize(bytes);
    const bitmap = await loadImage(bytes);
    if (bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width * bitmap.height > 16 * 1024 * 1024) throw new Error("AI 部件画布过大。");
    const original = createCanvas(bitmap.width, bitmap.height); original.getContext("2d").drawImage(bitmap, 0, 0);
    const pixels = original.getContext("2d").getImageData(0, 0, bitmap.width, bitmap.height).data;
    let visible = false, transparent = false;
    for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] > 8) visible = true; if (pixels[i] < 247) transparent = true; }
    if (!visible || !transparent) throw new Error(!visible ? "AI 部件完全透明，未生成有效内容。" : "AI 部件没有透明背景，请重新补绘。");
    const canvas = createCanvas(part.width, part.height), scale = Math.min(part.width / bitmap.width, part.height / bitmap.height);
    const width = bitmap.width * scale, height = bitmap.height * scale;
    canvas.getContext("2d").drawImage(bitmap, (part.width - width) / 2, (part.height - height) / 2, width, height);
    const imageId = `image-${index}`, file = `${imageId}.png`; signal.throwIfAborted();
    const rawId = `${imageId}-raw`, rawFile = `${rawId}.png`;
    await writeFile(join(folder, rawFile), bytes, { mode: 0o600 }); signal.throwIfAborted();
    await writeFile(join(folder, file), canvas.toBuffer("image/png"), { mode: 0o600 }); signal.throwIfAborted();
    job.images.push({ id: imageId, file, partId, width: part.width, height: part.height, canvasWidth: rig.width, canvasHeight: rig.height,
      sourceFingerprint: request.sourceFingerprint,
      raw: { id: rawId, file: rawFile, width: bitmap.width, height: bitmap.height, url: `/api/rig/jobs/${job.id}/images/${rawId}` },
      rect: { x: part.x, y: part.y, width: part.width, height: part.height, bone: part.bone, binding: part.binding, influences: part.influences },
      provider: request.provider.id, controllerModel: output.model, transparent: true, aiGenerated: true, url: `/api/rig/jobs/${job.id}/images/${imageId}` });
    job.images.sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6)));
  }
  async generateAppearance(job) {
    const request = job.request, signal = job.controller.signal, folder = join(this.root, job.id);
    const output = await this.connections.generate(request.provider, { cwd: folder, prompt: appearancePrompt(request),
      references: [join(folder, "source.png")], signal, instructions: RIG_APPEARANCE_IMAGE_INSTRUCTIONS });
    signal.throwIfAborted();
    const bytes = base64(output.result);
    if (!bytes.subarray(0, 8).equals(PNG)) throw new Error("AI 未返回 PNG 角色形象。");
    checkPNGSize(bytes);
    const { createCanvas, loadImage } = await import("@napi-rs/canvas"), image = await loadImage(bytes);
    if (!image.width || !image.height || image.width > 4096 || image.height > 4096 || image.width * image.height > 16 * 1024 * 1024)
      throw new Error("AI 角色画布过大或无效。");
    // Check the actual output before adding margins; an opaque image must not pass via letterboxing.
    const original = createCanvas(image.width, image.height); original.getContext("2d").drawImage(image, 0, 0);
    const pixels = original.getContext("2d").getImageData(0, 0, image.width, image.height).data;
    let visible = false, transparent = false;
    for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] > 8) visible = true; if (pixels[i] < 247) transparent = true; }
    if (!visible || !transparent) throw new Error(!visible ? "AI 角色形象完全透明，未生成有效内容。" : "AI 角色形象没有透明背景，请重新生成。");
    const width = 1024, height = 1024, padding = 32, canvas = createCanvas(width, height);
    const scale = Math.min((width - padding * 2) / image.width, (height - padding * 2) / image.height);
    const drawnWidth = image.width * scale, drawnHeight = image.height * scale;
    canvas.getContext("2d").drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
    signal.throwIfAborted();
    const id = "image-0", file = `${id}.png`; await writeFile(join(folder, file), canvas.toBuffer("image/png"), { mode: 0o600 });
    signal.throwIfAborted();
    job.images.push({ id, file, kind: "appearance", width, height, sourceFingerprint: request.sourceFingerprint,
      provider: request.provider.id, transparent: true, aiGenerated: true, url: `/api/rig/jobs/${job.id}/images/${id}` });
    job.model = output.model; job.result = { images: job.images };
  }
  async generateParts(job) {
    let next = 0, failure; job.currentParts = [];
    const worker = async () => {
      while (next < job.request.partIds.length && !failure && !job.controller.signal.aborted && !this.closed) {
        const index = next++, partId = job.request.partIds[index]; job.currentParts.push(partId);
        try { await this.persist(job); await this.generatePart(job, partId, index); }
        catch (error) { failure ||= new Error(`${partId}：${error.message || "部件补绘失败。"}`); }
        finally { job.currentParts = job.currentParts.filter((id) => id !== partId); await this.persist(job); }
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: Math.min(job.request.concurrency, job.request.partIds.length) }, worker));
    failure ||= workers.find((result) => result.status === "rejected")?.reason;
    if (failure) throw failure;
    job.controller.signal.throwIfAborted(); job.result = { images: job.images };
  }
  async drain() {
    if (this.draining || this.closed) return; this.draining = true;
    try {
      for (const job of this.jobs.values()) {
        if (job.status !== "queued" || this.closed) continue;
        job.controller = new AbortController(); job.stage = job.request.kind; job.status = ["appearance", "parts", "motion-frames"].includes(job.request.kind) ? "generating" : "analyzing";
        try {
          await this.persist(job); job.controller.signal.throwIfAborted();
          if (job.request.kind === "parts") await this.generateParts(job);
          else if (job.request.kind === "appearance") await this.generateAppearance(job);
          else if (job.request.kind === "motion-frames") await generateMotionFrames(this, job);
          else if (job.request.kind === "pose-mapping") await mapMotionPoses(this, job);
          else await this.analyze(job);
          job.controller.signal.throwIfAborted(); job.status = "completed"; job.stage = "completed";
        } catch (error) {
          delete job.result;
          if (job.status !== "cancelled") { job.status = "failed"; job.stage = "failed"; job.error = this.closed ? "服务已关闭，本次任务中断。" : String(error.message || error).slice(0, 1200); }
        } finally { delete job.controller; delete job.currentParts; delete job.currentFrames; await this.persist(job); }
      }
    } finally { this.draining = false; }
  }
  close() { this.closed = true; for (const job of this.jobs.values()) job.controller?.abort(); return this.drainingPromise?.catch(() => {}); }
}

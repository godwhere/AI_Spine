import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { rigGeometry, rigDefaultVisiblePartIds as defaultVisiblePartIds } from "../../shared/domain/rig.mjs";
export { rigGeometry } from "../../shared/domain/rig.mjs";
import { validateRigDocument } from "../../shared/rig-schema.mjs";
import { validateRigDraftDocument } from "../../shared/domain/draft.mjs";
import { assertProductionGate, productionFingerprint, productionPrompt, productionRequestFingerprint } from "../../shared/domain/production.mjs";
import { saveProductionReferences } from "./handlers/production-references.mjs";
import { imageDataBytes } from "../../shared/codec/image-data.mjs";
import { generateStructured } from "../providers/codex-planning.mjs";
import { MOTION_STUDY_KINDS, prepareMotionStudyRequest, saveMappingFrames } from "./handlers/motion-study.mjs";
import { ACTIVE, ID, KINDS, PNG, string, base64, fingerprint, sourceImage, saveMotionPlanningReferences, publicJob, restoreSourceIdentity } from "./rig-request.mjs";
import { JobManifests } from "./manifests.mjs";
import { JobQueue } from "./queue.mjs";
import { analyze as analyzeRig } from "./handlers/rig-planning.mjs";
import { generatePart as generateRigPart, generateAppearance as generateRigAppearance, generateParts as generateRigParts } from "./handlers/rig-images.mjs";
import { runRigJob } from "./handlers/rig-handlers.mjs";
import { codexPlanningProvider } from "../providers/codex-planning.mjs";

export class RigJobs {
  constructor({ root, rpc, connections, plan = generateStructured } = {}) {
    this.root = resolve(root); this.rpc = rpc; this.connections = connections; this.plan = plan;
    this.planner = codexPlanningProvider(rpc, (...args) => this.plan(...args));
    this.jobs = new Map(); this.manifests = new JobManifests(this.root); this.writes = this.manifests.writes; this.creating = new Set();
    this.queue = new JobQueue({ jobs: this.jobs, manifests: this.manifests, active: ACTIVE, ready: () => this.loading,
      closedMessage: "分析服务已关闭。", run: (job) => runRigJob(this, job),
      start: (job) => { job.stage = job.request.kind; job.status = ["appearance", "parts", "motion-frames"].includes(job.request.kind) ? "generating" : "analyzing"; },
      complete: (job) => { job.status = "completed"; job.stage = "completed"; },
      fail: (job, error, closed) => { delete job.result; if (job.status !== "cancelled") { job.status = "failed"; job.stage = "failed";
        job.error = closed ? "服务已关闭，本次任务中断。" : String(error.message || error).slice(0,1200); } },
      cancel: (job) => { job.stage = "cancelled"; },
      cleanup: (job) => { delete job.controller; delete job.currentParts; delete job.currentFrames; },
    });
    this.loading = this.restore();
  }
  isBusy() { return this.creating.size > 0 || [...this.jobs.values()].some((job) => ACTIVE.has(job.status)); }
  get closed() { return this.queue.closed; }
  get draining() { return this.queue.draining; }
  set draining(value) { this.queue.draining = value; }
  get drainingPromise() { return this.queue.drainingPromise; }
  async restore() {
    const recovered = await this.manifests.load({ accept: (job) => KINDS.has(job.request?.kind), recover: async (job) => {
      let changed = await restoreSourceIdentity(this.root, job).catch(() => false);
      if (ACTIVE.has(job.status)) { job.status = "failed"; job.stage = "failed";
        job.error = "本地服务已重启，上次生成、分析或补绘已中断。已完成图片仍可检查，请明确重新提交剩余工作。"; changed = true; }
      if (changed) await this.persist(job);
    } });
    for (const job of recovered) this.jobs.set(job.id, job);
  }
  persist(job) { return this.manifests.save(job); }
  async create(input, snapshot) {
    return this.queue.admit(async () => {
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
    if (input.rig?.production) {
      request.rig ||= validateRigDraftDocument(input.rig);
      if (request.rig.id !== input.projectId) throw new Error("制作计划与当前角色标识不一致。");
      assertProductionGate(request.rig, input.referenceTarget ? "reference" : input.kind);
    }
    if (input.referenceTarget !== undefined) {
      if (input.kind !== "appearance" || !request.rig?.production || !ID.test(input.referenceTarget) ||
        input.referenceFingerprint !== productionFingerprint(request.rig, "board-request", input.referenceTarget) ||
        request.prompt !== productionPrompt(request.rig, "reference", input.referenceTarget)) throw new Error("关键图目标或制作约束已经改变。");
      request.referenceTarget = input.referenceTarget; request.referenceFingerprint = input.referenceFingerprint;
    }
    // New studies freeze the caller's exact authored JSON after validation. Normalizing
    // optional defaults must not silently change the protected idle fingerprint.
    if (MOTION_STUDY_KINDS.has(input.kind)) request.rig = structuredClone(input.rig);
    if (input.kind === "registration" && input.projectId !== request.rig.id) throw new Error("原图坐标规划与当前工程标识不一致。");
    const source = await sourceImage(input.kind === "registration" ? { ...input, image: undefined } : input, request.rig);
    if (input.kind !== "motion" && !source) throw new Error("请先导入角色立绘。");
    if (request.rig?.production && source?.sourceFingerprint !== createHash("sha256").update(imageDataBytes(request.rig.sourceImage).bytes).digest("hex")) throw new Error("制作任务只能使用当前计划已审阅的源图，不能替换参考图片。");
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
    if (input.kind === "motion") {
        const motion = input.motion;
        if (!motion || !ID.test(motion.id || "") || typeof motion.loop !== "boolean" || !Number.isFinite(motion.duration) || motion.duration <= 0 || motion.duration > 30) throw new Error("动作标识、时长或循环设置无效。");
        request.motion = { id: motion.id, name: string(motion.name, 160, "动作名称", true), description: string(motion.description, 4000, "动作描述", true), duration: motion.duration, loop: motion.loop };
    }
    if (request.rig?.production) {
      if (input.kind === "structure" && request.detail !== (request.rig.structureDetail === "standard" ? "standard" : "detailed")) throw new Error("结构任务精细度与当前草稿不一致。");
      const instruction = productionPrompt(request.rig, input.referenceTarget ? "reference" : input.kind, input.referenceTarget || request.motion?.id);
      const submitted = request.kind === "motion" ? request.motion.description : request.prompt;
      if (!["motion-frames", "pose-mapping"].includes(input.kind) && !submitted.includes(instruction)) throw new Error("任务缺少当前制作计划的完整约束，未提交生成。");
      if (request.motion && input.kind === "motion") {
        const planned = request.rig.production.motions.find((m) => m.id === request.motion.id);
        if (!planned || planned.duration !== request.motion.duration || planned.loop !== request.motion.loop) throw new Error("本次动作与已确认的制作计划不一致。");
      }
      request.productionFingerprint = productionRequestFingerprint(request.rig, input.kind, request.motion?.id);
    }
    if (["appearance", "parts", "motion-frames"].includes(input.kind)) request.provider = await this.connections.snapshot(snapshot?.provider);
    else request.provider = this.planner.snapshot(input.planner);
    if (this.closed) throw new Error("分析服务已关闭。");
    const id = randomUUID(), folder = join(this.root, id); await mkdir(folder, { recursive: true });
    if (source) { await writeFile(join(folder, "source.png"), source.bytes, { mode: 0o600 }); request.image = { file: "source.png", width: source.width, height: source.height }; }
    if (request.rig?.production && ["structure", "motion"].includes(input.kind)) await saveProductionReferences(request, folder);
    else if (input.kind === "motion") await saveMotionPlanningReferences(request, folder);
    if (input.kind === "pose-mapping") await saveMappingFrames(input, request, folder);
    const geometry = request.rig && rigGeometry(request.rig);
    const job = { id, request, status: "queued", stage: "queued", images: [], createdAt: new Date().toISOString(),
      ...(snapshot?.parentJobId ? { parentJobId: snapshot.parentJobId } : {}),
      ...(geometry ? { geometry, rigFingerprint: fingerprint(geometry) } : {}) };
    await this.queue.enqueue(job);
    return publicJob(job);
    } finally { this.creating.delete(input.projectId); }
    });
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
  async cancel(id) { await this.loading; const job = await this.queue.cancel(id); return job ? publicJob(job) : null; }
  async image(id, imageId) {
    await this.loading; const job = this.jobs.get(id), image = job?.images.flatMap((image) => [image, image.raw]).find((image) => image?.id === imageId);
    if (!image) return null;
    if (!/^image-\d+(?:-raw)?$/.test(image.id) || image.file !== `${image.id}.png`) throw new Error("图片记录无效。");
    return readFile(join(this.root, id, image.file));
  }
  analyze(job) { return analyzeRig(this, job); }
  generatePart(job, partId, index) { return generateRigPart(this, job, partId, index); }
  generateAppearance(job) { return generateRigAppearance(this, job); }
  generateParts(job) { return generateRigParts(this, job); }
  drain() { return this.queue.drain(); }
  close() { return this.queue.close(); }
}

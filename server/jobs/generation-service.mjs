import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { CodexRpc, generateNativeImage } from "../infrastructure/codex-rpc.mjs";
import { AIConnections } from "../ai/connections.mjs";
import { RigJobs } from "./rig-service.mjs";
import { JobManifests } from "./manifests.mjs";
import { JobQueue } from "./queue.mjs";
import { TEMPLATE_ACTIVE as ACTIVE, concurrencyValue, validateRequest, publicJob } from "./template-request.mjs";
import { generateTemplatePart, runTemplateImages } from "./handlers/template-images.mjs";
export { pngInfo, validateRequest, imagePrompt } from "./template-request.mjs";

export class GenerationJobs {
  constructor({ root, rpc = new CodexRpc(), generate = generateNativeImage, connections, protection, fetcher } = {}) {
    this.root = resolve(root);
    this.rpc = rpc;
    this.generate = generate;
    this.jobs = new Map();
    this.manifests = new JobManifests(this.root); this.writes = this.manifests.writes; this.creating = new Set();
    this.queue = new JobQueue({ jobs: this.jobs, manifests: this.manifests, active: ACTIVE, ready: () => this.loading,
      closedMessage: "生成服务已关闭。", start: (job) => { job.status = "connecting"; },
      run: (job) => runTemplateImages(this, job), complete: (job) => { job.status = "completed"; },
      fail: (job, error, closed) => { if (job.status !== "cancelled") { job.status = "failed";
        job.error = closed ? "本地服务已重启，本次生成已中断。请重新生成。" : error.name === "AbortError" ? "生图超时或已中断，请重试。" : String(error.message || error).slice(0,1200); } },
      cleanup: (job) => { delete job.controller; delete job.currentParts; delete job.currentPart; },
    });
    this.connections = connections || new AIConnections({ root: join(this.root, ".connection"), rpc,
      generateNative: (...args) => this.generate(...args), protection, fetcher,
      isBusy: () => this.creating.size > 0 || [...this.jobs.values()].some((job) => ACTIVE.has(job.status)) || Boolean(this.rigJobs?.isBusy()) });
    this.rigJobs = new RigJobs({ root: join(this.root, ".rig"), rpc: this.rpc, connections: this.connections });
    this.loading = Promise.all([this.restore(), this.connections.ready, this.rigJobs.loading]);
  }
  get closed() { return this.queue.closed; }
  get draining() { return this.queue.draining; }
  set draining(value) { this.queue.draining = value; }
  get drainingPromise() { return this.queue.drainingPromise; }
  async restore() {
    const recovered = await this.manifests.load({ recover: async (job) => {
      if (ACTIVE.has(job.status)) { job.status = "failed";
        job.error = "本地服务已重启，上次生成已中断。已完成的候选仍可使用，请手动重新生成剩余部件。"; }
    } });
    for (const job of recovered) this.jobs.set(job.id, job);
  }
  status(provider) { return this.connections.status(provider); }
  persist(job) { return this.manifests.save(job); }
  async create(input) {
    return this.queue.admit(async () => {
    await this.loading;
    const request = validateRequest(input);
    if (this.creating.has(request.projectId) || [...this.jobs.values()].some((j) => ACTIVE.has(j.status) && j.request.projectId === request.projectId))
      throw new Error("这个工程已有进行中的生成，请等待完成或先取消。");
    this.creating.add(request.projectId);
    try {
    request.provider = await this.connections.snapshot(input.provider);
    this.queue.assertOpen();
    const id = randomUUID(), folder = join(this.root, id);
    await mkdir(join(folder, "inputs"), { recursive: true });
    const refs = [];
    for (const [index, ref] of request.references.entries()) {
      const file = `inputs/reference-${index}.png`;
      await writeFile(join(folder, file), ref.bytes, { mode: 0o600 });
      refs.push({ role: ref.role, partId: ref.partId, file });
    }
    request.references = refs;
    const job = { id, request, status: "queued", images: [], createdAt: new Date().toISOString() };
    await this.queue.enqueue(job);
    return publicJob(job);
    } finally { this.creating.delete(request.projectId); }
    });
  }
  async list(projectId) {
    await this.loading;
    return [...this.jobs.values()].filter((j) => j.request.projectId === projectId)
      .sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,50).map(publicJob);
  }
  async get(id) { await this.loading; const job = this.jobs.get(id); return job ? publicJob(job) : null; }
  async retry(id, { concurrency } = {}) {
    await this.loading;
    const previous = this.jobs.get(id);
    if (!previous) throw new Error("生成记录不存在。");
    if (!["failed", "cancelled"].includes(previous.status)) throw new Error("只能继续已中断或失败的生成。");
    const completed = new Set(previous.images.map((image) => image.partId));
    const parts = previous.request.parts.filter((part) => !completed.has(part.id));
    if (previous.request.kind === "parts" ? !parts.length : previous.images.length) throw new Error("没有需要继续生成的部件。");
    const remaining = new Set(parts.map((part) => part.id));
    // Reuse the original immutable brief and reference snapshot, even after editing the current project.
    const references = await Promise.all(previous.request.references.filter((ref) => ref.role !== "part" || remaining.has(ref.partId)).map(async (ref) => ({
      role: ref.role, ...(ref.partId ? { partId: ref.partId } : {}),
      base64: (await readFile(join(this.root, id, ref.file))).toString("base64"),
    })));
    return this.create({ ...previous.request, provider: previous.request.provider || { id: "codex-native" }, parts, references, concurrency: concurrencyValue(concurrency ?? previous.request.concurrency) });
  }
  async cancel(id) { await this.loading; const job = await this.queue.cancel(id); return job ? publicJob(job) : null; }
  async image(id, imageId) {
    await this.loading;
    const job = this.jobs.get(id), image = job?.images.find((i) => i.id === imageId);
    if (!image) return null;
    return readFile(join(this.root, id, image.file));
  }
  generatePart(job, part, index) { return generateTemplatePart(this, job, part, index); }
  drain() { return this.queue.drain(); }
  close() {
    if (this.closing) return this.closing;
    const pending = [this.queue.close(), this.rigJobs.close()];
    return this.closing = (async () => {
      const results = await Promise.allSettled(pending);
      this.connections.close?.(); this.rpc.close();
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "生成任务未完成关闭保存。");
    })();
  }
}

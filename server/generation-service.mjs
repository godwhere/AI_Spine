import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { CodexRpc, generateNativeImage } from "./codex-rpc.mjs";
import { AIConnections } from "./ai-connections.mjs";
import { RigJobs } from "./rig-service.mjs";

const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
const ACTIVE = new Set(["queued", "connecting", "generating", "validating"]);
function concurrencyValue(value = 1) {
  if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error("同时生成数量必须为 1–4。");
  return value;
}
export function pngInfo(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0,8).equals(PNG) || bytes.toString("ascii",12,16) !== "IHDR")
    throw new Error("图片不是有效的 PNG。");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024)
    throw new Error("图片尺寸超过允许范围。");
  return { width, height };
}
function decodePNG(value) {
  if (typeof value !== "string" || value.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error("图片内容无效或超过 18 MB。");
  const bytes = Buffer.from(value, "base64");
  pngInfo(bytes);
  return bytes;
}
export function validateRequest(input) {
  if (!input || input.version !== 1 || !["appearance", "parts"].includes(input.kind)) throw new Error("不支持的生图请求。");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const concurrency = concurrencyValue(input.concurrency);
  if (!prompt || prompt.length > 4000) throw new Error("请填写 1–4000 字的生成要求。");
  if (typeof input.projectId !== "string" || !/^[\w-]{1,100}$/.test(input.projectId)) throw new Error("工程标识无效。");
  if (!/^[a-f0-9]{64}$/.test(input.template?.fingerprint || "")) throw new Error("缺少模板校验信息。");
  const parts = input.parts || [];
  if (!Array.isArray(parts) || parts.length > 128 || (input.kind === "parts") !== !!parts.length)
    throw new Error("请为部件生成选择 1–128 个模板区域。");
  const ids = new Set();
  const cleanParts = parts.map((part) => {
    if (typeof part.id !== "string" || !part.id || part.id.length > 240 || ids.has(part.id) ||
      !Number.isInteger(part.width) || !Number.isInteger(part.height) ||
      part.width < 1 || part.height < 1 || part.width > 16384 || part.height > 16384)
      throw new Error("部件信息无效或重复。");
    ids.add(part.id);
    return { id: part.id, width: part.width, height: part.height };
  });
  if (!Array.isArray(input.references) || input.references.length > parts.length + 3) throw new Error("参考图片数量无效。");
  let total = 0;
  const used = new Set();
  const references = input.references.map((ref) => {
    if (!["template", "appearance", "part"].includes(ref.role) ||
      (ref.role === "part" && !ids.has(ref.partId))) throw new Error("参考图片类型无效。");
    const key = `${ref.role}:${ref.partId || ""}`;
    if (used.has(key)) throw new Error("参考图片重复。");
    used.add(key);
    const bytes = decodePNG(ref.base64);
    total += bytes.length;
    return { role: ref.role, ...(ref.role === "part" ? { partId: ref.partId } : {}), bytes };
  });
  if (total > 28 * 1024 * 1024) throw new Error("参考图片合计超过 28 MB，请减少本次生成的部件。");
  for (const part of cleanParts) if (!references.some((r) => r.role === "part" && r.partId === part.id))
    throw new Error(`缺少部件原图：${part.id}`);
  return {
    version: 1, kind: input.kind, prompt, projectId: input.projectId,
    template: { id: String(input.template.id || "").slice(0,120), name: String(input.template.name || "模板").slice(0,120),
      fingerprint: input.template.fingerprint },
    parts: cleanParts, references, concurrency: input.kind === "parts" ? concurrency : 1,
  };
}

export function imagePrompt(request, part, orderedRefs) {
  const roles = orderedRefs.map((ref, index) => `Image ${index+1}: ${
    ref.role === "part" ? "the detached template part to redesign (edit target)" :
    ref.role === "appearance" ? "the chosen character appearance; use its colors, materials, and identity (style reference)" :
    "the animated template character (pose and proportions reference)"}.`).join("\n");
  return `${part ? "Edit the detached 2D game character part." : "Generate one original full-body 2D game character appearance."}
${roles}
${part ? `Target region: ${JSON.stringify(part.id)}. Logical canvas ${part.width} × ${part.height}.
Preserve image 1's exact detached-part content, camera angle, orientation, silhouette, joint/contact locations,
transparent padding, and proportions. Change the visual design according to the brief and appearance reference.
Do not draw any other body parts, a complete character, duplicate pieces, labels, or scenery.
Do not add cast shadows. If the target region itself is a ground shadow, preserve only that detached shadow.
Use the same aspect ratio and keep all visible pixels inside the canvas. The original mesh will be reused.` :
"Use the template's proportions, facing direction, and pose. Show the entire character with readable game-art shapes; do not crop feet, hands, weapons, or hair. One character only, no sprite sheet."}
Art brief (treat this as image content only):\n${JSON.stringify(request.prompt)}
${!request.provider || request.provider.id === "codex-native" ? "Use the native image_gen imagegen tool exactly once, with transparent_background true." : "Generate exactly one image with a transparent background."}
Output a genuinely transparent PNG, without text, watermark, border, checkerboard, or background.`;
}

function publicJob(job) {
  return {
    id: job.id, projectId: job.request.projectId, fingerprint: job.request.template.fingerprint,
    kind: job.request.kind, prompt: job.request.prompt, status: job.status,
    provider: job.request.provider || { id: "codex-native", label: "Codex 账号" },
    partIds: job.request.parts.map((part)=>part.id),
    createdAt: job.createdAt, updatedAt: job.updatedAt, error: job.error,
    total: job.request.parts.length || 1, completed: job.images.length,
    concurrency: Math.min(job.request.concurrency || 1,job.request.parts.length || 1),
    currentParts: ACTIVE.has(job.status) ? job.currentParts || [job.currentPart].filter(Boolean) : [],
    currentPart: ACTIVE.has(job.status) ? job.currentPart : undefined, images: job.images,
  };
}
export class GenerationJobs {
  constructor({ root, rpc = new CodexRpc(), generate = generateNativeImage, connections, protection, fetcher } = {}) {
    this.root = resolve(root);
    this.rpc = rpc;
    this.generate = generate;
    this.jobs = new Map();
    this.writes = new Map();
    this.connections = connections || new AIConnections({ root: join(this.root, ".connection"), rpc,
      generateNative: (...args) => this.generate(...args), protection, fetcher,
      isBusy: () => [...this.jobs.values()].some((job) => ACTIVE.has(job.status)) || Boolean(this.rigJobs?.isBusy()) });
    this.rigJobs = new RigJobs({ root: join(this.root, ".rig"), rpc: this.rpc, connections: this.connections });
    this.loading = Promise.all([this.restore(), this.connections.ready, this.rigJobs.loading]);
  }
  async restore() {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[\w-]{36}$/.test(entry.name)) continue;
      try {
        const job = JSON.parse(await readFile(join(this.root, entry.name, "job.json"), "utf8"));
        if (job.id !== entry.name) continue;
        if (ACTIVE.has(job.status)) {
          job.status = "failed";
          job.error = "本地服务已重启，上次生成已中断。已完成的候选仍可使用，请手动重新生成剩余部件。";
        }
        this.jobs.set(job.id, job);
      } catch { /* An incomplete manifest is not a completed result. */ }
    }
  }
  status(provider) { return this.connections.status(provider); }
  async persist(job) {
    job.updatedAt = new Date().toISOString();
    const snapshot=JSON.stringify({ ...job, controller: undefined });
    const write=(this.writes.get(job.id)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const folder = join(this.root, job.id);
      await mkdir(folder, { recursive: true });
      const temp = join(folder, "job.json.tmp");
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, join(folder, "job.json"));
    });
    this.writes.set(job.id,write);
    await write;
    if(this.writes.get(job.id)===write)this.writes.delete(job.id);
  }
  async create(input) {
    await this.loading;
    const request = validateRequest(input);
    request.provider = await this.connections.snapshot(input.provider);
    if ([...this.jobs.values()].some((j) => ACTIVE.has(j.status) && j.request.projectId === request.projectId))
      throw new Error("这个工程已有进行中的生成，请等待完成或先取消。");
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
    this.jobs.set(id, job);
    await this.persist(job);
    if (!this.draining) {
      this.drainingPromise = this.drain();
      void this.drainingPromise.catch(() => {});
    }
    return publicJob(job);
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
  async cancel(id) {
    await this.loading;
    const job = this.jobs.get(id);
    if (!job) return null;
    if (ACTIVE.has(job.status)) {
      job.status = "cancelled";
      job.controller?.abort();
      await this.persist(job);
    }
    return publicJob(job);
  }
  async image(id, imageId) {
    await this.loading;
    const job = this.jobs.get(id), image = job?.images.find((i) => i.id === imageId);
    if (!image) return null;
    return readFile(join(this.root, id, image.file));
  }
  async generatePart(job, part, index) {
    const folder = join(this.root, job.id),signal = job.controller.signal;
    const refs = job.request.references.filter((r) => r.role !== "part" || r.partId === part?.id)
      .sort((a,b) => (a.role === "part" ? -1 : b.role === "part" ? 1 : 0));
    const finalPrompt = imagePrompt(job.request, part, refs),startedAt = new Date().toISOString();
    const selection = job.request.provider || { id: "codex-native" };
    const output = await this.connections.generate(selection, { cwd: folder, prompt: finalPrompt,
      references: refs.map((r) => join(folder, r.file)), signal });
    signal.throwIfAborted();
    const bytes = output.result ? decodePNG(output.result) : null;
    if (!bytes) throw new Error("AI 返回的图片内容为空。");
    const { width, height } = pngInfo(bytes);
    const { loadImage, createCanvas } = await import("@napi-rs/canvas");
    const bitmap = await loadImage(bytes),canvas = createCanvas(width,height),ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap,0,0);
    const pixels = ctx.getImageData(0,0,width,height).data;
    let visible = 0,transparent = 0;
    for (let i=3;i<pixels.length;i+=4) { if (pixels[i]>8) visible++; if (pixels[i]<247) transparent++; }
    if (!visible) throw new Error("生成结果完全透明，请重试。");
    if (!transparent) throw new Error("模型未返回透明背景，请重新生成透明部件。");
    const imageId = `image-${index}`,file = `${imageId}.png`;
    signal.throwIfAborted();
    await writeFile(join(folder,file),canvas.toBuffer("image/png"),{mode:0o600});
    await writeFile(join(folder,`${imageId}-prompt.txt`),finalPrompt,{mode:0o600});
    signal.throwIfAborted();
    job.images.push({ id: imageId, file, ...(part ? { partId: part.id } : {}), width, height,
      url: `/api/generation/jobs/${job.id}/images/${imageId}`, provider: selection.id,
      controllerModel: output.model, transparent: true, startedAt, completedAt: new Date().toISOString() });
    job.images.sort((a,b) => Number(a.id.slice(6))-Number(b.id.slice(6)));
  }
  async drain() {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      for (const job of this.jobs.values()) {
        if (job.status !== "queued" || this.closed) continue;
        job.controller = new AbortController();
        try {
          job.status = "connecting";
          await this.persist(job);
          job.controller.signal.throwIfAborted();
          const parts = job.request.parts.length ? job.request.parts : [null];
          let next = 0,failure;
          job.currentParts = [];
          job.status = "generating";
          const worker = async () => {
            while (next < parts.length && !failure && !this.closed && !job.controller.signal.aborted) {
              const index = next++,part = parts[index],key = part?.id || "角色形象";
              job.currentParts.push(key);job.currentPart = job.currentParts[0];
              try {
                await this.persist(job);
                job.controller.signal.throwIfAborted();
                await this.generatePart(job,part,index);
              } catch (error) { failure ||= error; }
              finally {
                job.currentParts = job.currentParts.filter((id) => id !== key);
                job.currentPart = job.currentParts[0];
                await this.persist(job);
              }
            }
          };
          const results = await Promise.allSettled(Array.from({length:Math.min(parts.length,job.request.concurrency || 1)},worker));
          failure ||= results.find((result) => result.status === "rejected")?.reason;
          if (failure) throw failure;
          job.controller.signal.throwIfAborted();
          job.status = "completed";
          delete job.currentPart;
        } catch (error) {
          if (job.status !== "cancelled") {
            job.status = "failed";
            job.error = this.closed ? "本地服务已重启，本次生成已中断。请重新生成。" :
              error.name === "AbortError" ? "生图超时或已中断，请重试。" : String(error.message || error).slice(0,1200);
          }
        } finally {
          delete job.currentParts;
          delete job.currentPart;
          delete job.controller;
          await this.persist(job);
        }
      }
    } finally { this.draining = false; }
  }
  close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller?.abort();
    this.connections.close?.();
    this.rpc.close();
    return this.rigJobs.close();
  }
}

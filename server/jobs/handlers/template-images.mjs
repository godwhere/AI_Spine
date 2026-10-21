import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { imagePrompt, decodePNG, pngInfo } from "../template-request.mjs";

export async function generateTemplatePart(service, job, part, index) {
    const folder = join(service.root, job.id),signal = job.controller.signal;
    const refs = job.request.references.filter((r) => r.role !== "part" || r.partId === part?.id)
      .sort((a,b) => (a.role === "part" ? -1 : b.role === "part" ? 1 : 0));
    const finalPrompt = imagePrompt(job.request, part, refs),startedAt = new Date().toISOString();
    const selection = job.request.provider || { id: "codex-native" };
    const output = await service.connections.generate(selection, { cwd: folder, prompt: finalPrompt,
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

export async function runTemplateImages(service, job) {
  const parts = job.request.parts.length ? job.request.parts : [null];
  let next = 0,failure;
  job.currentParts = [];
  job.status = "generating";
  const worker = async () => {
    while (next < parts.length && !failure && !service.closed && !job.controller.signal.aborted) {
      const index = next++,part = parts[index],key = part?.id || "角色形象";
      job.currentParts.push(key);job.currentPart = job.currentParts[0];
      try {
        await service.persist(job);
        job.controller.signal.throwIfAborted();
        await service.generatePart(job,part,index);
      } catch (error) { failure ||= error; }
      finally {
        job.currentParts = job.currentParts.filter((id) => id !== key);
        job.currentPart = job.currentParts[0];
        await service.persist(job);
      }
    }
  };
  const results = await Promise.allSettled(Array.from({length:Math.min(parts.length,job.request.concurrency || 1)},worker));
  failure ||= results.find((result) => result.status === "rejected")?.reason;
  if (failure) throw failure;
  job.controller.signal.throwIfAborted();
}

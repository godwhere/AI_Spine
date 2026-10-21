import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rigPartPrompt, RIG_PART_IMAGE_INSTRUCTIONS, appearancePrompt, RIG_APPEARANCE_IMAGE_INSTRUCTIONS, RIG_REFERENCE_IMAGE_INSTRUCTIONS } from "./rig-prompts.mjs";
import { base64, PNG, checkPNGSize } from "../rig-request.mjs";

export async function generatePart(service, job, partId, index) {
    const request = job.request, rig = request.rig, part = rig.parts.find((part) => part.id === partId), signal = job.controller.signal;
    const { createCanvas, loadImage } = await import("@napi-rs/canvas"), folder = join(service.root, job.id);
    const source = await loadImage(await readFile(join(folder, "source.png"))), crop = createCanvas(part.width, part.height);
    crop.getContext("2d").drawImage(source, part.x, part.y, part.width, part.height, 0, 0, part.width, part.height);
    const cropPath = join(folder, `reference-${index}.png`); await writeFile(cropPath, crop.toBuffer("image/png"), { mode: 0o600 });
    signal.throwIfAborted();
    const separateFeatures = rig.parts.some((feature) => feature.attachmentGroup && feature.bone === part.bone && /eye|brow|mouth|眼|眉|嘴|口/i.test(`${feature.attachmentGroup} ${feature.id} ${feature.label}`));
    const identity = `${part.id} ${part.label}`;
    const expression = part.attachmentGroup && /eye|brow|mouth|眼|眉|嘴|口/i.test(`${part.attachmentGroup} ${identity}`);
    const blankFace = !part.attachmentGroup && separateFeatures && /head|face|脸|面部|头部|(?:^|\s)头(?:$|\s)/i.test(identity) && !/hair|cap|hat|helmet|gear|发|帽|头饰|冠/i.test(identity);
    const overlapPrompt = [
      "PRODUCTION RIG: one complete independent part for continuous skeletal animation with joint overlap, not a visible-only cutout.",
      "Retain real hidden surfaces and rounded joint ends so adjacent limbs, sleeves, clothing and hair can overlap when rotated. Do not crop a joint flush to the visible source boundary or narrow the part to its exposed strip.",
      "Draw only this named part: do not include neighboring limbs, hair, clothing, skin, props or a whole-body substitute. Keep its original character proportions, setup orientation, local scale and attachment points; use the fixed logical rectangle without stretching.",
      ...(blankFace ? ["BLANK FACE BASE: make one complete filled face/ear support surface with continuous blank skin. No eyes, eyebrows or mouth; they are separate attachments. Do not punch holes, transparent eye sockets or mouth cutouts into the face. Do not include front hair, neck collar or other neighboring parts."] : []),
      ...(expression ? ["This is one isolated expression attachment. Preserve its own complete strokes and transparent surroundings; do not add the full face or a skin-colored background patch."] : part.attachmentGroup ? ["This is one isolated hand, body or equipment attachment variant. Draw its complete filled support shape and material, including skin for a hand; it is not a facial-expression stroke layer. Remove all neighboring parts."] : []),
      "Native transparent PNG only. Keep the full independent support shape inside the canvas. Human review and later calibration will verify hidden anatomy, isolation and overlap; do not claim automatic approval.",
    ].join("\n");
    const output = await service.connections.generate(request.provider, { cwd: folder, prompt: `${rigPartPrompt(rig, part, request.prompt)}\n\n${overlapPrompt}`,
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

export async function generateAppearance(service, job) {
    const request = job.request, signal = job.controller.signal, folder = join(service.root, job.id);
    const output = await service.connections.generate(request.provider, { cwd: folder, prompt: appearancePrompt(request),
      references: [join(folder, "source.png")], signal, instructions: request.referenceTarget ? RIG_REFERENCE_IMAGE_INSTRUCTIONS : RIG_APPEARANCE_IMAGE_INSTRUCTIONS });
    signal.throwIfAborted();
    const bytes = base64(output.result);
    if (!bytes.subarray(0, 8).equals(PNG)) throw new Error("AI 未返回 PNG 角色形象。");
    checkPNGSize(bytes);
    await writeFile(join(folder, "image-0-raw.png"), bytes, { mode: 0o600 });
    const { createCanvas, loadImage } = await import("@napi-rs/canvas"), image = await loadImage(bytes);
    if (!image.width || !image.height || image.width > 4096 || image.height > 4096 || image.width * image.height > 16 * 1024 * 1024)
      throw new Error("AI 角色画布过大或无效。");
    // Check the actual output before adding margins; an opaque image must not pass via letterboxing.
    const original = createCanvas(image.width, image.height); original.getContext("2d").drawImage(image, 0, 0);
    const pixels = original.getContext("2d").getImageData(0, 0, image.width, image.height).data;
    let visible = false, transparent = false;
    for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] > 8) visible = true; if (pixels[i] < 247) transparent = true; }
    if (!visible || !transparent) throw new Error(!visible ? "AI 角色形象完全透明，未生成有效内容。" : "AI 角色形象没有透明背景，请重新生成。");
    const width = request.referenceTarget ? image.width : 1024, height = request.referenceTarget ? image.height : 1024, padding = 32, canvas = createCanvas(width, height);
    const scale = Math.min((width - padding * 2) / image.width, (height - padding * 2) / image.height);
    const drawnWidth = image.width * scale, drawnHeight = image.height * scale;
    canvas.getContext("2d").drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
    signal.throwIfAborted();
    const id = "image-0", file = `${id}.png`; await writeFile(join(folder, file), request.referenceTarget ? bytes : canvas.toBuffer("image/png"), { mode: 0o600 });
    signal.throwIfAborted();
    job.images.push({ id, file, kind: "appearance", width, height, sourceFingerprint: request.sourceFingerprint,
      raw: { id: "image-0-raw", file: "image-0-raw.png", width: image.width, height: image.height, url: `/api/rig/jobs/${job.id}/images/image-0-raw` },
      ...(request.referenceTarget ? { targetWidth: request.width, targetHeight: request.height, requiresCalibration: width !== request.width || height !== request.height } : {}),
      provider: request.provider.id, transparent: true, aiGenerated: true, url: `/api/rig/jobs/${job.id}/images/${id}` });
    job.model = output.model; job.result = { images: job.images };
}

export async function generateParts(service, job) {
    let next = 0, failure; job.currentParts = [];
    const worker = async () => {
      while (next < job.request.partIds.length && !failure && !job.controller.signal.aborted && !service.closed) {
        const index = next++, partId = job.request.partIds[index]; job.currentParts.push(partId);
        try { await service.persist(job); await service.generatePart(job, partId, index); }
        catch (error) { failure ||= new Error(`${partId}：${error.message || "部件补绘失败。"}`); }
        finally { job.currentParts = job.currentParts.filter((id) => id !== partId); await service.persist(job); }
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: Math.min(job.request.concurrency, job.request.partIds.length) }, worker));
    failure ||= workers.find((result) => result.status === "rejected")?.reason;
    if (failure) throw failure;
    job.controller.signal.throwIfAborted(); job.result = { images: job.images };
}

const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
export const TEMPLATE_ACTIVE = new Set(["queued", "connecting", "generating", "validating"]);
export function concurrencyValue(value = 1) {
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
export function decodePNG(value) {
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

export function publicJob(job) {
  return {
    id: job.id, projectId: job.request.projectId, fingerprint: job.request.template.fingerprint,
    kind: job.request.kind, prompt: job.request.prompt, status: job.status,
    provider: job.request.provider || { id: "codex-native", label: "Codex 账号" },
    partIds: job.request.parts.map((part)=>part.id),
    createdAt: job.createdAt, updatedAt: job.updatedAt, error: job.error,
    total: job.request.parts.length || 1, completed: job.images.length,
    concurrency: Math.min(job.request.concurrency || 1,job.request.parts.length || 1),
    currentParts: TEMPLATE_ACTIVE.has(job.status) ? job.currentParts || [job.currentPart].filter(Boolean) : [],
    currentPart: TEMPLATE_ACTIVE.has(job.status) ? job.currentPart : undefined, images: job.images,
  };
}

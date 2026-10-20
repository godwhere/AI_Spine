import { validateRigSourcePolygon } from "../../shared/rig-schema.mjs";

const activeStatuses = new Set(["queued", "analyzing", "generating"]);
export const isRigJobActive = (job) => activeStatuses.has(job?.status);

export function rigGeometry(document) {
  return {
    width: document.width,
    height: document.height,
    joints: document.joints.map(({ id, parent, x, y }) => ({ id, parent, x, y })),
    parts: document.parts.map(({ id, bone, x, y, width, height, z, binding, influences, grip, mesh, attachmentGroup }) => ({ id, bone, x, y, width, height, z, binding, influences, grip: grip || null, mesh: mesh || null, attachmentGroup: attachmentGroup || null })),
    defaultAttachments: document.defaultAttachments || {},
  };
}

export function assertRigJobMatches(document, job) {
  if (job.projectId !== document.id) throw new Error("这项生成任务属于另一份骨架草稿。");
  if (job.geometry && JSON.stringify(rigGeometry(job.geometry)) !== JSON.stringify(rigGeometry(document)))
    throw new Error("骨架、部件矩形或绑定已改变，请基于当前草稿重新生成。已有候选未应用。");
}

export function rigAttachmentGroups(document) {
  const groups = new Map();
  for (const part of document.parts) if (part.attachmentGroup) {
    if (!groups.has(part.attachmentGroup)) groups.set(part.attachmentGroup, []);
    groups.get(part.attachmentGroup).push(part);
  }
  return [...groups].map(([id, parts]) => ({ id, parts,
    defaultPartId: Object.hasOwn(document.defaultAttachments || {}, id) ? document.defaultAttachments[id] : parts[0].id }));
}

export function rigDefaultVisiblePartIds(document, overrides = {}) {
  const groups = rigAttachmentGroups(document), selected = {};
  for (const group of groups) {
    const value = Object.hasOwn(overrides, group.id) ? overrides[group.id] : group.defaultPartId;
    selected[group.id] = value === null || group.parts.some((part) => part.id === value) ? value : group.defaultPartId;
  }
  return document.parts.filter((part) => !part.attachmentGroup || selected[part.attachmentGroup] === part.id).map((part) => part.id);
}

function cleanAttachmentReferences(document) {
  const groups = rigAttachmentGroups(document), byGroup = new Map(groups.map((group) => [group.id, new Set(group.parts.map((part) => part.id))]));
  const defaults = Object.fromEntries(groups.map((group) => [group.id,
    group.defaultPartId === null || byGroup.get(group.id).has(group.defaultPartId) ? group.defaultPartId : group.parts[0].id]));
  const motions = document.motions.map((motion) => ({ ...motion, poses: motion.poses.map((pose) => {
    if (!pose.attachments) return pose;
    return { ...pose, attachments: Object.fromEntries(Object.entries(pose.attachments).filter(([id, value]) => byGroup.has(id) && (value === null || byGroup.get(id).has(value)))) };
  }) }));
  return { ...document, ...(groups.length || document.defaultAttachments ? { defaultAttachments: defaults } : {}), motions };
}

export function rigWithPartAttachmentGroup(document, partId, groupId = "") {
  const part = document.parts.find((item) => item.id === partId);
  if (!part) throw new Error("找不到要分组的部件。");
  if (groupId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(groupId)) throw new Error("显示组 ID 请使用 1–96 位字母、数字、下划线或连字符，首位为字母或数字。");
  const sibling = groupId && document.parts.find((item) => item.id !== partId && item.attachmentGroup === groupId);
  const updated = { ...part };
  if (groupId) updated.attachmentGroup = groupId; else delete updated.attachmentGroup;
  if (sibling) {
    updated.z = sibling.z;
    if (updated.bone !== sibling.bone) { updated.bone = sibling.bone; updated.influences = [sibling.bone]; delete updated.mesh; delete updated.grip; }
  }
  return cleanAttachmentReferences({ ...document, parts: document.parts.map((item) => item.id === partId ? updated : item) });
}

export function rigWithPartFields(document, partId, fields) {
  const part = document.parts.find((item) => item.id === partId);
  if (!part) throw new Error("找不到要修改的部件。");
  const shared = {};
  if (part.attachmentGroup) {
    if (Object.hasOwn(fields, "z")) shared.z = fields.z;
    if (Object.hasOwn(fields, "bone")) Object.assign(shared, { bone: fields.bone, influences: [fields.bone], mesh: undefined, grip: undefined });
  }
  return { ...document, parts: document.parts.map((item) => item.id === partId ? { ...item, ...fields }
    : part.attachmentGroup && item.attachmentGroup === part.attachmentGroup ? { ...item, ...shared } : item) };
}

export function rigWithoutPart(document, partId) {
  if (document.parts.length <= 1) throw new Error("至少保留一个部件；可先添加新部件后再删除。");
  return cleanAttachmentReferences({ ...document, parts: document.parts.filter((part) => part.id !== partId) });
}

export function rigWithDefaultAttachment(document, groupId, partId) {
  const group = rigAttachmentGroups(document).find((item) => item.id === groupId);
  if (!group || (partId !== null && !group.parts.some((part) => part.id === partId))) throw new Error("默认附件不属于这个显示组。");
  return { ...document, defaultAttachments: { ...document.defaultAttachments, [groupId]: partId } };
}

export function rigReadiness(document) {
  const parts = document.parts || [];
  const pending = parts.filter((part) => !part.image || part.completion !== "ready" || !["uploaded", "ai", "calibrated"].includes(part.imageSource));
  return { ready: parts.length > 0 && pending.length === 0, total: parts.length, completed: parts.length - pending.length, pending };
}

export function bytesToImageDataURL(bytes, type = "image/png") {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return `data:${type};base64,${btoa(binary)}`;
}

export function rigSourceRequest(document) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(document.sourceImage || "");
  if (!match) throw new Error("请先导入角色立绘。");
  return { base64: match[1], width: document.width, height: document.height };
}

export async function rigSourceFingerprint(document) {
  const { base64 } = rigSourceRequest(document);
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function rigCompositionFingerprint(document) {
  const visible = new Set(rigDefaultVisiblePartIds(document));
  const value = { width: document.width, height: document.height, sourceImage: document.sourceImage,
    defaultAttachments: Object.fromEntries(Object.entries(document.defaultAttachments || {}).sort(([a], [b]) => a.localeCompare(b))),
    parts: document.parts.filter((part) => visible.has(part.id)).map(({ id, image, x, y, width, height, z, attachmentGroup }) => ({ id, image, x, y, width, height, z, attachmentGroup: attachmentGroup || null })) };
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assertRigAppearanceMatches(document, job) {
  if (job?.projectId !== document.id) throw new Error("这项形象候选属于另一份骨架草稿。");
  const images = job.result?.images || job.images || [];
  if (job.kind !== "appearance" || job.status !== "completed" || images.length !== 1)
    throw new Error("这项形象生成还没有完整的可应用候选。");
  if (job.sourceWidth !== document.width || job.sourceHeight !== document.height || job.sourceFingerprint !== await rigSourceFingerprint(document))
    throw new Error("身份参考立绘已改变，请基于当前立绘重新生成。已有候选未应用。");
  const candidate = images[0];
  if (candidate.sourceFingerprint !== job.sourceFingerprint || candidate.width !== 1024 || candidate.height !== 1024)
    throw new Error("形象候选的来源或画布尺寸无效，未应用。");
  return candidate;
}

export async function assertRigPartJobMatches(document, job) {
  assertRigJobMatches(document, job);
  if (job.kind !== "parts" || !job.geometry) throw new Error("这项记录缺少可验证的部件快照，请基于当前草稿重新补绘。");
  if (job.sourceWidth !== document.width || job.sourceHeight !== document.height || !job.sourceFingerprint || job.sourceFingerprint !== await rigSourceFingerprint(document))
    throw new Error("部件补绘的源立绘已改变或无法验证，已有候选未应用。请基于当前立绘重新补绘。");
  const images = job.result?.images || job.images || [];
  if (images.some((image) => image.sourceFingerprint !== job.sourceFingerprint))
    throw new Error("部件候选与生成时的源立绘不一致，未应用。");
  return images;
}

export function rigRegistrationPolygons(document, polygons) {
  const visible = rigDefaultVisiblePartIds(document);
  if (!polygons || typeof polygons !== "object" || Array.isArray(polygons) || Object.keys(polygons).length !== visible.length || visible.some((id) => !Object.hasOwn(polygons, id)))
    throw new Error("坐标计划必须覆盖每个默认可见部件，不能包含其他表情变体或未知部件。");
  return Object.fromEntries(visible.map((id) => {
    return [id, validateRigSourcePolygon(polygons[id], document.width, document.height, `部件 ${id} 原图轮廓`)];
  }));
}

export async function assertRigRegistrationMatches(document, job) {
  assertRigJobMatches(document, job);
  if (job.kind !== "registration" || job.status !== "completed" || !job.geometry || job.result?.gridSize !== 32)
    throw new Error("这项坐标规划还没有完整且可验证的结果。");
  if (job.sourceWidth !== document.width || job.sourceHeight !== document.height || !job.sourceFingerprint || job.sourceFingerprint !== await rigSourceFingerprint(document))
    throw new Error("坐标计划的源立绘已改变或无法验证，请基于当前立绘重新规划。");
  return rigRegistrationPolygons(document, job.result.polygons);
}

export function rigRetryablePartIds(job) {
  if (job?.kind !== "parts" || !["failed", "cancelled"].includes(job.status)) return [];
  const finished = new Set((job.result?.images || job.images || []).map((image) => image.partId));
  return [...new Set(job.partIds || [])].filter((id) => !finished.has(id));
}

export function rigWithAppearance(document, job, image) {
  if (!image?.dataURL || image.width !== 1024 || image.height !== 1024 || !image.transparent)
    throw new Error("Q 版形象必须是 1024 × 1024 的真实透明图片。");
  const candidate = (job.result?.images || job.images || [])[0];
  return { ...document, width: image.width, height: image.height, sourceImage: image.dataURL, origin: "ai-appearance", joints: [], parts: [], motions: [], defaultAttachments: {}, registration: undefined,
    appearanceReference: document.appearanceReference || { image: document.sourceImage, width: document.width, height: document.height },
    appearance: { prompt: job.prompt || document.prompts?.appearance || "", jobId: job.id, imageId: candidate?.id,
      sourceFingerprint: job.sourceFingerprint, provider: typeof job.provider === "string" ? job.provider : job.provider?.id || job.provider?.label,
      providerLabel: job.providerLabel || job.provider?.label, model: job.model, createdAt: job.createdAt } };
}

export function createRigClient(fetcher = fetch) {
  const call = async (path, options) => {
    const response = await fetcher(`/api/rig/${path}`, options);
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error("骨架 AI 服务尚未就绪，请重新打开最新版 iSpine。");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "骨架 AI 请求失败。");
    return result;
  };
  return {
    start: (request) => call("jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }),
    get: (id) => call(`jobs/${encodeURIComponent(id)}`),
    list: async (projectId) => (await call(`jobs?projectId=${encodeURIComponent(projectId)}`)).jobs,
    cancel: (id) => call(`jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    retry: (id, { concurrency = 2 } = {}) => call(`jobs/${encodeURIComponent(id)}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ concurrency }) }),
    async image(jobId, image) {
      const prefix = `/api/rig/jobs/${encodeURIComponent(jobId)}/images/`;
      const path = image.url || (image.id ? prefix + encodeURIComponent(image.id) : "");
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/") || /[?#]|\.\./.test(path))
        throw new Error("生成部件地址无效。");
      const response = await fetcher(path);
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png"))
        throw new Error("部件图片读取失败，请重新打开生成记录。");
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

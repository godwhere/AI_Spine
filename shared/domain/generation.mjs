import { decodeBase64 } from "../codec/base64.mjs";
import { rigDefaultVisiblePartIds } from "./rig.mjs";
import { rigGeometry } from "./rig.mjs";
import { sha256 } from "../codec/sha256.mjs";
import { validateRigSourcePolygon } from "../rig-schema.mjs";

const activeStatuses = new Set(["queued", "analyzing", "generating"]);

const isRigJobActive = (job) => activeStatuses.has(job?.status);

export function assertTemplateCandidateProject(projectId, job) {
  if (typeof projectId !== "string" || !projectId || job?.projectId !== projectId)
    throw new Error("候选属于另一份资源，未应用。请重新打开当前资源的生成记录。");
}

function assertRigJobMatches(document, job) {
  if (job.projectId !== document.id) throw new Error("这项生成任务属于另一份骨架草稿。");
  if (job.geometry && JSON.stringify(rigGeometry(job.geometry)) !== JSON.stringify(rigGeometry(document)))
    throw new Error("骨架、部件矩形或绑定已改变，请基于当前草稿重新生成。已有候选未应用。");
}

function rigSourceRequest(document) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(document.sourceImage || "");
  if (!match) throw new Error("请先导入角色立绘。");
  return { base64: match[1], width: document.width, height: document.height };
}

async function rigSourceFingerprint(document) {
  const { base64 } = rigSourceRequest(document); return sha256(decodeBase64(base64));
}

async function rigCompositionFingerprint(document) {
  const visible = new Set(rigDefaultVisiblePartIds(document));
  const value = { width: document.width, height: document.height, sourceImage: document.sourceImage,
    defaultAttachments: Object.fromEntries(Object.entries(document.defaultAttachments || {}).sort(([a], [b]) => a.localeCompare(b))),
    parts: document.parts.filter((part) => visible.has(part.id)).map(({ id, image, x, y, width, height, z, attachmentGroup }) => ({ id, image, x, y, width, height, z, attachmentGroup: attachmentGroup || null })) };
  return sha256(JSON.stringify(value));
}

async function assertRigAppearanceMatches(document, job) {
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

async function assertRigPartJobMatches(document, job) {
  assertRigJobMatches(document, job);
  if (job.kind !== "parts" || !job.geometry) throw new Error("这项记录缺少可验证的部件快照，请基于当前草稿重新补绘。");
  if (job.sourceWidth !== document.width || job.sourceHeight !== document.height || !job.sourceFingerprint || job.sourceFingerprint !== await rigSourceFingerprint(document))
    throw new Error("部件补绘的源立绘已改变或无法验证，已有候选未应用。请基于当前立绘重新补绘。");
  const images = job.result?.images || job.images || [];
  if (images.some((image) => image.sourceFingerprint !== job.sourceFingerprint))
    throw new Error("部件候选与生成时的源立绘不一致，未应用。");
  return images;
}

function rigRegistrationPolygons(document, polygons) {
  const visible = rigDefaultVisiblePartIds(document);
  if (!polygons || typeof polygons !== "object" || Array.isArray(polygons) || Object.keys(polygons).length !== visible.length || visible.some((id) => !Object.hasOwn(polygons, id)))
    throw new Error("坐标计划必须覆盖每个默认可见部件，不能包含其他表情变体或未知部件。");
  return Object.fromEntries(visible.map((id) => {
    return [id, validateRigSourcePolygon(polygons[id], document.width, document.height, `部件 ${id} 原图轮廓`)];
  }));
}

async function assertRigRegistrationMatches(document, job) {
  assertRigJobMatches(document, job);
  if (job.kind !== "registration" || job.status !== "completed" || !job.geometry || job.result?.gridSize !== 32)
    throw new Error("这项坐标规划还没有完整且可验证的结果。");
  if (job.sourceWidth !== document.width || job.sourceHeight !== document.height || !job.sourceFingerprint || job.sourceFingerprint !== await rigSourceFingerprint(document))
    throw new Error("坐标计划的源立绘已改变或无法验证，请基于当前立绘重新规划。");
  return rigRegistrationPolygons(document, job.result.polygons);
}

function rigRetryablePartIds(job) {
  if (job?.kind !== "parts" || !["failed", "cancelled"].includes(job.status)) return [];
  const finished = new Set((job.result?.images || job.images || []).map((image) => image.partId));
  return [...new Set(job.partIds || [])].filter((id) => !finished.has(id));
}

function rigWithAppearance(document, job, image) {
  if (!image?.dataURL || image.width !== 1024 || image.height !== 1024 || !image.transparent)
    throw new Error("Q 版形象必须是 1024 × 1024 的真实透明图片。");
  const candidate = (job.result?.images || job.images || [])[0];
  return { ...document, width: image.width, height: image.height, sourceImage: image.dataURL, origin: "ai-appearance", joints: [], parts: [], motions: [], defaultAttachments: {}, registration: undefined,
    appearanceReference: document.appearanceReference || { image: document.sourceImage, width: document.width, height: document.height },
    appearance: { prompt: job.prompt || document.prompts?.appearance || "", jobId: job.id, imageId: candidate?.id,
      sourceFingerprint: job.sourceFingerprint, provider: typeof job.provider === "string" ? job.provider : job.provider?.id || job.provider?.label,
      providerLabel: job.providerLabel || job.provider?.label, model: job.model, createdAt: job.createdAt } };
}

async function templateFingerprint(bundle) {
  const chunks = [bundle.skeletonPath,...(bundle.atlasPaths||[])].sort().flatMap((path)=>[
    new TextEncoder().encode(`${path}\0`), bundle.files[path],
  ]);
  const bytes = new Uint8Array(chunks.reduce((sum,chunk)=>sum+chunk.length,0));
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return sha256(bytes);
}

export { assertRigAppearanceMatches, assertRigJobMatches, assertRigPartJobMatches, assertRigRegistrationMatches, isRigJobActive, rigCompositionFingerprint, rigRegistrationPolygons, rigRetryablePartIds, rigSourceFingerprint, rigSourceRequest, rigWithAppearance, templateFingerprint };

import { decodeBase64 } from "../codec/base64.mjs";
import { MOTION_MAX_GAP_RATIO } from "./motion-ownership.mjs";
import { rigGeometry } from "./rig.mjs";
import { sha256 } from "../codec/sha256.mjs";
import { validateMotionStudyMapping } from "../rig-schema.mjs";

const isMotionStudyPlaybackActive = (study) => Boolean(study?.applied && study.playback !== "reference");

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonical(value[key])])) : value;

const bytes = (url) => decodeBase64(url.slice(url.indexOf(",") + 1));

function motionStudyFingerprints(document) {
  if (!document.sourceImage) throw new Error("逐帧动作需要固定的原始角色立绘。");
  return { baseFingerprint: sha256(bytes(document.sourceImage)), geometryFingerprint: sha256(JSON.stringify(rigGeometry(document))),
    protectedIdleFingerprint: sha256(JSON.stringify(document.motions.find((motion) => motion.id === "idle") || null)),
    originalArtworkFingerprint: sha256(JSON.stringify(document.parts.map(({ id,image,bone,binding,influences,mesh,grip }) => ({ id,image,bone,binding,influences,mesh:mesh||null,grip:grip||null })))) };
}

async function getMotionStudyFingerprints(document) { return motionStudyFingerprints(document); }

function currentStudy(document, motionId) {
  const study = document.motionStudies?.[motionId];
  if (!study) throw new Error(`动作图计划不存在：${motionId}`);
  if (motionId === "idle") throw new Error("逐帧动作不能覆盖受保护的原始待机。");
  const current = motionStudyFingerprints(document);
  for (const key of Object.keys(current)) if (study[key] !== current[key]) throw new Error(`角色原图、几何、原部件或待机已改变（${key}），请重新审阅动作图。`);
  return study;
}

function frameImage(study, frame) {
  if (frame.image) return frame.image;
  if (frame.imageRef) return frameImage(study, study.frames.find((value) => value.id === frame.imageRef));
  throw new Error(`动作画面尚未完成：${frame.id}`);
}

const approved = (value) => value === true || value?.approved === true;

function contentFingerprint(study) {
  return sha256(JSON.stringify(canonical(study.frames.map(({ id,time,image,imageRef,sourceFingerprint,mapping,segments,review,mappingReview,playbackTransform }) => ({ id,time,image,imageRef,sourceFingerprint,mapping,segments,review,mappingReview,playbackTransform })))));
}

export function motionStudyFrameAnchor(frame) {
  if (frame.playbackTransform) return { ...frame.playbackTransform.anchor };
  const joints = frame.mapping?.joints || [];
  const contact = joints.filter((joint) => /(?:foot|toe)$/i.test(joint.id)).sort((a, b) => b.y - a.y)[0]
    || joints.find((joint) => joint.id === "root") || joints[0];
  return { x: contact?.x || 0, y: contact?.y || 0 };
}

export function setMotionStudyFrameScale(study, frameId, scale, anchor) {
  if (!Number.isFinite(scale) || scale < .1 || scale > 2) throw new Error("整帧缩放须在 10% 至 200% 之间。");
  const frame = study?.frames?.find((item) => item.id === frameId);
  if (!frame?.mapping) throw new Error("请先完成当前动作画面的关节与部件对应。");
  anchor ||= motionStudyFrameAnchor(frame);
  if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) throw new Error("整帧缩放基准坐标无效。");
  if (study.applied && (study.applied.kind !== "stepped-parts" || study.applied.outOfDate
    || study.applied.contentFingerprint !== contentFingerprint(study))) throw new Error("逐帧内容已改变，请重新检查并应用后再调整播放缩放。");
  const next = { ...study, frames: study.frames.map((item) => {
    if (item.id !== frameId) return item;
    const value = { ...item };
    if (scale === 1) delete value.playbackTransform;
    else value.playbackTransform = { scale, anchor: { x: anchor.x, y: anchor.y } };
    return value;
  }) };
  if (study.applied) next.applied = { ...study.applied, contentFingerprint: contentFingerprint(next) };
  return next;
}

function requireComplete(document, motionId, study, reviews) {
  const motion = document.motions.find((item) => item.id === motionId);
  if (study.frames.length < 2 || study.frames[0].time !== 0 || study.frames.at(-1).time !== motion.duration) throw new Error("逐帧动作需要起点和结束时间，至少两个独立部件姿势。");
  const unique = new Set();
  for (const frame of study.frames) {
    const hash = sha256(bytes(frameImage(study, frame))); unique.add(hash);
    if (hash !== frame.sourceFingerprint) throw new Error(`动作画面来源指纹已改变：${frame.id}`);
    if (frame.origin === "base" && hash !== study.baseFingerprint) throw new Error(`原图帧与固定角色立绘不一致：${frame.id}`);
    validateMotionStudyMapping(frame.mapping, document, frame);
    if (reviews && (!approved(frame.review) || !approved(frame.mappingReview))) throw new Error(`请先审阅动作画面与部件坐标：${frame.id}`);
    if (!frame.segments?.length || frame.segments.some((segment) => !segment.image || !segment.visibleOnly || segment.origin !== "source-visible")) throw new Error(`动作画面尚未拆成独立可见部件：${frame.id}`);
    const expected = frame.mapping.parts.filter((part) => part.visible).map((part) => part.partId).sort(), actual = frame.segments.map((part) => part.partId).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual) || actual.length < 2) throw new Error(`动作画面的可见部件不完整，禁止用整图代替拆件：${frame.id}`);
    if (frame.compositionMetrics?.alphaIoU !== 1 || frame.compositionMetrics.missingAlphaPixels || frame.compositionMetrics.extraAlphaPixels || frame.compositionMetrics.maxChannelError > 2) throw new Error(`动作画面缺少有效的源像素重组验收：${frame.id}`);
  }
  if (unique.size > 5) throw new Error("每动作最多 5 张独立动作画面。");
}

const samplingCache = new WeakMap();

function assertAppliedMotionStudy(document, motionId, { cache = false } = {}) {
  const cached = samplingCache.get(document)?.get(motionId), candidate = document.motionStudies?.[motionId];
  if (cache && cached?.study === candidate && cached?.applied === candidate.applied) return candidate;
  const study = currentStudy(document, motionId);
  requireComplete(document, motionId, study, true);
  if (study.applied?.kind !== "stepped-parts" || study.applied.contentFingerprint !== contentFingerprint(study) || study.applied.outOfDate) throw new Error("逐帧部件或审阅状态已经改变，请重新检查并应用。");
  if (cache) { if (!samplingCache.has(document)) samplingCache.set(document,new Map()); samplingCache.get(document).set(motionId,{study,applied:study.applied}); }
  return study;
}

function motionStudyMappingFingerprint(mapping) {
  if (!mapping) return sha256("null");
  const value={frameId:mapping.frameId,sourceFingerprint:mapping.sourceFingerprint,joints:mapping.joints.map(({id,x,y})=>({id,x,y})),
    parts:mapping.parts.map(({partId,visible,z,sourcePolygon})=>({partId,visible,z,...(visible?{sourcePolygon}: {})}))};
  return sha256(JSON.stringify(canonical(value)));
}

function ownerFingerprint(owners) {
  const raw=new Uint8Array(owners.length*2),view=new DataView(raw.buffer);for(let i=0;i<owners.length;i++)view.setInt16(i*2,owners[i],true);return sha256(raw);
}

function requireGapAllowed(result) {
  if(result.significantGapRatio>MOTION_MAX_GAP_RATIO)throw new Error(`主体缺口 ${(result.significantGapRatio*100).toFixed(2)}% 超过 15%，请修正轮廓，不能以距离推定代替拆分。`);
  if(result.unresolvedSignificantPixels)throw new Error(`还有 ${result.unresolvedSignificantPixels} 个主体像素无法在 ${result.maxAllowedDistance} px 内归属物理部件，请修正轮廓。`);
}

function gapPolicy(frame,result,maxDistance) {
  requireGapAllowed(result);
  return {version:1,method:"nearest-physical-boundary",sourceFingerprint:frame.sourceFingerprint,mappingFingerprint:motionStudyMappingFingerprint(frame.mapping),maxDistance,
    maxGapRatio:.15,significantAlphaMin:9,inferredPixels:result.addedPixels,observedGapRatio:result.significantGapRatio,observedMaxDistance:result.maxDistance,ownerFingerprint:ownerFingerprint(result.owners)};
}

const motionStudyRegionName = (motionId,frameId,partId) => `ms_${motionId.slice(0,20)}_${frameId.slice(0,16)}_${partId.slice(0,24)}_${sha256(JSON.stringify([motionId,frameId,partId])).slice(0,16)}`;

const motionStudySlotName = (motionId,partId) => `ms_slot_${sha256(JSON.stringify([motionId,partId])).slice(0,40)}`;

export { assertAppliedMotionStudy, bytes, canonical, contentFingerprint, currentStudy, frameImage, gapPolicy, getMotionStudyFingerprints, isMotionStudyPlaybackActive, motionStudyFingerprints, motionStudyMappingFingerprint, motionStudyRegionName, motionStudySlotName, ownerFingerprint, requireComplete, requireGapAllowed };

import { validateRigDocument, validateMotionStudyMapping } from "../../shared/rig-schema.mjs";
import { rigGeometry, rigCompositionFingerprint } from "./rig-client.js";
import { browserPixels } from "./pixels.js";
import { rasterMotionOwners, inferMotionGapOwners, MOTION_MAX_GAP_RATIO } from "./rig-motion-ownership.js";

export const isMotionStudyPlaybackActive = (study) => Boolean(study?.applied && study.playback !== "reference");

const encoder = new TextEncoder();
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonical(value[key])])) : value;
const bytes = (url) => Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (char) => char.charCodeAt(0));
const dataURL = (value) => { let raw = ""; for (let i = 0; i < value.length; i += 0x8000) raw += String.fromCharCode(...value.subarray(i, i + 0x8000)); return `data:image/png;base64,${btoa(raw)}`; };
// Synchronous SHA-256 lets the synchronous compiler reject stale authored data
// too. It uses the same byte/JSON input as the managed-service fingerprints.
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function sha256(input) {
  const raw = typeof input === "string" ? encoder.encode(input) : input, length = Math.ceil((raw.length + 9) / 64) * 64, padded = new Uint8Array(length);
  padded.set(raw); padded[raw.length] = 128; const view = new DataView(padded.buffer), bits = raw.length * 8;
  view.setUint32(length - 8, Math.floor(bits / 2 ** 32)); view.setUint32(length - 4, bits >>> 0);
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w = new Uint32Array(64), rotr = (x,n) => x >>> n | x << 32-n;
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) { const a=w[i-15],b=w[i-2]; w[i]=(w[i-16]+(rotr(a,7)^rotr(a,18)^a>>>3)+w[i-7]+(rotr(b,17)^rotr(b,19)^b>>>10))>>>0; }
    let [a,b,c,d,e,f,g,j] = h;
    for (let i = 0; i < 64; i++) { const t1=(j+(rotr(e,6)^rotr(e,11)^rotr(e,25))+(e&f^~e&g)+K[i]+w[i])>>>0,t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+(a&b^a&c^b&c))>>>0; j=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
    for (const [i,v] of [a,b,c,d,e,f,g,j].entries()) h[i]=(h[i]+v)>>>0;
  }
  return h.map((v)=>v.toString(16).padStart(8,"0")).join("");
}
export function motionStudyFingerprints(document) {
  if (!document.sourceImage) throw new Error("逐帧动作需要固定的原始角色立绘。");
  return { baseFingerprint: sha256(bytes(document.sourceImage)), geometryFingerprint: sha256(JSON.stringify(rigGeometry(document))),
    protectedIdleFingerprint: sha256(JSON.stringify(document.motions.find((motion) => motion.id === "idle") || null)),
    originalArtworkFingerprint: sha256(JSON.stringify(document.parts.map(({ id,image,bone,binding,influences,mesh,grip }) => ({ id,image,bone,binding,influences,mesh:mesh||null,grip:grip||null })))) };
}
export async function getMotionStudyFingerprints(document) { return motionStudyFingerprints(document); }
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
  return sha256(JSON.stringify(canonical(study.frames.map(({ id,time,image,imageRef,sourceFingerprint,mapping,segments,review,mappingReview }) => ({ id,time,image,imageRef,sourceFingerprint,mapping,segments,review,mappingReview })))));
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
export function assertAppliedMotionStudy(document, motionId, { cache = false } = {}) {
  const cached = samplingCache.get(document)?.get(motionId), candidate = document.motionStudies?.[motionId];
  if (cache && cached?.study === candidate && cached?.applied === candidate.applied) return candidate;
  const study = currentStudy(document, motionId);
  requireComplete(document, motionId, study, true);
  if (study.applied?.kind !== "stepped-parts" || study.applied.contentFingerprint !== contentFingerprint(study) || study.applied.outOfDate) throw new Error("逐帧部件或审阅状态已经改变，请重新检查并应用。");
  if (cache) { if (!samplingCache.has(document)) samplingCache.set(document,new Map()); samplingCache.get(document).set(motionId,{study,applied:study.applied}); }
  return study;
}
function polygonDistance(polygon, x, y) {
  let minimum=Infinity;
  for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length],dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/Math.max(dx*dx+dy*dy,1e-9)));minimum=Math.min(minimum,(x-a.x-t*dx)**2+(y-a.y-t*dy)**2);}
  return minimum;
}
async function decoded(url, env) {
  const image=await env.loadImage(bytes(url));
  try { const canvas=env.createCanvas(image.width,image.height),context=canvas.getContext("2d");context.drawImage(image,0,0);return {canvas,width:image.width,height:image.height,data:context.getImageData(0,0,image.width,image.height).data}; }
  finally { image.close?.(); }
}
export function motionStudyMappingFingerprint(mapping) {
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
function verifiedGapOwners(document,frame,source) {
  const policy=frame.mapping.gapFill;
  if(policy.sourceFingerprint!==frame.sourceFingerprint||policy.mappingFingerprint!==motionStudyMappingFingerprint(frame.mapping))throw new Error("缺口候选的源画面或部件映射已改变，请重新诊断并明确接受候选。");
  const result=inferMotionGapOwners(document,frame.mapping,source,policy.maxDistance);requireGapAllowed(result);
  if(result.addedPixels!==policy.inferredPixels||Math.abs(result.significantGapRatio-policy.observedGapRatio)>1e-12||Math.abs(result.maxDistance-policy.observedMaxDistance)>1e-9||ownerFingerprint(result.owners)!==policy.ownerFingerprint)
    throw new Error("缺口归属策略与实际源像素不一致，请重新诊断。");
  return result;
}
async function frameOwnershipContext(document,motionId,frameId,pixels,requireMapping=true) {
  const doc=validateRigDocument(document),study=currentStudy(doc,motionId),frame=study.frames.find((value)=>value.id===frameId),env={...browserPixels,...pixels};
  if(!frame)throw new Error("动作画面不存在。");
  const image=frameImage(study,frame),fingerprint=sha256(bytes(image));
  if(fingerprint!==frame.sourceFingerprint)throw new Error("动作原画来源已改变，不能推定像素归属。");
  if(requireMapping)frame.mapping=validateMotionStudyMapping(frame.mapping,doc,frame);
  const source=await decoded(image,env);
  if(source.width!==doc.width||source.height!==doc.height||source.width*source.height>16*1024*1024)throw new Error("动作原画尺寸与坐标画布不一致。");
  return {doc,study,frame,env,source};
}
async function ownershipReport(context,result,renderReportImages=true) {
  const {source,env,frame}=context,{width,height}=source;
  const picture=async(predicate,color)=>{if(!renderReportImages)return undefined;const canvas=env.createCanvas(width,height),ctx=canvas.getContext("2d"),image=ctx.createImageData(width,height);for(let i=0;i<result.owners.length;i++)if(predicate(i))image.data.set(color(i),i*4);ctx.putImageData(image,0,0);const url=dataURL(await env.encode(canvas));canvas.width=1;canvas.height=1;return url;};
  const color=(index)=>[(index*83+63)%210+35,(index*137+31)%210+35,(index*61+107)%210+35,190];
  const missingHeatmap=await picture((i)=>source.data[i*4+3]&&result.originalOwners[i]<0,(i)=>source.data[i*4+3]>8?[255,45,45,220]:[255,187,32,180]);
  const ownerOverlay=await picture((i)=>result.originalOwners[i]>=0,(i)=>color(result.originalOwners[i]));
  const candidateOwnerOverlay=await picture((i)=>result.owners[i]>=0,(i)=>color(result.owners[i]));
  const parts=[];
  for(const [index,part]of result.parts.entries())parts.push({...part,
    ownerOverlay:await picture((i)=>result.originalOwners[i]===index,()=>color(index)),
    ...(part.addedPixels?{addedOverlay:await picture((i)=>result.originalOwners[i]<0&&result.owners[i]===index,()=>[255,125,25,225])}:{})});
  return {frameId:frame.id,sourceFingerprint:frame.sourceFingerprint,mappingFingerprint:motionStudyMappingFingerprint(frame.mapping),sourcePixels:result.sourcePixels,significantPixels:result.significantPixels,
    missingPixels:result.missingPixels,missingSignificantPixels:result.missingSignificantPixels,weakMissingPixels:result.weakMissingPixels,significantGapRatio:result.significantGapRatio,
    missingBounds:result.missingBounds,significantMissingBounds:result.significantMissingBounds,maxDistance:Number.isFinite(result.maxDistance)?result.maxDistance:null,maxAllowedDistance:result.maxAllowedDistance,
    unresolvedSignificantPixels:result.unresolvedSignificantPixels,addedPixels:result.addedPixels,canPropose:result.canPropose,parts,affectedParts:parts.filter((part)=>part.addedPixels),
    missingHeatmap,ownerOverlay,candidateOwnerOverlay,heatmap:missingHeatmap,ownership:ownerOverlay,partIds:result.partIds,
    inferred:result.addedPixels>0,proposalOnly:true,description:"仅为未归属主体像素提出最近物理部件边界推定；原有归属不变，推定不是精确 AI 分割，尚需逐部件审阅。"};
}
export async function diagnoseMotionStudyFrame(document,motionId,frameId,{maxDistance=64,pixels=browserPixels}={}) {
  const context=await frameOwnershipContext(document,motionId,frameId,pixels),result=inferMotionGapOwners(context.doc,context.frame.mapping,context.source,maxDistance);
  return ownershipReport(context,result);
}
async function gapOwnershipCandidate(document,motionId,frameId,{maxDistance=64,pixels=browserPixels}={},renderReportImages=true) {
  const context=await frameOwnershipContext(document,motionId,frameId,pixels),{frame}=context,result=inferMotionGapOwners(context.doc,frame.mapping,context.source,maxDistance);
  requireGapAllowed(result);if(!result.addedPixels)throw new Error("当前没有需要推定的主体缺口，请直接检查原部件映射。");
  const mapping={...frame.mapping,gapFill:gapPolicy(frame,result,maxDistance)};
  return {kind:"gap-fill",frameId,sourceFingerprint:frame.sourceFingerprint,mappingFingerprint:motionStudyMappingFingerprint(frame.mapping),mapping,report:await ownershipReport(context,result,renderReportImages)};
}
export async function proposeMotionStudyGapOwnership(document,motionId,frameId,options) {
  return gapOwnershipCandidate(document,motionId,frameId,options);
}
async function calibratedBaseCandidate(document,motionId,frameId,{pixels=browserPixels}={},renderReportImages=true) {
  const context=await frameOwnershipContext(document,motionId,frameId,pixels,false),{doc,study,frame}=context,previousFingerprint=motionStudyMappingFingerprint(frame.mapping);
  if(frame.sourceFingerprint!==study.baseFingerprint||doc.registration?.sourceFingerprint!==frame.sourceFingerprint||
      !doc.registration.compositionFingerprint||doc.registration.compositionFingerprint!==await rigCompositionFingerprint(doc))throw new Error("这张画面不是当前已校准基准，或原配准来源/画面组合指纹已过期，不能复用历史轮廓。");
  const first=new Map();for(const part of doc.parts)if(part.attachmentGroup&&!first.has(part.attachmentGroup))first.set(part.attachmentGroup,part.id);
  const defaults=doc.defaultAttachments||{},parts=doc.parts.filter((part)=>!part.attachmentGroup||(Object.hasOwn(defaults,part.attachmentGroup)?defaults[part.attachmentGroup]:first.get(part.attachmentGroup))===part.id);
  const mapping={frameId:frame.id,sourceFingerprint:frame.sourceFingerprint,joints:doc.joints.map(({id,x,y})=>({id,x,y})),parts:parts.map((part)=>({partId:part.id,visible:true,sourcePolygon:part.sourcePolygon,z:part.z})),notes:"显式复用当前已校准基准的完整轮廓、层级和站姿关节；尚需审阅。"};
  frame.mapping=validateMotionStudyMapping(mapping,doc,frame);
  const result=inferMotionGapOwners(doc,frame.mapping,context.source,64);requireGapAllowed(result);
  if(result.addedPixels)frame.mapping.gapFill=gapPolicy(frame,result,64);
  return {kind:"base-registration",frameId,sourceFingerprint:frame.sourceFingerprint,mappingFingerprint:previousFingerprint,mapping:frame.mapping,
    baseRegistrationProof:{sourceFingerprint:doc.registration.sourceFingerprint,compositionFingerprint:doc.registration.compositionFingerprint},report:await ownershipReport(context,result,renderReportImages)};
}
export async function proposeCalibratedBaseMotionMapping(document,motionId,frameId,options) {
  return calibratedBaseCandidate(document,motionId,frameId,options);
}
export async function acceptMotionStudyOwnershipCandidate(document,motionId,frameId,candidate,{pixels=browserPixels}={}) {
  if(!candidate||candidate.frameId!==frameId||!["gap-fill","base-registration"].includes(candidate.kind))throw new Error("缺口候选不属于当前动作画面。");
  // Recompute every source/mapping/owner proof. Acceptance does not display the
  // presentation PNGs, so do not encode the already-reviewed overlays again.
  const expected=candidate.kind==="base-registration"?await calibratedBaseCandidate(document,motionId,frameId,{pixels},false):await gapOwnershipCandidate(document,motionId,frameId,{maxDistance:candidate.mapping?.gapFill?.maxDistance,pixels},false);
  for(const key of ["sourceFingerprint","mappingFingerprint"])if(candidate[key]!==expected[key])throw new Error("候选来源或映射已改变，未接受。");
  if(JSON.stringify(canonical(candidate.mapping))!==JSON.stringify(canonical(expected.mapping))||JSON.stringify(candidate.baseRegistrationProof)!==JSON.stringify(expected.baseRegistrationProof))throw new Error("候选内容与实际确定性重算不一致，未接受。");
  const doc=validateRigDocument(document),study=doc.motionStudies[motionId];delete study.applied;
  const ids=new Set([frameId]);for(const frame of study.frames)if(ids.has(frame.imageRef))ids.add(frame.id);
  for(const frame of study.frames)if(ids.has(frame.id)){
    frame.mapping={...structuredClone(expected.mapping),frameId:frame.id};
    if(frame.mapping.gapFill)frame.mapping.gapFill.mappingFingerprint=motionStudyMappingFingerprint(frame.mapping);
    frame.mappingReview={...frame.mappingReview,approved:false};delete frame.segments;delete frame.composition;delete frame.compositionMetrics;
  }
  return {document:validateRigDocument(doc),report:expected.report};
}
async function prepareFrame(document, study, frame, env) {
  const source=await decoded(frameImage(study,frame),env),{width,height}=source;
  if(width!==document.width||height!==document.height||width*height>16*1024*1024)throw new Error(`动作画面必须保持统一画布像素尺寸：${frame.id}`);
  const raster=rasterMotionOwners(frame.mapping,source),parts=raster.parts, inference=frame.mapping.gapFill?verifiedGapOwners(document,frame,source):null,owners=inference?.owners||raster.owners;
  let sourcePixelCount=0,fallbackPixels=0,missingPixels=0;
  for(let index=0;index<owners.length;index++)if(source.data[index*4+3]) {
    sourcePixelCount++; if(owners[index]>=0)continue;
    if(source.data[index*4+3]>8){missingPixels++;continue;}
    let best=Infinity,owner=-1;
    for(const [pi,part]of parts.entries()){const distance=polygonDistance(part.sourcePolygon,index%width+.5,Math.floor(index/width)+.5);if(distance<best){best=distance;owner=pi;}}
    owners[index]=owner;fallbackPixels++;
  }
  if(missingPixels)throw new Error(`动作画面 ${frame.id} 有 ${missingPixels} 个主体像素未被部件轮廓覆盖，请修正映射。`);
  const extents=parts.map(()=>({x:width,y:height,right:-1,bottom:-1,pixels:0}));
  for(let index=0;index<owners.length;index++)if(owners[index]>=0){const r=extents[owners[index]],x=index%width,y=Math.floor(index/width);r.x=Math.min(r.x,x);r.y=Math.min(r.y,y);r.right=Math.max(r.right,x);r.bottom=Math.max(r.bottom,y);r.pixels++;}
  const empty=parts.filter((_,index)=>!extents[index].pixels).map((part)=>part.partId);
  if(empty.length||parts.length<2||!sourcePixelCount||extents.some((r)=>r.pixels/sourcePixelCount>=.98))throw new Error(`动作图未形成有效独立拆件（空部件或整图占用）：${empty.join("、")||frame.id}`);
  const composition=env.createCanvas(width,height),context=composition.getContext("2d"),segments=[];
  for(const [index,part] of parts.entries()) {
    const extent=extents[index],w=extent.right-extent.x+1,h=extent.bottom-extent.y+1,canvas=env.createCanvas(w,h),ctx=canvas.getContext("2d"),image=ctx.createImageData(w,h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const si=(extent.y+y)*width+extent.x+x;if(owners[si]===index)image.data.set(source.data.subarray(si*4,si*4+4),(y*w+x)*4);}
    ctx.putImageData(image,0,0);const url=dataURL(await env.encode(canvas)),actual=await decoded(url,env);context.drawImage(actual.canvas,extent.x,extent.y);
    const inferredPixels=inference?.parts[index].addedPixels||0;
    segments.push({partId:part.partId,image:url,x:extent.x,y:extent.y,width:w,height:h,z:part.z,visibleOnly:true,origin:"source-visible",...(inferredPixels?{inferredOwnershipPixels:inferredPixels}:{})});
  }
  const actual=context.getImageData(0,0,width,height).data;let intersection=0,union=0,missingAlphaPixels=0,extraAlphaPixels=0,error=0,maxChannelError=0;
  for(let i=0;i<actual.length;i+=4){const a=source.data[i+3]>0,b=actual[i+3]>0;if(a&&b)intersection++;if(a||b)union++;if(a&&!b)missingAlphaPixels++;if(b&&!a)extraAlphaPixels++;for(let c=0;c<4;c++){const e=Math.abs(source.data[i+c]-actual[i+c]);error+=e;maxChannelError=Math.max(maxChannelError,e);}}
  const metrics={frameId:frame.id,visiblePartCount:segments.length,sourcePixelCount,fallbackPixels,alphaIoU:union?intersection/union:0,pixelMAE:error/actual.length,maxChannelError,missingAlphaPixels,extraAlphaPixels,
    parts:parts.map((part,index)=>({partId:part.partId,pixels:extents[index].pixels,bounds:{x:segments[index].x,y:segments[index].y,width:segments[index].width,height:segments[index].height},...(inference?{inferredPixels:inference.parts[index].addedPixels}:{})})),
    ...(inference?{inferredOwnership:{method:"nearest-physical-boundary",addedPixels:inference.addedPixels,significantGapRatio:inference.significantGapRatio,maxDistance:inference.maxDistance,parts:inference.parts.filter((part)=>part.addedPixels).map(({partId,addedPixels,addedBounds,maxDistance})=>({partId,addedPixels,addedBounds,maxDistance}))}}:{})};
  if(metrics.alphaIoU!==1||missingAlphaPixels||extraAlphaPixels||maxChannelError>2)throw new Error(`动作图 ${frame.id} 独立部件重组未保持源像素。`);
  return {segments,metrics,composition:dataURL(await env.encode(composition))};
}
export async function prepareMotionStudyFrames(document, motionId, mappings, { pixels = browserPixels } = {}) {
  const doc=validateRigDocument(document),study=currentStudy(doc,motionId),env={...browserPixels,...pixels},reports=[];
  delete study.applied;
  for(const frame of study.frames){const image=frameImage(study,frame),fingerprint=sha256(bytes(image));if(frame.sourceFingerprint&&frame.sourceFingerprint!==fingerprint)throw new Error(`动作图来源已改变：${frame.id}`);frame.sourceFingerprint=fingerprint;
    const mapping=mappings?.find((value)=>value.frameId===frame.id)||frame.mapping;frame.mapping=validateMotionStudyMapping(mapping,doc,frame);
    const result=await prepareFrame(doc,study,frame,env);frame.segments=result.segments;frame.compositionMetrics=result.metrics;reports.push({...result.metrics,composition:result.composition});
  }
  requireComplete(doc,motionId,study,false);
  return {document:validateRigDocument(doc),report:{kind:"motion-study",motionId,visibleOnly:true,hiddenSurfaces:"not-inpainted",frames:reports}};
}
export async function applyMotionStudy(document, motionId, options = {}) {
  const checked=validateRigDocument(document),study=currentStudy(checked,motionId);requireComplete(checked,motionId,study,true);
  const result=await prepareMotionStudyFrames(checked,motionId,undefined,options),prepared=result.document.motionStudies[motionId];
  prepared.applied={kind:"stepped-parts",at:new Date().toISOString(),contentFingerprint:contentFingerprint(prepared)};
  return result;
}
export const motionStudyRegionName = (motionId,frameId,partId) => `ms_${motionId.slice(0,20)}_${frameId.slice(0,16)}_${partId.slice(0,24)}_${sha256(JSON.stringify([motionId,frameId,partId])).slice(0,16)}`;
export const motionStudySlotName = (motionId,partId) => `ms_slot_${sha256(JSON.stringify([motionId,partId])).slice(0,40)}`;
export function motionStudyAssets(document) {
  return Object.entries(document.motionStudies||{}).flatMap(([motionId,study])=>isMotionStudyPlaybackActive(study)?assertAppliedMotionStudy(document,motionId).frames.flatMap((frame)=>frame.segments.map((segment)=>({...segment,id:motionStudyRegionName(motionId,frame.id,segment.partId),motionId,frameId:frame.id}))):[]);
}
export function motionStudyKeyTime(time) {
  const value=Float32Array.of(time),bits=new Uint32Array(value.buffer);if(value[0]<time)bits[0]++;return value[0];
}
export function motionStudyFramePose(document, frame) {
  const byId=new Map(frame.mapping.joints.map((joint)=>[joint.id,joint])),children=new Map(document.joints.map((joint)=>[joint.id,document.joints.filter((child)=>child.parent===joint.id)])),joints={};
  const visit=(joint,parentAngle=0)=>{const position=byId.get(joint.id),child=children.get(joint.id)[0],target=child&&byId.get(child.id);let angle=joint.parent&&target&&Math.hypot(target.x-position.x,target.y-position.y)>.001?Math.atan2(target.y-position.y,target.x-position.x)*180/Math.PI:parentAngle;joints[joint.id]={...position,angle};for(const child of children.get(joint.id))visit(child,angle);};
  visit(document.joints.find((joint)=>joint.parent===null));return joints;
}
export function sampleMotionStudyPose(document,motionId,time) {
  const study=assertAppliedMotionStudy(document,motionId,{cache:true}),motion=document.motions.find((item)=>item.id===motionId),duration=motionStudyKeyTime(motion.duration);let t=time;
  if(motion.loop&&(t<0||t>duration))t=((t%duration)+duration)%duration;else t=Math.max(0,Math.min(duration,t));
  const frame=[...study.frames].reverse().find((value)=>motionStudyKeyTime(value.time)<=t)||study.frames[0],joints=motionStudyFramePose(document,frame);
  return {kind:"motion-study",stepped:true,time:t,frameId:frame.id,joints,parts:Object.fromEntries(frame.segments.map((p)=>[p.partId,{vertices:[p.x,p.y,p.x,p.y+p.height,p.x+p.width,p.y+p.height,p.x+p.width,p.y],triangles:[0,1,2,2,3,0]}])),visiblePartIds:frame.segments.map((part)=>part.partId),attachmentSelection:{},angles:{},root:{x:0,y:0},feet:{left:false,right:false},footTargets:{},weaponGrips:[],visibleOnly:true};
}
export function inspectMotionStudy(document,motionId,{samples=61}={}) {
  const study=assertAppliedMotionStudy(document,motionId),motion=document.motions.find((item)=>item.id===motionId),first=sampleMotionStudyPose(document,motionId,0),last=sampleMotionStudyPose(document,motionId,motionStudyKeyTime(motion.duration));
  const positionError=Math.max(...document.joints.map((j)=>Math.hypot(first.joints[j.id].x-last.joints[j.id].x,first.joints[j.id].y-last.joints[j.id].y))),angleError=Math.max(...document.joints.map((j)=>Math.abs(((first.joints[j.id].angle-last.joints[j.id].angle+180)%360+360)%360-180))),imagesContinuous=study.frames[0].sourceFingerprint===study.frames.at(-1).sourceFingerprint;
  const issues=[];if(motion.loop&&(positionError>.5||angleError>.5||!imagesContinuous))issues.push("循环逐帧动作首尾画面或关节不连续。");
  return {kind:"motion-study",motionId,stepped:true,duration:motion.duration,runtimeDuration:motionStudyKeyTime(motion.duration),samples,finite:true,issues,frames:study.frames.map((frame)=>frame.compositionMetrics),visibleOnly:true,hiddenSurfaces:"not-inpainted",maxVertexDistance:null,maxFootSlide:{left:null,right:null},footContactSamples:{left:0,right:0},weaponGrips:[],loop:{enabled:motion.loop,positionError,angleError,imagesContinuous,attachmentsContinuous:imagesContinuous,attachmentChanges:[]},solver:{sampler:"motion-study-landmarks",feet:"not-evaluated",twoHandGrip:false}};
}

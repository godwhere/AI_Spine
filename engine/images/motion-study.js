import { bytes } from "../../shared/domain/motion-study.mjs";
import { canonical } from "../../shared/domain/motion-study.mjs";
import { contentFingerprint } from "../../shared/domain/motion-study.mjs";
import { currentStudy } from "../../shared/domain/motion-study.mjs";
import { encodeBase64 } from "../../shared/codec/base64.mjs";
import { frameImage } from "../../shared/domain/motion-study.mjs";
import { gapPolicy } from "../../shared/domain/motion-study.mjs";
import { inferMotionGapOwners } from "./motion-ownership.js";
import { motionStudyMappingFingerprint } from "../../shared/domain/motion-study.mjs";
import { ownerFingerprint } from "../../shared/domain/motion-study.mjs";
import { rasterMotionOwners } from "./motion-ownership.js";
import { requireComplete } from "../../shared/domain/motion-study.mjs";
import { requireGapAllowed } from "../../shared/domain/motion-study.mjs";
import { rigCompositionFingerprint } from "../../shared/domain/generation.mjs";
import { sha256 } from "../../shared/codec/sha256.mjs";
import { validateMotionStudyMapping } from "../../shared/rig-schema.mjs";
import { validateRigDocument } from "../../shared/rig-schema.mjs";

const dataURL = (value) => `data:image/png;base64,${encodeBase64(value)}`;

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

function verifiedGapOwners(document,frame,source) {
  const policy=frame.mapping.gapFill;
  if(policy.sourceFingerprint!==frame.sourceFingerprint||policy.mappingFingerprint!==motionStudyMappingFingerprint(frame.mapping))throw new Error("缺口候选的源画面或部件映射已改变，请重新诊断并明确接受候选。");
  const result=inferMotionGapOwners(document,frame.mapping,source,policy.maxDistance);requireGapAllowed(result);
  if(result.addedPixels!==policy.inferredPixels||Math.abs(result.significantGapRatio-policy.observedGapRatio)>1e-12||Math.abs(result.maxDistance-policy.observedMaxDistance)>1e-9||ownerFingerprint(result.owners)!==policy.ownerFingerprint)
    throw new Error("缺口归属策略与实际源像素不一致，请重新诊断。");
  return result;
}

async function frameOwnershipContext(document,motionId,frameId,pixels,requireMapping=true) {
  const doc=validateRigDocument(document),study=currentStudy(doc,motionId),frame=study.frames.find((value)=>value.id===frameId),env=pixels;
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

async function diagnoseMotionStudyFrame(document,motionId,frameId,{maxDistance=64,pixels}={}) {
  const context=await frameOwnershipContext(document,motionId,frameId,pixels),result=inferMotionGapOwners(context.doc,context.frame.mapping,context.source,maxDistance);
  return ownershipReport(context,result);
}

async function gapOwnershipCandidate(document,motionId,frameId,{maxDistance=64,pixels}={},renderReportImages=true) {
  const context=await frameOwnershipContext(document,motionId,frameId,pixels),{frame}=context,result=inferMotionGapOwners(context.doc,frame.mapping,context.source,maxDistance);
  requireGapAllowed(result);if(!result.addedPixels)throw new Error("当前没有需要推定的主体缺口，请直接检查原部件映射。");
  const mapping={...frame.mapping,gapFill:gapPolicy(frame,result,maxDistance)};
  return {kind:"gap-fill",frameId,sourceFingerprint:frame.sourceFingerprint,mappingFingerprint:motionStudyMappingFingerprint(frame.mapping),mapping,report:await ownershipReport(context,result,renderReportImages)};
}

async function proposeMotionStudyGapOwnership(document,motionId,frameId,options) {
  return gapOwnershipCandidate(document,motionId,frameId,options);
}

async function calibratedBaseCandidate(document,motionId,frameId,{pixels}={},renderReportImages=true) {
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

async function proposeCalibratedBaseMotionMapping(document,motionId,frameId,options) {
  return calibratedBaseCandidate(document,motionId,frameId,options);
}

async function acceptMotionStudyOwnershipCandidate(document,motionId,frameId,candidate,{pixels}={}) {
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

async function prepareMotionStudyFrames(document, motionId, mappings, { pixels } = {}) {
  const doc=validateRigDocument(document),study=currentStudy(doc,motionId),env=pixels,reports=[];
  delete study.applied;
  for(const frame of study.frames){const image=frameImage(study,frame),fingerprint=sha256(bytes(image));if(frame.sourceFingerprint&&frame.sourceFingerprint!==fingerprint)throw new Error(`动作图来源已改变：${frame.id}`);frame.sourceFingerprint=fingerprint;
    const mapping=mappings?.find((value)=>value.frameId===frame.id)||frame.mapping;frame.mapping=validateMotionStudyMapping(mapping,doc,frame);
    const result=await prepareFrame(doc,study,frame,env);frame.segments=result.segments;frame.compositionMetrics=result.metrics;reports.push({...result.metrics,composition:result.composition});
  }
  requireComplete(doc,motionId,study,false);
  return {document:validateRigDocument(doc),report:{kind:"motion-study",motionId,visibleOnly:true,hiddenSurfaces:"not-inpainted",frames:reports}};
}

async function applyMotionStudy(document, motionId, options = {}) {
  const checked=validateRigDocument(document),study=currentStudy(checked,motionId);requireComplete(checked,motionId,study,true);
  const result=await prepareMotionStudyFrames(checked,motionId,undefined,options),prepared=result.document.motionStudies[motionId];
  prepared.applied={kind:"stepped-parts",at:options.now(),contentFingerprint:contentFingerprint(prepared)};
  return result;
}

export { acceptMotionStudyOwnershipCandidate, applyMotionStudy, diagnoseMotionStudyFrame, prepareMotionStudyFrames, proposeCalibratedBaseMotionMapping, proposeMotionStudyGapOwnership };

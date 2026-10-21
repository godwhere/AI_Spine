import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { validateRigDocument } from "../shared/rig-schema.mjs";
import { getMotionStudyFingerprints, motionStudyMappingFingerprint } from "../shared/domain/motion-study.mjs";
import { diagnoseMotionStudyFrame, proposeMotionStudyGapOwnership, proposeCalibratedBaseMotionMapping, acceptMotionStudyOwnershipCandidate, prepareMotionStudyFrames, applyMotionStudy } from "../src/infrastructure/motion-study-images.js";
import { inferMotionGapOwners, rasterMotionOwners } from "../engine/images/motion-ownership.js";
import { registerRigSourcePixels } from "../src/infrastructure/rig-registration.js";
import { rigCompositionFingerprint } from "../shared/domain/generation.mjs";
import { buildRigFiles } from "../src/infrastructure/rig-authoring.js";
import { compileRigSkeleton } from "../engine/rig/compile.js";
import { attachRigAuthoring, readRigAuthoring } from "../engine/archive/rig-project.js";
import { imageDataBytes } from "../shared/codec/image-data.mjs";
import { parseBundle } from "../src/infrastructure/archive-files.js";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";
import { pixelEnv } from "./helpers.mjs";

const rect=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
function image(w,h,color){const canvas=createCanvas(w,h),ctx=canvas.getContext("2d");ctx.fillStyle=color;ctx.fillRect(0,0,w,h);return canvas.toDataURL("image/png");}
async function fixture(){
  const canvas=createCanvas(80,100),ctx=canvas.getContext("2d");ctx.fillStyle="#45a080";ctx.fillRect(18,10,44,80);ctx.fillStyle="#ffffff";ctx.fillRect(38,30,4,10);
  const sourceImage=canvas.toDataURL("image/png"),part=(id,bone,x,width,z,color)=>({id,label:id,bone,x,y:10,width,height:80,z,binding:"rigid",influences:[bone],image:image(width,80,color),imageSource:"uploaded",completion:"ready"});
  let doc=validateRigDocument({version:1,id:"ownership-test",name:"Ownership test",width:80,height:100,sourceImage,
    joints:[{id:"root",parent:null,x:40,y:80},{id:"left",parent:"root",x:28,y:50},{id:"right",parent:"root",x:52,y:50}],
    parts:[part("left","left",18,20,0,"#45a080"),part("right","right",42,20,1,"#45a080"),
      {...part("eyeOpen","left",38,4,2,"#ffffff"),y:30,height:10,image:image(4,10,"#ffffff"),attachmentGroup:"eyes"},
      {...part("eyeClosed","left",38,4,2,"#222222"),y:30,height:10,image:image(4,10,"#222222"),attachmentGroup:"eyes"}],defaultAttachments:{eyes:"eyeOpen"},
    motions:[{id:"idle",name:"idle",duration:1,loop:true,poses:[{time:0},{time:1}]},{id:"attack",name:"attack",duration:1,poses:[{time:0},{time:1}]}]});
  const fingerprints=await getMotionStudyFingerprints(doc),mapping={frameId:"base",sourceFingerprint:fingerprints.baseFingerprint,joints:doc.joints.map(({id,x,y})=>({id,x,y})),parts:[
    {partId:"left",visible:true,z:0,sourcePolygon:rect(18,10,20,80)},{partId:"right",visible:true,z:1,sourcePolygon:rect(42,10,20,80)},{partId:"eyeOpen",visible:true,z:2,sourcePolygon:rect(38,30,4,10)}]};
  doc.motionStudies={attack:{motionId:"attack",...fingerprints,frames:[{id:"base",time:0,image:sourceImage,sourceFingerprint:fingerprints.baseFingerprint,origin:"base",review:{approved:true},mappingReview:{approved:true},mapping},
    {id:"end",time:1,imageRef:"base",sourceFingerprint:fingerprints.baseFingerprint,origin:"base",review:{approved:true},mappingReview:{approved:true},mapping:{...structuredClone(mapping),frameId:"end"}}]}};
  return doc;
}
async function source(doc){const bitmap=await loadImage(doc.sourceImage),canvas=createCanvas(doc.width,doc.height),ctx=canvas.getContext("2d");ctx.drawImage(bitmap,0,0);return{width:doc.width,height:doc.height,data:ctx.getImageData(0,0,doc.width,doc.height).data};}
const approved=(doc)=>({...doc,motionStudies:{...doc.motionStudies,attack:{...doc.motionStudies.attack,frames:doc.motionStudies.attack.frames.map((frame)=>({...frame,mappingReview:{approved:true}}))}}});

test("diagnostics expose significant gaps and overlays without changing the document or any already-owned pixel",async()=>{
  const doc=await fixture(),before=structuredClone(doc),report=await diagnoseMotionStudyFrame(doc,"attack","base",{maxDistance:12,pixels:pixelEnv});
  assert.equal(report.missingSignificantPixels,280);assert.equal(report.significantGapRatio,280/3520);assert.equal(report.maxDistance,2);assert.equal(report.unresolvedSignificantPixels,0);
  assert.deepEqual(report.missingBounds,{x:38,y:10,width:4,height:80});assert.ok(report.missingHeatmap.startsWith("data:image/png;base64,"));
  assert.ok(report.parts.every((part)=>part.ownerOverlay.startsWith("data:image/png;base64,")));assert.ok(report.parts.filter((part)=>part.addedPixels).every((part)=>part.physical&&part.addedOverlay));
  assert.equal(report.parts.find((part)=>part.partId==="eyeOpen").addedPixels,0,"a nearer facial boundary cannot absorb physical gaps");
  const src=await source(doc),raster=rasterMotionOwners(doc.motionStudies.attack.frames[0].mapping,src),inferred=inferMotionGapOwners(doc,doc.motionStudies.attack.frames[0].mapping,src,12);
  for(let i=0;i<raster.owners.length;i++)if(raster.owners[i]>=0)assert.equal(inferred.owners[i],raster.owners[i]);
  assert.deepEqual(doc,before);
});

test("an explicit candidate is source-bound, deterministic, source-exact and never silently approves or applies",async()=>{
  const doc=await fixture();await assert.rejects(prepareMotionStudyFrames(doc,"attack",undefined,{pixels:pixelEnv}),/主体像素/);
  const candidate=await proposeMotionStudyGapOwnership(doc,"attack","base",{maxDistance:12,pixels:pixelEnv}),policy=candidate.mapping.gapFill;
  assert.equal(policy.inferredPixels,280);assert.equal(policy.observedMaxDistance,2);assert.equal(policy.maxGapRatio,.15);assert.ok(JSON.stringify(policy).length<700);
  const src=await source(doc),inferred=inferMotionGapOwners(doc,candidate.mapping,src,12),raw=new Uint8Array(inferred.owners.length*2),view=new DataView(raw.buffer);
  for(let i=0;i<inferred.owners.length;i++)view.setInt16(i*2,inferred.owners[i],true);
  assert.equal(policy.ownerFingerprint,createHash("sha256").update(raw).digest("hex"));
  const result=await acceptMotionStudyOwnershipCandidate(doc,"attack","base",candidate,{pixels:pixelEnv}),frames=result.document.motionStudies.attack.frames;
  assert.equal(result.document.motionStudies.attack.applied,undefined);assert.ok(frames.every((frame)=>!frame.mappingReview.approved&&!frame.segments));
  assert.equal(frames[1].mapping.gapFill.ownerFingerprint,policy.ownerFingerprint);assert.notEqual(frames[1].mapping.gapFill.mappingFingerprint,policy.mappingFingerprint);
  assert.equal(frames[1].mapping.gapFill.mappingFingerprint,motionStudyMappingFingerprint(frames[1].mapping));
  const prepared=await prepareMotionStudyFrames(result.document,"attack",undefined,{pixels:pixelEnv});
  assert.ok(prepared.report.frames.every((frame)=>frame.alphaIoU===1&&frame.maxChannelError===0&&frame.inferredOwnership.addedPixels===280));
  await assert.rejects(applyMotionStudy(prepared.document,"attack",{pixels:pixelEnv}),/审阅/);
  const applied=(await applyMotionStudy(approved(prepared.document),"attack",{pixels:pixelEnv})).document;
  assert.deepEqual(applied.parts,doc.parts);assert.deepEqual(applied.joints,doc.joints);assert.ok(applied.motionStudies.attack.frames[0].segments.every((part)=>part.origin==="source-visible"&&part.visibleOnly));
});

test("ratio, distance, stale mappings, forged policies and absent physical seeds remain strict rejection gates",async()=>{
  const doc=await fixture();await assert.rejects(proposeMotionStudyGapOwnership(doc,"attack","base",{maxDistance:1,pixels:pixelEnv}),/无法在/);
  await assert.rejects(proposeMotionStudyGapOwnership(doc,"attack","base",{maxDistance:65,pixels:pixelEnv}),/64/);
  const large=structuredClone(doc);large.motionStudies.attack.frames[0].mapping.parts[0].sourcePolygon=rect(18,10,14,80);
  await assert.rejects(proposeMotionStudyGapOwnership(large,"attack","base",{maxDistance:64,pixels:pixelEnv}),/超过 15%/);
  const candidate=await proposeMotionStudyGapOwnership(doc,"attack","base",{maxDistance:12,pixels:pixelEnv}),tampered=structuredClone(candidate);tampered.mapping.gapFill.inferredPixels++;
  await assert.rejects(acceptMotionStudyOwnershipCandidate(doc,"attack","base",tampered,{pixels:pixelEnv}),/重算不一致/);
  const accepted=(await acceptMotionStudyOwnershipCandidate(doc,"attack","base",candidate,{pixels:pixelEnv})).document;
  accepted.motionStudies.attack.frames[0].mapping.parts[0].z=-1;await assert.rejects(prepareMotionStudyFrames(accepted,"attack",undefined,{pixels:pixelEnv}),/映射已改变/);
  const invalid=structuredClone(doc);invalid.motionStudies.attack.frames[0].mapping.gapFill={...candidate.mapping.gapFill,pixelIndices:[1,2,3]};assert.throws(()=>validateRigDocument(invalid),/像素列表/);
  const noPhysical=structuredClone(doc);noPhysical.parts[0].attachmentGroup="leftGroup";noPhysical.parts[1].attachmentGroup="rightGroup";Object.assign(noPhysical.motionStudies.attack,await getMotionStudyFingerprints(noPhysical));
  await assert.rejects(proposeMotionStudyGapOwnership(noPhysical,"attack","base",{maxDistance:64,pixels:pixelEnv}),/无法在/);
});

test("exact nearest-boundary distances and row-major ties agree with independent brute-force distances",async()=>{
  const doc=await fixture(),src=await source(doc),mapping=doc.motionStudies.attack.frames[0].mapping,result=inferMotionGapOwners(doc,mapping,src,64),raster=rasterMotionOwners(mapping,src),w=src.width,h=src.height,seeds=[];
  for(let i=0;i<raster.owners.length;i++){const o=raster.owners[i],x=i%w,y=Math.floor(i/w);if(o<0||doc.parts.find((p)=>p.id===raster.parts[o].partId).attachmentGroup||src.data[i*4+3]<=8)continue;
    if(x===0||y===0||x===w-1||y===h-1||[i-1,i+1,i-w,i+w].some((j)=>raster.owners[j]!==o))seeds.push(i);}
  for(let i=0;i<raster.owners.length;i++)if(src.data[i*4+3]>8&&raster.owners[i]<0){let nearest=-1,distance=Infinity;for(const s of seeds){const d=(s%w-i%w)**2+(Math.floor(s/w)-Math.floor(i/w))**2;if(d<distance){distance=d;nearest=s;}}
    assert.equal(result.nearestBoundary[i],nearest);assert.equal(result.distancesSquared[i],distance);assert.equal(result.owners[i],raster.owners[nearest]);}
});

test("calibrated base reuse copies the whole accepted mapping and requires current source/composition proof",async()=>{
  let doc=await fixture();const polygons={left:rect(18,10,22,80),right:rect(40,10,22,80),eyeOpen:rect(38,30,4,10)};
  doc=(await registerRigSourcePixels(doc,{polygons},pixelEnv)).document;
  doc.registration.compositionFingerprint=await rigCompositionFingerprint(doc);Object.assign(doc.motionStudies.attack,await getMotionStudyFingerprints(doc));
  doc.motionStudies.attack.frames[0].mapping.parts[0].z=99;
  const candidate=await proposeCalibratedBaseMotionMapping(doc,"attack","base",{pixels:pixelEnv});
  assert.equal(candidate.kind,"base-registration");assert.equal(candidate.mapping.parts.find((part)=>part.partId==="left").z,doc.parts[0].z);assert.deepEqual(candidate.mapping.joints,doc.joints.map(({id,x,y})=>({id,x,y})));
  assert.equal(candidate.report.missingSignificantPixels,0);assert.equal(candidate.mapping.gapFill,undefined);
  const accepted=await acceptMotionStudyOwnershipCandidate(doc,"attack","base",candidate,{pixels:pixelEnv}),prepared=await prepareMotionStudyFrames(accepted.document,"attack",undefined,{pixels:pixelEnv});assert.ok(prepared.report.frames.every((frame)=>frame.alphaIoU===1&&frame.maxChannelError<=2));
  const stale=structuredClone(doc);stale.registration.compositionFingerprint="0".repeat(64);await assert.rejects(proposeCalibratedBaseMotionMapping(stale,"attack","base",{pixels:pixelEnv}),/过期/);
});

test("inferred source-visible ownership and source pixels survive all three actual archive formats",async()=>{
  const doc=await fixture(),candidate=await proposeMotionStudyGapOwnership(doc,"attack","base",{maxDistance:12,pixels:pixelEnv}),accepted=await acceptMotionStudyOwnershipCandidate(doc,"attack","base",candidate,{pixels:pixelEnv}),prepared=await prepareMotionStudyFrames(accepted.document,"attack",undefined,{pixels:pixelEnv}),applied=(await applyMotionStudy(approved(prepared.document),"attack",{pixels:pixelEnv})).document;
  const files=attachRigAuthoring(await buildRigFiles(applied,pixelEnv),applied),bundle=parseBundle(files);
  for(const options of [{},{editable:true},{target:"unity"}]){const restored=readRigAuthoring(parseBundle(unpackZip(exportPackage(bundle,{},options))).files);assert.deepEqual(restored,applied);assert.doesNotThrow(()=>compileRigSkeleton(restored));}
  assert.equal(imageDataBytes(applied.sourceImage).bytes.length,imageDataBytes(doc.sourceImage).bytes.length);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Skeleton, AnimationState, AnimationStateData, Physics, RegionAttachment } from "@esotericsoftware/spine-webgl";
import { validateRigDocument } from "../shared/rig-schema.mjs";
import { getMotionStudyFingerprints, motionStudyRegionName, motionStudySlotName } from "../shared/domain/motion-study.mjs";
import { prepareMotionStudyFrames, applyMotionStudy, diagnoseMotionStudyFrame, proposeMotionStudyGapOwnership, proposeCalibratedBaseMotionMapping, acceptMotionStudyOwnershipCandidate } from "../src/infrastructure/motion-study-images.js";
import { motionStudyKeyTime } from "../engine/rig/motion-study.js";
import { buildRigFiles } from "../src/infrastructure/rig-authoring.js";
import { compileRigSkeleton } from "../engine/rig/compile.js";
import { sampleRigPose } from "../engine/rig/sample.js";
import { inspectRigMotion } from "../engine/rig/inspect.js";
import { attachRigAuthoring, readRigAuthoring } from "../engine/archive/rig-project.js";
import { imageDataBytes } from "../shared/codec/image-data.mjs";
import { rigWithCalibratedParts, synchronizeRigAuthoring } from "../src/infrastructure/rig-project.js";
import { RIG_DOCUMENT_PATH } from "../shared/domain/rig-summary.mjs";
import { parseBundle } from "../src/infrastructure/archive-files.js";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";
import { parseSkeleton } from "../engine/spine/parse.js";
import { attachmentVertices } from "../engine/spine/geometry.js";
import { compilePages } from "../src/infrastructure/calibration.js";
import { identityTransform } from "../engine/images/calibration.js";
import { rigGeometry } from "../shared/domain/rig.mjs";
import { rigCompositionFingerprint } from "../shared/domain/generation.mjs";
import { pixelEnv } from "./helpers.mjs";

const rect=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
function art(pose=0) {
  const canvas=createCanvas(64,64),c=canvas.getContext("2d"),body=pose?[20,12,20,26]:[12,20,20,26],arm=pose?[5,20,15,8]:[32,20,16,8],eye=pose?[28,16,4,3]:[20,24,4,3];
  c.fillStyle=pose?"#2a986d":"#3366b0";c.fillRect(...body);c.fillStyle="#e56a2c";c.fillRect(...arm);c.fillStyle="#ffffff";c.fillRect(...eye);
  return {image:canvas.toDataURL("image/png"),body,arm,eye};
}
function independent(color,w,h){const c=createCanvas(w,h);c.getContext("2d").fillStyle=color;c.getContext("2d").fillRect(0,0,w,h);return c.toDataURL("image/png");}
async function fixture({loop=false}={}) {
  const first=art(),next=art(1),joints=[{id:"root",parent:null,x:32,y:45},{id:"torso",parent:"root",x:32,y:24},{id:"head",parent:"torso",x:32,y:13},{id:"hand",parent:"torso",x:48,y:24}],
    part=(id,bone,r,z,color)=>({id,label:id,bone,x:r[0],y:r[1],width:r[2],height:r[3],z,binding:"rigid",influences:[bone],image:independent(color,r[2],r[3]),imageSource:"uploaded",completion:"ready"});
  let doc=validateRigDocument({version:1,id:"motion-study-test",name:"Motion study fixture",width:64,height:64,sourceImage:first.image,joints,
    parts:[{...part("body","torso",first.body,0,"#3366b0"),binding:"mesh",influences:["root","torso"],mesh:{cols:3,rows:3,weights:Array.from({length:9},()=>[{joint:"root",weight:.2},{joint:"torso",weight:.8}])}},part("arm","hand",first.arm,1,"#e56a2c"),
      {...part("eyeOpen","head",first.eye,2,"#ffffff"),attachmentGroup:"eyes"},{...part("eyeClosed","head",first.eye,2,"#222222"),attachmentGroup:"eyes"}],defaultAttachments:{eyes:"eyeOpen"},
    motions:[{id:"idle",name:"idle",duration:1,loop:true,poses:[{time:0},{time:1}]},{id:"attack",name:"attack",duration:1,loop,poses:[{time:0},{time:1,angles:{torso:20}}]},{id:"hit",name:"hit",duration:1,poses:[{time:0},{time:1}]}]});
  const hash=await getMotionStudyFingerprints(doc),frames=[{id:"base",time:0,image:first.image,origin:"base",review:{approved:true},mappingReview:{approved:true}},{id:"strike",time:.37,image:next.image,origin:"ai-motion-frame",review:{approved:true},mappingReview:{approved:true}},
    loop?{id:"end",time:1,imageRef:"base",origin:"base",review:{approved:true},mappingReview:{approved:true}}:{id:"end",time:1,imageRef:"strike",origin:"ai-motion-frame",review:{approved:true},mappingReview:{approved:true}}];
  const imageHash=(url)=>createHash("sha256").update(imageDataBytes(url).bytes).digest("hex");
  frames[0].sourceFingerprint=imageHash(first.image);frames[1].sourceFingerprint=imageHash(next.image);frames[2].sourceFingerprint=loop?frames[0].sourceFingerprint:frames[1].sourceFingerprint;
  const mapping=(frame,pose)=>({frameId:frame.id,sourceFingerprint:frame.sourceFingerprint,joints:pose?[{id:"root",x:30,y:40},{id:"torso",x:30,y:20},{id:"head",x:30,y:12},{id:"hand",x:10,y:24}]:joints.map(({id,x,y})=>({id,x,y})),parts:[{partId:"body",visible:true,sourcePolygon:rect(...(pose?next.body:first.body)),z:pose?5:0},{partId:"arm",visible:true,sourcePolygon:rect(...(pose?next.arm:first.arm)),z:pose?0:1},{partId:"eyeOpen",visible:true,sourcePolygon:rect(...(pose?next.eye:first.eye)),z:10}],notes:"Fixture mapping"});
  frames.forEach((frame,i)=>frame.mapping=mapping(frame,i===1||i===2&&!loop));
  doc.motionStudies={attack:{version:1,motionId:"attack",...hash,frames,prompt:"Reference driven action"}};
  return doc;
}
async function appliedFixture(options){return (await applyMotionStudy((await prepareMotionStudyFrames(await fixture(options),"attack",undefined,{pixels:pixelEnv})).document,"attack",{pixels:pixelEnv})).document;}
const visible=(s)=>s.drawOrder.appliedPose.filter((slot)=>slot.appliedPose.attachment);
function runtime(bundle){const {data,atlas}=parseSkeleton(bundle),skeleton=new Skeleton(data),state=new AnimationState(new AnimationStateData(data));return {data,atlas,skeleton,state};}
function at(value,name,time,{reset=true}={}){if(reset)value.skeleton.setupPose();const track=value.state.setAnimation(0,name,false);track.trackTime=time;value.state.apply(value.skeleton);value.skeleton.updateWorldTransform(Physics.none);return value.skeleton;}
const rgba=(canvas)=>canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data;
async function drawRegions(value,bundle,height){
  const canvas=createCanvas(64,height),context=canvas.getContext("2d"),pages=new Map(await Promise.all(bundle.pages.map(async(page)=>[page.file,await loadImage(Buffer.from(bundle.files[page.file]))])));context.imageSmoothingEnabled=false;
  for(const slot of visible(value.skeleton)){const a=slot.appliedPose.attachment;assert.ok(a instanceof RegionAttachment,"study must use independent rigid regions");const r=value.atlas.findRegion(a.path),v=attachmentVertices(value.skeleton,slot).vertices;
    // Use the actual runtime quad and UV orientation, not authoring FK or the
    // segment rectangle. Atlas packing is unrotated for this compiler.
    context.save();context.setTransform((v[4]-v[2])/r.width,-(v[5]-v[3])/r.width,(v[0]-v[2])/r.height,-(v[1]-v[3])/r.height,v[2],height-v[3]);context.drawImage(pages.get(r.page.name),r.x,r.y,r.width,r.height,0,0,r.width,r.height);context.restore();}
  return canvas;
}

test("fingerprints use exact source bytes and agreed ordered geometry while protecting base artwork and idle",async()=>{
  const doc=await fixture(),hash=await getMotionStudyFingerprints(doc);
  assert.equal(hash.baseFingerprint,createHash("sha256").update(imageDataBytes(doc.sourceImage).bytes).digest("hex"));
  assert.equal(hash.geometryFingerprint,createHash("sha256").update(JSON.stringify(rigGeometry(doc))).digest("hex"));
  assert.equal(hash.protectedIdleFingerprint,createHash("sha256").update(JSON.stringify(doc.motions[0])).digest("hex"));
  const changed=structuredClone(doc);changed.motionStudies.attack.prompt="Harmless prompt";assert.deepEqual(await getMotionStudyFingerprints(changed),hash);
  changed.parts[0].image=independent("#00ff00",20,26);assert.notEqual((await getMotionStudyFingerprints(changed)).originalArtworkFingerprint,hash.originalArtworkFingerprint);
});

test("early unapplied false drafts normalize without granting an applied state",async()=>{
  const doc=await fixture();doc.motionStudies.attack.applied=false;
  assert.equal(validateRigDocument(doc).motionStudies.attack.applied,undefined);
  assert.equal(doc.motionStudies.attack.applied,false,"validation keeps the original draft intact");
  for(const invalid of [true,"applied",1]){doc.motionStudies.attack.applied=invalid;assert.throws(()=>validateRigDocument(doc),/应用记录/);}
});

const reportImageKeys=new Set(["ownerOverlay","addedOverlay","missingHeatmap","candidateOwnerOverlay","heatmap","ownership"]);
const reportSummary=(value)=>Array.isArray(value)?value.map(reportSummary):value&&typeof value==="object"?
  Object.fromEntries(Object.entries(value).filter(([key])=>!reportImageKeys.has(key)).map(([key,item])=>[key,reportSummary(item)])):value;
function countedOwnershipPixels({rejectEncode=false}={}) {
  const counts={encodes:0,decodes:0};
  return {counts,pixels:{...pixelEnv,async loadImage(bytes){counts.decodes++;return pixelEnv.loadImage(bytes);},
    async encode(canvas){counts.encodes++;if(rejectEncode)throw new Error("Acceptance must not encode presentation images");return pixelEnv.encode(canvas);}}};
}
async function gapFixture() {
  const doc=await fixture();doc.motionStudies.attack.frames[1].mapping.parts[0].sourcePolygon=rect(20,12,19,26);return doc;
}
async function calibratedFixture() {
  const doc=await fixture(),frame=doc.motionStudies.attack.frames[0];
  for(const part of doc.parts){const mapped=frame.mapping.parts.find((value)=>value.partId===part.id);if(mapped)part.sourcePolygon=structuredClone(mapped.sourcePolygon);}
  doc.registration={sourceFingerprint:frame.sourceFingerprint,compositionFingerprint:await rigCompositionFingerprint(doc)};return doc;
}

test("diagnosis and gap candidates keep every review image while acceptance independently recomputes with zero PNG encodes",async()=>{
  const doc=await gapFixture(),before=structuredClone(doc),diagnosticPixels=countedOwnershipPixels(),candidatePixels=countedOwnershipPixels();
  const diagnosis=await diagnoseMotionStudyFrame(doc,"attack","strike",{pixels:diagnosticPixels.pixels}),
    candidate=await proposeMotionStudyGapOwnership(doc,"attack","strike",{pixels:candidatePixels.pixels});
  const expectedEncodes=3+candidate.report.parts.length+candidate.report.affectedParts.length;
  assert.equal(diagnosticPixels.counts.encodes,expectedEncodes);assert.equal(candidatePixels.counts.encodes,expectedEncodes);
  for(const report of [diagnosis,candidate.report]) {
    for(const key of ["missingHeatmap","ownerOverlay","candidateOwnerOverlay"])assert.match(report[key],/^data:image\/png;base64,/);
    assert.ok(report.parts.every((part)=>part.ownerOverlay&&(!part.addedPixels||part.addedOverlay)));
  }
  const acceptPixels=countedOwnershipPixels({rejectEncode:true}),misleading=structuredClone(candidate);
  misleading.report={canPropose:true,addedPixels:-100,parts:[],sourceFingerprint:"0".repeat(64)};
  const accepted=await acceptMotionStudyOwnershipCandidate(doc,"attack","strike",misleading,{pixels:acceptPixels.pixels});
  assert.equal(acceptPixels.counts.encodes,0);assert.equal(acceptPixels.counts.decodes,1,"actual source is decoded again instead of trusting a candidate cache");
  assert.deepEqual(reportSummary(accepted.report),reportSummary(candidate.report));assert.equal(accepted.report.ownerOverlay,undefined);
  assert.equal(accepted.document.motionStudies.attack.frames[1].mapping.gapFill.ownerFingerprint,candidate.mapping.gapFill.ownerFingerprint);
  for(const frame of accepted.document.motionStudies.attack.frames.slice(1))assert.equal(frame.mappingReview.approved,false);
  assert.deepEqual(doc,before);
});

test("zero-encode gap acceptance still rejects changed source, mapping, inferred owner proof and threshold policies",async()=>{
  const doc=await gapFixture(),candidate=await proposeMotionStudyGapOwnership(doc,"attack","strike",{pixels:pixelEnv}),counter=countedOwnershipPixels({rejectEncode:true});
  const badSource=structuredClone(doc);badSource.motionStudies.attack.frames[1].image=independent("#dd0011",64,64);
  await assert.rejects(acceptMotionStudyOwnershipCandidate(badSource,"attack","strike",candidate,{pixels:counter.pixels}),/来源已改变/);
  const movedMapping=structuredClone(doc);movedMapping.motionStudies.attack.frames[1].mapping.parts[0].sourcePolygon[0].x+=.5;
  await assert.rejects(acceptMotionStudyOwnershipCandidate(movedMapping,"attack","strike",candidate,{pixels:counter.pixels}),/来源或映射已改变/);
  const changes=[(value)=>value.sourceFingerprint="0".repeat(64),(value)=>value.mappingFingerprint="0".repeat(64),
    (value)=>value.mapping.parts[0].z++,(value)=>value.mapping.gapFill.ownerFingerprint="0".repeat(64),
    (value)=>value.mapping.gapFill.inferredPixels++,(value)=>value.mapping.gapFill.observedMaxDistance++,
    (value)=>value.mapping.gapFill.maxGapRatio=.2,(value)=>value.mapping.gapFill.significantAlphaMin=8,
    (value)=>value.mapping.gapFill.maxDistance=65];
  for(const change of changes){const invalid=structuredClone(candidate);change(invalid);await assert.rejects(acceptMotionStudyOwnershipCandidate(doc,"attack","strike",invalid,{pixels:counter.pixels}));}
  assert.equal(counter.counts.encodes,0);
});

test("calibrated-base candidates retain review images and zero-encode acceptance rechecks the complete registration proof",async()=>{
  const doc=await calibratedFixture(),before=structuredClone(doc),preview=countedOwnershipPixels(),
    candidate=await proposeCalibratedBaseMotionMapping(doc,"attack","base",{pixels:preview.pixels});
  assert.equal(preview.counts.encodes,3+candidate.report.parts.length+candidate.report.affectedParts.length);
  assert.ok(candidate.report.parts.every((part)=>part.ownerOverlay));assert.match(candidate.report.ownership,/^data:image\/png;base64,/);
  const counter=countedOwnershipPixels({rejectEncode:true}),accepted=await acceptMotionStudyOwnershipCandidate(doc,"attack","base",candidate,{pixels:counter.pixels});
  assert.deepEqual(reportSummary(accepted.report),reportSummary(candidate.report));assert.equal(counter.counts.encodes,0);assert.equal(counter.counts.decodes,1);
  for(const key of ["sourceFingerprint","compositionFingerprint"]){const invalid=structuredClone(candidate);invalid.baseRegistrationProof[key]="0".repeat(64);
    await assert.rejects(acceptMotionStudyOwnershipCandidate(doc,"attack","base",invalid,{pixels:counter.pixels}),/确定性重算/);}
  const altered=structuredClone(candidate);altered.mapping.joints[0].x++;
  await assert.rejects(acceptMotionStudyOwnershipCandidate(doc,"attack","base",altered,{pixels:counter.pixels}),/确定性重算/);
  const stale=structuredClone(doc);stale.registration.compositionFingerprint="0".repeat(64);
  await assert.rejects(acceptMotionStudyOwnershipCandidate(stale,"attack","base",candidate,{pixels:counter.pixels}),/已过期/);
  assert.equal(counter.counts.encodes,0);assert.deepEqual(doc,before);
});

test("real source ownership creates separate alpha PNGs and application preserves all original editable authoring",async()=>{
  const original=await fixture(),before=structuredClone(original),prepared=await prepareMotionStudyFrames(original,"attack",undefined,{pixels:pixelEnv});
  assert.deepEqual(original,before);assert.equal(prepared.report.frames.length,3);
  for(const frame of prepared.document.motionStudies.attack.frames){assert.equal(frame.segments.length,3);assert.equal(frame.compositionMetrics.alphaIoU,1);assert.equal(frame.compositionMetrics.pixelMAE,0);assert.ok(frame.segments.every((p)=>p.visibleOnly&&p.origin==="source-visible"));}
  const {document:doc}=await applyMotionStudy(prepared.document,"attack",{pixels:pixelEnv});
  assert.deepEqual(doc.parts,before.parts);assert.deepEqual(doc.joints,before.joints);assert.deepEqual(doc.motions,before.motions);assert.equal(doc.sourceImage,before.sourceImage);
  assert.equal(sampleRigPose(doc,"attack",.3699).frameId,"base");assert.equal(sampleRigPose(doc,"attack",motionStudyKeyTime(.37)).frameId,"strike");assert.equal(sampleRigPose(doc,"attack",1).frameId,"end");
  const inspection=inspectRigMotion(doc,"attack");assert.equal(inspection.kind,"motion-study");assert.equal(inspection.maxFootSlide.left,null);assert.equal(inspection.solver.feet,"not-evaluated");assert.equal(inspection.hiddenSurfaces,"not-inpainted");
});

test("official Spine runtime matches source pixels at every stepped pose and restores idle after the final frame",async()=>{
  const doc=await appliedFixture(),files=await buildRigFiles(doc,pixelEnv),bundle=parseBundle(files),value=runtime(bundle),json=compileRigSkeleton(doc);
  assert.equal(bundle.parts.length,13);assert.equal(json.bones.length,doc.joints.length);
  for(const time of [0,.18,.3699,.37,motionStudyKeyTime(.37),.7,.9999,1,1.25]){
    at(value,"attack",time);const pose=sampleRigPose(doc,"attack",Math.min(time,1)),frame=doc.motionStudies.attack.frames.find((f)=>f.id===pose.frameId);
    assert.equal(visible(value.skeleton).length,3);assert.ok(visible(value.skeleton).every((slot)=>slot.data.name.startsWith("ms_slot_")));
    for(const [id,expected]of Object.entries(pose.joints)){const actual=value.skeleton.findBone(id).appliedPose;assert.ok(Math.hypot(actual.worldX-expected.x,doc.height-actual.worldY-expected.y)<.0001,`${time} ${id}`);}
    const canvas=await drawRegions(value,bundle,64),source=await loadImage(frame.image||doc.motionStudies.attack.frames.find((f)=>f.id===frame.imageRef).image),expected=createCanvas(64,64);expected.getContext("2d").drawImage(source,0,0);
    const a=rgba(canvas),b=rgba(expected);
    for(let i=0;i<a.length;i+=4){assert.ok(Math.abs(a[i+3]-b[i+3])<=1,`runtime alpha ${time} ${i/4}`);for(let c=0;c<3;c++)assert.ok(Math.abs(a[i+c]*a[i+3]/255-b[i+c]*b[i+3]/255)<=2,`runtime premultiplied color ${time} ${i/4}`);}
    const ordered=frame.segments.slice().sort((a,b)=>a.z-b.z).map((s)=>motionStudySlotName("attack",s.partId));assert.deepEqual(visible(value.skeleton).map((s)=>s.data.name),ordered);
  }
  // Reuse the same AnimationState without setup-pose reset to test real action
  // switching rather than hiding leaked attachments with a fresh skeleton.
  at(value,"idle",.45,{reset:false});assert.equal(visible(value.skeleton).length,3);assert.ok(visible(value.skeleton).every((s)=>!s.data.name.startsWith("ms_slot_")));
  const baseline=runtime(parseBundle(await buildRigFiles({...doc,motionStudies:undefined},pixelEnv)));at(baseline,"idle",.45);
  for(const bone of doc.joints){const a=value.skeleton.findBone(bone.id).appliedPose,b=baseline.skeleton.findBone(bone.id).appliedPose;assert.ok(Math.hypot(a.worldX-b.worldX,a.worldY-b.worldY)<.0001,bone.id);}
});

test("all archive formats keep exact motion sources, segments, provenance and weights without base64 in metadata",async()=>{
  const doc=await appliedFixture({loop:true}),files=attachRigAuthoring(await buildRigFiles(doc,pixelEnv),doc),bundle=parseBundle(files),before=readRigAuthoring(files);
  assert.ok(!new TextDecoder().decode(files[RIG_DOCUMENT_PATH]).includes("base64,"));assert.deepEqual(before,doc);
  for(const options of [{},{editable:true},{target:"unity"}]){const restored=parseBundle(unpackZip(exportPackage(bundle,{},options))),after=readRigAuthoring(restored.files);assert.deepEqual(after,before);assert.doesNotThrow(()=>compileRigSkeleton(after));const value=runtime(restored);at(value,"attack",1);assert.equal(visible(value.skeleton).length,3);}
  const current=await rigWithCalibratedParts(before,bundle,{},pixelEnv);assert.deepEqual(current,before,"unchanged atlas pixels must not invalidate byte-based review fingerprints");
  const synchronized=readRigAuthoring(await synchronizeRigAuthoring(bundle,{},pixelEnv));assert.deepEqual(synchronized,before);assert.doesNotThrow(()=>compileRigSkeleton(synchronized));
});

test("multi-page study atlases retain exact region pixels and runtime frames across every export format",async()=>{
  const doc=await appliedFixture(),before=structuredClone(doc),files=attachRigAuthoring(await buildRigFiles(doc,pixelEnv,{maxPageSize:32}),doc),bundle=parseBundle(files);
  const single=parseBundle(await buildRigFiles(doc,pixelEnv)),singleRuntime=runtime(single),referenceFrames=new Map();
  for(const frame of doc.motionStudies.attack.frames){at(singleRuntime,"attack",motionStudyKeyTime(frame.time));referenceFrames.set(frame.id,rgba(await drawRegions(singleRuntime,single,64)));}
  assert.ok(bundle.pages.length>=3);assert.ok(bundle.pages.every((page)=>page.width<=32&&page.height<=32&&!page.pma));
  assert.deepEqual(bundle.json,JSON.parse(JSON.stringify(compileRigSkeleton(doc))));
  for(const frame of doc.motionStudies.attack.frames)for(const segment of frame.segments){
    const id=motionStudyRegionName("attack",frame.id,segment.partId),region=bundle.parts.find((part)=>part.id===id);
    assert.equal(region.width,segment.width);assert.equal(region.height,segment.height);
    assert.deepEqual(files[`images/${id}.png`],imageDataBytes(segment.image).bytes);
  }
  for(const options of [{},{editable:true},{target:"unity"}]){
    const output=unpackZip(exportPackage(bundle,{},options)),restored=parseBundle(output),value=runtime(restored);
    assert.deepEqual(readRigAuthoring(restored.files),doc);assert.deepEqual(restored.json,bundle.json);
    for(const page of bundle.pages)assert.deepEqual(output[page.file],files[page.file]);
    for(const frame of doc.motionStudies.attack.frames){
      at(value,"attack",motionStudyKeyTime(frame.time));
      const canvas=await drawRegions(value,restored,64),source=await loadImage(frame.image||doc.motionStudies.attack.frames.find((item)=>item.id===frame.imageRef).image),expected=createCanvas(64,64);
      expected.getContext("2d").drawImage(source,0,0);const a=rgba(canvas),b=rgba(expected);
      assert.deepEqual(a,referenceFrames.get(frame.id),`paging cannot change rendered pixels: ${options.target||"runtime"} ${frame.id}`);
      // The existing official-runtime quad rasterization budget is unchanged;
      // atlas source crops and the comparison to the single-page render are exact.
      for(let index=0;index<a.length;index+=4){assert.ok(Math.abs(a[index+3]-b[index+3])<=1);for(let channel=0;channel<3;channel++)assert.ok(Math.abs(a[index+channel]*a[index+3]/255-b[index+channel]*b[index+3]/255)<=2);}
      for(const slot of visible(value.skeleton)){
        const attachment=slot.appliedPose.attachment,region=attachment.sequence.regions[attachment.sequence.resolveIndex(slot.appliedPose)],part=restored.parts.find((part)=>part.id===attachment.path),page=restored.pages.find((page)=>page.file===part.pageFile);
        assert.equal(region.page.name,page.file);assert.ok(frame.segments.some((segment)=>attachment.path===motionStudyRegionName("attack",frame.id,segment.partId)));
        for(const uv of attachment.sequence.uvs[0])assert.ok(uv>=0&&uv<=1);
      }
    }
    at(value,"idle",.5);assert.ok(visible(value.skeleton).every((slot)=>!slot.data.name.startsWith("ms_slot_")));
  }
  assert.deepEqual(doc,before);
});

test("missing review, stale artwork, wrong mapping and fake whole-body segmentation are rejected atomically",async()=>{
  const doc=await fixture(),prepared=(await prepareMotionStudyFrames(doc,"attack",undefined,{pixels:pixelEnv})).document,original=structuredClone(prepared);
  const unchecked=structuredClone(prepared);unchecked.motionStudies.attack.frames[1].mappingReview.approved=false;await assert.rejects(applyMotionStudy(unchecked,"attack",{pixels:pixelEnv}),/审阅/);
  const stale=structuredClone(prepared);stale.parts[0].mesh.weights[0]=[{joint:"root",weight:1}];await assert.rejects(applyMotionStudy(stale,"attack",{pixels:pixelEnv}),/改变/);
  const wrong=structuredClone(doc);wrong.motionStudies.attack.frames[0].mapping.parts[0].partId="eyeClosed";await assert.rejects(prepareMotionStudyFrames(wrong,"attack",undefined,{pixels:pixelEnv}),/默认可见|部件标识/);
  const gap=structuredClone(doc);gap.motionStudies.attack.frames[0].mapping.parts[0].sourcePolygon=rect(12,20,1,1);await assert.rejects(prepareMotionStudyFrames(gap,"attack",undefined,{pixels:pixelEnv}),/主体像素/);
  const whole=structuredClone(doc);for(const part of whole.motionStudies.attack.frames[0].mapping.parts){part.visible=part.partId==="body";if(part.visible)part.sourcePolygon=rect(0,0,64,64);}await assert.rejects(prepareMotionStudyFrames(whole,"attack",undefined,{pixels:pixelEnv}),/独立拆件/);
  assert.deepEqual(prepared,original);
  const applied=await appliedFixture(),tampered=structuredClone(applied);tampered.motionStudies.attack.frames[1].segments[0].x++;assert.throws(()=>compileRigSkeleton(tampered),/改变|重新检查/);
});

test("pose-region ordinary calibration is preserved and honestly invalidates its source reconstruction review",async()=>{
  const doc=await appliedFixture(),bundle=parseBundle(attachRigAuthoring(await buildRigFiles(doc,pixelEnv),doc)),frame=doc.motionStudies.attack.frames[1],segment=frame.segments[0],id=motionStudyRegionName("attack",frame.id,segment.partId);
  const edits={[id]:{image:imageDataBytes(independent("#ee00ff",segment.width,segment.height)).bytes,transform:identityTransform(),fileName:"pose.png"}},pages=await compilePages(bundle,edits,pixelEnv),files=await synchronizeRigAuthoring(bundle,edits,pixelEnv),restored=parseBundle(unpackZip(exportPackage({...bundle,files},pages))),author=readRigAuthoring(restored.files);
  assert.equal(author.motionStudies.attack.applied.outOfDate,true);assert.notEqual(author.motionStudies.attack.frames[1].segments[0].image,segment.image);assert.throws(()=>compileRigSkeleton(author),/重新检查/);assert.deepEqual(author.parts,doc.parts);
});

test("several applied actions remain independent and switch attachments without leaking the previous motion",async()=>{
  const doc=await appliedFixture(),before=structuredClone(doc),frames=structuredClone(doc.motionStudies.attack.frames);frames.forEach((frame)=>{delete frame.segments;delete frame.compositionMetrics;});
  doc.motionStudies.hit={motionId:"hit",...await getMotionStudyFingerprints(doc),frames};
  const changed=(await applyMotionStudy((await prepareMotionStudyFrames(doc,"hit",undefined,{pixels:pixelEnv})).document,"hit",{pixels:pixelEnv})).document;
  assert.deepEqual(changed.motionStudies.attack,before.motionStudies.attack);assert.deepEqual(changed.parts,before.parts);assert.deepEqual(changed.motions,before.motions);
  const value=runtime(parseBundle(await buildRigFiles(changed,pixelEnv)));
  at(value,"attack",.8);at(value,"hit",.5,{reset:false});
  assert.deepEqual(new Set(visible(value.skeleton).map((slot)=>slot.data.name)),new Set(["body","arm","eyeOpen"].map((id)=>motionStudySlotName("hit",id))));
  at(value,"attack",0,{reset:false});assert.ok(visible(value.skeleton).every((slot)=>slot.data.name!==motionStudySlotName("hit","body")));
  at(value,"idle",.5,{reset:false});assert.ok(visible(value.skeleton).every((slot)=>!slot.data.name.startsWith("ms_slot_")));
});

test("non-Float32 terminal times hold the real final pose and loop inspection reports actual image discontinuity",async()=>{
  const original=await fixture();original.motions[1].duration=1.3;original.motions[1].poses[1].time=1.3;original.motionStudies.attack.frames[2].time=1.3;
  const doc=(await applyMotionStudy((await prepareMotionStudyFrames(original,"attack",undefined,{pixels:pixelEnv})).document,"attack",{pixels:pixelEnv})).document;
  const value=runtime(parseBundle(await buildRigFiles(doc,pixelEnv))),duration=value.data.findAnimation("attack").duration;
  assert.equal(duration,motionStudyKeyTime(1.3));assert.equal(sampleRigPose(doc,"attack",duration).frameId,"end");assert.equal(sampleRigPose(doc,"attack",duration+1).frameId,"end");
  at(value,"attack",duration+1);assert.ok(visible(value.skeleton).every((slot)=>slot.appliedPose.attachment.name.includes("_end_")));
  const loop=await appliedFixture({loop:true});assert.equal(inspectRigMotion(loop,"attack").loop.imagesContinuous,true);
  const broken=await appliedFixture();broken.motions[1].loop=true;assert.ok(inspectRigMotion(broken,"attack").issues.some((text)=>text.includes("首尾")));
});

test("near-transparent source noise is preserved and reported without becoming AI hidden inpainting",async()=>{
  const doc=await fixture(),frame=doc.motionStudies.attack.frames[1],image=await loadImage(frame.image),canvas=createCanvas(64,64),context=canvas.getContext("2d");context.drawImage(image,0,0);
  const pixel=context.createImageData(1,1);pixel.data.set([255,0,0,1]);context.putImageData(pixel,60,60);frame.image=canvas.toDataURL("image/png");
  frame.sourceFingerprint=createHash("sha256").update(imageDataBytes(frame.image).bytes).digest("hex");frame.mapping.sourceFingerprint=frame.sourceFingerprint;
  const end=doc.motionStudies.attack.frames[2];end.sourceFingerprint=frame.sourceFingerprint;end.mapping.sourceFingerprint=frame.sourceFingerprint;
  const result=await prepareMotionStudyFrames(doc,"attack",undefined,{pixels:pixelEnv});assert.equal(result.report.frames[1].fallbackPixels,1);assert.equal(result.report.frames[1].alphaIoU,1);assert.equal(result.report.frames[1].missingAlphaPixels,0);assert.equal(result.report.hiddenSurfaces,"not-inpainted");
});

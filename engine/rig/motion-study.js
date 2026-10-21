import { assertAppliedMotionStudy } from "../../shared/domain/motion-study.mjs";
import { isMotionStudyPlaybackActive } from "../../shared/domain/motion-study.mjs";
import { motionStudyRegionName } from "../../shared/domain/motion-study.mjs";

function motionStudyAssets(document) {
  return Object.entries(document.motionStudies||{}).flatMap(([motionId,study])=>isMotionStudyPlaybackActive(study)?assertAppliedMotionStudy(document,motionId).frames.flatMap((frame)=>frame.segments.map((segment)=>({...segment,id:motionStudyRegionName(motionId,frame.id,segment.partId),motionId,frameId:frame.id}))):[]);
}

function motionStudyKeyTime(time) {
  const value=Float32Array.of(time),bits=new Uint32Array(value.buffer);if(value[0]<time)bits[0]++;return value[0];
}

function motionStudyFramePoint(frame, point) {
  const transform = frame.playbackTransform;
  if (!transform) return point;
  const { scale, anchor } = transform;
  return { ...point, x: anchor.x + (point.x - anchor.x) * scale, y: anchor.y + (point.y - anchor.y) * scale };
}

function motionStudyFrameRegion(frame, segment) {
  const point = motionStudyFramePoint(frame, segment), scale = frame.playbackTransform?.scale || 1;
  return { ...point, width: segment.width * scale, height: segment.height * scale };
}

function motionStudyFramePose(document, frame) {
  const byId=new Map(frame.mapping.joints.map((joint)=>[joint.id,motionStudyFramePoint(frame,joint)])),children=new Map(document.joints.map((joint)=>[joint.id,document.joints.filter((child)=>child.parent===joint.id)])),joints={};
  const visit=(joint,parentAngle=0)=>{const position=byId.get(joint.id),child=children.get(joint.id)[0],target=child&&byId.get(child.id);let angle=joint.parent&&target&&Math.hypot(target.x-position.x,target.y-position.y)>.001?Math.atan2(target.y-position.y,target.x-position.x)*180/Math.PI:parentAngle;joints[joint.id]={...position,angle};for(const child of children.get(joint.id))visit(child,angle);};
  visit(document.joints.find((joint)=>joint.parent===null));return joints;
}

function sampleMotionStudyPose(document,motionId,time) {
  const study=assertAppliedMotionStudy(document,motionId,{cache:true}),motion=document.motions.find((item)=>item.id===motionId),duration=motionStudyKeyTime(motion.duration);let t=time;
  if(motion.loop&&(t<0||t>duration))t=((t%duration)+duration)%duration;else t=Math.max(0,Math.min(duration,t));
  const frame=[...study.frames].reverse().find((value)=>motionStudyKeyTime(value.time)<=t)||study.frames[0],joints=motionStudyFramePose(document,frame);
  return {kind:"motion-study",stepped:true,time:t,frameId:frame.id,joints,parts:Object.fromEntries(frame.segments.map((segment)=>{const p=motionStudyFrameRegion(frame,segment);return [p.partId,{vertices:[p.x,p.y,p.x,p.y+p.height,p.x+p.width,p.y+p.height,p.x+p.width,p.y],triangles:[0,1,2,2,3,0]}];})),visiblePartIds:frame.segments.map((part)=>part.partId),attachmentSelection:{},angles:{},root:{x:0,y:0},feet:{left:false,right:false},footTargets:{},weaponGrips:[],visibleOnly:true};
}

function inspectMotionStudy(document,motionId,{samples=61}={}) {
  const study=assertAppliedMotionStudy(document,motionId),motion=document.motions.find((item)=>item.id===motionId),first=sampleMotionStudyPose(document,motionId,0),last=sampleMotionStudyPose(document,motionId,motionStudyKeyTime(motion.duration));
  const positionError=Math.max(...document.joints.map((j)=>Math.hypot(first.joints[j.id].x-last.joints[j.id].x,first.joints[j.id].y-last.joints[j.id].y))),angleError=Math.max(...document.joints.map((j)=>Math.abs(((first.joints[j.id].angle-last.joints[j.id].angle+180)%360+360)%360-180))),imagesContinuous=study.frames[0].sourceFingerprint===study.frames.at(-1).sourceFingerprint;
  const issues=[];if(motion.loop&&(positionError>.5||angleError>.5||!imagesContinuous))issues.push("循环逐帧动作首尾画面或关节不连续。");
  return {kind:"motion-study",motionId,stepped:true,duration:motion.duration,runtimeDuration:motionStudyKeyTime(motion.duration),samples,finite:true,issues,frames:study.frames.map((frame)=>frame.compositionMetrics),visibleOnly:true,hiddenSurfaces:"not-inpainted",maxVertexDistance:null,maxFootSlide:{left:null,right:null},footContactSamples:{left:0,right:0},weaponGrips:[],loop:{enabled:motion.loop,positionError,angleError,imagesContinuous,attachmentsContinuous:imagesContinuous,attachmentChanges:[]},solver:{sampler:"motion-study-landmarks",feet:"not-evaluated",twoHandGrip:false}};
}

export { inspectMotionStudy, motionStudyAssets, motionStudyFramePose, motionStudyFramePoint, motionStudyFrameRegion, motionStudyKeyTime, sampleMotionStudyPose };

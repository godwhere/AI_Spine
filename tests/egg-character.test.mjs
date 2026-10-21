import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Skeleton, AnimationState, AnimationStateData, Physics } from "@esotericsoftware/spine-webgl";
import { parseBundle } from "../src/infrastructure/archive-files.js";
import { unpackZip } from "../engine/archive/zip.js";
import { parseSkeleton } from "../engine/spine/parse.js";
import { attachmentVertices } from "../engine/spine/geometry.js";
import { extractPart } from "../src/infrastructure/calibration.js";
import { drawReplacement } from "../engine/images/calibration.js";
import { template, pixelEnv } from "./helpers.mjs";

// Live account calls are performed explicitly in the workbench, never by tests.
// This acceptance suite verifies the saved full-character deliverables.
const directory = new URL("../outputs/egg-starberry/", import.meta.url);
const read = (path) => new Uint8Array(fs.readFileSync(new URL(path, directory)));
const load = (path) => parseBundle(unpackZip(read(path)));
const original = template(19);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pixels = (canvas) => canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data;

test("egg character replaces every one of the six regions with generated art", async () => {
  const project = load("starberry-project.zip"), runtime = load("starberry-runtime.zip");
  assert.equal(original.parts.length,6);
  assert.deepEqual(Object.keys(project.edits).sort(),original.parts.map((part)=>part.id).sort());
  const provenance=JSON.parse(new TextDecoder().decode(read("generation.json")));
  assert.equal(provenance.provider,"codex-native");
  assert.equal(provenance.parts.length,6);
  assert.deepEqual(provenance.parts.map((part)=>part.id).sort(),Object.keys(project.edits).sort());
  for (const part of original.parts) {
    const edit=project.edits[part.id], source=await extractPart(original,part,pixelEnv), result=await extractPart(runtime,part,pixelEnv);
    let changed=0, visible=0;
    const before=pixels(source), after=pixels(result);
    for (let i=0;i<before.length;i+=4) {
      if (after[i+3]>8) visible++;
      if (before.subarray(i,i+4).some((value,channel)=>value!==after[i+channel])) changed++;
    }
    assert.ok(visible>10,`${part.id} is visible`);
    assert.ok(changed>10,`${part.id} really changes the baked runtime texture`);
    assert.equal(digest(read(`parts/${part.name}.png`)),provenance.parts.find((p)=>p.id===part.id).sha256);
    assert.ok(["x","y","scaleX","scaleY","rotation"].every((key)=>Number.isFinite(edit.transform[key])));
    assert.ok(edit.transform.scaleX>0&&edit.transform.scaleY>0);
  }
});

test("every calibrated egg part stays within its atlas output rectangle, including the rotated leaves", async () => {
  const project=load("starberry-project.zip");
  for (const part of original.parts) {
    const image=await pixelEnv.loadImage(project.edits[part.id].image);
    const canvas=pixelEnv.createCanvas(part.originalWidth*3,part.originalHeight*3),ctx=canvas.getContext("2d");
    ctx.translate(part.originalWidth,part.originalHeight);
    drawReplacement(ctx,image,part,project.edits[part.id].transform);
    const data=pixels(canvas), x0=part.originalWidth+part.offsetX,
      y0=part.originalHeight*2-part.offsetY-part.height;
    let visible=0,outside=0;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(data[(y*canvas.width+x)*4+3]>8){
      visible++;
      if(x<x0||x>=x0+part.width||y<y0||y>=y0+part.height)outside++;
    }
    assert.ok(visible>0,part.id);
    assert.equal(outside,0,`${part.id} must not lose visible pixels to the atlas crop`);
  }
  assert.equal(original.parts.find((p)=>p.id==="guaiD3b/hua").degrees,90);
});

test("downloaded runtime, re-imported runtime and all six editable transforms roundtrip exactly", () => {
  const runtime=load("starberry-runtime.zip"),again=load("starberry-reimport-runtime.zip"),
    project=load("starberry-project.zip"),restored=load("starberry-reimport-project.zip");
  assert.deepEqual(Object.keys(runtime.files).sort(),Object.keys(original.files).sort());
  for(const path of [original.skeletonPath,...original.atlasPaths])assert.deepEqual(runtime.files[path],original.files[path]);
  for(const [path,bytes] of Object.entries(runtime.files))assert.deepEqual(again.files[path],bytes);
  for(const part of original.parts){
    assert.deepEqual(restored.edits[part.id].transform,project.edits[part.id].transform,part.id);
    assert.deepEqual(restored.edits[part.id].image,project.edits[part.id].image,part.id);
  }
  assert.deepEqual(project.generation.appearance.image,read("appearance.png"));
  assert.deepEqual(restored.generation.appearance.image,project.generation.appearance.image);
  assert.equal(restored.generation.appearancePrompt,project.generation.appearancePrompt);
  assert.equal(restored.generation.partsPrompt,project.generation.partsPrompt);
});

function poseSampler(bundle){
  const {data}=parseSkeleton(bundle),skeleton=new Skeleton(data),state=new AnimationState(new AnimationStateData(data));
  skeleton.setSkin(data.skins[0]);
  return {data,sample(name,time){
    skeleton.setupPose();
    state.setAnimation(0,name,false).trackTime=time;
    state.apply(skeleton);skeleton.updateWorldTransform(Physics.none);
    return skeleton.drawOrder.appliedPose.flatMap((slot)=>{
      const info=attachmentVertices(skeleton,slot);
      return info?[slot.data.name,info.attachment.name,...info.vertices]:[];
    });
  }};
}
for(const name of ["atk","jifei","std","std2","walk"])
  test(`egg ${name}: 121 poses preserve every region/weighted-mesh vertex before and after re-import`,()=>{
    const source=poseSampler(original),runtime=poseSampler(load("starberry-runtime.zip")),again=poseSampler(load("starberry-reimport-runtime.zip"));
    assert.equal(source.data.animations.length,5);
    assert.equal(runtime.data.bones.length,14);
    const animation=source.data.findAnimation(name);
    assert.ok(animation?.duration>0,name);
    for(let frame=0;frame<=120;frame++){
      const time=animation.duration*frame/120,expected=source.sample(name,time),actual=runtime.sample(name,time),restored=again.sample(name,time);
      assert.ok(expected.length>12);
      assert.ok(actual.filter((value)=>typeof value==="number").every(Number.isFinite));
      assert.deepEqual(actual,expected,`${name} at ${time}`);
      assert.deepEqual(restored,expected,`${name} re-imported at ${time}`);
    }
  });

test("all 45 browser poses are synchronized and all 30 imported character renders match pixel-for-pixel",async()=>{
  const samples=JSON.parse(new TextDecoder().decode(read("evidence/browser-poses.json"))),
    rect=JSON.parse(new TextDecoder().decode(read("evidence/render-rect.json")));
  assert.equal(samples.length,45);
  for(const stage of ["before-export","runtime-import","project-reimport"])
    for(const action of ["atk","jifei","std","std2","walk"]){
      const frames=samples.filter((p)=>p.stage===stage&&p.action===action);
      assert.equal(frames.length,3,`${stage}/${action}`);
      for(const frame of frames){assert.equal(frame.poses.length,2);assert.equal(frame.poses[0].pose,frame.poses[1].pose);assert.equal(frame.poses[0].time,frame.poses[1].time);}
    }
  const crop=async(file)=>{
    const image=await pixelEnv.loadImage(read(`evidence/${file}`)),canvas=pixelEnv.createCanvas(image.width,image.height),ctx=canvas.getContext("2d");
    ctx.drawImage(image,0,0);
    return ctx.getImageData(Math.ceil(rect.x),Math.ceil(rect.y),Math.floor(rect.width),Math.floor(rect.height)).data;
  };
  for(const source of samples.filter((p)=>p.stage==="before-export")){
    const expected=await crop(source.evidence);
    for(const stage of ["runtime-import","project-reimport"]){
      const again=samples.find((p)=>p.stage===stage&&p.action===source.action&&p.sample===source.sample);
      assert.equal(again.time,source.time);
      assert.deepEqual(await crop(again.evidence),expected,`${stage}/${source.action}/${source.sample}`);
    }
  }
});

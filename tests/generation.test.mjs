import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import { createCanvas } from "@napi-rs/canvas";
import { synthetic, pixelEnv, template } from "./helpers.mjs";
import { prepareGenerationRequest, applyGeneratedParts, templateFingerprint, createLocalGenerationProvider } from "../src/core/generation.js";
import { compilePages } from "../src/core/pixels.js";
import { exportPackage, parseBundle, unpackZip } from "../src/core/archive.js";
import { GenerationJobs, validateRequest, imagePrompt } from "../server/generation-service.mjs";
import { generationMiddleware } from "../server/generation-plugin.mjs";
import { generateNativeImage } from "../server/codex-rpc.mjs";

const canvas=createCanvas(32,32),ctx=canvas.getContext("2d");
ctx.fillStyle="#54baff";ctx.fillRect(6,8,20,16);
const png=canvas.toBuffer("image/png"),fingerprint="a".repeat(64);
function request(kind="appearance") {
  return {version:1,kind,projectId:"test-project",prompt:"blue jade armor",template:{id:"template-22",name:"Panda",fingerprint},
    parts:kind==="parts"?[{id:"skin/hand",width:32,height:32},{id:"skin/arm",width:32,height:32}]:[],
    references:kind==="parts"?[{role:"part",partId:"skin/hand",base64:png.toString("base64")},{role:"part",partId:"skin/arm",base64:png.toString("base64")}]:[]};
}
const rpcStub=()=>({start:async()=>{},request:async()=>({account:{type:"chatgpt",email:"private@example.test"}}),close(){}});
async function fixture(t,generate) {
  const root=await mkdtemp(join(tmpdir(),"ai-spine-generation-"));
  const jobs=new GenerationJobs({root,rpc:rpcStub(),generate});
  t.after(async()=>{jobs.close();await jobs.drainingPromise?.catch(()=>{});await rm(root,{recursive:true,force:true});});
  await jobs.loading;
  return {root,jobs};
}
async function settled(jobs,id) {
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){const value=await jobs.get(id);if(["completed","failed","cancelled"].includes(value.status))return value;await new Promise(r=>setTimeout(r,8));}
  throw new Error("test job timed out");
}

test("generation inputs extract logical regions and bind skeleton plus atlas fingerprint",async()=>{
  const bundle=synthetic({rotate:90,pma:true});
  const value=await prepareGenerationRequest(bundle,{prompt:"blue armor",partIds:["part","part"],projectId:"test-project",appearanceReference:{image:new Uint8Array(png)}},pixelEnv);
  assert.equal(value.parts.length,1);assert.equal(value.references[1].partId,"part");
  const bitmap=await pixelEnv.loadImage(value.references[1].bytes);assert.equal(bitmap.width,10);assert.equal(bitmap.height,8);
  const before=await templateFingerprint(bundle);bundle.files[bundle.atlasPaths[0]]=new TextEncoder().encode("different atlas");
  assert.notEqual(await templateFingerprint(bundle),before);
});
test("all 22 catalog templates build correctly mapped generation references without network calls",async()=>{
  const catalog=JSON.parse(await readFile(new URL("../public/templates/catalog.json",import.meta.url),"utf8"));
  assert.equal(catalog.length,22);
  for(const item of catalog){
    const bundle=template(item.id),largest=[...bundle.parts].sort((a,b)=>b.originalWidth*b.originalHeight-a.originalWidth*a.originalHeight)[0],
      rotated=bundle.parts.find((part)=>part.degrees===90),ids=[...new Set([largest.id,rotated?.id].filter(Boolean))];
    const prepared=await prepareGenerationRequest(bundle,{projectId:"catalog-check",prompt:"blue jade material",partIds:ids},pixelEnv);
    const wire={...prepared,references:prepared.references.map(({bytes,...ref})=>({...ref,base64:Buffer.from(bytes).toString("base64")}))};
    assert.equal(validateRequest(wire).parts.length,ids.length,item.name);
    for(const ref of prepared.references){const part=bundle.parts.find(p=>p.id===ref.partId),image=await pixelEnv.loadImage(ref.bytes);assert.equal(image.width,part.originalWidth,item.name);assert.equal(image.height,part.originalHeight,item.name);}
  }
});
test("generated parts apply atomically, auto-fit, export, and restore AI appearance",async()=>{
  const bundle=synthetic(),image={partId:"part",bytes:new Uint8Array(png)},result={kind:"parts",fingerprint:await templateFingerprint(bundle)};
  const edits=await applyGeneratedParts(bundle,{},result,[image],pixelEnv);
  assert.ok(edits.part.transform.scaleX>0);
  assert.deepEqual(Object.keys(edits),["part"]);
  const pages=await compilePages(bundle,edits,pixelEnv);
  const generation={appearancePrompt:"blue panda",partsPrompt:"blue jade",appearance:{image:new Uint8Array(png),fileName:"panda.png",prompt:"blue panda"}};
  const bytes=exportPackage(bundle,pages,{editable:true,edits,generation});
  const restored=parseBundle(unpackZip(bytes));
  assert.deepEqual(restored.generation.appearance.image,new Uint8Array(png));
  assert.equal(restored.generation.partsPrompt,"blue jade");assert.deepEqual(restored.edits.part.image,edits.part.image);
  assert.deepEqual(restored.files[restored.skeletonPath],bundle.files[bundle.skeletonPath]);
  const runtime=unpackZip(exportPackage(bundle,pages,{generation}));
  assert.ok(!Object.keys(runtime).some((p)=>p.startsWith(".ai-spine/")));
  await assert.rejects(()=>applyGeneratedParts(bundle,edits,{...result,fingerprint},[image],pixelEnv),/不匹配/);
  await assert.rejects(()=>applyGeneratedParts(bundle,edits,result,[image,{partId:"missing",bytes:png}],pixelEnv),/映射无效/);
  assert.equal(Object.keys(edits).length,1);
});
test("request validation rejects ambiguous mapping, malformed images, and excess input",()=>{
  const good=request("parts");assert.equal(validateRequest(good).parts.length,2);
  assert.throws(()=>validateRequest({...good,parts:[good.parts[0],good.parts[0]]}),/重复/);
  assert.throws(()=>validateRequest({...good,references:[]}),/缺少部件原图/);
  assert.throws(()=>validateRequest({...good,prompt:"x".repeat(4001)}),/4000/);
  assert.throws(()=>validateRequest({...good,projectId:"../bad"}),/标识/);
  assert.throws(()=>validateRequest({...good,references:[{role:"part",partId:"skin/hand",base64:"notpng"}]}),/PNG|内容/);
  const prompt=imagePrompt(validateRequest(good),good.parts[0],[{role:"part"},{role:"appearance"}]);
  assert.match(prompt,/Image 1: the detached/);assert.match(prompt,/transparent_background true/);
});
test("job service runs one native call per mapped part and restores completed history",async(t)=>{
  let calls=0;
  const {root,jobs}=await fixture(t,async(_rpc,options)=>{calls++;assert.equal(options.references.length,1);return {result:png.toString("base64"),model:"test-native"};});
  const created=await jobs.create(request("parts"));const done=await settled(jobs,created.id);
  assert.equal(done.status,"completed");assert.equal(calls,2);assert.equal(done.images[1].partId,"skin/arm");
  assert.deepEqual(done.partIds,["skin/hand","skin/arm"]);
  assert.deepEqual(await jobs.image(done.id,done.images[0].id),png);
  const disk=JSON.parse(await readFile(join(root,done.id,"job.json"),"utf8"));assert.equal(disk.images.length,2);
  const restored=new GenerationJobs({root,rpc:rpcStub()});t.after(()=>restored.close());
  assert.equal((await restored.list("test-project"))[0].status,"completed");
  assert.equal((await jobs.status()).connected,true);assert.ok(!JSON.stringify(await jobs.status()).includes("private@"));
});
test("cancellation interrupts the active image, prevents duplicates, and keeps partial results",async(t)=>{
  let secondStarted;const entered=new Promise(r=>secondStarted=r);let calls=0;
  const {jobs}=await fixture(t,async(_rpc,{signal})=>{
    if(++calls===1)return {result:png.toString("base64")};
    secondStarted();return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new DOMException("cancelled","AbortError")),{once:true}));
  });
  const created=await jobs.create(request("parts"));await entered;
  await assert.rejects(()=>jobs.create(request()),/已有进行中/);
  const cancelled=await jobs.cancel(created.id);assert.equal(cancelled.status,"cancelled");
  assert.equal(cancelled.images.length,1);assert.equal((await jobs.get(created.id)).images[0].partId,"skin/hand");
  await new Promise(r=>setTimeout(r,30));
});
test("native failure and opaque output become failed jobs without fabricated images",async(t)=>{
  const {jobs}=await fixture(t,async()=>{throw new Error("native unavailable");});
  const job=await jobs.create(request());const failed=await settled(jobs,job.id);
  assert.equal(failed.status,"failed");assert.match(failed.error,/native unavailable/);assert.equal(failed.images.length,0);
  const full=createCanvas(2,2);full.getContext("2d").fillRect(0,0,2,2);
  jobs.generate=async()=>({result:full.toBuffer("image/png").toString("base64")});
  const opaque=await settled(jobs,(await jobs.create(request())).id);assert.equal(opaque.status,"failed");assert.match(opaque.error,/透明背景/);
});
test("interrupted jobs are never silently re-submitted on local service restart",async(t)=>{
  const {root,jobs}=await fixture(t,async()=>{throw new Error("unused");});
  jobs.closed=true;const job=await jobs.create(request());
  const restored=new GenerationJobs({root,rpc:rpcStub()});t.after(()=>restored.close());
  const value=await restored.get(job.id);assert.equal(value.status,"failed");assert.match(value.error,/重启/);
});
test("HTTP boundary enforces loopback and same origin; browser adapter sends PNG bytes",async(t)=>{
  const {jobs}=await fixture(t,async()=>({result:png.toString("base64")}));
  const middleware=generationMiddleware(jobs),server=createServer((req,res)=>void middleware(req,res,()=>{res.writeHead(404);res.end();}));
  await new Promise(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post={method:"POST",headers:{"Content-Type":"application/json",Origin:base},body:JSON.stringify(request())};
  assert.equal((await fetch(base+"/api/generation/jobs",{...post,headers:{...post.headers,Origin:"https://evil.example"}})).status,403);
  assert.equal((await fetch(base+"/api/generation/jobs",{...post,headers:{"Content-Type":"application/json"}})).status,403);
  const rebinding=await new Promise((resolve,reject)=>{
    const req=httpRequest(base+"/api/generation/status",{headers:{Host:"evil.example"}},(res)=>{res.resume();resolve(res.statusCode);});
    req.on("error",reject);req.end();
  });
  assert.equal(rebinding,403);
  const provider=createLocalGenerationProvider((path,options={})=>fetch(base+path,{...options,headers:{...options.headers,Origin:base}}));
  assert.equal((await provider.status()).connected,true);
  const value=request();value.references=[{role:"template",bytes:new Uint8Array(png)}];
  const submitted=await provider.start(value),done=await settled(jobs,submitted.id);
  assert.equal(done.status,"completed");assert.deepEqual(await provider.image(done.id,done.images[0].id),new Uint8Array(png));
  assert.equal((await provider.list("test-project")).length,1);
});

class FakeRpc extends EventEmitter {
  async start(){}
  async request(method,params){
    if(method==="account/read")return {account:{type:this.accountType||"chatgpt"}};
    if(method==="thread/start"){this.threadParams=params;return {thread:{id:"thread"},model:"test-native"};}
    if(method==="turn/start"){
      this.turnParams=params;
      setTimeout(()=>{
        if(this.noComplete)return;
        if(this.image!==false)this.emit("notification",{method:"item/completed",params:{threadId:"thread",item:{type:"imageGeneration",status:"completed",result:png.toString("base64")}}});
        this.emit("notification",{method:"turn/completed",params:{threadId:"thread",turn:{status:this.turnStatus||"completed"}}});
      },5);
      return {turn:{id:"turn"}};
    }
    if(method==="turn/interrupt")this.interrupted=true;
    return {};
  }
}
test("native adapter uses managed ChatGPT auth, ephemeral jobs, and real image events",async()=>{
  const rpc=new FakeRpc();const image=await generateNativeImage(rpc,{cwd:"/tmp",prompt:"test",references:["/tmp/part.png"]});
  assert.equal(image.model,"test-native");assert.equal(rpc.threadParams.ephemeral,true);assert.equal(rpc.threadParams.sandbox,"read-only");
  assert.equal(rpc.turnParams.input[1].type,"localImage");assert.match(rpc.threadParams.baseInstructions,/Never use shell/);
  assert.equal(rpc.listenerCount("notification"),0);
});
test("native adapter rejects text-only and failed turns and propagates cancellation",async()=>{
  const noImage=new FakeRpc();noImage.image=false;
  await assert.rejects(()=>generateNativeImage(noImage,{cwd:"/tmp",prompt:"test",references:[]}),/没有返回原生生图/);
  const failed=new FakeRpc();failed.turnStatus="failed";
  await assert.rejects(()=>generateNativeImage(failed,{cwd:"/tmp",prompt:"test",references:[]}),/未完成/);
  const waiting=new FakeRpc();waiting.noComplete=true;const controller=new AbortController();
  const pending=generateNativeImage(waiting,{cwd:"/tmp",prompt:"test",references:[],signal:controller.signal});
  await new Promise(r=>setTimeout(r,5));controller.abort();await assert.rejects(()=>pending,{name:"AbortError"});assert.equal(waiting.interrupted,true);
  const apiKey=new FakeRpc();apiKey.accountType="apiKey";
  await assert.rejects(()=>generateNativeImage(apiKey,{cwd:"/tmp",prompt:"test",references:[]}),/登录 ChatGPT/);
});

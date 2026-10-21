import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { GenerationJobs } from "../server/jobs/generation-service.mjs";
import { RigJobs, rigGeometry } from "../server/jobs/rig-service.mjs";
import { generationMiddleware } from "../server/http/generation-routes.mjs";
import { generationStorageRoot } from "../server/bootstrap/environments.mjs";
import { generateStructured } from "../server/providers/codex-planning.mjs";
import { generateNativeImage } from "../server/infrastructure/codex-rpc.mjs";
import { RIG_PART_IMAGE_INSTRUCTIONS, RIG_APPEARANCE_IMAGE_INSTRUCTIONS } from "../server/jobs/handlers/rig-prompts.mjs";

const artwork = createCanvas(256, 256), paint = artwork.getContext("2d");
paint.fillStyle = "#8d58ff"; paint.fillRect(100, 105, 56, 100); paint.fillRect(90, 30, 76, 80); paint.fillRect(20, 155, 40, 40);
const source = artwork.toBuffer("image/png");
const small = createCanvas(32, 32), ink = small.getContext("2d"); ink.fillStyle = "#27c7bd"; ink.fillRect(7, 6, 18, 20);
const png = small.toBuffer("image/png");
function rig() {
  return { version: 1, id: "original-character", name: "独立角色", width: 256, height: 256, sourceImage: `data:image/png;base64,${source.toString("base64")}`,
    joints: [{ id: "root", label: "根", parent: null, x: 128, y: 220 }, { id: "torso", label: "躯干", parent: "root", x: 128, y: 140 },
      { id: "head", label: "头", parent: "torso", x: 128, y: 70 }, { id: "leftUpperArm", label: "上臂", parent: "torso", x: 80, y: 130 },
      { id: "leftForearm", label: "前臂", parent: "leftUpperArm", x: 50, y: 150 }, { id: "leftHand", label: "手", parent: "leftForearm", x: 40, y: 175 }],
    parts: [{ id: "body", label: "躯干", bone: "torso", x: 100, y: 105, width: 56, height: 100, z: 0, binding: "mesh", influences: ["torso", "root"], prompt: "补全身体遮挡", critical: true },
      { id: "head", label: "头", bone: "head", x: 90, y: 30, width: 76, height: 80, z: 1, binding: "rigid", influences: ["head"], prompt: "独立头部", critical: true },
      { id: "hand", label: "手", bone: "leftHand", x: 20, y: 155, width: 40, height: 40, z: 2, binding: "rigid", influences: ["leftHand"], prompt: "补全握持手", critical: true }], motions: [] };
}
function expressionRig() {
  const document = rig();
  document.parts.push(...[
    ["eyes_open", "eyes", 3], ["eyes_closed", "eyes", 3], ["mouth_neutral", "mouth", 4], ["mouth_hurt", "mouth", 4],
  ].map(([id, attachmentGroup, z]) => ({ id, label: id, bone: "head", x: 110, y: 65, width: 32, height: 12, z,
    binding: "rigid", influences: ["head"], attachmentGroup, prompt: "独立表情部件", critical: false })));
  document.defaultAttachments = { eyes: "eyes_open", mouth: "mouth_neutral" };
  return document;
}
const structure = () => ({ joints: rig().joints, parts: rig().parts.map((part) => ({ ...part, attachmentGroup: null })), defaultAttachments: [], notes: "遮挡处需要独立补绘和检查。" });
const motionRequest = { id: "attack", name: "攻击", description: "蓄力挥击再收回", duration: 1.2, loop: false };
const motion = (document = rig()) => ({ ...motionRequest, poses: [0, 0.4, 1.2].map((time, index) => ({ time,
  angles: Object.fromEntries(document.joints.map((joint) => [joint.id, joint.id === "leftForearm" && index === 1 ? -55 : 0])), root: { x: 0, y: 0 },
  translations: Object.fromEntries(document.joints.filter((joint) => joint.parent).map((joint) => [joint.id, { x: 0, y: 0 }])),
  scales: Object.fromEntries(document.joints.map((joint) => [joint.id, { x: 1, y: 1 }])),
  drawOrder: [...new Set([...document.parts].sort((a, b) => a.z - b.z).map((part) => part.attachmentGroup ? `group_${part.attachmentGroup}` : `slot_${part.id}`))],
  ease: "smooth", feet: { left: false, right: false } })) });
const structureRequest = () => ({ version: 1, kind: "structure", projectId: rig().id, name: rig().name, planner: "codex-native", image: { base64: source.toString("base64"), width: 256, height: 256 } });
const appearanceRequest = () => ({ ...structureRequest(), kind: "appearance", planner: undefined, prompt: "粉发角色改为Q版赛璐璐形象，手持法杖" });
const partsRequest = () => ({ version: 1, kind: "parts", projectId: rig().id, rig: rig(), partIds: ["body", "head", "hand"], concurrency: 3, prompt: "补全所有遮挡部分" });
const registrationRequest = () => ({ version: 1, kind: "registration", projectId: rig().id, name: rig().name, planner: "codex-native", rig: expressionRig(), gridSize: 32, prompt: "固定原图可见像素，不要让衣服和腿变瘦" });
const registrationPlan = (document, ids = ["body", "head", "hand", "eyes_open", "mouth_neutral"]) => ({ parts: ids.map((id) => {
  const part = document.parts.find((part) => part.id === id); return { id, sourcePolygon: [
    { x: part.x + 1.25, y: part.y + 1 }, { x: part.x + part.width - 2, y: part.y + 2 },
    { x: part.x + part.width - 1, y: part.y + part.height - 1 }, { x: part.x + 3, y: part.y + part.height - 2 },
  ] };
}), notes: "保留原图轮廓，表情区域独立分配。" });
const rpcStub = () => Object.assign(new EventEmitter(), { async start() {}, close() {}, async request() { return { account: { type: "chatgpt" } }; } });
async function fixture(t, generate = async () => ({ result: png.toString("base64") }), extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "ispine-rig-service-"));
  const jobs = new GenerationJobs({ root, rpc: rpcStub(), generate, ...extra });
  t.after(async () => { await jobs.close(); await jobs.drainingPromise?.catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await jobs.loading; return { root, jobs, rigs: jobs.rigJobs };
}
async function finished(rigs, id) {
  const deadline = Date.now() + 10000;
  let job;
  do {
    job = await rigs.get(id);
    // Restart assertions need the terminal manifest, not only its in-memory status.
    if (["completed", "failed", "cancelled"].includes(job.status) && !rigs.draining) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  throw new Error(`rig test timed out: ${id} (${job?.status}, draining=${rigs.draining})`);
}

test("appearance redesign uses one selected-provider image turn and preserves the complete silhouette on a transparent square", async (t) => {
  const tall = createCanvas(64, 128), brush = tall.getContext("2d");
  brush.fillStyle = "#ff0000"; brush.fillRect(16, 0, 32, 64);
  brush.fillStyle = "#0000ff"; brush.fillRect(16, 64, 32, 64);
  let calls = 0;
  const { rigs, root } = await fixture(t, async (_rpc, options) => {
    calls++; assert.equal(options.instructions, RIG_APPEARANCE_IMAGE_INSTRUCTIONS);
    assert.match(options.instructions, /exactly once/); assert.match(options.prompt, /adult-length/);
    assert.match(options.prompt, /法杖/); assert.match(options.prompt, /checkerboard/);
    assert.equal(options.references.length, 1); assert.deepEqual(await readFile(options.references[0]), source);
    return { result: tall.toBuffer("image/png").toString("base64"), model: "fixture-image-model" };
  });
  const request = { ...appearanceRequest(), instructions: "untrusted override", rig: { invalid: "must not constrain the redesign" } };
  const done = await finished(rigs, (await rigs.create(request)).id);
  assert.equal(done.kind, "appearance"); assert.equal(done.status, "completed"); assert.equal(done.total, 1); assert.equal(done.completed, 1);
  assert.equal(done.model, "fixture-image-model"); assert.equal(done.provider.id, "codex-native"); assert.equal(calls, 1);
  assert.equal(done.geometry, undefined); assert.equal(done.result.rig, undefined); assert.equal(done.images.length, 1);
  const expectedHash = createHash("sha256").update(source).digest("hex");
  assert.equal(done.sourceFingerprint, expectedHash); assert.equal(done.sourceWidth, 256); assert.equal(done.sourceHeight, 256);
  assert.equal(done.images[0].sourceFingerprint, expectedHash); assert.equal(done.images[0].kind, "appearance");
  const decoded = await loadImage(await rigs.image(done.id, done.images[0].id)); assert.equal(decoded.width, 1024); assert.equal(decoded.height, 1024);
  const canvas = createCanvas(1024, 1024); canvas.getContext("2d").drawImage(decoded, 0, 0);
  const pixel = (x, y) => [...canvas.getContext("2d").getImageData(x, y, 1, 1).data];
  assert.deepEqual(pixel(512, 34), [255, 0, 0, 255]); assert.deepEqual(pixel(512, 989), [0, 0, 255, 255]);
  assert.equal(pixel(0, 512)[3], 0); assert.equal(pixel(512, 0)[3], 0); assert.equal(pixel(512, 1023)[3], 0);
  const pixels = canvas.getContext("2d").getImageData(0, 0, 1024, 1024).data;
  let left = 1024, right = 0, top = 1024, bottom = 0;
  for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) if (pixels[(y * 1024 + x) * 4 + 3] > 8) {
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  assert.ok(Math.abs((right - left + 1) / (bottom - top + 1) - 0.25) < 0.02, "redesign aspect ratio stays intact");
  assert.ok(left >= 32 && top >= 32 && right < 992 && bottom < 992, "complete artwork has transparent padding");
  assert.deepEqual(done.result.images, done.images); assert.deepEqual(await rigs.list("another-project"), []);
  const restored = new RigJobs({ root: join(root, ".rig"), rpc: rpcStub(), connections: {} });
  t.after(() => restored.close()); assert.deepEqual((await restored.get(done.id)).result.images, done.images);
});

test("appearance candidates identify the exact source bytes and changed sources retain distinct history", async (t) => {
  const { rigs } = await fixture(t);
  const first = await finished(rigs, (await rigs.create(appearanceRequest())).id);
  const changed = createCanvas(256, 256); changed.getContext("2d").fillRect(12, 20, 30, 50);
  const jpeg = changed.toBuffer("image/jpeg");
  const second = await finished(rigs, (await rigs.create({ ...appearanceRequest(), image: { base64: jpeg.toString("base64"), width: 256, height: 256 } })).id);
  assert.notEqual(first.sourceFingerprint, second.sourceFingerprint);
  assert.equal(second.sourceFingerprint, createHash("sha256").update(jpeg).digest("hex"), "hash is computed before PNG normalization");
  assert.equal(second.images[0].sourceFingerprint, second.sourceFingerprint);
  assert.equal((await rigs.get(first.id)).sourceFingerprint, first.sourceFingerprint);
  await assert.rejects(rigs.create({ ...appearanceRequest(), image: undefined }), /导入角色立绘/);
  await assert.rejects(rigs.create({ ...appearanceRequest(), image: { ...appearanceRequest().image, width: 100 } }), /尺寸/);
});

test("appearance cancellation rejects late output, locks connection changes and restores interrupted jobs without resubmission", async (t) => {
  let entered, release, signal;
  const ready = new Promise((resolve) => { entered = resolve; });
  const { rigs, jobs, root } = await fixture(t, async (_rpc, options) => {
    signal = options.signal; entered(); return new Promise((resolve) => { release = resolve; });
  });
  const created = await rigs.create(appearanceRequest()); await ready;
  assert.equal((await rigs.get(created.id)).stage, "appearance"); assert.equal((await rigs.get(created.id)).status, "generating");
  await assert.rejects(jobs.connections.configure({ provider: "codex-native" }), /结束|取消/);
  await assert.rejects(rigs.create(appearanceRequest()), /进行中/);
  await rigs.cancel(created.id); assert.equal(signal.aborted, true);
  release({ result: png.toString("base64") });
  const cancelled = await finished(rigs, created.id); assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.result, undefined); assert.deepEqual(cancelled.images, []);
  rigs.draining = true;
  const queued = await rigs.create(appearanceRequest());
  const recovered = new RigJobs({ root: join(root, ".rig"), rpc: rpcStub(), connections: { generate() { throw new Error("must not resubmit"); } } });
  t.after(() => recovered.close()); const failed = await recovered.get(queued.id);
  assert.equal(failed.kind, "appearance"); assert.equal(failed.status, "failed"); assert.match(failed.error, /已重启/);
  await rigs.cancel(queued.id); rigs.draining = false;
});

test("appearance rejects opaque checkerboards, empty images and non-PNG output before normalization", async (t) => {
  const opaque = createCanvas(32, 64); opaque.getContext("2d").fillRect(0, 0, 32, 64);
  let result;
  const { rigs } = await fixture(t, async () => ({ result }));
  for (const [bytes, error] of [[opaque.toBuffer("image/png"), /透明背景/], [createCanvas(32, 32).toBuffer("image/png"), /完全透明/], [Buffer.from("not a PNG image"), /PNG/]]) {
    result = bytes.toString("base64");
    const failed = await finished(rigs, (await rigs.create(appearanceRequest())).id);
    assert.equal(failed.status, "failed"); assert.match(failed.error, error); assert.deepEqual(failed.images, []); assert.equal(failed.result, undefined);
  }
});

test("appearance keeps the explicitly selected API image provider and never falls back on API failure", async (t) => {
  let native = 0, apiCalls = 0, fail = false;
  const { rigs, jobs } = await fixture(t, async () => { native++; throw new Error("native fallback forbidden"); }, {
    fetcher: async (url, options) => {
      if (url.includes("/models/")) return Response.json({ id: "gpt-image-2.5-sunburst" });
      apiCalls++; assert.match(url, /\/images\/edits$/); assert.equal(options.body.get("background"), "transparent"); assert.equal(options.body.get("n"), "1");
      return fail ? new Response("unavailable", { status: 503 }) : Response.json({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  await jobs.connections.configure({ provider: "openai", apiKey: "sk-appearance-test-only-key", remember: false });
  const done = await finished(rigs, (await rigs.create(appearanceRequest())).id);
  assert.equal(done.status, "completed"); assert.equal(done.provider.id, "openai"); assert.equal(done.images[0].provider, "openai");
  fail = true; const failed = await finished(rigs, (await rigs.create(appearanceRequest())).id);
  assert.equal(failed.status, "failed"); assert.match(failed.error, /503/); assert.deepEqual(failed.images, []);
  assert.equal(apiCalls, 2); assert.equal(native, 0); assert.equal((await jobs.connections.info()).selected, "openai");
});

test("structure analysis uses the uploaded canvas and never fabricates completed part artwork", async (t) => {
  const { rigs, root } = await fixture(t); let calls = 0;
  rigs.plan = async (_rpc, options) => { calls++; assert.equal(options.references.length, 1); assert.deepEqual(await readFile(options.references[0]), source); assert.match(options.prompt, /12-18/); return { value: structure(), model: "fixture-planner" }; };
  const done = await finished(rigs, (await rigs.create(structureRequest())).id);
  assert.equal(done.status, "completed"); assert.equal(calls, 1); assert.equal(done.provider.id, "codex-native");
  assert.equal(done.result.rig.joints.length, 6); assert.equal(done.result.rig.parts.length, 3);
  assert.equal(done.result.rig.sourceImage, rig().sourceImage);
  for (const part of done.result.rig.parts) { assert.equal(part.completion, "needs-inpaint"); assert.equal(part.imageSource, "source-crop"); assert.equal(part.image, undefined); }
  const restored = new RigJobs({ root: join(root, ".rig"), rpc: rpcStub(), connections: {}, plan() { throw new Error("must not rerun"); } });
  t.after(() => restored.close()); assert.equal((await restored.get(done.id)).result.rig.id, rig().id);
  assert.equal((await restored.list(rig().id))[0].result, undefined);
});

test("structure detail keeps standard compatibility and supports a bounded detailed production split", async (t) => {
  const { rigs } = await fixture(t);
  const detailed = (count) => ({ ...structure(), parts: Array.from({ length: count }, (_, index) => ({
    ...rig().parts[0], id: `productionPart${index}`, label: `测试独立层${index}`, bone: "torso", influences: ["torso"],
    binding: "rigid", x: (index % 8) * 28, y: Math.floor(index / 8) * 28, width: 24, height: 24, z: index, attachmentGroup: null,
  })) });
  rigs.plan = async (_rpc, options) => {
    assert.equal(options.schema.properties.parts.minItems, 24); assert.equal(options.schema.properties.parts.maxItems, 64);
    assert.match(options.prompt, /24-40/); assert.match(options.prompt, /never merge a hand into its forearm/);
    assert.match(options.prompt, /front and back hair/); assert.match(options.prompt, /simultaneously visible layers/);
    return { value: detailed(40) };
  };
  const done = await finished(rigs, (await rigs.create({ ...structureRequest(), detail: "detailed" })).id);
  assert.equal(done.status, "completed"); assert.equal(done.detail, "detailed"); assert.equal(done.result.rig.parts.length, 40);
  assert.equal(done.result.rig.structureDetail, "detailed");
  for (const count of [23, 65]) {
    rigs.plan = async () => ({ value: detailed(count) });
    const failed = await finished(rigs, (await rigs.create({ ...structureRequest(), detail: "detailed" })).id);
    assert.equal(failed.status, "failed"); assert.match(failed.error, /格式/); assert.equal(failed.result, undefined);
  }
  rigs.plan = async (_rpc, options) => { assert.equal(options.schema.properties.parts.maxItems, 18); assert.match(options.prompt, /12-18/); return { value: structure() }; };
  const standard = await finished(rigs, (await rigs.create(structureRequest())).id);
  assert.equal(standard.status, "completed"); assert.equal(standard.detail, "standard");
  await assert.rejects(rigs.create({ ...structureRequest(), detail: "unsupported" }), /标准或精细/);
});

test("optional structure expression plans normalize strict nullable transport fields into document groups and defaults", async (t) => {
  const { rigs } = await fixture(t), grouped = expressionRig();
  const plan = { joints: grouped.joints, parts: grouped.parts.map((part) => ({ ...part, attachmentGroup: part.attachmentGroup || null })),
    defaultAttachments: [{ groupId: "eyes", partId: "eyes_open" }, { groupId: "mouth", partId: null }], notes: "表情使用单槽离散切换" };
  rigs.plan = async (_rpc, options) => {
    const strict = (schema) => {
      if (schema.type === "object") { assert.deepEqual(schema.required, Object.keys(schema.properties)); assert.equal(schema.additionalProperties, false); for (const property of Object.values(schema.properties)) strict(property); }
      if (schema.type === "array") strict(schema.items);
    };
    strict(options.schema); assert.match(options.prompt, /attachmentGroup:null/); assert.match(options.prompt, /Only one member/);
    return { value: plan };
  };
  const done = await finished(rigs, (await rigs.create(structureRequest())).id);
  assert.equal(done.status, "completed"); assert.deepEqual(done.result.rig.defaultAttachments, { eyes: "eyes_open", mouth: null });
  assert.equal(done.result.rig.parts[0].attachmentGroup, undefined); assert.equal(done.result.rig.parts.find((part) => part.id === "eyes_closed").attachmentGroup, "eyes");
  rigs.plan = async () => ({ value: { ...plan, defaultAttachments: [{ groupId: "eyes", partId: "mouth_hurt" }] } });
  const invalid = await finished(rigs, (await rigs.create(structureRequest())).id);
  assert.equal(invalid.status, "failed"); assert.match(invalid.error, /附件|分组/);
});

test("source registration plans frozen global polygons for default-visible IDs using original artwork and a separate coordinate guide", async (t) => {
  let imageCalls = 0, plans = 0;
  const { rigs, root } = await fixture(t, async () => { imageCalls++; throw new Error("registration must not redraw artwork"); });
  const input = registrationRequest(); input.rig.motions = [motion(input.rig)];
  input.rig.parts[0].mesh = { cols: 2, rows: 2, weights: Array.from({ length: 4 }, () => [{ joint: "torso", weight: 1 }]) };
  const frozen = structuredClone(input.rig), answer = registrationPlan(frozen), expectedIds = answer.parts.map((part) => part.id);
  rigs.plan = async (_rpc, options) => {
    plans++; assert.equal(options.references.length, 2); assert.deepEqual(await readFile(options.references[0]), source);
    assert.match(options.references[1], /source-grid\.png$/); const guide = await readFile(options.references[1]);
    assert.notDeepEqual(guide, source); const decoded = await loadImage(guide); assert.equal(decoded.width, 256); assert.equal(decoded.height, 256);
    assert.deepEqual(options.schema.properties.parts.items.properties.id.enum, expectedIds);
    assert.match(options.prompt, /not image generation/); assert.match(options.prompt, /not retain the original eye\/mouth/);
    assert.match(options.prompt, /not an instruction to deform/); assert.match(options.prompt, /32-pixel grid/);
    return { value: answer, model: "registration-planner-fixture" };
  };
  const created = await rigs.create(input);
  input.rig.parts[0].x = 10; input.rig.defaultAttachments.eyes = "eyes_closed"; input.rig.motions[0].description = "mutated input";
  const done = await finished(rigs, created.id);
  assert.equal(done.status, "completed"); assert.equal(done.kind, "registration"); assert.equal(done.gridSize, 32); assert.equal(done.maxBBoxExpansion, 2);
  assert.equal(done.provider.id, "codex-native"); assert.equal(done.model, "registration-planner-fixture"); assert.equal(imageCalls, 0); assert.equal(plans, 1);
  assert.deepEqual(done.partIds, expectedIds); assert.deepEqual(done.images, []); assert.equal(done.result.rig, undefined);
  assert.equal(done.result.canApply, true); assert.deepEqual(done.result.warnings, []);
  assert.deepEqual(done.result.polygons.body, answer.parts[0].sourcePolygon); assert.equal(done.result.polygons.eyes_closed, undefined);
  assert.equal(done.sourceFingerprint, createHash("sha256").update(source).digest("hex"));
  assert.equal(done.result.sourceFingerprint, done.sourceFingerprint); assert.deepEqual(done.geometry, rigGeometry(frozen));
  const manifest = JSON.parse(await readFile(join(root, ".rig", done.id, "job.json"), "utf8"));
  assert.deepEqual(manifest.request.rig.joints, frozen.joints); assert.deepEqual(manifest.request.rig.motions, frozen.motions);
  assert.deepEqual(manifest.request.rig.parts[0].mesh, frozen.parts[0].mesh); assert.deepEqual(manifest.request.rig.defaultAttachments, frozen.defaultAttachments);
  const hidden = registrationRequest(); hidden.rig.defaultAttachments.eyes = null; delete hidden.rig.defaultAttachments.mouth;
  rigs.plan = async (_rpc, options) => ({ value: registrationPlan(hidden.rig, options.schema.properties.parts.items.properties.id.enum) });
  const defaults = await finished(rigs, (await rigs.create(hidden)).id);
  assert.deepEqual(defaults.partIds, ["body", "head", "hand", "mouth_neutral"], "null hides a group and an unspecified default uses the first member");
});

test("registration reports truthful polygons outside tight rectangles without clamping, stretching or discarding the editable plan", async (t) => {
  const { rigs } = await fixture(t), input = registrationRequest(), answer = registrationPlan(input.rig);
  answer.parts[0].sourcePolygon[0].x = input.rig.parts[0].x - 3;
  rigs.plan = async () => ({ value: answer });
  const done = await finished(rigs, (await rigs.create(input)).id);
  assert.equal(done.status, "completed"); assert.equal(done.result.canApply, false); assert.equal(done.result.warnings.length, 1);
  assert.equal(done.result.warnings[0].partId, "body"); assert.equal(done.result.warnings[0].requiredExpansion.left, 3);
  assert.equal(done.result.requiredBounds.body.x, 97); assert.equal(done.result.polygons.body[0].x, 97);
  assert.equal(input.rig.parts[0].x, 100); assert.equal(done.geometry.parts[0].x, 100);
  answer.parts[0].sourcePolygon[0].x = 98;
  const allowed = await finished(rigs, (await rigs.create(input)).id);
  assert.equal(allowed.result.canApply, true); assert.deepEqual(allowed.result.warnings, []); assert.equal(allowed.result.polygons.body[0].x, 98);
});

test("registration rejects foreign sources and projects, unsupported planners, and incomplete or invalid ownership mappings", async (t) => {
  const { rigs } = await fixture(t);
  await assert.rejects(rigs.create({ ...registrationRequest(), projectId: "another-project" }), /工程标识/);
  await assert.rejects(rigs.create({ ...registrationRequest(), planner: "openai" }), /只支持/);
  await assert.rejects(rigs.create({ ...registrationRequest(), sourceFingerprint: "0".repeat(64) }), /指纹/);
  await assert.rejects(rigs.create({ ...registrationRequest(), rigFingerprint: "0".repeat(64) }), /几何/);
  await assert.rejects(rigs.create({ ...registrationRequest(), image: { base64: png.toString("base64") } }), /固定立绘/);
  await assert.rejects(rigs.create({ ...registrationRequest(), image: { base64: source.toString("base64"), width: 10 } }), /尺寸/);
  await assert.rejects(rigs.create({ ...registrationRequest(), gridSize: 64 }), /32 像素/);
  await assert.rejects(rigs.create({ ...registrationRequest(), maxBBoxExpansion: 20 }), /2 像素/);
  await assert.rejects(rigs.create({ ...registrationRequest(), partIds: ["body"] }), /全部默认可见/);
  const variants = [
    (value) => { value.parts[1].id = value.parts[0].id; },
    (value) => { value.parts[0].id = "eyes_closed"; },
    (value) => { value.parts.pop(); },
    (value) => { value.parts[0].sourcePolygon = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]; },
    (value) => { value.parts[0].sourcePolygon[0].x = -1; },
    (value) => { value.joints = []; },
  ];
  for (const alter of variants) {
    const answer = registrationPlan(expressionRig()); alter(answer); rigs.plan = async () => ({ value: answer });
    const failed = await finished(rigs, (await rigs.create(registrationRequest())).id);
    assert.equal(failed.status, "failed"); assert.equal(failed.result, undefined); assert.deepEqual(failed.images, []);
    assert.match(failed.error, /重复|格式|面积/);
  }
});

test("registration cancellation and service recovery do not turn planning into image generation or silently resubmit it", async (t) => {
  let entered, calls = 0; const ready = new Promise((resolve) => { entered = resolve; });
  const { rigs, root } = await fixture(t, async () => { throw new Error("no images during registration"); });
  rigs.plan = async (_rpc, { signal }) => new Promise((_resolve, reject) => {
    calls++; signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }); entered();
  });
  const created = await rigs.create(registrationRequest()); await ready;
  assert.equal((await rigs.get(created.id)).stage, "registration"); await rigs.cancel(created.id);
  const cancelled = await finished(rigs, created.id); assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.result, undefined);
  rigs.draining = true; const queued = await rigs.create(registrationRequest());
  const restored = new RigJobs({ root: join(root, ".rig"), rpc: rpcStub(), connections: {}, plan() { throw new Error("must not resubmit"); } });
  t.after(() => restored.close()); const recovered = await restored.get(queued.id);
  assert.equal(recovered.kind, "registration"); assert.equal(recovered.status, "failed"); assert.match(recovered.error, /已重启/);
  assert.equal(calls, 1); assert.deepEqual(recovered.partIds, ["body", "head", "hand", "eyes_open", "mouth_neutral"]);
  await rigs.cancel(queued.id); rigs.draining = false;
});

test("invalid AI structure and unsupported planners fail explicitly without default skeletons", async (t) => {
  const { rigs } = await fixture(t);
  await assert.rejects(rigs.create({ ...structureRequest(), planner: "openai" }), /只支持/);
  rigs.plan = async () => ({ value: { ...structure(), joints: [{ ...rig().joints[0], parent: "missing" }] } });
  const failed = await finished(rigs, (await rigs.create(structureRequest())).id);
  assert.equal(failed.status, "failed"); assert.equal(failed.result, undefined); assert.match(failed.error, /根关节|父级/);
  await assert.rejects(rigs.create({ ...structureRequest(), image: { ...structureRequest().image, width: 12 } }), /尺寸/);
  await assert.rejects(rigs.create({ ...structureRequest(), prompt: "x".repeat(4001) }), /要求无效/);
});

test("independent motion planning preserves requested identity and rejects static poses or unsupported foot contacts", async (t) => {
  const { rigs } = await fixture(t), request = { version: 1, kind: "motion", projectId: rig().id, rig: rig(), planner: "codex-native", motion: motionRequest };
  rigs.plan = async () => ({ value: motion() });
  const done = await finished(rigs, (await rigs.create(request)).id);
  assert.equal(done.status, "completed"); assert.equal(done.result.motion.id, "attack"); assert.equal(done.result.motion.origin, "ai-analysis");
  assert.deepEqual(done.geometry, rigGeometry(rig())); assert.equal(done.rigFingerprint.length, 64);
  const stationary = motion(); for (const pose of stationary.poses) pose.angles.leftForearm = 0;
  rigs.plan = async () => ({ value: stationary });
  assert.match((await finished(rigs, (await rigs.create(request)).id)).error, /姿势变化/);
  const badFeet = motion(); badFeet.poses[1].feet.left = true; rigs.plan = async () => ({ value: badFeet });
  assert.match((await finished(rigs, (await rigs.create(request)).id)).error, /脚锁/);
});

test("motion planning accepts compact identity channels without inheriting preceding transforms", async (t) => {
  const { rigs } = await fixture(t), document = rig(), request = { version: 1, kind: "motion", projectId: document.id, rig: document, planner: "codex-native", motion: motionRequest };
  const output = motion(document);
  output.poses[0].translations.head.x = 5;
  output.poses[0].scales.head = { x: .9, y: .9 };
  for (const field of ["translations", "scales", "drawOrder"]) output.poses[1][field] = null;
  rigs.plan = async (_rpc, options) => {
    assert.match(options.prompt, /NOT inheritance from a previous key/);
    return { value: output };
  };
  const done = await finished(rigs, (await rigs.create(request)).id);
  assert.equal(done.status, "completed", done.error);
  assert.deepEqual(done.result.motion.poses[0].translations.head, { x: 5, y: 0 });
  for (const field of ["translations", "scales", "drawOrder"]) assert.equal(done.result.motion.poses[1][field], undefined);
});

test("motion planning accepts real translation scale or draw-order changes and exposes their bounded local contracts", async (t) => {
  const { rigs } = await fixture(t), document = rig(), request = { version: 1, kind: "motion", projectId: document.id, rig: document, planner: "codex-native", motion: motionRequest };
  for (const field of ["translations", "scales", "drawOrder"]) {
    const output = motion(document); output.poses.forEach((pose) => { pose.angles.leftForearm = 0; });
    if (field === "translations") output.poses[1].translations.head.x = 7;
    if (field === "scales") output.poses[1].scales.head.x = .85;
    if (field === "drawOrder") output.poses[1].drawOrder.reverse();
    rigs.plan = async (_rpc, options) => {
      const properties = options.schema.properties.poses.items.properties;
      assert.equal(properties.translations.properties.root, undefined);
      assert.equal(properties.translations.properties.head.properties.x.minimum, -document.width);
      assert.equal(properties.scales.properties.head.properties.x.minimum, .05);
      assert.deepEqual(properties.drawOrder.items.enum, ["slot_body", "slot_head", "slot_hand"]);
      assert.match(options.prompt, /PARENT'S local axes/); assert.match(options.prompt, /Nonuniform scale/); assert.match(options.prompt, /complete unique back-to-front/);
      return { value: output };
    };
    const done = await finished(rigs, (await rigs.create(request)).id);
    assert.equal(done.status, "completed", done.error); assert.deepEqual(done.result.motion.poses[1][field], output.poses[1][field]);
  }
  const duplicate = motion(document); duplicate.poses[1].drawOrder[0] = duplicate.poses[1].drawOrder[1]; rigs.plan = async () => ({ value: duplicate });
  assert.match((await finished(rigs, (await rigs.create(request)).id)).error, /完整且唯一/);
});

function reviewedMotionReferenceRig(count = 3) {
  const document = rig(), hash = (bytes) => createHash("sha256").update(bytes).digest("hex"), checks = { identity: true, expression: true, limbs: true, scale: true, grip: true };
  const baseFingerprint = hash(source), images = Array.from({ length: count }, (_, index) => {
    const image = createCanvas(256, 256), context = image.getContext("2d"); context.fillStyle = `hsl(${index * 51 + 10},60%,55%)`; context.fillRect(80 + index, 30, 70, 175);
    return image.toBuffer("image/png");
  });
  document.motions = [motion(document), { ...motion(document), id: "idle", name: "Existing idle", loop: true }, { ...motion(document), id: "hit", name: "Other action" }];
  const review = () => ({ approved: true, checks: { ...checks } });
  const frames = images.map((bytes, index) => ({ id: `frame-${index + 1}`, time: Number((.15 * (index + 1)).toFixed(4)), label: `Reviewed pose ${index + 1}`,
    image: `data:image/png;base64,${bytes.toString("base64")}`, sourceFingerprint: hash(bytes), origin: "ai-motion-frame", review: review(),
    imageGeneration: { jobId: `native-job-${index + 1}`, imageId: `image-${index}` } }));
  if (count < 5) frames.unshift({ id: "base", time: 0, image: document.sourceImage, sourceFingerprint: baseFingerprint, origin: "base", reuseBase: true, review: review() });
  frames.push({ id: "end", time: 1.2, imageRef: "frame-1", sourceFingerprint: hash(images[0]), review: review() });
  document.motionStudies = { attack: { playback: "reference", motionId: "attack", baseFingerprint, frames },
    hit: { playback: "reference", motionId: "hit", baseFingerprint, frames: [{ ...frames.find((frame) => frame.id === "frame-1"), id: "other-motion-only" }] } };
  return { document, images, baseFingerprint };
}

test("reviewed motion key images reach the native planner in frozen order with exact PNG bytes and persisted provenance", async (t) => {
  const { rigs } = await fixture(t), { document, images, baseFingerprint } = reviewedMotionReferenceRig(), idle = structuredClone(document.motions[1]);
  let planCalls = 0;
  rigs.plan = async (_rpc, options) => {
    planCalls++; assert.equal(options.references.length, 4); assert.deepEqual(await readFile(options.references[0]), source);
    for (let i = 0; i < images.length; i++) assert.deepEqual(await readFile(options.references[i + 1]), images[i]);
    assert.match(options.prompt, /reviewed motion key-pose references/); assert.match(options.prompt, /ONLY to guide center of mass/);
    assert.match(options.prompt, /bone lengths, head\/cranium size/); assert.match(options.prompt, /staff length/); assert.match(options.prompt, /Never rescale the rig/);
    assert.ok(!options.prompt.includes("other-motion-only")); return { value: motion() };
  };
  const created = await rigs.create({ version: 1, kind: "motion", projectId: document.id, rig: document, planner: "codex-native", motion: motionRequest });
  document.motionStudies.attack.frames.find((frame) => frame.id === "frame-1").image = `data:image/png;base64,${png.toString("base64")}`;
  const done = await finished(rigs, created.id), persisted = JSON.parse(await readFile(join(rigs.root, created.id, "job.json"), "utf8"));
  assert.equal(done.status, "completed", done.error); assert.equal(planCalls, 1); assert.equal(done.motionId, "attack");
  assert.deepEqual(done.motionReferences.map((reference) => [reference.frameId, reference.time, reference.imageIndex]), [["frame-1", .15, 2], ["frame-2", .3, 3], ["frame-3", .45, 4]]);
  assert.equal(done.result.motion.provenance.baseFingerprint, baseFingerprint);
  assert.deepEqual(done.result.motion.provenance.referenceFrames.map((reference) => reference.sourceFingerprint), images.map((bytes) => createHash("sha256").update(bytes).digest("hex")));
  assert.equal(done.result.motion.provenance.referenceFrames[0].jobId, "native-job-1");
  assert.ok(!JSON.stringify(done.result.motion.provenance).includes("data:image"));
  assert.deepEqual(done.motionReferenceExclusions.map((entry) => entry.reason), ["shared-base-already-attached", "image-alias"]);
  assert.deepEqual(persisted.request.motionReferences, done.motionReferences); assert.deepEqual(persisted.request.rig.motions[1], idle);
  assert.deepEqual(persisted.result.motion.provenance, done.result.motion.provenance);
});

test("motion reference selection omits incomplete reviews stale bytes rejected dimensions and foreign bases while retaining text planning", async (t) => {
  const { rigs } = await fixture(t);
  const cases = [
    { reason: "incomplete-five-check-review", edit: (frame) => { frame.review.approved = false; } },
    ...["identity", "expression", "limbs", "scale", "grip"].map((key) => ({ reason: "incomplete-five-check-review", edit: (frame) => { frame.review.checks[key] = false; } })),
    { reason: "image-fingerprint-mismatch", edit: (frame) => { frame.sourceFingerprint = "f".repeat(64); } },
    { reason: "different-canvas-size", edit: (frame) => { frame.image = `data:image/png;base64,${png.toString("base64")}`; frame.sourceFingerprint = createHash("sha256").update(png).digest("hex"); } },
    { reason: "invalid-reference-image", edit: (frame) => { const bytes = Buffer.from("not a real PNG"); frame.image = `data:image/png;base64,${bytes.toString("base64")}`; frame.sourceFingerprint = createHash("sha256").update(bytes).digest("hex"); } },
    { reason: "stale-base-fingerprint", edit: (_frame, study) => { study.baseFingerprint = "e".repeat(64); } },
    { reason: "not-reference-mode", edit: (_frame, study) => { delete study.playback; } },
  ];
  for (const entry of cases) {
    const { document } = reviewedMotionReferenceRig(1), study = document.motionStudies.attack, frame = study.frames.find((item) => item.id === "frame-1"); entry.edit(frame, study);
    rigs.plan = async (_rpc, options) => { assert.equal(options.references.length, 1, entry.reason); assert.match(options.prompt, /No reviewed motion key images are attached/); return { value: motion() }; };
    const done = await finished(rigs, (await rigs.create({ version: 1, kind: "motion", projectId: document.id, rig: document, planner: "codex-native", motion: motionRequest })).id);
    assert.equal(done.status, "completed", done.error); assert.equal(done.motionReferences.length, 0);
    assert.ok(done.motionReferenceExclusions.some((item) => item.frameId === "frame-1" && item.reason === entry.reason), JSON.stringify(done.motionReferenceExclusions));
    assert.deepEqual(done.result.motion.provenance.referenceFrames, []);
  }
});

test("motion reference selection allows one image caps at four and detects saved-image tampering before a native turn", async (t) => {
  const { rigs } = await fixture(t);
  for (const count of [1, 5]) {
    const { document } = reviewedMotionReferenceRig(count);
    rigs.plan = async (_rpc, options) => { assert.equal(options.references.length, Math.min(count, 4) + 1); return { value: motion() }; };
    const done = await finished(rigs, (await rigs.create({ version: 1, kind: "motion", projectId: document.id, rig: document, planner: "codex-native", motion: motionRequest })).id);
    assert.equal(done.status, "completed", done.error); assert.equal(done.motionReferences.length, Math.min(count, 4));
    if (count === 5) assert.ok(done.motionReferenceExclusions.some((item) => item.reason === "maximum-four-reference-images"));
  }
  const { document } = reviewedMotionReferenceRig(1); let planCalls = 0;
  rigs.plan = async () => { planCalls++; return { value: motion() }; }; rigs.draining = true;
  const created = await rigs.create({ version: 1, kind: "motion", projectId: document.id, rig: document, planner: "codex-native", motion: motionRequest });
  await writeFile(join(rigs.root, created.id, created.motionReferences[0].file), png); rigs.draining = false; await rigs.drain();
  const done = await finished(rigs, created.id); assert.equal(done.status, "failed"); assert.match(done.error, /本地文件已改变/); assert.equal(planCalls, 0);
});

test("motion planning uses only existing group variants, permits expression motion and rejects mismatched loop endpoints", async (t) => {
  const { rigs } = await fixture(t), document = expressionRig();
  const request = { version: 1, kind: "motion", projectId: document.id, rig: document, planner: "codex-native",
    motion: { ...motionRequest, id: "idle", name: "待机眨眼", description: "平静待机，眨眼后恢复原表情", loop: true } };
  const output = () => ({ ...motion(document), ...request.motion, poses: motion(document).poses.map((pose, index) => ({ ...pose,
    angles: Object.fromEntries(document.joints.map((joint) => [joint.id, 0])),
    attachments: { eyes: index === 1 ? "eyes_closed" : "eyes_open", mouth: index === 1 ? null : "mouth_neutral" } })) });
  rigs.plan = async (_rpc, options) => {
    const schema = options.schema.properties.poses.items.properties.attachments;
    assert.deepEqual(schema.required, ["eyes", "mouth"]); assert.deepEqual(schema.properties.eyes.enum, ["eyes_open", "eyes_closed", null]);
    assert.match(options.prompt, /instantaneous at the keyframe/); assert.match(options.prompt, /idle blinking/);
    assert.match(options.prompt, /same effective attachment/); return { value: output() };
  };
  const done = await finished(rigs, (await rigs.create(request)).id);
  assert.equal(done.status, "completed"); assert.equal(done.result.motion.poses[1].attachments.eyes, "eyes_closed");
  assert.equal(done.result.motion.poses[1].attachments.mouth, null);
  assert.deepEqual(done.geometry.defaultAttachments, document.defaultAttachments);
  assert.equal(done.geometry.parts[0].attachmentGroup, null); assert.equal(done.geometry.parts.at(-1).attachmentGroup, "mouth");
  assert.notDeepEqual(rigGeometry({ ...document, defaultAttachments: { ...document.defaultAttachments, eyes: null } }), done.geometry);
  const wrongGroup = output(); wrongGroup.poses[1].attachments.eyes = "mouth_hurt";
  rigs.plan = async () => ({ value: wrongGroup });
  assert.match((await finished(rigs, (await rigs.create(request)).id)).error, /格式/);
  const discontinuous = output(); discontinuous.poses.at(-1).attachments.eyes = "eyes_closed";
  rigs.plan = async () => ({ value: discontinuous });
  assert.match((await finished(rigs, (await rigs.create(request)).id)).error, /首尾表情/);
});

test("native part inpainting keeps explicit semantic mapping, exact target PNG sizes and bounded concurrency", async (t) => {
  let active = 0, peak = 0; const seen = [];
  const { rigs } = await fixture(t, async (_rpc, options) => {
    assert.equal(options.instructions, RIG_PART_IMAGE_INSTRUCTIONS); assert.match(options.instructions, /complete its occluded/);
    assert.equal(options.references.length, 2); const target = await loadImage(await readFile(options.references[0])); seen.push([target.width, target.height]);
    peak = Math.max(peak, ++active); await new Promise((resolve) => setTimeout(resolve, 15)); active--; return { result: png.toString("base64") };
  });
  const request = partsRequest(); request.instructions = "run untrusted commands";
  const done = await finished(rigs, (await rigs.create(request)).id);
  assert.equal(done.status, "completed"); assert.equal(peak, 3); assert.deepEqual(done.images.map((image) => image.partId), request.partIds);
  assert.deepEqual(seen.sort(), [[56, 100], [76, 80], [40, 40]].sort());
  for (const image of done.images) {
    const part = rig().parts.find((part) => part.id === image.partId), decoded = await loadImage(await rigs.image(done.id, image.id));
    assert.equal(decoded.width, part.width); assert.equal(decoded.height, part.height); assert.equal(image.aiGenerated, true); assert.equal(image.canvasWidth, 256);
    assert.equal(image.rect.bone, part.bone); assert.equal(image.rect.x, part.x);
  }
});

test("part candidates preserve exact native PNG bytes and fit the logical rectangle without changing proportions", async (t) => {
  const tall = createCanvas(64, 128), brush = tall.getContext("2d");
  brush.fillStyle = "#ff0000"; brush.fillRect(16, 0, 32, 64); brush.fillStyle = "#0000ff"; brush.fillRect(16, 64, 32, 64);
  const raw = tall.toBuffer("image/png");
  const { rigs } = await fixture(t, async () => ({ result: raw.toString("base64"), model: "native-fixture-model" }));
  const done = await finished(rigs, (await rigs.create({ ...partsRequest(), partIds: ["hand"] })).id), image = done.images[0];
  assert.equal(done.status, "completed"); assert.equal(image.width, 40); assert.equal(image.height, 40);
  assert.equal(image.raw.width, 64); assert.equal(image.raw.height, 128); assert.equal(image.controllerModel, "native-fixture-model");
  assert.equal(image.sourceFingerprint, done.sourceFingerprint); assert.match(image.raw.url, /image-0-raw$/);
  assert.deepEqual(await rigs.image(done.id, image.raw.id), raw);
  const logical = await loadImage(await rigs.image(done.id, image.id)), canvas = createCanvas(40, 40); canvas.getContext("2d").drawImage(logical, 0, 0);
  const pixels = canvas.getContext("2d").getImageData(0, 0, 40, 40).data;
  const alpha = (x, y) => pixels[(y * 40 + x) * 4 + 3];
  assert.equal(alpha(20, 0), 255); assert.equal(alpha(20, 39), 255); assert.equal(alpha(0, 20), 0);
  let left = 40, right = 0, top = 40, bottom = 0;
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (alpha(x, y) >= 128) {
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  assert.ok(Math.abs((right - left + 1) / (bottom - top + 1) - 0.25) < 0.04, "part art is contained, not stretched");
});

test("failed part batches retry only missing IDs using the frozen source, brief, geometry, provider and API model", async (t) => {
  let nativeCalls = 0, failHead = true; const calls = [];
  const { rigs, jobs } = await fixture(t, async () => { nativeCalls++; throw new Error("must use original API provider"); }, {
    fetcher: async (url, options) => {
      if (url.includes("/models/")) return Response.json({ id: decodeURIComponent(url.split("/").at(-1)) });
      const prompt = options.body.get("prompt"), partId = /"id":"([^"]+)"/.exec(prompt)?.[1];
      calls.push({ partId, prompt, model: options.body.get("model"), references: await Promise.all(options.body.getAll("image[]").map(async (blob) => Buffer.from(await blob.arrayBuffer()))) });
      if (partId === "head" && failHead) { failHead = false; return new Response("unavailable", { status: 503 }); }
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  await jobs.connections.configure({ provider: "openai", model: "gpt-image-1.5", apiKey: "sk-rig-retry-fixture-key", remember: false });
  const input = { ...partsRequest(), concurrency: 1 }, failed = await finished(rigs, (await rigs.create(input)).id);
  assert.equal(failed.status, "failed"); assert.deepEqual(failed.images.map((image) => image.partId), ["body"]);
  assert.deepEqual(calls.map((call) => call.partId), ["body", "head"]);
  input.prompt = "new brief must not be used"; input.rig.parts[1].x = 2; input.rig.sourceImage = `data:image/png;base64,${png.toString("base64")}`;
  await jobs.connections.configure({ provider: "openai", model: "gpt-image-2.5-flare", remember: false });
  await jobs.connections.configure({ provider: "codex-native" });
  const retried = await finished(rigs, (await rigs.retry(failed.id, { concurrency: 2 })).id);
  assert.equal(retried.status, "completed"); assert.equal(retried.parentJobId, failed.id); assert.deepEqual(retried.partIds, ["head", "hand"]);
  assert.equal(retried.provider.id, "openai"); assert.equal(retried.provider.model, "gpt-image-1.5");
  assert.equal(retried.sourceFingerprint, failed.sourceFingerprint); assert.equal(retried.sourceWidth, failed.sourceWidth);
  assert.deepEqual(retried.geometry, failed.geometry); assert.equal(retried.prompt, failed.prompt);
  const headCalls = calls.filter((call) => call.partId === "head"); assert.equal(headCalls.length, 2);
  assert.equal(headCalls[1].prompt, headCalls[0].prompt); assert.deepEqual(headCalls[1].references, headCalls[0].references);
  assert.ok(calls.every((call) => call.model === "gpt-image-1.5")); assert.equal(nativeCalls, 0);
  assert.deepEqual((await rigs.get(failed.id)).images, failed.images); assert.ok((await rigs.image(failed.id, failed.images[0].id)).length);
  assert.equal((await jobs.connections.info()).selected, "codex-native", "retry does not change the selected image provider");
  await assert.rejects(rigs.retry(retried.id), /只能继续/); await assert.rejects(rigs.retry("missing"), /不存在/);
  await assert.rejects(rigs.retry(failed.id, { concurrency: 9 }), /同时补绘/);
});

test("restoring old part history derives missing source identity only from matching frozen reference pixels", async (t) => {
  const { rigs, root } = await fixture(t);
  const done = await finished(rigs, (await rigs.create({ ...partsRequest(), partIds: ["body"] })).id);
  const path = join(root, ".rig", done.id, "job.json"), manifest = JSON.parse(await readFile(path, "utf8"));
  delete manifest.request.sourceFingerprint;
  for (const image of [...manifest.images, ...manifest.result.images]) delete image.sourceFingerprint;
  await writeFile(path, JSON.stringify(manifest));
  const recovered = new RigJobs({ root: join(root, ".rig"), rpc: rpcStub(), connections: {} }); t.after(() => recovered.close());
  const restored = await recovered.get(done.id); assert.equal(restored.sourceFingerprint, done.sourceFingerprint);
  assert.equal(restored.images[0].sourceFingerprint, done.sourceFingerprint); assert.equal(restored.result.images[0].sourceFingerprint, done.sourceFingerprint);
  const mismatch = JSON.parse(await readFile(path, "utf8")); delete mismatch.request.sourceFingerprint;
  mismatch.request.rig.sourceImage = `data:image/png;base64,${createCanvas(256, 256).toBuffer("image/png").toString("base64")}`;
  for (const image of [...mismatch.images, ...mismatch.result.images]) delete image.sourceFingerprint;
  await writeFile(path, JSON.stringify(mismatch));
  const unverifiable = new RigJobs({ root: join(root, ".rig"), rpc: rpcStub(), connections: {} }); t.after(() => unverifiable.close());
  const rejected = await unverifiable.get(done.id); assert.equal(rejected.sourceFingerprint, undefined); assert.equal(rejected.images[0].sourceFingerprint, undefined);
});

test("restoring jobs created before expression groups preserves their original geometry and fingerprint", async (t) => {
  const { rigs, root } = await fixture(t);
  const done = await finished(rigs, (await rigs.create({ ...partsRequest(), partIds: ["body"] })).id);
  const path = join(root, ".rig", done.id, "job.json"), manifest = JSON.parse(await readFile(path, "utf8"));
  delete manifest.geometry.defaultAttachments;
  for (const part of manifest.geometry.parts) delete part.attachmentGroup;
  manifest.rigFingerprint = createHash("sha256").update(JSON.stringify(manifest.geometry)).digest("hex");
  await writeFile(path, JSON.stringify(manifest));
  const restored = new RigJobs({ root: join(root, ".rig"), rpc: rpcStub(), connections: {} }); t.after(() => restored.close());
  const previous = await restored.get(done.id); assert.deepEqual(previous.geometry, manifest.geometry); assert.equal(previous.rigFingerprint, manifest.rigFingerprint);
  assert.equal(previous.geometry.defaultAttachments, undefined); assert.equal(previous.geometry.parts[0].attachmentGroup, undefined);
});

test("rig part cancellation aborts every call and locks shared connection changes throughout the job", async (t) => {
  let enter; const entered = new Promise((resolve) => { enter = resolve; }), signals = [];
  const { rigs, jobs } = await fixture(t, async (_rpc, { signal }) => new Promise((_resolve, reject) => {
    signals.push(signal); signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }); if (signals.length === 3) enter();
  }));
  const created = await rigs.create(partsRequest()); await entered;
  await assert.rejects(jobs.connections.configure({ provider: "codex-native" }), /结束|取消/);
  await assert.rejects(jobs.connections.forget("openai"), /结束/);
  await assert.rejects(jobs.connections.login(), /结束/);
  await rigs.cancel(created.id); await rigs.drainingPromise;
  assert.ok(signals.every((signal) => signal.aborted)); assert.equal((await rigs.get(created.id)).status, "cancelled"); assert.equal((await rigs.get(created.id)).images.length, 0);
});

test("interrupted rig jobs restore as failed without resubmission, and planning cancellation is terminal", async (t) => {
  const { rigs, root, jobs } = await fixture(t); rigs.draining = true;
  const queued = await rigs.create(structureRequest());
  const recovered = new RigJobs({ root: join(root, ".rig"), rpc: jobs.rpc, connections: jobs.connections, plan() { throw new Error("must not resubmit"); } });
  t.after(() => recovered.close()); const recoveredJob = await recovered.get(queued.id);
  assert.equal(recoveredJob.status, "failed"); assert.match(recoveredJob.error, /已重启/);
  await rigs.cancel(queued.id); rigs.draining = false;
  let entered; const ready = new Promise((resolve) => { entered = resolve; });
  rigs.plan = async (_rpc, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }); entered(); });
  const planning = await rigs.create(structureRequest()); await ready; await rigs.cancel(planning.id); await rigs.drainingPromise;
  assert.equal((await rigs.get(planning.id)).result, undefined); assert.equal((await rigs.get(planning.id)).status, "cancelled");
});

test("selected API parts never fall back to Codex, and opaque AI images cannot become completed candidates", async (t) => {
  let native = 0, images = 0; const opaque = createCanvas(32, 32); opaque.getContext("2d").fillRect(0, 0, 32, 32);
  const { rigs, jobs } = await fixture(t, async () => { native++; throw new Error("no native fallback"); }, {
    fetcher: async (url) => url.includes("/models/") ? Response.json({ id: "gpt-image-2.5-sunburst" }) : (images++, Response.json({ data: [{ b64_json: opaque.toBuffer("image/png").toString("base64") }] })),
  });
  await jobs.connections.configure({ provider: "openai", apiKey: "sk-rig-test-only-key", remember: false });
  const failed = await finished(rigs, (await rigs.create({ ...partsRequest(), partIds: ["body"] })).id);
  assert.equal(failed.provider.id, "openai"); assert.equal(failed.status, "failed"); assert.match(failed.error, /透明背景/); assert.equal(failed.images.length, 0); assert.equal(native, 0); assert.equal(images, 1);
  rigs.plan = async () => ({ value: structure() });
  assert.equal((await finished(rigs, (await rigs.create(structureRequest())).id)).status, "completed");
  assert.equal((await jobs.connections.info()).selected, "openai", "explicit Codex planning does not change the image provider");
});

test("rig HTTP jobs share loopback/origin controls and expose real JSON history and PNG candidates", async (t) => {
  let failHead = false;
  const { rigs, jobs } = await fixture(t, async (_rpc, options) => {
    if (failHead && options.prompt.includes('"id":"head"')) throw new Error("fixture head failed");
    return { result: png.toString("base64") };
  }); rigs.plan = async () => ({ value: structure() });
  const middleware = generationMiddleware(jobs), server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const post = (value) => fetch(origin + "/api/rig/jobs", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await fetch(origin + "/api/rig/jobs", { method: "POST", headers: { Origin: "https://foreign.test" } })).status, 403);
  assert.equal((await fetch(origin + "/api/rig/jobs", { method: "POST" })).status, 403);
  const foreign = await new Promise((resolve, reject) => { const request = httpRequest(origin + "/api/rig/jobs", { headers: { Host: "foreign.test" } }, (response) => { response.resume(); resolve(response.statusCode); }); request.on("error", reject); request.end(); });
  assert.equal(foreign, 403);
  const created = await post(structureRequest()); assert.equal(created.status, 202); const done = await finished(rigs, (await created.json()).id);
  const detail = await (await fetch(origin + `/api/rig/jobs/${done.id}`)).json(); assert.equal(detail.result.rig.parts.length, 3);
  const list = await (await fetch(origin + `/api/rig/jobs?projectId=${rig().id}`)).json(); assert.equal(list.jobs[0].result, undefined);
  const parts = await finished(rigs, (await (await post({ ...partsRequest(), partIds: ["body"] })).json()).id);
  const response = await fetch(origin + parts.images[0].url); assert.match(response.headers.get("content-type"), /image\/png/); assert.ok((await response.arrayBuffer()).byteLength > 0);
  const raw = await fetch(origin + parts.images[0].raw.url); assert.equal(raw.status, 200); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), png);
  assert.equal((await fetch(origin + parts.images[0].raw.url, { headers: { Origin: "https://foreign.test" } })).status, 403);
  assert.equal((await fetch(origin + `/api/rig/jobs/${parts.id}/images/image-99-raw`)).status, 404);
  failHead = true;
  const interrupted = await finished(rigs, (await (await post({ ...partsRequest(), concurrency: 1 })).json()).id);
  assert.equal(interrupted.status, "failed"); assert.deepEqual(interrupted.images.map((image) => image.partId), ["body"]);
  const retryURL = origin + `/api/rig/jobs/${interrupted.id}/retry`;
  const retry = (value, headers = { Origin: origin, "Content-Type": "application/json" }) => fetch(retryURL, { method: "POST", headers, body: JSON.stringify(value) });
  assert.equal((await retry({ concurrency: 2 }, { Origin: "https://foreign.test", "Content-Type": "application/json" })).status, 403);
  assert.equal((await retry({ concurrency: 2 }, { "Content-Type": "application/json" })).status, 403);
  assert.equal((await retry({ concurrency: 2 }, { Origin: origin })).status, 415);
  assert.equal((await retry({ concurrency: 9 })).status, 400);
  assert.equal((await retry({ concurrency: 2, excess: "x".repeat(4100) })).status, 400);
  failHead = false;
  const continuedResponse = await retry({ concurrency: 2, prompt: "ignored replacement brief" }); assert.equal(continuedResponse.status, 202);
  const continued = await finished(rigs, (await continuedResponse.json()).id);
  assert.equal(continued.status, "completed"); assert.equal(continued.parentJobId, interrupted.id); assert.deepEqual(continued.partIds, ["head", "hand"]);
  assert.equal(continued.prompt, interrupted.prompt); assert.equal(continued.sourceFingerprint, interrupted.sourceFingerprint);
  assert.equal((await fetch(origin + interrupted.images[0].url)).status, 200, "partial results remain usable after continuation");
  assert.equal((await fetch(origin + `/api/rig/jobs/${continued.id}/retry`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 400);
  const appearance = await finished(rigs, (await (await post(appearanceRequest())).json()).id);
  const candidate = await fetch(origin + appearance.images[0].url); assert.equal(candidate.status, 200);
  const appearanceDetail = await (await fetch(origin + `/api/rig/jobs/${appearance.id}`)).json();
  assert.equal(appearanceDetail.sourceFingerprint, createHash("sha256").update(source).digest("hex"));
  assert.equal(appearanceDetail.result.images[0].width, 1024); assert.equal(appearanceDetail.result.images[0].kind, "appearance");
  rigs.plan = async (_rpc, options) => ({ value: registrationPlan(expressionRig(), options.schema.properties.parts.items.properties.id.enum) });
  const registeredResponse = await post(registrationRequest()); assert.equal(registeredResponse.status, 202);
  const registered = await finished(rigs, (await registeredResponse.json()).id);
  assert.equal(registered.status, "completed"); assert.equal(registered.kind, "registration"); assert.deepEqual(registered.images, []);
  const registrationDetail = await (await fetch(origin + `/api/rig/jobs/${registered.id}`)).json();
  assert.deepEqual(Object.keys(registrationDetail.result.polygons), ["body", "head", "hand", "eyes_open", "mouth_neutral"]);
  assert.equal(registrationDetail.result.sourceFingerprint, registrationDetail.sourceFingerprint);
  assert.equal((await post({ ...registrationRequest(), sourceFingerprint: "0".repeat(64) })).status, 400);
  assert.equal((await post({ ...registrationRequest(), projectId: "foreign-project" })).status, 400);
  rigs.plan = async () => ({ value: structure() });
  assert.equal((await post({ ...structureRequest(), planner: "openai" })).status, 400);
});

class PlanningRpc extends EventEmitter {
  constructor({ response = { answer: "valid" }, status = "completed", tool = false, hold = false } = {}) { super(); Object.assign(this, { response, status, tool, hold, calls: [] }); }
  async start() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "thread/start") { this.thread = params; return { thread: { id: "planning-thread" }, model: "fixture-model" }; }
    if (method === "turn/start") {
      this.turn = params;
      if (this.hold) return new Promise((resolve) => { this.startTurn = resolve; });
      queueMicrotask(() => {
        this.emit("notification", { method: "item/completed", params: { threadId: "wrong-thread", item: { type: "agentMessage", text: "malformed" } } });
        if (this.tool) this.emit("notification", { method: "item/started", params: { threadId: "planning-thread", turnId: "turn", item: { type: "commandExecution" } } });
        this.emit("notification", { method: "item/completed", params: { threadId: "planning-thread", turnId: "turn", item: { type: "agentMessage", phase: "final_answer", text: JSON.stringify(this.response) } } });
        this.emit("notification", { method: "turn/completed", params: { threadId: "planning-thread", turn: { id: "turn", status: this.status } } });
      });
      return { turn: { id: "turn" } };
    }
    return {};
  }
}
const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
test("development and each preview port use separate stable persistent job roots", () => {
  const root = "/tmp/ispine-test-project";
  assert.equal(generationStorageRoot(root), join(root, "work/generation/jobs"));
  const first = generationStorageRoot(root, { preview: true, port: 4177 }), second = generationStorageRoot(root, { preview: true, port: 4178 });
  assert.notEqual(first, second); assert.notEqual(first, generationStorageRoot(root));
  assert.equal(first, generationStorageRoot(root, { preview: true, port: 4177 }));
  assert.match(first, /preview-4177\/jobs$/);
});
test("structured Codex planning supplies local images/outputSchema and accepts only its completed agent response", async () => {
  const rpc = new PlanningRpc(), result = await generateStructured(rpc, { cwd: "/tmp", prompt: "analyze", schema, references: ["/tmp/attached.png"] });
  assert.deepEqual(result.value, { answer: "valid" }); assert.equal(rpc.thread.approvalPolicy, "never"); assert.equal(rpc.thread.sandbox, "read-only");
  assert.deepEqual(rpc.turn.outputSchema, schema); assert.equal(rpc.turn.input[1].type, "localImage");
  assert.equal(rpc.listenerCount("notification"), 0); assert.equal(rpc.listenerCount("disconnected"), 0);
  assert.ok(rpc.calls.some((call) => call.method === "thread/unsubscribe"));
});

test("native structured planner forwards multiple local images in order without dropping action references", async () => {
  const rpc = new PlanningRpc(), references = ["/tmp/source.png", ...Array.from({ length: 4 }, (_, index) => `/tmp/motion-reference-${index}.png`)];
  const result = await generateStructured(rpc, { cwd: "/tmp", prompt: "Plan from the standing reference and all four reviewed action images", schema, references });
  assert.deepEqual(result.value, { answer: "valid" });
  assert.deepEqual(rpc.turn.input, [{ type: "text", text: "Plan from the standing reference and all four reviewed action images" }, ...references.map((path) => ({ type: "localImage", path }))]);
  assert.equal(rpc.thread.approvalPolicy, "never"); assert.equal(rpc.thread.sandbox, "read-only");
});
test("structured planning rejects failed turns, unexpected tool use and malformed schemas", async () => {
  for (const options of [{ status: "failed" }, { tool: true }, { response: { answer: 12 } }]) {
    const rpc = new PlanningRpc(options); await assert.rejects(generateStructured(rpc, { cwd: "/tmp", prompt: "analyze", schema }), /未完成|工具|格式/);
    assert.equal(rpc.listenerCount("notification"), 0);
  }
});
test("cancellation before turn/start responds still interrupts the eventual turn and cleans up", async () => {
  const rpc = new PlanningRpc({ hold: true }), controller = new AbortController();
  const pending = generateStructured(rpc, { cwd: "/tmp", prompt: "analyze", schema, signal: controller.signal });
  while (!rpc.startTurn) await new Promise(setImmediate);
  controller.abort(); const rejected = assert.rejects(pending, { name: "AbortError" });
  rpc.startTurn({ turn: { id: "late-turn" } }); await rejected;
  assert.ok(rpc.calls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "late-turn")); assert.equal(rpc.listenerCount("notification"), 0);
});
test("planning timeout is a failure, and trusted rig image instructions reach only the native adapter", async () => {
  const planning = new PlanningRpc({ hold: true });
  const timedOut = generateStructured(planning, { cwd: "/tmp", prompt: "analyze", schema, timeoutMs: 10 });
  while (!planning.startTurn) await new Promise(setImmediate);
  setTimeout(() => planning.startTurn({ turn: { id: "late-turn" } }), 20);
  await assert.rejects(timedOut, /超时/);
  const rpc = new PlanningRpc(); rpc.request = async function (method, params) {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "thread/start") { this.thread = params; return { thread: { id: "image-thread" } }; }
    if (method === "turn/start") { queueMicrotask(() => {
      this.emit("notification", { method: "item/completed", params: { threadId: "image-thread", item: { type: "imageGeneration", status: "completed", result: png.toString("base64") } } });
      this.emit("notification", { method: "turn/completed", params: { threadId: "image-thread", turn: { status: "completed" } } });
    }); return { turn: { id: "image-turn" } }; }
    return {};
  };
  for (const instructions of [RIG_PART_IMAGE_INSTRUCTIONS, RIG_APPEARANCE_IMAGE_INSTRUCTIONS]) {
    await generateNativeImage(rpc, { cwd: "/tmp", prompt: "character art", references: [], instructions });
    assert.equal(rpc.thread.baseInstructions, instructions);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { RigJobs, rigGeometry } from "../server/jobs/rig-service.mjs";
import { generationMiddleware } from "../server/http/generation-routes.mjs";
import { MOTION_FRAME_IMAGE_INSTRUCTIONS } from "../server/jobs/handlers/motion-study.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = (size = 256, color = "#c84065", opaque = false, edge = false) => {
  const canvas = createCanvas(size, size), ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  if (opaque) ctx.fillRect(0, 0, size, size);
  else ctx.fillRect(edge ? 0 : size / 4, size / 4, size / 2, size / 2);
  return canvas.toBuffer("image/png");
};
const source = png(), framePNG = png(512, "#4160d1"), artHash = "a".repeat(64);
const idle = { id: "idle", name: "待机", duration: 1, loop: true, origin: "ai-analysis", poses: [0, 0.5, 1].map((time) => ({ time, angles: { root: 0, head: time === 0.5 ? 3 : 0 }, root: { x: 0, y: 0 }, ease: "smooth", feet: { left: false, right: false } })) };
const attack = { ...structuredClone(idle), id: "attack", name: "攻击", loop: false };
function rig() {
  return { version: 1, id: "mage", name: "法师", width: 256, height: 256,
    joints: [{ id: "root", label: "根", parent: null, x: 128, y: 210 }, { id: "head", label: "头", parent: "root", x: 128, y: 90 }],
    parts: [{ id: "body", label: "躯干", bone: "root", x: 70, y: 110, width: 100, height: 100, z: 0, binding: "mesh", influences: ["root", "head"], completion: "ready", imageSource: "ai" },
      { id: "head", label: "脸", bone: "head", x: 70, y: 60, width: 100, height: 60, z: 1, binding: "rigid", influences: ["head"], completion: "ready", imageSource: "ai" },
      ...["neutral", "hurt"].map((id) => ({ id: `mouth_${id}`, label: id, bone: "head", x: 110, y: 98, width: 30, height: 10, z: 2,
        binding: "rigid", influences: ["head"], completion: "ready", imageSource: "ai", attachmentGroup: "mouth" }))],
    defaultAttachments: { mouth: "mouth_neutral" }, motions: [structuredClone(idle), structuredClone(attack)] };
}
const frames = () => [{ id: "base", label: "起势", time: 0, reuseBase: true },
  ...[1, 2, 3].map((n) => ({ id: `attack_${n}`, label: `攻击${n}`, time: n / 4, prompt: `挥杖阶段${n}，保持角色衣服与身体比例` }))];
const request = () => ({ version: 1, kind: "motion-frames", projectId: "mage", name: "法师", planner: "codex-native", rig: rig(), motion: structuredClone(attack),
  image: { base64: source.toString("base64"), width: 256, height: 256 }, frames: frames(), concurrency: 3, originalArtworkFingerprint: artHash });
function mapping() {
  return { joints: [{ id: "root", x: 135, y: 205 }, { id: "head", x: 120, y: 85 }],
    parts: ["body", "head", "mouth_neutral"].map((partId, n) => ({ partId, visible: n !== 2,
      sourcePolygon: n === 2 ? null : [{ x: 64, y: 64 }, { x: 192, y: 64 }, { x: 192, y: 192 }, { x: 64, y: 192 }], z: n })), notes: "嘴部完全遮挡，未生成隐藏像素。" };
}
function mappingRequest(count = 2, unique = true) {
  return { ...request(), kind: "pose-mapping", frames: frames().slice(0, count).map(({ id, label, time }, index) => {
    const bytes = index && unique ? png(256, "#4160d1") : source;
    return { id, label, time, image: `data:image/png;base64,${bytes.toString("base64")}`, sourceFingerprint: sha(bytes) };
  }) };
}
async function fixture(t, { generate = async () => ({ result: framePNG.toString("base64"), model: "fixture-image" }), plan = async () => ({ value: mapping(), model: "fixture-planner" }), provider = { id: "codex-native", label: "Codex" } } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ispine-motion-study-service-"));
  const connections = { async snapshot(snapshot) { return snapshot || provider; }, async generate(selected, options) { return generate(selected, options); } };
  const service = new RigJobs({ root, rpc: {}, connections, plan }); await service.loading;
  t.after(async () => { await service.close(); await service.drainingPromise?.catch(() => {}); await rm(root, { recursive: true, force: true }); });
  return { service, root, connections };
}
async function finished(service, id) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const job = await service.get(id);
    if (["failed", "completed", "cancelled"].includes(job.status) && !service.draining) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("motion study test timed out");
}

test("action frames use the selected provider, bounded independent turns and immutable full-canvas identity", async (t) => {
  let calls = 0, active = 0, peak = 0;
  let releaseBatch, rejectBatch;
  const concurrentBatch = new Promise((resolve, reject) => { releaseBatch = resolve; rejectBatch = reject; });
  const watchdog = setTimeout(() => rejectBatch(new Error("Three independent image turns did not start concurrently")), 5000);
  t.after(() => clearTimeout(watchdog));
  const { service, root } = await fixture(t, { provider: { id: "openai-images", model: "explicit-api-model" }, generate: async (provider, options) => {
    calls++; active++; peak = Math.max(peak, active); assert.equal(provider.id, "openai-images");
    assert.equal(options.instructions, MOTION_FRAME_IMAGE_INSTRUCTIONS); assert.match(options.instructions, /exactly once/);
    assert.equal(options.references.length, 2); assert.deepEqual(await readFile(options.references[0]), source);
    assert.match(options.prompt, /REPLACE that expression/); assert.match(options.prompt, /Never use a smile/);
    assert.match(options.prompt, /leg thickness/); assert.match(options.prompt, /no zoom, crop, height-normalization/);
    if (calls === 3) { clearTimeout(watchdog); releaseBatch(); }
    await concurrentBatch; active--;
    return { result: framePNG.toString("base64"), model: "fixture-image" };
  } });
  const input = request(), frozen = JSON.stringify(input.rig);
  const done = await finished(service, (await service.create(input)).id);
  assert.equal(done.status, "completed"); assert.equal(done.kind, "motion-frames"); assert.equal(done.motionId, "attack");
  assert.equal(done.total, 4); assert.equal(done.completed, 4); assert.equal(calls, 3); assert.equal(peak, 3);
  assert.equal(done.baseFingerprint, sha(source)); assert.equal(done.geometryFingerprint, sha(JSON.stringify(rigGeometry(input.rig))));
  assert.equal(done.protectedIdleFingerprint, sha(JSON.stringify(idle))); assert.equal(done.originalArtworkFingerprint, artHash);
  assert.deepEqual(done.frames, frames().map((frame) => ({ ...frame, prompt: frame.prompt || "", reuseBase: frame.reuseBase === true })));
  assert.equal(JSON.stringify(input.rig), frozen); assert.deepEqual(done.result.images, done.images); assert.equal(done.images.length, 4);
  const base = done.images.find((image) => image.frameId === "base"), made = done.images.find((image) => image.frameId === "attack_1");
  assert.equal(base.aiGenerated, false); assert.equal(base.reusedBase, true); assert.equal(base.sourceFingerprint, sha(source));
  assert.deepEqual(await service.image(done.id, base.id), source); assert.equal(made.aiGenerated, true); assert.equal(made.rawWidth, 512);
  assert.equal(made.width, 256); assert.equal(made.normalization.scale, 0.5); assert.equal(made.normalization.offsetX, 0);
  assert.notEqual(made.sourceFingerprint, done.baseFingerprint); assert.equal(made.sourceFingerprint, sha(await service.image(done.id, made.id)));
  assert.equal(made.rawFingerprint, sha(framePNG)); assert.deepEqual(await service.image(done.id, made.raw.id), framePNG);
  const bitmap = await loadImage(await service.image(done.id, made.id)), canvas = createCanvas(256, 256); canvas.getContext("2d").drawImage(bitmap, 0, 0);
  assert.ok(canvas.getContext("2d").getImageData(64, 64, 1, 1).data[3] > 240, "full canvas uses expected coordinates without adding margins");
  assert.equal(await service.image(done.id, "../../source"), null);
  const manifest = JSON.parse(await readFile(join(root, done.id, "job.json"), "utf8")); assert.equal(manifest.request.rig.sourceImage, undefined);
  const restored = new RigJobs({ root, rpc: {}, connections: {} }); t.after(() => restored.close()); await restored.loading;
  assert.equal((await restored.get(done.id)).status, "completed"); assert.deepEqual(await restored.image(done.id, made.raw.id), framePNG);
});

test("motion study requests reject stale identities, protected idle, invalid maps and unsafe dimensions before generation", async (t) => {
  let calls = 0; const { service } = await fixture(t, { generate() { calls++; throw new Error("must not generate"); } });
  const invalid = [
    (input) => { input.projectId = "different"; }, (input) => { input.planner = "openai"; },
    (input) => { input.originalArtworkFingerprint = "invalid"; }, (input) => { input.baseFingerprint = "b".repeat(64); },
    (input) => { input.geometryFingerprint = "b".repeat(64); }, (input) => { input.protectedIdleFingerprint = "b".repeat(64); },
    (input) => { input.motion.id = "idle"; }, (input) => { input.motion.duration = 3; },
    (input) => { input.frames[1].id = "base"; }, (input) => { input.frames[1].time = 10; },
    (input) => { input.frames[1].time = input.frames[0].time; },
    (input) => { input.frames[1].prompt = ""; }, (input) => { input.frames[0].reuseBase = "yes"; },
    (input) => { input.frames = []; }, (input) => { input.frames = [...input.frames, ...input.frames]; },
    (input) => { input.concurrency = 4; }, (input) => { input.image.width = 1024; }, (input) => { delete input.image; },
  ];
  for (const alter of invalid) { const input = request(); alter(input); await assert.rejects(service.create(input)); }
  assert.equal(calls, 0); assert.equal(service.jobs.size, 0);
});

test("raw action alpha, full-body bounds and canvas ratio are checked before normalization can hide damage", async (t) => {
  const clear = createCanvas(512, 512), tall = createCanvas(256, 512); tall.getContext("2d").drawImage(await loadImage(source), 0, 0);
  for (const [bytes, message] of [[png(512, "#555", true), /真实透明/], [clear.toBuffer("image/png"), /完全透明/],
    [png(512, "#555", false, true), /截断/], [tall.toBuffer("image/png"), /画布比例/]]) {
    const { service } = await fixture(t, { generate: async () => ({ result: bytes.toString("base64") }) });
    const input = request(); input.frames = [input.frames[1]];
    const done = await finished(service, (await service.create(input)).id);
    assert.equal(done.status, "failed"); assert.match(done.error, message); assert.equal(done.images.length, 0); assert.equal(done.result, undefined);
  }
});

test("cancelling an action-frame batch aborts every in-flight turn and retry submits only unfinished fixed frame IDs", async (t) => {
  let started = 0, aborted = 0, allStarted; const ready = new Promise((resolve) => { allStarted = resolve; });
  const { service, connections } = await fixture(t, { generate: async (_provider, { signal }) => {
    started++; if (started === 3) allStarted();
    return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => { aborted++; reject(new DOMException("cancelled", "AbortError")); }, { once: true }); });
  } });
  const created = await service.create(request()); await ready; await service.cancel(created.id);
  const cancelled = await finished(service, created.id); assert.equal(cancelled.status, "cancelled"); assert.equal(aborted, 3);
  assert.equal(cancelled.completed, 1, "the genuine base copy remains available");
  const calls = [];
  connections.generate = async (provider, options) => { calls.push({ provider, prompt: options.prompt }); return { result: framePNG.toString("base64") }; };
  const retried = await finished(service, (await service.retry(created.id, { concurrency: 1 })).id);
  assert.equal(retried.status, "completed"); assert.equal(retried.parentJobId, created.id); assert.equal(calls.length, 3);
  assert.deepEqual(retried.frames.map((frame) => frame.id), ["attack_1", "attack_2", "attack_3"]);
  assert.equal(retried.originalArtworkFingerprint, artHash); assert.equal(retried.baseFingerprint, cancelled.baseFingerprint);
});

test("pose mapping uses reviewed per-frame pixels and grid guides without image generation, and returns complete immutable IDs", async (t) => {
  let plans = 0;
  const { service, root } = await fixture(t, { generate() { throw new Error("mapping cannot generate images"); }, plan: async (_rpc, options) => {
    plans++; assert.equal(options.references.length, 3); assert.deepEqual(await readFile(options.references[0]), source);
    assert.equal((await loadImage(await readFile(options.references[1]))).width, 256); assert.match(options.prompt, /not the unchanged standing positions/);
    assert.match(options.prompt, /not hidden-surface inpainting/); assert.match(options.prompt, /REQUIRED|Required/);
    assert.deepEqual(options.schema.properties.parts.items.properties.partId.enum, ["body", "head", "mouth_neutral"]);
    return { value: mapping(), model: "fixture-coordinate" };
  } });
  const input = mappingRequest(), done = await finished(service, (await service.create(input)).id);
  assert.equal(done.status, "completed"); assert.equal(done.provider.id, "codex-native"); assert.equal(plans, 2); assert.equal(done.completed, 2);
  assert.equal(done.images.length, 0); assert.equal(done.result.mappings.length, 2); assert.equal(done.result.motion, undefined);
  assert.deepEqual(done.result.mappings.map((frame) => frame.frameId), ["base", "attack_1"]);
  for (const item of done.result.mappings) {
    assert.equal(item.sourceFingerprint, input.frames.find((frame) => frame.id === item.frameId).sourceFingerprint); assert.deepEqual(item.joints, mapping().joints);
    assert.deepEqual(item.parts[2], { partId: "mouth_neutral", visible: false, z: 2 });
  }
  assert.equal(done.frames.some((frame) => Object.hasOwn(frame, "image") || Object.hasOwn(frame, "file")), false);
  const manifest = JSON.parse(await readFile(join(root, done.id, "job.json"), "utf8"));
  assert.equal(manifest.request.frames[0].file, "frame-0.png"); assert.equal(manifest.request.frames[0].image, undefined);
});

test("pose mapping rejects unknown, duplicated, missing, degenerate or forged invisible geometry", async (t) => {
  const alterations = [
    (answer) => { answer.joints[0].id = "foreign"; }, (answer) => { answer.joints[1].id = answer.joints[0].id; },
    (answer) => { answer.joints[0].x = -1; }, (answer) => { answer.joints.pop(); },
    (answer) => { answer.parts[0].partId = "mouth_hurt"; }, (answer) => { answer.parts[1].partId = answer.parts[0].partId; },
    (answer) => { answer.parts.pop(); }, (answer) => { answer.parts[0].sourcePolygon = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]; },
    (answer) => { answer.parts[0].sourcePolygon[0].x = 300; }, (answer) => { answer.parts[0].sourcePolygon = null; },
    (answer) => { answer.parts[2].sourcePolygon = answer.parts[0].sourcePolygon; },
    (answer) => { answer.parts[0].bone = "changed"; },
  ];
  for (const alter of alterations) {
    const { service } = await fixture(t, { plan: async () => { const value = mapping(); alter(value); return { value }; } });
    const done = await finished(service, (await service.create(mappingRequest(1))).id);
    assert.equal(done.status, "failed"); assert.equal(done.result, undefined); assert.equal(done.images.length, 0);
  }
  const { service } = await fixture(t);
  const stale = mappingRequest(); stale.frames[0].sourceFingerprint = "b".repeat(64); await assert.rejects(service.create(stale), /已改变/);
  const wrongSize = mappingRequest(); wrongSize.frames[0].image = `data:image/png;base64,${framePNG.toString("base64")}`; await assert.rejects(service.create(wrongSize), /完全一致/);
});

test("identical reviewed frame pixels reuse genuine coordinate analysis and retain truthful cache provenance", async (t) => {
  let calls = 0;
  const { service } = await fixture(t, { plan: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 10)); return { value: mapping() }; } });
  const done = await finished(service, (await service.create(mappingRequest(2, false))).id);
  assert.equal(done.status, "completed"); assert.equal(calls, 1);
  assert.deepEqual(done.result.mappings.map((frame) => frame.method), ["ai-analysis", "cached-frame-analysis"]);
  const reused = await finished(service, (await service.create(mappingRequest(1))).id);
  assert.equal(reused.status, "completed"); assert.equal(calls, 1);
  assert.equal(reused.result.mappings[0].method, "cached-frame-analysis"); assert.equal(reused.result.mappings[0].originalJobId, done.id);
  const changed = mappingRequest(1); changed.originalArtworkFingerprint = "b".repeat(64);
  const replanned = await finished(service, (await service.create(changed)).id);
  assert.equal(replanned.status, "completed"); assert.equal(calls, 2, "a different protected source artwork baseline cannot reuse the cached result");
});

test("failed coordinate batches retain successful per-frame results and retry only the unfinished frame", async (t) => {
  let calls = 0;
  const { service } = await fixture(t, { plan: async () => { calls++; if (calls === 2) throw new Error("本张需重新分析"); return { value: mapping() }; } });
  const input = mappingRequest(); input.concurrency = 1;
  const failed = await finished(service, (await service.create(input)).id);
  assert.equal(failed.status, "failed"); assert.equal(failed.completed, 1); assert.equal(failed.mappings.length, 1); assert.equal(failed.result, undefined);
  assert.equal(failed.mappings[0].frameId, "base");
  const retried = await finished(service, (await service.retry(failed.id)).id);
  assert.equal(retried.status, "completed"); assert.equal(retried.parentJobId, failed.id); assert.equal(calls, 3);
  assert.deepEqual(retried.frames.map((frame) => frame.id), ["attack_1"]); assert.equal(retried.mappings[0].frameId, "attack_1");
  assert.equal(retried.baseFingerprint, failed.baseFingerprint); assert.equal(retried.protectedIdleFingerprint, failed.protectedIdleFingerprint);
  assert.equal((await service.get(failed.id)).mappings[0].frameId, "base", "a retry does not discard previously reviewed work");
});

test("a single failed image turn aborts sibling turns without falling back to another provider", async (t) => {
  let starts = 0, aborts = 0, rejectFrame;
  const ready = new Promise((resolve) => { rejectFrame = resolve; });
  const { service } = await fixture(t, { generate: async (provider, { signal }) => {
    assert.equal(provider.id, "codex-native"); const n = starts++;
    if (starts === 3) rejectFrame();
    if (n === 0) { await ready; throw new Error("原生生图失败"); }
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborts++; reject(new DOMException("aborted", "AbortError")); }, { once: true }));
  } });
  const input = request(); input.frames = input.frames.slice(1);
  const done = await finished(service, (await service.create(input)).id);
  assert.equal(done.status, "failed"); assert.match(done.error, /原生生图失败/); assert.equal(starts, 3); assert.equal(aborts, 2);
  assert.equal(done.images.length, 0); assert.equal(done.result, undefined);
});

test("coordinate cancellation and server restart retain progress without resubmitting any image or planning turn", async (t) => {
  let calls = 0, aborted = 0, ready; const started = new Promise((resolve) => { ready = resolve; });
  const { service, root } = await fixture(t, { plan: async (_rpc, { signal }) => {
    if (++calls === 2) ready();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted++; reject(new DOMException("cancelled", "AbortError")); }, { once: true }));
  } });
  const input = mappingRequest(); input.concurrency = 2;
  const created = await service.create(input); await started; await service.cancel(created.id);
  assert.equal((await finished(service, created.id)).status, "cancelled"); assert.equal(aborted, 2);
  const saved = JSON.parse(await readFile(join(root, created.id, "job.json"), "utf8")); saved.status = "analyzing";
  await writeFile(join(root, created.id, "job.json"), JSON.stringify(saved));
  const restored = new RigJobs({ root, rpc: {}, connections: {}, plan() { throw new Error("must not resubmit"); } }); t.after(() => restored.close());
  await restored.loading; const recovered = await restored.get(created.id);
  assert.equal(recovered.kind, "pose-mapping"); assert.equal(recovered.status, "failed"); assert.match(recovered.error, /已重启/);
  assert.equal(recovered.motionId, "attack"); assert.equal(recovered.protectedIdleFingerprint, sha(JSON.stringify(idle))); assert.equal(calls, 2);
});

test("actual rig HTTP routes expose action frame candidates, raw PNGs and structured mappings with existing local request checks", async (t) => {
  const { service } = await fixture(t);
  const middleware = generationMiddleware({ rigJobs: service });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(origin + "/api/rig/jobs", { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(body) });
  const response = await post(request()); assert.equal(response.status, 202);
  const done = await finished(service, (await response.json()).id); assert.equal(done.status, "completed");
  const detail = await (await fetch(origin + `/api/rig/jobs/${done.id}`)).json(); assert.equal(detail.motionId, "attack"); assert.equal(detail.result.images.length, 4);
  const raw = await fetch(origin + detail.images[1].raw.url); assert.equal(raw.status, 200); assert.equal(raw.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), framePNG);
  const result = await post(mappingRequest()); assert.equal(result.status, 202);
  const mapped = await finished(service, (await result.json()).id); assert.equal(mapped.status, "completed");
  assert.equal((await (await fetch(origin + `/api/rig/jobs/${mapped.id}`)).json()).result.mappings.length, 2);
  assert.equal((await post({ ...request(), baseFingerprint: "b".repeat(64) })).status, 400);
  assert.equal((await post(request(), { origin: "https://untrusted.example" })).status, 403);
});

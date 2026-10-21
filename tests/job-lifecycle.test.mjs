import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createCanvas } from "@napi-rs/canvas";
import { GenerationJobs } from "../server/jobs/generation-service.mjs";
import { JobManifests } from "../server/jobs/manifests.mjs";
import { generateNativeImage } from "../server/infrastructure/codex-rpc.mjs";
import { generateStructured } from "../server/providers/codex-planning.mjs";
import { codexNativeProvider } from "../server/providers/codex-native.mjs";
import { codexPlanningProvider } from "../server/providers/codex-planning.mjs";
import { openAIImagesProvider } from "../server/providers/openai-images.mjs";
import { sub2apiImagesProvider } from "../server/providers/sub2api-images.mjs";
import { AIConnections } from "../server/ai/connections.mjs";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const canvas = createCanvas(64, 64); canvas.getContext("2d").fillRect(8, 8, 48, 48);
const png = canvas.toBuffer("image/png"), image = canvas.toDataURL("image/png");
function template(count = 1) {
  const parts = Array.from({ length: count }, (_, i) => ({ id: `part-${i}`, width: 16, height: 16 }));
  return { version: 1, projectId: "template", kind: "parts", prompt: "Test brief", concurrency: Math.min(count, 4),
    template: { id: "22", name: "Fixture", fingerprint: "a".repeat(64) }, parts,
    references: parts.map((part) => ({ role: "part", partId: part.id, base64: png.toString("base64") })) };
}
function rig(count = 4) {
  const parts = Array.from({ length: count }, (_, i) => ({ id: `part-${i}`, bone: "root", label: `Part ${i}`, x: 8, y: 8, width: 16, height: 16, z: i, binding: "rigid", influences: ["root"] }));
  return { version: 1, projectId: "rig", kind: "parts", prompt: "Test brief", concurrency: 4, partIds: parts.map((part) => part.id),
    rig: { version: 1, id: "rig", name: "Fixture", width: 64, height: 64, sourceImage: image,
      joints: [{ id: "root", parent: null, x: 32, y: 32 }], parts, motions: [] } };
}
async function fixture(t, { generate, snapshot } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ispine-job-lifecycle-")), closed = [];
  const connections = { ready: Promise.resolve(), snapshot: snapshot || (async () => ({ id: "codex-native", label: "Fixture" })), generate,
    close() { closed.push("connections"); } };
  const rpc = { close() { closed.push("rpc"); } }, jobs = new GenerationJobs({ root, connections, rpc });
  t.after(async () => { await jobs.close(); await rm(root, { recursive: true, force: true }); });
  await jobs.loading; return { root, jobs, closed };
}

test("close aborts every template turn, waits for their cleanup and durable manifests, then closes shared connections", async (t) => {
  const entered = deferred(), release = deferred(), signals = []; let finished = false;
  t.after(() => release.resolve());
  const { jobs, root, closed } = await fixture(t, { generate: async (_selection, { signal }) => {
    signals.push(signal); if (signals.length === 3) entered.resolve();
    await release.promise; signal.throwIfAborted(); return { result: png.toString("base64") };
  } });
  jobs.draining = true; const created = await jobs.create(template(3)); jobs.draining = false;
  const draining = jobs.drain(); assert.equal(jobs.drainingPromise, draining); await entered.promise;
  const closing = jobs.close(); assert.equal(jobs.close(), closing); void closing.then(() => { finished = true; });
  assert.ok(signals.every((signal) => signal.aborted)); await Promise.resolve(); assert.equal(finished, false); assert.deepEqual(closed, []);
  release.resolve(); await closing;
  const manifest = JSON.parse(await readFile(join(root, created.id, "job.json"), "utf8"));
  assert.equal(manifest.status, "failed"); assert.deepEqual(manifest.images, []); assert.equal(manifest.controller, undefined);
  assert.equal(jobs.writes.size, 0); assert.deepEqual(closed, ["connections", "rpc"]);
  await assert.rejects(jobs.create(template()), /已关闭/);
});

test("template and rig retain independent four-turn budgets and one close drains all eight requests", async (t) => {
  const entered = deferred(), signals = [];
  const { jobs } = await fixture(t, { generate: async (_selection, { signal }) => {
    signals.push(signal); if (signals.length === 8) entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }));
  } });
  await Promise.all([jobs.create(template(4)), jobs.rigJobs.create(rig())]);
  await entered.promise; await jobs.close(); assert.equal(signals.length, 8); assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(jobs.writes.size, 0); assert.equal(jobs.rigJobs.writes.size, 0);
  assert.equal([...jobs.jobs.values()][0].status, "failed"); assert.equal([...jobs.rigJobs.jobs.values()][0].status, "failed");
});

test("close owns in-flight admission and concurrent same-project creates cannot race through provider selection", async (t) => {
  const selected = deferred(), release = deferred();
  t.after(() => release.resolve());
  const { jobs, closed } = await fixture(t, { snapshot: async () => { selected.resolve(); await release.promise; return { id: "codex-native" }; } });
  const creating = assert.rejects(jobs.create(template()), /已关闭/); await selected.promise;
  await assert.rejects(jobs.create(template()), /已有进行中/);
  let finished = false; const closing = jobs.close().then(() => { finished = true; }); await Promise.resolve();
  assert.equal(finished, false); assert.deepEqual(closed, []); release.resolve(); await creating; await closing;
  assert.equal(jobs.jobs.size, 0); assert.equal(jobs.queue.admissions.size, 0);
});

test("atomic per-job manifests keep the old file on write failure, recover explicitly, and flush the last concurrent snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ispine-manifest-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JobManifests(root), id = randomUUID(), job = { id, status: "queued", images: [], controller: new AbortController() };
  await store.save(job); const path = join(root, id, "job.json"), original = await readFile(path);
  await mkdir(join(root, id, "job.json.tmp")); job.status = "generating";
  await assert.rejects(store.save(job)); assert.deepEqual(await readFile(path), original); await assert.rejects(store.flush(), AggregateError);
  await rm(join(root, id, "job.json.tmp"), { recursive: true });
  const one = store.save(job); job.status = "completed"; job.images.push({ id: "image-0" }); const two = store.save(job);
  await Promise.all([one, two]); await store.flush(); const result = JSON.parse(await readFile(path, "utf8"));
  assert.equal(result.status, "completed"); assert.equal(result.images.length, 1); assert.equal(result.controller, undefined);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await store.load())[0].status, "completed"); assert.equal(store.writes.size, 0);
});

test("an initial manifest failure cannot be picked up by another project's drain or start an unacknowledged image turn", async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve()); let turns = 0;
  const { jobs } = await fixture(t, { generate: async () => { turns++; return { result: png.toString("base64") }; } });
  const save = jobs.manifests.save.bind(jobs.manifests);
  jobs.manifests.save = async (job) => {
    if (job.request.projectId === "template") { entered.resolve(); await release.promise; throw new Error("Initial manifest failed"); }
    return save(job);
  };
  const failed = assert.rejects(jobs.create(template()), /Initial manifest failed/); await entered.promise;
  const accepted = await jobs.create({ ...template(), projectId: "other" }); await jobs.drainingPromise;
  assert.equal((await jobs.get(accepted.id)).status, "completed"); assert.equal(turns, 1);
  release.resolve(); await failed; await jobs.close(); assert.equal(jobs.jobs.size, 1); assert.equal(turns, 1);
});

test("image providers and Codex planning expose distinct capabilities and cannot substitute for each other", async () => {
  const forbidden = () => assert.fail("No account or network request is permitted"), rpc = {};
  for (const adapter of [codexNativeProvider(rpc, forbidden), openAIImagesProvider(forbidden), sub2apiImagesProvider(forbidden)]) assert.deepEqual(adapter.capabilities, ["image"]);
  let calls = 0; const planner = codexPlanningProvider(rpc, async (actual, options) => { assert.equal(actual, rpc); calls++; return { value: options.schema }; });
  assert.deepEqual(planner.capabilities, ["planning"]); assert.throws(() => planner.snapshot("sub2api"), /明确选择/);
  assert.throws(() => planner.generate({ id: "codex-native", capability: "image" }, {}), /身份无效/);
  assert.deepEqual((await planner.generate(planner.snapshot("codex-native"), { schema: { type: "object" } })).value, { type: "object" }); assert.equal(calls, 1);
  assert.throws(() => new AIConnections({ root: "/unused", providers: [planner] }), /不支持 image/);
});

test("native cancellation while turn start is pending interrupts every late turn and releases its listeners", async () => {
  class RPC extends EventEmitter {
    constructor() { super(); this.starts = []; this.interrupts = []; this.unsubscribed = []; }
    async start() {}
    async request(method, parameters) {
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "thread/start") return { thread: { id: randomUUID() }, model: "fixture" };
      if (method === "turn/start") { const gate = deferred(); this.starts.push({ parameters, gate }); return gate.promise; }
      if (method === "turn/interrupt") this.interrupts.push(parameters);
      if (method === "thread/unsubscribe") this.unsubscribed.push(parameters.threadId);
      return {};
    }
  }
  const rpc = new RPC(), controllers = Array.from({ length: 3 }, () => new AbortController());
  const pending = Promise.allSettled(controllers.map((controller) => generateNativeImage(rpc, { cwd: "/tmp", prompt: "Fixture", references: [], signal: controller.signal })));
  while (rpc.starts.length !== 3) await new Promise((resolve) => setImmediate(resolve));
  controllers.forEach((controller) => controller.abort()); rpc.starts.forEach(({ gate }, i) => gate.resolve({ turn: { id: `turn-${i}` } }));
  const results = await pending; assert.ok(results.every((result) => result.status === "rejected" && result.reason.name === "AbortError"));
  assert.equal(new Set(rpc.interrupts.map((turn) => turn.threadId)).size, 3); assert.equal(new Set(rpc.unsubscribed).size, 3);
  assert.equal(rpc.listenerCount("notification"), 0); assert.equal(rpc.listenerCount("disconnected"), 0);
});

test("image and planning handlers await interrupt and unsubscribe responses before releasing their RPC ownership", async () => {
  for (const generate of [generateNativeImage, generateStructured]) {
    const started = deferred(), interrupted = deferred(), interruptReply = deferred(), unsubscribed = deferred(), unsubscribeReply = deferred();
    const rpc = new EventEmitter(); rpc.start = async () => {};
    rpc.request = async (method) => {
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "thread/start") return { thread: { id: "owned-thread" } };
      if (method === "turn/start") { started.resolve(); return { turn: { id: "owned-turn" } }; }
      if (method === "turn/interrupt") { interrupted.resolve(); return interruptReply.promise; }
      if (method === "thread/unsubscribe") { unsubscribed.resolve(); return unsubscribeReply.promise; }
    };
    const controller = new AbortController(); let finished = false;
    const rejected = assert.rejects(generate(rpc, { cwd: "/tmp", prompt: "Fixture", references: [], schema: {}, signal: controller.signal }), { name: "AbortError" }).then(() => { finished = true; });
    await started.promise; controller.abort(); await interrupted.promise; assert.equal(finished, false);
    interruptReply.resolve({}); await unsubscribed.promise; assert.equal(finished, false); unsubscribeReply.resolve({}); await rejected;
    assert.equal(rpc.listenerCount("notification"), 0); assert.equal(rpc.listenerCount("disconnected"), 0);
  }
});

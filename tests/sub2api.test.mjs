import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { createCanvas } from "@napi-rs/canvas";
import { sub2apiImagesProvider, sub2apiSettings } from "../server/providers/sub2api-images.mjs";
import { AIConnections } from "../server/ai-connections.mjs";
import { GenerationJobs } from "../server/generation-service.mjs";
import { generationMiddleware } from "../server/generation-plugin.mjs";
import { createLocalGenerationProvider, prepareGenerationRequest, applyGeneratedParts } from "../src/core/generation.js";
import { exportPackage, unpackZip, parseBundle } from "../src/core/archive.js";
import { compilePages } from "../src/core/pixels.js";
import { pixelEnv, synthetic } from "./helpers.mjs";

const KEY = "sk-sub2api-fixture-only", MODEL = "gpt-image-2.5-sunburst", BASE = "https://gateway.example/v1";
const canvas = createCanvas(32, 32), context = canvas.getContext("2d");
context.fillStyle = "#753cc5"; context.fillRect(6, 8, 20, 16);
const png = canvas.toBuffer("image/png"), encoded = png.toString("base64");
const settings = { baseUrl: BASE, protocol: "images", key: KEY, model: MODEL };
const models = () => Response.json({ data: [{ id: MODEL }, { id: "private-image-model" }] });
function rpc() { const value = new EventEmitter(); value.start = async () => {}; value.close = () => {}; value.request = async () => { throw new Error("Codex must not be used"); }; return value; }
async function temp(t) { const root = await mkdtemp(join(tmpdir(), "ispine-sub2api-test-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function settle(jobs, id) {
  for (let step = 0; step < 300; step++) {
    const value = await jobs.get(id);
    if (["completed", "failed", "cancelled"].includes(value.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Sub2API job did not finish");
}

test("Sub2API accepts explicit HTTPS and loopback endpoints and normalizes both protocols", () => {
  assert.deepEqual(sub2apiSettings({ baseUrl: "https://gateway.example/prefix/" }), { baseUrl: "https://gateway.example/prefix/v1", protocol: "images" });
  assert.equal(sub2apiSettings({ baseUrl: "http://127.0.0.1:18080/v1/" }).baseUrl, "http://127.0.0.1:18080/v1");
  assert.equal(sub2apiSettings({ baseUrl: "https://gateway.example/antigravity/v1beta", protocol: "gemini" }).baseUrl, "https://gateway.example/antigravity/v1beta");
  assert.equal(sub2apiSettings({ baseUrl: BASE, protocol: "gemini" }).baseUrl, "https://gateway.example/v1beta");
  for (const baseUrl of ["", "gateway.example", "http://gateway.example", "https://user:secret@gateway.example", "https://gateway.example?key=secret", "https://gateway.example/#token", "https://gateway.example/v1/images/generations", "file:///tmp/gateway"])
    assert.throws(() => sub2apiSettings({ baseUrl }));
  assert.throws(() => sub2apiSettings({ baseUrl: BASE, protocol: "unknown" }), /图片接口/);
});

test("connection validation reads the gateway model directory without generating an image", async () => {
  const calls = [], adapter = sub2apiImagesProvider(async (url, init) => { calls.push({ url, init }); return models(); });
  assert.equal((await adapter.status(settings)).connected, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, BASE + "/models");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`); assert.equal(calls[0].init.redirect, "error");
  await assert.rejects(adapter.status({ ...settings, model: "missing" }), /模型目录/);
  assert.equal((await adapter.status({ ...settings, key: "" })).connected, false);
});

test("OpenAI Images generation and multi-reference editing preserve input order and request transparency", async (t) => {
  const file = join(await temp(t), "reference.png"); await writeFile(file, png);
  const calls = [], adapter = sub2apiImagesProvider(async (url, init) => { calls.push({ url, init }); return Response.json({ data: [{ b64_json: encoded }] }); });
  assert.equal((await adapter.generate(settings, { prompt: "purple character" })).result, encoded);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, BASE + "/images/generations"); assert.equal(body.n, 1);
  assert.equal(body.background, "transparent"); assert.equal(body.response_format, "b64_json");
  await adapter.generate(settings, { prompt: "change the detached part", references: [file, file] });
  assert.equal(calls[1].url, BASE + "/images/edits");
  const form = calls[1].init.body;
  assert.equal(form.getAll("image[]").length, 2); assert.equal(form.get("model"), MODEL);
  assert.deepEqual(Buffer.from(await form.getAll("image[]")[0].arrayBuffer()), png);
  assert.equal(form.get("background"), "transparent"); assert.equal(calls[1].init.headers["Content-Type"], undefined);
});

test("Gemini uses its native image protocol and preserves all reference pixels", async (t) => {
  const file = join(await temp(t), "reference.png"); await writeFile(file, png);
  const calls = [], model = "gemini-3.1-flash-image";
  const adapter = sub2apiImagesProvider(async (url, init) => {
    calls.push({ url, init });
    return url.endsWith("/models") ? Response.json({ models: [{ name: `models/${model}` }] })
      : Response.json({ candidates: [{ content: { parts: [{ text: "image" }, { inlineData: { mimeType: "image/png", data: encoded } }] } }] });
  });
  const config = { ...settings, baseUrl: "https://gateway.example/antigravity/v1beta", protocol: "gemini", model };
  assert.equal((await adapter.status(config)).connected, true);
  assert.equal((await adapter.generate(config, { prompt: "transparent detached sleeve", references: [file, file] })).result, encoded);
  assert.equal(calls[1].url, config.baseUrl + `/models/${model}:generateContent`);
  const body = JSON.parse(calls[1].init.body);
  assert.deepEqual(body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
  assert.deepEqual(body.contents[0].parts.slice(0, 2).map((part) => part.inlineData.data), [encoded, encoded]);
  assert.equal(body.contents[0].parts[2].text, "transparent detached sleeve");
});

test("same-origin image URLs are downloaded without credentials and external URLs are rejected", async () => {
  const calls = [], adapter = sub2apiImagesProvider(async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? Response.json({ data: [{ url: "/files/generated.png" }] }) : new Response(png, { headers: { "Content-Type": "image/png" } });
  });
  assert.equal((await adapter.generate(settings, { prompt: "purple" })).result, encoded);
  assert.equal(calls[1].url, "https://gateway.example/files/generated.png");
  assert.equal(calls[1].init.headers, undefined); assert.equal(calls[1].init.redirect, "error");
  const external = sub2apiImagesProvider(async () => Response.json({ data: [{ url: "http://127.0.0.1:4175/private" }] }));
  await assert.rejects(external.generate(settings, { prompt: "purple" }), /外部图片地址/);
});

test("gateway failures, malformed images, oversize responses and cancellation remain explicit", async () => {
  for (const status of [401, 402, 403, 404, 429, 500]) {
    const adapter = sub2apiImagesProvider(async () => Response.json({ error: KEY }, { status }));
    await assert.rejects(adapter.generate(settings, { prompt: "purple" }), (error) => error.message.includes("Sub2API") && !error.message.includes(KEY));
  }
  for (const value of [{ data: [] }, { data: [{ b64_json: "not an image" }] }, { candidates: [] }]) {
    const adapter = sub2apiImagesProvider(async () => Response.json(value));
    await assert.rejects(adapter.generate(settings, { prompt: "purple" }));
  }
  const oversize = sub2apiImagesProvider(async () => new Response("{}", { headers: { "Content-Length": String(30 * 1024 * 1024) } }));
  await assert.rejects(oversize.generate(settings, { prompt: "purple" }), /超过/);
  const controller = new AbortController(); controller.abort();
  const cancelled = sub2apiImagesProvider(() => { throw new Error("must not start a cancelled request"); });
  await assert.rejects(cancelled.generate(settings, { prompt: "purple", signal: controller.signal }), { name: "AbortError" });
});

test("Sub2API settings persist without plaintext keys, restore locked, and bind retries to the original gateway", async (t) => {
  const root = await temp(t), calls = [], access = { available: 0, decrypt: 0, encrypt: 0 };
  const protection = { isAvailable() { access.available++; return true; }, encrypt() { access.encrypt++; return Buffer.from("protected-fixture"); }, decrypt() { access.decrypt++; return KEY; } };
  const options = { root, rpc: rpc(), protection, fetcher: async (url) => { calls.push(url); return models(); } };
  const connection = new AIConnections(options); t.after(() => connection.close());
  await connection.configure({ provider: "sub2api", apiKey: KEY, baseUrl: BASE, model: "private-image-model", remember: true });
  const selected = await connection.snapshot(); assert.equal(selected.baseUrl, BASE); assert.equal(selected.model, "private-image-model");
  const saved = await readFile(join(root, "connection.json"), "utf8"); assert.ok(!saved.includes(KEY));
  const restored = new AIConnections(options); t.after(() => restored.close());
  const before = calls.length, beforeAccess = { ...access }, info = await restored.info();
  assert.equal(info.providers.find((item) => item.id === "sub2api").needsUnlock, true);
  assert.equal(calls.length, before); assert.deepEqual(access, beforeAccess);
  await restored.configure({ provider: "sub2api", remember: true }); assert.equal(access.decrypt, 1);
  await assert.rejects(restored.configure({ provider: "sub2api", baseUrl: "https://another.example/v1" }), /重新填写网关密钥/);
  assert.equal(await readFile(join(root, "connection.json"), "utf8"), saved);
  await restored.configure({ provider: "sub2api", baseUrl: "https://another.example/v1", apiKey: KEY, remember: false });
  const changedAt = calls.length;
  await assert.rejects(restored.snapshot(selected), /原任务/);
  await assert.rejects(restored.generate(selected, { prompt: "purple" }), /原任务/);
  assert.equal(calls.length, changedAt, "a changed gateway cannot receive a retry or a previous gateway's key");
});

test("Sub2API runs through the real local HTTP workflow, candidate application and editable export", async (t) => {
  const root = await temp(t), requests = [];
  const jobs = new GenerationJobs({ root: join(root, "jobs"), rpc: rpc(), generate() { throw new Error("unexpected Codex fallback"); }, fetcher: async (url, init) => {
    requests.push({ url, init }); return url.endsWith("/models") ? models() : Response.json({ data: [{ b64_json: encoded }] });
  } });
  const middleware = generationMiddleware(jobs), server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => { jobs.close(); await jobs.drainingPromise?.catch(() => {}); server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = createLocalGenerationProvider((path, init = {}) => fetch(origin + path, { ...init, headers: { ...init.headers, Origin: origin } }));
  await client.configure({ provider: "sub2api", baseUrl: BASE, apiKey: KEY, model: MODEL, remember: false });
  const bundle = synthetic(), request = await prepareGenerationRequest(bundle, { projectId: "sub2api-roundtrip", prompt: "purple jade", partIds: ["part"] }, pixelEnv);
  const result = await settle(jobs, (await client.start(request)).id);
  assert.equal(result.status, "completed"); assert.equal(result.provider.id, "sub2api"); assert.equal(result.provider.baseUrl, BASE);
  assert.equal(result.images[0].provider, "sub2api"); assert.ok(!JSON.stringify(result).includes(KEY));
  const bytes = await client.image(result.id, result.images[0].id);
  const edits = await applyGeneratedParts(bundle, {}, result, [{ partId: "part", bytes }], pixelEnv);
  const pages = await compilePages(bundle, edits, pixelEnv), zip = exportPackage(bundle, pages, { editable: true, edits });
  const reopened = parseBundle(unpackZip(zip));
  assert.deepEqual(reopened.edits.part.image, edits.part.image); assert.deepEqual(reopened.files[bundle.skeletonPath], bundle.files[bundle.skeletonPath]);
  assert.ok(!Buffer.from(zip).includes(Buffer.from(KEY)));
  assert.ok(!(await readFile(join(root, "jobs", result.id, "job.json"), "utf8")).includes(KEY));
  assert.equal(requests.at(-1).url, BASE + "/images/edits");
});

test("failed gateway replacement preserves the old encrypted key, address and selection", async (t) => {
  const root = await temp(t); let reject = false;
  const connection = new AIConnections({ root, rpc: rpc(), protection: { encrypt: () => Buffer.from("encrypted-fixture"), decrypt: () => KEY },
    fetcher: async () => reject ? Response.json({ error: "untrusted gateway failure" }, { status: 401 }) : models() });
  t.after(() => connection.close());
  await connection.configure({ provider: "sub2api", apiKey: KEY, model: MODEL, baseUrl: BASE });
  const original = await readFile(join(root, "connection.json"), "utf8"); reject = true;
  await assert.rejects(connection.configure({ provider: "sub2api", apiKey: "sk-replacement-fixture", model: MODEL, baseUrl: "https://replacement.example/v1" }), /网关密钥无效/);
  assert.equal(await readFile(join(root, "connection.json"), "utf8"), original);
  assert.equal((await connection.snapshot()).baseUrl, BASE);
  assert.equal(connection.settings("sub2api").key, KEY);
});

test("an opaque gateway image cannot pass as a completed transparent candidate", async (t) => {
  const opaque = createCanvas(32, 32); opaque.getContext("2d").fillRect(0, 0, 32, 32);
  const jobs = new GenerationJobs({ root: await temp(t), rpc: rpc(), fetcher: async (url) => url.endsWith("/models") ? models()
    : Response.json({ data: [{ b64_json: opaque.toBuffer("image/png").toString("base64") }] }) });
  t.after(async () => { jobs.close(); await jobs.drainingPromise?.catch(() => {}); });
  await jobs.connections.configure({ provider: "sub2api", apiKey: KEY, model: MODEL, baseUrl: BASE, remember: false });
  const result = await settle(jobs, (await jobs.create({ version: 1, kind: "appearance", projectId: "opaque-gateway-check", prompt: "transparent test",
    template: { fingerprint: "a".repeat(64) }, parts: [], references: [] })).id);
  assert.equal(result.status, "failed"); assert.match(result.error, /透明背景/); assert.deepEqual(result.images, []);
});

test("Sub2API cancels every concurrent part request without switching providers", async (t) => {
  const signals = [], jobs = new GenerationJobs({ root: await temp(t), rpc: rpc(), generate() { throw new Error("unexpected native fallback"); }, fetcher: async (url, init) => {
    if (url.endsWith("/models")) return models();
    signals.push(init.signal);
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  } });
  t.after(async () => { jobs.close(); await jobs.drainingPromise?.catch(() => {}); });
  await jobs.connections.configure({ provider: "sub2api", baseUrl: BASE, apiKey: KEY, model: MODEL, remember: false });
  const parts = ["hand", "arm", "belt"].map((id) => ({ id, width: 32, height: 32 }));
  const created = await jobs.create({ version: 1, kind: "parts", projectId: "sub2api-cancel", prompt: "purple", concurrency: 3,
    template: { fingerprint: "a".repeat(64) }, parts, references: parts.map((part) => ({ role: "part", partId: part.id, base64: encoded })) });
  for (let i = 0; i < 100 && signals.length < 3; i++) await new Promise((done) => setTimeout(done, 5));
  assert.equal(signals.length, 3);
  await assert.rejects(jobs.connections.configure({ provider: "codex-native" }), /结束|取消/);
  await jobs.cancel(created.id); await jobs.drainingPromise;
  assert.ok(signals.every((signal) => signal.aborted)); assert.equal((await jobs.get(created.id)).status, "cancelled");
  assert.equal((await jobs.connections.info()).selected, "sub2api");
});

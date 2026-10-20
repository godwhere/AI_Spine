import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createCanvas } from "@napi-rs/canvas";
import { AIConnections } from "../server/ai-connections.mjs";
import { GenerationJobs } from "../server/generation-service.mjs";
import { generationMiddleware } from "../server/generation-plugin.mjs";
import { openAIImagesProvider } from "../server/providers/openai-images.mjs";
import { codexNativeProvider } from "../server/providers/codex-native.mjs";
import { createLocalGenerationProvider, prepareGenerationRequest, applyGeneratedParts } from "../src/core/generation.js";
import { exportPackage, unpackZip, parseBundle } from "../src/core/archive.js";
import { compilePages } from "../src/core/pixels.js";
import { synthetic, pixelEnv } from "./helpers.mjs";

const API_KEY = "sk-ispine-test-fixture-only", MODEL = "gpt-image-2.5-sunburst";
const canvas = createCanvas(32, 32), context = canvas.getContext("2d");
context.fillStyle = "#31acdc"; context.fillRect(6, 8, 20, 16);
const png = canvas.toBuffer("image/png");
const protection = (() => {
  const secret = randomBytes(32);
  return {
    encrypt(value) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, iv); const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decrypt(value) { const cipher = createDecipheriv("aes-256-gcm", secret, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8"); },
  };
})();
function rpcStub() {
  const rpc = new EventEmitter(); rpc.start = async () => {}; rpc.close = () => {};
  rpc.request = async (method) => method === "account/read" ? { account: { type: "chatgpt", email: "private@example.test" } }
    : { loginId: "test-login", authUrl: "https://auth.openai.com/authorize?state=test" };
  return rpc;
}
async function temp(t) { const root = await mkdtemp(join(tmpdir(), "ispine-ai-connection-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function trackedProtection(overrides = {}) {
  const calls = { available: 0, encrypt: 0, decrypt: 0 };
  return { calls, storage: {
    isAvailable() { calls.available++; return overrides.isAvailable ? overrides.isAvailable() : true; },
    encrypt(value) { calls.encrypt++; return (overrides.encrypt || protection.encrypt)(value); },
    decrypt(value) { calls.decrypt++; return (overrides.decrypt || protection.decrypt)(value); },
  } };
}
async function savedConnection(root, selected = "codex-native") {
  await mkdir(root, { recursive: true });
  const encryptedKey = protection.encrypt(API_KEY).toString("base64");
  const config = { selected, profiles: { openai: { model: MODEL, encryptedKey } } };
  await writeFile(join(root, "connection.json"), JSON.stringify(config), { mode: 0o600 });
  return config;
}
const modelResponse = () => Response.json({ id: MODEL });
async function settled(jobs, id) {
  for (let step = 0; step < 300; step++) {
    const value = await jobs.get(id);
    if (["completed", "failed", "cancelled"].includes(value.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not finish");
}

test("Codex is the default connection and public settings never contain account credentials", async (t) => {
  const connections = new AIConnections({ root: await temp(t), rpc: rpcStub(), generateNative() {}, fetcher() { throw new Error("unexpected API request"); } });
  t.after(() => connections.close());
  const info = await connections.info();
  assert.equal(info.selected, "codex-native"); assert.equal(info.status.connected, true);
  assert.equal(info.providers.length, 3); assert.equal(info.providers[1].keyConfigured, false);
  assert.ok(!JSON.stringify(info).includes("private@"));
});
test("API keys persist as protected ciphertext and remain locked after restart", async (t) => {
  const root = await temp(t), calls = [];
  const options = { root, rpc: rpcStub(), protection, generateNative() {}, fetcher: async (url, init) => { calls.push({ url, init }); return modelResponse(); } };
  const connections = new AIConnections(options); t.after(() => connections.close());
  const result = await connections.configure({ provider: "openai", apiKey: API_KEY, model: MODEL, remember: true });
  assert.equal(calls.length, 1); assert.match(calls[0].url, /\/models\/gpt-image-2.5-sunburst$/);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(result.status.connected, true); assert.equal(result.providers[1].keySaved, true);
  assert.ok(!JSON.stringify(result).includes(API_KEY));
  const file = await readFile(join(root, "connection.json"), "utf8");
  assert.ok(!file.includes(API_KEY)); assert.equal((await stat(join(root, "connection.json"))).mode & 0o777, 0o600);
  const restored = new AIConnections(options); t.after(() => restored.close());
  const restoredInfo = await restored.info();
  assert.equal(restoredInfo.providers[1].keyConfigured, true); assert.equal(restoredInfo.providers[1].needsUnlock, true);
  assert.equal(restoredInfo.status.connected, false); assert.match(restoredInfo.status.message, /保存并验证连接/);
  await restored.forget("openai");
  assert.equal((await restored.status()).connected, false);
  assert.equal((await restored.info()).selected, "openai", "removing a key does not switch services");
  assert.ok(!JSON.parse(await readFile(join(root, "connection.json"), "utf8")).profiles.openai.encryptedKey);
});
test("without secure storage an API key is session-only and cannot become a plaintext fallback", async (t) => {
  const options = { root: await temp(t), rpc: rpcStub(), generateNative() {}, fetcher: async () => modelResponse() };
  const connections = new AIConnections(options); t.after(() => connections.close());
  const result = await connections.configure({ provider: "openai", apiKey: API_KEY, model: MODEL, remember: true });
  assert.equal(result.secureStorage, false); assert.equal(result.providers[1].keyConfigured, true); assert.equal(result.providers[1].keySaved, false);
  assert.ok(!JSON.stringify(await readFile(join(options.root, "connection.json"), "utf8")).includes(API_KEY));
  const restarted = new AIConnections(options); t.after(() => restarted.close());
  assert.equal((await restarted.status()).connected, false); await assert.rejects(restarted.snapshot(), /API Key/);
});
test("invalid credentials and unsupported models leave the selected connection unchanged", async (t) => {
  const root = await temp(t);
  const connections = new AIConnections({ root, rpc: rpcStub(), generateNative() {}, fetcher: async () => Response.json({ error: API_KEY }, { status: 401 }) });
  t.after(() => connections.close());
  await assert.rejects(connections.configure({ provider: "openai", apiKey: API_KEY, model: MODEL }), /API Key 无效/);
  await assert.rejects(connections.configure({ provider: "openai", apiKey: API_KEY, model: "not-an-image-model" }), /受支持/);
  await assert.rejects(connections.configure({ provider: "unknown" }), /不支持/);
  assert.equal((await connections.info()).selected, "codex-native");
  await assert.rejects(readFile(join(root, "connection.json")), { code: "ENOENT" });
});
test("official Codex login returns only a validated browser URL and rejects foreign redirects", async () => {
  const rpc = rpcStub(), adapter = codexNativeProvider(rpc, () => {});
  assert.equal((await adapter.login()).authUrl, "https://auth.openai.com/authorize?state=test");
  rpc.request = async () => ({ loginId: "test", authUrl: "https://foreign.example/credentials" });
  await assert.rejects(adapter.login(), /有效的官方登录页面/);
});
test("the registry accepts another image provider without changing generation job contracts", async (t) => {
  const provider = { id: "future-ai", label: "Future AI", auth: "api-key", models: ["test-image"],
    status: async ({ key }) => ({ connected: key === API_KEY, message: "test connection" }),
    generate: async (_settings, options) => ({ result: options.prompt, model: "test-image" }) };
  const connections = new AIConnections({ root: await temp(t), providers: [provider] }); t.after(() => connections.close());
  await connections.configure({ provider: provider.id, apiKey: API_KEY, model: "test-image", remember: false });
  const selection = await connections.snapshot(); assert.equal(selection.id, "future-ai");
  assert.equal((await connections.generate(selection, { prompt: "unchanged job input" })).result, "unchanged job input");
});
test("provider errors cannot echo API keys into connection responses or job failures", async (t) => {
  let failStatus = false;
  const provider = { id: "future-ai", label: "Future AI", auth: "api-key", models: ["test-image"],
    async status({ key }) { if (failStatus) throw new Error(`invalid ${key}`); return { connected: true }; },
    async generate({ key }) { throw new Error(`request failed for ${key}`); } };
  const connections = new AIConnections({ root: await temp(t), providers: [provider] }); t.after(() => connections.close());
  await connections.configure({ provider: provider.id, apiKey: API_KEY, model: "test-image" });
  const safe = (error) => !error.message.includes(API_KEY) && error.message.includes("[已隐藏]");
  await assert.rejects(connections.generate(await connections.snapshot(), {}), safe);
  failStatus = true;
  await assert.rejects(connections.configure({ provider: provider.id, apiKey: API_KEY, model: "test-image" }), safe);
});
test("API generation passes real references through jobs, mapping, calibration, and export without credential leakage", async (t) => {
  const root = await temp(t), seen = []; let nativeCalls = 0, failNext = false;
  const jobs = new GenerationJobs({ root: join(root, "jobs"), rpc: rpcStub(), generate: async () => { nativeCalls++; throw new Error("unexpected native fallback"); },
    fetcher: async (url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
      if (url.includes("/models/")) return modelResponse();
      assert.equal(url, "https://api.openai.com/v1/images/edits");
      const form = init.body;
      assert.equal(form.get("background"), "transparent"); assert.equal(form.get("output_format"), "png"); assert.equal(form.get("n"), "1");
      assert.equal(form.get("model"), MODEL); assert.ok(form.getAll("image[]").length > 0);
      assert.ok(form.getAll("image[]").every((file) => file.type === "image/png" && file.size > 0));
      assert.ok(!form.get("prompt").includes("native image_gen")); seen.push(form);
      if (failNext) { failNext = false; return Response.json({ error: API_KEY }, { status: 500 }); }
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    } });
  const middleware = generationMiddleware(jobs), server = createServer((req, res) => void middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { jobs.close(); await jobs.drainingPromise?.catch(() => {}); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createLocalGenerationProvider((path, options = {}) => fetch(base + path, { ...options, headers: { ...options.headers, Origin: base } }));
  for (const endpoint of ["connection", "connection/login"]) {
    assert.equal((await fetch(base + "/api/generation/" + endpoint, { method: "POST", headers: { Origin: "https://foreign.example" } })).status, 403);
    assert.equal((await fetch(base + "/api/generation/" + endpoint, { method: "POST" })).status, 403);
  }
  assert.equal((await fetch(base + "/api/generation/connection/openai", { method: "DELETE" })).status, 403);
  await client.configure({ provider: "openai", apiKey: API_KEY, model: MODEL, remember: false });
  const bundle = synthetic(), request = await prepareGenerationRequest(bundle, { projectId: "provider-check", prompt: "blue jade", partIds: ["part"] }, pixelEnv);
  const result = await settled(jobs, (await client.start(request)).id);
  assert.equal(result.status, "completed"); assert.equal(result.provider.id, "openai"); assert.equal(result.images[0].provider, "openai");
  const bytes = await client.image(result.id, result.images[0].id);
  const edits = await applyGeneratedParts(bundle, {}, result, [{ partId: "part", bytes }], pixelEnv);
  const pages = await compilePages(bundle, edits, pixelEnv), zip = exportPackage(bundle, pages, { editable: true, edits });
  const restored = parseBundle(unpackZip(zip));
  assert.deepEqual(restored.edits.part.image, edits.part.image); assert.deepEqual(restored.files[bundle.skeletonPath], bundle.files[bundle.skeletonPath]);
  assert.ok(!Buffer.from(zip).includes(Buffer.from(API_KEY)));
  assert.ok(!JSON.stringify(result).includes(API_KEY)); assert.ok(!(await readFile(join(root, "jobs", result.id, "job.json"), "utf8")).includes(API_KEY));
  failNext = true;
  const failed = await settled(jobs, (await client.start(request)).id);
  assert.equal(failed.status, "failed"); assert.ok(!failed.error.includes(API_KEY));
  await client.configure({ provider: "codex-native" });
  const continued = await settled(jobs, (await client.retry(failed.id)).id);
  assert.equal(continued.status, "completed"); assert.equal(continued.provider.id, "openai");
  assert.equal(nativeCalls, 0); assert.equal(seen.length, 3);
});
test("cancelling API batches aborts every request and blocks connection changes while running", async (t) => {
  const root = await temp(t), signals = []; let nativeCalls = 0;
  const jobs = new GenerationJobs({ root: join(root, "jobs"), rpc: rpcStub(), generate() { nativeCalls++; },
    fetcher: async (url, init) => {
      if (url.includes("/models/")) return modelResponse();
      signals.push(init.signal);
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
    } });
  t.after(async () => { jobs.close(); await jobs.drainingPromise?.catch(() => {}); });
  await jobs.connections.configure({ provider: "openai", apiKey: API_KEY, model: MODEL, remember: false });
  const parts = ["hand", "arm", "belt"].map((id) => ({ id, width: 32, height: 32 }));
  const result = await jobs.create({ version: 1, kind: "parts", projectId: "cancel-check", prompt: "blue", concurrency: 3, template: { fingerprint: "a".repeat(64) }, parts,
    references: parts.map((part) => ({ role: "part", partId: part.id, base64: png.toString("base64") })) });
  for (let i = 0; i < 100 && signals.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(signals.length, 3);
  await assert.rejects(jobs.connections.configure({ provider: "codex-native" }), /结束|取消/);
  await assert.rejects(jobs.connections.forget("openai"), /结束/);
  await jobs.cancel(result.id); await jobs.drainingPromise;
  assert.ok(signals.every((signal) => signal.aborted)); assert.deepEqual((await jobs.get(result.id)).images, []); assert.equal(nativeCalls, 0);
});
test("the image adapter rejects URL-only responses and propagates an already cancelled request", async (t) => {
  const file = join(await temp(t), "reference.png"); await writeFile(file, png);
  const adapter = openAIImagesProvider(async () => Response.json({ data: [{ url: "https://foreign.example/image.png" }] }));
  await assert.rejects(adapter.generate({ key: API_KEY, model: MODEL }, { prompt: "blue", references: [file], signal: new AbortController().signal }), /没有返回一张 PNG/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.generate({ key: API_KEY, model: MODEL }, { prompt: "blue", references: [file], signal: controller.signal }), { name: "AbortError" });
});

test("Codex startup, public checks, snapshots and Codex selection never touch saved API credentials", async (t) => {
  const root = await temp(t), connectionRoot = join(root, "jobs", ".connection"), saved = await savedConnection(connectionRoot);
  const { calls, storage } = trackedProtection();
  const jobs = new GenerationJobs({ root: join(root, "jobs"), rpc: rpcStub(), protection: storage, fetcher() { throw new Error("unexpected API request"); } });
  t.after(() => jobs.close()); await jobs.loading;
  assert.equal((await jobs.status()).connected, true);
  assert.equal((await jobs.connections.info()).providers[1].needsUnlock, true);
  assert.match((await jobs.status("openai")).message, /保存并验证连接/);
  assert.equal((await jobs.connections.snapshot()).id, "codex-native");
  assert.equal((await jobs.connections.snapshot({ id: "openai" })).id, "openai");
  await jobs.connections.configure({ provider: "codex-native" });
  assert.deepEqual(calls, { available: 0, encrypt: 0, decrypt: 0 });
  assert.deepEqual(JSON.parse(await readFile(join(connectionRoot, "connection.json"), "utf8")).profiles.openai, saved.profiles.openai);
});

test("saved API credentials unlock only after explicit connection validation and keep their legacy ciphertext", async (t) => {
  const root = await temp(t), saved = await savedConnection(root, "openai"), { calls, storage } = trackedProtection();
  const connections = new AIConnections({ root, rpc: rpcStub(), protection: storage, fetcher: async (_url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`); return modelResponse();
  } });
  t.after(() => connections.close());
  const before = await connections.info();
  assert.equal(before.status.connected, false); assert.equal(before.providers[1].keyConfigured, true); assert.equal(before.providers[1].needsUnlock, true);
  assert.deepEqual(calls, { available: 0, encrypt: 0, decrypt: 0 });
  const result = await connections.configure({ provider: "openai", apiKey: "", remember: true });
  assert.equal(result.status.connected, true); assert.equal(result.providers[1].needsUnlock, false);
  assert.deepEqual(calls, { available: 1, encrypt: 0, decrypt: 1 });
  assert.equal(JSON.parse(await readFile(join(root, "connection.json"), "utf8")).profiles.openai.encryptedKey, saved.profiles.openai.encryptedKey);
  assert.ok(!JSON.stringify(result).includes(API_KEY));
});

test("failed explicit decryption preserves the original ciphertext and selected provider", async (t) => {
  const root = await temp(t); await savedConnection(root);
  const original = await readFile(join(root, "connection.json"), "utf8"), { calls, storage } = trackedProtection({ decrypt() { throw new Error("access denied"); } });
  const connections = new AIConnections({ root, rpc: rpcStub(), protection: storage, fetcher() { throw new Error("unexpected API request"); } });
  t.after(() => connections.close());
  await assert.rejects(connections.configure({ provider: "openai", remember: true }), /无法解锁/);
  assert.equal(await readFile(join(root, "connection.json"), "utf8"), original);
  const info = await connections.info(); assert.equal(info.selected, "codex-native"); assert.equal(info.providers[1].needsUnlock, true);
  await assert.rejects(connections.generate(await connections.snapshot({ id: "openai" }), {}), /无法解锁/);
  assert.equal(await readFile(join(root, "connection.json"), "utf8"), original);
  assert.deepEqual(calls, { available: 1, encrypt: 0, decrypt: 2 });
});

test("explicit session-only replacement removes old remembered credentials without any Keychain calls", async (t) => {
  const root = await temp(t); await savedConnection(root); let valid = false;
  const before = await readFile(join(root, "connection.json"), "utf8");
  const { calls, storage } = trackedProtection({
    isAvailable() { throw new Error("must not probe"); }, encrypt() { throw new Error("must not encrypt"); }, decrypt() { throw new Error("must not decrypt"); },
  });
  const connections = new AIConnections({ root, rpc: rpcStub(), protection: storage, fetcher: async () => valid ? modelResponse() : Response.json({}, { status: 401 }) });
  t.after(() => connections.close());
  await assert.rejects(connections.configure({ provider: "openai", apiKey: API_KEY, remember: false }), /API Key 无效/);
  assert.equal(await readFile(join(root, "connection.json"), "utf8"), before, "failed verification cannot remove the remembered key");
  valid = true;
  const result = await connections.configure({ provider: "openai", apiKey: API_KEY, remember: false });
  assert.equal(result.status.connected, true); assert.equal(result.providers[1].keySaved, false);
  assert.deepEqual(calls, { available: 0, encrypt: 0, decrypt: 0 });
  const file = await readFile(join(root, "connection.json"), "utf8");
  assert.ok(!file.includes(API_KEY)); assert.equal(JSON.parse(file).profiles.openai.encryptedKey, undefined);
  const restarted = new AIConnections({ root, rpc: rpcStub(), protection: storage }); t.after(() => restarted.close());
  assert.equal((await restarted.status()).connected, false); await assert.rejects(restarted.snapshot(), /API Key/);
  assert.deepEqual(calls, { available: 0, encrypt: 0, decrypt: 0 });
});

test("forgetting a locked key does not decrypt or probe secure storage", async (t) => {
  const root = await temp(t); await savedConnection(root, "openai"); const { calls, storage } = trackedProtection();
  const connections = new AIConnections({ root, rpc: rpcStub(), protection: storage }); t.after(() => connections.close());
  const info = await connections.forget("openai");
  assert.equal(info.selected, "openai"); assert.equal(info.providers[1].keySaved, false);
  assert.deepEqual(calls, { available: 0, encrypt: 0, decrypt: 0 });
});

test("unavailable encryption with no old ciphertext falls back to session-only storage", async (t) => {
  const root = await temp(t), { calls, storage } = trackedProtection({ isAvailable: () => false });
  const connections = new AIConnections({ root, rpc: rpcStub(), protection: storage, fetcher: async () => modelResponse() });
  t.after(() => connections.close());
  const result = await connections.configure({ provider: "openai", apiKey: API_KEY, remember: true });
  assert.equal(result.secureStorage, false); assert.equal(result.providers[1].keySaved, false); assert.equal(result.providers[1].keyConfigured, true);
  assert.match(result.status.message, /仅在本次运行中使用/);
  assert.deepEqual(calls, { available: 1, encrypt: 0, decrypt: 0 });
  assert.ok(!(await readFile(join(root, "connection.json"), "utf8")).includes(API_KEY));
});

test("unavailable, denied or failed storage cannot overwrite an existing remembered key", async (t) => {
  for (const failure of [undefined, { isAvailable: () => false }, { isAvailable() { throw new Error("denied"); } }, { encrypt() { throw new Error("denied"); } }]) {
    const root = await temp(t); await savedConnection(root);
    const before = await readFile(join(root, "connection.json"), "utf8"), tracked = failure && trackedProtection(failure);
    const connections = new AIConnections({ root, rpc: rpcStub(), protection: tracked?.storage, fetcher: async () => modelResponse() });
    t.after(() => connections.close());
    await assert.rejects(connections.configure({ provider: "openai", apiKey: "sk-new-session-test-key", remember: true }), /原.*未更改/);
    assert.equal(await readFile(join(root, "connection.json"), "utf8"), before);
    const info = await connections.info(); assert.equal(info.selected, "codex-native"); assert.equal(info.providers[1].keySaved, true);
  }
});

test("legacy stored keys unlock once on real concurrent API generation without startup or snapshot probes", async (t) => {
  const root = await temp(t), connectionRoot = join(root, "jobs", ".connection"), saved = await savedConnection(connectionRoot, "openai");
  const { calls, storage } = trackedProtection({ async decrypt(value) { await new Promise((resolve) => setTimeout(resolve, 10)); return protection.decrypt(value); } });
  let requests = 0;
  const jobs = new GenerationJobs({ root: join(root, "jobs"), rpc: rpcStub(), protection: storage, generate() { throw new Error("unexpected native fallback"); },
    fetcher: async (_url, init) => { assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`); requests++; return Response.json({ data: [{ b64_json: png.toString("base64") }] }); } });
  t.after(async () => { jobs.close(); await jobs.drainingPromise?.catch(() => {}); });
  await jobs.loading; await jobs.connections.info(); await jobs.connections.snapshot();
  assert.deepEqual(calls, { available: 0, encrypt: 0, decrypt: 0 });
  const parts = ["hand", "arm", "belt"].map((id) => ({ id, width: 32, height: 32 }));
  const job = await settled(jobs, (await jobs.create({ version: 1, kind: "parts", projectId: "lazy-stored-key", prompt: "blue", concurrency: 3,
    template: { fingerprint: "a".repeat(64) }, parts, references: parts.map((part) => ({ role: "part", partId: part.id, base64: png.toString("base64") })) })).id);
  assert.equal(job.status, "completed"); assert.equal(job.images.length, 3); assert.equal(requests, 3);
  assert.deepEqual(calls, { available: 0, encrypt: 0, decrypt: 1 });
  assert.equal(JSON.parse(await readFile(join(connectionRoot, "connection.json"), "utf8")).profiles.openai.encryptedKey, saved.profiles.openai.encryptedKey);
});

test("asynchronous protection wrappers retain the legacy ciphertext contract", async (t) => {
  const root = await temp(t), { calls, storage } = trackedProtection({ async isAvailable() { return true; }, async encrypt(key) { return protection.encrypt(key); }, async decrypt(bytes) { return protection.decrypt(bytes); } });
  const options = { root, rpc: rpcStub(), protection: storage, fetcher: async () => modelResponse() };
  const connections = new AIConnections(options); t.after(() => connections.close());
  await connections.configure({ provider: "openai", apiKey: API_KEY, remember: true });
  const restarted = new AIConnections(options); t.after(() => restarted.close());
  await restarted.configure({ provider: "openai", remember: true });
  assert.deepEqual(calls, { available: 2, encrypt: 1, decrypt: 1 });
  assert.equal((await restarted.status()).connected, true);
});

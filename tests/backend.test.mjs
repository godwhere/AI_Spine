import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { startWorkbenchServer } from "../server/bootstrap/workbench.mjs";
import { GenerationJobs } from "../server/jobs/generation-service.mjs";
import { localKeyProtection } from "../server/infrastructure/key-protection.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ispine-backend-"));
  await mkdir(join(root, "client"));
  await writeFile(join(root, "client/index.html"), "<!doctype html><title>Workbench</title>");
  await writeFile(join(root, "client/view.js"), "export const ready = true;");
  await writeFile(join(root, "secret.txt"), "outside client root");
  let closed = 0;
  const backend = await startWorkbenchServer({ mode: "test", clientRoot: join(root, "client"), dataRoot: root, port: 0,
    jobs: { status: async () => ({ connected: true, provider: "codex-native" }), close: async () => { closed++; } } });
  t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
  return { ...backend, root, closed: () => closed };
}
test("local backend serves assets, workers, and HEAD with a restrictive content policy", async (t) => {
  const { origin } = await fixture(t);
  const page = await fetch(origin);
  assert.equal(page.status, 200); assert.match(await page.text(), /Workbench/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(page.headers.get("content-security-policy"), /worker-src 'self' blob:/);
  const script = await fetch(origin + "/view.js");
  assert.match(script.headers.get("content-type"), /javascript/);
  const head = await fetch(origin, { method: "HEAD" });
  assert.ok(Number(head.headers.get("content-length")) > 0); assert.equal(await head.text(), "");
});
test("local backend refuses paths outside its assets, other hosts, cross-site access, and writes", async (t) => {
  const { origin } = await fixture(t);
  assert.equal((await fetch(origin + "/..%2fsecret.txt")).status, 403);
  const foreignHost = await new Promise((accept, reject) => {
    const req = request(origin, { headers: { Host: "foreign.example" } }, (res) => { res.resume(); accept(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(origin, { headers: { Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await fetch(origin, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await fetch(origin, { method: "POST" })).status, 405);
});
test("browser backend keeps the same-origin Codex provider reachable without exposing raw RPC", async (t) => {
  const { origin } = await fixture(t);
  assert.deepEqual(await (await fetch(origin + "/api/generation/status")).json(), { connected: true, provider: "codex-native" });
  assert.equal((await fetch(origin + "/api/generation/status", { headers: { Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await fetch(origin + "/api/generation/rpc")).status, 404);
  assert.equal((await fetch(origin + "/server/infrastructure/codex-rpc.mjs")).status, 404);
});
test("browser rig routes use the real job service and enforce the local request boundary without invoking AI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ispine-backend-rig-"));
  await mkdir(join(root, "client"));
  await writeFile(join(root, "client/index.html"), "<!doctype html><title>iSpine</title>");
  let aiCalls = 0;
  const unexpected = () => { aiCalls++; throw new Error("Backend rig route checks must not invoke AI"); };
  const rpc = { on() {}, off() {}, start: unexpected, request: unexpected, close() {} };
  const jobs = new GenerationJobs({ root: join(root, "generation/jobs"), rpc, generate: unexpected, fetcher: unexpected });
  const server = await startWorkbenchServer({ mode: "test", clientRoot: join(root, "client"), dataRoot: root, port: 0, jobs });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const { origin } = server, endpoint = origin + "/api/rig/jobs";
  const list = await fetch(endpoint + "?projectId=desktop-rig-fixture");
  assert.equal(list.status, 200); assert.deepEqual(await list.json(), { jobs: [] });
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(endpoint)).status, 400);
  assert.equal((await fetch(endpoint + "/00000000-0000-0000-0000-000000000000")).status, 404);
  assert.equal((await fetch(endpoint + "?projectId=desktop-rig-fixture", { headers: { Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await fetch(endpoint + "?projectId=desktop-rig-fixture", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 400);
  assert.equal((await fetch(origin + "/api/rig/rpc")).status, 404);
  assert.equal((await fetch(origin + "/shared/rig-schema.mjs")).status, 404);
  assert.equal((await fetch(origin + "/server/rig-service.mjs")).status, 404);
  assert.equal(aiCalls, 0);
  assert.deepEqual(await jobs.rigJobs.list("desktop-rig-fixture"), []);
});
test("a failed port bind closes its owned Codex service", async (t) => {
  const backend = await fixture(t);
  let closed = false;
  await assert.rejects(startWorkbenchServer({ mode: "test", clientRoot: join(backend.root, "client"), dataRoot: backend.root,
    port: Number(new URL(backend.origin).port), jobs: { close: async () => { closed = true; } } }), { code: "EADDRINUSE" });
  assert.equal(closed, true);
});
test("browser startup and connection browsing never unlock stored API keys", async (t) => {
  for (const selected of ["codex-native", "openai"]) {
    const root = await mkdtemp(join(tmpdir(), "ispine-keychain-startup-"));
    const jobRoot = join(root, "generation/jobs"), connectionRoot = join(jobRoot, ".connection");
    await mkdir(join(root, "client"));
    await writeFile(join(root, "client/index.html"), "<!doctype html><title>iSpine</title>");
    await mkdir(connectionRoot, { recursive: true });
    const encryptedKey = Buffer.from("saved ciphertext fixture").toString("base64");
    await writeFile(join(connectionRoot, "connection.json"), JSON.stringify({ selected,
      profiles: { openai: { encryptedKey } } }), { mode: 0o600 });
    const calls = [];
    const protection = localKeyProtection({ platform: "darwin", run: async (...args) => {
      calls.push(args[0]); throw new Error("Unexpected Keychain access");
    } });
    const rpc = { on() {}, off() {}, async start() {}, close() {},
      async request(method) { assert.equal(method, "account/read"); return { account: { type: "chatgpt" } }; } };
    const jobs = new GenerationJobs({ root: jobRoot, rpc, protection,
      fetcher: async () => { throw new Error("Unexpected external API request"); } });
    const server = await startWorkbenchServer({ mode: "test", clientRoot: join(root, "client"), dataRoot: root, port: 0, jobs });
    t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
    assert.equal((await fetch(server.origin)).status, 200);
    const info = await (await fetch(server.origin + "/api/generation/connection")).json();
    assert.equal(info.selected, selected);
    assert.equal(info.providers.find((p) => p.id === "openai").keySaved, true);
    const status = await (await fetch(server.origin + "/api/generation/status?provider=openai")).json();
    assert.equal(status.connected, false); assert.match(status.message, /保存并验证连接/);
    assert.equal(info.providers.find((p) => p.id === "openai").needsUnlock, true);
    const configured = await fetch(server.origin + "/api/generation/connection", { method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ provider: "codex-native" }) });
    assert.equal(configured.status, 200);
    const saved = JSON.parse(await readFile(join(connectionRoot, "connection.json"), "utf8"));
    assert.equal(saved.profiles.openai.encryptedKey, encryptedKey);
    assert.deepEqual(calls, [], selected);
  }
});

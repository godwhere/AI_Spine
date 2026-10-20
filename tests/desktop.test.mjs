import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { existsSync } from "node:fs";
import { startDesktopServer } from "../desktop/server.mjs";
import { unpackZip, parseBundle } from "../src/core/archive.js";
import { GenerationJobs } from "../server/generation-service.mjs";
import { createDesktopKeyProtection } from "../desktop/key-protection.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ai-spine-desktop-"));
  await mkdir(join(root, "client"));
  await writeFile(join(root, "client/index.html"), "<!doctype html><title>Workbench</title>");
  await writeFile(join(root, "client/view.js"), "export const ready = true;");
  await writeFile(join(root, "secret.txt"), "outside client root");
  let closed = 0;
  const backend = await startDesktopServer({ clientRoot: join(root, "client"), dataRoot: root, port: 0,
    jobs: { status: async () => ({ connected: true, provider: "codex-native" }), close: async () => { closed++; } } });
  t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
  return { ...backend, root, closed: () => closed };
}
test("packaged backend serves assets, workers, and HEAD with a restrictive content policy", async (t) => {
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
test("desktop backend refuses paths outside its assets, other hosts, cross-site access, and writes", async (t) => {
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
test("desktop runtime keeps the same-origin Codex provider reachable without exposing raw RPC", async (t) => {
  const { origin } = await fixture(t);
  assert.deepEqual(await (await fetch(origin + "/api/generation/status")).json(), { connected: true, provider: "codex-native" });
  assert.equal((await fetch(origin + "/api/generation/status", { headers: { Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await fetch(origin + "/api/generation/rpc")).status, 404);
  assert.equal((await fetch(origin + "/server/codex-rpc.mjs")).status, 404);
});
test("desktop rig routes use the real job service and enforce the local request boundary without invoking AI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ispine-desktop-rig-"));
  await mkdir(join(root, "client"));
  await writeFile(join(root, "client/index.html"), "<!doctype html><title>iSpine</title>");
  let aiCalls = 0;
  const unexpected = () => { aiCalls++; throw new Error("Desktop rig route checks must not invoke AI"); };
  const rpc = { on() {}, off() {}, start: unexpected, request: unexpected, close() {} };
  const jobs = new GenerationJobs({ root: join(root, "generation/jobs"), rpc, generate: unexpected, fetcher: unexpected });
  const server = await startDesktopServer({ clientRoot: join(root, "client"), dataRoot: root, port: 0, jobs });
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
  await assert.rejects(startDesktopServer({ clientRoot: join(backend.root, "client"), dataRoot: backend.root,
    port: Number(new URL(backend.origin).port), jobs: { close: async () => { closed = true; } } }), { code: "EADDRINUSE" });
  assert.equal(closed, true);
});
test("desktop startup and connection browsing never unlock stored API keys", async (t) => {
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
    const storage = Object.fromEntries(["isEncryptionAvailable", "encryptString", "decryptString"].map((method) =>
      [method, () => { calls.push(method); throw new Error("Unexpected Keychain access"); }]));
    const protection = createDesktopKeyProtection(storage);
    const rpc = { on() {}, off() {}, async start() {}, close() {},
      async request(method) { assert.equal(method, "account/read"); return { account: { type: "chatgpt" } }; } };
    const jobs = new GenerationJobs({ root: jobRoot, rpc, protection,
      fetcher: async () => { throw new Error("Unexpected external API request"); } });
    const server = await startDesktopServer({ clientRoot: join(root, "client"), dataRoot: root, port: 0, jobs });
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
test("the desktop starter contains all six calibrated replacements and editable generation data", async () => {
  const zip = new Uint8Array(await readFile(resolve("outputs/egg-starberry/starberry-project.zip")));
  const files = await unpackZip(zip);
  const bundle = parseBundle(files);
  assert.equal(bundle.parts.length, 6); assert.equal(Object.keys(bundle.edits).length, 6);
  assert.ok(bundle.generation.appearance); assert.ok(bundle.generation.partsPrompt);
  for (const part of bundle.parts) {
    assert.ok(bundle.edits[part.id].image?.length, part.id);
  }
});
test("the actual macOS bundle includes working image decoding and an independently runnable backend", { skip: !existsSync("outputs/desktop/iSpine.app") }, async () => {
  const appRoot = resolve("outputs/desktop/iSpine.app/Contents/Resources/app");
  const executable = resolve("outputs/desktop/iSpine.app/Contents/MacOS/iSpine");
  const run = promisify(execFile);
  const { stdout } = await run(executable, ["--input-type=module", "-e", `
    const {mkdtemp,readFile,rm}=await import('node:fs/promises');
    const {tmpdir}=await import('node:os');
    const {join}=await import('node:path');
    const {createCanvas,loadImage}=await import('@napi-rs/canvas');
    const canvas=createCanvas(2,2), image=await loadImage(canvas.toBuffer('image/png'));
    const shared=await readFile('./shared/rig-schema.mjs','utf8');
    const {validateRigDocument}=await import('./shared/rig-schema.mjs');
    const {RigJobs}=await import('./server/rig-service.mjs');
    const {GenerationJobs}=await import('./server/generation-service.mjs');
    const {startDesktopServer}=await import('./desktop/server.mjs');
    const dataRoot=await mkdtemp(join(tmpdir(),'ispine-bundle-rig-'));
    let aiCalls=0;
    const unexpected=()=>{aiCalls++;throw new Error('Bundle smoke must not invoke AI')};
    const rpc={on(){},off(){},start:unexpected,request:unexpected,close(){}};
    const jobs=new GenerationJobs({root:join(dataRoot,'generation/jobs'),rpc,generate:unexpected,fetcher:unexpected});
    const server=await startDesktopServer({clientRoot:'dist/client',dataRoot,port:0,jobs});
    const page=await fetch(server.origin), zip=await fetch(server.origin+'/examples/starberry-project.zip');
    const rigs=await fetch(server.origin+'/api/rig/jobs?projectId=bundle-smoke');
    const denied=await fetch(server.origin+'/api/rig/jobs?projectId=bundle-smoke',{headers:{Origin:'https://foreign.example'}});
    console.log(JSON.stringify({width:image.width,page:page.status,zip:zip.status,zipBytes:(await zip.arrayBuffer()).byteLength,
      sharedBytes:shared.length,rigSchema:typeof validateRigDocument,rigService:jobs.rigJobs instanceof RigJobs,
      rigStatus:rigs.status,rigList:await rigs.json(),denied:denied.status,aiCalls}));
    await server.close();
    await rm(dataRoot,{recursive:true,force:true});
  `], { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20000 });
  const value = JSON.parse(stdout.trim());
  assert.deepEqual({ width: value.width, page: value.page, zip: value.zip }, { width: 2, page: 200, zip: 200 });
  assert.ok(value.zipBytes > 5000000);
  assert.ok(value.sharedBytes > 0);
  assert.equal(value.rigSchema, "function"); assert.equal(value.rigService, true);
  assert.equal(value.rigStatus, 200); assert.deepEqual(value.rigList, { jobs: [] });
  assert.equal(value.denied, 403); assert.equal(value.aiCalls, 0);
});
test("the ZIP saved through the native dialog preserves all replacements, transforms, source files, and prompts", async () => {
  const load = async (path) => parseBundle(unpackZip(new Uint8Array(await readFile(resolve(path)))));
  const source = await load("outputs/egg-starberry/starberry-project.zip");
  const exported = await load("outputs/desktop/evidence/starberry-desktop-project.zip");
  assert.equal(exported.parts.length, 6);
  assert.deepEqual(exported.edits, source.edits);
  for (const [path, bytes] of Object.entries(source.files)) assert.deepEqual(exported.files[path], bytes, path);
  assert.deepEqual(exported.generation.appearance.image, source.generation.appearance.image);
  assert.equal(exported.generation.appearancePrompt, source.generation.appearancePrompt);
  assert.equal(exported.generation.partsPrompt, source.generation.partsPrompt);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { startDesktopServer } from "../desktop/server.mjs";
import { unpackZip, parseBundle } from "../src/core/archive.js";

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
test("a failed port bind closes its owned Codex service", async (t) => {
  const backend = await fixture(t);
  let closed = false;
  await assert.rejects(startDesktopServer({ clientRoot: join(backend.root, "client"), dataRoot: backend.root,
    port: Number(new URL(backend.origin).port), jobs: { close: async () => { closed = true; } } }), { code: "EADDRINUSE" });
  assert.equal(closed, true);
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
test("the actual macOS bundle includes working image decoding and an independently runnable backend", async () => {
  const appRoot = resolve("outputs/desktop/AI Spine.app/Contents/Resources/app");
  const executable = resolve("outputs/desktop/AI Spine.app/Contents/MacOS/AI Spine");
  const run = promisify(execFile);
  const { stdout } = await run(executable, ["--input-type=module", "-e", `
    const {createCanvas,loadImage}=await import('@napi-rs/canvas');
    const canvas=createCanvas(2,2), image=await loadImage(canvas.toBuffer('image/png'));
    const {startDesktopServer}=await import('./desktop/server.mjs');
    const server=await startDesktopServer({clientRoot:'dist/client',dataRoot:${JSON.stringify(tmpdir())},port:0,
      jobs:{close:async()=>{},status:async()=>({connected:true})}});
    const page=await fetch(server.origin), zip=await fetch(server.origin+'/examples/starberry-project.zip');
    console.log(JSON.stringify({width:image.width,page:page.status,zip:zip.status,zipBytes:(await zip.arrayBuffer()).byteLength}));
    await server.close();
  `], { cwd: appRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20000 });
  const value = JSON.parse(stdout.trim());
  assert.deepEqual({ width: value.width, page: value.page, zip: value.zip }, { width: 2, page: 200, zip: 200 });
  assert.ok(value.zipBytes > 5000000);
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

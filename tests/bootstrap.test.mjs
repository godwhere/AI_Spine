import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createServer as createViteServer } from "vite";
import { setTimeout as delay } from "node:timers/promises";
import { generationPlugin } from "../server/generation-plugin.mjs";
import { localEnvironment } from "../server/bootstrap/environments.mjs";
import { createWorkbenchServices, startWorkbenchServer } from "../server/bootstrap/workbench.mjs";
import { launchWorkbench } from "../server/bootstrap/launcher.mjs";
import { workbenchProxy } from "../server/workbench-proxy.mjs";
import { GenerationJobs } from "../server/jobs/generation-service.mjs";
import { fakeImageConnections } from "./support/isolated-workbench.mjs";

const unexpected = () => { throw new Error("No account, key or remote service is allowed in bootstrap tests"); };
const rpc = () => ({ on() {}, off() {}, start: unexpected, request: unexpected, close() {} });

test("development and preview composition owns isolated workspaces and port-specific histories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ispine-vite-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  async function instance(preview, port, connections = fakeImageConnections()) {
    let route, services, environment;
    const httpServer = createServer((req, res) => { void route(req, res, () => { res.writeHead(404); res.end(); }); });
    const plugin = generationPlugin({ createServices(options) {
      environment = options;
      services = createWorkbenchServices({ ...options, jobs: new GenerationJobs({ root: options.jobsRoot, rpc: rpc(), connections }) });
      return services;
    } });
    assert.equal(plugin.config().server.strictPort, true); assert.equal(plugin.config().preview.strictPort, true);
    const config = { root, server: { port }, preview: { port } }; plugin.configResolved(config);
    plugin[preview ? "configurePreviewServer" : "configureServer"]({ config, httpServer, middlewares: { use(fn) { route = fn; } } });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    let closing;
    const close = () => closing ||= (async () => {
      httpServer.closeAllConnections(); await new Promise((resolve) => httpServer.close(resolve)); await services.close();
    })();
    t.after(close);
    return { origin: `http://127.0.0.1:${httpServer.address().port}`, environment, services, close };
  }
  const a = await instance(true, 42421, fakeImageConnections({ generate: async (_selection, { signal }) => {
    entered(); await delay(60_000, undefined, { signal });
  } }));
  const input = { version: 1, kind: "appearance", projectId: "preview-isolation", prompt: "fixture", references: [], parts: [], template: { fingerprint: "a".repeat(64) } };
  const job = await a.services.jobs.create(input); await started;
  const b = await instance(true, 42422), development = await instance(false, 5173);
  assert.notEqual(a.environment.jobsRoot, b.environment.jobsRoot);
  assert.equal(development.environment.jobsRoot, join(root, "work/generation/jobs"));
  assert.notEqual(a.environment.dataRoot, b.environment.dataRoot);
  const statuses = await Promise.all([a, b, development].map(async ({ origin }) => (await fetch(origin + "/api/workspace/status")).json()));
  assert.equal(new Set(statuses.map(({ id }) => id)).size, 3);
  await b.close(); assert.equal((await a.services.jobs.get(job.id)).status, "generating");
  await a.services.jobs.cancel(job.id); await a.services.jobs.drainingPromise;
  assert.equal((await a.services.jobs.get(job.id)).status, "cancelled");
  assert.throws(() => createWorkbenchServices({ mode: "test" }), /隔离数据目录/);
  assert.notEqual(localEnvironment(root, { port: 5174 }).jobsRoot, development.environment.jobsRoot);
});

test("the browser launcher starts an independent local service, opens its URL, and drains exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ispine-launcher-")), clientRoot = join(root, "client");
  await mkdir(clientRoot); await writeFile(join(clientRoot, "index.html"), "<!doctype html><title>Browser workbench</title>");
  let closed = 0; const opened = [];
  const backend = await launchWorkbench({ mode: "test", clientRoot, dataRoot: root, port: 0, open: true,
    opener: async (origin) => { assert.equal((await fetch(origin)).status, 200); opened.push(origin); },
    jobs: { close: async () => { closed++; } } });
  t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(opened, [backend.origin]); assert.equal(backend.reused, false);
  assert.equal((await (await fetch(backend.origin + "/api/workspace/status")).json()).storage, "local-shared");
  const reused = await launchWorkbench({ mode: "test", clientRoot, dataRoot: root, reuse: true, port: Number(new URL(backend.origin).port) });
  assert.equal(reused.reused, true); await reused.close(); assert.equal(closed, 0);
  await Promise.all([backend.close(), backend.close()]); assert.equal(closed, 1);
});

test("development uses production only through an explicit local proxy target", async () => {
  const calls = []; let constructed = false;
  const plugin = generationPlugin({ backendOrigin: "http://127.0.0.1:4175", createServices() { constructed = true; } });
  plugin.configureServer({ middlewares: { use(handler) { calls.push(handler); } } });
  assert.equal(calls.length, 1); assert.equal(constructed, false);
  for (const target of [undefined, "https://127.0.0.1:4175", "http://external.example:4175", "http://key@127.0.0.1:4175", "http://127.0.0.1:4175/api"])
    assert.throws(() => workbenchProxy(target));
});

test("a standalone bind failure never opens workspace or generation history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ispine-bind-owner-"));
  const listener = createServer(); await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => listener.close(resolve)); await rm(root, { recursive: true, force: true }); });
  let closed = 0;
  await assert.rejects(startWorkbenchServer({ mode: "test", dataRoot: root, clientRoot: root,
    port: listener.address().port, jobs: { close: async () => { closed++; } } }), { code: "EADDRINUSE" });
  assert.equal(closed, 1);
  await assert.rejects(access(join(root, "workspace")), { code: "ENOENT" });
  await assert.rejects(access(join(root, "generation")), { code: "ENOENT" });
});

test("real Vite bind failure and restart never open history before the previous owner drains", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ispine-vite-lifecycle-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Isolated Vite</title>");
  const reservation = createServer(); await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const events = []; let release, entered;
  const gate = new Promise((resolve) => { release = resolve; }), draining = new Promise((resolve) => { entered = resolve; });
  let count = 0;
  const plugin = () => generationPlugin({ createServices(options) {
    const id = ++count; events.push(`open-${id}`);
    return createWorkbenchServices({ ...options, jobs: { close: async () => {
      if (id === 1) { entered(); await gate; }
      events.push(`closed-${id}`);
    } } });
  } });
  const config = () => ({ root, configFile: false, logLevel: "silent", plugins: [plugin()], server: { host: "127.0.0.1", port, strictPort: true } });
  const first = await createViteServer(config());
  let second;
  t.after(async () => { release(); await second?.close(); await first.close(); await rm(root, { recursive: true, force: true }); });
  await first.listen(); assert.deepEqual(events, ["open-1"]);
  second = await createViteServer(config());
  await assert.rejects(second.listen(), /already in use/);
  assert.deepEqual(events, ["open-1"]);
  await second.close();
  const restarting = first.restart(); await draining;
  assert.deepEqual(events, ["open-1"]);
  release(); await restarting;
  assert.deepEqual(events, ["open-1", "closed-1", "open-2"]);
  const response = await fetch(`http://127.0.0.1:${port}/api/workspace/status`);
  assert.equal(response.status, 200); assert.equal((await response.json()).storage, "local-shared");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserServices } from "../src/app/browser-services.js";
import { configureWorkspace, usesSharedWorkspace } from "../src/infrastructure/workspace-client.js";

test("the browser composition root pins explicit storage/API/worker/preview ports through service failure", async (t) => {
  const descriptors = Object.fromEntries(["localStorage", "indexedDB"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const stored = new Map(), calls = []; let legacyWrites = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) } });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { databases: async () => [], open() { legacyWrites++; throw new Error("Unexpected legacy write"); } } });
  t.after(() => { for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  const fetcher = async (path, options) => {
    calls.push(path);
    let value = {}, status = 200;
    if (path.endsWith("/workspace/status")) value = { id: "backend-fixture", storage: "local-shared", revision: 0 };
    if (path.includes("/rig/jobs?")) value = { jobs: [] };
    if (path.endsWith("/generation/status")) value = { connected: true };
    if (path.endsWith("/workspace/projects")) {
      if (JSON.parse(options.body).operation === "summary") value = { value: { projects: [{ id: "thumb/图", thumbnailRef: { id: "thumb/图", hash: "a".repeat(64) } }], trash: [], hasDeletedProjects: false } };
      else { status = 503; value = { error: "Fixture backend unavailable" }; }
    }
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  };
  const preview = { createScene() {}, capture() {} }, workers = { unpack() {}, export() {} };
  const services = createBrowserServices({ storageMode: "shared", apiBase: "/fixture-api", fetcher, preview, workers });
  assert.equal(services.preview.createScene, preview.createScene); assert.equal(services.preview.capture, preview.capture);
  assert.equal(services.archive.unpack, workers.unpack);
  assert.equal((await services.connection.status()).connected, true); assert.deepEqual(await services.rigJobs.list("fixture"), []);
  await assert.rejects(services.repositories.projects.save({ id: "resource", name: "Name", files: {}, edits: {} }), /unavailable/);
  const library = await services.repositories.projects.library();
  assert.equal(library.projects[0].thumbnail, `/fixture-api/workspace/thumbnails/thumb%2F%E5%9B%BE?hash=${"a".repeat(64)}`);
  assert.ok(calls.every((path) => path.startsWith("/fixture-api/")));
  assert.equal(usesSharedWorkspace(), true); assert.equal(legacyWrites, 0);
  assert.throws(() => configureWorkspace({ storageMode: "shared", apiBase: "/fixture-api", fetcher: async () => {} }), /不能在运行中切换/);
  for (const apiBase of ["//external.example", "/\\external.example", "/", "https://external.example/api"])
    assert.throws(() => configureWorkspace({ storageMode: "shared", apiBase, fetcher }), /模式或 API 地址无效/);
  assert.throws(() => configureWorkspace({ storageMode: "legacy", apiBase: "/fixture-api", fetcher }), /不能在运行中切换/);
});

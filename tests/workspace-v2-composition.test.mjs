import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createBrowserServices } from "../src/app/browser-services.js";
import { startIsolatedWorkbench } from "./support/isolated-workbench.mjs";

test("browser composition negotiates V2 at its pinned API prefix and recovers native receipts without opening legacy storage", async (t) => {
  const server = await startIsolatedWorkbench({ seed: false, storageFormat: 2 }); t.after(() => server.close());
  const prior = Object.fromEntries(["localStorage", "indexedDB"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const storage = new Map(), calls = []; let opens = 0, lost = 2, unavailable = false;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { databases: async () => [], open() { opens++; throw new Error("No fallback writes"); } } });
  t.after(() => { for (const [name, descriptor] of Object.entries(prior)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const fetcher = async (path, options = {}) => {
    calls.push(path); assert.ok(path.startsWith("/fixture-api/"));
    if (unavailable) throw new Error("Simulated unavailable local service");
    const response = await fetch(server.origin + path.replace(/^\/fixture-api/, "/api"), { ...options, headers: { Origin: server.origin, ...options.headers } });
    if (path.endsWith("/v2/projects") && options.body && JSON.parse(options.body).operation === "save" && lost) {
      lost--; await response.arrayBuffer(); throw new Error("Simulated lost native receipt");
    }
    return response;
  };
  const services = createBrowserServices({ storageMode: "shared", apiBase: "/fixture-api", fetcher, createId: randomUUID, preview: {}, workers: {} });
  const writer = services.createEditorWriter({ schedule: () => 1, cancel() {} });
  writer.openSession({ sessionKey: "composition", entityId: "composed", persisted: false });
  const record = { id: "composed", name: "Composed", files: { "source.bin": new Uint8Array([1, 2, 3]) }, edits: {}, generation: {} };
  writer.enqueue({ sessionKey: "composition", localRevision: 1, snapshot: record });
  await assert.rejects(writer.flush("composition"), /服务暂不可用/);
  assert.equal(server.store.v2.row("ai-spine-local-workbench", "projects", record.id).resource_version, 1);
  await writer.flush("composition"); assert.equal(writer.hasUnsaved(), false); assert.equal(opens, 0);
  assert.equal(server.store.v2.row("ai-spine-local-workbench", "projects", record.id).resource_version, 1);
  const loaded = await services.repositories.projects.get(record.id); assert.deepEqual(loaded.files, record.files);
  unavailable = true;
  await assert.rejects(services.repositories.projects.save({ ...loaded, name: "Still local" }, { expectedVersion: loaded.updatedAt }), /服务暂不可用/);
  assert.equal(opens, 0); assert.ok(calls.some((path) => path.includes("/v2/blobs/")));
  assert.equal(server.store.call("projects", "get", [record.id]).name, "Composed");
});

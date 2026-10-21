import test from "node:test";
import assert from "node:assert/strict";
import { createLibraryController } from "../src/application/library-controller.js";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("library receipts invalidate stale reads and refresh other clients' changes without retaining full files in rows", async () => {
  const stale = deferred(), latest = { projects: [{ id: "local", name: "Committed" }, { id: "remote", name: "Other client" }], trash: [] };
  let reads = 0, watching, detached = false;
  const library = createLibraryController({ projects: { library: () => ++reads === 1 ? stale.promise : latest },
    templates: { list: async () => [] }, resources: { catalog: async () => ({ items: [{ id: "built-in" }] }) },
    watch: (callback) => { watching = callback; return () => { detached = true; }; } });
  const stop = library.start();
  library.saved({ id: "local", name: "Committed", files: { "source.png": new Uint8Array([1]) }, edits: {}, generation: {} });
  assert.equal(library.getSnapshot().projects[0].files, undefined);
  stale.resolve({ projects: [{ id: "local", name: "Old" }], trash: [] });
  for (let i = 0; i < 10 && !library.getSnapshot().ready; i++) await new Promise(setImmediate);
  assert.deepEqual(library.getSnapshot().projects, latest.projects);
  assert.deepEqual(library.getSnapshot().catalog, [{ id: "built-in" }]);
  assert.equal(reads, 2); await watching(); stop(); assert.equal(detached, true);
});

test("library lifecycle suppresses abandoned loads and reports read failure without selecting another store", async () => {
  const pending = deferred(), errors = [], updates = [];
  let watched;
  const library = createLibraryController({ projects: { library: () => pending.promise }, templates: { list: async () => [] },
    resources: { catalog: async () => ({ items: [] }) }, watch: (callback) => { watched = callback; return () => {}; } });
  library.subscribe((snapshot) => { updates.push(snapshot); if (snapshot.error) errors.push(snapshot.error.message); });
  const stop = library.start(); stop(); pending.resolve({ projects: [{ id: "late" }], trash: [] });
  await new Promise(setImmediate); await watched(); assert.deepEqual(updates, []);
  const failed = createLibraryController({ projects: { library: async () => { throw new Error("Shared service unavailable"); } },
    templates: { list: async () => [] }, resources: { catalog: async () => ({ items: [{ id: "built-in" }] }) }, watch: () => () => {} });
  await assert.rejects(failed.refresh(), /Shared service unavailable/);
  assert.equal(failed.getSnapshot().error.message, "Shared service unavailable");
  assert.deepEqual(failed.getSnapshot().projects, []); assert.equal(failed.getSnapshot().ready, true);
  assert.deepEqual(failed.getSnapshot().catalog, [{ id: "built-in" }]); assert.equal(typeof watched, "function");
});

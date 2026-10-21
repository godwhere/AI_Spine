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
  assert.deepEqual(library.getSnapshot().projects, []);
  stale.resolve({ projects: [{ id: "local", name: "Old" }], trash: [] });
  for (let i = 0; i < 10 && !library.getSnapshot().ready; i++) await new Promise(setImmediate);
  assert.deepEqual(library.getSnapshot().projects, latest.projects);
  assert.equal(library.getSnapshot().projects[0].files, undefined);
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

test("late save receipts reconcile trash, permanent deletion and restoration against current library state", async () => {
  const saved = { id: "resource", name: "Saved earlier", updatedAt: "2026-10-21T00:00:00.000Z" };
  let current = { projects: [saved], trash: [] };
  const library = createLibraryController({ projects: { library: async () => current }, templates: { list: async () => [] },
    resources: { catalog: async () => ({ items: [] }) }, watch: () => () => {} });
  await library.refresh();
  for (const deleted of [{ projects: [], trash: [{ ...saved, deletedAt: "2026-10-21T00:00:01.000Z" }] },
    { projects: [], trash: [], hasDeletedProjects: true }]) {
    const receipt = deferred(), arriving = receipt.promise.then((record) => library.saved(record));
    current = deleted; library.acceptLibrary(current);
    const observed = [], detach = library.subscribe((snapshot) => observed.push(snapshot.projects));
    receipt.resolve(saved); await arriving; detach();
    assert.deepEqual(library.getSnapshot().projects, []);
    assert.deepEqual(library.getSnapshot().trash, deleted.trash);
    assert.ok(observed.every((projects) => projects.length === 0), "no intermediate state may resurrect a deleted resource");
  }
  current = { projects: [{ ...saved, name: "Restored and edited elsewhere", updatedAt: "2026-10-21T00:00:02.000Z" }], trash: [] };
  await library.saved(saved);
  assert.deepEqual(library.getSnapshot().projects, current.projects);
  assert.deepEqual(library.getSnapshot().trash, []);
  current = { projects: [...current.projects, { id: "new", name: "Newly saved" }], trash: [] };
  await library.saved({ id: "new", files: { "large.png": new Uint8Array([1]) } });
  assert.deepEqual(library.getSnapshot().projects, current.projects);
  assert.equal(library.getSnapshot().projects[1].files, undefined);
});

for (const rejected of [false, true]) test(`a failed first catalog load retries on a watched refresh (${rejected ? "rejection" : "partial result"})`, async () => {
  const failure = new Error("Built-in catalog temporarily unavailable"), custom = { id: "custom", source: "custom" }, builtIn = { id: "built-in" };
  let calls = 0, customReads = 0, watched;
  const library = createLibraryController({ projects: { library: async () => ({ projects: [], trash: [] }) },
    templates: { list: async () => { customReads++; return [custom]; } },
    resources: { catalog: async () => {
      if (++calls === 1) { if (rejected) throw failure; return { items: [custom], error: failure }; }
      return { items: [custom, builtIn] };
    } }, watch: (callback) => { watched = callback; return () => {}; } });
  const stop = library.start();
  try {
    await new Promise(setImmediate);
    assert.equal(library.getSnapshot().ready, true);
    assert.equal(library.getSnapshot().error, failure);
    await watched();
    assert.equal(calls, 2); assert.equal(customReads, 0);
    assert.deepEqual(library.getSnapshot().catalog, [custom, builtIn]);
    assert.equal(library.getSnapshot().error, null);
    await watched();
    assert.equal(calls, 2); assert.equal(customReads, 1);
    assert.deepEqual(library.getSnapshot().catalog, [custom, builtIn]);
  } finally { stop(); }
});

test("successful catalog initialization is independent of a failed project read", async () => {
  let failed = true, catalogReads = 0;
  const library = createLibraryController({ projects: { library: async () => {
    if (failed) throw new Error("Workspace unavailable"); return { projects: [], trash: [] };
  } }, templates: { list: async () => [] }, resources: { catalog: async () => { catalogReads++; return { items: [{ id: "built-in" }] }; } },
    watch: () => () => {} });
  await assert.rejects(library.refresh(), /Workspace unavailable/); failed = false;
  await library.refresh();
  assert.equal(catalogReads, 1); assert.deepEqual(library.getSnapshot().catalog, [{ id: "built-in" }]);
  assert.equal(library.getSnapshot().error, null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";

async function fixture() {
  globalThis.indexedDB = new IDBFactory();
  return import(`../src/core/storage.js?case=${crypto.randomUUID()}`);
}
function project(id = "first") {
  return { id, name: `角色 ${id}`, files: { "skeleton.json": new Uint8Array([1, 2, 3]) },
    edits: { body: { image: new Uint8Array([4, 5, 6]), transform: { x: -3.5, y: 9, scaleX: 1.2, scaleY: 1.2, rotation: 0 } } },
    generation: { partsPrompt: "透明果冻身体", appearance: { image: new Uint8Array([7, 8, 9]) } },
    thumbnail: "data:image/png;base64,preview", partCount: 6, animationCount: 5 };
}
test("existing project records stay active and save without changing asset data", async () => {
  const storage = await fixture(), source = project();
  await storage.saveProject(source);
  const records = await storage.listProjects();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].files, source.files);
  assert.deepEqual(records[0].edits, source.edits);
  assert.equal((await storage.listTrashedProjects()).length, 0);
});
test("recapturing an animated thumbnail without authored changes keeps the resource revision", async () => {
  const storage = await fixture(), source = project(), initial = await storage.saveProject(source);
  const same = structuredClone(initial);
  same.thumbnail = "data:image/png;base64,a-different-animation-frame";
  same.partCount = 60; same.animationCount = 50; same.boneCount = 40;
  same.updatedAt = "2099-01-01T00:00:00.000Z";
  same.edits.body.transform = { rotation: 0, scaleY: 1.2, scaleX: 1.2, y: 9, x: -3.5 };
  const saved = await storage.saveProject(same, { expectedUpdatedAt: initial.updatedAt });
  assert.deepEqual(saved, initial);
  assert.deepEqual(await storage.getProject(initial.id), initial);
  await assert.rejects(storage.saveProject(same, { expectedUpdatedAt: "older-resource-revision" }), { code: "RESOURCE_CHANGED" }, "no-op equality never bypasses a real revision conflict");
});
test("real authored changes get distinct revisions even within one clock tick", async () => {
  const storage = await fixture(), now = Date.now;
  Date.now = () => 1792497600123;
  try {
    let record = await storage.saveProject(project());
    for (const change of [
      (value) => { value.name += " edited"; },
      (value) => { value.edits.body.transform.x += 1; },
      (value) => { value.edits.body.image[0] += 1; },
      (value) => { value.files["skeleton.json"][0] += 1; },
      (value) => { value.generation.partsPrompt += " new brief"; },
      (value) => { value.generation.appearance.image[0] += 1; },
      (value) => { value.templateId = "custom-template"; },
      (value) => { value.skeletonPath = "other/skeleton.json"; },
    ]) {
      const edited = structuredClone(record); change(edited);
      const next = await storage.saveProject(edited, { expectedUpdatedAt: record.updatedAt });
      assert.ok(Date.parse(next.updatedAt) > Date.parse(record.updatedAt));
      await assert.rejects(storage.saveProject(edited, { expectedUpdatedAt: record.updatedAt }), { code: "RESOURCE_CHANGED" });
      record = next;
    }
    assert.deepEqual(await storage.getProject(record.id), record);
  } finally { Date.now = now; }
});
test("authoring saves require the source resource revision to still match", async () => {
  const storage = await fixture();
  const initial = await storage.saveProject(project());
  const changed = await storage.saveProject({ ...initial, name: "New calibration", updatedAt: "2030-01-01T00:00:00.000Z" });
  // Give the persisted revision a distinct timestamp without relying on timer granularity.
  const db = await new Promise((resolve) => { const request = indexedDB.open("ai-spine-local-workbench", 2); request.onsuccess = () => resolve(request.result); });
  await new Promise((resolve) => { const tx = db.transaction("projects", "readwrite"); tx.objectStore("projects").put({ ...changed, updatedAt: "2030-01-01T00:00:00.000Z" }); tx.oncomplete = resolve; });
  db.close();
  await assert.rejects(storage.saveProject({ ...initial, name: "Old draft" }, { expectedUpdatedAt: initial.updatedAt }), { code: "RESOURCE_CHANGED" });
  assert.equal((await storage.getProject(initial.id)).name, "New calibration");
  const saved = await storage.saveProject({ ...changed, name: "Current draft" }, { expectedUpdatedAt: "2030-01-01T00:00:00.000Z" });
  assert.equal(saved.name, "Current draft");
  await storage.trashProject(initial.id);
  assert.equal(await storage.getProject(initial.id), null);
  assert.equal(await storage.getProject("missing"), null);
});
test("deletion moves only the chosen resource to persistent trash with all images and calibration", async () => {
  const storage = await fixture();
  await storage.saveProject(project()); await storage.saveProject(project("second"));
  const before = (await storage.listProjects()).find((record) => record.id === "first");
  await storage.trashProject("first");
  const library = await storage.listProjectLibrary();
  assert.deepEqual(library.projects.map((record) => record.id), ["second"]);
  assert.equal(library.trash.length, 1);
  const { deletedAt, ...after } = library.trash[0];
  assert.ok(Number.isFinite(Date.parse(deletedAt)));
  assert.deepEqual(after, before);
});
test("restoration preserves source bytes, replacements, transforms, and generation references", async () => {
  const storage = await fixture(), source = project();
  await storage.saveProject(source); await storage.trashProject(source.id);
  await storage.restoreProject(source.id);
  const record = (await storage.listProjects())[0];
  assert.equal(record.deletedAt, undefined);
  assert.equal((await storage.listTrashedProjects()).length, 0);
  assert.deepEqual(record.files, source.files);
  assert.deepEqual(record.edits, source.edits);
  assert.deepEqual(record.generation, source.generation);
});
test("a late autosave cannot bring a deleted project back or overwrite its saved contents", async () => {
  const storage = await fixture(), source = project();
  await storage.saveProject(source); await storage.trashProject(source.id);
  await assert.rejects(storage.saveProject({ ...source, name: "stale edit" }), /回收站/);
  assert.equal((await storage.listProjects()).length, 0);
  const record = (await storage.listTrashedProjects())[0];
  assert.equal(record.name, source.name); assert.deepEqual(record.edits, source.edits);
  await storage.restoreProject(source.id);
  await storage.saveProject({ ...source, name: "restored edit" });
  assert.equal((await storage.listProjects())[0].name, "restored edit");
});
test("invalid deletion and restoration do not remove or change other projects", async () => {
  const storage = await fixture(); await storage.saveProject(project());
  const before = await storage.listProjects();
  await assert.rejects(storage.trashProject("missing"), /不存在/);
  await assert.rejects(storage.restoreProject("missing"), /不存在/);
  assert.deepEqual(await storage.listProjects(), before);
});
test("desktop startup does not re-seed a sample when all existing projects are in trash", async (t) => {
  const storage = await fixture(); await storage.saveProject(project()); await storage.trashProject("first");
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  globalThis.window = { aiSpineDesktop: {} };
  globalThis.fetch = async () => { throw new Error("Unexpected sample download"); };
  t.after(() => { globalThis.window = oldWindow; globalThis.fetch = oldFetch; });
  const { desktopProjects } = await import(`../src/core/desktop.js?case=${crypto.randomUUID()}`);
  assert.deepEqual(await desktopProjects(), []);
  assert.equal((await storage.listTrashedProjects()).length, 1);
  await storage.permanentlyDeleteProjects(["first"]);
  const restarted = await import(`../src/core/desktop.js?case=${crypto.randomUUID()}`);
  assert.deepEqual(await restarted.desktopProjects(), []);
  assert.equal((await storage.listProjectLibrary()).hasDeletedProjects, true);
});
test("permanent deletion removes character data and prevents stale saves from reviving it", async () => {
  const storage = await fixture(), source = project();
  await storage.saveProject(source); await storage.saveProject(project("kept"));
  await storage.trashProject(source.id);
  assert.equal(await storage.permanentlyDeleteProjects([source.id]), 1);
  assert.deepEqual((await storage.listProjects()).map((value) => value.id), ["kept"]);
  assert.deepEqual(await storage.listTrashedProjects(), []);
  await assert.rejects(storage.saveProject(source), /永久删除/);
  await assert.rejects(storage.restoreProject(source.id), /永久删除/);
  const db = await new Promise((resolve) => { const request = indexedDB.open("ai-spine-local-workbench", 2); request.onsuccess = () => resolve(request.result); });
  const removed = await new Promise((resolve) => { const request = db.transaction("removedProjects").objectStore("removedProjects").get(source.id); request.onsuccess = () => resolve(request.result); });
  assert.deepEqual(Object.keys(removed).sort(), ["id", "removedAt"]);
  db.close();
});
test("emptying trash is atomic and rejects resources restored after confirmation opened", async () => {
  const storage = await fixture();
  for (const id of ["first", "second", "active"]) await storage.saveProject(project(id));
  await storage.trashProject("first"); await storage.trashProject("second");
  await storage.restoreProject("second");
  await assert.rejects(storage.permanentlyDeleteProjects(["first", "second"]), /只能永久删除/);
  assert.equal((await storage.listTrashedProjects())[0].id, "first");
  assert.equal((await storage.listProjectLibrary()).hasDeletedProjects, false);
  await storage.trashProject("second");
  assert.equal(await storage.permanentlyDeleteProjects(["first", "second", "first"]), 2);
  assert.deepEqual((await storage.listProjects()).map((value) => value.id), ["active"]);
  assert.deepEqual(await storage.listTrashedProjects(), []);
});
test("upgrading existing storage preserves imported assets and calibration", async () => {
  const storage = await fixture(), source = project();
  const old = await new Promise((resolve) => {
    const request = indexedDB.open("ai-spine-local-workbench", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("projects", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
  });
  await new Promise((resolve) => { const tx = old.transaction("projects", "readwrite"); tx.objectStore("projects").put(source); tx.oncomplete = resolve; });
  old.close();
  assert.deepEqual(await storage.listProjects(), [source]);
  assert.equal((await storage.listProjectLibrary()).hasDeletedProjects, false);
});
test("an old open window reports a blocked upgrade and can recover after it closes", async () => {
  const storage = await fixture();
  const old = await new Promise((resolve) => {
    const request = indexedDB.open("ai-spine-local-workbench", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("projects", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
  });
  await assert.rejects(storage.listProjectLibrary(), /关闭其他工作台窗口/);
  old.close();
  await storage.saveProject(project());
  assert.equal((await storage.listProjects()).length, 1);
});

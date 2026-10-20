import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { parseBundle, encodeText } from "../src/core/archive.js";
import { parseSkeleton } from "../src/spine/runtime.js";
import { synthetic, template } from "./helpers.mjs";

async function fixture() {
  globalThis.indexedDB = new IDBFactory();
  return import(`../src/core/custom-templates.js?case=${crypto.randomUUID()}`);
}
function project(bundle, id = "authored-one") {
  return {
    id, name: "我的角色", files: bundle.files, skeletonPath: bundle.skeletonPath,
    thumbnail: "data:image/png;base64,local-preview",
    edits: { part: { image: new Uint8Array([9, 8, 7]), transform: { x: 12, rotation: 30 } } },
    generation: { partsPrompt: "private generation prompt", appearance: { image: new Uint8Array([6, 5, 4]) } },
  };
}
async function openDatabase(name, version) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function rawRecords(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["metadata", "files"], "readonly");
    const metadata = tx.objectStore("metadata").getAll(), files = tx.objectStore("files").getAll();
    tx.oncomplete = () => resolve({ metadata: metadata.result, files: files.result });
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

test("a custom template snapshots real runtime files without project edits, prompts, or archive metadata", async () => {
  const storage = await fixture(), bundle = template("22"), source = project(bundle);
  const record = storage.createCustomTemplateRecord(source, {
    ...bundle.files,
    ".ai-spine/project.json": encodeText("private editable archive metadata"),
    ".ai-spine/generation/reference.png": new Uint8Array([1, 2, 3]),
    "notes.txt": encodeText("private notes"),
  }, { type: "role", categories: ["人物", " 人物 ", "", "怪物"] });
  assert.equal(record.id, `custom-${source.id}`);
  assert.equal(record.source, "custom"); assert.equal(record.sourceProjectId, source.id);
  assert.equal(record.name, source.name); assert.equal(record.thumbnail, source.thumbnail);
  assert.deepEqual(record.categories, ["人物", "怪物"]);
  assert.equal(record.animationCount, 7); assert.equal(record.regionCount, 49);
  assert.equal(record.skeletonFile, record.skeletonPath);
  assert.deepEqual(record.atlasFiles, bundle.atlasPaths);
  assert.deepEqual(record.textureFiles, bundle.pages.map((page) => page.file));
  assert.deepEqual(Object.keys(record.files).sort(), Object.keys(bundle.files).sort());
  assert.equal(record.edits, undefined); assert.equal(record.generation, undefined);
  assert.ok(!JSON.stringify(record).includes("private"));
  for (const path of Object.keys(bundle.files)) {
    assert.deepEqual(record.files[path], bundle.files[path]);
    assert.notEqual(record.files[path], bundle.files[path]);
  }
  const restored = parseBundle(record.files, { skeletonPath: record.skeletonPath });
  const before = parseSkeleton(bundle).data, after = parseSkeleton(restored).data;
  assert.deepEqual(after.animations.map((animation) => animation.name), before.animations.map((animation) => animation.name));
  assert.deepEqual(after.skins.map((skin) => skin.name), before.skins.map((skin) => skin.name));
  assert.deepEqual(restored.json, bundle.json);
});

test("saving, listing, and reopening use a separate database with lightweight metadata", async (t) => {
  const storage = await fixture(), bundle = synthetic(), source = project(bundle);
  const record = storage.createCustomTemplateRecord(source, bundle.files);
  const metadata = await storage.saveCustomTemplate(record);
  assert.equal(metadata.files, undefined);
  const list = await storage.listCustomTemplates();
  assert.deepEqual(list, [metadata]);
  assert.equal(list[0].edits, undefined); assert.equal(list[0].generation, undefined);
  assert.deepEqual((await indexedDB.databases()).map((entry) => entry.name), ["ai-spine-custom-templates"]);
  const getAll = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function (...args) {
    assert.notEqual(this.name, "files", "listing must never load file payloads");
    return getAll.apply(this, args);
  };
  try { assert.deepEqual(await storage.listCustomTemplates(), list); }
  finally { IDBObjectStore.prototype.getAll = getAll; }
  const reopened = await import(`../src/core/custom-templates.js?reopen=${crypto.randomUUID()}`);
  const loaded = await reopened.getCustomTemplate(record.id);
  assert.deepEqual(loaded.files, record.files);
  loaded.files[loaded.skeletonPath][0] = 0;
  assert.deepEqual((await storage.getCustomTemplate(record.id)).files, record.files);
  assert.equal(await storage.getCustomTemplate("custom-missing"), null);
  const db = await openDatabase("ai-spine-custom-templates", 1); t.after(() => db.close());
  assert.deepEqual([...db.objectStoreNames], ["files", "metadata"]);
  const raw = await rawRecords(db);
  assert.deepEqual(Object.keys(raw.files[0]).sort(), ["files", "id"]);
  assert.equal(raw.metadata[0].files, undefined);
});

test("binary skeleton and atlas bytes survive unchanged with independent buffers", async () => {
  const storage = await fixture(), directory = new URL("./fixtures/binary/", import.meta.url);
  const files = Object.fromEntries(["spineboy-pro.skel", "spineboy.atlas", "spineboy.png"].map((path) =>
    [path, new Uint8Array(fs.readFileSync(new URL(path, directory)))]));
  const bundle = parseBundle(files), source = project(bundle, "binary");
  const record = storage.createCustomTemplateRecord(source, files);
  const original = new Uint8Array(record.files[record.skeletonPath]);
  files[record.skeletonPath][0] ^= 255;
  assert.deepEqual(record.files[record.skeletonPath], original);
  const saving = storage.saveCustomTemplate(record);
  record.files[record.skeletonPath][0] ^= 255;
  await saving;
  const loaded = await storage.getCustomTemplate(record.id);
  assert.deepEqual(loaded.files[loaded.skeletonPath], original);
  assert.equal(parseSkeleton(parseBundle(loaded.files, { skeletonPath: loaded.skeletonPath })).data.animations.length, 11);
});

test("adding the same resource updates its stable template and preserves its creation time", async () => {
  const storage = await fixture(), bundle = synthetic(), source = project(bundle);
  const first = storage.createCustomTemplateRecord(source, bundle.files);
  first.createdAt = "2020-01-01T00:00:00.000Z";
  const metadata = await storage.saveCustomTemplate(first);
  const changed = synthetic({ rotate: 90 });
  source.name = "重新设计的角色";
  const next = storage.createCustomTemplateRecord(source, changed.files, { type: "effect", categories: ["法术"] });
  next.createdAt = "2030-01-01T00:00:00.000Z";
  const updated = await storage.saveCustomTemplate(next);
  assert.equal(next.id, first.id); assert.equal(updated.createdAt, metadata.createdAt);
  assert.equal(updated.name, source.name); assert.equal(updated.type, "effect");
  assert.deepEqual(updated.categories, ["法术"]);
  assert.equal((await storage.listCustomTemplates()).length, 1);
  assert.deepEqual((await storage.getCustomTemplate(next.id)).files, next.files);
});

test("resource edits, trash, and permanent deletion cannot change a saved template snapshot", async () => {
  const storage = await fixture();
  const resources = await import(`../src/core/storage.js?custom-case=${crypto.randomUUID()}`);
  const bundle = synthetic(), source = project(bundle);
  await resources.saveProject(source);
  const record = storage.createCustomTemplateRecord(source, bundle.files);
  await storage.saveCustomTemplate(record);
  const before = await storage.getCustomTemplate(record.id);
  source.files[source.skeletonPath][0] = 0;
  source.edits.part.transform.x = 300; source.generation.partsPrompt = "changed prompt";
  await resources.saveProject(source);
  await resources.trashProject(source.id);
  await resources.permanentlyDeleteProjects([source.id]);
  assert.deepEqual(await storage.getCustomTemplate(record.id), before);
  assert.deepEqual(await resources.listProjects(), []);
  assert.equal((await resources.listProjectLibrary()).hasDeletedProjects, true);
});

test("deleting only a custom template removes both stores and preserves its source project", async (t) => {
  const storage = await fixture();
  const resources = await import(`../src/core/storage.js?custom-case=${crypto.randomUUID()}`);
  const bundle = synthetic(), source = project(bundle);
  await resources.saveProject(source);
  const projectBefore = await resources.listProjects();
  const record = storage.createCustomTemplateRecord(source, bundle.files);
  await storage.saveCustomTemplate(record);
  for (const id of ["22", "template-22", source.id, "custom-", ""])
    await assert.rejects(storage.deleteCustomTemplate(id), /我创建的模板/);
  assert.equal((await storage.listCustomTemplates()).length, 1);
  assert.equal(await storage.deleteCustomTemplate(record.id), true);
  assert.equal(await storage.deleteCustomTemplate(record.id), false);
  assert.equal(await storage.getCustomTemplate(record.id), null);
  assert.deepEqual(await storage.listCustomTemplates(), []);
  assert.deepEqual(await resources.listProjects(), projectBefore);
  const db = await openDatabase("ai-spine-custom-templates", 1); t.after(() => db.close());
  assert.deepEqual(await rawRecords(db), { metadata: [], files: [] });
  const projectDB = await openDatabase("ai-spine-local-workbench", 2); t.after(() => projectDB.close());
  assert.equal(projectDB.version, 2);
  assert.deepEqual([...projectDB.objectStoreNames], ["projects", "removedProjects"]);
});

test("invalid or trashed resources fail validation without saving partial records", async (t) => {
  const storage = await fixture(), bundle = synthetic(), source = project(bundle);
  assert.throws(() => storage.createCustomTemplateRecord({ ...source, deletedAt: new Date().toISOString() }, bundle.files), /回收站/);
  assert.throws(() => storage.createCustomTemplateRecord(source, {}), /骨架/);
  assert.throws(() => storage.createCustomTemplateRecord(source, bundle.files, { type: "unknown" }), /类型/);
  const record = storage.createCustomTemplateRecord(source, bundle.files);
  await assert.rejects(storage.saveCustomTemplate({ ...record, id: "22" }), /我创建的模板/);
  await assert.rejects(storage.saveCustomTemplate({ ...record, sourceProjectId: "another" }), /不一致/);
  await assert.rejects(storage.saveCustomTemplate({ ...record, files: { ...record.files, "skeleton.json": encodeText("{") } }));
  const broken = structuredClone(bundle.json);
  broken.slots[0].bone = "missing-bone";
  await assert.rejects(storage.saveCustomTemplate({ ...record, files: { ...record.files, "skeleton.json": encodeText(JSON.stringify(broken)) } }), /missing-bone/);
  assert.deepEqual(await storage.listCustomTemplates(), []);
  const db = await openDatabase("ai-spine-custom-templates", 1); t.after(() => db.close());
  assert.deepEqual(await rawRecords(db), { metadata: [], files: [] });
  await storage.saveCustomTemplate(record);
  const before = await storage.getCustomTemplate(record.id);
  await assert.rejects(storage.saveCustomTemplate({ ...record, files: {} }));
  assert.deepEqual(await storage.getCustomTemplate(record.id), before);
});

test("a failed file write rolls metadata back together with the payload", async (t) => {
  const storage = await fixture(), bundle = synthetic(), source = project(bundle);
  const record = storage.createCustomTemplateRecord(source, bundle.files);
  await storage.saveCustomTemplate(record);
  const before = await storage.getCustomTemplate(record.id), put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === "files") throw new DOMException("Simulated storage quota", "QuotaExceededError");
    return put.apply(this, args);
  };
  try {
    await assert.rejects(storage.saveCustomTemplate({ ...record, name: "failed update" }), /quota/);
    const other = storage.createCustomTemplateRecord({ ...source, id: "other" }, bundle.files);
    await assert.rejects(storage.saveCustomTemplate(other), /quota/);
  } finally { IDBObjectStore.prototype.put = put; }
  assert.deepEqual(await storage.getCustomTemplate(record.id), before);
  assert.equal(await storage.getCustomTemplate("custom-other"), null);
  assert.equal((await storage.listCustomTemplates()).length, 1);
  const db = await openDatabase("ai-spine-custom-templates", 1); t.after(() => db.close());
  const raw = await rawRecords(db);
  assert.equal(raw.metadata.length, 1); assert.equal(raw.files.length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import forceCloseDatabase from "fake-indexeddb/lib/forceCloseDatabase";
import { createCanvas } from "@napi-rs/canvas";
import { createHumanoidDraft, buildRigFiles } from "../src/infrastructure/rig-authoring.js";
import { parseBundle } from "../src/infrastructure/archive-files.js";
import { attachRigAuthoring, readRigAuthoring } from "../engine/archive/rig-project.js";
import { rigWithCalibratedParts } from "../src/infrastructure/rig-project.js";
import { pixelEnv } from "./helpers.mjs";
import { createRigDraftWriter } from "../src/application/rig-draft-writer.js";
import { getMotionStudyFingerprints } from "../shared/domain/motion-study.mjs";
import { rigDraftDestination } from "../shared/domain/draft.mjs";
import { createRigResourceActions } from "../src/application/rig-resource.js";

const appSource = await readFile(new URL("../src/app/AppShell.jsx", import.meta.url), "utf8");
const entrySource = appSource.slice(appSource.indexOf("  const editResourceRig ="), appSource.indexOf("  const saveRigResource ="));
const entryNames = ["resourceBusy", "processing", "setResourceBusy", "setError", "flushRigDraft", "page", "persist", "services", "showRigWorkbench", "notify"];
const entryFactory = new Function(...entryNames, `${entrySource}; return editResourceRig;`);

function resourceEntry(storage, { flush = async () => {}, page = "home", persisted, persist = async () => persisted, saveDraft = storage.saveRigDraft } = {}) {
  const opened = [], errors = [], notices = [], calibrationCalls = [], busy = [];
  const values = {
    resourceBusy: false, processing: false, setResourceBusy: (value) => busy.push(value), setError: (value) => { if (value) errors.push(value); },
    flushRigDraft: flush, page, persist,
    getRigDraft: storage.getRigDraft, rigDraftDestination, readRigAuthoring, parseBundle,
    rigWithCalibratedParts: async (...args) => { calibrationCalls.push(args); return rigWithCalibratedParts(...args, pixelEnv); },
    showRigWorkbench: (document, options) => opened.push({ document, options }), saveRigDraft: saveDraft,
    crypto, notify: (value) => notices.push(value),
    services: { rigs: createRigResourceActions({ projects: {}, drafts: { get: storage.getRigDraft, save: saveDraft },
      pixels: { rigWithCalibratedParts: async (...args) => { calibrationCalls.push(args); return rigWithCalibratedParts(...args, pixelEnv); } },
      createId: () => crypto.randomUUID() }) },
  };
  return { open: entryFactory(...entryNames.map((name) => values[name])), opened, errors, notices, calibrationCalls, busy };
}

function partArtwork(color) {
  const canvas = createCanvas(12, 12), context = canvas.getContext("2d");
  context.fillStyle = color; context.fillRect(2, 2, 8, 8);
  return canvas.toDataURL("image/png");
}
async function resourceRecord(updatedAt = revision) {
  const doc = document("Saved character", "rig-R1"); doc.ownerResourceId = "R1";
  doc.parts = doc.parts.map((part) => ({ ...part, image: partArtwork("#5bca8f"), imageSource: "uploaded", completion: "ready" }));
  doc.motions = [{ id: "death", name: "Death", duration: 1.3, loop: false, origin: "manual", poses: [
    { time: 0, angles: {} }, { time: .35, angles: { leftThigh: 49 } }, { time: 1.3, angles: { leftThigh: 70 } },
  ] }];
  const files = attachRigAuthoring(await buildRigFiles(doc, pixelEnv), doc), bundle = parseBundle(files);
  return { id: "R1", name: doc.name, updatedAt, files, skeletonPath: bundle.skeletonPath, edits: {} };
}

async function fixture() {
  globalThis.indexedDB = new IDBFactory();
  return { ...await import(`../src/infrastructure/rig-draft-repository.js?lifecycle=${crypto.randomUUID()}`), rigDraftDestination };
}

test("legacy draft transactions reject stale session versions and keep timestamps monotonic", async () => {
  const storage = await fixture(), doc = { version: 1, id: "source-only-cas", name: "Source", width: 32, height: 32,
    joints: [], parts: [], motions: [] };
  const first = await storage.saveRigDraft(doc);
  const second = await storage.saveRigDraft({ ...doc, name: "Current" }, { expectedUpdatedAt: first.updatedAt });
  assert.notEqual(second.updatedAt, first.updatedAt);
  await assert.rejects(storage.saveRigDraft({ ...doc, name: "Stale" }, { expectedUpdatedAt: first.updatedAt }), { code: "DRAFT_CHANGED" });
  assert.equal((await storage.getRigDraft(doc.id)).document.name, "Current");
});
async function connectionFixture() {
  const factory = new IDBFactory(), connections = [], hooks = {}, original = factory.open.bind(factory);
  factory.open = (...args) => {
    const request = original(...args);
    request.addEventListener("success", () => { connections.push(request.result); hooks.open?.(request.result); });
    return request;
  };
  globalThis.indexedDB = factory;
  return { storage: await import(`../src/infrastructure/rig-draft-repository.js?connection=${crypto.randomUUID()}`), connections, hooks };
}
async function productionDraft() {
  const doc = document("Run and Death corrections", "draft-reconnection");
  doc.sourceImage = partArtwork("#dc83af");
  doc.parts[0] = { ...doc.parts[0], image: partArtwork("#7187dd"), imageSource: "calibrated", completion: "ready", previousCalibration: { x: 3, y: -2, scaleX: 1.17, scaleY: .92 } };
  doc.motions.push(...[["run", .8], ["death", 1.3]].map(([id, duration]) => ({ id, name: id, duration, loop: id === "run", poses: [{ time: 0 }, { time: duration }] })));
  const fingerprints = await getMotionStudyFingerprints(doc);
  doc.motionStudies = Object.fromEntries([["run", [0, .2, .4, .6, .8], 5], ["death", [0, .3, .65, 1.1, 1.3], 3]].map(([motionId, times, approved]) => [motionId, {
    version: 1, motionId, ...fingerprints, jobs: ["prelinked-candidate-job"], frames: times.map((time, index) => ({ id: `frame-${index}`, time, label: `${motionId} ${index}`,
      image: doc.sourceImage, sourceFingerprint: fingerprints.baseFingerprint, origin: index ? "ai-motion-frame" : "base",
      review: { approved: index < approved, checks: { identity: index < approved } }, mappingReview: { approved: false },
      ...(index < approved ? { segments: [{ partId: doc.parts[0].id, image: doc.parts[0].image, x: 0, y: 0, width: 12, height: 12, z: 0, visibleOnly: true, origin: "source-visible" }] } : {}) })),
  }]));
  // Save/load compares the normalized document, while preserving all art and review fields.
  const { validateRigDocument } = await import("../shared/rig-schema.mjs");
  return validateRigDocument(doc);
}
const document = (name = "Shared authoring package", id = "shared-document") =>
  createHumanoidDraft({ id, name, width: 160, height: 220 });
const revision = "2026-10-20T12:00:00.123Z";
async function rawDrafts() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("ispine-rig-drafts", 1);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(["metadata", "documents"], "readonly");
      const metadata = tx.objectStore("metadata").getAll(), documents = tx.objectStore("documents").getAll();
      tx.oncomplete = () => resolve({ metadata: metadata.result, documents: documents.result });
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

test("a cached connection closed without an event reopens once and preserves all pending production artwork", async () => {
  const { storage, connections } = await connectionFixture(), doc = await productionDraft();
  await storage.saveRigDraft(doc, { resourceId: "R1", resourceUpdatedAt: revision });
  connections[0].close();
  const edited = structuredClone(doc); edited.motions.find((motion) => motion.id === "death").poses[1].angles.leftThigh = -43.411768;
  edited.motionStudies.death.frames[2].label = "Latest accepted calibration";
  await storage.saveRigDraft(edited, { resourceId: "R1", resourceUpdatedAt: revision });
  assert.equal(connections.length, 2, "only one new connection is required");
  const loaded = await storage.getRigDraft("resource-R1");
  assert.deepEqual(loaded.document, edited); assert.equal(loaded.resourceUpdatedAt, revision);
  assert.equal((await storage.listRigDrafts()).length, 1);
  assert.deepEqual(doc.motionStudies.run.frames.map((frame) => frame.review.approved), [true, true, true, true, true]);
  assert.deepEqual(doc.motionStudies.death.frames.map((frame) => frame.review.approved), [true, true, true, false, false]);
});

test("unexpected close invalidates cached reads and a delayed old close cannot invalidate the replacement", async () => {
  const { storage, connections } = await connectionFixture(), doc = document();
  await storage.saveRigDraft(doc); const original = connections[0];
  forceCloseDatabase(original);
  assert.deepEqual((await storage.getRigDraft(doc.id)).document, doc); assert.equal(connections.length, 2);
  forceCloseDatabase(original); // Simulate an old close arriving after the new connection resolved.
  assert.equal((await storage.listRigDrafts()).length, 1); assert.equal(connections.length, 2);
  forceCloseDatabase(connections[1]);
  assert.equal((await storage.listRigDrafts()).length, 1); assert.equal(connections.length, 3);
});

test("closing during transaction creation is retried once and normal writer flush retains the draft after a second failure", async () => {
  const { storage, connections, hooks } = await connectionFixture(), doc = await productionDraft();
  await storage.saveRigDraft(doc, { resourceId: "R1", resourceUpdatedAt: revision });
  const statuses = [], writer = createRigDraftWriter({ save: storage.saveRigDraft, onStatus: (value) => statuses.push(value), schedule: () => 0, cancel() {} });
  writer.setSession("active-draft");
  const edited = structuredClone(doc); edited.name = "Latest Run and Death progress";
  writer.enqueue({ document: edited, sessionKey: "active-draft", resourceId: "R1", resourceUpdatedAt: revision });
  connections[0].close(); hooks.open = (db) => db.close();
  await assert.rejects(writer.flush(), { name: "InvalidStateError" });
  assert.equal(connections.length, 2, "there is no unbounded connection loop");
  assert.equal(writer.hasUnsaved(), true); assert.equal(statuses.at(-1).status, "failed");
  hooks.open = null;
  await writer.flush();
  assert.equal(connections.length, 3); assert.equal(writer.hasUnsaved(), false); assert.equal(statuses.at(-1).status, "saved");
  assert.deepEqual((await storage.getRigDraft("resource-R1")).document, edited);
  assert.equal((await storage.listRigDrafts()).length, 1); writer.dispose();
});

test("an aborted write is never replayed by connection recovery and the previous two-store draft remains intact", async (t) => {
  const { storage, connections } = await connectionFixture(), doc = document();
  await storage.saveRigDraft(doc);
  const original = IDBObjectStore.prototype.put; let writes = 0;
  const mock = t.mock.method(IDBObjectStore.prototype, "put", function (...args) {
    writes++;
    if (this.name === "documents") throw new DOMException("Storage full fixture", "QuotaExceededError");
    return original.apply(this, args);
  });
  await assert.rejects(storage.saveRigDraft({ ...doc, name: "Must not partially replace metadata" }), { name: "QuotaExceededError" });
  assert.equal(writes, 2); assert.equal(connections.length, 1, "the existing transaction error must not reopen or replay");
  mock.mock.restore();
  assert.deepEqual((await storage.getRigDraft(doc.id)).document, doc);
  assert.equal((await storage.listRigDrafts())[0].name, doc.name);
});

test("non-closing transaction errors propagate without invalidating a healthy connection", async (t) => {
  const { storage, connections } = await connectionFixture(), doc = document();
  await storage.saveRigDraft(doc); let calls = 0;
  const mock = t.mock.method(connections[0], "transaction", () => { calls++; throw new DOMException("Wrong store fixture", "NotFoundError"); });
  await assert.rejects(storage.listRigDrafts(), { name: "NotFoundError" });
  assert.equal(calls, 1); assert.equal(connections.length, 1); mock.mock.restore();
  assert.deepEqual((await storage.getRigDraft(doc.id)).document, doc); assert.equal(connections.length, 1);
});

test("concurrent save and reads share one replacement connection after a cached connection closes", async () => {
  const { storage, connections } = await connectionFixture(), doc = document();
  await storage.saveRigDraft(doc); connections[0].close();
  const edited = { ...doc, name: "Concurrent pending correction" };
  const [, loaded, list] = await Promise.all([storage.saveRigDraft(edited), storage.getRigDraft(doc.id), storage.listRigDrafts()]);
  assert.equal(connections.length, 2); assert.deepEqual(loaded.document, edited); assert.equal(list[0].name, edited.name);
});

test("two resources imported from the same authoring package have independent draft keys", async () => {
  const storage = await fixture();
  const first = document("First resource"), second = document("Second resource");
  second.joints.find((joint) => joint.id === "head").x += 4;
  const a = await storage.saveRigDraft(first, { resourceId: "R1", resourceUpdatedAt: revision });
  const b = await storage.saveRigDraft(second, { resourceId: "R2", resourceUpdatedAt: "second-revision" });
  assert.equal(a.id, "resource-R1"); assert.equal(b.id, "resource-R2");
  assert.equal(a.documentId, first.id); assert.equal(b.documentId, first.id);
  assert.equal(a.resourceUpdatedAt, revision); assert.equal(b.resourceUpdatedAt, "second-revision");
  assert.deepEqual((await storage.getRigDraft(a.id)).document, first);
  assert.deepEqual((await storage.getRigDraft(b.id)).document, second);
  assert.equal(await storage.getRigDraft(first.id), null, "document ID is not a resource-scoped draft key");
  await storage.saveRigDraft({ ...first, name: "First edited" }, { resourceId: "R1", resourceUpdatedAt: revision });
  assert.equal((await storage.getRigDraft(b.id)).document.name, "Second resource");
  assert.equal((await storage.listRigDrafts()).length, 2);
});

test("only the exact still-active source revision permits saving back to the same resource", async () => {
  const { rigDraftDestination } = await fixture();
  const draft = { resourceId: "R1", resourceUpdatedAt: revision };
  const resources = [{ id: "R1", updatedAt: revision, name: "Latest calibrated character" }], before = structuredClone(resources);
  assert.deepEqual(rigDraftDestination(draft, resources), { resourceId: "R1", resourceUpdatedAt: revision, forked: false, notice: "" });
  for (const [candidate, current] of [
    [draft, [{ ...resources[0], updatedAt: "2026-10-20T12:01:00.123Z" }]],
    [draft, [{ ...resources[0], deletedAt: "2026-10-20T12:02:00.000Z" }]],
    [draft, []], [{ resourceId: "R1" }, resources],
    [{ resourceId: "R1", resourceUpdatedAt: "" }, resources],
    [{ resourceId: "R1", resourceUpdatedAt: "   " }, resources],
  ]) {
    const result = rigDraftDestination(candidate, current);
    assert.equal(result.resourceId, null); assert.equal(result.resourceUpdatedAt, null); assert.equal(result.forked, true);
    assert.match(result.notice, /旧草稿将另存为新资源/);
  }
  assert.deepEqual(resources, before); assert.deepEqual(draft, { resourceId: "R1", resourceUpdatedAt: revision });
  assert.deepEqual(rigDraftDestination({ resourceId: null }, resources), { resourceId: null, resourceUpdatedAt: null, forked: false, notice: "" });
});

test("saving a linked resource atomically moves the explicitly chosen unlinked draft", async () => {
  const storage = await fixture(), doc = document();
  const original = await storage.saveRigDraft(doc);
  const linked = await storage.saveRigDraft(doc, { resourceId: "R1", resourceUpdatedAt: revision, previousDraftId: original.id });
  assert.equal(linked.id, "resource-R1"); assert.equal(linked.documentId, doc.id);
  assert.equal(await storage.getRigDraft(original.id), null);
  assert.deepEqual((await storage.getRigDraft(linked.id)).document, doc);
  const raw = await rawDrafts();
  assert.deepEqual(raw.metadata.map((record) => record.id), [linked.id]);
  assert.deepEqual(raw.documents.map((record) => record.id), [linked.id]);
  // Retrying the same completed move is idempotent even when the prior key is gone.
  await storage.saveRigDraft(doc, { resourceId: "R1", resourceUpdatedAt: revision, previousDraftId: original.id });
  assert.equal((await storage.listRigDrafts()).length, 1);
});

test("a failed migration restores both the old draft and the preexisting destination", async () => {
  const storage = await fixture(), doc = document("Unsaved changes");
  const original = await storage.saveRigDraft(doc);
  const destination = await storage.saveRigDraft(document("Previous destination"), { resourceId: "R1", resourceUpdatedAt: revision });
  const before = await rawDrafts(), remove = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function (...args) {
    if (this.name === "documents" && args[0] === original.id) throw new Error("injected migration failure");
    return remove.apply(this, args);
  };
  try {
    await assert.rejects(storage.saveRigDraft({ ...doc, name: "New attempt" }, {
      resourceId: "R1", resourceUpdatedAt: "new-revision", previousDraftId: original.id,
    }), /injected migration failure/);
  } finally { IDBObjectStore.prototype.delete = remove; }
  assert.deepEqual(await rawDrafts(), before);
  assert.equal((await storage.getRigDraft(original.id)).name, "Unsaved changes");
  assert.equal((await storage.getRigDraft(destination.id)).name, "Previous destination");
});

test("an ordinary resource update never removes unrelated drafts sharing old or new document IDs", async () => {
  const storage = await fixture(), old = document("Independent original draft"), next = document("Independent next draft", "next-document");
  await storage.saveRigDraft(old); await storage.saveRigDraft(next);
  const resource = await storage.saveRigDraft({ ...old, name: "Resource snapshot" }, { resourceId: "R1", resourceUpdatedAt: revision });
  await storage.saveRigDraft({ ...next, name: "Updated resource snapshot" }, { resourceId: "R1", resourceUpdatedAt: "new-revision" });
  assert.equal((await storage.getRigDraft(old.id)).name, old.name);
  assert.equal((await storage.getRigDraft(next.id)).name, next.name);
  assert.equal((await storage.getRigDraft(resource.id)).documentId, next.id);
  assert.equal((await storage.listRigDrafts()).length, 3);
});

test("legacy resource-linked drafts without a source revision restore as safe new-resource forks", async () => {
  const storage = await fixture(), doc = document();
  const metadata = await storage.saveRigDraft(doc, { resourceId: "R1" });
  const reloaded = await storage.getRigDraft(metadata.id);
  const destination = storage.rigDraftDestination(reloaded, [{ id: "R1", updatedAt: revision }]);
  assert.equal(destination.resourceId, null); assert.equal(destination.forked, true);
  assert.match(destination.notice, /旧草稿将另存为新资源/);
  assert.deepEqual(reloaded.document, doc);
});

test("the actual resource entry restores flushed authored changes after reload without reapplying archived atlas pixels", async () => {
  const storage = await fixture(), record = await resourceRecord(), archived = readRigAuthoring(record.files);
  await storage.saveRigDraft(archived, { resourceId: record.id, resourceUpdatedAt: record.updatedAt });
  const edited = structuredClone(archived);
  edited.motions[0].poses[1].angles.leftThigh = -43.411768;
  edited.joints.find((joint) => joint.id === "head").x += 3;
  edited.parts[0].image = partArtwork("#bd57eb"); edited.parts[0].imageSource = "calibrated";
  let flushed = false;
  const entry = resourceEntry(storage, { flush: async () => {
    await storage.saveRigDraft(edited, { resourceId: record.id, resourceUpdatedAt: record.updatedAt }); flushed = true;
  } });
  await entry.open(record);
  assert.equal(flushed, true); assert.deepEqual(entry.errors, []); assert.equal(entry.calibrationCalls.length, 0);
  assert.deepEqual(entry.opened[0].document, edited, "draft motion, joints and newly calibrated independent art all win over the archive");
  assert.deepEqual(entry.opened[0].options, { resourceId: "R1", resourceUpdatedAt: revision, draftId: "resource-R1",
    draftUpdatedAt: (await storage.getRigDraft("resource-R1")).updatedAt });
  // The workbench's initial onDraftChange must write back what was restored,
  // rather than persisting a stale archive snapshot over these authored edits.
  await storage.saveRigDraft(entry.opened[0].document, entry.opened[0].options);
  const reloaded = await import(`../src/infrastructure/rig-draft-repository.js?reload=${crypto.randomUUID()}`), reopened = resourceEntry(reloaded);
  await reopened.open(record);
  assert.deepEqual(reopened.opened[0].document, edited); assert.equal(reopened.calibrationCalls.length, 0);
  assert.equal(readRigAuthoring(record.files).motions[0].poses[1].angles.leftThigh, 49, "opening does not mutate the saved archive");
  assert.equal((await reloaded.getRigDraft("resource-R1")).document.motions[0].poses[1].angles.leftThigh, -43.411768);
  assert.deepEqual(entry.busy, [true, false]); assert.equal((await reloaded.listRigDrafts()).length, 1);
});

test("editor-to-rig entry preserves all pending action plans when only the preview thumbnail changed", async () => {
  const drafts = await fixture(), resources = await import(`../src/infrastructure/project-repository.js?entry=${crypto.randomUUID()}`);
  const record = await resources.saveProject(await resourceRecord()), edited = readRigAuthoring(record.files);
  edited.motions = ["attack", "hit", "skill", "run", "death", "stun"].map((id) => ({ id, name: id, duration: 1, loop: false, poses: [{ time: 0 }, { time: 1 }] }));
  edited.motionStudies = Object.fromEntries(edited.motions.map((motion) => [motion.id, {
    motionId: motion.id, baseFingerprint: "a".repeat(64), geometryFingerprint: "b".repeat(64),
    protectedIdleFingerprint: "c".repeat(64), originalArtworkFingerprint: "d".repeat(64),
    frames: [{ id: "base", time: 0, image: partArtwork("#6677cc"), review: { approved: true }, mappingReview: { approved: true } },
      { id: "strike", time: .5, image: partArtwork("#e85439"), review: { approved: true }, mappingReview: { approved: false } },
      { id: "end", time: 1, imageRef: "base", review: { approved: false }, mappingReview: { approved: false } }],
  }]));
  await drafts.saveRigDraft(edited, { resourceId: record.id, resourceUpdatedAt: record.updatedAt });
  const expected = (await drafts.getRigDraft("resource-R1")).document;
  const before = await resources.getProject(record.id), entry = resourceEntry(drafts, { page: "editor",
    persist: () => resources.saveProject({ ...structuredClone(record), thumbnail: partArtwork("#5533ee") }) });
  await entry.open(record);
  assert.deepEqual(entry.errors, []); assert.equal(entry.calibrationCalls.length, 0);
  assert.deepEqual(entry.opened[0].document, expected); assert.equal(Object.keys(entry.opened[0].document.motionStudies).length, 6);
  assert.deepEqual(await resources.getProject(record.id), before, "preview recapture is not an authored resource revision");
  assert.deepEqual((await drafts.listRigDrafts()).map((draft) => draft.id), ["resource-R1"], "no independent fork or replacement archive is created");
  await drafts.saveRigDraft(entry.opened[0].document, entry.opened[0].options);
  const reloaded = await import(`../src/infrastructure/rig-draft-repository.js?reload=${crypto.randomUUID()}`);
  assert.deepEqual((await reloaded.getRigDraft("resource-R1")).document.motionStudies, edited.motionStudies);
});

test("a resource version conflict keeps the old authoring draft independently and opens the latest calibrated pixels", async () => {
  const storage = await fixture(), record = await resourceRecord("2026-10-20T13:00:00.000Z"), old = readRigAuthoring(record.files);
  old.motions[0].poses[1].angles.leftThigh = -43.411768;
  old.parts[0].image = partArtwork("#bd57eb");
  await storage.saveRigDraft(old, { resourceId: record.id, resourceUpdatedAt: revision });
  const bundle = parseBundle(record.files), region = bundle.parts.find((part) => part.id === old.parts[0].id);
  const replacement = createCanvas(region.originalWidth, region.originalHeight), context = replacement.getContext("2d");
  context.fillStyle = "#e85439"; context.fillRect(2, 2, Math.max(1, replacement.width - 4), Math.max(1, replacement.height - 4));
  record.edits[region.id] = { image: new Uint8Array(replacement.toBuffer("image/png")), transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } };
  const expected = await rigWithCalibratedParts(readRigAuthoring(record.files), bundle, record.edits, pixelEnv);
  const entry = resourceEntry(storage); await entry.open(record);
  assert.deepEqual(entry.errors, []); assert.equal(entry.calibrationCalls.length, 1);
  assert.deepEqual(entry.opened[0].document, expected, "the fresh archive path materializes current ordinary-editor calibration");
  assert.equal(entry.opened[0].document.motions[0].poses[1].angles.leftThigh, 49);
  assert.notEqual(entry.opened[0].document.parts[0].image, old.parts[0].image);
  assert.match(entry.notices[0], /已单独保留/);
  const drafts = await storage.listRigDrafts(), independent = drafts.find((item) => !item.resourceId);
  assert.ok(independent); const preserved = await storage.getRigDraft(independent.id);
  assert.equal(preserved.document.motions[0].poses[1].angles.leftThigh, -43.411768);
  assert.equal(preserved.document.parts[0].image, old.parts[0].image); assert.equal(preserved.document.ownerResourceId, undefined);
  await storage.saveRigDraft(entry.opened[0].document, entry.opened[0].options);
  assert.equal((await storage.getRigDraft(independent.id)).document.motions[0].poses[1].angles.leftThigh, -43.411768, "subsequent resource autosave cannot overwrite the independent preserved draft");
  assert.deepEqual((await storage.getRigDraft("resource-R1")).document, expected);
  assert.equal((await storage.listRigDrafts()).length, 2);
});

test("matching resource metadata cannot restore a draft owned by another imported resource", async () => {
  const storage = await fixture(), record = await resourceRecord(), wrongOwner = readRigAuthoring(record.files);
  wrongOwner.ownerResourceId = "R2"; wrongOwner.motions[0].poses[1].angles.leftThigh = -43.411768;
  await storage.saveRigDraft(wrongOwner, { resourceId: "R1", resourceUpdatedAt: revision });
  const entry = resourceEntry(storage); await entry.open(record);
  assert.deepEqual(entry.errors, []); assert.equal(entry.calibrationCalls.length, 1);
  assert.equal(entry.opened[0].document.ownerResourceId, "R1");
  assert.equal(entry.opened[0].document.motions[0].poses[1].angles.leftThigh, 49);
  const independent = (await storage.listRigDrafts()).find((item) => !item.resourceId);
  assert.ok(independent); assert.equal((await storage.getRigDraft(independent.id)).document.motions[0].poses[1].angles.leftThigh, -43.411768);
});

test("failure to preserve a conflicting draft prevents opening and replacing its autosave key", async () => {
  const storage = await fixture(), record = await resourceRecord("new-resource-revision"), old = readRigAuthoring(record.files);
  old.motions[0].poses[1].angles.leftThigh = -43.411768;
  await storage.saveRigDraft(old, { resourceId: "R1", resourceUpdatedAt: revision });
  const entry = resourceEntry(storage, { saveDraft: async () => { throw new Error("draft storage unavailable"); } });
  await entry.open(record);
  assert.equal(entry.opened.length, 0); assert.match(entry.errors[0], /draft storage unavailable/);
  assert.deepEqual((await storage.getRigDraft("resource-R1")).document, old); assert.deepEqual(entry.busy, [true, false]);
});

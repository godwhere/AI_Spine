import test from "node:test";
import assert from "node:assert/strict";
import { createSaveCoordinator } from "../src/application/save-coordinator.js";
import { createEditorSession } from "../src/application/editor-session.js";
import { attachSaveExitGuards } from "../src/application/exit-guards.js";
import { sameAuthoredProjectContent } from "../shared/domain/project.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const content = (a, b) => a.name === b.name;
const edit = (name, localRevision, sessionKey = "A") => ({ sessionKey, localRevision, snapshot: { id: "resource", name } });
function fixture(repository) {
  const statuses = [], commits = [], errors = [], timers = new Set();
  const writer = createSaveCoordinator({ repository, sameContent: content, onStatus: (value) => statuses.push(value),
    onSaved: (receipt, value) => commits.push({ receipt, value }), onError: (error, value) => errors.push({ error, value }),
    schedule: (callback) => { timers.add(callback); return callback; }, cancel: (callback) => timers.delete(callback) });
  writer.openSession({ sessionKey: "A", entityId: "resource", expectedVersion: "v1", persisted: true });
  return { writer, statuses, commits, errors, timers };
}

test("A in flight coalesces B/C and a navigation flush waits for the latest confirmed revision", async () => {
  const a = deferred(), c = deferred(), calls = [];
  const { writer } = fixture({ save: (snapshot, options) => { calls.push({ snapshot, options }); return calls.length === 1 ? a.promise : c.promise; } });
  writer.enqueue(edit("A", 1)); const flush = writer.flush("A");
  writer.enqueue(edit("B", 2)); writer.enqueue(edit("C", 3));
  assert.equal(writer.flush("A"), flush); assert.equal(calls.length, 1);
  a.resolve({ updatedAt: "v2" }); await Promise.resolve(); await Promise.resolve();
  assert.equal(writer.hasUnsaved("A"), true); assert.notEqual(writer.getStatus("A").status, "saved");
  assert.deepEqual(calls.map((call) => call.snapshot.name), ["A", "C"]);
  assert.equal(calls[1].options.expectedVersion, "v2");
  c.resolve({ updatedAt: "v3" }); await flush;
  assert.equal(writer.hasUnsaved(), false); assert.equal(writer.getStatus("A").confirmedRevision, 3);
});

test("two sessions sharing one entity serialize but retain independent base versions", async () => {
  const first = deferred(), calls = [];
  const { writer } = fixture({ save: async (snapshot, options) => {
    calls.push(options.expectedVersion);
    if (snapshot.name === "A") return first.promise;
    throw Object.assign(new Error("conflict"), { code: "RESOURCE_CHANGED" });
  } });
  writer.openSession({ sessionKey: "B", entityId: "resource", expectedVersion: "v1", persisted: true });
  writer.enqueue(edit("A", 1)); const a = writer.flush("A");
  writer.enqueue(edit("B", 1, "B")); const b = writer.flush("B"); const rejected = assert.rejects(b, /conflict/);
  assert.deepEqual(calls, ["v1"]); first.resolve({ updatedAt: "v2" }); await a; await rejected;
  assert.deepEqual(calls, ["v1", "v1"]); assert.equal(writer.getStatus("A").status, "saved");
  assert.equal(writer.getStatus("B").status, "failed"); assert.equal(writer.hasUnsaved("B"), true);
});

test("failed snapshots survive; background flush does not retry a conflict", async () => {
  let calls = 0;
  const { writer, timers } = fixture({ save: async () => { calls++; throw Object.assign(new Error("deleted"), { code: "RESOURCE_DELETED" }); } });
  writer.enqueue(edit("local", 1)); await assert.rejects(writer.flush("A"), /deleted/);
  writer.enqueue(edit("newer local", 2)); for (const callback of timers) callback();
  await assert.rejects(writer.flush("A", { retry: false }), /deleted/);
  assert.equal(calls, 1); assert.equal(writer.hasUnsaved(), true);
});

test("a lost receipt reads back matching authored content without resubmitting", async () => {
  let saves = 0;
  const { writer } = fixture({ save: async () => { saves++; throw new Error("connection lost"); },
    get: async () => ({ id: "resource", name: "submitted", updatedAt: "v2" }) });
  writer.enqueue(edit("submitted", 1)); await writer.flush("A");
  assert.equal(saves, 1); assert.equal(writer.getStatus("A").version, "v2"); assert.equal(writer.hasUnsaved(), false);
});

test("a lost receipt never acknowledges or overwrites another client's newer content", async () => {
  let saves = 0;
  const { writer } = fixture({ save: async () => { saves++; throw new Error("connection lost"); },
    get: async () => ({ name: "other client", updatedAt: "v3" }) });
  writer.enqueue(edit("local", 1)); await assert.rejects(writer.flush("A"), /connection lost/);
  assert.equal(saves, 1); assert.equal(writer.getStatus("A").version, "v1"); assert.equal(writer.hasUnsaved(), true);
});

test("an older failed write retains the newest pending snapshot for an explicit retry", async () => {
  const first = deferred(), calls = [];
  const { writer } = fixture({ save: async (snapshot) => { calls.push(snapshot.name); return calls.length === 1 ? first.promise : { updatedAt: "v2" }; } });
  writer.enqueue(edit("old", 1)); const flush = writer.flush("A"); writer.enqueue(edit("new", 2));
  first.reject(new Error("offline")); await assert.rejects(flush, /offline/);
  await writer.flush("A"); assert.deepEqual(calls, ["old", "new"]); assert.equal(writer.hasUnsaved(), false);
});

test("an unknown commit is rechecked before retry and cannot overwrite a newer remote record", async () => {
  let saves = 0, readable = false;
  const { writer } = fixture({ save: async () => { saves++; throw new Error("response lost"); },
    get: async () => { if (!readable) throw new Error("offline"); return { name: "another editor", updatedAt: "v3" }; } });
  writer.enqueue(edit("local", 1)); await assert.rejects(writer.flush("A"), /response lost/);
  readable = true;
  await assert.rejects(writer.flush("A"), { code: "RESOURCE_CHANGED" });
  assert.equal(saves, 1); assert.equal(writer.hasUnsaved(), true);
});

test("a newly created record with an unknown receipt is recovered before applying newer edits", async () => {
  let saves = 0, readable = false, record;
  const { writer } = fixture({ save: async (snapshot, { expectedVersion }) => {
    saves++; if (saves === 1) { record = { ...snapshot, updatedAt: "v1" }; throw new Error("response lost"); }
    assert.equal(expectedVersion, "v1"); return record = { ...snapshot, updatedAt: "v2" };
  }, get: async () => { if (!readable) throw new Error("offline"); return record; } });
  writer.openSession({ sessionKey: "new", entityId: "new-resource" });
  writer.enqueue({ sessionKey: "new", localRevision: 0, snapshot: { id: "new-resource", name: "first" } });
  await assert.rejects(writer.flush("new"), /response lost/);
  readable = true; writer.enqueue({ sessionKey: "new", localRevision: 1, snapshot: { id: "new-resource", name: "latest" } });
  await writer.flush("new"); assert.equal(saves, 2); assert.equal(record.name, "latest");
});

test("an unknown create with no visible record is retained without an unconditional resend", async () => {
  let saves = 0;
  const { writer } = fixture({ save: async () => { saves++; throw new Error("lost response"); }, get: async () => null });
  writer.openSession({ sessionKey: "new", entityId: "new-resource" });
  writer.enqueue({ sessionKey: "new", localRevision: 0, snapshot: { id: "new-resource", name: "local" } });
  await assert.rejects(writer.flush("new"), /lost response/);
  await assert.rejects(writer.flush("new"), { code: "SAVE_UNCONFIRMED" });
  assert.equal(saves, 1); assert.equal(writer.hasUnsaved("new"), true);
});

test("a V1 unknown commit keeps read-back recovery after the repository advertises native receipts", async () => {
  let native = false, reads = 0; const calls = [];
  const { writer } = fixture({ usesMutationReceipts: () => native, save: async (snapshot, context) => {
    calls.push({ name: snapshot.name, version: context.expectedVersion });
    if (snapshot.name === "A") { native = true; throw Object.assign(new Error("V1 receipt lost"), { mutationReceipts: false }); }
    return { ...snapshot, updatedAt: "v3" };
  }, get: async () => { if (++reads === 1) throw new Error("Read temporarily unavailable"); return { id: "resource", name: "A", updatedAt: "v2" }; } });
  writer.enqueue(edit("A", 1)); await assert.rejects(writer.flush("A"), /V1 receipt lost/);
  writer.enqueue(edit("C", 2)); await writer.flush("A");
  assert.deepEqual(calls, [{ name: "A", version: "v1" }, { name: "C", version: "v2" }]);
  assert.equal(reads, 2); assert.equal(writer.getStatus("A").version, "v3"); assert.equal(writer.hasUnsaved(), false);
});

test("local editor revisions ignore thumbnails and retain shared immutable image bytes", () => {
  const bytes = new Uint8Array([1, 2]), record = { id: "resource", name: "Initial", files: { "image.png": bytes } };
  const session = createEditorSession({ key: "editor", entityId: record.id, sameContent: sameAuthoredProjectContent });
  assert.equal(session.update(record).localRevision, 0);
  assert.equal(session.update({ ...record, thumbnail: "preview" }).localRevision, 0);
  const edit = session.update({ ...record, name: "Authored" });
  assert.equal(edit.localRevision, 1); assert.equal(edit.snapshot.files["image.png"], bytes);
});

test("ordinary save exit guards flush early and retain refresh protection until the receipt", async () => {
  const commit = deferred(), { writer } = fixture({ save: () => commit.promise });
  const window = new EventTarget(), document = new EventTarget(); document.visibilityState = "hidden";
  const detach = attachSaveExitGuards(writer, { window, document });
  writer.enqueue(edit("pending", 1)); document.dispatchEvent(new Event("visibilitychange"));
  const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); commit.resolve({ updatedAt: "v2" }); await writer.flush("A");
  const saved = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(saved);
  assert.equal(saved.defaultPrevented, false); detach(); writer.dispose();
});

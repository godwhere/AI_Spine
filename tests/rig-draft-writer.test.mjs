import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRigDraftWriter, attachRigDraftExitGuards } from "../src/core/rig-draft-writer.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(save) {
  const statuses = [], errors = [], commits = [], timers = new Set();
  const writer = createRigDraftWriter({ save, onStatus: (value) => statuses.push(value), onError: (error) => errors.push(error),
    onSaved: (metadata, value) => commits.push({ metadata, value }),
    schedule: (callback) => { timers.add(callback); return callback; }, cancel: (callback) => timers.delete(callback) });
  writer.setSession("A");
  return { writer, statuses, errors, commits, timers };
}
const draft = (name, sessionKey = "A") => ({ document: { id: `rig-${sessionKey}`, name }, sessionKey, resourceId: `resource-${sessionKey}`, resourceUpdatedAt: `revision-${sessionKey}` });

test("debounced edits coalesce, but saved status waits for the actual transaction", async () => {
  const commit = deferred(), calls = [], { writer, statuses, commits, timers } = fixture((...args) => { calls.push(args); return commit.promise; });
  writer.enqueue(draft("first")); writer.enqueue(draft("latest approved study"));
  assert.equal(timers.size, 1); assert.equal(writer.hasUnsaved(), true); assert.equal(statuses.at(-1).status, "pending");
  const flushing = writer.flush(); assert.equal(timers.size, 0); assert.equal(statuses.at(-1).status, "saving");
  assert.equal(calls.length, 1); assert.equal(calls[0][0].name, "latest approved study");
  assert.deepEqual(calls[0][1], { resourceId: "resource-A", resourceUpdatedAt: "revision-A" });
  assert.equal(commits.length, 0); assert.equal(writer.hasUnsaved(), true);
  commit.resolve({ id: "resource-resource-A" }); await flushing;
  assert.equal(commits.length, 1); assert.equal(writer.hasUnsaved(), false); assert.equal(statuses.at(-1).status, "saved");
});

test("navigation flush drains edits arriving during a write in serial order", async () => {
  const first = deferred(), second = deferred(), calls = [], { writer } = fixture((document) => { calls.push(document.name); return calls.length === 1 ? first.promise : second.promise; });
  writer.enqueue(draft("first")); const flushing = writer.flush();
  writer.enqueue(draft("second")); assert.equal(writer.flush(), flushing);
  first.resolve({ id: "A" }); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls, ["first", "second"]); assert.equal(writer.hasUnsaved(), true);
  second.resolve({ id: "A" }); await flushing;
  assert.equal(writer.hasUnsaved(), false);
});

test("failed drafts survive a session switch and retry without accepting old-session callbacks", async () => {
  const calls = [], failure = new Error("disk full"); let fail = true;
  const { writer, statuses, errors } = fixture(async (document) => { calls.push(document.name); if (fail) throw failure; return { id: document.id }; });
  writer.enqueue(draft("preserve old session")); await assert.rejects(writer.flush(), /disk full/);
  assert.equal(writer.hasUnsaved(), true); assert.equal(statuses.at(-1).status, "failed"); assert.equal(errors.length, 1);
  writer.setSession("B"); assert.equal(writer.enqueue(draft("late wrong session")), false);
  writer.enqueue(draft("new session", "B")); fail = false; await writer.flush();
  assert.deepEqual(calls, ["preserve old session", "preserve old session", "new session"]);
  assert.equal(writer.hasUnsaved(), false); assert.equal(statuses.at(-1).status, "saved");
  writer.setSession(null); assert.equal(writer.enqueue(draft("after leave", "B")), false);
});

test("a failed old write cannot replace a newer pending document", async () => {
  const first = deferred(), calls = [], { writer } = fixture(async (document) => { calls.push(document.name); if (calls.length === 1) return first.promise; return { id: "A" }; });
  writer.enqueue(draft("old")); const flushing = writer.flush(); writer.enqueue(draft("new"));
  first.reject(new Error("interrupted")); await assert.rejects(flushing, /interrupted/); await writer.flush();
  assert.deepEqual(calls, ["old", "new"]); assert.equal(writer.hasUnsaved(), false);
});

test("refresh confirmation remains active through pending, failed and in-flight writes", async () => {
  const windowTarget = new EventTarget(), documentTarget = new EventTarget(); documentTarget.visibilityState = "visible";
  const commit = deferred(), { writer } = fixture(() => commit.promise);
  const detach = attachRigDraftExitGuards(writer, { window: windowTarget, document: documentTarget });
  const unload = () => { const event = new Event("beforeunload", { cancelable: true }); windowTarget.dispatchEvent(event); return event; };
  assert.equal(unload().defaultPrevented, false);
  writer.enqueue(draft("still writing")); assert.equal(unload().defaultPrevented, true); assert.equal(unload().defaultPrevented, true);
  commit.reject(new Error("unavailable")); await assert.rejects(writer.flush(), /unavailable/);
  assert.equal(writer.hasUnsaved(), true);
  // A failed write is retried on unload and remains protected, not reported saved.
  assert.equal(unload().defaultPrevented, true); await assert.rejects(writer.flush(), /unavailable/);
  detach(); assert.equal(unload().defaultPrevented, false); writer.dispose();
});

test("background/pagehide starts an early flush and unload stops blocking only after commit", async () => {
  const windowTarget = new EventTarget(), documentTarget = new EventTarget(); documentTarget.visibilityState = "visible";
  let commit = deferred(), calls = 0;
  const { writer } = fixture(() => { calls++; return commit.promise; });
  const detach = attachRigDraftExitGuards(writer, { window: windowTarget, document: documentTarget });
  writer.enqueue(draft("hidden document")); documentTarget.visibilityState = "hidden"; documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 1); commit.resolve({ id: "A" }); await writer.flush();
  const event = new Event("beforeunload", { cancelable: true }); windowTarget.dispatchEvent(event); assert.equal(event.defaultPrevented, false);
  commit = deferred(); writer.enqueue(draft("page hide")); windowTarget.dispatchEvent(new Event("pagehide")); assert.equal(calls, 2);
  commit.resolve({ id: "A" }); await writer.flush(); detach(); writer.dispose();
});

test("the App callback captures its own session and cannot relabel stale documents", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const callbackSource = source.slice(source.indexOf("  const updateRigDraft ="), source.indexOf("  useEffect(() => {\n    rigDraftMounted"));
  const factory = new Function("useCallback", "rigSessionRef", "rigDraftWriter", "rigSession", `${callbackSource}; return onRigDraftChange;`);
  const queued = [], session = { current: { key: "A", resourceId: "R1", resourceUpdatedAt: "old" } }, writer = { current: { enqueue: (value) => queued.push(value) } };
  const oldCallback = factory((callback) => callback, session, writer, session.current);
  session.current = { key: "B", resourceId: "R2", resourceUpdatedAt: "current", authoringId: "rig-R2" };
  const currentCallback = factory((callback) => callback, session, writer, session.current);
  const document = { id: "old-doc", name: "Approved action studies", joints: [], parts: [], motions: [] };
  oldCallback(document); assert.equal(queued.length, 0);
  currentCallback(document); assert.equal(queued.length, 1);
  assert.deepEqual(queued[0], { document: { ...document, id: "rig-R2", ownerResourceId: "R2" }, sessionKey: "B", resourceId: "R2", resourceUpdatedAt: "current" });
  session.current = null; currentCallback(document); assert.equal(queued.length, 1);
});

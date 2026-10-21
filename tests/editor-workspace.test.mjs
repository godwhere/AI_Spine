import test from "node:test";
import assert from "node:assert/strict";
import { createEditorWorkspace } from "../src/application/editor-workspace.js";
import { createEditorPersistence } from "../src/application/editor-persistence.js";
import { createRigSession } from "../src/application/rig-session.js";
import { createNavigation } from "../src/application/navigation.js";

const pixels = new Uint8Array([1, 2, 3]);
const bundle = { name: "Fixture", parts: [{ id: "body" }, { id: "hand" }], animations: ["idle"],
  files: { "body.png": pixels }, skeletonPath: "rig.json" };
function fixture(repository) {
  const records = new Map(), writes = [], states = [];
  const writer = createEditorPersistence({ repository: repository || {
    get: async (id) => records.get(id),
    save: async (record, { expectedVersion }) => {
      assert.equal(expectedVersion, records.get(record.id)?.updatedAt);
      const saved = { ...record, updatedAt: `version-${writes.length + 1}` };
      writes.push(saved); records.set(saved.id, saved); return saved;
    },
  }, schedule: () => 0, cancel() {} });
  let id = 0;
  const workspace = createEditorWorkspace({ getWriter: () => writer, createId: () => `id-${++id}` });
  workspace.subscribe((snapshot) => states.push(snapshot));
  return { workspace, writer, writes, records, states };
}

test("editor owns immutable image history while rename and generation survive undo and redo", async () => {
  const { workspace: editor, writes } = fixture();
  editor.open(bundle, { isDraft: true }); assert.equal(editor.queue(), null);
  editor.changeEdits({ body: { image: pixels, transform: { x: 1 } } }, bundle, "body");
  editor.patch({ name: "Authored", generation: { appearancePrompt: "Keep identity" } });
  assert.equal(editor.undo("hand"), "body");
  assert.equal(editor.getSnapshot().value.name, "Authored");
  assert.equal(editor.getSnapshot().value.generation.appearancePrompt, "Keep identity");
  assert.equal(editor.getSnapshot().canRedo, true);
  assert.equal(editor.redo("body"), "hand");
  assert.equal(editor.getRecord().edits.body.image, pixels);
  assert.equal(editor.getRecord().files, bundle.files);
  await editor.persist(); assert.equal(writes.length, 1);
  editor.undo("body"); await editor.persist(); assert.equal(writes.length, 2);
});

test("abandoned editor callbacks cannot change the next session and unsaved navigation retains the current document", async () => {
  const { workspace: editor, writer, writes } = fixture();
  editor.open(bundle, { isDraft: true }); const first = editor.sessionRef.current;
  editor.patch({ name: "Pending" }); assert.equal(writer.hasUnsaved(first.key), true);
  assert.throws(() => editor.close(), /先保存/); assert.equal(editor.sessionRef.current, first);
  await editor.persist(); editor.close(); editor.open(bundle, { isDraft: true });
  assert.equal(editor.patch({ name: "Late name" }, first.key), false);
  assert.equal(editor.changeEdits({ hand: { image: pixels } }, bundle, "hand", first.key), false);
  assert.equal(editor.getSnapshot().value.name, "Fixture · 新资源");
  assert.equal(editor.getSnapshot().canUndo, false); assert.equal(writes.length, 1);
});

test("unconfirmed save-as retains its fork identity and blocks closing until read-back confirms the write", async () => {
  const records = new Map(), attempts = []; let readable = false;
  const { workspace: editor } = fixture({
    get: async (id) => readable ? records.get(id) : undefined,
    save: async (record) => { attempts.push(record.id); records.set(record.id, { ...record, updatedAt: "committed" }); throw new Error("Lost response"); },
  });
  editor.open(bundle, { id: "original", name: "Retained", updatedAt: "base" });
  await assert.rejects(editor.saveAsNew(), /Lost response/);
  const fork = editor.sessionRef.current.fork;
  assert.throws(() => editor.close(), /另存结果尚未确认/);
  await assert.rejects(editor.persist(), /另存结果尚未确认/);
  assert.equal(editor.getRecord().id, "original");
  readable = true; const saved = await editor.saveAsNew();
  assert.equal(saved.id, fork.entityId); assert.deepEqual(attempts, [fork.entityId]);
  assert.equal(editor.getRecord().id, fork.entityId); assert.equal(editor.getRecord().files, bundle.files);
  assert.equal(editor.getSnapshot().canUndo, false); editor.close();
});

test("undo before the first autosave replaces the pending edit with the current content", async () => {
  const { workspace: editor, writer, writes } = fixture();
  editor.open(bundle, { isDraft: true });
  editor.changeEdits({ body: { image: pixels, transform: { x: 2 } } }, bundle, "body");
  assert.equal(writer.hasUnsaved(editor.sessionRef.current.key), true);
  editor.undo("body"); await editor.persist();
  assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0].edits), []);
  editor.close(); assert.equal(writer.hasUnsaved(), false);
});

test("navigation holds its pending state through asynchronous persistence and releases it after failure", async () => {
  const pending = []; const navigation = createNavigation({ onPending: (value) => pending.push(value) });
  let reject, actions = 0;
  const first = navigation.run(async () => { actions++; await new Promise((_, fail) => { reject = fail; }); });
  assert.equal(await navigation.run(() => actions++), false);
  assert.equal(navigation.pending, true); reject(new Error("Conflict"));
  await assert.rejects(first, /Conflict/); assert.equal(navigation.pending, false);
  await navigation.run(() => actions++); assert.equal(actions, 2);
  assert.deepEqual(pending, [true, false, true, false]);
});

test("rig gesture cancellation restores only its checkpoint and keeps later edits when requested", () => {
  const first = { parts: [{ image: pixels, x: 0 }] }, session = createRigSession(first);
  session.beginGesture(); session.commit({ ...first, x: 4 }, false); session.cancelGesture();
  assert.equal(session.getDocument(), first); assert.equal(session.getSnapshot().canUndo, false);
  session.beginGesture(); const moved = { ...first, x: 8 }; session.commit(moved, false);
  const later = { ...moved, name: "Later" }; session.commit(later);
  session.cancelGesture({ preserveDocument: true });
  assert.equal(session.getDocument(), later); session.undo(); assert.equal(session.getDocument(), moved);
  assert.equal(session.getSnapshot().canUndo, false); session.redo();
  assert.equal(session.getDocument().parts[0].image, pixels);
});

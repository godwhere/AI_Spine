import test from "node:test";
import assert from "node:assert/strict";
import { shouldPersistProject } from "../shared/domain/project.mjs";

const emptyDraft = { project: { id: "draft", isDraft: true, initialName: "功夫熊猫 · 新资源" }, name: "功夫熊猫 · 新资源", edits: {}, generation: {} };
test("opening template previews and AI dialogs without authoring content keeps a temporary draft", () => {
  assert.equal(shouldPersistProject(emptyDraft), false);
  assert.equal(shouldPersistProject({ ...emptyDraft, generation: { appearancePrompt: "  ", partsPrompt: "", appearance: null } }), false);
  assert.equal(shouldPersistProject({ ...emptyDraft, generation: { appearance: { image: new Uint8Array() } } }), false);
  assert.equal(shouldPersistProject({ ...emptyDraft, edits: { part: undefined } }), false);
  assert.equal(shouldPersistProject({ project: null }), false);
});
test("applied artwork, edits, a new name or a written brief make a template draft worth keeping", () => {
  for (const change of [
    { edits: { part: { image: new Uint8Array([1]) } } },
    { name: "我的猴王" },
    { generation: { appearancePrompt: "金色猴子" } },
    { generation: { partsPrompt: "红金护甲" } },
    { generation: { appearance: { image: new Uint8Array([1]) } } },
  ]) assert.equal(shouldPersistProject({ ...emptyDraft, ...change }), true);
});
test("explicit saves, imported projects and previously saved drafts retain normal persistence", () => {
  assert.equal(shouldPersistProject({ ...emptyDraft, explicit: true }), true);
  assert.equal(shouldPersistProject({ ...emptyDraft, project: { id: "imported" } }), true);
  assert.equal(shouldPersistProject({ ...emptyDraft, persisted: true }), true, "undoing all edits does not discard an already saved resource");
});

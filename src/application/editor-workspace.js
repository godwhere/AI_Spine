import { createEditorSession } from "./editor-session.js";
import { editorRecord } from "./project-bundle.js";
import { sameAuthoredProjectContent } from "../../shared/domain/project.mjs";

export function createEditorWorkspace({ getWriter, createId, captureThumbnail = (fallback) => fallback }) {
  let value = null, session = null, undo = [], redo = [], revision = 0;
  let snapshot = { value, session, revision, canUndo: false, canRedo: false };
  const listeners = new Set();
  function publish() {
    snapshot = { value, session, revision: ++revision, canUndo: Boolean(undo.length), canRedo: Boolean(redo.length) };
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  }
  function close() {
    if (session) {
      if (session.fork && getWriter().hasUnsaved(session.fork.key)) throw new Error("另存结果尚未确认，请先重试另存为新资源；当前本地内容仍保留。");
      if (getWriter().hasUnsaved(session.key)) throw new Error("请先保存当前修改，再打开另一份资源。");
      getWriter().discardSession(session.key);
    }
    value = null; session = null; undo = []; redo = []; publish();
  }
  function open(bundle, metadata = {}) {
    close();
    const id = metadata.id || createId(), key = createId();
    session = createEditorSession({ key, entityId: id, sameContent: sameAuthoredProjectContent });
    getWriter().openSession({ sessionKey: key, entityId: id, expectedVersion: metadata.updatedAt, persisted: Boolean(metadata.updatedAt) });
    const name = metadata.name || `${bundle.name} · 新资源`;
    value = { bundle, name,
      project: { id, sessionKey: key, templateId: metadata.templateId, thumbnail: metadata.thumbnail, isDraft: metadata.isDraft === true, initialName: name },
      edits: Object.assign(Object.create(null), metadata.edits || bundle.edits || {}), generation: metadata.generation || bundle.generation || {} };
    getWriter().queueProject(context());
    return publish();
  }
  function patch(fields, key = session?.key) {
    if (!value || key !== session?.key) return false;
    value = { ...value, ...fields }; getWriter().queueProject(context()); publish(); return true;
  }
  const imageSnapshot = (selectedPart) => ({ bundle: value.bundle, edits: value.edits, selectedPart });
  function changeEdits(edits, bundle = value?.bundle, selectedPart, key = session?.key) {
    if (!value || key !== session?.key) return false;
    undo.push(imageSnapshot(selectedPart)); undo = undo.slice(-30); redo = [];
    return patch({ bundle, edits: Object.assign(Object.create(null), edits) });
  }
  function restore(image) {
    patch({ bundle: image.bundle, edits: image.edits });
    return image.bundle.parts.some((part) => part.id === image.selectedPart) ? image.selectedPart : image.bundle.parts[0]?.id || "";
  }
  function context() {
    return { session, project: value?.project, record: value && editorRecord({ ...value, name: value.name }), name: value?.name };
  }
  return {
    getSnapshot: () => snapshot,
    getRecord: () => context().record,
    sessionRef: { get current() { return session; } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    open, close, patch, changeEdits,
    undo(selectedPart) { const previous = undo.pop(); if (!previous || !value) return undefined; redo.push(imageSnapshot(selectedPart)); return restore(previous); },
    redo(selectedPart) { const next = redo.pop(); if (!next || !value) return undefined; undo.push(imageSnapshot(selectedPart)); return restore(next); },
    queue(explicit = false) { return getWriter().queueProject({ ...context(), explicit }); },
    persist(explicit = false, options = {}) { return getWriter().persistProject(context(), { ...options, explicit }); },
    async saveAsNew() {
      const original = session, record = context().record, bundle = value?.bundle;
      if (!original || !record) return null;
      if (!original.fork) {
        original.fork = createEditorSession({ key: createId(), entityId: createId(), sameContent: sameAuthoredProjectContent });
        getWriter().openSession({ sessionKey: original.fork.key, entityId: original.fork.entityId });
      }
      const fork = original.fork;
      getWriter().enqueue(fork.update({ ...record, id: fork.entityId, thumbnail: captureThumbnail(record.thumbnail) }));
      const saved = await getWriter().flush(fork.key);
      getWriter().discardSession(original.key); getWriter().discardSession(fork.key);
      if (session === original) open(bundle, saved);
      return saved;
    },
  };
}

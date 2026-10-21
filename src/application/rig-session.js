// One immutable document owner. Views subscribe to references; history and
// gestures never copy PNGs, and abandoned views cannot mutate a new session.
export function createRigSession(initialDocument, { historyLimit = 30 } = {}) {
  let document = initialDocument, undo = [], redo = [], gesture, revision = 0;
  let snapshot = { document, revision, canUndo: false, canRedo: false };
  const listeners = new Set();
  const publish = () => {
    snapshot = { document, revision: ++revision, canUndo: Boolean(undo.length), canRedo: Boolean(redo.length) };
    for (const listener of listeners) listener(snapshot);
    return document;
  };
  const remember = (notify = true) => {
    undo = [...undo.slice(-(historyLimit - 1)), document]; redo = [];
    if (notify) publish();
  };
  const commit = (next, checkpoint = true) => {
    const value = typeof next === "function" ? next(document) : next;
    if (value === document) return false;
    if (checkpoint) remember(false);
    document = value; publish(); return true;
  };
  return {
    getSnapshot: () => snapshot,
    getDocument: () => document,
    documentRef: { get current() { return document; } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    commit, remember,
    undo() { const value = undo.pop(); if (!value) return false; redo.push(document); document = value; publish(); return true; },
    redo() { const value = redo.pop(); if (!value) return false; undo.push(document); document = value; publish(); return true; },
    beginGesture() { gesture = { document, undo, redo }; remember(); },
    finishGesture() { gesture = undefined; },
    cancelGesture({ preserveDocument = false } = {}) {
      if (!gesture) return false;
      if (preserveDocument) {
        const index = undo.lastIndexOf(gesture.document);
        if (index >= 0) undo = undo.filter((_, i) => i !== index);
      } else { undo = gesture.undo; redo = gesture.redo; document = gesture.document; }
      gesture = undefined; publish(); return true;
    },
  };
}

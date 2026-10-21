import { extractPart, autoFit, identityTransform, drawReplacement, partClipping } from "../../engine/images/calibration.js";

export function createCalibration({ pixels, readReplacement }) {
  return {
    async prepare(bundle, part) {
      const reference = await extractPart(bundle, part, pixels);
      return { reference, createDraft: async () => ({ image: await pixels.encode(reference), fileName: `${part.name}.png`, transform: identityTransform() }) };
    },
    loadImage: pixels.loadImage, readReplacement,
    fit: (bundle, part, bytes) => autoFit(bundle, part, bytes, pixels),
    identityTransform, drawReplacement, partClipping,
  };
}

// Temporary calibration owns its history; applying is the only operation that
// sends an edit back to the project/rig session. PNG bytes remain references.
export function createCalibrationSession(initialDraft) {
  let draft = initialDraft, history = [], future = [];
  let snapshot = { draft, canUndo: false, canRedo: false };
  const listeners = new Set();
  const publish = () => {
    snapshot = { draft, canUndo: Boolean(history.length), canRedo: Boolean(future.length) };
    for (const listener of listeners) listener(snapshot);
  };
  function remember() { if (draft) history = [...history.slice(-39), draft]; future = []; publish(); }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    initialize(value) { if (!draft) { draft = value; publish(); } },
    remember,
    patch(fields, checkpoint = true) {
      if (!draft) return;
      if (checkpoint) remember();
      draft = { ...draft, transform: { ...draft.transform, ...fields } }; publish();
    },
    replace(value) { remember(); draft = value; publish(); },
    undo() { const previous = history.pop(); if (!previous) return; future.push(draft); draft = previous; publish(); },
    redo() { const next = future.pop(); if (!next) return; history.push(draft); draft = next; publish(); },
  };
}

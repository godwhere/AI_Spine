import { browserPixels } from "./rig-pixels.js";
import { createHumanoidDraft as createDraft } from "../../engine/rig/create-draft.js";
import { buildRigFiles as buildFiles } from "../../engine/rig/build-files.js";

export function createHumanoidDraft(options = {}) {
  return createDraft({ ...options, id: options.id === undefined ? `rig-${crypto.randomUUID()}` : options.id });
}
export function buildRigFiles(document, pixels, atlasOptions) {
  return buildFiles(document, { ...browserPixels, ...pixels }, atlasOptions);
}

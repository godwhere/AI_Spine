import { browserPixels } from "./browser-pixels.js";
import { extractPart as extractPartEngine, extractPartFromImage as extractPartFromImageEngine,
  renderReplacement as renderReplacementEngine, autoFit as autoFitEngine, compilePages as compilePagesEngine } from "../../engine/images/calibration.js";

export const extractPart = (bundle, part, pixels = browserPixels) => extractPartEngine(bundle, part, pixels);
export const extractPartFromImage = (image, part, pixels = browserPixels) => extractPartFromImageEngine(image, part, pixels);
export const renderReplacement = (part, edit, pixels = browserPixels) => renderReplacementEngine(part, edit, pixels);
export const autoFit = (bundle, part, bytes, pixels = browserPixels) => autoFitEngine(bundle, part, bytes, pixels);
export const compilePages = (bundle, edits, pixels = browserPixels) => compilePagesEngine(bundle, edits, pixels);

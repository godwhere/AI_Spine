import { browserPixels } from "./browser-pixels.js";
import { createRigPartCalibration as createRigPartCalibrationEngine } from "../../engine/images/rig-images.js";
import { bakeRigPartCalibration as bakeRigPartCalibrationEngine } from "../../engine/images/rig-images.js";
import { composeRigSourceView as composeRigSourceViewEngine } from "../../engine/images/rig-images.js";
import { inspectRigPartAlpha as inspectRigPartAlphaEngine } from "../../engine/images/rig-images.js";
import { readRigPartCandidate as readRigPartCandidateEngine } from "../../engine/images/rig-images.js";

export function createRigPartCalibration(...args) { args[2] = { ...browserPixels, ...args[2] }; return createRigPartCalibrationEngine(...args); }

export function bakeRigPartCalibration(...args) { args[3] = { ...browserPixels, ...args[3] }; return bakeRigPartCalibrationEngine(...args); }

export function composeRigSourceView(...args) { args[1] = { ...browserPixels, ...args[1] }; return composeRigSourceViewEngine(...args); }

export function inspectRigPartAlpha(...args) { args[2] = { ...browserPixels, ...args[2] }; return inspectRigPartAlphaEngine(...args); }

export function readRigPartCandidate(...args) { args[2] = { ...browserPixels, ...args[2] }; return readRigPartCandidateEngine(...args); }

import { readRigImage as decodeRigImage, readRigReference as decodeRigReference } from "../../engine/images/rig-images.js";
export async function readRigImage(file, options) {
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
  return decodeRigImage(bytes, { ...options, type: file.type }, browserPixels);
}
export async function readRigReference(file) {
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
  return decodeRigReference(bytes, { name: file.name, type: file.type }, browserPixels);
}

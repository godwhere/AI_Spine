import { browserPixels } from "./browser-pixels.js";
import { rigWithCalibratedParts as rigWithCalibratedPartsEngine } from "../../engine/images/rig-calibration.js";
import { synchronizeRigAuthoring as synchronizeRigAuthoringEngine } from "../../engine/archive/rig-project.js";

export function rigWithCalibratedParts(...args) { args[3] = { ...browserPixels, ...args[3] }; return rigWithCalibratedPartsEngine(...args); }

export function synchronizeRigAuthoring(...args) { args[2] = { ...browserPixels, ...args[2] }; return synchronizeRigAuthoringEngine(...args); }

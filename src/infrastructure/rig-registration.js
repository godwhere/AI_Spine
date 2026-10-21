import { browserPixels } from "./browser-pixels.js";
import { inspectRigSourceCoverage as inspectRigSourceCoverageEngine } from "../../engine/images/registration.js";
import { expandRigRegistrationBounds as expandRigRegistrationBoundsEngine } from "../../engine/images/registration.js";
import { prepareCompleteOverlapReview as prepareCompleteOverlapReviewEngine } from "../../engine/images/registration.js";
import { measureRigSourceRegistration as measureRigSourceRegistrationEngine } from "../../engine/images/registration.js";
import { registerRigSourcePixels as registerRigSourcePixelsEngine } from "../../engine/images/registration.js";

export function inspectRigSourceCoverage(...args) { args[1] = { ...browserPixels, ...args[1] }; return inspectRigSourceCoverageEngine(...args); }

export function expandRigRegistrationBounds(...args) { args[3] = { ...browserPixels, ...args[3] }; return expandRigRegistrationBoundsEngine(...args); }

export function prepareCompleteOverlapReview(...args) { args[1] = { ...browserPixels, ...args[1] }; return prepareCompleteOverlapReviewEngine(...args); }

export function measureRigSourceRegistration(...args) { args[1] = { ...browserPixels, ...args[1] }; return measureRigSourceRegistrationEngine(...args); }

export function registerRigSourcePixels(...args) { args[2] = { ...browserPixels, ...args[2] }; return registerRigSourcePixelsEngine(...args); }

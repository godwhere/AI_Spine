import { browserPixels } from "./browser-pixels.js";
import { diagnoseMotionStudyFrame as diagnoseMotionStudyFrameEngine } from "../../engine/images/motion-study.js";
import { proposeMotionStudyGapOwnership as proposeMotionStudyGapOwnershipEngine } from "../../engine/images/motion-study.js";
import { proposeCalibratedBaseMotionMapping as proposeCalibratedBaseMotionMappingEngine } from "../../engine/images/motion-study.js";
import { acceptMotionStudyOwnershipCandidate as acceptMotionStudyOwnershipCandidateEngine } from "../../engine/images/motion-study.js";
import { prepareMotionStudyFrames as prepareMotionStudyFramesEngine } from "../../engine/images/motion-study.js";
import { applyMotionStudy as applyMotionStudyEngine } from "../../engine/images/motion-study.js";

export function diagnoseMotionStudyFrame(...args) { args[3] = { ...args[3], pixels: { ...browserPixels, ...args[3]?.pixels } }; return diagnoseMotionStudyFrameEngine(...args); }

export function proposeMotionStudyGapOwnership(...args) { args[3] = { ...args[3], pixels: { ...browserPixels, ...args[3]?.pixels } }; return proposeMotionStudyGapOwnershipEngine(...args); }

export function proposeCalibratedBaseMotionMapping(...args) { args[3] = { ...args[3], pixels: { ...browserPixels, ...args[3]?.pixels } }; return proposeCalibratedBaseMotionMappingEngine(...args); }

export function acceptMotionStudyOwnershipCandidate(...args) { args[4] = { ...args[4], pixels: { ...browserPixels, ...args[4]?.pixels } }; return acceptMotionStudyOwnershipCandidateEngine(...args); }

export function prepareMotionStudyFrames(...args) { args[3] = { ...args[3], pixels: { ...browserPixels, ...args[3]?.pixels } }; return prepareMotionStudyFramesEngine(...args); }

export function applyMotionStudy(...args) { args[2] = { ...args[2], pixels: { ...browserPixels, ...args[2]?.pixels }, now: () => new Date().toISOString() }; return applyMotionStudyEngine(...args); }

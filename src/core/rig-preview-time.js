import { motionStudyKeyTime } from "./rig-motion-studies.js";

// The range control uses 0.01s steps. Accessibility APIs may expose a step as
// its exact Float32 representation; recover only that representation, never a
// nearby arbitrary playback time.
export function rigTimelineInputTime(time) {
  if (!Number.isFinite(time)) return time;
  const stepTime = Math.round(time * 100) / 100;
  return time === Math.fround(stepTime) ? stepTime : time;
}

// Explicitly seeking an authored frame should reach its real compiled key.
// This helper is not used to quantize a running animation clock.
export function rigManualSeekTime(time, study) {
  const frame = study?.frames.find((item) => item.time === time);
  return frame ? motionStudyKeyTime(frame.time) : time;
}

import { generateMotionFrames, mapMotionPoses } from "./motion-study.mjs";

const handlers = {
  appearance: (service, job) => service.generateAppearance(job),
  parts: (service, job) => service.generateParts(job),
  "motion-frames": generateMotionFrames,
  "pose-mapping": mapMotionPoses,
  structure: (service, job) => service.analyze(job),
  registration: (service, job) => service.analyze(job),
  motion: (service, job) => service.analyze(job),
};
export function runRigJob(service, job) {
  const handler = handlers[job.request.kind];
  if (!Object.hasOwn(handlers, job.request.kind)) throw new Error("不支持的骨架任务类型。");
  return handler(service, job);
}

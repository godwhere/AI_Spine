import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { createHumanoidDraft } from "../src/infrastructure/rig-authoring.js";
import { getMotionStudyFingerprints } from "../shared/domain/motion-study.mjs";
import { rigSourceFingerprint } from "../shared/domain/generation.mjs";
import { rigGeometry } from "../shared/domain/rig.mjs";
import { bytesToImageDataURL } from "../shared/codec/image-data.mjs";
import { motionStudyPlan, motionStudyRequest, motionStudySources, motionStudyFrameImage, patchMotionStudyFrame, restoreMotionStudyPlan,
  assertMotionStudyCurrent, assertMotionStudyJob, loadMotionStudyHistory, loadMotionStudyImages, loadMotionStudyMappings, setMotionStudyPlayback } from "../src/application/motion-study.js";
import { validateRigDocument } from "../shared/rig-schema.mjs";

function artwork(color = "#c74a96") {
  const canvas = createCanvas(80, 100), context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(20, 10, 40, 80);
  return new Uint8Array(canvas.toBuffer("image/png"));
}
async function fixture(id = "attack", duration = 1.1, loop = false) {
  const document = createHumanoidDraft({ id: "motion-client", width: 80, height: 100, sourceImage: bytesToImageDataURL(artwork()) });
  const motion = { ...document.motions.find((item) => item.id === "attack"), id, duration, loop, poses: [{ time: 0, angles: {} }, { time: duration, angles: {} }] };
  document.motions = [document.motions[0], motion];
  const fingerprints = await getMotionStudyFingerprints(document), study = motionStudyPlan(document, motion, fingerprints, id === "run" ? 4 : 3);
  document.motionStudies = { [id]: study };
  return { document, motion, study };
}
function jobFor(document, study, kind, frames = motionStudySources(study)) {
  return { id: `job-${kind}`, projectId: document.id, motionId: study.motionId, motion: study.motion, kind, status: "completed", provider: { id: "codex-native", label: "Codex" },
    ...Object.fromEntries(["baseFingerprint", "geometryFingerprint", "protectedIdleFingerprint", "originalArtworkFingerprint"].map((key) => [key, study[key]])),
    geometry: rigGeometry(document), frames: frames.map(({ id, time, label, prompt, sourceFingerprint }) => ({ id, time, label, prompt, sourceFingerprint })) };
}
const imageReader = async (bytes) => ({ dataURL: bytesToImageDataURL(bytes) });

test("run cycles four new poses without inserting idle, death holds its last new pose, and other clips reuse base endpoints", async () => {
  for (const [id, duration, loop, times, reference] of [
    ["run", .8, true, [0, .2, .4, .6, .8], "frame-1"], ["death", 1.3, false, [0, .3, .65, 1.1, 1.3], "frame-3"],
    ["attack", 1.1, false, [0, .198, .418, .825, 1.1], "base"],
  ]) {
    const { document, study } = await fixture(id, duration, loop), before = structuredClone(document);
    assert.deepEqual(study.frames.map((frame) => frame.time), times); assert.equal(study.frames.at(-1).imageRef, reference);
    assert.equal(motionStudySources(study).length, 4); validateRigDocument(document);
    assert.equal(motionStudySources(study).filter((frame) => !frame.reuseBase).length, id === "run" ? 4 : 3);
    if (id === "run") assert.ok(!study.frames.some((frame) => frame.reuseBase));
    assert.deepEqual(document, before); assert.throws(() => motionStudyPlan(document, document.motions[0], study), /idle/);
  }
});

test("generation requests freeze fixed-canvas identity and omit image-heavy authoring data from the rig snapshot", async () => {
  const { document, study } = await fixture(), before = structuredClone(document);
  document.parts[0].image = document.sourceImage; document.parts[0].registrationBase = { image: document.sourceImage };
  const request = motionStudyRequest(document, study, "motion-frames", ["frame-1", "frame-2", "frame-3"]);
  assert.equal(request.version, 1); assert.equal(request.concurrency, 3); assert.equal(request.planner, "codex-native");
  assert.equal(request.frames.length, 3); assert.equal(request.image.width, 80); assert.equal(request.image.height, 100);
  assert.equal(request.rig.sourceImage, undefined); assert.equal(request.rig.motionStudies, undefined);
  assert.equal(request.rig.parts[0].image, undefined); assert.equal(request.rig.parts[0].registrationBase, undefined);
  assert.deepEqual(request.rig.joints, before.joints); assert.deepEqual(request.rig.motions, before.motions);
  assert.equal(document.sourceImage, before.sourceImage); assert.deepEqual(document.motions[0], before.motions[0]);
});

test("loading a single exact PNG resets only that frame review and its held endpoint, preserving other approved pictures", async () => {
  const { document, study } = await fixture("death", 1.3), bytes = artwork("#62b0cf"), dataURL = bytesToImageDataURL(bytes);
  study.frames[1] = { ...study.frames[1], image: document.sourceImage, review: { approved: true, checks: { identity: true } }, mappingReview: { approved: true } };
  const preserved = structuredClone(study.frames[1]), target = study.frames[3], job = jobFor(document, study, "motion-frames", [target]);
  const sourceFingerprint = await rigSourceFingerprint({ sourceImage: dataURL });
  job.images = [{ id: "image-0", frameId: target.id, width: 80, height: 100, sourceFingerprint,
    raw: { id: "image-0-raw", width: 1024, height: 1280 }, normalization: { mode: "uniform-full-canvas" } }];
  const original = structuredClone(document), reads = [];
  const next = await loadMotionStudyImages(document, study, job, { image: async (id, candidate) => { reads.push([id, candidate.id]); return bytes; } }, getMotionStudyFingerprints, imageReader);
  assert.deepEqual(document, original); assert.deepEqual(next.frames[1], preserved); assert.equal(next.frames[3].image, dataURL);
  assert.equal(next.frames[3].review.approved, false); assert.equal(next.frames[3].origin, "ai-motion-frame");
  assert.equal(next.frames[4].sourceFingerprint, sourceFingerprint); assert.equal(motionStudyFrameImage(next, next.frames[4]), dataURL);
  assert.deepEqual(next.frames[3].imageGeneration.raw, job.images[0].raw); assert.deepEqual(reads, [[job.id, "image-0"]]);
  const approved = patchMotionStudyFrame(next, target.id, { review: { approved: true, checks: { identity: true } } });
  assert.equal(approved.frames.at(-1).review.approved, true); assert.equal(approved.frames.at(-1).image, undefined);
});

test("stale source, protected idle, original art, target canvas, and wrong candidate bytes are rejected before any application", async () => {
  const { document, study } = await fixture(), bytes = artwork("#62b0cf"), frame = study.frames[1], job = jobFor(document, study, "motion-frames", [frame]);
  job.images = [{ id: "image-0", frameId: frame.id, width: 80, height: 100, sourceFingerprint: "f".repeat(64) }];
  for (const mutate of [
    (doc) => { doc.sourceImage = bytesToImageDataURL(bytes); },
    (doc) => { doc.motions[0].poses[1].angles.head = 7; },
    (doc) => { doc.parts[0].image = bytesToImageDataURL(bytes); },
    (doc) => { doc.width += 1; },
  ]) {
    const changed = structuredClone(document); mutate(changed);
    await assert.rejects(assertMotionStudyCurrent(changed, study, getMotionStudyFingerprints), /已改变/);
  }
  const original = structuredClone(document);
  await assert.rejects(loadMotionStudyImages(document, study, job, { image: async () => bytes }, getMotionStudyFingerprints, imageReader), /图片与任务指纹/);
  assert.deepEqual(document, original);
});

test("reviewed fixed-canvas frames map to independent parts and repeated endpoints inherit the exact source mapping", async () => {
  const { document, study } = await fixture();
  for (const frame of study.frames) if (!frame.imageRef) { frame.image = document.sourceImage; frame.sourceFingerprint = study.baseFingerprint; frame.review = { approved: true }; }
  const job = jobFor(document, study, "pose-mapping");
  job.result = { mappings: motionStudySources(study).map((frame) => ({ frameId: frame.id, sourceFingerprint: frame.sourceFingerprint,
    joints: document.joints.map(({ id, x, y }) => ({ id, x, y })),
    parts: document.parts.map((part) => ({ partId: part.id, visible: true, z: part.z, sourcePolygon: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 2, y: 4 }] })),
  })) };
  const original = structuredClone(document), next = await loadMotionStudyMappings(document, study, job, getMotionStudyFingerprints);
  assert.deepEqual(document, original); assert.equal(next.frames.at(-1).mapping.frameId, "end");
  assert.deepEqual(next.frames.at(-1).mapping.joints, next.frames[0].mapping.joints);
  assert.ok(next.frames.every((frame) => frame.mappingReview.approved === false));
  validateRigDocument({ ...document, motionStudies: { attack: next } });
  study.frames[1].review.approved = false;
  await assert.rejects(loadMotionStudyMappings(document, study, job, getMotionStudyFingerprints), /审阅状态/);
});

test("a frozen completed job restores exact prompts and times after a failed old draft save without resubmitting AI", async () => {
  const { document, study } = await fixture(), frozen = structuredClone(study);
  frozen.frames[1].prompt = "Frozen staff strike reference"; frozen.frames[1].label = "Anticipation"; frozen.frames[1].time = .21;
  const job = jobFor(document, frozen, "motion-frames", motionStudySources(frozen).filter((frame) => !frame.reuseBase)); job.prompt = "Frozen shared request";
  const before = structuredClone(document), restored = await restoreMotionStudyPlan(document, document.motions[1], job, getMotionStudyFingerprints);
  assert.deepEqual(document, before); assert.equal(restored.prompt, job.prompt); assert.equal(restored.frames[1].time, .21);
  assert.equal(restored.frames[1].prompt, "Frozen staff strike reference"); assert.equal(restored.frames[1].label, "Anticipation");
  assert.equal(restored.activeJobId, job.id); assert.equal(restored.frames[1].image, undefined);
  validateRigDocument({ ...document, motionStudies: { attack: restored } });
  await assert.rejects(restoreMotionStudyPlan(document, document.motions[1], { ...job, protectedIdleFingerprint: "f".repeat(64) }, getMotionStudyFingerprints), /不能恢复计划/);
});

test("partial coordinate jobs and retries merge only matching frames while retaining earlier approvals and manual mapping edits", async () => {
  const { document, study } = await fixture();
  for (const frame of motionStudySources(study)) { frame.image = document.sourceImage; frame.sourceFingerprint = study.baseFingerprint; frame.review = { approved: true }; }
  const mappings = motionStudySources(study).map((frame) => ({ frameId: frame.id, sourceFingerprint: frame.sourceFingerprint,
    joints: document.joints.map(({ id, x, y }) => ({ id, x, y })), parts: document.parts.map((part) => ({ partId: part.id, visible: true, z: part.z, sourcePolygon: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 2, y: 4 }] })) }));
  const originalJob = { ...jobFor(document, study, "pose-mapping"), status: "failed", mappings: mappings.slice(0, 2) };
  let partial = await loadMotionStudyMappings(document, study, originalJob, getMotionStudyFingerprints);
  assert.equal(partial.frames.filter((frame) => frame.mapping).length, 3, "base endpoint receives its referenced source mapping");
  partial = patchMotionStudyFrame(partial, "base", { mappingReview: { approved: true }, mapping: { ...partial.frames[0].mapping,
    joints: partial.frames[0].mapping.joints.map((joint, index) => index === 0 ? { ...joint, x: joint.x + 1 } : joint) } });
  assert.equal(partial.frames.at(-1).mappingReview.approved, true);
  const edited = structuredClone(partial.frames[0]);
  const retry = { ...jobFor(document, study, "pose-mapping"), id: "retry-mapping", parentJobId: originalJob.id,
    frames: originalJob.frames.slice(2), result: { mappings: mappings.slice(2) } };
  const merged = await loadMotionStudyMappings({ ...document, motionStudies: { attack: partial } }, partial, retry, getMotionStudyFingerprints);
  assert.deepEqual(merged.frames[0], edited); assert.ok(merged.frames.every((frame) => frame.mapping));
  const repeated = await loadMotionStudyMappings({ ...document, motionStudies: { attack: merged } }, merged, originalJob, getMotionStudyFingerprints);
  assert.deepEqual(repeated.frames[0], edited, "reloading the original task does not erase manual coordinate corrections");
  validateRigDocument({ ...document, motionStudies: { attack: merged } });
});

test("a fork can reuse only its prelinked frozen job with exact fingerprints geometry and generated PNG source", async () => {
  const { document, study } = await fixture(), target = study.frames[1], job = jobFor(document, study, "motion-frames", [target]);
  const bytes = artwork("#4f94be"), dataURL = bytesToImageDataURL(bytes), sourceFingerprint = await rigSourceFingerprint({ sourceImage: dataURL });
  job.images = [{ id: "image-0", frameId: target.id, width: 80, height: 100, sourceFingerprint }];
  const fork = structuredClone(document); fork.id = "independent-copy"; fork.motionStudies.attack.jobs = [job.id];
  const linked = fork.motionStudies.attack, before = structuredClone(fork);
  const next = await loadMotionStudyImages(fork, linked, job, { image: async () => bytes }, getMotionStudyFingerprints, imageReader);
  assert.equal(next.frames[1].image, dataURL); assert.deepEqual(fork, before); assert.equal(next.frames[1].imageGeneration.jobId, job.id);
  const unlinked = { ...linked, jobs: [], activeJobId: undefined };
  await assert.rejects(assertMotionStudyJob(fork, unlinked, job, getMotionStudyFingerprints), /另一角色/);
  await assertMotionStudyJob(fork, { ...unlinked, activeJobId: job.id }, job, getMotionStudyFingerprints);
  for (const field of ["baseFingerprint", "geometryFingerprint", "protectedIdleFingerprint", "originalArtworkFingerprint"])
    await assert.rejects(assertMotionStudyJob(fork, linked, { ...job, [field]: "f".repeat(64) }, getMotionStudyFingerprints), /来源与当前动作计划/);
  await assert.rejects(assertMotionStudyJob(fork, linked, { ...job, motionId: "hit" }, getMotionStudyFingerprints), /另一角色或动作/);
  await assert.rejects(assertMotionStudyJob(fork, linked, { ...job, geometry: undefined }, getMotionStudyFingerprints), /缺少完整骨架快照/);
  const changedGeometry = structuredClone(job.geometry); changedGeometry.joints[0].x += 1;
  await assert.rejects(assertMotionStudyJob(fork, linked, { ...job, geometry: changedGeometry }, getMotionStudyFingerprints), /骨架快照已改变/);
  await assert.rejects(loadMotionStudyImages(fork, linked, { ...job, images: [{ ...job.images[0], sourceFingerprint: "f".repeat(64) }] }, { image: async () => bytes }, getMotionStudyFingerprints, imageReader), /图片与任务指纹/);
  const changedSource = { ...fork, sourceImage: dataURL };
  await assert.rejects(assertMotionStudyJob(changedSource, linked, job, getMotionStudyFingerprints), /原图.*已改变/);
});

test("history unions current jobs with only recorded linked IDs and tolerates absent archive-device history", async () => {
  const { document, study } = await fixture(), oldJob = jobFor(document, study, "motion-frames", [study.frames[1]]);
  const fork = structuredClone(document); fork.id = "fork-with-history";
  const linked = fork.motionStudies.attack; linked.jobs = [oldJob.id, "missing-device-job", "changed-source-job"]; linked.activeJobId = oldJob.id;
  const currentJob = { ...oldJob, id: "current-job", projectId: fork.id }, arbitraryOld = { ...oldJob, id: "not-recorded" }, reads = [];
  const history = await loadMotionStudyHistory(fork, linked, {
    list: async (id) => { assert.equal(id, fork.id); return [currentJob, arbitraryOld]; },
    get: async (id) => { reads.push(id); if (id === "missing-device-job") throw new Error("404"); return id === oldJob.id ? oldJob : { ...oldJob, id, baseFingerprint: "f".repeat(64) }; },
  }, getMotionStudyFingerprints);
  assert.deepEqual(new Set(history.jobs.map((job) => job.id)), new Set([currentJob.id, oldJob.id]));
  assert.deepEqual(reads, [oldJob.id, "missing-device-job", "changed-source-job"]); assert.equal(history.unavailable, 2);
  const offline = await loadMotionStudyHistory(fork, linked, { list: async () => { throw new Error("offline"); }, get: async () => { throw new Error("404"); } }, getMotionStudyFingerprints);
  assert.equal(offline.jobs.length, 0); assert.equal(offline.unavailable, 4); assert.equal(linked.frames.length, study.frames.length);
});


test("pose-reference mode preserves reviewed sources and mapping but drops reproducible stepped textures", async () => {
  const { document, study } = await fixture();
  study.jobs = ["native-frames", "native-mapping"];
  study.applied = { kind: "stepped-parts", outOfDate: true };
  study.frames[1] = { ...study.frames[1], image: document.sourceImage, sourceFingerprint: "source-sha", review: { approved: true }, mapping: { joints: [{ id: "head", x: 40, y: 20 }] }, segments: [{ partId: "head", image: document.sourceImage }], composition: document.sourceImage, compositionMetrics: { alphaIoU: 1 } };
  const before = structuredClone(study), next = setMotionStudyPlayback(study, "reference");
  assert.deepEqual(study, before);
  assert.equal(next.playback, "reference"); assert.equal(next.applied, undefined);
  assert.deepEqual(next.jobs, before.jobs);
  for (const key of ["image", "sourceFingerprint", "review", "mapping"]) assert.deepEqual(next.frames[1][key], before.frames[1][key]);
  for (const key of ["segments", "composition", "compositionMetrics"]) assert.equal(next.frames[1][key], undefined);
  next.frames[1].mapping.joints[0].x = 80; assert.equal(study.frames[1].mapping.joints[0].x, 40);
  const restored = setMotionStudyPlayback(next, "stepped-parts");
  assert.equal(restored.applied, undefined); assert.equal(restored.frames[1].segments, undefined);
  assert.equal(restored.frames[1].image, before.frames[1].image);
});

test("pose-reference selection rejects invalid modes and empty studies", () => {
  assert.throws(() => setMotionStudyPlayback({ frames: [{}] }, "smooth-images"), /用途无效/);
  assert.throws(() => setMotionStudyPlayback({ frames: [] }, "reference"), /建立动作画面计划/);
});

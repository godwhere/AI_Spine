import { rigGeometry, rigDefaultVisiblePartIds } from "../../shared/domain/rig.mjs";
import { rigSourceRequest, rigSourceFingerprint } from "../../shared/domain/generation.mjs";
import { bytesToImageDataURL } from "../../shared/codec/image-data.mjs";
import { validateRigSourcePolygon } from "../../shared/rig-schema.mjs";
export { motionStudyFrameAnchor, setMotionStudyFrameScale } from "../../shared/domain/motion-study.mjs";

export const motionFrameChecks = { identity: "角色形象一致", expression: "表情符合动作", limbs: "肢体与服装完整", scale: "尺寸与画布一致", grip: "握持与武器合理" };
export const isMotionStudyJob = (job) => ["motion-frames", "pose-mapping"].includes(job?.kind);

export function motionStudyBaseline(document) {
  const { sourceImage, appearanceReference, appearance, registration, motionStudies, ...baseline } = document;
  return { ...baseline, parts: document.parts.map(({ image, registrationBase, registration, imageGeneration, ...part }) => part) };
}

export function motionStudyPlan(document, motion, fingerprints, count = 4) {
  if (!motion || motion.id === "idle") throw new Error("保留现有 idle，请选择其他动作重制。");
  if (![3, 4].includes(count)) throw new Error("每个动作需要 3 或 4 张新画面。");
  const base = { id: "base", time: 0, label: "共享基准", prompt: "", image: document.sourceImage,
    sourceFingerprint: fingerprints.baseFingerprint, origin: "base", reuseBase: true,
    review: { approved: true, checks: Object.fromEntries(Object.keys(motionFrameChecks).map((key) => [key, true])) } };
  if (motion.id === "run") count = 4;
  const labels = motion.id === "run" ? ["跑步接地", "跑步蹬地", "跑步腾空", "跑步落地"] : count === 4 ? ["动作准备", "动作展开", "动作极点", "动作收势"] : ["动作准备", "动作极点", "动作收势"];
  const ratios = motion.id === "run" ? [0, .25, .5, .75] : motion.id === "death" && count === 3 ? [.3 / 1.3, .65 / 1.3, 1.1 / 1.3] : count === 3 ? [.18, .38, .75] : [.15, .35, .6, .8];
  const generated = labels.map((label, index) => ({ id: `frame-${index + 1}`, time: Number((motion.duration * ratios[index]).toFixed(4)),
    label, prompt: `${motion.description || motion.name}。此张重点：${label}。`, origin: "pending", review: { approved: false, checks: {} } }));
  const frames = motion.id === "run" ? generated : [base, ...generated];
  const last = motion.id === "run" ? generated[0] : motion.id === "death" ? generated.at(-1) : base;
  frames.push({ id: "end", time: motion.duration, label: motion.id === "run" ? "循环回到首张跑姿" : motion.id === "death" ? "保持死亡终态" : "回到共享基准", prompt: "", imageRef: last.id,
    ...(last.sourceFingerprint ? { sourceFingerprint: last.sourceFingerprint } : {}), origin: last.origin, reuseBase: Boolean(last.reuseBase), review: structuredClone(last.review) });
  return { version: 1, motionId: motion.id, motion: { id: motion.id, name: motion.name, description: motion.description || "", duration: motion.duration, loop: motion.loop },
    ...fingerprints, prompt: "保留角色身份、服装、发型和武器。每张画面使用同一像素画布、固定角色尺度与相机，动作轮廓清晰，实际透明背景。倒地和伸展姿态保持原画布，不按人物高度重新缩放。", frames };
}

export const motionStudySources = (study) => (study?.frames || []).filter((frame) => !frame.imageRef);
export const motionStudyLinkedJobIds = (study) => [...new Set([...(Array.isArray(study?.jobs) ? study.jobs : []), study?.activeJobId].filter((id) => typeof id === "string" && id.length > 0))];

export async function loadMotionStudyHistory(document, study, client, getFingerprints) {
  const linkedIds = motionStudyLinkedJobIds(study), requests = [client.list(document.id), ...linkedIds.map((id) => client.get(id))];
  const results = await Promise.allSettled(requests), jobs = new Map();
  let unavailable = results[0].status === "rejected" ? 1 : 0;
  if (results[0].status === "fulfilled") for (const job of results[0].value) {
    if (isMotionStudyJob(job) && job.projectId === document.id && (job.motionId || job.motion?.id) === study?.motionId) jobs.set(job.id, job);
  }
  let fingerprints;
  const cachedFingerprints = () => fingerprints ||= getFingerprints(document);
  for (let index = 1; index < results.length; index++) {
    const result = results[index];
    if (result.status !== "fulfilled" || result.value?.id !== linkedIds[index - 1]) { unavailable++; continue; }
    try { await assertMotionStudyJob(document, study, result.value, cachedFingerprints); jobs.set(result.value.id, result.value); }
    catch { unavailable++; /* A recorded ID never bypasses current source, motion or geometry checks. */ }
  }
  return { jobs: [...jobs.values()].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)), unavailable };
}

export async function restoreMotionStudyPlan(document, motion, job, getFingerprints) {
  if (job?.kind !== "motion-frames" || (job.motionId || job.motion?.id) !== motion.id ||
      !Array.isArray(job.frames) || !job.frames.length || job.frames.length > 5)
    throw new Error("请选择当前动作的画面生成记录。");
  if (job.projectId !== document.id) await assertMotionStudyJob(document, document.motionStudies?.[motion.id], job, getFingerprints);
  if (job.motion?.duration !== motion.duration || job.motion?.loop !== motion.loop) throw new Error("任务的动作时长或循环设置已改变，不能恢复到当前动作。");
  const fingerprints = await getFingerprints(document);
  for (const key of Object.keys(fingerprints)) if (job[key] !== fingerprints[key]) throw new Error("任务的原图、骨架、原部件或 idle 与当前角色不同，不能恢复计划。");
  const count = job.frames.filter((frame) => !frame.reuseBase).length > 3 ? 4 : 3, plan = motionStudyPlan(document, motion, fingerprints, count);
  for (const frame of job.frames) {
    const target = plan.frames.find((item) => item.id === frame.id && !item.imageRef);
    if (!target) throw new Error("任务包含不能识别的画面编号，请保留该任务。");
    Object.assign(target, { time: frame.time, label: frame.label || target.label, prompt: frame.prompt || "" });
  }
  return { ...plan, prompt: job.prompt || plan.prompt, motion: { ...plan.motion, ...job.motion }, activeJobId: job.id, jobs: [job.id], frames: plan.frames.sort((a, b) => a.time - b.time) };
}
export function motionStudyFrameImage(study, frame) {
  if (!frame) return "";
  if (frame.image) return frame.image;
  const reference = frame.imageRef && study.frames.find((item) => item.id === frame.imageRef && !item.imageRef);
  return reference?.image || "";
}

export function setMotionStudyPlayback(study, playback) {
  if (!["reference", "stepped-parts"].includes(playback)) throw new Error("动作画面用途无效。");
  if (!study?.frames?.length) throw new Error("请先建立动作画面计划。");
  const next = structuredClone(study);
  next.playback = playback;
  delete next.applied;
  if (playback === "reference") for (const frame of next.frames) {
    // These are reproducible derivatives. Keep source art, ownership, landmarks,
    // reviews and provenance so reference use does not carry hundreds of textures.
    delete frame.segments;
    delete frame.composition;
    delete frame.compositionMetrics;
  }
  return next;
}

export function patchMotionStudyFrame(study, id, fields, { invalidate = false } = {}) {
  const clear = invalidate ? { mapping: undefined, mappingReview: undefined, segments: undefined, composition: undefined, compositionMetrics: undefined } : {};
  const frames = study.frames.map((frame) => frame.id === id ? { ...frame, ...clear, ...fields } : frame);
  return { ...study, applied: undefined, frames: frames.map((frame) => frame.imageRef === id ? { ...frame, ...clear,
    sourceFingerprint: fields.sourceFingerprint ?? frame.sourceFingerprint,
    ...(fields.review ? { review: structuredClone(fields.review) } : {}),
    ...(Object.hasOwn(fields, "mapping") ? { mapping: fields.mapping ? { ...structuredClone(fields.mapping), frameId: frame.id } : undefined,
      segments: undefined, composition: undefined, compositionMetrics: undefined } : {}),
    ...(Object.hasOwn(fields, "mappingReview") ? { mappingReview: structuredClone(fields.mappingReview) } : {}) } : frame).sort((a, b) => a.time - b.time) };
}

export async function assertMotionStudyCurrent(document, study, getFingerprints) {
  if (!study) throw new Error("请先建立动作画面计划。");
  const current = await getFingerprints(document);
  for (const key of ["baseFingerprint", "geometryFingerprint", "protectedIdleFingerprint", "originalArtworkFingerprint"])
    if (!study[key] || current[key] !== study[key]) throw new Error("原图、骨架、原部件或受保护的 idle 已改变，请重新建立画面计划。已有画面仍保留。");
  const motion = document.motions.find((item) => item.id === study.motionId);
  if (!motion || motion.id === "idle" || motion.duration !== study.motion.duration || motion.loop !== study.motion.loop)
    throw new Error("动作时长或循环设置已改变，请重新建立画面计划。");
  return current;
}

export async function assertMotionStudyJob(document, study, job, getFingerprints) {
  await assertMotionStudyCurrent(document, study, getFingerprints);
  const copiedDraft = job?.projectId !== document.id;
  if (!isMotionStudyJob(job) || (job.motionId || job.motion?.id) !== study.motionId || (copiedDraft && !motionStudyLinkedJobIds(study).includes(job.id)))
    throw new Error("这项任务属于另一角色或动作，已有候选未应用。");
  for (const key of ["baseFingerprint", "geometryFingerprint", "protectedIdleFingerprint", "originalArtworkFingerprint"])
    if (job[key] !== study[key]) throw new Error("候选来源与当前动作计划不一致，已有候选未应用。");
  if (copiedDraft && !job.geometry) throw new Error("已关联任务缺少完整骨架快照，不能用于这份复制草稿。");
  if (job.geometry && JSON.stringify(rigGeometry(job.geometry)) !== JSON.stringify(rigGeometry(document)))
    throw new Error("候选的骨架快照已改变，已有候选未应用。");
  if (job.kind === "pose-mapping") for (const snapshot of job.frames || []) {
    const frame = study.frames.find((item) => item.id === snapshot.id && !item.imageRef);
    if (!frame?.review?.approved || !snapshot.sourceFingerprint || snapshot.sourceFingerprint !== frame.sourceFingerprint)
      throw new Error("坐标任务的源画面或审阅状态已改变，不能载入或续做旧坐标。");
  }
}

export async function loadMotionStudyImages(document, study, job, client, getFingerprints, readImage) {
  await assertMotionStudyJob(document, study, job, getFingerprints);
  if (job.kind !== "motion-frames") throw new Error("请选择动作画面任务。");
  const images = job.result?.images || job.images || [];
  if (!images.length) throw new Error("这项任务还没有生成画面。");
  const seen = new Set(); let next = study;
  for (const candidate of images) {
    const frame = study.frames.find((item) => item.id === candidate.frameId && !item.imageRef);
    if (!frame || seen.has(frame.id) || candidate.width !== document.width || candidate.height !== document.height)
      throw new Error("动作画面映射或画布尺寸无效，未载入。");
    seen.add(frame.id);
    const requested = job.frames?.find((item) => item.id === frame.id);
    if (requested && (requested.time !== frame.time || requested.prompt !== frame.prompt)) throw new Error("画面说明或时间已修改，请重新生成此帧。");
    if (frame.imageGeneration?.jobId === job.id && frame.imageGeneration?.imageId === candidate.id) continue;
    const bytes = await client.image(job.id, candidate), sourceFingerprint = await rigSourceFingerprint({ sourceImage: bytesToImageDataURL(bytes), width: document.width, height: document.height });
    if (!candidate.sourceFingerprint || sourceFingerprint !== candidate.sourceFingerprint) throw new Error("画面图片与任务指纹不一致，未载入。");
    const ready = await readImage(bytes, { expectedWidth: document.width, expectedHeight: document.height });
    next = patchMotionStudyFrame(next, frame.id, { image: ready.dataURL, sourceFingerprint, origin: frame.reuseBase ? "base" : "ai-motion-frame",
      review: frame.reuseBase ? frame.review : { approved: false, checks: {} },
      imageGeneration: { jobId: job.id, imageId: candidate.id, provider: typeof job.provider === "string" ? job.provider : job.provider?.id,
        model: job.model, ...(candidate.raw ? { raw: candidate.raw } : {}), ...(candidate.normalization ? { normalization: candidate.normalization } : {}) } }, { invalidate: true });
  }
  return next;
}

export async function loadMotionStudyMappings(document, study, job, getFingerprints) {
  await assertMotionStudyJob(document, study, job, getFingerprints);
  const mappings = job.result?.mappings || job.mappings || [];
  if (job.kind !== "pose-mapping" || !mappings.length || !["completed", "failed", "cancelled"].includes(job.status)) throw new Error("这项任务还没有可载入的坐标结果。");
  const expected = new Set(motionStudySources(study).map((frame) => frame.id)), found = new Set(), byId = new Map();
  for (const raw of mappings) {
    const frame = study.frames.find((item) => item.id === raw.frameId);
    if (!expected.has(raw.frameId) || found.has(raw.frameId) || !frame.review?.approved || raw.sourceFingerprint !== frame.sourceFingerprint)
      throw new Error("坐标对应的来源或画面审阅状态已改变，未载入。");
    const actual = await rigSourceFingerprint({ sourceImage: frame.image, width: document.width, height: document.height });
    if (actual !== raw.sourceFingerprint) throw new Error("坐标对应的原画已改变，未载入。");
    const joints = new Set(document.joints.map((joint) => joint.id)), partIds = new Set(rigDefaultVisiblePartIds(document));
    const mapping = structuredClone(raw);
    for (const joint of mapping.joints || []) {
      if (!joints.delete(joint.id) || ![joint.x, joint.y].every(Number.isFinite) || joint.x < 0 || joint.x > document.width || joint.y < 0 || joint.y > document.height)
        throw new Error("动作关节坐标无效。");
    }
    for (const part of mapping.parts || []) {
      if (!partIds.delete(part.partId) || typeof part.visible !== "boolean" || !Number.isFinite(part.z)) throw new Error("动作部件对应或遮挡层级无效。");
      if (part.visible) part.sourcePolygon = validateRigSourcePolygon(part.sourcePolygon, document.width, document.height);
    }
    if (joints.size || partIds.size) throw new Error("坐标对应缺少关节或默认部件，未载入。");
    found.add(frame.id);
    if (frame.mappingGeneration?.jobId !== job.id || !frame.mapping) byId.set(frame.id, mapping);
  }
  if (!byId.size) return study;
  return { ...study, applied: undefined, mappingJobId: job.id, frames: study.frames.map((frame) => {
    const mapping = byId.get(frame.imageRef || frame.id);
    return mapping ? { ...frame, mapping: { ...structuredClone(mapping), frameId: frame.id }, mappingReview: { approved: false },
      mappingGeneration: { jobId: job.id, sourceFingerprint: mapping.sourceFingerprint }, segments: undefined, composition: undefined, compositionMetrics: undefined } : frame;
  }) };
}

export function motionStudyRequest(document, study, kind, frameIds) {
  const sources = motionStudySources(study), selected = frameIds ? sources.filter((frame) => frameIds.includes(frame.id)) : sources;
  if (!selected.length || selected.length > 5) throw new Error("请选择 1 至 5 张不同的源画面。");
  const fingerprints = Object.fromEntries(["baseFingerprint", "geometryFingerprint", "protectedIdleFingerprint", "originalArtworkFingerprint"].map((key) => [key, study[key]]));
  return { version: 1, kind, projectId: document.id, name: document.name, planner: "codex-native", ...fingerprints,
    rig: motionStudyBaseline(document), image: rigSourceRequest(document), motion: study.motion, prompt: study.prompt,
    ...(kind === "motion-frames" ? { concurrency: 3 } : {}),
    frames: selected.map((frame) => kind === "motion-frames" ? { id: frame.id, time: frame.time, label: frame.label, prompt: frame.prompt, ...(frame.reuseBase ? { reuseBase: true } : {}) }
      : { id: frame.id, time: frame.time, label: frame.label, image: motionStudyFrameImage(study, frame), sourceFingerprint: frame.sourceFingerprint }) };
}

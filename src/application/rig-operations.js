import { validateRigDocument, replaceRigMotion } from "../../shared/rig-schema.mjs";
import { assertRigJobMatches, assertRigAppearanceMatches, assertRigPartJobMatches, assertRigRegistrationMatches, rigWithAppearance } from "../../shared/domain/generation.mjs";
import { rigReadiness } from "../../shared/domain/rig.mjs";
import { isMotionStudyPlaybackActive } from "../../shared/domain/motion-study.mjs";
import { createHumanoidDraft } from "../../engine/rig/create-draft.js";
import { parseBundle } from "../../engine/archive/bundle.js";
import { parseSkeleton } from "../../engine/spine/parse.js";
import { inspectRigMotion } from "../../engine/rig/inspect.js";
import { inspectRegistrationBounds } from "../../engine/images/registration.js";
import { rigRegistrationPolygons, rigSourceFingerprint } from "../../shared/domain/generation.mjs";
import { bytesToImageDataURL } from "../../shared/codec/image-data.mjs";
import { assertProductionGate, plannedMotionSlots, productionRequestFingerprint } from "../../shared/domain/production.mjs";

export function basicMotionSlots() {
  return [{ id: "idle", name: "待机", duration: 2, loop: true, description: "自然呼吸与轻微重心变化，双脚稳定着地，首尾连续。" }, { id: "attack", name: "攻击", duration: 1.1, loop: false, description: "明确准备、挥击与收势，按当前武器握点设计动作，双脚稳定。" }, { id: "hit", name: "受击", duration: 0.6, loop: false, description: "受击后身体短暂后仰并恢复，保持脚部和握持稳定。" }].map((motion) => ({ ...motion, origin: "manual-placeholder", poses: [{ time: 0, angles: {}, root: { x: 0, y: 0 }, ease: "smooth" }, { time: motion.duration, angles: {}, root: { x: 0, y: 0 }, ease: "smooth" }] }));
}

// Builds candidates and checked results. Applying them remains an atomic session
// command after the caller verifies that its immutable source is still current.
export function createRigOperations({ images, buildFiles, createId, inspectMotion = inspectRigMotion }) {
  const emptyDocument = () => ({ version: 1, id: `rig-${createId()}`, name: "新角色", width: 1024, height: 1024, joints: [], parts: [], motions: [], origin: "manual" });
  const operations = {
    emptyDocument,
    async sourceDraft(current, file) {
      const image = await images.readRigReference(file);
      return { document: { ...emptyDocument(), name: current.name === "新角色" ? file.name.replace(/\.[^.]+$/, "") : current.name,
        width: image.width, height: image.height, sourceImage: image.dataURL, appearanceReference: image.reference, prompts: current.prompts,
        ...(current.production ? { production: current.production } : {}) }, resized: image.resized };
    },
    programDraft(current) {
      assertProductionGate(current, "structure");
      const next = createHumanoidDraft({ id: current.id, name: current.name, width: current.width, height: current.height, sourceImage: current.sourceImage });
      next.prompts = current.prompts; next.structureDetail = current.structureDetail; next.appearanceReference = current.appearanceReference; next.appearance = current.appearance;
      if (current.production) { next.production = current.production; next.motions = plannedMotionSlots(current); }
      next.parts = next.parts.map((item) => ({ ...item, x: Math.round(item.x), y: Math.round(item.y), width: Math.round(item.width), height: Math.round(item.height) }));
      return validateRigDocument(next);
    },
    async preview(snapshot) {
      const document = validateRigDocument(snapshot), files = await buildFiles(document);
      const bundle = parseBundle(files, { id: `rig-preview-${snapshot.id}`, name: snapshot.name }), { data } = parseSkeleton(bundle);
      return { document, bundle: { ...bundle, animations: data.animations.map((item) => item.name), skins: data.skins.map((item) => item.name),
        durations: Object.fromEntries(data.animations.map((item) => [item.name, item.duration])), boneCount: data.bones.length } };
    },
    inspectMotion,
    async registrationStage(current, stage) {
      if (!stage || stage.baseDocument !== current) throw new Error("草稿已改变，请重新查看坐标任务核对原始快照。已有对齐预览不会覆盖当前修改。");
      const polygons = rigRegistrationPolygons(current, stage.polygons);
      if (await rigSourceFingerprint(current) !== stage.sourceFingerprint) throw new Error("源立绘已改变，请重新生成坐标对应。");
      return { current, polygons };
    },
    async prepareRegistration(current, polygons, stage, expand) {
      const bounds = inspectRegistrationBounds(current, polygons, { maxBBoxExpansion: 2 });
      if (!expand && bounds.parts.some((item) => item.needsExpansion)) throw new Error("原图轮廓超出现有部件框。请明确选择「扩展框并检查对齐效果」，不要把轮廓压细塞入旧框。");
      const prepared = expand ? await images.expandRigRegistrationBounds(current, polygons, {}) : current;
      const result = await images.registerRigSourcePixels(prepared, { polygons, jobId: stage.jobId, gridSize: 32, maxBBoxExpansion: 2, sourceFingerprint: stage.sourceFingerprint });
      return { baseDocument: current, document: result.document, metrics: result.metrics, expanded: expand,
        previewDataURL: bytesToImageDataURL(result.preview.png), ownerDataURL: bytesToImageDataURL(result.ownerMap.png) };
    },
    async prepareStudy(document, id) {
      const result = await images.prepareMotionStudyFrames(document, id), reports = new Map(result.report.frames.map((frame) => [frame.frameId, frame]));
      const study = result.document.motionStudies[id];
      study.frames = study.frames.map((frame) => ({ ...frame, composition: reports.get(frame.id)?.composition }));
      return result;
    },
    async applyStudy(document, id) {
      const result = await images.applyMotionStudy(document, id), rendered = await operations.preview(result.document);
      return { ...result, bundle: rendered.bundle };
    },
    async validateForSave(current, { requireDelivery = true } = {}) {
      assertProductionGate(current, requireDelivery ? "save" : "export");
      const state = rigReadiness(current);
      const pending = Object.entries(current.motionStudies || {}).filter(([, study]) => study.frames?.length && study.playback !== "reference" && !study.applied);
      if (pending.length) throw new Error(`动作画面计划尚未应用：${pending.map(([id]) => current.motions.find((motion) => motion.id === id)?.name || id).join("、")}。请完成画面审阅、坐标对应和逐帧应用，再正式保存；候选与草稿仍保留。`);
      if (!state.ready) throw new Error(`还有 ${state.pending.length} 个部件待补绘或上传。草稿已保留，完成独立部件后再保存为正常资源。`);
      if (!current.motions.length) throw new Error("请至少创建并验证一个动作。");
      if (current.motions.some((item) => item.origin === "manual-placeholder")) throw new Error("还有待制作的动作槽，请先生成或编辑对应关键帧。");
      for (const item of current.motions) {
        const report = await inspectMotion(current, item.id);
        if (!report.finite || report.issues.length) throw Object.assign(new Error(`动作「${item.name}」尚未通过检查：${report.issues.join("；") || "存在无效姿态"}。请调整关节、关键帧或握点，或关闭不适用的脚锁。`), { motionId: item.id, report });
      }
    },
    async prepareCandidate(current, job, loadImage) {
      if (job.referenceTarget) throw new Error("请在对应分镜中应用这张关键图，设定图保持不变。");
      assertProductionGate(current, job.kind);
      if (current.production && job.productionFingerprint !== productionRequestFingerprint(current, job.kind, job.motionId || job.result?.motion?.id)) throw new Error("制作计划或任务输入已改变，旧候选未应用。");
      if (job.kind === "registration") return { kind: job.kind, polygons: await assertRigRegistrationMatches(current, job) };
      if (job.kind === "appearance") {
        const candidate = await assertRigAppearanceMatches(current, job), bytes = await loadImage(job.id, candidate);
        const image = await images.readRigImage(bytes, { requireTransparent: true, maxDimension: 1024, expectedWidth: 1024, expectedHeight: 1024 });
        return { kind: job.kind, document: rigWithAppearance(current, job, image), needsConfirmation: Boolean(current.joints.length || current.parts.length || current.motions.length) };
      }
      assertRigJobMatches(job.kind === "structure" ? current : validateRigDocument(current), job);
      if (job.kind === "structure") {
        if (!job.result?.rig) throw new Error("这项记录还没有可应用的结构结果。");
        const document = validateRigDocument({ ...job.result.rig, id: current.id, name: current.name, sourceImage: current.sourceImage, prompts: current.prompts,
          structureDetail: current.structureDetail, appearanceReference: current.appearanceReference, appearance: current.appearance, origin: "ai-analysis",
          ...(current.production ? { production: current.production } : {}) });
        if (current.production) document.motions = plannedMotionSlots(current);
        if (!document.motions.length) document.motions = basicMotionSlots();
        if (document.width !== current.width || document.height !== current.height || (job.result.rig.sourceImage && job.result.rig.sourceImage !== current.sourceImage)) throw new Error("立绘已改变，请重新分析当前立绘。");
        return { kind: job.kind, document, needsConfirmation: Boolean(current.joints.length) };
      }
      if (job.kind === "motion") {
        if (!job.result?.motion) throw new Error("这项记录还没有可应用的动作结果。");
        if (isMotionStudyPlaybackActive(current.motionStudies?.[job.result.motion.id])) throw new Error("此动作使用逐帧部件，旧连续骨骼候选不会改变当前画面；请打开动作画面重制。");
        return { kind: job.kind, document: replaceRigMotion(current, job.result.motion), motionId: job.result.motion.id };
      }
      const candidates = await assertRigPartJobMatches(current, job);
      if (!candidates.length) throw new Error("还没有可应用的补绘图片。");
      const replacements = new Map(), seen = new Set();
      for (const image of candidates) {
        const target = current.parts.find((item) => item.id === image.partId);
        if (!target || seen.has(target.id) || image.width !== target.width || image.height !== target.height || image.canvasWidth !== current.width || image.canvasHeight !== current.height) throw new Error("部件映射或图片尺寸与当前骨架不一致，未应用。");
        seen.add(target.id);
        if (image.id && target.imageGeneration?.jobId === job.id && target.imageGeneration?.imageId === image.id) continue;
        const bytes = await loadImage(job.id, image), ready = await images.readRigPartCandidate(bytes, { expectedWidth: target.width, expectedHeight: target.height });
        replacements.set(target.id, { image: ready.dataURL, imageGeneration: { jobId: job.id, imageId: image.id, partId: image.partId, parentJobId: job.parentJobId,
          sourceFingerprint: job.sourceFingerprint, provider: image.provider || (typeof job.provider === "string" ? job.provider : job.provider?.id || job.provider?.label), model: job.model, controllerModel: image.controllerModel, createdAt: job.createdAt,
          logical: { width: image.width, height: image.height, url: image.url }, ...(image.raw ? { raw: { ...image.raw } } : {}) } });
      }
      return { kind: job.kind, count: replacements.size, selectedPart: candidates[0].partId, document: replacements.size ? { ...current, parts: current.parts.map((item) => {
        if (!replacements.has(item.id)) return item;
        const next = { ...item, ...replacements.get(item.id), imageSource: "ai", completion: "ready" }; delete next.registrationBase; delete next.registration; return next;
      }) } : current };
    },
  };
  return operations;
}

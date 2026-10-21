import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateRigDocument, validateRigMotion } from "../../../shared/rig-schema.mjs";
import { validateStructured } from "../../../shared/contracts/structured.mjs";
import { structureSchema, structurePrompt, motionSchema, motionPrompt, registrationSchema, registrationPrompt } from "./rig-prompts.mjs";
import { registrationGrid, registrationResult } from "../rig-request.mjs";

export async function analyze(service, job) {
    const request = job.request, cwd = join(service.root, job.id), signal = job.controller.signal;
    const schema = request.kind === "structure" ? structureSchema(request.width, request.height, request.detail) :
      request.kind === "registration" ? registrationSchema(request.rig, request.partIds) : motionSchema(request.rig, request.motion);
    const references = request.image ? [join(cwd, "source.png")] : [];
    if (request.kind === "registration") references.push(await registrationGrid(request, cwd));
    for (const reference of request.kind === "motion" ? request.motionReferences || [] : request.productionReferences || []) {
      const file = join(cwd, reference.file), bytes = await readFile(file);
      if (createHash("sha256").update(bytes).digest("hex") !== reference.sourceFingerprint) throw new Error("动作参考图的本地文件已改变，未提交规划。");
      references.push(file);
    }
    signal.throwIfAborted();
    const output = await service.planner.generate(request.provider, { cwd, signal,
      prompt: request.kind === "structure" ? structurePrompt(request) : request.kind === "registration" ? registrationPrompt(request) : motionPrompt(request.rig, request.motion, request.motionReferences),
      schema, references });
    signal.throwIfAborted();
    validateStructured(output.value, schema);
    if (request.kind === "structure") {
      if (!Array.isArray(output.value?.joints) || !output.value.joints.length || !Array.isArray(output.value?.parts) || !output.value.parts.length) throw new Error("AI 未返回可用的关节和部件，请调整要求后重试。");
      const defaultAttachments = {};
      for (const { groupId, partId } of output.value.defaultAttachments) {
        if (Object.hasOwn(defaultAttachments, groupId)) throw new Error("AI 返回了重复的默认附件分组，请重新分析。");
        Object.defineProperty(defaultAttachments, groupId, { value: partId, enumerable: true, configurable: true, writable: true });
      }
      const rig = validateRigDocument({ version: 1, id: request.projectId, name: request.name, width: request.width, height: request.height,
        sourceImage: `data:image/png;base64,${(await readFile(join(cwd, "source.png"))).toString("base64")}`,
        joints: output.value.joints, parts: output.value.parts.map(({ attachmentGroup, ...part }) => ({ ...part, ...(attachmentGroup ? { attachmentGroup } : {}), imageSource: "source-crop", completion: "needs-inpaint" })),
        ...(Object.keys(defaultAttachments).length ? { defaultAttachments } : {}), motions: [], origin: "ai-analysis", structureDetail: request.detail || "standard" });
      job.result = { rig, notes: String(output.value.notes || "").slice(0, 2000) };
    } else if (request.kind === "registration") job.result = registrationResult(request, output.value);
    else {
      if (output.value?.id !== request.motion.id || output.value?.name !== request.motion.name || output.value?.duration !== request.motion.duration || output.value?.loop !== request.motion.loop)
        throw new Error("AI 返回的动作与本次请求不一致，未替换原动作。");
      const planned = { ...output.value, poses: output.value.poses.map((pose) => {
        const result = { ...pose };
        for (const field of ["translations", "scales", "drawOrder"]) if (result[field] === null) delete result[field];
        return result;
      }) };
      const motion = validateRigMotion({ ...planned, origin: "ai-analysis" }, request.rig.joints, request.rig.parts);
      if (motion.poses.length < 3 || motion.poses[0].time !== 0 || motion.poses.at(-1).time !== motion.duration) throw new Error("AI 动作缺少完整的起始、关键姿势或结束时间。");
      const attachments = Object.create(null);
      for (const part of request.rig.parts) if (part.attachmentGroup && !Object.hasOwn(attachments, part.attachmentGroup))
        attachments[part.attachmentGroup] = Object.hasOwn(request.rig.defaultAttachments || {}, part.attachmentGroup) ? request.rig.defaultAttachments[part.attachmentGroup] : part.id;
      const attachmentStates = motion.poses.map((pose) => { Object.assign(attachments, pose.attachments || {}); return { ...attachments }; });
      if (motion.loop && JSON.stringify(attachmentStates[0]) !== JSON.stringify(attachmentStates.at(-1))) throw new Error("循环动作的首尾表情附件不一致，请重新规划。");
      if (new Set(motion.poses.map((pose, index) => JSON.stringify([request.rig.joints.map((joint) => pose.angles[joint.id] || 0), pose.root,
        pose.translations || {}, pose.scales || {}, pose.drawOrder || [], attachmentStates[index]]))).size < 2)
        throw new Error("AI 未返回有效的关键姿势变化，未替换原动作。");
      motion.provenance = { kind: "continuous-rig-motion", planner: "codex-native", jobId: job.id, ...(typeof output.model === "string" ? { model: output.model } : {}), baseFingerprint: request.motionReferenceBaseFingerprint ?? request.sourceFingerprint ?? null,
        rigFingerprint: job.rigFingerprint, referenceFrames: (request.motionReferences || []).map(({ file, ...reference }) => reference),
        referenceExclusions: request.motionReferenceExclusions || [] };
      // Existing studies for other motions remain in the request snapshot only;
      // validating a single returned motion must not make their IDs look foreign.
      const { motionStudies, ...baseline } = request.rig;
      job.result = { motion: validateRigDocument({ ...baseline, motions: [motion] }).motions[0] };
    }
    signal.throwIfAborted(); job.model = output.model;
}

import { readRigAuthoring, attachRigAuthoring } from "../../engine/archive/rig-project.js";
import { rigDraftDestination } from "../../shared/domain/draft.mjs";
import { imageDataBytes } from "../../shared/codec/image-data.mjs";
import { prepareProject } from "./project-bundle.js";

export function createRigResourceActions({ projects, drafts, pixels, createId }) {
  const prepare = (files, options) => prepareProject(files, options, createId);
  return {
    listDrafts: () => drafts.list(),
    async resume(id, resources) {
      const draft = await drafts.get(id);
      if (!draft) throw new Error("这份骨架草稿不存在，请重新选择。");
      const destination = rigDraftDestination(draft, resources);
      return { document: destination.forked ? { ...draft.document, id: `rig-${createId()}`, ownerResourceId: undefined } : draft.document,
        options: { ...destination, draftId: draft.id, draftUpdatedAt: destination.forked ? undefined : draft.updatedAt } };
    },
    async open(record, adjustmentOptions = {}) {
      const draftId = `resource-${record.id}`, draft = await drafts.get(draftId);
      if (draft?.resourceId === record.id && draft.document.ownerResourceId === record.id && rigDraftDestination(draft, [record]).resourceId === record.id)
        return { document: draft.document, options: { resourceId: record.id, resourceUpdatedAt: record.updatedAt, draftId, draftUpdatedAt: draft.updatedAt, ...adjustmentOptions } };
      const document = readRigAuthoring(record.files);
      if (!document) throw new Error("该资源未包含可编辑的新骨架数据。");
      const current = await pixels.rigWithCalibratedParts(document, prepare(record.files, { skeletonPath: record.skeletonPath }), record.edits || {});
      if (current.ownerResourceId !== record.id) { current.id = `rig-${record.id}`; current.ownerResourceId = record.id; }
      if (draft) await drafts.save({ ...draft.document, id: `rig-${createId()}`, ownerResourceId: undefined });
      return { document: current, options: { resourceId: record.id, resourceUpdatedAt: record.updatedAt, draftId, draftUpdatedAt: draft?.updatedAt, ...adjustmentOptions },
        notice: draft ? "原骨架草稿的资源版本或归属已变，已单独保留；当前打开最新资源及校准。" : "" };
    },
    async publish({ document, previewBundle, thumbnail: previewThumbnail, session, previousDraftId, writer, draftWriter, flushDraft, onPublished = () => {} }) {
      if (document.parts.some((part) => !part.image || part.completion !== "ready" || ["source-crop", "placeholder"].includes(part.imageSource)))
        throw new Error("请先补绘或导入全部独立部件，再保存为正式资源。");
      await flushDraft();
      session = typeof session === "function" ? session() : session;
      const latest = session.resourceId ? await projects.get(session.resourceId) : null;
      const conflict = Boolean(session.resourceId && (!latest || latest.updatedAt !== session.resourceUpdatedAt));
      const existing = !conflict ? latest : null, id = conflict ? session.forkResourceId : session.saveResourceId;
      const authored = { ...document, ownerResourceId: id, id: conflict ? `rig-${id}` : session.authoringId || document.id };
      const bundle = prepare(attachRigAuthoring(previewBundle.files, authored), { skeletonPath: previewBundle.skeletonPath, name: document.name, id });
      const reference = document.sourceImage ? imageDataBytes(document.sourceImage).bytes : null;
      const generation = existing?.generation || (reference ? { appearance: { image: reference, fileName: "character-reference.png", prompt: "" } } : {});
      const record = { id, name: document.name, files: bundle.files, skeletonPath: bundle.skeletonPath, edits: {}, generation,
        thumbnail: previewThumbnail || document.sourceImage || existing?.thumbnail, templateId: existing?.templateId,
        boneCount: bundle.boneCount, partCount: bundle.parts.length, animationCount: bundle.animations.length };
      const key = `rig-resource-${session.key}-${id}`;
      session.publicationKeys ||= new Set(); session.publicationKeys.add(key);
      if (!writer.getStatus(key).sessionKey) writer.openSession({ sessionKey: key, entityId: id, expectedVersion: existing?.updatedAt });
      writer.enqueue({ sessionKey: key, localRevision: writer.getStatus(key).localRevision + 1, snapshot: record, reason: "rig-resource" });
      const saved = await writer.flush(key);
      const committedSession = { ...session, resourceId: id, saveResourceId: id, forkResourceId: createId(), authoringId: authored.id, resourceUpdatedAt: saved.updatedAt };
      const result = { saved, bundle, committedSession, conflict };
      onPublished(result);
      draftWriter.enqueue({ document: authored, resourceId: id, resourceUpdatedAt: saved.updatedAt,
        previousDraftId: typeof previousDraftId === "function" ? previousDraftId() : previousDraftId, sessionKey: session.key });
      await flushDraft();
      for (const key of session.publicationKeys) writer.discardSession(key);
      return result;
    },
  };
}

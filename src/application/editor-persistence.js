import { createSaveCoordinator } from "./save-coordinator.js";
import { sameAuthoredProjectContent, shouldPersistProject } from "../../shared/domain/project.mjs";
import { hasRigAuthoring, rigAuthoringSummary } from "../../shared/domain/rig-summary.mjs";

export function resourceSummary(record) {
  const { files, edits, generation, ...metadata } = record;
  return { ...metadata, replacementCount: Object.keys(edits || {}).length,
    hasRigAuthoring: hasRigAuthoring(files), rigSummary: rigAuthoringSummary(files) };
}

export function createEditorPersistence({ repository, captureThumbnail = (_key, fallback) => fallback, onSaved = () => {}, ...options }) {
  const writer = createSaveCoordinator({ ...options, sameContent: sameAuthoredProjectContent,
    repository: { ...repository, save: (record, context) => repository.save({ ...record,
      thumbnail: captureThumbnail(context.sessionKey, record.thumbnail) }, context) },
    onSaved: (saved, context) => onSaved(saved, { ...context, summary: resourceSummary(saved) }),
  });
  function queueProject({ session, project, record, name = record?.name, explicit = false, persisted = false }) {
    if (!session || session.key !== project?.sessionKey || !record) return null;
    const value = session.update(record), status = writer.getStatus(session.key);
    if (!shouldPersistProject({ project, name, edits: record.edits, generation: record.generation,
      explicit, persisted: status.persisted || status.hasUnsaved || persisted })) return null;
    writer.enqueue({ ...value, reason: explicit ? "explicit" : "autosave" });
    return session;
  }
  async function persistProject(context, { explicit = false, force = false } = {}) {
    if (context.session?.fork && writer.hasUnsaved(context.session.fork.key))
      throw new Error("另存结果尚未确认，请先重试另存为新资源；当前本地内容仍保留。");
    const session = queueProject({ ...context, explicit: explicit || force });
    if (!session) return;
    return await writer.flush(session.key) || { ...context.record, updatedAt: writer.getStatus(session.key).version };
  }
  return { ...writer, queueProject, persistProject };
}

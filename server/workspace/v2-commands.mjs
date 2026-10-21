import { composeWorkspaceRecord, validateWorkspaceReferences, MAX_WORKSPACE_BYTES, WORKSPACE_NAMESPACES as NS } from "../../shared/domain/workspace-assets.mjs";
import { serialize } from "node:v8";

const layouts = { projects: { namespace: NS.projects, primary: "projects", payload: "projects" },
  drafts: { namespace: NS.drafts, primary: "metadata", payload: "documents" },
  templates: { namespace: NS.templates, primary: "metadata", payload: "files" } };
const failure = (code, message) => Object.assign(new Error(message), { code });
const reads = new Set(["head", "get", "read", "list", "summary"]);

function descriptor(store, collection, id) {
  const { namespace, primary, payload } = layouts[collection], metadata = store.v2.descriptor(namespace, primary, id);
  if (!metadata) return null;
  if (primary === payload) return metadata;
  const body = store.v2.descriptor(namespace, payload, id);
  if (!body) throw failure("ASSET_REFERENCE_CORRUPT", "记录缺少独立文档或素材集合。");
  return { ...metadata, document: { ...metadata.document, ...body.document }, refs: [...metadata.refs, ...body.refs] };
}

export function workspaceV2Command(store, collection, body, call) {
  if (!store.v2 || store.activeFormat !== 2) throw failure("WORKSPACE_REFRESH_REQUIRED", "本机工作区尚未启用格式 2，请刷新工作台以确认当前保存协议。");
  const layout = layouts[collection], operation = body?.operation;
  if (!layout || typeof operation !== "string") throw failure("WORKSPACE_OPERATION_INVALID", "工作区操作不存在。");
  return store.transaction(() => {
    const { namespace, primary, payload } = layout;
    if (operation === "summary" || operation === "list") return call(collection, operation);
    if (["head", "get", "read"].includes(operation)) {
      const id = store.v2.key(namespace, primary, body.id)[2];
      if (operation === "head") {
        const row = store.v2.row(namespace, primary, id);
        return row ? { id, version: row.resource_version, updatedAt: row.updated_at, deletedAt: row.deleted_at } : null;
      }
      const value = descriptor(store, collection, id);
      if (!value || (collection === "projects" && operation === "get" && value.deletedAt)) return null;
      return { payload: { document: value.document, refs: value.refs }, version: value.version };
    }
    if (collection === "projects" && operation === "remove") {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 4096) throw failure("WORKSPACE_ID_INVALID", "请先选择回收站中的资源。");
      const ids = [...new Set(body.ids)], revision = store.status().revision;
      for (const id of ids) store.v2.mutate({ namespace, store: primary, id, operation, mutationId: body.mutationId,
        expectedVersion: body.expectedVersions?.[id], ids }, (current) => {
        call("projects", "remove", [[id]]);
        return { changed: true, receipt: { id, version: current.version + 1, removed: true } };
      }, { trackRevision: false });
      store.db.prepare("UPDATE settings SET value=? WHERE key='revision'").run(String(revision + 1));
      return { removed: ids.length };
    }
    const id = store.v2.key(namespace, primary, body.id)[2];
    if (!(["save", "trash", "restore"].includes(operation) && (collection === "projects" || operation === "save")) && !(collection === "templates" && operation === "delete"))
      throw failure("WORKSPACE_OPERATION_INVALID", "此分类不支持该写入操作。");
    return store.v2.mutate({ ...body, namespace, store: primary, id, refs: body.payload?.refs }, (current) => {
      let value = id;
      const options = { ...body.options };
      if (operation === "save") {
        if (options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== current?.updatedAt)
          throw failure(collection === "drafts" ? "DRAFT_CHANGED" : "RESOURCE_CHANGED", "保存基础版本已变化，请保留本地修改并重新打开。");
        const input = body.payload;
        if (input?.document?.id !== id) throw failure("WORKSPACE_ID_INVALID", "保存标识与文档不一致。");
        const bytes = validateWorkspaceReferences(namespace, payload, input.document, input.refs);
        if (bytes + serialize(input.document).byteLength > MAX_WORKSPACE_BYTES) throw failure("WORKSPACE_SIZE_INVALID", "工程文档与素材合计超过 256 MiB。");
        value = composeWorkspaceRecord(namespace, payload, input.document, input.refs, (hash) => {
          const blob = store.v2.asset(hash, body.leaseId);
          if (!blob) throw failure("ASSET_MISSING", "工程素材缺失或上传租约已过期，请重新上传。");
          return blob.bytes;
        });
        // The versioned entity is metadata for drafts/templates; reuse the
        // existing domain command to atomically update both underlying stores.
        if (collection === "drafts") {
          const destination = options.resourceId ? `resource-${options.resourceId}` : value.document?.id;
          if (destination !== id) throw failure("WORKSPACE_ID_INVALID", "草稿归属与保存标识不一致。");
          if (options.previousDraftId && options.previousDraftId !== id) {
            const previous = store.v2.row(namespace, primary, options.previousDraftId);
            if (!Number.isSafeInteger(body.previousDraftVersion) || (previous?.resource_version || 0) !== body.previousDraftVersion)
              throw failure("DRAFT_CHANGED", "原草稿已变化，未移动或删除它。请保留当前修改并重新打开。");
          }
          value = value.document;
        }
        if (["projects", "drafts"].includes(collection)) options.expectedUpdatedAt = current?.updatedAt;
      }
      const result = call(collection, operation, [value, options]), updated = store.v2.row(namespace, primary, id);
      const changed = (updated?.resource_version || 0) !== (current?.version || 0);
      let receipt = { id, version: updated?.resource_version || (current?.version || 0) + 1, updatedAt: updated?.updated_at,
        ...(operation === "delete" ? { removed: true } : {}) };
      if (collection === "projects" && updated) receipt.summary = store.projectIndex.summaries()[result.deletedAt ? "trash" : "projects"].find((item) => item.id === id);
      if (collection !== "projects" && operation === "save") {
        const { thumbnail, ...metadata } = result;
        receipt.metadata = metadata;
      }
      return { changed, receipt };
    });
  }, { readOnly: reads.has(operation), trackRevision: false });
}

export function legacyWorkspaceCommand(store, collection, operation, args = [], call) {
  if (store.activeFormat !== 2 || reads.has(operation)) return call(collection, operation, args);
  // Legacy pages cannot supply numeric versions or mutation receipts. Accept
  // only their existing timestamp CAS, never an unconditional overwrite.
  if (!["projects", "drafts"].includes(collection) || operation !== "save" || args[1]?.expectedUpdatedAt === undefined || args[1]?.previousDraftId)
    throw failure("WORKSPACE_REFRESH_REQUIRED", "保存协议已升级，请刷新工作台；当前修改仍保留。");
  return call(collection, operation, args);
}

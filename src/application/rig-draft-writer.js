import { createSaveCoordinator } from "./save-coordinator.js";

// Draft ownership and policy remain separate while writes share the coordinator.
export function createRigDraftWriter({ save, onStatus = () => {}, onSaved = () => {}, onError = () => {}, delay = 400,
  schedule = setTimeout, cancel = clearTimeout, get, createMutationId, usesMutationReceipts }) {
  let sessionKey = null;
  const contexts = new Map(), revisions = new Map();
  let sequence = 0;
  const publish = (value = { status: "idle" }) => {
    if (value.sessionKey && value.sessionKey !== contexts.get(sessionKey)?.activeKey) return;
    const { status } = value;
    onStatus({ status, message: status === "failed" ? `草稿保存失败：${value.error.message}。请重试保存后再离开。` :
      ({ pending: "草稿等待保存…", saving: "正在保存骨架草稿…", saved: "骨架草稿已保存到本机", idle: "本机骨架草稿" })[status] });
  };
  const writer = createSaveCoordinator({ delay, schedule, cancel, onStatus: publish, createMutationId,
    repository: {
      save: (document, { expectedVersion, value, mutationId }) => save(document, { resourceId: value.resourceId,
        resourceUpdatedAt: value.resourceUpdatedAt, expectedUpdatedAt: expectedVersion,
        ...(mutationId ? { mutationId } : {}),
        ...(value.previousDraftId ? { previousDraftId: value.previousDraftId } : {}) }),
      get, usesMutationReceipts,
    },
    sameContent: (record, document, value) => JSON.stringify(record.document) === JSON.stringify(document) &&
      (record.resourceId || null) === (value.resourceId || null) && record.resourceUpdatedAt === value.resourceUpdatedAt,
    onSaved: (metadata, value) => {
      if (contexts.get(value.original.sessionKey)?.activeKey === value.sessionKey) onSaved(metadata, value.original);
    },
    onError: (error, value) => {
      if (contexts.get(value.original.sessionKey)?.activeKey === value.sessionKey) onError(error, value.original);
    },
  });
  return {
    setSession(key, context = {}) {
      sessionKey = key || null;
      if (key && !contexts.has(key)) contexts.set(key, { ...context, entities: new Map(), activeKey: null });
      publish(writer.getStatus(contexts.get(key)?.activeKey));
    },
    enqueue(value) {
      if (!sessionKey || value.sessionKey !== sessionKey) return false;
      const context = contexts.get(sessionKey), entityId = value.resourceId ? `resource-${value.resourceId}` : value.document.id;
      context.entityId ||= entityId;
      if (!context.entities.has(entityId)) {
        const key = `draft-save-${++sequence}`; context.entities.set(entityId, key); context.activeKey = key;
        writer.openSession({ sessionKey: key, entityId, expectedVersion: entityId === context.entityId ? context.expectedVersion : undefined });
        revisions.set(key, 0);
      }
      const key = context.entities.get(entityId); context.activeKey = key;
      const revision = revisions.get(key) + 1; revisions.set(key, revision);
      return writer.enqueue({ ...value, sessionKey: key, snapshot: value.document, original: value, localRevision: revision });
    },
    flush: writer.flush, hasUnsaved: writer.hasUnsaved, dispose: writer.dispose,
  };
}


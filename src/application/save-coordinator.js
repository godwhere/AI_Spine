/** Serializes each entity's writes while keeping every editor's base version independent.
 * Snapshots and their image bytes are immutable references owned by the caller.
 */
export function createSaveCoordinator({ repository, sameContent = () => false, onStatus = () => {}, onSaved = () => {},
  onError = () => {}, delay = 850, schedule = setTimeout, cancel = clearTimeout, createMutationId }) {
  const sessions = new Map(), entities = new Map(), flushes = new Map();
  const entityFor = (id) => {
    if (!entities.has(id)) entities.set(id, { pending: new Map(), writing: null, running: null });
    return entities.get(id);
  };
  const status = (key) => {
    const session = sessions.get(key);
    if (!session) return { status: "idle", hasUnsaved: false };
    const entity = entityFor(session.entityId), pending = entity.pending.has(key), writing = entity.writing?.sessionKey === key;
    return { sessionKey: key, status: session.error ? "failed" : writing ? "saving" : pending ? "pending" : session.persisted ? "saved" : "idle",
      hasUnsaved: Boolean(pending || writing), error: session.error, version: session.expectedVersion, persisted: session.persisted,
      localRevision: session.localRevision, confirmedRevision: session.confirmedRevision };
  };
  const publish = (key) => onStatus(status(key));
  function openSession({ sessionKey, entityId, expectedVersion, persisted = false }) {
    if (!sessionKey || !entityId || sessions.has(sessionKey)) throw new Error("A save session needs a unique key and an entity ID.");
    sessions.set(sessionKey, { entityId, expectedVersion, persisted, localRevision: 0, confirmedRevision: persisted ? 0 : -1,
      error: null, timer: null, receipt: null });
    publish(sessionKey);
  }
  function drain(entity) {
    if (entity.running) return entity.running;
    entity.running = (async () => {
      while (true) {
        const entry = [...entity.pending.entries()].find(([key]) => !sessions.get(key).error);
        if (!entry) break;
        const [key, value] = entry, session = sessions.get(key);
        entity.pending.delete(key); entity.writing = value; publish(key);
        let receipt, failure;
        try {
          if (session.uncertain && session.uncertainUsesReceipts) {
            const original = session.uncertain;
            const confirmed = await repository.save(original.snapshot, { expectedVersion: session.expectedVersion,
              mutationId: original.mutationId, sessionKey: key, value: original });
            session.expectedVersion = repository.version ? repository.version(confirmed) : confirmed?.updatedAt;
            session.uncertain = null;
            if (original === value || original.snapshot === value.snapshot || sameContent(confirmed, value.snapshot, value)) receipt = confirmed;
          } else if (session.uncertain && repository.get) {
            // Resolve an unknown earlier commit before retrying, including new
            // entities whose old expected version was undefined.
            const current = await repository.get(session.entityId);
            const version = repository.version ? repository.version(current) : current?.updatedAt;
            if (!current && session.expectedVersion === undefined)
              throw Object.assign(new Error("新资源的保存结果尚未确认，请稍后核对或导出本地工程备份。"), { code: "SAVE_UNCONFIRMED" });
            if (current && sameContent(current, session.uncertain.snapshot, session.uncertain)) {
              session.expectedVersion = version;
              if (sameContent(current, value.snapshot, value)) receipt = current;
            } else if (version !== session.expectedVersion || (!current && session.expectedVersion !== undefined)) {
              throw Object.assign(new Error("保存结果无法与原版本核对，请保留本地修改并重新打开或另存。"), { code: "RESOURCE_CHANGED" });
            }
            session.uncertain = null;
          }
          receipt ||= await repository.save(value.snapshot, { expectedVersion: session.expectedVersion,
            mutationId: value.mutationId, sessionKey: key, value });
        } catch (error) {
          failure = error;
          // A transport failure may lose a successful transaction's response.
          // Explicit server rejections (including conflicts) must stay rejected.
          if (!error.code) {
            if (!session.uncertain) {
              session.uncertain = value;
              session.uncertainUsesReceipts = error.mutationReceipts ?? repository.usesMutationReceipts?.() ?? false;
            }
            if (!session.uncertainUsesReceipts && repository.get) try {
                const current = await repository.get(session.entityId);
                if (current && sameContent(current, value.snapshot, value)) { receipt = current; failure = null; session.uncertain = null; }
              } catch { /* Retain the original failure and local snapshot. */ }
          }
        }
        if (failure) {
          if (!entity.pending.has(key)) entity.pending.set(key, value);
          session.error = failure; onError(failure, value);
        } else {
          session.expectedVersion = repository.version ? repository.version(receipt) : receipt?.updatedAt;
          session.persisted = true; session.confirmedRevision = value.localRevision; session.receipt = receipt;
          onSaved(receipt, value);
        }
        entity.writing = null; publish(key);
      }
    })().finally(() => { entity.running = null; });
    return entity.running;
  }
  function enqueue(value) {
    const session = sessions.get(value.sessionKey);
    if (!session || (value.entityId && value.entityId !== session.entityId)) return false;
    if (!Number.isInteger(value.localRevision) || value.localRevision < session.localRevision) return false;
    const entity = entityFor(session.entityId);
    session.localRevision = value.localRevision;
    if (session.persisted && value.localRevision <= session.confirmedRevision && !entity.pending.has(value.sessionKey)) return false;
    if (entity.writing?.sessionKey === value.sessionKey && entity.writing.localRevision === value.localRevision) return false;
    // One pending snapshot per session: B is superseded by C while A is writing.
    const mutationId = value.mutationId || createMutationId?.();
    entity.pending.set(value.sessionKey, { ...value, entityId: session.entityId, ...(mutationId ? { mutationId } : {}) }); publish(value.sessionKey);
    cancel(session.timer);
    session.timer = schedule(() => { session.timer = null; void drain(entity); }, delay);
    return true;
  }
  function flush(sessionKey, { retry = true } = {}) {
    const scope = sessionKey || "*";
    if (flushes.has(scope)) return flushes.get(scope);
    const keys = () => sessionKey ? (sessions.has(sessionKey) ? [sessionKey] : []) : [...sessions.keys()];
    for (const key of keys()) {
      const session = sessions.get(key); cancel(session.timer); session.timer = null;
      if (retry) session.error = null;
    }
    const promise = (async () => {
      do {
        await Promise.all([...new Set(keys().map((key) => entityFor(sessions.get(key).entityId)))].map(drain));
        for (const key of keys()) if (sessions.get(key).error) throw sessions.get(key).error;
      } while (keys().some((key) => status(key).hasUnsaved));
      return sessionKey ? sessions.get(sessionKey)?.receipt : undefined;
    })().finally(() => { flushes.delete(scope); });
    flushes.set(scope, promise); return promise;
  }
  return { openSession, enqueue, flush, getStatus: status,
    hasUnsaved: (key) => key ? status(key).hasUnsaved : [...sessions.keys()].some((key) => status(key).hasUnsaved),
    dispose() { for (const session of sessions.values()) { cancel(session.timer); session.timer = null; } },
    discardSession(key) {
      const session = sessions.get(key);
      if (!session) return;
      const entity = entityFor(session.entityId);
      if (entity.writing?.sessionKey === key) throw new Error("Cannot discard an in-flight save.");
      cancel(session.timer); entity.pending.delete(key); sessions.delete(key);
    },
  };
}

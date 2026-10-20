// One serial writer owns pending drafts across editor sessions. A delayed
// callback must carry the session that created it, never the current session.
export function createRigDraftWriter({ save, onStatus = () => {}, onSaved = () => {}, onError = () => {}, delay = 400,
  schedule = setTimeout, cancel = clearTimeout }) {
  const pending = new Map(), saved = new Set();
  let sessionKey = null, writing = null, flushing = null, timer;
  const publish = () => {
    const value = pending.get(sessionKey);
    const status = value?.error ? "failed" : writing?.sessionKey === sessionKey ? "saving" : value ? "pending" : saved.has(sessionKey) ? "saved" : "idle";
    onStatus({ status, message: status === "failed" ? `草稿保存失败：${value.error.message}。请重试保存后再离开。` :
      ({ pending: "草稿等待保存…", saving: "正在保存骨架草稿…", saved: "骨架草稿已保存到本机", idle: "本机骨架草稿" })[status] });
  };
  const flush = () => {
    cancel(timer); timer = undefined;
    if (flushing) return flushing;
    if (!pending.size) return Promise.resolve();
    flushing = (async () => {
      while (pending.size) {
        const [key, value] = pending.entries().next().value;
        pending.delete(key); writing = value; publish();
        try {
          const metadata = await save(value.document, { resourceId: value.resourceId, resourceUpdatedAt: value.resourceUpdatedAt });
          saved.add(key); onSaved(metadata, value);
        } catch (error) {
          // A newer edit supersedes a failed older write; otherwise retain the
          // failed document so navigation/retry cannot silently discard it.
          if (!pending.has(key)) pending.set(key, { ...value, error });
          saved.delete(key); onError(error, value);
          throw error;
        } finally { writing = null; publish(); }
      }
    })().finally(() => { flushing = null; });
    return flushing;
  };
  return {
    setSession(key) { sessionKey = key || null; publish(); },
    enqueue(value) {
      if (!sessionKey || value.sessionKey !== sessionKey) return false;
      pending.set(sessionKey, value); publish();
      cancel(timer); timer = schedule(() => { void flush().catch(() => {}); }, delay);
      return true;
    },
    flush,
    hasUnsaved: () => Boolean(pending.size || writing),
    dispose() { cancel(timer); timer = undefined; },
  };
}

// A browser cannot await an IndexedDB transaction during unload. Start writes
// when hidden and keep the browser's leave confirmation active until committed.
export function attachRigDraftExitGuards(writer, { window: windowTarget = globalThis.window, document: documentTarget = globalThis.document } = {}) {
  const flush = () => { if (writer.hasUnsaved()) void writer.flush().catch(() => {}); };
  const beforeUnload = (event) => {
    if (!writer.hasUnsaved()) return;
    event.preventDefault(); event.returnValue = ""; flush();
  };
  const visibility = () => { if (documentTarget.visibilityState === "hidden") flush(); };
  windowTarget.addEventListener("beforeunload", beforeUnload);
  windowTarget.addEventListener("pagehide", flush);
  documentTarget.addEventListener("visibilitychange", visibility);
  return () => {
    windowTarget.removeEventListener("beforeunload", beforeUnload);
    windowTarget.removeEventListener("pagehide", flush);
    documentTarget.removeEventListener("visibilitychange", visibility);
  };
}

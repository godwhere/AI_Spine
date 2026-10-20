import { encodeWorkspace, decodeWorkspace } from "../../shared/workspace-codec.mjs";

const databases = ["ai-spine-local-workbench", "ispine-rig-drafts", "ai-spine-custom-templates"];
let ready;
export const usesSharedWorkspace = () => typeof window !== "undefined" && ["127.0.0.1", "localhost"].includes(window.location?.hostname);

async function request(path, data) {
  let response;
  try {
    response = await fetch(`/api/workspace/${path}`, { method: data === undefined ? "GET" : "POST", cache: "no-store",
      ...(data === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(encodeWorkspace(data)) }) });
  } catch { throw new Error("本机工作台服务暂不可用，未切换到独立浏览器存储。请稍后重试保存。"); }
  const value = decodeWorkspace(await response.json().catch(() => ({ error: "本机统一存储服务不可用，请打开正式工作台地址。" })));
  if (!response.ok) throw Object.assign(new Error(value.error || "本机数据操作失败。"), { code: value.code });
  return value;
}

export async function legacyWorkspaceSnapshot(indexedDB = globalThis.indexedDB) {
  const snapshot = {};
  if (!indexedDB?.databases) return snapshot;
  const existing = new Set((await indexedDB.databases()).map((db) => db.name));
  for (const name of databases.filter((name) => existing.has(name))) {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const names = [...db.objectStoreNames];
      snapshot[name] = await new Promise((resolve, reject) => {
        const tx = db.transaction(names, "readonly"), reads = names.map((store) => [store, tx.objectStore(store).getAll()]);
        tx.oncomplete = () => resolve(Object.fromEntries(reads.map(([store, r]) => [store, r.result])));
        tx.onabort = tx.onerror = () => reject(tx.error || new Error("旧工程读取失败，未完成迁移。"));
      });
    } finally { db.close(); }
  }
  return snapshot;
}

export function initializeWorkspace() {
  if (!usesSharedWorkspace()) return Promise.resolve(null);
  ready ||= (async () => {
    const status = await request("status");
    const marker = `ispine-shared-migration-${status.id}`;
    if (!localStorage.getItem(marker)) {
      let source = localStorage.getItem("ispine-workspace-source");
      if (!source) { source = crypto.randomUUID(); localStorage.setItem("ispine-workspace-source", source); }
      await request("migrate", { source: `browser-${source}`, snapshot: await legacyWorkspaceSnapshot() });
      localStorage.setItem(marker, "completed");
    }
    return status;
  })().catch((error) => { ready = null; throw error; });
  return ready;
}
export async function workspaceCall(collection, operation, ...args) {
  await initializeWorkspace();
  return (await request(collection, { operation, args })).value;
}

export function watchWorkspace(onChange) {
  if (!usesSharedWorkspace()) return () => {};
  let stopped = false, pending = false, revision;
  const check = async () => {
    if (pending || stopped || document.hidden) return;
    pending = true;
    try {
      await initializeWorkspace();
      const value = await request("status");
      if (revision !== undefined && revision !== value.revision && !stopped) await onChange();
      revision = value.revision;
    } catch { /* Saving reports service errors; background polling never forks storage. */ }
    finally { pending = false; }
  };
  const timer = setInterval(check, 2500);
  window.addEventListener("focus", check); void check();
  return () => { stopped = true; clearInterval(timer); window.removeEventListener("focus", check); };
}

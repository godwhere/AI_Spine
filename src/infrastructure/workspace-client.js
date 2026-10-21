import { legacyWorkspaceSnapshot } from "./legacy-indexeddb.js";
import { encodeWorkspace, decodeWorkspace } from "../../shared/workspace-codec.mjs";
import { createWorkspaceV2Client } from "./workspace-v2.js";

let ready, configuration, currentStatus, identityFailure, v2Client, legacyDeferred = false;
export function configureWorkspace({ storageMode, apiBase, fetcher = fetch, createId }) {
  if (!["shared", "legacy"].includes(storageMode) || typeof apiBase !== "string" || !/^\/(?!\/)[^?#\\\s]+$/.test(apiBase))
    throw new Error("工作台存储模式或 API 地址无效。");
  apiBase = apiBase.replace(/\/$/, "");
  if (configuration && (configuration.storageMode !== storageMode || configuration.apiBase !== apiBase || configuration.fetcher !== fetcher || (createId && configuration.createId && configuration.createId !== createId)))
    throw new Error("工作台已组装，不能在运行中切换存储。");
  configuration ||= { storageMode, apiBase, fetcher, createId };
}
export const usesSharedWorkspace = () => configuration ? configuration.storageMode === "shared" :
  typeof window !== "undefined" && ["127.0.0.1", "localhost"].includes(window.location?.hostname);

export function workspaceThumbnailURL(reference) {
  if (!reference || typeof reference.id !== "string" || !/^[a-f0-9]{64}$/.test(reference.hash)) throw new Error("资源缩略图引用无效。");
  return `${configuration?.apiBase || "/api"}/workspace/thumbnails/${encodeURIComponent(reference.id)}?hash=${reference.hash}`;
}

async function request(path, data) {
  let response;
  try {
    response = await (configuration?.fetcher || fetch)(`${configuration?.apiBase || "/api"}/workspace/${path}`, { method: data === undefined ? "GET" : "POST", cache: "no-store",
      ...(data === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(encodeWorkspace(data)) }) });
  } catch { throw new Error("本机工作台服务暂不可用，未切换到独立浏览器存储。请稍后重试保存。"); }
  let body;
  try { body = await response.json(); } catch { throw new Error("本机保存响应无法确认，请重试以核对原提交。"); }
  const value = decodeWorkspace(body);
  if (!response.ok) throw Object.assign(new Error(value.error || "本机数据操作失败。"), {
    code: value.code || (response.status >= 400 && response.status < 500 ? "WORKSPACE_REJECTED" : undefined),
  });
  return value;
}

async function rawRequest(path, options = {}) {
  let response;
  try { response = await (configuration?.fetcher || fetch)(`${configuration?.apiBase || "/api"}/workspace/${path}`, { cache: "no-store", ...options }); }
  catch { throw new Error("本机素材传输暂时中断，当前工程仍保留在会话中。"); }
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw Object.assign(new Error(value.error || "本机素材传输失败。"), { code: value.code || (response.status < 500 ? "WORKSPACE_REJECTED" : undefined) });
  }
  return response;
}
function acceptStatus(status) {
  if (!status || typeof status.id !== "string" || ![1, 2].includes(status.version ?? 1)) throw Object.assign(new Error("本机存储协议较新或不完整，请刷新工作台。"), { code: "WORKSPACE_REFRESH_REQUIRED" });
  if (currentStatus && currentStatus.id !== status.id) identityFailure = Object.assign(new Error("本机工作区身份已改变，请保留当前修改并重新打开。"), { code: "WORKSPACE_IDENTITY_CHANGED" });
  if (identityFailure) throw identityFailure;
  if (status.version === 2 && (!status.capabilities?.protocols?.includes(2) || !status.capabilities.assets || !status.capabilities.mutationReceipts))
    throw Object.assign(new Error("本机存储能力尚未就绪，请刷新工作台后再保存。"), { code: "WORKSPACE_REFRESH_REQUIRED" });
  currentStatus = status;
  return status;
}
export const workspaceMutationReceipts = () => currentStatus?.version === 2 && currentStatus.capabilities?.mutationReceipts === true;

export function initializeWorkspace() {
  if (!usesSharedWorkspace()) return Promise.resolve(null);
  ready ||= (async () => {
    const status = acceptStatus(await request("status"));
    const marker = `ispine-shared-migration-${status.id}`;
    if (!localStorage.getItem(marker)) {
      if (status.writable === false) { legacyDeferred = true; return status; }
      let source = localStorage.getItem("ispine-workspace-source");
      if (!source) { source = crypto.randomUUID(); localStorage.setItem("ispine-workspace-source", source); }
      await request("migrate", { source: `browser-${source}`, snapshot: await legacyWorkspaceSnapshot() });
      localStorage.setItem(marker, "completed");
    }
    legacyDeferred = false;
    return status;
  })().catch((error) => { ready = null; throw error; });
  return ready;
}
export async function workspaceCall(collection, operation, ...args) {
  await initializeWorkspace();
  if (identityFailure) throw identityFailure;
  const read = ["summary", "list", "get", "read"].includes(operation);
  if (!read && currentStatus?.writable === false) throw Object.assign(new Error("本机工作区暂不可写，当前修改仍保留；请等待维护完成或刷新工作台。"), { code: "WORKSPACE_MAINTENANCE" });
  if (workspaceMutationReceipts()) {
    v2Client ||= createWorkspaceV2Client({ request, rawRequest, createId: configuration?.createId });
    try { return await v2Client.call(collection, operation, ...args); }
    catch (error) { error.mutationReceipts = true; throw error; }
  }
  try { return (await request(collection, { operation, args })).value; }
  catch (error) { error.mutationReceipts = false; throw error; }
}

export function watchWorkspace(onChange) {
  if (!usesSharedWorkspace()) return () => {};
  let stopped = false, pending = false, revision, version, writable;
  const check = async () => {
    if (pending || stopped || document.hidden) return;
    pending = true;
    try {
      await initializeWorkspace();
      const value = acceptStatus(await request("status"));
      if (legacyDeferred && value.writable !== false) { ready = null; await initializeWorkspace(); }
      if (revision !== undefined && (revision !== value.revision || version !== value.version || writable !== value.writable) && !stopped) await onChange();
      revision = value.revision; version = value.version; writable = value.writable;
    } catch { /* Saving reports service errors; background polling never forks storage. */ }
    finally { pending = false; }
  };
  const timer = setInterval(check, 2500);
  window.addEventListener("focus", check); void check();
  return () => { stopped = true; clearInterval(timer); window.removeEventListener("focus", check); };
}

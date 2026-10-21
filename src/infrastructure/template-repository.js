import { createLegacyTemplateDatabase } from "./legacy-indexeddb.js";
import { requireCustomId } from "../../shared/domain/template.mjs";
import { usesSharedWorkspace } from "./workspace-client.js";
import { validatedSnapshot } from "./template-snapshot.js";
import { workspaceCall } from "./workspace-client.js";

const { openDB } = createLegacyTemplateDatabase();
async function saveCustomTemplate(record) {
  if (usesSharedWorkspace()) return workspaceCall("templates", "save", record);
  const snapshot = validatedSnapshot(record), { files, ...metadata } = snapshot;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["metadata", "files"], "readwrite");
    let failure;
    const store = tx.objectStore("metadata"), request = store.get(snapshot.id);
    request.onsuccess = () => {
      try {
        metadata.createdAt = request.result?.createdAt || metadata.createdAt;
        store.put(metadata);
        tx.objectStore("files").put({ id: snapshot.id, files });
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(metadata);
    tx.onerror = () => { failure ||= new Error("本机模板保存失败，请检查存储空间。原资源不会受影响。"); };
    tx.onabort = () => reject(failure || new Error("本机模板保存已中断，请重试。"));
  });
}

async function listCustomTemplates() {
  if (usesSharedWorkspace()) return workspaceCall("templates", "list");
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("metadata", "readonly"), request = tx.objectStore("metadata").getAll();
    tx.oncomplete = () => resolve(request.result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    tx.onabort = tx.onerror = () => reject(new Error("无法读取本机模板列表。"));
  });
}

async function getCustomTemplate(id) {
  requireCustomId(id);
  if (usesSharedWorkspace()) return workspaceCall("templates", "get", id);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["metadata", "files"], "readonly");
    const metadata = tx.objectStore("metadata").get(id), payload = tx.objectStore("files").get(id);
    tx.oncomplete = () => {
      if (!metadata.result && !payload.result) { resolve(null); return; }
      if (!metadata.result || !payload.result?.files) {
        reject(new Error("本机模板数据不完整，请从原资源重新加入模板。")); return;
      }
      resolve({ ...metadata.result, files: payload.result.files });
    };
    tx.onabort = tx.onerror = () => reject(new Error("无法读取本机模板。"));
  });
}

async function deleteCustomTemplate(id) {
  requireCustomId(id);
  if (usesSharedWorkspace()) return workspaceCall("templates", "delete", id);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["metadata", "files"], "readwrite"), store = tx.objectStore("metadata");
    const request = store.getKey(id);
    store.delete(id); tx.objectStore("files").delete(id);
    tx.oncomplete = () => resolve(request.result !== undefined);
    tx.onabort = tx.onerror = () => reject(new Error("删除本机模板失败，原资源不会受影响。"));
  });
}

export { deleteCustomTemplate, getCustomTemplate, listCustomTemplates, saveCustomTemplate };

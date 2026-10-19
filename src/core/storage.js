const DB_NAME = "ai-spine-local-workbench";
let database;
function openDB() {
  database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("projects", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = null;
      reject(new Error("无法打开本地存储。请导出可编辑工程以保存工作。"));
    };
  });
  return database;
}
async function transaction(mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("projects", mode),
      request = callback(tx.objectStore("projects"));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () =>
      reject(new Error("本地保存失败，存储空间可能不足。请导出工程备份。"));
    tx.onabort = () => reject(new Error("本地保存已中断。"));
  });
}
export const listProjects = () =>
  transaction("readonly", (store) => store.getAll());
export const saveProject = (project) =>
  transaction("readwrite", (store) =>
    store.put({ ...project, updatedAt: new Date().toISOString() }),
  );

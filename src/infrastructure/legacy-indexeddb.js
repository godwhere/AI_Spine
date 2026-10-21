export function createLegacyProjectDatabase() {
const DB_NAME = "ai-spine-local-workbench";
let database;
function openDB() {
  database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    let blocked = false;
    request.onblocked = () => {
      blocked = true; database = null;
      reject(new Error("资源库需要升级，请关闭其他工作台窗口后重新打开。已有资源会保留。"));
    };
    request.onupgradeneeded = () => {
      for (const name of ["projects", "removedProjects"])
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name, { keyPath: "id" });
    };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => { request.result.close(); database = null; };
      resolve(request.result);
    };
    request.onerror = () => {
      database = null;
      reject(new Error("无法打开本地存储。请导出可编辑工程以保存工作。"));
    };
  });
  return database;
}
async function transaction(mode, callback, name = "projects") {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode),
      request = callback(tx.objectStore(name));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () =>
      reject(new Error("本地保存失败，存储空间可能不足。请导出工程备份。"));
    tx.onabort = () => reject(new Error("本地保存已中断。"));
  });
}
return { openDB, transaction };
}

export function createLegacyRigDatabase() {
const DB_NAME = "ispine-rig-drafts";

let database;


function openDB() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("无法保存骨架草稿，请使用支持本机存储的工作台。"));
  if (database) return database.promise;
  const entry = { db: null, promise: null };
  database = entry;
  const clear = () => { if (database === entry) database = null; };
  entry.promise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      for (const name of ["metadata", "documents"])
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
    };
    request.onblocked = () => { blocked = true; clear(); reject(new Error("骨架草稿存储暂不可用，请关闭其他工作台后重试。")); };
    request.onerror = () => { clear(); reject(new Error("无法打开骨架草稿存储。")); };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      const db = request.result;
      entry.db = db;
      db.onversionchange = () => { clear(); db.close(); };
      db.onclose = clear;
      resolve(db);
    };
  }).catch((error) => { clear(); throw error; });
  return entry.promise;
}

async function withTransaction(stores, mode, callback) {
  let db = await openDB(), tx;
  for (let attempt = 0; ; attempt++) {
    try { tx = db.transaction(stores, mode); break; }
    catch (error) {
      if (error?.name !== "InvalidStateError") throw error;
      // A closing connection may reject before its close event is dispatched.
      // No transaction exists yet, so reopening once cannot replay any writes.
      if (database?.db === db) database = null;
      db.close();
      if (attempt) throw error;
      db = await openDB();
    }
  }
  return callback(tx);
}

return { withTransaction };
}

export function createLegacyTemplateDatabase() {
const DB_NAME = "ai-spine-custom-templates";

let database;

function openDB() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("当前环境无法保存本机模板。"));
  database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      for (const name of ["metadata", "files"])
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name, { keyPath: "id" });
    };
    request.onblocked = () => {
      blocked = true; database = null;
      reject(new Error("本机模板库暂时无法打开，请关闭其他工作台窗口后重试。"));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = null; };
      resolve(db);
    };
    request.onerror = () => {
      database = null;
      reject(new Error("无法打开本机模板库，原资源不会受影响。"));
    };
  });
  return database;
}

return { openDB };
}

const databases = ["ai-spine-local-workbench", "ispine-rig-drafts", "ai-spine-custom-templates"];
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


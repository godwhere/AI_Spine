import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { serialize, deserialize } from "node:v8";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sameAuthoredProjectContent } from "../../shared/domain/project.mjs";
import { validateRigDraftDocument } from "../../shared/domain/draft.mjs";
import { validatedSnapshot } from "../../engine/archive/template-snapshot.js";
import { ProjectIndex, PROJECT_NAMESPACE } from "./project-index.mjs";
import { WorkspaceV2Repository } from "./v2-repository.mjs";
import { ACTIVE_FORMAT_KEY, activeWorkspaceFormat, installLegacyGuards, legacyRecordWrite, refreshRequired } from "./v2-mode.mjs";
import { workspaceV2Command, legacyWorkspaceCommand } from "./v2-commands.mjs";
import { maintenanceToken, assertMaintenanceWritable } from "./maintenance.mjs";
import { createV2ProjectIndex } from "./v2-index.mjs";

const PROJECTS = PROJECT_NAMESPACE, DRAFTS = "ispine-rig-drafts", TEMPLATES = "ai-spine-custom-templates";
const idOf = (id) => {
  if (typeof id !== "string" || !id.trim() || id.length > 256 || /[\x00-\x1f]/.test(id)) throw new Error("本机资源标识无效。");
  return id;
};
const hash = (value) => createHash("sha256").update(serialize(value)).digest("hex");
const conflict = () => Object.assign(new Error("其他工作台已修改这个资源，当前修改未覆盖新版本。请保留当前工程并重新打开资源。"), { code: "RESOURCE_CHANGED" });

export class WorkspaceRepository {
  constructor(root) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
    const path = join(root, "workspace.sqlite");
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (namespace TEXT, store TEXT, id TEXT, payload BLOB NOT NULL, PRIMARY KEY(namespace,store,id)); CREATE TABLE IF NOT EXISTS migrations (source TEXT, namespace TEXT, id TEXT, hash TEXT, destination TEXT, PRIMARY KEY(source,namespace,id,hash)); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);");
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key='id'").get()) this.db.prepare("INSERT INTO settings VALUES ('id',?)").run(randomUUID());
    if (!this.db.prepare("SELECT 1 FROM settings WHERE key='revision'").get()) this.db.prepare("INSERT INTO settings VALUES ('revision','0')").run();
    try {
      this.activeFormat = activeWorkspaceFormat(this.db);
      if (![1, 2].includes(this.activeFormat)) throw refreshRequired();
      if (this.activeFormat === 2) this.configureV2(); else this.projectIndex = new ProjectIndex(this.db);
      this.projectIndex.ensure();
    }
    catch (error) { this.db.close(); throw error; }
  }
  status() { return { id: this.db.prepare("SELECT value FROM settings WHERE key='id'").get().value,
    revision: Number(this.db.prepare("SELECT value FROM settings WHERE key='revision'").get().value), storage: "local-shared", version: activeWorkspaceFormat(this.db),
    maintenance: Boolean(maintenanceToken(this.db)), writable: this.activeFormat === activeWorkspaceFormat(this.db) && !maintenanceToken(this.db), capabilities: { protocols: this.activeFormat === 2 ? [1, 2] : [1], assets: this.activeFormat === 2, mutationReceipts: this.activeFormat === 2 } }; }
  assertFormat() { if (activeWorkspaceFormat(this.db) !== this.activeFormat) throw refreshRequired(); }
  configureV2() {
    this.v2 = new WorkspaceV2Repository(this.db);
    this.projectIndex = createV2ProjectIndex(this.db, this.v2, { install: true });
    installLegacyGuards(this.db);
  }
  initializeEmptyV2() {
    // Explicit opt-in for a fresh isolated workspace; real conversion is a
    // separate checkpointed maintenance operation, never an implicit startup.
    if (this.db.prepare("SELECT 1 FROM records LIMIT 1").get() || this.activeFormat !== 1) throw new Error("只能对空工作区初始化格式 2；已有数据必须先执行迁移。");
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM records LIMIT 1").get() || (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='documents_v2'").get() && this.db.prepare("SELECT 1 FROM documents_v2 LIMIT 1").get()))
        throw new Error("已有数据必须先执行迁移，不能按空工作区激活。");
      this.db.prepare("INSERT INTO settings VALUES (?, '2') ON CONFLICT(key) DO UPDATE SET value='2'").run(ACTIVE_FORMAT_KEY);
      this.activeFormat = 2;
      try { this.configureV2(); this.projectIndex.rebuild(); }
      catch (error) { this.activeFormat = 1; this.v2 = null; this.projectIndex = new ProjectIndex(this.db); throw error; }
    }, { trackRevision: false });
  }
  get(namespace, store, id) {
    this.assertFormat();
    if (this.activeFormat === 2 && !(namespace === PROJECTS && store === "removedProjects")) return this.v2.record(namespace, store, idOf(id));
    const row = this.db.prepare("SELECT payload FROM records WHERE namespace=? AND store=? AND id=?").get(namespace, store, idOf(id));
    return row ? deserialize(Buffer.from(row.payload)) : null;
  }
  all(namespace, store) {
    this.assertFormat();
    if (this.activeFormat === 2 && !(namespace === PROJECTS && store === "removedProjects")) return this.db.prepare("SELECT id FROM documents_v2 WHERE namespace=? AND store=? ORDER BY rowid").all(namespace, store).map(({ id }) => this.v2.record(namespace, store, id));
    return this.db.prepare("SELECT payload FROM records WHERE namespace=? AND store=? ORDER BY rowid").all(namespace, store).map((row) => deserialize(Buffer.from(row.payload)));
  }
  put(namespace, store, record) {
    if (!this.db.isTransaction) return this.transaction(() => this.put(namespace, store, record));
    if (this.transactionReadOnly) throw new Error("只读事务不能写入工作区。");
    this.assertFormat();
    if (namespace === PROJECTS && store === "projects") this.projectIndex.assertVersion();
    if (this.activeFormat === 2 && !(namespace === PROJECTS && store === "removedProjects")) {
      const previous = this.v2.descriptor(namespace, store, record.id);
      if (previous && isDeepStrictEqual(this.v2.record(namespace, store, record.id), record)) return;
      return this.v2.putRecord(namespace, store, record, { version: (previous?.version || 0) + 1 });
    }
    const id = idOf(record.id), payload = serialize(record);
    if (this.activeFormat === 2 && isDeepStrictEqual(this.get(namespace, store, id), record)) return;
    legacyRecordWrite(this.db, () => this.db.prepare("INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(namespace,store,id) DO UPDATE SET payload=excluded.payload WHERE records.payload IS NOT excluded.payload").run(namespace, store, id, payload));
    if (namespace === PROJECTS && store === "projects") {
      const row = this.db.prepare("SELECT rowid AS n FROM records WHERE namespace=? AND store=? AND id=?").get(namespace, store, id);
      this.projectIndex.write(record, payload, row.n);
    }
  }
  remove(namespace, store, id) {
    if (!this.db.isTransaction) return this.transaction(() => this.remove(namespace, store, id));
    if (this.transactionReadOnly) throw new Error("只读事务不能写入工作区。");
    this.assertFormat();
    if (namespace === PROJECTS && store === "projects") this.projectIndex.assertVersion();
    if (this.activeFormat === 2 && !(namespace === PROJECTS && store === "removedProjects")) {
      this.v2.deleteRecord(namespace, store, idOf(id));
      if (namespace === PROJECTS && store === "projects") this.db.prepare("DELETE FROM mutations WHERE namespace=? AND id=?").run(namespace, id);
    }
    if (this.db.prepare("SELECT 1 FROM records WHERE namespace=? AND store=? AND id=?").get(namespace, store, idOf(id)))
      legacyRecordWrite(this.db, () => this.db.prepare("DELETE FROM records WHERE namespace=? AND store=? AND id=?").run(namespace, store, id));
    if (namespace === PROJECTS && store === "projects") this.projectIndex.remove(id);
  }
  transaction(fn, { readOnly = false, trackRevision = true } = {}) {
    if (this.db.isTransaction) {
      if (this.transactionReadOnly && !readOnly) throw new Error("只读事务不能升级为写事务。");
      return fn();
    }
    this.db.exec(readOnly ? "BEGIN DEFERRED" : "BEGIN IMMEDIATE"); this.transactionReadOnly = readOnly;
    try {
      this.assertFormat();
      if (!readOnly) assertMaintenanceWritable(this.db);
      const before = !readOnly && trackRevision ? this.db.prepare("SELECT total_changes() AS n").get().n : null, result = fn();
      if (before !== null && this.db.prepare("SELECT total_changes() AS n").get().n !== before)
        this.db.prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
      this.db.exec("COMMIT"); return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.transactionReadOnly = false; }
  }
  dispatch(collection, operation, args, { readOnly }) {
    if (collection === "projects" && !readOnly) this.projectIndex.assertVersion();
    return this[collection](operation, args);
  }
  nativeCommand(collection, body, call) { return workspaceV2Command(this, collection, body, call); }
  compatibleCommand(collection, operation, args, call) { return legacyWorkspaceCommand(this, collection, operation, args, call); }
  asset(hash, leaseId) { this.requireAssets(); return this.transaction(() => this.v2.asset(hash, leaseId), { readOnly: true }); }
  uploadAsset(hash, bytes, leaseId) { this.requireAssets(); return this.transaction(() => this.v2.upload(hash, bytes, leaseId), { trackRevision: false }); }
  queryAssets(hashes, leaseId) { this.requireAssets(); return this.transaction(() => this.v2.query(hashes, leaseId), { trackRevision: false }); }
  requireAssets() { if (!this.v2) throw refreshRequired(); }
  checkProjectIndex() { return this.transaction(() => this.projectIndex.check(), { readOnly: true }); }
  rebuildProjectIndex() { return this.transaction(() => this.projectIndex.rebuild(), { trackRevision: false }); }
  getProjectThumbnail(id, hash) { return this.transaction(() => this.projectIndex.thumbnail(idOf(id), hash), { readOnly: true }); }
  projects(operation, [value, options = {}]) {
    if (operation === "summary" || operation === "list") return this.projectIndex.summaries();
    if (operation === "get") { const record = this.get(PROJECTS, "projects", value); return record && !record.deletedAt ? record : null; }
    if (operation === "read") return this.get(PROJECTS, "projects", value);
    if (operation === "remove") {
      if (!Array.isArray(value) || !value.length) throw new Error("请先选择回收站中的资源。");
      const ids = [...new Set(value.map(idOf))];
      if (ids.some((id) => !this.get(PROJECTS, "projects", id)?.deletedAt)) throw new Error("只能永久删除仍在回收站中的资源，请刷新后重试。");
      for (const id of ids) { this.put(PROJECTS, "removedProjects", { id, removedAt: new Date().toISOString() }); this.remove(PROJECTS, "projects", id); }
      return ids.length;
    }
    const id = idOf(operation === "save" ? value?.id : value);
    if (this.get(PROJECTS, "removedProjects", id)) throw new Error("资源已永久删除，请导入工程备份后继续编辑。");
    const existing = this.get(PROJECTS, "projects", id);
    let record;
    if (operation === "save") {
      if (!value || typeof value.name !== "string" || !value.name.trim() || !value.files || typeof value.files !== "object") throw new Error("工程缺少名称或源文件。");
      if (existing?.deletedAt || value.deletedAt) throw new Error("资源已移入回收站，请先恢复后再编辑。");
      if (options.expectedUpdatedAt !== undefined && existing?.updatedAt !== options.expectedUpdatedAt) throw conflict();
      if (sameAuthoredProjectContent(existing, value)) return existing;
      const previous = Date.parse(existing?.updatedAt);
      record = { ...value, updatedAt: new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString() };
    } else {
      if (!existing) throw new Error("资源不存在，请刷新资源库。");
      if (operation === "trash") record = { ...existing, deletedAt: existing.deletedAt || new Date().toISOString() };
      else if (operation === "restore") { if (!existing.deletedAt) return existing; const { deletedAt, ...rest } = existing; record = { ...rest, updatedAt: new Date().toISOString() }; }
      else throw new Error("资源操作不存在。");
    }
    this.put(PROJECTS, "projects", record); return record;
  }
  drafts(operation, [value, options = {}]) {
    if (operation === "list") return this.all(DRAFTS, "metadata").sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    if (operation === "get") {
      const metadata = this.get(DRAFTS, "metadata", value), payload = this.get(DRAFTS, "documents", value);
      return metadata && payload ? { ...metadata, document: validateRigDraftDocument(payload.document) } : null;
    }
    if (operation !== "save") throw new Error("骨架草稿操作不存在。");
    for (const key of ["resourceId", "previousDraftId"]) if (options[key] != null) idOf(options[key]);
    const rig = validateRigDraftDocument(value), id = options.resourceId ? `resource-${options.resourceId}` : rig.id;
    const previous = this.get(DRAFTS, "metadata", id);
    if (options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== previous?.updatedAt)
      throw Object.assign(new Error("其他工作台已修改这份草稿，当前修改已保留，请另存或重新打开最新草稿。"), { code: "DRAFT_CHANGED" });
    const metadata = { id, documentId: rig.id, name: rig.name, updatedAt: new Date(Math.max(Date.now(), (Date.parse(previous?.updatedAt) || 0) + 1)).toISOString(), partCount: rig.parts.length,
      completeParts: rig.parts.filter((p) => p.image).length, jointCount: rig.joints.length, motionCount: rig.motions.length,
      resourceId: options.resourceId || null, resourceUpdatedAt: options.resourceUpdatedAt };
    this.put(DRAFTS, "metadata", metadata); this.put(DRAFTS, "documents", { id, document: rig });
    if (options.previousDraftId && options.previousDraftId !== id) {
      this.remove(DRAFTS, "metadata", options.previousDraftId); this.remove(DRAFTS, "documents", options.previousDraftId);
    }
    return metadata;
  }
  templates(operation, [value]) {
    if (operation === "list") return this.all(TEMPLATES, "metadata").sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    if (operation !== "save" && (typeof value !== "string" || !value.startsWith("custom-") || !value.slice(7).trim())) throw new Error("只能操作我创建的模板，内置模板不可删除。");
    if (operation === "get") {
      const metadata = this.get(TEMPLATES, "metadata", value), payload = this.get(TEMPLATES, "files", value);
      if (!metadata && !payload) return null;
      if (!metadata || !payload?.files) throw new Error("本机模板数据不完整，请从原资源重新加入模板。");
      return { ...metadata, files: payload.files };
    }
    if (operation === "delete") {
      const exists = Boolean(this.get(TEMPLATES, "metadata", value));
      this.remove(TEMPLATES, "metadata", value); this.remove(TEMPLATES, "files", value); return exists;
    }
    if (operation !== "save") throw new Error("自建模板操作不存在。");
    const { files, ...metadata } = validatedSnapshot(value, { now: new Date().toISOString() });
    metadata.createdAt = this.get(TEMPLATES, "metadata", metadata.id)?.createdAt || metadata.createdAt;
    this.put(TEMPLATES, "metadata", metadata); this.put(TEMPLATES, "files", { id: metadata.id, files }); return metadata;
  }
  migrate(source, snapshot) {
    idOf(source);
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("旧工程快照无效。");
    return this.transaction(() => {
      this.projectIndex.assertVersion();
      const result = { projects: 0, trash: 0, drafts: 0, templates: 0, conflicts: 0, unchanged: 0, skippedDeleted: 0 }, mapping = new Map();
      const migrated = (namespace, id, digest) => this.db.prepare("SELECT destination FROM migrations WHERE source=? AND namespace=? AND id=? AND hash=?").get(source, namespace, id, digest)?.destination;
      const remember = (namespace, id, digest, destination) => this.db.prepare("INSERT OR IGNORE INTO migrations VALUES (?,?,?,?,?)").run(source, namespace, id, digest, destination);
      for (const item of snapshot[PROJECTS]?.removedProjects || []) {
        idOf(item.id);
        // A tombstone from another profile must not delete an independently saved version.
        if (!this.get(PROJECTS, "projects", item.id)) this.put(PROJECTS, "removedProjects", item);
      }
      for (const original of snapshot[PROJECTS]?.projects || []) {
        idOf(original.id); const digest = hash(original), previous = migrated(PROJECTS, original.id, digest);
        if (previous) { mapping.set(original.id, previous); result.unchanged++; continue; }
        let item = original, existing = this.get(PROJECTS, "projects", item.id);
        if (this.get(PROJECTS, "removedProjects", item.id) || (existing?.deletedAt && !item.deletedAt)) {
          // Old browser caches are not an explicit restore/import operation.
          // Keep the shared deletion decision even after a client loses its migration marker.
          mapping.set(original.id, original.id); remember(PROJECTS, original.id, digest, original.id); result.skippedDeleted++; continue;
        }
        if (existing && sameAuthoredProjectContent(existing, item) && Boolean(existing.deletedAt) === Boolean(item.deletedAt)) { result.unchanged++; }
        else {
          if (existing) {
            item = { ...item, id: `${item.id}-import-${digest.slice(0,12)}`, name: `${item.name}（迁入版本）` }; result.conflicts++;
          }
          this.put(PROJECTS, "projects", item); result[item.deletedAt ? "trash" : "projects"]++;
        }
        mapping.set(original.id, item.id); remember(PROJECTS, original.id, digest, item.id);
      }
      for (const [namespace, payloadStore, kind] of [[DRAFTS,"documents","drafts"],[TEMPLATES,"files","templates"]]) {
        const data = snapshot[namespace] || {}, payloads = new Map((data[payloadStore] || []).map((r) => [r.id,r]));
        for (const original of data.metadata || []) {
          idOf(original.id); const payload = payloads.get(original.id);
          if (!payload) throw new Error("旧模板或草稿缺少原始文件，未完成迁移。");
          const digest = hash({ original, payload });
          if (migrated(namespace, original.id, digest)) { result.unchanged++; continue; }
          let metadata = { ...original }, body = structuredClone(payload);
          if (namespace === DRAFTS && metadata.resourceId && mapping.has(metadata.resourceId)) {
            const oldId = metadata.resourceId; metadata.resourceId = mapping.get(oldId); metadata.id = `resource-${metadata.resourceId}`;
            if (body.document?.ownerResourceId === oldId) body.document.ownerResourceId = metadata.resourceId;
            const resource = this.get(PROJECTS, "projects", metadata.resourceId), originalResource = (snapshot[PROJECTS]?.projects || []).find((p) => p.id === oldId);
            if (resource && originalResource?.updatedAt === metadata.resourceUpdatedAt) metadata.resourceUpdatedAt = resource.updatedAt;
          }
          if (namespace === TEMPLATES && mapping.has(metadata.sourceProjectId)) { metadata.sourceProjectId = mapping.get(metadata.sourceProjectId); metadata.id = `custom-${metadata.sourceProjectId}`; }
          body.id = metadata.id;
          const existing = this.get(namespace, "metadata", metadata.id), existingBody = this.get(namespace, payloadStore, metadata.id);
          if (existing && hash({ original: existing, payload: existingBody }) === hash({ original: metadata, payload: body })) result.unchanged++;
          else {
            if (existing) {
              metadata.name = `${metadata.name}（迁入版本）`;
              if (namespace === TEMPLATES) { metadata.sourceProjectId += `-import-${digest.slice(0,12)}`; metadata.id = `custom-${metadata.sourceProjectId}`; }
              else {
                metadata.id = `rig-import-${digest.slice(0,24)}`; metadata.documentId = metadata.id; metadata.resourceId = null; delete metadata.resourceUpdatedAt;
                body.document.id = metadata.id; delete body.document.ownerResourceId;
              }
              body.id = metadata.id; result.conflicts++;
            }
            this.put(namespace,"metadata",metadata); this.put(namespace,payloadStore,body); result[kind]++;
          }
          remember(namespace, original.id, digest, metadata.id);
        }
      }
      return result;
    });
  }
  close() { this.db.close(); }
}

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { serialize, deserialize } from "node:v8";
import { createHash, randomUUID } from "node:crypto";
import { sameAuthoredProjectContent } from "../src/core/project-content.js";
import { validateRigDraftDocument } from "../src/core/rig-drafts.js";
import { validatedSnapshot } from "../src/core/custom-templates.js";
import { rigAuthoringSummary } from "../src/core/rig-project.js";

const PROJECTS = "ai-spine-local-workbench", DRAFTS = "ispine-rig-drafts", TEMPLATES = "ai-spine-custom-templates";
const idOf = (id) => {
  if (typeof id !== "string" || !id.trim() || id.length > 256 || /[\x00-\x1f]/.test(id)) throw new Error("本机资源标识无效。");
  return id;
};
const hash = (value) => createHash("sha256").update(serialize(value)).digest("hex");
const conflict = () => Object.assign(new Error("其他工作台已修改这个资源，当前修改未覆盖新版本。请保留当前工程并重新打开资源。"), { code: "RESOURCE_CHANGED" });

export class WorkspaceStore {
  constructor(root) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
    const path = join(root, "workspace.sqlite");
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (namespace TEXT, store TEXT, id TEXT, payload BLOB NOT NULL, PRIMARY KEY(namespace,store,id)); CREATE TABLE IF NOT EXISTS migrations (source TEXT, namespace TEXT, id TEXT, hash TEXT, destination TEXT, PRIMARY KEY(source,namespace,id,hash)); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);");
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('id',?)").run(randomUUID());
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('revision','0')").run();
  }
  status() { return { id: this.db.prepare("SELECT value FROM settings WHERE key='id'").get().value,
    revision: Number(this.db.prepare("SELECT value FROM settings WHERE key='revision'").get().value), storage: "local-shared", version: 1 }; }
  get(namespace, store, id) {
    const row = this.db.prepare("SELECT payload FROM records WHERE namespace=? AND store=? AND id=?").get(namespace, store, idOf(id));
    return row ? deserialize(Buffer.from(row.payload)) : null;
  }
  all(namespace, store) { return this.db.prepare("SELECT payload FROM records WHERE namespace=? AND store=? ORDER BY rowid").all(namespace, store).map((row) => deserialize(Buffer.from(row.payload))); }
  put(namespace, store, record) {
    this.db.prepare("INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(namespace,store,id) DO UPDATE SET payload=excluded.payload").run(namespace, store, idOf(record.id), serialize(record));
  }
  remove(namespace, store, id) { this.db.prepare("DELETE FROM records WHERE namespace=? AND store=? AND id=?").run(namespace, store, idOf(id)); }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const before = this.db.prepare("SELECT total_changes() AS n").get().n, result = fn();
      if (this.db.prepare("SELECT total_changes() AS n").get().n !== before)
        this.db.prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
      this.db.exec("COMMIT"); return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  call(collection, operation, args = []) {
    if (!Array.isArray(args)) throw new Error("本机存储参数无效。");
    return this.transaction(() => {
      if (collection === "projects") return this.projects(operation, args);
      if (collection === "drafts") return this.drafts(operation, args);
      if (collection === "templates") return this.templates(operation, args);
      throw new Error("本机数据分类不存在。");
    });
  }
  projects(operation, [value, options = {}]) {
    if (operation === "summary") {
      const active = [], trash = [];
      for (const row of this.db.prepare("SELECT payload FROM records WHERE namespace=? AND store='projects' ORDER BY rowid").iterate(PROJECTS)) {
        const { files, edits, generation, ...metadata } = deserialize(Buffer.from(row.payload));
        metadata.replacementCount = Object.keys(edits || {}).length;
        metadata.hasRigAuthoring = Boolean(files?.[".ispine/rig/document.json"]);
        metadata.rigSummary = rigAuthoringSummary(files);
        (metadata.deletedAt ? trash : active).push(metadata);
      }
      return { projects: active, trash, hasDeletedProjects: Boolean(this.db.prepare("SELECT 1 FROM records WHERE namespace=? AND store='removedProjects' LIMIT 1").get(PROJECTS)) };
    }
    if (operation === "list") {
      const records = this.all(PROJECTS, "projects");
      return { projects: records.filter((r) => !r.deletedAt), trash: records.filter((r) => r.deletedAt), hasDeletedProjects: this.all(PROJECTS, "removedProjects").length > 0 };
    }
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
      else if (operation === "restore") { const { deletedAt, ...rest } = existing; record = { ...rest, updatedAt: new Date().toISOString() }; }
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
    const { files, ...metadata } = validatedSnapshot(value);
    metadata.createdAt = this.get(TEMPLATES, "metadata", metadata.id)?.createdAt || metadata.createdAt;
    this.put(TEMPLATES, "metadata", metadata); this.put(TEMPLATES, "files", { id: metadata.id, files }); return metadata;
  }
  migrate(source, snapshot) {
    idOf(source);
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("旧工程快照无效。");
    return this.transaction(() => {
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

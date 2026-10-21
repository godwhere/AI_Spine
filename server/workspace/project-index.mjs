import { createHash } from "node:crypto";
import { deserialize } from "node:v8";
import { rigAuthoringSummary, hasRigAuthoring } from "../../shared/domain/rig-summary.mjs";

export const PROJECT_NAMESPACE = "ai-spine-local-workbench", PROJECT_INDEX_VERSION = 1;
const VERSION_KEY = "project-index.version";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const invalid = (id, reason) => Object.assign(new Error(`资源摘要无法建立（${PROJECT_NAMESPACE}/projects/${id}）：${reason}。原记录未删除。`),
  { code: "PROJECT_INDEX_CORRUPT", namespace: PROJECT_NAMESPACE, store: "projects", id });
const outdated = () => Object.assign(new Error("资源摘要索引需要更新，请重启工作台或执行摘要重建；原工程仍保留。"), { code: "PROJECT_INDEX_OUTDATED" });

function entry(record, id, payload, sourceRowid) {
  if (!record || record.id !== id || typeof id !== "string" || !id.trim() || id.length > 256 || /[\x00-\x1f]/.test(id)) throw invalid(id, "资源标识无效或不匹配");
  if (typeof record.name !== "string" || !record.name.trim() || !record.files || typeof record.files !== "object" || Array.isArray(record.files)) throw invalid(id, "缺少名称或源文件集合");
  if (record.edits != null && (typeof record.edits !== "object" || Array.isArray(record.edits))) throw invalid(id, "替换记录无效");
  const summary = { id, name: record.name.slice(0, 4096) };
  for (const key of ["updatedAt", "deletedAt", "createdAt", "templateId"]) {
    if (record[key] == null) continue;
    if (!(key === "templateId" ? ["string", "number"].includes(typeof record[key]) : typeof record[key] === "string") || String(record[key]).length > 256) throw invalid(id, `${key} 无效`);
    summary[key] = record[key];
  }
  const rigSummary = rigAuthoringSummary(record.files), authored = hasRigAuthoring(record.files);
  if (authored && !rigSummary) throw invalid(id, "骨架作者数据不可解析");
  for (const key of ["boneCount", "partCount", "animationCount"]) {
    const count = record[key] ?? (key === "boneCount" ? rigSummary?.bones : undefined) ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw invalid(id, `${key} 无效`);
    summary[key] = count;
  }
  Object.assign(summary, { basePartCount: rigSummary?.baseParts ?? summary.partCount, regionCount: summary.partCount,
    replacementCount: Object.keys(record.edits || {}).length, hasRigAuthoring: authored, rigSummary });
  let thumbnail = null;
  if (record.thumbnail != null && record.thumbnail !== "") {
    if (typeof record.thumbnail !== "string") throw invalid(id, "缩略图信息无效");
    if (record.thumbnail.startsWith("data:")) {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(record.thumbnail);
      if (!match || !match[2].length || match[2].length % 4 === 1) throw invalid(id, "缩略图数据无效");
      const bytes = Buffer.from(match[2], "base64"), hash = sha256(bytes);
      thumbnail = { mime: match[1].toLowerCase(), bytes, hash };
      summary.thumbnailRef = { id, hash };
      summary.thumbnail = `/api/workspace/thumbnails/${encodeURIComponent(id)}?hash=${hash}`;
    } else {
      if (record.thumbnail.length > 4096) throw invalid(id, "缩略图引用过长");
      summary.thumbnail = record.thumbnail;
    }
  }
  return { id, summary, thumbnail, hash: sha256(payload), sourceRowid };
}

export class ProjectIndex {
  constructor(db, { source } = {}) { this.db = db; this.source = source; }
  sourceRow(id) { return this.source ? this.source.row(id) : this.db.prepare("SELECT id,payload,rowid AS source_rowid FROM records WHERE namespace=? AND store='projects' AND id=?").get(PROJECT_NAMESPACE, id); }
  sourceRows() { return this.source ? this.source.rows() : this.db.prepare("SELECT id,payload,rowid AS source_rowid FROM records WHERE namespace=? AND store='projects' ORDER BY rowid").iterate(PROJECT_NAMESPACE); }
  version() { return Number(this.db.prepare("SELECT value FROM settings WHERE key=?").get(VERSION_KEY)?.value || 0); }
  tablesReady() { return this.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('project_index','project_thumbnails','project_index_dirty')").get().n === 3; }
  deletionCleanupReady() { return /DELETE\s+FROM\s+project_thumbnails/i.test(this.db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='project_index_delete'").get()?.sql || ""); }
  upsertSafeTriggers() { return this.db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name IN ('project_index_insert','project_index_update','project_index_delete')").all().filter((row) => /ON CONFLICT\(id\) DO NOTHING/i.test(row.sql)).length === 3; }
  atomic(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  schema() {
    if (!this.deletionCleanupReady() || !this.upsertSafeTriggers()) this.db.exec("DROP TRIGGER IF EXISTS project_index_insert; DROP TRIGGER IF EXISTS project_index_update; DROP TRIGGER IF EXISTS project_index_delete;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS project_index (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, name TEXT NOT NULL, updated_at TEXT, deleted_at TEXT,
      summary TEXT NOT NULL, source_hash TEXT NOT NULL, source_rowid INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS project_index_lifecycle ON project_index(deleted_at,updated_at,id);
      CREATE TABLE IF NOT EXISTS project_thumbnails (id TEXT PRIMARY KEY,mime TEXT NOT NULL,bytes BLOB NOT NULL,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_index_dirty (id TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS project_index_insert AFTER INSERT ON records
      WHEN NEW.namespace='${PROJECT_NAMESPACE}' AND NEW.store='projects'
      BEGIN INSERT INTO project_index_dirty VALUES (NEW.id) ON CONFLICT(id) DO NOTHING; END;
      CREATE TRIGGER IF NOT EXISTS project_index_update AFTER UPDATE ON records
      WHEN NEW.namespace='${PROJECT_NAMESPACE}' AND NEW.store='projects'
      BEGIN INSERT INTO project_index_dirty VALUES (NEW.id) ON CONFLICT(id) DO NOTHING; END;
      CREATE TRIGGER IF NOT EXISTS project_index_delete AFTER DELETE ON records
      WHEN OLD.namespace='${PROJECT_NAMESPACE}' AND OLD.store='projects'
      BEGIN DELETE FROM project_index WHERE id=OLD.id; DELETE FROM project_thumbnails WHERE id=OLD.id;
      INSERT INTO project_index_dirty VALUES (OLD.id) ON CONFLICT(id) DO NOTHING; END;`);
  }
  decode(row) {
    let record;
    try { record = row.record || deserialize(Buffer.from(row.payload)); }
    catch { throw invalid(row.id, "源记录反序列化失败"); }
    return entry(record, row.id, row.payload, row.source_rowid);
  }
  write(record, payload, sourceRowid) { this.assertVersion(); this.writeEntry(entry(record, record.id, payload, sourceRowid)); }
  writeEntry(value) {
    const { summary: s, thumbnail: image } = value;
    this.db.prepare(`INSERT INTO project_index VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      version=excluded.version,name=excluded.name,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,
      summary=excluded.summary,source_hash=excluded.source_hash,source_rowid=excluded.source_rowid
      WHERE project_index.version IS NOT excluded.version OR project_index.name IS NOT excluded.name OR project_index.updated_at IS NOT excluded.updated_at OR project_index.deleted_at IS NOT excluded.deleted_at OR project_index.summary IS NOT excluded.summary
      OR project_index.source_hash IS NOT excluded.source_hash OR project_index.source_rowid IS NOT excluded.source_rowid`)
      .run(s.id, PROJECT_INDEX_VERSION, s.name, s.updatedAt ?? null, s.deletedAt ?? null, JSON.stringify(s), value.hash, value.sourceRowid);
    if (image) this.db.prepare(`INSERT INTO project_thumbnails VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      mime=excluded.mime,bytes=excluded.bytes,hash=excluded.hash
      WHERE project_thumbnails.mime IS NOT excluded.mime OR project_thumbnails.hash IS NOT excluded.hash OR project_thumbnails.bytes IS NOT excluded.bytes`)
      .run(s.id, image.mime, image.bytes, image.hash);
    else this.db.prepare("DELETE FROM project_thumbnails WHERE id=?").run(s.id);
    this.db.prepare("DELETE FROM project_index_dirty WHERE id=?").run(s.id);
  }
  remove(id) { this.assertVersion(); this.deleteEntry(id); }
  deleteEntry(id) {
    this.db.prepare("DELETE FROM project_index WHERE id=?").run(id);
    this.db.prepare("DELETE FROM project_thumbnails WHERE id=?").run(id);
    this.db.prepare("DELETE FROM project_index_dirty WHERE id=?").run(id);
  }
  ensure() {
    if (this.version() > PROJECT_INDEX_VERSION) throw Object.assign(new Error("资源摘要版本较新，请使用更新的工作台。"), { code: "PROJECT_INDEX_VERSION" });
    if (this.version() !== PROJECT_INDEX_VERSION) return this.rebuild();
    if (!this.tablesReady()) throw invalid("index", "摘要索引表缺失，请执行重建");
    if (!this.deletionCleanupReady() || !this.upsertSafeTriggers()) return this.rebuild();
    const dirty = this.db.prepare("SELECT id FROM project_index_dirty").all();
    if (dirty.length) this.atomic(() => {
      for (const { id } of this.db.prepare("SELECT id FROM project_index_dirty").all()) {
        const row = this.sourceRow(id);
        if (row) this.writeEntry(this.decode(row)); else this.remove(id);
      }
    });
  }
  rebuild() {
    if (this.version() > PROJECT_INDEX_VERSION) throw Object.assign(new Error("资源摘要版本较新，未覆盖索引。"), { code: "PROJECT_INDEX_VERSION" });
    return this.atomic(() => {
      this.schema(); const seen = new Set();
      for (const row of this.sourceRows()) {
        this.writeEntry(this.decode(row)); seen.add(row.id);
      }
      for (const { id } of this.db.prepare("SELECT id FROM project_index UNION SELECT id FROM project_thumbnails UNION SELECT id FROM project_index_dirty").all()) if (!seen.has(id)) this.deleteEntry(id);
      this.db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value IS NOT excluded.value").run(VERSION_KEY, String(PROJECT_INDEX_VERSION));
      return { version: PROJECT_INDEX_VERSION, projects: seen.size };
    });
  }
  assertVersion() {
    if (this.version() !== PROJECT_INDEX_VERSION) throw Object.assign(new Error("资源摘要版本已改变，请更新或重启工作台后再操作。"), { code: "PROJECT_INDEX_VERSION" });
  }
  assertReady() {
    this.assertVersion();
    if (this.db.prepare("SELECT 1 FROM project_index_dirty LIMIT 1").get()) throw outdated();
  }
  summaries() {
    this.assertReady(); const projects = [], trash = [];
    for (const row of this.db.prepare("SELECT id,version,summary FROM project_index ORDER BY source_rowid").iterate()) {
      let record;
      try {
        const keys = new Set(["id","name","updatedAt","deletedAt","createdAt","templateId","boneCount","partCount","animationCount","basePartCount","regionCount","replacementCount","hasRigAuthoring","rigSummary","thumbnail","thumbnailRef"]);
        if (row.summary.length > 24 * 1024) throw new Error();
        record = JSON.parse(row.summary); if (row.version !== PROJECT_INDEX_VERSION || record.id !== row.id || Object.keys(record).some((key) => !keys.has(key))) throw new Error();
      }
      catch { throw invalid(row.id, "摘要内容无效，请执行一致性检查"); }
      (record.deletedAt ? trash : projects).push(record);
    }
    return { projects, trash, hasDeletedProjects: Boolean(this.db.prepare("SELECT 1 FROM records WHERE namespace=? AND store='removedProjects' LIMIT 1").get(PROJECT_NAMESPACE)) };
  }
  thumbnail(id, hash) {
    this.assertReady();
    const row = this.db.prepare("SELECT t.mime,t.bytes,t.hash FROM project_thumbnails t INNER JOIN project_index p ON p.id=t.id WHERE t.id=?").get(id);
    return row && (!hash || hash === row.hash) ? row : null;
  }
  check() {
    const version = this.version(), ready = this.tablesReady(), report = { version, deletionCleanup: this.deletionCleanupReady(), upsertSafeTriggers: this.upsertSafeTriggers(), checked: 0, missing: [], stale: [], orphaned: [], dirty: [], invalid: [] };
    const indexed = new Map(ready ? this.db.prepare("SELECT * FROM project_index").all().map((row) => [row.id, row]) : []);
    if (ready) report.dirty = this.db.prepare("SELECT id FROM project_index_dirty ORDER BY id").all().map((row) => row.id);
    for (const row of this.sourceRows()) {
      report.checked++; const actual = indexed.get(row.id); indexed.delete(row.id);
      try {
        const expected = this.decode(row), image = ready ? this.db.prepare("SELECT * FROM project_thumbnails WHERE id=?").get(row.id) : null;
        if (!actual) report.missing.push(row.id);
        else if (actual.version !== PROJECT_INDEX_VERSION || actual.name !== expected.summary.name || actual.updated_at !== (expected.summary.updatedAt ?? null) || actual.deleted_at !== (expected.summary.deletedAt ?? null) || actual.summary !== JSON.stringify(expected.summary) || actual.source_hash !== expected.hash || actual.source_rowid !== expected.sourceRowid ||
          (expected.thumbnail ? !image || image.mime !== expected.thumbnail.mime || image.hash !== expected.thumbnail.hash || sha256(image.bytes) !== expected.thumbnail.hash : Boolean(image))) report.stale.push(row.id);
      } catch (error) { report.invalid.push({ id: row.id, code: error.code, message: error.message }); }
    }
    report.orphaned = [...indexed.keys()];
    if (ready) for (const row of this.db.prepare("SELECT id FROM project_thumbnails WHERE id NOT IN (SELECT id FROM project_index)").all()) report.orphaned.push(row.id);
    report.consistent = version === PROJECT_INDEX_VERSION && ready && report.deletionCleanup && report.upsertSafeTriggers && [report.missing, report.stale, report.orphaned, report.dirty, report.invalid].every((items) => !items.length);
    return report;
  }
}

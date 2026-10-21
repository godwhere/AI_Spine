import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import { isDeepStrictEqual } from "node:util";
import { existsSync, createReadStream, chmodSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { WorkspaceV2Repository } from "./v2-repository.mjs";
import { createV2ProjectIndex } from "./v2-index.mjs";
import { ProjectIndex } from "./project-index.mjs";
import { ACTIVE_FORMAT_KEY, activeWorkspaceFormat, installLegacyGuards } from "./v2-mode.mjs";
import { MAINTENANCE_KEY, MAINTENANCE_WRITER_KEY, maintenanceToken, withMaintenanceWriter, installMigrationGuards } from "./maintenance.mjs";
import { WORKSPACE_NAMESPACES as NS } from "../../shared/domain/workspace-assets.mjs";
import { encodeWorkspace, decodeWorkspace } from "../../shared/workspace-codec.mjs";

const SHADOW_KEY = "workspace.v2-shadow-owner";
const ownedSettings = new Set([ACTIVE_FORMAT_KEY, SHADOW_KEY, MAINTENANCE_KEY, MAINTENANCE_WRITER_KEY, "workspace-v2.schema", "workspace.compatible-write", "project-index.version"]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const encodedHash = (value) => digest(serialize(value));
const fault = (message, key) => Object.assign(new Error(`${message}${key ? `（${key.namespace}/${key.store}/${key.id}）` : ""}`), { code: "WORKSPACE_MIGRATION_FAILED", ...(key || {}) });
const hasTable = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
const tombstone = (key) => key.namespace === NS.projects && key.store === "removedProjects";
const keyArgs = (key) => [key.namespace, key.store, key.id];
function atomic(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
async function fileHash(path) { const hash = createHash("sha256"); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest("hex"); }
function optionalFields(value) {
  if (Array.isArray(value)) return value.map(optionalFields);
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, optionalFields(item)]));
  return value;
}

function sourceHash(db, format, key) {
  if (format === 1 || tombstone(key)) {
    const row = db.prepare("SELECT payload FROM records WHERE namespace=? AND store=? AND id=?").get(...keyArgs(key));
    if (!row) throw fault("来源记录缺失", key);
    return digest(row.payload);
  }
  const row = db.prepare("SELECT format_version,document,asset_count,resource_version,updated_at,deleted_at FROM documents_v2 WHERE namespace=? AND store=? AND id=?").get(...keyArgs(key));
  if (!row) throw fault("来源文档缺失", key);
  return encodedHash({ ...row, document: digest(row.document), refs: db.prepare("SELECT path,hash,encoding,size FROM asset_refs WHERE namespace=? AND store=? AND id=? ORDER BY path").all(...keyArgs(key)).map((item) => ({ ...item })) });
}
function sourceKeys(db, format) {
  const keys = format === 1 ? db.prepare("SELECT namespace,store,id FROM records ORDER BY rowid").all()
    : [...db.prepare("SELECT namespace,store,id FROM documents_v2 ORDER BY rowid").all(), ...db.prepare("SELECT namespace,store,id FROM records WHERE namespace=? AND store='removedProjects' ORDER BY rowid").all(NS.projects)];
  return keys.map((key, i) => ({ ...key, ordinal: i + 1, hash: sourceHash(db, format, key) }));
}
function snapshot(db) {
  const format = activeWorkspaceFormat(db), entries = sourceKeys(db, format);
  const settings = db.prepare("SELECT key,value FROM settings ORDER BY key").all().filter((row) => !ownedSettings.has(row.key)).map((row) => ({ ...row }));
  const links = db.prepare("SELECT source,namespace,id,hash,destination FROM migrations ORDER BY source,namespace,id,hash").all().map((row) => ({ ...row }));
  const raw = db.prepare("SELECT namespace,store,id,payload FROM records ORDER BY rowid").iterate(), rawHash = createHash("sha256");
  for (const row of raw) rawHash.update(serialize([row.namespace, row.store, row.id, digest(row.payload)]));
  const extra = format === 2 ? { assets: db.prepare("SELECT hash,size FROM asset_blobs ORDER BY hash").all().map((row) => ({ ...row })),
    uploads: db.prepare("SELECT * FROM asset_uploads ORDER BY lease_id,hash").all().map((row) => ({ ...row })),
    mutations: db.prepare("SELECT * FROM mutations ORDER BY namespace,store,id,mutation_id").all().map((row) => ({ ...row, receipt: digest(row.receipt) })) } : null;
  const value = { format, entries, settings, links, rawDigest: rawHash.digest("hex"), extra };
  return { ...value, digest: encodedHash(value) };
}
function recordFor(db, repository, format, key) {
  try {
    return format === 1 || tombstone(key) ? deserialize(Buffer.from(db.prepare("SELECT payload FROM records WHERE namespace=? AND store=? AND id=?").get(...keyArgs(key)).payload))
      : repository.record(...keyArgs(key));
  } catch (error) { throw fault(`来源数据无法还原：${error.message}`, key); }
}
function targetHash(db, target, key) {
  if (target === 2 && !tombstone(key)) return sourceHash(db, 2, key);
  if (target === 2) return sourceHash(db, 1, key);
  const row = db.prepare("SELECT payload FROM records_v1_stage WHERE namespace=? AND store=? AND id=?").get(...keyArgs(key));
  return row ? digest(row.payload) : null;
}

// Offline database conversion only. The caller coordinates editor/task drain
// and production service lifecycle; this class never touches job directories,
// account settings, profile stores, exported files or the served static build.
export class WorkspaceMigration {
  constructor(db, { onCheckpoint = () => {} } = {}) { this.db = db; this.onCheckpoint = onCheckpoint; }
  schema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_migrations (id TEXT PRIMARY KEY,source_format INTEGER NOT NULL,target_format INTEGER NOT NULL,
      state TEXT NOT NULL,checkpoint INTEGER NOT NULL,manifest BLOB NOT NULL,backup_path TEXT NOT NULL,backup_hash TEXT,report BLOB);
      CREATE TABLE IF NOT EXISTS workspace_migration_rows (migration_id TEXT NOT NULL,namespace TEXT NOT NULL,store TEXT NOT NULL,id TEXT NOT NULL,
        target_hash TEXT NOT NULL,PRIMARY KEY(migration_id,namespace,store,id));
      CREATE TABLE IF NOT EXISTS records_v1_stage (namespace TEXT NOT NULL,store TEXT NOT NULL,id TEXT NOT NULL,payload BLOB NOT NULL,ordinal INTEGER NOT NULL,
        PRIMARY KEY(namespace,store,id));`);
  }
  row() {
    if (!hasTable(this.db, "workspace_migrations")) return null;
    return this.id ? this.db.prepare("SELECT * FROM workspace_migrations WHERE id=?").get(this.id)
      : this.db.prepare("SELECT * FROM workspace_migrations ORDER BY rowid DESC LIMIT 1").get();
  }
  status() {
    const row = this.row();
    return row ? { id: row.id, sourceFormat: row.source_format, targetFormat: row.target_format, state: row.state, checkpoint: row.checkpoint,
      total: deserialize(Buffer.from(row.manifest)).entries.length, backupPath: row.backup_path, backupVerified: Boolean(row.backup_hash),
      activeFormat: activeWorkspaceFormat(this.db), maintenance: Boolean(maintenanceToken(this.db)), report: row.report ? deserialize(Buffer.from(row.report)) : null }
      : { activeFormat: activeWorkspaceFormat(this.db), maintenance: Boolean(maintenanceToken(this.db)), state: "idle" };
  }
  owner(row, action) {
    return atomic(this.db, () => {
      if (!row || maintenanceToken(this.db) !== row.id || activeWorkspaceFormat(this.db) !== row.source_format) throw fault("迁移所有权或来源格式已改变，未继续写入");
      return withMaintenanceWriter(this.db, row.id, action);
    });
  }
  begin(target, backupPath) {
    const path = resolve(backupPath || ""), sourcePath = this.db.prepare("PRAGMA database_list").all().find((row) => row.name === "main").file;
    if (!backupPath || path === resolve(sourcePath) || existsSync(path)) throw fault("必须指定一个全新的独立备份文件");
    const result = atomic(this.db, () => {
      this.schema();
      const source = activeWorkspaceFormat(this.db);
      if (![1, 2].includes(target) || source === target || ![1, 2].includes(source) || maintenanceToken(this.db)) throw fault("迁移方向无效或工作区已有维护操作");
      const previous = this.row();
      if (previous && !["activated", "aborted"].includes(previous.state)) throw fault("存在未完成迁移，请恢复原检查点");
      const shadow = this.db.prepare("SELECT value FROM settings WHERE key=?").get(SHADOW_KEY)?.value;
      if (source === 1 && hasTable(this.db, "documents_v2") && ["documents_v2", "asset_blobs", "asset_refs", "mutations", "asset_uploads"].some((table) => this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) &&
          !this.db.prepare("SELECT 1 FROM workspace_migrations WHERE id=? AND target_format=1 AND state='activated'").get(shadow || ""))
        throw fault("未激活的新表含未知来源数据，未覆盖它们");
      this.id = randomUUID();
      installMigrationGuards(this.db);
      this.db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(MAINTENANCE_KEY, this.id);
      return withMaintenanceWriter(this.db, this.id, () => {
        if (source === 2) { const report = new WorkspaceV2Repository(this.db).check(); if (!report.consistent) throw fault("来源素材或引用损坏，不能开始反向转换"); }
        const manifest = snapshot(this.db);
        manifest.indexDirty = hasTable(this.db, "project_index_dirty") ? this.db.prepare("SELECT id FROM project_index_dirty ORDER BY id").all().map((row) => row.id) : [];
        this.db.prepare("INSERT INTO workspace_migrations VALUES (?,?,?,?,?,?,?,?,?)").run(this.id, source, target, "frozen", 0, serialize(manifest), path, null, null);
        return this.status();
      });
    });
    this.onCheckpoint("frozen", result); return result;
  }
  async prepareBackup() {
    let row = this.row(); if (!row || ["activated", "aborted"].includes(row.state)) return this.status();
    if (row.backup_hash) { if (!existsSync(row.backup_path) || await fileHash(row.backup_path) !== row.backup_hash) throw fault("迁移备份缺失或已改变"); return this.status(); }
    if (maintenanceToken(this.db) !== row.id) throw fault("维护锁已改变，未创建备份");
    await mkdir(dirname(row.backup_path), { recursive: true, mode: 0o700 });
    if (!existsSync(row.backup_path)) { await sqliteBackup(this.db, row.backup_path); chmodSync(row.backup_path, 0o600); }
    const copy = new DatabaseSync(row.backup_path, { readOnly: true });
    try {
      if (copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" || snapshot(copy).digest !== deserialize(Buffer.from(row.manifest)).digest)
        throw fault("备份未通过一致性核对；请保留备份并检查，不会覆盖原文件");
    } finally { copy.close(); }
    const hash = await fileHash(row.backup_path);
    this.owner(row, () => this.db.prepare("UPDATE workspace_migrations SET backup_hash=?,state='backed-up' WHERE id=?").run(hash, row.id));
    const status = this.status(); this.onCheckpoint("backed-up", status); return status;
  }
  async stage({ batchSize = 10, maxBatches = Infinity } = {}) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100 || !(maxBatches === Infinity || Number.isSafeInteger(maxBatches) && maxBatches >= 1)) throw fault("迁移批次大小无效");
    if (["activated", "aborted"].includes(this.row()?.state)) return this.status();
    await this.prepareBackup(); let row = this.row();
    const manifest = deserialize(Buffer.from(row.manifest));
    if (snapshot(this.db).digest !== manifest.digest) throw fault("维护期间来源数据已改变，未继续迁移");
    if (row.state === "backed-up") this.owner(row, () => {
      if (row.target_format === 2) {
        new WorkspaceV2Repository(this.db);
        this.db.exec("DELETE FROM asset_refs; DELETE FROM documents_v2;");
      } else this.db.exec("DELETE FROM records_v1_stage");
      installMigrationGuards(this.db);
      this.db.prepare("UPDATE workspace_migrations SET state='staging' WHERE id=?").run(row.id);
    });
    for (let batches = 0; batches < maxBatches; batches++) {
      row = this.row(); if (row.checkpoint >= manifest.entries.length) break;
      this.owner(row, () => {
        const repository = row.target_format === 2 || row.source_format === 2 ? new WorkspaceV2Repository(this.db) : null;
        for (const key of manifest.entries.slice(row.checkpoint, row.checkpoint + batchSize)) {
          if (sourceHash(this.db, row.source_format, key) !== key.hash) throw fault("来源记录已改变", key);
          const record = recordFor(this.db, repository, row.source_format, key);
          if (!record || record.id !== key.id) throw fault("来源记录标识与存储键不一致", key);
          if (tombstone(key) && Object.keys(record).some((name) => !["id", "removedAt"].includes(name))) throw fault("删除标记含非 ID 数据，未自动改变它", key);
          try {
            if (row.target_format === 2 && !tombstone(key)) {
              const value = repository.putRecord(key.namespace, key.store, record);
              const transported = decodeWorkspace(JSON.parse(JSON.stringify(encodeWorkspace({ document: value.document, refs: value.refs }))));
              if (!isDeepStrictEqual(optionalFields(transported), optionalFields({ document: value.document, refs: value.refs }))) throw fault("记录包含不能无损传输的扩展类型", key);
            } else if (row.target_format === 1) {
              const payload = serialize(record);
              this.db.prepare("INSERT INTO records_v1_stage VALUES (?,?,?,?,?)").run(...keyArgs(key), payload, key.ordinal);
              if (!isDeepStrictEqual(deserialize(Buffer.from(payload)), record)) throw fault("反向转换未能无损还原", key);
            }
          } catch (error) { throw fault(`记录转换失败：${error.message}`, key); }
          this.db.prepare("INSERT INTO workspace_migration_rows VALUES (?,?,?,?,?)").run(row.id, ...keyArgs(key), targetHash(this.db, row.target_format, key));
          this.db.prepare("UPDATE workspace_migrations SET checkpoint=? WHERE id=?").run(key.ordinal, row.id);
        }
      });
      this.onCheckpoint("batch", this.status());
    }
    return this.status();
  }
  verify() {
    const row = this.row();
    const report = this.owner(row, () => {
      const manifest = deserialize(Buffer.from(row.manifest));
      if (row.checkpoint !== manifest.entries.length || snapshot(this.db).digest !== manifest.digest) throw fault("迁移尚未完成或来源指纹不一致");
      const repository = new WorkspaceV2Repository(this.db), counts = {}, sourceRecords = new Map();
      if (!repository.check().consistent) throw fault("素材库或引用未通过检查");
      for (const key of manifest.entries) {
        const receipt = this.db.prepare("SELECT target_hash FROM workspace_migration_rows WHERE migration_id=? AND namespace=? AND store=? AND id=?").get(row.id, ...keyArgs(key));
        if (!receipt || receipt.target_hash !== targetHash(this.db, row.target_format, key)) throw fault("检查点目标指纹不一致", key);
        const original = recordFor(this.db, repository, row.source_format, key);
        const restored = row.target_format === 2 ? tombstone(key) ? recordFor(this.db, repository, 1, key) : repository.record(...keyArgs(key))
          : deserialize(Buffer.from(this.db.prepare("SELECT payload FROM records_v1_stage WHERE namespace=? AND store=? AND id=?").get(...keyArgs(key)).payload));
        if (!isDeepStrictEqual(original, restored)) throw fault("往返内容不一致", key);
        counts[`${key.namespace}/${key.store}`] = (counts[`${key.namespace}/${key.store}`] || 0) + 1;
        sourceRecords.set(JSON.stringify(keyArgs(key)), original);
      }
      const actual = row.target_format === 2 ? this.db.prepare("SELECT count(*) AS n FROM documents_v2").get().n + manifest.entries.filter(tombstone).length : this.db.prepare("SELECT count(*) AS n FROM records_v1_stage").get().n;
      if (actual !== manifest.entries.length) throw fault("目标记录数量不一致");
      for (const key of manifest.entries.filter((key) => [NS.drafts, NS.templates].includes(key.namespace) && key.store === "metadata")) {
        const bodyStore = key.namespace === NS.drafts ? "documents" : "files";
        if (!sourceRecords.has(JSON.stringify([key.namespace, bodyStore, key.id]))) throw fault("草稿或模板缺少配对数据", key);
      }
      const report = { consistent: true, sourceFormat: row.source_format, targetFormat: row.target_format, records: actual, counts,
        identity: manifest.settings.find((setting) => setting.key === "id")?.value, revision: manifest.settings.find((setting) => setting.key === "revision")?.value,
        sourceDigest: manifest.digest, originalPayloadDigest: manifest.rawDigest, browserMappingsPreserved: true, bytesAndUnknownFieldsPreserved: true };
      this.db.prepare("UPDATE workspace_migrations SET state='validated',report=? WHERE id=?").run(serialize(report), row.id);
      return report;
    });
    this.onCheckpoint("validated", this.status()); return report;
  }
  async activate() {
    let row = this.row(); if (row?.state === "activated") return this.status();
    if (row?.state !== "validated") throw fault("只有完成核对的迁移可以激活");
    await this.prepareBackup(); this.verify(); row = this.row();
    this.owner(row, () => {
      this.db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(ACTIVE_FORMAT_KEY, String(row.target_format));
      let index;
      if (row.target_format === 2) {
        const repository = new WorkspaceV2Repository(this.db); index = createV2ProjectIndex(this.db, repository, { install: true }); installLegacyGuards(this.db);
        this.db.prepare("INSERT INTO settings VALUES (?, '') ON CONFLICT(key) DO UPDATE SET value=''").run(SHADOW_KEY);
      } else {
        this.db.exec("DELETE FROM records; INSERT INTO records(namespace,store,id,payload) SELECT namespace,store,id,payload FROM records_v1_stage ORDER BY ordinal; DELETE FROM records_v1_stage; UPDATE mutations SET receipt=X'';");
        this.db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(SHADOW_KEY, row.id);
        index = new ProjectIndex(this.db);
      }
      index.rebuild(); if (!index.check().consistent) throw fault("新格式摘要未通过一致性检查");
      installMigrationGuards(this.db);
      this.onCheckpoint("before-commit", this.status());
      this.db.prepare("UPDATE workspace_migrations SET state='activated' WHERE id=?").run(row.id);
      this.db.prepare("UPDATE settings SET value='' WHERE key=?").run(MAINTENANCE_KEY);
    });
    const status = this.status(); this.onCheckpoint("activated", status); return status;
  }
  abort() {
    const row = this.row(); if (!row || row.state === "aborted") return this.status();
    if (row.state === "activated") throw fault("已经激活的数据必须按当前内容反向转换，不能恢复旧备份");
    this.owner(row, () => {
      if (row.target_format === 2 && hasTable(this.db, "documents_v2")) {
        this.db.exec("DELETE FROM asset_refs; DELETE FROM documents_v2;");
        if (!this.db.prepare("SELECT value FROM settings WHERE key=?").get(SHADOW_KEY)?.value) this.db.exec("DELETE FROM mutations; DELETE FROM asset_uploads; DELETE FROM asset_blobs;");
      }
      this.db.exec("DELETE FROM records_v1_stage");
      if (hasTable(this.db, "project_index_dirty")) {
        this.db.exec("DELETE FROM project_index_dirty");
        for (const id of deserialize(Buffer.from(row.manifest)).indexDirty || []) this.db.prepare("INSERT INTO project_index_dirty VALUES (?)").run(id);
      }
      this.db.prepare("UPDATE workspace_migrations SET state='aborted' WHERE id=?").run(row.id);
      this.db.prepare("UPDATE settings SET value='' WHERE key=?").run(MAINTENANCE_KEY);
    });
    return this.status();
  }
}

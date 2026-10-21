import { createHash } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import { isDeepStrictEqual } from "node:util";
import { legacyRecordWrite } from "./v2-mode.mjs";
import { assertMaintenanceWritable } from "./maintenance.mjs";
import { composeWorkspaceRecord, decomposeWorkspaceRecord, validateWorkspaceReferences,
  WORKSPACE_FORMAT, WORKSPACE_NAMESPACES, MAX_WORKSPACE_BYTES } from "../../shared/domain/workspace-assets.mjs";

export const ASSET_LEASE_MS = 30 * 60 * 1000;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const error = (code, message) => Object.assign(new Error(message), { code });
const validId = (id) => {
  if (typeof id !== "string" || !id.trim() || id.length > 256 || /[\x00-\x1f]/.test(id)) throw error("WORKSPACE_ID_INVALID", "工作区标识无效。");
  return id;
};
const validHash = (hash) => {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw error("ASSET_HASH_INVALID", "素材 SHA-256 无效。");
  return hash;
};
const conflict = () => error("WORKSPACE_VERSION_CHANGED", "其他工作台已修改此记录，请保留当前修改并重新打开或另存。");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const ordered = (refs) => [...refs].sort((a, b) => JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)));

// Construction never activates storage format 2. The composition root selects
// the active repository after explicit migration. Use one enclosing transaction
// owner; leases/receipts alone never increment the library revision.
export class WorkspaceV2Repository {
  constructor(db, { now = Date.now, indexProject = null, removeProjectIndex = () => {}, readOnly = false } = {}) {
    this.db = db; this.now = now; this.indexProject = indexProject; this.removeProjectIndex = removeProjectIndex;
    this.readOnly = readOnly;
    const ready = () => this.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('documents_v2','asset_blobs','asset_refs','mutations','asset_uploads')").get().n === 5;
    if (readOnly) { this.assertSchema(); if (!ready()) throw error("ASSET_REFERENCE_CORRUPT", "版本 2 存储表不完整，未创建空表代替原记录。"); this.initialized = true; return; }
    this.atomic(() => {
      const current = this.db.prepare("SELECT value FROM settings WHERE key='workspace-v2.schema'").get()?.value;
      if (current && current !== String(WORKSPACE_FORMAT)) throw error("WORKSPACE_FORMAT_NEWER", "工作区存储格式较新，请更新工作台。");
      if (current && !ready()) throw error("ASSET_REFERENCE_CORRUPT", "版本 2 存储表不完整，未创建空表代替原记录。");
      this.db.exec(`CREATE TABLE IF NOT EXISTS documents_v2 (
        namespace TEXT NOT NULL,store TEXT NOT NULL,id TEXT NOT NULL,format_version INTEGER NOT NULL,
        document BLOB NOT NULL,asset_count INTEGER NOT NULL,resource_version INTEGER NOT NULL,
        updated_at TEXT,deleted_at TEXT,PRIMARY KEY(namespace,store,id));
        CREATE TABLE IF NOT EXISTS asset_blobs (hash TEXT PRIMARY KEY,size INTEGER NOT NULL,bytes BLOB NOT NULL CHECK(size=length(bytes)));
        CREATE TABLE IF NOT EXISTS asset_refs (namespace TEXT NOT NULL,store TEXT NOT NULL,id TEXT NOT NULL,
          path TEXT NOT NULL,hash TEXT NOT NULL,encoding TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(namespace,store,id,path));
        CREATE INDEX IF NOT EXISTS asset_refs_hash ON asset_refs(hash);
        CREATE TABLE IF NOT EXISTS mutations (namespace TEXT NOT NULL,store TEXT NOT NULL,id TEXT NOT NULL,
          mutation_id TEXT NOT NULL,request_hash TEXT NOT NULL,receipt BLOB NOT NULL,PRIMARY KEY(namespace,store,id,mutation_id));
        CREATE TABLE IF NOT EXISTS asset_uploads (lease_id TEXT NOT NULL,hash TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(lease_id,hash));
        CREATE INDEX IF NOT EXISTS asset_uploads_hash ON asset_uploads(hash,expires_at);`);
      this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('workspace-v2.schema',?)").run(String(WORKSPACE_FORMAT));
    });
    this.initialized = true;
  }
  assertSchema() {
    if (this.db.prepare("SELECT value FROM settings WHERE key='workspace-v2.schema'").get()?.value !== String(WORKSPACE_FORMAT))
      throw error("WORKSPACE_FORMAT_NEWER", "工作区存储格式已改变，请刷新或更新工作台后再保存。");
  }
  atomic(fn) {
    if (this.readOnly) throw error("WORKSPACE_READ_ONLY", "只读仓储不能写入工作区。");
    if (this.db.isTransaction) { if (this.initialized) { this.assertSchema(); assertMaintenanceWritable(this.db); } return fn(); }
    this.db.exec("BEGIN IMMEDIATE");
    try { if (this.initialized) { this.assertSchema(); assertMaintenanceWritable(this.db); } const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (failure) { this.db.exec("ROLLBACK"); throw failure; }
  }
  key(namespace, store, id) { return [namespace, store, id].map(validId); }
  row(namespace, store, id) { return this.db.prepare("SELECT rowid AS ordinal,* FROM documents_v2 WHERE namespace=? AND store=? AND id=?").get(...this.key(namespace, store, id)); }
  descriptor(namespace, store, id) {
    const row = this.row(namespace, store, id);
    if (!row) return null;
    if (row.format_version !== WORKSPACE_FORMAT) throw error("WORKSPACE_FORMAT_NEWER", "记录存储格式不受支持，未改变原记录。");
    const refs = this.db.prepare("SELECT path,hash,encoding,size FROM asset_refs WHERE namespace=? AND store=? AND id=? ORDER BY path").all(namespace, store, id)
      .map((ref) => ({ path: JSON.parse(ref.path), hash: ref.hash, size: ref.size, encoding: JSON.parse(ref.encoding) }));
    if (refs.length !== row.asset_count) throw error("ASSET_REFERENCE_CORRUPT", "工程素材引用不完整，未丢弃原记录。");
    return { document: deserialize(Buffer.from(row.document)), refs, version: row.resource_version, updatedAt: row.updated_at, deletedAt: row.deleted_at, ordinal: row.ordinal };
  }
  checkedBlob(hash) {
    const value = this.db.prepare("SELECT bytes,size FROM asset_blobs WHERE hash=?").get(validHash(hash));
    if (!value) return null;
    if (value.bytes.byteLength !== value.size || digest(value.bytes) !== hash) throw error("ASSET_CORRUPT", "素材字节与 SHA-256 不一致，未返回损坏图片。");
    return value;
  }
  record(namespace, store, id) {
    const value = this.descriptor(namespace, store, id);
    return value ? composeWorkspaceRecord(namespace, store, value.document, value.refs, (hash) => this.checkedBlob(hash)?.bytes) : null;
  }
  expiry(ttl = ASSET_LEASE_MS) {
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 24 * 60 * 60 * 1000) throw error("ASSET_LEASE_INVALID", "素材上传租约时间无效。");
    return this.now() + ttl;
  }
  lease(hash, leaseId, expires) {
    this.db.prepare("INSERT INTO asset_uploads VALUES (?,?,?) ON CONFLICT(lease_id,hash) DO UPDATE SET expires_at=max(asset_uploads.expires_at,excluded.expires_at)").run(validId(leaseId), hash, expires);
  }
  upload(hash, bytes, leaseId, { ttl = ASSET_LEASE_MS } = {}) {
    validHash(hash); validId(leaseId);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_WORKSPACE_BYTES) throw error("ASSET_SIZE_INVALID", "素材必须是 256 MiB 以内的原始二进制。");
    if (digest(bytes) !== hash) throw error("ASSET_HASH_MISMATCH", "素材字节与提交的 SHA-256 不一致。");
    const expires = this.expiry(ttl);
    return this.atomic(() => {
      const old = this.checkedBlob(hash);
      if (!old) this.db.prepare("INSERT INTO asset_blobs VALUES (?,?,?)").run(hash, bytes.byteLength, bytes);
      this.lease(hash, leaseId, expires);
      return { hash, size: bytes.byteLength, expiresAt: expires };
    });
  }
  query(hashes, leaseId, { ttl = ASSET_LEASE_MS } = {}) {
    if (!Array.isArray(hashes) || hashes.length > 4096) throw error("ASSET_QUERY_INVALID", "素材查询最多包含 4096 个 SHA-256。");
    hashes.forEach(validHash); validId(leaseId); const expires = this.expiry(ttl);
    return this.atomic(() => {
      const missing = [];
      for (const hash of new Set(hashes)) {
        if (this.db.prepare("SELECT 1 FROM asset_blobs WHERE hash=?").get(hash)) this.lease(hash, leaseId, expires); else missing.push(hash);
      }
      return { missing, expiresAt: expires };
    });
  }
  asset(hash, leaseId) {
    return this.assetInfo(hash, leaseId) ? this.checkedBlob(hash) : null;
  }
  assetInfo(hash, leaseId) {
    validHash(hash);
    const used = this.db.prepare("SELECT 1 FROM asset_refs WHERE hash=? LIMIT 1").get(hash);
    const leased = leaseId && this.db.prepare("SELECT 1 FROM asset_uploads WHERE hash=? AND lease_id=? AND expires_at>?").get(hash, validId(leaseId), this.now());
    return used || leased ? this.db.prepare("SELECT size FROM asset_blobs WHERE hash=?").get(hash) : null;
  }
  putDescriptor(namespace, store, id, value, { leaseId, trusted = false } = {}) {
    if (this.readOnly) throw error("WORKSPACE_READ_ONLY", "只读仓储不能写入工作区。");
    this.assertSchema(); assertMaintenanceWritable(this.db);
    this.key(namespace, store, id);
    if (!this.db.isTransaction) throw new Error("文档、引用和回执必须在同一事务内提交。");
    if (!Number.isSafeInteger(value.version) || value.version < 1) throw error("WORKSPACE_VERSION_REQUIRED", "记录版本必须是正整数。");
    if (this.tombstoned(namespace, store, id)) throw error("RESOURCE_REMOVED", "资源已永久删除，旧数据转换不能恢复它。");
    if (value.document?.id !== id) throw error("WORKSPACE_ID_INVALID", "记录标识与文档不一致。");
    const bytes = serialize(value.document), total = validateWorkspaceReferences(namespace, store, value.document, value.refs);
    if (bytes.byteLength + total > MAX_WORKSPACE_BYTES) throw error("WORKSPACE_SIZE_INVALID", "工程文档与素材合计超过 256 MiB。");
    for (const ref of value.refs) {
      const blob = trusted ? this.db.prepare("SELECT size FROM asset_blobs WHERE hash=?").get(ref.hash) : this.assetInfo(ref.hash, leaseId);
      if (!blob || blob.size !== ref.size) throw error("ASSET_MISSING", "素材缺失、上传租约已过期或字节数不匹配，请重新上传。");
    }
    this.db.prepare(`INSERT INTO documents_v2(namespace,store,id,format_version,document,asset_count,resource_version,updated_at,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace,store,id) DO UPDATE SET format_version=excluded.format_version,
      document=excluded.document,asset_count=excluded.asset_count,resource_version=excluded.resource_version,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at`)
      .run(namespace, store, id, WORKSPACE_FORMAT, bytes, value.refs.length, value.version, value.document.updatedAt ?? null, value.document.deletedAt ?? null);
    this.db.prepare("DELETE FROM asset_refs WHERE namespace=? AND store=? AND id=?").run(namespace, store, id);
    const insert = this.db.prepare("INSERT INTO asset_refs VALUES (?,?,?,?,?,?,?)");
    for (const ref of value.refs) insert.run(namespace, store, id, JSON.stringify(ref.path), ref.hash, JSON.stringify(ref.encoding), ref.size);
    if (this.indexProject && namespace === WORKSPACE_NAMESPACES.projects && store === "projects")
      this.indexProject(this.descriptor(namespace, store, id), () => this.record(namespace, store, id));
  }
  // Used by the offline converter and V1 compatibility adapter, not raw HTTP.
  putRecord(namespace, store, record, { version = 1 } = {}) {
    return this.atomic(() => {
      const { document, assets } = decomposeWorkspaceRecord(namespace, store, record);
      const refs = assets.map(({ bytes, ...ref }) => {
        const hash = digest(bytes), old = this.checkedBlob(hash);
        if (!old) this.db.prepare("INSERT INTO asset_blobs VALUES (?,?,?)").run(hash, bytes.byteLength, bytes);
        return { ...ref, hash, size: bytes.byteLength };
      });
      this.putDescriptor(namespace, store, record.id, { document, refs, version }, { trusted: true });
      if (!isDeepStrictEqual(this.record(namespace, store, record.id), record)) throw error("WORKSPACE_CONVERSION_LOSS", "此记录不能无损还原，未完成存储转换。");
      return this.descriptor(namespace, store, record.id);
    });
  }
  tombstoned(namespace, store, id) {
    return namespace === WORKSPACE_NAMESPACES.projects && store === "projects" && Boolean(this.db.prepare("SELECT 1 FROM records WHERE namespace=? AND store='removedProjects' AND id=?").get(namespace, id));
  }
  mutate(command, change, { trackRevision = true } = {}) {
    const { namespace, store, id, mutationId, expectedVersion, operation = "save", leaseId } = command;
    this.key(namespace, store, id); validId(mutationId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw error("WORKSPACE_VERSION_REQUIRED", "保存必须指定基础版本；创建新记录请明确使用版本 0。");
    if (!["save", "trash", "restore", "remove", "delete"].includes(operation)) throw error("WORKSPACE_OPERATION_INVALID", "记录操作不存在。");
    const { leaseId: omittedLease, ...content } = command;
    const requestHash = digest(serialize(canonical(content)));
    return this.atomic(() => {
      if (this.tombstoned(namespace, store, id)) throw error("RESOURCE_REMOVED", "资源已永久删除，迟到保存或旧回执不能恢复它。");
      const previous = this.db.prepare("SELECT request_hash,receipt FROM mutations WHERE namespace=? AND store=? AND id=? AND mutation_id=?").get(namespace, store, id, mutationId);
      if (previous) {
        if (previous.request_hash !== requestHash) throw error("MUTATION_REUSED", "同一保存标识不能用于不同修改。");
        if (!previous.receipt.byteLength) throw error("RESOURCE_REMOVED", "这次保存对应的记录已删除或移动，请使用新保存标识。");
        const receipt = deserialize(Buffer.from(previous.receipt));
        if (receipt.removed) throw error("RESOURCE_REMOVED", "这次保存对应的记录已删除或移动，旧回执不能用于新建的同名记录。");
        const row = this.row(namespace, store, id);
        if (!row) throw error("RESOURCE_REMOVED", "记录已删除，旧保存回执不可重放。");
        if (row.deleted_at && operation === "save") throw error("RESOURCE_TRASHED", "资源已在回收站，旧保存回执不可重放。");
        return receipt;
      }
      const current = this.descriptor(namespace, store, id);
      if ((current?.version || 0) !== expectedVersion) throw conflict();
      if (current?.deletedAt && operation === "save") throw error("RESOURCE_TRASHED", "资源已在回收站，请先恢复再保存。");
      if (operation !== "save" && !current) throw error("RESOURCE_MISSING", "记录不存在。");
      const { receipt, changed = true } = change(current);
      if (changed && trackRevision) this.db.prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
      if (leaseId && operation === "save") {
        const release = this.db.prepare("DELETE FROM asset_uploads WHERE lease_id=? AND hash=?");
        for (const ref of command.refs || []) release.run(validId(leaseId), ref.hash);
      }
      // Permanent deletion retains only its ID tombstone, with no character
      // document, thumbnails or prior receipts. Repeating removal is rejected.
      if (!["remove", "delete"].includes(operation)) this.db.prepare("INSERT INTO mutations VALUES (?,?,?,?,?,?)").run(namespace, store, id, mutationId, requestHash, serialize(receipt));
      return receipt;
    });
  }
  commit(command) {
    const { namespace, store, id, expectedVersion, operation = "save", leaseId } = command;
    if (!["save", "trash", "restore", "remove"].includes(operation)) throw error("WORKSPACE_OPERATION_INVALID", "记录操作不存在。");
    return this.mutate(command, (current) => {
      if (operation !== "save" && (namespace !== WORKSPACE_NAMESPACES.projects || store !== "projects")) throw error("WORKSPACE_OPERATION_INVALID", "回收站操作只用于普通资源。");
      const time = new Date(Math.max(this.now(), (Date.parse(current?.updatedAt) || 0) + 1)).toISOString();
      let changed = true, value, receipt;
      if (operation === "remove") {
        if (!current.deletedAt) throw error("RESOURCE_NOT_TRASHED", "只能永久删除仍在回收站的资源。");
        this.deleteRecord(namespace, store, id);
        legacyRecordWrite(this.db, () => {
          this.db.prepare("DELETE FROM records WHERE namespace=? AND store='projects' AND id=?").run(namespace, id);
          this.db.prepare("INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(namespace,store,id) DO UPDATE SET payload=excluded.payload")
            .run(namespace, "removedProjects", id, serialize({ id, removedAt: time }));
        });
        this.db.prepare("DELETE FROM mutations WHERE namespace=? AND store=? AND id=?").run(namespace, store, id);
        this.removeProjectIndex(id);
        receipt = { id, version: current.version + 1, removed: true };
      } else {
        if (operation === "save") value = { document: structuredClone(command.document), refs: ordered(command.refs || []), version: expectedVersion + 1 };
        else {
          value = { ...current, document: structuredClone(current.document), version: current.version + 1 };
          if (operation === "trash") value.document.deletedAt ||= time;
          else delete value.document.deletedAt;
        }
        if (value.document?.id !== id || (operation === "save" && value.document.deletedAt)) throw error("WORKSPACE_ID_INVALID", "文档标识或保存状态无效。");
        const authored = (document) => { const { updatedAt, ...rest } = document; return canonical(rest); };
        changed = !current || !isDeepStrictEqual(authored(current.document), authored(value.document)) || !isDeepStrictEqual(ordered(current.refs), ordered(value.refs));
        if (changed) {
          value.document.updatedAt = time;
          this.putDescriptor(namespace, store, id, value, { leaseId });
        }
        receipt = { id, version: changed ? value.version : current.version, updatedAt: changed ? time : current.updatedAt,
          ...(value.document.deletedAt ? { deletedAt: value.document.deletedAt } : {}) };
      }
      return { receipt, changed };
    });
  }
  deleteRecord(namespace, store, id) {
    if (this.readOnly) throw error("WORKSPACE_READ_ONLY", "只读仓储不能写入工作区。");
    this.assertSchema(); assertMaintenanceWritable(this.db);
    if (!this.db.isTransaction) throw new Error("删除记录必须在事务内执行。");
    this.db.prepare("DELETE FROM asset_refs WHERE namespace=? AND store=? AND id=?").run(...this.key(namespace, store, id));
    this.db.prepare("DELETE FROM documents_v2 WHERE namespace=? AND store=? AND id=?").run(namespace, store, id);
    const invalidated = new Uint8Array();
    this.db.prepare("UPDATE mutations SET receipt=? WHERE namespace=? AND store=? AND id=? AND receipt IS NOT ?").run(invalidated, namespace, store, id, invalidated);
  }
  check() {
    this.assertSchema();
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN DEFERRED");
    try {
      const report = { format: WORKSPACE_FORMAT, documents: {}, assets: 0, bytes: 0, references: 0, invalid: [] };
      for (const row of this.db.prepare("SELECT namespace,store,id,resource_version,updated_at,deleted_at FROM documents_v2 ORDER BY namespace,store,id").iterate()) {
        const key = `${row.namespace}/${row.store}`; report.documents[key] = (report.documents[key] || 0) + 1;
        try {
          const value = this.descriptor(row.namespace, row.store, row.id);
          if (value.document?.id !== row.id || !Number.isSafeInteger(row.resource_version) || row.resource_version < 1 ||
              (value.document.updatedAt ?? null) !== row.updated_at || (value.document.deletedAt ?? null) !== row.deleted_at || this.tombstoned(row.namespace, row.store, row.id))
            throw error("DOCUMENT_INVALID", "记录标识、版本、时间或删除标记不一致。");
          const total = validateWorkspaceReferences(row.namespace, row.store, value.document, value.refs);
          if (total + serialize(value.document).byteLength > MAX_WORKSPACE_BYTES) throw error("WORKSPACE_SIZE_INVALID", "工程文档与素材合计超限。");
          report.references += value.refs.length;
        } catch (failure) { report.invalid.push({ namespace: row.namespace, store: row.store, id: row.id, code: failure.code || "DOCUMENT_CORRUPT", message: failure.message }); }
      }
      for (const row of this.db.prepare("SELECT hash,size,bytes FROM asset_blobs ORDER BY hash").iterate()) {
        report.assets++; report.bytes += row.size;
        if (!/^[a-f0-9]{64}$/.test(row.hash) || row.bytes.byteLength !== row.size || digest(row.bytes) !== row.hash)
          report.invalid.push({ hash: row.hash, code: "ASSET_CORRUPT" });
      }
      for (const row of this.db.prepare(`SELECT r.namespace,r.store,r.id,r.path,r.hash FROM asset_refs r
        LEFT JOIN documents_v2 d ON d.namespace=r.namespace AND d.store=r.store AND d.id=r.id
        LEFT JOIN asset_blobs b ON b.hash=r.hash WHERE d.id IS NULL OR b.hash IS NULL OR b.size IS NOT r.size`).iterate())
        report.invalid.push({ ...row, code: "ASSET_REFERENCE_CORRUPT" });
      for (const row of this.db.prepare("SELECT u.lease_id,u.hash FROM asset_uploads u LEFT JOIN asset_blobs b ON b.hash=u.hash WHERE b.hash IS NULL").iterate())
        report.invalid.push({ ...row, code: "ASSET_LEASE_INVALID" });
      report.consistent = report.invalid.length === 0;
      if (ownsTransaction) this.db.exec("COMMIT"); return report;
    } catch (failure) { if (ownsTransaction) this.db.exec("ROLLBACK"); throw failure; }
  }
  collect() {
    return this.atomic(() => {
      const expiredLeases = this.db.prepare("DELETE FROM asset_uploads WHERE expires_at<=?").run(this.now()).changes;
      const removedBlobs = this.db.prepare("DELETE FROM asset_blobs WHERE NOT EXISTS(SELECT 1 FROM asset_refs r WHERE r.hash=asset_blobs.hash) AND NOT EXISTS(SELECT 1 FROM asset_uploads u WHERE u.hash=asset_blobs.hash AND u.expires_at>?)").run(this.now()).changes;
      return { expiredLeases, removedBlobs };
    });
  }
}

export const MAINTENANCE_KEY = "workspace.maintenance";
export const MAINTENANCE_WRITER_KEY = "workspace.migration-writer";
export const maintenanceToken = (db) => db.prepare("SELECT value FROM settings WHERE key=?").get(MAINTENANCE_KEY)?.value || "";
export const maintenanceError = () => Object.assign(new Error("工作区正在维护，当前修改仍保留。请等待维护完成后重试。"), { code: "WORKSPACE_MAINTENANCE" });
export function assertMaintenanceWritable(db) {
  const token = maintenanceToken(db);
  if (token && db.prepare("SELECT value FROM settings WHERE key=?").get(MAINTENANCE_WRITER_KEY)?.value !== token) throw maintenanceError();
}
export function withMaintenanceWriter(db, token, action) {
  if (!db.isTransaction || !token || maintenanceToken(db) !== token) throw maintenanceError();
  const previous = db.prepare("SELECT value FROM settings WHERE key=?").get(MAINTENANCE_WRITER_KEY)?.value || "";
  db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(MAINTENANCE_WRITER_KEY, token);
  try { return action(); }
  finally { db.prepare("UPDATE settings SET value=? WHERE key=?").run(previous, MAINTENANCE_WRITER_KEY); }
}

export function installMigrationGuards(db) {
  const present = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
  const active = `COALESCE((SELECT value FROM settings WHERE key='${MAINTENANCE_KEY}'),'')`;
  const permission = `COALESCE((SELECT value FROM settings WHERE key='${MAINTENANCE_WRITER_KEY}'),'')`;
  const frozen = `${active}<>'' AND ${permission} IS NOT ${active}`;
  const tables = ["records", "migrations", "documents_v2", "asset_refs", "asset_blobs", "mutations", "asset_uploads", "project_index", "project_thumbnails", "project_index_dirty", "workspace_migrations", "workspace_migration_rows", "records_v1_stage"];
  for (const table of tables.filter((name) => present.has(name))) for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS migration_freeze_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
      WHEN ${frozen} BEGIN SELECT RAISE(ABORT,'WORKSPACE_MAINTENANCE: 工作区正在维护'); END;`);
  }
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const item = operation === "DELETE" ? "OLD" : "NEW";
    // Identical INSERT OR IGNORE attempts during service startup are harmless.
    const sameInsert = operation === "INSERT" ? "AND NOT EXISTS(SELECT 1 FROM settings s WHERE s.key=NEW.key AND s.value IS NEW.value)" : "";
    db.exec(`CREATE TRIGGER IF NOT EXISTS migration_freeze_settings_${operation.toLowerCase()} BEFORE ${operation} ON settings
      WHEN ${frozen} AND ${item}.key<>'${MAINTENANCE_WRITER_KEY}' ${sameInsert}
      BEGIN SELECT RAISE(ABORT,'WORKSPACE_MAINTENANCE: 工作区正在维护'); END;`);
  }
  // A retired V2 program must not keep writing its former tables after reverse
  // conversion. Only the current maintenance transaction may rebuild them.
  for (const table of ["documents_v2", "asset_refs", "asset_blobs", "mutations", "asset_uploads"].filter((name) => present.has(name))) for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const canClean = ["documents_v2", "asset_refs", "mutations"].includes(table) && operation === "DELETE"
      ? "AND EXISTS(SELECT 1 FROM records r WHERE r.namespace=OLD.namespace AND r.store=OLD.store AND r.id=OLD.id)" : "";
    const invalidation = table === "mutations" && operation === "UPDATE"
      ? "AND NOT (length(NEW.receipt)=0 AND NEW.namespace IS OLD.namespace AND NEW.store IS OLD.store AND NEW.id IS OLD.id AND NEW.mutation_id IS OLD.mutation_id AND NEW.request_hash IS OLD.request_hash AND NOT EXISTS(SELECT 1 FROM records r WHERE r.namespace=OLD.namespace AND r.store=OLD.store AND r.id=OLD.id))" : "";
    db.exec(`CREATE TRIGGER IF NOT EXISTS migration_inactive_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
      WHEN COALESCE((SELECT value FROM settings WHERE key='workspace.active-format'),'1')<>'2'
        AND NOT (${active}<>'' AND ${permission} IS ${active}) ${canClean} ${invalidation}
      BEGIN SELECT RAISE(ABORT,'WORKSPACE_REFRESH_REQUIRED: 旧存储分支不可写'); END;`);
  }
  if (present.has("documents_v2")) db.exec(`CREATE TRIGGER IF NOT EXISTS migration_retired_v2_cleanup AFTER DELETE ON records
    WHEN COALESCE((SELECT value FROM settings WHERE key='workspace.active-format'),'1')='1' AND ${active}=''
    BEGIN DELETE FROM asset_refs WHERE namespace=OLD.namespace AND store=OLD.store AND id=OLD.id;
      DELETE FROM documents_v2 WHERE namespace=OLD.namespace AND store=OLD.store AND id=OLD.id;
      UPDATE mutations SET receipt=X'' WHERE namespace=OLD.namespace AND store=OLD.store AND id=OLD.id; END;`);
}

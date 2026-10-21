import { WORKSPACE_NAMESPACES } from "../../shared/domain/workspace-assets.mjs";

export const ACTIVE_FORMAT_KEY = "workspace.active-format";
export const activeWorkspaceFormat = (db) => Number(db.prepare("SELECT value FROM settings WHERE key=?").get(ACTIVE_FORMAT_KEY)?.value || 1);
export const refreshRequired = () => Object.assign(new Error("本机工作区已切换，请刷新工作台后再保存；当前本地修改仍保留。"), { code: "WORKSPACE_REFRESH_REQUIRED" });

// The permission is visible only inside the owning SQLite write transaction.
// Other connections see the locked state; a crash rolls it back automatically.
export function legacyRecordWrite(db, fn) {
  if (activeWorkspaceFormat(db) !== 2) return fn();
  if (!db.isTransaction) throw new Error("兼容写入必须位于工作区事务内。");
  const key = "workspace.compatible-write", previous = db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value || "0";
  db.prepare("INSERT INTO settings VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value='1'").run(key);
  try { return fn(); }
  finally { db.prepare("UPDATE settings SET value=? WHERE key=?").run(previous, key); }
}

export function installLegacyGuards(db) {
  db.prepare("INSERT OR IGNORE INTO settings VALUES ('workspace.compatible-write','0')").run();
  const namespaces = Object.values(WORKSPACE_NAMESPACES).map((value) => `'${value}'`).join(",");
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const scope = operation === "UPDATE" ? `(NEW.namespace IN (${namespaces}) OR OLD.namespace IN (${namespaces}))` : `${operation === "DELETE" ? "OLD" : "NEW"}.namespace IN (${namespaces})`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS workspace_v2_guard_${operation.toLowerCase()} BEFORE ${operation} ON records
      WHEN (SELECT value FROM settings WHERE key='${ACTIVE_FORMAT_KEY}')='2'
        AND (SELECT value FROM settings WHERE key='workspace.compatible-write') IS NOT '1' AND ${scope}
      BEGIN SELECT RAISE(ABORT,'WORKSPACE_REFRESH_REQUIRED: 本机数据已升级，请刷新工作台'); END;`);
  }
}

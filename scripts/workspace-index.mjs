import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { ProjectIndex } from "../server/workspace/project-index.mjs";
import { WorkspaceV2Repository } from "../server/workspace/v2-repository.mjs";
import { createV2ProjectIndex } from "../server/workspace/v2-index.mjs";
import { activeWorkspaceFormat } from "../server/workspace/v2-mode.mjs";

const [directory, mode] = process.argv.slice(2);
if (!directory || !["--check", "--rebuild"].includes(mode)) throw new Error("Usage: node scripts/workspace-index.mjs <workspace-directory> --check|--rebuild");
const path = join(resolve(directory), "workspace.sqlite");
if (!existsSync(path)) throw new Error("Workspace database does not exist; no database was created.");
const db = new DatabaseSync(path, { readOnly: mode === "--check" });
try {
  const format = activeWorkspaceFormat(db);
  if (![1,2].includes(format)) throw new Error("Unsupported workspace format; no index was changed.");
  const index = format === 2 ? createV2ProjectIndex(db, new WorkspaceV2Repository(db, { readOnly: true })) : new ProjectIndex(db);
  if (mode === "--rebuild") index.rebuild();
  db.exec("BEGIN DEFERRED");
  const report = index.check(); db.exec("COMMIT");
  console.log(JSON.stringify(report, null, 2));
  if (!report.consistent) process.exitCode = 1;
} catch (error) {
  if (db.isTransaction) db.exec("ROLLBACK");
  throw error;
} finally { db.close(); }

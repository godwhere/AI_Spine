import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { WorkspaceMigration } from "../server/workspace/migration.mjs";

const [directory, action, ...args] = process.argv.slice(2);
const actions = ["--status", "--prepare", "--resume", "--verify", "--activate", "--abort"];
if (!directory || !actions.includes(action) || args.some((value) => !/^--(?:to=[12]|backup=.+|batch=\d+)$/.test(value)))
  throw new Error("Usage: node scripts/migrate-workspace.mjs <workspace-directory> --status|--prepare --to=2|1 --backup=<new-file>|--resume [--batch=10]|--verify|--activate|--abort");
const path = join(resolve(directory), "workspace.sqlite");
if (!existsSync(path)) throw new Error("Explicit workspace database does not exist; no database was created.");
const option = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const db = new DatabaseSync(path, { readOnly: action === "--status" });
try {
  const migration = new WorkspaceMigration(db);
  if (action === "--prepare") migration.begin(Number(option("to")), option("backup"));
  else if (action === "--resume") await migration.stage({ batchSize: Number(option("batch") || 10) });
  else if (action === "--verify") migration.verify();
  else if (action === "--activate") await migration.activate();
  else if (action === "--abort") migration.abort();
  console.log(JSON.stringify(migration.status(), null, 2));
} finally { db.close(); }

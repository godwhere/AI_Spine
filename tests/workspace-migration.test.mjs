import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWorkspaceStore } from "../server/bootstrap/workspace.mjs";
import { WorkspaceMigration } from "../server/workspace/migration.mjs";
import { WorkspaceV2Repository } from "../server/workspace/v2-repository.mjs";
import { WORKSPACE_NAMESPACES as NS } from "../shared/domain/workspace-assets.mjs";
import { createCustomTemplateRecord } from "../engine/archive/template-snapshot.js";
import { template } from "./helpers.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originalRows = (db) => db.prepare("SELECT namespace,store,id,payload FROM records ORDER BY rowid").all().map((row) => ({ ...row, payload: digest(row.payload) }));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ispine-migration-")), opened = [];
  const open = () => { const store = createWorkspaceStore(root); opened.push(store); return store; };
  const store = open(), bundle = template("22");
  for (const id of ["active", "trash"]) store.call("projects", "save", [{ id, name: id, files: bundle.files, edits: {}, generation: {}, skeletonPath: bundle.skeletonPath,
    thumbnail: png, extension: { retained: new Uint8Array([8, 6, 7]), marker: { $ispineAsset: 2 } } }]);
  store.call("projects", "trash", ["trash"]); store.put(NS.projects, "removedProjects", { id: "removed", removedAt: "2026-01-01" });
  store.call("drafts", "save", [{ version: 1, id: "draft", name: "Source draft", width: 1, height: 1, sourceImage: png, joints: [], parts: [], motions: [] }]);
  store.call("templates", "save", [createCustomTemplateRecord({ id: "active", name: "Custom", skeletonPath: bundle.skeletonPath, thumbnail: png }, bundle.files)]);
  store.put("extension-namespace", "future-store", { id: "future", unknown: { values: [1, "kept", false], image: png, bytes: new Uint8Array([4, 3]) } });
  store.db.prepare("INSERT INTO migrations VALUES (?,?,?,?,?)").run("legacy-profile", NS.projects, "active", "source-hash", "active");
  store.db.prepare("INSERT INTO settings VALUES ('future-setting','kept')").run();
  t.after(async () => { for (const item of opened) if (item.db.isOpen) item.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, open, backup: (name) => join(root, `${name}.sqlite`) };
}

test("checkpointed conversion freezes old writers and preserves every namespace, source byte, identity and revision", async (t) => {
  const { store, root, open, backup } = await fixture(t), before = originalRows(store.db), identity = store.status(), linked = store.db.prepare("SELECT * FROM migrations").all();
  const migration = new WorkspaceMigration(store.db); migration.begin(2, backup("forward"));
  assert.equal(store.status().maintenance, true); assert.equal(store.status().writable, false);
  assert.throws(() => store.call("projects", "save", [{ id: "late", name: "Late", files: {} }]), { code: "WORKSPACE_MAINTENANCE" });
  assert.equal(store.call("projects", "list").projects.length, 1);
  const legacy = new DatabaseSync(join(root, "workspace.sqlite")); t.after(() => legacy.close());
  assert.throws(() => legacy.prepare("INSERT INTO records VALUES (?,?,?,?)").run(NS.projects, "projects", "late", serialize({ id: "late" })), /WORKSPACE_MAINTENANCE/);
  assert.throws(() => legacy.exec("UPDATE settings SET value='999' WHERE key='revision'"), /WORKSPACE_MAINTENANCE/);
  await migration.stage({ batchSize: 2, maxBatches: 1 }); assert.equal(migration.status().checkpoint, 2);
  const resumed = new WorkspaceMigration(store.db); await resumed.stage({ batchSize: 2 });
  assert.equal(resumed.verify().consistent, true); resumed.verify();
  assert.deepEqual(originalRows(store.db), before); assert.equal(store.status().revision, identity.revision);
  await resumed.activate(); assert.equal(resumed.status().state, "activated");
  assert.throws(() => store.call("projects", "get", ["active"]), { code: "WORKSPACE_REFRESH_REQUIRED" });
  const current = open(); assert.equal(current.status().id, identity.id); assert.equal(current.status().revision, identity.revision);
  assert.equal(current.status().version, 2); assert.equal(current.status().writable, true);
  assert.deepEqual(originalRows(current.db), before); assert.deepEqual(current.db.prepare("SELECT * FROM migrations").all(), linked);
  assert.equal(current.get("extension-namespace", "future-store", "future").unknown.image, png);
  assert.equal(current.call("drafts", "get", ["draft"]).document.sourceImage, png);
  assert.equal(current.call("projects", "list").trash.length, 1); assert.equal(current.v2.check().consistent, true); assert.equal(current.checkProjectIndex().consistent, true);
  assert.ok((await stat(backup("forward"))).size > 0);
});

test("reverse conversion keeps post-activation edits and later V1 permanent deletion also removes retired V2 copies", async (t) => {
  const { store, open, backup } = await fixture(t), forward = new WorkspaceMigration(store.db); forward.begin(2, backup("before-v2"));
  await forward.stage(); forward.verify(); await forward.activate(); const v2 = open();
  const before = v2.call("projects", "get", ["active"]);
  const edited = v2.call("projects", "save", [{ ...before, name: "Written after activation", generation: { appearancePrompt: "New authored content" }, extension: { ...before.extension, postActivation: [1,2,3] } }, { expectedUpdatedAt: before.updatedAt }]);
  const revision = v2.status().revision, reverse = new WorkspaceMigration(v2.db); reverse.begin(1, backup("before-reverse"));
  await reverse.stage({ batchSize: 2, maxBatches: 1 });
  const resumed = new WorkspaceMigration(v2.db); await resumed.stage(); assert.equal(resumed.verify().consistent, true); await resumed.activate();
  const v1 = open(); assert.equal(v1.status().version, 1); assert.equal(v1.status().revision, revision);
  assert.deepEqual(v1.call("projects", "get", ["active"]), edited); assert.equal(v1.db.prepare("SELECT count(*) AS n FROM records_v1_stage").get().n, 0);
  const retired = new WorkspaceV2Repository(v1.db);
  assert.throws(() => retired.putRecord(NS.projects, "projects", { ...edited, name: "Forbidden retired write" }), /旧存储分支不可写/);
  v1.call("projects", "trash", ["active"]); v1.call("projects", "remove", [["active"]]);
  assert.equal(retired.record(NS.projects, "projects", "active"), null);
  assert.equal(v1.call("templates", "get", ["custom-active"]).sourceProjectId, "active");
  const again = new WorkspaceMigration(v1.db); again.begin(2, backup("forward-again")); await again.stage(); again.verify(); await again.activate();
  const current = open(); assert.equal(current.call("projects", "get", ["active"]), null);
  assert.equal(current.call("templates", "get", ["custom-active"]).sourceProjectId, "active"); assert.equal(current.v2.check().consistent, true);
});

test("a failure before activation commit rolls back format, index and release; abort restores the untouched original", async (t) => {
  const { store, backup } = await fixture(t), before = originalRows(store.db);
  const migration = new WorkspaceMigration(store.db, { onCheckpoint: (step) => { if (step === "before-commit") throw new Error("Simulated switch interruption"); } });
  migration.begin(2, backup("atomic")); await migration.stage(); migration.verify();
  await assert.rejects(migration.activate(), /switch interruption/);
  assert.equal(store.status().version, 1); assert.equal(store.status().maintenance, true); assert.equal(migration.status().state, "validated");
  assert.deepEqual(originalRows(store.db), before);
  migration.abort(); assert.equal(store.status().writable, true); assert.deepEqual(originalRows(store.db), before); assert.equal(store.checkProjectIndex().consistent, true);
});

test("corrupt or unsupported original data is identified and never skipped or overwritten", async (t) => {
  const { store, backup } = await fixture(t);
  store.put("extension-namespace", "future-store", { id: "unsupported", retained: new Map([["future", "value"]]) });
  const before = originalRows(store.db), migration = new WorkspaceMigration(store.db); migration.begin(2, backup("unsupported"));
  await assert.rejects(migration.stage({ batchSize: 1 }), (error) => error.id === "unsupported" && error.code === "WORKSPACE_MIGRATION_FAILED");
  assert.deepEqual(originalRows(store.db), before); assert.equal(store.status().version, 1);
  migration.abort(); assert.equal(store.status().writable, true);
  const corrupt = new WorkspaceMigration(store.db);
  store.db.prepare("INSERT INTO records VALUES (?,?,?,?)").run("extension-namespace", "future-store", "broken", new Uint8Array([0,1,2]));
  store.remove("extension-namespace", "future-store", "unsupported"); corrupt.begin(2, backup("corrupt"));
  await assert.rejects(corrupt.stage({ batchSize: 1 }), (error) => error.id === "broken" && error.message.includes("无法还原"));
  corrupt.abort(); assert.equal(store.db.prepare("SELECT payload FROM records WHERE id='broken'").get().payload.byteLength, 3);
});

test("backup tampering and target damage stop activation without releasing maintenance or changing source records", async (t) => {
  const { store, backup } = await fixture(t), migration = new WorkspaceMigration(store.db); migration.begin(2, backup("checked"));
  await migration.stage(); migration.verify();
  const row = migration.row(); migration.owner(row, () => store.db.prepare("UPDATE documents_v2 SET resource_version=42 WHERE id='active'").run());
  assert.throws(() => migration.verify(), /目标指纹不一致/); assert.equal(store.status().version, 1);
  migration.abort();
  const next = new WorkspaceMigration(store.db); next.begin(2, backup("backup-tamper")); await next.stage(); next.verify();
  await appendFile(backup("backup-tamper"), new Uint8Array([1,2,3]));
  await assert.rejects(next.activate(), /备份缺失或已改变/); assert.equal(store.status().maintenance, true); next.abort();
});

test("process exits at every forward checkpoint resume without duplicate or missing records", async (t) => {
  for (const stop of ["frozen", "backed-up", "batch", "validated", "before-commit", "activated"]) await t.test(stop, async (t) => {
    const { store, root, backup, open } = await fixture(t); store.close();
    const module = new URL("../server/workspace/migration.mjs", import.meta.url).href;
    const script = `import {DatabaseSync} from 'node:sqlite'; import {WorkspaceMigration} from ${JSON.stringify(module)};
      const db=new DatabaseSync(${JSON.stringify(join(root,"workspace.sqlite"))});
      const migration=new WorkspaceMigration(db,{onCheckpoint:(step)=>{if(step===${JSON.stringify(stop)})process.exit(17)}});
      migration.begin(2,${JSON.stringify(backup("process-exit"))}); await migration.stage({batchSize:2}); migration.verify(); await migration.activate();`;
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" }), (error) => error.status === 17);
    const current = open(), resumed = new WorkspaceMigration(current.db);
    if (stop !== "activated") { await resumed.stage({ batchSize: 1 }); resumed.verify(); }
    await resumed.activate();
    const result = open(); assert.equal(result.v2.check().consistent, true); assert.equal(result.call("projects", "list").projects.length, 1);
  });
});

test("process exit during reverse activation preserves the latest V2 author edit before and after resuming", async (t) => {
  const { store, root, backup, open } = await fixture(t), forward = new WorkspaceMigration(store.db);
  forward.begin(2, backup("first")); await forward.stage(); forward.verify(); await forward.activate(); store.close();
  const active = open(), project = active.call("projects", "get", ["active"]);
  const latest = active.call("projects", "save", [{ ...project, name: "Latest before reverse crash" }, { expectedUpdatedAt: project.updatedAt }]); active.close();
  const module = new URL("../server/workspace/migration.mjs", import.meta.url).href;
  const script = `import {DatabaseSync} from 'node:sqlite'; import {WorkspaceMigration} from ${JSON.stringify(module)};
    const db=new DatabaseSync(${JSON.stringify(join(root,"workspace.sqlite"))});
    const migration=new WorkspaceMigration(db,{onCheckpoint:(step)=>{if(step==='before-commit')process.exit(19)}});
    migration.begin(1,${JSON.stringify(backup("reverse-crash"))}); await migration.stage({batchSize:2}); migration.verify(); await migration.activate();`;
  assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" }), (error) => error.status === 19);
  const crashed = open(); assert.equal(crashed.status().version, 2); assert.deepEqual(crashed.call("projects", "get", ["active"]), latest);
  await new WorkspaceMigration(crashed.db).activate();
  assert.deepEqual(open().call("projects", "get", ["active"]), latest);
});

test("read-only V2 inspection creates no schema and missing declared tables cannot be silently recreated", async (t) => {
  const { store, root, backup } = await fixture(t), migration = new WorkspaceMigration(store.db);
  migration.begin(2, backup("inspection")); await migration.stage(); migration.verify(); await migration.activate();
  const db = new DatabaseSync(join(root, "workspace.sqlite"), { readOnly: true });
  try {
    const before = db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all();
    const repository = new WorkspaceV2Repository(db, { readOnly: true });
    assert.equal(repository.check().consistent, true);
    assert.throws(() => repository.putRecord(NS.projects, "projects", { id: "rejected" }), { code: "WORKSPACE_READ_ONLY" });
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_schema ORDER BY name").all(), before);
  } finally { db.close(); }
  store.db.exec("DROP TABLE asset_uploads");
  assert.throws(() => new WorkspaceV2Repository(store.db), { code: "ASSET_REFERENCE_CORRUPT" });
  assert.equal(store.db.prepare("SELECT name FROM sqlite_schema WHERE name='asset_uploads'").get(), undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { createWorkspaceStore } from "../server/bootstrap/workspace.mjs";
import { ProjectIndex, PROJECT_NAMESPACE } from "../server/workspace/project-index.mjs";
import { startWorkbenchServer } from "../server/bootstrap/workbench.mjs";

const record = (id = "resource") => ({ id, name: `Name ${id}`, files: { "source.png": new Uint8Array(1024 * 1024) },
  edits: { body: { image: new Uint8Array(20) } }, generation: { appearance: { image: new Uint8Array(40) } }, partCount: 12, boneCount: 8, animationCount: 4 });
async function fixture(t, legacy = false) {
  const root = await mkdtemp(join(tmpdir(), "ispine-project-index-")), path = join(root, "workspace.sqlite");
  let store;
  t.after(async () => { store?.close(); await rm(root, { recursive: true, force: true }); });
  if (legacy) {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE records(namespace TEXT,store TEXT,id TEXT,payload BLOB NOT NULL,PRIMARY KEY(namespace,store,id)); CREATE TABLE migrations(source TEXT,namespace TEXT,id TEXT,hash TEXT,destination TEXT,PRIMARY KEY(source,namespace,id,hash)); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES ('id','legacy-identity'),('revision','17');");
    return { root, db, open: () => store = createWorkspaceStore(root) };
  }
  store = createWorkspaceStore(root); return { root, store };
}

test("summary and list read only the index, not source payloads, and perform no write transaction", async (t) => {
  const { store } = await fixture(t); store.call("projects", "save", [record()]);
  const revision = store.status().revision, prepare = store.db.prepare.bind(store.db), exec = store.db.exec.bind(store.db), sql = [];
  store.db.prepare = (text) => { sql.push(text); assert.ok(!/SELECT[\s\S]*payload[\s\S]*FROM records/i.test(text), text); return prepare(text); };
  store.db.exec = (text) => { sql.push(text); assert.ok(!/BEGIN IMMEDIATE/i.test(text), text); return exec(text); };
  store.projectIndex.decode = () => assert.fail("A library query cannot deserialize a source project");
  for (const operation of ["summary", "list"]) {
    const value = store.call("projects", operation).projects[0];
    assert.equal(value.files, undefined); assert.equal(value.edits, undefined); assert.equal(value.generation, undefined);
    assert.equal(value.partCount, 12); assert.equal(value.boneCount, 8); assert.equal(value.replacementCount, 1);
  }
  assert.equal(store.status().revision, revision); assert.ok(sql.some((text) => text.includes("BEGIN DEFERRED")));
});

test("legacy backfill and repeated rebuild preserve every source byte, version and database identity", async (t) => {
  const { db, open } = await fixture(t, true), original = record(), bytes = serialize(original);
  db.prepare("INSERT INTO records VALUES (?,?,?,?)").run(PROJECT_NAMESPACE, "projects", original.id, bytes); db.close();
  const store = open(); assert.equal(store.status().id, "legacy-identity"); assert.equal(store.status().revision, 17);
  assert.equal(store.checkProjectIndex().consistent, true);
  const before = store.db.prepare("SELECT total_changes() AS n").get().n;
  store.rebuildProjectIndex(); store.rebuildProjectIndex();
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, before);
  assert.deepEqual(new Uint8Array(store.db.prepare("SELECT payload FROM records WHERE id=?").get(original.id).payload), new Uint8Array(bytes));
  assert.equal(store.status().revision, 17);
});

test("a corrupt legacy row reports its identity and rolls back the entire first backfill", async (t) => {
  const { root, db, open } = await fixture(t, true);
  db.prepare("INSERT INTO records VALUES (?,?,?,?)").run(PROJECT_NAMESPACE, "projects", "valid", serialize(record("valid")));
  db.prepare("INSERT INTO records VALUES (?,?,?,?)").run(PROJECT_NAMESPACE, "projects", "broken", new Uint8Array([0, 1, 2])); db.close();
  assert.throws(open, (error) => error.code === "PROJECT_INDEX_CORRUPT" && error.id === "broken" && error.message.includes("反序列化"));
  const inspected = new DatabaseSync(join(root, "workspace.sqlite")); t.after(() => inspected.close());
  assert.equal(inspected.prepare("SELECT count(*) AS n FROM records").get().n, 2);
  assert.equal(inspected.prepare("SELECT 1 FROM settings WHERE key='project-index.version'").get(), undefined);
  assert.equal(inspected.prepare("SELECT 1 FROM sqlite_schema WHERE name='project_index'").get(), undefined);
  const report = new ProjectIndex(inspected).check(); assert.equal(report.consistent, false); assert.equal(report.invalid[0].id, "broken");
});

test("SQLite failure after source and summary writes rolls both back with thumbnail and revision", async (t) => {
  const { store } = await fixture(t), image = "data:image/png;base64," + Buffer.from([1, 2, 3]).toString("base64");
  const saved = store.call("projects", "save", [{ ...record(), thumbnail: image }]), before = store.call("projects", "summary"), revision = store.status().revision;
  store.db.exec("CREATE TRIGGER interrupt_thumbnail AFTER UPDATE ON project_thumbnails BEGIN SELECT RAISE(ABORT,'simulated interruption'); END;");
  assert.throws(() => store.call("projects", "save", [{ ...saved, name: "Interrupted", thumbnail: "data:image/png;base64,BAUG" }]), /simulated interruption/);
  assert.deepEqual(store.call("projects", "get", [saved.id]), saved); assert.deepEqual(store.call("projects", "summary"), before);
  assert.equal(store.status().revision, revision); assert.equal(store.checkProjectIndex().consistent, true);
  store.db.exec("DROP TRIGGER interrupt_thumbnail; UPDATE project_thumbnails SET bytes=X'0000';");
  assert.deepEqual(store.checkProjectIndex().stale, [saved.id]); store.rebuildProjectIndex();
  assert.equal(store.checkProjectIndex().consistent, true); assert.equal(store.status().revision, revision);
});

test("migration, trash, restore, tombstones and no-op writes keep the index atomic and idempotent", async (t) => {
  const { store } = await fixture(t), original = { ...record(), updatedAt: "2026-10-20T00:00:00Z" }, snapshot = { [PROJECT_NAMESPACE]: { projects: [original] } };
  store.migrate("source", snapshot); const migratedRevision = store.status().revision;
  store.migrate("source", snapshot); assert.equal(store.status().revision, migratedRevision);
  const saved = store.call("projects", "get", [original.id]);
  store.call("projects", "save", [saved]); store.call("projects", "restore", [saved.id]); assert.equal(store.status().revision, migratedRevision);
  store.call("projects", "trash", [saved.id]); const trashedRevision = store.status().revision;
  store.call("projects", "trash", [saved.id]); assert.equal(store.status().revision, trashedRevision);
  assert.equal(store.call("projects", "summary").trash[0].name, saved.name);
  store.call("projects", "restore", [saved.id]); store.call("projects", "trash", [saved.id]); store.call("projects", "remove", [[saved.id]]);
  assert.deepEqual(store.call("projects", "summary"), { projects: [], trash: [], hasDeletedProjects: true });
  assert.equal(store.checkProjectIndex().consistent, true); assert.equal(store.db.prepare("SELECT count(*) AS n FROM project_thumbnails").get().n, 0);
});

test("older writers mark the index dirty, listing fails explicitly, and startup or rebuild repairs it", async (t) => {
  const { root, store } = await fixture(t); const saved = store.call("projects", "save", [record()]);
  const old = new DatabaseSync(join(root, "workspace.sqlite")); t.after(() => old.close());
  old.prepare("UPDATE records SET payload=? WHERE namespace=? AND store='projects' AND id=?").run(serialize({ ...saved, name: "Older writer" }), PROJECT_NAMESPACE, saved.id);
  assert.throws(() => store.call("projects", "summary"), { code: "PROJECT_INDEX_OUTDATED" });
  assert.deepEqual(store.checkProjectIndex().dirty, [saved.id]);
  const reopened = createWorkspaceStore(root); t.after(() => reopened.close());
  assert.equal(reopened.call("projects", "summary").projects[0].name, "Older writer");
  store.db.prepare("UPDATE project_index SET summary='{}' WHERE id=?").run(saved.id);
  assert.throws(() => store.call("projects", "summary"), { code: "PROJECT_INDEX_CORRUPT" });
  assert.deepEqual(store.checkProjectIndex().stale, [saved.id]); store.rebuildProjectIndex(); assert.equal(store.checkProjectIndex().consistent, true);
  store.db.prepare("UPDATE project_index SET name='wrong',updated_at='wrong',deleted_at='wrong' WHERE id=?").run(saved.id);
  assert.deepEqual(store.checkProjectIndex().stale, [saved.id]); store.rebuildProjectIndex(); assert.equal(store.checkProjectIndex().consistent, true);
});

test("read transactions can browse a committed snapshot while another connection holds the write lock", async (t) => {
  const { root, store } = await fixture(t); const saved = store.call("projects", "save", [record()]);
  const writer = new DatabaseSync(join(root, "workspace.sqlite")); t.after(() => writer.close());
  writer.exec("BEGIN IMMEDIATE");
  try {
    writer.prepare("UPDATE records SET payload=? WHERE id=?").run(serialize({ ...saved, name: "Uncommitted" }), saved.id);
    assert.equal(store.call("projects", "summary").projects[0].name, saved.name);
    assert.equal(store.call("projects", "get", [saved.id]).name, saved.name);
    assert.deepEqual(store.call("drafts", "list"), []); assert.deepEqual(store.call("templates", "list"), []);
  } finally { writer.exec("ROLLBACK"); }
});

test("large thumbnails stay outside list JSON and their local endpoint enforces origin, hash and deletion", async (t) => {
  const { root, store } = await fixture(t), clientRoot = join(root, "client"); await mkdir(clientRoot); await writeFile(join(clientRoot, "index.html"), "<!doctype html>");
  const image = new Uint8Array(300 * 1024).fill(17), saved = store.call("projects", "save", [{ ...record("thumb/id"), thumbnail: `data:image/png;base64,${Buffer.from(image).toString("base64")}` }]);
  const summary = store.call("projects", "summary").projects[0]; assert.ok(JSON.stringify(summary).length < 2048); assert.equal(summary.files, undefined);
  const server = await startWorkbenchServer({ clientRoot, dataRoot: root, mode: "test", port: 0, jobs: { close() {} } }); t.after(() => server.close());
  server.store.call("projects", "save", [saved]);
  const prepare = server.store.db.prepare.bind(server.store.db);
  server.store.db.prepare = (sql) => { assert.ok(!/SELECT[\s\S]*payload[\s\S]*FROM records/i.test(sql)); return prepare(sql); };
  const response = await fetch(server.origin + summary.thumbnail);
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png"); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image);
  assert.equal((await fetch(server.origin + summary.thumbnail, { headers: { Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await fetch(server.origin + summary.thumbnail.replace(summary.thumbnailRef.hash, "0".repeat(64)))).status, 404);
  server.store.db.prepare = prepare;
  server.store.call("projects", "trash", [saved.id]); server.store.call("projects", "remove", [[saved.id]]);
  assert.equal((await fetch(server.origin + summary.thumbnail)).status, 404);
});


test("future index versions reject startup and running project writes without replacing source data", async (t) => {
  const { root, store } = await fixture(t), saved = store.call("projects", "save", [record()]), revision = store.status().revision;
  store.db.prepare("UPDATE settings SET value='999' WHERE key='project-index.version'").run();
  assert.throws(() => createWorkspaceStore(root), { code: "PROJECT_INDEX_VERSION" });
  assert.throws(() => store.call("projects", "save", [{ ...saved, name: "Old writer" }]), { code: "PROJECT_INDEX_VERSION" });
  assert.throws(() => store.call("projects", "summary"), { code: "PROJECT_INDEX_VERSION" });
  assert.throws(() => store.call("projects", "trash", [saved.id]), { code: "PROJECT_INDEX_VERSION" });
  assert.throws(() => store.call("projects", "remove", [[saved.id]]), { code: "PROJECT_INDEX_VERSION" });
  assert.throws(() => store.migrate("future", {}), { code: "PROJECT_INDEX_VERSION" });
  assert.deepEqual(store.call("projects", "get", [saved.id]), saved); assert.equal(store.status().revision, revision);
  assert.throws(() => store.rebuildProjectIndex(), { code: "PROJECT_INDEX_VERSION" });
});

test("an older writer's permanent deletion removes cached character data in its original transaction", async (t) => {
  const { root, store } = await fixture(t), thumbnail = "data:image/png;base64,AQID";
  store.call("projects", "save", [{ ...record(), thumbnail }]);
  const old = new DatabaseSync(join(root, "workspace.sqlite")); t.after(() => old.close());
  old.exec("BEGIN IMMEDIATE");
  old.prepare("DELETE FROM records WHERE namespace=? AND store='projects' AND id=?").run(PROJECT_NAMESPACE, "resource");
  assert.equal(old.prepare("SELECT count(*) AS n FROM project_thumbnails").get().n, 0);
  assert.equal(old.prepare("SELECT count(*) AS n FROM project_index").get().n, 0);
  old.exec("ROLLBACK"); assert.equal(store.call("projects", "summary").projects.length, 1);
  old.exec("BEGIN IMMEDIATE");
  old.prepare("INSERT INTO records VALUES (?,?,?,?)").run(PROJECT_NAMESPACE, "removedProjects", "resource", serialize({ id: "resource", removedAt: "2026-10-21T00:00:00Z" }));
  old.prepare("DELETE FROM records WHERE namespace=? AND store='projects' AND id=?").run(PROJECT_NAMESPACE, "resource"); old.exec("COMMIT");
  assert.equal(old.prepare("SELECT count(*) AS n FROM project_thumbnails").get().n, 0);
  assert.throws(() => store.call("projects", "summary"), { code: "PROJECT_INDEX_OUTDATED" });
  store.rebuildProjectIndex(); assert.deepEqual(store.call("projects", "summary"), { projects: [], trash: [], hasDeletedProjects: true });
  assert.equal(store.checkProjectIndex().consistent, true);
});

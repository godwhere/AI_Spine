import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";
import { createWorkspaceStore } from "../server/bootstrap/workspace.mjs";
import { WorkspaceV2Repository } from "../server/workspace/v2-repository.mjs";
import { encodeWorkspace } from "../shared/workspace-codec.mjs";
import { decomposeWorkspaceRecord, composeWorkspaceRecord, validateWorkspaceReferences,
  WORKSPACE_NAMESPACES as NS, MAX_WORKSPACE_BYTES } from "../shared/domain/workspace-assets.mjs";
import { template } from "./helpers.mjs";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const picture = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const original = (id = "character") => ({ id, name: "Character", updatedAt: "2026-01-01T00:00:00.000Z",
  files: { "original.png": new Uint8Array([137, 80, 78, 71]), "skeleton.json": new TextEncoder().encode('{"unknown":true}') },
  edits: { arm: { image: new Uint8Array([1, 2, 3]), transform: { x: 2, scaleX: 1 }, unknown: "kept" } },
  generation: { appearance: { image: new Uint8Array([1, 2, 3]), prompt: "identity" } }, thumbnail: picture,
  extension: { binary: new Uint8Array([77, 88]), image: picture, collision: { $ispineAsset: 2 }, nested: { untouched: true } } });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ispine-v2-")), store = createWorkspaceStore(root);
  let now = Date.parse("2026-10-21T00:00:00Z");
  const repository = new WorkspaceV2Repository(store.db, { now: () => now, ...options });
  t.after(async () => { if (store.db.isOpen) store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, repository, advance: (ms) => now += ms };
}
function prepared(repository, record = original(), namespace = NS.projects, store = "projects", lease = "upload-one") {
  const { document, assets } = decomposeWorkspaceRecord(namespace, store, record);
  const refs = assets.map(({ bytes, ...asset }) => {
    const digest = hash(bytes); repository.upload(digest, bytes, lease); return { ...asset, hash: digest, size: bytes.length };
  });
  return { namespace, store, id: record.id, document, refs, leaseId: lease, mutationId: "save-1", expectedVersion: 0 };
}

test("format 2 externalizes only known fields, preserves unknown data and never changes raw ZIP bytes", async (t) => {
  const { repository, store } = await fixture(t), record = original();
  const value = repository.putRecord(NS.projects, "projects", record);
  assert.equal(value.version, 1); assert.equal(value.refs.length, 5);
  assert.deepEqual(repository.record(NS.projects, "projects", record.id), record);
  assert.equal(value.document.extension.image, picture); assert.deepEqual(value.document.extension.collision, { $ispineAsset: 2 });
  assert.deepEqual(value.document.files["original.png"], { $ispineAsset: 2 });
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM asset_blobs").get().n, 4);
  assert.equal(store.status().version, 1); // No storage activation or HTTP capability switch.
  const bundle = template("22"), source = { id: "archive", name: bundle.name, files: bundle.files, edits: {}, generation: {} };
  repository.putRecord(NS.projects, "projects", source);
  const roundtrip = repository.record(NS.projects, "projects", source.id), reopened = { ...bundle, files: roundtrip.files };
  for (const options of [{}, { editable: true }, { target: "unity" }]) {
    const before = exportPackage(bundle, {}, options), after = exportPackage(reopened, {}, options);
    assert.equal(hash(after), hash(before));
    assert.deepEqual(Object.keys(unpackZip(after)), Object.keys(unpackZip(before)));
  }
  assert.equal(store.status().revision, 0); // Offline conversion is not an author edit.
});

test("draft source, parts, registration and per-frame images roundtrip independently of logical metadata", async (t) => {
  const { repository } = await fixture(t);
  const record = { id: "draft", document: { id: "draft", version: 1, width: 12, height: 12, sourceImage: picture,
    appearanceReference: { image: picture, width: 12, height: 12 }, parts: [{ id: "hand", image: picture, registrationBase: { image: picture } }],
    motionStudies: { hit: { frames: [{ id: "base", image: picture, composition: picture, segments: [{ partId: "hand", image: picture }] }, { id: "end", imageRef: "base" }] } },
    unknown: { sourceImage: picture, bytes: new Uint8Array([7]), $ispineAsset: 2 } } };
  const descriptor = repository.putRecord(NS.drafts, "documents", record);
  assert.equal(descriptor.refs.length, 7); assert.equal(descriptor.document.document.version, 1);
  assert.equal(descriptor.document.document.motionStudies.hit.frames[1].imageRef, "base");
  assert.deepEqual(repository.record(NS.drafts, "documents", record.id), record);
  repository.putRecord(NS.drafts, "metadata", { id: "draft", resourceId: "character", custom: { keep: true } });
  assert.deepEqual(repository.record(NS.drafts, "metadata", "draft").custom, { keep: true });
});

test("small document mutations deduplicate blobs and retain exactly one commit and receipt after response loss", async (t) => {
  const { repository, store } = await fixture(t), command = prepared(repository);
  assert.equal(store.status().revision, 0);
  const receipt = repository.commit(command), revision = store.status().revision;
  assert.deepEqual(Object.keys(receipt).sort(), ["id", "updatedAt", "version"]);
  assert.equal(receipt.version, 1); assert.equal(revision, 1);
  assert.deepEqual(repository.commit({ ...command, leaseId: "another-lease-after-response-loss" }), receipt);
  assert.equal(store.status().revision, revision);
  const name = { ...command, document: { ...command.document, name: "Renamed" }, mutationId: "rename-2", expectedVersion: 1 };
  assert.ok(serialize(name).length < 4096);
  const blobs = store.db.prepare("SELECT hash,size FROM asset_blobs ORDER BY hash").all();
  const second = repository.commit(name);
  assert.equal(second.version, 2); assert.deepEqual(store.db.prepare("SELECT hash,size FROM asset_blobs ORDER BY hash").all(), blobs);
  assert.equal(repository.record(NS.projects, "projects", command.id).name, "Renamed");
  assert.throws(() => repository.commit({ ...command, document: { ...command.document, name: "Reused mutation" } }), { code: "MUTATION_REUSED" });
  assert.throws(() => repository.commit({ ...name, mutationId: "stale-3" }), { code: "WORKSPACE_VERSION_CHANGED" });
  assert.throws(() => repository.commit({ ...name, mutationId: "unconditional", expectedVersion: undefined }), { code: "WORKSPACE_VERSION_REQUIRED" });
  const noOp = repository.commit({ ...name, mutationId: "same-document-3", expectedVersion: 2 });
  assert.equal(noOp.version, 2); assert.equal(store.status().revision, 2);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM mutations").get().n, 3);
});

test("file path keys, ArrayBuffers, optional nulls and base64 spelling survive decomposition", () => {
  const record = { id: "paths", files: Object.fromEntries([["__proto__", new Uint8Array([1])], ["folder/a~b.png", new Uint8Array([9, 8]).buffer]]),
    thumbnail: null, generation: { appearance: { image: null } }, edits: {} };
  const { document, assets } = decomposeWorkspaceRecord(NS.projects, "projects", record), bytes = new Map();
  const refs = assets.map(({ bytes: data, ...asset }) => { const h = hash(data); bytes.set(h, data); return { ...asset, hash: h, size: data.length }; });
  assert.deepEqual(composeWorkspaceRecord(NS.projects, "projects", document, refs, (h) => bytes.get(h)), record);
  const image = { id: "draft", document: { sourceImage: "data:image/PNG;base64,AQ", parts: [] } };
  const plan = decomposeWorkspaceRecord(NS.drafts, "documents", image), data = plan.assets[0].bytes;
  const reference = { ...plan.assets[0], hash: hash(data), size: data.length }; delete reference.bytes;
  assert.deepEqual(composeWorkspaceRecord(NS.drafts, "documents", plan.document, [reference], () => data), image);
  assert.throws(() => decomposeWorkspaceRecord(NS.drafts, "documents", { id: "bad", document: { sourceImage: "data:image/png;base64,AB==" } }), /不能无损还原/);
});

test("upload hash, missing references, duplicate paths, limits and future encoding reject atomically", async (t) => {
  const { repository, store } = await fixture(t), command = prepared(repository);
  assert.throws(() => repository.upload("a".repeat(64), new Uint8Array([1]), "upload"), { code: "ASSET_HASH_MISMATCH" });
  const bad = (refs, mutationId) => ({ ...command, refs, mutationId });
  const missing = command.refs.map((ref, i) => i ? ref : { ...ref, hash: "f".repeat(64) });
  assert.throws(() => repository.commit(bad(missing, "missing")), { code: "ASSET_MISSING" });
  assert.throws(() => repository.commit(bad(command.refs.slice(1), "incomplete")), { code: "WORKSPACE_ASSET_INVALID" });
  assert.throws(() => repository.commit(bad([command.refs[0], ...command.refs.slice(0, -1)], "duplicate")), { code: "WORKSPACE_ASSET_INVALID" });
  assert.throws(() => repository.commit(bad(command.refs.map((ref, i) => i ? ref : { ...ref, encoding: { type: "future" } }), "encoding")), { code: "WORKSPACE_ASSET_INVALID" });
  assert.throws(() => repository.commit(bad(command.refs.map((ref, i) => i ? ref : { ...ref, bytes: new Uint8Array([9]) }), "inline-ref-bytes")), { code: "WORKSPACE_ASSET_INVALID" });
  assert.throws(() => repository.commit(bad(command.refs.map((ref) => ref.encoding.type === "data-url" ? { ...ref, hash: hash(new Uint8Array()), size: 0 } : ref), "empty-image")), { code: "WORKSPACE_ASSET_INVALID" });
  const large = { id: "large", files: { "a": { $ispineAsset: 2 }, "b": { $ispineAsset: 2 } } };
  assert.throws(() => validateWorkspaceReferences(NS.projects, "projects", large, ["a", "b"].map((name) => ({ path: ["files", name], hash: "a".repeat(64), size: MAX_WORKSPACE_BYTES, encoding: { type: "Uint8Array" } }))), /256 MiB/);
  assert.throws(() => decomposeWorkspaceRecord(NS.projects, "projects", { files: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [String(i), new Uint8Array()])) }), /4096/);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM documents_v2").get().n, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM mutations").get().n, 0);
  assert.equal(store.status().revision, 0);
});

test("failure during indexing rolls document, references, revision and mutation receipt back together", async (t) => {
  let fail = false;
  const { repository, store } = await fixture(t, { indexProject: () => { if (fail) throw new Error("simulated index interruption"); } });
  const command = prepared(repository), first = repository.commit(command), before = repository.descriptor(NS.projects, "projects", command.id);
  fail = true;
  assert.throws(() => repository.commit({ ...command, document: { ...command.document, name: "Interrupted" }, expectedVersion: 1, mutationId: "interrupted" }), /index interruption/);
  assert.deepEqual(repository.descriptor(NS.projects, "projects", command.id), before); assert.equal(store.status().revision, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM mutations").get().n, 1);
  fail = false; assert.equal(repository.commit({ ...command, document: { ...command.document, name: "Recovered" }, expectedVersion: first.version, mutationId: "interrupted" }).version, 2);
});

test("active upload leases and independent entity references prevent garbage collection", async (t) => {
  const { repository, store, advance } = await fixture(t), bytes = new Uint8Array([4, 5, 6]), digest = hash(bytes);
  repository.upload(digest, bytes, "first-lease", { ttl: 10 }); advance(5);
  assert.deepEqual(repository.query([digest, "a".repeat(64)], "second-lease", { ttl: 50 }).missing, ["a".repeat(64)]);
  advance(6); assert.equal(repository.asset(digest, "first-lease"), null); assert.equal(repository.asset(digest, "wrong-lease"), null);
  assert.equal(repository.asset(digest, "second-lease").size, 3); assert.equal(repository.collect().removedBlobs, 0);
  const document = { id: "custom-source", files: { "same.png": bytes } };
  repository.putRecord(NS.templates, "files", document);
  advance(100); assert.equal(repository.collect().removedBlobs, 0); assert.equal(repository.asset(digest).size, 3);
  repository.atomic(() => repository.deleteRecord(NS.templates, "files", document.id));
  assert.equal(repository.collect().removedBlobs, 1); assert.equal(repository.asset(digest, "second-lease"), null);
  assert.equal(store.status().revision, 0);
});

test("trash retains bytes, permanent deletion clears V1/V2 character records, and tombstones outrank old receipts", async (t) => {
  const { repository, store, advance } = await fixture(t), record = original();
  store.put(NS.projects, "projects", record); // Transition payload must obey the same deletion.
  const command = prepared(repository, record), receipt = repository.commit(command);
  repository.putRecord(NS.templates, "files", { id: "custom-character", files: record.files, sourceProjectId: record.id });
  repository.putRecord(NS.drafts, "documents", { id: "draft", document: { id: "draft", sourceImage: picture, parts: [] } });
  const trashed = repository.commit({ namespace: NS.projects, store: "projects", id: record.id, mutationId: "trash", expectedVersion: 1, operation: "trash" });
  assert.equal(trashed.version, 2); assert.deepEqual(repository.record(NS.projects, "projects", record.id).files, record.files);
  assert.throws(() => repository.commit(command), { code: "RESOURCE_TRASHED" });
  assert.throws(() => repository.commit({ ...command, expectedVersion: 2, mutationId: "late-save" }), { code: "RESOURCE_TRASHED" });
  const restored = repository.commit({ namespace: NS.projects, store: "projects", id: record.id, mutationId: "restore", expectedVersion: 2, operation: "restore" });
  assert.equal(restored.version, 3); assert.equal(repository.record(NS.projects, "projects", record.id).deletedAt, undefined);
  repository.commit({ namespace: NS.projects, store: "projects", id: record.id, mutationId: "trash-again", expectedVersion: 3, operation: "trash" });
  const removed = repository.commit({ namespace: NS.projects, store: "projects", id: record.id, mutationId: "remove", expectedVersion: 4, operation: "remove" });
  assert.equal(removed.removed, true); assert.equal(repository.descriptor(NS.projects, "projects", record.id), null);
  assert.equal(store.get(NS.projects, "projects", record.id), null);
  assert.deepEqual(Object.keys(store.get(NS.projects, "removedProjects", record.id)).sort(), ["id", "removedAt"]);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM mutations WHERE id=?").get(record.id).n, 0);
  assert.throws(() => repository.commit(command), { code: "RESOURCE_REMOVED" });
  assert.throws(() => repository.commit({ ...command, mutationId: "recreate" }), { code: "RESOURCE_REMOVED" });
  assert.throws(() => repository.putRecord(NS.projects, "projects", record), { code: "RESOURCE_REMOVED" });
  assert.deepEqual(repository.record(NS.templates, "files", "custom-character").files, record.files);
  assert.equal(repository.record(NS.drafts, "documents", "draft").document.sourceImage, picture);
  advance(31 * 60 * 1000); repository.collect();
  assert.deepEqual(repository.record(NS.templates, "files", "custom-character").files, record.files);
  assert.equal(repository.record(NS.drafts, "documents", "draft").document.sourceImage, picture);
  assert.equal(receipt.version, 1);
});

test("lost asset references or corrupt raw blobs fail explicitly without fabricating empty content", async (t) => {
  const { repository, store } = await fixture(t), command = prepared(repository); repository.commit(command);
  const one = command.refs[0];
  store.db.prepare("DELETE FROM asset_refs WHERE namespace=? AND store=? AND id=? AND path=?").run(NS.projects, "projects", command.id, JSON.stringify(one.path));
  assert.throws(() => repository.record(NS.projects, "projects", command.id), { code: "ASSET_REFERENCE_CORRUPT" });
  store.db.prepare("INSERT INTO asset_refs VALUES (?,?,?,?,?,?,?)").run(NS.projects, "projects", command.id, JSON.stringify(one.path), one.hash, JSON.stringify(one.encoding), one.size);
  const badBytes = new Uint8Array(one.size).fill(42);
  store.db.prepare("UPDATE asset_blobs SET bytes=? WHERE hash=?").run(badBytes, one.hash);
  assert.throws(() => repository.record(NS.projects, "projects", command.id), { code: "ASSET_CORRUPT" });
  assert.throws(() => repository.upload(one.hash, new Uint8Array([137,80,78,71]), "repair"), /SHA-256/);
});

test("durable reopening preserves exact assets, versions, pending leases and original mutation receipts", async (t) => {
  const { root, repository, store } = await fixture(t), command = prepared(repository), first = repository.commit(command);
  const bytes = new Uint8Array([8, 6, 7, 5, 3, 0, 9]), digest = hash(bytes);
  repository.upload(digest, bytes, "pending-on-restart");
  const expected = repository.record(NS.projects, "projects", command.id), revision = store.status().revision;
  store.close();
  const reopened = createWorkspaceStore(root); t.after(() => reopened.close());
  const reloaded = new WorkspaceV2Repository(reopened.db, { now: () => Date.parse("2026-10-21T00:00:01Z") });
  assert.deepEqual(reloaded.record(NS.projects, "projects", command.id), expected);
  assert.deepEqual(reloaded.commit(command), first); assert.equal(reopened.status().revision, revision);
  assert.deepEqual(new Uint8Array(reloaded.asset(digest, "pending-on-restart").bytes), bytes);
});

test("SQLite interruption after receipt insertion rolls back the real summary with documents, references and revision", async (t) => {
  const { repository, store } = await fixture(t);
  repository.indexProject = (descriptor, read) => store.projectIndex.write(read(), serialize(read()), descriptor.ordinal);
  repository.removeProjectIndex = (id) => store.projectIndex.remove(id);
  const command = prepared(repository); repository.commit(command);
  const before = store.call("projects", "summary"), descriptor = repository.descriptor(NS.projects, "projects", command.id);
  store.db.exec("CREATE TRIGGER interrupt_v2_receipt AFTER INSERT ON mutations WHEN NEW.mutation_id='failure' BEGIN SELECT RAISE(ABORT,'simulated post-receipt interruption'); END;");
  assert.throws(() => repository.commit({ ...command, document: { ...command.document, name: "Must roll back" }, expectedVersion: 1, mutationId: "failure" }), /post-receipt interruption/);
  assert.deepEqual(store.call("projects", "summary"), before);
  assert.deepEqual(repository.descriptor(NS.projects, "projects", command.id), descriptor);
  assert.equal(store.status().revision, 1); assert.equal(store.db.prepare("SELECT count(*) AS n FROM mutations").get().n, 1);
  store.db.exec("DROP TRIGGER interrupt_v2_receipt");
  const saved = repository.commit({ ...command, document: { ...command.document, name: "Can commit" }, expectedVersion: 1, mutationId: "failure" });
  assert.equal(saved.version, 2); assert.equal(store.call("projects", "summary").projects[0].name, "Can commit");
});

test("rename, calibration and motion-key saves send small descriptors and never read unchanged BLOB data", async (t) => {
  const { repository, store } = await fixture(t);
  const record = { ...original(), files: { "large-source.bin": new Uint8Array(1024 * 1024).fill(7) }, motion: { time: 0 } };
  const command = prepared(repository, record); repository.commit(command);
  const prepare = store.db.prepare.bind(store.db), statements = [];
  store.db.prepare = (sql) => { statements.push(sql); assert.ok(!/SELECT[\s\S]*\bbytes\b[\s\S]*FROM asset_blobs/i.test(sql), sql); return prepare(sql); };
  let document = command.document;
  for (const [i, change] of [ { name: "Renamed" }, { edits: { ...document.edits, arm: { ...document.edits.arm, transform: { x: 8, scaleX: 1 } } } }, { motion: { time: .35 } } ].entries()) {
    document = { ...document, ...change };
    const request = { ...command, document, expectedVersion: i + 1, mutationId: `small-${i}` };
    assert.ok(serialize(request).byteLength < 64 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(encodeWorkspace(request))) < 64 * 1024);
    assert.equal(repository.commit(request).version, i + 2);
  }
  assert.ok(statements.some((sql) => sql.includes("INSERT INTO documents_v2")));
  assert.ok(!statements.some((sql) => sql.includes("INSERT INTO asset_blobs")));
  store.db.prepare = prepare;
  assert.deepEqual(repository.record(NS.projects, "projects", record.id).files, record.files);
});

test("future storage versions reject startup and every existing writer without replacing bytes", async (t) => {
  const { repository, store } = await fixture(t), command = prepared(repository); repository.commit(command);
  const bytes = store.db.prepare("SELECT document FROM documents_v2").get().document;
  store.db.exec("UPDATE settings SET value='3' WHERE key='workspace-v2.schema'");
  assert.throws(() => new WorkspaceV2Repository(store.db), { code: "WORKSPACE_FORMAT_NEWER" });
  for (const operation of [() => repository.commit(command), () => repository.upload(hash(new Uint8Array([1])), new Uint8Array([1]), "future"),
    () => repository.query([], "future"), () => repository.putRecord(NS.projects, "projects", original("future")), () => repository.collect()])
    assert.throws(operation, { code: "WORKSPACE_FORMAT_NEWER" });
  assert.deepEqual(store.db.prepare("SELECT document FROM documents_v2").get().document, bytes);
});

test("explicit read-only integrity checks locate damaged bytes, orphan references and permanent-delete inconsistencies", async (t) => {
  const { repository, store } = await fixture(t), command = prepared(repository); repository.commit(command);
  const revision = store.status().revision, changes = store.db.prepare("SELECT total_changes() AS n").get().n;
  const exec = store.db.exec.bind(store.db);
  store.db.exec = (sql) => { assert.ok(!/BEGIN IMMEDIATE/.test(sql)); return exec(sql); };
  const valid = repository.check();
  assert.equal(valid.consistent, true); assert.equal(valid.references, 5); assert.equal(valid.assets, 4);
  assert.equal(valid.documents[`${NS.projects}/projects`], 1);
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, changes); assert.equal(store.status().revision, revision);
  store.db.exec = exec;
  const one = command.refs[0];
  store.db.prepare("UPDATE asset_blobs SET bytes=? WHERE hash=?").run(new Uint8Array(one.size), one.hash);
  store.db.prepare("INSERT INTO asset_refs VALUES (?,?,?,?,?,?,?)").run(NS.drafts, "documents", "orphan", '["document","sourceImage"]', "f".repeat(64), '{"type":"data-url","prefix":"data:image/png;base64,","padding":0}', 1);
  store.put(NS.projects, "removedProjects", { id: command.id, removedAt: "2026-10-21" });
  const invalid = repository.check();
  assert.equal(invalid.consistent, false);
  assert.ok(invalid.invalid.some((row) => row.hash === one.hash && row.code === "ASSET_CORRUPT"));
  assert.ok(invalid.invalid.some((row) => row.id === "orphan" && row.code === "ASSET_REFERENCE_CORRUPT"));
  assert.ok(invalid.invalid.some((row) => row.id === command.id && row.code === "DOCUMENT_INVALID"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { serialize } from "node:v8";
import { startIsolatedWorkbench } from "./support/isolated-workbench.mjs";
import { createWorkspaceStore } from "../server/bootstrap/workspace.mjs";
import { legacyRecordWrite } from "../server/workspace/v2-mode.mjs";
import { workspaceMiddleware } from "../server/http/workspace-routes.mjs";
import { decomposeWorkspaceRecord, WORKSPACE_NAMESPACES as NS } from "../shared/domain/workspace-assets.mjs";
import { encodeWorkspace, decodeWorkspace } from "../shared/workspace-codec.mjs";
import { createCustomTemplateRecord } from "../engine/archive/template-snapshot.js";
import { template } from "./helpers.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const project = (id = "http-character") => ({ id, name: "Character", files: { "source.bin": new Uint8Array(1024 * 1024).fill(17) },
  edits: { hand: { image: new Uint8Array([1,2,3]), transform: { x: 1, scaleX: 1 } } }, generation: {}, thumbnail: png, partCount: 1 });
async function fixture(t, options = {}) {
  const server = await startIsolatedWorkbench({ seed: false, storageFormat: 2, ...options }); t.after(() => server.close());
  const api = async (path, body, headers) => {
    const response = await fetch(`${server.origin}/api/workspace/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { Origin: server.origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(encodeWorkspace(body)) }) });
    return { status: response.status, body: decodeWorkspace(await response.json()) };
  };
  return { server, api };
}
async function prepare(server, api, record = project(), collection = "projects", options = {}) {
  const namespace = NS[collection], store = { projects: "projects", drafts: "documents", templates: "files" }[collection], leaseId = `lease-${record.id}`;
  const { document, assets } = decomposeWorkspaceRecord(namespace, store, record), refs = [];
  for (const { bytes, ...ref } of assets) refs.push({ ...ref, hash: hash(bytes), size: bytes.length });
  const query = await api("v2/blobs/query", { hashes: refs.map((ref) => ref.hash), leaseId }); assert.equal(query.status, 200);
  let uploads = 0, uploadedBytes = 0;
  for (const digest of query.body.missing) {
    const asset = assets.find((asset) => hash(asset.bytes) === digest);
    const response = await fetch(`${server.origin}/api/workspace/v2/blobs/${digest}`, { method: "PUT", headers: {
      Origin: server.origin, "Content-Type": "application/octet-stream", "X-iSpine-Upload": leaseId }, body: asset.bytes });
    assert.equal(response.status, 200, await response.text()); uploads++; uploadedBytes += asset.bytes.byteLength;
  }
  return { command: { operation: "save", id: record.id, payload: { document, refs }, options, mutationId: `save-${record.id}`, expectedVersion: 0, leaseId }, uploads, uploadedBytes };
}

test("V2 HTTP negotiates capabilities, deduplicates uploads and commits small versioned documents with replayable receipts", async (t) => {
  const { server, api } = await fixture(t), status = await api("status");
  assert.equal(status.body.version, 2); assert.equal(status.body.writable, true); assert.deepEqual(status.body.capabilities.protocols, [1, 2]);
  const record = project(), first = await prepare(server, api, record); assert.equal(first.uploads, 3);
  assert.equal(server.store.status().revision, 0);
  assert.ok(JSON.stringify(encodeWorkspace(first.command)).length < 64 * 1024);
  const saved = await api("v2/projects", first.command); assert.equal(saved.status, 200); assert.equal(saved.body.value.version, 1);
  assert.equal(saved.body.value.payload, undefined); assert.equal(saved.body.value.summary.name, "Character");
  assert.equal(JSON.stringify(saved.body).includes("$ispineBinary"), false);
  const revision = server.store.status().revision;
  assert.deepEqual(await api("v2/projects", first.command), saved); assert.equal(server.store.status().revision, revision);
  const second = await prepare(server, api, { ...record, name: "Renamed", edits: { hand: { ...record.edits.hand, transform: { x: 6, scaleX: 1 } } } });
  assert.equal(second.uploads, 0);
  t.diagnostic(JSON.stringify({ case: "workspace-v2-http-transfer", sourceBytes: record.files["source.bin"].byteLength,
    firstUploadedBytes: first.uploadedBytes, secondUploadedBytes: second.uploadedBytes,
    firstCommandBytes: Buffer.byteLength(JSON.stringify(encodeWorkspace(first.command))), secondCommandBytes: Buffer.byteLength(JSON.stringify(encodeWorkspace({ ...second.command, expectedVersion: 1, mutationId: "rename" }))),
    receiptBytes: Buffer.byteLength(JSON.stringify(encodeWorkspace(saved.body))) }));
  assert.equal((await api("v2/projects", { ...second.command, expectedVersion: 1, mutationId: "rename" })).body.value.version, 2);
  assert.equal((await api("v2/projects", { ...second.command, mutationId: "stale" })).status, 409);
  assert.equal((await api("v2/projects", { ...first.command, payload: second.command.payload })).body.code, "MUTATION_REUSED");
  const read = await api("v2/projects", { operation: "get", id: record.id });
  assert.equal(read.body.value.payload.document.name, "Renamed"); assert.equal(read.body.value.payload.document.files["source.bin"].$ispineAsset, 2);
  const source = first.command.payload.refs[0];
  const bytes = new Uint8Array(await (await fetch(`${server.origin}/api/workspace/v2/blobs/${source.hash}`)).arrayBuffer());
  assert.deepEqual(bytes, record.files["source.bin"]);
  assert.equal(server.store.checkProjectIndex().consistent, true); assert.equal(server.store.v2.check().consistent, true);
  await server.restart();
  assert.deepEqual(await api("v2/projects", first.command), saved); assert.equal(server.store.checkProjectIndex().consistent, true);
  assert.equal(server.store.call("projects", "get", [record.id]).name, "Renamed");
});

test("draft and custom-template commands retain their separate metadata/payload stores in one transaction", async (t) => {
  const { server, api } = await fixture(t);
  const draft = { id: "source-draft", document: { id: "source-draft", version: 1, name: "Source", width: 1, height: 1, sourceImage: png, joints: [], parts: [], motions: [] } };
  const draftSave = await prepare(server, api, draft, "drafts");
  const saved = await api("v2/drafts", draftSave.command); assert.equal(saved.status, 200); assert.equal(saved.body.value.metadata.documentId, draft.id);
  const read = await api("v2/drafts", { operation: "get", id: draft.id });
  assert.equal(read.body.value.payload.document.document.sourceImage.$ispineAsset, 2);
  assert.equal(server.store.call("drafts", "get", [draft.id]).document.sourceImage, png);
  const bundle = template("22"), snapshot = createCustomTemplateRecord({ id: "source", name: "Custom", skeletonPath: bundle.skeletonPath, thumbnail: png }, bundle.files);
  const pending = await prepare(server, api, snapshot, "templates"), templateSave = await api("v2/templates", pending.command);
  assert.equal(templateSave.status, 200); assert.equal(templateSave.body.value.metadata.sourceProjectId, "source");
  assert.equal(templateSave.body.value.metadata.thumbnail, undefined);
  const fetched = await api("v2/templates", { operation: "get", id: snapshot.id });
  assert.ok(fetched.body.value.payload.refs.some((ref) => ref.path[0] === "thumbnail"));
  assert.deepEqual(server.store.call("templates", "get", [snapshot.id]).files, snapshot.files);
  const before = server.store.call("drafts", "get", [draft.id]);
  server.store.db.exec("CREATE TRIGGER interrupt_draft_pair AFTER UPDATE ON documents_v2 WHEN NEW.store='documents' BEGIN SELECT RAISE(ABORT,'draft pair interrupted'); END;");
  const changed = await prepare(server, api, { ...draft, document: { ...draft.document, name: "Must roll back" } }, "drafts");
  const result = await api("v2/drafts", { ...changed.command, expectedVersion: 1, mutationId: "draft-pair-fault" });
  assert.equal(result.status, 400); assert.deepEqual(server.store.call("drafts", "get", [draft.id]), before);
  assert.equal(server.store.v2.row(NS.drafts, "metadata", draft.id).resource_version, 1);
  server.store.db.exec("DROP TRIGGER interrupt_draft_pair");
  const source = await prepare(server, api, project("source")); await api("v2/projects", source.command);
  await api("v2/projects", { operation: "trash", id: "source", expectedVersion: 1, mutationId: "trash-source" });
  await api("v2/projects", { operation: "remove", ids: ["source"], expectedVersions: { source: 2 }, mutationId: "delete-source" });
  server.store.v2.collect();
  assert.deepEqual(server.store.call("templates", "get", [snapshot.id]).files, snapshot.files);
  assert.equal(server.store.call("drafts", "get", [draft.id]).document.sourceImage, png);
  const deleted = await api("v2/templates", { operation: "delete", id: snapshot.id, expectedVersion: 1, mutationId: "delete-template" });
  assert.equal(deleted.status, 200);
  const renewed = await prepare(server, api, snapshot, "templates");
  const recreated = await api("v2/templates", { ...renewed.command, mutationId: "intentional-new-template" });
  assert.equal(recreated.status, 200);
  assert.equal((await api("v2/templates", pending.command)).body.code, "RESOURCE_REMOVED");
  assert.equal(server.store.v2.check().consistent, true);
});

test("trash, restoration, atomic multi-delete and old browser re-migration cannot bypass tombstones", async (t) => {
  const { server, api } = await fixture(t);
  for (const id of ["one", "two"]) {
    const prepared = await prepare(server, api, project(id)); assert.equal((await api("v2/projects", prepared.command)).status, 200);
    server.store.transaction(() => legacyRecordWrite(server.store.db, () => server.store.db.prepare("INSERT INTO records VALUES (?,?,?,?)").run(NS.projects, "projects", id, serialize(project(id)))));
    const trash = await api("v2/projects", { operation: "trash", id, expectedVersion: 1, mutationId: `trash-${id}` });
    assert.equal(trash.status, 200, JSON.stringify(trash.body));
  }
  assert.equal((await api("v2/projects", { operation: "restore", id: "one", expectedVersion: 2, mutationId: "restore-one" })).status, 200);
  assert.equal((await api("v2/projects", { operation: "trash", id: "one", expectedVersion: 3, mutationId: "trash-again" })).status, 200);
  const revision = server.store.status().revision;
  const invalid = await api("v2/projects", { operation: "remove", ids: ["one", "two"], expectedVersions: { one: 4, two: 1 }, mutationId: "remove-both" });
  assert.equal(invalid.status, 409); assert.equal(server.store.status().revision, revision);
  assert.equal(server.store.call("projects", "summary").trash.length, 2);
  const removed = await api("v2/projects", { operation: "remove", ids: ["one", "two"], expectedVersions: { one: 4, two: 2 }, mutationId: "remove-both" });
  assert.equal(removed.status, 200); assert.equal(removed.body.value.removed, 2); assert.equal(server.store.status().revision, revision + 1);
  assert.deepEqual(server.store.call("projects", "summary"), { projects: [], trash: [], hasDeletedProjects: true });
  assert.equal(server.store.db.prepare("SELECT count(*) AS n FROM mutations").get().n, 0);
  assert.equal(server.store.db.prepare("SELECT count(*) AS n FROM records WHERE store='projects'").get().n, 0);
  const legacy = await api("migrate", { source: "old-browser", snapshot: { [NS.projects]: { projects: [project("one")] } } });
  assert.equal(legacy.status, 200); assert.equal(legacy.body.value.skippedDeleted, 1);
  assert.equal(server.store.call("projects", "get", ["one"]), null); assert.equal(server.store.v2.check().consistent, true);
  assert.equal(server.store.checkProjectIndex().consistent, true);
});

test("cached V1 pages read V2 and only timestamp-conditional legacy saves can write the single active repository", async (t) => {
  const { server, api } = await fixture(t), input = project(), initial = await prepare(server, api, input);
  await api("v2/projects", initial.command);
  const current = (await api("projects", { operation: "get", args: [input.id] })).body.value;
  assert.deepEqual(current.files, input.files);
  const stale = await api("projects", { operation: "save", args: [{ ...current, name: "Unsafe overwrite" }] });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "WORKSPACE_REFRESH_REQUIRED");
  const safe = await api("projects", { operation: "save", args: [{ ...current, name: "Conditional legacy save" }, { expectedUpdatedAt: current.updatedAt }] });
  assert.equal(safe.status, 200);
  assert.equal((await api("v2/projects", { operation: "get", id: input.id })).body.value.payload.document.name, "Conditional legacy save");
  assert.equal(server.store.db.prepare("SELECT count(*) AS n FROM records WHERE store='projects'").get().n, 0);
  const directOldWriter = new DatabaseSync(join(server.root, "workspace/workspace.sqlite")); t.after(() => directOldWriter.close());
  assert.throws(() => directOldWriter.prepare("INSERT INTO records VALUES (?,?,?,?)").run(NS.projects, "projects", input.id, serialize({ ...input, name: "Old binary" })), /WORKSPACE_REFRESH_REQUIRED/);
  // Trigger guards are exercised against an actual old-format row, not a no-op DELETE.
  server.store.transaction(() => legacyRecordWrite(server.store.db, () => server.store.db.prepare("INSERT INTO records VALUES (?,?,?,?)").run(NS.projects, "projects", "retained-source", serialize(project("retained-source")))));
  assert.throws(() => directOldWriter.prepare("DELETE FROM records WHERE id='retained-source'").run(), /WORKSPACE_REFRESH_REQUIRED/);
  assert.throws(() => directOldWriter.prepare("UPDATE records SET payload=? WHERE id='retained-source'").run(serialize(input)), /WORKSPACE_REFRESH_REQUIRED/);
  assert.equal(server.store.get(NS.projects, "projects", input.id).name, "Conditional legacy save");
});

test("a store opened before activation cannot keep writing the old format; initialization refuses existing data", async (t) => {
  const { server } = await fixture(t, { storageFormat: 1 }), previous = createWorkspaceStore(join(server.root, "workspace")); t.after(() => previous.close());
  server.store.initializeEmptyV2();
  assert.equal(previous.status().writable, false);
  assert.throws(() => previous.call("projects", "save", [project()]), { code: "WORKSPACE_REFRESH_REQUIRED" });
  assert.equal(server.store.db.prepare("SELECT count(*) AS n FROM records").get().n, 0);
  const live = await startIsolatedWorkbench({ seed: true }); t.after(() => live.close());
  assert.throws(() => live.store.initializeEmptyV2(), /已有数据必须先执行迁移/);
  assert.equal(live.store.status().version, 1);
});

test("PUT and JSON routes reject foreign origins, forged/missing hashes and over-limit or invalid protocol bodies", async (t) => {
  const { server, api } = await fixture(t), bytes = new Uint8Array([3, 4, 5]), digest = hash(bytes), path = `${server.origin}/api/workspace/v2/blobs/${digest}`;
  const put = (headers, body = bytes) => fetch(path, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-iSpine-Upload": "security", ...headers }, body });
  assert.equal((await put({})).status, 403); assert.equal((await put({ Origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await put({ Origin: server.origin, "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await put({ Origin: server.origin }, new Uint8Array([9]))).status, 400);
  assert.equal((await put({ Origin: server.origin })).status, 200);
  assert.equal((await fetch(path)).status, 404); assert.equal((await fetch(`${path}?leaseId=security`)).status, 200);
  const request = await prepare(server, api), refs = request.command.payload.refs.map((ref, i) => i ? ref : { ...ref, hash: "f".repeat(64) });
  const missing = await api("v2/projects", { ...request.command, payload: { ...request.command.payload, refs } });
  assert.equal(missing.status, 400); assert.equal(missing.body.code, "ASSET_MISSING");
  assert.equal((await api("v2/projects", { ...request.command, expectedVersion: undefined })).body.code, "WORKSPACE_VERSION_REQUIRED");
  assert.equal(server.store.call("projects", "summary").projects.length, 0);
  const middleware = workspaceMiddleware(server.store, { maxRequestBytes: 64 }), http = createServer((req, res) => middleware(req, res, () => res.end()));
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => http.close(resolve)));
  const origin = `http://127.0.0.1:${http.address().port}`;
  for (const [method, suffix, contentType] of [["PUT", `v2/blobs/${digest}`, "application/octet-stream"], ["POST", "v2/projects", "application/json"]]) {
    const over = await fetch(`${origin}/api/workspace/${suffix}`, { method, headers: { Origin: origin, "Content-Type": contentType }, body: new Uint8Array(65) });
    assert.equal(over.status, 413);
    const streamed = await new Promise((resolve, reject) => {
      const client = httpRequest(`${origin}/api/workspace/${suffix}`, { method, headers: { Origin: origin, "Content-Type": contentType, "Transfer-Encoding": "chunked" }, signal: AbortSignal.timeout(5000) }, (response) => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      });
      client.on("error", reject); client.write(new Uint8Array(40)); client.end(new Uint8Array(40));
    });
    assert.equal(streamed, 413);
  }
});

test("moving a linked draft requires the old draft's version and cannot remove concurrent edits", async (t) => {
  const { server, api } = await fixture(t), document = { id: "moving", version: 1, name: "Moving", width: 1, height: 1, sourceImage: png, joints: [], parts: [], motions: [] };
  const first = await prepare(server, api, { id: "moving", document }, "drafts"); await api("v2/drafts", first.command);
  const next = await prepare(server, api, { id: "resource-owner", document }, "drafts", { resourceId: "owner", previousDraftId: "moving" });
  const stale = await api("v2/drafts", { ...next.command, mutationId: "move", previousDraftVersion: 0 });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "DRAFT_CHANGED");
  assert.equal(server.store.call("drafts", "get", ["resource-owner"]), null); assert.ok(server.store.call("drafts", "get", ["moving"]));
  const moved = await api("v2/drafts", { ...next.command, mutationId: "move", previousDraftVersion: 1 });
  assert.equal(moved.status, 200); assert.equal(server.store.call("drafts", "get", ["moving"]), null);
  assert.equal(server.store.call("drafts", "get", ["resource-owner"]).document.sourceImage, png);
  assert.equal((await api("v2/drafts", first.command)).body.code, "RESOURCE_REMOVED");
  assert.equal(server.store.call("drafts", "get", ["moving"]), null);
  assert.equal(server.store.v2.check().consistent, true);
});

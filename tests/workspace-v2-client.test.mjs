import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { WorkspaceMigration } from "../server/workspace/migration.mjs";
import { createWorkspaceV2Client } from "../src/infrastructure/workspace-v2.js";
import { createSaveCoordinator } from "../src/application/save-coordinator.js";
import { startIsolatedWorkbench } from "./support/isolated-workbench.mjs";
import { encodeWorkspace, decodeWorkspace } from "../shared/workspace-codec.mjs";
import { createCustomTemplateRecord } from "../engine/archive/template-snapshot.js";
import { template } from "./helpers.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const source = (id = "client-resource") => ({ id, name: "Client", files: { "source.bin": new Uint8Array(1024 * 1024).fill(19) },
  edits: { hand: { image: new Uint8Array([1, 2, 3]), transform: { x: 0, scaleX: 1 } } }, thumbnail: png, generation: {}, extension: { retained: true } });
async function fixture(t, settings = {}) {
  const server = await startIsolatedWorkbench({ seed: false, storageFormat: 2 }); t.after(() => server.close());
  const calls = [], hashes = []; let failures = 0;
  const request = async (path, data) => {
    const body = data === undefined ? undefined : JSON.stringify(encodeWorkspace(data));
    calls.push({ path, method: data === undefined ? "GET" : "POST", data: data === undefined ? null : JSON.parse(body), bytes: body?.length || 0 });
    const response = await fetch(`${server.origin}/api/workspace/${path}`, { method: data === undefined ? "GET" : "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" }, body });
    const value = decodeWorkspace(await response.json());
    if (!response.ok) throw Object.assign(new Error(value.error), { code: value.code || "HTTP_REJECTED" });
    if (path.startsWith("v2/") && data?.operation === "save" && failures) { failures--; throw new Error("Simulated receipt loss after commit"); }
    return value;
  };
  const rawRequest = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", bytes: options.body?.byteLength || 0 });
    const response = await fetch(`${server.origin}/api/workspace/${path}`, { ...options, headers: { Origin: server.origin, ...options.headers } });
    if (!response.ok) { const value = await response.json(); throw Object.assign(new Error(value.error), { code: value.code }); }
    return response;
  };
  const client = createWorkspaceV2Client({ request, rawRequest, createId: randomUUID, hash: async (bytes) => { hashes.push(bytes.byteLength); return createHash("sha256").update(bytes).digest("hex"); }, ...settings });
  return { server, client, calls, hashes, lose: (count) => failures = count, ports: { request, rawRequest } };
}

test("maintenance rejection retains upload sources for the original mutation after leases expire and maintenance is aborted", async (t) => {
  const { ports, server, calls } = await fixture(t), record = source("maintenance-retry");
  const migration = new WorkspaceMigration(server.store.db); let frozen = false;
  const client = createWorkspaceV2Client({ ...ports, createId: randomUUID, request: async (path, data) => {
    if (data?.operation === "save" && !frozen) { migration.begin(1, join(server.root, "before-reverse.sqlite")); frozen = true; }
    return ports.request(path, data);
  } });
  await assert.rejects(client.call("projects", "save", record, { mutationId: "before-maintenance" }), { code: "WORKSPACE_MAINTENANCE" });
  assert.equal(server.store.call("projects", "get", [record.id]), null);
  migration.abort();
  server.store.db.exec("UPDATE asset_uploads SET expires_at=0"); server.store.v2.collect();
  assert.equal(server.store.db.prepare("SELECT count(*) AS n FROM asset_blobs").get().n, 0);
  const recovered = await client.call("projects", "save", record, { mutationId: "before-maintenance" });
  assert.deepEqual(recovered.files, record.files); assert.equal(server.store.status().revision, 1);
  const attempts = calls.filter((call) => call.data?.mutationId === "before-maintenance");
  assert.equal(attempts.length, 3); assert.ok(attempts.every((item) => JSON.stringify(item.data) === JSON.stringify(attempts[0].data)));
});

test("the actual V2 client only transfers missing bytes and reuses immutable hashes for rename, calibration and animation edits", async (t) => {
  const { client, calls, hashes, server } = await fixture(t), record = source();
  const first = await client.call("projects", "save", record, { mutationId: "create" });
  assert.deepEqual(first.files, record.files); assert.equal(hashes.filter((size) => size === 1024 * 1024).length, 1);
  const before = calls.length;
  let current = first;
  for (const [i, change] of [{ name: "Renamed" }, { edits: { hand: { ...record.edits.hand, transform: { x: 8, scaleX: 1 } } } }, { generation: { appearancePrompt: "Authored brief" } }].entries())
    current = await client.call("projects", "save", { ...current, ...change }, { expectedUpdatedAt: current.updatedAt, mutationId: `edit-${i}` });
  assert.equal(calls.slice(before).filter((call) => call.method === "PUT").length, 0);
  assert.equal(hashes.filter((size) => size === 1024 * 1024).length, 1);
  assert.ok(calls.filter((call) => call.data?.operation === "save").every((call) => call.bytes < 64 * 1024 && call.data.payload.document.files["source.bin"].$ispineAsset === 2));
  assert.equal(server.store.status().revision, 4); assert.equal(server.store.v2.check().consistent, true);
  const read = await client.call("projects", "get", record.id); assert.deepEqual(read, current);
  assert.deepEqual(read.extension, record.extension);
});

test("a lost response retries the exact mutation and a newer local snapshot waits for the unknown commit's original receipt", async (t) => {
  const { client, server, lose, calls } = await fixture(t); lose(1);
  const record = source("lost"), created = await client.call("projects", "save", record, { mutationId: "lost-create" });
  const attempts = calls.filter((call) => call.data?.mutationId === "lost-create"); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].data, attempts[1].data);
  assert.equal(server.store.status().revision, 1);
  let sequence = 0;
  const writer = createSaveCoordinator({ createMutationId: () => `snapshot-${++sequence}`, schedule: () => 1, cancel() {},
    sameContent: (a, b) => a.name === b.name,
    repository: { usesMutationReceipts: () => true, get: () => assert.fail("Native receipt recovery must not hydrate the whole current resource"),
      save: (value, context) => client.call("projects", "save", value, { expectedUpdatedAt: context.expectedVersion, mutationId: context.mutationId }) } });
  writer.openSession({ sessionKey: "session", entityId: record.id, expectedVersion: created.updatedAt, persisted: true });
  lose(2); writer.enqueue({ sessionKey: "session", localRevision: 1, snapshot: { ...created, name: "A" } });
  await assert.rejects(writer.flush("session"), /receipt loss/);
  assert.equal(server.store.status().revision, 2); assert.equal(writer.hasUnsaved(), true);
  writer.enqueue({ sessionKey: "session", localRevision: 2, snapshot: { ...created, name: "C" } });
  await writer.flush("session");
  assert.equal(server.store.get("ai-spine-local-workbench", "projects", record.id).name, "C");
  assert.equal(server.store.status().revision, 3); assert.equal(writer.hasUnsaved(), false);
  const saves = calls.filter((call) => call.data?.mutationId?.startsWith("snapshot-"));
  assert.deepEqual(saves.map((call) => call.data.mutationId), ["snapshot-1", "snapshot-1", "snapshot-1", "snapshot-2"]);
  assert.equal(saves.at(-1).data.expectedVersion, 2);
});

test("client retries retain the first derived thumbnail but reject changed author content and honor resource tombstones", async (t) => {
  const { client, lose, server, calls } = await fixture(t), record = source("retry");
  lose(2); await assert.rejects(client.call("projects", "save", record, { mutationId: "unknown" }), /receipt loss/);
  const recovered = await client.call("projects", "save", { ...record, thumbnail: "data:image/png;base64,AQID" }, { mutationId: "unknown" });
  assert.equal(recovered.id, record.id); assert.equal(server.store.status().revision, 1);
  const attempts = calls.filter((call) => call.data?.mutationId === "unknown"); assert.ok(attempts.every((call) => JSON.stringify(call.data) === JSON.stringify(attempts[0].data)));
  await assert.rejects(client.call("projects", "save", { ...record, name: "Different author edit" }, { mutationId: "unknown" }), { code: "MUTATION_REUSED" });
  await client.call("projects", "trash", record.id); await client.call("projects", "remove", [record.id]);
  await assert.rejects(client.call("projects", "save", record, { mutationId: "unknown" }), { code: "RESOURCE_REMOVED" });
});

test("draft images, linked-draft movement, custom-template snapshots and trash restoration share the real client adapter", async (t) => {
  const { client, server } = await fixture(t), draft = { id: "source", name: "Draft", version: 1, width: 1, height: 1, sourceImage: png, joints: [], parts: [], motions: [] };
  const saved = await client.call("drafts", "save", draft, { mutationId: "draft" });
  assert.equal((await client.call("drafts", "get", saved.id)).document.sourceImage, png);
  const moved = await client.call("drafts", "save", draft, { resourceId: "owner", previousDraftId: draft.id, previousDraftUpdatedAt: saved.updatedAt, mutationId: "move" });
  assert.equal(moved.id, "resource-owner"); assert.equal(await client.call("drafts", "get", saved.id), null);
  const bundle = template("22"), snapshot = createCustomTemplateRecord({ id: "owner", name: "Snapshot", skeletonPath: bundle.skeletonPath, thumbnail: png }, bundle.files);
  const templateSaved = await client.call("templates", "save", snapshot, { mutationId: "template" });
  assert.equal(templateSaved.thumbnail, png); assert.deepEqual((await client.call("templates", "get", snapshot.id)).files, snapshot.files);
  const project = await client.call("projects", "save", source("owner"), { mutationId: "owner" });
  assert.ok((await client.call("projects", "trash", project.id)).deletedAt);
  assert.deepEqual((await client.call("projects", "restore", project.id)).files, project.files);
  await client.call("projects", "trash", project.id); await client.call("projects", "remove", [project.id]); server.store.v2.collect();
  assert.equal((await client.call("drafts", "get", moved.id)).document.sourceImage, png);
  assert.deepEqual((await client.call("templates", "get", snapshot.id)).files, snapshot.files);
  assert.equal(await client.call("templates", "delete", snapshot.id), true);
});

test("downloaded bytes are verified, coalesced and cached within the configured byte budget", async (t) => {
  const { client, server, ports } = await fixture(t), record = source("download"); await client.call("projects", "save", record);
  let gets = 0, corrupt = true;
  const fresh = createWorkspaceV2Client({ ...ports, cacheBytes: 16, rawRequest: async (path, options) => {
    const response = await ports.rawRequest(path, options); gets++;
    if (corrupt) return new Response(new Uint8Array(await response.arrayBuffer()).fill(42)); return response;
  } });
  await assert.rejects(fresh.call("projects", "get", record.id), { code: "ASSET_CORRUPT" });
  corrupt = false; assert.deepEqual((await fresh.call("projects", "get", record.id)).files, record.files);
  const before = gets; await fresh.call("projects", "get", record.id); assert.ok(gets > before); // 1 MiB exceeds the 16 B test cache.
  assert.equal(server.store.v2.check().consistent, true);
});

test("an old native receipt cannot advance a newer pending edit past another client's committed version", async (t) => {
  const { client, server, lose } = await fixture(t), record = source("native-conflict"), first = await client.call("projects", "save", record);
  let sequence = 0;
  const writer = createSaveCoordinator({ createMutationId: () => `conflict-${++sequence}`, schedule: () => 1, cancel() {}, sameContent: (a, b) => a.name === b.name,
    repository: { usesMutationReceipts: () => true, save: (value, context) => client.call("projects", "save", value, { expectedUpdatedAt: context.expectedVersion, mutationId: context.mutationId }) } });
  writer.openSession({ sessionKey: "editor", entityId: record.id, expectedVersion: first.updatedAt, persisted: true });
  lose(2); writer.enqueue({ sessionKey: "editor", localRevision: 1, snapshot: { ...first, name: "Unconfirmed A" } });
  await assert.rejects(writer.flush("editor"), /receipt loss/);
  const committed = server.store.call("projects", "get", [record.id]);
  server.store.call("projects", "save", [{ ...committed, name: "Other browser B" }, { expectedUpdatedAt: committed.updatedAt }]);
  writer.enqueue({ sessionKey: "editor", localRevision: 2, snapshot: { ...first, name: "Local C" } });
  await assert.rejects(writer.flush("editor"), { code: "RESOURCE_CHANGED" });
  assert.equal(server.store.call("projects", "get", [record.id]).name, "Other browser B"); assert.equal(writer.hasUnsaved(), true);
});

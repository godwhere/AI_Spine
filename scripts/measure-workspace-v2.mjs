import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cpus } from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { startIsolatedWorkbench } from "../tests/support/isolated-workbench.mjs";
import { createWorkspaceV2Client } from "../src/infrastructure/workspace-v2.js";
import { encodeWorkspace, decodeWorkspace } from "../shared/workspace-codec.mjs";

const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
function material(mib) {
  const bytes = new Uint8Array(mib * 1024 * 1024); let state = 0x13579bdf;
  for (let i = 0; i < bytes.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[i] = state & 255; }
  return bytes;
}
async function storageBytes(root) {
  return (await Promise.all(["workspace.sqlite", "workspace.sqlite-wal", "workspace.sqlite-shm"].map((name) => stat(join(root, "workspace", name)).then((value) => value.size, () => 0)))).reduce((a, b) => a + b, 0);
}
const report = { stage: "P7", format: 2, measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0].model,
  synthetic: true, source: "fixed xorshift seed, shared raw material plus a PNG replacement", samples: [] };
let server;
try {
  for (const [count, mib] of [[10, 1], [100, 1], [500, 1], [10, 10], [1, 50]]) {
    server = await startIsolatedWorkbench({ seed: false, storageFormat: 2 });
    const emptyBytes = await storageBytes(server.root), bytes = material(mib), initial = performance.now();
    for (let i = 0; i < count; i++) server.store.call("projects", "save", [{ id: `fixture-${i}`, name: `Fixture ${i}`, files: { "retained-asset.bin": bytes },
      edits: { hand: { image: png, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } } }, generation: {} }]);
    const seedMs = performance.now() - initial, reopen = performance.now(); await server.restart(); const reopenMs = performance.now() - reopen;
    const store = server.store, prepare = store.db.prepare.bind(store.db); let sourceReads = 0;
    store.db.prepare = (sql) => { if (/SELECT[\s\S]*(?:payload|\bdocument\b|\bbytes\b)[\s\S]*FROM (?:records|documents_v2|asset_blobs)\b/i.test(sql)) sourceReads++; return prepare(sql); };
    const cold = performance.now(), summary = store.call("projects", "summary"); const coldMs = performance.now() - cold;
    assert.equal(summary.projects.length, count); assert.ok(summary.projects.every((value) => !value.files && !value.edits && !value.generation));
    const times = [];
    for (let i = 0; i < 30; i++) { const start = performance.now(); store.call("projects", "summary"); times.push(performance.now() - start); await delay(0); }
    store.db.prepare = prepare; assert.equal(sourceReads, 0);
    const requests = [];
    const request = async (path, data) => {
      const body = data === undefined ? undefined : JSON.stringify(encodeWorkspace(data));
      requests.push({ method: body ? "POST" : "GET", path, bytes: body ? Buffer.byteLength(body) : 0, operation: data?.operation });
      const response = await fetch(`${server.origin}/api/workspace/${path}`, { method: body ? "POST" : "GET", headers: { Origin: server.origin, "Content-Type": "application/json" }, body });
      const value = decodeWorkspace(await response.json()); if (!response.ok) throw Object.assign(new Error(value.error), { code: value.code }); return value;
    };
    const rawRequest = async (path, options = {}) => {
      requests.push({ method: options.method || "GET", path, bytes: options.body?.byteLength || 0 });
      const response = await fetch(`${server.origin}/api/workspace/${path}`, { ...options, headers: { Origin: server.origin, ...options.headers } });
      if (!response.ok) throw new Error(`Raw request failed: ${response.status}`); return response;
    };
    const client = createWorkspaceV2Client({ request, rawRequest, createId: randomUUID });
    const record = await client.call("projects", "get", "fixture-0"), before = requests.length, save = performance.now();
    const calibrated = await client.call("projects", "save", { ...record, edits: { hand: { ...record.edits.hand, transform: { ...record.edits.hand.transform, x: 7 } } } },
      { expectedUpdatedAt: record.updatedAt, mutationId: randomUUID() });
    const calibrationMs = performance.now() - save;
    await client.call("projects", "save", { ...calibrated, name: "Renamed fixture" }, { expectedUpdatedAt: calibrated.updatedAt, mutationId: randomUUID() });
    const saves = requests.slice(before), commands = saves.filter((value) => value.operation === "save"), uploads = saves.filter((value) => value.method === "PUT");
    assert.equal(uploads.length, 0); assert.ok(commands.every((value) => value.bytes < 64 * 1024));
    const physical = await storageBytes(server.root), unique = store.db.prepare("SELECT count(*) AS count,sum(size) AS bytes FROM asset_blobs").get();
    assert.equal(unique.count, 2); assert.equal(unique.bytes, bytes.byteLength + png.byteLength);
    const sample = { count, assetMiB: mib, iterations: times.length, seedMs, reopenMs, coldMs, p50Ms: percentile(times, .5), p95Ms: percentile(times, .95),
      summarySourceReads: sourceReads, calibrationMs, calibrationRequestBytes: commands[0].bytes, renameRequestBytes: commands[1].bytes,
      unchangedMaterialUploads: uploads.length, uniqueMaterialBytes: unique.bytes, logicalMaterialBytes: count * (bytes.byteLength + png.byteLength),
      storageBytes: physical, storageIncrementBytes: physical - emptyBytes };
    if (mib === 50) {
      const extra = bytes.slice(); extra[0] ^= 255; const hash = digest(extra), leaseId = randomUUID(), latencies = [], roundtrips = [], schedulingLags = [], loop = monitorEventLoopDelay({ resolution: 1 });
      const uploadAsset = store.v2.upload.bind(store.v2); let repositoryUploadMs = 0;
      store.v2.upload = (...args) => { const start = performance.now(); try { return uploadAsset(...args); } finally { repositoryUploadMs += performance.now() - start; } };
      let complete = false, cursor = 0; loop.enable(); await delay(20);
      const statusRequests = (async () => { while (!complete) { const scheduled = performance.now() + 1; await delay(1);
        const start = performance.now(), value = await (await fetch(`${server.origin}/api/workspace/status`)).json(), end = performance.now();
        assert.equal(value.version, 2); latencies.push(end - scheduled); roundtrips.push(end - start); schedulingLags.push(Math.max(0, start - scheduled)); } })();
      const upload = performance.now();
      try {
        const body = new ReadableStream({ async pull(controller) { if (cursor >= extra.length) { controller.close(); return; }
          const end = Math.min(cursor + 1024 * 1024, extra.length); controller.enqueue(extra.subarray(cursor, end)); cursor = end; await delay(2); } });
        const response = await fetch(`${server.origin}/api/workspace/v2/blobs/${hash}`, { method: "PUT", headers: { Origin: server.origin, "Content-Type": "application/octet-stream", "X-iSpine-Upload": leaseId }, body, duplex: "half" });
        assert.equal(response.status, 200); await response.json();
      } finally { complete = true; await statusRequests; await delay(20); loop.disable(); }
      const uploadMs = performance.now() - upload, alive = store.v2.collect(); assert.equal(alive.removedBlobs, 0);
      const now = store.v2.now; store.v2.now = () => Date.now() + 31 * 60 * 1000; const reclaimed = store.v2.collect(); store.v2.now = now;
      assert.equal(reclaimed.removedBlobs, 1); assert.equal(store.v2.check().consistent, true);
      sample.largeUpload = { bytes: extra.length, chunkBytes: 1024 * 1024, producerDelayMs: 2, clientAndServerSameProcess: true, uploadMs,
        statusSamples: latencies.length, statusIncludesSchedulingLag: true, statusP50Ms: percentile(latencies, .5), statusP95Ms: percentile(latencies, .95), statusMaxMs: Math.max(...latencies),
        statusRoundtripP95Ms: percentile(roundtrips, .95), maximumSchedulingLagMs: Math.max(...schedulingLags), repositoryUploadMs,
        eventLoopP95Ms: loop.percentile(95) / 1e6, eventLoopMaxMs: loop.max / 1e6,
        activeLeaseProtected: true, expiredLeaseGarbageCollection: reclaimed, storageBytesAfterLogicalGC: await storageBytes(server.root),
        immediatePhysicalReclaimClaimed: false };
    }
    report.samples.push(sample); console.log(JSON.stringify(sample)); await server.close(); server = null;
  }
  const path = process.argv[2] || "/tmp/ispine-workspace-v2-performance.json"; await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ complete: true, output: path }));
} finally { await server?.close(); }

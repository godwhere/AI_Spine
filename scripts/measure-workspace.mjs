import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { createWorkspaceStore } from "../server/bootstrap/workspace.mjs";
import { encodeWorkspace } from "../shared/workspace-codec.mjs";
import { template } from "../tests/helpers.mjs";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";
import { parseBundle } from "../src/infrastructure/archive-files.js";
import { parseSkeleton } from "../engine/spine/parse.js";

const root = await mkdtemp(join(tmpdir(), "ispine-performance-"));
const output = process.argv[2] || "/tmp/ispine-workspace-performance.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const report = { measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0].model,
  stage: "P4", synthetic: true, samples: [], exports: [] };
let store;
try {
  // Representative combinations, not a 500 x 50 MiB Cartesian product.
  for (const [count, mib] of [[10, 1], [100, 1], [500, 1], [10, 10], [1, 50]]) {
    const location = join(root, `${count}-${mib}`), bytes = new Uint8Array(mib * 1024 * 1024);
    let state = 0x13579bdf;
    for (let i = 0; i < bytes.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[i] = state & 255; }
    store = createWorkspaceStore(location);
    for (let i = 0; i < count; i++) store.call("projects", "save", [{ id: `fixture-${i}`, name: `Fixture ${i}`,
      files: { "retained-asset.bin": bytes }, edits: {}, generation: {} }]);
    // Reproduce the existing records schema with no derived index, then time
    // the one-off upgrade separately from cold/warm library reads.
    store.db.exec("DROP TRIGGER project_index_insert; DROP TRIGGER project_index_update; DROP TRIGGER project_index_delete; DROP TABLE project_index; DROP TABLE project_thumbnails; DROP TABLE project_index_dirty; DELETE FROM settings WHERE key='project-index.version';");
    store.close(); const upgrade = performance.now(); store = createWorkspaceStore(location); const indexBackfillMs = performance.now() - upgrade;
    store.close(); const opening = performance.now(); store = createWorkspaceStore(location); const reopenMs = performance.now() - opening;
    const prepare = store.db.prepare.bind(store.db); let payloadReads = 0;
    store.db.prepare = (sql) => { if (/SELECT[\s\S]*payload[\s\S]*FROM records/i.test(sql)) payloadReads++; return prepare(sql); };
    const start = performance.now(); store.call("projects", "summary"); const coldMs = performance.now() - start;
    const times = [], loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable(); await delay(20);
    for (let i = 0; i < 30; i++) {
      const begin = performance.now(); store.call("projects", "summary"); times.push(performance.now() - begin);
      await delay(0);
    }
    await delay(20); loop.disable();
    const summaryPayloadReads = payloadReads; store.db.prepare = prepare;
    const record = store.call("projects", "get", ["fixture-0"]);
    const request = encodeWorkspace({ operation: "save", args: [{ ...record, name: "Renamed fixture" }, { expectedUpdatedAt: record.updatedAt }] });
    const storageBytes = await Promise.all(["workspace.sqlite", "workspace.sqlite-wal", "workspace.sqlite-shm"].map((name) =>
      stat(join(location, name)).then((info) => info.size, () => 0))).then((sizes) => sizes.reduce((a, b) => a + b, 0));
    report.samples.push({ count, assetMiB: mib, iterations: times.length, indexBackfillMs, reopenMs, coldMs, p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95),
      eventLoopP95Ms: loop.percentile(95) / 1e6, eventLoopMaxMs: loop.max / 1e6, storageBytes,
      renameRequestBytes: Buffer.byteLength(JSON.stringify(request)), summaryReadsPayload: summaryPayloadReads > 0, summaryPayloadReads });
    store.close(); store = null;
    await rm(location, { recursive: true, force: true });
  }
  const bundle = template("22"), originalAnimations = parseSkeleton(bundle).data.animations.map((item) => item.name);
  for (const [name, options] of [["runtime", {}], ["editable", { editable: true }], ["unity", { target: "unity" }]]) {
    const bytes = exportPackage(bundle, {}, options), files = unpackZip(bytes), reopened = parseBundle(files);
    const animations = parseSkeleton(reopened).data.animations.map((item) => item.name);
    if (JSON.stringify(animations) !== JSON.stringify(originalAnimations)) throw new Error(`${name} animation mismatch`);
    const path = join(tmpdir(), `ispine-P4-${name}.zip`); await writeFile(path, bytes);
    report.exports.push({ name, templateId: "22", bytes: bytes.byteLength, sha256: hash(bytes), animations,
      regions: reopened.parts.length, entries: Object.fromEntries(Object.entries(files).map(([path, data]) => [path, hash(data)])), path });
  }
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, samples: report.samples, exports: report.exports.map(({ name, bytes, regions }) => ({ name, bytes, regions })) }, null, 2));
} finally { store?.close(); await rm(root, { recursive: true, force: true }); }

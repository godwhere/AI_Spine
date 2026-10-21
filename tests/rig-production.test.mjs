import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync } from "fflate";
import { createProductionPlan, productionChecks, productionFingerprint, productionRequestFingerprint, productionReviewCurrent, productionStageIssues,
  assertProductionGate, plannedMotionSlots, hasAuthoredProduction, validateProduction, productionPrompt } from "../shared/domain/production.mjs";
import { includeMotionInProduction, confirmProduction, productionReferenceRequest, recordProductionRequest, prepareProductionReference, prepareStoredProductionReference, withProductionReference, applyProductionReference, verifyProductionPackage, productionExportBundle } from "../src/application/rig-production.js";
import { alphaBounds, drawReplacement } from "../engine/images/calibration.js";
import { createRigReferenceCalibration, bakeRigReferenceCalibration } from "../engine/images/rig-reference.js";
import { readRigImage } from "../engine/images/rig-images.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createRigOperations } from "../src/application/rig-operations.js";
import { createProjectExporter } from "../src/application/export-project.js";
import { buildRigFiles } from "../engine/rig/build-files.js";
import { parseBundle } from "../engine/archive/bundle.js";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";
import { readRigAuthoring } from "../engine/archive/rig-project.js";
import { imageDataBytes } from "../shared/codec/image-data.mjs";
import { rigSourceFingerprint } from "../shared/domain/generation.mjs";
import { RigJobs } from "../server/jobs/rig-service.mjs";
import { analyze } from "../server/jobs/handlers/rig-planning.mjs";
import { productionFixture, productionArtwork } from "./support/production-fixture.mjs";
import { pixelEnv } from "./helpers.mjs";

const boardFor = (doc, motion) => doc.production.boards.find((b) => b.motionId === motion);
const legacy = () => { const doc = productionFixture(); delete doc.production; return doc; };

test("adding a motion keeps its production plan and target aligned without altering existing character work", () => {
  const doc = productionFixture(), before = structuredClone(doc);
  const motion = { id: "skill", name: "Skill", duration: 2.2, loop: false, description: "Charge, release, recover." };
  const next = includeMotionInProduction(doc, motion, "board-skill");
  assert.deepEqual(doc, before);
  assert.deepEqual(next.motions, doc.motions); assert.deepEqual(next.parts, doc.parts); assert.deepEqual(next.joints, doc.joints);
  assert.deepEqual(next.production.motions.slice(0, -1), doc.production.motions);
  assert.deepEqual(next.production.boards.slice(0, -1), doc.production.boards);
  assert.deepEqual(next.production.reviews, doc.production.reviews);
  const planned = next.production.motions.at(-1), target = next.production.boards.at(-1);
  assert.deepEqual([planned.id, planned.duration, planned.loop, target.motionId, target.time], ["skill", 2.2, false, "skill", 1.1]);
  assert.equal(productionReviewCurrent(next, "brief"), false);
  assert.equal(productionReviewCurrent(next, "motion", "idle"), true);
  assert.ok(productionStageIssues(next, "brief").length, "New action still requires authored script and target.");
  assert.equal(includeMotionInProduction(next, motion, "duplicate"), next);
  const old = legacy(); assert.equal(includeMotionInProduction(old, motion, "unused"), old);
});

test("new source-only plans retain authored text without converting untouched starts or legacy documents", () => {
  const old = legacy(), snapshot = structuredClone(old);
  assertProductionGate(old, "save"); assert.deepEqual(productionStageIssues(old, "export"), []);
  assert.equal(validateProduction(old), old); assert.deepEqual(old, snapshot);
  const draft = { ...old, joints: [], parts: [], motions: [], production: createProductionPlan() };
  assert.equal(hasAuthoredProduction(draft), false);
  assert.throws(() => assertProductionGate(draft, "appearance"), /填写/);
  draft.production.brief.identity = "Authored character identity";
  assert.equal(hasAuthoredProduction(draft), true);
  assert.deepEqual(plannedMotionSlots(draft).map((m) => m.id), ["idle", "attack", "death"]);
  assert.ok(plannedMotionSlots(draft).every((m) => m.origin === "manual-placeholder"));
  const upgraded = createProductionPlan({ motions: [{ id: "a".repeat(96), name: "long", duration: 1, loop: false }] });
  assert.doesNotThrow(() => validateProduction({ production: upgraded }));
});

test("reviews require actual pictures and explicit checks; numerical success never substitutes for visual approval", () => {
  let doc = productionFixture({ reviewed: false });
  assert.throws(() => confirmProduction(doc, "appearance", undefined, productionChecks.appearance), /制作计划/);
  assert.throws(() => confirmProduction(doc, "brief", undefined, []), /逐项检查/);
  doc = confirmProduction(doc, "brief", undefined, productionChecks.brief, "2026-10-21T00:00:00Z");
  doc = confirmProduction(doc, "appearance", undefined, productionChecks.appearance, "2026-10-21T00:00:00Z");
  const attack = boardFor(doc, "attack"), missing = structuredClone(doc); delete boardFor(missing, "attack").image;
  assert.throws(() => confirmProduction(missing, "board", attack.id, productionChecks.board), /提供/);
  assert.throws(() => assertProductionGate(doc, "parts"), /关键画面/);
  assert.throws(() => assertProductionGate(productionFixture(), "save"), /运行时/);
});

test("changed scripts invalidate their own pose reviews while retaining images, unrelated motions and bindings", () => {
  const doc = productionFixture(), changed = structuredClone(doc);
  changed.production.motions.find((m) => m.id === "attack").script += " New windup.";
  assert.equal(productionReviewCurrent(changed, "brief"), false);
  assert.equal(productionReviewCurrent(changed, "board", boardFor(changed, "attack").id), false);
  assert.equal(productionReviewCurrent(changed, "motion", "attack"), false);
  assert.equal(productionReviewCurrent(changed, "motion", "idle"), true);
  assert.equal(productionReviewCurrent(changed, "binding"), true);
  assert.deepEqual(changed.parts, doc.parts); assert.deepEqual(changed.motions, doc.motions);
  assert.equal(boardFor(changed, "attack").image, boardFor(doc, "attack").image);
  changed.production.brief.rules += " Keep weapon length fixed.";
  assert.equal(productionReviewCurrent(changed, "appearance"), false);
  assert.throws(() => assertProductionGate(changed, "motion"), /制作计划/);
  const reweighted = structuredClone(doc); reweighted.joints[1].x++;
  assert.equal(productionReviewCurrent(reweighted, "binding"), false);
  assert.equal(productionReviewCurrent(reweighted, "motion", "idle"), false);
});

test("review metadata rejects malformed, unknown, forged and unbounded records", () => {
  for (const mutate of [
    (p) => { p.reviews.brief = true; }, (p) => { p.reviews.unrecognized = {}; },
    (p) => { p.reviews.boards = []; }, (p) => { p.reviews.brief.checks = ["approved"]; },
    (p) => { p.reviews.brief.at = "not a time"; }, (p) => { p.delivery.runtime = { snapshot: "bad" }; },
  ]) { const doc = productionFixture(); mutate(doc.production); assert.throws(() => validateProduction(doc), /无效|未知/); }
});

test("plan constraints are forwarded intact, including motion coverage, without silent truncation", () => {
  const doc = productionFixture(), text = productionPrompt(doc, "structure");
  assert.match(text, /idle/); assert.match(text, /attack/); assert.match(text, /death/); assert.match(text, /失去支撑/);
  doc.production.brief.identity = "x".repeat(3900);
  assert.throws(() => productionPrompt(doc, "structure"), /超出/);
});

test("key-image candidates freeze project, source, target and prompt, and never overwrite the setup or rig", async () => {
  let doc = productionFixture(), board = boardFor(doc, "attack"), request = productionReferenceRequest(doc, board.id);
  const job = { id: "reference-job", projectId: doc.id, kind: "appearance", status: "completed", referenceTarget: board.id,
    referenceFingerprint: request.referenceFingerprint, prompt: request.prompt, sourceFingerprint: await rigSourceFingerprint(doc), images: [{ id: "image-0" }] };
  doc = recordProductionRequest(doc, board.id, job);
  const load = async () => imageDataBytes(productionArtwork("#ff2233")).bytes;
  const decode = async () => ({ dataURL: productionArtwork("#ff2233") });
  const applied = await applyProductionReference(doc, job, load, decode);
  assert.equal(applied.sourceImage, doc.sourceImage); assert.deepEqual(applied.joints, doc.joints); assert.deepEqual(applied.motions, doc.motions);
  assert.notEqual(boardFor(applied, "attack").image, board.image); assert.equal(boardFor(applied, "attack").pending, undefined);
  for (const invalid of [{ ...job, status: "cancelled" }, { ...job, projectId: "other" }, { ...job, prompt: "changed" }, { ...job, id: "another-job" }])
    await assert.rejects(applyProductionReference(doc, invalid, load, decode), /不一致/);
  const changed = structuredClone(doc); boardFor(changed, "attack").prompt += " A different pose.";
  await assert.rejects(applyProductionReference(changed, job, load, decode), /不一致|制作计划/);
  const operations = createRigOperations({ images: {}, buildFiles: () => {} });
  await assert.rejects(operations.prepareCandidate(doc, job, load), /对应分镜/);
  const stale = { ...job, referenceTarget: undefined, productionFingerprint: "0".repeat(64) };
  await assert.rejects(operations.prepareCandidate(doc, stale, load), /旧候选/);
});

async function serviceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ispine-production-")), calls = { images: 0, snapshots: 0, plans: [] };
  const rpc = Object.assign(new EventEmitter(), { async start() {}, async request() { return { account: { type: "chatgpt" } }; }, close() {} });
  const connections = { async snapshot() { calls.snapshots++; return { id: "codex-native", label: "Synthetic only" }; },
    async generate(_provider, options) { calls.images++; calls.imageOptions = options; return { result: Buffer.from(imageDataBytes(productionArtwork("#ff1122")).bytes).toString("base64"), model: "fake-only" }; } };
  const rigs = new RigJobs({ root, rpc, connections, plan: async (_rpc, options) => { calls.plans.push(options); return { value: calls.plannedValue }; } });
  await rigs.loading;
  t.after(async () => { await rigs.close(); await rigs.drainingPromise?.catch(() => {}); await rm(root, { recursive: true, force: true }); });
  return { root, rigs, calls };
}
async function finished(rigs, id) {
  for (let i = 0; i < 1000; i++) {
    const job = await rigs.get(id);
    if (["completed", "failed", "cancelled"].includes(job.status) && !rigs.draining) return job;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail("Synthetic production job did not settle");
}

test("server rejects incomplete plans and omitted constraints before unlocking or invoking any provider", async (t) => {
  const { rigs, calls } = await serviceFixture(t), doc = productionFixture({ reviewed: false });
  const request = { version: 1, kind: "appearance", projectId: doc.id, rig: doc, prompt: "Try to skip plan review" };
  await assert.rejects(rigs.create(request), /制作计划/);
  await assert.rejects(rigs.create({ ...request, rig: productionFixture() }), /完整约束/);
  await assert.rejects(rigs.create({ ...request, rig: productionFixture(), image: { base64: Buffer.from(imageDataBytes(productionArtwork("#112233")).bytes).toString("base64"), width: 64, height: 64 } }), /不能替换参考/);
  assert.equal(calls.snapshots, 0); assert.equal(calls.images, 0); assert.equal(calls.plans.length, 0);
});

test("native key-image generation preserves original pixels and fixed canvas instead of adding setup margins", async (t) => {
  const { rigs, calls } = await serviceFixture(t), doc = productionFixture(), board = boardFor(doc, "death");
  const done = await finished(rigs, (await rigs.create(productionReferenceRequest(doc, board.id))).id);
  assert.equal(done.status, "completed", done.error); assert.equal(calls.images, 1);
  assert.match(calls.imageOptions.instructions, /fixes identity|fix identity/);
  assert.match(calls.imageOptions.prompt, /64 x 64/);
  assert.deepEqual(await rigs.image(done.id, done.images[0].id), Buffer.from(imageDataBytes(productionArtwork("#ff1122")).bytes));
  assert.equal(done.referenceTarget, board.id); assert.equal(done.referenceFingerprint, productionFingerprint(doc, "board-request", board.id));
});

test("different native key-image canvases remain inspectable and need explicit uniform calibration before review", async (t) => {
  const { rigs } = await serviceFixture(t), doc = productionFixture(), board = boardFor(doc, "attack"), wide = createCanvas(128, 64);
  wide.getContext("2d").fillStyle = "#af3999"; wide.getContext("2d").fillRect(52, 12, 24, 40);
  const native = wide.toBuffer("image/png");
  rigs.connections.generate = async () => ({ result: native.toString("base64"), model: "synthetic-only" });
  const done = await finished(rigs, (await rigs.create(productionReferenceRequest(doc, board.id))).id);
  assert.equal(done.status, "completed", done.error); assert.equal(done.images[0].width, 128); assert.equal(done.images[0].requiresCalibration, true);
  assert.deepEqual(await rigs.image(done.id, done.images[0].raw.id), native);
  const current = recordProductionRequest(doc, board.id, done), decode = (bytes, options) => readRigImage(bytes, options, pixelEnv), read = (id, image) => rigs.image(id, image.id);
  await assert.rejects(applyProductionReference(current, done, read, decode), /先校准/);
  const prepared = await prepareProductionReference(current, done, read, decode), session = createRigReferenceCalibration(prepared);
  assert.equal(session.edit.transform.scaleX, 1, "native content is not automatically resized to canvas bounds");
  for (const fields of [{ scaleX: 1, scaleY: .5 }, { flipX: true }, { x: 100 }]) await assert.rejects(bakeRigReferenceCalibration(session, { ...session.edit, transform: { ...session.edit.transform, ...fields } }, pixelEnv), /等比|可见源像素/);
  const baked = await bakeRigReferenceCalibration(session, session.edit, pixelEnv), applied = withProductionReference(current, prepared, baked.image, baked.nativeImage, baked.transform);
  const decoded = await loadImage(baked.image); assert.equal(decoded.width, 64); assert.equal(decoded.height, 64);
  const pixels = createCanvas(64, 64), context = pixels.getContext("2d"); context.drawImage(decoded, 0, 0);
  assert.deepEqual(alphaBounds(context.getImageData(0, 0, 64, 64)), { x: 20, y: 12, width: 24, height: 40 }, "identity retains native pixel size without a second fit");
  context.clearRect(0, 0, 64, 64); drawReplacement(context, await loadImage(native), session.part, session.edit.transform);
  assert.deepEqual(alphaBounds(context.getImageData(0, 0, 64, 64)), { x: 20, y: 12, width: 24, height: 40 }, "preview matches baked pixels");
  assert.equal(boardFor(applied, "attack").nativeImage, `data:image/png;base64,${native.toString("base64")}`);
  assert.equal(productionReviewCurrent(applied, "board", board.id), false);
  assert.throws(() => withProductionReference({ ...current }, prepared, baked.image, baked.nativeImage, baked.transform), /已改变/);
  const reopened = await prepareStoredProductionReference(applied, board.id, decode), stored = createRigReferenceCalibration(reopened);
  assert.deepEqual(Buffer.from(stored.edit.image), native);
  const half = await bakeRigReferenceCalibration(stored, { ...stored.edit, transform: { ...stored.edit.transform, scaleX: .5, scaleY: .5 } }, pixelEnv);
  context.clearRect(0, 0, 64, 64); context.drawImage(await loadImage(half.image), 0, 0);
  assert.deepEqual(alphaBounds(context.getImageData(0, 0, 64, 64)), { x: 26, y: 22, width: 12, height: 20 });
  assert.equal(boardFor(withProductionReference(applied, reopened, half.image, half.nativeImage, half.transform), "attack").jobId, done.id);
  assert.throws(() => withProductionReference({ ...applied }, reopened, half.image, half.nativeImage, half.transform), /已改变/);
  const files = productionExportBundle(applied, parseBundle(await buildRigFiles(applied, pixelEnv))).files;
  assert.deepEqual(readRigAuthoring(files).production.boards, applied.production.boards);
});

test("structural planning receives every approved pose image and protects attached file hashes", async (t) => {
  const { rigs, calls, root } = await serviceFixture(t), doc = productionFixture();
  calls.plannedValue = { joints: doc.joints, parts: doc.parts.map(({ id, label, bone, x, y, width, height, z, binding, influences }) => ({ id, label, bone, x, y, width, height, z, binding, influences, prompt: "Complete support shape", critical: true, attachmentGroup: null })), defaultAttachments: [], notes: "Synthetic only" };
  const done = await finished(rigs, (await rigs.create({ version: 1, kind: "structure", projectId: doc.id, rig: doc, planner: "codex-native", prompt: productionPrompt(doc, "structure") })).id);
  assert.equal(done.status, "completed", done.error); assert.equal(calls.plans.length, 1);
  assert.equal(calls.plans[0].references.length, 3); assert.equal(done.productionReferences.length, 2);
  assert.ok(done.productionReferences.every((r) => !r.file));
  assert.match(calls.plans[0].prompt, /sole coordinate\/scale source/);
  for (let i = 0; i < 2; i++) assert.deepEqual(await readFile(calls.plans[0].references[i + 1]), Buffer.from(imageDataBytes(doc.production.boards[i + 1].image).bytes));
  assert.equal(done.productionFingerprint, productionRequestFingerprint(doc, "structure"));
  const changed = { ...doc, prompts: { structure: "A newly edited structure description" } };
  await assert.rejects(createRigOperations({ images: {}, buildFiles: () => {} }).prepareCandidate(changed, done, () => {}), /旧候选/);
  const internal = rigs.jobs.get(done.id); await writeFile(calls.plans[0].references[1], Buffer.from([1, 2, 3]));
  await assert.rejects(analyze(rigs, { ...internal, controller: new AbortController() }), /本地文件已改变/);
  assert.equal(calls.plans.length, 1); assert.ok(root);
});

test("motion planning uses the selected action's reviewed image and immutable constraints without touching other actions", async (t) => {
  const { rigs, calls } = await serviceFixture(t), doc = productionFixture(), motion = doc.motions.find((m) => m.id === "attack");
  const { origin, ...value } = motion;
  calls.plannedValue = { ...value, poses: motion.poses.map((p) => ({ ...p, angles: { root: 0, hand: p.angles.hand }, translations: null, scales: null,
    drawOrder: null, feet: { left: false, right: false } })) };
  const done = await finished(rigs, (await rigs.create({ version: 1, kind: "motion", projectId: doc.id, rig: doc, planner: "codex-native",
    motion: { id: motion.id, name: motion.name, duration: motion.duration, loop: motion.loop, description: productionPrompt(doc, "motion", motion.id) } })).id);
  assert.equal(done.status, "completed", done.error); assert.equal(calls.plans[0].references.length, 2);
  assert.equal(done.motionReferences.length, 1); assert.equal(done.motionReferences[0].frameId, boardFor(doc, "attack").id);
  assert.match(calls.plans[0].prompt, /visible bounding box/);
  const ops = createRigOperations({ images: {}, buildFiles: () => {} }), applied = await ops.prepareCandidate(doc, done, () => {});
  assert.deepEqual(applied.document.parts, doc.parts); assert.deepEqual(applied.document.joints, doc.joints);
  assert.deepEqual(applied.document.motions.find((m) => m.id === "idle"), doc.motions.find((m) => m.id === "idle"));
  assert.deepEqual(applied.document.motions.find((m) => m.id === "death"), doc.motions.find((m) => m.id === "death"));
  assert.equal(applied.document.motions.find((m) => m.id === "attack").provenance.referenceFrames[0].frameId, boardFor(doc, "attack").id);
});

test("real runtime and editable ZIPs retain plans, native reference PNGs and stale-safe delivery receipts", async () => {
  const doc = productionFixture(), raw = parseBundle(await buildRigFiles(doc, pixelEnv)), bundle = productionExportBundle(doc, raw);
  const metadata = JSON.parse(new TextDecoder().decode(bundle.files[".ispine/rig/document.json"]));
  assert.equal(metadata.production.boards[1].image, undefined);
  assert.ok(bundle.files[metadata.production.boards[1].imageFile.path]);
  assert.deepEqual(readRigAuthoring(bundle.files), doc);
  const runtime = exportPackage(bundle), editable = exportPackage(bundle, {}, { editable: true });
  let checked = verifyProductionPackage(doc, raw, runtime, "runtime", "actual-runtime.zip");
  assert.throws(() => assertProductionGate(checked, "save"), /可编辑/);
  checked = verifyProductionPackage(checked, raw, editable, "project", "actual-project.zip");
  assert.doesNotThrow(() => assertProductionGate(checked, "save"));
  assert.throws(() => verifyProductionPackage(doc, raw, editable, "runtime", "wrong-type.zip"), /类型/);
  const changed = structuredClone(checked); changed.name += " changed";
  assert.throws(() => assertProductionGate(changed, "save"), /运行时/);
  const altered = unpackZip(runtime), skeleton = JSON.parse(new TextDecoder().decode(altered[bundle.skeletonPath]));
  skeleton.bones[0].x += 1; altered[bundle.skeletonPath] = new TextEncoder().encode(JSON.stringify(skeleton));
  assert.throws(() => verifyProductionPackage(doc, raw, zipSync(altered), "runtime", "altered.zip"), /骨架或动画/);
  const badAtlas = unpackZip(runtime); badAtlas[bundle.pages[0].file] = imageDataBytes(productionArtwork("#111111")).bytes;
  assert.throws(() => verifyProductionPackage(doc, raw, zipSync(badAtlas), "runtime", "altered-atlas.zip"), /贴图像素/);
  const badEditable = unpackZip(editable); badEditable[bundle.skeletonPath] = altered[bundle.skeletonPath];
  assert.throws(() => verifyProductionPackage(doc, raw, zipSync(badEditable), "project", "damaged-top-level.zip"), /骨架或动画/);
  const badMapping = unpackZip(runtime); badMapping["rig.atlas"] = new TextEncoder().encode(new TextDecoder().decode(badMapping["rig.atlas"]).replace("bounds:2,2,", "bounds:3,2,"));
  if (new TextDecoder().decode(badMapping["rig.atlas"]) !== new TextDecoder().decode(bundle.files["rig.atlas"])) assert.throws(() => verifyProductionPackage(doc, raw, zipSync(badMapping), "runtime", "altered-mapping.zip"), /Atlas/);
});

test("candidate export downloads without saving a library resource and visual reviews cannot bypass runtime checks", async () => {
  const doc = productionFixture(), raw = parseBundle(await buildRigFiles(doc, pixelEnv)), bundle = productionExportBundle(doc, raw), downloads = [];
  const exporter = createProjectExporter({ archive: { export: exportPackage }, pixels: { compilePages: async () => ({}), synchronizeRigAuthoring: async (b) => b.files }, downloads: { save: async (bytes, name) => downloads.push({ bytes, name }) } });
  await exporter({ bundle, edits: {}, mode: "runtime", name: doc.name }); assert.equal(downloads.length, 1);
  const ops = createRigOperations({ images: {}, buildFiles: () => {}, inspectMotion: async () => ({ finite: true, issues: ["Unreachable planted contact"] }) });
  await assert.rejects(ops.validateForSave(doc, { requireDelivery: false }), /Unreachable planted contact/);
});

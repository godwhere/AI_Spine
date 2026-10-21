import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createRigClient } from "../src/infrastructure/rig-client.js";
import { rigGeometry, rigReadiness, rigAttachmentGroups, rigDefaultVisiblePartIds, rigWithPartAttachmentGroup, rigWithPartFields, rigWithoutPart, rigWithDefaultAttachment } from "../shared/domain/rig.mjs";
import { assertRigJobMatches, assertRigAppearanceMatches, assertRigPartJobMatches, assertRigRegistrationMatches, rigRegistrationPolygons, rigCompositionFingerprint, rigRetryablePartIds, rigSourceFingerprint, rigWithAppearance, rigSourceRequest } from "../shared/domain/generation.mjs";
import { bytesToImageDataURL } from "../shared/codec/image-data.mjs";
import { readRigImage, readRigReference, readRigPartCandidate, composeRigSourceView, inspectRigPartAlpha, createRigPartCalibration, bakeRigPartCalibration } from "../src/infrastructure/rig-images.js";
import { browserPixels } from "../src/infrastructure/browser-pixels.js";
import { alphaBounds, identityTransform } from "../engine/images/calibration.js";
import { autoFit } from "../src/infrastructure/calibration.js";
import { createHumanoidDraft } from "../src/infrastructure/rig-authoring.js";
import { validateRigDocument } from "../shared/rig-schema.mjs";
import { resolveRigAttachments } from "../engine/rig/attachments.js";
import { rigGeometry as serverGeometry } from "../server/jobs/rig-service.mjs";

test("rig HTTP client submits only explicit requests and preserves the selected planner", async () => {
  const calls = [], client = createRigClient(async (path, options) => {
    calls.push({ path, options });
    return new Response(JSON.stringify(path.includes("?") ? { jobs: [] } : { id: "job-1", status: "queued" }), { status: options?.method === "POST" ? 202 : 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(calls.length, 0);
  await client.list("rig-1"); assert.equal(calls[0].path, "/api/rig/jobs?projectId=rig-1");
  await client.start({ version: 1, kind: "motion", projectId: "rig-1", planner: "codex-native", motion: { id: "attack", description: "Faster swing" } });
  assert.equal(calls[1].options.method, "POST"); assert.equal(JSON.parse(calls[1].options.body).planner, "codex-native");
  await client.cancel("job-1"); assert.equal(calls[2].options.method, "DELETE");
  await client.retry("job-1", { concurrency: 3 });
  assert.equal(calls[3].path, "/api/rig/jobs/job-1/retry"); assert.deepEqual(JSON.parse(calls[3].options.body), { concurrency: 3 });
});

test("rig image reads reject external or mismatched task URLs and non-PNG replies", async () => {
  let calls = 0;
  const client = createRigClient(async () => { calls++; return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }); });
  for (const url of ["https://example.com/image.png", "/api/rig/jobs/other/images/image-1", "/api/rig/jobs/job-1/images/../private"])
    await assert.rejects(() => client.image("job-1", { url }), /地址无效/);
  assert.equal(calls, 0);
  assert.deepEqual(await client.image("job-1", { url: "/api/rig/jobs/job-1/images/image-1" }), new Uint8Array([1, 2, 3]));
  const invalid = createRigClient(async () => new Response("page", { headers: { "content-type": "text/html" } }));
  await assert.rejects(() => invalid.image("job-1", { id: "image-1" }), /读取失败/);
});

test("client geometry matches the server and rejects stale joints, weights and grip candidates", () => {
  const document = createHumanoidDraft({ id: "rig-1", width: 768, height: 1024 });
  assert.deepEqual(rigGeometry(document), serverGeometry(document));
  const job = { projectId: document.id, geometry: serverGeometry(document) };
  assert.doesNotThrow(() => assertRigJobMatches(document, job));
  for (const alter of [
    (copy) => { copy.joints[0].x++; },
    (copy) => { copy.parts[0].mesh = { cols: 2, rows: 2, weights: [[{ joint: copy.parts[0].bone, weight: 1 }]] }; },
    (copy) => { copy.parts[0].grip = { primaryHand: "rightHand", primaryLocalPoint: { x: 1, y: 1 } }; },
  ]) { const copy = structuredClone(document); alter(copy); assert.throws(() => assertRigJobMatches(copy, job), /已改变/); }
  assert.throws(() => assertRigJobMatches(document, { ...job, projectId: "another" }), /另一份/);
  const renamed = { ...document, name: "A new name" }; assert.doesNotThrow(() => assertRigJobMatches(renamed, job));
});

test("source crops never count as complete while calibrated independent images remain ready", () => {
  const image = "data:image/png;base64,AAAA";
  const part = { id: "part", image, completion: "ready" };
  for (const imageSource of ["source-crop", "placeholder", undefined]) assert.equal(rigReadiness({ parts: [{ ...part, imageSource }] }).ready, false);
  for (const imageSource of ["uploaded", "ai", "calibrated"]) assert.equal(rigReadiness({ parts: [{ ...part, imageSource }] }).ready, true);
  assert.equal(rigReadiness({ parts: [] }).ready, false);
  const source = bytesToImageDataURL(new Uint8Array([0, 255, 3]));
  assert.deepEqual(rigSourceRequest({ sourceImage: source, width: 20, height: 30 }), { base64: "AP8D", width: 20, height: 30 });
});

test("real alpha accepts black transparent artwork and rejects opaque or empty parts", async () => {
  const previous = { ...browserPixels };
  Object.assign(browserPixels, { createCanvas, loadImage: (bytes) => loadImage(Buffer.from(bytes)), encode: async (canvas) => new Uint8Array(canvas.toBuffer("image/png")) });
  try {
    const black = createCanvas(40, 40), context = black.getContext("2d"); context.fillStyle = "#000"; context.fillRect(10, 10, 20, 20);
    const result = await readRigImage(new Uint8Array(black.toBuffer("image/png")), { requireTransparent: true });
    const decoded = await loadImage(Buffer.from(result.dataURL.split(",")[1], "base64"));
    const check = createCanvas(40, 40), pixels = check.getContext("2d"); pixels.drawImage(decoded, 0, 0);
    assert.deepEqual([...pixels.getImageData(20, 20, 1, 1).data], [0, 0, 0, 255]);
    assert.equal(pixels.getImageData(0, 0, 1, 1).data[3], 0);
    context.fillRect(0, 0, 40, 40);
    await assert.rejects(() => readRigImage(new Uint8Array(black.toBuffer("image/png")), { requireTransparent: true }), /没有透明像素/);
    assert.equal((await readRigImage(new Uint8Array(black.toBuffer("image/png")))).transparent, false);
    context.clearRect(0, 0, 40, 40);
    await assert.rejects(() => readRigImage(new Uint8Array(black.toBuffer("image/png")), { requireTransparent: true }), /完全透明/);
  } finally { Object.assign(browserPixels, previous); }
});

const pixels = { createCanvas, loadImage: (bytes) => loadImage(Buffer.from(bytes)), encode: async (canvas) => new Uint8Array(canvas.toBuffer("image/png")) };
function calibrationDocument() {
  const source = createCanvas(200, 200), original = source.getContext("2d");
  original.fillStyle = "#de2b56"; original.fillRect(24, 44, 72, 36);
  const independent = createCanvas(42, 24), image = independent.getContext("2d");
  image.fillStyle = "#000"; image.fillRect(20, 10, 15, 11);
  return { id: "calibration", width: 100, height: 100, sourceImage: bytesToImageDataURL(source.toBuffer("image/png")),
    joints: [{ id: "foot", x: 25, y: 25 }], motions: [{ id: "attack", poses: [{ time: 0, angles: { foot: 7 } }] }],
    parts: [{ id: "foot", bone: "foot", x: 10, y: 20, width: 42, height: 24, z: 3, binding: "mesh", influences: ["foot"],
      mesh: { cols: 2, rows: 2, weights: [[{ joint: "foot", weight: 1 }]] }, grip: { primaryHand: "foot", primaryLocalPoint: { x: 5, y: 4 } },
      image: bytesToImageDataURL(independent.toBuffer("image/png")), imageSource: "ai", completion: "ready", imageGeneration: { jobId: "retained-job", partId: "foot" } }, { id: "unchanged", imageSource: "placeholder" }] };
}

test("part calibration uses the original source crop and bakes alpha-fit without altering rig or provenance", async () => {
  const document = calibrationDocument(), before = structuredClone(document);
  const session = await createRigPartCalibration(document, "foot", pixels);
  assert.equal(session.document, document); assert.equal(session.part.originalWidth, 42); assert.equal(session.part.originalHeight, 24);
  const reference = await pixels.loadImage(session.bundle.files["reference.png"]), canvas = createCanvas(42, 24), context = canvas.getContext("2d");
  context.drawImage(reference, 0, 0);
  assert.deepEqual([...context.getImageData(10, 10, 1, 1).data], [222, 43, 86, 255]);
  assert.deepEqual(alphaBounds(context.getImageData(0, 0, 42, 24)), { x: 2, y: 2, width: 36, height: 18 });
  const transform = await autoFit(session.bundle, session.part, session.edit.image, pixels);
  const next = await bakeRigPartCalibration(document, "foot", { ...session.edit, transform }, pixels);
  const calibrated = await pixels.loadImage(Buffer.from(next.parts[0].image.split(",")[1], "base64"));
  assert.equal(calibrated.width, 42); assert.equal(calibrated.height, 24); context.clearRect(0, 0, 42, 24); context.drawImage(calibrated, 0, 0);
  const bounds = alphaBounds(context.getImageData(0, 0, 42, 24));
  assert.ok(bounds.width >= 24 && bounds.height >= 18, `Expected alpha-fit to expand the 15×11 pixels: ${JSON.stringify(bounds)}`);
  assert.deepEqual([...context.getImageData(20, 10, 1, 1).data], [0, 0, 0, 255]);
  assert.equal(context.getImageData(0, 0, 1, 1).data[3], 0);
  assert.equal(next.joints, document.joints); assert.equal(next.motions, document.motions); assert.equal(next.parts[1], document.parts[1]);
  assert.equal(next.parts[0].mesh, document.parts[0].mesh); assert.equal(next.parts[0].grip, document.parts[0].grip);
  assert.equal(next.parts[0].imageGeneration, document.parts[0].imageGeneration);
  assert.equal(next.parts[0].imageSource, "calibrated"); assert.equal(next.parts[0].completion, "ready");
  assert.deepEqual({ ...next.parts[0], image: before.parts[0].image, imageSource: "ai" }, before.parts[0]);
  assert.deepEqual(document, before);
});

test("calibration cannot promote source crops or accept empty, opaque, invalid or failed output", async () => {
  const document = calibrationDocument(), before = structuredClone(document), session = await createRigPartCalibration(document, "foot", pixels);
  for (const imageSource of ["source-crop", "placeholder"]) {
    const pending = { ...document, parts: [{ ...document.parts[0], imageSource }] };
    await assert.rejects(() => createRigPartCalibration(pending, "foot", pixels), /原图裁片/);
    await assert.rejects(() => bakeRigPartCalibration(pending, "foot", session.edit, pixels), /原图裁片/);
  }
  const incomplete = { ...document, parts: [{ ...document.parts[0], completion: "needs-inpaint" }] };
  await assert.rejects(() => createRigPartCalibration(incomplete, "foot", pixels), /完整独立/);
  await assert.rejects(() => bakeRigPartCalibration(incomplete, "foot", session.edit, pixels), /完整独立/);
  await assert.rejects(() => bakeRigPartCalibration(document, "foot", { ...session.edit, transform: { ...identityTransform(), x: 1000 } }, pixels), /移出了矩形/);
  await assert.rejects(() => bakeRigPartCalibration(document, "foot", { ...session.edit, transform: { ...identityTransform(), scaleX: 0 } }, pixels), /参数无效/);
  const opaque = createCanvas(42, 24); opaque.getContext("2d").fillRect(0, 0, 42, 24);
  await assert.rejects(() => bakeRigPartCalibration(document, "foot", { image: new Uint8Array(opaque.toBuffer("image/png")), transform: identityTransform() }, pixels), /没有透明像素/);
  await assert.rejects(() => bakeRigPartCalibration(document, "foot", session.edit, { ...pixels, encode: async () => { throw new Error("PNG encoder unavailable"); } }), /encoder unavailable/);
  assert.deepEqual(document, before);
});

test("appearance fingerprints use submitted bytes and reject stale or mismatched candidates", async () => {
  const document = { id: "appearance", width: 10, height: 20, sourceImage: bytesToImageDataURL(new TextEncoder().encode("abc")) };
  const fingerprint = await rigSourceFingerprint(document);
  assert.equal(fingerprint, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const image = { id: "image-0", width: 1024, height: 1024, sourceFingerprint: fingerprint };
  const job = { id: "appearance-job", projectId: document.id, kind: "appearance", status: "completed", sourceWidth: 10, sourceHeight: 20, sourceFingerprint: fingerprint, result: { images: [image] } };
  assert.equal(await assertRigAppearanceMatches(document, job), image);
  for (const patch of [{ projectId: "another" }, { sourceFingerprint: "0".repeat(64) }, { sourceWidth: 20 }, { status: "generating" }, { result: { images: [] } }, { result: { images: [{ ...image, sourceFingerprint: "0".repeat(64) }] } }, { result: { images: [{ ...image, width: 512 }] } }])
    await assert.rejects(() => assertRigAppearanceMatches(document, { ...job, ...patch }));
  await assert.rejects(() => assertRigAppearanceMatches({ ...document, sourceImage: bytesToImageDataURL(new TextEncoder().encode("different")) }, job), /立绘已改变/);
});

test("appearance application clears only rig authoring and preserves the original reference and provenance", () => {
  const document = createHumanoidDraft({ id: "appearance", width: 768, height: 1024, sourceImage: "data:image/png;base64,AAAA" });
  document.appearanceReference = { image: "data:image/png;base64,BBBB", width: 1029, height: 1528, name: "original.png" };
  document.prompts = { appearance: "Chibi cel shading", structure: "Keep a staff" };
  const before = structuredClone(document), job = { id: "appearance-job", prompt: "Chibi cel shading", sourceFingerprint: "a".repeat(64), provider: { id: "codex-native", label: "Codex 账号" }, model: "native-image", createdAt: "2026-10-20T10:00:00Z", images: [{ id: "image-0" }] };
  const image = { dataURL: "data:image/png;base64,CCCC", width: 1024, height: 1024, transparent: true };
  const next = rigWithAppearance(document, job, image);
  assert.deepEqual(document, before); assert.equal(next.id, document.id); assert.equal(next.name, document.name);
  assert.equal(next.sourceImage, image.dataURL); assert.equal(next.width, 1024); assert.equal(next.height, 1024);
  assert.deepEqual([next.joints, next.parts, next.motions], [[], [], []]);
  assert.equal(next.appearanceReference, document.appearanceReference); assert.equal(next.prompts, document.prompts);
  assert.equal(next.appearance.provider, "codex-native"); assert.equal(next.appearance.jobId, "appearance-job"); assert.equal(next.appearance.prompt, job.prompt);
  assert.equal(next.appearance.sourceFingerprint, job.sourceFingerprint);
  assert.throws(() => rigWithAppearance(document, job, { ...image, transparent: false }), /真实透明/);
});

test("reference import preserves exact original bytes and dimensions separately from the working image", async () => {
  const previous = { ...browserPixels }; Object.assign(browserPixels, pixels);
  try {
    const original = createCanvas(30, 40); original.getContext("2d").fillRect(0, 0, 30, 40);
    const bytes = new Uint8Array(original.toBuffer("image/png"));
    const file = { name: "portrait.png", type: "image/png", arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    const result = await readRigReference(file);
    assert.deepEqual(new Uint8Array(Buffer.from(result.reference.image.split(",")[1], "base64")), bytes);
    assert.deepEqual({ ...result.reference, image: undefined }, { image: undefined, width: 30, height: 40, name: "portrait.png" });
    assert.equal(result.transparent, false); assert.equal(result.sourceWidth, 30); assert.equal(result.sourceHeight, 40);
  } finally { Object.assign(browserPixels, previous); }
});

test("part candidate validation rejects changed source bytes even when skeleton geometry is identical", async () => {
  const document = createHumanoidDraft({ id: "parts", width: 768, height: 1024, sourceImage: "data:image/png;base64,AAAA" });
  const sourceFingerprint = await rigSourceFingerprint(document), image = { id: "image-0", partId: document.parts[0].id, sourceFingerprint };
  const job = { projectId: document.id, kind: "parts", status: "failed", geometry: rigGeometry(document), sourceFingerprint, sourceWidth: document.width, sourceHeight: document.height, images: [image] };
  assert.deepEqual(await assertRigPartJobMatches(document, job), [image]);
  const changed = { ...document, sourceImage: "data:image/png;base64,BBBB" };
  assert.deepEqual(rigGeometry(changed), job.geometry);
  await assert.rejects(() => assertRigPartJobMatches(changed, job), /源立绘已改变/);
  await assert.rejects(() => assertRigPartJobMatches(document, { ...job, sourceFingerprint: undefined }), /无法验证/);
  await assert.rejects(() => assertRigPartJobMatches(document, { ...job, images: [{ ...image, sourceFingerprint: "0".repeat(64) }] }), /源立绘不一致/);
  await assert.rejects(() => assertRigPartJobMatches(document, { ...job, geometry: undefined }), /缺少可验证/);
});

test("retry selection includes only unfinished parts from failed or cancelled snapshots", () => {
  const job = { kind: "parts", status: "failed", partIds: ["hand", "foot", "hair", "hand"], images: [{ partId: "hand" }] };
  assert.deepEqual(rigRetryablePartIds(job), ["foot", "hair"]);
  assert.deepEqual(rigRetryablePartIds({ ...job, status: "cancelled" }), ["foot", "hair"]);
  for (const status of ["queued", "generating", "completed"]) assert.deepEqual(rigRetryablePartIds({ ...job, status }), []);
});

test("logical part PNG candidates preserve exact pixels and alpha without fitting them again", async () => {
  const previous = { ...browserPixels }; Object.assign(browserPixels, pixels);
  try {
    const canvas = createCanvas(42, 24); canvas.getContext("2d").fillRect(20, 10, 15, 11);
    const bytes = new Uint8Array(canvas.toBuffer("image/png"));
    const result = await readRigPartCandidate(bytes, { expectedWidth: 42, expectedHeight: 24 });
    assert.deepEqual(new Uint8Array(Buffer.from(result.dataURL.split(",")[1], "base64")), bytes);
    assert.equal(result.width, 42); assert.equal(result.height, 24); assert.equal(result.resized, false);
    const image = await pixels.loadImage(bytes), checked = createCanvas(42, 24); checked.getContext("2d").drawImage(image, 0, 0);
    assert.deepEqual(alphaBounds(checked.getContext("2d").getImageData(0, 0, 42, 24)), { x: 20, y: 10, width: 15, height: 11 });
    await assert.rejects(() => readRigPartCandidate(bytes, { expectedWidth: 84, expectedHeight: 48 }), /尺寸.*不一致/);
    await assert.rejects(() => readRigPartCandidate(new Uint8Array([1, 2, 3])), /透明 PNG/);
  } finally { Object.assign(browserPixels, previous); }
});

test("legacy ungrouped snapshots normalize empty group fields without altering frozen hashes", () => {
  const document = createHumanoidDraft({ id: "legacy", width: 768, height: 1024 }), geometry = rigGeometry(document);
  delete geometry.defaultAttachments; for (const part of geometry.parts) delete part.attachmentGroup;
  const job = { projectId: document.id, geometry, rigFingerprint: "original-frozen-hash" }, before = structuredClone(job);
  assert.doesNotThrow(() => assertRigJobMatches(document, job)); assert.deepEqual(job, before);
  const grouped = rigWithPartAttachmentGroup(document, document.parts[0].id, "eyeLeft");
  assert.throws(() => assertRigJobMatches(grouped, job), /已改变/); assert.equal(job.rigFingerprint, "original-frozen-hash");
});

test("attachment group joins share bone and depth while defaults and visibility remain exclusive", () => {
  const original = createHumanoidDraft({ id: "groups", width: 768, height: 1024 }), before = structuredClone(original), [first, second] = original.parts;
  let document = rigWithPartAttachmentGroup(original, first.id, "eyeLeft");
  document = rigWithPartAttachmentGroup(document, second.id, "eyeLeft");
  assert.doesNotThrow(() => validateRigDocument(document));
  assert.equal(document.parts[1].bone, first.bone); assert.equal(document.parts[1].z, first.z);
  assert.equal(document.defaultAttachments.eyeLeft, first.id); assert.equal(rigAttachmentGroups(document)[0].parts.length, 2);
  assert.ok(rigDefaultVisiblePartIds(document).includes(first.id)); assert.ok(!rigDefaultVisiblePartIds(document).includes(second.id));
  document = rigWithDefaultAttachment(document, "eyeLeft", second.id);
  assert.ok(!rigDefaultVisiblePartIds(document).includes(first.id)); assert.ok(rigDefaultVisiblePartIds(document).includes(second.id));
  assert.ok(rigDefaultVisiblePartIds(document, { eyeLeft: first.id }).includes(first.id));
  assert.deepEqual(rigDefaultVisiblePartIds(document), resolveRigAttachments(document).visiblePartIds);
  assert.equal(document.defaultAttachments.eyeLeft, second.id);
  document = rigWithDefaultAttachment(document, "eyeLeft", null);
  assert.doesNotThrow(() => validateRigDocument(document));
  assert.ok(!rigDefaultVisiblePartIds(document).some((id) => [first.id, second.id].includes(id)));
  assert.deepEqual(original, before);
  assert.throws(() => rigWithPartAttachmentGroup(document, first.id, "not a group"), /显示组 ID/);
  assert.throws(() => rigWithDefaultAttachment(document, "eyeLeft", document.parts[2].id), /不属于/);
});

test("leaving groups and deleting parts clean defaults and every animation reference", () => {
  let document = createHumanoidDraft({ id: "cleanup", width: 768, height: 1024 }); const [first, second] = document.parts;
  document = rigWithPartAttachmentGroup(document, first.id, "mouth"); document = rigWithPartAttachmentGroup(document, second.id, "mouth");
  document = rigWithDefaultAttachment(document, "mouth", second.id);
  document.motions = document.motions.map((motion) => ({ ...motion, poses: motion.poses.map((pose) => ({ ...pose, attachments: { mouth: second.id } })) }));
  const removed = rigWithoutPart(document, second.id);
  assert.doesNotThrow(() => validateRigDocument(removed));
  assert.equal(removed.defaultAttachments.mouth, first.id); assert.ok(removed.motions.every((motion) => motion.poses.every((pose) => !Object.hasOwn(pose.attachments, "mouth"))));
  const ordinary = rigWithPartAttachmentGroup(removed, first.id, "");
  assert.doesNotThrow(() => validateRigDocument(ordinary));
  assert.deepEqual(ordinary.defaultAttachments, {}); assert.equal(rigAttachmentGroups(ordinary).length, 0);
  assert.equal(ordinary.parts[0].attachmentGroup, undefined);
  assert.throws(() => rigWithoutPart({ ...ordinary, parts: [ordinary.parts[0]] }, first.id), /至少保留/);
});

test("group binding and depth edits propagate without changing geometry rectangles or motion frames", () => {
  let document = createHumanoidDraft({ id: "shared-binding", width: 768, height: 1024 });
  document = rigWithPartAttachmentGroup(document, document.parts[0].id, "eyeRight"); document = rigWithPartAttachmentGroup(document, document.parts[1].id, "eyeRight");
  const before = structuredClone(document), bone = document.joints.at(-1).id;
  const next = rigWithPartFields(document, document.parts[0].id, { bone, influences: [bone], mesh: undefined, grip: undefined, z: 15 });
  assert.doesNotThrow(() => validateRigDocument(next));
  for (const index of [0, 1]) { assert.equal(next.parts[index].bone, bone); assert.equal(next.parts[index].z, 15); for (const field of ["x", "y", "width", "height"]) assert.equal(next.parts[index][field], before.parts[index][field]); }
  assert.deepEqual(next.motions, before.motions); assert.deepEqual(next.joints, before.joints); assert.deepEqual(document, before);
});

test("registration planning verifies source and immutable geometry while accepting true contours beyond narrow rectangles", async () => {
  const document = createHumanoidDraft({ id: "registration", width: 768, height: 1024, sourceImage: "data:image/png;base64,AAAA" });
  const polygons = Object.fromEntries(document.parts.map((part) => [part.id, [{ x: part.x, y: part.y }, { x: part.x + part.width, y: part.y }, { x: part.x, y: part.y + part.height }]]));
  const sourceFingerprint = await rigSourceFingerprint(document), job = { kind: "registration", status: "completed", projectId: document.id, geometry: rigGeometry(document), sourceFingerprint, sourceWidth: document.width, sourceHeight: document.height,
    result: { gridSize: 32, polygons, canApply: false } };
  polygons[document.parts[0].id] = Array.from({ length: 200 }, (_, index) => ({ x: 380 + Math.cos(index / 200 * Math.PI * 2) * 200, y: 500 + Math.sin(index / 200 * Math.PI * 2) * 200 }));
  assert.equal((await assertRigRegistrationMatches(document, job))[document.parts[0].id].length, 200);
  await assert.rejects(() => assertRigRegistrationMatches({ ...document, sourceImage: "data:image/png;base64,BBBB" }, job), /源立绘已改变/);
  const changed = structuredClone(document); changed.parts[0].x++;
  await assert.rejects(() => assertRigRegistrationMatches(changed, job), /已改变/);
  const missing = { ...polygons }; delete missing[document.parts[1].id]; assert.throws(() => rigRegistrationPolygons(document, missing), /覆盖每个/);
  assert.throws(() => rigRegistrationPolygons(document, { ...polygons, [document.parts[0].id]: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] }), /零面积/);
});

test("composition fingerprints expire for source artwork rectangles depth and default attachments but not joints or motion edits", async () => {
  let document = createHumanoidDraft({ id: "composition", width: 768, height: 1024, sourceImage: "data:image/png;base64,AAAA" });
  document.parts = document.parts.map((part) => ({ ...part, image: "data:image/png;base64,AAAA" }));
  document = rigWithPartAttachmentGroup(document, document.parts[0].id, "mouth"); document = rigWithPartAttachmentGroup(document, document.parts[1].id, "mouth");
  const before = structuredClone(document), fingerprint = await rigCompositionFingerprint(document);
  for (const change of [(copy) => { copy.sourceImage = "data:image/png;base64,BBBB"; }, (copy) => { copy.parts[0].image = "data:image/png;base64,BBBB"; }, (copy) => { copy.parts[0].width++; }, (copy) => { copy.parts[0].z++; }, (copy) => { copy.defaultAttachments.mouth = copy.parts[1].id; }]) {
    const copy = structuredClone(document); change(copy); assert.notEqual(await rigCompositionFingerprint(copy), fingerprint);
  }
  const poseEdit = structuredClone(document); poseEdit.joints[0].x++; poseEdit.motions[0].poses[0].angles = { torso: 15 };
  assert.equal(await rigCompositionFingerprint(poseEdit), fingerprint);
  const inactiveEdit = structuredClone(document); inactiveEdit.parts[1].image = "data:image/png;base64,BBBB";
  assert.equal(await rigCompositionFingerprint(inactiveEdit), fingerprint); assert.deepEqual(document, before);
});

test("coordinate comparison composes exact mapped alpha and reports the current skinny artwork in source coordinates", async () => {
  const document = calibrationDocument(); document.parts = [document.parts[0]];
  const before = structuredClone(document), bounds = await inspectRigPartAlpha(document, "foot", pixels), view = await composeRigSourceView(document, pixels);
  assert.deepEqual(bounds, { x: 30, y: 30, width: 15, height: 11 });
  const image = await pixels.loadImage(view.png), canvas = createCanvas(100, 100), context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
  assert.deepEqual(alphaBounds(context.getImageData(0, 0, 100, 100)), { x: 30, y: 30, width: 15, height: 11 });
  assert.equal(view.width, 100); assert.equal(view.height, 100); assert.deepEqual(document, before);
});

test("manual image calibration discards previous registration bases and measurements while keeping AI provenance", async () => {
  const document = calibrationDocument(), part = document.parts[0];
  part.registrationBase = { image: part.image, x: part.x, y: part.y, width: part.width, height: part.height, imageSource: "ai", completion: "ready" };
  part.registration = { lockedPixels: 100, hiddenPixels: 20 };
  const before = structuredClone(document), session = await createRigPartCalibration(document, part.id, pixels);
  const next = await bakeRigPartCalibration(document, part.id, session.edit, pixels);
  assert.equal(Object.hasOwn(next.parts[0], "registrationBase"), false); assert.equal(Object.hasOwn(next.parts[0], "registration"), false);
  assert.deepEqual(next.parts[0].imageGeneration, before.parts[0].imageGeneration); assert.deepEqual(document, before);
});

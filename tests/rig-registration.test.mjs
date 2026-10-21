import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { validateRigDocument } from "../shared/rig-schema.mjs";
import { inspectRegistrationBounds } from "../engine/images/registration.js";
import { inspectRigSourceCoverage, expandRigRegistrationBounds, registerRigSourcePixels, measureRigSourceRegistration, prepareCompleteOverlapReview } from "../src/infrastructure/rig-registration.js";
import { buildRigFiles } from "../src/infrastructure/rig-authoring.js";
import { compileRigSkeleton } from "../engine/rig/compile.js";
import { attachRigAuthoring, readRigAuthoring } from "../engine/archive/rig-project.js";
import { imageDataBytes } from "../shared/codec/image-data.mjs";
import { exportPackage } from "../engine/archive/package.js";
import { parseBundle } from "../src/infrastructure/archive-files.js";
import { unpackZip } from "../engine/archive/zip.js";
import { parseSkeleton } from "../engine/spine/parse.js";
import { pixelEnv } from "./helpers.mjs";

const polygon = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
function image(width, height, color, skinny = false) {
  const canvas = createCanvas(width, height), context = canvas.getContext("2d");
  context.fillStyle = color; context.fillRect(skinny ? Math.floor(width / 4) : 0, 0, skinny ? Math.ceil(width / 2) : width, height);
  return canvas.toDataURL("image/png");
}
function fixture() {
  const canvas = createCanvas(40, 40), context = canvas.getContext("2d"), pixels = context.createImageData(40, 40);
  const fill = (x, y, w, h, color, alpha = 254) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) pixels.data.set([...color, alpha], (yy * 40 + xx) * 4);
  };
  fill(8, 18, 24, 18, [60, 180, 90]); fill(9, 28, 8, 10, [60, 70, 180]); fill(23, 28, 8, 10, [100, 80, 170]);
  fill(12, 5, 16, 14, [245, 200, 160]); fill(5, 15, 10, 17, [210, 70, 70]);
  fill(15, 10, 3, 1, [5, 8, 15]); fill(22, 10, 3, 1, [5, 8, 15]); fill(17, 14, 6, 1, [180, 50, 60]);
  fill(11, 7, 1, 1, [245, 200, 160], 80); context.putImageData(pixels, 0, 0);
  const part = (id, bone, x, y, width, height, z, color, group) => ({ id, label: id, bone, x, y, width, height, z,
    binding: "rigid", influences: [bone], image: image(Math.ceil(width), Math.ceil(height), color, id === "torso" || id.includes("Leg")),
    imageSource: "ai", completion: "ready", sourcePolygon: polygon(x, y, width, height), ...(group ? { attachmentGroup: group } : {}) });
  const parts = [part("torso", "root", 8, 18, 24, 18, 0, "#553399"), part("leftLeg", "root", 9, 28, 8, 10, 1, "#332299"),
    part("rightLeg", "root", 23, 28, 8, 10, 2, "#442299"), part("head", "head", 11.7, 4.6, 16.3, 14.4, 3, "#f5c8a0"),
    part("arm", "hand", 5, 15, 10, 17, 4, "#dd5566"), part("eyesOpen", "head", 15, 9, 10, 3, 5, "#111111", "eyes"),
    part("eyesClosed", "head", 15, 9, 10, 3, 5, "#2244cc", "eyes"), part("mouthNeutral", "head", 17, 14, 6, 1, 6, "#aa2233", "mouth"),
    part("mouthOpen", "head", 17, 12, 6, 6, 6, "#cc2255", "mouth")];
  parts[3].sourcePolygon = polygon(12, 5, 16, 14);
  parts[1].binding = "mesh"; parts[1].mesh = { cols: 2, rows: 2, weights: Array.from({ length: 4 }, () => [{ joint: "root", weight: 1 }]) };
  parts[4].grip = { primaryHand: "hand", primaryLocalPoint: { x: 3, y: 5 } };
  return validateRigDocument({ version: 1, id: "registration-fixture", name: "Coordinate fixture", width: 40, height: 40, sourceImage: canvas.toDataURL("image/png"),
    joints: [{ id: "root", parent: null, x: 20, y: 25 }, { id: "head", parent: "root", x: 20, y: 10 }, { id: "hand", parent: "root", x: 8, y: 20 }],
    parts, defaultAttachments: { eyes: "eyesOpen", mouth: "mouthNeutral" }, motions: [{ id: "idle", duration: 1, loop: true, poses: [{ time: 0 }, { time: 1 }] }] });
}
async function rgba(png) {
  const bitmap = await loadImage(Buffer.from(typeof png === "string" ? imageDataBytes(png).bytes : png)), canvas = createCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return { width: canvas.width, height: canvas.height, data: canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data };
}

test("source pixel ownership restores skinny AI parts without holes or new silhouette and measures actual CPU assembly", async () => {
  const original = fixture(), before = structuredClone(original), result = await registerRigSourcePixels(original, { jobId: "actual-mask-job", gridSize: 8 }, pixelEnv);
  assert.deepEqual(original, before); assert.equal(result.document.parts.length, before.parts.length);
  assert.deepEqual(result.document.joints, before.joints); assert.deepEqual(result.document.motions, before.motions); assert.deepEqual(result.document.defaultAttachments, before.defaultAttachments);
  assert.deepEqual(result.document.parts[1].mesh.weights, before.parts[1].mesh.weights);
  assert.ok(result.metrics.before.alphaIoU < 1); assert.ok(result.metrics.before.pixelMAE > 1);
  assert.equal(result.metrics.alphaIoU, 1); assert.equal(result.metrics.missingAlphaPixels, 0); assert.equal(result.metrics.extraAlphaPixels, 0);
  assert.ok(result.metrics.maxAlphaError <= 1); assert.ok(result.metrics.maxPremultipliedColorError <= 2);
  assert.equal(result.metrics.ownedPixels, result.metrics.sourcePixels); assert.ok(result.metrics.hiddenPixels > 20);
  assert.equal(result.metrics.semiOpaqueThreshold, 250); assert.ok(result.metrics.hiddenPixels > 0); assert.ok(result.metrics.fallbackPixels > 0);
  const ownerAt = (x, y) => result.ownerMap.partIds[result.ownerMap.owners[y * 40 + x]];
  assert.equal(ownerAt(12, 34), "leftLeg"); assert.equal(ownerAt(9, 23), "arm");
  assert.equal(ownerAt(16, 10), "eyesOpen"); assert.equal(ownerAt(19, 14), "mouthNeutral");
  assert.ok(![...result.ownerMap.owners].includes(result.ownerMap.partIds.indexOf("eyesClosed")));
  const torso = result.metrics.partDiagnostics.find((part) => part.partId === "torso");
  assert.ok(torso.aiToSourceWidthRatio < .7); assert.ok(torso.aiAlphaBounds && torso.sourceVisibleBounds && torso.aiCenterOffset);
  const actual = await measureRigSourceRegistration(result.document, pixelEnv);
  assert.deepEqual(actual.metrics, result.metrics.after); assert.deepEqual(actual.preview.png, result.preview.png);
  assert.equal(result.document.registration.sourceFingerprint, createHash("sha256").update(imageDataBytes(original.sourceImage).bytes).digest("hex"));
  assert.match(result.document.registration.ownerMapSHA256, /^[a-f0-9]{64}$/);
});

test("neutral eyes belong only to their attachment and closed eyes reveal completed blank head without open-eye ghost", async () => {
  const doc = fixture(), result = await registerRigSourcePixels(doc, {}, pixelEnv), source = await rgba(doc.sourceImage), registered = result.document;
  const head = registered.parts.find((part) => part.id === "head"), open = registered.parts.find((part) => part.id === "eyesOpen");
  const headPixels = await rgba(head.image), openPixels = await rgba(open.image);
  for (const [x, y] of [[16, 10], [23, 10]]) {
    const sourceOffset = (y * 40 + x) * 4, openOffset = ((y - open.y) * open.width + x - open.x) * 4;
    assert.deepEqual([...openPixels.data.subarray(openOffset, openOffset + 4)], [...source.data.subarray(sourceOffset, sourceOffset + 4)]);
    const headOffset = ((y - head.y) * head.width + x - head.x) * 4;
    assert.ok(headPixels.data[headOffset] > 180, "head contains hidden blank skin, not the original dark eye");
    assert.ok(headPixels.data[headOffset + 3] > 0, "AI provides filled skin under the removed eye");
  }
  const closed = { ...registered, defaultAttachments: { ...registered.defaultAttachments, eyes: "eyesClosed" } };
  const closedAssembly = await measureRigSourceRegistration(closed, pixelEnv), pixels = await rgba(closedAssembly.preview.png);
  const center = (10 * 40 + 16) * 4;
  assert.ok(pixels.data[center + 2] > pixels.data[center], "actual attachment replacement draws only the blue closed eye");
  assert.ok(pixels.data[center + 2] > 80);
  const mouth = result.metrics.alignedVariants.find((part) => part.partId === "mouthOpen");
  assert.equal(mouth.aspectRatioPreserved, true); assert.equal(mouth.alignedWidth, mouth.sourceNeutralBounds.width);
  assert.ok(mouth.alignedHeight >= 6, "an open mouth retains its height instead of being compressed into the neutral one-pixel smile");
});

test("252/253-alpha eyes retain hidden skin under transparent closed lines and 250-alpha regions report their real blend error", async () => {
  const doc = fixture(), source = await rgba(doc.sourceImage), canvas = createCanvas(40, 40), context = canvas.getContext("2d"), data = context.createImageData(40, 40);
  data.data.set(source.data);
  for (let y = 5; y < 19; y++) for (let x = 12; x < 28; x++) data.data[(y * 40 + x) * 4 + 3] = 252 + (x + y) % 2;
  for (let x = 17; x < 23; x++) data.data[(14 * 40 + x) * 4 + 3] = 250;
  context.putImageData(data, 0, 0); doc.sourceImage = canvas.toDataURL("image/png");
  const line = createCanvas(10, 3), lineContext = line.getContext("2d");
  lineContext.fillStyle = "#2244cc"; lineContext.fillRect(1, 1, 1, 1); lineContext.fillRect(8, 1, 1, 1);
  doc.parts.find((part) => part.id === "eyesClosed").image = line.toDataURL("image/png");
  const snapshot = structuredClone(doc), result = await registerRigSourcePixels(doc, {}, pixelEnv), head = result.document.parts.find((part) => part.id === "head");
  const headPixels = await rgba(head.image), closed = { ...result.document, defaultAttachments: { ...result.document.defaultAttachments, eyes: "eyesClosed" } };
  const closedPixels = await rgba((await measureRigSourceRegistration(closed, pixelEnv)).preview.png);
  for (let y = 9; y < 12; y++) for (let x = 15; x < 25; x++) {
    const headOffset = ((y - head.y) * head.width + x - head.x) * 4;
    assert.ok(headPixels.data[headOffset + 3] >= 250, `hidden eye skin alpha at ${x},${y}`);
    assert.ok(closedPixels.data[(y * 40 + x) * 4 + 3] >= 250, `closed expression has no hole at ${x},${y}`);
  }
  const iris = (10 * 40 + 17) * 4;
  assert.ok(closedPixels.data[iris] > 180, "transparent gap in the closed line reveals skin, not the original dark iris");
  const unchangedSource = await rgba(doc.sourceImage), output = await rgba(result.preview.png), edge = (7 * 40 + 11) * 4;
  assert.deepEqual([...output.data.subarray(edge, edge + 4)], [...unchangedSource.data.subarray(edge, edge + 4)], "lower-alpha outer edge stays unchanged");
  const open = result.document.parts.find((part) => part.id === "eyesOpen"), openPixels = await rgba(open.image), openIris = ((10 - open.y) * open.width + 17 - open.x) * 4;
  assert.deepEqual([...openPixels.data.subarray(openIris, openIris + 4)], [...unchangedSource.data.subarray(iris, iris + 4)], "visible source eye RGBA is copied directly");
  assert.equal(result.metrics.alphaIoU, 1); assert.equal(result.metrics.missingAlphaPixels, 0); assert.equal(result.metrics.extraAlphaPixels, 0);
  assert.ok(result.metrics.maxAlphaError > 1 && result.metrics.maxAlphaError <= 5);
  assert.ok(result.metrics.maxPremultipliedColorError <= 6); assert.deepEqual(doc, snapshot);
});

test("explicit expansion pads existing AI artwork in world coordinates and preserves pivots, weights and source polygons", async () => {
  const doc = fixture(), torso = doc.parts[0]; torso.x = 14; torso.width = 12;
  const original = validateRigDocument(doc), snapshot = structuredClone(original), inspection = inspectRegistrationBounds(original);
  const required = inspection.parts.find((part) => part.partId === "torso");
  assert.equal(inspection.canApply, false); assert.equal(required.exceedsLimit, true); assert.equal(required.requiredBounds.x, 8);
  await assert.rejects(registerRigSourcePixels(original, {}, pixelEnv), (error) => error.code === "RIG_REGISTRATION_BOUNDS" && error.diagnostics.parts.some((part) => part.partId === "torso"));
  assert.deepEqual(original, snapshot);
  const before = await measureRigSourceRegistration(original, pixelEnv), expanded = await expandRigRegistrationBounds(original, {}, {}, pixelEnv);
  const after = await measureRigSourceRegistration(expanded, pixelEnv);
  assert.deepEqual((await rgba(after.preview.png)).data, (await rgba(before.preview.png)).data);
  assert.deepEqual(expanded.parts[1].mesh.weights, original.parts[1].mesh.weights); assert.deepEqual(expanded.joints, original.joints); assert.deepEqual(expanded.motions, original.motions);
  assert.deepEqual(expanded.parts[0].sourcePolygon, original.parts[0].sourcePolygon);
  assert.equal(expanded.parts[0].registrationBase.image, original.parts[0].image);
  assert.equal(expanded.parts[0].registrationBase.x, original.parts[0].x);
  assert.equal(inspectRegistrationBounds(expanded).canApply, true);
  const armPolygon = polygon(4, 15, 11, 17), withArm = await expandRigRegistrationBounds(fixture(), { arm: armPolygon }, { partIds: ["arm"] }, pixelEnv);
  const arm = withArm.parts.find((part) => part.id === "arm");
  assert.equal(arm.x + arm.grip.primaryLocalPoint.x, 8); assert.equal(arm.y + arm.grip.primaryLocalPoint.y, 20);
  const registered = await registerRigSourcePixels(expanded, {}, pixelEnv);
  assert.equal(registered.metrics.alphaIoU, 1);
});

test("uncovered source pixels and changed fingerprints fail atomically instead of pasting the whole image onto one part", async () => {
  const doc = fixture(), source = await rgba(doc.sourceImage), canvas = createCanvas(40, 40), context = canvas.getContext("2d"), data = context.createImageData(40, 40);
  data.data.set(source.data); data.data.set([20, 30, 40, 254], 0); context.putImageData(data, 0, 0); doc.sourceImage = canvas.toDataURL("image/png");
  const before = structuredClone(doc);
  await assert.rejects(registerRigSourcePixels(doc, {}, pixelEnv), (error) => error.code === "RIG_REGISTRATION_GAP" && error.diagnostics.missingPixels === 1 && error.diagnostics.missingBounds.x === 0);
  assert.deepEqual(doc, before);
  await assert.rejects(registerRigSourcePixels(fixture(), { sourceFingerprint: "0".repeat(64) }, pixelEnv), /原图已改变/);
  const mismatched = fixture(); mismatched.width = 41;
  await assert.rejects(registerRigSourcePixels(mismatched, {}, pixelEnv), /尺寸.*不一致/);
});

test("registration refuses unfinished crops or placeholders and does not upgrade pending alternate artwork", async () => {
  for (const change of [
    (part) => { delete part.image; },
    (part) => { part.imageSource = "placeholder"; },
    (part) => { part.imageSource = "source-crop"; },
    (part) => { part.completion = "needs-inpaint"; },
    (part) => { part.image = createCanvas(20, 20).toDataURL("image/png"); },
  ]) {
    const doc = fixture(); change(doc.parts[0]); const original = structuredClone(doc);
    await assert.rejects(registerRigSourcePixels(doc, {}, pixelEnv), (error) => error.code === "RIG_REGISTRATION_ARTWORK" && error.diagnostics.incompletePartIds.includes("torso"));
    assert.deepEqual(doc, original);
  }
  const doc = fixture(), pending = doc.parts.find((part) => part.id === "eyesClosed");
  pending.imageSource = "source-crop"; pending.completion = "needs-inpaint";
  const result = await registerRigSourcePixels(doc, {}, pixelEnv), restored = result.document.parts.find((part) => part.id === pending.id);
  assert.ok(result.metrics.pendingVariants.includes(pending.id));
  assert.equal(restored.image, pending.image); assert.equal(restored.imageSource, "source-crop"); assert.equal(restored.completion, "needs-inpaint");
});

test("registration metadata and all independent source-locked and alternate images survive real Spine export/re-import", async () => {
  const result = await registerRigSourcePixels(fixture(), {}, pixelEnv), doc = result.document;
  doc.prompts = { registration: "Keep the actual coat and leg silhouette." };
  const files = attachRigAuthoring(await buildRigFiles(doc, pixelEnv), doc), bundle = parseBundle(files);
  const metadataText = new TextDecoder().decode(files[".ispine/rig/document.json"]), metadata = JSON.parse(metadataText);
  assert.ok(!metadataText.includes("base64,"));
  for (const part of metadata.parts) {
    assert.equal(part.registrationBase.image, undefined);
    assert.ok(part.registrationBase.imageFile.path.startsWith(".ispine/rig/registration-base/"));
    assert.deepEqual(files[part.registrationBase.imageFile.path], imageDataBytes(doc.parts.find((item) => item.id === part.id).registrationBase.image).bytes);
  }
  assert.equal(parseSkeleton(bundle).data.animations.length, 1);
  for (const options of [{}, { editable: true }, { target: "unity" }]) {
    const imported = parseBundle(unpackZip(exportPackage(bundle, {}, options))), restored = readRigAuthoring(imported.files);
    assert.deepEqual(restored, doc);
    const measured = await measureRigSourceRegistration(restored, pixelEnv);
    assert.deepEqual(measured.metrics, result.metrics.after); assert.equal(imported.parts.length, doc.parts.length);
  }
  const legacy = fixture(); delete legacy.registration;
  for (const part of legacy.parts) delete part.sourcePolygon;
  assert.equal(validateRigDocument(legacy).registration, undefined);
});

async function withSourcePixels(doc, additions) {
  const original = await rgba(doc.sourceImage), canvas = createCanvas(doc.width, doc.height), context = canvas.getContext("2d"), data = context.createImageData(doc.width, doc.height);
  data.data.set(original.data);
  for (const [x, y, alpha] of additions) data.data.set([180, 80, 220, alpha], (y * doc.width + x) * 4);
  context.putImageData(data, 0, 0); return { ...doc, sourceImage: canvas.toDataURL("image/png") };
}

test("explicit low-alpha padding preserves every outlier and existing mesh geometry without assigning noise to facial groups", async () => {
  const doc = await withSourcePixels(fixture(), [[0, 0, 1], [39, 39, 4], [0, 39, 8], [39, 0, 2]]), snapshot = structuredClone(doc);
  await assert.rejects(registerRigSourcePixels(doc, {}, pixelEnv), (error) => error.code === "RIG_REGISTRATION_GAP" && error.diagnostics.alphaHistogram[1] === 1);
  const coverage = await inspectRigSourceCoverage(doc, pixelEnv);
  assert.equal(coverage.weakPixels, 4); assert.equal(coverage.visiblePixels, 0);
  assert.deepEqual(coverage.alphaHistogram, { 1: 1, 2: 1, 4: 1, 8: 1 });
  const before = await measureRigSourceRegistration(doc, pixelEnv), expanded = await expandRigRegistrationBounds(doc, {}, {}, pixelEnv);
  const after = await measureRigSourceRegistration(expanded, pixelEnv);
  assert.deepEqual((await rgba(after.preview.png)).data, (await rgba(before.preview.png)).data);
  assert.deepEqual(expanded.parts[1], doc.parts[1], "noise must not alter an existing weighted mesh rectangle or weights");
  assert.deepEqual(compileRigSkeleton(expanded).skins[0].attachments.slot_leftLeg, compileRigSkeleton(doc).skins[0].attachments.slot_leftLeg);
  assert.deepEqual(expanded.joints, doc.joints); assert.deepEqual(expanded.motions, doc.motions); assert.equal(expanded.sourceImage, doc.sourceImage);
  assert.equal(expanded.registration.lowAlphaCoverage.retainedPixels, 4);
  assert.equal(expanded.registration.visibleNoise.sourcePixelsDiscarded, 0);
  assert.equal(expanded.registration.visibleNoise.meshBoundsChangedForNoise, false);
  const paddedAgain = await expandRigRegistrationBounds(expanded, {}, {}, pixelEnv);
  assert.equal(paddedAgain.registration.lowAlphaCoverage.addedThisOperation, 0);
  assert.equal(paddedAgain.registration.lowAlphaCoverage.retainedPixels, 4);
  assert.deepEqual(paddedAgain.registration.visibleNoise.alphaHistogram, { 1: 1, 2: 1, 4: 1, 8: 1 });
  const registered = await registerRigSourcePixels(expanded, {}, pixelEnv), assembled = await rgba(registered.preview.png), source = await rgba(doc.sourceImage);
  for (const entry of expanded.registration.lowAlphaCoverage.assignments) {
    const part = registered.document.parts.find((item) => item.id === entry.partId);
    assert.equal(part.binding, "rigid"); assert.equal(part.attachmentGroup, undefined);
    for (const index of entry.pixelIndices) {
      assert.equal(registered.ownerMap.partIds[registered.ownerMap.owners[index]], entry.partId);
      assert.deepEqual([...assembled.data.subarray(index * 4, index * 4 + 4)], [...source.data.subarray(index * 4, index * 4 + 4)]);
    }
  }
  assert.equal(registered.metrics.alphaIoU, 1); assert.equal(registered.metrics.extraAlphaPixels, 0); assert.equal(registered.metrics.missingAlphaPixels, 0);
  assert.equal(registered.metrics.weakPixelAssignments, 4); assert.equal(registered.metrics.weakPixelOwnerPolicy, "nearest-rigid");
  assert.deepEqual(doc, snapshot);
});

test("weak-pixel padding rejects a visible source gap or the absence of a rigid physical owner", async () => {
  const visible = await withSourcePixels(fixture(), [[0, 0, 9]]), snapshot = structuredClone(visible);
  await assert.rejects(expandRigRegistrationBounds(visible, {}, {}, pixelEnv), (error) => error.code === "RIG_REGISTRATION_VISIBLE_GAP" && error.diagnostics.visiblePixels === 1);
  assert.deepEqual(visible, snapshot);
  const meshes = await withSourcePixels(fixture(), [[0, 0, 1]]);
  for (const part of meshes.parts) if (!part.attachmentGroup) { part.binding = "mesh"; delete part.grip; }
  await assert.rejects(expandRigRegistrationBounds(meshes, {}, {}, pixelEnv), (error) => error.code === "RIG_REGISTRATION_NO_RIGID_OWNER");
});

test("weak outliers remain in coverage bounds while visible size, calibration ratios and expression alignment stay unchanged", async () => {
  const baseline = await registerRigSourcePixels(fixture(), {}, pixelEnv), noisy = await withSourcePixels(fixture(), [[0, 0, 1]]);
  const expanded = await expandRigRegistrationBounds(noisy, {}, {}, pixelEnv), result = await registerRigSourcePixels(expanded, {}, pixelEnv);
  const expected = baseline.metrics.partDiagnostics.find((part) => part.partId === "head"), actual = result.metrics.partDiagnostics.find((part) => part.partId === "head");
  assert.equal(actual.sourceAllAlphaBounds.x, 0);
  assert.ok(actual.sourceAllAlphaBounds.width > actual.sourceVisibleBounds.width);
  assert.deepEqual(actual.sourceVisibleBounds, expected.sourceVisibleBounds);
  assert.equal(actual.aiToSourceWidthRatio, expected.aiToSourceWidthRatio);
  assert.equal(actual.aiToSourceHeightRatio, expected.aiToSourceHeightRatio);
  assert.deepEqual(actual.aiCenterOffset, expected.aiCenterOffset);
  assert.deepEqual(result.metrics.alignedVariants, baseline.metrics.alignedVariants);
  assert.equal(result.metrics.alphaIoU, 1); assert.equal(result.metrics.missingAlphaPixels, 0);
  const pixels = await rgba(result.preview.png), source = await rgba(noisy.sourceImage);
  assert.deepEqual([...pixels.data.subarray(0, 4)], [...source.data.subarray(0, 4)]);
});

test("changing masks A to B uses the immutable independent underlay and matches registering fresh B", async () => {
  const original = fixture(), a = { arm: polygon(5, 15, 7, 17) }, b = { arm: polygon(5, 15, 10, 17) };
  const first = await registerRigSourcePixels(original, { polygons: a }, pixelEnv), repeated = await registerRigSourcePixels(first.document, { polygons: b }, pixelEnv), fresh = await registerRigSourcePixels(original, { polygons: b }, pixelEnv);
  const torsoA = first.document.parts.find((part) => part.id === "torso"), torsoB = repeated.document.parts.find((part) => part.id === "torso"), expected = fresh.document.parts.find((part) => part.id === "torso");
  const at = (part, pixels) => [...pixels.data.subarray(((23 - part.y) * part.width + 14 - part.x) * 4, ((23 - part.y) * part.width + 14 - part.x) * 4 + 4)];
  assert.notDeepEqual(at(torsoA, await rgba(torsoA.image)), at(expected, await rgba(expected.image)));
  assert.deepEqual(at(torsoB, await rgba(torsoB.image)), at(expected, await rgba(expected.image)));
  for (const part of repeated.document.parts) assert.equal(part.image, fresh.document.parts.find((item) => item.id === part.id).image, part.id);
  assert.equal(torsoB.registrationBase.image, original.parts[0].image);
  const edited = structuredClone(first.document), newImage = image(24, 18, "#00ff00");
  edited.parts[0].image = newImage; edited.parts[0].imageSource = "calibrated";
  const manual = await registerRigSourcePixels(edited, { polygons: b }, pixelEnv), manualTorso = manual.document.parts[0];
  assert.equal(manualTorso.registrationBase.image, newImage);
  const green = at(manualTorso, await rgba(manualTorso.image)); assert.ok(green[1] > 240 && green[0] < 10);
});

test("an empty owned and hidden layer is rejected even when the assembled image would match the source", async () => {
  const doc = fixture(), empty = { ...doc.parts[0], id: "emptyLayer", label: "Empty layer", x: 0, y: 0, width: 2, height: 2, z: -10, sourcePolygon: polygon(0, 0, 2, 2), image: image(2, 2, "#00ff00") };
  doc.parts.push(empty); const snapshot = structuredClone(doc);
  await assert.rejects(registerRigSourcePixels(doc, {}, pixelEnv), (error) => error.code === "RIG_REGISTRATION_EMPTY_PART" && error.diagnostics.parts.some((part) => part.partId === "emptyLayer" && part.visibleLockedPixels === 0 && part.visibleHiddenPixels === 0));
  assert.deepEqual(doc, snapshot);
});

test("source polygon and registration schema reject invalid coordinate or fake metric data", () => {
  const invalid = (change) => { const doc = fixture(); change(doc); assert.throws(() => validateRigDocument(doc)); };
  invalid((doc) => { doc.parts[0].sourcePolygon = [{ x: 0, y: 0 }, { x: 10, y: 10 }]; });
  invalid((doc) => { doc.parts[0].sourcePolygon[0].x = -1; });
  invalid((doc) => { doc.parts[0].sourcePolygon[0].x = NaN; });
  invalid((doc) => { doc.parts[0].sourcePolygon = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]; });
  invalid((doc) => { doc.registration = { metrics: { alphaIoU: Infinity } }; });
  invalid((doc) => { doc.registration = { sourceFingerprint: "fake" }; });
  invalid((doc) => { doc.registration = { metrics: { image: doc.sourceImage } }; });
});

function completeFixture() {
  const doc = fixture();
  for (const part of doc.parts) {
    const x = Math.floor(part.x), y = Math.floor(part.y), width = Math.ceil(part.x + part.width) - x, height = Math.ceil(part.y + part.height) - y;
    Object.assign(part, { x, y, width, height });
    const canvas = createCanvas(width, height), context = canvas.getContext("2d");
    context.fillStyle = part.id === "head" ? "#f5c8a0" : part.id === "arm" ? "#dd5566" : part.id.includes("eyes") ? "#2244cc" : "#553399";
    context.fillRect(0, 0, width, height); context.clearRect(width - 1, height - 1, 1, 1);
    part.image = canvas.toDataURL("image/png");
  }
  // Deliberately omit one original eye from the eye mask. The blank-face guard
  // must retain skin throughout the facial attachment rectangle, not paste it
  // into the head simply because the fallback head polygon contains it.
  doc.parts.find((part) => part.id === "eyesOpen").sourcePolygon = polygon(15, 10, 3, 1);
  return validateRigDocument(doc);
}
function approveComplete(prepared) {
  return { sourceFingerprint: prepared.sourceFingerprint, geometryFingerprint: prepared.geometryFingerprint,
    parts: prepared.parts.map((part) => ({ partId: part.partId, imageSHA256: part.imageSHA256, approved: true,
      hiddenReviewed: true, isolationReviewed: true, sourceMaskReviewed: true, sourceLock: part.sourceLock, ...(part.requiresBlankFace ? { blankFace: true } : {}) })) };
}
async function worldPixels(part) {
  const bitmap = await loadImage(Buffer.from(imageDataBytes(part.image).bytes)), canvas = createCanvas(40, 40);
  canvas.getContext("2d").drawImage(bitmap, part.x, part.y, part.width, part.height);
  return canvas.getContext("2d").getImageData(0, 0, 40, 40).data;
}
async function worldPixel(part, x, y) {
  const data = await worldPixels(part), offset = (y * 40 + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

test("complete-overlap review presents immutable full underlays and never approves or modifies the source document", async () => {
  const original = completeFixture(), exclusive = await registerRigSourcePixels(original, {}, pixelEnv), snapshot = structuredClone(exclusive.document);
  const prepared = await prepareCompleteOverlapReview(exclusive.document, pixelEnv);
  assert.deepEqual(exclusive.document, snapshot); assert.equal(prepared.ready, true); assert.deepEqual(prepared.issues, []);
  assert.equal(prepared.parts.length, original.parts.length); assert.match(prepared.sourceFingerprint, /^[a-f0-9]{64}$/); assert.match(prepared.geometryFingerprint, /^[a-f0-9]{64}$/);
  for (const part of prepared.parts) {
    const source = original.parts.find((item) => item.id === part.partId);
    assert.equal(part.image, source.image, part.partId);
    assert.equal(part.imageSHA256, createHash("sha256").update(imageDataBytes(source.image).bytes).digest("hex"));
    assert.equal(part.baseSource, "registration-base"); assert.equal(part.approved, undefined);
    assert.ok(part.alpha.significantPixels > 0 && part.alpha.transparentPixels > 0);
  }
  assert.equal(prepared.parts.find((part) => part.partId === "head").requiresBlankFace, true);
  assert.equal(prepared.parts.find((part) => part.partId === "head").sourceLock, "underlay-only");
  assert.equal(prepared.parts.find((part) => part.partId === "eyesOpen").sourceLockForced, true);
  assert.equal(prepared.parts.find((part) => part.partId === "arm").sourceLock, "known-source");
  assert.equal(prepared.parts.find((part) => part.partId === "arm").sourceLockForced, false);
  assert.equal(prepared.parts.find((part) => part.partId === "eyesClosed").defaultVisible, false);
  const withHair = structuredClone(original);
  withHair.parts.push({ ...structuredClone(withHair.parts.find((part) => part.id === "head")), id: "frontHair", label: "前发与头发cap" });
  const hairReview = await prepareCompleteOverlapReview(withHair, pixelEnv);
  assert.equal(hairReview.parts.find((part) => part.partId === "frontHair").requiresBlankFace, false, "sharing the head bone does not make hair a blank face");
  assert.equal(hairReview.parts.find((part) => part.partId === "frontHair").sourceLock, "known-source");
  assert.equal(hairReview.parts.find((part) => part.partId === "frontHair").sourceLockForced, false);
});

test("complete-overlap restores full support and blank skin without deleting joint art or resurrecting source eyes", async () => {
  const original = completeFixture(), exclusive = await registerRigSourcePixels(original, {}, pixelEnv), snapshot = structuredClone(exclusive.document);
  const prepared = await prepareCompleteOverlapReview(exclusive.document, pixelEnv), review = approveComplete(prepared);
  const result = await registerRigSourcePixels(exclusive.document, { mode: "complete-overlap", review }, pixelEnv), next = result.document;
  assert.deepEqual(exclusive.document, snapshot); assert.deepEqual(next.joints, original.joints); assert.deepEqual(next.motions, original.motions);
  assert.deepEqual(next.defaultAttachments, original.defaultAttachments); assert.equal(next.parts.length, original.parts.length);
  assert.deepEqual(next.parts[1].mesh, original.parts[1].mesh); assert.deepEqual(next.parts[4].grip, original.parts[4].grip);
  assert.deepEqual(compileRigSkeleton(next), compileRigSkeleton(exclusive.document), "complete-art registration changes texture pixels without rewriting existing runtime binding, skin groups or continuous animation timelines");
  const head = next.parts.find((part) => part.id === "head");
  assert.equal((await worldPixel(exclusive.document.parts.find((part) => part.id === "head"), 12, 4))[3], 0);
  assert.deepEqual(await worldPixel(head, 12, 4), await worldPixel(original.parts.find((part) => part.id === "head"), 12, 4), "real full-head edge erased by exclusive ownership is restored");
  for (const [x, y] of [[16, 10], [23, 10], [19, 14]]) {
    const pixel = await worldPixel(head, x, y); assert.ok(pixel[0] > 220 && pixel[1] > 170 && pixel[3] === 255, `blank skin at ${x},${y}`);
  }
  assert.deepEqual(await worldPixels(head), await worldPixels(original.parts.find((part) => part.id === "head")), "the entire independent blank face remains intact, not just facial rectangles");
  const torso = next.parts.find((part) => part.id === "torso"), oldTorso = original.parts.find((part) => part.id === "torso");
  assert.deepEqual(await worldPixel(torso, 10, 23), await worldPixel(oldTorso, 10, 23), "independent hidden shoulder remains behind the red arm");
  const source = await rgba(original.sourceImage), actual = await worldPixel(next.parts.find((part) => part.id === "arm"), 6, 16), offset = (16 * 40 + 6) * 4;
  assert.deepEqual(actual, [...source.data.subarray(offset, offset + 4)], "known source-owned RGBA is still locked exactly");
  for (const id of ["eyesClosed", "mouthOpen"]) {
    const before = original.parts.find((part) => part.id === id), current = exclusive.document.parts.find((part) => part.id === id), after = next.parts.find((part) => part.id === id);
    assert.deepEqual({ x: after.x, y: after.y, width: after.width, height: after.height }, { x: current.x, y: current.y, width: current.width, height: current.height }, "existing padded geometry is preserved");
    assert.deepEqual(await worldPixels(after), await worldPixels(before), "inactive expression retains independent world pixels instead of being resized to the neutral alpha box");
  }
  for (const id of ["head", "eyesOpen", "eyesClosed", "mouthNeutral", "mouthOpen"]) {
    const part = next.parts.find((part) => part.id === id), report = result.metrics.completeOverlap.parts.find((part) => part.partId === id);
    assert.equal(part.registration.lockedPixels, 0); assert.equal(part.registration.visibleLockedPixels, 0);
    assert.equal(report.lockedPixels, 0); assert.equal(report.sourceLockPolicy, "disabled-preserve-independent-facial-underlay");
  }
  assert.deepEqual(result.metrics.alignedVariants, []); assert.ok(result.metrics.completeOverlap.preservedPixels > 0);
  assert.ok(result.metrics.completeOverlap.protectedFacePixels > 0); assert.ok(result.metrics.completeOverlap.retainedOutsideSourcePixels > 0);
  assert.ok(result.metrics.extraAlphaPixels > 0 && result.metrics.alphaIoU < 1, "actual setup disagreement remains visible rather than forcing IoU=1 by deleting art");
  assert.equal(result.metrics.completeOverlap.runtimeMotionVerification, "not-evaluated"); assert.equal(result.metrics.completeOverlap.requiresVisualReview, true);
  assert.equal(next.registration.mode, "complete-overlap");
  assert.deepEqual({ ...next.registration.completeOverlapReview, parts: next.registration.completeOverlapReview.parts.map(({ rect, ...part }) => part) }, review);
  for (const part of next.registration.completeOverlapReview.parts) assert.deepEqual(part.rect, prepared.parts.find((item) => item.partId === part.partId).rect);
});

test("complete face and active facial attachments retain all native RGBA and sparse alpha without skin halos", async () => {
  const doc = completeFixture(), head = doc.parts.find((part) => part.id === "head"), face = createCanvas(head.width, head.height), faceContext = face.getContext("2d");
  for (let row = 0; row < head.height; row++) {
    faceContext.fillStyle = `rgb(${230 + row},${130 + row * 2},${110 + row * 3})`; faceContext.fillRect(0, row, head.width, 1);
  }
  faceContext.clearRect(head.width - 1, head.height - 1, 1, 1); head.image = face.toDataURL("image/png");
  for (const part of doc.parts.filter((part) => part.attachmentGroup)) {
    const canvas = createCanvas(part.width, part.height), context = canvas.getContext("2d");
    context.fillStyle = "#136ce8"; context.fillRect(1, Math.floor(part.height / 2), Math.max(1, part.width - 3), 1);
    part.image = canvas.toDataURL("image/png"); part.sourcePolygon = polygon(part.x, part.y, part.width, part.height);
  }
  const snapshot = structuredClone(doc), review = approveComplete(await prepareCompleteOverlapReview(doc, pixelEnv));
  const result = await registerRigSourcePixels(doc, { mode: "complete-overlap", review }, pixelEnv);
  for (const part of doc.parts.filter((part) => part.id === "head" || part.attachmentGroup)) {
    const after = result.document.parts.find((item) => item.id === part.id);
    assert.deepEqual(await worldPixels(after), await worldPixels(part), `${part.id}: no source skin patch, iris, hair or mouth pixel may replace native underlay RGBA`);
    assert.deepEqual({ x: after.x, y: after.y, width: after.width, height: after.height }, { x: part.x, y: part.y, width: part.width, height: part.height });
    const metrics = result.metrics.completeOverlap.parts.find((item) => item.partId === part.id);
    assert.equal(metrics.lockedPixels, 0); assert.equal(metrics.visibleLockedPixels, 0);
    assert.equal(after.registration.sourceLockPolicy, "disabled-preserve-independent-facial-underlay");
    if (part.attachmentGroup) assert.equal(metrics.facialAttachment, true);
  }
  const source = await rgba(doc.sourceImage), arm = result.document.parts.find((part) => part.id === "arm"), sourceOffset = (16 * 40 + 6) * 4;
  assert.deepEqual(await worldPixel(arm, 6, 16), [...source.data.subarray(sourceOffset, sourceOffset + 4)], "body source-locking remains exact");
  assert.ok(arm.registration.lockedPixels > 0);
  assert.equal(result.metrics.completeOverlap.faceSourceLockPolicy, "disabled-preserve-complete-blank-face-and-independent-facial-attachments");
  assert.ok(result.metrics.pixelMAE > 0, "the honest composition error is retained instead of painting source skin to force agreement");
  assert.deepEqual(doc, snapshot);
});

test("complete-overlap reports nearest fallback as unassigned and leaves independent pixels untouched there", async () => {
  const doc = completeFixture(); doc.parts.find((part) => part.id === "arm").sourcePolygon = polygon(5, 15, 3, 3);
  const prepared = await prepareCompleteOverlapReview(doc, pixelEnv), result = await registerRigSourcePixels(doc, { mode: "complete-overlap", review: approveComplete(prepared) }, pixelEnv);
  const arm = result.document.parts.find((part) => part.id === "arm"), original = doc.parts.find((part) => part.id === "arm");
  assert.deepEqual(await worldPixel(arm, 6, 29), await worldPixel(original, 6, 29));
  assert.ok(result.metrics.completeOverlap.unassignedSourcePixels > 0); assert.ok(result.metrics.completeOverlap.fallbackPixels > 0);
  assert.ok(result.metrics.completeOverlap.parts.find((part) => part.partId === "arm").fallbackOwnedPixels > 0);
  assert.equal(result.metrics.completeOverlap.fallbackPolicy, "reported-not-copied");
  assert.equal(result.metrics.completeOverlap.knownOwnerPixels + result.metrics.completeOverlap.unassignedSourcePixels, result.metrics.sourcePixels);
  const overlay = await rgba(result.ownerMap.png), unknown = (29 * 40 + 6) * 4;
  assert.equal(result.ownerMap.policy, "reviewed-source-only"); assert.equal(result.ownerMap.knownOwners[29 * 40 + 6], 0);
  assert.equal(overlay.data[unknown + 3], 0, "unproven nearest fallback is not colored as known source ownership");
});

test("complete-overlap requires every exact source, geometry and underlay review; motions alone do not expire artwork review", async () => {
  const doc = completeFixture(), snapshot = structuredClone(doc), prepared = await prepareCompleteOverlapReview(doc, pixelEnv), review = approveComplete(prepared);
  for (const mutate of [
    (r) => { r.sourceFingerprint = "0".repeat(64); }, (r) => { r.geometryFingerprint = "0".repeat(64); },
    (r) => { r.parts[0].imageSHA256 = "0".repeat(64); }, (r) => { r.parts[0].approved = false; },
    (r) => { r.parts[0].hiddenReviewed = false; }, (r) => { r.parts[0].isolationReviewed = false; }, (r) => { r.parts[0].sourceMaskReviewed = false; },
    (r) => { delete r.parts.find((part) => part.partId === "head").blankFace; }, (r) => { r.parts.pop(); },
    (r) => { r.parts[1] = r.parts[0]; },
  ]) {
    const invalid = structuredClone(review); mutate(invalid);
    await assert.rejects(registerRigSourcePixels(doc, { mode: "complete-overlap", review: invalid }, pixelEnv), (error) => error.code === "RIG_REGISTRATION_COMPLETE_REVIEW");
  }
  await assert.rejects(registerRigSourcePixels(doc, { mode: "complete-overlap" }, pixelEnv), /重新审阅/);
  for (const mutate of [
    (d) => { d.joints[2].x += .25; }, (d) => { d.parts[0].z -= 1; }, (d) => { d.parts[0].width -= .25; },
    (d) => { d.parts[0].sourcePolygon[0].x += .25; }, (d) => { d.parts[4].grip.primaryLocalPoint.x += .25; },
    (d) => { d.parts[1].influences.push("head"); d.parts[1].mesh.weights[0] = [{ joint: "root", weight: .5 }, { joint: "head", weight: .5 }]; },
    (d) => { d.defaultAttachments.eyes = "eyesClosed"; },
    (d) => { d.parts[0].image = image(24, 18, "#00ff00", true); },
  ]) {
    const changed = structuredClone(doc); mutate(changed);
    await assert.rejects(registerRigSourcePixels(changed, { mode: "complete-overlap", review }, pixelEnv), (error) => error.code === "RIG_REGISTRATION_COMPLETE_REVIEW");
  }
  const changedSource = await withSourcePixels(doc, [[20, 20, 240]]);
  await assert.rejects(registerRigSourcePixels(changedSource, { mode: "complete-overlap", review }, pixelEnv), /重新审阅/);
  const changedMotion = structuredClone(doc); changedMotion.motions[0].poses[0].angles = { head: 3 };
  assert.equal((await prepareCompleteOverlapReview(changedMotion, pixelEnv)).geometryFingerprint, prepared.geometryFingerprint);
  await registerRigSourcePixels(changedMotion, { mode: "complete-overlap", review }, pixelEnv); assert.deepEqual(doc, snapshot);
});

test("complete-overlap rejects crops, pending variants, opaque or empty art instead of laundering them as complete", async () => {
  for (const mutate of [
    (d) => { d.parts[6].completion = "needs-inpaint"; }, (d) => { d.parts[6].imageSource = "source-crop"; },
    (d) => { d.parts[6].image = createCanvas(10, 3).toDataURL("image/png"); },
    (d) => { d.parts[6].image = image(10, 3, "#00ff00"); },
  ]) {
    const doc = completeFixture(); mutate(doc); const snapshot = structuredClone(doc), prepared = await prepareCompleteOverlapReview(doc, pixelEnv);
    assert.equal(prepared.ready, false); assert.ok(prepared.parts.find((part) => part.partId === "eyesClosed").issues.length > 0);
    await assert.rejects(registerRigSourcePixels(doc, { mode: "complete-overlap", review: approveComplete(prepared) }, pixelEnv), (error) => error.code === "RIG_REGISTRATION_COMPLETE_REVIEW");
    assert.deepEqual(doc, snapshot);
  }
  const visibleOnly = completeFixture(); visibleOnly.parts[6].imageSource = "source-visible";
  await assert.rejects(prepareCompleteOverlapReview(visibleOnly, pixelEnv), /图像来源无效/);
});

test("complete-overlap repeats from immutable art and survives all real archive variants with honest composition metrics", async () => {
  const doc = completeFixture(), first = await registerRigSourcePixels(doc, { mode: "complete-overlap", review: approveComplete(await prepareCompleteOverlapReview(doc, pixelEnv)) }, pixelEnv);
  const nextReview = approveComplete(await prepareCompleteOverlapReview(first.document, pixelEnv));
  const repeated = await registerRigSourcePixels(first.document, { mode: "complete-overlap", review: nextReview }, pixelEnv);
  for (const part of first.document.parts) assert.equal(part.image, repeated.document.parts.find((item) => item.id === part.id).image, part.id);
  assert.deepEqual(first.metrics.after, repeated.metrics.after);
  const bundle = parseBundle(attachRigAuthoring(await buildRigFiles(first.document, pixelEnv), first.document));
  for (const options of [{}, { editable: true }, { target: "unity" }]) {
    const imported = parseBundle(unpackZip(exportPackage(bundle, {}, options))), restored = readRigAuthoring(imported.files);
    assert.deepEqual(restored.registration.completeOverlapReview, first.document.registration.completeOverlapReview);
    assert.equal(restored.registration.mode, "complete-overlap");
    for (const part of first.document.parts) assert.equal(restored.parts.find((item) => item.id === part.id).image, part.image);
    assert.deepEqual((await measureRigSourceRegistration(restored, pixelEnv)).metrics, first.metrics.after);
    assert.equal(parseSkeleton(imported).data.animations.length, 1);
  }
  const exclusive = await registerRigSourcePixels(first.document, { mode: "exclusive" }, pixelEnv);
  assert.equal(exclusive.document.registration.mode, undefined); assert.equal(exclusive.document.registration.completeOverlapReview, undefined);
  assert.equal(exclusive.metrics.completeOverlap, undefined);
  for (const part of exclusive.document.parts) assert.equal(part.registration?.mode, undefined);
});

test("a reviewed per-part underlay-only policy preserves exact full pixels while other body parts keep source locking", async () => {
  const doc = completeFixture(), snapshot = structuredClone(doc), prepared = await prepareCompleteOverlapReview(doc, pixelEnv), review = approveComplete(prepared);
  review.parts.find((part) => part.partId === "arm").sourceLock = "underlay-only";
  const result = await registerRigSourcePixels(doc, { mode: "complete-overlap", review }, pixelEnv), arm = result.document.parts.find((part) => part.id === "arm");
  assert.deepEqual(await worldPixels(arm), await worldPixels(doc.parts.find((part) => part.id === "arm")), "the generic policy preserves the independent image without hue rules or new ownership");
  assert.equal(arm.registration.lockedPixels, 0); assert.equal(arm.registration.visibleLockedPixels, 0);
  assert.equal(arm.registration.sourceLock, "underlay-only"); assert.equal(arm.registration.sourceLockPolicy, "disabled-preserve-independent-underlay");
  assert.ok(arm.registration.policySuppressedPixels > 0);
  const armReport = result.metrics.completeOverlap.parts.find((part) => part.partId === "arm");
  assert.equal(armReport.lockedPixels, 0); assert.equal(armReport.sourceLock, "underlay-only");
  assert.ok(result.metrics.completeOverlap.underlayOnlyPartIds.includes("arm")); assert.ok(!result.metrics.completeOverlap.knownSourcePartIds.includes("arm"));
  const torso = result.document.parts.find((part) => part.id === "torso"), source = await rgba(doc.sourceImage), offset = (22 * 40 + 20) * 4;
  assert.deepEqual(await worldPixel(torso, 20, 22), [...source.data.subarray(offset, offset + 4)]);
  assert.ok(torso.registration.lockedPixels > 0); assert.equal(torso.registration.sourceLock, "known-source");
  assert.deepEqual(compileRigSkeleton(result.document), compileRigSkeleton(doc)); assert.deepEqual(doc, snapshot);
  const storedReview = result.document.registration.completeOverlapReview.parts.find((part) => part.partId === "arm");
  assert.equal(storedReview.sourceLock, "underlay-only");
  const nextPreparation = await prepareCompleteOverlapReview(result.document, pixelEnv), recommendation = nextPreparation.parts.find((part) => part.partId === "arm");
  assert.equal(recommendation.sourceLock, "underlay-only"); assert.equal(recommendation.sourceLockForced, false); assert.equal(recommendation.approved, undefined, "a remembered art policy does not approve a new review");
  const bundle = parseBundle(attachRigAuthoring(await buildRigFiles(result.document, pixelEnv), result.document));
  for (const options of [{}, { editable: true }, { target: "unity" }]) {
    const restored = readRigAuthoring(parseBundle(unpackZip(exportPackage(bundle, {}, options))).files);
    assert.equal(restored.registration.completeOverlapReview.parts.find((part) => part.partId === "arm").sourceLock, "underlay-only");
    assert.equal((await prepareCompleteOverlapReview(restored, pixelEnv)).parts.find((part) => part.partId === "arm").sourceLock, "underlay-only");
    assert.deepEqual(await worldPixels(restored.parts.find((part) => part.id === "arm")), await worldPixels(arm));
  }
});

test("per-part policies normalize old reviews, reject unknown choices and cannot enable source copying into face or bypass review gates", async () => {
  const doc = completeFixture(), prepared = await prepareCompleteOverlapReview(doc, pixelEnv), review = approveComplete(prepared);
  const malformedHistory = structuredClone(doc); malformedHistory.registration = { completeOverlapReview: { parts: {} } };
  const freshPreparation = await prepareCompleteOverlapReview(malformedHistory, pixelEnv);
  assert.equal(freshPreparation.parts.find((part) => part.partId === "arm").sourceLock, "known-source");
  assert.equal(freshPreparation.parts.find((part) => part.partId === "head").sourceLock, "underlay-only");
  const legacyReview = structuredClone(review); for (const part of legacyReview.parts) delete part.sourceLock;
  const result = await registerRigSourcePixels(doc, { mode: "complete-overlap", review: legacyReview }, pixelEnv);
  for (const part of result.document.registration.completeOverlapReview.parts)
    assert.equal(part.sourceLock, prepared.parts.find((item) => item.partId === part.partId).sourceLockForced ? "underlay-only" : "known-source");
  for (const [id, choice] of [["arm", "auto"], ["arm", "nearest"], ["arm", null], ["head", "known-source"], ["eyesOpen", "known-source"], ["eyesClosed", "known-source"], ["mouthOpen", "known-source"]]) {
    const invalid = structuredClone(review); invalid.parts.find((part) => part.partId === id).sourceLock = choice;
    await assert.rejects(registerRigSourcePixels(doc, { mode: "complete-overlap", review: invalid }, pixelEnv), (error) => error.code === "RIG_REGISTRATION_COMPLETE_REVIEW");
  }
  const underlayReview = structuredClone(review); underlayReview.parts.find((part) => part.partId === "arm").sourceLock = "underlay-only";
  for (const flag of ["approved", "hiddenReviewed", "isolationReviewed", "sourceMaskReviewed"]) {
    const invalid = structuredClone(underlayReview); invalid.parts.find((part) => part.partId === "arm")[flag] = false;
    await assert.rejects(registerRigSourcePixels(doc, { mode: "complete-overlap", review: invalid }, pixelEnv), (error) => error.code === "RIG_REGISTRATION_COMPLETE_REVIEW");
  }
  const changed = structuredClone(doc); changed.parts.find((part) => part.id === "arm").image = image(10, 17, "#00ccff", true);
  await assert.rejects(registerRigSourcePixels(changed, { mode: "complete-overlap", review: underlayReview }, pixelEnv), (error) => error.code === "RIG_REGISTRATION_COMPLETE_REVIEW");
});

test("underlay-only avoids source-owner padding and reports every intentionally suppressed known pixel", async () => {
  const doc = completeFixture(), originalArm = doc.parts.find((part) => part.id === "arm"); originalArm.sourcePolygon = polygon(5, 15, 12, 17);
  const review = approveComplete(await prepareCompleteOverlapReview(doc, pixelEnv)), known = await registerRigSourcePixels(doc, { mode: "complete-overlap", review }, pixelEnv);
  const knownArm = known.document.parts.find((part) => part.id === "arm"); assert.ok(knownArm.width > originalArm.width, "known source ownership exercises the allowed two-pixel padding path");
  review.parts.find((part) => part.partId === "arm").sourceLock = "underlay-only";
  const pure = await registerRigSourcePixels(doc, { mode: "complete-overlap", review }, pixelEnv), pureArm = pure.document.parts.find((part) => part.id === "arm");
  assert.deepEqual({ x: pureArm.x, y: pureArm.y, width: pureArm.width, height: pureArm.height }, { x: originalArm.x, y: originalArm.y, width: originalArm.width, height: originalArm.height });
  assert.deepEqual(await worldPixels(pureArm), await worldPixels(originalArm));
  assert.equal(pureArm.registration.policySuppressedPixels, knownArm.registration.lockedPixels, "source-owned pixels outside the retained underlay rectangle are also counted as intentionally unlocked");
  assert.equal(pureArm.registration.lockedPixels, 0); assert.equal(pure.metrics.completeOverlap.sourceLockPolicy, "per-part-reviewed-source-or-underlay-only");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { buildRigFiles, createHumanoidDraft } from "../src/infrastructure/rig-authoring.js";
import { parseBundle } from "../src/infrastructure/archive-files.js";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";
import { compilePages, extractPart } from "../src/infrastructure/calibration.js";
import { identityTransform } from "../engine/images/calibration.js";
import { attachRigAuthoring, readRigAuthoring } from "../engine/archive/rig-project.js";
import { hasRigAuthoring, rigAuthoringSummary, RIG_DOCUMENT_PATH } from "../shared/domain/rig-summary.mjs";
import { imageDataBytes, imageDataURL } from "../shared/codec/image-data.mjs";
import { rigWithCalibratedParts, synchronizeRigAuthoring } from "../src/infrastructure/rig-project.js";
import { validateRigDocument } from "../shared/rig-schema.mjs";
import { getMotionStudyFingerprints, motionStudyRegionName } from "../shared/domain/motion-study.mjs";
import { prepareMotionStudyFrames, applyMotionStudy } from "../src/infrastructure/motion-study-images.js";

const env = { createCanvas, loadImage: (value) => loadImage(typeof value === "string" ? value : Buffer.from(value)),
  encode: async (canvas) => new Uint8Array(canvas.toBuffer("image/png")) };
function artwork(color = "#7047df") {
  const canvas = createCanvas(48, 64), context = canvas.getContext("2d");
  context.fillStyle = color; context.fillRect(5, 9, 24, 38);
  context.fillStyle = "#ffb854"; context.fillRect(12, 19, 27, 15);
  return canvas.toDataURL("image/png");
}
async function fixture() {
  const document = createHumanoidDraft({ id: "rig-authoring-test", name: "Authoring test", width: 160, height: 220, sourceImage: artwork() });
  for (const part of document.parts) { part.image = artwork(); part.imageSource = "uploaded"; part.completion = "ready"; }
  const files = await buildRigFiles(document, env);
  const bundle = parseBundle(attachRigAuthoring(files, document), { name: document.name });
  return { document, bundle };
}
const pixels = (canvas) => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;

async function pagedSyncFixture() {
  const rectangles = Array.from({ length: 6 }, (_, index) => ({ id: `piece_${index}`, x: 2 + index % 3 * 10, y: 3 + Math.floor(index / 3) * 12, width: 6, height: 6 }));
  const picture = (offset = 0) => {
    const canvas = createCanvas(32, 32), context = canvas.getContext("2d");
    for (const [index, rect] of rectangles.entries()) { context.fillStyle = `hsl(${index * 55 + offset * 11},70%,55%)`; context.fillRect(rect.x + offset, rect.y, 6, 6); }
    return canvas.toDataURL("image/png");
  };
  const source = picture(), joints = [{ id: "root", parent: null, x: 16, y: 30 }, { id: "top", parent: "root", x: 16, y: 10 }];
  let document = validateRigDocument({ version: 1, id: "paged-sync", name: "Synthetic page synchronization", width: 32, height: 32, sourceImage: source, joints,
    parts: await Promise.all(rectangles.map(async (rect, index) => {
      const canvas = createCanvas(6, 6), context = canvas.getContext("2d"); context.fillStyle = `hsl(${index * 55},70%,55%)`; context.fillRect(0, 0, 6, 6);
      return { ...rect, label: rect.id, bone: "top", binding: "rigid", influences: ["top"], z: index, image: canvas.toDataURL("image/png"), imageSource: "uploaded", completion: "ready" };
    })), motions: ["idle", "attack"].map((id) => ({ id, name: id, duration: 1, loop: id === "idle", poses: [{ time: 0 }, { time: 1 }] })) });
  const frames = [0, 1].map((offset) => {
    const image = offset ? picture(offset) : source, id = offset ? "strike" : "base", sourceFingerprint = createHash("sha256").update(imageDataBytes(image).bytes).digest("hex");
    return { id, time: offset, image, sourceFingerprint, origin: offset ? "ai-motion-frame" : "base", review: { approved: true }, mappingReview: { approved: true },
      mapping: { frameId: id, sourceFingerprint, joints: joints.map(({ id, x, y }) => ({ id, x: x + offset, y })), parts: rectangles.map((rect, index) => ({ partId: rect.id, visible: true, z: index,
        sourcePolygon: [{ x: rect.x + offset, y: rect.y }, { x: rect.x + offset + 6, y: rect.y }, { x: rect.x + offset + 6, y: rect.y + 6 }, { x: rect.x + offset, y: rect.y + 6 }] })) } };
  });
  // Review/application is confined to this clearly synthetic fixture.
  document.motionStudies = { attack: { version: 1, motionId: "attack", ...await getMotionStudyFingerprints(document), frames } };
  document = (await prepareMotionStudyFrames(document, "attack", undefined, { pixels: env })).document;
  document = (await applyMotionStudy(document, "attack", { pixels: env })).document;
  const files = attachRigAuthoring(await buildRigFiles(document, env, { maxPageSize: 32 }), document), bundle = parseBundle(files);
  assert.equal(bundle.pages.length, 2); assert.equal(bundle.parts.length, 18);
  return { document, bundle };
}

function trackedSyncPixels(bundle, { failSmallDecode = 0, failPageDecode = 0, failEncode = false } = {}) {
  const pageFiles = new Map(bundle.pages.map((page) => [bundle.files[page.file], page.file])),
    calls = { pageDecodes: new Map(), activePages: 0, maximumActivePages: 0, smallDecodes: 0, encodes: 0, canvases: [], images: [] };
  let pageAttempts = 0;
  const tracked = { ...env, createCanvas(width, height) { const canvas = createCanvas(width, height); calls.canvases.push(canvas); return canvas; },
    async loadImage(bytes) {
      const pageFile = pageFiles.get(bytes);
      if (pageFile) { pageAttempts++; if (pageAttempts === failPageDecode) throw new Error("injected page decode failure"); }
      else { calls.smallDecodes++; if (calls.smallDecodes === failSmallDecode) throw new Error("injected independent decode failure"); }
      const image = await env.loadImage(bytes), record = { image, pageFile, closed: false }; calls.images.push(record);
      if (pageFile) { calls.pageDecodes.set(pageFile, (calls.pageDecodes.get(pageFile) || 0) + 1); calls.activePages++; calls.maximumActivePages = Math.max(calls.maximumActivePages, calls.activePages); }
      image.close = () => { assert.equal(record.closed, false, "each owned bitmap closes once"); record.closed = true; if (pageFile) calls.activePages--; };
      return image;
    }, async encode(canvas) { calls.encodes++; if (failEncode) throw new Error("injected synchronization encode failure"); return env.encode(canvas); } };
  return { env: tracked, calls };
}
function releasedSyncPixels(calls) {
  assert.equal(calls.activePages, 0); assert.equal(calls.maximumActivePages, 1);
  assert.ok(calls.images.every((record) => record.closed));
  assert.ok(calls.canvases.every((canvas) => canvas.width === 1 && canvas.height === 1), "source crops and comparison canvases release their backing stores");
}
async function externallyChangedAtlas(bundle, ids) {
  const files = { ...bundle.files };
  for (const page of bundle.pages) {
    const regions = bundle.parts.filter((part) => part.pageFile === page.file && ids.includes(part.id)); if (!regions.length) continue;
    const image = await env.loadImage(files[page.file]), canvas = createCanvas(page.width, page.height), context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    context.fillStyle = "#ed1389"; for (const region of regions) context.fillRect(region.x + 1, region.y + 1, 2, 2);
    files[page.file] = await env.encode(canvas);
  }
  return { ...bundle, files };
}

test("authoring synchronization checks every base and pose region with one borrowed decoded page at a time", async () => {
  const { document, bundle } = await pagedSyncFixture(), before = structuredClone(document), tracked = trackedSyncPixels(bundle);
  const files = await synchronizeRigAuthoring(bundle, {}, tracked.env);
  assert.deepEqual(readRigAuthoring(files), before); assert.deepEqual(document, before);
  assert.deepEqual([...tracked.calls.pageDecodes.values()], [1, 1]); assert.equal(tracked.calls.smallDecodes, 18); assert.equal(tracked.calls.encodes, 0);
  releasedSyncPixels(tracked.calls);
});

test("reference-only studies retain their provenance without requiring or exporting stale runtime regions", async () => {
  const { document } = await pagedSyncFixture();
  document.motionStudies.attack.playback = "reference";
  const before = structuredClone(document.motionStudies.attack);
  const bundle = parseBundle(attachRigAuthoring(await buildRigFiles(document, env), document));
  assert.equal(bundle.parts.length, document.parts.length);
  const files = await synchronizeRigAuthoring(bundle, {}, env);
  assert.deepEqual(readRigAuthoring(files).motionStudies.attack, before);
  for (const frame of before.frames) for (const segment of frame.segments) {
    assert.equal(files[`images/${motionStudyRegionName("attack", frame.id, segment.partId)}.png`], undefined);
  }
});

test("empty edits still synchronize externally changed atlas pixels and mark changed applied pose art stale", async () => {
  const { document, bundle } = await pagedSyncFixture(), segment = document.motionStudies.attack.frames[1].segments[5],
    id = motionStudyRegionName("attack", "strike", segment.partId), changed = await externallyChangedAtlas(bundle, ["piece_2", id]), tracked = trackedSyncPixels(changed);
  const files = await synchronizeRigAuthoring(changed, {}, tracked.env), current = readRigAuthoring(files);
  assert.notEqual(current.parts[2].image, document.parts[2].image); assert.notEqual(current.motionStudies.attack.frames[1].segments[5].image, segment.image);
  assert.equal(current.motionStudies.attack.applied.outOfDate, true);
  assert.deepEqual(current.parts.map((part) => part.id), document.parts.map((part) => part.id));
  assert.deepEqual(current.motionStudies.attack.frames.map((frame) => [frame.id, frame.segments.map((part) => part.partId)]), document.motionStudies.attack.frames.map((frame) => [frame.id, frame.segments.map((part) => part.partId)]));
  assert.deepEqual(current.parts.filter((part) => part.id !== "piece_2"), document.parts.filter((part) => part.id !== "piece_2"));
  for (const [regionId, image] of [["piece_2", current.parts[2].image], [id, current.motionStudies.attack.frames[1].segments[5].image]]) {
    const region = changed.parts.find((part) => part.id === regionId), expected = await extractPart(changed, region, env), actual = await env.loadImage(imageDataBytes(image).bytes), canvas = createCanvas(expected.width, expected.height);
    canvas.getContext("2d").drawImage(actual, 0, 0); assert.deepEqual(pixels(canvas), pixels(expected)); assert.deepEqual(files[`images/${regionId}.png`], imageDataBytes(image).bytes);
  }
  assert.deepEqual([...tracked.calls.pageDecodes.values()], [1, 1]); assert.equal(tracked.calls.encodes, 2); releasedSyncPixels(tracked.calls);
});

test("authoring synchronization releases borrowed pages, small images and crop canvases when decoding or encoding fails", async () => {
  const { document, bundle } = await pagedSyncFixture(), before = structuredClone(document), changed = await externallyChangedAtlas(bundle, ["piece_0"]);
  for (const [input, options, message] of [[bundle, { failSmallDecode: 2 }, /independent decode failure/], [bundle, { failPageDecode: 2 }, /page decode failure/], [changed, { failEncode: true }, /synchronization encode failure/]]) {
    const tracked = trackedSyncPixels(input, options); await assert.rejects(rigWithCalibratedParts(document, input, {}, tracked.env), message);
    releasedSyncPixels(tracked.calls); assert.deepEqual(document, before);
  }
});

test("editable authoring, individual artwork and motion corrections survive runtime, project and Unity ZIPs", async () => {
  const { document, bundle } = await fixture();
  assert.equal(hasRigAuthoring(bundle.files), true);
  const before = readRigAuthoring(bundle.files);
  assert.equal(before.sourceImage, document.sourceImage);
  assert.deepEqual(before.joints, document.joints);
  assert.deepEqual(before.motions, document.motions);
  assert.deepEqual(before.parts.map((part) => part.image), document.parts.map((part) => part.image));
  const smallMetadata = new TextDecoder().decode(bundle.files[RIG_DOCUMENT_PATH]);
  assert.ok(!smallMetadata.includes("base64,"));
  for (const options of [{}, { editable: true }, { target: "unity" }]) {
    const restored = parseBundle(unpackZip(exportPackage(bundle, {}, options)));
    assert.deepEqual(readRigAuthoring(restored.files), before);
    assert.equal(restored.parts.length, document.parts.length);
    assert.equal(restored.animations.length, document.motions.length);
  }
  const independent = readRigAuthoring(bundle.files); independent.joints[0].x += 15;
  assert.deepEqual(readRigAuthoring(bundle.files).joints, before.joints);
});

test("reopening a rig bakes ordinary calibration and runtime-only re-import cannot restore stale part images", async () => {
  const { bundle } = await fixture(), region = bundle.parts[0];
  const replacement = imageDataBytes(artwork("#dd2255")).bytes;
  const edits = { [region.id]: { image: replacement, fileName: "new.png", transform: { ...identityTransform(), x: 3, y: -2, rotation: 18, scaleX: 0.8, scaleY: 0.9 } } };
  const originalFiles = structuredClone(bundle.files);
  const pages = await compilePages(bundle, edits, env);
  const files = await synchronizeRigAuthoring(bundle, edits, env);
  const restored = parseBundle(unpackZip(exportPackage({ ...bundle, files }, pages)));
  const rig = await rigWithCalibratedParts(readRigAuthoring(restored.files), restored, {}, env);
  const newPart = rig.parts.find((part) => part.id === region.id);
  const expected = await extractPart(restored, restored.parts.find((part) => part.id === region.id), env);
  const actual = await loadImage(newPart.image), canvas = createCanvas(expected.width, expected.height);
  canvas.getContext("2d").drawImage(actual, 0, 0);
  assert.deepEqual(pixels(canvas), pixels(expected));
  assert.deepEqual(restored.files[`images/${region.id}.png`], files[`images/${region.id}.png`]);
  assert.deepEqual(bundle.files, originalFiles);
});

test("authoring hydration refuses external references, missing artwork and corrupt documents", async () => {
  const { bundle } = await fixture();
  for (const path of ["https://example.com/private.png", "../other.png", ".ispine/rig/../../other.png"]) {
    const raw = JSON.parse(new TextDecoder().decode(bundle.files[RIG_DOCUMENT_PATH]));
    raw.sourceImageFile.path = path;
    assert.throws(() => readRigAuthoring({ ...bundle.files, [RIG_DOCUMENT_PATH]: new TextEncoder().encode(JSON.stringify(raw)) }), /引用无效/);
  }
  const missing = { ...bundle.files }; delete missing[".ispine/rig/source.png"];
  assert.throws(() => readRigAuthoring(missing), /图片/);
  assert.throws(() => readRigAuthoring({ [RIG_DOCUMENT_PATH]: new TextEncoder().encode("invalid") }), /无法读取/);
  assert.equal(readRigAuthoring({}), null);
});

test("rig images support exact binary data and reject non-images or oversized references", () => {
  const image = artwork(), { bytes, mime } = imageDataBytes(image);
  assert.equal(imageDataURL(bytes, mime), image);
  for (const source of ["https://example.com/image.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,"])
    assert.throws(() => imageDataBytes(source), /无效|为空/);
  assert.throws(() => imageDataURL(new Uint8Array()), /图片/);
});

async function drafts() {
  globalThis.indexedDB = new IDBFactory();
  return import(`../src/infrastructure/rig-draft-repository.js?test=${crypto.randomUUID()}`);
}
test("rig drafts stay outside the resource database, list without artwork, and restore independently after reload", async () => {
  const storage = await drafts(), { document } = await fixture();
  const saved = await storage.saveRigDraft(document, { resourceId: "saved-resource", resourceUpdatedAt: "2026-10-20T10:00:00.000Z" });
  const getAll = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function (...args) { assert.notEqual(this.name, "documents"); return getAll.apply(this, args); };
  let list;
  try { list = await storage.listRigDrafts(); }
  finally { IDBObjectStore.prototype.getAll = getAll; }
  assert.equal(list.length, 1); assert.equal(list[0].document, undefined);
  assert.equal(list[0].resourceId, "saved-resource");
  assert.equal(list[0].id, "resource-saved-resource"); assert.equal(list[0].documentId, document.id);
  assert.equal(list[0].resourceUpdatedAt, "2026-10-20T10:00:00.000Z");
  assert.deepEqual((await indexedDB.databases()).map((entry) => entry.name), ["ispine-rig-drafts"]);
  const reopened = await import(`../src/infrastructure/rig-draft-repository.js?reload=${crypto.randomUUID()}`);
  const loaded = await reopened.getRigDraft(saved.id);
  assert.deepEqual(loaded.document.parts, document.parts);
  loaded.document.joints[0].x += 15;
  assert.deepEqual((await reopened.getRigDraft(saved.id)).document.joints, document.joints);
  assert.equal(await reopened.getRigDraft("missing"), null);
});

test("draft validation or an aborted two-store write leaves the previous draft intact", async () => {
  const storage = await drafts(), { document } = await fixture();
  await storage.saveRigDraft(document);
  await assert.rejects(storage.saveRigDraft({ ...document, width: NaN }));
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) { if (this.name === "documents") throw new Error("injected failure"); return put.apply(this, args); };
  try { await assert.rejects(storage.saveRigDraft({ ...document, name: "Changed" })); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await storage.getRigDraft(document.id)).name, document.name);
  assert.equal((await storage.getRigDraft(document.id)).document.name, document.name);
});

test("an imported illustration can resume before AI analysis without becoming a normal resource", async () => {
  const storage = await drafts();
  const document = { version: 1, id: "pre-analysis", name: "Imported illustration", width: 160, height: 220,
    sourceImage: artwork(), joints: [], parts: [], motions: [] };
  await storage.saveRigDraft(document);
  const loaded = await storage.getRigDraft(document.id);
  assert.deepEqual(loaded.document, document);
  assert.equal(loaded.partCount, 0); assert.equal(loaded.resourceId, null);
  assert.deepEqual((await indexedDB.databases()).map((entry) => entry.name), ["ispine-rig-drafts"]);
});

test("the original appearance reference survives all authoring exports as exact PNG or JPEG bytes", async () => {
  const { document, bundle } = await fixture();
  const referenceCanvas = createCanvas(48, 64), referenceContext = referenceCanvas.getContext("2d");
  referenceContext.fillStyle = "#23a8b5"; referenceContext.fillRect(0, 0, 48, 64);
  referenceContext.fillStyle = "#eec468"; referenceContext.fillRect(7, 11, 29, 37);
  for (const mime of ["image/png", "image/jpeg"]) {
    const original = referenceCanvas.toDataURL(mime), { bytes } = imageDataBytes(original);
    const current = { ...document,
      appearanceReference: { image: original, width: 48, height: 64, name: "original-reference" },
      appearance: { prompt: "Create a chibi mage from the supplied reference.", sourceFingerprint: createHash("sha256").update(bytes).digest("hex"),
        jobId: "actual-job-reference", imageId: "candidate-1", provider: "codex-native", model: "native-image", createdAt: "2026-10-20T14:00:00.000Z" },
      prompts: { appearance: "Keep the original face and outfit cues.", structure: "Independent humanoid rig", parts: "Transparent independent pieces" } };
    const files = attachRigAuthoring(bundle.files, current), path = `.ispine/rig/appearance-reference.${mime === "image/jpeg" ? "jpg" : "png"}`;
    assert.deepEqual(files[path], bytes);
    assert.deepEqual(files[".ispine/rig/source.png"], imageDataBytes(document.sourceImage).bytes);
    const raw = new TextDecoder().decode(files[RIG_DOCUMENT_PATH]), metadata = JSON.parse(raw);
    assert.ok(!raw.includes("base64,")); assert.equal(metadata.appearanceReference.image, undefined);
    assert.deepEqual(metadata.appearanceReference.imageFile, { path, mime });
    for (const options of [{}, { editable: true }, { target: "unity" }]) {
      const roundtrip = parseBundle(unpackZip(exportPackage({ ...bundle, files }, {}, options)));
      const restored = readRigAuthoring(roundtrip.files);
      assert.deepEqual(restored.appearanceReference, current.appearanceReference);
      assert.deepEqual(restored.appearance, current.appearance); assert.deepEqual(restored.prompts, current.prompts);
      assert.equal(restored.sourceImage, document.sourceImage);
      assert.deepEqual(roundtrip.files[path], bytes);
      const beforeImage = await loadImage(original), afterImage = await loadImage(restored.appearanceReference.image);
      const a = createCanvas(48, 64), b = createCanvas(48, 64);
      a.getContext("2d").drawImage(beforeImage, 0, 0); b.getContext("2d").drawImage(afterImage, 0, 0);
      assert.deepEqual(pixels(a), pixels(b), "decoded original-reference pixels must not change");
    }
  }
});

test("ordinary calibration updates part artwork while preserving the original appearance reference and generation provenance", async () => {
  const { document, bundle } = await fixture();
  const current = { ...document, appearanceReference: { image: artwork("#1144aa"), width: 48, height: 64 },
    appearance: { jobId: "appearance-job", prompt: "Reference-guided chibi appearance", sourceFingerprint: "source-hash", provider: "codex-native" },
    prompts: { appearance: "Preserve the uploaded reference.", parts: "Separate transparent parts" } };
  const original = { ...bundle, files: attachRigAuthoring(bundle.files, current) }, region = bundle.parts[0];
  const edits = { [region.id]: { image: imageDataBytes(artwork("#bb5577")).bytes, transform: { ...identityTransform(), x: 2, rotation: 12 } } };
  const synchronized = await synchronizeRigAuthoring(original, edits, env), restored = readRigAuthoring(synchronized);
  assert.deepEqual(restored.appearanceReference, current.appearanceReference);
  assert.deepEqual(restored.appearance, current.appearance); assert.deepEqual(restored.prompts, current.prompts);
  assert.equal(restored.parts[0].imageSource, "calibrated");
  assert.notEqual(restored.parts[0].image, current.parts[0].image);
  assert.deepEqual(synchronized[".ispine/rig/appearance-reference.png"], imageDataBytes(current.appearanceReference.image).bytes);
});

test("reference-only pre-analysis drafts restore original pixels and editable appearance prompts without creating resources", async () => {
  const storage = await drafts();
  const document = { version: 1, id: "reference-only", name: "Appearance reference draft", width: 160, height: 220,
    appearanceReference: { image: artwork("#775533"), width: 48, height: 64, name: "reference.png" },
    prompts: { appearance: "Make a small chibi character from this original reference." }, joints: [], parts: [], motions: [] };
  await storage.saveRigDraft(document);
  const loaded = await storage.getRigDraft(document.id);
  assert.deepEqual(loaded.document, document); assert.equal(loaded.document.sourceImage, undefined);
  assert.equal(loaded.partCount, 0); assert.equal(loaded.resourceId, null);
  for (const changes of [
    { appearanceReference: { ...document.appearanceReference, image: "https://example.com/reference.png" } },
    { appearanceReference: { ...document.appearanceReference, width: 0 } },
    { appearance: { jobId: "job", image: artwork() } },
    { prompts: { appearance: "x".repeat(4001) } },
  ]) await assert.rejects(storage.saveRigDraft({ ...document, ...changes }));
  assert.deepEqual((await storage.getRigDraft(document.id)).document, document);
  assert.deepEqual((await indexedDB.databases()).map((entry) => entry.name), ["ispine-rig-drafts"]);
});

test("reference file hydration rejects missing and external references while old source-only archives remain compatible", async () => {
  const { document, bundle } = await fixture();
  assert.equal(readRigAuthoring(bundle.files).appearanceReference, undefined);
  const files = attachRigAuthoring(bundle.files, { ...document, appearanceReference: { image: artwork("#116633"), width: 48, height: 64 } });
  for (const path of ["https://example.com/reference.png", "../reference.png", ".ispine/rig/../../private.png"]) {
    const raw = JSON.parse(new TextDecoder().decode(files[RIG_DOCUMENT_PATH]));
    raw.appearanceReference.imageFile.path = path;
    assert.throws(() => readRigAuthoring({ ...files, [RIG_DOCUMENT_PATH]: new TextEncoder().encode(JSON.stringify(raw)) }), /引用无效/);
  }
  const missing = { ...files }; delete missing[".ispine/rig/appearance-reference.png"];
  assert.throws(() => readRigAuthoring(missing), /图片/);
  assert.throws(() => attachRigAuthoring(bundle.files, { ...document, appearance: { prompt: "x".repeat(4001) } }), /4000/);
});


test("library counts distinguish logical parts, attachment variants and active pose textures without hydrating artwork", () => {
  const document = { parts: [{ id: "body" }, { id: "eye", attachmentGroup: "eyes", imageFile: { path: "not-loaded.png" } },
    { id: "blink", attachmentGroup: "eyes" }, { id: "eyes" }], joints: [{ id: "root" }], motionStudies: {
    attack: { applied: { kind: "stepped-parts" }, frames: [{ segments: [{}, {}, {}] }] },
    skill: { playback: "reference", applied: { kind: "stepped-parts" }, frames: [{ segments: [{}, {}] }] },
  } };
  const files = { [RIG_DOCUMENT_PATH]: new TextEncoder().encode(JSON.stringify(document)) };
  assert.deepEqual(rigAuthoringSummary(files), { baseParts: 4, bones: 1, logicalParts: 3, additionalAttachments: 1, expressionVariants: 2, poseRegions: 3 });
  assert.equal(rigAuthoringSummary({}), null);
  assert.equal(rigAuthoringSummary({ [RIG_DOCUMENT_PATH]: new TextEncoder().encode("bad JSON") }), null);
});

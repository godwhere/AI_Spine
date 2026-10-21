// Semantic snapshot captured before P2, then compared after each extraction.
// Fixtures use repository templates and synthetic art, never the live workspace.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { template, synthetic, pixelEnv } from "../tests/helpers.mjs";
import { exportPackage } from "../engine/archive/package.js";
import { unpackZip } from "../engine/archive/zip.js";
import { parseSkeleton } from "../engine/spine/parse.js";
import { measurePreviewBounds } from "../engine/spine/geometry.js";
import { templateFingerprint } from "../shared/domain/generation.mjs";
import { createHumanoidDraft } from "../engine/rig/create-draft.js";
import { buildRigFiles } from "../engine/rig/build-files.js";
import { setRigPartWeights } from "../engine/rig/geometry.js";
import { sampleRigPose } from "../engine/rig/sample.js";
import { inspectRigMotion } from "../engine/rig/inspect.js";
import { compileRigSkeleton } from "../engine/rig/compile.js";
import { motionStudyFingerprints, motionStudyRegionName, motionStudySlotName } from "../shared/domain/motion-study.mjs";
import { rigSourceFingerprint, rigCompositionFingerprint } from "../shared/domain/generation.mjs";
import { attachRigAuthoring, readRigAuthoring } from "../engine/archive/rig-project.js";
import { imageDataURL } from "../shared/codec/image-data.mjs";
import { extractPart, compilePages } from "../engine/images/calibration.js";
import { identityTransform } from "../engine/images/calibration.js";
import { addTemplateVariant } from "../engine/archive/template-variants.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFiles = (files) => Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, sha(bytes)]));
const hashJSON = (value) => sha(JSON.stringify(value));
export async function measureEngine() {
  const report = { templates: {}, pixels: [], rig: {}, variants: {} };
  const catalog = JSON.parse(await readFile(new URL("../public/templates/catalog.json", import.meta.url), "utf8"));
  for (const entry of catalog) {
    const bundle = template(entry.id), { data } = parseSkeleton(bundle);
    report.templates[entry.id] = { fingerprint: await templateFingerprint(bundle),
      bones: data.bones.length, regions: bundle.parts.length,
      animations: data.animations.map(({ name, duration }) => ({ name, duration })),
      bounds: data.skins.map((skin) => measurePreviewBounds(data, skin)) };
  }
  const bundle = template(22);
  report.exports = Object.fromEntries([{}, { editable: true }, { target: "unity" }].map((options) => {
    const zip = exportPackage(bundle, {}, options);
    return [options.target || (options.editable ? "editable" : "runtime"), { sha256: sha(zip), entries: hashFiles(unpackZip(zip)) }];
  }));
  for (const rotate of [0, 90]) for (const pma of [false, true]) {
    const bundle = synthetic({ rotate, pma }), part = bundle.parts[0], canvas = await extractPart(bundle, part, pixelEnv);
    const image = await pixelEnv.encode(canvas), transform = { ...identityTransform(), x: 1, y: -1, rotation: 7, scaleX: .9 };
    report.pixels.push({ rotate, pma, extracted: sha(image), pages: hashFiles(await compilePages(bundle, { [part.id]: { image, transform } }, pixelEnv)) });
  }
  const canvas = createCanvas(12, 16), context = canvas.getContext("2d");
  context.fillStyle = "#9d4d74"; context.fillRect(2, 2, 8, 12);
  const image = new Uint8Array(canvas.toBuffer("image/png")), url = imageDataURL(image);
  let doc = createHumanoidDraft({ id: "engine-fixture", name: "Engine fixture", width: 240, height: 360, sourceImage: url });
  doc.parts = doc.parts.map((part) => ({ ...part, image: url, imageSource: "uploaded" }));
  doc = setRigPartWeights(doc, "torso", 0, [{ joint: "torso", weight: 2 }, { joint: "neck", weight: 1 }]);
  const face = doc.parts.find((part) => part.id === "head"); face.attachmentGroup = "face";
  doc.parts.push({ ...face, id: "head_hurt", name: "Hurt face" }); doc.defaultAttachments = { face: "head" };
  doc.motions.find((motion) => motion.id === "hit").poses = [
    { time: 0, attachments: { face: "head_hurt" } }, { time: .34, attachments: { face: null } }, { time: .5, attachments: { face: "head" } }, { time: .6 },
  ];
  doc.motions.push({ id: "release_test", name: "Release", duration: 1.1, loop: false, poses: [
    { time: 0, feet: { left: true, right: true } }, { time: .17, angles: { torso: -7 }, root: { x: 2, y: 3 } },
    { time: .347, angles: { torso: 9, leftThigh: -23, leftShin: 49 }, root: { x: 4, y: 20 }, feet: { left: false, right: false } },
    { time: 1.1, angles: { torso: 40, leftThigh: -65, leftShin: 145 }, root: { x: 18, y: 100 } },
  ] });
  const files = attachRigAuthoring(await buildRigFiles(doc, pixelEnv), doc);
  report.rig = { source: await rigSourceFingerprint(doc), composition: await rigCompositionFingerprint(doc),
    study: motionStudyFingerprints(doc), regionName: motionStudyRegionName("attack", "frame1", "torso"), slotName: motionStudySlotName("attack", "torso"),
    samples: hashJSON(doc.motions.map((motion) => [motion.id, [0, .123, .347 - Number.EPSILON, .347, .5, motion.duration].map((time) => sampleRigPose(doc, motion.id, time))])),
    inspections: doc.motions.map((motion) => inspectRigMotion(doc, motion.id)), skeleton: hashJSON(compileRigSkeleton(doc)),
    files: hashFiles(files), roundTrip: hashJSON(readRigAuthoring(files)) };
  const source = template(16), variant = await addTemplateVariant(source, { partId: "face", image, name: "Hurt", animations: ["unit_damage", "unit_dead"], provenance: { jobId: "fixture-job", imageId: "fixture-image" } }, pixelEnv);
  report.variants = { partId: variant.partId, metadata: variant.metadata, files: hashFiles(variant.bundle.files) };
  return JSON.parse(JSON.stringify(report));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await measureEngine();
  const output = process.argv[2] || "/tmp/ispine-engine.json";
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, templates: Object.keys(report.templates).length,
    syntheticPixelCases: report.pixels.length, motions: report.rig.inspections.length }));
}

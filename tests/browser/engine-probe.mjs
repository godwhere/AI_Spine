// Browser-only acceptance entry bundled into the isolated temporary client.
import { Skeleton, AnimationState, AnimationStateData, Physics } from "@esotericsoftware/spine-core";
import { createHumanoidDraft } from "../../engine/rig/create-draft.js";
import { buildRigFiles } from "../../engine/rig/build-files.js";
import { sampleRigPose } from "../../engine/rig/sample.js";
import { parseBundle } from "../../engine/archive/bundle.js";
import { parseSkeleton } from "../../engine/spine/parse.js";
import { exportPackage } from "../../engine/archive/package.js";
import { unpackZip } from "../../engine/archive/zip.js";
import { attachRigAuthoring, readRigAuthoring } from "../../engine/archive/rig-project.js";
import { extractPart, compilePages, identityTransform } from "../../engine/images/calibration.js";
import { templateFingerprint } from "../../shared/domain/generation.mjs";
import { imageDataURL } from "../../shared/codec/image-data.mjs";
import { validateRigDocument } from "../../shared/rig-schema.mjs";
import { browserPixels } from "../../src/infrastructure/browser-pixels.js";
import { browserPixels as rigPixels } from "../../src/infrastructure/rig-pixels.js";

export async function runEngineProbe() {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const canvas = browserPixels.createCanvas(12, 16), context = canvas.getContext("2d");
  context.fillStyle = "#9d4d74"; context.fillRect(2, 2, 8, 12);
  const image = await browserPixels.encode(canvas), sourceImage = imageDataURL(image);
  const doc = createHumanoidDraft({ id: "browser-engine-fixture", name: "Browser fixture", width: 240, height: 360, sourceImage });
  doc.parts = doc.parts.map((part) => ({ ...part, image: sourceImage, imageSource: "uploaded", completion: "ready" }));
  doc.motions.push({ id: "release_test", name: "Release", duration: 1.1, loop: false, poses: [
    { time: 0, feet: { left: true, right: true } }, { time: .17, angles: { torso: -7 }, root: { x: 2, y: 3 } },
    { time: .347, angles: { torso: 9, leftThigh: -23, leftShin: 49 }, root: { x: 4, y: 20 }, feet: { left: false, right: false } },
    { time: 1.1, angles: { torso: 40, leftThigh: -65, leftShin: 145 }, root: { x: 18, y: 100 } },
  ] });
  const files = attachRigAuthoring(await buildRigFiles(doc, rigPixels), doc), bundle = parseBundle(files, { id: doc.id });
  const { data } = parseSkeleton(bundle), skeleton = new Skeleton(data), state = new AnimationState(new AnimationStateData(data));
  skeleton.setSkin(data.skins[0]); skeleton.setupPose();
  const track = state.setAnimation(0, "release_test", false);
  let maximumFootError = 0;
  for (let index = 0; index < 200; index++) {
    const time = .347 * index / 200, expected = sampleRigPose(doc, "release_test", time);
    skeleton.setupPose(); track.trackTime = time; state.apply(skeleton); skeleton.updateWorldTransform(Physics.none);
    for (const side of ["left", "right"]) {
      const actual = skeleton.findBone(`${side}Foot`).appliedPose, target = expected.footTargets[side];
      maximumFootError = Math.max(maximumFootError, Math.hypot(actual.worldX - target.x, doc.height - actual.worldY - target.y));
    }
  }
  const part = bundle.parts[0], extracted = await extractPart(bundle, part, browserPixels);
  const pixels = extracted.getContext("2d").getImageData(0, 0, extracted.width, extracted.height).data;
  const pages = await compilePages(bundle, { [part.id]: { image, transform: { ...identityTransform(), x: 1 } } }, browserPixels);
  const zip = exportPackage(bundle, pages, { editable: true }), reopened = parseBundle(unpackZip(zip), { id: doc.id });
  const catalog = await (await fetch("/templates/catalog.json")).json(), item = catalog.find((entry) => String(entry.id) === "22");
  const templateFiles = Object.fromEntries(await Promise.all([item.skeletonFile, ...item.atlasFiles, ...item.textureFiles].map(async (path) => [path,
    new Uint8Array(await (await fetch(`/templates/22/${path}`)).arrayBuffer())])));
  return { maximumFootError, feetAfterRelease: sampleRigPose(doc, "release_test", .347).feet,
    hasVisiblePixels: pixels.some((value, index) => index % 4 === 3 && value > 8),
    authoredRoundTrip: JSON.stringify(canonical(readRigAuthoring(reopened.files))) === JSON.stringify(canonical(validateRigDocument(doc))),
    animations: parseSkeleton(reopened).data.animations.map(({ name }) => name),
    fingerprint: await templateFingerprint(parseBundle(templateFiles, { id: "template-22" })),
    basePartCount: doc.parts.length,
    pngCount: Object.keys(reopened.files).filter((path) => path.startsWith("images/") && path.endsWith(".png")).length };
}

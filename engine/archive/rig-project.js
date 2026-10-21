import { hasRigAuthoring } from "../../shared/domain/rig-summary.mjs";
import { imageDataBytes } from "../../shared/codec/image-data.mjs";
import { imageDataURL } from "../../shared/codec/image-data.mjs";
import { isMotionStudyPlaybackActive } from "../../shared/domain/motion-study.mjs";
import { motionStudyRegionName } from "../../shared/domain/motion-study.mjs";
import { RIG_DOCUMENT_PATH } from "../../shared/domain/rig-summary.mjs";
import { rigWithCalibratedParts } from "../images/rig-calibration.js";
import { validateRigDocument } from "../../shared/rig-schema.mjs";

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const extension = (mime) => mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";

// Keep the small editable document separate from its binary artwork. The normal
// archive layer already preserves these files in both runtime and project ZIPs.
function attachRigAuthoring(inputFiles, document) {
  const rig = validateRigDocument(document), files = { ...inputFiles };
  const images = new Map();
  const storeImage = (url, stem, reuse = false) => {
    if (reuse && images.has(url)) return images.get(url);
    const { bytes, mime } = imageDataBytes(url), path = `${stem}.${extension(mime)}`;
    files[path] = bytes;
    const reference = { path, mime }; if (!images.has(url)) images.set(url, reference); return reference;
  };
  if (rig.sourceImage) {
    rig.sourceImageFile = storeImage(rig.sourceImage, ".ispine/rig/source");
    delete rig.sourceImage;
  }
  if (rig.appearanceReference) {
    const reference = { ...rig.appearanceReference };
    reference.imageFile = storeImage(reference.image, ".ispine/rig/appearance-reference");
    delete reference.image;
    rig.appearanceReference = reference;
  }
  if (rig.production) for (const board of rig.production.boards) for (const field of ["image", "nativeImage"]) if (board[field]) {
    board[`${field}File`] = storeImage(board[field], `.ispine/rig/production/${board.id}-${field}`);
    delete board[field];
  }
  rig.parts = rig.parts.map((part) => {
    const saved = { ...part };
    if (part.image) { saved.imageFile = storeImage(part.image, `.ispine/rig/parts/${part.id}`); delete saved.image; }
    if (part.registrationBase) {
      saved.registrationBase = { ...part.registrationBase,
        imageFile: storeImage(part.registrationBase.image, `.ispine/rig/registration-base/${part.id}`) };
      delete saved.registrationBase.image;
    }
    return saved;
  });
  for (const [motionId, study] of Object.entries(rig.motionStudies || {})) for (const frame of study.frames) {
    if (frame.image) {
      frame.imageFile = storeImage(frame.image, `.ispine/rig/motion-studies/${motionId}/frames/${frame.id}`, true);
      delete frame.image;
    }
    // Comparison renders are derived; only the actual source and independent
    // segments belong to the editable archive.
    delete frame.composition;
    for (const segment of frame.segments || []) {
      const runtimePath = `images/${motionStudyRegionName(motionId, frame.id, segment.partId)}.png`, raw = imageDataBytes(segment.image);
      const runtime = files[runtimePath];
      if (raw.mime === "image/png" && runtime?.length === raw.bytes.length && runtime.every((value, index) => value === raw.bytes[index]))
        segment.imageFile = { path: runtimePath, mime: raw.mime };
      else segment.imageFile = storeImage(segment.image, `.ispine/rig/motion-studies/${motionId}/segments/${frame.id}-${segment.partId}`);
      delete segment.image;
    }
  }
  files[RIG_DOCUMENT_PATH] = encoder.encode(JSON.stringify(rig));
  return files;
}

function readRigAuthoring(files) {
  if (!hasRigAuthoring(files)) return null;
  const bytes = files[RIG_DOCUMENT_PATH];
  if (!(bytes instanceof Uint8Array) || bytes.length > 16 * 1024 * 1024)
    throw new Error("骨架编辑数据无效，普通动画资源仍可预览。");
  let document;
  try { document = JSON.parse(decoder.decode(bytes)); }
  catch { throw new Error("骨架编辑数据无法读取，普通动画资源仍可预览。"); }
  const restoreImage = (reference) => {
    if (!reference || typeof reference.path !== "string" ||
        !/^(?:images\/|\.ispine\/rig\/)[A-Za-z0-9_./-]+$/.test(reference.path) ||
        reference.path.split("/").some((piece) => piece === "." || piece === "..") ||
        !["image/png", "image/jpeg", "image/webp"].includes(reference.mime))
      throw new Error("骨架图片引用无效，请重新导入完整工程。");
    return imageDataURL(files[reference.path], reference.mime);
  };
  if (document.sourceImageFile) {
    document.sourceImage = restoreImage(document.sourceImageFile);
    delete document.sourceImageFile;
  }
  if (document.appearanceReference?.imageFile) {
    const reference = { ...document.appearanceReference };
    reference.image = restoreImage(reference.imageFile);
    delete reference.imageFile;
    document.appearanceReference = reference;
  }
  if (document.production) for (const board of document.production.boards || []) for (const field of ["image", "nativeImage"]) if (board[`${field}File`]) {
    board[field] = restoreImage(board[`${field}File`]);
    delete board[`${field}File`];
  }
  if (Array.isArray(document.parts)) document.parts = document.parts.map((part) => {
    const restored = { ...part };
    if (part.imageFile) { restored.image = restoreImage(part.imageFile); delete restored.imageFile; }
    if (part.registrationBase?.imageFile) {
      restored.registrationBase = { ...part.registrationBase, image: restoreImage(part.registrationBase.imageFile) };
      delete restored.registrationBase.imageFile;
    }
    return restored;
  });
  for (const study of Object.values(document.motionStudies || {})) for (const frame of study.frames || []) {
    if (frame.imageFile) { frame.image = restoreImage(frame.imageFile); delete frame.imageFile; }
    for (const segment of frame.segments || []) if (segment.imageFile) { segment.image = restoreImage(segment.imageFile); delete segment.imageFile; }
  }
  return validateRigDocument(document);
}

async function synchronizeRigAuthoring(bundle, edits = {}, env) {
  const document = readRigAuthoring(bundle.files);
  if (!document) return bundle.files;
  const current = await rigWithCalibratedParts(document, bundle, edits, env);
  const files = attachRigAuthoring(bundle.files, current);
  for (const part of current.parts) files[`images/${part.id}.png`] = imageDataBytes(part.image).bytes;
  for (const [motionId, study] of Object.entries(current.motionStudies || {})) for (const frame of study.frames) for (const segment of frame.segments || [])
    if (isMotionStudyPlaybackActive(study)) files[`images/${motionStudyRegionName(motionId, frame.id, segment.partId)}.png`] = imageDataBytes(segment.image).bytes;
  return files;
}

export { attachRigAuthoring, readRigAuthoring, synchronizeRigAuthoring };

import { validateRigDocument } from "../../shared/rig-schema.mjs";
import { browserPixels, extractPartFromImage, drawReplacement } from "./pixels.js";
import { motionStudyRegionName, isMotionStudyPlaybackActive } from "./rig-motion-studies.js";

export const RIG_DOCUMENT_PATH = ".ispine/rig/document.json";
const encoder = new TextEncoder(), decoder = new TextDecoder();
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const summaryCache = new WeakMap();

// Library counts must not hydrate every image just to distinguish body parts
// from the hundreds of texture variants that can be produced by pose studies.
export function rigAuthoringSummary(files) {
  const data = files?.[RIG_DOCUMENT_PATH];
  if (!(data instanceof Uint8Array) || data.length > 16 * 1024 * 1024) return null;
  if (summaryCache.has(data)) return summaryCache.get(data);
  let result = null;
  try {
    const document = JSON.parse(decoder.decode(data));
    if (Array.isArray(document.parts) && Array.isArray(document.joints)) result = Object.freeze({
      baseParts: document.parts.length, bones: document.joints.length,
      expressionVariants: document.parts.filter((part) => part.attachmentGroup).length,
      poseRegions: Object.values(document.motionStudies || {}).filter(isMotionStudyPlaybackActive)
        .reduce((sum, study) => sum + (study.frames || []).reduce((count, frame) => count + (frame.segments?.length || 0), 0), 0),
    });
  } catch { /* Ordinary resources remain browseable when author data is invalid. */ }
  summaryCache.set(data, result);
  return result;
}

export function imageDataBytes(url) {
  const match = typeof url === "string" && url.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4)
    throw new Error("骨架图片无效或超过 32 MB，请重新导入。");
  const raw = atob(match[2]), bytes = Uint8Array.from(raw, (value) => value.charCodeAt(0));
  if (!bytes.length) throw new Error("骨架图片为空。");
  return { bytes, mime: match[1] };
}

export function imageDataURL(bytes, mime = "image/png") {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("骨架工程缺少有效图片。");
  let raw = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    raw += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${mime};base64,${btoa(raw)}`;
}

const extension = (mime) => mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
export const hasRigAuthoring = (files) => Boolean(files?.[RIG_DOCUMENT_PATH]);

// Keep the small editable document separate from its binary artwork. The normal
// archive layer already preserves these files in both runtime and project ZIPs.
export function attachRigAuthoring(inputFiles, document) {
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

export function readRigAuthoring(files) {
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

// Ordinary texture replacement/calibration can precede reopening the rig editor.
// Bake those current pixels into the authoring part so a bone edit cannot revert them.
export async function rigWithCalibratedParts(document, bundle, edits = {}, env = browserPixels) {
  const rig = validateRigDocument(document);
  const currentImage = async (part, region, edit, page) => {
    let canvas;
    try {
      if (edit) {
        canvas = env.createCanvas(region.originalWidth, region.originalHeight);
        const image = await env.loadImage(edit.image);
        try { drawReplacement(canvas.getContext("2d"), image, region, edit.transform); }
        finally { image.close?.(); }
      } else canvas = extractPartFromImage(page, region, env);
      if (!edit && part.image) {
        let image, expected;
        try {
          image = await env.loadImage(imageDataBytes(part.image).bytes);
          expected = env.createCanvas(canvas.width, canvas.height);
          const context = expected.getContext("2d"); context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const before = context.getImageData(0, 0, canvas.width, canvas.height).data, after = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
          if (before.every((value, index) => value === after[index])) return part.image;
        } finally { image?.close?.(); if (expected) { expected.width = 1; expected.height = 1; } }
      }
      return imageDataURL(await env.encode(canvas));
    } finally {
      if (canvas) { canvas.width = 1; canvas.height = 1; }
    }
  };
  const regions = new Map(bundle.parts.map((part) => [part.id, part])), groups = new Map();
  const queue = (part, region, edit, update) => {
    if (!groups.has(region.pageFile)) groups.set(region.pageFile, []);
    groups.get(region.pageFile).push({ part, region, edit, update });
  };
  for (const [index, part] of rig.parts.entries()) {
    const edit = edits[part.id];
    const region = regions.get(part.id);
    if (!region) throw new Error(`找不到骨架部件：${part.label || part.id}`);
    queue(part, region, edit, (image) => {
      const result = { ...part, image, ...(edit ? { imageSource: "calibrated", previousCalibration: { ...edit.transform } } : {}) };
      if (edit) { delete result.registrationBase; delete result.registration; }
      rig.parts[index] = result;
    });
  }
  for (const [motionId, study] of Object.entries(rig.motionStudies || {})) for (const frame of study.playback === "reference" ? [] : study.frames) for (const segment of frame.segments || []) {
    const id = motionStudyRegionName(motionId, frame.id, segment.partId), region = regions.get(id);
    if (!region) { if (study.applied) throw new Error(`找不到逐帧动作部件：${id}`); continue; }
    queue(segment, region, edits[id], (image) => {
      if (image !== segment.image) { segment.image = image; if (study.applied) study.applied.outOfDate = true; }
    });
  }
  // Base artwork and all pose regions on a page share one decoded bitmap. Never
  // keep several large pages alive or skip comparison just because edits is empty.
  for (const [pageFile, tasks] of groups) {
    let page;
    try {
      if (tasks.some((task) => !task.edit)) page = await env.loadImage(bundle.files[pageFile]);
      for (const task of tasks) task.update(await currentImage(task.part, task.region, task.edit, page));
    } finally { page?.close?.(); }
  }
  return rig;
}

export async function synchronizeRigAuthoring(bundle, edits = {}, env = browserPixels) {
  const document = readRigAuthoring(bundle.files);
  if (!document) return bundle.files;
  const current = await rigWithCalibratedParts(document, bundle, edits, env);
  const files = attachRigAuthoring(bundle.files, current);
  for (const part of current.parts) files[`images/${part.id}.png`] = imageDataBytes(part.image).bytes;
  for (const [motionId, study] of Object.entries(current.motionStudies || {})) for (const frame of study.frames) for (const segment of frame.segments || [])
    if (isMotionStudyPlaybackActive(study)) files[`images/${motionStudyRegionName(motionId, frame.id, segment.partId)}.png`] = imageDataBytes(segment.image).bytes;
  return files;
}

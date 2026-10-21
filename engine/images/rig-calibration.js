import { drawReplacement } from "./calibration.js";
import { extractPartFromImage } from "./calibration.js";
import { imageDataBytes } from "../../shared/codec/image-data.mjs";
import { imageDataURL } from "../../shared/codec/image-data.mjs";
import { motionStudyRegionName } from "../../shared/domain/motion-study.mjs";
import { validateRigDocument } from "../../shared/rig-schema.mjs";

// Ordinary texture replacement/calibration can precede reopening the rig editor.
// Bake those current pixels into the authoring part so a bone edit cannot revert them.
async function rigWithCalibratedParts(document, bundle, edits = {}, env) {
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

export { rigWithCalibratedParts };

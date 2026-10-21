import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { imageDataBytes } from "../../../shared/codec/image-data.mjs";
import { productionReviewCurrent } from "../../../shared/domain/production.mjs";

// Preserve the reviewed canvas exactly. These are pose targets, never inputs to
// visible-height normalization or a replacement for independently painted parts.
export async function saveProductionReferences(request, folder) {
  const { loadImage } = await import("@napi-rs/canvas");
  const references = [], boards = request.rig.production.boards.filter((b) => !b.reuseBase &&
    (request.kind === "structure" || b.motionId === request.motion.id));
  for (const board of boards) {
    if (!board.image || !productionReviewCurrent(request.rig, "board", board.id)) throw new Error("动作关键图尚未确认，未提交规划。");
    const { bytes, mime } = imageDataBytes(board.image), image = await loadImage(bytes);
    try {
      if (image.width !== request.rig.width || image.height !== request.rig.height) throw new Error("动作关键图必须使用与设定图相同的画布，不能按可见身高缩放。");
      const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png", file = `production-reference-${references.length}.${extension}`;
      await writeFile(join(folder, file), bytes, { mode: 0o600 });
      references.push({ frameId: board.id, motionId: board.motionId, time: board.time, label: board.label, sourceFingerprint: createHash("sha256").update(bytes).digest("hex"),
        width: image.width, height: image.height, imageIndex: references.length + 2, file, ...(board.jobId ? { jobId: board.jobId, imageId: board.imageId } : {}) });
    } finally { image.close?.(); }
  }
  if (request.kind === "motion") {
    request.motionReferences = references; request.motionReferenceExclusions = [];
    request.motionReferenceBaseFingerprint = request.sourceFingerprint;
  } else request.productionReferences = references;
}

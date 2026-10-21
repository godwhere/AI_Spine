import { validateRigDocument } from "../../shared/rig-schema.mjs";
import { imageDataBytes, imageDataURL } from "../../shared/codec/image-data.mjs";
import { sha256 } from "../../shared/codec/sha256.mjs";

// Bake adjacent, finished limb pieces on their existing source grid. This is
// texture composition, not new artwork or a claim of hidden-surface inpainting.
export async function createRigContinuousLimb(document, { motionId, upperId, lowerId }, pixels) {
  const doc = validateRigDocument(document), motion = doc.motions.find((item) => item.id === motionId);
  if (!motion || doc.motionStudies?.[motionId]?.applied) throw new Error("请先选择连续骨骼动作。");
  const sources = [upperId, lowerId].map((id) => doc.parts.find((part) => part.id === id));
  if (upperId === lowerId || sources.some((part) => !part?.image || part.completion !== "ready" || part.role === "effect" ||
    !["ai", "uploaded", "calibrated"].includes(part.imageSource) || part.composition?.kind === "continuous-limb"))
    throw new Error("请选择两个已完成的独立肢体部件。");
  const [upper, lower] = sources, joint = doc.joints.find((item) => item.id === lower.bone);
  if (joint?.parent !== upper.bone || upper.grip || lower.grip) throw new Error("上段和下段必须绑定同一条相邻骨链，不能包含武器握点。");
  const key = (await sha256(new TextEncoder().encode(JSON.stringify([doc.id, motionId, upperId, lowerId])))).slice(0, 16);
  const id = `limb-${key}`, groups = [`limb_${key}_upper`, `limb_${key}_lower`];
  for (const [index, part] of sources.entries()) {
    if (part.attachmentGroup && part.attachmentGroup !== groups[index]) throw new Error("此部件已有其他显示组，请选择普通独立层。");
    if (doc.parts.some((item) => item.attachmentGroup === groups[index] && ![part.id, id].includes(item.id))) throw new Error("连续网格显示组已被其他部件使用。");
    if (doc.parts.some((item) => item.id === id && (item.composition?.kind !== "continuous-limb" || item.composition.motionId !== motionId))) throw new Error("连续网格标识已被使用。");
  }
  const x = Math.floor(Math.min(...sources.map((part) => part.x))), y = Math.floor(Math.min(...sources.map((part) => part.y)));
  const width = Math.ceil(Math.max(...sources.map((part) => part.x + part.width))) - x;
  const height = Math.ceil(Math.max(...sources.map((part) => part.y + part.height))) - y;
  const decoded = [], hashes = [];
  let canvas;
  try {
    for (const part of sources) {
      const bytes = imageDataBytes(part.image).bytes;
      decoded.push(await pixels.loadImage(bytes)); hashes.push(await sha256(bytes));
    }
    const scale = Math.max(1, ...decoded.flatMap((image, index) => [image.width / sources[index].width, image.height / sources[index].height]));
    const nativeWidth = Math.ceil(width * scale), nativeHeight = Math.ceil(height * scale);
    if (nativeWidth * nativeHeight > 16 * 1024 * 1024) throw new Error("连续网格纹理超过 1600 万像素，请先降低部件分辨率。");
    canvas = pixels.createCanvas(nativeWidth, nativeHeight);
    const context = canvas.getContext("2d");context.scale(nativeWidth / width, nativeHeight / height);
    for (const part of [...sources].sort((a, b) => a.z - b.z))
      context.drawImage(decoded[sources.indexOf(part)], part.x - x, part.y - y, part.width, part.height);
    const image = imageDataURL(new Uint8Array(await pixels.encode(canvas)));
    const influences = [...new Set(sources.flatMap((part) => part.influences || [part.bone]))];
    const combined = { id, label: `${upper.label} + ${lower.label} · 连续网格`, bone: upper.bone, x, y, width, height, z: upper.z,
      binding: "mesh", influences, mesh: { cols: 5, rows: 8 }, attachmentGroup: groups[0], image,
      imageSource: "calibrated", completion: "ready", critical: true,
      composition: { kind: "continuous-limb", motionId, sourcePartIds: [upperId, lowerId], sourceImageSHA256: hashes,
        sourceGrid: { x, y, width, height }, nativeWidth, nativeHeight, hiddenSurfaces: "inherited-from-source-parts" } };
    const renames = new Map(sources.map((part, index) => [`slot_${part.id}`, `group_${groups[index]}`]));
    const parts = doc.parts.filter((part) => part.id !== id).map((part) => sources.includes(part)
      ? { ...part, attachmentGroup: groups[sources.indexOf(part)] } : part);
    parts.push(combined);
    const motions = doc.motions.map((item) => ({ ...item, poses: item.poses.map((pose) => ({ ...pose,
      ...(pose.drawOrder ? { drawOrder: pose.drawOrder.map((slot) => renames.get(slot) || slot) } : {}),
      ...(item.id === motionId ? { attachments: { ...pose.attachments, [groups[0]]: id, [groups[1]]: null } } : {}),
    })) }));
    return validateRigDocument({ ...doc, parts, motions,
      defaultAttachments: { ...doc.defaultAttachments, [groups[0]]: upperId, [groups[1]]: lowerId } });
  } finally {
    for (const image of decoded) image.close?.();
    if (canvas) { canvas.width = 1; canvas.height = 1; }
  }
}

import { alphaBounds } from "../images/calibration.js";
import { cleanPath } from "./paths.js";
import { drawReplacement } from "../images/calibration.js";
import { identityTransform } from "../images/calibration.js";
import { MAX_PACKAGE_BYTES } from "./zip.js";
import { MAX_PACKAGE_FILES } from "./zip.js";
import { parseBundle } from "./bundle.js";
import { sha256 } from "../../shared/codec/sha256.mjs";

const PREFIX = ".ispine/template-variants/";

const MANIFEST = `${PREFIX}manifest.json`;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const clone = (value) => structuredClone(value);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const plain = (value) => value && typeof value === "object" && !Array.isArray(value);

const fail = (message) => { throw new Error(message); };

const bytes = (value, label) => value instanceof Uint8Array && value.length ? value : fail(`${label}缺少有效文件。`);

const atlasAlias = (path) => /\.atlas$/i.test(path) ? `${path}.txt` : path;

const ownedFile = (value) => typeof value === "string" && cleanPath(value) === value && value.startsWith(PREFIX);

function originalFile(files, value, label) {
  if (!plain(value) || typeof value.path !== "string" || cleanPath(value.path) !== value.path || value.path.startsWith(PREFIX) || !ownedFile(value.backupPath)) fail(`${label}的原始文件记录无效。`);
  const data = bytes(files[value.backupPath], label);
  if (sha256(data) !== value.sha256) fail(`${label}原始文件指纹不匹配，不能恢复。`);
  return data;
}

function readManifest(bundle) {
  const files = bundle?.files;
  if (!files || !bundle.skeletonPath) fail("请先载入模板资源。");
  if (!files[MANIFEST]) {
    if (Object.keys(files).some((path) => path.startsWith(PREFIX))) fail("模板变体目录存在文件但缺少清单，请重新导入完整资源。");
    return null;
  }
  let manifest;
  try { if (files[MANIFEST].length > 2 * 1024 * 1024) fail("清单过大"); manifest = JSON.parse(decoder.decode(files[MANIFEST])); } catch { fail("模板变体清单无法读取。"); }
  if (manifest.version !== 1 || !plain(manifest.base) || !Array.isArray(manifest.base.atlases) || !manifest.base.atlases.length || !Array.isArray(manifest.variants) || manifest.variants.length > 128 || !Array.isArray(manifest.controls)) fail("模板变体清单版本或结构无效。");
  originalFile(files, manifest.base.skeleton, "骨架");
  for (const atlas of manifest.base.atlases) originalFile(files, atlas, "Atlas");
  const ids = new Set(), allowed = new Set([MANIFEST, manifest.base.skeleton.backupPath, ...manifest.base.atlases.map((value) => value.backupPath)]);
  for (const variant of manifest.variants) {
    if (!plain(variant) || typeof variant.regionId !== "string" || !/^tv_[a-f0-9]{20}$/.test(variant.regionId) || ids.has(variant.regionId) || !Array.isArray(variant.animations) || !plain(variant.binding) || !plain(variant.attachmentDefinition) || !plain(variant.provenance)) fail("模板变体定义无效或重复。");
    ids.add(variant.regionId);
    for (const key of ["nativePath", "pageFile", "atlasFile"]) if (!ownedFile(variant[key])) fail("模板变体图片路径无效。");
    const native = bytes(files[variant.nativePath], "原生候选图");
    if (sha256(native) !== variant.nativeSHA256) fail("模板变体原生候选图指纹不匹配。");
    bytes(files[variant.pageFile], "变体贴图页"); bytes(files[variant.atlasFile] || files[atlasAlias(variant.atlasFile)], "变体 Atlas");
    const region = bundle.parts?.find((part) => part.id === variant.regionId), shape = variant.normalization;
    if (!region || !shape || region.pageFile !== variant.pageFile || ["width", "height", "originalWidth", "originalHeight", "offsetX", "offsetY", "degrees"].some((key) => region[key] !== shape[key])) fail("模板变体 Atlas 区域缺失或几何已改变。");
    allowed.add(variant.nativePath); allowed.add(variant.pageFile); allowed.add(variant.atlasFile); allowed.add(atlasAlias(variant.atlasFile));
  }
  if (Object.keys(files).some((path) => path.startsWith(PREFIX) && !allowed.has(path))) fail("模板变体目录存在未登记文件，不能覆盖或删除。");
  return manifest;
}

function originalJSON(bundle, manifest) {
  return JSON.parse(decoder.decode(manifest ? originalFile(bundle.files, manifest.base.skeleton, "骨架") : bytes(bundle.files[bundle.skeletonPath], "骨架")));
}

function findBinding(json, partId) {
  if (!Array.isArray(json.skins) || !Array.isArray(json.slots) || !plain(json.animations)) fail("当前只支持带明确 Skin/Slot 的 Spine JSON 模板。");
  const found = [];
  for (const skin of json.skins) for (const [slotName, attachments] of Object.entries(skin.attachments || {})) for (const [attachmentName, attachment] of Object.entries(attachments))
    if ((attachment.path || attachmentName) === partId) found.push({ skinName: skin.name, slotName, attachmentName, attachment });
  if (found.length !== 1) fail("该纹理存在跨 Skin / Slot 的多重绑定或没有附件，不能自动添加变体。");
  const binding = found[0], slot = json.slots.find((slot) => slot.name === binding.slotName);
  if (!slot || slot.attachment !== binding.attachmentName) fail("请选择该插槽的默认区域附件创建变体。");
  if ((binding.attachment.type || "region") !== "region" || binding.attachment.sequence !== undefined) fail("首版表情变体仅支持普通 region 附件，不能修改 mesh 或序列附件。");
  return binding;
}

function checkedTransform(input = identityTransform()) {
  if (!plain(input)) fail("变体校准参数无效。");
  const output = { ...identityTransform(), ...input };
  for (const key of ["x", "y", "scaleX", "scaleY", "rotation"]) if (!Number.isFinite(output[key]) || Math.abs(output[key]) > 32768) fail("变体校准参数无效。");
  if (output.scaleX <= 0 || output.scaleY <= 0 || ![true, false].includes(output.flipX) || ![true, false].includes(output.flipY)) fail("变体校准缩放或翻转无效。");
  return Object.fromEntries(Object.keys(identityTransform()).map((key) => [key, output[key]]));
}

function checkControls(json, controls) {
  for (const control of controls) if (!plain(control) || !same(json.animations?.[control.animationId]?.slots?.[control.slotName]?.attachment, control.timeline)) fail("模板变体的附件切换已被外部修改，请先恢复或另存，不能静默覆盖。");
}

function applyDefinitions(json, original, variants) {
  const controls = [], slots = new Map();
  for (const variant of variants) {
    const { skinName, slotName, attachmentName } = variant.binding, skin = json.skins.find((skin) => skin.name === skinName);
    if (!skin?.attachments?.[slotName]?.[attachmentName]) fail("模板原始附件已丢失，不能加入变体。");
    skin.attachments[slotName][variant.regionId] = clone(variant.attachmentDefinition);
    if (!slots.has(slotName)) slots.set(slotName, { attachmentName, variants: [] });
    const group = slots.get(slotName); if (group.attachmentName !== attachmentName) fail("同一插槽的多个原始附件存在歧义。"); group.variants.push(variant);
  }
  for (const [slotName, group] of slots) for (const [animationId, animation] of Object.entries(json.animations)) {
    if (!Object.hasOwn(original.animations, animationId)) fail("新增动画没有冻结的原始附件时间线，不能自动覆盖。");
    const chosen = group.variants.filter((variant) => variant.animations.includes(animationId)); if (chosen.length > 1) fail(`动作 ${animationId} 已指定另一个表情变体，请勿重复分配。`);
    const source = original.animations[animationId].slots?.[slotName]?.attachment || [];
    if (!Array.isArray(source) || source.some((key, index) => !plain(key) || key.name !== group.attachmentName || !Number.isFinite(key.time ?? 0) || (key.time ?? 0) < 0 || (index > 0 && (key.time ?? 0) < (source[index - 1].time ?? 0))))
      fail(`动作 ${animationId} 已有不兼容的附件切换，不能静默覆盖。`);
    const name = chosen[0]?.regionId || group.attachmentName, timeline = source.map((key) => ({ ...clone(key), name }));
    if (!timeline.length || (timeline[0].time ?? 0) > 0) timeline.unshift({ time: 0, name });
    animation.slots ||= {}; animation.slots[slotName] = { ...animation.slots[slotName], attachment: timeline };
    controls.push({ animationId, slotName, timeline: clone(timeline) });
  }
  return controls;
}

function packageBounds(files) {
  if (Object.keys(files).length > MAX_PACKAGE_FILES || Object.values(files).reduce((size, value) => size + value.length, 0) > MAX_PACKAGE_BYTES) fail("加入变体后资源超过导出文件数或 256 MB 限制，请拆分资源。");
}

/** User-facing labels remain separate from stable region identifiers. */
function templateVariantEntries(bundle) {
  return (readManifest(bundle)?.variants || []).map(({ regionId, originalPartId, name, animations }) => ({
    regionId, originalPartId, name, animations: [...animations],
  }));
}

/** Restore the frozen template geometry/atlases; leave original texture bytes alone. */
function templateVariantBase(bundle) {
  const manifest = readManifest(bundle); if (!manifest) return bundle;
  const files = Object.fromEntries(Object.entries(bundle.files).filter(([path]) => !path.startsWith(PREFIX)));
  files[manifest.base.skeleton.path] = originalFile(bundle.files, manifest.base.skeleton, "骨架").slice();
  for (const atlas of manifest.base.atlases) { delete files[atlasAlias(atlas.path)]; files[atlas.path] = originalFile(bundle.files, atlas, "Atlas").slice(); }
  return parseBundle(files, { skeletonPath: manifest.base.skeleton.path, id: bundle.id, name: bundle.name });
}

/** Add a region-only expression without changing its world quad or other channels. */
async function addTemplateVariant(bundle, { partId, image, name, animations, provenance, transform = identityTransform() } = {}, pixelEnv) {
  if (bundle?.binary || !bundle?.json) fail("首版模板附件变体只支持 JSON，暂不支持二进制骨架。");
  const env = pixelEnv, manifest = readManifest(bundle), original = originalJSON(bundle, manifest);
  const json = JSON.parse(decoder.decode(bytes(bundle.files[bundle.skeletonPath], "骨架")));
  if (!same(json, bundle.json)) fail("骨架内存数据与文件不一致，请重新载入完整资源。");
  if (manifest) { checkControls(json, manifest.controls); for (const variant of manifest.variants) {
    const attachment = json.skins?.find((skin) => skin.name === variant.binding.skinName)?.attachments?.[variant.binding.slotName]?.[variant.regionId];
    if (!same(attachment, variant.attachmentDefinition)) fail("已登记的变体附件几何已改变，不能静默覆盖。");
  } }
  const part = bundle.parts.find((part) => part.id === partId); if (!part || manifest?.variants.some((variant) => variant.regionId === partId)) fail("请选择原始模板中存在的部件创建变体。");
  const binding = findBinding(original, partId);
  if (!same(json.skins?.find((skin) => skin.name === binding.skinName)?.attachments?.[binding.slotName]?.[binding.attachmentName], binding.attachment) || json.slots.find((slot) => slot.name === binding.slotName)?.attachment !== binding.attachmentName) fail("原始模板附件几何或默认附件已改变，不能自动加入变体。");
  if (typeof name !== "string" || !name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) fail("请填写有效的表情变体名称。");
  name = name.trim().normalize("NFC");
  if (!Array.isArray(animations) || !animations.length || new Set(animations).size !== animations.length || animations.some((id) => typeof id !== "string" || !Object.hasOwn(original.animations, id) || !Object.hasOwn(json.animations, id))) fail("请选择存在且不重复的目标动作。");
  animations = Object.keys(original.animations).filter((id) => animations.includes(id));
  if (!plain(provenance) || ["jobId", "imageId"].some((key) => typeof provenance[key] !== "string" || !provenance[key].trim() || provenance[key].length > 160 || /[\u0000-\u001f\u007f]/.test(provenance[key]))) fail("变体缺少明确的生成任务与候选图片来源。");
  provenance = { jobId: provenance.jobId, imageId: provenance.imageId };
  bytes(image, "原生候选图"); if (image.length > 32 * 1024 * 1024 || ![137,80,78,71,13,10,26,10].every((value, index) => image[index] === value)) fail("变体候选必须是 32 MB 以内的原生 PNG。");
  const native = image.slice(), nativeSHA256 = sha256(native), regionId = `tv_${sha256(encoder.encode(JSON.stringify({ partId, name }))).slice(0, 20)}`, checked = checkedTransform(transform);
  const existing = manifest?.variants.find((variant) => variant.regionId === regionId);
  if (bundle.parts.some((part) => part.id === regionId) && !existing) fail("新变体 ID 与已有 Atlas 区域碰撞，不能覆盖。");
  if (existing && (existing.originalPartId !== partId || existing.name !== name)) fail("新变体 ID 与已有变体定义碰撞。");
  if (existing && existing.nativeSHA256 === nativeSHA256 && same(existing.animations, animations) && same(existing.transform, checked) && same(existing.provenance, provenance))
    return { bundle, partId: regionId, edit: { image: native, fileName: `${name}.png`, transform: clone(checked) }, metadata: { ...clone(existing), unchanged: true } };
  const files = { ...bundle.files }, next = manifest ? clone(manifest) : { version: 1, base: { skeleton: { path: bundle.skeletonPath, backupPath: `${PREFIX}base/skeleton.bin`, sha256: sha256(files[bundle.skeletonPath]) }, atlases: bundle.atlasPaths.map((path, index) => ({ path, backupPath: `${PREFIX}base/atlas-${index}.bin`, sha256: sha256(files[path]) })) }, variants: [], controls: [] };
  if (!manifest) { files[next.base.skeleton.backupPath] = files[bundle.skeletonPath].slice(); for (const atlas of next.base.atlases) files[atlas.backupPath] = files[atlas.path].slice(); }
  const nativePath = `${PREFIX}native/${regionId}.png`, pageFile = `${PREFIX}pages/${regionId}.png`, atlasFile = `${PREFIX}pages/${regionId}.atlas`;
  const identities = new Map(Object.keys(files).map((path) => [path.normalize("NFC").toLowerCase(), path]));
  for (const path of [MANIFEST, nativePath, pageFile, atlasFile]) { const collision = identities.get(path.normalize("NFC").toLowerCase()); if (collision && !(path === MANIFEST && manifest) && !(existing && [existing.nativePath, existing.pageFile, existing.atlasFile, atlasAlias(existing.atlasFile)].includes(collision))) fail(`变体文件路径碰撞：${collision}`); }
  const pageWidth = part.packedWidth + 4, pageHeight = part.packedHeight + 4;
  if (pageWidth > 16384 || pageHeight > 16384) fail("变体贴图页超过运行库尺寸限制。");
  let bitmap, material, crop, page, encoded, clippedVisiblePixels = 0;
  try {
    bitmap = await env.loadImage(native);
    if (!Number.isInteger(bitmap.width) || !Number.isInteger(bitmap.height) || bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 16384 || bitmap.height > 16384 || bitmap.width * bitmap.height > 64 * 1024 * 1024) fail("变体原生图片尺寸无效或过大。");
    material = env.createCanvas(part.originalWidth, part.originalHeight); const context = material.getContext("2d"); drawReplacement(context, bitmap, part, checked);
    const pixels = context.getImageData(0, 0, material.width, material.height), top = part.originalHeight - part.offsetY - part.height;
    if (!alphaBounds(pixels)) fail("变体图片在逻辑帧中没有有效可见像素，请检查图片和校准。");
    for (let y = 0; y < material.height; y++) for (let x = 0; x < material.width; x++) if (pixels.data[(y * material.width + x) * 4 + 3] > 8 && (x < part.offsetX || x >= part.offsetX + part.width || y < top || y >= top + part.height)) clippedVisiblePixels++;
    crop = env.createCanvas(part.width, part.height); crop.getContext("2d").drawImage(material, part.offsetX, top, part.width, part.height, 0, 0, part.width, part.height);
    if (!alphaBounds(crop.getContext("2d").getImageData(0, 0, part.width, part.height))) fail("变体图片完全落在原始裁切区外，请先校准。");
    page = env.createCanvas(pageWidth, pageHeight); const target = page.getContext("2d");
    if (part.degrees === 90) { target.translate(2, 2 + part.width); target.rotate(-Math.PI / 2); target.drawImage(crop, 0, 0); }
    else if (!part.degrees) target.drawImage(crop, 2, 2); else fail("首版变体只支持 0° / 90° Atlas 区域。");
    encoded = new Uint8Array(await env.encode(page));
  } finally { bitmap?.close?.(); for (const canvas of [material, crop, page]) if (canvas) { canvas.width = 1; canvas.height = 1; } }
  const metadata = { regionId, originalPartId: partId, name, animations, binding: { skinName: binding.skinName, slotName: binding.slotName, attachmentName: binding.attachmentName },
    attachmentDefinition: { ...clone(binding.attachment), path: regionId }, nativePath, nativeSHA256, pageFile, atlasFile, provenance, transform: checked,
    normalization: { mode: "contain-logical-frame-then-calibrate", originalWidth: part.originalWidth, originalHeight: part.originalHeight, width: part.width, height: part.height, offsetX: part.offsetX, offsetY: part.offsetY, degrees: part.degrees,
      clippedVisiblePixels, preservesWorldQuad: true, pma: false }, warnings: clippedVisiblePixels ? ["候选有可见像素超出原区域裁切范围，请在部件校准中检查；原生 PNG 已完整保留。"] : [] };
  next.variants = next.variants.filter((variant) => variant.regionId !== regionId); next.variants.push(metadata);
  if (next.variants.length > 128) fail("单个模板最多添加 128 个附件变体。");
  next.controls = applyDefinitions(json, original, next.variants);
  files[nativePath] = native; files[pageFile] = encoded;
  if (atlasAlias(atlasFile) !== atlasFile) delete files[atlasAlias(atlasFile)];
  files[atlasFile] = encoder.encode([`${regionId}.png`, `size:${pageWidth},${pageHeight}`, "filter:Linear,Linear", "pma:false", regionId,
    `bounds:2,2,${part.width},${part.height}`, `offsets:${part.offsetX},${part.offsetY},${part.originalWidth},${part.originalHeight}`, `rotate:${part.degrees}`, ""].join("\n"));
  files[bundle.skeletonPath] = encoder.encode(JSON.stringify(json)); files[MANIFEST] = encoder.encode(JSON.stringify(next)); packageBounds(files);
  const result = parseBundle(files, { skeletonPath: bundle.skeletonPath, id: bundle.id, name: bundle.name });
  result.parts.find((part) => part.id === regionId).name = `${part.name} · ${name}`;
  return { bundle: result, partId: regionId, edit: { image: native.slice(), fileName: `${name}.png`, transform: clone(checked) }, metadata: { ...clone(metadata), unchanged: false } };
}

export { addTemplateVariant, templateVariantBase, templateVariantEntries };

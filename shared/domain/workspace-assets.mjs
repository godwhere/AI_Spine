// Storage format 2 is independent of project/archive and rig document versions.
// Only these authored fields contain externalized assets. Unknown fields stay
// in the document; never search arbitrary strings for image-looking content.
export const WORKSPACE_FORMAT = 2;
export const MAX_WORKSPACE_BYTES = 256 * 1024 * 1024;
export const MAX_WORKSPACE_ASSETS = 4096;
export const WORKSPACE_NAMESPACES = Object.freeze({ projects: "ai-spine-local-workbench", drafts: "ispine-rig-drafts", templates: "ai-spine-custom-templates" });

import { encodeBase64, decodeBase64 } from "../codec/base64.mjs";

const fail = (message) => { throw Object.assign(new Error(message), { code: "WORKSPACE_ASSET_INVALID" }); };
const own = (value, key) => value != null && Object.hasOwn(value, key);
const at = (value, path) => path.reduce((item, key) => own(item, key) ? item[key] : undefined, value);
const keyOf = (path) => JSON.stringify(path);
const placeholder = () => ({ $ispineAsset: WORKSPACE_FORMAT });
const isPlaceholder = (value) => value && typeof value === "object" && Object.keys(value).length === 1 && value.$ispineAsset === WORKSPACE_FORMAT;
function replace(value, path, item) {
  const parent = at(value, path.slice(0, -1)), key = path.at(-1);
  if (!own(parent, key)) fail("素材路径不存在。");
  Object.defineProperty(parent, key, { value: item, writable: true, enumerable: true, configurable: true });
}
function imageSlots(rig, prefix, slots) {
  if (!rig || typeof rig !== "object") return;
  const add = (path) => { if (at(rig, path) != null && at(rig, path) !== "") slots.push({ path: [...prefix, ...path], kind: "image", maxBytes: 32 * 1024 * 1024 }); };
  add(["sourceImage"]); add(["appearanceReference", "image"]);
  for (const [i, part] of (rig.parts || []).entries()) {
    if (part?.image != null && part.image !== "") add(["parts", String(i), "image"]);
    add(["parts", String(i), "registrationBase", "image"]);
  }
  for (const [motion, study] of Object.entries(rig.motionStudies || {})) for (const [i, frame] of (study.frames || []).entries()) {
    add(["motionStudies", motion, "frames", String(i), "image"]);
    add(["motionStudies", motion, "frames", String(i), "composition"]);
    for (const [j] of (frame.segments || []).entries()) add(["motionStudies", motion, "frames", String(i), "segments", String(j), "image"]);
  }
}

// Markers are recognized only at known asset fields. The same object anywhere
// else is unknown authored data and remains untouched. Optional nulls also stay.
export function workspaceAssetSlots(namespace, store, record) {
  const slots = [], add = (path, kind = "binary") => {
    const value = at(record, path);
    if (value !== undefined && value !== null) slots.push({ path, kind, maxBytes: MAX_WORKSPACE_BYTES });
  };
  const files = () => { for (const path of Object.keys(record.files || {})) slots.push({ path: ["files", path], kind: "binary", maxBytes: MAX_WORKSPACE_BYTES }); };
  if (namespace === WORKSPACE_NAMESPACES.projects && store === "projects") {
    files();
    for (const name of Object.keys(record.edits || {})) add(["edits", name, "image"]);
    add(["generation", "appearance", "image"]);
    if ((typeof record.thumbnail === "string" && record.thumbnail.startsWith("data:")) || isPlaceholder(record.thumbnail)) add(["thumbnail"], "image");
  } else if (namespace === WORKSPACE_NAMESPACES.templates && ["files", "metadata"].includes(store)) {
    if (store === "files") files();
    if ((typeof record.thumbnail === "string" && record.thumbnail.startsWith("data:")) || isPlaceholder(record.thumbnail)) add(["thumbnail"], "image");
  }
  else if (namespace === WORKSPACE_NAMESPACES.drafts && store === "documents") {
    imageSlots(record.document, ["document"], slots);
  }
  if (slots.length > MAX_WORKSPACE_ASSETS) fail("工程素材超过 4096 个，请拆分后保存。");
  return slots;
}

export function workspaceAssetData(value, slot, { copy = true } = {}) {
  if (slot.kind === "binary") {
    if (value instanceof Uint8Array) return { bytes: copy ? value.slice() : value, encoding: { type: "Uint8Array" } };
    if (value instanceof ArrayBuffer) return { bytes: new Uint8Array(copy ? value.slice(0) : value), encoding: { type: "ArrayBuffer" } };
    fail("工程文件或替换图必须是原始二进制。");
  }
  const match = typeof value === "string" && /^(data:image\/(?:png|jpeg|jpg|webp|gif);base64,)([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match || !match[2] || match[2].length % 4 === 1) fail("本地图片编码无效，未改变原图片。");
  const bytes = decodeBase64(match[2]);
  if (encodeBase64(bytes).replace(/=+$/, "") !== match[2].replace(/=+$/, "")) fail("图片编码不能无损还原，未完成素材转换。");
  return { bytes, encoding: { type: "data-url", prefix: match[1], padding: (match[2].match(/=+$/) || [""])[0].length } };
}

export function workspaceDocument(record, slots) {
  const root = { children: new Map() };
  for (const slot of slots) {
    let node = root;
    for (const key of slot.path) { if (!node.children.has(key)) node.children.set(key, { children: new Map() }); node = node.children.get(key); }
    node.asset = true;
  }
  const strip = (value, node) => {
    if (node.asset) return placeholder();
    if (!node.children.size) return value;
    const result = Array.isArray(value) ? [...value] : { ...value };
    for (const [key, child] of node.children) Object.defineProperty(result, key, { value: strip(value[key], child), enumerable: true, writable: true, configurable: true });
    return result;
  };
  // Strip source bytes before cloning author metadata; never clone hundreds of
  // MiB only to immediately replace those copied images with placeholders.
  return structuredClone(strip(record, root));
}

export function decomposeWorkspaceRecord(namespace, store, record) {
  const slots = workspaceAssetSlots(namespace, store, record), assets = [];
  let size = 0;
  for (const slot of slots) {
    const value = workspaceAssetData(at(record, slot.path), slot);
    if (value.bytes.byteLength > slot.maxBytes) fail("单张图片或工程素材超过大小限制。");
    size += value.bytes.byteLength;
    if (size > MAX_WORKSPACE_BYTES) fail("工程素材总量超过 256 MiB。");
    assets.push({ path: slot.path, ...value });
  }
  return { document: workspaceDocument(record, slots), assets };
}

export function validateWorkspaceReferences(namespace, store, document, refs) {
  if (!document || typeof document !== "object" || !Array.isArray(refs) || refs.length > MAX_WORKSPACE_ASSETS) fail("工程文档或素材引用无效。");
  // Inline images in a known field would evade transfer limits and deduplication.
  const slots = new Map(workspaceAssetSlots(namespace, store, document).map((slot) => [keyOf(slot.path), slot]));
  if ([...slots.values()].some((slot) => !isPlaceholder(at(document, slot.path)))) fail("版本 2 文档必须通过素材引用提交图片。");
  if (refs.length !== slots.size) fail("工程素材引用缺失或重复。");
  let total = 0;
  for (const ref of refs) {
    if (!ref || !Array.isArray(ref.path) || ref.path.some((key) => typeof key !== "string")) fail("工程素材路径无效。");
    if (Object.keys(ref).some((key) => !["path", "hash", "size", "encoding"].includes(key))) fail("素材引用包含未知字段。");
    const key = keyOf(ref.path), slot = slots.get(key); slots.delete(key);
    if (!slot || !/^[a-f0-9]{64}$/.test(ref.hash) || !Number.isSafeInteger(ref.size) || ref.size < 0 || (slot.kind === "image" && ref.size === 0) || ref.size > slot.maxBytes) fail("工程素材引用无效或超限。");
    const encoding = ref.encoding;
    if (!encoding || (slot.kind === "binary" ? !["Uint8Array", "ArrayBuffer"].includes(encoding.type) : encoding.type !== "data-url")) fail("工程素材编码与字段不匹配。");
    if (encoding.type === "data-url" && (!/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,$/i.test(encoding.prefix) || !Number.isInteger(encoding.padding) || encoding.padding < 0 || encoding.padding > 2)) fail("图片引用编码无效。");
    const keys = encoding.type === "data-url" ? ["type", "prefix", "padding"] : ["type"];
    if (Object.keys(encoding).some((key) => !keys.includes(key))) fail("图片引用包含未知编码规则。");
    total += ref.size;
    if (total > MAX_WORKSPACE_BYTES) fail("工程素材总量超过 256 MiB。");
  }
  return total;
}

export function composeWorkspaceRecord(namespace, store, document, refs, getBytes) {
  validateWorkspaceReferences(namespace, store, document, refs);
  const record = structuredClone(document);
  for (const ref of refs) {
    const bytes = getBytes(ref.hash);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== ref.size) fail("工程缺少完整素材字节。");
    let value;
    if (ref.encoding.type === "data-url") value = ref.encoding.prefix + encodeBase64(bytes).replace(/=+$/, "") + "=".repeat(ref.encoding.padding);
    else value = ref.encoding.type === "ArrayBuffer" ? bytes.slice().buffer : bytes.slice();
    replace(record, ref.path, value);
  }
  return record;
}

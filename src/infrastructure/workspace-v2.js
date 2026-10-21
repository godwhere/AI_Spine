import { composeWorkspaceRecord, validateWorkspaceReferences, workspaceAssetSlots, workspaceAssetData, workspaceDocument,
  WORKSPACE_NAMESPACES as NS } from "../../shared/domain/workspace-assets.mjs";
import { encodeWorkspace } from "../../shared/workspace-codec.mjs";

const failure = (code, message) => Object.assign(new Error(message), { code });
const layouts = { projects: [NS.projects, "projects"], drafts: [NS.drafts, "documents"], templates: [NS.templates, "files"] };
const at = (value, path) => path.reduce((item, key) => item && Object.hasOwn(item, key) ? item[key] : undefined, value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const defaultHash = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
async function bounded(items, action) {
  let cursor = 0, failure; const result = [];
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (!failure && cursor < items.length) {
      const i = cursor++;
      try { result[i] = await action(items[i], i); } catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return result;
}

export function createWorkspaceV2Client({ request, rawRequest, hash = defaultHash, createId = () => crypto.randomUUID(), cacheBytes = 64 * 1024 * 1024 }) {
  const binaryHashes = new WeakMap(), imageHashes = new WeakMap(), downloads = new Map(), downloading = new Map(), mutations = new Map();
  let downloadedBytes = 0;
  function cacheInfo(record, path, info) {
    const value = at(record, path);
    if (value && typeof value === "object") binaryHashes.set(value, Promise.resolve(info));
    else {
      const parent = at(record, path.slice(0, -1));
      if (!imageHashes.has(parent)) imageHashes.set(parent, new Map());
      imageHashes.get(parent).set(path.at(-1), { source: value, info: Promise.resolve(info) });
    }
  }
  function remember(digest, bytes) {
    if (bytes.byteLength > cacheBytes) return;
    const old = downloads.get(digest); if (old) { downloadedBytes -= old.byteLength; downloads.delete(digest); }
    downloads.set(digest, bytes); downloadedBytes += bytes.byteLength;
    while (downloadedBytes > cacheBytes || downloads.size > 256) { const first = downloads.keys().next().value; downloadedBytes -= downloads.get(first).byteLength; downloads.delete(first); }
  }
  async function blob(digest, size) {
    if (downloads.has(digest)) { const bytes = downloads.get(digest); remember(digest, bytes); return bytes; }
    if (!downloading.has(digest)) {
      const promise = (async () => {
        const response = await rawRequest(`v2/blobs/${digest}`), bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== size || await hash(bytes) !== digest) throw failure("ASSET_CORRUPT", "收到的素材与原始指纹不一致，未使用损坏图片。");
        remember(digest, bytes); return bytes;
      })().finally(() => downloading.delete(digest));
      downloading.set(digest, promise);
    }
    return downloading.get(digest);
  }
  async function read(collection, operation, id) {
    const value = (await request(`v2/${collection}`, { operation, id })).value;
    if (!value) return null;
    const [namespace, store] = layouts[collection], { document, refs } = value.payload;
    validateWorkspaceReferences(namespace, store, document, refs);
    const bytes = new Map(await bounded([...new Map(refs.map((ref) => [ref.hash, ref])).values()], async (ref) => [ref.hash, await blob(ref.hash, ref.size)]));
    const record = composeWorkspaceRecord(namespace, store, document, refs, (digest) => bytes.get(digest));
    for (const { path, ...info } of refs) cacheInfo(record, path, info);
    return record;
  }
  async function plan(collection, record) {
    const [namespace, store] = layouts[collection], slots = workspaceAssetSlots(namespace, store, record), sources = new Map();
    const refs = await bounded(slots, async (slot) => {
      const value = at(record, slot.path), parent = at(record, slot.path.slice(0, -1)), key = slot.path.at(-1);
      let cached;
      if (typeof value === "object" && value) cached = binaryHashes.get(value);
      else cached = imageHashes.get(parent)?.get(key)?.source === value ? imageHashes.get(parent).get(key).info : undefined;
      if (!cached) {
        const { bytes, encoding } = workspaceAssetData(value, slot, { copy: false });
        cached = Promise.resolve(hash(bytes)).then((digest) => ({ hash: digest, size: bytes.byteLength, encoding }));
        if (typeof value === "object" && value) binaryHashes.set(value, cached);
        else { if (!imageHashes.has(parent)) imageHashes.set(parent, new Map()); imageHashes.get(parent).set(key, { source: value, info: cached }); }
        cached.catch(() => { if (typeof value === "object" && value) binaryHashes.delete(value); else imageHashes.get(parent)?.delete(key); });
      }
      const info = await cached;
      sources.set(info.hash, () => workspaceAssetData(value, slot, { copy: false }).bytes);
      return { path: slot.path, ...info };
    });
    const document = workspaceDocument(record, slots);
    validateWorkspaceReferences(namespace, store, document, refs);
    return { payload: { document, refs }, sources };
  }
  const head = async (collection, id) => (await request(`v2/${collection}`, { operation: "head", id })).value;
  function trim() {
    let settledBytes = [...mutations.values()].reduce((sum, entry) => sum + (entry.settled ? entry.cost : 0), 0);
    for (const [key, entry] of mutations) {
      if (mutations.size <= 64 && settledBytes <= 8 * 1024 * 1024) break;
      if (entry.settled) { settledBytes -= entry.cost; mutations.delete(key); }
    }
  }
  async function send(collection, body) {
    try { return (await request(`v2/${collection}`, body)).value; }
    catch (error) { if (error.code) throw error; return (await request(`v2/${collection}`, body)).value; }
  }
  async function upload(entry) {
    const { body } = entry, hashes = [...new Set(body.payload.refs.map((ref) => ref.hash))];
    const query = await request("v2/blobs/query", { hashes, leaseId: body.leaseId });
    if (!Array.isArray(query.missing) || query.missing.some((digest) => !hashes.includes(digest))) throw failure("WORKSPACE_RESPONSE_INVALID", "素材查询返回了未知引用。");
    await bounded(query.missing, async (digest) => {
      const getBytes = entry.sources?.get(digest);
      if (!getBytes) throw failure("ASSET_MISSING", "原提交的素材已不在当前会话，请保留本地修改并重新打开工程。");
      const bytes = getBytes();
      const response = await rawRequest(`v2/blobs/${digest}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-iSpine-Upload": body.leaseId }, body: bytes });
      const uploaded = await response.json();
      if (uploaded.hash !== digest || uploaded.size !== bytes.byteLength) throw new Error("素材上传回执不完整，请重试以核对原提交。");
      remember(digest, bytes);
    });
  }
  async function save(collection, value, options = {}) {
    const id = collection === "drafts" ? options.resourceId ? `resource-${options.resourceId}` : value.id : value.id;
    const record = collection === "drafts" ? { id, document: value } : value;
    const prepared = await plan(collection, record), mutationId = options.mutationId || createId(), key = JSON.stringify([collection, id, mutationId]);
    const { mutationId: omittedId, expectedUpdatedAt: omittedVersion, previousDraftUpdatedAt: omittedPrevious, ...authoredOptions } = options;
    let signatureDocument = prepared.payload.document, signatureRefs = prepared.payload.refs;
    if (collection === "projects") {
      const { thumbnail, updatedAt, createdAt, boneCount, partCount, animationCount, ...authored } = signatureDocument;
      signatureDocument = authored; signatureRefs = signatureRefs.filter((ref) => ref.path[0] !== "thumbnail");
    }
    const signature = await hash(new TextEncoder().encode(JSON.stringify(canonical(encodeWorkspace({ document: signatureDocument, refs: signatureRefs, options: authoredOptions })))));
    let entry = mutations.get(key), first = !entry;
    if (entry && entry.signature !== signature) throw failure("MUTATION_REUSED", "同一保存标识不能用于不同作者修改。");
    if (!entry) {
      const current = await head(collection, id), expected = options.expectedUpdatedAt;
      if (expected !== undefined && (expected === null ? Boolean(current) : current?.updatedAt !== expected))
        throw failure(collection === "drafts" ? "DRAFT_CHANGED" : "RESOURCE_CHANGED", "其他工作台已修改此记录，本地修改仍保留。请重新打开或另存。");
      const expectedVersion = expected !== undefined || collection === "templates" ? current?.version || 0 : 0;
      const { mutationId: omittedMutation, previousDraftUpdatedAt, ...wireOptions } = options;
      if (wireOptions.expectedUpdatedAt === null) delete wireOptions.expectedUpdatedAt;
      const body = { operation: "save", id, mutationId, expectedVersion, payload: prepared.payload, options: wireOptions, leaseId: createId() };
      if (collection === "drafts" && options.previousDraftId && options.previousDraftId !== id) {
        const previous = await head(collection, options.previousDraftId);
        if (previous && (previousDraftUpdatedAt === undefined || previous.updatedAt !== previousDraftUpdatedAt))
          throw failure("DRAFT_CHANGED", "原草稿版本无法确认，未移动它；请重新打开草稿后保存。");
        body.previousDraftVersion = previous?.version || 0;
      }
      entry = { body, signature, sources: prepared.sources, cost: JSON.stringify(encodeWorkspace(body)).length * 2 }; mutations.set(key, entry);
    }
    try {
      if (first) await upload(entry);
      let receipt;
      try { receipt = await send(collection, entry.body); }
      catch (error) { if (error.code !== "ASSET_MISSING") throw error; await upload(entry); receipt = await send(collection, entry.body); }
      if (receipt?.id !== id || !Number.isSafeInteger(receipt.version) || receipt.version < 1 || typeof receipt.updatedAt !== "string" ||
          (collection !== "projects" && (receipt.metadata?.id !== id || receipt.metadata.updatedAt !== receipt.updatedAt)))
        throw new Error("本机保存回执不完整，请重试以核对原提交。");
      entry.settled = true; entry.sources = null; trim();
      if (collection === "projects") return { ...value, updatedAt: receipt.updatedAt };
      if (collection === "drafts") return receipt.metadata;
      return { ...receipt.metadata, ...(value.thumbnail === undefined ? {} : { thumbnail: value.thumbnail }) };
    } catch (error) { if (error.code && !["ASSET_MISSING", "WORKSPACE_MAINTENANCE", "WORKSPACE_REFRESH_REQUIRED"].includes(error.code)) { entry.settled = true; entry.sources = null; trim(); } throw error; }
  }
  return { async call(collection, operation, ...args) {
    if (!layouts[collection]) throw failure("WORKSPACE_OPERATION_INVALID", "本机数据分类不存在。");
    if (["list", "summary"].includes(operation)) return (await request(`v2/${collection}`, { operation })).value;
    if (["get", "read"].includes(operation)) return read(collection, operation, args[0]);
    if (operation === "save") return save(collection, args[0], args[1]);
    if (collection === "projects" && operation === "remove") {
      const ids = [...new Set(args[0] || [])], versions = await bounded(ids, async (id) => [id, (await head(collection, id))?.version || 0]);
      return (await send(collection, { operation, ids, mutationId: createId(), expectedVersions: Object.fromEntries(versions) })).removed;
    }
    if ((collection === "projects" && ["trash", "restore"].includes(operation)) || (collection === "templates" && operation === "delete")) {
      const id = args[0], current = await head(collection, id);
      if (!current && operation === "delete") return false;
      const receipt = await send(collection, { operation, id, expectedVersion: current?.version || 0, mutationId: createId() });
      return operation === "delete" ? receipt.removed : read(collection, "read", id);
    }
    throw failure("WORKSPACE_OPERATION_INVALID", "本机数据操作不存在。");
  } };
}

import { encodeWorkspace, decodeWorkspace } from "../../shared/workspace-codec.mjs";

export function workspaceMiddleware(store, { maxRequestBytes = 256 * 1024 * 1024 } = {}) {
  return async (req, res, next) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (!path.startsWith("/api/workspace/")) return next();
    const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(encodeWorkspace(value))); };
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) || (["POST", "PUT"].includes(req.method) && req.headers.origin !== `http://${host}`))
      return send(403, { error: "本机数据只接受工作台自身的请求。" });
    try {
      if (path === "/api/workspace/status" && req.method === "GET") return send(200, store.status());
      const blob = /^\/api\/workspace\/v2\/blobs\/([a-f0-9]{64})$/.exec(path);
      if (blob && ["GET", "PUT"].includes(req.method)) {
        if (!store.hasAssets()) return send(409, { code: "WORKSPACE_REFRESH_REQUIRED", error: "当前工作区尚未启用格式 2，请刷新工作台。" });
        if (req.method === "GET") {
          const value = store.asset(blob[1], new URL(req.url, "http://127.0.0.1").searchParams.get("leaseId"));
          if (!value) return send(404, { error: "素材没有有效引用或上传租约。", code: "ASSET_MISSING" });
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": value.size, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
          return res.end(value.bytes);
        }
        if (req.headers["content-type"] !== "application/octet-stream") return send(415, { error: "请上传原始二进制素材。" });
        if (Number(req.headers["content-length"]) > maxRequestBytes) return send(413, { error: "本次素材超过大小限制。", code: "ASSET_SIZE_INVALID" });
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > maxRequestBytes) return send(413, { error: "本次素材超过大小限制。", code: "ASSET_SIZE_INVALID" }); chunks.push(chunk); }
        return send(200, store.uploadAsset(blob[1], Buffer.concat(chunks), req.headers["x-ispine-upload"]));
      }
      const thumbnail = /^\/api\/workspace\/thumbnails\/([^/]+)$/.exec(path);
      if (thumbnail && req.method === "GET") {
        const value = store.getProjectThumbnail(decodeURIComponent(thumbnail[1]), new URL(req.url, "http://127.0.0.1").searchParams.get("hash"));
        if (!value) return send(404, { error: "缩略图不存在或已更新。" });
        res.writeHead(200, { "Content-Type": value.mime, "Content-Length": value.bytes.byteLength, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        return res.end(value.bytes);
      }
      if (req.method !== "POST") return send(405, { error: "不支持此存储操作。" });
      if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "请使用 JSON 请求。" });
      if (Number(req.headers["content-length"]) > maxRequestBytes) return send(413, { error: "本次工程数据超过大小限制。" });
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > maxRequestBytes) return send(413, { error: "本次工程数据超过大小限制，请分开迁移。" }); chunks.push(chunk); }
      const body = decodeWorkspace(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (path === "/api/workspace/v2/blobs/query") {
        if (!store.hasAssets()) return send(409, { code: "WORKSPACE_REFRESH_REQUIRED", error: "当前工作区尚未启用格式 2。" });
        return send(200, store.queryAssets(body.hashes, body.leaseId));
      }
      if (path.startsWith("/api/workspace/v2/")) return send(200, { value: store.callV2(path.slice("/api/workspace/v2/".length), body) });
      if (path === "/api/workspace/migrate") return send(200, { value: store.migrate(body.source, body.snapshot) });
      const collection = path.slice("/api/workspace/".length);
      return send(200, { value: store.callLegacy(collection, body.operation, body.args) });
    } catch (error) { return send(["PROJECT_INDEX_CORRUPT", "PROJECT_INDEX_OUTDATED", "ASSET_CORRUPT", "ASSET_REFERENCE_CORRUPT", "WORKSPACE_MAINTENANCE"].includes(error.code) ? 503 :
      ["RESOURCE_CHANGED", "DRAFT_CHANGED", "PROJECT_INDEX_VERSION", "WORKSPACE_VERSION_CHANGED", "WORKSPACE_REFRESH_REQUIRED", "WORKSPACE_FORMAT_NEWER", "MUTATION_REUSED", "RESOURCE_REMOVED", "RESOURCE_TRASHED"].includes(error.code) ? 409 :
      ["ASSET_SIZE_INVALID", "WORKSPACE_SIZE_INVALID"].includes(error.code) ? 413 : 400,
      { error: error instanceof SyntaxError ? "存储请求内容无效。" : error.message, code: error.code }); }
  };
}

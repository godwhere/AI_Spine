import { encodeWorkspace, decodeWorkspace } from "../shared/workspace-codec.mjs";

export function workspaceMiddleware(store) {
  return async (req, res, next) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (!path.startsWith("/api/workspace/")) return next();
    const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(encodeWorkspace(value))); };
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) || (req.method === "POST" && req.headers.origin !== `http://${host}`))
      return send(403, { error: "本机数据只接受工作台自身的请求。" });
    try {
      if (path === "/api/workspace/status" && req.method === "GET") return send(200, store.status());
      if (req.method !== "POST") return send(405, { error: "不支持此存储操作。" });
      if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "请使用 JSON 请求。" });
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 256 * 1024 * 1024) return send(413, { error: "本次工程数据超过 256 MB，请分开迁移。" }); chunks.push(chunk); }
      const body = decodeWorkspace(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (path === "/api/workspace/migrate") return send(200, { value: store.migrate(body.source, body.snapshot) });
      const collection = path.slice("/api/workspace/".length);
      return send(200, { value: store.call(collection, body.operation, body.args) });
    } catch (error) { return send(["RESOURCE_CHANGED", "DRAFT_CHANGED"].includes(error.code) ? 409 : 400, { error: error instanceof SyntaxError ? "存储请求内容无效。" : error.message, code: error.code }); }
  };
}

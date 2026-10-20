import { request } from "node:http";

// Validate the caller before forwarding to the one production data owner.
export function workbenchProxy(target = "http://127.0.0.1:4175", { all = false } = {}) {
  return (req, res, next) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (!all && !/^\/api\/(?:workspace|generation|rig)\//.test(path)) return next();
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) || (["POST","DELETE"].includes(req.method) && req.headers.origin !== `http://${host}`)) {
      res.writeHead(403); res.end(JSON.stringify({ error: "本机工作台请求来源无效。" })); return;
    }
    const requested = new URL(req.url, "http://127.0.0.1"), upstream = new URL(target);
    upstream.pathname = requested.pathname; upstream.search = requested.search;
    const headers = { ...req.headers, host: upstream.host };
    if (headers.origin) headers.origin = upstream.origin;
    const forwarded = request(upstream, { method: req.method, headers }, (response) => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    forwarded.on("error", () => { if (!res.headersSent) res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "本机统一工作台服务暂不可用。" })); });
    req.on("aborted", () => forwarded.destroy()); req.pipe(forwarded);
    res.on("close", () => { if (!res.writableFinished) forwarded.destroy(); });
  };
}

import { JSON_LIMIT, readOptions } from "./request-body.mjs";

export async function handleRigRoute({ req, res, url, send, rigs }) {
  if (!rigs) return send(404, { error: "当前运行环境不支持骨架分析。" });
  if (url.pathname === "/api/rig/jobs" && req.method === "GET") {
    const projectId = url.searchParams.get("projectId");
    if (!projectId) return send(400, { error: "缺少工程标识。" });
    return send(200, { jobs: await rigs.list(projectId) });
  }
  if (url.pathname === "/api/rig/jobs" && req.method === "POST") {
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "请使用 JSON 请求。" });
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > JSON_LIMIT) return send(413, { error: "骨架任务和图片超过 40 MB。" }); chunks.push(chunk); }
    return send(202, await rigs.create(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
  }
  const retryRig = url.pathname.match(/^\/api\/rig\/jobs\/([\w-]{36})\/retry$/);
  if (retryRig && req.method === "POST") {
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "请使用 JSON 请求。" });
    const value = await rigs.retry(retryRig[1], await readOptions(req));
    return send(value ? 202 : 404, value || { error: "骨架任务不存在。" });
  }
  const rig = url.pathname.match(/^\/api\/rig\/jobs\/([\w-]{36})(?:\/images\/(image-\d+(?:-raw)?))?$/);
  if (rig && req.method === "GET" && rig[2]) {
    const bytes = await rigs.image(rig[1], rig[2]);
    if (!bytes) return send(404, { error: "补绘图片不存在。" });
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); return res.end(bytes);
  }
  if (rig && !rig[2] && ["GET", "DELETE"].includes(req.method)) {
    const value = await (req.method === "DELETE" ? rigs.cancel(rig[1]) : rigs.get(rig[1]));
    return send(value ? 200 : 404, value || { error: "骨架任务不存在。" });
  }
  return send(404, { error: "骨架分析接口不存在。" });
}

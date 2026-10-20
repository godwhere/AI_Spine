import { resolve } from "node:path";
import { GenerationJobs } from "./generation-service.mjs";
import { workbenchProxy } from "./workbench-proxy.mjs";

const JSON_LIMIT = 40 * 1024 * 1024;
async function readOptions(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("请使用 JSON 请求。");
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error("连接配置过大。"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function generationMiddleware(jobs) {
  return async (req, res, next) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/generation/") && !url.pathname.startsWith("/api/rig/")) return next();
    const send = (code, value) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    // Loopback and same-origin only: a website cannot submit jobs using this account.
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      (req.headers.origin && ![`http://${host}`,`https://${host}`].includes(req.headers.origin)) ||
      (["POST","DELETE"].includes(req.method) && req.headers.origin !== `http://${host}`))
      return send(403, { error: "生成服务只接受本机工作台的请求。" });
    try {
      if (url.pathname.startsWith("/api/rig/")) {
        const rigs = jobs.rigJobs;
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
      if (req.method === "GET" && url.pathname === "/api/generation/status") return send(200,await jobs.status(url.searchParams.get("provider") || undefined));
      if (url.pathname === "/api/generation/connection") {
        if (req.method === "GET") return send(200, await jobs.connections.info());
        if (req.method === "POST") return send(200, await jobs.connections.configure(await readOptions(req)));
      }
      if (url.pathname === "/api/generation/connection/login" && req.method === "POST")
        return send(200, await jobs.connections.login());
      const connection = url.pathname.match(/^\/api\/generation\/connection\/([\w-]+)$/);
      if (connection && req.method === "DELETE") return send(200, await jobs.connections.forget(connection[1]));
      if (req.method === "GET" && url.pathname === "/api/generation/jobs") {
        const projectId = url.searchParams.get("projectId");
        if (!projectId) return send(400,{error:"缺少工程标识。"});
        return send(200,{jobs:await jobs.list(projectId)});
      }
      if (req.method === "POST" && url.pathname === "/api/generation/jobs") {
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(415,{error:"请使用 JSON 请求。"});
        let size=0; const chunks=[];
        for await (const chunk of req) {
          size+=chunk.length;
          if (size>JSON_LIMIT) return send(413,{error:"参考图片过大，请减少部件数量。"});
          chunks.push(chunk);
        }
        return send(202,await jobs.create(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      }
      const retry = url.pathname.match(/^\/api\/generation\/jobs\/([\w-]{36})\/retry$/);
      if (retry && req.method === "POST") {
        let size = 0;const chunks = [];
        for await (const chunk of req) { size += chunk.length;if(size > 1024)return send(413,{error:"续做选项过大。"});chunks.push(chunk); }
        const options = size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        return send(202,await jobs.retry(retry[1],options));
      }
      const match = url.pathname.match(/^\/api\/generation\/jobs\/([\w-]{36})(?:\/images\/(image-\d+))?$/);
      if (match && req.method === "GET" && match[2]) {
        const bytes=await jobs.image(match[1],match[2]);
        if (!bytes) return send(404,{error:"图片不存在。"});
        res.writeHead(200,{"Content-Type":"image/png","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
        return res.end(bytes);
      }
      if (match && !match[2] && ["GET","DELETE"].includes(req.method)) {
        const job=await (req.method==="DELETE"?jobs.cancel(match[1]):jobs.get(match[1]));
        return send(job?200:404,job||{error:"生成记录不存在。"});
      }
      return send(404,{error:"生成接口不存在。"});
    } catch (error) { return send(400,{error:error instanceof SyntaxError ? "请求内容无效。" : error.message}); }
  };
}
export function generationStorageRoot(root, { preview = false, port = 4173 } = {}) {
  if (!preview) return resolve(root, "work/generation/jobs");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("预览服务端口无效。");
  return resolve(root, `work/generation/preview-${port}/jobs`);
}
export function generationPlugin() {
  let root, previewPort = 4173;
  const install = (server, preview = false) => {
    if (!preview) { server.middlewares.use(workbenchProxy()); return; }
    const jobs = new GenerationJobs({ root: generationStorageRoot(root, { preview, port: server.config?.preview?.port ?? previewPort }) });
    server.middlewares.use(generationMiddleware(jobs));
    server.httpServer?.once("close",()=>jobs.close());
  };
  return { name:"ai-spine-codex-generation", configResolved(config){root=config.root; previewPort = config.preview?.port ?? 4173;},
    configureServer: (server) => install(server), configurePreviewServer: (server) => install(server, true) };
}

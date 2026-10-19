import { resolve } from "node:path";
import { GenerationJobs } from "./generation-service.mjs";

const JSON_LIMIT = 40 * 1024 * 1024;
export function generationMiddleware(jobs) {
  return async (req, res, next) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/generation/")) return next();
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
      if (req.method === "GET" && url.pathname === "/api/generation/status") return send(200,await jobs.status());
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
export function generationPlugin() {
  let root;
  const install = (server) => {
    const jobs = new GenerationJobs({root:resolve(root,"work/generation/jobs")});
    server.middlewares.use(generationMiddleware(jobs));
    server.httpServer?.once("close",()=>jobs.close());
  };
  return { name:"ai-spine-codex-generation", configResolved(config){root=config.root;},
    configureServer:install, configurePreviewServer:install };
}

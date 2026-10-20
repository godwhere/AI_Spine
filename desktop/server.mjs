import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { GenerationJobs } from "../server/generation-service.mjs";
import { generationMiddleware } from "../server/generation-plugin.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".zip": "application/zip", ".atlas": "text/plain", ".skel": "application/octet-stream" };
export const DESKTOP_PORT = 4175;
export async function startDesktopServer({ clientRoot, dataRoot, port = DESKTOP_PORT, jobs, protection, workspace } = {}) {
  const root = resolve(clientRoot);
  jobs ||= new GenerationJobs({ root: resolve(dataRoot, "generation/jobs"), protection });
  const generation = generationMiddleware(jobs);
  const server = createServer((req, res) => {
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.writeHead(403); res.end("Local application only"); return;
    }
    const serve = () => generation(req, res, async () => {
      try {
        if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); res.end(); return; }
        const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
        const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
        if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
        const info = await stat(file);
        if (!info.isFile()) throw new Error("Not a file");
        res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream",
          "Content-Length": info.size, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'" });
        res.end(req.method === "HEAD" ? undefined : await readFile(file));
      } catch { res.writeHead(404); res.end("Not found"); }
    });
    if (workspace) void workspace(req, res, serve);
    else void serve();
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  }).catch(async (error) => { await jobs.close(); throw error; });
  return { origin: `http://127.0.0.1:${server.address().port}`, jobs,
    async close() {
      await jobs.close();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    } };
}

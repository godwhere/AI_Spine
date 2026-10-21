import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".zip": "application/zip", ".atlas": "text/plain", ".skel": "application/octet-stream" };
export async function startHttpServer({ clientRoot, port, route = (_req, _res, next) => next(), closeServices = async () => {} } = {}) {
  const root = resolve(clientRoot);
  const server = createServer((req, res) => {
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.writeHead(403); res.end("Local application only"); return;
    }
    const serve = async () => {
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
    };
    void Promise.resolve(route(req, res, serve)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end("Local service failed");
    });
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  }).catch(async (error) => { await closeServices(); throw error; });
  let closing;
  return { origin: `http://127.0.0.1:${server.address().port}`,
    close() {
      return closing ||= (async () => {
        try { await closeServices(); } finally {
          server.closeAllConnections();
          await new Promise((done) => server.close(done));
        }
      })();
    } };
}

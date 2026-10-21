import { createWorkbenchServices } from "./bootstrap/workbench.mjs";
import { localEnvironment } from "./bootstrap/environments.mjs";
import { workbenchProxy } from "./workbench-proxy.mjs";

export function generationPlugin({ backendOrigin, createServices = createWorkbenchServices } = {}) {
  let root, developmentPort = 5173, previewPort = 4173;
  const install = (server, preview = false) => {
    if (!preview && backendOrigin) {
      server.middlewares.use(workbenchProxy(backendOrigin));
      return;
    }
    if (!server.httpServer) throw new Error("中间件模式必须显式指定本机后台地址。");
    let services, failure, closing = false, closed, accept;
    const ready = new Promise((resolve) => { accept = resolve; });
    const start = () => {
      if (closing) { accept(); return; }
      const configured = preview ? server.config?.preview?.port ?? previewPort : server.config?.server?.port ?? developmentPort;
      const port = configured || server.httpServer.address().port;
      try { services = createServices(localEnvironment(root, { preview, port })); }
      catch (error) { failure = error; }
      accept();
    };
    // A failed bind must never open another instance's manifests/database.
    if (server.httpServer.listening) start(); else server.httpServer.once("listening", start);
    server.middlewares.use(async (req, res, next) => {
      if (!/^\/api\/(?:workspace|generation|rig)\//.test(new URL(req.url, "http://127.0.0.1").pathname)) return next();
      await ready;
      if (!services || failure || closing) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "本机工作台服务暂不可用，未切换存储。", code: "WORKBENCH_UNAVAILABLE" }));
        return;
      }
      return services.route(req, res, next);
    });
    const close = () => closed ||= (async () => { closing = true; accept(); await services?.close(); })();
    // Vite restart prepares a new server before closing the old one. Drain the
    // old owner before releasing its port; only then may the new owner restore.
    if (typeof server.close === "function") {
      const closeServer = server.close.bind(server);
      server.close = async () => { try { await close(); } finally { await closeServer(); } };
    }
    server.httpServer.once("close", () => { void close(); });
  };
  return { name: "ispine-local-workbench",
    config: () => ({ server: { strictPort: true }, preview: { strictPort: true } }),
    configResolved(config) { root = config.root; developmentPort = config.server?.port ?? 5173; previewPort = config.preview?.port ?? 4173; },
    configureServer: (server) => install(server), configurePreviewServer: (server) => install(server, true),
  };
}

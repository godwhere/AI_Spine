import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { startWorkbenchServer, WORKBENCH_PORT } from "./workbench.mjs";
import { workbenchProxy } from "../workbench-proxy.mjs";

const openBrowser = (origin) => new Promise((accept, reject) => {
  execFile("/usr/bin/open", [origin], (error) => error ? reject(error) : accept());
});

export async function launchWorkbench({ clientRoot, port = WORKBENCH_PORT, mode = "production", aliasPorts = mode === "production" ? [4173, 4180] : [],
  open = false, opener = openBrowser, reuse = mode === "production", ...options } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("工作台服务端口无效。");
  if (reuse && port) {
    const origin = `http://127.0.0.1:${port}`;
    let available = false;
    try {
      const response = await fetch(`${origin}/api/workspace/status`, { signal: AbortSignal.timeout(1000) });
      available = response.ok && (await response.json()).storage === "local-shared";
    } catch { /* Start only when the existing backend could not be reached. */ }
    if (available) {
      if (open) await opener(origin);
      return { origin, reused: true, close: async () => {} };
    }
  }
  if (!clientRoot || !existsSync(resolve(clientRoot, "index.html"))) throw new Error("工作台尚未构建，请先运行 npm run build。");
  const backend = await startWorkbenchServer({ clientRoot, port, mode, ...options }), aliases = [];
  let closing;
  const close = () => closing ||= (async () => {
    for (const alias of aliases) { alias.closeAllConnections(); await new Promise((done) => alias.close(done)); }
    await backend.close();
  })();
  try {
    for (const port of aliasPorts) {
      const forward = workbenchProxy(backend.origin, { all: true });
      const alias = createServer((req, res) => forward(req, res, () => { res.writeHead(404); res.end(); }));
      try {
        await new Promise((accept, reject) => { alias.once("error", reject); alias.listen(port, "127.0.0.1", accept); });
        aliases.push(alias);
      } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
    }
    if (open) await opener(backend.origin);
    return { ...backend, reused: false, close };
  } catch (error) { await close(); throw error; }
}

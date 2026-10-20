import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { startWorkbenchServer, WORKBENCH_PORT } from "../server/workbench-server.mjs";
import { workbenchProxy } from "../server/workbench-proxy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), origin = `http://127.0.0.1:${WORKBENCH_PORT}`;
const open = () => { if (process.argv.includes("--open")) execFile("/usr/bin/open", [origin], () => {}); };
try {
  const response = await fetch(`${origin}/api/workspace/status`, { signal: AbortSignal.timeout(1000) });
  if (response.ok && (await response.json()).storage === "local-shared") { open(); process.exit(0); }
} catch { /* Start the persistent local workbench. */ }
if (!existsSync(resolve(root, "dist/client/index.html"))) throw new Error("工作台尚未构建，请先运行 npm run build。");
const server = await startWorkbenchServer({ clientRoot: resolve(root, "dist/client") });
const aliases = [];
for (const port of [4173, 4180]) {
  const forward = workbenchProxy(server.origin, { all: true });
  const alias = createServer((req, res) => forward(req, res, () => { res.writeHead(404); res.end(); }));
  try {
    await new Promise((accept, reject) => { alias.once("error", reject); alias.listen(port, "127.0.0.1", accept); });
    aliases.push(alias);
  } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
}
console.log(`iSpine 本机工作台：${server.origin}`); open();
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  if (!stopping) { stopping = true; for (const alias of aliases) { alias.closeAllConnections(); alias.close(); } void server.close().then(() => process.exit(0)); }
});

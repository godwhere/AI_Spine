import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { launchWorkbench } from "../server/bootstrap/launcher.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await launchWorkbench({ clientRoot: resolve(root, "dist/client"), open: process.argv.includes("--open") });
console.log(`iSpine 本机工作台：${server.origin}`);
if (!server.reused) {
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
    if (!stopping) { stopping = true; void server.close().then(() => process.exit(0), () => process.exit(1)); }
  });
}

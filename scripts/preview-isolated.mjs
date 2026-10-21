import { writeFile } from "node:fs/promises";
import { buildIsolatedClient, startIsolatedWorkbench } from "../tests/support/isolated-workbench.mjs";

const client = await buildIsolatedClient();
const storageFormat = process.argv.includes("--format=2") ? 2 : 1;
let server;
try { server = await startIsolatedWorkbench({ clientRoot: client.clientRoot, storageFormat }); }
catch (error) { await client.close(); throw error; }
const manifest = { origin: server.origin, dataRoot: server.root, clientRoot: client.clientRoot, storageFormat, provider: "fake-only" };
await writeFile("/tmp/ispine-isolated-preview.json", JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  if (closing) return; closing = true;
  await server.close(); await client.close(); process.exit(0);
});

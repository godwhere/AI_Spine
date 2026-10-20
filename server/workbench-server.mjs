import { homedir } from "node:os";
import { join } from "node:path";
import { startDesktopServer } from "../desktop/server.mjs";
import { WorkspaceStore } from "./workspace-store.mjs";
import { workspaceMiddleware } from "./workspace-middleware.mjs";
import { localKeyProtection } from "./key-protection.mjs";

export const WORKBENCH_PORT = 4175;
export const workbenchDataRoot = () => process.env.ISPINE_DATA_ROOT || join(homedir(), "Library/Application Support/AI Spine");
export async function startWorkbenchServer({ clientRoot, dataRoot = workbenchDataRoot(), port = WORKBENCH_PORT, protection = localKeyProtection(), jobs } = {}) {
  const store = new WorkspaceStore(join(dataRoot, "workspace"));
  try {
    const server = await startDesktopServer({ clientRoot, dataRoot, port, protection, jobs, workspace: workspaceMiddleware(store) });
    return { ...server, store, async close() { await server.close(); store.close(); } };
  } catch (error) { store.close(); throw error; }
}

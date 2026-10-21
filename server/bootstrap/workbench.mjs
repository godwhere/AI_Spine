import { homedir } from "node:os";
import { join } from "node:path";
import { startHttpServer } from "../http/server.mjs";
import { createWorkspaceStore } from "./workspace.mjs";
import { workspaceMiddleware } from "../http/workspace-routes.mjs";
import { generationMiddleware } from "../http/generation-routes.mjs";
import { localKeyProtection } from "../infrastructure/key-protection.mjs";
import { GenerationJobs } from "../jobs/generation-service.mjs";

export const WORKBENCH_PORT = 4175;
export const workbenchDataRoot = () => process.env.ISPINE_DATA_ROOT || join(homedir(), "Library/Application Support/AI Spine");

// This is the one Node composition root. HTTP/Vite only receive its handlers;
// neither routes nor the UI choose data directories or construct providers.
export function createWorkbenchServices({ mode = "production", dataRoot, jobsRoot, protection, jobs } = {}) {
  if (!["production", "development", "preview", "test"].includes(mode)) throw new Error("工作台运行模式无效。");
  dataRoot ||= mode === "production" ? workbenchDataRoot() : null;
  if (!dataRoot) throw new Error("非正式工作台必须显式指定隔离数据目录。");
  const store = createWorkspaceStore(join(dataRoot, "workspace"));
  try {
    jobs ||= new GenerationJobs({ root: jobsRoot || join(dataRoot, "generation/jobs"),
      protection: protection === undefined ? localKeyProtection() : protection });
    const workspace = workspaceMiddleware(store), generation = generationMiddleware(jobs);
    let closing;
    return { mode, store, jobs,
      route: (req, res, next) => workspace(req, res, () => generation(req, res, next)),
      close() { return closing ||= (async () => { try { await jobs.close(); } finally { store.close(); } })(); },
    };
  } catch (error) { store.close(); throw error; }
}

export async function startWorkbenchServer({ clientRoot, port = WORKBENCH_PORT, ...options } = {}) {
  let services, failure, accept, closed;
  const ready = new Promise((resolve) => { accept = resolve; });
  const close = () => closed ||= services ? services.close() : Promise.resolve(options.jobs?.close());
  let server;
  try {
    // Acquire the loopback port before opening a workspace or restoring jobs.
    // A second launch must not interrupt the live owner's generation history.
    server = await startHttpServer({ clientRoot, port, closeServices: close, route: async (req, res, next) => {
      await ready;
      if (failure || !services) { res.writeHead(503); res.end("Local service unavailable"); return; }
      return services.route(req, res, next);
    } });
    services = createWorkbenchServices(options); accept();
    return { ...server, store: services.store, jobs: services.jobs, mode: services.mode };
  } catch (error) {
    failure = error; accept();
    if (server) await server.close(); else await close();
    throw error;
  }
}

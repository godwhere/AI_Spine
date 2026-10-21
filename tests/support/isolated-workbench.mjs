import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { launchWorkbench } from "../../server/bootstrap/launcher.mjs";
import { GenerationJobs } from "../../server/jobs/generation-service.mjs";
import { template } from "../helpers.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const unexpected = () => { throw new Error("Isolated tests must never invoke accounts, key protection or external AI."); };

export function fakeImageConnections({ generate } = {}) {
  const selection = Object.freeze({ id: "codex-native", label: "隔离测试 AI", model: "fixture-image-v1" });
  const status = { connected: true, provider: selection.id, label: selection.label, model: selection.model, message: "隔离测试服务" };
  const canvas = createCanvas(32, 32), context = canvas.getContext("2d");
  context.fillStyle = "#9866df"; context.fillRect(8, 8, 16, 16);
  const result = canvas.toBuffer("image/png").toString("base64");
  return {
    ready: Promise.resolve(),
    status: async () => ({ ...status }),
    info: async () => ({ selected: selection.id, status: { ...status }, secureStorage: false, busy: false,
      providers: [{ ...selection, models: [selection.model], auth: "chatgpt" }] }),
    snapshot: async (id = selection.id) => { if (id !== selection.id) throw new Error("Only the isolated fixture provider is available."); return { ...selection }; },
    generate: generate || (async (_selection, { signal }) => { signal?.throwIfAborted(); return { result, model: selection.model }; }),
    configure: unexpected, login: unexpected, forget: unexpected, close() {},
  };
}

// No configurable production defaults: every fixture owns a fresh directory,
// OS-assigned port and fake capability. Callers cannot point it at live storage.
export async function startIsolatedWorkbench({ clientRoot, connections = fakeImageConnections(), seed = true, storageFormat = 1 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ispine-isolated-"));
  let server, jobs;
  const openedOrigins = [], opener = async (origin) => { openedOrigins.push(origin); };
  try {
    if (!clientRoot) {
      clientRoot = join(root, "client"); await mkdir(clientRoot);
      await writeFile(join(clientRoot, "index.html"), "<!doctype html><title>iSpine isolated test</title>");
    }
    const rpc = { on() {}, off() {}, start: unexpected, request: unexpected, close() {} };
    const createJobs = () => new GenerationJobs({ root: join(root, "generation/jobs"), rpc, connections, generate: unexpected, fetcher: unexpected });
    const protection = { isAvailable: () => false, encrypt: unexpected, decrypt: unexpected };
    jobs = createJobs();
    await jobs.loading;
    server = await launchWorkbench({ mode: "test", clientRoot, dataRoot: root, port: 0, jobs, open: true, opener,
      protection });
    if (storageFormat === 2) server.store.initializeEmptyV2();
    else if (storageFormat !== 1) throw new Error("Unsupported isolated storage format");
    if (seed) {
      const bundle = template("22");
      server.store.call("projects", "save", [{ id: "architecture-fixture", name: "隔离测试角色", templateId: "22",
        files: bundle.files, skeletonPath: bundle.skeletonPath, edits: {}, generation: {}, partCount: bundle.parts.length }]);
    }
    let closing;
    const instance = { ...server, root, jobs, openedOrigins,
      async restart() {
        if (closing) throw new Error("The isolated fixture is already closed.");
        const port = Number(new URL(server.origin).port);
        await server.close(); await jobs.drainingPromise?.catch(() => {});
        jobs = createJobs(); await jobs.loading;
        server = await launchWorkbench({ mode: "test", clientRoot, dataRoot: root, port, jobs, protection, open: true, opener });
        instance.store = server.store; instance.jobs = jobs; instance.origin = server.origin;
      },
      async close() {
      closing ||= (async () => {
        await server.close();
        await jobs.drainingPromise?.catch(() => {});
        await Promise.all([...jobs.writes.values()]);
        await rm(root, { recursive: true, force: true });
      })();
      return closing;
    } };
    return instance;
  } catch (error) {
    if (server) await server.close(); else await jobs?.close();
    await rm(root, { recursive: true, force: true }); throw error;
  }
}

export async function buildIsolatedClient() {
  const root = await mkdtemp(join(tmpdir(), "ispine-client-")), clientRoot = join(root, "client");
  try {
    // Deliberately bypass the Vite generation plugin and its live proxy.
    await build({ root: projectRoot, configFile: false, plugins: [react()], logLevel: "warn",
      build: { outDir: clientRoot, emptyOutDir: true } });
    return { root, clientRoot, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

import { resolve } from "node:path";

export function generationStorageRoot(root, { preview = false, port = 4173 } = {}) {
  if (!preview) return resolve(root, "work/generation/jobs");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("预览服务端口无效。");
  return resolve(root, `work/generation/preview-${port}/jobs`);
}

export function localEnvironment(root, { preview = false, port = preview ? 4173 : 5173 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("工作台服务端口无效。");
  return { mode: preview ? "preview" : "development",
    dataRoot: resolve(root, `work/${preview ? "preview" : "development"}-${port}`),
    jobsRoot: !preview && port !== 5173 ? resolve(root, `work/generation/development-${port}/jobs`) : generationStorageRoot(root, { preview, port }),
  };
}

import { listProjects, saveProject } from "./storage.js";
import { parseBundle } from "./archive.js";
import { unpackInWorker } from "./archive-worker.js";
import { parseSkeleton } from "../spine/runtime.js";

export const isDesktop = Boolean(window.aiSpineDesktop);
let startup;
export function desktopProjects() {
  startup ||= (async () => {
    const projects = await listProjects();
    if (projects.length) return projects;
    const response = await fetch("/examples/starberry-project.zip");
    if (!response.ok) throw new Error("示例角色加载失败，可通过“导入资源”导入自己的工程。");
    const files = await unpackInWorker(new Uint8Array(await response.arrayBuffer()));
    const bundle = parseBundle(files, { name: "星莓果冻精灵" });
    const { data } = parseSkeleton(bundle);
    await saveProject({ id: "example-starberry-v1", name: "星莓果冻精灵", templateId: "19",
      files: bundle.files, skeletonPath: bundle.skeletonPath, edits: bundle.edits || {},
      generation: bundle.generation || {}, thumbnail: "/examples/starberry.png",
      partCount: bundle.parts.length, animationCount: data.animations.length, boneCount: data.bones.length });
    return listProjects();
  })().catch((error) => { startup = null; throw error; });
  return startup;
}

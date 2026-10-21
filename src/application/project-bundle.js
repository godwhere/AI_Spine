import { parseBundle } from "../../engine/archive/bundle.js";
import { parseSkeleton } from "../../engine/spine/parse.js";

export function prepareBundle(bundle) {
  const { data } = parseSkeleton(bundle);
  return { ...bundle, version: data.version, animations: data.animations.map((a) => a.name),
    skins: data.skins.map((s) => s.name), boneCount: data.bones.length,
    durations: Object.fromEntries(data.animations.map((a) => [a.name, a.duration])) };
}

export function prepareProject(files, options, createId) {
  return prepareBundle(parseBundle(files, { ...options, id: options?.id === undefined ? createId() : options.id }));
}

export function editorRecord({ project, bundle, name, edits, generation }) {
  return project && bundle ? { id: project.id, name: name || bundle.name, files: bundle.files, skeletonPath: bundle.skeletonPath,
    edits, generation, templateId: project.templateId, thumbnail: project.thumbnail,
    boneCount: bundle.boneCount, partCount: bundle.parts.length, animationCount: bundle.animations.length } : null;
}

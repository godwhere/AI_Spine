export function shouldPersistProject({ project, name, edits = {}, generation = {}, explicit = false, persisted = false }) {
  if (!project) return false;
  if (!project.isDraft || explicit || persisted) return true;
  const title = name?.trim();
  return Boolean(
    (title && title !== project.initialName?.trim()) ||
    Object.values(edits).some(Boolean) ||
    generation.appearance?.image?.byteLength ||
    generation.appearancePrompt?.trim() ||
    generation.partsPrompt?.trim(),
  );
}

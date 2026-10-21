import { hasRigAuthoring } from "../../shared/domain/rig-summary.mjs";

const exportName = (name) => (name || "Spine").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");

export function createProjectExporter({ archive, pixels, downloads }) {
  return async function exportProject({ bundle, edits, mode, name, generation }, { persist, onExported = () => {} } = {}) {
    const pages = await pixels.compilePages(bundle, edits), editable = mode === "project", target = mode === "unity" ? "unity" : undefined;
    const files = hasRigAuthoring(bundle.files) ? await pixels.synchronizeRigAuthoring(bundle, edits) : bundle.files;
    const bytes = await archive.export({ ...bundle, files }, pages, { editable, target, edits, name, generation });
    const fileName = `${exportName(name)}${editable ? "-工程" : target === "unity" ? "-Unity" : "-Spine4.3"}.zip`;
    await downloads.save(bytes, fileName);
    onExported({ editable, target, fileName });
    let saveError;
    try { await persist?.(false, { force: true }); } catch (error) { saveError = error; }
    return { bytes, fileName, editable, target, saveError };
  };
}

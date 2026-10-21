import { createLibraryController } from "../application/library-controller.js";
import { createCalibration } from "../application/part-calibration.js";
import { browserPixels } from "../infrastructure/browser-pixels.js";
import { createRigOperations } from "../application/rig-operations.js";
import { buildRigFiles } from "../infrastructure/rig-authoring.js";
import * as rigImagePorts from "../infrastructure/rig-images.js";
import * as registrationPorts from "../infrastructure/rig-registration.js";
import * as motionStudyPorts from "../infrastructure/motion-study-images.js";
import * as projects from "../infrastructure/project-repository.js";
import * as templates from "../infrastructure/template-repository.js";
import * as drafts from "../infrastructure/rig-draft-repository.js";
import { configureWorkspace, watchWorkspace, workspaceMutationReceipts } from "../infrastructure/workspace-client.js";
import { readImportFiles, loadCatalogTemplate } from "../infrastructure/archive-files.js";
import { compilePages } from "../infrastructure/calibration.js";
import { synchronizeRigAuthoring, rigWithCalibratedParts } from "../infrastructure/rig-project.js";
import { createSpineScene } from "../spine/runtime.js";
import { captureTemplatePreview } from "../infrastructure/template-preview.js";
import { unpackInWorker, exportInWorker } from "../infrastructure/archive-worker.js";
import { createLocalGenerationProvider, applyGeneratedParts, prepareGenerationRequest } from "../infrastructure/generation-client.js";
import { createRigClient } from "../infrastructure/rig-client.js";
import { addTemplateVariant } from "../infrastructure/template-variants.js";
import { readReplacement } from "../infrastructure/image-files.js";
import { saveDownload } from "../infrastructure/downloads.js";
import { createResourceActions } from "../application/resource-actions.js";
import { createProjectExporter } from "../application/export-project.js";
import { createCandidateApplication } from "../application/apply-candidate.js";
import { createEditorPersistence } from "../application/editor-persistence.js";
import { createRigResourceActions } from "../application/rig-resource.js";
import { createRigDraftWriter } from "../application/rig-draft-writer.js";

// The browser composition root chooses capabilities once. Connection failure
// never changes storage mode or substitutes another repository/provider.
export function createBrowserServices({ storageMode, apiBase, fetcher = fetch,
  createId = () => crypto.randomUUID(), now = () => new Date().toISOString(),
  preview = { createScene: createSpineScene },
  workers = { unpack: unpackInWorker, export: exportInWorker }, downloads = { save: saveDownload } }) {
  configureWorkspace({ storageMode, apiBase, fetcher, createId });
  const apiFetch = (path, options) => fetcher(path.startsWith("/api/") ? apiBase.replace(/\/$/, "") + path.slice(4) : path, options);
  const repositories = {
    projects: { get: projects.getProject, list: projects.listProjects, library: projects.listProjectLibrary,
      preview: projects.getProjectForPreview, trash: projects.trashProject, restore: projects.restoreProject, remove: projects.permanentlyDeleteProjects,
      usesMutationReceipts: workspaceMutationReceipts,
      save: (record, { expectedVersion, mutationId } = {}) => projects.saveProject(record, { expectedUpdatedAt: expectedVersion, mutationId }) },
    templates: { get: templates.getCustomTemplate, list: templates.listCustomTemplates, save: templates.saveCustomTemplate, remove: templates.deleteCustomTemplate },
    drafts: { get: drafts.getRigDraft, list: drafts.listRigDrafts, save: drafts.saveRigDraft },
  };
  const archive = { ...workers, readImportFiles, loadCatalogTemplate: (template) => loadCatalogTemplate(template, fetcher) }, pixels = { compilePages, synchronizeRigAuthoring, rigWithCalibratedParts, readReplacement };
  const catalog = { async list() { const response = await fetcher("/templates/catalog.json");
    if (!response.ok) throw new Error("模板目录加载失败。"); return response.json(); },
    async atlas(path, options) { const response = await fetcher(path, options); if (!response.ok) throw new Error("Atlas unavailable"); return response.text(); } };
  const resources = createResourceActions({ ...repositories, archive, pixels, catalog, createId, now });
  const library = createLibraryController({ ...repositories, resources, watch: watchWorkspace });
  const rigImages = { ...rigImagePorts, ...registrationPorts, ...motionStudyPorts };
  const rigEditing = { createId, images: rigImages, operations: createRigOperations({ images: rigImages, buildFiles: buildRigFiles, createId }) };
  const previewRuntime = { ...preview, capture: preview.capture || ((bundle, options) => captureTemplatePreview(bundle, options, { createScene: preview.createScene })) };
  return { calibration: createCalibration({ pixels: browserPixels, readReplacement }), rigEditing, storageMode, apiBase, repositories, archive, pixels, preview: previewRuntime, createId, now, downloads,
    connection: createLocalGenerationProvider(apiFetch), rigJobs: createRigClient(apiFetch), watchWorkspace,
    resources, library,
    rigs: createRigResourceActions({ ...repositories, pixels, createId }),
    exportProject: createProjectExporter({ archive, pixels, downloads }),
    applyCandidate: createCandidateApplication({ images: { applyGeneratedParts }, variants: { add: addTemplateVariant } }),
    prepareGenerationRequest,
    createEditorWriter: (callbacks) => createEditorPersistence({ repository: repositories.projects, createMutationId: createId, ...callbacks }),
    createDraftWriter: (callbacks) => createRigDraftWriter({ save: repositories.drafts.save, get: repositories.drafts.get, usesMutationReceipts: workspaceMutationReceipts, createMutationId: createId, ...callbacks }),
  };
}

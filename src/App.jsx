import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Grid2X2,
  Palette,
  Upload,
  Plus,
  Pause,
  Play,
  BookOpen,
  History,
  X,
  ArrowLeft,
  Download,
  Save,
  Check,
  Search,
  SlidersHorizontal,
  RotateCcw,
  Replace,
  Undo2,
  Redo2,
  LoaderCircle,
  FolderOpen,
  CheckCircle2,
  ChevronRight,
  Bone,
  FileArchive,
  Layers,
  Sparkles,
  Trash2,
  ChevronDown,
  Move,
} from "lucide-react";
import { SpineViewer } from "./components/SpineViewer.jsx";
import { PartEditor } from "./components/PartEditor.jsx";
import { GenerationPanel } from "./components/GenerationPanel.jsx";
import { AIConnectionPanel } from "./components/AIConnectionPanel.jsx";
import { CreationWorkflow } from "./components/CreationWorkflow.jsx";
import { ResourceLibrary } from "./components/ResourceLibrary.jsx";
import { TemplateLibrary } from "./components/TemplateLibrary.jsx";
import { RigWorkbench } from "./components/RigWorkbench.jsx";
import { isDesktop, desktopProjects } from "./core/desktop.js";
import { watchWorkspace } from "./core/workspace.js";
import {
  loadCatalogTemplate,
  parseBundle,
  readImportFiles,
} from "./core/archive.js";
import { unpackInWorker, exportInWorker } from "./core/archive-worker.js";
import { compilePages, readReplacement } from "./core/pixels.js";
import { listProjects, listTrashedProjects, listProjectLibrary, getProject, saveProject, trashProject, restoreProject, permanentlyDeleteProjects } from "./core/storage.js";
import { parseSkeleton } from "./spine/runtime.js";
import { applyGeneratedParts, createLocalGenerationProvider, templateFingerprint } from "./core/generation.js";
import { addTemplateVariant, templateVariantBase, templateVariantEntries } from "./core/template-variants.js";
import { shouldPersistProject } from "./core/project-draft.js";
import { captureTemplatePreview } from "./core/template-preview.js";
import { createCustomTemplateRecord, saveCustomTemplate, listCustomTemplates, getCustomTemplate, deleteCustomTemplate } from "./core/custom-templates.js";
import { getRigDraft, listRigDrafts, saveRigDraft, rigDraftDestination } from "./core/rig-drafts.js";
import { createRigDraftWriter, attachRigDraftExitGuards } from "./core/rig-draft-writer.js";
import { attachRigAuthoring, hasRigAuthoring, imageDataBytes, readRigAuthoring, rigAuthoringSummary, rigWithCalibratedParts, synchronizeRigAuthoring } from "./core/rig-project.js";

const EMPTY = Object.freeze(Object.create(null));
function makeClock() {
  return {
    position: 0,
    anchor: performance.now(),
    playing: true,
    speed: 1,
    read(now = performance.now()) {
      return (
        this.position +
        (this.playing ? ((now - this.anchor) / 1000) * this.speed : 0)
      );
    },
    set(values) {
      this.position = this.read();
      this.anchor = performance.now();
      Object.assign(this, values);
    },
    seek(value) {
      this.position = value;
      this.anchor = performance.now();
    },
  };
}
const defaultAnimation = (names) =>
  ["idle", "unit_wait", "std", "stand"].find((n) => names.includes(n)) ||
  names[0] ||
  "";
function prepare(bundle) {
  const { data } = parseSkeleton(bundle);
  return {
    ...bundle,
    version: data.version,
    animations: data.animations.map((a) => a.name),
    skins: data.skins.map((s) => s.name),
    boneCount: data.bones.length,
    durations: Object.fromEntries(
      data.animations.map((a) => [a.name, a.duration]),
    ),
  };
}
function triggerDownload(bytes, name) {
  const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/zip" }),
    ),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const exportName = (name) =>
  (name || "Spine").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");

export function App() {
  const [catalog, setCatalog] = useState([]),
    [selectedTemplate, setSelectedTemplate] = useState(null),
    [bundle, setBundle] = useState(null);
  const [page, setPage] = useState("home"),
    [tab, setTab] = useState("characters"),
    [type, setType] = useState("全部"),
    [category, setCategory] = useState("全部"),
    [search, setSearch] = useState("");
  const [projects, setProjects] = useState([]),
    [project, setProject] = useState(null),
    [projectName, setProjectName] = useState("");
  const persistedProjects = useRef(new Set());
  const projectVersions = useRef(new Map());
  const [edits, setEdits] = useState(EMPTY),
    [compiled, setCompiled] = useState(EMPTY),
    [processing, setProcessing] = useState(false),
    [loading, setLoading] = useState(true);
  const [selectedPart, setSelectedPart] = useState(""),
    [partSearch, setPartSearch] = useState(""),
    [showParts, setShowParts] = useState(isDesktop),
    [editing, setEditing] = useState(false);
  const [animation, setAnimation] = useState(""),
    [skin, setSkin] = useState(""),
    [playing, setPlaying] = useState(true),
    [speed, setSpeed] = useState(1),
    [time, setTime] = useState(0),
    [showBones, setShowBones] = useState(false);
  const [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [saving, setSaving] = useState(false),
    [saveState, setSaveState] = useState(""),
    [modal, setModal] = useState(null),
    [exportMode, setExportMode] = useState("runtime"),
    [exporting, setExporting] = useState(false);
  const [importChoice, setImportChoice] = useState(null),
    [logs, setLogs] = useState([]),
    [, setHistoryCount] = useState(0);
  const [importing, setImporting] = useState(false);
  const [generation, setGeneration] = useState({});
  const [generationKind, setGenerationKind] = useState("appearance");
  const [previewMode, setPreviewMode] = useState(isDesktop ? "resource" : "compare");
  const [trash, setTrash] = useState([]), [trashTarget, setTrashTarget] = useState(null), [resourceBusy, setResourceBusy] = useState(false);
  const [permanentTargets, setPermanentTargets] = useState([]);
  const [templateDraft, setTemplateDraft] = useState(null), [templateDeleteTarget, setTemplateDeleteTarget] = useState(null);
  const [rigSession, setRigSession] = useState(null), [rigStartDrafts, setRigStartDrafts] = useState([]);
  const [rigDraftSaveStatus, setRigDraftSaveStatus] = useState({ status: "idle", message: "本机骨架草稿" });
  const rigSessionRef = useRef(null), rigDraftStorageKey = useRef(null);
  const rigDraftMounted = useRef(true), rigDraftWriter = useRef(null);
  if (!rigDraftWriter.current) rigDraftWriter.current = createRigDraftWriter({
    save: saveRigDraft,
    onStatus: (value) => { if (rigDraftMounted.current) setRigDraftSaveStatus(value); },
    onError: (error) => { if (rigDraftMounted.current) setError(error.message); },
    onSaved: (metadata, value) => { if (rigSessionRef.current?.key === value.sessionKey) rigDraftStorageKey.current = metadata.id; },
  });
  const flushRigDraft = useCallback(() => rigDraftWriter.current.flush(), []);
  const updateRigDraft = useCallback((document, sessionKey) => {
    const session = rigSessionRef.current;
    if (!session || session.key !== sessionKey) return;
    if (!document.sourceImage && !document.joints.length && !document.parts.length && document.name === "新角色") return;
    const current = session?.authoringId ? { ...document, id: session.authoringId, ownerResourceId: session.resourceId } : document;
    rigDraftWriter.current.enqueue({ document: current, resourceId: session.resourceId, resourceUpdatedAt: session.resourceUpdatedAt, sessionKey });
  }, []);
  const onRigDraftChange = useCallback((document) => updateRigDraft(document, rigSession?.key), [updateRigDraft, rigSession?.key]);
  useEffect(() => {
    rigDraftMounted.current = true;
    const detach = attachRigDraftExitGuards(rigDraftWriter.current);
    return () => {
      rigDraftMounted.current = false; detach(); rigDraftWriter.current.dispose();
      void flushRigDraft().catch(() => {});
    };
  }, [flushRigDraft]);
  const [aiStatus, setAIStatus] = useState(null), [aiConnectionReturn, setAIConnectionReturn] = useState(null);
  const aiClient = useRef(createLocalGenerationProvider()).current;
  const aiStatusSequence = useRef(0);
  const refreshAI = useCallback(async () => {
    const sequence = ++aiStatusSequence.current;
    try { const value = await aiClient.status(); if (sequence === aiStatusSequence.current) setAIStatus(value); }
    catch (e) { if (sequence === aiStatusSequence.current) setAIStatus({ connected: false, message: e.message }); }
  }, [aiClient]);
  const aiConnectionChanged = (value) => { aiStatusSequence.current++; setAIStatus(value); };
  const openAIConnection = () => { setAIConnectionReturn(modal === "generation" ? "generation" : null); setModal("ai-connection"); };
  useEffect(() => {
    void refreshAI(); window.addEventListener("focus", refreshAI);
    return () => window.removeEventListener("focus", refreshAI);
  }, [refreshAI]);
  const clock = useRef(makeClock()),
    importInput = useRef(),
    replacementInput = useRef(),
    templateSequence = useRef(0),
    undoStack = useRef([]),
    redoStack = useRef([]);
  const notify = useCallback((text) => {
    setToast(text);
    setLogs((values) =>
      [
        {
          text,
          date: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
          id: crypto.randomUUID(),
        },
        ...values,
      ].slice(0, 30),
    );
  }, []);
  const openCreationStep = (step) => {
    if (step === 1 && bundle && hasRigAuthoring(bundle.files)) { void editResourceRig(project); return; }
    if (step < 2) {
      setGenerationKind(step === 0 ? "appearance" : "parts");
      setModal("generation");
    } else if (step === 2) {
      setModal(null);
      setShowParts(true);
      notify("逐个检查部件接缝，并切换所有动作检查遮挡；确认后可导出资源。");
    } else setModal("export");
  };
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!modal && !editing) return;
    const previous = document.activeElement,
      dialog = document.querySelector('[role="dialog"]');
    const focusable = () =>
      [
        ...dialog.querySelectorAll(
          "button:not(:disabled),input:not([hidden]),textarea,select,canvas[tabindex]",
        ),
      ].filter((e) => e.offsetParent !== null);
    focusable()[0]?.focus();
    const key = (e) => {
      if (e.key === "Escape" && modal && !exporting && !resourceBusy) setModal(null);
      if (e.key !== "Tab") return;
      const targets = focusable(),
        first = targets[0],
        last = targets.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (previous?.isConnected) previous.focus();
    };
  }, [modal, editing, exporting, resourceBusy]);
  useEffect(() => {
    let stopped = false;
    Promise.allSettled([fetch("/templates/catalog.json").then((response) => {
        if (!response.ok) throw new Error("模板目录加载失败。");
        return response.json();
      }), listCustomTemplates()]).then(([builtIn, custom]) => {
        if (stopped) return;
        const items = [...(custom.status === "fulfilled" ? custom.value : []), ...(builtIn.status === "fulfilled" ? builtIn.value : [])];
        setCatalog(items);
        setSelectedTemplate(items[0] || null);
        const failure = [builtIn, custom].find((result) => result.status === "rejected");
        if (failure) setError(failure.reason.message);
        if (!items.length) setLoading(false);
      });
    (isDesktop ? desktopProjects() : listProjects())
      .then(setProjects)
      .catch((e) => setError(e.message));
    listTrashedProjects().then(setTrash).catch((e) => setError(e.message));
    return () => { stopped = true; };
  }, []);
  useEffect(() => watchWorkspace(async () => {
    const [library, custom] = await Promise.all([listProjectLibrary(), listCustomTemplates()]);
    setProjects(library.projects); setTrash(library.trash);
    setCatalog((items) => [...custom, ...items.filter((item) => item.source !== "custom")]);
  }), []);
  useEffect(() => {
    if (!selectedTemplate || page !== "home" || tab !== "templates") return;
    const sequence = ++templateSequence.current;
    setLoading(true);
    setError("");
    (selectedTemplate.source === "custom"
      ? getCustomTemplate(selectedTemplate.id).then((record) => {
        if (!record) throw new Error("这个模板已被删除，请刷新模板库。");
        return parseBundle(record.files, { name: record.name, skeletonPath: record.skeletonPath, id: `template-${record.id}` });
      })
      : loadCatalogTemplate(selectedTemplate))
      .then(prepare)
      .then((value) => {
        if (sequence !== templateSequence.current) return;
        setBundle(value);
        setAnimation(defaultAnimation(value.animations));
        setSkin(value.skins[0] || "");
        setEdits(EMPTY);
        setCompiled(EMPTY);
        clock.current.seek(0);
      })
      .catch((e) => {
        if (sequence === templateSequence.current) { setError(e.message); setBundle(null); }
      })
      .finally(() => {
        if (sequence === templateSequence.current) setLoading(false);
      });
  }, [selectedTemplate, page, tab]);
  useEffect(() => {
    const timer = setInterval(() => setTime(clock.current.read()), 100);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!bundle || page !== "editor") return;
    let cancelled = false;
    setProcessing(true);
    const timer = setTimeout(() => {
      compilePages(bundle, edits)
        .then((pages) => {
          if (!cancelled) {
            setCompiled(pages);
            setError("");
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          if (!cancelled) setProcessing(false);
        });
    }, 90);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bundle, edits, page]);
  const persist = useCallback(
    async (explicit = false, { force = false } = {}) => {
      if (!project || !bundle) return;
      if (!shouldPersistProject({ project, name: projectName, edits, generation, explicit: explicit || force, persisted: persistedProjects.current.has(project.id) })) {
        setSaveState("临时草稿 · 修改后自动保存"); return;
      }
      setSaving(true);
      try {
        const canvas = document.querySelector(
          '[data-preview="edited"] .spine-canvas',
        );
        const thumbnail =
          canvas && canvas.width > 0
            ? canvas.toDataURL("image/png")
            : project.thumbnail;
        const record = {
          id: project.id,
          name: projectName || bundle.name,
          files: bundle.files,
          skeletonPath: bundle.skeletonPath,
          edits,
          generation,
          templateId: project.templateId,
          thumbnail,
          boneCount: bundle.boneCount,
          partCount: bundle.parts.length,
          animationCount: bundle.animations.length,
        };
        const saved = await saveProject(record, { expectedUpdatedAt: projectVersions.current.get(project.id) });
        projectVersions.current.set(project.id, saved.updatedAt);
        persistedProjects.current.add(project.id);
        setProjects(await listProjects());
        setSaveState("已保存到本机");
        if (explicit) notify("工程已保存到本机。");
        return saved;
      } catch (e) {
        setSaveState("保存失败");
        setError(e.message);
        throw e;
      } finally {
        setSaving(false);
      }
    },
    [bundle, edits, generation, project, projectName, notify],
  );
  useEffect(() => {
    if (page !== "editor" || !project) return;
    if (!shouldPersistProject({ project, name: projectName, edits, generation, persisted: persistedProjects.current.has(project.id) })) {
      setSaveState("临时草稿 · 修改后自动保存"); return;
    }
    setSaveState("等待保存…");
    const timer = setTimeout(() => {
      void persist().catch(() => {});
    }, 850);
    return () => clearTimeout(timer);
  }, [persist, page, project]);
  const resetUndo = () => {
    undoStack.current = [];
    redoStack.current = [];
    setHistoryCount(0);
  };
  const editSnapshot = () => ({ bundle, edits, selectedPart });
  const restoreEditSnapshot = (snapshot) => {
    setBundle(snapshot.bundle);
    setEdits(snapshot.edits);
    setSelectedPart(snapshot.bundle.parts.some((part) => part.id === snapshot.selectedPart)
      ? snapshot.selectedPart : snapshot.bundle.parts[0]?.id || "");
  };
  const updateEdits = (next, nextBundle = bundle) => {
    undoStack.current.push(editSnapshot());
    undoStack.current = undoStack.current.slice(-30);
    redoStack.current = [];
    if (nextBundle !== bundle) setBundle(nextBundle);
    setEdits(Object.assign(Object.create(null), next));
    setHistoryCount((v) => v + 1);
  };
  const undo = () => {
    const previous = undoStack.current.pop();
    if (previous) {
      redoStack.current.push(editSnapshot());
      restoreEditSnapshot(previous);
      setHistoryCount((v) => v + 1);
    }
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (next) {
      undoStack.current.push(editSnapshot());
      restoreEditSnapshot(next);
      setHistoryCount((v) => v + 1);
    }
  };
  const togglePlay = () => {
    const value = !playing;
    setPlaying(value);
    clock.current.set({ playing: value });
  };
  useEffect(() => {
    const key = (e) => {
      if (
        page !== "editor" ||
        editing ||
        modal ||
        /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const changeAnimation = (name) => {
    setAnimation(name);
    clock.current.seek(0);
    setTime(0);
  };
  const openEditor = (value, metadata = {}) => {
    if (metadata.id) projectVersions.current.set(metadata.id, metadata.updatedAt);
    templateSequence.current++;
    setLoading(false);
    setBundle(value);
    if (hasRigAuthoring(value.files)) setPreviewMode("resource");
    setProject({
      id: metadata.id || crypto.randomUUID(),
      templateId: metadata.templateId,
      thumbnail: metadata.thumbnail,
      isDraft: metadata.isDraft === true,
      initialName: metadata.name || `${value.name} · 新资源`,
    });
    setProjectName(metadata.name || `${value.name} · 新资源`);
    setEdits(
      Object.assign(
        Object.create(null),
        metadata.edits || value.edits || EMPTY,
      ),
    );
    setCompiled(EMPTY);
    setGeneration(metadata.generation || value.generation || {});
    setSelectedPart(value.parts[0]?.id || "");
    setAnimation(defaultAnimation(value.animations));
    setSkin(value.skins[0] || "");
    setError("");
    resetUndo();
    setShowParts(isDesktop);
    setPartSearch("");
    setPage("editor");
    clock.current.seek(0);
  };
  const createResource = () => {
    if (bundle && !loading) {
      openEditor(bundle, {
        isDraft: true,
        templateId: selectedTemplate?.id,
        thumbnail: selectedTemplate?.thumbnail,
      });
      notify("已打开临时草稿。修改内容后会自动保存，也可主动保存。");
    }
  };
  const showRigWorkbench = (document = null, { resourceId = null, resourceUpdatedAt = null, draftId = null, notice = "", manualAdjustment = false, selectedPartId = null } = {}) => {
    templateSequence.current++;
    const session = { document, resourceId, resourceUpdatedAt, key: crypto.randomUUID(), saveResourceId: resourceId || crypto.randomUUID(), forkResourceId: crypto.randomUUID(), notice, manualAdjustment, selectedPartId };
    rigSessionRef.current = session; rigDraftStorageKey.current = draftId;
    rigDraftWriter.current.setSession(session.key);
    setRigSession(session);
    setProject(null); setModal(null); setError(""); setPage("rig");
  };
  const beginRigCreation = async () => {
    if (resourceBusy) return;
    setResourceBusy(true); setError("");
    try {
      await flushRigDraft();
      const drafts = await listRigDrafts();
      if (!drafts.length) showRigWorkbench();
      else { setRigStartDrafts(drafts); setModal("rig-start"); }
    } catch (e) { setError(e.message); }
    finally { setResourceBusy(false); }
  };
  const resumeRigDraft = async (id) => {
    if (resourceBusy) return;
    setResourceBusy(true); setError("");
    try {
      await flushRigDraft();
      const draft = await getRigDraft(id);
      if (!draft) throw new Error("这份骨架草稿不存在，请重新选择。");
      const destination = rigDraftDestination(draft, projects);
      const document = destination.forked ? { ...draft.document, id: `rig-${crypto.randomUUID()}`, ownerResourceId: undefined } : draft.document;
      showRigWorkbench(document, { ...destination, draftId: draft.id });
    } catch (e) { setError(e.message); }
    finally { setResourceBusy(false); }
  };
  const editResourceRig = async (record, { manualAdjustment = false, selectedPartId = null } = {}) => {
    if (!record || resourceBusy || processing) return;
    setResourceBusy(true); setError("");
    const adjustmentOptions = manualAdjustment ? { manualAdjustment: true, selectedPartId } : {};
    try {
      await flushRigDraft();
      const currentRecord = page === "editor" ? await persist() || record : record;
      const draftId = `resource-${currentRecord.id}`, draft = await getRigDraft(draftId);
      if (draft?.resourceId === currentRecord.id && draft.document.ownerResourceId === currentRecord.id &&
          rigDraftDestination(draft, [currentRecord]).resourceId === currentRecord.id) {
        showRigWorkbench(draft.document, { resourceId: currentRecord.id, resourceUpdatedAt: currentRecord.updatedAt, draftId, ...adjustmentOptions });
        return;
      }
      const document = readRigAuthoring(currentRecord.files);
      if (!document) throw new Error("该资源未包含可编辑的新骨架数据。");
      const current = await rigWithCalibratedParts(document, parseBundle(currentRecord.files, { skeletonPath: currentRecord.skeletonPath }), currentRecord.edits || {});
      if (current.ownerResourceId !== currentRecord.id) { current.id = `rig-${currentRecord.id}`; current.ownerResourceId = currentRecord.id; }
      if (draft) await saveRigDraft({ ...draft.document, id: `rig-${crypto.randomUUID()}`, ownerResourceId: undefined });
      showRigWorkbench(current, { resourceId: currentRecord.id, resourceUpdatedAt: currentRecord.updatedAt, draftId, ...adjustmentOptions });
      if (draft) notify("原骨架草稿的资源版本或归属已变，已单独保留；当前打开最新资源及校准。");
    } catch (e) { setError(e.message); }
    finally { setResourceBusy(false); }
  };
  const saveRigResource = async (document, previewBundle) => {
    if (document.parts.some((part) => !part.image || part.completion !== "ready" || ["source-crop", "placeholder"].includes(part.imageSource))) throw new Error("请先补绘或导入全部独立部件，再保存为正式资源。");
    setResourceBusy(true); setError("");
    try {
      await flushRigDraft();
      const session = rigSessionRef.current;
      const latest = session.resourceId ? await getProject(session.resourceId) : null;
      const conflict = Boolean(session.resourceId && (!latest || latest.updatedAt !== session.resourceUpdatedAt));
      const existing = !conflict ? latest : null;
      const id = conflict ? session.forkResourceId : session.saveResourceId;
      const authored = { ...document, ownerResourceId: id, id: conflict ? `rig-${id}` : session.authoringId || document.id };
      const value = prepare(parseBundle(attachRigAuthoring(previewBundle.files, authored), { skeletonPath: previewBundle.skeletonPath, name: document.name, id }));
      const canvas = window.document.querySelector('[data-rig-preview] .spine-canvas');
      const thumbnail = canvas?.width ? canvas.toDataURL("image/png") : document.sourceImage || existing?.thumbnail;
      const reference = document.sourceImage ? imageDataBytes(document.sourceImage).bytes : null;
      const generation = existing?.generation || (reference ? { appearance: { image: reference, fileName: "character-reference.png", prompt: "" } } : {});
      const record = { id, name: document.name, files: value.files, skeletonPath: value.skeletonPath,
        edits: {}, generation, thumbnail, templateId: existing?.templateId,
        boneCount: value.boneCount, partCount: value.parts.length, animationCount: value.animations.length };
      const saved = await saveProject(record, existing ? { expectedUpdatedAt: session.resourceUpdatedAt } : {});
      const committedSession = { ...session, resourceId: id, saveResourceId: id, forkResourceId: crypto.randomUUID(), authoringId: authored.id, resourceUpdatedAt: saved.updatedAt };
      rigSessionRef.current = committedSession; setRigSession(committedSession);
      persistedProjects.current.add(id);
      setProjects((items) => [saved, ...items.filter((item) => item.id !== id)]);
      await saveRigDraft(authored, { resourceId: id, resourceUpdatedAt: saved.updatedAt, previousDraftId: rigDraftStorageKey.current });
      rigSessionRef.current = null; rigDraftWriter.current.setSession(null);
      setRigSession(null); openEditor(value, saved);
      notify(conflict ? "原资源已有更新，当前骨架已另存为新资源，原来的修改仍保留。" : "新骨架和动作已保存为资源，可继续校准、预览或导出。");
    } catch (e) { setError(e.message); throw e; }
    finally { setResourceBusy(false); }
  };
  const openProject = async (record) => {
    try {
      if (!record.files) record = await getProject(record.id);
      if (!record) throw new Error("这个资源已被删除，请重新选择。");
      openEditor(
        prepare(
          parseBundle(record.files, {
            skeletonPath: record.skeletonPath,
            name: record.name,
          }),
        ),
        record,
      );
    } catch (e) {
      setError(e.message);
    }
  };
  const finishImport = (files, skeletonPath) => {
    const value = prepare(
      parseBundle(files, {
        skeletonPath,
        name:
          skeletonPath
            ?.split("/")
            .at(-1)
            .replace(/\.(json|skel)$/i, "") || "导入的资源",
      }),
    );
    openEditor(value, { name: value.name });
    setImportChoice(null);
    setModal(null);
    notify(
      `已导入 ${value.parts.length} 个纹理部件、${value.animations.length} 个动作。`,
    );
  };
  const importFiles = async (files) => {
    if (!files?.length) return;
    setLoading(true);
    setImporting(true);
    setError("");
    try {
      const entries = await readImportFiles(files, { unpack: unpackInWorker });
      try {
        finishImport(entries);
      } catch (e) {
        if (e.candidates) {
          setImportChoice({
            files: entries,
            candidates: e.candidates,
            selected: e.candidates[0],
          });
          setModal("choose-skeleton");
        } else throw e;
      }
    } catch (e) {
      setError(`导入失败：${e.message}`);
    } finally {
      setLoading(false);
      setImporting(false);
    }
  };
  const replacePart = async (file) => {
    if (!file || !selectedPart) return;
    try {
      const replacement = await readReplacement(file);
      updateEdits({ ...edits, [selectedPart]: replacement });
      setEditing(true);
      notify("部件图片已替换，请检查并完成校准。");
    } catch (e) {
      setError(`替换失败：${e.message}`);
    }
  };
  const doExport = async () => {
    if (!bundle) return;
    setExporting(true);
    setError("");
    try {
      const pages = await compilePages(bundle, edits),
        editable = exportMode === "project";
      const files = hasRigAuthoring(bundle.files) ? await synchronizeRigAuthoring(bundle, edits) : bundle.files;
      const bytes = await exportInWorker({ ...bundle, files }, pages, {
        editable,
        target: exportMode === "unity" ? "unity" : undefined,
        edits,
        name: projectName,
        generation,
      });
      triggerDownload(
        bytes,
        `${exportName(projectName)}${editable ? "-工程" : exportMode === "unity" ? "-Unity" : "-Spine4.3"}.zip`,
      );
      notify(
        `${editable ? "可编辑工程" : exportMode === "unity" ? "Unity 资源包" : "Spine 资源包"}已导出，重新解析校验通过。`,
      );
      setModal(null);
      void persist(false, { force: true }).catch(() => {});
    } catch (e) {
      setError(`导出失败：${e.message}`);
    } finally {
      setExporting(false);
    }
  };
  const leaveEditor = async () => {
    try {
      await persist();
      setPage("home");
      setTab("characters");
      setProject(null);
    } catch {
      /* Preserve unsaved work in the open editor. */
    }
  };
  const navigateLibrary = async (next) => {
    if (editing || importing || exporting || resourceBusy || (page === "rig" && document.querySelector('.rig-workbench [role="dialog"]'))) { notify("请先完成或取消当前操作。"); return; }
    try {
      if (page === "editor") await persist();
      if (page === "rig") {
        await flushRigDraft();
        rigSessionRef.current = null; rigDraftWriter.current.setSession(null);
      }
      setPage("home"); setTab(next); setProject(null); setModal(null);
    } catch { /* Keep the editor open if saving fails. */ }
  };
  const updateResource = async (record, restore = false) => {
    if (!record || resourceBusy) return;
    setResourceBusy(true); setError("");
    try {
      await (restore ? restoreProject(record.id) : trashProject(record.id));
      const library = await listProjectLibrary();
      setProjects(library.projects); setTrash(library.trash);
      setModal(null); setTrashTarget(null);
      notify(restore ? `已恢复「${record.name}」。` : `已将「${record.name}」移入回收站。`);
    } catch (e) { setError(e.message); }
    finally { setResourceBusy(false); }
  };
  const deleteForever = async () => {
    if (!permanentTargets.length || resourceBusy) return;
    setResourceBusy(true); setError("");
    try {
      const count = await permanentlyDeleteProjects(permanentTargets.map((record) => record.id));
      const library = await listProjectLibrary();
      setProjects(library.projects); setTrash(library.trash);
      setPermanentTargets([]); setModal(null);
      notify(`已永久删除 ${count} 个资源。`);
    } catch (e) { setError(e.message); }
    finally { setResourceBusy(false); }
  };
  const confirmPermanentDelete = (records) => { setPermanentTargets(records); setError(""); setModal("permanent-delete"); };
  const beginAddTemplate = (record) => {
    if (!record || record.deletedAt || resourceBusy) return;
    const existing = catalog.find((item) => item.source === "custom" && item.sourceProjectId === record.id);
    const original = existing || catalog.find((item) => String(item.id) === String(record.templateId));
    setTemplateDraft({ record, name: existing?.name || record.name, type: original?.type || "role", categories: [...(original?.categories || [])], updating: Boolean(existing) });
    setError(""); setModal("add-template");
  };
  const addResourceTemplate = async () => {
    if (!templateDraft?.name.trim() || resourceBusy) return;
    setResourceBusy(true); setError("");
    try {
      const source = templateDraft.record;
      const value = prepare(parseBundle(source.files, { skeletonPath: source.skeletonPath, name: source.name }));
      const pages = await compilePages(value, source.edits || {});
      const baked = await unpackInWorker(await exportInWorker(value, pages, { editable: false }));
      const record = createCustomTemplateRecord({ ...source, name: templateDraft.name.trim() }, baked, { type: templateDraft.type, categories: templateDraft.categories });
      const saved = await saveCustomTemplate(record);
      setCatalog((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setSelectedTemplate(saved); setType("全部"); setCategory("我创建的"); setSearch("");
      setPage("home"); setTab("templates"); setProject(null); setModal(null); setTemplateDraft(null);
      notify(`已${templateDraft.updating ? "更新" : "加入"}模板「${saved.name}」，可在「我创建的」中复用。`);
    } catch (e) { setError(`保存模板失败：${e.message}`); }
    finally { setResourceBusy(false); }
  };
  const removeTemplate = async () => {
    if (!templateDeleteTarget || resourceBusy) return;
    setResourceBusy(true); setError("");
    try {
      await deleteCustomTemplate(templateDeleteTarget.id);
      setCatalog((items) => items.filter((item) => item.id !== templateDeleteTarget.id));
      if (selectedTemplate?.id === templateDeleteTarget.id) { setSelectedTemplate(null); setBundle(null); setLoading(false); }
      setModal(null); setTemplateDeleteTarget(null); notify("模板已删除，原资源和从模板创建的资源仍保留。");
    } catch (e) { setError(e.message); }
    finally { setResourceBusy(false); }
  };
  useEffect(() => window.aiSpineDesktop?.onAction((action) => {
    if (page === "rig" && document.querySelector('.rig-workbench [role="dialog"]')) { notify("请先应用或取消部件校准。"); return; }
    if (action === "library" || action === "templates") void navigateLibrary(action === "library" ? "characters" : "templates");
    else if (action === "import") setModal("import");
    else if (action === "save") {
      if (page === "rig") void flushRigDraft().then(() => notify("骨架草稿已保存到本机。")).catch((e) => setError(e.message));
      else void persist(true).catch(() => {});
    }
    else if (action === "export" && page === "editor") setModal("export");
    else if (action === "guide") setModal("guide");
    else if (action === "ai-connection") openAIConnection();
    else if (action === "close") {
      if (editing || importing || exporting || resourceBusy) { notify("请先完成当前操作，再关闭窗口。"); return; }
      void (page === "rig" ? flushRigDraft() : persist()).then(() => window.aiSpineDesktop.closeReady()).catch((e) => setError(e.message));
    }
  }));
  const visibleTemplates = catalog.filter(
    (item) =>
      (type === "全部" ||
        item.type === (type === "角色" ? "role" : "effect")) &&
      (category === "全部" || (category === "我创建的" ? item.source === "custom" : item.categories.includes(category))) &&
      (!search || item.name.toLowerCase().includes(search.toLowerCase())),
  );
  const templateComparison = useMemo(() => {
    if (!bundle) return { bundle: null };
    try { return { bundle: templateVariantBase(bundle), variants: templateVariantEntries(bundle) }; }
    catch (error) { return { bundle: null, error: error.message }; }
  }, [bundle]);
  const partLabel = (part) => templateComparison.variants?.find((variant) => variant.regionId === part.id)?.name || part.name;
  const part = bundle?.parts.find((p) => p.id === selectedPart),
    duration = bundle?.durations?.[animation] || 1;
  const visibleParts =
      bundle?.parts.filter((p) =>
        p.id.toLowerCase().includes(partSearch.toLowerCase()),
      ) || [],
    changeCount = Object.keys(edits).length;
  return (
    <div
      className={`app-shell explorer-shell ${isDesktop ? "desktop-shell" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          if (page !== "rig" && !editing && !modal) void importFiles([...e.dataTransfer.files]);
        }
      }}
    >
      {isDesktop && <div className="desktop-titlebar"><span>iSpine</span><small>角色动画工作台</small></div>}
      <header className="workbench-header explorer-app-header">
        <button className="explorer-brand" aria-label="iSpine · 返回我的资源" onClick={() => void navigateLibrary("characters")}><Layers size={29} /><strong>iSpine</strong></button>
        <nav className="explorer-navigation" aria-label="工作台导航">
          <button className={page === "home" && tab === "characters" ? "active" : ""} aria-current={page === "home" && tab === "characters" ? "page" : undefined} onClick={() => void navigateLibrary("characters")}><FolderOpen size={17} /><span>我的资源</span><small>{projects.length}</small></button>
          <button className={page === "home" && tab === "templates" ? "active" : ""} aria-current={page === "home" && tab === "templates" ? "page" : undefined} onClick={() => void navigateLibrary("templates")}><Grid2X2 size={17} /><span>模板库</span><small>{catalog.length}</small></button>
          <button className={page === "home" && tab === "trash" ? "active" : ""} aria-current={page === "home" && tab === "trash" ? "page" : undefined} onClick={() => void navigateLibrary("trash")}><Trash2 size={17} /><span>回收站</span><small>{trash.length}</small></button>
        </nav>
        <div className="header-actions">
          <button
            className="icon-button framed"
            aria-label="操作记录"
            onClick={() => setModal("history")}
          >
            <History size={19} />
          </button>
          <button className="ai-header-status" aria-label={`AI 连接：${aiStatus ? aiStatus.connected ? `${aiStatus.label}已连接` : "尚未连接" : "正在检查"}`} onClick={openAIConnection}>
            <Sparkles size={17} /><span>AI 连接</span><i className={aiStatus?.connected ? "connected" : ""} /><strong>{aiStatus ? aiStatus.connected ? `${aiStatus.label}已连接` : "尚未连接" : "正在检查…"}</strong><ChevronDown size={14} />
          </button>
          <button className="button" aria-label="使用引导" onClick={() => setModal("guide")}>
            <BookOpen size={16} />
            <span>使用引导</span>
          </button>
        </div>
      </header>
      <input
        ref={importInput}
        type="file"
        multiple
        accept=".zip,.json,.skel,.bytes,.atlas,.txt,.png,.jpg,.jpeg,.webp"
        hidden
        onChange={(e) => {
          void importFiles([...e.target.files]);
          e.target.value = "";
        }}
      />
      <input
        ref={replacementInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          void replacePart(e.target.files[0]);
          e.target.value = "";
        }}
      />
      {error && !modal && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="关闭错误提示"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {page === "rig" ? (
        <RigWorkbench key={rigSession?.key} initialDocument={rigSession?.document || null}
          initialManualAdjustment={Boolean(rigSession?.manualAdjustment)} initialPartId={rigSession?.selectedPartId}
          saveHint={rigSession?.notice || ""}
          draftSaveStatus={rigDraftSaveStatus}
          onDraftChange={onRigDraftChange} onSave={saveRigResource}
          onClose={() => void navigateLibrary("characters")} connectionStatus={aiStatus} onOpenConnection={openAIConnection} />
      ) : page === "home" ? (
        <main className="home-main">
          {tab === "templates" ? (
            <TemplateLibrary catalog={catalog} visibleTemplates={visibleTemplates} selectedTemplate={selectedTemplate}
              onSelect={setSelectedTemplate} type={type} category={category} search={search}
              onType={setType} onCategory={setCategory} onSearch={setSearch}
              bundle={bundle} loading={loading} clock={clock.current} animation={animation} skin={skin} playing={playing}
              onAnimation={changeAnimation} onTogglePlay={togglePlay} onCreate={createResource}
              onDeleteTemplate={(item) => { if (!resourceBusy && item.source === "custom") { setTemplateDeleteTarget(item); setError(""); setModal("delete-template"); } }}
              onImport={() => { setError(""); setModal("import"); }} projects={projects} onOpen={openProject} />
          ) : (
            <ResourceLibrary projects={projects} trash={trash} showTrash={tab === "trash"} onOpen={openProject} onImport={() => setModal("import")}
              onCreateRig={() => void beginRigCreation()} onEditRig={(record) => void editResourceRig(record)}
              onManualAdjust={(record) => void editResourceRig(record, { manualAdjustment: true })}
              onBrowseTemplates={() => void navigateLibrary("templates")}
              onAddTemplate={beginAddTemplate} customTemplateProjectIds={catalog.filter((item) => item.source === "custom").map((item) => item.sourceProjectId)}
              busy={resourceBusy} onRestore={(record) => void updateResource(record, true)}
              onDeleteForever={(record) => confirmPermanentDelete([record])} onEmptyTrash={confirmPermanentDelete}
              onTrash={(record) => { setTrashTarget(record); setError(""); setModal("trash-resource"); }} />
          )}
        </main>
      ) : (
        <main className="editor-main" key={bundle?.id}>
          <div className="project-toolbar">
            <button
              className="button subtle"
              onClick={() => void leaveEditor()}
              disabled={saving}
            >
              <ArrowLeft size={16} />
              返回首页
            </button>
            <input
              className="project-name-input"
              aria-label="资源名称"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
            <span
              className={`save-indicator ${saveState.includes("失败") ? "error" : ""}`}
            >
              {saving ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <CheckCircle2 size={13} />
              )}
              {saving ? "正在保存…" : saveState}
            </span>
            <div className="toolbar-spacer" />
            {hasRigAuthoring(bundle?.files) && <button className="button" disabled={processing || resourceBusy} onClick={() => void editResourceRig({ ...project, name: projectName, files: bundle.files, skeletonPath: bundle.skeletonPath, edits, generation })}><Bone size={16} />骨架与动作</button>}
            {hasRigAuthoring(bundle?.files) && <button className="button" disabled={processing || resourceBusy} onClick={() => void editResourceRig({ ...project, name: projectName, files: bundle.files, skeletonPath: bundle.skeletonPath, edits, generation }, { manualAdjustment: true, selectedPartId: selectedPart })}><Move size={16} />手动调整</button>}
            <button className="button accent" onClick={() => openCreationStep(generation.appearance ? 1 : 0)}>
              <Sparkles size={16} /> AI 创作
            </button>
            <button
              className="button"
              onClick={() => void persist(true).catch(() => {})}
              disabled={saving}
            >
              <Save size={15} />
              保存
            </button>
            <button
              className="button primary"
              onClick={() => setModal("export")}
              disabled={processing}
            >
              <Download size={16} />
              导出
            </button>
          </div>
          <CreationWorkflow hasAppearance={!!generation.appearance?.image} replaced={bundle.parts.filter((part)=>edits[part.id]).length}
            total={bundle.parts.length} animations={bundle.animations.length} active={2} onStep={openCreationStep} disabled={processing} authored={hasRigAuthoring(bundle.files)} rigSummary={rigAuthoringSummary(bundle.files)}/>
          <section className="panel calibration-panel">
            <div className="animation-toolbar">
              <label>
                动作{" "}
                <select
                  aria-label="校准动作"
                  value={animation}
                  onChange={(e) => changeAnimation(e.target.value)}
                >
                  {bundle?.animations.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <button
                className="icon-button framed"
                aria-label={playing ? "暂停动画" : "播放动画"}
                onClick={togglePlay}
              >
                {playing ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <label className="speed-control">
                两侧同步{" "}
                <select
                  aria-label="播放速度"
                  value={speed}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    setSpeed(value);
                    clock.current.set({ speed: value });
                  }}
                >
                  {[0.25, 0.5, 1, 1.5, 2].map((value) => (
                    <option key={value} value={value}>
                      {value * 100}%
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button subtle"
                onClick={() => {
                  clock.current.seek(0);
                  setTime(0);
                }}
              >
                <RotateCcw size={14} />
                复位
              </button>
              {bundle?.skins.length > 1 && (
                <label>
                  皮肤{" "}
                  <select
                    aria-label="预览皮肤"
                    value={skin}
                    onChange={(e) => setSkin(e.target.value)}
                  >
                    {bundle.skins.map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
              )}
              <div className="toolbar-spacer" />
              <button className="button subtle"
                onClick={() => setPreviewMode(previewMode === "resource" ? "compare" : "resource")}><Layers size={16} />{previewMode === "resource" ? "模板对照" : "放大资源"}</button>
              <button
                className={`button subtle ${showBones ? "active" : ""}`}
                onClick={() => setShowBones(!showBones)}
                aria-pressed={showBones}
              >
                <Bone size={15} />
                骨骼
              </button>
              <button
                className={`button subtle ${showParts ? "active" : ""}`}
                onClick={() => setShowParts(!showParts)}
                aria-pressed={showParts}
              >
                <Layers size={15} />
                部件列表
              </button>
            </div>
            <div className="part-toolbar">
              <label>
                当前部件{" "}
                <select
                  aria-label="选择部件"
                  value={selectedPart}
                  onChange={(e) => setSelectedPart(e.target.value)}
                >
                  {bundle?.parts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {edits[p.id] ? "● " : ""}
                      {partLabel(p)}
                    </option>
                  ))}
                </select>
              </label>
              <span className="part-dimensions">
                {part?.originalWidth} × {part?.originalHeight}
              </span>
              <button
                className="button accent"
                disabled={!part}
                onClick={() => replacementInput.current.click()}
              >
                <Replace size={15} />
                替换图片
              </button>
              <button
                className="button"
                disabled={!part}
                onClick={() => setEditing(true)}
              >
                <SlidersHorizontal size={15} />
                调整细节
              </button>
              <button
                className="button subtle"
                disabled={!edits[selectedPart]}
                onClick={() => {
                  const next = { ...edits };
                  delete next[selectedPart];
                  updateEdits(next);
                  notify("当前部件已恢复模板图片。");
                }}
              >
                <RotateCcw size={14} />
                恢复模板
              </button>
              <div className="toolbar-spacer" />
              <button
                className="icon-button"
                aria-label="撤销修改"
                disabled={!undoStack.current.length}
                onClick={undo}
              >
                <Undo2 size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="重做修改"
                disabled={!redoStack.current.length}
                onClick={redo}
              >
                <Redo2 size={17} />
              </button>
            </div>
            <div
              className={`comparison-layout ${showParts ? "with-parts" : ""} ${previewMode === "resource" ? "resource-focus" : ""}`}
            >
              {previewMode === "compare" && <div className="comparison-view">
                <div className="viewer-heading">
                  <span>模板动画</span>
                  <small>
                    {templateComparison.bundle?.boneCount} 根骨骼 · {templateComparison.bundle?.parts.length}{" "}
                    个纹理区域
                  </small>
                </div>
                {templateComparison.error && <p className="error-banner" role="alert">{templateComparison.error}</p>}
                {templateComparison.bundle && (
                  <SpineViewer
                    bundle={templateComparison.bundle}
                    clock={clock.current}
                    animation={animation}
                    skin={skin}
                    selected={selectedPart}
                    onSelect={setSelectedPart}
                    label="模板动画"
                    bones={showBones}
                  />
                )}
              </div>}
              <div className="comparison-view" data-preview="edited">
                <div className="viewer-heading">
                  <span>当前资源动画</span>
                  <small className={processing ? "accent-text" : ""}>
                    {processing
                      ? "正在更新贴图…"
                      : `${changeCount} 个部件已修改`}
                  </small>
                </div>
                {bundle && (
                  <SpineViewer
                    bundle={bundle}
                    pages={compiled}
                    clock={clock.current}
                    animation={animation}
                    skin={skin}
                    selected={selectedPart}
                    onSelect={setSelectedPart}
                    label="当前资源动画"
                    bones={showBones}
                  />
                )}
              </div>
              {showParts && (
                <aside className="parts-sidebar">
                  <div className="parts-search">
                    <Search size={15} />
                    <input
                      aria-label="搜索部件"
                      placeholder="搜索部件"
                      value={partSearch}
                      onChange={(e) => setPartSearch(e.target.value)}
                    />
                  </div>
                  <div className="parts-list">
                    {visibleParts.map((p) => (
                      <button
                        key={p.id}
                        className={`part-list-item ${p.id === selectedPart ? "selected" : ""}`}
                        onClick={() => setSelectedPart(p.id)}
                      >
                        <span>
                          {partLabel(p)}
                          <small>
                            {p.width} × {p.height}
                          </small>
                        </span>
                        {edits[p.id] && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                </aside>
              )}
            </div>
            <div className="timeline">
              <span>{(time % duration).toFixed(2)}s</span>
              <input
                aria-label="动画进度"
                type="range"
                min="0"
                max={duration}
                step=".01"
                value={Math.min(duration, time % duration)}
                onChange={(e) => {
                  clock.current.seek(Number(e.target.value));
                  setTime(Number(e.target.value));
                }}
              />
              <span>{duration.toFixed(2)}s</span>
            </div>
          </section>
          <div className="editor-footnote">
            <span>
              单击角色选择部件 · 拖动平移 · 滚轮缩放 · 空格播放 / 暂停
            </span>
            <span>输出保留原骨架、网格、皮肤和动作</span>
          </div>
        </main>
      )}
      {editing && bundle && part && (
        <PartEditor
          bundle={bundle}
          part={part}
          displayName={partLabel(part)}
          edit={edits[part.id]}
          onClose={() => setEditing(false)}
          onApply={(value) => {
            updateEdits({ ...edits, [part.id]: value });
            setEditing(false);
            notify("部件校准已应用，检查两侧动画中的关节和遮挡。");
          }}
        />
      )}
      {modal === "generation" && bundle && project && (
        <GenerationPanel bundle={bundle} projectId={project.id} selectedPart={selectedPart} currentAnimation={animation}
          ai={generation} onChange={setGeneration} onClose={() => setModal(null)}
          initialKind={generationKind} replaced={bundle.parts.filter((part)=>edits[part.id]).length} onStep={openCreationStep}
          captureTemplate={() => {
            if (templateComparison.error) throw new Error(templateComparison.error);
            return captureTemplatePreview(templateComparison.bundle, { animation, skin, time: clock.current.read() });
          }}
          onConfigure={openAIConnection}
          onApply={async (result, images, scope) => {
            const applicationBundle = scope && result.fingerprint !== await templateFingerprint(bundle)
              ? templateComparison.bundle : bundle;
            if (!applicationBundle) throw new Error("原模板无法恢复，未应用候选。");
            const next=await applyGeneratedParts(applicationBundle,edits,result,images);
            if (scope) {
              const image = images[0];
              const variant = await addTemplateVariant(bundle, {
                partId: image.partId, image: image.bytes, transform: next[image.partId].transform,
                name: scope.name, animations: scope.animations,
                provenance: { jobId: result.id, imageId: image.id },
              });
              const previousNative = bundle.files[variant.metadata.nativePath];
              const sameNative = previousNative?.length === image.bytes.length
                && previousNative.every((value, index) => value === image.bytes[index]);
              const replacement = (variant.metadata.unchanged || sameNative) && edits[variant.partId]
                ? edits[variant.partId] : variant.edit;
              updateEdits({ ...edits, [variant.partId]: replacement }, prepare(variant.bundle));
              setSelectedPart(variant.partId);
              changeAnimation(scope.animations[0]);
            } else {
              updateEdits(next);
              setSelectedPart(images[0].partId);
            }
            setModal(null);
            if(images.length===1)setEditing(true);
            notify(scope ? `已添加「${scope.name}」，用于 ${scope.animations.length} 个动作，请校准后预览。`
              : `已应用 ${images.length} 个 AI 部件，请校准后检查动画。`);
          }}/>
      )}
      {modal === "ai-connection" && <AIConnectionPanel onChanged={aiConnectionChanged} onClose={() => { setModal(aiConnectionReturn); void refreshAI(); }} />}
      {modal && !["generation", "ai-connection"].includes(modal) && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !exporting && !resourceBusy) setModal(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            className="modal simple-modal"
          >
            <header className="modal-header">
              <h2 id="dialog-title">
                {
                  {
                    import: "导入 Spine 资源",
                    guide: "开始使用工作台",
                    history: "操作记录",
                    export: "导出资源",
                    "choose-skeleton": "选择骨架",
                    "trash-resource": "删除资源",
                    "permanent-delete": "永久删除资源",
                    "add-template": templateDraft?.updating ? "更新模板" : "加入模板",
                    "delete-template": "删除模板",
                    "rig-start": "骨架与动作",
                  }[modal]
                }
              </h2>
              <button
                className="icon-button"
                aria-label="关闭对话框"
                disabled={exporting || resourceBusy}
                onClick={() => setModal(null)}
              >
                <X size={18} />
              </button>
            </header>
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            {modal === "rig-start" && <div className="simple-modal-body">
              <p className="muted">从立绘创建 Q 版人形角色的新骨架，或继续本机保存的草稿。</p>
              <button className="button primary full" disabled={resourceBusy} onClick={() => showRigWorkbench()}><Plus size={17} />从立绘新建</button>
              <div className="rig-saved-drafts">{rigStartDrafts.map((draft) => <button className="button" key={draft.id} disabled={resourceBusy} onClick={() => void resumeRigDraft(draft.id)}><Bone size={17} /><span>继续 {draft.name}<small>{draft.jointCount} 个关节 · {draft.completeParts} / {draft.partCount} 部件 · {draft.motionCount} 个动作</small></span><ChevronRight size={16} /></button>)}</div>
            </div>}
            {modal === "add-template" && templateDraft && <div className="simple-modal-body">
              <p className="muted">将当前部件和校准结果保存为独立模板，在「我创建的」中继续复用。</p>
              <label className="ai-setting-field">模板名称<input aria-label="模板名称" value={templateDraft.name} maxLength={100} disabled={resourceBusy} onChange={(e) => setTemplateDraft({ ...templateDraft, name: e.target.value })} /></label>
              <label className="ai-setting-field">类型<select aria-label="模板类型" value={templateDraft.type} disabled={resourceBusy} onChange={(e) => setTemplateDraft({ ...templateDraft, type: e.target.value, categories: [] })}><option value="role">角色</option><option value="effect">特效</option></select></label>
              <fieldset className="template-form-categories"><legend>分类（可多选）</legend>{[...new Set(catalog.filter((item) => item.type === templateDraft.type).flatMap((item) => item.categories))].map((value) => <label key={value}><input type="checkbox" checked={templateDraft.categories.includes(value)} disabled={resourceBusy} onChange={(e) => setTemplateDraft({ ...templateDraft, categories: e.target.checked ? [...templateDraft.categories, value] : templateDraft.categories.filter((item) => item !== value) })} />{value}</label>)}</fieldset>
              <p className="muted small">{templateDraft.updating ? "保存会更新这个资源对应的模板；已创建的资源保持各自内容。" : "原资源会继续保留，后续修改与模板互不影响。"}</p>
              <div className="button-row"><button className="button" disabled={resourceBusy} onClick={() => setModal(null)}>取消</button><button className="button primary" disabled={resourceBusy || !templateDraft.name.trim()} onClick={() => void addResourceTemplate()}>{resourceBusy ? "正在保存模板…" : "保存模板"}</button></div>
            </div>}
            {modal === "delete-template" && templateDeleteTarget && <div className="simple-modal-body resource-delete-confirm">
              <p>删除模板「<strong>{templateDeleteTarget.name}</strong>」？</p><p className="muted">模板删除后无法恢复。原资源和从这个模板创建的资源会继续保留。</p>
              <div className="button-row"><button className="button" disabled={resourceBusy} onClick={() => setModal(null)}>取消</button><button className="button danger" disabled={resourceBusy} onClick={() => void removeTemplate()}>{resourceBusy ? "正在删除…" : "确认删除模板"}</button></div>
            </div>}
            {modal === "trash-resource" && trashTarget && <div className="simple-modal-body resource-delete-confirm">
              <p>确认删除「<strong>{trashTarget.name}</strong>」？</p>
              <p className="muted">资源将移入回收站。替换图片、校准参数和形象参考会保留，可以随时恢复。</p>
              <div className="button-row"><button className="button" disabled={resourceBusy} onClick={() => setModal(null)}>取消</button>
                <button className="button danger" disabled={resourceBusy} onClick={() => void updateResource(trashTarget)}>{resourceBusy ? "正在删除…" : "确认删除"}</button></div>
            </div>}
            {modal === "permanent-delete" && <div className="simple-modal-body resource-delete-confirm">
              <p>{permanentTargets.length === 1 ? <>永久删除「<strong>{permanentTargets[0].name}</strong>」？</> : <>清空回收站中的 <strong>{permanentTargets.length}</strong> 个资源？</>}</p>
              <p className="delete-warning">原始资源、替换图片、校准参数和形象参考将从工作台永久删除，无法恢复。</p>
              <p className="muted small">已导出的文件和独立生成记录另行保留。</p>
              <div className="button-row"><button className="button" disabled={resourceBusy} onClick={() => setModal(null)}>取消</button>
                <button className="button danger" disabled={resourceBusy || !permanentTargets.length} onClick={() => void deleteForever()}>{resourceBusy ? "正在永久删除…" : `确认永久删除${permanentTargets.length > 1 ? ` ${permanentTargets.length} 个资源` : ""}`}</button></div>
            </div>}
            {modal === "import" && (
              <div className="simple-modal-body">
                <button
                  className="import-dropzone"
                  onClick={() => importInput.current.click()}
                >
                  <Upload size={34} />
                  <strong>选择 ZIP，或同时选择骨架、Atlas 和贴图</strong>
                  <span>也可以把文件拖到工作台中</span>
                </button>
                <div className="import-notes">
                  <p>
                    <Check size={15} />
                    支持 Spine 4.3.x 的 JSON / SKEL 资源包
                  </p>
                  <p>
                    <Check size={15} />
                    支持多贴图页、网格、路径和多皮肤
                  </p>
                  <p>
                    <Check size={15} />
                    可重新导入本工作台导出的可编辑工程
                  </p>
                </div>
                <p className="muted small">
                  请使用 Spine 导出的运行时资源。当前不直接读取 .spine
                  编辑器工程。
                </p>
              </div>
            )}
            {modal === "guide" && (
              <div className="simple-modal-body guide-steps">
                {[
                  [
                    "选择或导入模板",
                    "在模板列表中检查体型、朝向与动作，或导入自己的资源包。",
                  ],
                  [
                    "创建资源并替换部件",
                    "点击创建新资源，使用 AI 创作生成角色形象与模板部件，或上传已有透明图片。",
                  ],
                  [
                    "校准并检查动画",
                    "调整位置、缩放、旋转与镜像，使用同一动作比较关节和遮挡。",
                  ],
                  [
                    "保存与导出",
                    "本地工程会自动保存。导出 Spine 资源包用于运行，或导出可编辑工程备份。",
                  ],
                ].map(([title, text], index) => (
                  <div key={title}>
                    <span>{index + 1}</span>
                    <section>
                      <h3>{title}</h3>
                      <p>{text}</p>
                    </section>
                  </div>
                ))}
                <button
                  className="button primary full"
                  onClick={() => setModal(null)}
                >
                  开始制作
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
            {modal === "history" && (
              <div className="simple-modal-body history-list">
                {logs.length ? (
                  logs.map((log) => (
                    <div key={log.id}>
                      <CheckCircle2 size={16} />
                      <span>
                        {log.text}
                        <small>{log.date}</small>
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="muted">此会话还没有操作记录。</p>
                )}
              </div>
            )}
            {modal === "choose-skeleton" && importChoice && (
              <div className="simple-modal-body">
                <p>资源包内有多个骨架，请选择本次要编辑的一个。</p>
                <select
                  aria-label="导入骨架文件"
                  className="full"
                  value={importChoice.selected}
                  onChange={(e) =>
                    setImportChoice({
                      ...importChoice,
                      selected: e.target.value,
                    })
                  }
                >
                  {importChoice.candidates.map((path) => (
                    <option key={path}>{path}</option>
                  ))}
                </select>
                <button
                  className="button primary full spaced"
                  onClick={() => {
                    try {
                      finishImport(importChoice.files, importChoice.selected);
                    } catch (e) {
                      setError(e.message);
                    }
                  }}
                >
                  导入选定骨架
                </button>
              </div>
            )}
            {modal === "export" && (
              <div className="simple-modal-body">
                <div className="export-options">
                  {[
                    [
                      "runtime",
                      "Spine 运行时资源包",
                      "原骨架 JSON / SKEL、Atlas 与校准后的 PNG，可导入目标项目。",
                      FileArchive,
                    ],
                    [
                      "unity",
                      "Unity 资源包",
                      "自动整理 .atlas.txt / .skel.bytes，附导入说明。需在 Unity 中安装匹配版本的 spine-unity。",
                      FileArchive,
                    ],
                    [
                      "project",
                      "可编辑工程备份",
                      "包含原始资源、替换图片和校准参数，可重新导入继续编辑。",
                      FolderOpen,
                    ],
                  ].map(([value, title, text, Icon]) => (
                    <label
                      key={value}
                      className={`export-option ${exportMode === value ? "selected" : ""}`}
                    >
                      <input
                        type="radio"
                        name="export-mode"
                        value={value}
                        checked={exportMode === value}
                        onChange={() => setExportMode(value)}
                      />
                      <Icon size={23} />
                      <span>
                        <strong>{title}</strong>
                        <small>{text}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="export-summary">
                  <span>
                    Spine 版本<strong>{bundle?.version}</strong>
                  </span>
                  <span>
                    动作<strong>{bundle?.animations.length}</strong>
                  </span>
                  <span>
                    修改部件
                    <strong>
                      {changeCount} / {bundle?.parts.length}
                    </strong>
                  </span>
                  <span>
                    贴图页<strong>{bundle?.pages.length}</strong>
                  </span>
                </div>
                <p className="muted small">
                  导出使用原版本，保留全部骨骼、约束、网格权重和动画。目标引擎需要匹配的
                  Spine 4.3 运行库。
                </p>
                <button
                  className="button primary full"
                  disabled={exporting || processing}
                  onClick={() => void doExport()}
                >
                  {exporting ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <Download size={17} />
                  )}
                  {exporting ? "正在打包与校验…" : "校验并导出 ZIP"}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
      {toast && !modal && !editing && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
        </div>
      )}
      {importing && (
        <div className="busy-overlay" role="status">
          <LoaderCircle className="spin" size={25} />
          <span>正在导入并检查资源…</span>
        </div>
      )}
    </div>
  );
}

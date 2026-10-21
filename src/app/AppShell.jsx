import { useCalibratedPreview } from "../features/editor/use-calibrated-preview.js";
import { CreationWorkflow } from "../features/generation/CreationWorkflow.jsx";
import { EditorView } from "../features/editor/EditorView.jsx";
import { createEditorWorkspace } from "../application/editor-workspace.js";
import { createNavigation } from "../application/navigation.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Grid2X2, Upload, Plus, BookOpen, History, X, Download, Check, LoaderCircle, FolderOpen, CheckCircle2, ChevronRight, Bone, FileArchive, Layers, Sparkles, Trash2, ChevronDown } from "lucide-react";

import { PartEditor } from "../features/editor/PartEditor.jsx";
import { GenerationPanel } from "../features/generation/GenerationPanel.jsx";
import { AIConnectionPanel } from "../features/connections/AIConnectionPanel.jsx";

import { ResourceLibrary } from "../features/library/ResourceLibrary.jsx";
import { TemplateLibrary } from "../features/library/TemplateLibrary.jsx";
import { RigWorkbench } from "../features/rig/RigWorkbench.jsx";

import { attachSaveExitGuards } from "../application/exit-guards.js";

import { hasRigAuthoring } from "../../shared/domain/rig-summary.mjs";
import { hasAuthoredProduction } from "../../shared/domain/production.mjs";

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
export function AppShell({ services }) {
  const { resources } = services;
  const library = services.library;
  const [libraryState, setLibraryState] = useState(() => library.getSnapshot());
  const { catalog, projects, trash } = libraryState;
  const [selectedTemplate, setSelectedTemplate] = useState(null), [libraryBundle, setBundle] = useState(null);
  const [page, setPage] = useState("home"),
    [tab, setTab] = useState("characters"),
    [type, setType] = useState("全部"),
    [category, setCategory] = useState("全部"),
    [search, setSearch] = useState("");
  const editorWriter = useRef(null), editorPreviewPort = useRef(null), workspaceRef = useRef(null);
  if (!workspaceRef.current) workspaceRef.current = createEditorWorkspace({ getWriter: () => editorWriter.current,
    createId: services.createId, captureThumbnail: (fallback) => editorPreviewPort.current?.captureThumbnail() || fallback });
  const editorWorkspace = workspaceRef.current;
  const [editorState, setEditorState] = useState(() => editorWorkspace.getSnapshot());
  useEffect(() => editorWorkspace.subscribe(setEditorState), [editorWorkspace]);
  const editorSessionRef = editorWorkspace.sessionRef;
  const editorValue = editorState.value, project = editorValue?.project, projectName = editorValue?.name || "";
  const bundle = page === "editor" ? editorValue?.bundle : libraryBundle;
  const edits = page === "editor" ? editorValue?.edits || EMPTY : EMPTY, generation = editorValue?.generation || EMPTY;
  const setProjectName = (name) => editorWorkspace.patch({ name }, editorState.session?.key);
  const setGeneration = (generation) => editorWorkspace.patch({ generation }, editorState.session?.key);
  const [navigating, setNavigating] = useState(false), navigationRef = useRef(null);
  if (!navigationRef.current) navigationRef.current = createNavigation({ onPending: setNavigating });
  const navigation = navigationRef.current;
  const [rigBlocking, setRigBlocking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedPart, setSelectedPart] = useState(""),
    [partSearch, setPartSearch] = useState(""),
    [showParts, setShowParts] = useState(false),
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
  const { compiled, processing, setCompiled } = useCalibratedPreview({ bundle, edits, active: page === "editor", compile: services.pixels.compilePages,
    onReady: () => setError(""), onError: (error) => setError(error.message) });
  const [importChoice, setImportChoice] = useState(null),
    [logs, setLogs] = useState([]);
  const [importing, setImporting] = useState(false);
  const [generationKind, setGenerationKind] = useState("appearance");
  const [previewMode, setPreviewMode] = useState("compare");
  const [trashTarget, setTrashTarget] = useState(null), [resourceBusy, setResourceBusy] = useState(false);
  const [permanentTargets, setPermanentTargets] = useState([]);
  const [templateDraft, setTemplateDraft] = useState(null), [templateDeleteTarget, setTemplateDeleteTarget] = useState(null);
  const [rigSession, setRigSession] = useState(null), [rigStartDrafts, setRigStartDrafts] = useState([]);
  const [rigDraftSaveStatus, setRigDraftSaveStatus] = useState({ status: "idle", message: "本机骨架草稿" });
  const rigSessionRef = useRef(null), rigDraftStorageKey = useRef(null);
  const rigDraftMounted = useRef(true), rigDraftWriter = useRef(null);
  if (!editorWriter.current) editorWriter.current = services.createEditorWriter({
    captureThumbnail: (key, fallback) => editorSessionRef.current?.key === key ? editorPreviewPort.current?.captureThumbnail() || fallback : fallback,
    onStatus: (value) => {
      if (!rigDraftMounted.current || editorSessionRef.current?.key !== value.sessionKey) return;
      setSaving(value.status === "saving");
      setSaveState(({ pending: "等待保存…", saving: "正在保存…", saved: "已保存到本机", failed: "保存失败", idle: "临时草稿 · 修改后自动保存" })[value.status]);
    },
    onSaved: (saved, value) => {
      library.saved(value.summary);
    },
    onError: (error, value) => { if (rigDraftMounted.current && editorSessionRef.current?.key === value.sessionKey) setError(error.message); },
  });
  if (!rigDraftWriter.current) rigDraftWriter.current = services.createDraftWriter({
    onStatus: (value) => { if (rigDraftMounted.current) setRigDraftSaveStatus(value); },
    onError: (error) => { if (rigDraftMounted.current) setError(error.message); },
    onSaved: (metadata, value) => { if (rigSessionRef.current?.key === value.sessionKey) rigDraftStorageKey.current = metadata.id; },
  });
  const flushRigDraft = useCallback(() => rigDraftWriter.current.flush(), []);
  const updateRigDraft = useCallback((document, sessionKey) => {
    const session = rigSessionRef.current;
    if (!session || session.key !== sessionKey) return;
    if (!document.sourceImage && !document.joints.length && !document.parts.length && document.name === "新角色" && !hasAuthoredProduction(document)) return;
    const current = session?.authoringId ? { ...document, id: session.authoringId, ownerResourceId: session.resourceId } : document;
    rigDraftWriter.current.enqueue({ document: current, resourceId: session.resourceId, resourceUpdatedAt: session.resourceUpdatedAt, sessionKey });
  }, []);
  const onRigDraftChange = useCallback((document) => updateRigDraft(document, rigSession?.key), [updateRigDraft, rigSession?.key]);
  useEffect(() => {
    rigDraftMounted.current = true;
    const detach = attachSaveExitGuards({
      hasUnsaved: () => editorWriter.current.hasUnsaved() || rigDraftWriter.current.hasUnsaved(),
      flush: (_, options) => Promise.all([editorWriter.current.flush(undefined, options), rigDraftWriter.current.flush(undefined, options)]),
    }, { window, document });
    return () => {
      rigDraftMounted.current = false; detach(); rigDraftWriter.current.dispose();
      editorWriter.current.dispose();
      void editorWriter.current.flush(undefined, { retry: false }).catch(() => {});
      void rigDraftWriter.current.flush(undefined, { retry: false }).catch(() => {});
    };
  }, [flushRigDraft]);
  const [aiStatus, setAIStatus] = useState(null), [aiConnectionReturn, setAIConnectionReturn] = useState(null);
  const aiClient = services.connection;
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
    templateSequence = useRef(0);
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
    const detach = library.subscribe(setLibraryState), stop = library.start();
    return () => { detach(); stop(); };
  }, [library]);
  useEffect(() => { if (libraryState.error) setError(libraryState.error.message); }, [libraryState.error]);
  useEffect(() => {
    if (!libraryState.ready) return;
    setSelectedTemplate((current) => current || libraryState.catalog[0] || null);
    if (!libraryState.catalog.length) setLoading(false);
  }, [libraryState.ready]);
  useEffect(() => {
    if (!selectedTemplate || page !== "home" || tab !== "templates") return;
    const sequence = ++templateSequence.current;
    setLoading(true);
    setError("");
    resources.loadTemplate(selectedTemplate)
      .then((value) => {
        if (sequence !== templateSequence.current) return;
        setBundle(value);
        setAnimation(defaultAnimation(value.animations));
        setSkin(value.skins[0] || "");
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
  const queueEditorSave = useCallback((explicit = false) => {
    const session = editorWorkspace.queue(explicit);
    if (!session) setSaveState("临时草稿 · 修改后自动保存");
    return session;
  }, [editorWorkspace, editorValue]);
  const persist = useCallback(async (explicit = false, options = {}) => {
    const session = editorSessionRef.current;
    const saved = await editorWorkspace.persist(explicit, options);
    if (explicit && saved && editorSessionRef.current?.key === session?.key) notify("工程已保存到本机。");
    return saved;
  }, [editorWorkspace, notify]);
  const saveAsNewResource = () => navigation.run(async () => {
    try {
      const saved = await editorWorkspace.saveAsNew();
      if (!saved) return;
      resetEditorView(editorWorkspace.getSnapshot().value.bundle); await library.refresh();
      notify("本地修改已另存为新资源，原资源保留。");
    } catch (error) { setError(`另存尚未确认，当前内容仍保留：${error.message}`); }
  });
  useEffect(() => {
    if (page === "editor") queueEditorSave();
  }, [queueEditorSave, page]);
  const updateEdits = (next, nextBundle = bundle) => editorWorkspace.changeEdits(next, nextBundle, selectedPart, editorState.session?.key);
  const undo = () => {
    const selected = editorWorkspace.undo(selectedPart);
    if (selected !== undefined) setSelectedPart(selected);
  };
  const redo = () => {
    const selected = editorWorkspace.redo(selectedPart);
    if (selected !== undefined) setSelectedPart(selected);
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
  const resetEditorView = (value) => {
    templateSequence.current++;
    setLoading(false);
    if (hasRigAuthoring(value.files)) setPreviewMode("resource");
    setCompiled(EMPTY);
    setSelectedPart(value.parts[0]?.id || "");
    setAnimation(defaultAnimation(value.animations));
    setSkin(value.skins[0] || "");
    setError("");
    setShowParts(false);
    setPartSearch("");
    setPage("editor");
    clock.current.seek(0);
  };
  const openEditor = (value, metadata = {}) => {
    editorWorkspace.open(value, metadata);
    resetEditorView(value);
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
  const showRigWorkbench = (document = null, { resourceId = null, resourceUpdatedAt = null, draftId = null, draftUpdatedAt, notice = "", manualAdjustment = false, selectedPartId = null } = {}) => {
    templateSequence.current++;
    editorWorkspace.close();
    const session = { document, resourceId, resourceUpdatedAt, key: crypto.randomUUID(), saveResourceId: resourceId || crypto.randomUUID(), forkResourceId: crypto.randomUUID(), notice, manualAdjustment, selectedPartId };
    rigSessionRef.current = session; rigDraftStorageKey.current = draftId;
    rigDraftWriter.current.setSession(session.key, { expectedVersion: draftUpdatedAt, entityId: draftId });
    setRigSession(session);
    setModal(null); setError(""); setRigBlocking(false); setPage("rig");
  };
  const beginRigCreation = async () => {
    if (resourceBusy) return;
    setResourceBusy(true); setError("");
    try {
      await flushRigDraft();
      const drafts = await services.rigs.listDrafts();
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
      const opened = await services.rigs.resume(id, projects);
      showRigWorkbench(opened.document, opened.options);
    } catch (error) { setError(error.message); }
    finally { setResourceBusy(false); }
  };
  const editResourceRig = async (record, { manualAdjustment = false, selectedPartId = null } = {}) => {
    if (!record || resourceBusy || processing) return;
    setResourceBusy(true); setError("");
    const adjustmentOptions = manualAdjustment ? { manualAdjustment: true, selectedPartId } : {};
    try {
      await flushRigDraft();
      const currentRecord = page === "editor" ? await persist() || record : record;
      const opened = await services.rigs.open(currentRecord, adjustmentOptions);
      showRigWorkbench(opened.document, opened.options);
      if (opened.notice) notify(opened.notice);
    } catch (error) { setError(error.message); }
    finally { setResourceBusy(false); }
  };
  const saveRigResource = async (document, previewBundle, { thumbnail } = {}) => {
    setResourceBusy(true); setError("");
    try {
      const result = await services.rigs.publish({ document, previewBundle, thumbnail, session: () => rigSessionRef.current,
        previousDraftId: () => rigDraftStorageKey.current, writer: editorWriter.current, draftWriter: rigDraftWriter.current, flushDraft: flushRigDraft,
        onPublished: ({ saved, committedSession }) => {
          rigSessionRef.current = committedSession; setRigSession(committedSession);
          library.saved(saved);
        },
      });
      rigSessionRef.current = null; rigDraftWriter.current.setSession(null);
      setRigSession(null); openEditor(result.bundle, result.saved);
      notify(result.conflict ? "原资源已有更新，当前骨架已另存为新资源，原来的修改仍保留。" : "新骨架和动作已保存为资源，可继续校准、预览或导出。");
    } catch (error) { setError(error.message); throw error; }
    finally { setResourceBusy(false); }
  };
  const openProject = async (record) => {
    try { const opened = await resources.open(record); openEditor(opened.bundle, opened.record); }
    catch (error) { setError(error.message); }
  };
  const finishImport = (files, skeletonPath) => {
    const value = resources.prepareImport(files, skeletonPath);
    openEditor(value, { name: value.name }); setImportChoice(null); setModal(null);
    notify(`已导入 ${value.parts.length} 个纹理部件、${value.animations.length} 个动作。`);
  };
  const importFiles = async (files) => {
    if (!files?.length) return;
    setLoading(true);
    setImporting(true);
    setError("");
    try {
      if (page === "editor") await persist();
      const entries = await resources.readImport(files);
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
      const replacement = await services.pixels.readReplacement(file);
      if (editorSessionRef.current?.key !== editorState.session?.key) return;
      updateEdits({ ...edits, [selectedPart]: replacement });
      setEditing(true);
      notify("部件图片已替换，请检查并完成校准。");
    } catch (e) {
      setError(`替换失败：${e.message}`);
    }
  };
  const doExport = async () => {
    if (!bundle) return;
    setExporting(true); setError("");
    try {
      const result = await services.exportProject({ bundle, edits, mode: exportMode, name: projectName, generation }, { persist,
        onExported: ({ editable, target }) => {
          notify(`${editable ? "可编辑工程" : target === "unity" ? "Unity 资源包" : "Spine 资源包"}已导出，重新解析校验通过。`);
          setModal(null);
        },
      });
      if (result.saveError) setError(`资源包已导出，但本机保存失败：${result.saveError.message}`);
    } catch (error) { setError(`导出失败：${error.message}`); }
    finally { setExporting(false); }
  };
  const leaveEditor = async () => {
    await navigateLibrary("characters");
  };
  const navigateLibrary = async (next) => {
    if (navigation.pending) return;
    if (editing || importing || exporting || resourceBusy || (page === "rig" && rigBlocking)) { notify("请先完成或取消当前操作。"); return; }
    await navigation.run(async () => {
      try {
        if (page === "editor") await persist();
        if (page === "rig") {
          await flushRigDraft();
          rigSessionRef.current = null; rigDraftWriter.current.setSession(null);
        }
        editorWorkspace.close();
        setPage("home"); setTab(next); setModal(null);
      } catch (error) { setError(error.message); /* Keep the editor open if saving fails. */ }
    });
  };
  const updateResource = async (record, restore = false) => {
    if (!record || resourceBusy) return;
    setResourceBusy(true); setError("");
    try {
      const library = await resources.trash(record, restore);
      services.library.acceptLibrary(library);
      setModal(null); setTrashTarget(null);
      notify(restore ? `已恢复「${record.name}」。` : `已将「${record.name}」移入回收站。`);
    } catch (e) { setError(e.message); }
    finally { setResourceBusy(false); }
  };
  const deleteForever = async () => {
    if (!permanentTargets.length || resourceBusy) return;
    setResourceBusy(true); setError("");
    try {
      const { count, library } = await resources.remove(permanentTargets);
      services.library.acceptLibrary(library);
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
      const saved = await resources.addTemplate(templateDraft);
      library.templateSaved(saved);
      setSelectedTemplate(saved); setType("全部"); setCategory("我创建的"); setSearch("");
      editorWorkspace.close(); setPage("home"); setTab("templates"); setModal(null); setTemplateDraft(null);
      notify(`已${templateDraft.updating ? "更新" : "加入"}模板「${saved.name}」，可在「我创建的」中复用。`);
    } catch (e) { setError(`保存模板失败：${e.message}`); }
    finally { setResourceBusy(false); }
  };
  const removeTemplate = async () => {
    if (!templateDeleteTarget || resourceBusy) return;
    setResourceBusy(true); setError("");
    try {
      await resources.removeTemplate(templateDeleteTarget.id);
      library.templateRemoved(templateDeleteTarget.id);
      if (selectedTemplate?.id === templateDeleteTarget.id) { setSelectedTemplate(null); setBundle(null); setLoading(false); }
      setModal(null); setTemplateDeleteTarget(null); notify("模板已删除，原资源和从模板创建的资源仍保留。");
    } catch (e) { setError(e.message); }
    finally { setResourceBusy(false); }
  };
  const visibleTemplates = catalog.filter(
    (item) =>
      (type === "全部" ||
        item.type === (type === "角色" ? "role" : "effect")) &&
      (category === "全部" || (category === "我创建的" ? item.source === "custom" : item.categories.includes(category))) &&
      (!search || item.name.toLowerCase().includes(search.toLowerCase())),
  );
  const templateComparison = useMemo(() => resources.comparison(bundle), [bundle, resources]);
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
      className="app-shell explorer-shell"
      inert={navigating || importing || (page === "editor" && resourceBusy)}
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
        <RigWorkbench CalibrationEditor={PartEditor} calibration={services.calibration} editing={services.rigEditing} client={services.rigJobs} generationClient={services.connection} key={rigSession?.key} initialDocument={rigSession?.document || null}
          initialManualAdjustment={Boolean(rigSession?.manualAdjustment)} initialPartId={rigSession?.selectedPartId}
          saveHint={rigSession?.notice || ""}
          draftSaveStatus={rigDraftSaveStatus}
          onDraftChange={onRigDraftChange} onSave={saveRigResource} onBlockingChange={setRigBlocking}
          onClose={() => void navigateLibrary("characters")} connectionStatus={aiStatus} onOpenConnection={openAIConnection} />
      ) : page === "home" ? (
        <main className="home-main">
          {tab === "templates" ? (
            <TemplateLibrary countRegions={resources.templateRegionCount} catalog={catalog} visibleTemplates={visibleTemplates} selectedTemplate={selectedTemplate}
              onSelect={setSelectedTemplate} type={type} category={category} search={search}
              onType={setType} onCategory={setCategory} onSearch={setSearch}
              bundle={bundle} loading={loading} clock={clock.current} animation={animation} skin={skin} playing={playing}
              onAnimation={changeAnimation} onTogglePlay={togglePlay} onCreate={createResource}
              onDeleteTemplate={(item) => { if (!resourceBusy && item.source === "custom") { setTemplateDeleteTarget(item); setError(""); setModal("delete-template"); } }}
              onImport={() => { setError(""); setModal("import"); }} projects={projects} onOpen={openProject} />
          ) : (
            <ResourceLibrary actions={resources} projects={projects} trash={trash} showTrash={tab === "trash"} onOpen={openProject} onImport={() => setModal("import")}
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
        <EditorView session={editorState} view={{ saving, saveState, processing, resourceBusy, selectedPart, animation, playing, speed, clock, skin, previewMode, showBones, showParts, part, replacementInput, templateComparison, changeCount, compiled, editorPreviewPort, partSearch, visibleParts, time, duration }} commands={{ leaveEditor, setProjectName, editResourceRig, openCreationStep, persist, saveAsNewResource, setModal, changeAnimation, togglePlay, setSpeed, setTime, setSkin, setPreviewMode, setShowBones, setShowParts, setSelectedPart, partLabel, setEditing, updateEdits, notify, undo, redo, setPartSearch }} Workflow={CreationWorkflow} />
      )}
      {editing && bundle && part && (
        <PartEditor calibration={services.calibration}
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
        <GenerationPanel provider={services.connection} prepareGenerationRequest={services.prepareGenerationRequest} readReplacement={services.pixels.readReplacement} bundle={bundle} projectId={project.id} selectedPart={selectedPart} currentAnimation={animation}
          ai={generation} onChange={setGeneration} onClose={() => setModal(null)}
          initialKind={generationKind} replaced={bundle.parts.filter((part)=>edits[part.id]).length} onStep={openCreationStep}
          captureTemplate={() => {
            if (templateComparison.error) throw new Error(templateComparison.error);
            return services.preview.capture(templateComparison.bundle, { animation, skin, time: clock.current.read() });
          }}
          onConfigure={openAIConnection}
          onApply={async (result, images, scope) => {
            const applied = await services.applyCandidate({ projectId: project.id, bundle, comparison: templateComparison.bundle, edits, result, candidates: images, scope });
            if (!updateEdits(applied.edits, applied.bundle)) return; setSelectedPart(applied.selectedPart);
            if (scope) changeAnimation(applied.animation);
            setModal(null);
            if(images.length===1)setEditing(true);
            notify(scope ? `已添加「${scope.name}」，用于 ${scope.animations.length} 个动作，请校准后预览。`
              : `已应用 ${images.length} 个 AI 部件，请校准后检查动画。`);
          }}/>
      )}
      {modal === "ai-connection" && <AIConnectionPanel client={services.connection} onChanged={aiConnectionChanged} onClose={() => { setModal(aiConnectionReturn); void refreshAI(); }} />}
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

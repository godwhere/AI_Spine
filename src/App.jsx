import { useCallback, useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import { SpineViewer } from "./components/SpineViewer.jsx";
import { PartEditor } from "./components/PartEditor.jsx";
import { GenerationPanel } from "./components/GenerationPanel.jsx";
import { ResourceLibrary } from "./components/ResourceLibrary.jsx";
import { isDesktop, desktopProjects } from "./core/desktop.js";
import {
  loadCatalogTemplate,
  parseBundle,
  readImportFiles,
} from "./core/archive.js";
import { unpackInWorker, exportInWorker } from "./core/archive-worker.js";
import { compilePages, readReplacement } from "./core/pixels.js";
import { listProjects, saveProject } from "./core/storage.js";
import { parseSkeleton } from "./spine/runtime.js";
import { applyGeneratedParts } from "./core/generation.js";

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
    [tab, setTab] = useState(isDesktop ? "characters" : "templates"),
    [type, setType] = useState("全部"),
    [category, setCategory] = useState("全部"),
    [search, setSearch] = useState("");
  const [projects, setProjects] = useState([]),
    [project, setProject] = useState(null),
    [projectName, setProjectName] = useState("");
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
  const [previewMode, setPreviewMode] = useState(isDesktop ? "resource" : "compare");
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
      if (e.key === "Escape" && modal && !exporting) setModal(null);
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
  }, [modal, editing, exporting]);
  useEffect(() => {
    fetch("/templates/catalog.json")
      .then((response) => {
        if (!response.ok) throw new Error("模板目录加载失败。");
        return response.json();
      })
      .then((items) => {
        setCatalog(items);
        setSelectedTemplate(items[0]);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
    (isDesktop ? desktopProjects() : listProjects())
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!selectedTemplate || page !== "home" || tab !== "templates") return;
    const sequence = ++templateSequence.current;
    setLoading(true);
    setError("");
    loadCatalogTemplate(selectedTemplate)
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
        if (sequence === templateSequence.current) setError(e.message);
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
    async (explicit = false) => {
      if (!project || !bundle) return;
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
        await saveProject(record);
        setProjects(await listProjects());
        setSaveState("已保存到本机");
        if (explicit) notify("工程已保存到本机。");
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
  const updateEdits = (next) => {
    undoStack.current.push(edits);
    undoStack.current = undoStack.current.slice(-30);
    redoStack.current = [];
    setEdits(Object.assign(Object.create(null), next));
    setHistoryCount((v) => v + 1);
  };
  const undo = () => {
    const previous = undoStack.current.pop();
    if (previous) {
      redoStack.current.push(edits);
      setEdits(previous);
      setHistoryCount((v) => v + 1);
    }
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (next) {
      undoStack.current.push(edits);
      setEdits(next);
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
    templateSequence.current++;
    setLoading(false);
    setBundle(value);
    setProject({
      id: metadata.id || crypto.randomUUID(),
      templateId: metadata.templateId,
      thumbnail: metadata.thumbnail,
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
        templateId: selectedTemplate?.id,
        thumbnail: selectedTemplate?.thumbnail,
      });
      notify("新资源已创建，选择部件开始替换与校准。");
    }
  };
  const openProject = (record) => {
    try {
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
      const bytes = await exportInWorker(bundle, pages, {
        editable,
        edits,
        name: projectName,
        generation,
      });
      triggerDownload(
        bytes,
        `${exportName(projectName)}${editable ? "-工程" : "-Spine4.3"}.zip`,
      );
      notify(
        `${editable ? "可编辑工程" : "Spine 资源包"}已导出，重新解析校验通过。`,
      );
      setModal(null);
      void persist().catch(() => {});
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
    if (editing || importing || exporting) { notify("请先完成当前操作。"); return; }
    try {
      if (page === "editor") await persist();
      setPage("home"); setTab(next); setProject(null); setModal(null);
    } catch { /* Keep the editor open if saving fails. */ }
  };
  useEffect(() => window.aiSpineDesktop?.onAction((action) => {
    if (action === "library" || action === "templates") void navigateLibrary(action === "library" ? "characters" : "templates");
    else if (action === "import") setModal("import");
    else if (action === "save") void persist(true).catch(() => {});
    else if (action === "export" && page === "editor") setModal("export");
    else if (action === "guide") setModal("guide");
    else if (action === "close") {
      if (editing || importing || exporting) { notify("请先完成当前校准、导入或导出，再关闭窗口。"); return; }
      void persist().then(() => window.aiSpineDesktop.closeReady()).catch(() => {});
    }
  }));
  const visibleTemplates = catalog.filter(
    (item) =>
      (type === "全部" ||
        item.type === (type === "角色" ? "role" : "effect")) &&
      (category === "全部" || item.categories.includes(category)) &&
      (!search || item.name.toLowerCase().includes(search.toLowerCase())),
  );
  const part = bundle?.parts.find((p) => p.id === selectedPart),
    duration = bundle?.durations?.[animation] || 1;
  const visibleParts =
      bundle?.parts.filter((p) =>
        p.id.toLowerCase().includes(partSearch.toLowerCase()),
      ) || [],
    changeCount = Object.keys(edits).length;
  const runtimeReady = page === "home" && tab === "characters" ? projects.length > 0 : bundle && !loading;
  return (
    <div
      className={`app-shell ${isDesktop ? "desktop-shell" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          if (!editing && !modal) void importFiles([...e.dataTransfer.files]);
        }
      }}
    >
      {isDesktop && <>
        <div className="desktop-titlebar"><span>AI Spine</span><small>角色动画工作台</small></div>
        <aside className="desktop-navigation" aria-label="工作台导航">
          <div className="desktop-brand"><Layers size={25} /><div><strong>AI Spine</strong><small>本地创作空间</small></div></div>
          <span className="navigation-label">资源管理</span>
          <button className={tab === "characters" || page === "editor" ? "active" : ""} onClick={() => void navigateLibrary("characters")}><FolderOpen size={18} />我的资源<span>{projects.length}</span></button>
          <button className={tab === "templates" && page === "home" ? "active" : ""} onClick={() => void navigateLibrary("templates")}><Grid2X2 size={18} />模板库<span>{catalog.length}</span></button>
          <button onClick={() => setModal("import")}><Upload size={18} />导入资源</button>
          <div className="navigation-bottom"><button onClick={() => setModal("guide")}><BookOpen size={17} />使用引导</button><p><i />资源保存于本机</p><small>Spine 4.3 · macOS</small></div>
        </aside>
      </>}
      <header className="workbench-header">
        <div>
          <h1>{page === "editor" ? "部件校准" : isDesktop ? (tab === "characters" ? "我的资源" : "模板库") : "Spine 工作台"}</h1>
          <p>
            {page === "editor"
              ? "先检查整体动画，再选择部件调整。原骨骼与动作保持完整。"
              : tab === "characters" ? "管理本机角色资源，预览完整动作，继续编辑与导出。" : "浏览 Spine 模板，预览动作，并基于模板创建和管理资源。"}
          </p>
        </div>
        <div className="header-actions">
          <button
            className="button"
            aria-label="导入模板"
            onClick={() => {
              setModal("import");
              setError("");
            }}
          >
            <Upload size={16} />
            <span>导入模板</span>
          </button>
          <button
            className="icon-button framed"
            aria-label="操作记录"
            onClick={() => setModal("history")}
          >
            <History size={19} />
          </button>
          <div className="runtime-status">
            <i className={runtimeReady ? "connected" : ""} />
            <span>
              <strong>Spine 4.3.x</strong>
              <small>
                {runtimeReady ? "本地运行时已就绪" : "等待资源加载"}
              </small>
            </span>
          </div>
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
        accept=".zip,.json,.skel,.atlas,.txt,.png,.jpg,.jpeg,.webp"
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
      {page === "home" ? (
        <main className="home-main">
          <div className="home-toolbar">
            <div className="view-tabs" role="tablist" aria-label="首页视图">
              <button
                role="tab"
                aria-selected={tab === "templates"}
                className={tab === "templates" ? "active" : ""}
                onClick={() => setTab("templates")}
              >
                <Grid2X2 size={17} />
                模板视图
              </button>
              <button
                role="tab"
                aria-selected={tab === "characters"}
                className={tab === "characters" ? "active" : ""}
                onClick={() => setTab("characters")}
              >
                <Palette size={18} />
                我的创作
                {projects.length > 0 && (
                  <span className="count">{projects.length}</span>
                )}
              </button>
            </div>
            <span className="local-note">资源在本机处理与保存</span>
          </div>
          {tab === "templates" ? (
            <div className="home-layout">
              <section className="panel template-panel" aria-label="Spine 模板">
                <div className="filters">
                  <div className="filter-row">
                    <strong>类型</strong>
                    {["全部", "角色", "特效"].map((value) => (
                      <button
                        key={value}
                        className={`filter-button ${type === value ? "active" : ""}`}
                        aria-pressed={type === value}
                        onClick={() => setType(value)}
                      >
                        {value}
                      </button>
                    ))}
                    <div className="template-search">
                      <Search size={14} />
                      <input
                        aria-label="搜索模板"
                        placeholder="搜索模板"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="filter-row">
                    <strong>分类</strong>
                    {["全部", "人物", "怪物"].map((value) => (
                      <button
                        key={value}
                        className={`filter-button ${category === value ? "active" : ""}`}
                        aria-pressed={category === value}
                        onClick={() => setCategory(value)}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
                <div
                  className="template-grid"
                  role="list"
                  aria-label="模板列表"
                >
                  {visibleTemplates.map((item) => (
                    <button
                      key={item.id}
                      role="listitem"
                      aria-label={`选择模板 ${item.name}`}
                      aria-current={
                        selectedTemplate?.id === item.id ? "true" : undefined
                      }
                      className={`template-card ${selectedTemplate?.id === item.id ? "selected" : ""}`}
                      onClick={() => setSelectedTemplate(item)}
                    >
                      <span className="template-label">
                        {item.type === "effect" ? "特效" : "角色"} ·{" "}
                        {item.categories.join(" / ")}
                      </span>
                      <img
                        src={item.thumbnail}
                        alt={item.name}
                        loading="lazy"
                      />
                      <span className="template-card-name">
                        {item.name}
                        <small>{item.animationCount} 个动作</small>
                      </span>
                    </button>
                  ))}
                  {!visibleTemplates.length && (
                    <div className="empty-state">
                      没有匹配的模板，试试其他筛选条件。
                    </div>
                  )}
                  <p className="list-end">
                    {visibleTemplates.length
                      ? `共 ${visibleTemplates.length} 个模板 · 没有更多了`
                      : ""}
                  </p>
                </div>
              </section>
              <div className="home-right">
                <section className="panel home-preview">
                  <div className="panel-heading">
                    <div>
                      <h2>{selectedTemplate?.name || "动作预览"}</h2>
                      <p>
                        动作 {bundle?.animations.length || 0}　部件{" "}
                        {selectedTemplate?.partCount || 0}
                      </p>
                    </div>
                    <button
                      className="button primary"
                      disabled={!bundle || loading}
                      onClick={createResource}
                    >
                      <Plus size={18} />
                      创建新资源
                    </button>
                  </div>
                  <div className="preview-controls">
                    <label>
                      预览动作{" "}
                      <select
                        aria-label="选择预览动作"
                        value={animation}
                        onChange={(e) => changeAnimation(e.target.value)}
                      >
                        {bundle?.animations.map((name) => (
                          <option key={name}>{name}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="icon-button framed accent"
                      aria-label={playing ? "暂停预览" : "播放预览"}
                      onClick={togglePlay}
                    >
                      {playing ? <Pause size={18} /> : <Play size={18} />}
                    </button>
                  </div>
                  <div className="home-viewer-wrap">
                    {loading ? (
                      <div className="viewer-message">
                        <LoaderCircle size={23} className="spin" />
                        正在加载模板…
                      </div>
                    ) : (
                      bundle && (
                        <SpineViewer
                          bundle={bundle}
                          clock={clock.current}
                          animation={animation}
                          skin={skin}
                          label="模板预览"
                        />
                      )
                    )}
                  </div>
                </section>
                <section className="panel template-resources">
                  <div className="panel-heading">
                    <h2>
                      该模板下的资源{" "}
                      <span className="count">
                        {
                          projects.filter(
                            (p) => p.templateId === selectedTemplate?.id,
                          ).length
                        }
                      </span>
                    </h2>
                  </div>
                  <div className="resource-list">
                    {projects.filter(
                      (p) => p.templateId === selectedTemplate?.id,
                    ).length ? (
                      projects
                        .filter((p) => p.templateId === selectedTemplate?.id)
                        .map((record) => (
                          <button
                            key={record.id}
                            className="resource-item"
                            onClick={() => openProject(record)}
                          >
                            {record.thumbnail && (
                              <img src={record.thumbnail} alt="" />
                            )}
                            <span>
                              {record.name}
                              <small>{record.partCount} 个纹理部件</small>
                            </span>
                            <ChevronRight size={16} />
                          </button>
                        ))
                    ) : (
                      <div className="empty-resource">
                        还没有资源，点击上方「创建新资源」开始制作。
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </div>
          ) : (
            <ResourceLibrary projects={projects} onOpen={openProject} onImport={() => setModal("import")} />
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
            <button className="button accent" onClick={() => setModal("generation")}>
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
                      {p.id}
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
                    {bundle?.boneCount} 根骨骼 · {bundle?.parts.length}{" "}
                    个纹理区域
                  </small>
                </div>
                {bundle && (
                  <SpineViewer
                    bundle={bundle}
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
                          {p.name}
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
        <GenerationPanel bundle={bundle} projectId={project.id} selectedPart={selectedPart}
          ai={generation} onChange={setGeneration} onClose={() => setModal(null)}
          captureTemplate={async () => {
            const source=document.querySelector('.comparison-view .spine-canvas');
            if (!source?.width) throw new Error("模板预览尚未准备好，请稍后再试。");
            const canvas=document.createElement("canvas"), scale=Math.min(1,1024/Math.max(source.width,source.height));
            canvas.width=Math.max(1,Math.round(source.width*scale));canvas.height=Math.max(1,Math.round(source.height*scale));
            canvas.getContext("2d").drawImage(source,0,0,canvas.width,canvas.height);
            const blob=await new Promise((resolve)=>canvas.toBlob(resolve,"image/png"));
            if(!blob)throw new Error("模板参考图片读取失败。");
            return new Uint8Array(await blob.arrayBuffer());
          }}
          onApply={async (result, images) => {
            const next=await applyGeneratedParts(bundle,edits,result,images);
            updateEdits(next);
            setSelectedPart(images[0].partId);
            setModal(null);
            if(images.length===1)setEditing(true);
            notify(`已应用 ${images.length} 个 AI 部件，请校准后检查动画。`);
          }}/>
      )}
      {modal && modal !== "generation" && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !exporting) setModal(null);
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
                  }[modal]
                }
              </h2>
              <button
                className="icon-button"
                aria-label="关闭对话框"
                disabled={exporting}
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

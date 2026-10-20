import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Layers, SlidersHorizontal, LoaderCircle, FolderOpen, Trash2, RotateCcw, List, LayoutGrid, ArrowLeft, Bone, Plus, Move } from "lucide-react";
import { parseBundle } from "../core/archive.js";
import { compilePages } from "../core/pixels.js";
import { parseSkeleton } from "../spine/runtime.js";
import { SpineViewer } from "./SpineViewer.jsx";
import { PreviewTransport } from "./PreviewTransport.jsx";
import { ResourceThumbnail } from "./ResourceThumbnail.jsx";
import { rigAuthoringSummary } from "../core/rig-project.js";
import { getProjectForPreview } from "../core/storage.js";

export function ResourceLibrary({ projects, trash = [], onOpen, onImport, onTrash, onRestore, onDeleteForever, onEmptyTrash, onBrowseTemplates, onAddTemplate, onCreateRig, onEditRig, onManualAdjust, customTemplateProjectIds = [], showTrash = false, busy = false }) {
  const [search, setSearch] = useState(""), [sort, setSort] = useState("updated");
  const [selected, setSelected] = useState(null), [preview, setPreview] = useState(null);
  const [loadedRecord, setLoadedRecord] = useState(null);
  const [error, setError] = useState(""), [animation, setAnimation] = useState("");
  const [playing, setPlaying] = useState(true);
  const [view, setView] = useState("list"), [mobilePreview, setMobilePreview] = useState(false);
  const clock = useRef({ position: 0, anchor: performance.now(), playing: true,
    read(now = performance.now()) { return this.position + (this.playing ? (now - this.anchor) / 1000 : 0); },
    seek(position) { this.position = position; this.anchor = performance.now(); } });
  const source = showTrash ? trash : projects;
  const records = useMemo(() => source.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "zh-CN") : (b.deletedAt || b.updatedAt).localeCompare(a.deletedAt || a.updatedAt)), [source, search, sort]);
  const selectedRecord = records.find((p) => p.id === selected) || records[0];
  const record = loadedRecord?.id === selectedRecord?.id && loadedRecord?.updatedAt === selectedRecord?.updatedAt ? loadedRecord : selectedRecord;
  const authored = Boolean(record?.hasRigAuthoring || record?.files?.[".ispine/rig/document.json"]);
  const rigSummary = record?.rigSummary || rigAuthoringSummary(record?.files);
  useEffect(() => { setSearch(""); setSelected(null); setMobilePreview(false); }, [showTrash]);
  useEffect(() => {
    let cancelled = false;
    setPreview(null); setLoadedRecord(null); setError("");
    if (!selectedRecord) return;
    void (async () => {
      const record = selectedRecord.files ? selectedRecord : await getProjectForPreview(selectedRecord.id);
      if (cancelled) return;
      if (!record) throw new Error("这个资源已被删除，请重新选择。");
      const bundle = parseBundle(record.files, { skeletonPath: record.skeletonPath, name: record.name });
      const { data } = parseSkeleton(bundle);
      const pages = await compilePages(bundle, record.edits || {});
      if (cancelled) return;
      const animations = data.animations.map((a) => a.name);
      setAnimation(["idle", "std", "stand"].find((a) => animations.includes(a)) || animations[0] || "");
      clock.current.seek(0);
      setLoadedRecord(record);
      setPreview({ bundle, pages, animations, durations: Object.fromEntries(data.animations.map((a) => [a.name, a.duration])), skin: data.skins[0]?.name || "" });
    })().catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [selectedRecord?.id, selectedRecord?.updatedAt, selectedRecord?.deletedAt]);
  const togglePlay = () => {
    clock.current.position = clock.current.read(); clock.current.anchor = performance.now();
    clock.current.playing = !playing; setPlaying(!playing);
  };
  const changeAnimation = (name) => { setAnimation(name); clock.current.seek(0); };
  const actionCount = preview?.animations.length ?? record?.animationCount ?? 0;
  return <section className={`resource-library explorer ${mobilePreview ? "preview-open" : ""}`} aria-label={showTrash ? "回收站" : "我的资源库"}>
    <div className="explorer-toolbar">
      <div className="explorer-title"><h2>{showTrash ? "回收站" : "我的资源"}</h2><span>{source.length} 个资源</span></div>
      <label className="explorer-search"><Search size={18} /><input aria-label={showTrash ? "搜索回收站" : "搜索我的资源"} placeholder="搜索资源…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <div className="explorer-filters"><select aria-label="资源排序" value={sort} onChange={(e) => setSort(e.target.value)}><option value="updated">{showTrash ? "最近删除" : "最近修改"}</option><option value="name">名称排序</option></select></div>
      <div className="explorer-view-toggle" role="group" aria-label="资源显示方式">
        <button className={view === "list" ? "selected" : ""} aria-label="列表视图" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={18} /></button>
        <button className={view === "grid" ? "selected" : ""} aria-label="网格视图" aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid size={18} /></button>
      </div>
      {showTrash ? <button className="button danger" disabled={!trash.length || busy} onClick={() => onEmptyTrash(trash)}><Trash2 size={16} />清空回收站</button>
        : <button className="button" disabled={busy} onClick={onImport}><FolderOpen size={17} />导入工程</button>}
      {!showTrash && onCreateRig && <button className="button primary" disabled={busy} onClick={onCreateRig}><Plus size={17} />新建角色</button>}
    </div>
    <div className="explorer-workspace">
      <div className="explorer-list-pane">
        <div className="explorer-columns" aria-hidden="true"><span>名称</span><span>动作</span><span>纹理区域</span></div>
        <div className={`explorer-rows ${view === "grid" ? "is-grid" : ""}`}>
          {records.map((item) => <button key={item.id} className={`explorer-row ${item.id === record?.id ? "selected" : ""}`}
            disabled={busy} aria-label={`预览 ${item.name}`} aria-pressed={item.id === record?.id}
            onClick={() => { setSelected(item.id); setMobilePreview(true); }} onDoubleClick={() => { if (!showTrash && !busy) onOpen(item); }}>
            <span className="explorer-thumbnail">{item.thumbnail ? <ResourceThumbnail src={item.thumbnail} /> : <Layers size={28} />}</span>
            <span className="explorer-row-name"><strong>{item.name}</strong><small>{(item.hasRigAuthoring || item.files?.[".ispine/rig/document.json"]) ? (() => { const summary = item.rigSummary || rigAuthoringSummary(item.files); return summary ? `${summary.baseParts} 个基础部件${summary.poseRegions ? ` · ${summary.poseRegions} 个动作区域` : ""}` : `自建骨架 · ${item.partCount ?? 0} 个纹理区域`; })() : `${item.replacementCount ?? Object.keys(item.edits || {}).length} 个部件已替换`}</small></span>
            <span className="explorer-cell">{item.animationCount ?? 0}</span><span className="explorer-cell">{item.partCount ?? 0}</span>
          </button>)}
          {!records.length && <div className="empty-state"><Layers size={32} /><h3>{search ? "没有匹配的资源" : showTrash ? "回收站为空" : "还没有创作资源"}</h3><p>{search ? "试试其他名称。" : showTrash ? "删除的资源会保存在这里，可以恢复。" : "导入工程，或从模板库创建角色。"}</p>
            {!search && !showTrash && <div className="button-row"><button className="button" disabled={busy} onClick={onImport}><FolderOpen size={15} />导入工程</button>
              {onCreateRig && <button className="button primary" disabled={busy} onClick={onCreateRig}><Bone size={15} />从立绘创建骨架</button>}
              {onBrowseTemplates && <button className="button" disabled={busy} onClick={onBrowseTemplates}>浏览模板</button>}</div>}</div>}
        </div>
        <div className="explorer-list-footer">{records.length} 个资源 · {showTrash ? "选择后可恢复或永久删除" : "双击直接编辑"}</div>
      </div>
      <section className="explorer-stage" aria-label="资源动画预览">
        <div className="explorer-stage-heading"><div><button className="button explorer-back" onClick={() => setMobilePreview(false)}><ArrowLeft size={16} />返回列表</button><strong>动画预览</strong></div><span>{record ? record.name : "选择资源"}</span></div>
        <div className="explorer-canvas">{preview ? <SpineViewer bundle={preview.bundle} pages={preview.pages} clock={clock.current}
          animation={animation} skin={preview.skin} label="资源库角色" /> : <div className="viewer-message">{error || (record ? <><LoaderCircle className="spin" size={20} />正在加载角色…</> : "从左侧选择资源，查看真实动画。")}</div>}</div>
        {preview && <PreviewTransport clock={clock.current} duration={preview.durations[animation] || 1} animation={animation} animations={preview.animations}
          onAnimation={changeAnimation} onTogglePlay={togglePlay} playing={playing} label="资源" />}
      </section>
      <aside className="explorer-inspector" aria-label="资源详情">
        <div className="explorer-inspector-heading"><h2>{record?.name || "选择一个资源"}</h2><p>{showTrash ? "回收站 · 可恢复资源" : authored ? "角色 · 自建骨架" : "角色 · 本机资源"}</p></div>
        {record && <><dl className="explorer-facts"><div><dt>动作</dt><dd>{actionCount}</dd></div><div><dt>纹理区域</dt><dd>{record.partCount ?? 0}</dd></div>{rigSummary && <div><dt>基础部件</dt><dd>{rigSummary.baseParts}</dd></div>}{rigSummary?.poseRegions > 0 && <div><dt>动作区域</dt><dd>{rigSummary.poseRegions}</dd></div>}<div><dt>{authored ? "骨骼" : "已替换部件"}</dt><dd>{authored ? record.boneCount ?? 0 : (record.replacementCount ?? Object.keys(record.edits || {}).length)}</dd></div></dl>
          <div className="explorer-animation-list"><h3>动作</h3>{preview ? preview.animations.map((name) => <button key={name} className={animation === name ? "selected" : ""} aria-pressed={animation === name} disabled={busy} onClick={() => changeAnimation(name)}>{name}</button>)
            : <p className="muted small">{error ? "预览未能加载。" : "正在读取动作…"}</p>}</div>
          <div className="explorer-inspector-actions">{showTrash ? <>
            <button className="button primary explorer-primary-action" disabled={busy} onClick={() => onRestore(record)}><RotateCcw size={17} />恢复资源</button>
            <button className="button danger" disabled={busy} onClick={() => onDeleteForever(record)}><Trash2 size={15} />永久删除</button>
          </> : <>
            <button className="button primary explorer-primary-action" disabled={!preview || busy} onClick={() => onOpen(record)}><SlidersHorizontal size={17} />编辑与校准</button>
            {onEditRig && record.files?.[".ispine/rig/document.json"] && <button className="button" disabled={!preview || busy} onClick={() => onEditRig(record)}><Bone size={16} />骨架与动作</button>}
            {onManualAdjust && record.files?.[".ispine/rig/document.json"] && <button className="button" disabled={!preview || busy} onClick={() => onManualAdjust(record)}><Move size={16} />手动调整</button>}
            {onAddTemplate && <button className="button" disabled={!preview || busy} onClick={() => onAddTemplate(record)}><Layers size={16} />{customTemplateProjectIds.includes(record.id) ? "更新模板" : "加入模板"}</button>}
            <button className="button danger" disabled={busy} onClick={() => onTrash(record)}><Trash2 size={15} />删除资源</button>
          </>}<p>{showTrash ? "恢复后可继续编辑，部件与校准结果会一并保留。" : "修改后自动保存"}</p></div>
        </>}
        {!record && <p className="muted">{showTrash ? "回收站中的资源可在这里恢复。" : "选择资源后查看详情与完整动作。"}</p>}
      </aside>
    </div>
  </section>;
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Layers, Pause, Play, SlidersHorizontal, LoaderCircle, FolderOpen } from "lucide-react";
import { parseBundle } from "../core/archive.js";
import { compilePages } from "../core/pixels.js";
import { parseSkeleton } from "../spine/runtime.js";
import { SpineViewer } from "./SpineViewer.jsx";

export function ResourceLibrary({ projects, onOpen, onImport }) {
  const [search, setSearch] = useState(""), [sort, setSort] = useState("updated");
  const [selected, setSelected] = useState(null), [preview, setPreview] = useState(null);
  const [error, setError] = useState(""), [animation, setAnimation] = useState("");
  const [playing, setPlaying] = useState(true);
  const clock = useRef({ position: 0, anchor: performance.now(), playing: true,
    read(now = performance.now()) { return this.position + (this.playing ? (now - this.anchor) / 1000 : 0); } });
  const records = useMemo(() => projects.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "zh-CN") : b.updatedAt.localeCompare(a.updatedAt)), [projects, search, sort]);
  const record = records.find((p) => p.id === selected) || records[0];
  useEffect(() => {
    let cancelled = false;
    setPreview(null); setError("");
    if (!record) return;
    void (async () => {
      const bundle = parseBundle(record.files, { skeletonPath: record.skeletonPath, name: record.name });
      const { data } = parseSkeleton(bundle);
      const pages = await compilePages(bundle, record.edits || {});
      if (cancelled) return;
      const animations = data.animations.map((a) => a.name);
      setAnimation(["idle", "std", "stand"].find((a) => animations.includes(a)) || animations[0] || "");
      clock.current.position = 0; clock.current.anchor = performance.now();
      setPreview({ bundle, pages, animations, skin: data.skins[0]?.name || "" });
    })().catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [record]);
  const togglePlay = () => {
    clock.current.position = clock.current.read(); clock.current.anchor = performance.now();
    clock.current.playing = !playing; setPlaying(!playing);
  };
  return <section className="resource-library" aria-label="我的资源库">
    <div className="library-heading">
      <div><h2>我的资源 <span className="count">{projects.length}</span></h2><p>单击预览角色与动作，进入编辑后可替换部件、校准和导出。</p></div>
      <button className="button primary" onClick={onImport}><FolderOpen size={16} />导入工程</button>
    </div>
    <div className="library-layout">
      <div className="library-browser panel">
        <div className="library-search">
          <label><Search size={16} /><input aria-label="搜索我的资源" placeholder="搜索资源名称…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          <select aria-label="资源排序" value={sort} onChange={(e) => setSort(e.target.value)}><option value="updated">最近修改</option><option value="name">名称排序</option></select>
        </div>
        <div className="library-cards">
          {records.map((item) => <button key={item.id} className={`library-card ${item.id === record?.id ? "selected" : ""}`}
            aria-label={`预览 ${item.name}`} aria-pressed={item.id === record?.id} onClick={() => setSelected(item.id)} onDoubleClick={() => onOpen(item)}>
            <div className="library-thumbnail">{item.thumbnail ? <img src={item.thumbnail} alt="" /> : <Layers size={42} />}
              <span>Spine 4.3</span></div>
            <strong>{item.name}</strong><small>{item.partCount} 个部件 · {item.animationCount} 个动作</small>
            <time>{new Date(item.updatedAt).toLocaleDateString("zh-CN")}</time>
          </button>)}
          {!records.length && <div className="empty-state"><Layers size={32} /><h3>{projects.length ? "没有匹配的资源" : "还没有创作资源"}</h3><p>{projects.length ? "试试其他名称。" : "导入工程，或从模板库创建角色。"}</p></div>}
        </div>
        <div className="library-list-footer">{records.length} 个资源 · 双击直接编辑</div>
      </div>
      <section className="library-inspector panel" aria-label="资源动画预览">
        <div className="library-preview-title"><div><span className="eyebrow">资源预览</span><h3>{record?.name || "选择一个资源"}</h3></div>
          <span className="local-badge">本机资源</span></div>
        {preview && <div className="preview-controls"><label>动作<select aria-label="资源预览动作" value={animation} onChange={(e) => {
          setAnimation(e.target.value); clock.current.position = 0; clock.current.anchor = performance.now();
        }}>{preview.animations.map((name) => <option key={name}>{name}</option>)}</select></label>
          <button className="icon-button framed accent" aria-label={playing ? "暂停资源预览" : "播放资源预览"} onClick={togglePlay}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
          <small>{preview.animations.length} 个动作</small></div>}
        <div className="library-viewer">{preview ? <SpineViewer bundle={preview.bundle} pages={preview.pages} clock={clock.current}
          animation={animation} skin={preview.skin} label="资源库角色" /> : <div className="viewer-message">{error || (record ? <><LoaderCircle className="spin" size={20} />正在加载角色…</> : "从左侧选择资源，查看真实动画。")}</div>}</div>
        {record && <div className="library-details"><div><strong>{record.partCount}</strong><span>纹理部件</span></div><div><strong>{record.animationCount}</strong><span>完整动作</span></div><div><strong>{Object.keys(record.edits || {}).length}</strong><span>已替换部件</span></div></div>}
        <div className="library-preview-footer"><p>预览显示当前已应用的部件与校准结果。</p><button className="button primary" disabled={!preview} onClick={() => onOpen(record)}><SlidersHorizontal size={16} />编辑与校准</button></div>
      </section>
    </div>
  </section>;
}

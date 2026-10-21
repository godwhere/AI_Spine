import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Grid3X3, Layers, List, LoaderCircle, Plus, Search, Upload } from "lucide-react";
import { SpineViewer } from "../../components/SpineViewer.jsx";
import { PreviewTransport } from "../../components/PreviewTransport.jsx";
import { ResourceThumbnail } from "../../components/ResourceThumbnail.jsx";

export function TemplateLibrary({
  countRegions,
  catalog = [], visibleTemplates = catalog, selectedTemplate, onSelect,
  type, category, search, onType, onCategory, onSearch,
  bundle, loading, clock, animation, skin, playing, onAnimation, onTogglePlay,
  onCreate, onImport, projects = [], onOpen, onDeleteTemplate,
}) {
  const [view, setView] = useState("list");
  const [mobilePreview, setMobilePreview] = useState(false);
  const [regionCounts, setRegionCounts] = useState({});
  const categories = [...new Set(catalog.filter((item) => type === "全部" || item.type === (type === "角色" ? "role" : "effect")).flatMap((item) => item.categories || []))].filter((value) => value !== "全部" && value !== "我创建的");
  const selectType = (value) => { onType(value); onCategory("全部"); };
  const duplicateNames = useMemo(() => {
    const counts = new Map();
    for (const item of catalog) counts.set(item.name, (counts.get(item.name) || 0) + 1);
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  }, [catalog]);

  const visibleIds = visibleTemplates.map((item) => item.id).join(",");
  useEffect(() => {
    if (!visibleTemplates.some((item) => item.id === selectedTemplate?.id)) {
      if (visibleTemplates.length || selectedTemplate) onSelect(visibleTemplates[0] || null);
      setMobilePreview(false);
    }
  }, [visibleIds, selectedTemplate?.id, onSelect]);

  useEffect(() => {
    const controller = new AbortController();
    for (const item of catalog) {
      if (item.source === "custom") continue;
      void countRegions(item, { signal: controller.signal }).then((count) => {
        if (controller.signal.aborted || count === undefined) return;
        setRegionCounts((previous) => ({ ...previous, [item.id]: count }));
      }).catch(() => { /* Keep an unavailable count unknown instead of showing attachment counts. */ });
    }
    return () => controller.abort();
  }, [catalog]);

  const currentBundle = !loading && bundle &&
    (!bundle.id || bundle.id === `template-${selectedTemplate?.id}`) ? bundle : null;
  const animations = currentBundle?.animations || [];
  const regionCount = (item) => item?.source === "custom" ? item.regionCount : regionCounts[item?.id];
  const selectedRegions = currentBundle?.parts.length ?? regionCount(selectedTemplate);
  const related = selectedTemplate
    ? projects.filter((project) => String(project.templateId) === String(selectedTemplate.id))
    : [];
  const selectTemplate = (item) => { onSelect(item); setMobilePreview(true); };
  const templateIdentifier = (item) => item.source === "custom" ? `我的模板 #${String(item.id).slice(-8)}` : `#${item.id}`;
  const templateName = (item) => `${item.name}${duplicateNames.has(item.name) || item.source === "custom" ? `（${templateIdentifier(item)}）` : ""}`;
  const createAction = <button className="button primary" disabled={!currentBundle} onClick={onCreate}><Plus size={20} />{selectedTemplate?.type === "effect" ? "创建特效" : "创建角色"}</button>;

  return <section className={`explorer template-explorer${view === "images" ? " image-layout" : ""}${mobilePreview ? " preview-open" : ""}`} aria-label="模板库">
    <div className="explorer-toolbar">
      <div className="explorer-title"><h2>模板库</h2><span>{catalog.length} 个模板</span></div>
      <label className="explorer-search"><Search size={18} /><input aria-label="搜索模板" placeholder="搜索模板…" value={search} onChange={(event) => onSearch(event.target.value)} /></label>
      <div className="explorer-view-toggle" role="group" aria-label="模板显示方式">
        <button className="icon-button" aria-label="列表视图" title="1 列 · 列表" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={20} /></button>
        <button className="icon-button" aria-label="三列图片视图" title="3 列 · 仅显示图片" aria-pressed={view === "images"} onClick={() => setView("images")}><Grid3X3 size={19} /></button>
      </div>
      <button className="button explorer-import" onClick={onImport}><Upload size={17} />导入模板</button>
    </div>

    <div className="template-categories" aria-label="模板分类筛选">
      <div role="group" aria-label="模板类型"><strong>类型</strong>{["全部", "角色", "特效"].map((value) => <button key={value} aria-pressed={type === value} onClick={() => selectType(value)}>{value}</button>)}</div>
      <div role="group" aria-label="模板分类"><strong>分类</strong>{["全部", "我创建的", ...categories].map((value) => <button key={value} aria-pressed={category === value} onClick={() => onCategory(value)}>{value}</button>)}</div>
    </div>

    <div className="explorer-workspace">
      <div className="explorer-list-pane">
        <div className="explorer-columns" aria-hidden="true"><span>名称</span><span>动作</span><span title="Atlas 纹理区域数量">区域</span></div>
        <div className={`explorer-rows${view === "images" ? " is-images" : ""}`} role="list" aria-label="模板列表">
          {visibleTemplates.map((item) => {
            const selected = item.id === selectedTemplate?.id;
            const regions = selected && currentBundle ? currentBundle.parts.length : regionCount(item);
            return <button key={item.id} role="listitem" aria-label={`选择模板 ${templateName(item)}`}
              aria-current={selected ? "true" : undefined} title={templateName(item)}
              className={`explorer-row${selected ? " selected" : ""}`} onClick={() => selectTemplate(item)}>
              <span className="explorer-thumbnail">{item.source === "custom" ? <ResourceThumbnail src={item.thumbnail} /> : <img src={item.thumbnail} alt="" loading="lazy" />}</span>
              <span className="explorer-row-name"><strong>{item.name}{duplicateNames.has(item.name) && <small className="template-identifier"> {templateIdentifier(item)}</small>}</strong><small>{item.source === "custom" ? "我创建的 · " : item.type === "effect" ? "特效 · " : ""}{item.categories.join(" / ")}</small></span>
              <span className="explorer-cell" title={`${item.animationCount} 个动作`}>{selected && currentBundle ? currentBundle.animations.length : item.animationCount}</span>
              <span className="explorer-cell" title={regions == null ? "正在读取可替换纹理区域" : `${regions} 个可替换纹理区域`}>{regions ?? "—"}</span>
            </button>;
          })}
          {!visibleTemplates.length && <div className="empty-state"><Layers size={30} /><h3>没有匹配的模板</h3><p>试试其他名称或筛选条件。</p></div>}
        </div>
        <div className="explorer-list-footer">{visibleTemplates.length} 个模板{visibleTemplates.length !== catalog.length && ` / 共 ${catalog.length} 个`}</div>
      </div>

      <section className="explorer-stage" aria-label="模板动画预览">
        <div className="explorer-stage-heading"><button className="button subtle explorer-mobile-back" onClick={() => setMobilePreview(false)}><ArrowLeft size={16} />返回列表</button><h3>动画预览</h3><span>{selectedTemplate?.name}</span></div>
        <div className="explorer-canvas">{currentBundle
          ? <SpineViewer bundle={currentBundle} clock={clock} animation={animation} skin={skin} label="模板预览" />
          : <div className="viewer-message">{loading ? <><LoaderCircle size={23} className="spin" />正在加载模板…</> : "选择一个模板，查看完整动画。"}</div>}
        </div>
        {currentBundle && <PreviewTransport clock={clock} duration={currentBundle.durations?.[animation] || 1}
          animation={animation} animations={animations} onAnimation={onAnimation} onTogglePlay={onTogglePlay} playing={playing} label="模板" />}
      </section>

      <aside className="explorer-inspector" aria-label="模板详情">
        <div className="explorer-inspector-title"><h2>{selectedTemplate?.name || "选择模板"}</h2><p>{selectedTemplate ? `${selectedTemplate.source === "custom" ? "我创建的" : selectedTemplate.type === "effect" ? "特效" : "角色"} · ${selectedTemplate.categories.join(" / ")}` : "从列表中选择角色或特效"}</p></div>
        <dl className="explorer-facts"><div><dt>动作</dt><dd>{currentBundle?.animations.length ?? selectedTemplate?.animationCount ?? "—"}</dd></div><div><dt>可替换区域</dt><dd>{selectedRegions ?? "—"}</dd></div>{currentBundle?.skins.length > 1 && <div><dt>皮肤</dt><dd>{currentBundle.skins.length}</dd></div>}</dl>
        <div className="explorer-animation-list"><h3>动作</h3>{animations.map((name) => <button key={name} aria-label={`预览动作 ${name}`} aria-pressed={animation === name} onClick={() => onAnimation(name)}>{name}</button>)}{!animations.length && <p className="muted small">{loading ? "正在读取动作…" : "选择模板后显示动作"}</p>}</div>
        <div className="explorer-primary-action">{selectedTemplate?.source === "custom" && onDeleteTemplate
          ? <div className="button-row">{createAction}<button className="button danger" disabled={loading} onClick={() => onDeleteTemplate(selectedTemplate)}>删除模板</button></div>
          : createAction}<p>修改后自动保存</p></div>
        {related.length > 0 && <div className="explorer-related"><h3>此模板的资源 <span>{related.length}</span></h3>{related.map((project) => <button key={project.id} onClick={() => onOpen(project)}>{project.thumbnail && <img src={project.thumbnail} alt="" />}<span>{project.name}</span><ArrowRight size={14} /></button>)}</div>}
      </aside>
    </div>
  </section>;
}

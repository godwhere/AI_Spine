import { useEffect, useRef, useState } from "react";

const checks = [
  ["hiddenReviewed", "隐藏接头和被遮挡部分完整"],
  ["isolationReviewed", "没有混入其他部件或背景"],
  ["sourceMaskReviewed", "原图可见轮廓的部件归属正确"],
];
const number = (value, digits = 0) => Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "未提供";
const percent = (value) => Number.isFinite(value) ? `${number(value * 100, 2)}%` : "未提供";
const issueText = (issue) => typeof issue === "string" ? issue : issue?.message || issue?.reason || "部件需要检查";
const rectText = (rect) => rect ? `${number(rect.x, 2)}, ${number(rect.y, 2)} · ${number(rect.width, 2)} × ${number(rect.height, 2)} px` : "未提供";
const sameRect = (a, b) => a && b && ["x", "y", "width", "height"].every((key) => a[key] === b[key]);
const sourceLockFor = (part, entry) => part.sourceLockForced || part.requiresBlankFace ? "underlay-only" : entry?.sourceLock || part.sourceLock || "known-source";
const partApproved = (part, entry) => Boolean(entry?.approved && entry.imageSHA256 === part.imageSHA256 &&
  checks.every(([key]) => entry[key]) && (!part.requiresBlankFace || entry.blankFace));

function comparisonBounds(document, part, polygon, fullCanvas) {
  if (fullCanvas) return `0 0 ${document.width} ${document.height}`;
  const rects = [part.rect, part.currentRect].filter(Boolean);
  const points = [...rects.flatMap((rect) => [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }]), ...(polygon || [])];
  const left = Math.min(...points.map((point) => point.x)), top = Math.min(...points.map((point) => point.y));
  const width = Math.max(1, Math.max(...points.map((point) => point.x)) - left), height = Math.max(1, Math.max(...points.map((point) => point.y)) - top);
  const padding = Math.max(8, Math.max(width, height) * .08);
  return `${left - padding} ${top - padding} ${width + padding * 2} ${height + padding * 2}`;
}

function WorldComparison({ document, part, parts, fullCanvas }) {
  const neutral = part.attachmentGroup && parts.find((item) => item.attachmentGroup === part.attachmentGroup && item.defaultVisible);
  const polygon = part.sourcePolygon || neutral?.sourcePolygon;
  const viewBox = comparisonBounds(document, part, polygon, fullCanvas);
  const polygonPoints = polygon?.map(({ x, y }) => `${x},${y}`).join(" ");
  return <>
    <div className="complete-overlap-comparison">
      {[false, true].map((source) => <figure key={String(source)}>
        <figcaption>{source ? "原图与可见轮廓" : "完整独立底图"}</figcaption>
        <div className="complete-overlap-image">
          <svg viewBox={viewBox} role="img" aria-label={`${part.label}${source ? "原图轮廓对照" : "完整底图"}`}>
            {source ? <image href={document.sourceImage} x="0" y="0" width={document.width} height={document.height} preserveAspectRatio="none" /> :
              part.image && <image href={part.image} {...part.rect} preserveAspectRatio="none" />}
            <rect {...part.rect} fill="none" stroke="#7d6b96" strokeDasharray="5 4" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
            {polygonPoints && <polygon points={polygonPoints} fill="#9062d712" stroke="#8852d4" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />}
          </svg>
        </div>
      </figure>)}
    </div>
    <p className="complete-overlap-caption">两侧使用相同世界坐标与比例。虚线为完整底图矩形，紫线为原图可见轮廓；完整底图不按轮廓裁断。</p>
    {!part.defaultVisible && <p className="complete-overlap-note">这是表情变体，基准立绘不显示它。{!part.sourcePolygon && neutral?.sourcePolygon ? "紫线借用同组默认表情，只用于核对位置和五官归属。" : "请核对它在所属五官位置的独立性与遮挡。"}</p>}
    {!polygonPoints && <p className="complete-overlap-note">此部件没有已保存的可见轮廓。请核对原图位置和归属；候选会如实报告未锁定的源像素。</p>}
  </>;
}

function CandidateMetrics({ metrics }) {
  const before = metrics.before || {}, after = metrics.after || metrics, overlap = metrics.completeOverlap || {};
  return <div className="complete-overlap-metrics">
    <table>
      <caption>设置姿态的实际像素测量</caption>
      <thead><tr><th scope="col">指标</th><th scope="col">当前组装</th><th scope="col">完整重叠候选</th></tr></thead>
      <tbody>
        <tr><th scope="row">Alpha 轮廓交并比</th><td>{percent(before.alphaIoU)}</td><td>{percent(after.alphaIoU)}</td></tr>
        <tr><th scope="row">预乘颜色平均误差</th><td>{number(before.pixelMAE, 4)}</td><td>{number(after.pixelMAE, 4)}</td></tr>
        <tr><th scope="row">最大 Alpha 误差</th><td>{number(before.maxAlphaError, 2)}</td><td>{number(after.maxAlphaError, 2)}</td></tr>
        <tr><th scope="row">最大预乘颜色误差</th><td>{number(before.maxPremultipliedColorError, 2)}</td><td>{number(after.maxPremultipliedColorError, 2)}</td></tr>
        <tr><th scope="row">缺失 / 新增轮廓像素</th><td>{number(before.missingAlphaPixels)} / {number(before.extraAlphaPixels)}</td><td>{number(after.missingAlphaPixels)} / {number(after.extraAlphaPixels)}</td></tr>
      </tbody>
    </table>
    <dl>
      <div><dt>保留完整底图像素</dt><dd>{number(overlap.preservedPixels)}</dd></div>
      <div><dt>其中原图轮廓外像素</dt><dd>{number(overlap.retainedOutsideSourcePixels)}</dd></div>
      <div><dt>保留隐藏补绘像素</dt><dd>{number(metrics.hiddenPixels)}</dd></div>
      <div><dt>实际锁定源像素覆盖率</dt><dd>{percent(overlap.sourceLockCoverage)}</dd></div>
      <div><dt>未按已审轮廓锁定的源像素</dt><dd>{number(overlap.unassignedSourcePixels)}</dd></div>
      <div><dt>保留空白脸底像素</dt><dd>{number(overlap.protectedFacePixels)}</dd></div>
      {overlap.boundaryPolicy === "source-occlusion" && <><div><dt>遮挡边界校正像素</dt><dd>{number(overlap.boundarySuppressedPixels)}</dd></div><div><dt>补充分配源像素</dt><dd>{number(overlap.fallbackLockedPixels)}</dd></div></>}
    </dl>
    <p>误差以 0–255 颜色值计。重叠底图会改变半透明叠色及轮廓；交并比不代表接头、表情和动作已验证。</p>
  </div>;
}

export function CompleteOverlapPanel({ imageTools, document, disabled = false, onApply, onClose }) {
  const { prepareCompleteOverlapReview, restoreCompleteOverlapReview, registerRigSourcePixels } = imageTools;
  const [boundaryPolicy, setBoundaryPolicy] = useState("full-underlay");
  const [prepared, setPrepared] = useState(null), [review, setReview] = useState({}), [selectedId, setSelectedId] = useState("");
  const [candidate, setCandidate] = useState(null), [candidateURL, setCandidateURL] = useState(""), [visualReviewed, setVisualReviewed] = useState(false);
  const [operation, setOperation] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [fullCanvas, setFullCanvas] = useState(false);
  const panel = useRef(null), resultPanel = useRef(null), current = useRef(null), alive = useRef(true), epoch = useRef(0), busy = useRef(false), previousDocument = useRef(document);
  current.current = { document, disabled, onApply, onClose };
  const active = prepared?.snapshot === document ? prepared : null;
  const parts = active?.value.parts || [], part = parts.find((item) => item.partId === selectedId) || parts[0];
  const entry = part ? review[part.partId] || {} : {};
  const sourceLock = part ? sourceLockFor(part, entry) : "known-source";
  const approved = parts.filter((item) => partApproved(item, review[item.partId])).length;
  const locked = disabled || Boolean(operation) || !active;
  const selectedMetrics = candidate?.value.metrics.completeOverlap?.parts?.find((item) => item.partId === part?.partId);

  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  useEffect(() => {
    let cancelled = false;
    const ticket = ++epoch.current, snapshot = document;
    const changed = previousDocument.current !== document;
    previousDocument.current = document;
    setPrepared(null); setCandidate(null); setReview({}); setVisualReviewed(false); setError("");
    setNotice(changed ? "草稿已改变，已清除旧审阅和候选。请重新逐件检查。" : "");
    busy.current = true; setOperation("正在读取完整独立底图…");
    Promise.resolve().then(async () => {
      if (cancelled || !alive.current || ticket !== epoch.current) return;
      try {
        const value = await prepareCompleteOverlapReview(snapshot);
        if (cancelled || !alive.current || ticket !== epoch.current || current.current.document !== snapshot) return;
        const restored = restoreCompleteOverlapReview?.(value, snapshot.registration?.completeOverlapReview) || {};
        setPrepared({ value, snapshot }); setSelectedId(value.parts[0]?.partId || ""); setReview(restored);
        setBoundaryPolicy(Object.keys(restored).length ? snapshot.registration.completeOverlapReview.boundaryPolicy || "full-underlay" : "full-underlay");
      } catch (failure) {
        if (!cancelled && alive.current && ticket === epoch.current) setError(failure.message || "无法读取完整部件。");
      } finally {
        if (!cancelled && alive.current && ticket === epoch.current) { busy.current = false; setOperation(""); }
      }
    });
    return () => { cancelled = true; };
  }, [document]);
  useEffect(() => {
    if (!candidate?.value.preview?.png) { setCandidateURL(""); return; }
    const url = URL.createObjectURL(new Blob([candidate.value.preview.png], { type: "image/png" }));
    setCandidateURL(url);
    return () => URL.revokeObjectURL(url);
  }, [candidate]);
  useEffect(() => {
    if (candidate?.snapshot === document) resultPanel.current?.scrollIntoView?.({ behavior: "smooth", block: "start", inline: "nearest" });
  }, [candidate, document]);
  useEffect(() => {
    const node = panel.current, previous = globalThis.document?.activeElement;
    if (!node) return;
    const focusable = () => [...node.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled)")].filter((element) => element.offsetParent !== null);
    focusable()[0]?.focus();
    const keydown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); current.current.onClose?.(); }
      if (event.key !== "Tab") return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (globalThis.document.activeElement === first || !node.contains(globalThis.document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (globalThis.document.activeElement === last || !node.contains(globalThis.document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    node.addEventListener("keydown", keydown);
    return () => { node.removeEventListener("keydown", keydown); previous?.focus?.(); };
  }, []);

  const changeCheck = (key, checked) => {
    if (locked || !part) return;
    setReview((previous) => ({ ...previous, [part.partId]: { ...previous[part.partId], [key]: checked, approved: false, imageSHA256: part.imageSHA256 } }));
    setCandidate(null); setVisualReviewed(false); setError("");
  };
  const changeSourceLock = (value) => {
    if (locked || !part || part.sourceLockForced || part.requiresBlankFace || !["known-source", "underlay-only"].includes(value)) return;
    setReview((previous) => ({ ...previous, [part.partId]: { ...previous[part.partId], sourceLock: value,
      approved: false, sourceMaskReviewed: false, imageSHA256: part.imageSHA256 } }));
    setCandidate(null); setVisualReviewed(false); setError("");
    setNotice(`${part.label}已切换像素来源，请重新确认该件的原图轮廓归属。其他部件的审阅保留。`);
  };
  const confirmPart = () => {
    if (locked || !part || part.issues.length || !checks.every(([key]) => entry[key]) || (part.requiresBlankFace && !entry.blankFace)) return;
    setReview((previous) => ({ ...previous, [part.partId]: { ...entry, sourceLock, imageSHA256: part.imageSHA256, approved: true } }));
    setCandidate(null); setVisualReviewed(false);
    const next = parts.find((item) => item.partId !== part.partId && !partApproved(item, review[item.partId]));
    if (next) setSelectedId(next.partId);
  };
  const computeCandidate = async () => {
    if (busy.current || disabled || !active?.value.ready || !parts.length || approved !== parts.length || current.current.document !== active.snapshot) return;
    const snapshot = active.snapshot, ticket = epoch.current;
    busy.current = true; setOperation("正在计算完整重叠候选与像素差异…"); setError(""); setCandidate(null); setVisualReviewed(false);
    try {
      const value = await registerRigSourcePixels(snapshot, { mode: "complete-overlap", review: {
        sourceFingerprint: active.value.sourceFingerprint, geometryFingerprint: active.value.geometryFingerprint,
        ...(boundaryPolicy !== "full-underlay" ? { boundaryPolicy } : {}),
        parts: parts.map((item) => ({ partId: item.partId, imageSHA256: item.imageSHA256, sourceLock: sourceLockFor(item, review[item.partId]), ...Object.fromEntries(
          ["approved", "hiddenReviewed", "isolationReviewed", "sourceMaskReviewed", ...(item.requiresBlankFace ? ["blankFace"] : [])].map((key) => [key, review[item.partId][key] === true])) })),
      } });
      if (!alive.current || ticket !== epoch.current || current.current.document !== snapshot) return;
      setCandidate({ value, snapshot });
    } catch (failure) {
      if (alive.current && ticket === epoch.current) setError(failure.message || "候选计算失败，请检查部件与轮廓。");
    } finally {
      if (alive.current && ticket === epoch.current) { busy.current = false; setOperation(""); }
    }
  };
  const applyCandidate = async () => {
    if (busy.current || current.current.disabled || !visualReviewed || !candidate || candidate.snapshot !== current.current.document || typeof current.current.onApply !== "function") return;
    const ticket = epoch.current;
    busy.current = true; setOperation("正在应用完整重叠候选…"); setError("");
    try {
      await current.current.onApply(candidate.value.document, candidate.snapshot);
      if (alive.current) current.current.onClose?.();
    } catch (failure) {
      if (alive.current && ticket === epoch.current) setError(failure.message || "应用失败，候选仍可重新检查。");
    } finally {
      if (alive.current && ticket === epoch.current) { busy.current = false; setOperation(""); }
    }
  };

  return <div className="complete-overlap-backdrop">
    <section className="complete-overlap-panel" role="dialog" aria-modal="true" aria-label="完整重叠部件" ref={panel} aria-busy={Boolean(operation)}>
      <header className="complete-overlap-header">
        <div><h2>完整重叠部件</h2><p>逐件检查完整底图、隐藏接头与原图轮廓，再检查真实重组候选。</p></div>
        <button type="button" className="button" onClick={() => current.current.onClose?.()}>关闭</button>
      </header>
      {error && <p className="complete-overlap-alert" role="alert">{error}</p>}
      {notice && <p className="complete-overlap-notice">{notice}</p>}
      <div className="complete-overlap-status" role="status"><span>{operation || (candidate ? "候选已生成，请检查中栏重组与像素差异。" : `${approved} / ${parts.length} 件已确认`)}</span><progress aria-label="完整部件逐件审阅进度" value={approved} max={parts.length || 1} /></div>
      <div className="complete-overlap-body">
        <aside className="complete-overlap-library" aria-label="完整底图部件列表">
          <div className="complete-overlap-library-heading"><strong>独立部件</strong><span>{parts.length} 件</span></div>
          <div className="complete-overlap-parts">
            {parts.map((item) => <button type="button" key={item.partId} className={item.partId === part?.partId ? "selected" : ""}
              aria-pressed={item.partId === part?.partId} onClick={() => setSelectedId(item.partId)}>
              {item.image && <img src={item.image} alt="" loading="lazy" />}
              <span><strong>{item.label}</strong><small>{item.defaultVisible ? "默认显示" : "表情变体"} · {partApproved(item, review[item.partId]) ? "已确认" : item.issues.length ? "待修复" : "待审阅"}</small></span>
              <span className={partApproved(item, review[item.partId]) ? "complete-overlap-done" : "complete-overlap-wait"} aria-hidden="true">{partApproved(item, review[item.partId]) ? "✓" : "○"}</span>
            </button>)}
          </div>
        </aside>
        <main className="complete-overlap-main">
          {part ? <>
            <div className="complete-overlap-view-heading"><div><h3>{part.label}</h3><p>完整底图：{rectText(part.rect)}</p></div>
              <label><input type="checkbox" checked={fullCanvas} onChange={(event) => setFullCanvas(event.target.checked)} />整张画布</label>
            </div>
            <WorldComparison document={document} part={part} parts={parts} fullCanvas={fullCanvas} />
            {!sameRect(part.rect, part.currentRect) && <p className="complete-overlap-caption">当前校准矩形：{rectText(part.currentRect)}。本次审阅显示保存的独立底图坐标。</p>}
            {candidate && candidate.snapshot === document && <section className="complete-overlap-result" aria-label="完整重叠候选预览" ref={resultPanel}>
              <h3>真实重组候选</h3><p>当前草稿尚未改变。请检查隐藏面是否完整、是否出现额外轮廓和五官混入，再决定应用。</p>
              <div className="complete-overlap-result-pair">
                <figure><figcaption>原始立绘</figcaption><div className="complete-overlap-preview"><img src={document.sourceImage} alt="未改变的原始立绘" /></div></figure>
                <figure><figcaption>完整重叠候选</figcaption><div className="complete-overlap-preview">{candidateURL && <img src={candidateURL} alt="完整重叠候选的真实设置姿态重组" />}</div></figure>
              </div>
              <CandidateMetrics metrics={candidate.value.metrics} />
            </section>}
          </> : <p className="complete-overlap-empty">{operation || "没有可审阅的完整独立部件。"}</p>}
        </main>
        <aside className="complete-overlap-controls" aria-label="部件逐件审阅与候选应用">
          {part && <>
            <div className="complete-overlap-control-section"><h3>检查完整独立图</h3>
              <dl className="complete-overlap-part-details">
                <div><dt>骨骼</dt><dd>{part.bone}</dd></div>
                <div><dt>底图来源</dt><dd>{part.baseSource === "registration-base" ? "保存的独立原始底图" : "当前独立图片"}</dd></div>
                <div><dt>有效可见像素</dt><dd>{number(part.alpha.significantPixels)}</dd></div>
                <div><dt>透明像素</dt><dd>{number(part.alpha.transparentPixels)}</dd></div>
              </dl>
              <p className="complete-overlap-caption">检查被袖口、衣摆、头发遮住的连接区域；无隐藏面时请先补绘，不能把裁片确认为完整部件。</p>
              <label className="complete-overlap-source-field">可见像素来源
                <select aria-label={`${part.label}：可见像素来源`} value={sourceLock} disabled={locked || part.issues.length > 0 || part.sourceLockForced || part.requiresBlankFace}
                  onChange={(event) => changeSourceLock(event.target.value)}>
                  <option value="known-source">原图已审轮廓＋完整底图</option>
                  <option value="underlay-only">仅使用完整独立底图</option>
                </select>
              </label>
              <p className="complete-overlap-caption">{sourceLock === "underlay-only" ? "此件仅使用完整独立底图，不贴回原图像素。原图轮廓仍用于核对位置、比例与归属。" : "按已审原图轮廓保留可见像素，并保留完整底图的隐藏部分。"}
                {(part.sourceLockForced || part.requiresBlankFace) && "脸底与眼眉嘴固定使用独立底图，避免把原图皮肤或五官再次贴回。"}</p>
              {part.issues.length > 0 && <ul className="complete-overlap-issues">{part.issues.map((issue, index) => <li key={index}>{issueText(issue)}</li>)}</ul>}
              <fieldset disabled={locked || part.issues.length > 0}>
                <legend className="complete-overlap-sr-only">{part.label}审阅项</legend>
                {checks.map(([key, label]) => <label key={key}><input type="checkbox" checked={Boolean(entry[key])} aria-label={`${part.label}：${label}`} onChange={(event) => changeCheck(key, event.target.checked)} /><span>{label}</span></label>)}
                {part.requiresBlankFace && <label className="complete-overlap-blank-face"><input type="checkbox" checked={Boolean(entry.blankFace)} aria-label={`${part.label}：已确认无眼眉嘴的完整空白脸底`} onChange={(event) => changeCheck("blankFace", event.target.checked)} /><span>已确认是无眼、眉、嘴的完整空白脸底，闭眼时仍有皮肤。</span></label>}
              </fieldset>
              <button type="button" className="button complete-overlap-primary" disabled={locked || partApproved(part, entry) || part.issues.length > 0 || !checks.every(([key]) => entry[key]) || (part.requiresBlankFace && !entry.blankFace)} onClick={confirmPart}>{partApproved(part, entry) ? "此部件已确认" : "确认此部件"}</button>
              {selectedMetrics && <dl className="complete-overlap-part-details"><div><dt>候选保留底图像素</dt><dd>{number(selectedMetrics.preservedPixels)}</dd></div><div><dt>候选隐藏补绘像素</dt><dd>{number(selectedMetrics.hiddenPixels)}</dd></div><div><dt>候选锁定源像素</dt><dd>{number(selectedMetrics.lockedPixels)}</dd></div></dl>}
            </div>
          </>}
          <div className="complete-overlap-control-section"><h3>计算与应用</h3>
            <p className="complete-overlap-caption">全部 {parts.length} 件逐件确认后，才会在临时副本计算候选。应用前仍需查看重组画面。</p>
            <label><input type="checkbox" aria-label="按原图遮挡校正可见边界" checked={boundaryPolicy === "source-occlusion"} disabled={locked} onChange={(event) => { setBoundaryPolicy(event.target.checked ? "source-occlusion" : "full-underlay"); setCandidate(null); setVisualReviewed(false); }} />按原图遮挡校正可见边界</label>
            <p className="complete-overlap-caption">启用后，普通默认部件锁定原图归属像素，补充分配数量单独报告；隐藏面保留在前景遮挡区。完整原生底图、空白脸底、五官和隐藏变体保留。仍需检查极限姿势及接头。</p>
            {active?.value.issues.length > 0 && <details className="complete-overlap-issues"><summary>{active.value.issues.length} 项待修复</summary><ul>{active.value.issues.map((issue, index) => <li key={index}>{issueText(issue)}</li>)}</ul></details>}
            <button type="button" className="button" disabled={locked || !active?.value.ready || !parts.length || approved !== parts.length} onClick={computeCandidate}>{candidate ? "重新计算重叠候选" : "计算完整重叠候选"}</button>
            {candidate && candidate.snapshot === document && <>
              <label className="complete-overlap-final-check"><input type="checkbox" checked={visualReviewed} disabled={locked} onChange={(event) => setVisualReviewed(event.target.checked)} /><span>已查看真实重组与像素差异；应用后继续检查骨骼补间和全部表情。</span></label>
              <button type="button" className="button complete-overlap-primary" disabled={locked || !visualReviewed || typeof onApply !== "function"} onClick={applyCandidate}>应用完整重叠候选</button>
            </>}
          </div>
        </aside>
      </div>
      <footer className="complete-overlap-footer">逐件确认记录的是人工审阅。设置姿态像素测量不代替动作验证；本面板不会生图或修改原始立绘。</footer>
    </section>
  </div>;
}

export default CompleteOverlapPanel;

import { useEffect, useRef, useState } from "react";
import { isRigJobActive } from "../../../shared/domain/generation.mjs";
import { motionFrameChecks, isMotionStudyJob, motionStudyPlan, motionStudySources, motionStudyFrameImage, patchMotionStudyFrame,
  assertMotionStudyCurrent, assertMotionStudyJob, motionStudyLinkedJobIds, loadMotionStudyHistory, motionStudyRequest, restoreMotionStudyPlan, loadMotionStudyImages, loadMotionStudyMappings, setMotionStudyPlayback } from "../../application/motion-study.js";
import { getMotionStudyFingerprints } from "../../../shared/domain/motion-study.mjs";
import { validateMotionStudyMapping } from "../../../shared/rig-schema.mjs";

const statusLabels = { queued: "等待处理", analyzing: "正在分析坐标", generating: "正在生成画面", completed: "已完成", failed: "失败", cancelled: "已取消" };
const clamp = (value, max) => Math.max(0, Math.min(max, value));
const images = (job) => job?.result?.images || job?.images || [];
const boundsText = (bounds) => bounds ? `${bounds.x}, ${bounds.y} · ${bounds.width} × ${bounds.height}px` : "无";

export function MotionStudyPanel({ imageTools, client, document, motion, disabled = false, onStudyChange, onPrepare, onApply, onClose, onBusyChange }) {
  const { diagnoseMotionStudyFrame, proposeMotionStudyGapOwnership, proposeCalibratedBaseMotionMapping, acceptMotionStudyOwnershipCandidate } = imageTools;
  const study = document.motionStudies?.[motion.id], sources = motionStudySources(study);
  const linkedHistoryKey = JSON.stringify(motionStudyLinkedJobIds(study));
  const repairFrameIds = sources.filter((item) => !item.reuseBase && (!item.image || item.review?.rejected)).map((item) => item.id);
  const [count, setCount] = useState(motion.id === "run" ? 4 : 3), [selectedId, setSelectedId] = useState("base");
  const [job, setJob] = useState(null), [jobs, setJobs] = useState([]), [operation, setOperation] = useState("");
  const [historyUnavailable, setHistoryUnavailable] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [mode, setMode] = useState("source");
  const [partId, setPartId] = useState(""), [vertex, setVertex] = useState(0), [focus, setFocus] = useState(false), [onlySelected, setOnlySelected] = useState(true), [opacity, setOpacity] = useState(0.5);
  const [jointId, setJointId] = useState(document.joints[0]?.id || "");
  const [coverage, setCoverage] = useState(null), [gapDistance, setGapDistance] = useState(64), [ownershipChecks, setOwnershipChecks] = useState({});
  const alive = useRef(true), operationRef = useRef(false), panel = useRef(), current = useRef();
  current.current = { document, motion, study, onStudyChange, onPrepare, onApply, onClose };
  const active = isRigJobActive(job), locked = Boolean(disabled || operation || active), frame = study?.frames.find((item) => item.id === selectedId) || study?.frames[0];
  const sourceImage = motionStudyFrameImage(study, frame), mapping = frame?.mapping;
  const coverageCurrent = coverage?.snapshot === document && coverage.frameId === frame?.id ? coverage : null;
  const coverageReport = coverageCurrent?.report, ownershipCandidate = coverageCurrent?.candidate;
  const viewMode = ["gaps", "ownership"].includes(mode) && !coverageCurrent ? "mapping" : mode;
  const baselineCandidate = ownershipCandidate?.kind === "base-registration";
  const ownershipParts = (coverageReport?.parts || []).filter((item) => baselineCandidate ? item.ownedPixels > 0 || item.addedPixels > 0 : item.addedPixels > 0);
  const ownershipReady = Boolean(ownershipCandidate && ownershipParts.length && (!baselineCandidate || ownershipChecks.$baseline) && ownershipParts.filter((item) => item.addedPixels > 0).every((item) => ownershipChecks[item.partId]) && !coverageReport.unresolvedSignificantPixels);
  const selectedPart = mapping?.parts?.find((item) => item.partId === partId) || mapping?.parts?.find((item) => item.visible);
  const selectedJoint = mapping?.joints?.find((item) => item.id === jointId) || mapping?.joints?.[0];
  const points = selectedPart?.sourcePolygon || [], selectedPoint = points[Math.min(vertex, points.length - 1)];
  const reviewed = sources.filter((item) => item.image && item.review?.approved).length;
  const mapped = (study?.frames || []).filter((item) => item.mappingReview?.approved).length;
  const prepared = Boolean(study?.frames.length && study.frames.every((item) => item.compositionMetrics && item.segments?.length));
  const change = (updater, checkpoint = false) => current.current.onStudyChange(motion.id, updater, { checkpoint });
  const updateFrame = (fields, invalidate = false) => change((value) => patchMotionStudyFrame(value, frame.id, fields, { invalidate }));
  const run = async (label, callback) => {
    if (operationRef.current || disabled) return;
    operationRef.current = true;
    setOperation(label); setError(""); setNotice("");
    try { await callback(); }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { operationRef.current = false; if (alive.current) setOperation(""); }
  };
  const setJobValue = (value) => {
    setJob(value); setJobs((items) => [value, ...items.filter((item) => item.id !== value.id)]);
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    onBusyChange?.(Boolean(operation || active));
    return () => onBusyChange?.(false);
  }, [operation, active, onBusyChange]);
  useEffect(() => {
    const node = panel.current, browser = globalThis.window;
    if (!node || !browser) return;
    const previous = globalThis.document.activeElement;
    const focusable = () => [...node.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')].filter((element) => element.offsetParent !== null);
    focusable()[0]?.focus();
    const keydown = (event) => {
      if (event.key === "Escape" && !operation) { event.preventDefault(); current.current.onClose(); }
      if (event.key !== "Tab") return;
      const elements = focusable(), index = elements.indexOf(globalThis.document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); elements.at(-1)?.focus(); }
      else if (!event.shiftKey && (index < 0 || index === elements.length - 1)) { event.preventDefault(); elements[0]?.focus(); }
    };
    browser.addEventListener("keydown", keydown);
    return () => { browser.removeEventListener("keydown", keydown); previous?.focus?.(); };
  }, [operation]);
  useEffect(() => {
    let cancelled = false;
    loadMotionStudyHistory(document, study || { motionId: motion.id }, client, getMotionStudyFingerprints).then(async ({ jobs: relevant, unavailable }) => {
      if (cancelled) return; setJobs(relevant);
      setHistoryUnavailable(unavailable ? "部分关联生成记录在当前设备不可用或来源不匹配；工程里保留的原画和坐标仍可继续审阅。" : "");
      const latest = relevant.find(isRigJobActive) || relevant[0];
      if (latest) {
        try { const value = await client.get(latest.id); if (!cancelled) setJob(value); }
        catch { if (!cancelled) setHistoryUnavailable("当前设备暂时无法读取这条生成记录；已归档的原画和坐标仍保留。"); }
      }
    }).catch(() => { if (!cancelled) setHistoryUnavailable("当前设备暂时无法读取生成记录；已归档的原画和坐标仍保留。"); });
    return () => { cancelled = true; };
  }, [client, document.id, motion.id, linkedHistoryKey]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false, polling = false;
    const timer = setInterval(async () => {
      if (polling) return; polling = true;
      try { const value = await client.get(job.id); if (!cancelled) setJobValue(value); }
      catch (failure) { if (!cancelled) setError(failure.message); }
      finally { polling = false; }
    }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [client, active, job?.id]);
  useEffect(() => { setVertex(0); }, [frame?.id, selectedPart?.partId]);
  useEffect(() => { setCoverage(null); setOwnershipChecks({}); }, [frame?.id]);
  useEffect(() => { if (coverage && coverage.snapshot !== document) { setCoverage(null); setOwnershipChecks({}); } }, [coverage, document]);

  const createPlan = () => run("建立画面计划", async () => {
    const snapshot = current.current.document, fingerprints = await getMotionStudyFingerprints(snapshot);
    if (!alive.current || current.current.document !== snapshot) throw new Error("草稿已改变，请重新建立计划。");
    const value = motionStudyPlan(snapshot, motion, fingerprints, count);
    change(() => value); setSelectedId(value.frames[0].id); setMode("source");
    setNotice("画面计划已保存到本机草稿。点击生成后才会提交 AI 任务，现有 idle 保持。");
  });
  const start = (kind, frameIds) => run(kind === "motion-frames" ? "提交动作画面" : "提交画面坐标分析", async () => {
    if (active) throw new Error("请等待当前任务结束，或先取消。");
    const snapshot = current.current.document, value = current.current.study;
    await assertMotionStudyCurrent(snapshot, value, getMotionStudyFingerprints);
    if (kind === "pose-mapping" && motionStudySources(value).some((item) => !item.image || !item.review?.approved)) throw new Error("请先逐张确认角色形象、表情、肢体、尺寸和握持。");
    const request = motionStudyRequest(snapshot, value, kind, frameIds), result = await client.start(request);
    if (!alive.current || current.current.document.id !== snapshot.id) return;
    setJobValue(result);
    change((latest) => ({ ...latest, activeJobId: result.id, jobs: [...new Set([...(latest.jobs || []), result.id])] }));
    setNotice("任务来源与计划已冻结。可关闭窗口，稍后从这个动作继续查看候选；任务不会自动覆盖动作。");
  });
  const loadImages = () => run("载入动作画面候选", async () => {
    const snapshot = current.current.document, value = current.current.study;
    const next = await loadMotionStudyImages(snapshot, value, job, client, getMotionStudyFingerprints, imageTools.readRigPartCandidate);
    if (!alive.current || current.current.document !== snapshot) throw new Error("草稿已改变，画面尚未载入。");
    change(() => next); setMode("source");
    const first = images(job).find((item) => !value.frames.find((candidate) => candidate.id === item.frameId)?.reuseBase);
    if (first) setSelectedId(first.frameId);
    setNotice("已载入原始动作画面；请逐张审阅。画布尺寸与 PNG 原字节保持，没有按角色高度缩放。");
  });
  const loadMappings = () => run("载入坐标对应候选", async () => {
    const snapshot = current.current.document, value = current.current.study;
    const next = await loadMotionStudyMappings(snapshot, value, job, getMotionStudyFingerprints);
    if (!alive.current || current.current.document !== snapshot) throw new Error("草稿已改变，坐标尚未载入。");
    change(() => next); setMode("mapping"); setNotice("坐标对应已载入，尚未替换动作。请检查每帧部件轮廓、关节与前后遮挡，再确认。");
  });
  const patchMapping = (updater) => {
    try { const changed = updater(structuredClone(mapping)); delete changed.gapFill;
      const value = validateMotionStudyMapping(changed, document, frame);
      updateFrame({ mapping: value, mappingReview: { approved: false }, segments: undefined, composition: undefined, compositionMetrics: undefined }); setError(""); }
    catch (failure) { setError(failure.message); }
  };
  const moveVertex = (index, x, y) => patchMapping((value) => ({ ...value, parts: value.parts.map((item) => item.partId === selectedPart.partId ? { ...item,
    sourcePolygon: item.sourcePolygon.map((point, i) => i === index ? { x: Math.round(clamp(x, document.width) * 10) / 10, y: Math.round(clamp(y, document.height) * 10) / 10 } : point) } : item) }));
  const inspectCoverage = (kind = "diagnose") => run(kind === "diagnose" ? "检查轮廓缺口" : kind === "base" ? "生成基准轮廓候选" : "推定缺口归属候选", async () => {
    const snapshot = current.current.document, value = current.current.study, frameId = frame.id;
    await assertMotionStudyCurrent(snapshot, value, getMotionStudyFingerprints);
    const result = kind === "diagnose" ? await diagnoseMotionStudyFrame(snapshot, motion.id, frameId, { maxDistance: gapDistance })
      : kind === "base" ? await proposeCalibratedBaseMotionMapping(snapshot, motion.id, frameId)
        : await proposeMotionStudyGapOwnership(snapshot, motion.id, frameId, { maxDistance: gapDistance });
    if (!alive.current || current.current.document !== snapshot) throw new Error("草稿已改变，诊断或归属候选未载入，请重新检查。");
    const candidate = kind === "diagnose" ? null : result, report = candidate ? result.report : result;
    setCoverage({ snapshot, frameId, candidate, report }); setOwnershipChecks({}); setMode(candidate ? "ownership" : "gaps"); setOnlySelected(false);
    const first = report.parts?.find((item) => candidate?.kind === "base-registration" ? item.ownedPixels > 0 : item.addedPixels > 0);
    if (first) setPartId(first.partId);
    setNotice(candidate ? "这里只显示待审阅候选，尚未更改坐标或像素归属。请逐项查看彩色归属与边界并确认；推定结果不是 AI 补绘。" : "红色热图显示尚未归属的原画像素。检查缺口和部件边界后，可显式生成待审阅候选。");
  });
  const acceptOwnership = () => run("接受已审阅归属候选", async () => {
    if (!ownershipReady || !coverageCurrent) throw new Error("请先逐项审阅候选部件，且不能保留未解决的可见像素。");
    const snapshot = current.current.document, candidate = coverageCurrent.candidate;
    const result = await acceptMotionStudyOwnershipCandidate(snapshot, motion.id, frame.id, candidate);
    if (!alive.current || current.current.document !== snapshot) throw new Error("草稿已改变，归属候选尚未接受，请重新检查。");
    change(() => result.document.motionStudies[motion.id], true); setCoverage(null); setOwnershipChecks({}); setMode("mapping");
    setNotice("已接受人工审阅的坐标归属候选，尚未批准本帧坐标或替换动作。请重新确认坐标与遮挡，再检查逐帧拆分与重组。");
  });
  const prepare = () => run("拆分并检查逐帧重组", async () => {
    if (!onPrepare) throw new Error("逐帧部件模块尚未就绪，请保留画面草稿。");
    await onPrepare(motion.id); if (!alive.current) return;
    setMode("overlay"); setNotice("已从各动作原画拆出独立可见区域并测量重组。隐藏表面尚未补绘；这是逐帧部件动作，连续补间未验收。");
  });
  const apply = () => run("应用选定动作并构建预览", async () => {
    if (!onApply) throw new Error("逐帧动作编译模块尚未就绪，请保留草稿。");
    await onApply(motion.id); if (alive.current) current.current.onClose();
  });
  const checked = Object.keys(motionFrameChecks).every((key) => frame?.review?.checks?.[key]);
  const metrics = frame?.compositionMetrics;
  const referenceOnly = study?.playback === "reference";
  return <div className="rig-motion-study-backdrop"><section className="rig-motion-study" role="dialog" aria-modal="true" aria-label={`动作画面重制 · ${motion.name}`} ref={panel}>
    <header className="motion-study-header"><div><h2>动作画面重制 · {motion.name}</h2><p>共享基准 + 3–4 张新画面 → 原画审阅 → 网格与部件对应 → 逐帧部件动作</p></div><button className="button" disabled={Boolean(operation)} onClick={onClose}>关闭动作画面重制</button></header>
    {error && <p className="motion-study-alert" role="alert">{error}</p>}{notice && <p className="motion-study-notice" role="status">{notice}</p>}
    <div className="motion-study-body">
      <main className="motion-study-main">
        {!study ? <div className="motion-study-empty"><h3>{motion.id === "idle" ? "现有 idle 已保护" : "先建立动作画面计划"}</h3><p>沿用当前立绘和像素画布。画面候选不会覆盖角色、idle 或其他动作。</p><label>新画面数量<select aria-label="动作新画面数量" disabled={locked || motion.id === "idle"} value={count} onChange={(event) => setCount(Number(event.target.value))}><option value="3">3 张新图 + 共享基准</option><option value="4">4 张新图 + 共享基准</option></select></label><button className="button primary" disabled={locked || motion.id === "idle" || !document.sourceImage} onClick={createPlan}>建立画面计划</button></div> : <>
          <div className="motion-study-frame-strip" aria-label="动作关键画面">{study.frames.map((item) => <button key={item.id} className={frame?.id === item.id ? "selected" : ""} disabled={Boolean(operation)} onClick={() => setSelectedId(item.id)} aria-pressed={frame?.id === item.id}>
            {motionStudyFrameImage(study, item) ? <img src={motionStudyFrameImage(study, item)} alt={`${item.label} 原画`} /> : <span>待生成</span>}<strong>{item.label}</strong><small>{item.time.toFixed(2)}s · {item.imageRef ? "复用基准" : item.review?.approved ? "原画已审阅" : item.image ? "待审阅" : "待生成"}</small>
          </button>)}</div>
          <div className="motion-study-view-tools"><select aria-label="动作画面对照视图" value={viewMode} onChange={(event) => setMode(event.target.value)}><option value="source">AI 源画面 / 共享基准</option><option value="mapping" disabled={!mapping}>网格与坐标对应</option><option value="gaps" disabled={!coverageReport}>未归属像素热图</option><option value="ownership" disabled={!coverageReport}>彩色部件归属候选</option><option value="overlay" disabled={!frame?.composition}>原画 / 独立区域重组叠加</option><option value="composition" disabled={!frame?.composition}>独立可见区域重组</option></select>
            {mapping && <><button className="button subtle" onClick={() => setFocus(!focus)}>{focus ? "显示整张动作画面" : "查看所选部件细节"}</button><label><input type="checkbox" checked={onlySelected} onChange={(event) => setOnlySelected(event.target.checked)} />仅所选轮廓</label></>}
            {mode === "overlay" && <label>重组透明度<input aria-label="动作重组叠加透明度" type="range" min="0" max="1" step="0.05" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} /></label>}
          </div>
          <MotionStudyCanvas image={sourceImage} composition={frame?.composition} width={document.width} height={document.height} mapping={mapping} coverage={coverageReport} candidate={ownershipCandidate} mode={viewMode} opacity={opacity} selectedPart={selectedPart?.partId} vertex={vertex} focus={focus} onlySelected={onlySelected} disabled={locked || frame?.imageRef} onSelectPart={setPartId} onSelectVertex={setVertex} onMoveVertex={moveVertex} />
          <p className="motion-study-canvas-caption">{document.width} × {document.height} 固定像素画布 · {viewMode === "gaps" ? "红色：未归属源像素；只作诊断，未改变原画" : viewMode === "ownership" ? "彩色：部件像素归属；橙框：所选部件推定新增范围；候选须人工审阅" : viewMode === "source" ? "完整源画面，仅作为拆分与动作依据" : "坐标均以此帧原画左上角为原点"} · 现有 idle 保持</p>
        </>}
      </main>
      <aside className="motion-study-controls">
        {study && <>
          <section className="rig-control-group"><h3>动作画面的用途</h3><label className="rig-field">播放方式<select aria-label="动作画面用途" disabled={locked} value={referenceOnly ? "reference" : "stepped-parts"} onChange={(event) => { const value = event.target.value; change((study) => setMotionStudyPlayback(study, value), true); setCoverage(null); setNotice(value === "reference" ? "已保留原画、坐标与审阅作为关键姿势参考。当前动作改用连续骨骼与网格；原画切片可重新检查生成。" : "已切回逐帧部件制作，请重新检查拆分并明确应用。"); }}><option value="reference">关键姿势参考 · 连续骨骼动画</option><option value="stepped-parts">原画切片 · 逐帧附件切换</option></select></label><p className="rig-hint">参考画面用于姿势与节奏设计。动作的平移、旋转、缩放及变形在骨架关键帧中编辑。</p></section>
          <section className="rig-control-group"><h3>1 · 动作原画</h3><p className="rig-hint">{sources.filter((item) => !item.reuseBase).length} 张新图{motion.id === "run" ? "；跑步循环回到首张跑姿，不穿插站姿" : motion.id === "death" ? " + 共享基准；末尾保持死亡终态" : " + 起终共享基准"}。倒地画面保持同一画布和人物尺度。</p><label className="rig-field">整组画面要求<textarea aria-label="动作画面整体说明" maxLength={4000} rows={3} disabled={locked} value={study.prompt || ""} onChange={(event) => change((value) => ({ ...value, prompt: event.target.value }))} /></label><div className="button-row"><button className="button primary" disabled={locked} onClick={() => start("motion-frames", sources.filter((item) => !item.reuseBase).map((item) => item.id))}>生成全部新画面</button><button className="button" disabled={locked || !repairFrameIds.length} onClick={() => start("motion-frames", repairFrameIds)}>生成缺失或已拒绝画面</button></div><p className="rig-hint">最多 3 张并发；补生成只处理没有图片或已明确拒绝的画面，已有待审阅图片与已确认画面保留。</p></section>
          {frame && <section className="rig-control-group"><h3>{frame.label} · {frame.time.toFixed(2)}s</h3><label className="rig-field">画面名称<input aria-label="当前动作画面名称" maxLength={120} disabled={locked || Boolean(frame.imageRef)} value={frame.label} onChange={(event) => updateFrame({ label: event.target.value })} /></label><label className="rig-field">画面时间（秒）<input aria-label="当前动作画面时间" type="number" min="0" max={motion.duration} step="0.01" disabled={locked || Boolean(frame.imageRef) || frame.reuseBase} value={frame.time} onChange={(event) => { const time = Number(event.target.value); if (!Number.isFinite(time) || time < 0 || time >= motion.duration || study.frames.some((item) => item.id !== frame.id && Math.abs(item.time - time) < .0001)) { setError("画面时间应在动作范围内，且不能与其他帧重复。"); return; } updateFrame({ time }); }} /></label><label className="rig-field">这张画面的要求<textarea aria-label="当前动作画面说明" maxLength={4000} rows={3} disabled={locked || frame.reuseBase || Boolean(frame.imageRef)} value={frame.prompt || ""} onChange={(event) => updateFrame({ prompt: event.target.value })} /></label>
            {!frame.reuseBase && !frame.imageRef && <button className="button" disabled={locked} onClick={() => start("motion-frames", [frame.id])}>{frame.image ? "重新生成所选画面" : "生成所选画面"}</button>}
            {sourceImage && <><p className="rig-hint">{frame.origin === "base" ? "共享现有基准原图，没有重新生图。" : "AI 原画候选，尚未作为部件或动作应用。"}</p>{Object.entries(motionFrameChecks).map(([key, label]) => <label className="rig-check" key={key}><input type="checkbox" aria-label={`动作画面审阅 ${label}`} checked={Boolean(frame.review?.checks?.[key])} disabled={locked || frame.reuseBase} onChange={(event) => updateFrame({ review: { ...frame.review, approved: false, checks: { ...frame.review?.checks, [key]: event.target.checked } } })} />{label}</label>)}
              <label className="rig-field">审阅备注<textarea aria-label="动作画面审阅备注" maxLength={1000} rows={2} disabled={locked || frame.reuseBase} value={frame.review?.note || ""} onChange={(event) => updateFrame({ review: { ...frame.review, note: event.target.value } })} /></label>
              {!frame.reuseBase && <div className="button-row"><button className="button primary" disabled={locked || !checked} onClick={() => updateFrame({ review: { ...frame.review, approved: true, rejected: false } })}>确认此画面</button><button className="button danger" disabled={locked} onClick={() => updateFrame({ review: { ...frame.review, approved: false, rejected: true } }, true)}>拒绝此画面</button></div>}
              <p className={frame.review?.approved ? "rig-ready-note" : "rig-pending-note"}>{frame.review?.approved ? "原画已审阅" : frame.review?.rejected ? "已拒绝，请调整要求后重新生成这一张。" : "完成五项审阅后确认，尚未替换动作。"}</p>
            </>}
          </section>}
          <section className="rig-control-group"><h3>2 · 网格与坐标对应</h3><p className="rig-hint">源画面审阅 {reviewed} / {sources.length}。分析每帧关节、可见部件轮廓和遮挡，沿用原逻辑部件编号。</p><button className="button" disabled={locked || reviewed !== sources.length} onClick={() => start("pose-mapping")}>分析已审阅画面的坐标</button>
            {mapping && <><label className="rig-field">对应部件<select aria-label="动作坐标对应部件" value={selectedPart?.partId || ""} onChange={(event) => setPartId(event.target.value)}>{mapping.parts.map((item) => <option key={item.partId} value={item.partId}>{document.parts.find((part) => part.id === item.partId)?.label || item.partId}{item.visible ? "" : " · 遮挡不可见"}</option>)}</select></label>
              {selectedPart && <><label className="rig-check"><input aria-label="动作部件在本帧可见" type="checkbox" checked={selectedPart.visible} disabled={locked || frame.imageRef} onChange={(event) => patchMapping((value) => ({ ...value, parts: value.parts.map((item) => {
                if (item.partId !== selectedPart.partId) return item;
                if (!event.target.checked || item.sourcePolygon?.length) return { ...item, visible: event.target.checked };
                const original = document.parts.find((part) => part.id === item.partId), joint = value.joints.find((joint) => joint.id === original.bone), w = Math.min(original.width, document.width), h = Math.min(original.height, document.height);
                const x = clamp(joint.x - w / 2, document.width - w), y = clamp(joint.y - h / 2, document.height - h);
                return { ...item, visible: true, sourcePolygon: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] };
              }) }))} />本帧可见</label><label className="rig-field">前后层级<input aria-label="动作部件遮挡层级" type="number" step="1" disabled={locked || frame.imageRef} value={selectedPart.z} onChange={(event) => { const z = Number(event.target.value); if (Number.isFinite(z)) patchMapping((value) => ({ ...value, parts: value.parts.map((item) => item.partId === selectedPart.partId ? { ...item, z } : item) })); }} /></label></>}
              {selectedPoint && <><label className="rig-field">轮廓顶点<select aria-label="动作轮廓顶点" value={Math.min(vertex, points.length - 1)} onChange={(event) => setVertex(Number(event.target.value))}>{points.map((point, index) => <option key={index} value={index}>点 {index + 1}</option>)}</select></label><div className="rig-field-grid">{["x", "y"].map((axis) => <label className="rig-number-field" key={axis}>{axis.toUpperCase()}<input aria-label={`动作轮廓顶点 ${axis.toUpperCase()}`} type="number" step="0.1" min="0" max={axis === "x" ? document.width : document.height} disabled={locked || frame.imageRef} value={selectedPoint[axis]} onChange={(event) => { const number = Number(event.target.value); if (Number.isFinite(number)) moveVertex(Math.min(vertex, points.length - 1), axis === "x" ? number : selectedPoint.x, axis === "y" ? number : selectedPoint.y); }} /></label>)}</div></>}
              <div className="motion-study-coverage"><h4>轮廓缺口与像素归属</h4><p className="rig-hint">先检查尚未归属的原画像素。缺口候选只推定未归属像素到邻近非表情物理部件，保留已有归属；需要逐项人工审阅，不能代替隐藏面补绘。</p>
                {frame.imageRef ? <><p className="rig-hint">本帧复用源画面；请在源帧修正，重复终帧会同步。</p><button className="button subtle" disabled={locked} onClick={() => setSelectedId(frame.imageRef)}>转到复用的源帧</button></> : <>
                  <button className="button" disabled={locked || !frame.review?.approved} onClick={() => inspectCoverage()}>检查轮廓缺口</button>
                  {frame.sourceFingerprint === study.baseFingerprint && document.registration && document.parts.some((part) => part.sourcePolygon?.length) && <button className="button" disabled={locked || !frame.review?.approved} onClick={() => inspectCoverage("base")}>复用已校准基准轮廓</button>}
                  {coverageReport && <><div className="motion-study-gap-metrics" role="status"><p>未归属像素 {coverageReport.missingPixels ?? 0} · 有效可见 {coverageReport.missingSignificantPixels ?? 0} · 弱透明 {coverageReport.weakMissingPixels ?? 0}</p><p>有效可见缺口占比 {(Number(coverageReport.significantGapRatio || 0) * 100).toFixed(2)}% · 候选上限 15%</p><p>缺口范围 {boundsText(coverageReport.missingBounds)}</p>{ownershipCandidate && <><p>候选新增 {coverageReport.addedPixels ?? 0} · 尚未解决的可见像素 {coverageReport.unresolvedSignificantPixels ?? 0}</p>{coverageReport.addedPixels > 0 && <p>实际最远推定距离 {Number(coverageReport.maxDistance || 0).toFixed(2)}px · 最大允许 {ownershipCandidate.mapping?.gapFill?.maxDistance ?? coverageReport.maxAllowedDistance ?? 64}px</p>}</>}</div>
                    <label className="rig-field">最大推定距离（像素）<input aria-label="缺口归属最大距离" type="number" min="1" max="64" step="1" disabled={locked || Boolean(ownershipCandidate)} value={gapDistance} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 64) setGapDistance(value); }} /></label>
                    <button className="button" disabled={locked || !coverageReport.missingPixels} onClick={() => inspectCoverage("gap")}>生成缺口归属候选</button>
                    {ownershipCandidate && <><p className="rig-pending-note">{ownershipCandidate.kind === "base-registration" ? "整套基准轮廓与原遮挡层级候选" : `邻近边界推定候选 · 最远 ${coverageReport.maxDistance ?? gapDistance}px`}，尚未接受。点击部件查看叠加与范围，再逐项确认。</p><div className="motion-study-owner-parts">{ownershipParts.map((item) => {
                      const label = document.parts.find((part) => part.id === item.partId)?.label || item.partId;
                      return <div key={item.partId} className={selectedPart?.partId === item.partId ? "selected" : ""}><button type="button" className="motion-study-owner-select" disabled={locked} onClick={() => { setPartId(item.partId); setMode("ownership"); setFocus(true); setOnlySelected(true); }}><strong>{label}</strong><small>原有 {item.ownedPixels ?? 0} · 新增 {item.addedPixels ?? 0}px</small><small>{boundsText(item.addedBounds || item.bounds)}</small></button>{item.addedPixels > 0 && <label className="rig-check"><input type="checkbox" aria-label={`审阅推定归属 ${label}`} disabled={locked} checked={Boolean(ownershipChecks[item.partId])} onChange={(event) => setOwnershipChecks((current) => ({ ...current, [item.partId]: event.target.checked }))} />已核对新增像素的边界与归属</label>}</div>;
                    })}</div>{baselineCandidate && <label className="rig-check"><input type="checkbox" aria-label="已核对整套基准轮廓与层级" disabled={locked} checked={Boolean(ownershipChecks.$baseline)} onChange={(event) => setOwnershipChecks((current) => ({ ...current, $baseline: event.target.checked }))} />已核对整套基准轮廓与层级</label>}<div className="button-row"><button className="button primary" disabled={locked || !ownershipReady} onClick={acceptOwnership}>接受已审阅归属候选</button><button className="button subtle" disabled={locked} onClick={() => { setCoverage(null); setOwnershipChecks({}); setMode("mapping"); }}>放弃此归属候选</button></div></>}
                  </>}
                </>}
              </div>
              <p className="rig-hint">关节 {mapping.joints.length} · 可见区域 {mapping.parts.filter((item) => item.visible).length}。可拖动绿色轮廓顶点；修改后需重新确认。</p><button className="button" disabled={locked || !frame.review?.approved || Boolean(ownershipCandidate)} onClick={() => updateFrame({ mappingReview: { approved: true } })}>{frame.mappingReview?.approved ? "此帧坐标已确认" : "确认此帧坐标与遮挡"}</button>
              <label className="rig-field">关节坐标<select aria-label="动作对应关节" value={selectedJoint?.id || ""} onChange={(event) => setJointId(event.target.value)}>{mapping.joints.map((joint) => <option key={joint.id} value={joint.id}>{document.joints.find((item) => item.id === joint.id)?.label || joint.id}</option>)}</select></label>
              {selectedJoint && <div className="rig-field-grid">{["x", "y"].map((axis) => <label className="rig-number-field" key={axis}>{axis.toUpperCase()}<input aria-label={`动作关节坐标 ${axis.toUpperCase()}`} type="number" step="0.1" min="0" max={axis === "x" ? document.width : document.height} disabled={locked || frame.imageRef} value={selectedJoint[axis]} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) patchMapping((mapping) => ({ ...mapping, joints: mapping.joints.map((joint) => joint.id === selectedJoint.id ? { ...joint, [axis]: clamp(value, axis === "x" ? document.width : document.height) } : joint) })); }} /></label>)}</div>}
            </>}
          </section>
          <section className="rig-control-group"><h3>3 · 原画可见像素拆分</h3><p className="rig-hint">每帧拆成多个独立区域，并以真实 PNG 重组对照原画。仅有可见像素；遮挡面没有标成 AI 补绘，不宣称完整隐藏面或连续补间。</p><button className="button" disabled={locked || referenceOnly || Boolean(ownershipCandidate) || !onPrepare || !study.frames.every((item) => item.review?.approved && item.mapping)} onClick={prepare}>检查逐帧拆分与重组</button>
            {metrics && <div className="rig-test-report"><strong>本帧源像素重组</strong><p>独立可见区域 {metrics.visiblePartCount ?? frame.segments?.length} · Alpha IoU {Number(metrics.alphaIoU).toFixed(6)}</p><p>像素平均误差 {Number(metrics.pixelMAE).toPrecision(4)} · 最大通道误差 {metrics.maxChannelError}</p><p>缺失 / 多出像素 {metrics.missingAlphaPixels} / {metrics.extraAlphaPixels}</p><p>来源：原画可见像素。隐藏表面：未补绘。</p></div>}
          </section>
          <section className="rig-control-group"><h3>4 · 应用选定动作</h3><p className="rig-hint">坐标审阅 {mapped} / {study.frames.length}。仅替换「{motion.name}」，idle 和其他动作保持。预览使用真实 Spine 附件切换，画面之间采用逐帧切换。</p><button className="button primary" disabled={locked || referenceOnly || Boolean(ownershipCandidate) || !onApply || !prepared || mapped !== study.frames.length} onClick={apply}>应用选定动作并查看 Spine 预览</button>{study.applied && <p className="rig-ready-note">此动作已应用为逐帧独立部件动作；请继续预览并导出、回导验收。</p>}</section>
        </>}
        <section className="rig-control-group motion-study-jobs"><h3>画面与坐标任务</h3>{historyUnavailable && <p className="rig-hint" role="status">{historyUnavailable}</p>}<div className="rig-job-history">{jobs.map((item) => <button key={item.id} className={item.id === job?.id ? "selected" : ""} disabled={Boolean(operation)} onClick={() => run("读取任务", async () => { const value = await client.get(item.id); if (alive.current) setJobValue(value); })}>{item.kind === "motion-frames" ? "动作画面" : "坐标对应"}<small>{statusLabels[item.status] || item.status}</small></button>)}</div>
          {job && <><p className="rig-hint">{job.kind === "motion-frames" ? "动作画面" : "坐标对应"} · {statusLabels[job.status] || job.status} · {job.completed || 0} / {job.total || 1}<br />{job.provider?.label || job.provider?.id || (typeof job.provider === "string" ? job.provider : "Codex 账号")}</p>{job.error && <p className="motion-study-error">{job.error}</p>}
            {job.kind === "motion-frames" && !active && !sources.some((frame) => !frame.reuseBase && frame.image) && <button className="button" disabled={Boolean(operation)} onClick={() => run("从任务恢复画面计划", async () => { const snapshot = current.current.document, value = await restoreMotionStudyPlan(snapshot, motion, job, getMotionStudyFingerprints); if (!alive.current || current.current.document !== snapshot) throw new Error("草稿已改变，计划尚未恢复。"); change(() => value); setSelectedId(value.frames[0].id); setNotice("已从任务冻结快照恢复画面名称、时间和完整提示词。没有重新提交 AI；现在可以载入已有画面。"); })}>从此任务恢复画面计划</button>}
            {job.parentJobId && <button className="button subtle" disabled={Boolean(operation)} onClick={() => run("读取原任务成功结果", async () => { const value = await client.get(job.parentJobId); if (alive.current) setJobValue(value); })}>查看原任务成功结果</button>}
            {active && <button className="button" disabled={Boolean(operation)} onClick={() => run("取消任务", async () => { const value = await client.cancel(job.id); if (alive.current) setJobValue(value); })}>取消动作画面任务</button>}
            {job.kind === "motion-frames" && images(job).length > 0 && <button className="button" disabled={locked || !study} onClick={loadImages}>载入已生成画面</button>}
            {job.kind === "pose-mapping" && ["completed", "failed", "cancelled"].includes(job.status) && (job.result?.mappings || job.mappings || []).length > 0 && <button className="button" disabled={locked || !study} onClick={loadMappings}>载入坐标对应</button>}
            {job.kind === "pose-mapping" && ["failed", "cancelled"].includes(job.status) && (job.frames?.length || job.total || 0) > (job.result?.mappings || job.mappings || []).length && <button className="button" disabled={locked || !study} onClick={() => run("继续未完成坐标", async () => { await assertMotionStudyJob(current.current.document, current.current.study, job, getMotionStudyFingerprints); const value = await client.retry(job.id, { concurrency: 3 }); if (alive.current) { setJobValue(value); change((study) => ({ ...study, activeJobId: value.id, jobs: [...new Set([...(study.jobs || []), value.id])] })); } })}>继续未完成坐标</button>}
          </>}{!jobs.length && <p className="rig-hint">{sources.some((frame) => frame.image) ? "原画与坐标已保存在工程中，可继续本地审阅；当前设备没有可用的历史任务。" : "当前没有可用的画面任务记录；可以从现有计划继续制作。"}</p>}
        </section>
      </aside>
    </div>
    <footer className="motion-study-footer"><span>{operation ? `${operation}…` : active ? "AI 任务在后台运行；关闭窗口后仍可回来查看。" : "画面计划与审阅状态自动保存在骨架草稿。"}</span><span>{referenceOnly ? "关键姿势参考 · 使用骨骼与网格动画" : "动作图逐帧部件 · 隐藏补绘未完成 · 连续补间未验收"}</span></footer>
  </section></div>;
}

function MotionStudyCanvas({ image, composition, width, height, mapping, coverage, candidate, mode, opacity, selectedPart, vertex, focus, onlySelected, disabled, onSelectPart, onSelectVertex, onMoveVertex }) {
  const drag = useRef(null), reviewMapping = candidate?.mapping || mapping, selected = reviewMapping?.parts.find((item) => item.partId === selectedPart), points = selected?.sourcePolygon || [];
  const ownership = coverage?.parts?.find((item) => item.partId === selectedPart), gapBounds = ownership?.addedBounds || ownership?.bounds;
  const coverageMode = ["gaps", "ownership"].includes(mode);
  let view = { x: 0, y: 0, width, height };
  const focusPoints = mode === "ownership" && gapBounds ? [...points, { x: gapBounds.x, y: gapBounds.y }, { x: gapBounds.x + gapBounds.width, y: gapBounds.y + gapBounds.height }] : points;
  if (focus && focusPoints.length) {
    const x = Math.max(0, Math.min(...focusPoints.map((point) => point.x)) - 24), y = Math.max(0, Math.min(...focusPoints.map((point) => point.y)) - 24);
    view = { x, y, width: Math.min(width, Math.max(...focusPoints.map((point) => point.x)) + 24) - x, height: Math.min(height, Math.max(...focusPoints.map((point) => point.y)) + 24) - y };
  }
  const unit = Math.min(view.width, view.height), showMapping = mapping && mode === "mapping", step = focus ? 32 : 128;
  const position = (event) => { const svg = event.currentTarget.ownerSVGElement, matrix = svg.getScreenCTM(); if (!matrix) return null; const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY; return point.matrixTransform(matrix.inverse()); };
  return <div className="motion-study-canvas">{image ? <svg viewBox={`${view.x} ${view.y} ${Math.max(1, view.width)} ${Math.max(1, view.height)}`} role="img" aria-label="动作画面网格对照">
    <defs><pattern id="motion-study-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#75628c" strokeWidth="0.6" opacity="0.35" /></pattern></defs>
    {mode !== "composition" && <image href={image} width={width} height={height} />}
    {composition && ["overlay", "composition"].includes(mode) && <image href={composition} width={width} height={height} opacity={mode === "overlay" ? opacity : 1} />}
    {mode === "gaps" && coverage?.missingHeatmap && <image href={coverage.missingHeatmap} width={width} height={height} opacity="0.85" />}
    {mode === "ownership" && <>
      {(!onlySelected || !ownership?.ownerOverlay && !(candidate && ownership?.addedOverlay)) && (candidate ? coverage?.candidateOwnerOverlay : coverage?.ownerOverlay) && <image href={candidate ? coverage.candidateOwnerOverlay : coverage.ownerOverlay} width={width} height={height} opacity="0.65" />}
      {onlySelected && ownership?.ownerOverlay && <image href={ownership.ownerOverlay} width={width} height={height} opacity="0.45" />}
      {onlySelected && candidate && ownership?.addedOverlay && <image href={ownership.addedOverlay} width={width} height={height} opacity="0.95" />}
      {gapBounds && <rect x={gapBounds.x} y={gapBounds.y} width={gapBounds.width} height={gapBounds.height} fill="none" stroke="#ed9b26" strokeWidth={unit * .004} strokeDasharray={`${unit * .016} ${unit * .008}`} />}
    </>}
    {coverageMode && <>
      <rect x={view.x} y={view.y} width={view.width} height={view.height} fill="url(#motion-study-grid)" />
      {Array.from({ length: Math.ceil(view.width / step) + 1 }, (_, index) => Math.ceil(view.x / step) * step + index * step).filter((x) => x <= view.x + view.width).map((x) => <text key={`cx${x}`} x={x + unit * .01} y={view.y + unit * .045} fontSize={unit * .025} fill="#68527e">{x}</text>)}
      {Array.from({ length: Math.ceil(view.height / step) + 1 }, (_, index) => Math.ceil(view.y / step) * step + index * step).filter((y) => y <= view.y + view.height).map((y) => <text key={`cy${y}`} x={view.x + unit * .01} y={y + unit * .03} fontSize={unit * .025} fill="#68527e">{y}</text>)}
      {reviewMapping?.parts.filter((item) => item.visible && item.sourcePolygon?.length && (!onlySelected || item.partId === selectedPart)).map((item) => <polygon key={`coverage-${item.partId}`} points={item.sourcePolygon.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={item.partId === selectedPart ? "#0a9b7b" : "#9c8bc4"} strokeWidth={unit * .003} onClick={() => onSelectPart(item.partId)} />)}
      {mode === "gaps" && coverage?.missingBounds && <rect {...coverage.missingBounds} fill="none" stroke="#e5465e" strokeWidth={unit * .004} />}
    </>}
    {showMapping && <><rect x={view.x} y={view.y} width={view.width} height={view.height} fill="url(#motion-study-grid)" />
      {Array.from({ length: Math.ceil(view.width / step) + 1 }, (_, index) => Math.ceil(view.x / step) * step + index * step).filter((x) => x <= view.x + view.width).map((x) => <text key={`x${x}`} x={x + unit * .01} y={view.y + unit * .045} fontSize={unit * .025} fill="#68527e">{x}</text>)}
      {Array.from({ length: Math.ceil(view.height / step) + 1 }, (_, index) => Math.ceil(view.y / step) * step + index * step).filter((y) => y <= view.y + view.height).map((y) => <text key={`y${y}`} x={view.x + unit * .01} y={y + unit * .03} fontSize={unit * .025} fill="#68527e">{y}</text>)}
      {mapping.parts.filter((item) => item.visible && item.sourcePolygon?.length && (!onlySelected || item.partId === selectedPart)).map((item) => <polygon key={item.partId} points={item.sourcePolygon.map((point) => `${point.x},${point.y}`).join(" ")} fill={item.partId === selectedPart ? "#29c99b1c" : "#876fe70a"} stroke={item.partId === selectedPart ? "#09a67c" : "#9c8bc4"} strokeWidth={unit * .004} onClick={() => onSelectPart(item.partId)} />)}
      {!onlySelected && mapping.joints.map((joint) => <g key={joint.id}><circle cx={joint.x} cy={joint.y} r={unit * .006} fill="#7855cf" /><text x={joint.x + unit * .009} y={joint.y} fontSize={unit * .014} fill="#563b83">{joint.id}</text></g>)}
      {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={unit * (index === vertex ? .009 : .006)} fill={index === vertex ? "#f1ad4e" : "#0aab83"} stroke="#fff" strokeWidth={unit * .002} role="button" tabIndex={disabled ? -1 : 0} aria-label={`动作轮廓控制点 ${index + 1}`} onPointerDown={(event) => { if (disabled) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = index; onSelectVertex(index); }} onPointerMove={(event) => { if (disabled || drag.current !== index) return; const next = position(event); if (next) onMoveVertex(index, next.x, next.y); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={(event) => { if (disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); const delta = event.shiftKey ? 10 : 1; onSelectVertex(index); onMoveVertex(index, point.x + (event.key === "ArrowRight" ? delta : event.key === "ArrowLeft" ? -delta : 0), point.y + (event.key === "ArrowDown" ? delta : event.key === "ArrowUp" ? -delta : 0)); }} />)}
    </>}
  </svg> : <div className="motion-study-empty"><strong>此画面尚未生成</strong><p>生成完成后载入候选，审阅原画再分析网格坐标。</p></div>}</div>;
}

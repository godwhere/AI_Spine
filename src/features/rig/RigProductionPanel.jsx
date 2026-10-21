import { useEffect, useState } from "react";
import { productionBriefFields, productionChecks, productionFingerprint, productionReviewCurrent, productionStageIssues, productionBoardImage } from "../../../shared/domain/production.mjs";

export function ProductionReview({ document, stage, id, disabled, onConfirm, onRevoke }) {
  const fingerprint = productionFingerprint(document, stage, id), approved = productionReviewCurrent(document, stage, id);
  const [checks, setChecks] = useState([]);
  useEffect(() => setChecks([]), [fingerprint]);
  const issues = productionStageIssues(document, stage, id);
  return <div className="production-review" aria-label={`${stage}${id ? ` ${id}` : ""}审阅`}>
    <p className={approved && !issues.length ? "rig-ready-note" : "rig-pending-note"}>{approved ? issues.length ? "本项记录保留，前置内容需要重新确认。" : "当前内容已确认" : "待审阅当前内容"}</p>
    {issues.length > 0 && <p className="rig-hint">{issues[0]}</p>}
    {productionChecks[stage].map((text) => <label className="rig-check" key={text}><input type="checkbox" aria-label={`${stage}${id ? ` ${id}` : ""}：${text}`} disabled={disabled || approved} checked={approved || checks.includes(text)} onChange={(e) => setChecks(e.target.checked ? [...checks, text] : checks.filter((v) => v !== text))} />{text}</label>)}
    <div className="button-row"><button className="button primary" disabled={disabled || approved || issues.length > 0 || checks.length !== productionChecks[stage].length} onClick={() => onConfirm(stage, id, checks)}>{approved ? "已确认当前内容" : "确认当前内容"}</button>
      {approved && <button className="button" disabled={disabled} onClick={() => onRevoke(stage, id)}>退回修改</button>}</div>
  </div>;
}

function Candidate({ job, client, onApply, disabled }) {
  const [url, setURL] = useState(""), [error, setError] = useState("");
  const image = (job?.result?.images || job?.images || [])[0];
  useEffect(() => {
    let cancelled = false, objectURL;
    setURL(""); setError("");
    if (job?.status === "completed" && image) client.image(job.id, image).then((bytes) => {
      if (cancelled) return;
      objectURL = URL.createObjectURL(new Blob([bytes], { type: "image/png" })); setURL(objectURL);
    }).catch((error) => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; if (objectURL) URL.revokeObjectURL(objectURL); };
  }, [client, job?.id, job?.status, image?.id]);
  if (!job) return null;
  return <div className="production-candidate"><p>候选 · {({ queued: "排队中", generating: "生成中", completed: "已完成", failed: "失败", cancelled: "已取消" })[job.status] || job.status}</p>
    {job?.referenceTarget && image && <p className="rig-hint">原生 {image.width} × {image.height} · 选择后按设定图的物理尺寸校准，图片不会自动拉伸。</p>}
    {url && <img src={url} alt="尚未应用的完整画面候选" />}{(error || job.error) && <p role="alert">{error || job.error}</p>}
    {url && <button className="button" disabled={disabled} onClick={() => onApply(job)}>选择此候选</button>}</div>;
}

export function RigProductionPanel({ document, view, disabled, jobs, job, client, running, onCancel, onEnable, onUpdate, onUploadSource, onGenerateAppearance, onApplyAppearance,
  onUploadBoard, onGenerateBoard, onApplyBoard, onAdjustBoard, onConfirm, onRevoke, onStep, createId }) {
  const p = document.production;
  if (!p) return <section className="production-panel"><h2>按计划制作角色</h2><p>先确定脚本、固定约束和视觉目标，再拆件、绑定与制作动画。启用后保留现有图片、骨架、动作和历史；确认记录从当前内容开始。</p><button className="button primary" disabled={disabled} onClick={onEnable}>为当前草稿启用制作计划</button></section>;
  const patch = (value) => onUpdate({ ...p, ...value });
  const patchMotion = (id, fields) => {
    const before = p.motions.find((m) => m.id === id);
    const boards = fields.duration !== undefined ? p.boards.map((b) => b.motionId === id ? { ...b, time: Math.round(b.time / before.duration * fields.duration * 1000) / 1000 } : b) : p.boards;
    patch({ motions: p.motions.map((m) => m.id === id ? { ...m, ...fields } : m), boards });
  };
  const patchBoard = (id, fields) => patch({ boards: p.boards.map((b) => b.id === id ? { ...b, ...fields } : b) });
  const addBoard = (motion) => patch({ boards: [...p.boards, { id: `board-${createId()}`, motionId: motion.id, label: "新的关键姿势", time: motion.duration / 2, prompt: "描述这个时间点的完整姿势、表情和接触。", reuseBase: false }] });
  const addMotion = () => {
    const id = `action-${createId()}`;
    patch({ motions: [...p.motions, { id, name: "新动作", duration: 1, loop: false, script: "", expression: "", contacts: "", ending: "" }],
      boards: [...p.boards, { id: `board-${createId()}`, motionId: id, label: "主姿势", time: .5, prompt: "", reuseBase: false }] });
  };
  return <section className="production-panel" aria-label={view === "plan" ? "制作计划与约束" : "角色造型与分镜"}>
    <div className="production-intro"><div><h2>{view === "plan" ? "先确定制作计划" : "确认造型与动作画面"}</h2><p>{view === "plan" ? "把角色、动作、固定规则和交付要求写清楚。计划确认后才能开始生成。" : "逐张确认实际画面。姿势图用于指导后续连续骨骼动画，不直接作为整图动画交付。"}</p></div>
      <button className="button" disabled={disabled} onClick={onUploadSource}>{document.sourceImage ? "更换身份参考 / 设定图" : "导入身份参考"}</button></div>
    {running && <div className="production-running" role="status">当前任务正在进行，已有图片和候选保留。<button className="button danger" onClick={onCancel}>取消当前生成</button></div>}
    {view === "plan" ? <div className="production-columns"><div>
      <section className="production-card"><h3>角色与固定约束</h3><fieldset disabled={disabled}>{productionBriefFields.map(([key, label, hint]) => <label className="rig-field" key={key}>{label}<textarea aria-label={`制作计划：${label}`} rows={3} maxLength={1200} value={p.brief[key] || ""} placeholder={hint} onChange={(e) => patch({ brief: { ...p.brief, [key]: e.target.value } })} /></label>)}</fieldset></section>
      <section className="production-card"><h3>动作脚本与范围</h3><p className="rig-hint">这里定义要做什么。修改计划不会自动覆盖已经制作的骨架动作。</p><fieldset disabled={disabled}>{p.motions.map((m) => <article className="production-motion" key={m.id}>
        <div className="production-motion-heading"><strong>{m.name} · {m.id}</strong><button className="button subtle" onClick={() => patch({ motions: p.motions.filter((v) => v.id !== m.id), boards: p.boards.filter((b) => b.motionId !== m.id) })}>移除动作计划</button></div>
        <div className="rig-field-grid"><label className="rig-field">名称<input aria-label={`计划 ${m.id} 名称`} value={m.name} maxLength={100} onChange={(e) => patchMotion(m.id, { name: e.target.value })} /></label>
          <label className="rig-field">时长（秒）<input type="number" min="0.1" max="30" step="0.1" aria-label={`计划 ${m.id} 时长`} value={m.duration} onChange={(e) => { const value = Number(e.target.value); if (value >= .1 && value <= 30) patchMotion(m.id, { duration: value }); }} /></label></div>
        <label className="rig-check"><input type="checkbox" aria-label={`计划 ${m.id} 循环`} checked={m.loop} onChange={(e) => patchMotion(m.id, { loop: e.target.checked })} />循环动作</label>
        {[["script", "动作分镜脚本"], ["expression", "表情与视线"], ["contacts", "接触与握持阶段"], ["ending", "收尾或终态"]].map(([key, label]) => <label className="rig-field" key={key}>{label}<textarea aria-label={`计划 ${m.id} ${label}`} rows={key === "script" ? 4 : 2} maxLength={1200} value={m[key] || ""} onChange={(e) => patchMotion(m.id, { [key]: e.target.value })} /></label>)}
      </article>)}<button className="button" disabled={p.motions.length >= 16} onClick={addMotion}>添加动作计划</button></fieldset></section>
    </div><aside className="production-card production-summary"><h3>确认计划后进入下一步</h3><ol><li>计划与固定约束</li><li>完整设定图与动作分镜</li><li>结构、拆件与完整补绘</li><li>绑定、主动作与细节</li><li>视觉检查、下载与实际回导</li></ol>
      <ProductionReview document={document} stage="brief" disabled={disabled} onConfirm={onConfirm} onRevoke={onRevoke} /><button className="button" disabled={!productionReviewCurrent(document, "brief")} onClick={() => onStep("targets")}>进入造型与分镜</button>
      <p className="rig-hint">确认绑定当前内容。后续修改会显示需要重新审阅的阶段；旧图片和历史不会被清空。</p></aside></div>
      : <div className="production-visuals"><section className="production-card production-setup"><div><h3>完整设定图</h3>{document.sourceImage ? <img className="production-art" src={document.sourceImage} alt="待确认的完整设定图" /> : <p>先导入身份参考，再生成完整 Q 版形象。</p>}</div>
        <div><p>检查脸型、头身比、朝向、服装和武器。确认这张图后，再制作动作关键画面。</p><button className="button" disabled={disabled || productionStageIssues(document, "appearance").length > 0} onClick={onGenerateAppearance}>按计划生成设定候选</button>
          {job?.kind === "appearance" && !job.referenceTarget && <Candidate job={job} client={client} disabled={disabled} onApply={onApplyAppearance} />}
          <ProductionReview document={document} stage="appearance" disabled={disabled} onConfirm={onConfirm} onRevoke={onRevoke} /></div></section>
        {p.motions.map((m) => <section className="production-card" key={m.id}><div className="production-motion-heading"><h3>{m.name} · 关键姿势</h3><button className="button" disabled={disabled || p.boards.length >= 64} onClick={() => addBoard(m)}>添加关键姿势</button></div><p>{m.script}</p>
          <div className="production-board-grid">{p.boards.filter((b) => b.motionId === m.id).map((b) => {
            const pending = jobs.find((j) => j.id === b.pending?.jobId), art = productionBoardImage(document, b);
            return <article className="production-board" key={b.id}><fieldset disabled={disabled}>
              <div className="rig-field-grid"><label className="rig-field">画面名称<input aria-label={`分镜 ${b.id} 名称`} value={b.label} maxLength={100} onChange={(e) => patchBoard(b.id, { label: e.target.value })} /></label><label className="rig-field">时间（秒）<input type="number" min="0" max={m.duration} step="0.01" aria-label={`分镜 ${b.id} 时间`} value={b.time} onChange={(e) => { const time = Number(e.target.value); if (time >= 0 && time <= m.duration) patchBoard(b.id, { time }); }} /></label></div>
              <label className="rig-field">姿势、表情和接触<textarea rows={3} maxLength={1200} aria-label={`分镜 ${b.id} 描述`} value={b.prompt} onChange={(e) => patchBoard(b.id, { prompt: e.target.value })} /></label>
              <label className="rig-check"><input type="checkbox" aria-label={`分镜 ${b.id} 复用设定图`} checked={b.reuseBase} onChange={(e) => patchBoard(b.id, { reuseBase: e.target.checked })} />复用设定图</label>
              {!b.reuseBase && <><p className="rig-hint">使用与设定图相同的 {document.width} × {document.height} 画布和镜头，保持头部及武器的物理尺寸。</p><div className="button-row"><label className="button production-upload">上传关键图<input type="file" aria-label={`上传分镜 ${b.id}`} accept="image/png,image/jpeg,image/webp" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) onUploadBoard(b.id, file); }} /></label><button className="button" disabled={!b.prompt.trim() || productionStageIssues(document, "board").length > 0} onClick={() => onGenerateBoard(b.id)}>生成此关键图</button></div></>}
            </fieldset>{art ? <img className="production-art" src={art} alt={`${b.label} · 当前参考画面`} /> : <p className="production-empty">尚未选择画面</p>}
              <Candidate job={pending} client={client} disabled={disabled} onApply={onApplyBoard} />
              {b.calibration && <p className="rig-hint">已等比校准到设定画布；原生 PNG 与校准记录随工程保留。</p>}
              {b.image && !b.reuseBase && <button className="button" disabled={disabled} onClick={() => onAdjustBoard(b.id)}>调整关键图 {b.label}</button>}
              <ProductionReview document={document} stage="board" id={b.id} disabled={disabled} onConfirm={onConfirm} onRevoke={onRevoke} />
              <button className="button subtle" disabled={disabled} onClick={() => patch({ boards: p.boards.filter((v) => v.id !== b.id) })}>移除此分镜</button>
            </article>;
          })}</div></section>)}
        <div className="production-card"><p>{productionStageIssues(document, "targets")[0] || "造型与关键画面已确认，可以规划结构和拆件。"}</p><button className="button primary" disabled={productionStageIssues(document, "targets").length > 0} onClick={() => onStep("structure")}>进入结构与关节</button></div>
      </div>}
  </section>;
}

export function ProductionDelivery({ document, disabled, onExport, onVerify }) {
  const snapshot = productionFingerprint(document, "delivery"), issues = productionStageIssues(document, "export");
  return <section className="rig-control-group"><h3>下载并回导验收包</h3><p className="rig-hint">正式保存前，先下载两个包，再上传实际文件核对骨架、贴图和作者数据。此处不会向资源库加入中间角色。</p>{issues[0] && <p className="rig-pending-note">{issues[0]}</p>}
    {[['runtime', '运行时'], ['project', '可编辑']].map(([kind, label]) => <div className="production-package" key={kind}><strong>{label}包</strong><p className={document.production.delivery?.[kind]?.snapshot === snapshot ? "rig-ready-note" : "rig-pending-note"}>{document.production.delivery?.[kind]?.snapshot === snapshot ? "实际回导比对通过" : "待下载与回导"}</p><div className="button-row"><button className="button" disabled={disabled || issues.length > 0} onClick={() => onExport(kind)}>下载{label}验收包</button><label className={`button production-upload${disabled || issues.length ? " is-disabled" : ""}`}>回导{label}包<input type="file" aria-label={`回导${label}验收包`} accept=".zip" disabled={disabled || issues.length > 0} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) onVerify(kind, file); }} /></label></div></div>)}
    <p className="rig-hint">官方 Spine Editor 与目标引擎验收需另行进行。</p>
  </section>;
}

export function ProductionMotionTargets({ document, motion, disabled, onSeek, onOpenTargets }) {
  const boards = document.production.boards.filter((b) => b.motionId === motion.id);
  return <section className="rig-control-group"><h3>{motion.name} · 已定视觉目标</h3><p className="rig-hint">对照当前连续动画检查姿势与表情；头部、肢体和武器沿用设定图的物理尺寸。</p>
    <div className="production-motion-targets">{boards.map((b) => <div key={b.id}>{productionBoardImage(document, b) && <img src={productionBoardImage(document, b)} alt={`${b.label} · 动画对照目标`} />}<button className="button subtle" disabled={disabled} onClick={() => onSeek(b.time)}>{b.label} · {b.time.toFixed(2)} 秒</button></div>)}</div>
    <button className="button" disabled={disabled} onClick={onOpenTargets}>查看脚本与画面审阅</button></section>;
}

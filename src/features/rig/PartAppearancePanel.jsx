import { useMemo } from "react";
import { rigPartAppearanceView } from "../../application/rig-view.js";

const number = (value) => Number(value.toFixed(1)).toString();
const seconds = (value) => `${Number(value.toFixed(3))}s`;
const timeRange = (range) => range.terminalOnly ? `${seconds(range.start)}${range.terminalHold ? " 起保持" : " 终帧"}` : `${seconds(range.start)}–${seconds(range.end)}`;
function displayRanges(motion) {
  if (motion.error) return [];
  const ranges = []; let cursor = 0;
  for (const interval of motion.intervals) {
    if (interval.start > cursor) ranges.push({ start: cursor, end: interval.start, hidden: true });
    ranges.push(interval); cursor = interval.end;
  }
  if (cursor < motion.duration || !ranges.length) ranges.push({ start: cursor, end: motion.duration, hidden: true });
  else if (!motion.terminalVisible) ranges.push({ start: motion.duration, end: motion.duration, hidden: true, terminalOnly: true });
  return ranges;
}

export function PartAppearancePanel({ document, partId, onSelectPart, onSeek, disabled = false }) {
  const state = useMemo(() => rigPartAppearanceView(document, partId), [document, partId]);
  const value = state.annotation;
  return <section className="part-appearance-panel rig-control-group" aria-label="部件出现时间与位置">
    <h3>出现时间与位置</h3>
    {document?.parts?.length > 0 && <label className="part-appearance-selector">选择部件<select aria-label="部件出现规则选择器" value={partId || ""} disabled={disabled || !onSelectPart} onChange={(event) => onSelectPart?.(event.target.value)}>
      {!partId && <option value="">选择一个部件…</option>}{document.parts.map((part) => <option key={part.id} value={part.id}>{typeof part.label === "string" ? part.label : part.id}</option>)}
    </select></label>}
    {state.error && <p role="alert" className="part-appearance-error">{state.error}</p>}
    {!state.error && !value && <p>选择一个部件，查看显示时间和位置。</p>}
    {value && <>
      <p className="part-appearance-hint">32 px 网格，X 向右、Y 向下。列表显示区间起点的中心位置；区间内位置随动作变化。</p>
      <div className="part-appearance-motions">
        {value.motions.map((motion) => <section className="part-appearance-motion" key={motion.motionId} aria-label={`${motion.name}的部件时空标注`}>
          {motion.issues.length > 0 && <ul className="part-appearance-issues" role="alert">{motion.issues.map((issue, index) => <li key={index}>{motion.name}：{issue}</li>)}</ul>}
          <ol className="part-appearance-ranges">
            {displayRanges(motion).map((interval, index) => {
              const center = interval.startPosition?.center, outside = center && (center.x < 0 || center.y < 0 || center.x >= value.source.canvas.width || center.y >= value.source.canvas.height);
              return <li className="part-appearance-row" key={`${interval.start}-${index}`}>
                <span className="part-appearance-time">{motion.name} · {timeRange(interval)}{motion.loop ? " · 循环" : ""}</span>
                <span aria-hidden="true"> → </span>
                {interval.hidden ? <strong className="part-appearance-hidden">隐藏</strong> : <span className="part-appearance-position"><strong>第{Math.floor(center.x / 32) + 1}列 · 第{Math.floor(center.y / 32) + 1}行</strong><small>X {number(center.x)} · Y {number(center.y)}{outside ? " · 画布外" : ""}{motion.baseReplaced ? " · 动作图区域" : ""}</small></span>}
                <div className="part-appearance-seek">
                  <button type="button" className="button subtle" disabled={disabled || !onSeek || interval.seekUnavailable} aria-label={`定位 ${motion.name} ${value.label} ${seconds(interval.start)}`} onClick={() => onSeek?.(motion.motionId, interval.start)}>在网格中定位</button>
                  {!interval.hidden && !interval.terminalOnly && <button type="button" className="button subtle" disabled={disabled || !onSeek || interval.seekUnavailable} aria-label={`定位 ${motion.name} ${value.label} ${seconds(interval.end)}${interval.endInclusive ? "" : "切换前"}`} onClick={() => onSeek?.(motion.motionId, interval.endPosition.time)}>终点</button>}
                </div>
              </li>;
            })}
          </ol>
        </section>)}
      </div>
      {!value.motions.length && <p>基准 → X {number(value.source.rect.x + value.source.rect.width / 2)} · Y {number(value.source.rect.y + value.source.rect.height / 2)}（尚无动作）</p>}
      <details className="part-appearance-details"><summary>详细信息</summary>
        <dl className="part-appearance-source">
          <dt>部件</dt><dd>{value.label}</dd><dt>来源画布</dt><dd>{value.source.canvas.width} × {value.source.canvas.height} px</dd>
          <dt>基准矩形</dt><dd>({number(value.source.rect.x)}, {number(value.source.rect.y)}) · {number(value.source.rect.width)} × {number(value.source.rect.height)} px</dd>
          <dt>绑定骨骼</dt><dd>{value.source.bone.label || value.source.bone.id} · {value.source.binding === "mesh" ? "加权网格" : "刚性"}</dd>
          <dt>默认显示</dt><dd>{value.source.defaultVisible ? "显示" : "隐藏"}{value.source.attachmentGroup ? ` · 显示组 ${value.source.attachmentGroup} 每次只显示一个附件` : " · 普通独立层"}</dd>
          <dt>基准层级</dt><dd>第 {value.source.layer.index + 1} / {value.source.layer.total} 槽 · Z {value.source.layer.z}</dd>
        </dl>
        <ul>{value.motions.map((motion) => <li key={motion.motionId}>{motion.name}：{motion.baseReplaced ? "动作图区域替代原部件，脚锁与连续握持未评估" : "连续骨骼与网格"}；层级 {motion.layerChanges.map((change) => `${seconds(change.time)} 第${change.index + 1}/${change.total}层`).join(" → ") || "无显示区间"}</li>)}</ul>
        <p className="part-appearance-hint">坐标由实际骨骼与网格外框计算，可能包含透明边距；不代表美术或动作验收已通过。</p>
      </details>
    </>}
  </section>;
}

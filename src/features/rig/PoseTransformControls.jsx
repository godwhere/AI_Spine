import { useState } from "react";
import { rigPoseOrderView } from "../../application/rig-view.js";

export function PoseTransformControls({ document, motion, pose, joint, onChange }) {
  const [selected, setSelected] = useState("");
  const [uniform, setUniform] = useState(true);
  if (!joint || !pose) return null;
  const { root, slots, order } = rigPoseOrderView(document, motion, pose);
  const selectedId = order.includes(selected) ? selected : order[0], index = order.indexOf(selectedId);
  const changeAxis = (field, axis, value) => {
    if (!Number.isFinite(value) || field === "scales" && value <= 0) return;
    const fallback = field === "scales" ? { x: 1, y: 1 } : { x: 0, y: 0 };
    onChange({ [field]: { ...(pose[field] || {}), [joint.id]: { ...fallback, ...pose[field]?.[joint.id], [axis]: value, ...(field === "scales" && uniform ? { x: value, y: value } : {}) } } });
  };
  const move = (direction) => {
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= order.length) return;
    const next = [...order]; [next[index], next[destination]] = [next[destination], next[index]];
    onChange({ drawOrder: next });
  };
  return <section className="rig-control-group">
    <h3>局部变换 · {joint.label || joint.id}</h3>
    {joint.id !== root && <div className="rig-field-grid">{["x", "y"].map((axis) => <label className="rig-number-field" key={axis}>局部位移 {axis.toUpperCase()}<input aria-label={`骨骼局部位移 ${axis.toUpperCase()}`} type="number" step="0.1" value={pose.translations?.[joint.id]?.[axis] ?? 0} onChange={(event) => changeAxis("translations", axis, Number(event.target.value))} /></label>)}</div>}
    <div className="rig-field-grid">{["x", "y"].map((axis) => <label className="rig-number-field" key={axis}>缩放 {axis.toUpperCase()}<input aria-label={`骨骼局部缩放 ${axis.toUpperCase()}`} type="number" min="0.001" max="100" step="0.01" value={pose.scales?.[joint.id]?.[axis] ?? 1} onChange={(event) => changeAxis("scales", axis, Number(event.target.value))} /></label>)}</div>
    <label className="rig-check"><input aria-label="骨骼保持等比缩放" type="checkbox" checked={uniform} onChange={(event) => setUniform(event.target.checked)} />保持等比缩放</label>
    <p className="rig-hint">位移沿父骨骼的局部坐标；缩放 1 为原尺寸。锁脚或双手握持的骨链需要等比缩放。</p>
    <h3>本帧前后顺序</h3>
    <label className="rig-field">部件<select aria-label="关键帧排序部件" value={selectedId || ""} onChange={(event) => setSelected(event.target.value)}>{order.map((id) => { const part = slots.find(([slot]) => slot === id)?.[1]; return <option key={id} value={id}>{part?.attachmentGroup || part?.label || id}</option>; })}</select></label>
    <div className="button-row"><button className="button" disabled={index <= 0} onClick={() => move(-1)}>向后一层</button><button className="button" disabled={index < 0 || index >= order.length - 1} onClick={() => move(1)}>向前一层</button><button className="button subtle" disabled={!pose.drawOrder} onClick={() => onChange({ drawOrder: undefined })}>沿用前帧顺序</button></div>
    <p className="rig-hint">前后顺序在此关键帧切换；位置、旋转和缩放在关键帧之间连续变化。</p>
  </section>;
}

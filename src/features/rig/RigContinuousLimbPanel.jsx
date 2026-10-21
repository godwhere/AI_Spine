import { useState } from "react";

export function RigContinuousLimbPanel({ document, motion, locked, onApply }) {
  const [upperId, setUpperId] = useState(""), [lowerId, setLowerId] = useState("");
  const parts = document.parts.filter((part) => part.image && part.completion === "ready" && part.role !== "effect" && part.composition?.kind !== "continuous-limb");
  const upper = parts.find((part) => part.id === upperId);
  const lowerParts = parts.filter((part) => document.joints.find((joint) => joint.id === part.bone)?.parent === upper?.bone);
  const applied = document.parts.filter((part) => part.composition?.kind === "continuous-limb" && part.composition.motionId === motion.id);
  return <section className="rig-control-group" aria-label="连续肢体接头">
    <h3>连续肢体接头</h3>
    <p className="rig-hint">把相邻两段的现有图片按原坐标连接成一片网格，消除弯曲时的拼接断口。只在当前动作使用，原分件、其他动作和特效保留；可撤销。</p>
    <fieldset disabled={locked}>
      <label className="rig-field">上段部件<select aria-label="连续网格上段部件" value={upperId} onChange={(event) => { setUpperId(event.target.value); setLowerId(""); }}><option value="">选择上段部件</option>{parts.map((part) => <option key={part.id} value={part.id}>{part.label}</option>)}</select></label>
      <label className="rig-field">下段部件<select aria-label="连续网格下段部件" value={lowerId} onChange={(event) => setLowerId(event.target.value)}><option value="">选择相邻下段部件</option>{lowerParts.map((part) => <option key={part.id} value={part.id}>{part.label}</option>)}</select></label>
      <button className="button" disabled={!upperId || !lowerId} onClick={() => void onApply({ upperId, lowerId })}>制作本动作连续网格</button>
    </fieldset>
    {applied.length > 0 && <p className="rig-ready-note">本动作已制作 {applied.length} 个连续接头 · 来源为现有部件合成，未新增补绘。</p>}
  </section>;
}

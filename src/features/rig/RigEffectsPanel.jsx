import { useEffect, useState } from "react";
import { NumberField } from "./RigControls.jsx";

export function RigEffectsPanel({ document, motion, locked, onApply, onRemove, onSeek }) {
  const initial = () => motion.magicEffects?.options || { chargeBone: "rightHand", releaseBone: "leftHand", chargeX: -35, chargeY: -295,
    releaseX: 20, releaseY: 0, chargeStart: .15, releaseTime: Math.min(.95, motion.duration * .5), endTime: Math.min(1.65, motion.duration), intensity: .9, fps: 30, blend: "normal" };
  const [options, setOptions] = useState(initial);
  useEffect(() => setOptions(initial()), [motion.id, motion.magicEffects]);
  const patch = (key, value) => setOptions((before) => ({ ...before, [key]: value }));
  const parts = document.parts.filter((part) => part.role === "effect" && part.effect?.motionId === motion.id);
  const previews = ["charge", "release"].map((kind) => parts.filter((part) => part.effect.kind === kind)
    .sort((a, b) => Math.abs(a.effect.time - options.releaseTime) - Math.abs(b.effect.time - options.releaseTime))[0]);
  return <section className="rig-control-group rig-effects-panel" aria-label="魔法特效制作">
    <h3>蓄力与释放特效</h3>
    <p className="rig-hint">蓝金星辉汇聚到杖头，再从施法手向前释放。独立特效层跟随实际骨骼，保留身体关键帧，并随 Spine 包导出。</p>
    <fieldset disabled={locked}>
      {[['chargeStart', '特效蓄力开始（秒）'], ['releaseTime', '特效释放时刻（秒）'], ['endTime', '特效消散结束（秒）']].map(([key, label]) =>
        <NumberField key={key} label={label} value={options[key]} min={0} max={motion.duration} step={.01} onChange={(value) => patch(key, value)} />)}
      <NumberField label="特效强度" value={options.intensity} min={.1} max={1.5} step={.05} onChange={(value) => patch("intensity", value)} />
      {[["charge", "蓄力"], ["release", "释放"]].map(([kind, label]) => <div key={kind}>
        <label className="rig-field">{label}跟随<select aria-label={`${label}跟随骨骼`} value={options[kind + "Bone"]} onChange={(event) => patch(kind + "Bone", event.target.value)}>
          {document.joints.map((joint) => <option key={joint.id} value={joint.id}>{joint.label || joint.id}</option>)}
        </select></label>
        <div className="rig-field-grid">{["X", "Y"].map((axis) => <NumberField key={axis} label={`${label}偏移 ${axis}`} value={options[kind + axis]} min={-document.width} max={document.width} step={1} onChange={(value) => patch(kind + axis, value)} />)}</div>
      </div>)}
      <label className="rig-field">特效帧率<select aria-label="特效帧率" value={options.fps} onChange={(event) => patch("fps", Number(event.target.value))}><option value={30}>30 帧 / 秒</option><option value={24}>24 帧 / 秒</option></select></label>
      <label className="rig-field">特效叠加<select aria-label="特效叠加方式" value={options.blend} onChange={(event) => patch("blend", event.target.value)}><option value="normal">普通透明叠加</option><option value="additive">发光叠加</option></select></label>
      <button className="button primary" onClick={() => void onApply(options)}>{parts.length ? "更新本动作特效" : "制作蓄力与释放特效"}</button>
      {parts.length > 0 && <button className="button danger" onClick={() => void onRemove()}>移除本动作特效</button>}
    </fieldset>
    {parts.length > 0 && <>
      <p className="rig-ready-note">2 个特效层 · {parts.length} 个透明纹理帧 · {motion.magicEffects?.options.fps} 帧 / 秒</p>
      <p className="rig-hint">由软件生成的魔法纹理序列。身体保持连续骨骼动画，特效纹理数量不计为身体部件。</p>
      <div className="rig-effects-previews">{previews.map((part, index) => part && <div key={part.id}><img src={part.image} alt={index ? "释放魔法效果纹理" : "蓄力魔法效果纹理"} /><button className="button" disabled={locked} onClick={() => onSeek(part.effect.time)}>{index ? "查看释放" : "查看蓄力"}</button></div>)}</div>
    </>}
  </section>;
}

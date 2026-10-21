import { useState, useEffect } from "react";
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function RegistrationMetrics({ metrics }) {
  if (!metrics) return null;
  const after = metrics.after || metrics, before = metrics.before;
  const number = (value, digits = 3) => !Number.isFinite(value) ? "—" : value === 0 ? "0" : Math.abs(value) < 0.001 ? value.toExponential(2) : value.toFixed(digits);
  return <div className="rig-registration-metrics"><strong>实际像素对比</strong><dl>
    <div><dt>透明轮廓 IoU</dt><dd>{before ? `${number(before.alphaIoU, 6)} → ` : ""}{number(after.alphaIoU, 6)}</dd></div>
    <div><dt>像素平均误差</dt><dd>{before ? `${number(before.pixelMAE)} → ` : ""}{number(after.pixelMAE)}</dd></div>
    <div><dt>最大 Alpha 误差</dt><dd>{number(after.maxAlphaError, 0)}</dd></div>
    <div><dt>最大预乘颜色误差</dt><dd>{number(after.maxPremultipliedColorError)}</dd></div>
    <div><dt>缺失 / 多余像素</dt><dd>{after.missingAlphaPixels ?? "—"} / {after.extraAlphaPixels ?? "—"}</dd></div>
    <div><dt>原图回补像素</dt><dd>{metrics.fallbackPixels ?? "—"}</dd></div>
    <div><dt>AI 隐藏补绘像素</dt><dd>{metrics.hiddenPixels ?? "—"}</dd></div>
  </dl><p>IoU 越接近 1、误差越接近 0，组装越接近原图。这里显示实际计算结果。</p></div>;
}

export function NumberField({ label, value, onChange, min, max, step = 1, disabled = false }) {
  const [text, setText] = useState(String(value ?? 0));
  useEffect(() => { setText(String(value ?? 0)); }, [value]);
  return <label className="rig-number-field"><span>{label}</span><input type="number" aria-label={label} min={min} max={max} step={step} disabled={disabled} value={text}
    onChange={(event) => { setText(event.target.value); if (event.target.value.trim() && Number.isFinite(Number(event.target.value))) onChange(clamp(Number(event.target.value), min ?? -Infinity, max ?? Infinity)); }}
    onBlur={() => { if (!text.trim() || !Number.isFinite(Number(text))) setText(String(value ?? 0)); }} /></label>;
}

export function GripControls({ document, part, disabled, onBind }) {
  const recognized = document.joints.filter((joint) => /hand|wrist/i.test(joint.id) || /手|腕/.test(joint.label || ""));
  const hands = (recognized.length ? recognized : document.joints.filter((joint) => joint.parent)).slice();
  for (const id of [part.grip?.primaryHand, part.grip?.secondaryHand]) {
    const existing = document.joints.find((joint) => joint.id === id);
    if (existing && !hands.some((joint) => joint.id === id)) hands.push(existing);
  }
  const projectedGrip = (id, ratio) => {
    const hand = document.joints.find((joint) => joint.id === id);
    return hand ? { x: clamp(hand.x - part.x, 0, part.width), y: clamp(hand.y - part.y, 0, part.height) }
      : { x: Math.round(part.width * ratio), y: Math.round(part.height * 0.5) };
  };
  const [primary, setPrimary] = useState(""), [secondary, setSecondary] = useState("");
  const [grip, setGrip] = useState({ x: 0, y: 0 }), [secondGrip, setSecondGrip] = useState({ x: 0, y: 0 });
  useEffect(() => {
    let ancestor = document.joints.find((joint) => joint.id === part.bone);
    const visited = new Set();
    while (ancestor && !hands.some((joint) => joint.id === ancestor.id) && !visited.has(ancestor.id)) { visited.add(ancestor.id); ancestor = document.joints.find((joint) => joint.id === ancestor.parent); }
    const handId = part.grip?.primaryHand || ancestor?.id || hands.find((joint) => /right/i.test(joint.id) || /右/.test(joint.label || ""))?.id || hands[0]?.id || "";
    setPrimary(handId);
    setSecondary(part.grip?.secondaryHand || "");
    setGrip(part.grip?.primaryLocalPoint || projectedGrip(handId, 0.3));
    setSecondGrip(part.grip?.secondaryLocalPoint || projectedGrip(part.grip?.secondaryHand, 0.7));
  }, [part.id, part.bone, part.x, part.y, part.width, part.height, document.joints, part.grip?.primaryHand, part.grip?.secondaryHand, part.grip?.primaryLocalPoint?.x, part.grip?.primaryLocalPoint?.y, part.grip?.secondaryLocalPoint?.x, part.grip?.secondaryLocalPoint?.y]);
  return <section className="rig-control-group"><h3>握持与武器</h3><p className="rig-hint">握点以部件图片左上角为原点。副手会通过双骨 IK 跟随第二握点。</p>
    <label className="rig-field">主手<select aria-label="主握持手" value={primary} disabled={disabled} onChange={(event) => { const id = event.target.value; setPrimary(id); setGrip(part.grip?.primaryHand === id ? part.grip.primaryLocalPoint : projectedGrip(id, 0.3)); if (id === secondary) setSecondary(""); }}>{hands.map((joint) => <option key={joint.id} value={joint.id}>{joint.label || joint.id}</option>)}</select></label>
    <div className="rig-field-grid"><NumberField label="主握点 X" value={grip.x} min={0} max={part.width} onChange={(x) => setGrip({ ...grip, x })} disabled={disabled} /><NumberField label="主握点 Y" value={grip.y} min={0} max={part.height} onChange={(y) => setGrip({ ...grip, y })} disabled={disabled} /></div>
    <label className="rig-field">副手<select aria-label="副握持手" value={secondary} disabled={disabled} onChange={(event) => { const id = event.target.value; setSecondary(id); setSecondGrip(part.grip?.secondaryHand === id ? part.grip.secondaryLocalPoint : projectedGrip(id, 0.7)); }}><option value="">单手握持</option>{hands.filter((joint) => joint.id !== primary).map((joint) => <option key={joint.id} value={joint.id}>{joint.label || joint.id}</option>)}</select></label>
    {secondary && <div className="rig-field-grid"><NumberField label="副握点 X" value={secondGrip.x} min={0} max={part.width} onChange={(x) => setSecondGrip({ ...secondGrip, x })} disabled={disabled} /><NumberField label="副握点 Y" value={secondGrip.y} min={0} max={part.height} onChange={(y) => setSecondGrip({ ...secondGrip, y })} disabled={disabled} /></div>}
    <button className="button" disabled={disabled || !primary} onClick={() => onBind({ hand: primary, grip, ...(secondary ? { secondaryHand: secondary, secondaryGrip: secondGrip } : {}) })}>应用握点绑定</button>
  </section>;
}

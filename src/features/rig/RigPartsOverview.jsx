
// Reads the active session; commands retain document and history ownership.
export function RigPartsOverview({ locked, document, setCompleteOverlapOpen }) {
  return <section className="rig-control-group"><h2>完整重叠部件</h2><p className="rig-hint">查看完整脸底、接头与隐藏表面。逐件审阅独立图片和可见轮廓，再检查重叠组装；保留可撤销的对齐候选。</p><button className="button primary" disabled={locked || !document.parts.length} onClick={() => setCompleteOverlapOpen(true)}>审阅完整重叠部件</button></section>;
}

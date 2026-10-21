
// Reads the active session; commands retain document and history ownership.
export function RigMotionStart({ document, commit, basicMotionSlots, setMotionId }) {
  return <section className="rig-control-group"><p className="rig-hint">从左侧添加自定义动作，或建立待机、攻击、受击的待制作动作槽；此操作保留关节、部件和手工权重。</p><button className="button" disabled={!document.joints.length} onClick={() => { commit({ ...document, motions: basicMotionSlots() }); setMotionId("idle"); }}>添加 idle / attack / hit 动作槽</button></section>;
}

export function CreationWorkflow({ hasAppearance, replaced, total, animations, active, onStep, disabled, authored = false, rigSummary }) {
  const steps = [
    ["角色形象", hasAppearance ? "已有形象参考" : "生成或导入形象"],
    [authored ? "角色部件" : "模板部件", authored ? rigSummary ? `${rigSummary.baseParts} 个基础部件${rigSummary.poseRegions ? ` · ${rigSummary.poseRegions} 个动作区域` : ""}` : `${total} 个纹理区域` : `已替换 ${replaced} / ${total}`],
    ["校准与预览", `检查部件与 ${animations} 个动作`],
    ["导出资源", "运行时包 / 可编辑工程"],
  ];
  return <nav className="creation-workflow" aria-label="角色创作流程">
    <ol>{steps.map(([label, detail], index) => <li key={label}>
      <button type="button" disabled={disabled} aria-current={active === index ? "step" : undefined} onClick={() => onStep(index)}>
        <span className="workflow-number">{index + 1}</span><span><strong>{label}</strong><small>{detail}</small></span>
      </button>
    </li>)}</ol>
  </nav>;
}

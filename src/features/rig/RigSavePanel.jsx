import { Save } from "lucide-react";
import { productionStageIssues } from "../../../shared/domain/production.mjs";
// Reads the active session; commands retain document and history ownership.
export function RigSavePanel({ saveHint, readiness, document, saveResource }) {
  const issues = productionStageIssues(document, "save");
  return <section className="rig-control-group"><h2>{saveHint ? "另存为新的角色资源" : "保存为正常角色资源"}</h2><p>{readiness.completed} / {readiness.total} 个纹理区域已有独立透明图片</p><p className="rig-hint">{document.production ? "当前计划、画面、绑定和动画需完成审阅；两个验收包实际回导通过后才保存到资源库。" : "全部部件补全并检查动作后，保存到资源库，继续使用普通校准、预览与 Spine / Unity 导出。"}</p>{!readiness.ready && <p className="rig-pending-note">待完成：{readiness.pending.map((item) => item.label || item.id).join("、") || "尚未创建部件"}</p>}{issues[0] && <p className="rig-pending-note">{issues[0]}</p>}<button className="button primary" disabled={!readiness.ready || !document.motions.length || issues.length > 0} onClick={() => void saveResource()}><Save size={15} />{saveHint ? "另存为新资源" : "保存为角色资源"}</button></section>;
}

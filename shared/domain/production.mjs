import { sha256 } from "../codec/sha256.mjs";

export const productionBriefFields = [
  ["identity", "身份与服装", "保留的脸型、发型、服装轮廓和配色"],
  ["style", "画风与比例", "头身比、线条、上色和细节密度"],
  ["camera", "朝向与尺寸基准", "朝向、画布、地面、镜头和物理尺寸基准"],
  ["equipment", "武器与持握", "主手、副手、握点以及何时松手"],
  ["rules", "固定约束", "尺寸、接触、遮挡和禁止变化的内容"],
  ["parts", "分层与补绘策略", "独立活动部件、隐藏面及需要的角度变体"],
  ["delivery", "用途与交付", "实际显示尺寸、动作范围、目标运行库和文件格式"],
];
export const productionChecks = {
  brief: ["范围与脚本明确", "固定约束完整", "交付标准明确"],
  appearance: ["角色身份与服装", "画风比例与朝向", "全身尺寸与持握"],
  board: ["角色身份", "表情与动作意图", "肢体和服装", "物理尺寸与镜头", "握持与地面接触"],
  structure: ["关节与部件覆盖目标动作", "角度及表情变体完整", "前后遮挡合理"],
  assembly: ["可见原画与完整隐藏面", "无邻件污染与重复五官", "实际组装轮廓与比例"],
  binding: ["极限姿势无断裂穿插", "握点与接触约束正确", "权重和遮挡合理"],
  motion: ["主动作与节奏", "表情与关键图一致", "接触与握持", "循环或终态"],
};
const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
const idOK = (v) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(v);
const hash = (value) => sha256(JSON.stringify(value, (_key, v) => plain(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));
const imageCache = new WeakMap();
function imageHash(owner, field = "image") {
  if (!owner?.[field]) return null;
  const old = imageCache.get(owner);
  if (old?.[field]?.value === owner[field]) return old[field].hash;
  const digest = sha256(owner[field]);
  imageCache.set(owner, { ...old, [field]: { value: owner[field], hash: digest } });
  return digest;
}
const motionSpecs = [
  { id: "idle", name: "待机", duration: 2.4, loop: true, script: "自然呼吸、轻微重心变化，发丝和衣摆延迟随动；首尾连续。", expression: "平静表情，中间自然眨眼。", contacts: "支撑脚保持接触，武器稳定握持。", ending: "回到起始姿势并连续循环。" },
  { id: "attack", name: "攻击", duration: 1.4, loop: false, script: "明确准备、蓄力、释放、跟随和收势，主动作在关闭特效时仍然可读。", expression: "目光集中于目标，释放时表情明确。", contacts: "根据重心和步法安排接触阶段；持握不断开。", ending: "收势后可衔接待机。" },
  { id: "death", name: "死亡", duration: 1.8, loop: false, script: "先有疼痛反应，再失去支撑并倒地；发丝衣摆随后稳定。", expression: "疼痛、失力并闭眼，不保留微笑。", contacts: "明确脚部何时失去支撑、身体落地以及武器是否松手。", ending: "保持已确认的倒地终态，不恢复站立。" },
];
export function createProductionPlan(document = {}) {
  const motions = document.motions?.length ? document.motions.map((m) => ({ ...motionSpecs.find((v) => v.id === m.id), id: m.id, name: m.name, duration: m.duration, loop: m.loop,
    script: m.description || "请描述准备、主动作、跟随和收尾。", expression: "请明确表情与视线。", contacts: "请明确支撑与握持阶段。", ending: m.loop ? "首尾连续循环。" : "请明确最后的姿势与保持。" })) : structuredClone(motionSpecs);
  return { version: 1, brief: Object.fromEntries(productionBriefFields.map(([key]) => [key, ""])), motions,
    boards: motions.map((m, index) => ({ id: `${m.id.slice(0, 80)}-target-${index}`, motionId: m.id, time: m.id === "idle" ? 0 : m.id === "attack" ? Math.round(m.duration * .4 * 1000) / 1000 : m.duration,
      label: m.id === "idle" ? "待机基准" : m.id === "attack" ? "攻击释放姿势" : "动作终态", prompt: m.script, reuseBase: m.id === "idle" })), reviews: {}, delivery: {} };
}
export function hasAuthoredProduction(document) {
  const p = document.production;
  if (!p) return false;
  const empty = createProductionPlan();
  return Object.values(p.brief || {}).some((v) => v?.trim()) || JSON.stringify(p.motions) !== JSON.stringify(empty.motions) || JSON.stringify(p.boards) !== JSON.stringify(empty.boards);
}
export function validateProduction(document) {
  const p = document.production;
  if (p === undefined) return document;
  if (!plain(p) || p.version !== 1 || !plain(p.brief) || !Array.isArray(p.motions) || !Array.isArray(p.boards)) throw new Error("制作计划格式无效。");
  const text = (v, max = 4000) => v === undefined || typeof v === "string" && v.length <= max;
  if (productionBriefFields.some(([key]) => !text(p.brief[key])) || p.motions.length > 16 || p.boards.length > 64) throw new Error("制作计划文字过长或动作、画面数量超限。");
  const ids = new Set();
  for (const m of p.motions) {
    if (!plain(m) || !idOK(m.id) || ids.has(m.id) || !text(m.name, 100) || !Number.isFinite(m.duration) || m.duration < .1 || m.duration > 30 || typeof m.loop !== "boolean" ||
      ["script", "expression", "contacts", "ending"].some((key) => !text(m[key]))) throw new Error("制作计划动作无效或重复。");
    ids.add(m.id);
  }
  const boardIds = new Set();
  for (const b of p.boards) {
    const m = p.motions.find((m) => m.id === b.motionId);
    if (!plain(b) || !idOK(b.id) || boardIds.has(b.id) || !m || !Number.isFinite(b.time) || b.time < 0 || b.time > m.duration || !text(b.label, 100) || !text(b.prompt) || typeof b.reuseBase !== "boolean") throw new Error("分镜画面标识、时间或说明无效。");
    boardIds.add(b.id);
    for (const field of ["image", "nativeImage"]) if (b[field] !== undefined && (typeof b[field] !== "string" || b[field].length > 32 * 1024 * 1024 || !/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/.test(b[field]))) throw new Error("分镜需要有效的本地图片。");
    if (b.calibration !== undefined && (!plain(b.calibration) || !["x", "y", "scaleX", "scaleY", "rotation"].every((k) => Number.isFinite(b.calibration[k])) || b.calibration.scaleX <= 0 || b.calibration.scaleX > 8 || Math.abs(b.calibration.scaleX - b.calibration.scaleY) > 1e-6 || b.calibration.flipX || b.calibration.flipY || !b.nativeImage)) throw new Error("关键图校准需要原生图片及有效等比变换。");
    if (b.pending !== undefined && (!plain(b.pending) || !idOK(b.pending.jobId) || !/^[a-f0-9]{64}$/.test(b.pending.fingerprint))) throw new Error("分镜生成映射无效。");
    if (["jobId", "imageId"].some((key) => b[key] !== undefined && !idOK(b[key]))) throw new Error("分镜来源无效。");
  }
  if (!plain(p.reviews || {}) || !plain(p.delivery || {})) throw new Error("制作审阅或回导记录无效。");
  const checkReview = (review, stage) => {
    if (!plain(review) || !/^[a-f0-9]{64}$/.test(review.fingerprint) || !Array.isArray(review.checks) ||
      review.checks.length !== productionChecks[stage].length || !productionChecks[stage].every((value) => review.checks.includes(value)) ||
      typeof review.at !== "string" || review.at.length > 80 || !Number.isFinite(Date.parse(review.at))) throw new Error("制作审阅记录无效。");
  };
  for (const [key, value] of Object.entries(p.reviews || {})) {
    if (["boards", "motions"].includes(key)) {
      if (!plain(value) || Object.keys(value).length > 128) throw new Error("制作审阅映射无效。");
      for (const [id, review] of Object.entries(value)) { if (!idOK(id)) throw new Error("制作审阅标识无效。"); checkReview(review, key === "boards" ? "board" : "motion"); }
    } else if (["brief", "appearance", "structure", "assembly", "binding"].includes(key)) checkReview(value, key);
    else throw new Error("未知制作审阅阶段。");
  }
  for (const [kind, receipt] of Object.entries(p.delivery || {})) if (!["runtime", "project"].includes(kind) || !plain(receipt) ||
    ![receipt.snapshot, receipt.archive].every((v) => /^[a-f0-9]{64}$/.test(v)) || !text(receipt.fileName, 240)) throw new Error("验收包回导记录无效。");
  return document;
}
export function productionBoardImage(document, board) { return board?.reuseBase ? document.sourceImage : board?.image; }
const planMotion = (doc, id) => doc.production.motions.find((m) => m.id === id);
const boardSpec = ({ id, motionId, time, label, prompt, reuseBase }) => ({ id, motionId, time, label, prompt, reuseBase });
const partStructure = ({ id, bone, x, y, width, height, z, attachmentGroup, role, blendMode, effect }) => ({ id, bone, x, y, width, height, z, attachmentGroup,
  ...(role ? { role } : {}), ...(blendMode ? { blendMode } : {}), ...(effect ? { effect } : {}) });
export function productionFingerprint(doc, stage, id) {
  const p = doc.production;
  if (!p) return null;
  if (stage === "brief") return hash({ brief: p.brief, motions: p.motions, boards: p.boards.map(boardSpec) });
  const appearance = hash({ source: imageHash(doc, "sourceImage"), brief: ["identity", "style", "camera", "equipment", "rules"].map((key) => p.brief[key]) });
  if (stage === "appearance") return appearance;
  if (stage === "board-request" || stage === "board") {
    const b = p.boards.find((b) => b.id === id);
    if (!b) throw new Error("分镜不存在。");
    const request = { appearance, board: boardSpec(b), motion: planMotion(doc, b.motionId) };
    return hash(stage === "board-request" ? { ...request, brief: p.brief } : { ...request, image: b.reuseBase ? imageHash(doc, "sourceImage") : imageHash(b) });
  }
  const targets = p.boards.map((b) => productionFingerprint(doc, "board", b.id));
  const structure = { appearance, targets, strategy: p.brief.parts, joints: doc.joints, parts: doc.parts.map(partStructure) };
  if (stage === "structure") return hash(structure);
  const assembly = hash({ appearance, parts: doc.parts.map((part) => ({ ...partStructure(part), image: imageHash(part), completion: part.completion, imageSource: part.imageSource })), defaults: doc.defaultAttachments });
  if (stage === "assembly") return assembly;
  const binding = hash({ assembly, joints: doc.joints, parts: doc.parts.map(({ id, binding, influences, mesh, grip }) => ({ id, binding, influences, mesh, grip })) });
  if (stage === "binding") return binding;
  if (stage === "motion") return hash({ binding, motion: doc.motions.find((m) => m.id === id), script: planMotion(doc, id), targets: p.boards.filter((b) => b.motionId === id).map((b) => productionFingerprint(doc, "board", b.id)) });
  if (stage === "delivery") return hash({ ...doc, sourceImage: imageHash(doc, "sourceImage"),
    appearanceReference: doc.appearanceReference && { ...doc.appearanceReference, image: imageHash(doc.appearanceReference) },
    parts: doc.parts.map((part) => ({ ...part, image: imageHash(part), registrationBase: part.registrationBase && { ...part.registrationBase, image: imageHash(part.registrationBase) } })),
    production: { ...p, reviews: undefined, delivery: undefined, boards: p.boards.map((b) => ({ ...b, image: imageHash(b), ...(b.nativeImage ? { nativeImage: imageHash(b, "nativeImage") } : {}), pending: undefined })) } });
  throw new Error("未知制作阶段。");
}
export function productionReviewCurrent(doc, stage, id) {
  if (!doc.production) return false;
  const review = stage === "board" ? doc.production.reviews?.boards?.[id] : stage === "motion" ? doc.production.reviews?.motions?.[id] : doc.production.reviews?.[stage];
  return Boolean(review && review.fingerprint === productionFingerprint(doc, stage, id) && productionChecks[stage].every((text) => review.checks.includes(text)));
}
export function productionStageIssues(doc, stage, motionId) {
  const p = doc.production;
  if (!p) return [];
  const issues = [];
  const add = (condition, text) => { if (!condition) issues.push(text); };
  add(productionBriefFields.every(([key]) => p.brief[key]?.trim().length >= 4), "请填写身份、画风、尺寸、持握、固定约束、分层策略和交付要求。");
  add(p.motions.length > 0 && p.motions.every((m) => m.name?.trim() && ["script", "expression", "contacts", "ending"].every((key) => m[key]?.trim().length >= 4)), "请完成每个动作的脚本、表情、接触和终态。");
  add(p.motions.every((m) => p.boards.some((b) => b.motionId === m.id && b.prompt?.trim())), "每个动作至少需要一个关键姿势目标。");
  if (stage === "brief") return issues;
  add(productionReviewCurrent(doc, "brief"), "请先确认当前制作计划。");
  if (stage === "appearance") { add(Boolean(doc.sourceImage), "请先导入或生成完整设定图。"); return issues; }
  add(productionReviewCurrent(doc, "appearance"), "请先审阅并确认当前设定图。");
  if (stage === "board") {
    if (motionId !== undefined) {
      const board = p.boards.find((b) => b.id === motionId);
      add(Boolean(board?.prompt?.trim()), "请描述这张关键画面的姿势、表情和接触。");
      add(Boolean(productionBoardImage(doc, board)), "请先提供这张关键画面。");
    }
    return issues;
  }
  for (const b of p.boards) add(Boolean(productionBoardImage(doc, b)) && productionReviewCurrent(doc, "board", b.id), `关键画面「${b.label}」待提供图片或重新确认。`);
  for (const m of p.motions.filter((m) => m.id !== "idle")) add(p.boards.some((b) => b.motionId === m.id && !b.reuseBase), `「${m.name}」需要独立的动作姿势图。`);
  if (stage === "targets") return issues;
  add(doc.joints.length > 0 && doc.parts.length > 0, "请先建立并检查角色结构。");
  if (stage === "structure") return issues;
  add(productionReviewCurrent(doc, "structure"), "请确认关节、部件与变体覆盖目标动作。");
  add(doc.parts.length > 0 && doc.parts.every((p) => p.image && p.completion === "ready" && !["source-crop", "placeholder"].includes(p.imageSource)), "独立部件与隐藏补绘尚未完成。");
  if (stage === "assembly") return issues;
  add(productionReviewCurrent(doc, "assembly"), "请确认实际组装、可见原画和完整接头。");
  if (stage === "binding") return issues;
  add(productionReviewCurrent(doc, "binding"), "请完成极限姿势和绑定审阅。");
  add(JSON.stringify(doc.motions.map((m) => m.id).sort()) === JSON.stringify(p.motions.map((m) => m.id).sort()), "实际动作清单与制作计划不同，请保留要求的动作范围。");
  for (const m of p.motions) {
    const actual = doc.motions.find((v) => v.id === m.id);
    add(actual?.duration === m.duration && actual?.loop === m.loop, `「${m.name}」时长或循环方式与计划不一致。`);
  }
  if (stage === "motion") {
    if (motionId !== undefined) add(Boolean(doc.motions.find((m) => m.id === motionId && m.origin !== "manual-placeholder")), "请先完成当前动画。");
    return issues;
  }
  for (const m of p.motions) add(productionReviewCurrent(doc, "motion", m.id), `「${m.name}」需要预览并确认当前动画。`);
  if (stage === "export") return issues;
  for (const kind of ["runtime", "project"]) add(Boolean(p.delivery?.[kind] && p.delivery[kind].snapshot === productionFingerprint(doc, "delivery")), `${kind === "runtime" ? "运行时" : "可编辑"}验收包尚未实际回导或内容已改变。`);
  return issues;
}
export function assertProductionGate(doc, operation) {
  if (!doc.production) return;
  const stage = { appearance: "appearance", reference: "board", structure: "targets", parts: "assembly", registration: "assembly", motion: "motion", "motion-frames": "motion", "pose-mapping": "motion", export: "export", save: "save" }[operation] || operation;
  let issues;
  // Assembly review follows part generation, so generation needs structure approval only.
  if (["parts", "registration"].includes(operation)) {
    issues = productionStageIssues(doc, "structure");
    if (!productionReviewCurrent(doc, "structure")) issues.push("请先确认结构覆盖目标动作。");
  } else issues = productionStageIssues(doc, stage);
  if (issues.length) throw new Error(issues[0]);
}
export function productionPrompt(doc, kind, id) {
  const p = doc.production;
  if (!p) return "";
  const brief = productionBriefFields.map(([key, label]) => `${label}：${p.brief[key]}`).join("\n");
  const motion = p.motions.find((m) => m.id === id), board = p.boards.find((b) => b.id === id);
  const selected = motion || p.motions.find((m) => m.id === board?.motionId);
  const describe = (m) => `动作 ${m.name}（${m.id}），${m.duration}秒，${m.loop ? "循环" : "非循环"}。脚本：${m.script}；表情：${m.expression}；接触：${m.contacts}；终态：${m.ending}。`;
  const detail = selected ? describe(selected) : ["structure", "parts"].includes(kind) ? p.motions.map(describe).join("\n") : "";
  const prompt = `${brief}\n${detail}\n${board ? `仅绘制关键姿势「${board.label}」，时间 ${board.time} 秒。${board.prompt}。保持参考角色物理尺寸、镜头和身份，只改变姿势；这张图是姿势参考，不是拆件或最终动画。` : kind === "structure" ? "按已确认造型和动作需求规划独立结构，不套模板。" : "按当前已确认的制作要求执行。"}`;
  if (prompt.length > 3800) throw new Error("制作说明超出单次任务长度，请精简计划或分镜文字；固定约束不会被自动截断。");
  return prompt;
}
export function productionRequestFingerprint(doc, kind, id) {
  if (!doc.production) return null;
  return hash({ kind, prompt: productionPrompt(doc, kind, id), extra: doc.prompts?.[kind] || "", appearance: productionFingerprint(doc, "appearance"),
    ...(kind === "structure" ? { detail: doc.structureDetail === "standard" ? "standard" : "detailed" } : {}),
    ...(kind === "parts" ? { partPrompts: doc.parts.map(({ id, prompt }) => ({ id, prompt })) } : {}),
    ...(kind === "motion" ? { input: productionFingerprint(doc, "motion", id) } :
      ["structure", "parts", "registration"].includes(kind) ? { input: productionFingerprint(doc, "structure") } : {}) });
}
export function plannedMotionSlots(doc) {
  return doc.production.motions.map((m) => ({ id: m.id, name: m.name, duration: m.duration, loop: m.loop, description: `${m.script}\n表情：${m.expression}\n接触：${m.contacts}\n终态：${m.ending}`, origin: "manual-placeholder",
    poses: [0, m.duration].map((time) => ({ time, angles: {}, root: { x: 0, y: 0 }, ease: "smooth" })) }));
}

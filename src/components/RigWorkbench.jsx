import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bone, Check, Eye, ImagePlus, Layers, LoaderCircle, Move, Pause, Play, Plus, Redo2, RefreshCw, Save, ScanLine, Sparkles, Square, Trash2, Undo2, Upload } from "lucide-react";
import { createHumanoidDraft, validateRigDocument, buildRigFiles, getRigPartMesh, setRigPartWeights, replaceRigMotion, sampleRigPose, inspectRigMotion, bindRigWeapon, resolveRigAttachments } from "../core/rig-authoring.js";
import { registerRigSourcePixels, inspectRegistrationBounds, expandRigRegistrationBounds } from "../core/rig-registration.js";
import { parseBundle } from "../core/archive.js";
import { parseSkeleton } from "../spine/runtime.js";
import { createLocalGenerationProvider } from "../core/generation.js";
import { createRigClient, isRigJobActive, assertRigJobMatches, assertRigAppearanceMatches, assertRigPartJobMatches, assertRigRegistrationMatches, rigRegistrationPolygons, rigSourceFingerprint, rigCompositionFingerprint, bytesToImageDataURL, rigRetryablePartIds, rigWithAppearance, rigReadiness, rigSourceRequest, rigAttachmentGroups, rigDefaultVisiblePartIds, rigWithPartAttachmentGroup, rigWithPartFields, rigWithoutPart, rigWithDefaultAttachment } from "../core/rig-client.js";
import { readRigImage, readRigReference, readRigPartCandidate, composeRigSourceView, inspectRigPartAlpha, createRigPartCalibration, bakeRigPartCalibration } from "../core/rig-images.js";
import { SpineViewer } from "./SpineViewer.jsx";
import { RigCanvas } from "./RigCanvas.jsx";
import { PartEditor } from "./PartEditor.jsx";
import { MotionStudyPanel } from "./MotionStudyPanel.jsx";
import { CompleteOverlapPanel } from "./CompleteOverlapPanel.jsx";
import { PoseTransformControls } from "./PoseTransformControls.jsx";
import { PartAppearancePanel } from "./PartAppearancePanel.jsx";
import { rigTimelineInputTime, rigManualSeekTime } from "../core/rig-preview-time.js";
import { isMotionStudyJob, motionStudyFrameImage } from "../core/motion-study-client.js";
import { prepareMotionStudyFrames, applyMotionStudy, isMotionStudyPlaybackActive } from "../core/rig-motion-studies.js";
import { moveRigPart, resizeRigPart } from "../core/rig-part-adjustment.js";
import "../rig-workbench.css";

const steps = [{ id: "structure", label: "结构与关节", icon: ScanLine }, { id: "parts", label: "拆分与补绘", icon: Layers }, { id: "binding", label: "绑定与权重", icon: Bone }, { id: "motion", label: "动作与关键帧", icon: Play }, { id: "preview", label: "验证与保存", icon: Check }];
const statusLabels = { queued: "等待处理", analyzing: "正在分析", generating: "正在生成", completed: "已完成", failed: "生成失败", cancelled: "已取消" };
const kindLabels = { appearance: "Q 版形象", structure: "结构分析", parts: "部件补绘", motion: "动作规划", registration: "原图坐标对应" };
const defaultPrompts = { appearance: "以当前立绘为身份参考，保留发型、服装、配色与角色特征，重新设计成 2.5–3 头身的 Q 版人形角色。干净赛璐璐上色，清楚的分色与阴影，全身完整，头、躯干、四肢与手持物轮廓便于后续拆分。自然站姿，适合骨骼动画，角色居中，实际透明背景，不绘制棋盘格、地面、投影、边框或文字。", structure: "识别当前 Q 版人形角色的真实骨架、遮挡顺序与独立部件，按关节活动边界拆分。手掌与前臂分开，上臂与前臂、大腿与小腿、脚掌分别绑定有效关节；有活动需要的前后发、衣摆和武器分开。关节与部件应支持待机、攻击、受击、跑步、技能、死亡和胜利等动作。补足被遮挡的肢体连接处，不把不同表情或动作变体叠成同时显示的部件。", parts: "保留角色身份和画风，补全被遮挡的肢体与连接处，输出完整独立透明部件，去除其他部件和背景。" };
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const makeId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const emptyDocument = () => ({ version: 1, id: makeId("rig"), name: "新角色", width: 1024, height: 1024, joints: [], parts: [], motions: [], origin: "manual" });
const jobImages = (job) => job?.result?.images || job?.images || [];
const copyPose = (pose, time = pose.time) => ({ ...structuredClone(pose), time });
const attachmentGroupLabels = { eyeLeft: "左眼", eyeRight: "右眼", browLeft: "左眉", browRight: "右眉", mouth: "嘴型" };
const registrationDefaultPrompt = "以原图像素坐标规划每个默认可见部件的真实可见轮廓。保留衣服和腿部的实际宽度与体积，按 32 像素网格定位。轮廓允许超出偏小的现有矩形，明确报告所需边界；不要把轮廓缩细塞进框，不重画角色，不改变关节、网格权重、动作或默认表情。";

function RegistrationMetrics({ metrics }) {
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
const motionPresets = {
  run: { name: "跑步", duration: 0.8, loop: true, description: "循环跑步，双腿交替蹬地与摆动，身体轻微起伏，手臂与武器稳定跟随，首尾连续。" },
  skill: { name: "技能", duration: 1.6, loop: false, description: "清晰的技能蓄势、施放和收势，重心稳定，武器握点与双脚接地合理。" },
  death: { name: "死亡", duration: 1.3, loop: false, description: "角色受击后失去平衡并倒下，最终停留在死亡姿态，部件保持连接，避免地面穿插。" },
  victory: { name: "胜利", duration: 1.8, loop: false, description: "角色完成轻快明确的胜利庆祝，保留角色性格与武器握持，最终稳定站立。" },
};
function basicMotionSlots() {
  return [{ id: "idle", name: "待机", duration: 2, loop: true, description: "自然呼吸与轻微重心变化，双脚稳定着地，首尾连续。" }, { id: "attack", name: "攻击", duration: 1.1, loop: false, description: "明确准备、挥击与收势，按当前武器握点设计动作，双脚稳定。" }, { id: "hit", name: "受击", duration: 0.6, loop: false, description: "受击后身体短暂后仰并恢复，保持脚部和握持稳定。" }].map((motion) => ({ ...motion, origin: "manual-placeholder", poses: [{ time: 0, angles: {}, root: { x: 0, y: 0 }, ease: "smooth" }, { time: motion.duration, angles: {}, root: { x: 0, y: 0 }, ease: "smooth" }] }));
}
function makeClock() {
  return { position: 0, anchor: performance.now(), playing: true, speed: 1,
    read(now = performance.now()) { return this.position + (this.playing ? (now - this.anchor) / 1000 * this.speed : 0); },
    seek(value) { this.position = value; this.anchor = performance.now(); },
    set(values) { this.position = this.read(); this.anchor = performance.now(); Object.assign(this, values); } };
}
function NumberField({ label, value, onChange, min, max, step = 1, disabled = false }) {
  const [text, setText] = useState(String(value ?? 0));
  useEffect(() => { setText(String(value ?? 0)); }, [value]);
  return <label className="rig-number-field"><span>{label}</span><input type="number" aria-label={label} min={min} max={max} step={step} disabled={disabled} value={text}
    onChange={(event) => { setText(event.target.value); if (event.target.value.trim() && Number.isFinite(Number(event.target.value))) onChange(clamp(Number(event.target.value), min ?? -Infinity, max ?? Infinity)); }}
    onBlur={() => { if (!text.trim() || !Number.isFinite(Number(text))) setText(String(value ?? 0)); }} /></label>;
}

function GripControls({ document, part, disabled, onBind }) {
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

export function RigWorkbench({ initialDocument = null, initialManualAdjustment = false, initialPartId = null, onDraftChange, onSave, onClose, connectionStatus = null, onOpenConnection, saveHint = "", draftSaveStatus = null }) {
  const [document, setDocument] = useState(() => initialDocument || emptyDocument());
  const documentRef = useRef(document), callbacks = useRef({}); documentRef.current = document; callbacks.current = { onDraftChange, onSave, onClose };
  const [step, setStep] = useState(initialManualAdjustment ? "binding" : "structure"), [canvasMode, setCanvasMode] = useState("overlay");
  const [manualAdjustment, setManualAdjustment] = useState(initialManualAdjustment), partGesture = useRef(null);
  const [jointId, setJointId] = useState(initialDocument?.joints?.[0]?.id || ""), [partId, setPartId] = useState(initialPartId || initialDocument?.parts?.[0]?.id || "");
  const [motionId, setMotionId] = useState(initialDocument?.motions?.[0]?.id || ""), [poseIndex, setPoseIndex] = useState(0), [vertexIndex, setVertexIndex] = useState(0);
  const [selectedParts, setSelectedParts] = useState([]), [concurrency, setConcurrency] = useState(3);
  const [motionPreset, setMotionPreset] = useState("custom");
  const [motionStudyOpen, setMotionStudyOpen] = useState(false), [motionStudyBusy, setMotionStudyBusy] = useState(false);
  const [newPartGroup, setNewPartGroup] = useState(""), [customGroup, setCustomGroup] = useState(""), [addingGroup, setAddingGroup] = useState(false), [attachmentPreview, setAttachmentPreview] = useState({});
  const [registrationOpen, setRegistrationOpen] = useState(false), [registrationStage, setRegistrationStage] = useState(null), [registrationCandidate, setRegistrationCandidate] = useState(null);
  const [completeOverlapOpen, setCompleteOverlapOpen] = useState(false);
  const [registrationView, setRegistrationView] = useState("overlay"), [registrationGrid, setRegistrationGrid] = useState(true), [registrationOpacity, setRegistrationOpacity] = useState(0.5);
  const [registrationFocus, setRegistrationFocus] = useState(false), [registrationOnlySelected, setRegistrationOnlySelected] = useState(true);
  const [registrationAssembly, setRegistrationAssembly] = useState(""), [registrationAlpha, setRegistrationAlpha] = useState(null), [registrationVertex, setRegistrationVertex] = useState(0);
  const [registrationMeasurement, setRegistrationMeasurement] = useState(null);
  const appearancePrompt = document.prompts?.appearance ?? defaultPrompts.appearance, structurePrompt = document.prompts?.structure ?? defaultPrompts.structure, partsPrompt = document.prompts?.parts ?? defaultPrompts.parts;
  const structureDetail = document.structureDetail === "standard" ? "standard" : "detailed";
  const setAppearancePrompt = (value) => commit((current) => ({ ...current, prompts: { ...current.prompts, appearance: value } }), false);
  const setStructurePrompt = (value) => commit((current) => ({ ...current, prompts: { ...current.prompts, structure: value } }), false);
  const setPartsPrompt = (value) => commit((current) => ({ ...current, prompts: { ...current.prompts, parts: value } }), false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState("");
  const [jobs, setJobs] = useState([]), [job, setJob] = useState(null), selectedJobId = useRef("");
  const [plannerStatus, setPlannerStatus] = useState(null), [pendingSource, setPendingSource] = useState(null), [confirmReset, setConfirmReset] = useState(null);
  const [preview, setPreview] = useState(null), [previewDocument, setPreviewDocument] = useState(null), [testReport, setTestReport] = useState(null);
  const [calibration, setCalibration] = useState(null), [calibrationError, setCalibrationError] = useState("");
  const [playing, setPlaying] = useState(!initialManualAdjustment), [position, setPosition] = useState(0), [showImage, setShowImage] = useState(!initialManualAdjustment), [showParts, setShowParts] = useState(true);
  const [partGrid, setPartGrid] = useState(false), annotationSeek = useRef(null);
  const [, updateHistory] = useState(0), undo = useRef([]), redo = useRef([]), alive = useRef(true), busyRef = useRef(false);
  const sourceInput = useRef(), partInput = useRef(), partUploadTarget = useRef(""), jobSection = useRef(), calibrationContainer = useRef();
  const registrationPanel = useRef(), contourUndo = useRef([]);
  const client = useRef(createRigClient()).current, generationClient = useRef(createLocalGenerationProvider()).current, clock = useRef(makeClock()).current;
  const running = jobs.find(isRigJobActive), locked = Boolean(busy || running || calibration || motionStudyBusy);
  const joint = document.joints.find((item) => item.id === jointId) || document.joints[0];
  const part = document.parts.find((item) => item.id === partId) || document.parts[0];
  const attachmentGroups = useMemo(() => rigAttachmentGroups(document), [document.parts, document.defaultAttachments]);
  const groupIds = [...new Set([...Object.keys(attachmentGroupLabels), ...attachmentGroups.map((group) => group.id)])];
  const partGroup = attachmentGroups.find((group) => group.id === part?.attachmentGroup);
  const motion = document.motions.find((item) => item.id === motionId) || document.motions[0];
  const pose = motion?.poses[Math.min(poseIndex, motion.poses.length - 1)];
  const readiness = rigReadiness(document), duration = motion?.duration || 1;
  const resolvedTime = motion?.loop ? ((position % duration) + duration) % duration : clamp(position, 0, duration);
  const activeMotionStudy = isMotionStudyPlaybackActive(document.motionStudies?.[motion?.id]) ? document.motionStudies[motion.id] : null;
  const poseTime = activeMotionStudy ? !motion.loop && position >= duration ? rigManualSeekTime(duration, activeMotionStudy) : position : resolvedTime;
  const runtimeClock = useMemo(() => ({ read(now) {
    const time = clock.read(now), end = preview?.durations?.[motion?.id];
    return motion && !motion.loop && time >= motion.duration && Number.isFinite(end) ? end : time;
  } }), [clock, preview, motion?.id, motion?.loop, motion?.duration]);
  const geometryDocument = useMemo(() => ({ ...document, sourceImage: undefined, appearanceReference: undefined, motionStudies: undefined, parts: document.parts.map((item) => ({ ...item, image: undefined, registrationBase: undefined })) }), [document]);
  const mesh = useMemo(() => { try { return step === "binding" && part?.binding === "mesh" ? getRigPartMesh(geometryDocument, part.id) : null; } catch { return null; } }, [geometryDocument, part?.id, step]);
  const sampledPose = useMemo(() => { try { return { pose: canvasMode === "overlay" && (step === "motion" || step === "preview") && motion ? sampleRigPose(activeMotionStudy ? document : geometryDocument, motion.id, poseTime) : null, error: "" }; } catch (failure) { return { pose: null, error: failure.message }; } }, [document, geometryDocument, motion?.id, poseTime, step, canvasMode]);
  const displayedPose = sampledPose.pose;
  const displayedStudyFrame = activeMotionStudy?.frames.find((frame) => frame.id === displayedPose?.frameId);
  const overlayDocument = useMemo(() => displayedStudyFrame ? { ...document, sourceImage: motionStudyFrameImage(activeMotionStudy, displayedStudyFrame) } : document, [document, displayedStudyFrame]);
  const setupVisiblePartIds = useMemo(() => {
    const defaults = { ...document.defaultAttachments };
    for (const group of attachmentGroups) if (group.parts.some((item) => item.id === attachmentPreview[group.id])) defaults[group.id] = attachmentPreview[group.id];
    try { return resolveRigAttachments({ ...geometryDocument, defaultAttachments: defaults }).visiblePartIds; }
    catch { return rigDefaultVisiblePartIds(document, attachmentPreview); }
  }, [geometryDocument, attachmentPreview]);
  const registrationStageCurrent = registrationStage?.baseDocument === document;
  const activeRegistrationCandidate = registrationCandidate && (registrationCandidate.baseDocument === document || registrationCandidate.document === document) ? registrationCandidate : null;
  const registrationPolygons = registrationStageCurrent || activeRegistrationCandidate ? registrationStage?.polygons || {} : {};
  const registrationBounds = useMemo(() => { try { return registrationStageCurrent ? inspectRegistrationBounds(document, registrationStage.polygons) : null; } catch { return null; } }, [document, registrationStage]);
  const selectedPolygon = registrationPolygons[part?.id] || [];
  const selectedRegistrationBounds = registrationBounds?.parts.find((item) => item.partId === part?.id);
  const selectedRegistrationPixels = activeRegistrationCandidate?.document.parts.find((item) => item.id === part?.id)?.registration || part?.registration;
  const selectedRegistrationDiagnostic = (activeRegistrationCandidate?.metrics || document.registration?.metrics)?.partDiagnostics?.find((item) => item.partId === part?.id);

  const remember = () => { undo.current = [...undo.current.slice(-29), documentRef.current]; redo.current = []; updateHistory((value) => value + 1); };
  const commit = (next, checkpoint = true) => {
    const value = typeof next === "function" ? next(documentRef.current) : next;
    if (value === documentRef.current) return;
    if (checkpoint) remember();
    documentRef.current = value; setDocument(value); setTestReport(null);
  };
  const patchJoint = (id, fields, checkpoint = true) => commit((current) => ({ ...current, joints: current.joints.map((item) => item.id === id ? { ...item, ...fields } : item) }), checkpoint);
  const patchPart = (id, fields) => commit((current) => rigWithPartFields(current, id, fields));
  const selectEditablePart = (id) => {
    setPartId(id);
    const selected = documentRef.current.parts.find((item) => item.id === id);
    if (manualAdjustment && selected?.attachmentGroup) setAttachmentPreview((current) => ({ ...current, [selected.attachmentGroup]: id }));
  };
  const adjustPart = (id, x, y, checkpoint = true) => {
    try { commit(moveRigPart(documentRef.current, id, x, y), checkpoint); }
    catch (failure) { setError(failure.message); }
  };
  const beginPartMove = () => { partGesture.current = { document: documentRef.current, undo: undo.current, redo: redo.current }; remember(); };
  const cancelPartMove = ({ preserveDocument = false } = {}) => {
    const gesture = partGesture.current;
    if (!gesture) return;
    if (preserveDocument) {
      const index = undo.current.lastIndexOf(gesture.document);
      if (index >= 0) undo.current = undo.current.filter((_, i) => i !== index);
    } else {
      undo.current = gesture.undo; redo.current = gesture.redo;
      commit(gesture.document, false);
    }
    partGesture.current = null; updateHistory((value) => value + 1);
  };
  const resizeSelectedPart = (scale) => {
    try { commit(resizeRigPart(documentRef.current, part.id, scale)); }
    catch (failure) { setError(failure.message); }
  };
  const enterManualAdjustment = () => {
    setManualAdjustment(true); setStep("binding"); setCanvasMode("overlay"); setRegistrationOpen(false);
    setShowImage(false); setShowParts(true); setPartGrid(false);
    clock.set({ playing: false }); clock.seek(0); setPlaying(false); setPosition(0);
    const selected = documentRef.current.parts.find((item) => item.id === partId);
    if (selected?.attachmentGroup) setAttachmentPreview((current) => ({ ...current, [selected.attachmentGroup]: selected.id }));
  };
  useEffect(() => { if (initialManualAdjustment) { clock.set({ playing: false }); clock.seek(0); } }, []);
  const patchMotion = (fields) => {
    if (!motion) return;
    if (isMotionStudyPlaybackActive(documentRef.current.motionStudies?.[motion.id]) && ["poses", "duration", "loop"].some((key) => Object.hasOwn(fields, key))) { setError("此动作使用逐帧部件画面，请打开动作画面重制调整；原连续骨骼关键帧保持。"); return; }
    commit((current) => ({ ...current, motions: current.motions.map((item) => item.id === motion.id ? { ...item, ...fields, ...(fields.poses ? { origin: "manual" } : {}) } : item) }));
  };
  const patchPose = (fields) => { if (motion && pose) patchMotion({ origin: "manual", poses: motion.poses.map((item, index) => index === poseIndex ? { ...item, ...fields } : item) }); };
  const changePartGroup = (group) => {
    try { commit(rigWithPartAttachmentGroup(documentRef.current, part.id, group)); setAddingGroup(false); setCustomGroup(""); setAttachmentPreview({}); if (group) setShowImage(false); setNotice(group ? "已加入显示组。同组只显示一个附件，并共享绑定骨骼与遮挡层级。" : "已改为普通独立层，将始终显示。"); }
    catch (failure) { setError(failure.message); }
  };
  const changePoseAttachment = (group, value) => {
    const attachments = { ...pose.attachments };
    if (value === "__inherit__") delete attachments[group]; else attachments[group] = value === "__hidden__" ? null : value;
    patchPose({ attachments }); clock.set({ playing: false }); setPlaying(false); clock.seek(pose.time); setPosition(pose.time);
  };
  const addPart = (duplicate = false) => {
    const current = documentRef.current, id = makeId("part"), bone = joint?.id || current.joints[0].id;
    const value = duplicate ? { ...part, id, label: `${part.label || part.id} 变体`, image: undefined, imageSource: "placeholder", completion: "needs-inpaint", imageGeneration: undefined, previousCalibration: undefined, registrationBase: undefined, registration: undefined }
      : { id, label: `新部件 ${current.parts.length + 1}`, bone, x: Math.round(current.width * 0.4), y: Math.round(current.height * 0.4), width: Math.round(current.width * 0.2), height: Math.round(current.height * 0.2), z: current.parts.length, binding: "rigid", influences: [bone], critical: true, completion: "needs-inpaint", imageSource: "placeholder" };
    let next = { ...current, parts: [...current.parts, value] };
    const group = duplicate ? part.attachmentGroup : newPartGroup;
    if (group) { next = rigWithPartAttachmentGroup(next, id, group); setShowImage(false); }
    commit(next); setPartId(id); setAttachmentPreview({});
  };
  const mergeJob = (value, select = false) => {
    const metadata = { ...value }; delete metadata.result;
    setJobs((previous) => [metadata, ...previous.filter((item) => item.id !== value.id)].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));
    if (select || selectedJobId.current === value.id) { selectedJobId.current = value.id; setJob(value); }
  };
  const perform = async (label, action) => {
    if (calibration) { setCalibrationError("请先完成或取消部件图片校准。"); return; }
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(""); setNotice("");
    try { return await action(); }
    catch (failure) { if (alive.current) setError(failure.message); }
    finally { busyRef.current = false; if (alive.current) setBusy(""); }
  };

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    const saveDraft = callbacks.current.onDraftChange;
    Promise.resolve().then(() => { if (!cancelled && alive.current) return saveDraft?.(document); }).catch((failure) => { if (!cancelled && alive.current) setError(`草稿保存失败：${failure.message}`); });
    return () => { cancelled = true; };
  }, [document]);
  useEffect(() => { if (registrationOpen) registrationPanel.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); }, [registrationOpen]);
  useEffect(() => {
    let cancelled = false;
    client.list(document.id).then(async (values) => {
      if (cancelled) return;
      const ordinary = values.filter((item) => !isMotionStudyJob(item));
      setJobs(ordinary); const latest = ordinary.find(isRigJobActive) || ordinary[0];
      if (latest) { const detail = await client.get(latest.id); if (!cancelled) mergeJob(detail, true); }
    }).catch((failure) => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [client, document.id]);
  useEffect(() => {
    let cancelled = false;
    generationClient.status("codex-native").then((value) => { if (!cancelled) setPlannerStatus(value); }).catch((failure) => { if (!cancelled) setPlannerStatus({ connected: false, message: failure.message }); });
    return () => { cancelled = true; };
  }, [generationClient, connectionStatus]);
  useEffect(() => {
    if (!running) return;
    let cancelled = false, polling = false;
    const timer = setInterval(async () => {
      if (polling) return; polling = true;
      try { const value = await client.get(running.id); if (!cancelled) mergeJob(value); }
      catch (failure) { if (!cancelled) setError(failure.message); }
      finally { polling = false; }
    }, 1600);
    return () => { cancelled = true; clearInterval(timer); };
  }, [client, running?.id]);
  useEffect(() => {
    const timer = setInterval(() => {
      const time = clock.read();
      if (motion && !motion.loop && time >= duration) {
        clock.set({ playing: false }); clock.seek(duration); setPlaying(false); setPosition(duration);
      } else setPosition(time);
    }, 100);
    return () => clearInterval(timer);
  }, [clock, motion?.id, motion?.loop, duration]);
  useEffect(() => {
    const target = annotationSeek.current?.motionId === motion?.id ? annotationSeek.current : null;
    annotationSeek.current = null;
    const time = target?.time || 0;
    setPoseIndex(target ? Math.max(0, motion.poses.findLastIndex((item) => item.time <= time)) : 0);
    clock.seek(time); setPosition(time);
  }, [motion?.id, clock]);
  useEffect(() => { setVertexIndex(0); }, [part?.id, mesh?.vertices.length]);
  useEffect(() => { setAddingGroup(false); setCustomGroup(""); }, [part?.id]);
  useEffect(() => { setAttachmentPreview({}); }, [step]);
  useEffect(() => {
    let cancelled = false;
    if (registrationOpen) composeRigSourceView(document).then((result) => { if (!cancelled && alive.current) setRegistrationAssembly(bytesToImageDataURL(result.png)); }).catch(() => { if (!cancelled && alive.current) setRegistrationAssembly(""); });
    return () => { cancelled = true; };
  }, [registrationOpen, document]);
  useEffect(() => {
    let cancelled = false;
    if (registrationOpen && part) inspectRigPartAlpha(document, part.id).then((result) => { if (!cancelled && alive.current) setRegistrationAlpha(result); }).catch(() => { if (!cancelled && alive.current) setRegistrationAlpha(null); });
    return () => { cancelled = true; };
  }, [registrationOpen, part?.id, part?.image, part?.x, part?.y, part?.width, part?.height]);
  useEffect(() => { setRegistrationVertex(0); }, [part?.id]);
  useEffect(() => {
    let cancelled = false;
    if (document.registration?.metrics && document.registration.compositionFingerprint)
      rigCompositionFingerprint(document).then((fingerprint) => { if (!cancelled && alive.current) setRegistrationMeasurement({ document, matches: fingerprint === document.registration.compositionFingerprint }); }).catch(() => { if (!cancelled && alive.current) setRegistrationMeasurement({ document, matches: false }); });
    else setRegistrationMeasurement(null);
    return () => { cancelled = true; };
  }, [document]);
  useEffect(() => {
    if (!calibration) return;
    const dialog = calibrationContainer.current?.querySelector('[role="dialog"]'), browser = globalThis.window;
    if (!dialog || !browser) return;
    const previous = globalThis.document.activeElement;
    const focusable = () => [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),canvas[tabindex]')].filter((element) => element.offsetParent !== null);
    focusable()[0]?.focus();
    const handle = (event) => {
      if (busyRef.current) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (event.key !== "Tab") return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (!items.length) { event.preventDefault(); return; }
      if (!dialog.contains(globalThis.document.activeElement) || (event.shiftKey && globalThis.document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    browser.addEventListener("keydown", handle, true);
    return () => { browser.removeEventListener("keydown", handle, true); previous?.focus?.(); };
  }, [calibration]);

  const changeSource = async (file) => perform("读取立绘", async () => {
    const image = await readRigReference(file);
    const next = { ...emptyDocument(), name: documentRef.current.name === "新角色" ? file.name.replace(/\.[^.]+$/, "") : documentRef.current.name, width: image.width, height: image.height, sourceImage: image.dataURL, appearanceReference: image.reference, prompts: documentRef.current.prompts };
    if (!alive.current) return;
    if (documentRef.current.joints.length || documentRef.current.parts.length) setPendingSource(next);
    else { commit(next); setPreview(null); setJobs([]); setJob(null); }
    if (image.resized) setNotice("立绘已按比例缩至最长边 2048 像素，关节与部件坐标以当前画布为准。");
  });
  const programDraft = () => {
    try {
      const current = documentRef.current;
      const next = createHumanoidDraft({ id: current.id, name: current.name, width: current.width, height: current.height, sourceImage: current.sourceImage });
      next.prompts = current.prompts; next.structureDetail = current.structureDetail; next.appearanceReference = current.appearanceReference; next.appearance = current.appearance;
      next.parts = next.parts.map((item) => ({ ...item, x: Math.round(item.x), y: Math.round(item.y), width: Math.round(item.width), height: Math.round(item.height) }));
      commit(validateRigDocument(next));
      setJointId("root"); setStep("structure"); setCanvasMode("overlay"); setPreview(null); setConfirmReset(null);
      setNotice("已创建程序人形初稿。它不是 AI 识别结果；请逐个拖动关节对齐立绘，并补绘所有独立部件。");
    } catch (failure) { setError(failure.message); }
  };
  const buildPreview = async (snapshot = documentRef.current) => {
    const normalized = validateRigDocument(snapshot), files = await buildRigFiles(normalized);
    const bundle = parseBundle(files, { id: `rig-preview-${snapshot.id}`, name: snapshot.name });
    const { data } = parseSkeleton(bundle);
    const value = { ...bundle, animations: data.animations.map((item) => item.name), skins: data.skins.map((item) => item.name), durations: Object.fromEntries(data.animations.map((item) => [item.name, item.duration])), boneCount: data.bones.length };
    if (alive.current && documentRef.current === snapshot) { setPreview(value); setPreviewDocument(snapshot); }
    return { document: normalized, bundle: value };
  };
  const showPreview = () => perform("构建骨架预览", async () => { await buildPreview(); if (alive.current) { setManualAdjustment(false); setRegistrationOpen(false); setCanvasMode("preview"); clock.seek(0); setPosition(0); setNotice(readiness.ready ? "已用独立部件生成真实骨架预览。" : "当前包含原图矩形裁片或程序占位，仅用于检查骨架；这些部件仍待补绘。"); } });
  const openRegistration = () => { setManualAdjustment(false); setRegistrationOpen(true); setRegistrationGrid(true); setStep("binding"); setCanvasMode("overlay"); setShowImage(false); setShowParts(true); setAttachmentPreview({}); if (!rigDefaultVisiblePartIds(documentRef.current).includes(part?.id)) setPartId(rigDefaultVisiblePartIds(documentRef.current)[0] || ""); };
  const loadRegistrationStage = (current, polygons, sourceFingerprint, jobId) => {
    setRegistrationStage({ baseDocument: current, polygons, sourceFingerprint, jobId }); setRegistrationCandidate(null); contourUndo.current = []; setRegistrationVertex(0); openRegistration();
  };
  const loadSavedContours = () => perform("读取已保存轮廓", async () => {
    const current = documentRef.current, polygons = rigRegistrationPolygons(current, Object.fromEntries(current.parts.filter((item) => item.sourcePolygon && rigDefaultVisiblePartIds(current).includes(item.id)).map((item) => [item.id, item.sourcePolygon]))), fingerprint = await rigSourceFingerprint(current);
    if (current.registration?.sourceFingerprint && current.registration.sourceFingerprint !== fingerprint) throw new Error("已保存轮廓属于另一张源立绘，请重新生成坐标对应。");
    if (alive.current && documentRef.current === current) loadRegistrationStage(current, polygons, fingerprint, current.registration?.jobId);
  });
  const rememberContour = () => { if (registrationStageCurrent) contourUndo.current = [...contourUndo.current.slice(-29), registrationStage.polygons]; };
  const moveContourVertex = (id, index, x, y) => {
    if (!registrationStageCurrent || locked) return;
    setRegistrationStage((current) => ({ ...current, polygons: { ...current.polygons, [id]: current.polygons[id].map((point, at) => at === index ? { x: Math.round(clamp(x, 0, document.width) * 10) / 10, y: Math.round(clamp(y, 0, document.height) * 10) / 10 } : point) } }));
    setRegistrationCandidate(null); setRegistrationVertex(index);
  };
  const checkedRegistrationStage = async () => {
    const current = documentRef.current;
    if (!registrationStage || registrationStage.baseDocument !== current) throw new Error("草稿已改变，请重新查看坐标任务核对原始快照。已有对齐预览不会覆盖当前修改。");
    const polygons = rigRegistrationPolygons(current, registrationStage.polygons);
    if (await rigSourceFingerprint(current) !== registrationStage.sourceFingerprint) throw new Error("源立绘已改变，请重新生成坐标对应。");
    return { current, polygons };
  };
  const saveContours = () => perform("保存轮廓草稿", async () => {
    const { current, polygons } = await checkedRegistrationStage();
    const next = { ...current, parts: current.parts.map((item) => polygons[item.id] ? { ...item, sourcePolygon: polygons[item.id] } : item) };
    validateRigDocument(next);
    if (!alive.current || documentRef.current !== current) return;
    commit(next); setRegistrationStage({ ...registrationStage, baseDocument: next, polygons }); setRegistrationCandidate(null); setNotice("轮廓坐标已保存到草稿，尚未改动部件图片或矩形。可撤销或继续检查对齐效果。");
  });
  const checkRegistration = (expand = false) => perform(expand ? "扩展框并检查对齐" : "检查原图坐标对齐", async () => {
    const { current, polygons } = await checkedRegistrationStage();
    const bounds = inspectRegistrationBounds(current, polygons, { maxBBoxExpansion: 2 });
    if (!expand && bounds.parts.some((item) => item.needsExpansion)) throw new Error("原图轮廓超出现有部件框。请明确选择「扩展框并检查对齐效果」，不要把轮廓压细塞入旧框。");
    const prepared = expand ? await expandRigRegistrationBounds(current, polygons, {}) : current;
    const result = await registerRigSourcePixels(prepared, { polygons, jobId: registrationStage.jobId, gridSize: 32, maxBBoxExpansion: 2, sourceFingerprint: registrationStage.sourceFingerprint });
    if (!alive.current || documentRef.current !== current) return;
    setRegistrationCandidate({ baseDocument: current, document: result.document, metrics: result.metrics, expanded: expand,
      previewDataURL: bytesToImageDataURL(result.preview.png), ownerDataURL: bytesToImageDataURL(result.ownerMap.png) });
    setRegistrationView("overlay"); setNotice("已计算原图像素对齐候选。请查看叠加、轮廓和误差；确认应用前，当前草稿图片与矩形保持。");
  });
  const applyRegistration = () => perform("应用原图坐标对齐", async () => {
    if (!registrationCandidate || registrationCandidate.baseDocument !== documentRef.current) throw new Error("当前草稿已改变，请重新检查对齐效果。候选未应用。");
    const current = documentRef.current, candidate = registrationCandidate;
    const fingerprint = await rigCompositionFingerprint(candidate.document);
    if (!alive.current || documentRef.current !== current) return;
    const next = { ...candidate.document, registration: { ...candidate.document.registration, compositionFingerprint: fingerprint } };
    commit(next); setRegistrationStage({ ...registrationStage, baseDocument: next }); setRegistrationCandidate({ ...candidate, document: next });
    setRegistrationMeasurement({ document: next, matches: true }); setPreview(null); setPreviewDocument(null); setNotice("已应用原图坐标对齐。源图可见像素与 AI 隐藏补绘已合成；关节、网格权重、动作与默认表情保留，可用撤销恢复。");
  });
  const startJob = (kind) => perform(kindLabels[kind], async () => {
    const current = documentRef.current;
    if (running) throw new Error("已有骨架 AI 任务运行，请等待完成或取消。");
    const request = { version: 1, kind, projectId: current.id, name: current.name };
    if (kind === "appearance") {
      if (!appearancePrompt.trim()) throw new Error("请填写 Q 版形象说明。");
      Object.assign(request, { image: rigSourceRequest(current), prompt: appearancePrompt });
    } else if (kind === "structure") Object.assign(request, { planner: "codex-native", image: rigSourceRequest(current), prompt: structurePrompt, detail: structureDetail });
    else if (kind === "registration") Object.assign(request, { planner: "codex-native", rig: validateRigDocument(current), gridSize: 32, prompt: current.prompts?.registration || registrationDefaultPrompt });
    else {
      request.rig = validateRigDocument(current);
      if (kind === "motion") {
        if (!motion) throw new Error("请先选择一个动作。");
        if (isMotionStudyPlaybackActive(current.motionStudies?.[motion.id])) throw new Error("此动作已应用逐帧部件，请在动作画面重制中修改画面与坐标。");
        if (!motion.description?.trim()) throw new Error("请描述需要生成或调整的动作。");
        Object.assign(request, { planner: "codex-native", motion: { id: motion.id, name: motion.name, description: motion.description, duration: motion.duration, loop: motion.loop } });
      } else {
        const ids = [...new Set(selectedParts)].filter((id) => current.parts.some((item) => item.id === id));
        if (!ids.length) throw new Error("请勾选要补绘的部件。");
        Object.assign(request, { partIds: ids, concurrency, prompt: partsPrompt });
      }
    }
    const value = await client.start(request); if (alive.current) mergeJob(value, true);
  });
  const useAppearance = (next) => {
    commit(next); setJointId(""); setPartId(""); setSelectedParts([]); setMotionId(""); setPoseIndex(0); clock.seek(0);
    setStep("structure"); setCanvasMode("overlay"); setPreview(null); setPreviewDocument(null); setConfirmReset(null);
    setNotice("已应用 AI Q 版形象，原始参考和生成来源已保留。下一步点击「AI 结构分析」创建新的骨架与部件。");
  };
  const retryParts = () => perform("继续未完成部件", async () => {
    if (running) throw new Error("已有 AI 任务正在进行，请完成或取消后再继续。");
    const current = documentRef.current;
    if (!rigRetryablePartIds(job).length) throw new Error("这项记录没有可继续生成的部件。");
    await assertRigPartJobMatches(current, job);
    if (!alive.current || documentRef.current !== current) return;
    const value = await client.retry(job.id, { concurrency });
    if (alive.current && documentRef.current.id === current.id) { mergeJob(value, true); setNotice("已按原任务快照继续未完成部件。原立绘、提示词、部件映射与 AI 服务保持，已成功候选仍在原记录中。"); }
  });
  const applyJob = () => perform("应用 AI 候选", async () => {
    if (!job) return;
    const current = documentRef.current;
    if (job.kind === "registration") {
      const polygons = await assertRigRegistrationMatches(current, job);
      if (alive.current && documentRef.current === current) { loadRegistrationStage(current, polygons, job.sourceFingerprint, job.id); setNotice("已载入原图坐标计划，仅供审阅；当前部件图片、矩形、关节和动作尚未改变。"); }
      return;
    }
    if (job.kind === "appearance") {
      const candidate = await assertRigAppearanceMatches(current, job), bytes = await client.image(job.id, candidate);
      const image = await readRigImage(bytes, { requireTransparent: true, maxDimension: 1024, expectedWidth: 1024, expectedHeight: 1024 });
      if (!alive.current || documentRef.current !== current) return;
      const next = rigWithAppearance(current, job, image);
      if (current.joints.length || current.parts.length || current.motions.length) { setConfirmReset({ kind: "appearance", document: next, source: current }); return; }
      useAppearance(next); return;
    }
    assertRigJobMatches(job.kind === "structure" ? current : validateRigDocument(current), job);
    if (job.kind === "structure") {
      if (!job.result?.rig) throw new Error("这项记录还没有可应用的结构结果。");
      const value = validateRigDocument({ ...job.result.rig, id: current.id, name: current.name, sourceImage: current.sourceImage, prompts: current.prompts, structureDetail: current.structureDetail, appearanceReference: current.appearanceReference, appearance: current.appearance, origin: "ai-analysis" });
      if (!value.motions.length) value.motions = basicMotionSlots();
      if (value.width !== current.width || value.height !== current.height || (job.result.rig.sourceImage && job.result.rig.sourceImage !== current.sourceImage)) throw new Error("立绘已改变，请重新分析当前立绘。");
      if (current.joints.length) { setConfirmReset({ kind: "structure", document: value }); return; }
      commit(value); setJointId(value.joints[0]?.id || ""); setPartId(value.parts[0]?.id || ""); setSelectedParts(value.parts.map((item) => item.id)); setStep("structure"); setCanvasMode("overlay");
      setNotice("已应用 AI 结构。部件仍待补绘；idle / attack / hit 是待制作动作槽，请逐个生成或编辑。");
    } else if (job.kind === "motion") {
      if (!job.result?.motion) throw new Error("这项记录还没有可应用的动作结果。");
      if (isMotionStudyPlaybackActive(current.motionStudies?.[job.result.motion.id])) throw new Error("此动作使用逐帧部件，旧连续骨骼候选不会改变当前画面；请打开动作画面重制。");
      commit(replaceRigMotion(current, job.result.motion)); setMotionId(job.result.motion.id); setStep("motion"); setPoseIndex(0); setNotice("已替换此动作，部件、绑定、网格与权重保持。");
    } else {
      const images = await assertRigPartJobMatches(current, job); if (!images.length) throw new Error("还没有可应用的补绘图片。");
      const replacements = new Map(), seen = new Set();
      for (const image of images) {
        const target = current.parts.find((item) => item.id === image.partId);
        if (!target || seen.has(target.id) || image.width !== target.width || image.height !== target.height || image.canvasWidth !== current.width || image.canvasHeight !== current.height) throw new Error("部件映射或图片尺寸与当前骨架不一致，未应用。");
        seen.add(target.id);
        if (image.id && target.imageGeneration?.jobId === job.id && target.imageGeneration?.imageId === image.id) continue;
        const bytes = await client.image(job.id, image);
        const ready = await readRigPartCandidate(bytes, { expectedWidth: target.width, expectedHeight: target.height });
        replacements.set(target.id, { image: ready.dataURL, imageGeneration: { jobId: job.id, imageId: image.id, partId: image.partId, parentJobId: job.parentJobId,
          sourceFingerprint: job.sourceFingerprint, provider: image.provider || (typeof job.provider === "string" ? job.provider : job.provider?.id || job.provider?.label), model: job.model, controllerModel: image.controllerModel, createdAt: job.createdAt,
          logical: { width: image.width, height: image.height, url: image.url }, ...(image.raw ? { raw: { ...image.raw } } : {}) } });
      }
      if (!alive.current || documentRef.current !== current) return;
      if (!replacements.size) { setNotice("这些候选已应用，保留当前部件图片及后续校准。"); return; }
      commit({ ...current, parts: current.parts.map((item) => {
        if (!replacements.has(item.id)) return item;
        const next = { ...item, ...replacements.get(item.id), imageSource: "ai", completion: "ready" }; delete next.registrationBase; delete next.registration; return next;
      }) });
      setStep("binding"); setPartId(images[0].partId); setNotice(`已应用 ${replacements.size} 个透明补绘部件，请检查边缘、关节与权重。`);
    }
  });
  const uploadPart = (file) => perform("读取独立部件", async () => {
    const id = partUploadTarget.current, current = documentRef.current;
    const image = await readRigImage(file, { requireTransparent: true, maxDimension: 4096 });
    if (alive.current && documentRef.current === current) { patchPart(id, { image: image.dataURL, imageSource: "uploaded", completion: "ready", registrationBase: undefined, registration: undefined, imageGeneration: undefined }); setNotice("已载入独立透明图片。它会映射到当前部件矩形，请检查位置与遮挡。"); }
  });
  const openCalibration = () => perform("准备部件校准", async () => {
    if (running) throw new Error("请等待当前 AI 任务完成或取消，再校准图片。");
    const current = documentRef.current, session = await createRigPartCalibration(current, part.id);
    if (alive.current && documentRef.current === current) { setCalibrationError(""); setCalibration(session); }
  });
  const applyCalibration = async (edit) => {
    if (!calibration || busyRef.current) return;
    busyRef.current = true; setBusy("烘焙部件校准"); setCalibrationError("");
    try {
      if (running) throw new Error("AI 任务正在进行，请先完成任务后再应用校准。");
      const current = documentRef.current;
      if (current !== calibration.document) throw new Error("骨架草稿已改变，请取消后重新打开此部件校准。");
      const next = await bakeRigPartCalibration(current, calibration.partId, edit);
      if (!alive.current) return;
      if (documentRef.current !== current) throw new Error("骨架草稿已改变，校准尚未应用。请重新打开此部件。");
      commit(next); setCalibration(null); setCanvasMode("overlay"); setPreview(null); setPreviewDocument(null);
      setNotice("部件图片校准已烘焙，关节、矩形、网格权重和动作保持。请更新动画预览检查接缝。");
    } catch (failure) { if (alive.current) setCalibrationError(`校准尚未应用：${failure.message}`); }
    finally { busyRef.current = false; if (alive.current) setBusy(""); }
  };
  const selectMotion = (id) => { setMotionId(id); setPoseIndex(0); clock.seek(0); setPosition(0); };
  const locatePartAppearance = (id, requestedTime) => {
    if (locked) return;
    const target = documentRef.current.motions.find((item) => item.id === id);
    if (!target || !Number.isFinite(requestedTime)) return;
    const time = clamp(requestedTime, 0, target.duration);
    setStep("motion"); setRegistrationOpen(false); setCanvasMode("overlay"); setPartGrid(true); setShowParts(true);
    clock.set({ playing: false }); setPlaying(false);
    if (motion?.id === id) {
      setPoseIndex(Math.max(0, target.poses.findLastIndex((item) => item.time <= time)));
      clock.seek(time); setPosition(time);
    } else { annotationSeek.current = { motionId: id, time }; setMotionId(id); }
  };
  const seekAnimation = (time, pause = false) => {
    if (pause || (motion && !motion.loop && time >= duration)) { clock.set({ playing: false }); setPlaying(false); }
    const seekTime = rigManualSeekTime(time, activeMotionStudy);
    clock.seek(seekTime); setPosition(seekTime);
  };
  const toggleAnimation = () => {
    if (!playing && motion && !motion.loop && clock.read() >= duration) clock.seek(0);
    clock.set({ playing: !playing }); setPlaying(!playing); setPosition(clock.read());
  };
  const addMotion = () => {
    const current = documentRef.current, preset = motionPresets[motionPreset];
    let id = preset ? motionPreset : makeId("motion"), suffix = 1;
    while (current.motions.some((item) => item.id === id)) id = `${motionPreset}-${++suffix}`;
    const duration = preset?.duration || 1;
    const value = { id, name: preset ? `${preset.name}${suffix > 1 ? ` ${suffix}` : ""}` : `自定义动作 ${current.motions.length + 1}`, duration, loop: Boolean(preset?.loop), description: preset?.description || "", origin: preset ? "manual-placeholder" : "manual",
      poses: [{ time: 0, angles: {}, root: { x: 0, y: 0 }, ease: "smooth" }, { time: duration, angles: {}, root: { x: 0, y: 0 }, ease: "smooth" }] };
    commit({ ...current, motions: [...current.motions, value] }); setMotionId(id); setStep("motion"); setPoseIndex(0);
    if (preset) setNotice(`已添加「${value.name}」待制作动作槽。请生成或编辑关键帧后再验证保存。`);
  };
  const selectPose = (index) => { setPoseIndex(index); if (motion) seekAnimation(motion.poses[index].time, true); };
  const inspectMotion = () => perform("检查动作", async () => { if (!motion) throw new Error("请先选择动作。"); const current = documentRef.current, result = await inspectRigMotion(current, motion.id); await buildPreview(current); if (alive.current) { setTestReport(result); setStep("preview"); setCanvasMode("preview"); } });
  const prepareStudy = async (id) => {
    const snapshot = documentRef.current, result = await prepareMotionStudyFrames(snapshot, id);
    if (!alive.current || documentRef.current !== snapshot) throw new Error("草稿已改变，逐帧检查结果未覆盖当前编辑。");
    const reports = new Map(result.report.frames.map((frame) => [frame.frameId, frame]));
    const study = result.document.motionStudies[id];
    study.frames = study.frames.map((frame) => ({ ...frame, composition: reports.get(frame.id)?.composition }));
    commit(result.document); setPreview(null); setPreviewDocument(null); return result.report;
  };
  const applyStudy = async (id) => {
    const snapshot = documentRef.current, result = await applyMotionStudy(snapshot, id), rendered = await buildPreview(result.document);
    if (!alive.current || documentRef.current !== snapshot) throw new Error("草稿已改变，逐帧动作尚未应用。");
    commit(result.document); setPreview(rendered.bundle); setPreviewDocument(result.document); setMotionId(id); setPoseIndex(0); setStep("motion"); setCanvasMode("preview");
    clock.set({ playing: false }); clock.seek(0); setPlaying(false); setPosition(0); setTestReport(null);
    setNotice("已应用选定动作的独立可见部件与真实 Spine 附件切换。idle 和其他动作保持；隐藏表面未补绘，连续补间未验收。请检查全部画面并完成导出回导。");
    return result.report;
  };
  const saveResource = () => perform("保存角色资源", async () => {
    const current = documentRef.current, state = rigReadiness(current);
    const pendingStudies = Object.entries(current.motionStudies || {}).filter(([, study]) => study.frames?.length && study.playback !== "reference" && !study.applied);
    if (pendingStudies.length) throw new Error(`动作画面计划尚未应用：${pendingStudies.map(([id]) => current.motions.find((motion) => motion.id === id)?.name || id).join("、")}。请完成画面审阅、坐标对应和逐帧应用，再正式保存；候选与草稿仍保留。`);
    if (!state.ready) throw new Error(`还有 ${state.pending.length} 个部件待补绘或上传。草稿已保留，完成独立部件后再保存为正常资源。`);
    if (!current.motions.length) throw new Error("请至少创建并验证一个动作。");
    if (current.motions.some((item) => item.origin === "manual-placeholder")) throw new Error("还有待制作的动作槽，请先生成或编辑对应关键帧。");
    for (const item of current.motions) {
      const report = await inspectRigMotion(current, item.id);
      if (!report.finite || report.issues.length) { if (alive.current) { setMotionId(item.id); setTestReport(report); setStep("preview"); } throw new Error(`动作「${item.name}」尚未通过检查：${report.issues.join("；") || "存在无效姿态"}。请调整关节、关键帧或握点，或关闭不适用的脚锁。`); }
    }
    const result = await buildPreview(current); await callbacks.current.onSave?.(result.document, result.bundle);
  });
  const changeStep = (id) => { setStep(id); if (id !== "binding") setManualAdjustment(false); if (id !== "binding") setRegistrationOpen(false); if (id !== "preview") setCanvasMode("overlay"); if (id === "preview" && document.joints.length) void showPreview(); };
  const vertex = mesh?.weights[Math.min(vertexIndex, mesh.weights.length - 1)] || [];
  const parentCandidates = document.joints.filter((candidate) => {
    if (!joint || candidate.id === joint.id) return false;
    const seen = new Set(); let current = candidate;
    while (current?.parent && !seen.has(current.id)) { if (current.parent === joint.id) return false; seen.add(current.id); current = document.joints.find((item) => item.id === current.parent); }
    return true;
  });
  const updateWeights = (id, value) => { try { const weights = [...vertex.filter((item) => item.joint !== id), { joint: id, weight: value }]; commit(setRigPartWeights(documentRef.current, part.id, vertexIndex, weights)); } catch (failure) { setError(failure.message); } };
  const toggleInfluence = (id, checked) => {
    const influences = checked ? [...new Set([...(part.influences || [part.bone]), id])] : (part.influences || [part.bone]).filter((item) => item !== id);
    if (!influences.length) { setError("至少保留一根影响骨骼。"); return; }
    if (influences.length > 8) { setError("每个网格最多选择 8 根影响骨骼。"); return; }
    const nextMesh = part.mesh ? { ...part.mesh } : undefined;
    if (nextMesh?.weights) nextMesh.weights = nextMesh.weights.map((weights) => { const kept = weights.filter((item) => influences.includes(item.joint)); const total = kept.reduce((sum, item) => sum + item.weight, 0); return total ? kept.map((item) => ({ ...item, weight: item.weight / total })) : [{ joint: influences[0], weight: 1 }]; });
    patchPart(part.id, { influences, ...(nextMesh ? { mesh: nextMesh } : {}) });
  };
  const addPose = () => {
    if (!motion || !pose) return;
    const times = [...new Set([0, ...motion.poses.map((item) => item.time), motion.duration])].sort((a, b) => a - b);
    let start = 0, gap = 0; for (let index = 1; index < times.length; index++) if (times[index] - times[index - 1] > gap) { start = times[index - 1]; gap = times[index] - start; }
    if (gap < 0.01) { setError("关键帧已足够密集，请先延长动作或调整现有帧。"); return; }
    const next = copyPose(pose, Math.round((start + gap / 2) * 1000) / 1000), poses = [...motion.poses, next].sort((a, b) => a.time - b.time);
    patchMotion({ poses }); setPoseIndex(poses.indexOf(next)); seekAnimation(next.time, true);
  };

  return <main className="rig-workbench" aria-label="新骨架与动作工作台">
    <input ref={sourceInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void changeSource(file); }} />
    <input ref={partInput} type="file" accept="image/png,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadPart(file); }} />
    <header className="rig-topbar"><button className="button subtle" disabled={Boolean(busy || calibration)} onClick={() => { if (!busyRef.current && !calibration) callbacks.current.onClose?.(); }}><ArrowLeft size={16} />返回资源</button>
      <label className="rig-name"><span>新骨架与动作</span><input aria-label="骨架资源名称" value={document.name} disabled={locked} onChange={(event) => commit({ ...documentRef.current, name: event.target.value }, false)} /></label>
      <span className="rig-draft-status" data-save-status={draftSaveStatus?.status} role={draftSaveStatus?.status === "failed" ? "alert" : "status"}>独立骨架草稿 · {typeof draftSaveStatus?.message === "string" && draftSaveStatus.message || ({ idle: "自动保存", pending: "待保存", saving: "保存中", saved: "已保存", failed: "保存失败" }[draftSaveStatus?.status] || "自动保存")}</span>
      <div className="rig-history-controls"><button className="icon-button" aria-label="撤销骨架修改" disabled={locked || !undo.current.length} onClick={() => { const value = undo.current.pop(); if (value) { redo.current.push(documentRef.current); commit(value, false); updateHistory((count) => count + 1); } }}><Undo2 size={17} /></button><button className="icon-button" aria-label="重做骨架修改" disabled={locked || !redo.current.length} onClick={() => { const value = redo.current.pop(); if (value) { undo.current.push(documentRef.current); commit(value, false); updateHistory((count) => count + 1); } }}><Redo2 size={17} /></button></div>
      <button className="button primary" disabled={locked || !readiness.ready || !document.motions.length} onClick={() => void saveResource()}><Save size={16} />{saveHint ? "另存为新资源" : "保存为角色资源"}</button>
    </header>
    <nav className="rig-steps" aria-label="骨架制作步骤">{steps.map(({ id, label, icon: Icon }, index) => <button key={id} aria-current={step === id ? "step" : undefined} disabled={Boolean(busy || calibration)} onClick={() => changeStep(id)}><span>{index + 1}</span><Icon size={16} />{label}</button>)}</nav>
    {saveHint && <div className="rig-save-hint" role="note">{saveHint}</div>}
    {(running || job) && <div className="rig-task-banner" role="status">{running && <LoaderCircle size={14} className="spin" />}<span>{kindLabels[(running || job).kind]} · {statusLabels[(running || job).status] || (running || job).status}</span>{running && <><progress max={Math.max(1, running.total || 1)} value={running.completed || 0} /><small>{running.completed || 0}/{running.total || 1}</small></>}<button className="button subtle" onClick={() => jobSection.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>{running ? "查看任务" : "查看候选与结果"}</button></div>}
    {error && <div className="rig-message rig-error" role="alert">{error}<button className="button subtle" onClick={() => setError("")}>关闭</button></div>}
    {sampledPose.error && <div className="rig-message rig-error" role="alert">当前关键帧需要调整：{sampledPose.error}</div>}
    {notice && <div className="rig-message" role="status">{notice}</div>}
    {pendingSource && <div className="rig-confirm"><strong>用新立绘重新开始？</strong><p>当前结构、部件和动作仍保存在原草稿；新立绘将建立另一份骨架草稿。</p><div className="button-row"><button className="button" onClick={() => setPendingSource(null)}>保留当前草稿</button><button className="button primary" onClick={() => { commit(pendingSource); setPendingSource(null); setPreview(null); setJobs([]); setJob(null); setStep("structure"); setCanvasMode("overlay"); }}>使用新立绘</button></div></div>}
    {confirmReset && <div className="rig-confirm"><strong>{confirmReset.kind === "appearance" ? "应用 Q 版形象并重建骨架？" : confirmReset.kind === "structure" ? "应用新的 AI 结构？" : "替换为程序初稿？"}</strong><p>{confirmReset.kind === "appearance" ? "新的角色比例需要重新分析。确认后会清空当前关节、部件绑定和动作；原始参考与生成来源会保留，可用撤销恢复。" : "这会替换当前关节、部件绑定和动作。当前版本可用撤销恢复，草稿会更新。"}</p><div className="button-row"><button className="button" onClick={() => setConfirmReset(null)}>取消</button><button className="button primary" onClick={() => { if (confirmReset.kind === "appearance") { if (documentRef.current !== confirmReset.source) { setError("草稿已修改，请重新确认应用形象候选。"); setConfirmReset(null); return; } useAppearance(confirmReset.document); } else if (confirmReset.kind === "structure") { const next = confirmReset.document; commit(next); setSelectedParts(next.parts.map((item) => item.id)); setJointId(next.joints[0]?.id || ""); setPartId(next.parts[0]?.id || ""); setStep("structure"); setCanvasMode("overlay"); setPreview(null); setConfirmReset(null); } else programDraft(); }}>{confirmReset.kind === "appearance" ? "应用形象并重建" : "确认替换结构"}</button></div></div>}

    <div className="rig-workspace">
      <aside className="rig-library">
        <section className="rig-source-section"><h2>角色立绘</h2><button className="rig-source-upload" disabled={locked} onClick={() => sourceInput.current.click()}>{document.sourceImage ? <img src={document.sourceImage} alt="角色立绘" /> : <ImagePlus size={30} />}<span>{document.sourceImage ? "替换立绘" : "导入 PNG / JPEG / WebP"}</span></button><small>{document.width} × {document.height} · 坐标向右、向下</small></section>
        <div className="rig-collection-heading"><h3>{step === "structure" ? "关节层级" : step === "motion" || step === "preview" ? "动作" : "独立部件"}</h3><span>{step === "structure" ? document.joints.length : step === "motion" || step === "preview" ? document.motions.length : `${readiness.completed}/${readiness.total}`}</span></div>
        <div className="rig-object-list">
          {step === "structure" ? document.joints.map((item) => <button key={item.id} className={joint?.id === item.id ? "selected" : ""} onClick={() => setJointId(item.id)}><Bone size={15} /><span><strong>{item.label || item.id}</strong><small>{item.parent ? `父级 ${document.joints.find((parent) => parent.id === item.parent)?.label || item.parent}` : "根关节"}</small></span></button>)
            : step === "motion" || step === "preview" ? document.motions.map((item) => <button key={item.id} className={motion?.id === item.id ? "selected" : ""} onClick={() => selectMotion(item.id)}><Play size={14} /><span><strong>{item.name}</strong><small>{item.duration}s · {item.poses.length} 帧{item.origin === "procedural-draft" ? " · 程序初稿" : item.origin === "manual-placeholder" ? " · 待制作" : ""}</small></span></button>)
              : document.parts.map((item) => <div className={`rig-part-row${part?.id === item.id ? " selected" : ""}`} key={item.id}><input type="checkbox" aria-label={`选择补绘 ${item.label || item.id}`} disabled={locked} checked={selectedParts.includes(item.id)} onChange={(event) => setSelectedParts((current) => event.target.checked ? [...new Set([...current, item.id])] : current.filter((id) => id !== item.id))} /><button onClick={() => selectEditablePart(item.id)}>{item.image ? <img src={item.image} alt="" /> : <Layers size={20} />}<span><strong>{item.label || item.id}</strong><small className={item.image && item.completion === "ready" ? "is-ready" : "is-pending"}>{item.image && item.completion === "ready" ? item.imageSource === "ai" ? "AI 补绘" : "独立图片" : "待补绘 · 原图裁片"}</small>{item.attachmentGroup && <small>{attachmentGroupLabels[item.attachmentGroup] || item.attachmentGroup} · {attachmentGroups.find((group) => group.id === item.attachmentGroup)?.defaultPartId === item.id ? "默认" : "可切换附件"}</small>}</span></button></div>)}
          {!(step === "structure" ? document.joints.length : step === "motion" || step === "preview" ? document.motions.length : document.parts.length) && <div className="rig-list-empty">{document.sourceImage ? "先分析结构或明确创建程序人形初稿。" : "先导入一张角色立绘。"}</div>}
        </div>
        <div className="rig-library-footer">{step === "structure" ? <button className="button" disabled={locked || !document.joints.length} onClick={() => { const id = makeId("joint"); const parent = joint || document.joints[0]; commit({ ...document, joints: [...document.joints, { id, label: `新关节 ${document.joints.length + 1}`, parent: parent.id, x: clamp(parent.x + 20, 0, document.width), y: clamp(parent.y + 20, 0, document.height) }] }); setJointId(id); }}><Plus size={14} />添加关节</button>
          : step === "motion" || step === "preview" ? <div className="rig-motion-adder"><select aria-label="新动作预设" disabled={locked || !document.joints.length} value={motionPreset} onChange={(event) => setMotionPreset(event.target.value)}><option value="custom">自定义动作</option>{Object.entries(motionPresets).map(([id, preset]) => <option key={id} value={id}>{preset.name} · {preset.duration}s{preset.loop ? " · 循环" : ""}</option>)}</select><button className="button" disabled={locked || !document.joints.length} onClick={addMotion}><Plus size={14} />添加动作</button></div>
            : <div className="rig-part-adder"><label>新增部件显示组<select aria-label="新增部件显示组" disabled={locked} value={newPartGroup} onChange={(event) => setNewPartGroup(event.target.value)}><option value="">普通独立层</option>{groupIds.map((id) => <option key={id} value={id}>{attachmentGroupLabels[id] || id}</option>)}</select></label><div className="button-row"><button className="button" disabled={locked || !document.parts.length} onClick={() => setSelectedParts(document.parts.filter((item) => !item.image).map((item) => item.id))}>选择待补绘</button><button className="button" disabled={locked || !document.joints.length} onClick={() => addPart()}><Plus size={14} />添加部件</button></div></div>}</div>
      </aside>

      <section className="rig-stage">
        <div className="rig-stage-toolbar"><strong>{registrationOpen ? "原图网格与部件坐标对齐" : manualAdjustment ? "手动调整 · 基准姿势" : canvasMode === "preview" ? "骨架动画预览" : step === "binding" ? "绑定与网格叠图" : step === "motion" ? "动作姿态叠图" : "立绘与关节叠图"}</strong><div className="button-row"><button className={`button${manualAdjustment ? " accent" : ""}`} aria-pressed={manualAdjustment} disabled={locked || !document.parts.length} onClick={() => manualAdjustment ? setManualAdjustment(false) : enterManualAdjustment()}><Move size={15} />手动调整</button><button className="button" disabled={locked || !document.sourceImage || !document.parts.length} onClick={() => registrationOpen ? setRegistrationOpen(false) : openRegistration()}><ScanLine size={15} />{registrationOpen ? "关闭坐标对比" : "原图坐标对齐"}</button><button className={`button subtle${canvasMode === "overlay" ? " active" : ""}`} onClick={() => setCanvasMode("overlay")}><ScanLine size={15} />叠图</button><button className="button" disabled={locked || !document.joints.length} onClick={() => void showPreview()}><Eye size={15} />{previewDocument === document ? "动画预览" : "更新动画预览"}</button></div></div>
        {canvasMode === "overlay" && !registrationOpen && <div className="rig-overlay-options"><label><input type="checkbox" checked={showImage} onChange={(event) => setShowImage(event.target.checked)} />显示原立绘</label><label><input type="checkbox" checked={showParts} onChange={(event) => setShowParts(event.target.checked)} />显示部件矩形</label><label><input type="checkbox" checked={partGrid} onChange={(event) => setPartGrid(event.target.checked)} />部件网格标注</label>{mesh && <span>蓝 → 黄：所选骨骼权重由低到高</span>}{Object.keys(attachmentPreview).length > 0 && step !== "motion" && <><span>临时附件预览 · 未修改默认</span><button className="button subtle" onClick={() => setAttachmentPreview({})}>恢复默认表情</button></>}</div>}
        {registrationOpen && <div className="rig-registration-toolbar"><select aria-label="原图坐标对齐视图" value={registrationView} onChange={(event) => setRegistrationView(event.target.value)}><option value="overlay">原图 / 组装叠加</option><option value="source">原图</option><option value="assembled">组装结果</option><option value="owners" disabled={!activeRegistrationCandidate?.ownerDataURL}>像素归属图</option></select><button className="button subtle" disabled={!part} onClick={() => setRegistrationFocus(!registrationFocus)}>{registrationFocus ? "显示整图" : "查看选中部件细节"}</button><label><input aria-label="仅显示所选部件" type="checkbox" checked={registrationOnlySelected} onChange={(event) => setRegistrationOnlySelected(event.target.checked)} />仅显示所选部件</label><label><input type="checkbox" checked={registrationGrid} onChange={(event) => setRegistrationGrid(event.target.checked)} />32px 网格</label>{registrationView === "overlay" && <label>组装透明度<input aria-label="坐标对比组装透明度" type="range" min="0" max="1" step="0.05" value={registrationOpacity} onChange={(event) => setRegistrationOpacity(Number(event.target.value))} /></label>}<span>绿：原图轮廓 · 粉：当前部件图透明轮廓</span></div>}
        <div className="rig-stage-canvas" data-rig-preview>{canvasMode === "preview" && preview
          ? <SpineViewer bundle={preview} clock={runtimeClock} animation={preview.animations.includes(motion?.id) ? motion.id : preview.animations[0]} loop={Boolean(motion?.loop)} skin={preview.skins[0]} label="新骨架动作预览" />
          : <RigCanvas document={registrationOpen && activeRegistrationCandidate ? activeRegistrationCandidate.document : registrationOpen ? document : overlayDocument} selectedJoint={joint?.id} selectedPart={part?.id} selectedVertex={vertexIndex} mesh={manualAdjustment ? null : mesh} partAnnotation={partGrid && !registrationOpen && !manualAdjustment ? { motionName: motion?.name, time: resolvedTime } : null} pose={registrationOpen ? null : displayedPose} visiblePartIds={setupVisiblePartIds} registration={registrationOpen ? { mode: registrationView, grid: registrationGrid, opacity: registrationOpacity, focus: registrationFocus, onlySelected: registrationOnlySelected, polygons: registrationPolygons, assembly: activeRegistrationCandidate?.previewDataURL || registrationAssembly, owners: activeRegistrationCandidate?.ownerDataURL, alphaPart: part, alphaBounds: registrationAlpha } : null} selectedPolygonVertex={registrationVertex} onSelectPolygonVertex={setRegistrationVertex} onBeginPolygonMove={rememberContour} onMovePolygonVertex={moveContourVertex} showParts={showParts} showImage={showImage} disabled={locked} editingTool={manualAdjustment ? "parts" : "joints"} onBeginPartMove={beginPartMove} onMovePart={(id, x, y) => adjustPart(id, x, y, false)} onEndPartMove={() => { partGesture.current = null; }} onCancelPartMove={cancelPartMove} onSelectJoint={setJointId} onSelectPart={selectEditablePart} onSelectVertex={setVertexIndex} onBeginMove={remember} onMoveJoint={(id, x, y) => patchJoint(id, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }, false)} />}</div>
        {canvasMode === "preview" && previewDocument !== document && <p className="rig-preview-warning">骨架或动作已修改，请更新预览后再检查。</p>}
        {!readiness.ready && <p className="rig-preview-warning">原图裁片与占位仅供校对 · 还有 {readiness.pending.length} 个部件待补绘</p>}
        <div className="rig-playback"><button className="rig-play-button" aria-label={playing ? "暂停骨架动画" : "播放骨架动画"} disabled={!motion} onClick={toggleAnimation}>{playing ? <Pause size={18} /> : <Play size={18} />}</button><select aria-label="骨架预览动作" value={motion?.id || ""} disabled={!document.motions.length} onChange={(event) => selectMotion(event.target.value)}>{document.motions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input type="range" aria-label="骨架动画时间" min="0" max={duration} step="0.01" value={resolvedTime} disabled={!motion} onChange={(event) => seekAnimation(activeMotionStudy ? rigTimelineInputTime(Number(event.target.value)) : Number(event.target.value))} /><span>{resolvedTime.toFixed(2)} / {duration.toFixed(2)}s</span></div>
        <div className="rig-stage-footnote">{manualAdjustment ? "选择部件后拖动金色手柄 · 方向键 1px · Shift 10px · Esc 取消拖动" : step === "structure" ? "拖动圆点纠正关节 · 方向键微调 · Shift 加速" : step === "binding" ? "点选网格顶点，在右侧调整真实导出权重" : "切换动作沿用同一预览镜头"}<span>{document.origin === "procedural-draft" ? "程序人形初稿 · 需人工校对" : "自建骨架"}</span></div>
      </section>

      <aside className="rig-inspector">
        <section className="rig-ai-connection"><Sparkles size={17} /><div><strong>AI 结构 / 动作：Codex 账号</strong><small>{plannerStatus?.connected ? "已连接" : plannerStatus ? "需要连接 Codex 账号" : "正在检查连接"} · 补绘：{connectionStatus?.label || "当前图像服务"}</small></div>{onOpenConnection && <button className="button subtle" onClick={onOpenConnection}>设置</button>}</section>
        <fieldset disabled={locked}>
          {registrationOpen && <section className="rig-control-group rig-registration-panel" ref={registrationPanel}><h2>原图坐标对齐</h2><p className="rig-hint">网格、矩形与轮廓统一使用原图像素坐标。当前图的透明边距与缩放会改变衣服、腿部体积；不要把原图轮廓压细塞进偏小的框。</p>
            <label className="rig-field">坐标规划说明<textarea aria-label="坐标对应规划说明" rows={3} maxLength={4000} value={document.prompts?.registration ?? registrationDefaultPrompt} onChange={(event) => commit({ ...documentRef.current, prompts: { ...documentRef.current.prompts, registration: event.target.value } }, false)} /></label>
            <div className="button-row"><button className="button primary" disabled={!document.sourceImage || !document.parts.length || plannerStatus?.connected === false} onClick={() => startJob("registration")}><Sparkles size={14} />生成坐标对应</button><button className="button" disabled={!rigDefaultVisiblePartIds(document).every((id) => document.parts.find((item) => item.id === id)?.sourcePolygon)} onClick={loadSavedContours}>载入已保存轮廓</button></div><p className="rig-hint">Codex 只规划默认可见部件的原图坐标，不重画角色。候选需先审阅，再计算像素对齐效果。</p>
            {registrationStage && !registrationStageCurrent && !activeRegistrationCandidate && <p className="rig-pending-note" role="alert">草稿已改变。请重新查看原坐标任务核对快照，已有候选不会覆盖当前修改。</p>}
            {registrationStageCurrent && <><label className="rig-field">轮廓部件<select aria-label="坐标对齐部件" value={registrationPolygons[part?.id] ? part.id : ""} onChange={(event) => setPartId(event.target.value)}><option value="" disabled>选择默认可见部件</option>{Object.keys(registrationPolygons).map((id) => <option key={id} value={id}>{document.parts.find((item) => item.id === id)?.label || id}</option>)}</select></label>
              {selectedPolygon.length > 0 && <><label className="rig-field">轮廓顶点<select aria-label="坐标轮廓顶点" value={Math.min(registrationVertex, selectedPolygon.length - 1)} onChange={(event) => setRegistrationVertex(Number(event.target.value))}>{selectedPolygon.map((point, index) => <option key={index} value={index}>{index + 1} · {point.x}, {point.y}</option>)}</select></label><div className="rig-field-grid"><NumberField label="轮廓顶点 X" value={selectedPolygon[Math.min(registrationVertex, selectedPolygon.length - 1)].x} min={0} max={document.width} step={0.1} onChange={(value) => { rememberContour(); moveContourVertex(part.id, Math.min(registrationVertex, selectedPolygon.length - 1), value, selectedPolygon[Math.min(registrationVertex, selectedPolygon.length - 1)].y); }} /><NumberField label="轮廓顶点 Y" value={selectedPolygon[Math.min(registrationVertex, selectedPolygon.length - 1)].y} min={0} max={document.height} step={0.1} onChange={(value) => { rememberContour(); moveContourVertex(part.id, Math.min(registrationVertex, selectedPolygon.length - 1), selectedPolygon[Math.min(registrationVertex, selectedPolygon.length - 1)].x, value); }} /></div>
                <div className="button-row"><button className="button" disabled={selectedPolygon.length >= 256} onClick={() => { rememberContour(); const index = Math.min(registrationVertex, selectedPolygon.length - 1), a = selectedPolygon[index], b = selectedPolygon[(index + 1) % selectedPolygon.length], points = [...selectedPolygon]; points.splice(index + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); setRegistrationStage({ ...registrationStage, polygons: { ...registrationPolygons, [part.id]: points } }); setRegistrationVertex(index + 1); setRegistrationCandidate(null); }}>插入轮廓顶点</button><button className="button" disabled={selectedPolygon.length <= 3} onClick={() => { rememberContour(); setRegistrationStage({ ...registrationStage, polygons: { ...registrationPolygons, [part.id]: selectedPolygon.filter((_, index) => index !== registrationVertex) } }); setRegistrationVertex(0); setRegistrationCandidate(null); }}>删除轮廓顶点</button></div></>}
              <div className="button-row"><button className="button" disabled={!contourUndo.current.length} aria-label="撤销轮廓修改" onClick={() => { const polygons = contourUndo.current.pop(); if (polygons) { setRegistrationStage({ ...registrationStage, polygons }); setRegistrationCandidate(null); setRegistrationVertex(0); } }}>撤销轮廓</button><button className="button" onClick={saveContours}>保存轮廓草稿</button></div>
              {registrationAlpha && <p className="rig-hint">当前独立图可见范围：{registrationAlpha.width.toFixed(1)} × {registrationAlpha.height.toFixed(1)} px，起点 {registrationAlpha.x.toFixed(1)}, {registrationAlpha.y.toFixed(1)}。粉色轮廓直接来自图片 Alpha。</p>}
              {selectedRegistrationBounds && <p className={selectedRegistrationBounds.needsExpansion ? "rig-pending-note" : "rig-hint"}>部件框 {selectedRegistrationBounds.currentBounds.width} × {selectedRegistrationBounds.currentBounds.height} → 所需 {selectedRegistrationBounds.requiredBounds.width} × {selectedRegistrationBounds.requiredBounds.height}，起点 {selectedRegistrationBounds.requiredBounds.x}, {selectedRegistrationBounds.requiredBounds.y}。</p>}
              {registrationBounds?.parts.some((item) => item.needsExpansion) && <p className="rig-pending-note">{registrationBounds.parts.filter((item) => item.needsExpansion).length} 个部件框需要扩展，原图轮廓保持原尺寸。</p>}<div className="button-row"><button className="button" disabled={!registrationBounds || registrationBounds.parts.some((item) => item.needsExpansion)} onClick={() => checkRegistration(false)}>检查对齐效果</button><button className="button" disabled={!registrationBounds} onClick={() => checkRegistration(true)}>扩展框并检查对齐效果</button></div><p className="rig-hint">明确扩框会在临时候选中补透明边距，并处理框外的近透明源像素，保持旧 AI 像素世界坐标与网格权重。确认应用时才更新草稿。</p>
            </>}
            {activeRegistrationCandidate && <><p className="rig-ready-note">{activeRegistrationCandidate.document === document ? "已应用的原图像素对齐" : "临时像素候选 · 尚未应用"}</p><RegistrationMetrics metrics={activeRegistrationCandidate.metrics} /><button className="button primary" disabled={registrationCandidate?.baseDocument !== document} onClick={applyRegistration}>{activeRegistrationCandidate.document === document ? "已应用原图坐标对齐" : activeRegistrationCandidate.expanded ? "应用原图坐标对齐（含扩框）" : "应用原图坐标对齐"}</button></>}
            {document.registration?.metrics && !activeRegistrationCandidate && <RegistrationMetrics metrics={document.registration.metrics} />}
            {selectedRegistrationDiagnostic && <p className="rig-hint">计算时原图可见包络 {selectedRegistrationDiagnostic.sourceVisibleBounds?.width ?? "—"} × {selectedRegistrationDiagnostic.sourceVisibleBounds?.height ?? "—"} px；AI 底图 Alpha 包络 {selectedRegistrationDiagnostic.aiAlphaBounds?.width ?? "—"} × {selectedRegistrationDiagnostic.aiAlphaBounds?.height ?? "—"} px。宽 / 高比例 {Number.isFinite(selectedRegistrationDiagnostic.aiToSourceWidthRatio) ? selectedRegistrationDiagnostic.aiToSourceWidthRatio.toFixed(3) : "—"} / {Number.isFinite(selectedRegistrationDiagnostic.aiToSourceHeightRatio) ? selectedRegistrationDiagnostic.aiToSourceHeightRatio.toFixed(3) : "—"}。</p>}
            {(activeRegistrationCandidate?.document.registration || document.registration)?.lowAlphaCoverage && <p className="rig-hint">显式扩框保留框外近透明源像素 {(activeRegistrationCandidate?.document.registration || document.registration).lowAlphaCoverage.retainedPixels ?? "—"} 个；本次新增 {(activeRegistrationCandidate?.document.registration || document.registration).lowAlphaCoverage.addedThisOperation ?? "—"} 个。丢弃源像素 {(activeRegistrationCandidate?.document.registration || document.registration)?.visibleNoise?.sourcePixelsDiscarded ?? "—"} 个。</p>}
            {selectedRegistrationPixels && <p className="rig-hint">对齐计算时：此部件原图归属锁定 {selectedRegistrationPixels.lockedPixels ?? "—"} px（计算时可见 {selectedRegistrationPixels.visibleLockedPixels ?? "—"}）；AI 隐藏补绘 {selectedRegistrationPixels.hiddenPixels ?? "—"} px（计算时可见 {selectedRegistrationPixels.visibleHiddenPixels ?? "—"}）。</p>}
            {document.registration?.metrics && <p className={registrationMeasurement?.document === document && registrationMeasurement.matches ? "rig-hint" : "rig-pending-note"}>{registrationMeasurement?.document === document && registrationMeasurement.matches ? "应用时测量；当前默认组装图片与框未变。关节和动作编辑不影响此设置姿态像素报告。" : "应用时测量；图片或几何已变动或尚未重新核对，需重新检查。历史指标不代表当前组装已通过。"}</p>}
          </section>}
          {step === "parts" && <section className="rig-control-group"><h2>完整重叠部件</h2><p className="rig-hint">查看完整脸底、接头与隐藏表面。逐件审阅独立图片和可见轮廓，再检查重叠组装；保留可撤销的对齐候选。</p><button className="button primary" disabled={locked || !document.parts.length} onClick={() => setCompleteOverlapOpen(true)}>审阅完整重叠部件</button></section>}
          {step === "structure" && <>
            <section className="rig-control-group rig-appearance-card"><h2>参考图转 Q 版形象</h2><p className="rig-hint">先导入身份参考，再生成适合拆分与骨骼动画的 Q 版立绘。已有合适的 Q 版立绘也可直接分析结构。</p>
              {document.appearanceReference && <div className="rig-appearance-reference"><img src={document.appearanceReference.image} alt="保留的原始参考图" /><div><strong>原始身份参考 · 已保留</strong><small>{document.appearanceReference.name || "导入的参考图"}<br />{document.appearanceReference.width} × {document.appearanceReference.height}</small></div></div>}
              <label className="rig-field">形象与画风说明<textarea aria-label="Q 版形象生成说明" maxLength={4000} rows={5} value={appearancePrompt} onChange={(event) => setAppearancePrompt(event.target.value)} /></label>
              <button className="button primary" disabled={!document.sourceImage || connectionStatus?.connected === false} onClick={() => void startJob("appearance")}><Sparkles size={15} />生成 Q 版形象</button>
              <p className="rig-hint">使用当前立绘作为身份参考 · {connectionStatus?.label || "当前图像服务"}。生成后先确认候选，再分析骨架。</p>
              {document.appearance && <p className="rig-ready-note">已应用 AI Q 版形象 · {document.appearance.providerLabel || document.appearance.provider || "图像服务"}。原图与提示词可随工程恢复。</p>}
            </section>
            <section className="rig-control-group"><h2>分析角色结构</h2><p className="rig-hint">AI 识别新的骨架与部件，不套用已有模板。结果需要你确认应用，再校正关节。</p><label className="rig-field">部件精细度<select aria-label="结构部件精细度" value={structureDetail} onChange={(event) => commit({ ...documentRef.current, structureDetail: event.target.value }, false)}><option value="detailed">精细 · 24–40 个部件</option><option value="standard">标准 · 12–18 个部件</option></select></label><p className="rig-hint">{structureDetail === "detailed" ? "按活动边界细分，手掌与前臂分开，最多 64 个部件。改变选项不会重建当前草稿；重新分析后仍需确认应用。" : "适合简单角色，最多 18 个部件。改变选项不会重建当前草稿。"}</p><label className="rig-field">结构说明<textarea aria-label="AI 结构分析说明" maxLength={4000} rows={3} value={structurePrompt} onChange={(event) => setStructurePrompt(event.target.value)} /></label><button className="button primary" disabled={!document.sourceImage || plannerStatus?.connected === false} onClick={() => void startJob("structure")}><Sparkles size={15} />AI 结构分析</button><button className="button" disabled={!document.sourceImage} onClick={() => document.joints.length ? setConfirmReset({ kind: "program" }) : programDraft()}>先用程序人形初稿</button><p className="rig-hint">程序初稿按比例放置关节，不代表识别了立绘，也不代表部件已补全。</p></section>
            {joint && <section className="rig-control-group"><h3>关节校准</h3><label className="rig-field">关节名称<input aria-label="关节名称" value={joint.label || joint.id} onChange={(event) => patchJoint(joint.id, { label: event.target.value })} /></label><label className="rig-field">父级<select aria-label="关节父级" value={joint.parent || ""} disabled={!joint.parent} onChange={(event) => patchJoint(joint.id, { parent: event.target.value })}>{!joint.parent && <option value="">根关节</option>}{parentCandidates.map((item) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select></label><div className="rig-field-grid"><NumberField label="关节 X" value={joint.x} min={0} max={document.width} step={0.1} onChange={(x) => patchJoint(joint.id, { x })} /><NumberField label="关节 Y" value={joint.y} min={0} max={document.height} step={0.1} onChange={(y) => patchJoint(joint.id, { y })} /></div><p className="rig-hint">骨段长度 {(() => { const parent = document.joints.find((item) => item.id === joint.parent); return parent ? Math.hypot(joint.x - parent.x, joint.y - parent.y).toFixed(1) : "0.0"; })()} px · 坐标为立绘画布坐标</p></section>}
          </>}

          {(step === "parts" || step === "binding") && part && <>
            {manualAdjustment && <section className="rig-control-group rig-manual-controls" aria-label="手动调整部件">
              <h2><Move size={17} />手动调整</h2><strong>{part.label || part.id}</strong>
              <p className="rig-hint">先从左侧选部件，再拖动金色手柄。这里修改基准位置，所有连续骨骼动作都会使用调整后的部件。</p>
              {!part.image || part.imageSource === "placeholder" || part.imageSource === "source-crop" ? <p className="rig-pending-note">先为这个部件补绘或上传独立图片，再调整位置。</p> : <>
                <div className="rig-field-grid"><NumberField label="部件位置 X" value={part.x} min={0} max={Math.max(0, document.width - part.width)} step={0.1} disabled={locked} onChange={(x) => adjustPart(part.id, x, part.y)} /><NumberField label="部件位置 Y" value={part.y} min={0} max={Math.max(0, document.height - part.height)} step={0.1} disabled={locked} onChange={(y) => adjustPart(part.id, part.x, y)} /></div>
                <div className="button-row"><button className="button" disabled={locked} onClick={() => resizeSelectedPart(0.95)}>缩小 5%</button><button className="button" disabled={locked} onClick={() => resizeSelectedPart(1.05)}>放大 5%</button><span className="rig-hint">等比缩放 · 原图保留</span></div>
                <NumberField label="部件前后层级" value={part.z} min={-1000} max={1000} disabled={locked} onChange={(z) => patchPart(part.id, { z: Math.round(z) })} />
              </>}
              <p className="rig-hint">隐藏附件只做临时显示，不改变默认表情。可用顶部撤销 / 重做恢复；完成后更新动画预览，再保存角色资源。</p>
            </section>}
            <section className="rig-control-group"><h2>{part.label || part.id}</h2><p className={part.image && part.completion === "ready" ? "rig-ready-note" : "rig-pending-note"}>{part.image && part.completion === "ready" ? "已有独立透明图片" : "待补绘：矩形裁片可能缺少被遮挡内容"}</p><label className="rig-field">部件名称<input aria-label="部件名称" value={part.label || part.id} onChange={(event) => patchPart(part.id, { label: event.target.value })} /></label><label className="rig-field">绑定骨骼<select aria-label="部件绑定骨骼" value={part.bone} onChange={(event) => patchPart(part.id, { bone: event.target.value, influences: [event.target.value], mesh: undefined, grip: undefined })}>{document.joints.map((item) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select></label>{!manualAdjustment && <div className="rig-field-grid">{["x", "y", "width", "height", "z"].map((field) => <NumberField key={field} label={{ x: "矩形 X", y: "矩形 Y", width: "矩形宽", height: "矩形高", z: "遮挡层级" }[field]} value={part[field]} min={field === "z" ? -1000 : ["width", "height"].includes(field) ? 1 : 0} max={field === "z" ? 1000 : ["x", "width"].includes(field) ? document.width : document.height} onChange={(value) => patchPart(part.id, { [field]: Math.round(value) })} />)}</div>}<button className="button" onClick={() => { partUploadTarget.current = part.id; partInput.current.click(); }}><Upload size={14} />上传独立透明部件</button>{part.image && ["uploaded", "ai", "calibrated"].includes(part.imageSource) && part.completion === "ready" && <button className="button" disabled={locked} onClick={() => void openCalibration()}><ScanLine size={14} />校准部件图片</button>}<label className="rig-check"><input type="checkbox" checked={part.critical !== false} onChange={(event) => patchPart(part.id, { critical: event.target.checked })} />关键部件</label></section>
            <section className="rig-control-group"><h3>显示组与表情附件</h3><label className="rig-field">显示组<select aria-label="部件显示组" value={addingGroup ? "__custom__" : part.attachmentGroup || ""} onChange={(event) => event.target.value === "__custom__" ? setAddingGroup(true) : changePartGroup(event.target.value)}><option value="">普通独立层 · 始终显示</option>{groupIds.map((id) => <option key={id} value={id}>{attachmentGroupLabels[id] || id} · {id}</option>)}<option value="__custom__">创建自定义显示组…</option></select></label>
              {addingGroup && <><label className="rig-field">新组 ID<input aria-label="新显示组 ID" maxLength={96} value={customGroup} onChange={(event) => setCustomGroup(event.target.value)} placeholder="例如 accessoryLeft" /></label><button className="button" disabled={!customGroup.trim()} onClick={() => changePartGroup(customGroup.trim())}>创建并加入显示组</button></>}
              {partGroup && <><p className="rig-hint">同组 {partGroup.parts.length} 个附件仅显示一个。绑定骨骼与遮挡层级在组内同步；眼、眉、嘴可分别切换。</p><label className="rig-field">组默认附件<select aria-label="显示组默认附件" value={partGroup.defaultPartId ?? "__hidden__"} onChange={(event) => { try { commit(rigWithDefaultAttachment(documentRef.current, partGroup.id, event.target.value === "__hidden__" ? null : event.target.value)); setAttachmentPreview({}); setShowImage(false); } catch (failure) { setError(failure.message); } }}><option value="__hidden__">隐藏此组</option>{partGroup.parts.map((item) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select></label><div className="button-row"><button className="button" onClick={() => { setAttachmentPreview({ [partGroup.id]: part.id }); setCanvasMode("overlay"); setShowImage(false); }}>预览此附件</button><button className="button" onClick={() => addPart(true)}><Plus size={13} />复制为新变体</button></div></>}
            </section>
            {step === "parts" && <section className="rig-control-group"><h3>AI 补全被遮挡部位</h3><label className="rig-field">此部件说明<textarea aria-label="当前部件补绘说明" rows={2} maxLength={2000} value={part.prompt || ""} onChange={(event) => patchPart(part.id, { prompt: event.target.value })} /></label><label className="rig-field">统一补绘要求<textarea aria-label="统一部件补绘要求" rows={3} maxLength={4000} value={partsPrompt} onChange={(event) => setPartsPrompt(event.target.value)} /></label><label className="rig-field">同时生成<select aria-label="骨架补绘并发数量" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value} 个部件</option>)}</select></label><button className="button primary" disabled={!selectedParts.length || connectionStatus?.connected === false} onClick={() => void startJob("parts")}><Sparkles size={15} />补绘已选 {selectedParts.length} 个部件</button><p className="rig-hint">AI 候选保持原矩形、方向与部件 ID，确认应用后才替换当前图片。</p></section>}
            {step === "binding" && <>
              <section className="rig-control-group"><h3>绑定方式</h3><label className="rig-field">绑定类型<select aria-label="骨架部件绑定类型" value={part.binding} onChange={(event) => patchPart(part.id, { binding: event.target.value, ...(event.target.value === "mesh" ? { mesh: { cols: 3, rows: 3 }, influences: part.influences?.length ? part.influences : [part.bone], grip: undefined } : {}) })}><option value="rigid">刚性跟随 rigid</option><option value="mesh">加权网格 mesh</option></select></label>
              {mesh && <><p className="rig-hint">改变网格密度会重新分配权重。当前 {mesh.weights.length} 个顶点、{mesh.triangles.length / 3} 个三角形。</p><div className="rig-field-grid"><NumberField label="网格列数" value={part.mesh?.cols || 3} min={2} max={8} onChange={(cols) => patchPart(part.id, { mesh: { cols: Math.round(cols), rows: part.mesh?.rows || 3 } })} /><NumberField label="网格行数" value={part.mesh?.rows || 3} min={2} max={8} onChange={(rows) => patchPart(part.id, { mesh: { cols: part.mesh?.cols || 3, rows: Math.round(rows) } })} /></div><label className="rig-field">查看权重骨骼<select aria-label="权重可视化骨骼" value={joint?.id || ""} onChange={(event) => setJointId(event.target.value)}>{document.joints.map((item) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select></label><div className="rig-influences">{document.joints.map((item) => <label key={item.id}><input type="checkbox" checked={(part.influences || [part.bone]).includes(item.id)} onChange={(event) => toggleInfluence(item.id, event.target.checked)} />{item.label || item.id}</label>)}</div><label className="rig-field">编辑顶点<select aria-label="编辑网格顶点" value={Math.min(vertexIndex, mesh.weights.length - 1)} onChange={(event) => setVertexIndex(Number(event.target.value))}>{mesh.weights.map((_, index) => <option key={index} value={index}>顶点 {index + 1}</option>)}</select></label><div className="rig-weight-fields">{(part.influences || [part.bone]).map((id) => <NumberField key={id} label={`权重 ${document.joints.find((item) => item.id === id)?.label || id}`} value={Number((vertex.find((item) => item.joint === id)?.weight || 0).toFixed(4))} min={0} max={1} step={0.05} onChange={(value) => updateWeights(id, value)} />)}</div><p className="rig-hint">每个顶点的权重会归一化。网格密度与权重会进入真实导出。</p></>}
              </section><GripControls document={document} part={part} disabled={locked} onBind={(options) => { try { commit(bindRigWeapon(documentRef.current, part.id, options)); } catch (failure) { setError(failure.message); } }} />
            </>}
            <button className="button danger" disabled={document.parts.length <= 1} onClick={() => { try { commit(rigWithoutPart(documentRef.current, part.id)); setSelectedParts((current) => current.filter((id) => id !== part.id)); setAttachmentPreview({}); } catch (failure) { setError(failure.message); } }}><Trash2 size={14} />删除此部件</button>
          </>}
          {(step === "parts" || step === "binding") && !part && <p className="rig-hint">先在结构步骤识别或创建骨架部件。</p>}
          {["parts", "binding", "motion"].includes(step) && document.parts.length > 0 && <details className="part-appearance-details"><summary>部件出现时间与网格位置</summary><PartAppearancePanel document={document} partId={part?.id} onSelectPart={setPartId} disabled={locked} onSeek={locatePartAppearance} /></details>}

          {step === "motion" && motion && <>
            <section className="rig-control-group"><h2>动作画面重制</h2><p className="rig-hint">先生成并审阅同角色动作原画，再按网格对应独立部件与遮挡。保留当前 idle；动作图逐帧部件与连续骨骼动作分别验证。</p><button className="button primary" disabled={locked || motion.id === "idle" || !document.sourceImage} onClick={() => setMotionStudyOpen(true)}>打开动作画面重制</button>{motion.id === "idle" && <p className="rig-hint">idle 已保护。请从左侧选择需要重制的其他动作。</p>}</section>
            {activeMotionStudy && <section className="rig-control-group"><h2>{motion.name} · 逐帧部件</h2><p className="rig-hint">当前播放已审阅的动作原画与独立区域。画面时间、轮廓、关节和遮挡请在「动作画面重制」中修改；原连续骨骼的角度、重心、脚锁和表情关键帧保留。</p><p className="rig-hint">{activeMotionStudy.frames.length} 个时间点 · {motion.duration.toFixed(2)}s · {motion.loop ? "循环" : "末尾保持"}。隐藏补绘与连续补间尚未验收。</p></section>}
            {!activeMotionStudy && <>
            <section className="rig-control-group"><h2>{motion.name}</h2><label className="rig-field">动作名称<input aria-label="动作名称" value={motion.name} onChange={(event) => patchMotion({ name: event.target.value })} /></label><NumberField label="动作时长（秒）" value={motion.duration} min={0.2} max={30} step={0.1} onChange={(duration) => patchMotion({ duration, poses: motion.poses.map((item) => ({ ...item, time: Number((item.time / motion.duration * duration).toFixed(4)) })) })} /><label className="rig-check"><input type="checkbox" checked={motion.loop} onChange={(event) => patchMotion({ loop: event.target.checked })} />循环动作</label><label className="rig-field">动作要求<textarea aria-label="AI 动作调整描述" maxLength={4000} rows={3} value={motion.description || ""} onChange={(event) => patchMotion({ description: event.target.value })} placeholder="例如：挥棍更快、重心更低；保留准备与收招，双脚着地。" /></label><button className="button primary" disabled={plannerStatus?.connected === false || !motion.description?.trim()} onClick={() => void startJob("motion")}><Sparkles size={15} />仅重新生成此动作</button><p className="rig-hint">只替换选定动作的关键帧，保留部件、骨架绑定和手工权重。</p></section>
            <section className="rig-control-group"><h3>关键帧与节奏</h3><div className="rig-keyframes">{motion.poses.map((item, index) => <button className={index === poseIndex ? "selected" : ""} key={index} onClick={() => selectPose(index)}>{item.time.toFixed(2)}s</button>)}</div><div className="button-row"><button className="button" onClick={addPose}><Plus size={13} />插入帧</button><button className="button danger" disabled={motion.poses.length <= 1} onClick={() => { const poses = motion.poses.filter((_, index) => index !== poseIndex), index = Math.max(0, poseIndex - 1); patchMotion({ poses }); setPoseIndex(index); seekAnimation(poses[index].time, true); }}>删除帧</button></div>
              {pose && <><NumberField label="关键帧时间（秒）" value={pose.time} min={0} max={motion.duration} step={0.01} onChange={(time) => { if (motion.poses.some((item, index) => index !== poseIndex && Math.abs(item.time - time) < 0.001)) { setError("同一时间已有关键帧。"); return; } const next = { ...pose, time }, poses = motion.poses.map((item, index) => index === poseIndex ? next : item).sort((a, b) => a.time - b.time); patchMotion({ poses }); setPoseIndex(poses.indexOf(next)); seekAnimation(time, true); }} /><label className="rig-field">节奏插值<select aria-label="关键帧插值" value={pose.ease || "smooth"} onChange={(event) => patchPose({ ease: event.target.value })}><option value="smooth">平滑 smooth</option><option value="linear">匀速 linear</option></select></label><label className="rig-field">编辑骨骼<select aria-label="关键帧骨骼" value={joint?.id || ""} onChange={(event) => setJointId(event.target.value)}>{document.joints.map((item) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select></label><NumberField label="骨骼角度（度）" value={pose.angles?.[joint?.id] || 0} min={-360} max={360} step={1} onChange={(angle) => patchPose({ angles: { ...(pose.angles || {}), [joint.id]: angle } })} /><div className="rig-field-grid"><NumberField label="重心偏移 X" value={pose.root?.x || 0} min={-document.width} max={document.width} onChange={(x) => patchPose({ root: { ...pose.root, x } })} /><NumberField label="重心偏移 Y" value={pose.root?.y || 0} min={-document.height} max={document.height} onChange={(y) => patchPose({ root: { ...pose.root, y } })} /></div><label className="rig-check"><input type="checkbox" checked={Boolean(pose.feet?.left)} onChange={(event) => patchPose({ feet: { ...(pose.feet || {}), left: event.target.checked } })} />左脚锁定</label><label className="rig-check"><input type="checkbox" checked={Boolean(pose.feet?.right)} onChange={(event) => patchPose({ feet: { ...(pose.feet || {}), right: event.target.checked } })} />右脚锁定</label></>}
            </section>
            {pose && <PoseTransformControls document={document} motion={motion} pose={pose} joint={joint} onChange={patchPose} />}
            {pose && attachmentGroups.length > 0 && <section className="rig-control-group"><h3>当前关键帧表情</h3><p className="rig-hint">附件按关键帧离散切换；沿用会保留前一帧选择，首帧从默认项开始。每组只显示一个附件。</p>{attachmentGroups.map((group) => <label className="rig-field" key={group.id}>{attachmentGroupLabels[group.id] || group.id}<select aria-label={`关键帧显示组 ${group.id}`} value={Object.hasOwn(pose.attachments || {}, group.id) ? pose.attachments[group.id] ?? "__hidden__" : "__inherit__"} onChange={(event) => changePoseAttachment(group.id, event.target.value)}><option value="__inherit__">沿用前帧 / 默认</option><option value="__hidden__">隐藏此组</option>{group.parts.map((item) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select></label>)}</section>}
            </>}
          </>}
          {step === "motion" && !motion && <section className="rig-control-group"><p className="rig-hint">从左侧添加自定义动作，或建立待机、攻击、受击的待制作动作槽；此操作保留关节、部件和手工权重。</p><button className="button" disabled={!document.joints.length} onClick={() => { commit({ ...document, motions: basicMotionSlots() }); setMotionId("idle"); }}>添加 idle / attack / hit 动作槽</button></section>}

          {(step === "motion" || step === "preview") && <section className="rig-control-group"><h3>{activeMotionStudy ? "逐帧部件检查" : "脚锁与握持测试"}</h3><button className="button" disabled={!motion} onClick={() => void inspectMotion()}><Check size={14} />检查当前动作</button><p className="rig-hint">{(activeMotionStudy || testReport?.kind === "motion-study") ? "动作图逐帧检查源像素重组和循环画面；脚锁、连续握持和隐藏补绘未评估，不能据此判定连续骨骼动画已通过。" : "骨架文档 FK 采样，容差为 0.5 px / 0.5°。检查姿态、脚部滑动、循环接缝及主副手握点误差。"}</p>{testReport?.kind === "motion-study" && <div className="rig-test-report"><strong>动作图逐帧部件 · {testReport.finite ? "来源与数值有效" : "需要修正"}</strong><p>独立可见像素重组；隐藏表面未补绘，脚锁与连续握持未评估。</p>{testReport.frames?.map((frame) => <p key={frame.frameId}>{frame.frameId}：{frame.visiblePartCount} 个区域 · Alpha IoU {Number(frame.alphaIoU).toFixed(6)} · 像素误差 {Number(frame.pixelMAE).toPrecision(4)}</p>)}{testReport.issues?.length ? <ul>{testReport.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : <p>数值检查未发现源像素或循环问题。仍需真实 Spine 视觉预览及导出回导验收。</p>}</div>}{testReport && testReport.kind !== "motion-study" && <div className="rig-test-report"><strong>{testReport.finite ? "姿态数值有效" : "存在无效姿态"}</strong><p>采样 {testReport.samples} 帧 · 左脚滑动 {testReport.maxFootSlide?.left?.toFixed(2) ?? "—"} px · 右脚 {testReport.maxFootSlide?.right?.toFixed(2) ?? "—"} px</p>{testReport.footContactSamples && <p>脚锁接触采样：左 {testReport.footContactSamples.left} / 右 {testReport.footContactSamples.right}。跑步腾空、倒地等未启用脚锁的采样不计锁定误差；0 次接触不代表已验证完整脚滑。</p>}{testReport.loop?.enabled && <p>循环位移误差 {testReport.loop.positionError?.toFixed(2)} px · 角度 {testReport.loop.angleError?.toFixed(2)}°</p>}{testReport.weaponGrips?.map((grip) => <p key={grip.partId}>{document.parts.find((item) => item.id === grip.partId)?.label || grip.partId} · 握点误差 {grip.maxError.toFixed(2)} px{grip.mode === "dual-hand-ik" ? " · 双手 IK" : " · 单手"}</p>)}{testReport.issues?.length ? <ul>{testReport.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : <p>当前采样未发现几何问题。仍需预览检查关节与遮挡。</p>}</div>}</section>}
          {step === "preview" && <section className="rig-control-group"><h2>{saveHint ? "另存为新的角色资源" : "保存为正常角色资源"}</h2><p>{readiness.completed} / {readiness.total} 个部件已有独立透明图片</p><p className="rig-hint">全部部件补全并检查动作后，保存到资源库，继续使用普通校准、预览与 Spine / Unity 导出。</p>{!readiness.ready && <p className="rig-pending-note">待完成：{readiness.pending.map((item) => item.label || item.id).join("、") || "尚未创建部件"}</p>}<button className="button primary" disabled={!readiness.ready || !document.motions.length} onClick={() => void saveResource()}><Save size={15} />{saveHint ? "另存为新资源" : "保存为角色资源"}</button></section>}
        </fieldset>

        <section className="rig-job-section" ref={jobSection}><div className="rig-collection-heading"><h3>AI 任务与候选</h3><button className="icon-button" aria-label="刷新骨架 AI 任务" disabled={Boolean(busy)} onClick={() => void perform("读取任务", async () => { const values = await client.list(document.id); if (alive.current) setJobs(values.filter((item) => !isMotionStudyJob(item))); })}><RefreshCw size={14} /></button></div>
          {running && <div className="rig-job-progress" role="status"><strong>{kindLabels[running.kind]} · {statusLabels[running.status] || running.status}</strong><progress max={Math.max(1, running.total || 1)} value={running.completed || 0} /><small>{running.completed || 0} / {running.total || 1} · 任务在本地继续，可返回后恢复</small><button className="button danger" disabled={Boolean(busy)} onClick={() => void perform("取消任务", async () => { const value = await client.cancel(running.id); if (alive.current) mergeJob(value, true); })}><Square size={12} />取消生成</button></div>}
          <div className="rig-job-history">{jobs.slice(0, 8).map((item) => <button key={item.id} className={job?.id === item.id ? "selected" : ""} disabled={Boolean(busy)} onClick={() => void perform("读取候选", async () => { const value = await client.get(item.id); if (alive.current) mergeJob(value, true); })}>{kindLabels[item.kind]}<small>{statusLabels[item.status] || item.status}</small></button>)}</div>
          {job && <div className="rig-job-result"><p><strong>{kindLabels[job.kind]}</strong> · {job.providerLabel || job.provider?.label || job.provider?.id || (typeof job.provider === "string" ? job.provider : "Codex 账号")}</p>{job.kind === "motion" && Array.isArray(job.motionReferences) && <p>{job.motionReferences.length ? `已使用 ${job.motionReferences.length} 张已审阅动作图作为姿势参考` : "按角色立绘与动作说明规划"}{job.motionReferenceExclusions?.length > 0 && <span> · {job.motionReferenceExclusions.length} 张画面未选入参考</span>}</p>}{job.error && <p className="rig-error-text">{job.error}</p>}{job.parentJobId && <button className="button subtle" disabled={locked} onClick={() => void perform("读取原任务候选", async () => { const value = await client.get(job.parentJobId); if (alive.current) mergeJob(value, true); })}>查看原任务成功候选</button>}{rigRetryablePartIds(job).length > 0 && <div className="rig-retry-parts"><strong>已成功 {jobImages(job).length} / {job.partIds?.length || job.total || 0} 个部件</strong><p>可先应用已成功候选，再继续未完成部件。续做沿用生成时的立绘、提示词、部件映射和 AI 服务。</p><label className="rig-field">续做并发<select aria-label="续做部件并发数量" value={concurrency} disabled={locked} onChange={(event) => setConcurrency(Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value} 个部件</option>)}</select></label><button className="button" disabled={locked} onClick={retryParts}><RefreshCw size={14} />继续未完成 {rigRetryablePartIds(job).length} 个部件</button></div>}{job.result?.rig && <p>{job.result.rig.joints.length} 个关节 · {job.result.rig.parts.length} 个待补绘区域</p>}{job.result?.motion && <p>{job.result.motion.name} · {job.result.motion.poses.length} 个关键帧</p>}{jobImages(job).length > 0 && <div className={`rig-candidate-images${job.kind === "appearance" ? " rig-appearance-candidate" : ""}`}>{jobImages(job).map((image) => <div key={image.id || image.partId}><img src={image.url} alt={job.kind === "appearance" ? "Q 版形象候选，等待确认应用" : `候选 ${document.parts.find((item) => item.id === image.partId)?.label || image.partId}`} /><small>{job.kind === "appearance" ? "Q 版形象 · 待确认" : document.parts.find((item) => item.id === image.partId)?.label || image.partId}</small>{image.raw && <small>原生 {image.raw.width} × {image.raw.height} → 映射 {image.width} × {image.height} · 等比适配，仍可校准</small>}</div>)}</div>}{(job.result?.rig || job.result?.motion || job.result?.polygons || jobImages(job).length > 0) && <button className="button primary" disabled={locked} onClick={applyJob}><Check size={14} />{job.kind === "registration" ? "查看坐标对应" : job.kind === "appearance" ? "确认应用 Q 版形象" : job.kind === "structure" ? "确认应用结构" : job.kind === "motion" ? "仅应用此动作" : `应用 ${jobImages(job).length} 个补绘候选`}</button>}<p className="rig-hint">候选不会自动覆盖草稿。Q 版形象确认后再分析新骨架；结构重分析需再次确认，动作重生成保留绑定。</p></div>}
          {!jobs.length && <p className="rig-hint">生成形象、分析结构或补绘后，候选会显示在这里。连接状态读取不会开始 AI 任务。</p>}
        </section>
      </aside>
    </div>
    {motionStudyOpen && motion && <MotionStudyPanel key={`${document.id}-${motion.id}`} document={document} motion={motion} disabled={Boolean(busy || running || calibration)}
      onBusyChange={setMotionStudyBusy} onClose={() => setMotionStudyOpen(false)} onPrepare={prepareStudy} onApply={applyStudy}
      onStudyChange={(id, update, { checkpoint = false } = {}) => commit((current) => ({ ...current, motionStudies: { ...current.motionStudies, [id]: typeof update === "function" ? update(current.motionStudies?.[id]) : update } }), checkpoint)} />}
    {completeOverlapOpen && <CompleteOverlapPanel document={document} disabled={Boolean(busy || running || calibration)} onClose={() => setCompleteOverlapOpen(false)} onApply={async (next, snapshot) => {
      if (documentRef.current !== snapshot) throw new Error("草稿已改变，请重新审阅完整部件。候选未应用。");
      const fingerprint = await rigCompositionFingerprint(next);
      if (!alive.current || documentRef.current !== snapshot) throw new Error("草稿已改变，候选未应用。");
      commit({ ...next, registration: { ...next.registration, compositionFingerprint: fingerprint } });
      setPreview(null); setPreviewDocument(null); setCompleteOverlapOpen(false); setRegistrationCandidate(null); setRegistrationMeasurement(null);
      setNotice("已应用经逐件审阅的完整重叠部件。关节、权重和动作保持，可撤销；请继续用连续动作检查接缝、表情和遮挡。");
    }} />}
    {busy && <div className="rig-local-progress" role="status"><LoaderCircle size={15} className="spin" />{busy}…</div>}
    {calibration && <div className={`rig-part-calibration${busy ? " is-busy" : ""}`} ref={calibrationContainer} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      <fieldset className="rig-calibration-shell" disabled={Boolean(busy)} aria-busy={Boolean(busy)}><PartEditor bundle={calibration.bundle} part={calibration.part} edit={calibration.edit} externalError={calibrationError ? `${calibrationError} 可以继续调整后重试，或取消保留原图。` : ""}
        onClose={() => { if (!busyRef.current) { setCalibration(null); setCalibrationError(""); } }} onApply={applyCalibration} /></fieldset>
    </div>}
  </main>;
}

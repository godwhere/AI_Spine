import { rigGeometryView, rigMeshView, rigPoseView, rigVisiblePartsView, rigRegistrationView, rigParentCandidates } from "../../application/rig-view.js";
import { basicMotionSlots } from "../../application/rig-operations.js";
import { createRigCommands } from "../../application/rig-commands.js";
import { RigRegistrationPanel } from "./RigRegistrationPanel.jsx";
import { RigRegistrationToolbar } from "./RigRegistrationToolbar.jsx";
import { RigPartDetails } from "./RigPartDetails.jsx";
import { RigSavePanel } from "./RigSavePanel.jsx";
import { RigValidationPanel } from "./RigValidationPanel.jsx";
import { RigMotionStart } from "./RigMotionStart.jsx";
import { RigMotionPanel } from "./RigMotionPanel.jsx";

import { RigPartsOverview } from "./RigPartsOverview.jsx";
import { RigStructurePanel } from "./RigStructurePanel.jsx";

import { createRigSession } from "../../application/rig-session.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bone, Check, Eye, ImagePlus, Layers, LoaderCircle, Move, Pause, Play, Plus, Redo2, RefreshCw, Save, ScanLine, Sparkles, Square, Undo2 } from "lucide-react";
import { validateRigDocument } from "../../../shared/rig-schema.mjs";

import { isRigJobActive, assertRigPartJobMatches, rigRegistrationPolygons, rigSourceFingerprint, rigCompositionFingerprint, rigRetryablePartIds, rigSourceRequest } from "../../../shared/domain/generation.mjs";
import { bytesToImageDataURL } from "../../../shared/codec/image-data.mjs";
import { rigReadiness, rigAttachmentGroups, rigDefaultVisiblePartIds } from "../../../shared/domain/rig.mjs";
import { SpineViewer } from "../../components/SpineViewer.jsx";
import { RigCanvas } from "./RigCanvas.jsx";
import { MotionStudyPanel } from "./MotionStudyPanel.jsx";
import { CompleteOverlapPanel } from "./CompleteOverlapPanel.jsx";

import { PartAppearancePanel } from "./PartAppearancePanel.jsx";
import { rigTimelineInputTime, rigManualSeekTime } from "../../application/rig-preview-time.js";
import { isMotionStudyJob, motionStudyFrameImage } from "../../application/motion-study.js";
import { isMotionStudyPlaybackActive } from "../../../shared/domain/motion-study.mjs";


const steps = [{ id: "structure", label: "结构与关节", icon: ScanLine }, { id: "parts", label: "拆分与补绘", icon: Layers }, { id: "binding", label: "绑定与权重", icon: Bone }, { id: "motion", label: "动作与关键帧", icon: Play }, { id: "preview", label: "验证与保存", icon: Check }];
const statusLabels = { queued: "等待处理", analyzing: "正在分析", generating: "正在生成", completed: "已完成", failed: "生成失败", cancelled: "已取消" };
const kindLabels = { appearance: "Q 版形象", structure: "结构分析", parts: "部件补绘", motion: "动作规划", registration: "原图坐标对应" };
const defaultPrompts = { appearance: "以当前立绘为身份参考，保留发型、服装、配色与角色特征，重新设计成 2.5–3 头身的 Q 版人形角色。干净赛璐璐上色，清楚的分色与阴影，全身完整，头、躯干、四肢与手持物轮廓便于后续拆分。自然站姿，适合骨骼动画，角色居中，实际透明背景，不绘制棋盘格、地面、投影、边框或文字。", structure: "识别当前 Q 版人形角色的真实骨架、遮挡顺序与独立部件，按关节活动边界拆分。手掌与前臂分开，上臂与前臂、大腿与小腿、脚掌分别绑定有效关节；有活动需要的前后发、衣摆和武器分开。关节与部件应支持待机、攻击、受击、跑步、技能、死亡和胜利等动作。补足被遮挡的肢体连接处，不把不同表情或动作变体叠成同时显示的部件。", parts: "保留角色身份和画风，补全被遮挡的肢体与连接处，输出完整独立透明部件，去除其他部件和背景。" };
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const jobImages = (job) => job?.result?.images || job?.images || [];
const copyPose = (pose, time = pose.time) => ({ ...structuredClone(pose), time });
const attachmentGroupLabels = { eyeLeft: "左眼", eyeRight: "右眼", browLeft: "左眉", browRight: "右眉", mouth: "嘴型" };
const registrationDefaultPrompt = "以原图像素坐标规划每个默认可见部件的真实可见轮廓。保留衣服和腿部的实际宽度与体积，按 32 像素网格定位。轮廓允许超出偏小的现有矩形，明确报告所需边界；不要把轮廓缩细塞进框，不重画角色，不改变关节、网格权重、动作或默认表情。";

const motionPresets = {
  run: { name: "跑步", duration: 0.8, loop: true, description: "循环跑步，双腿交替蹬地与摆动，身体轻微起伏，手臂与武器稳定跟随，首尾连续。" },
  skill: { name: "技能", duration: 1.6, loop: false, description: "清晰的技能蓄势、施放和收势，重心稳定，武器握点与双脚接地合理。" },
  death: { name: "死亡", duration: 1.3, loop: false, description: "角色受击后失去平衡并倒下，最终停留在死亡姿态，部件保持连接，避免地面穿插。" },
  victory: { name: "胜利", duration: 1.8, loop: false, description: "角色完成轻快明确的胜利庆祝，保留角色性格与武器握持，最终稳定站立。" },
};
function makeClock() {
  return { position: 0, anchor: performance.now(), playing: true, speed: 1,
    read(now = performance.now()) { return this.position + (this.playing ? (now - this.anchor) / 1000 * this.speed : 0); },
    seek(value) { this.position = value; this.anchor = performance.now(); },
    set(values) { this.position = this.read(); this.anchor = performance.now(); Object.assign(this, values); } };
}

export function RigWorkbench({ CalibrationEditor, calibration: calibrationTools, editing, client, generationClient, initialDocument = null, initialManualAdjustment = false, initialPartId = null, onDraftChange, onSave, onClose, onBlockingChange, connectionStatus = null, onOpenConnection, saveHint = "", draftSaveStatus = null }) {
  const { operations, images } = editing;
  const makeId = (prefix) => `${prefix}-${editing.createId()}`;
  const emptyDocument = operations.emptyDocument;
  const { readRigImage, readRigReference, readRigPartCandidate, composeRigSourceView, inspectRigPartAlpha, createRigPartCalibration, bakeRigPartCalibration,
    registerRigSourcePixels, expandRigRegistrationBounds, prepareMotionStudyFrames, applyMotionStudy } = images;
  const sessionRef = useRef(null);
  if (!sessionRef.current) sessionRef.current = createRigSession(initialDocument || emptyDocument());
  const session = sessionRef.current;
  const [sessionState, setSessionState] = useState(() => session.getSnapshot());
  const { document } = sessionState;
  useEffect(() => {
    let previous = session.getDocument();
    return session.subscribe((state) => {
      setSessionState(state);
      if (state.document === previous) return;
      previous = state.document;
      try { Promise.resolve(callbacks.current.onDraftChange?.(state.document)).catch((failure) => { if (alive.current) setError(`草稿保存失败：${failure.message}`); }); }
      catch (failure) { if (alive.current) setError(`草稿保存失败：${failure.message}`); }
    });
  }, [session]);
  const documentRef = session.documentRef, callbacks = useRef({}); callbacks.current = { onDraftChange, onSave, onClose };
  const previewPort = useRef(null);
  const [step, setStep] = useState(initialManualAdjustment ? "binding" : "structure"), [canvasMode, setCanvasMode] = useState("overlay");
  const [manualAdjustment, setManualAdjustment] = useState(initialManualAdjustment);
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
  const commands = useMemo(() => createRigCommands(session, { createId: editing.createId, onChanged: () => setTestReport(null) }), [session]);
  const [playing, setPlaying] = useState(!initialManualAdjustment), [position, setPosition] = useState(0), [showImage, setShowImage] = useState(!initialManualAdjustment), [showParts, setShowParts] = useState(true);
  const [partGrid, setPartGrid] = useState(false), annotationSeek = useRef(null);
  const alive = useRef(true), busyRef = useRef(false);
  const sourceInput = useRef(), partInput = useRef(), partUploadTarget = useRef(""), jobSection = useRef(), calibrationContainer = useRef();
  const registrationPanel = useRef(), contourUndo = useRef([]);
  const clock = useRef(makeClock()).current;
  const running = jobs.find(isRigJobActive), locked = Boolean(busy || running || calibration || motionStudyBusy);
  const joint = document.joints.find((item) => item.id === jointId) || document.joints[0];
  const part = document.parts.find((item) => item.id === partId) || document.parts[0];
  const attachmentGroups = useMemo(() => rigAttachmentGroups(document), [document.parts, document.defaultAttachments]);
  const groupIds = [...new Set([...Object.keys(attachmentGroupLabels), ...attachmentGroups.map((group) => group.id)])];
  const partGroup = attachmentGroups.find((group) => group.id === part?.attachmentGroup);
  const motion = document.motions.find((item) => item.id === motionId) || document.motions[0];
  const pose = motion?.poses[Math.min(poseIndex, motion.poses.length - 1)];
  const modalBlocking = Boolean(calibration || (motionStudyOpen && motion) || completeOverlapOpen);
  useEffect(() => { onBlockingChange?.(modalBlocking); return () => onBlockingChange?.(false); }, [onBlockingChange, modalBlocking]);
  const readiness = rigReadiness(document), duration = motion?.duration || 1;
  const resolvedTime = motion?.loop ? ((position % duration) + duration) % duration : clamp(position, 0, duration);
  const activeMotionStudy = isMotionStudyPlaybackActive(document.motionStudies?.[motion?.id]) ? document.motionStudies[motion.id] : null;
  const poseTime = activeMotionStudy ? !motion.loop && position >= duration ? rigManualSeekTime(duration, activeMotionStudy) : position : resolvedTime;
  const runtimeClock = useMemo(() => ({ read(now) {
    const time = clock.read(now), end = preview?.durations?.[motion?.id];
    return motion && !motion.loop && time >= motion.duration && Number.isFinite(end) ? end : time;
  } }), [clock, preview, motion?.id, motion?.loop, motion?.duration]);
  const geometryDocument = useMemo(() => rigGeometryView(document), [document]);
  const mesh = useMemo(() => rigMeshView(geometryDocument, part, step), [geometryDocument, part?.id, step]);
  const sampledPose = useMemo(() => rigPoseView(activeMotionStudy ? document : geometryDocument, motion, poseTime, step, canvasMode), [document, geometryDocument, motion?.id, poseTime, step, canvasMode]);
  const displayedPose = sampledPose.pose;
  const displayedStudyFrame = activeMotionStudy?.frames.find((frame) => frame.id === displayedPose?.frameId);
  const overlayDocument = useMemo(() => displayedStudyFrame ? { ...document, sourceImage: motionStudyFrameImage(activeMotionStudy, displayedStudyFrame) } : document, [document, displayedStudyFrame]);
  const setupVisiblePartIds = useMemo(() => rigVisiblePartsView(geometryDocument, attachmentPreview, attachmentGroups, document), [geometryDocument, attachmentPreview]);
  const registrationStageCurrent = registrationStage?.baseDocument === document;
  const activeRegistrationCandidate = registrationCandidate && (registrationCandidate.baseDocument === document || registrationCandidate.document === document) ? registrationCandidate : null;
  const registrationPolygons = registrationStageCurrent || activeRegistrationCandidate ? registrationStage?.polygons || {} : {};
  const registrationBounds = useMemo(() => rigRegistrationView(document, registrationStage), [document, registrationStage]);
  const selectedPolygon = registrationPolygons[part?.id] || [];
  const selectedRegistrationBounds = registrationBounds?.parts.find((item) => item.partId === part?.id);
  const selectedRegistrationPixels = activeRegistrationCandidate?.document.parts.find((item) => item.id === part?.id)?.registration || part?.registration;
  const selectedRegistrationDiagnostic = (activeRegistrationCandidate?.metrics || document.registration?.metrics)?.partDiagnostics?.find((item) => item.partId === part?.id);

  const remember = () => session.remember();
  const { commit, patchJoint, patchPart } = commands;
  const selectEditablePart = (id) => {
    setPartId(id);
    const selected = documentRef.current.parts.find((item) => item.id === id);
    if (manualAdjustment && selected?.attachmentGroup) setAttachmentPreview((current) => ({ ...current, [selected.attachmentGroup]: id }));
  };
  const adjustPart = (id, x, y, checkpoint = true) => {
    try { commands.movePart(id, x, y, checkpoint); }
    catch (failure) { setError(failure.message); }
  };
  const beginPartMove = () => session.beginGesture();
  const cancelPartMove = (options) => { if (session.cancelGesture(options)) setTestReport(null); };
  const resizeSelectedPart = (scale) => {
    try { commands.resizePart(part.id, scale); }
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
  const patchMotion = (fields) => { try { if (motion) commands.patchMotion(motion.id, fields); } catch (failure) { setError(failure.message); } };
  const patchPose = (fields) => { try { if (motion && pose) commands.patchPose(motion.id, poseIndex, fields); } catch (failure) { setError(failure.message); } };
  const changePartGroup = (group) => {
    try { commands.setPartGroup(part.id, group); setAddingGroup(false); setCustomGroup(""); setAttachmentPreview({}); if (group) setShowImage(false); setNotice(group ? "已加入显示组。同组只显示一个附件，并共享绑定骨骼与遮挡层级。" : "已改为普通独立层，将始终显示。"); }
    catch (failure) { setError(failure.message); }
  };
  const changePoseAttachment = (group, value) => {
    const attachments = { ...pose.attachments };
    if (value === "__inherit__") delete attachments[group]; else attachments[group] = value === "__hidden__" ? null : value;
    patchPose({ attachments }); clock.set({ playing: false }); setPlaying(false); clock.seek(pose.time); setPosition(pose.time);
  };
  const addPart = (duplicate = false) => {
    const { id, group } = commands.addPart({ duplicateId: duplicate ? part.id : undefined, boneId: joint?.id, group: newPartGroup });
    if (group) setShowImage(false);
    setPartId(id); setAttachmentPreview({});
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
  }, [session]);
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

  const bindSelectedWeapon = (options) => { try { commands.bindWeapon(part.id, options); } catch (failure) { setError(failure.message); } };
  const changeSource = async (file) => perform("读取立绘", async () => {
    const { document: next, resized } = await operations.sourceDraft(documentRef.current, file);
    if (!alive.current) return;
    if (documentRef.current.joints.length || documentRef.current.parts.length) setPendingSource(next);
    else { commit(next); setPreview(null); setJobs([]); setJob(null); }
    if (resized) setNotice("立绘已按比例缩至最长边 2048 像素，关节与部件坐标以当前画布为准。");
  });
  const programDraft = () => {
    try {
      commit(operations.programDraft(documentRef.current));
      setJointId("root"); setStep("structure"); setCanvasMode("overlay"); setPreview(null); setConfirmReset(null);
      setNotice("已创建程序人形初稿。它不是 AI 识别结果；请逐个拖动关节对齐立绘，并补绘所有独立部件。");
    } catch (failure) { setError(failure.message); }
  };
  const buildPreview = async (snapshot = documentRef.current) => {
    const result = await operations.preview(snapshot);
    if (alive.current && documentRef.current === snapshot) { setPreview(result.bundle); setPreviewDocument(snapshot); }
    return result;
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
  const checkedRegistrationStage = () => operations.registrationStage(documentRef.current, registrationStage);
  const saveContours = () => perform("保存轮廓草稿", async () => {
    const { current, polygons } = await checkedRegistrationStage();
    const next = { ...current, parts: current.parts.map((item) => polygons[item.id] ? { ...item, sourcePolygon: polygons[item.id] } : item) };
    validateRigDocument(next);
    if (!alive.current || documentRef.current !== current) return;
    commit(next); setRegistrationStage({ ...registrationStage, baseDocument: next, polygons }); setRegistrationCandidate(null); setNotice("轮廓坐标已保存到草稿，尚未改动部件图片或矩形。可撤销或继续检查对齐效果。");
  });
  const checkRegistration = (expand = false) => perform(expand ? "扩展框并检查对齐" : "检查原图坐标对齐", async () => {
    const { current, polygons } = await checkedRegistrationStage();
    const candidate = await operations.prepareRegistration(current, polygons, registrationStage, expand);
    if (!alive.current || documentRef.current !== current) return;
    setRegistrationCandidate(candidate);
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
    const current = documentRef.current, candidate = await operations.prepareCandidate(current, job, client.image);
    if (!alive.current || documentRef.current !== current) return;
    if (candidate.kind === "registration") {
      loadRegistrationStage(current, candidate.polygons, job.sourceFingerprint, job.id); setNotice("已载入原图坐标计划，仅供审阅；当前部件图片、矩形、关节和动作尚未改变。"); return;
    }
    if (candidate.kind === "appearance") {
      if (candidate.needsConfirmation) setConfirmReset({ kind: "appearance", document: candidate.document, source: current });
      else useAppearance(candidate.document);
      return;
    }
    if (candidate.kind === "structure") {
      const value = candidate.document;
      if (candidate.needsConfirmation) { setConfirmReset({ kind: "structure", document: value }); return; }
      commit(value); setJointId(value.joints[0]?.id || ""); setPartId(value.parts[0]?.id || ""); setSelectedParts(value.parts.map((item) => item.id)); setStep("structure"); setCanvasMode("overlay");
      setNotice("已应用 AI 结构。部件仍待补绘；idle / attack / hit 是待制作动作槽，请逐个生成或编辑。");
    } else if (candidate.kind === "motion") {
      commit(candidate.document); setMotionId(candidate.motionId); setStep("motion"); setPoseIndex(0); setNotice("已替换此动作，部件、绑定、网格与权重保持。");
    } else {
      if (!candidate.count) { setNotice("这些候选已应用，保留当前部件图片及后续校准。"); return; }
      commit(candidate.document); setStep("binding"); setPartId(candidate.selectedPart); setNotice(`已应用 ${candidate.count} 个透明补绘部件，请检查边缘、关节与权重。`);
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
  const inspectMotion = () => perform("检查动作", async () => { if (!motion) throw new Error("请先选择动作。"); const current = documentRef.current, result = await operations.inspectMotion(current, motion.id); await buildPreview(current); if (alive.current) { setTestReport(result); setStep("preview"); setCanvasMode("preview"); } });
  const prepareStudy = async (id) => {
    const snapshot = documentRef.current, result = await operations.prepareStudy(snapshot, id);
    if (!alive.current || documentRef.current !== snapshot) throw new Error("草稿已改变，逐帧检查结果未覆盖当前编辑。");
    commit(result.document); setPreview(null); setPreviewDocument(null); return result.report;
  };
  const applyStudy = async (id) => {
    const snapshot = documentRef.current, result = await operations.applyStudy(snapshot, id);
    if (!alive.current || documentRef.current !== snapshot) throw new Error("草稿已改变，逐帧动作尚未应用。");
    commit(result.document); setPreview(result.bundle); setPreviewDocument(result.document); setMotionId(id); setPoseIndex(0); setStep("motion"); setCanvasMode("preview");
    clock.set({ playing: false }); clock.seek(0); setPlaying(false); setPosition(0); setTestReport(null);
    setNotice("已应用选定动作的独立可见部件与真实 Spine 附件切换。idle 和其他动作保持；隐藏表面未补绘，连续补间未验收。请检查全部画面并完成导出回导。");
    return result.report;
  };
  const saveResource = () => perform("保存角色资源", async () => {
    const current = documentRef.current;
    try { await operations.validateForSave(current); }
    catch (error) {
      if (error.report && alive.current && documentRef.current === current) { setMotionId(error.motionId); setTestReport(error.report); setStep("preview"); }
      throw error;
    }
    if (!alive.current || documentRef.current !== current) return;
    const result = await buildPreview(current);
    if (alive.current && documentRef.current === current) await callbacks.current.onSave?.(result.document, result.bundle, { thumbnail: previewPort.current?.captureThumbnail() });
  });
  const changeStep = (id) => { setStep(id); if (id !== "binding") setManualAdjustment(false); if (id !== "binding") setRegistrationOpen(false); if (id !== "preview") setCanvasMode("overlay"); if (id === "preview" && document.joints.length) void showPreview(); };
  const vertex = mesh?.weights[Math.min(vertexIndex, mesh.weights.length - 1)] || [];
  const parentCandidates = rigParentCandidates(document, joint);
  const updateWeights = (id, value) => { try { commands.setVertexWeight(part.id, vertexIndex, id, value); } catch (failure) { setError(failure.message); } };
  const toggleInfluence = (id, checked) => { try { commands.setInfluence(part.id, id, checked); } catch (failure) { setError(failure.message); } };
  const addPose = () => { try {
    const added = motion && commands.addPose(motion.id, poseIndex);
    if (added) { setPoseIndex(added.index); seekAnimation(added.time, true); }
  } catch (failure) { setError(failure.message); } };

  return <main className="rig-workbench" aria-label="新骨架与动作工作台">
    <input ref={sourceInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void changeSource(file); }} />
    <input ref={partInput} type="file" accept="image/png,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void uploadPart(file); }} />
    <header className="rig-topbar"><button className="button subtle" disabled={Boolean(busy || calibration)} onClick={() => { if (!busyRef.current && !calibration) callbacks.current.onClose?.(); }}><ArrowLeft size={16} />返回资源</button>
      <label className="rig-name"><span>新骨架与动作</span><input aria-label="骨架资源名称" value={document.name} disabled={locked} onChange={(event) => commit({ ...documentRef.current, name: event.target.value }, false)} /></label>
      <span className="rig-draft-status" data-save-status={draftSaveStatus?.status} role={draftSaveStatus?.status === "failed" ? "alert" : "status"}>独立骨架草稿 · {typeof draftSaveStatus?.message === "string" && draftSaveStatus.message || ({ idle: "自动保存", pending: "待保存", saving: "保存中", saved: "已保存", failed: "保存失败" }[draftSaveStatus?.status] || "自动保存")}</span>
      <div className="rig-history-controls"><button className="icon-button" aria-label="撤销骨架修改" disabled={locked || !sessionState.canUndo} onClick={() => { if (session.undo()) setTestReport(null); }}><Undo2 size={17} /></button><button className="icon-button" aria-label="重做骨架修改" disabled={locked || !sessionState.canRedo} onClick={() => { if (session.redo()) setTestReport(null); }}><Redo2 size={17} /></button></div>
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
        {registrationOpen && <RigRegistrationToolbar registrationView={registrationView} setRegistrationView={setRegistrationView} activeRegistrationCandidate={activeRegistrationCandidate} part={part} setRegistrationFocus={setRegistrationFocus} registrationFocus={registrationFocus} registrationOnlySelected={registrationOnlySelected} setRegistrationOnlySelected={setRegistrationOnlySelected} registrationGrid={registrationGrid} setRegistrationGrid={setRegistrationGrid} registrationOpacity={registrationOpacity} setRegistrationOpacity={setRegistrationOpacity} />}
        <div className="rig-stage-canvas" data-rig-preview>{canvasMode === "preview" && preview
          ? <SpineViewer bundle={preview} clock={runtimeClock} animation={preview.animations.includes(motion?.id) ? motion.id : preview.animations[0]} loop={Boolean(motion?.loop)} skin={preview.skins[0]} label="新骨架动作预览" previewPort={previewPort} />
          : <RigCanvas document={registrationOpen && activeRegistrationCandidate ? activeRegistrationCandidate.document : registrationOpen ? document : overlayDocument} selectedJoint={joint?.id} selectedPart={part?.id} selectedVertex={vertexIndex} mesh={manualAdjustment ? null : mesh} partAnnotation={partGrid && !registrationOpen && !manualAdjustment ? { motionName: motion?.name, time: resolvedTime } : null} pose={registrationOpen ? null : displayedPose} visiblePartIds={setupVisiblePartIds} registration={registrationOpen ? { mode: registrationView, grid: registrationGrid, opacity: registrationOpacity, focus: registrationFocus, onlySelected: registrationOnlySelected, polygons: registrationPolygons, assembly: activeRegistrationCandidate?.previewDataURL || registrationAssembly, owners: activeRegistrationCandidate?.ownerDataURL, alphaPart: part, alphaBounds: registrationAlpha } : null} selectedPolygonVertex={registrationVertex} onSelectPolygonVertex={setRegistrationVertex} onBeginPolygonMove={rememberContour} onMovePolygonVertex={moveContourVertex} showParts={showParts} showImage={showImage} disabled={locked} editingTool={manualAdjustment ? "parts" : "joints"} onBeginPartMove={beginPartMove} onMovePart={(id, x, y) => adjustPart(id, x, y, false)} onEndPartMove={() => session.finishGesture()} onCancelPartMove={cancelPartMove} onSelectJoint={setJointId} onSelectPart={selectEditablePart} onSelectVertex={setVertexIndex} onBeginMove={remember} onMoveJoint={(id, x, y) => patchJoint(id, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }, false)} />}</div>
        {canvasMode === "preview" && previewDocument !== document && <p className="rig-preview-warning">骨架或动作已修改，请更新预览后再检查。</p>}
        {!readiness.ready && <p className="rig-preview-warning">原图裁片与占位仅供校对 · 还有 {readiness.pending.length} 个部件待补绘</p>}
        <div className="rig-playback"><button className="rig-play-button" aria-label={playing ? "暂停骨架动画" : "播放骨架动画"} disabled={!motion} onClick={toggleAnimation}>{playing ? <Pause size={18} /> : <Play size={18} />}</button><select aria-label="骨架预览动作" value={motion?.id || ""} disabled={!document.motions.length} onChange={(event) => selectMotion(event.target.value)}>{document.motions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input type="range" aria-label="骨架动画时间" min="0" max={duration} step="0.01" value={resolvedTime} disabled={!motion} onChange={(event) => seekAnimation(activeMotionStudy ? rigTimelineInputTime(Number(event.target.value)) : Number(event.target.value))} /><span>{resolvedTime.toFixed(2)} / {duration.toFixed(2)}s</span></div>
        <div className="rig-stage-footnote">{manualAdjustment ? "选择部件后拖动金色手柄 · 方向键 1px · Shift 10px · Esc 取消拖动" : step === "structure" ? "拖动圆点纠正关节 · 方向键微调 · Shift 加速" : step === "binding" ? "点选网格顶点，在右侧调整真实导出权重" : "切换动作沿用同一预览镜头"}<span>{document.origin === "procedural-draft" ? "程序人形初稿 · 需人工校对" : "自建骨架"}</span></div>
      </section>

      <aside className="rig-inspector">
        <section className="rig-ai-connection"><Sparkles size={17} /><div><strong>AI 结构 / 动作：Codex 账号</strong><small>{plannerStatus?.connected ? "已连接" : plannerStatus ? "需要连接 Codex 账号" : "正在检查连接"} · 补绘：{connectionStatus?.label || "当前图像服务"}</small></div>{onOpenConnection && <button className="button subtle" onClick={onOpenConnection}>设置</button>}</section>
        <fieldset disabled={locked}>
          {registrationOpen && <RigRegistrationPanel registrationPanel={registrationPanel} document={document} registrationDefaultPrompt={registrationDefaultPrompt} commit={commit} documentRef={documentRef} plannerStatus={plannerStatus} startJob={startJob} loadSavedContours={loadSavedContours} registrationStage={registrationStage} registrationStageCurrent={registrationStageCurrent} activeRegistrationCandidate={activeRegistrationCandidate} registrationPolygons={registrationPolygons} part={part} setPartId={setPartId} selectedPolygon={selectedPolygon} registrationVertex={registrationVertex} setRegistrationVertex={setRegistrationVertex} rememberContour={rememberContour} moveContourVertex={moveContourVertex} setRegistrationStage={setRegistrationStage} setRegistrationCandidate={setRegistrationCandidate} contourUndo={contourUndo} saveContours={saveContours} registrationAlpha={registrationAlpha} selectedRegistrationBounds={selectedRegistrationBounds} registrationBounds={registrationBounds} checkRegistration={checkRegistration} registrationCandidate={registrationCandidate} applyRegistration={applyRegistration} selectedRegistrationDiagnostic={selectedRegistrationDiagnostic} selectedRegistrationPixels={selectedRegistrationPixels} registrationMeasurement={registrationMeasurement} />}
          {step === "parts" && <RigPartsOverview locked={locked} document={document} setCompleteOverlapOpen={setCompleteOverlapOpen} />}
          {step === "structure" && <RigStructurePanel document={document} appearancePrompt={appearancePrompt} setAppearancePrompt={setAppearancePrompt} connectionStatus={connectionStatus} startJob={startJob} structureDetail={structureDetail} commit={commit} documentRef={documentRef} structurePrompt={structurePrompt} setStructurePrompt={setStructurePrompt} plannerStatus={plannerStatus} setConfirmReset={setConfirmReset} programDraft={programDraft} joint={joint} patchJoint={patchJoint} parentCandidates={parentCandidates} />}

          {(step === "parts" || step === "binding") && part && <RigPartDetails manualAdjustment={manualAdjustment} part={part} document={document} locked={locked} adjustPart={adjustPart} resizeSelectedPart={resizeSelectedPart} patchPart={patchPart} partUploadTarget={partUploadTarget} partInput={partInput} openCalibration={openCalibration} addingGroup={addingGroup} setAddingGroup={setAddingGroup} changePartGroup={changePartGroup} groupIds={groupIds} attachmentGroupLabels={attachmentGroupLabels} customGroup={customGroup} setCustomGroup={setCustomGroup} partGroup={partGroup} commands={commands} setAttachmentPreview={setAttachmentPreview} setShowImage={setShowImage} setError={setError} setCanvasMode={setCanvasMode} addPart={addPart} step={step} partsPrompt={partsPrompt} setPartsPrompt={setPartsPrompt} concurrency={concurrency} setConcurrency={setConcurrency} selectedParts={selectedParts} connectionStatus={connectionStatus} startJob={startJob} mesh={mesh} joint={joint} setJointId={setJointId} toggleInfluence={toggleInfluence} vertexIndex={vertexIndex} setVertexIndex={setVertexIndex} vertex={vertex} updateWeights={updateWeights} bindSelectedWeapon={bindSelectedWeapon} setSelectedParts={setSelectedParts} />}
          {(step === "parts" || step === "binding") && !part && <p className="rig-hint">先在结构步骤识别或创建骨架部件。</p>}
          {["parts", "binding", "motion"].includes(step) && document.parts.length > 0 && <details className="part-appearance-details"><summary>部件出现时间与网格位置</summary><PartAppearancePanel document={document} partId={part?.id} onSelectPart={setPartId} disabled={locked} onSeek={locatePartAppearance} /></details>}

          {step === "motion" && motion && <RigMotionPanel locked={locked} motion={motion} document={document} setMotionStudyOpen={setMotionStudyOpen} activeMotionStudy={activeMotionStudy} patchMotion={patchMotion} plannerStatus={plannerStatus} startJob={startJob} poseIndex={poseIndex} selectPose={selectPose} addPose={addPose} setPoseIndex={setPoseIndex} seekAnimation={seekAnimation} pose={pose} setError={setError} patchPose={patchPose} joint={joint} setJointId={setJointId} attachmentGroups={attachmentGroups} attachmentGroupLabels={attachmentGroupLabels} changePoseAttachment={changePoseAttachment} />}
          {step === "motion" && !motion && <RigMotionStart document={document} commit={commit} basicMotionSlots={basicMotionSlots} setMotionId={setMotionId} />}

          {(step === "motion" || step === "preview") && <RigValidationPanel activeMotionStudy={activeMotionStudy} motion={motion} inspectMotion={inspectMotion} testReport={testReport} document={document} />}
          {step === "preview" && <RigSavePanel saveHint={saveHint} readiness={readiness} document={document} saveResource={saveResource} />}
        </fieldset>

        <section className="rig-job-section" ref={jobSection}><div className="rig-collection-heading"><h3>AI 任务与候选</h3><button className="icon-button" aria-label="刷新骨架 AI 任务" disabled={Boolean(busy)} onClick={() => void perform("读取任务", async () => { const values = await client.list(document.id); if (alive.current) setJobs(values.filter((item) => !isMotionStudyJob(item))); })}><RefreshCw size={14} /></button></div>
          {running && <div className="rig-job-progress" role="status"><strong>{kindLabels[running.kind]} · {statusLabels[running.status] || running.status}</strong><progress max={Math.max(1, running.total || 1)} value={running.completed || 0} /><small>{running.completed || 0} / {running.total || 1} · 任务在本地继续，可返回后恢复</small><button className="button danger" disabled={Boolean(busy)} onClick={() => void perform("取消任务", async () => { const value = await client.cancel(running.id); if (alive.current) mergeJob(value, true); })}><Square size={12} />取消生成</button></div>}
          <div className="rig-job-history">{jobs.slice(0, 8).map((item) => <button key={item.id} className={job?.id === item.id ? "selected" : ""} disabled={Boolean(busy)} onClick={() => void perform("读取候选", async () => { const value = await client.get(item.id); if (alive.current) mergeJob(value, true); })}>{kindLabels[item.kind]}<small>{statusLabels[item.status] || item.status}</small></button>)}</div>
          {job && <div className="rig-job-result"><p><strong>{kindLabels[job.kind]}</strong> · {job.providerLabel || job.provider?.label || job.provider?.id || (typeof job.provider === "string" ? job.provider : "Codex 账号")}</p>{job.kind === "motion" && Array.isArray(job.motionReferences) && <p>{job.motionReferences.length ? `已使用 ${job.motionReferences.length} 张已审阅动作图作为姿势参考` : "按角色立绘与动作说明规划"}{job.motionReferenceExclusions?.length > 0 && <span> · {job.motionReferenceExclusions.length} 张画面未选入参考</span>}</p>}{job.error && <p className="rig-error-text">{job.error}</p>}{job.parentJobId && <button className="button subtle" disabled={locked} onClick={() => void perform("读取原任务候选", async () => { const value = await client.get(job.parentJobId); if (alive.current) mergeJob(value, true); })}>查看原任务成功候选</button>}{rigRetryablePartIds(job).length > 0 && <div className="rig-retry-parts"><strong>已成功 {jobImages(job).length} / {job.partIds?.length || job.total || 0} 个部件</strong><p>可先应用已成功候选，再继续未完成部件。续做沿用生成时的立绘、提示词、部件映射和 AI 服务。</p><label className="rig-field">续做并发<select aria-label="续做部件并发数量" value={concurrency} disabled={locked} onChange={(event) => setConcurrency(Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value} 个部件</option>)}</select></label><button className="button" disabled={locked} onClick={retryParts}><RefreshCw size={14} />继续未完成 {rigRetryablePartIds(job).length} 个部件</button></div>}{job.result?.rig && <p>{job.result.rig.joints.length} 个关节 · {job.result.rig.parts.length} 个待补绘区域</p>}{job.result?.motion && <p>{job.result.motion.name} · {job.result.motion.poses.length} 个关键帧</p>}{jobImages(job).length > 0 && <div className={`rig-candidate-images${job.kind === "appearance" ? " rig-appearance-candidate" : ""}`}>{jobImages(job).map((image) => <div key={image.id || image.partId}><img src={image.url} alt={job.kind === "appearance" ? "Q 版形象候选，等待确认应用" : `候选 ${document.parts.find((item) => item.id === image.partId)?.label || image.partId}`} /><small>{job.kind === "appearance" ? "Q 版形象 · 待确认" : document.parts.find((item) => item.id === image.partId)?.label || image.partId}</small>{image.raw && <small>原生 {image.raw.width} × {image.raw.height} → 映射 {image.width} × {image.height} · 等比适配，仍可校准</small>}</div>)}</div>}{(job.result?.rig || job.result?.motion || job.result?.polygons || jobImages(job).length > 0) && <button className="button primary" disabled={locked} onClick={applyJob}><Check size={14} />{job.kind === "registration" ? "查看坐标对应" : job.kind === "appearance" ? "确认应用 Q 版形象" : job.kind === "structure" ? "确认应用结构" : job.kind === "motion" ? "仅应用此动作" : `应用 ${jobImages(job).length} 个补绘候选`}</button>}<p className="rig-hint">候选不会自动覆盖草稿。Q 版形象确认后再分析新骨架；结构重分析需再次确认，动作重生成保留绑定。</p></div>}
          {!jobs.length && <p className="rig-hint">生成形象、分析结构或补绘后，候选会显示在这里。连接状态读取不会开始 AI 任务。</p>}
        </section>
      </aside>
    </div>
    {motionStudyOpen && motion && <MotionStudyPanel imageTools={images} client={client} key={`${document.id}-${motion.id}`} document={document} motion={motion} disabled={Boolean(busy || running || calibration)}
      onBusyChange={setMotionStudyBusy} onClose={() => setMotionStudyOpen(false)} onPrepare={prepareStudy} onApply={applyStudy}
      onStudyChange={(id, update, { checkpoint = false } = {}) => commit((current) => ({ ...current, motionStudies: { ...current.motionStudies, [id]: typeof update === "function" ? update(current.motionStudies?.[id]) : update } }), checkpoint)} />}
    {completeOverlapOpen && <CompleteOverlapPanel imageTools={images} document={document} disabled={Boolean(busy || running || calibration)} onClose={() => setCompleteOverlapOpen(false)} onApply={async (next, snapshot) => {
      if (documentRef.current !== snapshot) throw new Error("草稿已改变，请重新审阅完整部件。候选未应用。");
      const fingerprint = await rigCompositionFingerprint(next);
      if (!alive.current || documentRef.current !== snapshot) throw new Error("草稿已改变，候选未应用。");
      commit({ ...next, registration: { ...next.registration, compositionFingerprint: fingerprint } });
      setPreview(null); setPreviewDocument(null); setCompleteOverlapOpen(false); setRegistrationCandidate(null); setRegistrationMeasurement(null);
      setNotice("已应用经逐件审阅的完整重叠部件。关节、权重和动作保持，可撤销；请继续用连续动作检查接缝、表情和遮挡。");
    }} />}
    {busy && <div className="rig-local-progress" role="status"><LoaderCircle size={15} className="spin" />{busy}…</div>}
    {calibration && <div className={`rig-part-calibration${busy ? " is-busy" : ""}`} ref={calibrationContainer} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      <fieldset className="rig-calibration-shell" disabled={Boolean(busy)} aria-busy={Boolean(busy)}><CalibrationEditor calibration={calibrationTools} bundle={calibration.bundle} part={calibration.part} edit={calibration.edit} externalError={calibrationError ? `${calibrationError} 可以继续调整后重试，或取消保留原图。` : ""}
        onClose={() => { if (!busyRef.current) { setCalibration(null); setCalibrationError(""); } }} onApply={applyCalibration} /></fieldset>
    </div>}
  </main>;
}

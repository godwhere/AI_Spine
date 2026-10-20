import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import * as authoring from "../src/core/rig-authoring.js";
import * as rigClient from "../src/core/rig-client.js";
import * as rigImages from "../src/core/rig-images.js";
import * as rigRegistration from "../src/core/rig-registration.js";
import * as motionStudyClient from "../src/core/motion-study-client.js";
import * as motionStudyCore from "../src/core/rig-motion-studies.js";
import * as rigPreviewTime from "../src/core/rig-preview-time.js";
import * as rigPartAdjustment from "../src/core/rig-part-adjustment.js";
import { createCanvas } from "@napi-rs/canvas";
import { Skeleton, AnimationState, AnimationStateData, Physics } from "@esotericsoftware/spine-webgl";
import { pixelEnv } from "./helpers.mjs";
import { parseBundle } from "../src/core/archive.js";
import { parseSkeleton } from "../src/spine/runtime.js";

const source = await readFile(new URL("../src/components/RigWorkbench.jsx", import.meta.url), "utf8");
const names = [...source.matchAll(/^import \{ ([^}]+) \} from .+;$/gm)].flatMap((match) => match[1].split(",").map((name) => name.trim()));
const { code } = await transformWithEsbuild(source.replace(/^import .*;\n/gm, "").replace("export function RigWorkbench", "function RigWorkbench"), "RigWorkbench.jsx", { loader: "jsx", jsx: "transform", jsxFactory: "jsx" });
const factory = new Function(...names, "jsx", "React", "setInterval", "clearInterval", "performance", `${code};return { RigWorkbench, GripControls };`);
const descendants = (node) => node && typeof node === "object" ? [node, ...(node.children || []).flatMap(descendants)] : [];
const text = (node) => typeof node === "string" || typeof node === "number" ? String(node) : node && typeof node === "object" ? (node.children || []).map(text).join("") : "";
const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function workbench({ initialDocument, initialManualAdjustment = false, initialPartId = null, history = [], get, inspect = authoring.inspectRigMotion, saveHint = "", draftSaveStatus = null, onDraftChange, createCalibration = rigImages.createRigPartCalibration, bakeCalibration = rigImages.bakeRigPartCalibration, image = async () => new Uint8Array([1]), readImage = rigImages.readRigImage, readPartImage = rigImages.readRigPartCandidate, retry, now = () => performance.now(), bindings = {} } = {}) {
  const cells = [], timers = new Map(), drafts = [], submissions = [], saved = [], retries = [];
  let cursor = 0, dirty = true, scheduled = [], tree, mounted = true, writesAfterUnmount = 0, timerId = 0;
  const state = (initial) => { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === "function" ? initial() : initial; return [cells[i], (value) => { if (!mounted) writesAfterUnmount++; const next = typeof value === "function" ? value(cells[i]) : value; if (!Object.is(cells[i], next)) { cells[i] = next; dirty = true; } }]; };
  const effect = (callback, dependencies) => { const i = cursor++, previous = cells[i]; if (!same(previous?.dependencies, dependencies)) scheduled.push(() => { previous?.cleanup?.(); cells[i] = { dependencies, cleanup: callback() }; }); };
  const memo = (callback, dependencies) => { const i = cursor++; if (!same(cells[i]?.dependencies, dependencies)) cells[i] = { dependencies, value: callback() }; return cells[i].value; };
  const ref = (initial) => { const i = cursor++; return cells[i] ||= { current: initial }; };
  const jsx = (type, props, ...children) => {
    const flat = children.flat(Infinity);
    for (const child of flat) if (child && typeof child === "object" && !("type" in child)) throw new Error("Object passed as a React child");
    return { type, props: props || {}, children: flat };
  };
  const client = { list: async () => history.map(({ result, ...item }) => item), get: get || (async (id) => history.find((item) => item.id === id)), image,
    retry: async (id, options) => { retries.push({ id, options }); return retry ? retry(id, options) : { id: "retry-job", parentJobId: id, kind: "parts", projectId: initialDocument.id, status: "queued", provider: { id: "codex-native", label: "Codex 账号" } }; },
    start: async (request) => { submissions.push(request); return { id: "new-job", projectId: request.projectId, kind: request.kind, status: "queued", provider: { id: "codex-native", label: "Codex 账号规划" } }; } };
  const values = { ...authoring, ...rigClient, ...rigImages, ...rigRegistration, ...motionStudyClient, ...motionStudyCore, ...rigPreviewTime, ...rigPartAdjustment, useState: state, useEffect: effect, useMemo: memo, useRef: ref,
    createRigPartCalibration: createCalibration, bakeRigPartCalibration: bakeCalibration,
    readRigImage: readImage,
    readRigPartCandidate: readPartImage,
    createRigClient: () => client, createLocalGenerationProvider: () => ({ status: async () => ({ connected: true }) }), inspectRigMotion: inspect, ...bindings };
  const component = factory(...names.map((name) => values[name] || "stub"), jsx, { Fragment: "fragment" }, (callback) => { timers.set(++timerId, callback); return timerId; }, (id) => timers.delete(id), { now }).RigWorkbench;
  const props = { initialDocument, initialManualAdjustment, initialPartId, saveHint, draftSaveStatus, connectionStatus: { connected: true, label: "Codex 账号" }, onDraftChange: (document) => { drafts.push(document); return onDraftChange?.(document); }, onSave: (...args) => saved.push(args), onClose() {} };
  const render = () => { if (dirty) { dirty = false; cursor = 0; scheduled = []; tree = component(props); for (const callback of scheduled) callback(); } };
  const settle = async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      render();
      await new Promise(setImmediate);
      if (!dirty) return;
    }
    throw new Error("Rig component did not settle");
  };
  const find = (predicate) => descendants(tree).find(predicate);
  return { render, settle, drafts, submissions, saved, retries,
    text: () => text(tree),
    find,
    async click(label) { const target = find((node) => node.type === "button" && text(node) === label); assert.ok(target, `Missing ${label}`); await target.props.onClick(); await settle(); },
    async change(label, value) { const target = find((node) => node.props["aria-label"] === label); assert.ok(target, `Missing ${label}`); target.props.onChange({ target: { value } }); await settle(); },
    async tick() { await Promise.all([...timers.values()].map((callback) => callback())); await settle(); },
    async until(predicate) { for (let i = 0; i < 40; i++) { await settle(); if (predicate()) return; await new Promise((done) => setTimeout(done, 1)); } assert.fail("UI condition did not settle"); },
    unmount() { mounted = false; for (const value of cells) value?.cleanup?.(); },
    get writesAfterUnmount() { return writesAfterUnmount; },
  };
}
const empty = () => ({ version: 1, id: "rig-test", name: "Test character", width: 768, height: 1024, sourceImage: "data:image/png;base64,AAAA", joints: [], parts: [], motions: [] });

test("manual adjustment opens the selected part in setup pose and groups a drag into one undo", async () => {
  const document = authoring.createHumanoidDraft({ id: "rig-manual", width: 768, height: 1024 });
  document.parts = document.parts.map((part) => ({ ...part, image: "data:image/png;base64,AAAA", imageSource: "uploaded", completion: "ready" }));
  const part = document.parts.find((item) => item.id === "head") || document.parts[0];
  const ui = workbench({ initialDocument: document, initialManualAdjustment: true, initialPartId: part.id });
  await ui.settle();
  let canvas = ui.find((node) => node.props.editingTool === "parts");
  assert.ok(canvas); assert.equal(canvas.props.pose, null); assert.equal(canvas.props.showImage, false);
  assert.equal(canvas.props.selectedPart, part.id); assert.equal(canvas.props.mesh, null);
  canvas.props.onBeginPartMove(); canvas.props.onMovePart(part.id, part.x + 4, part.y + 6); canvas.props.onEndPartMove();
  await ui.settle(); let changed = ui.drafts.at(-1);
  assert.equal(changed.parts.find((item) => item.id === part.id).x, part.x + 4);
  assert.deepEqual(changed.joints, document.joints); assert.deepEqual(changed.motions, document.motions);
  ui.find((node) => node.props["aria-label"] === "撤销骨架修改").props.onClick(); await ui.settle();
  assert.deepEqual(ui.drafts.at(-1), document);
  ui.find((node) => node.props["aria-label"] === "重做骨架修改").props.onClick(); await ui.settle();
  assert.equal(ui.drafts.at(-1).parts.find((item) => item.id === part.id).y, part.y + 6);
  canvas = ui.find((node) => node.props.editingTool === "parts");
  canvas.props.onBeginPartMove(); canvas.props.onCancelPartMove(); await ui.settle();
  assert.equal(ui.drafts.at(-1).parts.find((item) => item.id === part.id).x, part.x + 4);
  assert.equal(ui.submissions.length, 0); ui.unmount();
});

test("manual numeric placement preserves the original image and remains a draft until explicit save", async () => {
  const document = authoring.createHumanoidDraft({ id: "rig-manual-fields", width: 768, height: 1024 });
  document.parts = document.parts.map((part) => ({ ...part, image: "data:image/png;base64,AAAA", imageSource: "uploaded", completion: "ready" }));
  const part = document.parts[0], ui = workbench({ initialDocument: document });
  await ui.settle(); await ui.click("手动调整");
  const x = ui.find((node) => node.props.label === "部件位置 X"); assert.ok(x);
  x.props.onChange(part.x + 2); await ui.settle();
  const changed = ui.drafts.at(-1).parts[0]; assert.equal(changed.x, part.x + 2); assert.equal(changed.image, part.image);
  assert.equal(ui.saved.length, 0); assert.equal(ui.submissions.length, 0); ui.unmount();
});

test("real provider metadata objects render without React object-child failures", async () => {
  const ui = workbench({ initialDocument: empty(), history: [{ id: "job-1", projectId: "rig-test", kind: "structure", status: "queued", provider: { id: "codex-native", label: "Codex 账号规划", capability: "planning" } }] });
  await ui.settle(); assert.match(ui.text(), /Codex 账号规划/); assert.match(ui.text(), /结构分析/); assert.equal(ui.submissions.length, 0); ui.unmount();
});

test("a cancelled draft effect never invokes a late save callback and a mounted draft still saves", async () => {
  let calls = 0;
  const closed = workbench({ initialDocument: empty(), onDraftChange: () => { calls++; } });
  closed.render(); closed.unmount(); await new Promise(setImmediate);
  assert.equal(calls, 0); assert.equal(closed.drafts.length, 0); assert.equal(closed.writesAfterUnmount, 0);
  const active = workbench({ initialDocument: empty(), onDraftChange: () => { calls++; } }); await active.settle();
  assert.equal(calls, 1); assert.equal(active.drafts.length, 1); active.unmount();
});

test("transaction-backed draft status is visible alongside the persistent save conflict hint", async () => {
  for (const [status, message] of [["pending", "待保存"], ["saving", "保存中"], ["saved", "已保存"], ["failed", "保存失败：磁盘空间不足"]]) {
    const ui = workbench({ initialDocument: empty(), draftSaveStatus: { status, message }, saveHint: "原资源已更新，这份草稿会另存。" }); await ui.settle();
    const indicator = ui.find((node) => node.props["data-save-status"] === status);
    assert.ok(indicator); assert.equal(indicator.props.role, status === "failed" ? "alert" : "status");
    assert.match(text(indicator), new RegExp(message)); assert.match(ui.text(), /原资源已更新，这份草稿会另存/);
    assert.ok(ui.find((node) => node.type === "button" && text(node) === "另存为新资源")); ui.unmount();
  }
});

test("structure prompts persist in the document and restore without starting AI", async () => {
  const ui = workbench({ initialDocument: empty() }); await ui.settle(); await ui.change("AI 结构分析说明", "A monkey with a long staff");
  const draft = ui.drafts.at(-1); assert.equal(draft.prompts.structure, "A monkey with a long staff"); assert.equal(ui.submissions.length, 0); ui.unmount();
  const restored = workbench({ initialDocument: draft }); await restored.settle(); assert.equal(restored.find((node) => node.props["aria-label"] === "AI 结构分析说明").props.value, draft.prompts.structure); restored.unmount();
});

test("explicit procedural drafts remain unfinished and cannot save source crops as complete art", async () => {
  const ui = workbench({ initialDocument: empty() }); await ui.settle(); await ui.click("先用程序人形初稿");
  const draft = ui.drafts.at(-1); assert.equal(draft.origin, "procedural-draft"); assert.equal(draft.motions.length, 3);
  assert.ok(draft.parts.every((part) => [part.x, part.y, part.width, part.height].every(Number.isInteger)));
  assert.equal(rigClient.rigReadiness(draft).ready, false); assert.match(ui.text(), /程序人形初稿/);
  await ui.click("保存为角色资源"); assert.equal(ui.saved.length, 0); assert.match(ui.text(), /待补绘或上传/); assert.equal(ui.submissions.length, 0); ui.unmount();
});

test("applying AI structure creates clearly unfinished standard motion slots", async () => {
  const initial = empty(), rig = authoring.createHumanoidDraft(initial); rig.motions = [];
  const ui = workbench({ initialDocument: initial, history: [{ id: "job-1", projectId: initial.id, kind: "structure", status: "completed", provider: { id: "codex-native", label: "Codex 账号规划" }, result: { rig } }] });
  await ui.settle(); await ui.click("确认应用结构");
  const draft = ui.drafts.at(-1); assert.deepEqual(draft.motions.map((motion) => motion.id), ["idle", "attack", "hit"]); assert.ok(draft.motions.every((motion) => motion.origin === "manual-placeholder")); assert.match(ui.text(), /待制作动作槽/); assert.equal(ui.submissions.length, 0); ui.unmount();
});

test("late history responses cannot update an unmounted rig document", async () => {
  const reply = deferred(), ui = workbench({ initialDocument: empty(), history: [{ id: "old-job", status: "queued", kind: "structure" }], get: () => reply.promise });
  await ui.settle(); ui.unmount(); reply.resolve({ id: "old-job", status: "completed", kind: "structure", provider: { label: "Late provider" } }); await new Promise(setImmediate);
  assert.equal(ui.writesAfterUnmount, 0);
});

test("normal resource save rejects finite poses with foot or grip inspection issues", async () => {
  const document = authoring.createHumanoidDraft({ id: "rig-test", width: 768, height: 1024 });
  document.parts = document.parts.map((part) => ({ ...part, image: "data:image/png;base64,AAAA", imageSource: "uploaded", completion: "ready" }));
  const ui = workbench({ initialDocument: document, inspect: () => ({ finite: true, issues: ["Secondary grip is unreachable"], samples: 61 }) });
  await ui.settle(); await ui.click("保存为角色资源"); assert.equal(ui.saved.length, 0); assert.match(ui.text(), /Secondary grip is unreachable/); assert.match(ui.text(), /握点/); ui.unmount();
});

test("regenerating one selected motion preserves other actions and hand-authored mesh weights", async () => {
  let document = authoring.createHumanoidDraft({ id: "rig-test", width: 768, height: 1024 });
  const part = document.parts[0];
  document = authoring.setRigPartWeights(document, part.id, 0, [{ joint: part.influences[0], weight: 0.3 }, { joint: part.influences[1], weight: 0.7 }]);
  const originalParts = structuredClone(document.parts), originalJoints = structuredClone(document.joints);
  let ui;
  ui = workbench({ initialDocument: document, get: async () => {
    const request = ui.submissions[0], before = request.rig.motions.find((motion) => motion.id === request.motion.id);
    return { id: "new-job", projectId: document.id, kind: "motion", status: "completed", provider: { id: "codex-native", label: "Codex 账号规划" }, geometry: rigClient.rigGeometry(request.rig), result: { motion: { ...before, origin: "ai-analysis", description: request.motion.description, poses: before.poses.map((pose, index) => index === 1 ? { ...pose, angles: { ...pose.angles, torso: -13 } } : pose) } } };
  } });
  await ui.settle(); await ui.click("4动作与关键帧");
  ui.find((node) => node.type === "button" && text(node).startsWith("攻击")).props.onClick(); await ui.settle();
  await ui.change("AI 动作调整描述", "挥击更快，重心更低"); await ui.click("仅重新生成此动作");
  assert.equal(ui.submissions.length, 1); assert.equal(ui.submissions[0].motion.id, "attack"); assert.equal(ui.submissions[0].planner, "codex-native");
  await ui.tick(); await ui.click("仅应用此动作");
  const next = ui.drafts.at(-1);
  assert.deepEqual(next.parts, originalParts); assert.deepEqual(next.joints, originalJoints);
  for (const id of ["idle", "hit"]) assert.deepEqual(next.motions.find((motion) => motion.id === id), document.motions.find((motion) => motion.id === id));
  assert.equal(next.motions.find((motion) => motion.id === "attack").poses[1].angles.torso, -13);
  ui.unmount();
});

test("AI Wrist joints and unnamed non-root fallback joints support projected grip coordinates", () => {
  const render = (document, part) => {
    const cells = [], effects = []; let cursor = 0, tree, bound;
    const values = { useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], (value) => { cells[i] = value; }]; }, useEffect(callback) { effects.push(callback); } };
    const jsx = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
    const Grip = factory(...names.map((name) => values[name] || "stub"), jsx, { Fragment: "fragment" }, () => {}, () => {}).GripControls;
    tree = Grip({ document, part, onBind: (value) => { bound = value; } });
    for (const effect of effects) effect(); cursor = 0; effects.length = 0;
    tree = Grip({ document, part, onBind: (value) => { bound = value; } });
    descendants(tree).find((node) => node.type === "button" && text(node) === "应用握点绑定").props.onClick();
    return { tree, bound };
  };
  const document = { joints: [{ id: "root", label: "骨盆", parent: null, x: 300, y: 400 }, { id: "leftWrist", label: "左腕", parent: "root", x: 220, y: 510 }, { id: "rightWrist", label: "右腕", parent: "root", x: 400, y: 500 }, { id: "staff", label: "棍棒", parent: "leftWrist", x: 280, y: 500 }] };
  const part = { id: "staff-part", bone: "staff", x: 200, y: 450, width: 300, height: 100 };
  const result = render(document, part);
  assert.equal(result.bound.hand, "leftWrist"); assert.deepEqual(result.bound.grip, { x: 20, y: 60 });
  const options = descendants(result.tree).filter((node) => node.type === "option").map((node) => node.props.value);
  assert.ok(options.includes("leftWrist") && options.includes("rightWrist"));
  const explicit = render(document, { ...part, grip: { primaryHand: "rightWrist", primaryLocalPoint: { x: 77, y: 33 } } });
  assert.equal(explicit.bound.hand, "rightWrist"); assert.deepEqual(explicit.bound.grip, { x: 77, y: 33 });
  const fallback = render({ joints: [{ id: "root", parent: null, x: 0, y: 0 }, { id: "joint-2", label: "末端", parent: "root", x: 600, y: 300 }] }, { ...part, bone: "joint-2" });
  assert.equal(fallback.bound.hand, "joint-2"); assert.deepEqual(fallback.bound.grip, { x: 300, y: 0 });
});

test("save conflict hints persist alongside temporary notices and explicitly label save-as", async () => {
  const hint = "原资源已有新修改，这份旧草稿将另存为新资源。";
  const ui = workbench({ initialDocument: empty(), saveHint: hint }); await ui.settle(); await ui.click("先用程序人形初稿");
  assert.equal(ui.find((node) => node.props.role === "note").children.join(""), hint);
  assert.match(ui.text(), /程序人形初稿/); assert.match(ui.text(), /另存为新资源/);
  await ui.click("另存为新资源"); assert.equal(ui.saved.length, 0); assert.match(ui.text(), /待补绘或上传/); assert.match(ui.text(), /原资源已有新修改/); ui.unmount();
});

test("empty action channels can add idle attack hit without resetting an existing binding", async () => {
  const document = authoring.createHumanoidDraft({ id: "rig-test", width: 768, height: 1024 }); document.motions = [];
  const before = structuredClone({ joints: document.joints, parts: document.parts });
  const ui = workbench({ initialDocument: document }); await ui.settle(); await ui.click("4动作与关键帧"); await ui.click("添加 idle / attack / hit 动作槽");
  const next = ui.drafts.at(-1); assert.deepEqual(next.joints, before.joints); assert.deepEqual(next.parts, before.parts); assert.deepEqual(next.motions.map((motion) => motion.id), ["idle", "attack", "hit"]); assert.ok(next.motions.every((motion) => motion.origin === "manual-placeholder")); ui.unmount();
});

const calibrationEditor = (ui) => ui.find((node) => node.props.onApply && node.props.edit && node.props.bundle);
function independentDocument() {
  const document = authoring.createHumanoidDraft({ id: "rig-test", width: 768, height: 1024, sourceImage: "data:image/png;base64,AAAA" });
  document.parts = document.parts.map((part) => ({ ...part, image: "data:image/png;base64,AAAA", imageSource: "ai", completion: "ready" }));
  return document;
}
const mockCalibration = async (document, partId) => ({ document, partId, part: { id: partId }, bundle: { parts: [{ id: partId }] }, edit: { image: new Uint8Array([1]), transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } } });

test("calibration failures retain the editor session, lock background actions and can retry without changing bindings", async () => {
  const document = independentDocument(), before = structuredClone(document); let attempts = 0;
  const ui = workbench({ initialDocument: document, createCalibration: mockCalibration, bakeCalibration: async (current, partId, edit) => {
    if (++attempts === 1) throw new Error("PNG encoding interrupted");
    return { ...current, parts: current.parts.map((part) => part.id === partId ? { ...part, image: "data:image/png;base64,BBBB", imageSource: "calibrated", completion: "ready" } : part) };
  } });
  await ui.settle(); await ui.click("2拆分与补绘"); await ui.click("校准部件图片");
  const editor = calibrationEditor(ui); assert.ok(editor);
  for (const label of ["返回资源", "保存为角色资源"]) assert.equal(ui.find((node) => node.type === "button" && text(node) === label).props.disabled, true);
  await ui.click("保存为角色资源"); assert.equal(ui.saved.length, 0); assert.match(calibrationEditor(ui).props.externalError, /先完成或取消部件图片校准/);
  await editor.props.onApply({ ...editor.props.edit, transform: { ...editor.props.edit.transform, x: 4 } }); await ui.settle();
  assert.match(calibrationEditor(ui).props.externalError, /PNG encoding interrupted/); assert.match(calibrationEditor(ui).props.externalError, /继续调整后重试/);
  assert.equal(calibrationEditor(ui).props.edit, editor.props.edit); assert.equal(calibrationEditor(ui).props.bundle, editor.props.bundle);
  assert.deepEqual(ui.drafts.at(-1), before); assert.equal(ui.submissions.length, 0);
  await calibrationEditor(ui).props.onApply(editor.props.edit); await ui.settle();
  assert.equal(calibrationEditor(ui), undefined);
  const next = ui.drafts.at(-1); assert.equal(next.parts[0].imageSource, "calibrated"); assert.deepEqual(next.joints, before.joints); assert.deepEqual(next.motions, before.motions);
  assert.deepEqual({ ...next.parts[0], image: before.parts[0].image, imageSource: "ai" }, before.parts[0]); ui.unmount();
});

test("calibration cancellation preserves images and cannot dismiss a pending async bake", async () => {
  const document = independentDocument(), reply = deferred();
  const ui = workbench({ initialDocument: document, createCalibration: mockCalibration, bakeCalibration: () => reply.promise });
  await ui.settle(); await ui.click("3绑定与权重"); await ui.click("校准部件图片");
  calibrationEditor(ui).props.onClose(); await ui.settle(); assert.equal(calibrationEditor(ui), undefined); assert.deepEqual(ui.drafts.at(-1), document);
  await ui.click("校准部件图片"); const editor = calibrationEditor(ui), pending = editor.props.onApply(editor.props.edit); await ui.settle();
  assert.equal(ui.find((node) => node.props.className === "rig-calibration-shell").props.disabled, true);
  editor.props.onClose(); await ui.settle(); assert.ok(calibrationEditor(ui));
  reply.resolve({ ...document, parts: document.parts.map((part, index) => index ? part : { ...part, imageSource: "calibrated" }) }); await pending; await ui.settle();
  assert.equal(calibrationEditor(ui), undefined); assert.equal(ui.drafts.at(-1).parts[0].imageSource, "calibrated"); ui.unmount();
});

test("pending source crops do not expose independent-image calibration and active jobs lock it", async () => {
  const document = independentDocument(); document.parts[0].imageSource = "source-crop";
  let ui = workbench({ initialDocument: document }); await ui.settle(); await ui.click("2拆分与补绘");
  assert.equal(ui.find((node) => node.type === "button" && text(node) === "校准部件图片"), undefined); ui.unmount();
  document.parts[0].imageSource = "ai";
  ui = workbench({ initialDocument: document, history: [{ id: "busy-job", projectId: document.id, kind: "parts", status: "generating", provider: { label: "Codex" } }] });
  await ui.settle(); await ui.click("3绑定与权重");
  assert.equal(ui.find((node) => node.type === "button" && text(node) === "校准部件图片").props.disabled, true); ui.unmount();
});

test("external calibration errors render inside the modal alert while existing callers remain unchanged", async () => {
  const source = await readFile(new URL("../src/components/PartEditor.jsx", import.meta.url), "utf8");
  const names = [...source.matchAll(/import \{([^}]+)\} from [^;]+;/g)].flatMap((match) => match[1].split(",").map((name) => name.trim()).filter(Boolean));
  const { code } = await transformWithEsbuild(source.replace(/import \{[^}]+\} from [^;]+;\n/g, "").replace("export function PartEditor", "function PartEditor"), "PartEditor.jsx", { loader: "jsx", jsx: "transform", jsxFactory: "jsx" });
  const jsx = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const values = { useState: (value) => [value, () => {}], useEffect: () => {}, useRef: (value) => ({ current: value }), partClipping: () => false };
  const Component = new Function(...names, "jsx", `${code}; return PartEditor;`)(...names.map((name) => values[name] || "stub"), jsx);
  const props = { part: { id: "foot", originalWidth: 42, originalHeight: 24 }, bundle: {}, edit: { image: new Uint8Array([1]), transform: {} }, onApply() {}, onClose() {} };
  const dialog = descendants(Component({ ...props, externalError: "Calibration failed. Adjust and retry." })).find((node) => node.props.role === "dialog");
  const alert = descendants(dialog).find((node) => node.props.role === "alert");
  assert.equal(text(alert), "Calibration failed. Adjust and retry.");
  assert.equal(descendants(Component(props)).find((node) => node.props.role === "alert"), undefined);
});

const appearanceResult = { dataURL: "data:image/png;base64,BBBB", width: 1024, height: 1024, transparent: true };
async function appearanceJob(document, patch = {}) {
  const sourceFingerprint = await rigClient.rigSourceFingerprint(document);
  return { id: "appearance-job", projectId: document.id, kind: "appearance", status: "completed", sourceFingerprint, sourceWidth: document.width, sourceHeight: document.height, prompt: "Chibi, cel shaded", provider: { id: "codex-native", label: "Codex 账号" }, model: "native-image",
    result: { images: [{ id: "image-0", width: 1024, height: 1024, sourceFingerprint, url: "/api/rig/jobs/appearance-job/images/image-0" }] }, ...patch };
}

test("appearance prompts restore and generation uses the selected image service without a planning request", async () => {
  const document = empty(), ui = workbench({ initialDocument: document }); await ui.settle();
  assert.match(ui.find((node) => node.props["aria-label"] === "Q 版形象生成说明").props.value, /2.5–3 头身/);
  await ui.change("Q 版形象生成说明", "Convert this identity to a chibi mage with a staff");
  const draft = ui.drafts.at(-1); assert.equal(draft.prompts.appearance, "Convert this identity to a chibi mage with a staff"); assert.equal(ui.submissions.length, 0);
  await ui.click("生成 Q 版形象"); const request = ui.submissions[0];
  assert.equal(request.kind, "appearance"); assert.equal(request.prompt, draft.prompts.appearance); assert.equal(request.image.base64, "AAAA");
  assert.equal(request.projectId, document.id); assert.equal(request.planner, undefined); assert.equal(request.rig, undefined); assert.equal(ui.saved.length, 0); ui.unmount();
  const restored = workbench({ initialDocument: draft }); await restored.settle(); assert.equal(restored.find((node) => node.props["aria-label"] === "Q 版形象生成说明").props.value, draft.prompts.appearance); restored.unmount();
});

test("Q appearance candidates remain separate until applied and preserve the original reference", async () => {
  const document = empty(), before = structuredClone(document), job = await appearanceJob(document);
  const ui = workbench({ initialDocument: document, history: [job], readImage: async () => appearanceResult }); await ui.settle();
  assert.deepEqual(ui.drafts.at(-1), before); assert.equal(ui.saved.length, 0); assert.ok(ui.find((node) => node.props.alt === "Q 版形象候选，等待确认应用"));
  await ui.click("确认应用 Q 版形象"); const next = ui.drafts.at(-1);
  assert.equal(next.sourceImage, appearanceResult.dataURL); assert.equal(next.appearanceReference.image, before.sourceImage);
  assert.deepEqual([next.joints, next.parts, next.motions], [[], [], []]); assert.equal(next.appearance.jobId, job.id);
  assert.equal(next.appearance.provider, "codex-native"); assert.equal(next.appearance.prompt, job.prompt); assert.match(ui.text(), /下一步点击「AI 结构分析」/);
  assert.equal(ui.saved.length, 0); assert.equal(ui.submissions.length, 0); ui.unmount();
});

test("applying a new Q appearance to an authored rig requires explicit reset confirmation", async () => {
  const document = independentDocument(), before = structuredClone(document), job = await appearanceJob(document);
  const ui = workbench({ initialDocument: document, history: [job], readImage: async () => appearanceResult }); await ui.settle(); await ui.click("确认应用 Q 版形象");
  assert.match(ui.text(), /应用 Q 版形象并重建骨架？/); assert.deepEqual(ui.drafts.at(-1), before);
  await ui.click("取消"); assert.deepEqual(ui.drafts.at(-1), before);
  await ui.click("确认应用 Q 版形象"); await ui.click("应用形象并重建");
  assert.equal(ui.drafts.at(-1).sourceImage, appearanceResult.dataURL); assert.equal(ui.drafts.at(-1).parts.length, 0); assert.equal(ui.saved.length, 0); ui.unmount();
});

test("stale Q appearance sources are rejected before reading images and late image loads cannot overwrite an unmounted draft", async () => {
  const document = empty(); let reads = 0;
  let ui = workbench({ initialDocument: document, history: [await appearanceJob(document, { sourceFingerprint: "0".repeat(64) })], image: async () => { reads++; return new Uint8Array([1]); }, readImage: async () => appearanceResult });
  await ui.settle(); await ui.click("确认应用 Q 版形象"); assert.match(ui.text(), /立绘已改变/); assert.equal(reads, 0); assert.deepEqual(ui.drafts.at(-1), document); ui.unmount();
  const reply = deferred();
  ui = workbench({ initialDocument: document, history: [await appearanceJob(document)], image: () => reply.promise, readImage: async () => appearanceResult });
  await ui.settle(); const applying = ui.find((node) => node.type === "button" && text(node) === "确认应用 Q 版形象").props.onClick(); await ui.settle(); ui.unmount(); reply.resolve(new Uint8Array([1])); await applying; await new Promise(setImmediate);
  assert.equal(ui.writesAfterUnmount, 0); assert.deepEqual(ui.drafts.at(-1), document);
});

test("AI structure and explicit program drafts retain appearance reference, prompts and provenance", async () => {
  const initial = empty(); initial.prompts = { appearance: "Cel shaded chibi" }; initial.appearance = { jobId: "appearance-job", provider: "codex-native" };
  initial.appearanceReference = { image: "data:image/png;base64,BBBB", width: 1029, height: 1528, name: "original.png" };
  const rig = authoring.createHumanoidDraft(initial); rig.motions = [];
  const ui = workbench({ initialDocument: initial, history: [{ id: "structure-job", projectId: initial.id, kind: "structure", status: "completed", provider: { label: "Codex" }, result: { rig } }] });
  await ui.settle(); await ui.click("确认应用结构"); let next = ui.drafts.at(-1);
  assert.deepEqual(next.appearanceReference, initial.appearanceReference); assert.deepEqual(next.appearance, initial.appearance); assert.deepEqual(next.prompts, initial.prompts);
  await ui.click("先用程序人形初稿"); await ui.click("确认替换结构"); next = ui.drafts.at(-1);
  assert.deepEqual(next.appearanceReference, initial.appearanceReference); assert.deepEqual(next.appearance, initial.appearance); assert.deepEqual(next.prompts, initial.prompts); ui.unmount();
});

test("structure precision defaults to detailed and changing it never rebuilds the existing rig", async () => {
  const document = independentDocument(), before = structuredClone(document);
  let ui = workbench({ initialDocument: document }); await ui.settle();
  assert.equal(ui.find((node) => node.props["aria-label"] === "结构部件精细度").props.value, "detailed");
  assert.match(ui.find((node) => node.props["aria-label"] === "AI 结构分析说明").props.value, /手掌与前臂分开/);
  assert.match(ui.text(), /最多 64 个部件/);
  await ui.click("AI 结构分析"); assert.equal(ui.submissions[0].detail, "detailed"); assert.deepEqual(ui.drafts.at(-1), before); ui.unmount();
  ui = workbench({ initialDocument: document }); await ui.settle(); await ui.change("结构部件精细度", "standard");
  const next = ui.drafts.at(-1); assert.equal(next.structureDetail, "standard"); assert.deepEqual(next.joints, before.joints); assert.deepEqual(next.parts, before.parts); assert.deepEqual(next.motions, before.motions);
  await ui.click("AI 结构分析"); assert.equal(ui.submissions[0].detail, "standard"); assert.equal(ui.saved.length, 0); ui.unmount();
});

async function partialPartsJob(document, status = "failed") {
  const sourceFingerprint = await rigClient.rigSourceFingerprint(document);
  const images = document.parts.slice(0, 2).map((part, index) => ({ id: `image-${index}`, partId: part.id, sourceFingerprint, width: part.width, height: part.height, canvasWidth: document.width, canvasHeight: document.height,
    url: `/api/rig/jobs/parts-job/images/image-${index}`, raw: { id: `image-${index}-raw`, file: `image-${index}-raw.png`, width: 1024, height: 1536, url: `/api/rig/jobs/parts-job/images/image-${index}-raw` } }));
  return { id: "parts-job", kind: "parts", status, projectId: document.id, partIds: document.parts.slice(0, 3).map((part) => part.id), total: 3, completed: 2, sourceWidth: document.width, sourceHeight: document.height, sourceFingerprint,
    geometry: rigClient.rigGeometry(document), images, provider: { id: "codex-native", label: "Codex 账号" }, model: "native-image", error: "One part failed" };
}

test("partial successes apply logical images and preserve raw provenance before retrying the frozen snapshot", async () => {
  const document = independentDocument(), before = structuredClone(document), job = await partialPartsJob(document), reads = [];
  const ui = workbench({ initialDocument: document, history: [job], image: async (id, image) => { reads.push(image.url); return new Uint8Array([1]); }, readPartImage: async (bytes, dimensions) => ({ dataURL: "data:image/png;base64,BBBB", width: dimensions.expectedWidth, height: dimensions.expectedHeight, transparent: true }) });
  await ui.settle(); assert.match(ui.text(), /继续未完成 1 个部件/); assert.match(ui.text(), /原生 1024 × 1536/);
  await ui.click("应用 2 个补绘候选"); const next = ui.drafts.at(-1);
  assert.equal(next.parts[0].imageGeneration.jobId, job.id); assert.deepEqual(next.parts[0].imageGeneration.raw, job.images[0].raw);
  assert.deepEqual(next.parts[0].imageGeneration.logical, { width: job.images[0].width, height: job.images[0].height, url: job.images[0].url });
  assert.equal(next.parts[0].imageSource, "ai"); assert.deepEqual(next.joints, before.joints); assert.deepEqual(next.motions, before.motions); assert.deepEqual(next.parts[2], before.parts[2]);
  assert.deepEqual(reads, job.images.map((image) => image.url));
  await ui.change("续做部件并发数量", "4"); await ui.click("继续未完成 1 个部件");
  assert.deepEqual(ui.retries, [{ id: job.id, options: { concurrency: 4 } }]); assert.equal(ui.submissions.length, 0); assert.equal(ui.saved.length, 0); assert.match(ui.text(), /原任务快照继续/); ui.unmount();
});

test("changed source images reject both partial application and snapshot retries before any remote operation", async () => {
  const original = independentDocument(), job = await partialPartsJob(original), changed = { ...original, sourceImage: "data:image/png;base64,BBBB" }; let reads = 0;
  const ui = workbench({ initialDocument: changed, history: [job], image: async () => { reads++; return new Uint8Array([1]); } }); await ui.settle();
  await ui.click("应用 2 个补绘候选"); assert.match(ui.text(), /源立绘已改变/); assert.equal(reads, 0); assert.deepEqual(ui.drafts.at(-1), changed);
  await ui.click("继续未完成 1 个部件"); assert.match(ui.text(), /源立绘已改变/); assert.equal(ui.retries.length, 0); assert.equal(ui.submissions.length, 0); ui.unmount();
});

test("reapplying an already applied candidate preserves later calibration and makes no image request", async () => {
  const document = independentDocument(), job = await partialPartsJob(document); job.images = job.images.slice(0, 1);
  document.parts[0] = { ...document.parts[0], imageSource: "calibrated", imageGeneration: { jobId: job.id, imageId: job.images[0].id, raw: job.images[0].raw } };
  let reads = 0; const ui = workbench({ initialDocument: document, history: [job], image: async () => { reads++; return new Uint8Array([1]); } });
  await ui.settle(); await ui.click("应用 1 个补绘候选"); assert.equal(reads, 0); assert.deepEqual(ui.drafts.at(-1), document); assert.match(ui.text(), /保留当前部件图片及后续校准/); ui.unmount();
});

test("lightweight motion presets add four uniquely named unfinished channels without touching bindings", async () => {
  const document = independentDocument(), before = structuredClone({ joints: document.joints, parts: document.parts });
  const ui = workbench({ initialDocument: document }); await ui.settle(); await ui.click("4动作与关键帧");
  for (const [id, duration, loop] of [["run", 0.8, true], ["skill", 1.6, false], ["death", 1.3, false], ["victory", 1.8, false]]) {
    await ui.change("新动作预设", id); await ui.click("添加动作"); const value = ui.drafts.at(-1).motions.find((motion) => motion.id === id);
    assert.equal(value.duration, duration); assert.equal(value.loop, loop); assert.equal(value.origin, "manual-placeholder"); assert.ok(value.description);
  }
  assert.equal(ui.drafts.at(-1).motions.length, 7);
  await ui.change("新动作预设", "run"); await ui.click("添加动作"); assert.ok(ui.drafts.at(-1).motions.some((motion) => motion.id === "run-2" && motion.name === "跑步 2"));
  await ui.change("新动作预设", "custom"); await ui.click("添加动作"); assert.match(ui.drafts.at(-1).motions.at(-1).id, /^motion-/); assert.equal(ui.drafts.at(-1).motions.at(-1).origin, "manual");
  assert.deepEqual({ joints: ui.drafts.at(-1).joints, parts: ui.drafts.at(-1).parts }, before);
  await ui.click("保存为角色资源"); assert.equal(ui.saved.length, 0); assert.match(ui.text(), /待制作的动作槽/); assert.equal(ui.submissions.length, 0); ui.unmount();
});

function expressionDocument() {
  let document = independentDocument();
  document = rigClient.rigWithPartAttachmentGroup(document, document.parts[0].id, "eyeLeft");
  return rigClient.rigWithPartAttachmentGroup(document, document.parts[1].id, "eyeLeft");
}
const canvasProps = (ui) => ui.find((node) => node.props.onMoveJoint && node.props.visiblePartIds)?.props;

test("non-loop authoring playback holds the final pose and expression, pauses, and replays from zero", async () => {
  const document = expressionDocument(), first = document.parts[0].id, last = document.parts[1].id;
  document.motions = [{ id: "death", name: "死亡", duration: 1.3, loop: false, origin: "manual", poses: [
    { time: 0, angles: {}, attachments: { eyeLeft: first } },
    { time: 1.3, angles: { head: 75 }, attachments: { eyeLeft: last } },
  ] }];
  let now = 0;
  const ui = workbench({ initialDocument: document, now: () => now, bindings: {
    buildRigFiles: async () => ({}), parseBundle: () => ({}),
    parseSkeleton: () => ({ data: { animations: [{ name: "death", duration: 1.3000000715255737 }], skins: [{ name: "default" }], bones: [] } }),
  } });
  await ui.settle(); await ui.click("4动作与关键帧");
  now = 1300; await ui.tick();
  assert.equal(ui.find((node) => node.props["aria-label"] === "骨架动画时间").props.value, 1.3);
  assert.match(ui.text(), /1\.30 \/ 1\.30s/);
  assert.ok(ui.find((node) => node.props["aria-label"] === "播放骨架动画"));
  assert.equal(canvasProps(ui).pose.angles.head, 75);
  assert.equal(canvasProps(ui).pose.attachmentSelection.eyeLeft, last);
  now = 8000; await ui.tick();
  assert.equal(canvasProps(ui).pose.angles.head, 75, "the paused clock cannot run past the last pose");
  ui.find((node) => node.props["aria-label"] === "播放骨架动画").props.onClick(); await ui.settle();
  assert.equal(ui.find((node) => node.props["aria-label"] === "骨架动画时间").props.value, 0);
  assert.equal(canvasProps(ui).pose.attachmentSelection.eyeLeft, first);
  await ui.click("1.30s");
  assert.equal(canvasProps(ui).pose.attachmentSelection.eyeLeft, last, "selecting the final keyframe must not wrap");
  await ui.change("骨架动画时间", "0.65");
  assert.equal(canvasProps(ui).pose.angles.head, 37.5, "paused timeline and overlay sample the same time");
  await ui.change("骨架动画时间", "1.3");
  assert.equal(canvasProps(ui).pose.attachmentSelection.eyeLeft, last);
  await ui.click("更新动画预览");
  const viewer = ui.find((node) => node.props.label === "新骨架动作预览");
  assert.equal(viewer.props.loop, false); assert.equal(viewer.props.animation, "death");
  now = 12000; await ui.tick(); assert.equal(viewer.props.clock.read(), 0, "building a paused preview resets the shared clock");
  await ui.change("骨架动画时间", "1.3");
  assert.equal(viewer.props.clock.read(), 1.3000000715255737, "the exact authoring endpoint reaches the official Float32 animation end key");
  assert.match(ui.text(), /1\.30 \/ 1\.30s/);
  ui.unmount();
});

test("motion study entry protects idle and planned unapplied frames prevent saving stale old motions", async () => {
  const document = independentDocument(), fingerprints = await motionStudyCore.getMotionStudyFingerprints(document);
  document.motionStudies = { attack: motionStudyClient.motionStudyPlan(document, document.motions.find((motion) => motion.id === "attack"), fingerprints, 3) };
  const ui = workbench({ initialDocument: document }); await ui.settle(); await ui.click("4动作与关键帧");
  assert.ok(ui.find((node) => node.type === "button" && text(node) === "打开动作画面重制").props.disabled, "idle stays protected");
  await ui.change("骨架预览动作", "attack"); await ui.click("打开动作画面重制");
  const panel = ui.find((node) => node.props.onStudyChange && node.props.onPrepare && node.props.onApply);
  assert.equal(panel.props.motion.id, "attack"); assert.equal(panel.props.document.motionStudies.attack.frames.length, 5);
  panel.props.onClose(); await ui.settle(); await ui.click("保存为角色资源");
  assert.equal(ui.saved.length, 0); assert.match(ui.text(), /动作画面计划尚未应用/); assert.match(ui.text(), /候选与草稿仍保留/);
  ui.unmount();
});

test("actual study prepare and apply callbacks preserve base authoring and build a real independent-region Spine preview", async () => {
  const document = pixelRegistrationDocument(); document.id = "study-pixels";
  const part = document.parts[0]; document.parts = [{ ...part, id: "left", x: 8, width: 12 }, { ...part, id: "right", x: 20, width: 12, z: 1 }];
  document.motions.push({ id: "attack", name: "Attack", duration: 1.3, loop: false, origin: "manual", poses: [{ time: 0, angles: {} }, { time: 1.3, angles: {} }] });
  Object.assign(document, authoring.validateRigDocument(document));
  const hashes = await motionStudyCore.getMotionStudyFingerprints(document), study = motionStudyClient.motionStudyPlan(document, document.motions[1], hashes, 3);
  study.frames[1].time = .18; study.frames[2].time = .38; study.frames[3].time = .75;
  for (const frame of study.frames) {
    if (!frame.imageRef) frame.image = document.sourceImage;
    frame.sourceFingerprint = hashes.baseFingerprint; frame.review = { approved: true }; frame.mappingReview = { approved: true };
    frame.mapping = { frameId: frame.id, sourceFingerprint: frame.sourceFingerprint, joints: [{ id: "root", x: 20, y: 20 }], parts: [
      { partId: "left", visible: true, z: 0, sourcePolygon: [{ x: 8, y: 8 }, { x: 20, y: 8 }, { x: 20, y: 32 }, { x: 8, y: 32 }] },
      { partId: "right", visible: true, z: 1, sourcePolygon: [{ x: 20, y: 8 }, { x: 32, y: 8 }, { x: 32, y: 32 }, { x: 20, y: 32 }] },
    ] };
  }
  document.motionStudies = { attack: study }; const before = structuredClone(document);
  let now = 0;
  const ui = workbench({ initialDocument: document, now: () => now, bindings: {
    prepareMotionStudyFrames: (doc, id) => motionStudyCore.prepareMotionStudyFrames(doc, id, undefined, { pixels: pixelEnv }),
    applyMotionStudy: (doc, id) => motionStudyCore.applyMotionStudy(doc, id, { pixels: pixelEnv }),
    buildRigFiles: (doc) => authoring.buildRigFiles(doc, pixelEnv), parseBundle, parseSkeleton,
  } });
  await ui.settle(); await ui.click("4动作与关键帧"); await ui.change("骨架预览动作", "attack"); await ui.click("打开动作画面重制");
  const oldAngleEdit = ui.find((node) => node.props.label === "骨骼角度（度）")?.props.onChange;
  assert.ok(oldAngleEdit, "unapplied candidates retain the active continuous editor");
  const panel = () => ui.find((node) => node.props.onStudyChange && node.props.onPrepare && node.props.onApply);
  const checked = await panel().props.onPrepare("attack"); await ui.settle();
  assert.ok(checked.frames.every((frame) => frame.alphaIoU === 1 && frame.pixelMAE === 0));
  assert.ok(ui.drafts.at(-1).motionStudies.attack.frames.every((frame) => frame.composition && frame.segments.length === 2));
  assert.deepEqual(document, before, "all source authoring remains immutable during staged preparation");
  await panel().props.onApply("attack"); await ui.settle();
  const applied = ui.drafts.at(-1), viewer = ui.find((node) => node.props.label === "新骨架动作预览");
  assert.equal(applied.motionStudies.attack.applied.kind, "stepped-parts"); assert.deepEqual(applied.parts, before.parts); assert.deepEqual(applied.motions, before.motions);
  assert.equal(ui.find((node) => node.props.label === "骨骼角度（度）"), undefined);
  assert.equal(ui.find((node) => node.props.label === "重心偏移 X"), undefined);
  assert.equal(ui.find((node) => node.props["aria-label"] === "关键帧插值"), undefined);
  assert.match(ui.text(), /当前播放已审阅的动作原画与独立区域/);
  oldAngleEdit(77); await ui.settle();
  assert.deepEqual(ui.drafts.at(-1).motions, before.motions, "a stale continuous control callback cannot alter a currently applied study");
  assert.equal(viewer.props.bundle.parts.length, 12, "base parts plus ten real independent source regions enter the atlas");
  const { data } = parseSkeleton(viewer.props.bundle), skeleton = new Skeleton(data), state = new AnimationState(new AnimationStateData(data));
  const officialFrame = (time) => {
    skeleton.setupPose(); const track = state.setAnimation(0, "attack", false); track.trackTime = time;
    state.apply(skeleton); skeleton.updateWorldTransform(Physics.none);
    return skeleton.drawOrder.appliedPose.filter((slot) => slot.appliedPose.attachment).map((slot) => slot.appliedPose.attachment.path);
  };
  const preceding = motionStudyCore.motionStudyRegionName("attack", "frame-1", "left"), strike = motionStudyCore.motionStudyRegionName("attack", "frame-2", "left");
  const axTime = 0.3799999952316284, keyTime = motionStudyCore.motionStudyKeyTime(.38);
  assert.equal(axTime, Math.fround(.38)); assert.ok(keyTime > .38);
  assert.ok(officialFrame(axTime).includes(preceding)); assert.ok(officialFrame(.38).includes(preceding), "the actual compiled boundary must not be moved earlier");
  assert.ok(officialFrame(keyTime).includes(strike));
  for (const [input, expectedTime, expectedRegion] of [[.379999, .379999, preceding], [axTime, keyTime, strike], [.38, keyTime, strike]]) {
    await ui.change("骨架动画时间", String(input));
    assert.equal(viewer.props.clock.read(), expectedTime); assert.ok(officialFrame(viewer.props.clock.read()).includes(expectedRegion));
  }
  await ui.change("骨架动画时间", "1.3");
  assert.equal(viewer.props.clock.read(), motionStudyCore.motionStudyKeyTime(1.3), "rendering reaches the final Float32 attachment key");
  assert.ok(officialFrame(viewer.props.clock.read()).includes(motionStudyCore.motionStudyRegionName("attack", "end", "left")), "the final official runtime attachment remains visible");
  panel().props.onClose(); await ui.settle(); await ui.click("叠图");
  assert.equal(canvasProps(ui).pose.kind, "motion-study"); assert.equal(canvasProps(ui).document.sourceImage, document.sourceImage);
  assert.equal(canvasProps(ui).pose.frameId, "end", "the non-loop endpoint also holds the last overlay attachment");
  await ui.change("骨架动画时间", "0"); ui.find((node) => node.props["aria-label"] === "播放骨架动画").props.onClick(); await ui.settle(); now = 380; await ui.tick();
  assert.equal(viewer.props.clock.read(), .38); assert.ok(officialFrame(viewer.props.clock.read()).includes(preceding));
  assert.equal(canvasProps(ui).pose.frameId, "frame-1", "normal elapsed time keeps the exact compiler boundary without seek snapping");
  await ui.change("骨架动画时间", String(axTime)); assert.equal(canvasProps(ui).pose.frameId, "frame-2", "manual exact-step seeking keeps overlay and Spine on the same source frame");
  await ui.change("骨架预览动作", "idle"); assert.ok(ui.find((node) => node.props.label === "骨骼角度（度）"), "the protected continuous idle editor remains available");
  ui.unmount();
});

test("looping authoring playback still wraps without pausing and forwards its loop setting", async () => {
  const document = expressionDocument(); document.motions = [{ id: "idle", name: "待机", duration: 1, loop: true, origin: "manual", poses: [
    { time: 0, angles: {}, attachments: { eyeLeft: document.parts[0].id } },
    { time: 0.5, angles: { head: 20 }, attachments: { eyeLeft: document.parts[1].id } },
    { time: 1, angles: {}, attachments: { eyeLeft: document.parts[0].id } },
  ] }];
  let now = 0;
  const ui = workbench({ initialDocument: document, now: () => now, bindings: {
    buildRigFiles: async () => ({}), parseBundle: () => ({}),
    parseSkeleton: () => ({ data: { animations: [{ name: "idle", duration: 1 }], skins: [{ name: "default" }], bones: [] } }),
  } });
  await ui.settle(); await ui.click("4动作与关键帧");
  now = 1500; await ui.tick();
  assert.equal(ui.find((node) => node.props["aria-label"] === "骨架动画时间").props.value, .5);
  assert.equal(canvasProps(ui).pose.angles.head, 20);
  assert.ok(ui.find((node) => node.props["aria-label"] === "暂停骨架动画"));
  now = 2000; await ui.tick();
  assert.equal(ui.find((node) => node.props["aria-label"] === "骨架动画时间").props.value, 0);
  assert.equal(canvasProps(ui).pose.attachmentSelection.eyeLeft, document.parts[0].id);
  await ui.click("更新动画预览");
  assert.equal(ui.find((node) => node.props.label === "新骨架动作预览").props.loop, true);
  ui.unmount();
});

test("group defaults and temporary previews remain exclusive while copied variants stay unfinished", async () => {
  const document = expressionDocument(), [first, second] = document.parts;
  document.parts[0].imageGeneration = { jobId: "original-job", raw: { id: "raw" } };
  const ui = workbench({ initialDocument: document }); await ui.settle(); await ui.click("2拆分与补绘");
  assert.equal(ui.find((node) => node.props["aria-label"] === "部件显示组").props.value, "eyeLeft");
  await ui.change("显示组默认附件", second.id); assert.equal(ui.drafts.at(-1).defaultAttachments.eyeLeft, second.id);
  assert.ok(canvasProps(ui).visiblePartIds.includes(second.id)); assert.ok(!canvasProps(ui).visiblePartIds.includes(first.id));
  await ui.click("预览此附件"); assert.ok(canvasProps(ui).visiblePartIds.includes(first.id)); assert.ok(!canvasProps(ui).visiblePartIds.includes(second.id));
  assert.equal(ui.drafts.at(-1).defaultAttachments.eyeLeft, second.id);
  await ui.click("恢复默认表情"); assert.ok(canvasProps(ui).visiblePartIds.includes(second.id));
  await ui.click("复制为新变体"); const next = ui.drafts.at(-1), variant = next.parts.at(-1);
  assert.equal(variant.attachmentGroup, "eyeLeft"); assert.equal(variant.bone, first.bone); assert.equal(variant.z, first.z);
  assert.equal(variant.image, undefined); assert.equal(variant.imageGeneration, undefined); assert.equal(variant.completion, "needs-inpaint"); assert.equal(variant.imageSource, "placeholder");
  assert.equal(next.defaultAttachments.eyeLeft, second.id); assert.equal(ui.submissions.length, 0); assert.equal(ui.saved.length, 0); ui.unmount();
});

test("new parts can join a display group and custom IDs validate before changing the document", async () => {
  const document = independentDocument(), ui = workbench({ initialDocument: document }); await ui.settle(); await ui.click("2拆分与补绘");
  await ui.change("新增部件显示组", "mouth"); await ui.click("添加部件"); let next = ui.drafts.at(-1), added = next.parts.at(-1);
  assert.equal(added.attachmentGroup, "mouth"); assert.equal(next.defaultAttachments.mouth, added.id);
  await ui.change("部件显示组", "__custom__"); await ui.change("新显示组 ID", "invalid group"); await ui.click("创建并加入显示组");
  assert.match(ui.text(), /显示组 ID/); assert.equal(ui.drafts.at(-1).parts.at(-1).attachmentGroup, "mouth");
  await ui.change("新显示组 ID", "accessoryLeft"); await ui.click("创建并加入显示组"); next = ui.drafts.at(-1);
  assert.equal(next.parts.at(-1).attachmentGroup, "accessoryLeft"); assert.equal(next.defaultAttachments.accessoryLeft, added.id); assert.equal(Object.hasOwn(next.defaultAttachments, "mouth"), false);
  await ui.click("删除此部件"); next = ui.drafts.at(-1); assert.equal(next.parts.length, document.parts.length); assert.deepEqual(next.defaultAttachments, {}); ui.unmount();
});

test("keyframe expression selectors support explicit variants hidden state and inherited state", async () => {
  const document = expressionDocument(), before = structuredClone({ parts: document.parts, joints: document.joints });
  const ui = workbench({ initialDocument: document }); await ui.settle(); await ui.click("4动作与关键帧");
  await ui.change("关键帧显示组 eyeLeft", document.parts[1].id);
  assert.equal(ui.drafts.at(-1).motions[0].poses[0].attachments.eyeLeft, document.parts[1].id);
  await ui.change("关键帧显示组 eyeLeft", "__hidden__"); assert.equal(ui.drafts.at(-1).motions[0].poses[0].attachments.eyeLeft, null);
  await ui.change("关键帧显示组 eyeLeft", "__inherit__"); assert.equal(Object.hasOwn(ui.drafts.at(-1).motions[0].poses[0].attachments, "eyeLeft"), false);
  await ui.change("关键帧显示组 eyeLeft", document.parts[1].id); await ui.click("插入帧");
  const next = ui.drafts.at(-1), copied = next.motions[0].poses.find((pose) => !document.motions[0].poses.some((old) => old.time === pose.time));
  assert.equal(copied.attachments.eyeLeft, document.parts[1].id); assert.notEqual(copied.attachments, next.motions[0].poses[0].attachments);
  assert.deepEqual({ parts: next.parts, joints: next.joints }, before); assert.equal(ui.submissions.length, 0); ui.unmount();
});

test("foot lock reports identify contact sample counts and avoid treating unlocked zeroes as full acceptance", async () => {
  const ui = workbench({ initialDocument: independentDocument(), inspect: () => ({ finite: true, issues: ["Contact requires correction"], samples: 61, maxFootSlide: { left: 0, right: 0 }, footContactSamples: { left: 0, right: 18 } }) });
  await ui.settle(); await ui.click("保存为角色资源"); assert.match(ui.text(), /脚锁接触采样：左 0 \/ 右 18/); assert.match(ui.text(), /0 次接触不代表已验证完整脚滑/); assert.equal(ui.saved.length, 0); ui.unmount();
});

test("RigCanvas renders one default or preview attachment per group while ordinary layers stay visible", async () => {
  const source = await readFile(new URL("../src/components/RigCanvas.jsx", import.meta.url), "utf8");
  const { code } = await transformWithEsbuild(source.replace(/^import .*;\n/gm, "").replace("export function RigCanvas", "function RigCanvas"), "RigCanvas.jsx", { loader: "jsx", jsx: "transform", jsxFactory: "jsx" });
  const jsx = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const Component = new Function("useRef", "useState", "useEffect", "rigDefaultVisiblePartIds", "jsx", "React", `${code};return RigCanvas;`)((value) => ({ current: value }), (value) => [typeof value === "function" ? value() : value, () => {}], () => {}, rigClient.rigDefaultVisiblePartIds, jsx, { Fragment: "fragment" });
  const document = expressionDocument(), [first, second] = document.parts;
  const props = { document, showImage: false, selectedPart: first.id, onSelectPart() {}, onSelectJoint() {} };
  const ids = (tree) => descendants(tree).filter((node) => node.props["data-rig-part"]).map((node) => node.props["data-rig-part"]);
  const defaults = ids(Component(props)); assert.ok(defaults.includes(first.id)); assert.ok(!defaults.includes(second.id)); assert.ok(defaults.includes(document.parts[2].id));
  const preview = ids(Component({ ...props, visiblePartIds: rigClient.rigDefaultVisiblePartIds(document, { eyeLeft: second.id }) }));
  assert.ok(!preview.includes(first.id)); assert.ok(preview.includes(second.id));
  const hidden = ids(Component({ ...props, visiblePartIds: rigClient.rigDefaultVisiblePartIds(document, { eyeLeft: null }) }));
  assert.ok(!hidden.includes(first.id)); assert.ok(!hidden.includes(second.id)); assert.ok(hidden.includes(document.parts[2].id));
});

async function registrationJob(document) {
  const polygons = Object.fromEntries(rigClient.rigDefaultVisiblePartIds(document).map((id) => {
    const part = document.parts.find((item) => item.id === id);
    return [id, [{ x: part.x, y: part.y }, { x: part.x + part.width, y: part.y }, { x: part.x + part.width, y: part.y + part.height }, { x: part.x, y: part.y + part.height }]];
  }));
  return { id: "registration-job", kind: "registration", status: "completed", projectId: document.id, geometry: rigClient.rigGeometry(document),
    sourceFingerprint: await rigClient.rigSourceFingerprint(document), sourceWidth: document.width, sourceHeight: document.height,
    provider: { id: "codex-native", label: "Codex 账号规划" }, images: [], result: { polygons, gridSize: 32, maxBBoxExpansion: 2, warnings: [], canApply: true } };
}

test("registration planning is explicit and viewing polygons leaves the current character unchanged", async () => {
  const document = independentDocument(), before = structuredClone(document);
  let ui = workbench({ initialDocument: document }); await ui.settle(); await ui.click("原图坐标对齐");
  assert.equal(canvasProps(ui).registration.grid, true); assert.equal(canvasProps(ui).registration.mode, "overlay");
  await ui.click("生成坐标对应"); const request = ui.submissions[0];
  assert.equal(request.kind, "registration"); assert.equal(request.gridSize, 32); assert.equal(request.planner, "codex-native"); assert.deepEqual(request.rig, authoring.validateRigDocument(document)); assert.equal(ui.saved.length, 0); ui.unmount();
  const job = await registrationJob(document); ui = workbench({ initialDocument: document, history: [job] }); await ui.settle(); await ui.click("查看坐标对应");
  assert.deepEqual(canvasProps(ui).registration.polygons, job.result.polygons); assert.deepEqual(ui.drafts.at(-1), before); assert.equal(ui.submissions.length, 0); assert.equal(ui.saved.length, 0); ui.unmount();
});

function pixelRegistrationDocument() {
  const source = createCanvas(40, 40), original = source.getContext("2d"); original.fillStyle = "#65b986"; original.fillRect(8, 8, 24, 24);
  const image = createCanvas(12, 24), current = image.getContext("2d"); current.fillStyle = "#6839a3"; current.fillRect(3, 0, 6, 24);
  return authoring.validateRigDocument({ version: 1, id: "registration-pixels", name: "Thin robe", width: 40, height: 40, sourceImage: source.toDataURL("image/png"),
    joints: [{ id: "root", parent: null, x: 20, y: 20 }], parts: [{ id: "body", label: "衣服", bone: "root", x: 14, y: 8, width: 12, height: 24, z: 0, binding: "mesh", influences: ["root"], mesh: { cols: 2, rows: 2, weights: Array.from({ length: 4 }, () => [{ joint: "root", weight: 1 }]) }, image: image.toDataURL("image/png"), imageSource: "ai", completion: "ready" }],
    motions: [{ id: "idle", name: "待机", duration: 1, loop: true, origin: "manual", poses: [{ time: 0, angles: {} }, { time: 1, angles: {} }] }] });
}
const nodeRegistrationBindings = {
  composeRigSourceView: (document) => rigImages.composeRigSourceView(document, pixelEnv),
  inspectRigPartAlpha: (document, id) => rigImages.inspectRigPartAlpha(document, id, pixelEnv),
  expandRigRegistrationBounds: (document, polygons, options) => rigRegistration.expandRigRegistrationBounds(document, polygons, options, pixelEnv),
  registerRigSourcePixels: (document, options) => rigRegistration.registerRigSourcePixels(document, options, pixelEnv),
};
async function pixelRegistrationJob(document) {
  const job = await registrationJob(document);
  job.result.polygons.body = [{ x: 8, y: 8 }, { x: 32, y: 8 }, { x: 32, y: 32 }, { x: 8, y: 32 }]; job.result.canApply = false;
  return job;
}

test("explicit expansion and source-pixel alignment stay temporary until one atomic commit with undo", async () => {
  const document = pixelRegistrationDocument(), before = structuredClone(document), job = await pixelRegistrationJob(document);
  const ui = workbench({ initialDocument: document, history: [job], bindings: nodeRegistrationBindings }); await ui.settle(); await ui.click("查看坐标对应");
  assert.equal(ui.find((node) => node.type === "button" && text(node) === "检查对齐效果").props.disabled, true);
  await ui.click("扩展框并检查对齐效果"); assert.deepEqual(ui.drafts.at(-1), before);
  assert.equal(canvasProps(ui).document.parts[0].width, 24); assert.equal(canvasProps(ui).document.parts[0].x, 8);
  const metrics = ui.find((node) => node.props.metrics?.before)?.props.metrics;
  assert.equal(metrics.alphaIoU, 1); assert.ok(metrics.before.alphaIoU < 0.5); assert.equal(metrics.missingAlphaPixels, 0); assert.equal(metrics.extraAlphaPixels, 0);
  assert.match(ui.text(), /临时像素候选 · 尚未应用/);
  await ui.click("应用原图坐标对齐（含扩框）"); const next = ui.drafts.at(-1);
  assert.equal(next.parts[0].width, 24); assert.equal(next.parts[0].x, 8); assert.notEqual(next.parts[0].image, before.parts[0].image);
  assert.deepEqual(next.parts[0].mesh.weights, before.parts[0].mesh.weights); assert.deepEqual(next.joints, before.joints); assert.deepEqual(next.motions, before.motions);
  assert.equal(next.registration.compositionFingerprint, await rigClient.rigCompositionFingerprint(next)); assert.equal(ui.saved.length, 0); assert.equal(ui.submissions.length, 0);
  ui.find((node) => node.props["aria-label"] === "撤销骨架修改").props.onClick(); await ui.settle(); assert.deepEqual(ui.drafts.at(-1), before); ui.unmount();
});

test("a changed immutable draft rejects a prepared registration candidate instead of overwriting later edits", async () => {
  const document = pixelRegistrationDocument(), job = await pixelRegistrationJob(document);
  const ui = workbench({ initialDocument: document, history: [job], bindings: nodeRegistrationBindings }); await ui.settle(); await ui.click("查看坐标对应"); await ui.click("扩展框并检查对齐效果");
  const apply = ui.find((node) => node.type === "button" && text(node) === "应用原图坐标对齐（含扩框）").props.onClick;
  canvasProps(ui).onMoveJoint("root", 21, 20); await ui.settle(); await apply(); await ui.settle();
  assert.match(ui.text(), /当前草稿已改变/); assert.equal(ui.drafts.at(-1).joints[0].x, 21); assert.equal(ui.drafts.at(-1).parts[0].width, 12); assert.equal(ui.drafts.at(-1).registration, undefined); ui.unmount();
});

test("applied measurements remain current for joint edits but are labelled historical after image geometry changes", async () => {
  const document = pixelRegistrationDocument(), job = await pixelRegistrationJob(document);
  const ui = workbench({ initialDocument: document, history: [job], bindings: nodeRegistrationBindings }); await ui.settle(); await ui.click("查看坐标对应"); await ui.click("扩展框并检查对齐效果"); await ui.click("应用原图坐标对齐（含扩框）");
  canvasProps(ui).onMoveJoint("root", 21, 20); await ui.until(() => ui.text().includes("当前默认组装图片与框未变"));
  const width = ui.find((node) => node.props.label === "矩形宽"); width.props.onChange(25); await ui.settle();
  assert.match(ui.text(), /历史指标不代表当前组装已通过/); await ui.until(() => ui.text().includes("图片或几何已变动")); assert.ok(ui.drafts.at(-1).registration.metrics); ui.unmount();
});

test("registration detail controls follow the selected part without changing document coordinates", async () => {
  const document = independentDocument(), before = structuredClone(document), job = await registrationJob(document);
  const ui = workbench({ initialDocument: document, history: [job] }); await ui.settle(); await ui.click("查看坐标对应");
  assert.equal(canvasProps(ui).registration.onlySelected, true); assert.equal(canvasProps(ui).registration.focus, false);
  await ui.click("查看选中部件细节"); assert.equal(canvasProps(ui).registration.focus, true);
  await ui.change("坐标对齐部件", document.parts[1].id); assert.equal(canvasProps(ui).selectedPart, document.parts[1].id); assert.equal(canvasProps(ui).registration.focus, true);
  assert.deepEqual(ui.drafts.at(-1), before); await ui.click("显示整图"); assert.equal(canvasProps(ui).registration.focus, false); ui.unmount();
});

test("focused RigCanvas keeps global polygon coordinates and grid labels while isolating the selected part", async () => {
  const source = await readFile(new URL("../src/components/RigCanvas.jsx", import.meta.url), "utf8");
  const { code } = await transformWithEsbuild(source.replace(/^import .*;\n/gm, "").replace("export function RigCanvas", "function RigCanvas"), "RigCanvas.jsx", { loader: "jsx", jsx: "transform", jsxFactory: "jsx" });
  const jsx = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const Component = new Function("useRef", "useState", "useEffect", "rigDefaultVisiblePartIds", "jsx", "React", `${code};return RigCanvas;`)((value) => ({ current: value }), (value) => [typeof value === "function" ? value() : value, () => {}], () => {}, rigClient.rigDefaultVisiblePartIds, jsx, { Fragment: "fragment" });
  const document = { id: "detail", width: 512, height: 512, joints: [{ id: "root", x: 256, y: 256, parent: null }, { id: "other-bone", x: 450, y: 450, parent: "root" }],
    parts: [{ id: "eye", label: "左眼", bone: "root", influences: ["root"], x: 200, y: 180, width: 40, height: 60, z: 1 }, { id: "other", bone: "other-bone", x: 400, y: 400, width: 30, height: 30, z: 2 }] };
  const polygons = { eye: [{ x: 210, y: 190 }, { x: 230, y: 190 }, { x: 230, y: 220 }, { x: 210, y: 220 }], other: [{ x: 400, y: 400 }, { x: 430, y: 400 }, { x: 400, y: 430 }] };
  const before = structuredClone({ document, polygons }), moves = [];
  const tree = Component({ document, selectedPart: "eye", selectedJoint: "root", registration: { focus: true, onlySelected: true, grid: true, mode: "source", polygons }, onMovePolygonVertex: (...args) => moves.push(args), onSelectPolygonVertex() {}, onSelectPart() {}, onSelectJoint() {} });
  const nodes = descendants(tree), svg = nodes.find((node) => node.type === "svg");
  assert.equal(svg.props.viewBox, "186 166 68 78");
  assert.deepEqual(nodes.filter((node) => node.props["data-rig-part"]).map((node) => node.props["data-rig-part"]), ["eye"]);
  assert.deepEqual(nodes.filter((node) => node.props["data-rig-polygon"]).map((node) => node.props["data-rig-polygon"]), ["eye"]);
  assert.equal(nodes.find((node) => node.props["aria-label"] === "关节 other-bone"), undefined);
  assert.ok(nodes.some((node) => node.type === "text" && text(node) === "192"));
  const vertex = nodes.find((node) => node.props["aria-label"] === "轮廓顶点 1"); assert.equal(vertex.props.cx, 210); assert.equal(vertex.props.cy, 190);
  vertex.props.onKeyDown({ key: "ArrowRight", preventDefault() {} }); assert.deepEqual(moves.pop(), ["eye", 0, 211, 190]);
  const inverse = {}; svg.props.ref.current = { setPointerCapture() {}, getScreenCTM: () => ({ inverse: () => inverse }), createSVGPoint: () => ({ x: 0, y: 0, matrixTransform(matrix) { assert.equal(matrix, inverse); return { x: this.x * 2 + 195, y: this.y + 185 }; } }) };
  vertex.props.onPointerDown({ pointerId: 1, preventDefault() {}, stopPropagation() {} }); svg.props.onPointerMove({ clientX: 10, clientY: 20 }); assert.deepEqual(moves.pop(), ["eye", 0, 215, 205]);
  assert.deepEqual({ document, polygons }, before);
});

test("polygon editing and local undo do not alter images and explicit contour save is draft-only", async () => {
  const document = pixelRegistrationDocument(), job = await pixelRegistrationJob(document), before = structuredClone(document);
  const ui = workbench({ initialDocument: document, history: [job], bindings: nodeRegistrationBindings }); await ui.settle(); await ui.click("查看坐标对应");
  canvasProps(ui).onBeginPolygonMove(); canvasProps(ui).onMovePolygonVertex("body", 0, 7, 8); await ui.settle();
  assert.equal(canvasProps(ui).registration.polygons.body[0].x, 7); assert.deepEqual(ui.drafts.at(-1), before);
  ui.find((node) => node.props["aria-label"] === "撤销轮廓修改").props.onClick(); await ui.settle(); assert.equal(canvasProps(ui).registration.polygons.body[0].x, 8);
  canvasProps(ui).onBeginPolygonMove(); canvasProps(ui).onMovePolygonVertex("body", 0, 7, 8); await ui.settle(); await ui.click("保存轮廓草稿");
  const next = ui.drafts.at(-1); assert.equal(next.parts[0].sourcePolygon[0].x, 7); assert.equal(next.parts[0].image, before.parts[0].image); assert.equal(next.parts[0].width, 12);
  assert.equal(ui.saved.length, 0); assert.equal(ui.submissions.length, 0); ui.unmount();
});

test("part annotation navigation keeps the requested time across motion changes without editing the rig", async () => {
  const document = independentDocument(), before = structuredClone(document);
  const ui = workbench({ initialDocument: document, now: () => 0 });
  await ui.settle(); await ui.click("2拆分与补绘");
  const panel = ui.find((node) => node.props.onSeek && node.props.onSelectPart);
  assert.ok(panel);
  const target = document.motions.find((item) => item.id !== document.motions[0].id);
  panel.props.onSelectPart(document.parts[1].id); await ui.settle();
  panel.props.onSeek(target.id, .34); await ui.settle();
  assert.equal(ui.find((node) => node.props["aria-label"] === "骨架预览动作").props.value, target.id);
  assert.equal(ui.find((node) => node.props["aria-label"] === "骨架动画时间").props.value, .34);
  assert.equal(canvasProps(ui).selectedPart, document.parts[1].id);
  assert.equal(canvasProps(ui).partAnnotation.time, .34);
  assert.equal(ui.find((node) => node.props["aria-label"] === "播放骨架动画").props.disabled, false);
  ui.find((node) => node.props.onSeek && node.props.onSelectPart).props.onSeek(target.id, .51); await ui.settle();
  assert.equal(canvasProps(ui).partAnnotation.time, .51);
  assert.deepEqual(ui.drafts.at(-1), before); assert.equal(ui.submissions.length, 0); ui.unmount();
});

test("the part grid labels the sampled world position and never shows a hidden variant at its setup rectangle", async () => {
  const source = await readFile(new URL("../src/components/RigCanvas.jsx", import.meta.url), "utf8");
  const { code } = await transformWithEsbuild(source.replace(/^import .*;\n/gm, "").replace("export function RigCanvas", "function RigCanvas"), "RigCanvas.jsx", { loader: "jsx", jsx: "transform", jsxFactory: "jsx" });
  const jsx = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const Component = new Function("useRef", "useState", "useEffect", "rigDefaultVisiblePartIds", "jsx", "React", `${code};return RigCanvas;`)((value) => ({ current: value }), (value) => [typeof value === "function" ? value() : value, () => {}], () => {}, rigClient.rigDefaultVisiblePartIds, jsx, { Fragment: "fragment" });
  const document = expressionDocument(), part = document.parts[0], before = structuredClone(document);
  const pose = { joints: {}, visiblePartIds: [part.id], parts: { [part.id]: { vertices: [16,32,80,32,80,96,16,96] } } };
  const props = { document, selectedPart: part.id, pose, partAnnotation: { motionName: "Attack", time: .34 }, showImage: false };
  const tree = Component(props), nodes = descendants(tree);
  assert.match(text(tree), /第 2 列 \/ 第 3 行 · X 48.0 \/ Y 64.0/);
  assert.ok(nodes.find((node) => node.props["aria-label"] === "32 像素原图坐标网格"));
  assert.equal(nodes.filter((node) => node.props["aria-label"]?.startsWith("关节 ")).length, 0);
  const hidden = Component({ ...props, pose: { ...pose, visiblePartIds: [] } });
  assert.match(text(hidden), /当前隐藏/); assert.doesNotMatch(text(hidden), /X 48.0/);
  assert.deepEqual(document, before);
});

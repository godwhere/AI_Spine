import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";
import { createCanvas } from "@napi-rs/canvas";
import { createHumanoidDraft } from "../src/infrastructure/rig-authoring.js";
import { validateRigDocument, validateMotionStudyMapping } from "../shared/rig-schema.mjs";
import { rigClient as rig, motionStudyCore as motionCore } from "./support/rig-bindings.mjs";
import * as studies from "../src/application/motion-study.js";
import { pixelEnv } from "./helpers.mjs";

const { getMotionStudyFingerprints } = motionCore;

const source = await readFile(new URL("../src/features/rig/MotionStudyPanel.jsx", import.meta.url), "utf8");
const imports = [...source.matchAll(/^import\s*\{([^}]+)\}\s*from[^;]+;/gm)].flatMap((match) => match[1].split(",").map((value) => value.trim()));
const { code } = await transformWithEsbuild(source.replace(/^import\s*\{[^}]+\}\s*from[^;]+;\n/gm, "").replace("export function MotionStudyPanel", "function MotionStudyPanel"), "MotionStudyPanel.jsx", { loader: "jsx", jsx: "transform", jsxFactory: "jsx" });
const factory = new Function(...imports, "jsx", "React", "setInterval", "clearInterval", `${code};return {MotionStudyPanel,MotionStudyCanvas};`);
const descend = (node) => node && typeof node === "object" ? [node, ...(node.children || []).flatMap(descend)] : [];
const text = (node) => typeof node === "string" || typeof node === "number" ? String(node) : node && typeof node === "object" ? (node.children || []).map(text).join("") : "";
const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
function png(color = "#bc6eae") {
  const canvas = createCanvas(80, 100), context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(18, 10, 44, 80);
  return new Uint8Array(canvas.toBuffer("image/png"));
}
function character() {
  return createHumanoidDraft({ id: "panel-character", width: 80, height: 100, sourceImage: rig.bytesToImageDataURL(png()) });
}

function panel({ initialDocument = character(), motionId = "attack", history = [], get, start, image = async () => png("#4f9acf"), bindings = {} } = {}) {
  const cells = [], timers = new Map(), jobs = new Map(history.map((job) => [job.id, job])), requests = [], drafts = [], busy = [], checkpoints = [];
  let cursor = 0, dirty = true, effects = [], tree, document = initialDocument, mounted = true, writesAfterUnmount = 0, timerId = 0, closed = 0;
  const state = (initial) => { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial; return [cells[index], (value) => { if (!mounted) writesAfterUnmount++; const next = typeof value === "function" ? value(cells[index]) : value; if (!Object.is(cells[index], next)) { cells[index] = next; dirty = true; } }]; };
  const ref = (initial) => { const index = cursor++; return cells[index] ||= { current: initial }; };
  const effect = (callback, dependencies) => { const index = cursor++, previous = cells[index]; if (!same(previous?.dependencies, dependencies)) effects.push(() => { previous?.cleanup?.(); cells[index] = { dependencies, cleanup: callback() }; }); };
  const jsx = (type, props, ...children) => {
    const flat = children.flat(Infinity); for (const child of flat) if (child && typeof child === "object" && !("type" in child)) throw new Error("Object passed as React child");
    return { type, props: props || {}, children: flat };
  };
  const client = {
    list: async () => [...jobs.values()].map(({ result, ...job }) => job), get: async (id) => get ? get(id, jobs.get(id)) : jobs.get(id), image,
    start: async (request) => {
      requests.push(request);
      const job = start ? await start(request) : { id: `job-${requests.length}`, status: "queued", kind: request.kind, projectId: request.projectId, motionId: request.motion.id,
        ...Object.fromEntries(["baseFingerprint", "geometryFingerprint", "protectedIdleFingerprint", "originalArtworkFingerprint"].map((key) => [key, request[key]])),
        geometry: rig.rigGeometry(request.rig), frames: request.frames, provider: { id: "codex-native", label: "Codex 账号" }, total: request.frames.length, completed: 0 };
      jobs.set(job.id, job); return job;
    }, cancel: async (id) => { const job = { ...jobs.get(id), status: "cancelled" }; jobs.set(id, job); return job; },
  };
  const values = { ...rig, ...studies, ...motionCore, validateMotionStudyMapping, useState: state, useRef: ref, useEffect: effect, createRigClient: () => client,
    loadMotionStudyImages: (...args) => studies.loadMotionStudyImages(...args.slice(0, 5), async (bytes) => ({ dataURL: rig.bytesToImageDataURL(bytes) })), ...bindings };
  const Component = factory(...imports.map((name) => values[name]), jsx, { Fragment: "fragment" }, (callback) => { timers.set(++timerId, callback); return timerId; }, (id) => timers.delete(id)).MotionStudyPanel;
  const onBusyChange = (value) => busy.push(value);
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      if (dirty) {
        cursor = 0; dirty = false; effects = [];
        tree = Component({ imageTools: values, client, document, motion: document.motions.find((motion) => motion.id === motionId), onBusyChange, onClose: () => { closed++; },
          onStudyChange: (id, update, { checkpoint = false } = {}) => { document = validateRigDocument({ ...document, motionStudies: { ...document.motionStudies, [id]: update(document.motionStudies?.[id]) } }); drafts.push(document); checkpoints.push(checkpoint); dirty = true; } });
        for (const callback of effects) callback();
      }
      await new Promise(setImmediate); if (!dirty) return;
    }
    throw new Error("Panel did not settle");
  };
  const find = (predicate) => descend(tree).find(predicate);
  return { requests, drafts, jobs, busy, checkpoints, settle, find, text: () => text(tree), get document() { return document; }, get closed() { return closed; }, get writesAfterUnmount() { return writesAfterUnmount; },
    async click(label) { const button = find((node) => node.type === "button" && text(node) === label); assert.ok(button, `Missing ${label}`); assert.ok(!button.props.disabled, `${label} disabled`); await button.props.onClick(); await settle(); },
    async change(label, value) { const field = find((node) => node.props["aria-label"] === label); assert.ok(field, `Missing ${label}`); assert.ok(!field.props.disabled, `${label} disabled`); field.props.onChange({ target: { value, checked: value } }); await settle(); },
    async frame(id) { const study = document.motionStudies[motionId], value = study.frames.find((frame) => frame.id === id); const button = find((node) => node.type === "button" && Object.hasOwn(node.props, "aria-pressed") && text(node).includes(value.label)); assert.ok(button); button.props.onClick(); await settle(); },
    async tick() { for (const callback of [...timers.values()]) await callback(); await settle(); },
    unmount() { mounted = false; for (const item of cells) item?.cleanup?.(); },
  };
}

test("planning and changing frame labels/times/prompts is local, persists a valid draft, and never changes idle", async () => {
  const initialDocument = character(), originalIdle = structuredClone(initialDocument.motions[0]), originalParts = structuredClone(initialDocument.parts);
  const ui = panel({ initialDocument }); await ui.settle(); await ui.click("建立画面计划");
  assert.equal(ui.requests.length, 0); assert.equal(ui.document.motionStudies.attack.frames.length, 5);
  await ui.frame("frame-1"); await ui.change("当前动作画面名称", "Anticipation"); await ui.change("当前动作画面时间", "0.22"); await ui.change("当前动作画面说明", "Keep the staff behind the shoulder");
  const frame = ui.document.motionStudies.attack.frames.find((frame) => frame.id === "frame-1");
  assert.equal(frame.label, "Anticipation"); assert.equal(frame.time, .22); assert.equal(frame.prompt, "Keep the staff behind the shoulder");
  assert.deepEqual(ui.document.motions[0], originalIdle); assert.deepEqual(ui.document.parts, originalParts);
  assert.equal(ui.document.sourceImage, initialDocument.sourceImage); assert.equal(ui.requests.length, 0);
  assert.ok(ui.find((node) => node.type === "button" && text(node) === "应用选定动作并查看 Spine 预览").props.disabled);
  ui.unmount();
  const restored = panel({ initialDocument: ui.document }); await restored.settle(); await restored.frame("frame-1");
  assert.equal(restored.find((node) => node.props["aria-label"] === "当前动作画面说明").props.value, frame.prompt); assert.equal(restored.requests.length, 0); restored.unmount();
});

test("visible generation submits three frozen frames, requires explicit load and five review checks, and supports single-frame retry", async () => {
  const bytes = png("#5b9abf"), fingerprint = await rig.rigSourceFingerprint({ sourceImage: rig.bytesToImageDataURL(bytes) });
  const ui = panel({ image: async () => bytes, get: async (id, job) => ({ ...job, status: "completed", completed: job.frames.length,
    images: job.frames.map((frame, index) => ({ id: `image-${index}`, frameId: frame.id, width: 80, height: 100, sourceFingerprint: fingerprint })),
  }) });
  await ui.settle(); await ui.click("建立画面计划"); await ui.click("生成全部新画面");
  assert.equal(ui.requests[0].frames.length, 3); assert.equal(ui.requests[0].concurrency, 3); assert.equal(ui.requests[0].rig.sourceImage, undefined);
  assert.equal(ui.document.motionStudies.attack.frames[1].image, undefined, "AI completion cannot silently apply a picture");
  await ui.tick(); assert.equal(ui.document.motionStudies.attack.frames[1].image, undefined);
  await ui.click("载入已生成画面"); const selected = ui.document.motionStudies.attack.frames.find((frame) => frame.id === "frame-1");
  assert.equal(selected.image, rig.bytesToImageDataURL(bytes)); assert.equal(selected.review.approved, false);
  assert.ok(ui.find((node) => node.type === "button" && text(node) === "确认此画面").props.disabled);
  for (const label of Object.values(studies.motionFrameChecks)) await ui.change(`动作画面审阅 ${label}`, true);
  await ui.click("确认此画面"); assert.equal(ui.document.motionStudies.attack.frames[1].review.approved, true);
  await ui.frame("frame-2"); await ui.click("重新生成所选画面");
  assert.deepEqual(ui.requests[1].frames.map((frame) => frame.id), ["frame-2"]);
  assert.equal(ui.document.motionStudies.attack.frames[1].review.approved, true, "retrying another frame preserves accepted art");
  assert.match(ui.text(), /隐藏补绘未完成/); assert.match(ui.text(), /连续补间未验收/); ui.unmount();
});

test("closing an active job preserves its local plan and history resumes without a second submission", async () => {
  const ui = panel(); await ui.settle(); await ui.click("建立画面计划"); await ui.click("生成全部新画面");
  const document = ui.document, history = [...ui.jobs.values()]; await ui.click("关闭动作画面重制"); assert.equal(ui.closed, 1); ui.unmount();
  const restored = panel({ initialDocument: document, history }); await restored.settle();
  assert.equal(restored.requests.length, 0); assert.match(restored.text(), /等待处理/); assert.ok(restored.find((node) => node.type === "button" && text(node) === "取消动作画面任务")); restored.unmount();
});

test("run repairs only rejected and missing sources, preserves approved frames, and still checks the frozen prompts before loading", async () => {
  let initialDocument = character();
  initialDocument.motions.push({ id: "run", name: "跑步", duration: .8, loop: true, origin: "manual", poses: [{ time: 0 }, { time: .8 }] });
  initialDocument = validateRigDocument(initialDocument);
  const study = studies.motionStudyPlan(initialDocument, initialDocument.motions.find((motion) => motion.id === "run"), await getMotionStudyFingerprints(initialDocument), 4);
  for (const frame of study.frames.slice(0, 3)) {
    frame.image = initialDocument.sourceImage; frame.sourceFingerprint = study.baseFingerprint; frame.origin = "ai-motion-frame";
    frame.imageGeneration = { jobId: "old-run-job", imageId: frame.id };
    frame.review = { approved: frame.id !== "frame-3", rejected: frame.id === "frame-3", checks: { identity: true } };
  }
  study.frames.at(-1).sourceFingerprint = study.baseFingerprint;
  initialDocument.motionStudies = { run: study };
  const preserved = structuredClone(study.frames.slice(0, 2)), bytes = png("#5a97bd"), sourceFingerprint = await rig.rigSourceFingerprint({ sourceImage: rig.bytesToImageDataURL(bytes) });
  const ui = panel({ initialDocument, motionId: "run", image: async () => bytes,
    get: async (id, job) => ({ ...job, status: "completed", completed: 2, images: job.frames.map((frame, index) => ({ id: `image-${index}`, frameId: frame.id, width: 80, height: 100, sourceFingerprint })) }),
  });
  await ui.settle(); await ui.click("生成缺失或已拒绝画面");
  assert.deepEqual(ui.requests[0].frames.map((frame) => frame.id), ["frame-3", "frame-4"]); assert.equal(ui.requests[0].concurrency, 3);
  assert.deepEqual(ui.document.motionStudies.run.frames.slice(0, 2), preserved);
  assert.equal(ui.document.motionStudies.run.frames[3].image, undefined, "completion must remain a separate candidate until loaded");
  await ui.tick(); await ui.frame("frame-3"); const frozenPrompt = ui.requests[0].frames[0].prompt;
  await ui.change("当前动作画面说明", "A newer direction which the completed job did not use"); await ui.click("载入已生成画面");
  assert.match(ui.text(), /画面说明或时间已修改/); assert.equal(ui.document.motionStudies.run.frames[3].image, undefined);
  assert.deepEqual(ui.document.motionStudies.run.frames.slice(0, 2), preserved);
  await ui.change("当前动作画面说明", frozenPrompt); await ui.click("载入已生成画面");
  const next = ui.document.motionStudies.run;
  assert.deepEqual(next.frames.slice(0, 2), preserved, "loading repaired sources preserves accepted images, provenance and review state");
  assert.ok(next.frames.slice(2, 4).every((frame) => frame.image === rig.bytesToImageDataURL(bytes) && !frame.review.approved && !frame.review.rejected));
  assert.ok(ui.find((node) => node.type === "button" && text(node) === "生成缺失或已拒绝画面").props.disabled, "unreviewed existing images must not be regenerated");
  assert.equal(ui.requests.length, 1); ui.unmount();
});

async function gapCharacter() {
  const source = character(), rect = (x, y, width, height) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  let document = validateRigDocument({ ...source, parts: [
    { id: "body", label: "身体", bone: "torso", x: 18, y: 10, width: 22, height: 80, z: 0, binding: "rigid", influences: ["torso"], image: source.sourceImage, imageSource: "uploaded", completion: "ready" },
    { id: "arm", label: "手臂", bone: "rightHand", x: 40, y: 10, width: 22, height: 80, z: 1, binding: "rigid", influences: ["rightHand"], image: source.sourceImage, imageSource: "uploaded", completion: "ready" },
  ] });
  const study = studies.motionStudyPlan(document, document.motions.find((item) => item.id === "attack"), await getMotionStudyFingerprints(document), 3);
  for (const frame of study.frames) {
    if (!frame.imageRef) frame.image = source.sourceImage;
    frame.sourceFingerprint = study.baseFingerprint; frame.review = { approved: true }; frame.mappingReview = { approved: true };
    frame.mapping = { frameId: frame.id, sourceFingerprint: study.baseFingerprint, joints: document.joints.map(({ id, x, y }) => ({ id, x, y })),
      parts: [{ partId: "body", visible: true, z: 0, sourcePolygon: rect(18, 10, 20, 80) }, { partId: "arm", visible: true, z: 1, sourcePolygon: rect(42, 10, 20, 80) }] };
  }
  document.motionStudies = { attack: study }; return validateRigDocument(document);
}
const coverageBindings = () => ({
  diagnoseMotionStudyFrame: (document, motionId, frameId, options) => motionCore.diagnoseMotionStudyFrame(document, motionId, frameId, { ...options, pixels: pixelEnv }),
  proposeMotionStudyGapOwnership: (document, motionId, frameId, options) => motionCore.proposeMotionStudyGapOwnership(document, motionId, frameId, { ...options, pixels: pixelEnv }),
  proposeCalibratedBaseMotionMapping: (document, motionId, frameId) => motionCore.proposeCalibratedBaseMotionMapping(document, motionId, frameId, { pixels: pixelEnv }),
  acceptMotionStudyOwnershipCandidate: (document, motionId, frameId, candidate) => motionCore.acceptMotionStudyOwnershipCandidate(document, motionId, frameId, candidate, { pixels: pixelEnv }),
});

test("visible gap diagnosis and per-part candidate review cannot approve coordinates or rewrite source artwork", async () => {
  const initialDocument = await gapCharacter(), before = structuredClone(initialDocument), ui = panel({ initialDocument, bindings: coverageBindings() });
  await assert.rejects(motionCore.prepareMotionStudyFrames(initialDocument, "attack", undefined, { pixels: pixelEnv }), /缺|未|覆盖/);
  await ui.settle(); await ui.click("检查轮廓缺口");
  assert.match(ui.text(), /有效可见缺口占比 9\.09%/); assert.match(ui.text(), /未归属像素 320/);
  assert.deepEqual(ui.document, before, "diagnosis is read-only"); assert.equal(ui.requests.length, 0);
  await ui.change("缺口归属最大距离", "12"); await ui.click("生成缺口归属候选");
  assert.deepEqual(ui.document, before, "proposing ownership does not apply it");
  assert.ok(ui.find((node) => node.type === "button" && text(node) === "接受已审阅归属候选").props.disabled);
  assert.ok(ui.find((node) => node.type === "button" && ["确认此帧坐标与遮挡", "此帧坐标已确认"].includes(text(node))).props.disabled);
  await ui.change("审阅推定归属 身体", true);
  assert.ok(ui.find((node) => node.type === "button" && text(node) === "接受已审阅归属候选").props.disabled, "each affected part must be reviewed");
  await ui.change("审阅推定归属 手臂", true); await ui.click("接受已审阅归属候选");
  assert.deepEqual(ui.checkpoints, [true], "accepting ownership creates one reversible authoring change");
  const study = ui.document.motionStudies.attack;
  assert.ok(study.frames[0].mapping.gapFill); assert.equal(study.frames[0].mappingReview.approved, false);
  const sourcePolicy = study.frames[0].mapping.gapFill, endPolicy = study.frames.at(-1).mapping.gapFill;
  assert.equal(endPolicy.ownerFingerprint, sourcePolicy.ownerFingerprint, "reused endpoint inherits the same source pixel owners");
  assert.equal(endPolicy.inferredPixels, sourcePolicy.inferredPixels); assert.equal(endPolicy.maxDistance, sourcePolicy.maxDistance);
  assert.notEqual(endPolicy.mappingFingerprint, sourcePolicy.mappingFingerprint, "the endpoint retains its own frame identity");
  assert.equal(study.frames.at(-1).mappingReview.approved, false); assert.equal(study.applied, undefined);
  assert.equal(study.frames[0].segments, undefined); assert.deepEqual(ui.document.parts, before.parts);
  assert.deepEqual(ui.document.motions, before.motions); assert.equal(ui.document.sourceImage, before.sourceImage);
  await assert.rejects(motionCore.applyMotionStudy(ui.document, "attack", { pixels: pixelEnv }), /审阅/);
  await ui.click("确认此帧坐标与遮挡"); assert.equal(ui.document.motionStudies.attack.frames[0].mappingReview.approved, true);
  await ui.change("动作关节坐标 X", "39");
  assert.equal(ui.document.motionStudies.attack.frames[0].mapping.gapFill, undefined, "a changed mapping requires another explicit proposal");
  assert.equal(ui.document.motionStudies.attack.frames[0].mappingReview.approved, false); ui.unmount();
});

test("editing the plan discards its transient ownership candidate and stale async diagnosis cannot update an unmounted panel", async () => {
  const initialDocument = await gapCharacter(), ui = panel({ initialDocument, bindings: coverageBindings() });
  await ui.settle(); await ui.click("检查轮廓缺口"); await ui.click("生成缺口归属候选");
  await ui.change("当前动作画面名称", "Reviewed base source");
  assert.equal(ui.find((node) => node.type === "button" && text(node) === "接受已审阅归属候选"), undefined);
  assert.equal(ui.document.motionStudies.attack.frames[0].mapping.gapFill, undefined); ui.unmount();
  let release;
  const delayed = panel({ initialDocument, bindings: { ...coverageBindings(), diagnoseMotionStudyFrame: () => new Promise((resolve) => { release = resolve; }) } });
  await delayed.settle(); const pending = delayed.click("检查轮廓缺口"); await new Promise(setImmediate); delayed.unmount();
  release({ missingPixels: 320, parts: [] }); await pending;
  assert.equal(delayed.writesAfterUnmount, 0); assert.deepEqual(delayed.document, initialDocument);
});

test("known calibrated base contours and z order require one explicit baseline review and leave coordinate approval pending", async () => {
  const initialDocument = await gapCharacter(), study = initialDocument.motionStudies.attack;
  const rect = (x, width) => [{ x, y: 10 }, { x: x + width, y: 10 }, { x: x + width, y: 90 }, { x, y: 90 }];
  initialDocument.parts[0].sourcePolygon = rect(18, 22); initialDocument.parts[1].sourcePolygon = rect(40, 22);
  initialDocument.registration = { sourceFingerprint: study.baseFingerprint, compositionFingerprint: await rig.rigCompositionFingerprint(initialDocument) };
  study.frames[0].mapping.parts.forEach((part) => { part.z += 20; });
  const before = structuredClone(initialDocument), ui = panel({ initialDocument, bindings: coverageBindings() });
  await ui.settle(); await ui.click("复用已校准基准轮廓");
  assert.deepEqual(ui.document, before, "the old calibrated mapping remains a candidate until explicitly accepted");
  assert.equal(ui.find((node) => node.props["aria-label"] === "审阅推定归属 身体"), undefined, "unchanged accepted baseline parts need no repeated individual checkbox");
  assert.ok(ui.find((node) => node.type === "button" && text(node) === "接受已审阅归属候选").props.disabled);
  await ui.change("已核对整套基准轮廓与层级", true); await ui.click("接受已审阅归属候选");
  const applied = ui.document.motionStudies.attack;
  assert.deepEqual(applied.frames[0].mapping.parts.map((part) => part.z), [0, 1]);
  assert.deepEqual(applied.frames[0].mapping.parts.map((part) => part.sourcePolygon), initialDocument.parts.map((part) => part.sourcePolygon));
  assert.equal(applied.frames[0].mappingReview.approved, false); assert.equal(applied.frames.at(-1).mappingReview.approved, false);
  assert.equal(applied.applied, undefined); assert.deepEqual(ui.document.parts, before.parts); assert.deepEqual(ui.checkpoints, [true]); ui.unmount();
});

test("an independent copied draft reads its prelinked old-project job without submitting AI and missing-device history remains a hint", async () => {
  const initialDocument = await gapCharacter(), study = initialDocument.motionStudies.attack, originalId = initialDocument.id;
  const bytes = png("#519d91"), sourceFingerprint = await rig.rigSourceFingerprint({ sourceImage: rig.bytesToImageDataURL(bytes) });
  const job = { id: "old-project-job", projectId: originalId, kind: "motion-frames", motionId: "attack", motion: study.motion, status: "completed", provider: { id: "codex-native", label: "Codex 账号" },
    geometry: rig.rigGeometry(initialDocument), frames: [{ ...study.frames[1] }], images: [{ id: "image-0", frameId: "frame-1", width: 80, height: 100, sourceFingerprint }],
    ...Object.fromEntries(["baseFingerprint", "geometryFingerprint", "protectedIdleFingerprint", "originalArtworkFingerprint"].map((key) => [key, study[key]])) };
  initialDocument.id = "copied-independent-draft"; study.jobs = [job.id, "not-on-this-device"]; study.activeJobId = job.id;
  const before = structuredClone(initialDocument), ui = panel({ initialDocument, history: [job], image: async () => bytes });
  await ui.settle(); assert.equal(ui.requests.length, 0); assert.deepEqual(ui.document, before);
  assert.match(ui.text(), /部分关联生成记录在当前设备不可用/); assert.ok(ui.find((node) => node.type === "button" && text(node) === "载入已生成画面"));
  await ui.click("载入已生成画面");
  assert.equal(ui.document.motionStudies.attack.frames[1].imageGeneration.jobId, job.id);
  assert.equal(ui.document.motionStudies.attack.frames[1].image, rig.bytesToImageDataURL(bytes)); assert.equal(ui.requests.length, 0); ui.unmount();
  const offline = panel({ initialDocument: before }); await offline.settle();
  assert.match(offline.text(), /原画与坐标已保存在工程中/); assert.equal(offline.find((node) => node.props.role === "alert"), undefined);
  assert.deepEqual(offline.document, before); assert.equal(offline.requests.length, 0); offline.unmount();
});

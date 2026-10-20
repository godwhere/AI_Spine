import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";

// Exercise the real handlers and local UI state without a browser or AI calls.
const source = (await readFile(new URL("../src/components/GenerationPanel.jsx", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export function GenerationPanel", "function GenerationPanel");
const { code } = await transformWithEsbuild(source, "GenerationPanel.jsx", { loader: "jsx", jsx: "transform", jsxFactory: "jsx", jsxFragment: "Fragment" });
const factory = new Function("useEffect", "useRef", "useState", "createLocalGenerationProvider", "prepareGenerationRequest", "readReplacement", "CreationWorkflow",
  "X", "Sparkles", "Upload", "RefreshCw", "Check", "LoaderCircle", "Download", "Square", "jsx", "Fragment", "setInterval", "clearInterval", `${code}; return GenerationPanel;`);
const text = (node) => typeof node === "string" || typeof node === "number" ? String(node) : node && typeof node === "object" ? (node.children || []).map(text).join("") : "";
const descend = (node) => node && typeof node === "object" ? [node, ...(node.children || []).flatMap(descend)] : [];
const sameDependencies = (a, b) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
const fixtureJob = (kind = "parts") => ({ id: `${kind}-job`, kind, status: "completed", projectId: "project", createdAt: "2026-10-20T00:00:00Z", completed: kind === "parts" ? 2 : 1,
  total: kind === "parts" ? 2 : 1, prompt: "Frozen original generation prompt", partIds: kind === "parts" ? ["face", "body"] : [], fingerprint: "frozen-template-fingerprint",
  images: kind === "parts" ? [{ id: "image-face", partId: "face", width: 64, height: 64, url: "/face.png" }, { id: "image-body", partId: "body", width: 64, height: 80, url: "/body.png" }] : [{ id: "appearance-image", width: 100, height: 100, url: "/appearance.png" }] });

function panel({ jobs = [fixtureJob()], currentAnimation = "hurt", initialKind = "parts", applyError = "" } = {}) {
  const cells = [], timers = new Map(), applies = [], imageReads = [], changes = [], requests = [], preparations = [], history = structuredClone(jobs);
  let bundle = { id: "mage", name: "Mage", parts: ["face", "body"].map((id) => ({ id, originalWidth: 64, originalHeight: 64 })), animations: ["idle", "hurt", "dead"] };
  let ai = { appearancePrompt: "Approved identity", partsPrompt: "Keep all joints and the staff grip" }, cursor = 0, effects = [], dirty = true, tree, closed = 0, timerId = 0;
  const original = { bundle: structuredClone(bundle), ai: structuredClone(ai), jobs: structuredClone(jobs) };
  const client = { status: async () => ({ connected: true, label: "Test provider", message: "Ready" }), list: async () => history,
    image: async (jobId, imageId) => { imageReads.push({ jobId, imageId }); return new Uint8Array([1, 2, imageId === "image-face" ? 3 : 4]); },
    start: async (request) => { requests.push(structuredClone(request)); return { ...fixtureJob(request.kind), id: "new-generation", createdAt: "2026-10-20T01:00:00Z" }; },
    cancel: async (id) => ({ ...history.find((job) => job.id === id), status: "cancelled" }), get: async (id) => history.find((job) => job.id === id) };
  const useState = (initial) => { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === "function" ? initial() : initial;
    return [cells[i], (value) => { const next = typeof value === "function" ? value(cells[i]) : value; if (!Object.is(next, cells[i])) { cells[i] = next; dirty = true; } }]; };
  const useRef = (initial) => { const i = cursor++; return cells[i] ||= { current: initial }; };
  const useEffect = (effect, dependencies) => { const i = cursor++, previous = cells[i]; if (!sameDependencies(previous?.dependencies, dependencies)) effects.push(() => {
    previous?.cleanup?.(); cells[i] = { dependencies, cleanup: effect() };
  }); };
  const jsx = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const Component = factory(useEffect, useRef, useState, () => client, async (_bundle, options) => { preparations.push(structuredClone(options));
    return { kind: options.partIds.length ? "parts" : "appearance", ...options }; }, () => { throw new Error("Unexpected file upload"); }, "workflow",
  ...Array(8).fill("icon"), jsx, "fragment", (callback) => { timers.set(++timerId, callback); return timerId; }, (id) => timers.delete(id));
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      if (dirty) { cursor = 0; dirty = false; effects = []; tree = Component({ bundle, projectId: "project", selectedPart: "face", currentAnimation, ai, initialKind,
        captureTemplate: async () => new Uint8Array([9]), onChange(value) { changes.push(value); ai = value; dirty = true; },
        async onApply(...args) { applies.push(args); if (applyError) throw new Error(applyError); }, onClose() { closed++; }, onConfigure() {}, onStep() {} });
        for (const effect of effects) effect(); }
      await new Promise(setImmediate); if (!dirty) return;
    }
    throw new Error("Generation panel did not settle");
  };
  const find = (predicate) => descend(tree).find(predicate);
  return { original, jobs, applies, imageReads, changes, requests, preparations, settle, find, text: () => text(tree),
    field: (label) => find((node) => node.props["aria-label"] === label),
    candidateButton: (partId) => descend(find((node) => node.type === "article" && node.props.className === "generation-candidate" && descend(node).some((child) => child.type === "strong" && text(child) === partId)))
      .find((node) => node.type === "button" && node.props.className === "button primary"),
    bulkButton: () => find((node) => node.type === "button" && node.props.className === "button primary full" && text(node).startsWith("应用")),
    async change(label, value) { const field = this.field(label); assert.ok(field, `Missing ${label}`); field.props.onChange({ target: { value, checked: value } }); await settle(); },
    async click(node, { force = false } = {}) { assert.ok(node, "Missing button"); if (!force) assert.ok(!node.props.disabled, `Disabled ${text(node)}`); await node.props.onClick(); await settle(); },
    async switchKind(kind) { await this.click(find((node) => node.props.role === "tab" && text(node) === (kind === "parts" ? "模板部件" : "角色形象"))); },
    async replaceAnimations(animations) { bundle = { ...bundle, animations }; dirty = true; await settle(); },
    get bundle() { return bundle; }, get ai() { return ai; }, get closed() { return closed; },
    unmount() { for (const cell of cells) cell?.cleanup?.(); },
  };
}

test("default character application preserves one atomic global multi-part callback and frozen job mapping", async () => {
  const ui = panel(); await ui.settle();
  assert.equal(ui.field("候选应用范围").props.value, "character"); assert.equal(ui.field("变体名称"), undefined);
  await ui.click(ui.bulkButton());
  assert.equal(ui.applies.length, 1); const [job, images, scope] = ui.applies[0];
  assert.equal(ui.applies[0].length, 2, "legacy global callback keeps its original two arguments"); assert.equal(scope, undefined);
  assert.deepEqual(job, ui.original.jobs[0]); assert.deepEqual(images.map((image) => image.partId), ["face", "body"]);
  assert.ok(images.every((image) => image.bytes instanceof Uint8Array)); assert.equal(ui.imageReads.length, 2);
  assert.deepEqual(ui.jobs, ui.original.jobs); assert.equal(ui.changes.length, 0); ui.unmount();
});

test("a single candidate can be explicitly applied to named actions without changing its generation target", async () => {
  const ui = panel(); await ui.settle(); await ui.change("候选应用范围", "animations");
  assert.equal(ui.field("用于动作 hurt").props.checked, true, "the current valid action is the initial default");
  assert.ok(ui.candidateButton("face").props.disabled, "a name is required before application");
  await ui.change("变体名称", "  Painful head  "); await ui.change("用于动作 dead", true);
  assert.match(text(ui.candidateButton("face")), /指定 2 个动作/); assert.ok(ui.bulkButton().props.disabled);
  await ui.click(ui.candidateButton("face"));
  assert.equal(ui.applies.length, 1); assert.deepEqual(ui.applies[0][2], { name: "Painful head", animations: ["hurt", "dead"] });
  assert.deepEqual(ui.applies[0][1].map((image) => image.partId), ["face"]); assert.equal(ui.applies[0][0].prompt, ui.original.jobs[0].prompt);
  assert.deepEqual(ui.ai, ui.original.ai); assert.equal(ui.requests.length, 0); assert.equal(ui.changes.length, 0); ui.unmount();
});

test("empty stale and multi-image scopes are rejected by the submit handler before fetching any images", async () => {
  const ui = panel(); await ui.settle(); await ui.change("候选应用范围", "animations"); await ui.change("变体名称", "Hurt head");
  await ui.change("用于动作 hurt", false); assert.ok(ui.candidateButton("face").props.disabled);
  await ui.click(ui.candidateButton("face"), { force: true }); assert.match(ui.text(), /有效动作/); assert.equal(ui.imageReads.length, 0);
  await ui.change("用于动作 hurt", true); await ui.click(ui.bulkButton(), { force: true });
  assert.match(ui.text(), /逐次应用一张候选/); assert.equal(ui.imageReads.length, 0);
  await ui.replaceAnimations(["idle", "dead"]); assert.ok(ui.candidateButton("face").props.disabled);
  await ui.click(ui.candidateButton("face"), { force: true }); assert.match(ui.text(), /有效动作/);
  assert.equal(ui.imageReads.length, 0); assert.equal(ui.applies.length, 0); ui.unmount();
});

test("switching back to global clears the scope while generation inputs and original candidate data stay independent", async () => {
  const ui = panel(); await ui.settle(); await ui.change("候选应用范围", "animations"); await ui.change("变体名称", "Death only");
  await ui.change("用于动作 hurt", false); await ui.change("用于动作 dead", true);
  await ui.click(ui.find((node) => node.type === "button" && text(node).trim() === "生成 2 个部件"));
  assert.equal(ui.requests.length, 1); assert.deepEqual(ui.requests[0].partIds, ["face", "body"]);
  assert.equal(ui.requests[0].prompt, ui.original.ai.partsPrompt);
  assert.ok(!Object.hasOwn(ui.requests[0], "scope")); assert.ok(!Object.hasOwn(ui.requests[0], "animations")); assert.ok(!Object.hasOwn(ui.requests[0], "name"));
  await ui.change("候选应用范围", "character"); await ui.click(ui.candidateButton("face"));
  assert.equal(ui.applies.length, 1); assert.equal(ui.applies[0].length, 2);
  await ui.change("候选应用范围", "animations"); assert.equal(ui.field("变体名称").props.value, "");
  assert.equal(ui.field("用于动作 hurt").props.checked, true); assert.equal(ui.field("用于动作 dead").props.checked, false);
  assert.deepEqual(ui.ai, ui.original.ai); assert.deepEqual(ui.jobs, ui.original.jobs); assert.equal(ui.changes.length, 0); ui.unmount();
});

test("an invalid current action is not silently selected and invalid job part mapping cannot be applied", async () => {
  const ui = panel({ currentAnimation: "foreign-motion" }); await ui.settle(); await ui.change("候选应用范围", "animations"); await ui.change("变体名称", "Head");
  assert.ok(ui.candidateButton("face").props.disabled); assert.equal(ui.field("用于动作 hurt").props.checked, false);
  await ui.click(ui.candidateButton("face"), { force: true }); assert.equal(ui.applies.length, 0); ui.unmount();
  const bad = fixtureJob(); bad.partIds = ["face"];
  const wrong = panel({ jobs: [bad] }); await wrong.settle(); assert.ok(wrong.candidateButton("body").props.disabled);
  await wrong.click(wrong.candidateButton("body"), { force: true }); assert.match(wrong.text(), /部件映射不匹配/);
  assert.equal(wrong.imageReads.length, 0); assert.equal(wrong.applies.length, 0); wrong.unmount();
});

test("failed application and closing retain candidates without persisting scope or applying on cancellation", async () => {
  const ui = panel({ applyError: "Application validation rejected" }); await ui.settle(); await ui.change("候选应用范围", "animations");
  await ui.change("变体名称", "Painful head"); await ui.click(ui.candidateButton("face")); assert.match(ui.text(), /Application validation rejected/);
  assert.ok(ui.candidateButton("face")); assert.equal(ui.field("变体名称").props.value, "Painful head"); assert.equal(ui.applies.length, 1);
  await ui.click(ui.find((node) => node.props["aria-label"] === "关闭 AI 创作")); assert.equal(ui.closed, 1);
  assert.equal(ui.applies.length, 1); assert.equal(ui.changes.length, 0); assert.deepEqual(ui.jobs, ui.original.jobs); ui.unmount();
  const cancelled = panel(); await cancelled.settle(); await cancelled.change("候选应用范围", "animations"); await cancelled.change("变体名称", "Unused head");
  await cancelled.click(cancelled.find((node) => node.type === "button" && text(node) === "返回工作台"));
  assert.equal(cancelled.closed, 1); assert.equal(cancelled.applies.length, 0); assert.equal(cancelled.changes.length, 0); cancelled.unmount();
});

test("the appearance tab has no application scope and still applies an appearance reference normally", async () => {
  const ui = panel({ jobs: [fixtureJob(), fixtureJob("appearance")] }); await ui.settle(); await ui.change("候选应用范围", "animations");
  await ui.switchKind("appearance"); assert.equal(ui.field("候选应用范围"), undefined); assert.equal(ui.field("变体名称"), undefined);
  await ui.click(ui.find((node) => node.type === "button" && text(node).trim() === "设为形象参考"));
  assert.equal(ui.changes.length, 1); assert.equal(ui.applies.length, 0); assert.equal(ui.ai.appearance.jobId, "appearance-job");
  assert.equal(ui.ai.appearance.prompt, "Frozen original generation prompt"); ui.unmount();
});

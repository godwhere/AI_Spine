import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild } from "vite";

// Execute the real component with isolated hooks and a controlled clock. This
// exercises its async handlers without a browser, network, or real credentials.
const source = (await readFile(new URL("../src/components/AIConnectionPanel.jsx", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export function AIConnectionPanel", "function AIConnectionPanel");
const { code } = await transformWithEsbuild(source, "AIConnectionPanel.jsx", { loader: "jsx", jsx: "transform", jsxFactory: "jsx", jsxFragment: "Fragment" });
const factory = new Function("useEffect", "useRef", "useState", "createLocalGenerationProvider", "jsx", "setInterval", "clearInterval",
  "Sparkles", "KeyRound", "RefreshCw", "Check", "LoaderCircle", "ExternalLink", "X", "Fragment", `${code}; return AIConnectionPanel;`);
const text = (node) => typeof node === "string" ? node : node && typeof node === "object" ? (node.children || []).map(text).join("") : "";
const descendants = (node) => node && typeof node === "object" ? [node, ...(node.children || []).flatMap(descendants)] : [];
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const sameDependencies = (a, b) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));

function panel() {
  const cells = [], timers = new Map(), pendingStatus = [], configured = [];
  let selectedProvider = "codex-native";
  const providers = [
    { id: "codex-native", label: "Codex 账号", auth: "chatgpt", models: [] },
    { id: "openai", label: "OpenAI API", auth: "api-key", models: ["test-image"], model: "test-image", keyConfigured: false },
    { id: "sub2api", label: "Sub2API", auth: "api-key", models: ["gpt-image-2"], model: "gpt-image-2", keyConfigured: false,
      configurableEndpoint: true, allowCustomModel: true, baseUrl: "", protocol: "images",
      protocols: [{ id: "images", label: "OpenAI Images" }, { id: "gemini", label: "Gemini 原生" }],
      modelsByProtocol: { images: ["gpt-image-2"], gemini: ["gemini-test-image"] } },
  ];
  let cursor = 0, scheduled = [], dirty = true, tree, nextTimer = 0, mounted = true, writesAfterUnmount = 0, codexConnected = false;
  const connectionStatus = (provider) => ({ provider, connected: provider === "codex-native" && codexConnected,
    message: provider === "codex-native" ? "Codex status" : "API Key required" });
  const client = {
    status: async (provider = "codex-native") => pendingStatus.length && provider === "codex-native" ? pendingStatus.shift().promise : connectionStatus(provider),
    connection: async () => ({ selected: selectedProvider, status: connectionStatus(selectedProvider), secureStorage: false, busy: false, providers: structuredClone(providers) }),
    configure: async (input) => {
      configured.push(input); selectedProvider = input.provider;
      const profile = providers.find((p) => p.id === input.provider);
      Object.assign(profile, { model: input.model, baseUrl: input.baseUrl, protocol: input.protocol, keyConfigured: true });
      return { ...await client.connection(), status: { provider: input.provider, connected: true, message: "verified" } };
    },
    login: async () => ({ loginId: "test-login", authUrl: "https://auth.openai.com/test" }),
  };
  const useState = (initial) => {
    const i = cursor++; if (!(i in cells)) cells[i] = initial;
    return [cells[i], (value) => {
      if (!mounted) writesAfterUnmount++;
      const next = typeof value === "function" ? value(cells[i]) : value;
      if (!Object.is(next, cells[i])) { cells[i] = next; dirty = true; }
    }];
  };
  const useRef = (value) => { const i = cursor++; return cells[i] ||= { current: value }; };
  const useEffect = (effect, dependencies) => {
    const i = cursor++, previous = cells[i];
    if (!sameDependencies(previous?.dependencies, dependencies)) scheduled.push(() => {
      previous?.cleanup?.(); cells[i] = { dependencies, cleanup: effect() };
    });
  };
  const jsx = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const component = factory(useEffect, useRef, useState, () => client, jsx,
    (callback) => { timers.set(++nextTimer, callback); return nextTimer; }, (id) => timers.delete(id), ...Array(8).fill("icon"));
  const find = (predicate) => descendants(tree).find(predicate);
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      if (dirty) {
        dirty = false; cursor = 0; scheduled = [];
        tree = component({ onClose() {}, onChanged() {} });
        for (const effect of scheduled) effect();
      }
      await new Promise(setImmediate);
      if (!dirty) return;
    }
    throw new Error("component did not settle");
  };
  return {
    settle,
    async startLogin() { find((node) => node.type === "button" && text(node) === "开始 Codex 登录").props.onClick(); await settle(); },
    async select(label) { find((node) => node.props.role === "tab" && text(node).startsWith(label)).props.onClick(); await settle(); },
    deferLoginCheck() { const value = deferred(); pendingStatus.push(value); return value; },
    tick: () => Promise.all([...timers.values()].map((callback) => callback())),
    connectCodex() { codexConnected = true; return connectionStatus("codex-native"); },
    statusText: () => text(find((node) => node.props.className?.startsWith("generation-connection"))),
    selected: () => text(find((node) => node.props.role === "tab" && node.props["aria-selected"])),
    allText: () => text(tree),
    configured,
    field: (label) => find((node) => node.props["aria-label"] === label),
    async fill(label, value) { find((node) => node.props["aria-label"] === label).props.onChange({ target: { value } }); await settle(); },
    async save() { find((node) => node.type === "button" && text(node) === "保存并验证连接").props.onClick(); await settle(); },
    unmount() { mounted = false; for (const cell of cells) cell?.cleanup?.(); },
    get writesAfterUnmount() { return writesAfterUnmount; },
    get timerCount() { return timers.size; },
  };
}

test("a late Codex login response cannot mark the OpenAI tab connected", async () => {
  const ui = panel(); await ui.settle(); await ui.startLogin();
  const check = ui.deferLoginCheck(), polling = ui.tick();
  await ui.select("OpenAI API");
  assert.match(ui.statusText(), /尚未连接/);
  check.resolve(ui.connectCodex()); await polling; await ui.settle();
  assert.match(ui.selected(), /^OpenAI API/);
  assert.match(ui.statusText(), /尚未连接.*API Key required/);
  assert.doesNotMatch(ui.allText(), /Codex 登录成功/);
  ui.unmount();
});

test("returning to Codex resumes its pending login check with the correct status", async () => {
  const ui = panel(); await ui.settle(); await ui.startLogin();
  const check = ui.deferLoginCheck(), polling = ui.tick();
  await ui.select("OpenAI API"); check.resolve(ui.connectCodex()); await polling; await ui.settle();
  await ui.select("Codex 账号"); await ui.tick(); await ui.settle();
  assert.match(ui.statusText(), /Codex 账号已连接.*Codex status/);
  assert.match(ui.allText(), /Codex 登录成功/);
  assert.equal(ui.timerCount, 0, "successful login stops the polling timer");
  ui.unmount();
});

test("closing the panel ignores an already pending login response", async () => {
  const ui = panel(); await ui.settle(); await ui.startLogin();
  const check = ui.deferLoginCheck(), polling = ui.tick();
  ui.unmount(); check.resolve(ui.connectCodex()); await polling;
  assert.equal(ui.writesAfterUnmount, 0);
  assert.equal(ui.timerCount, 0);
});

test("Sub2API exposes its own endpoint, native protocol, custom model and explicit validation", async () => {
  const ui = panel(); await ui.settle(); await ui.select("Sub2API");
  assert.ok(ui.field("Sub2API 服务地址")); assert.ok(ui.field("Sub2API 图片接口"));
  assert.equal(ui.configured.length, 0);
  await ui.fill("Sub2API 服务地址", "http://127.0.0.1:18080/v1");
  await ui.fill("Sub2API Key", "sk-ui-sub2api-fixture");
  await ui.fill("Sub2API 图片接口", "gemini");
  assert.equal(ui.field("Sub2API 生图模型").props.value, "gemini-test-image");
  await ui.fill("Sub2API 生图模型", "gemini-custom-image");
  await ui.save();
  assert.deepEqual(ui.configured, [{ provider: "sub2api", apiKey: "sk-ui-sub2api-fixture", model: "gemini-custom-image", remember: false,
    baseUrl: "http://127.0.0.1:18080/v1", protocol: "gemini" }]);
  assert.equal(ui.field("Sub2API Key").props.value, "", "a saved key leaves the password field");
  await ui.select("OpenAI API");
  assert.equal(ui.field("Sub2API 服务地址"), undefined); assert.equal(ui.field("OpenAI API Key").props.value, "");
  ui.unmount();
});

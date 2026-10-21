import { test, expect } from "./fixtures.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";
import { buildRigFiles } from "../../src/infrastructure/rig-authoring.js";
import { attachRigAuthoring, readRigAuthoring } from "../../engine/archive/rig-project.js";
import { parseBundle } from "../../src/infrastructure/archive-files.js";
import { unpackZip } from "../../engine/archive/zip.js";
import { parseSkeleton } from "../../engine/spine/parse.js";
import { pixelEnv } from "../helpers.mjs";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const navigation = (page, name) => page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name });
async function openResource(page, name = "隔离测试角色") {
  await page.getByRole("button", { name: `预览 ${name}`, exact: true }).dblclick();
  await expect(page.getByRole("textbox", { name: "资源名称", exact: true })).toHaveValue(name);
}
async function openTemplateDraft(page) {
  await navigation(page, /模板库/).click();
  await page.getByRole("listitem", { name: "选择模板 青牙重刃战士", exact: true }).click();
  await page.getByRole("button", { name: "创建角色", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "资源名称", exact: true })).toBeVisible();
}

test("rename and calibration commit before immediate navigation and survive reload", async ({ page, workbench }, testInfo) => {
  await openResource(page);
  const original = workbench.store.call("projects", "get", ["architecture-fixture"]);
  await page.getByRole("button", { name: "调整细节", exact: true }).click();
  await expect(page.getByRole("button", { name: "完成调整", exact: true })).toBeEnabled();
  await page.getByRole("spinbutton", { name: "水平位置", exact: true }).fill("3");
  await expect(page.getByRole("spinbutton", { name: "水平位置", exact: true })).toHaveValue("3");
  await page.getByRole("button", { name: "完成调整", exact: true }).click();
  await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("立即导航后的校准");
  await navigation(page, /模板库/).click();
  await expect(page.getByRole("heading", { name: "模板库", exact: true })).toBeVisible();
  const saved = workbench.store.call("projects", "get", [original.id]);
  expect(saved.name).toBe("立即导航后的校准");
  expect(Object.values(saved.edits)[0].transform.x).toBe(3);
  expect(saved.files).toEqual(original.files);
  await page.reload(); await openResource(page, saved.name);
  await page.screenshot({ path: testInfo.outputPath("calibration-reopened.png"), fullPage: true });
});

test("edits during a write coalesce; navigation waits for the final receipt", async ({ page, workbench }) => {
  await openResource(page);
  const first = deferred(), second = deferred(), firstArrived = deferred(), secondArrived = deferred(), names = [];
  await page.route(/\/api\/workspace\/(?:v2\/)?projects$/, async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation === "save") {
      names.push(body.args?.[0]?.name ?? body.payload.document.name);
      if (names.length === 1) { firstArrived.resolve(); await first.promise; }
      if (names.length === 2) { secondArrived.resolve(); await second.promise; }
    }
    await route.continue();
  });
  try {
    const field = page.getByRole("textbox", { name: "资源名称", exact: true });
    await field.fill("A"); await firstArrived.promise;
    await field.fill("B"); await field.fill("C"); first.resolve(); await secondArrived.promise;
    await expect(page.locator(".save-indicator")).toContainText("正在保存");
    expect(names).toEqual(["A", "C"]);
    await navigation(page, /我的资源/).click();
    await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");
    expect(workbench.store.call("projects", "get", ["architecture-fixture"]).name).toBe("A");
    second.resolve(); await expect(page.getByRole("heading", { name: "我的资源", exact: true })).toBeVisible();
    expect(workbench.store.call("projects", "get", ["architecture-fixture"]).name).toBe("C");
    await page.reload(); await expect(page.getByRole("button", { name: "预览 C", exact: true })).toBeVisible();
  } finally { first.resolve(); second.resolve(); }
});

test.describe("legacy response recovery", () => {
  test.use({ storageFormat: 1 });
  test("a lost HTTP save response is acknowledged by reading the committed content", async ({ page, workbench }) => {
    await openResource(page); let writes = 0;
    await page.route("**/api/workspace/projects", async (route) => {
      const body = route.request().postDataJSON();
      if (body.operation === "save" && ++writes === 1) { await route.fetch(); await route.abort("failed"); }
      else await route.continue();
    });
    await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("响应丢失的保存");
    await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
    expect(writes).toBe(1); expect(workbench.store.call("projects", "get", ["architecture-fixture"]).name).toBe("响应丢失的保存");
    await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("核对回执后继续编辑");
    await navigation(page, /我的资源/).click();
    await expect(page.getByRole("button", { name: "预览 核对回执后继续编辑", exact: true })).toBeVisible();
    expect(writes).toBe(2);
  });
});

test("two pages reject a stale version and save local work as an independent resource", async ({ page, workbench }, testInfo) => {
  const other = await page.context().newPage(); await other.goto(workbench.origin);
  try {
    await openResource(page); await openResource(other);
    await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("另一个窗口的新版本");
    await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
    await other.getByRole("textbox", { name: "资源名称", exact: true }).fill("保留冲突的本地内容");
    await expect(other.locator(".save-indicator")).toHaveText("保存失败");
    expect(workbench.store.call("projects", "get", ["architecture-fixture"]).name).toBe("另一个窗口的新版本");
    await other.getByRole("button", { name: "另存为新资源", exact: true }).click();
    await expect(other.locator(".save-indicator")).toHaveText("已保存到本机");
    const records = workbench.store.call("projects", "list").projects;
    expect(records.map((record) => record.name).sort()).toEqual(["保留冲突的本地内容", "另一个窗口的新版本"]);
    await expect(other.locator(".app-shell")).not.toHaveAttribute("inert", "");
    await expect(other.getByRole("button", { name: "导出", exact: true })).toBeEnabled();
    await other.screenshot({ path: testInfo.outputPath("conflict-saved-as-new.png"), fullPage: true });
  } finally { await other.close(); }
});

for (const permanent of [false, true]) test(`a stale editor cannot revive a ${permanent ? "permanently deleted" : "trashed"} resource`, async ({ page, workbench }) => {
  await openResource(page);
  workbench.store.call("projects", "trash", ["architecture-fixture"]);
  if (permanent) workbench.store.call("projects", "remove", [["architecture-fixture"]]);
  await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("删除之后的旧修改");
  await expect(page.locator(".save-indicator")).toHaveText("保存失败");
  await expect(page.getByRole("textbox", { name: "资源名称", exact: true })).toHaveValue("删除之后的旧修改");
  expect(workbench.store.call("projects", "list").projects).toEqual([]);
  expect(workbench.store.call("projects", "list").trash.length).toBe(permanent ? 0 : 1);
});

test("untouched templates and opening/closing AI stay temporary; explicitly saved drafts stay saved", async ({ page, workbench }) => {
  await openTemplateDraft(page);
  await page.getByRole("button", { name: "AI 创作", exact: true }).click();
  await page.getByRole("button", { name: "关闭 AI 创作", exact: true }).click();
  await navigation(page, /我的资源/).click();
  await expect(page.getByRole("heading", { name: "我的资源", exact: true })).toBeVisible();
  expect(workbench.store.call("projects", "list").projects).toHaveLength(1);
  await openTemplateDraft(page);
  const originalName = await page.getByRole("textbox", { name: "资源名称", exact: true }).inputValue();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
  await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("保存后改名");
  await page.getByRole("textbox", { name: "资源名称", exact: true }).fill(originalName);
  await page.getByRole("button", { name: "调整细节", exact: true }).click();
  await expect(page.getByRole("button", { name: "完成调整", exact: true })).toBeEnabled();
  await page.getByRole("spinbutton", { name: "水平位置", exact: true }).fill("2");
  await page.getByRole("button", { name: "完成调整", exact: true }).click();
  await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
  await page.getByRole("button", { name: "撤销修改", exact: true }).click();
  await navigation(page, /我的资源/).click();
  await expect(page.getByRole("heading", { name: "我的资源", exact: true })).toBeVisible();
  expect(workbench.store.call("projects", "list").projects).toHaveLength(2);
  const summary = workbench.store.call("projects", "list").projects.find((record) => record.name === originalName);
  expect(summary.replacementCount).toBe(0);
  expect(workbench.store.call("projects", "get", [summary.id]).edits).toEqual({});
});

test("source-only rig drafts survive navigation/reload and remain outside normal resources", async ({ page, workbench }) => {
  await page.getByRole("button", { name: "新建角色", exact: true }).click();
  const canvas = createCanvas(64, 64); canvas.getContext("2d").fillRect(12, 8, 40, 48);
  await page.locator('.rig-workbench input[type="file"]').first().setInputFiles({
    name: "source-only-fixture.png", mimeType: "image/png", buffer: canvas.toBuffer("image/png"),
  });
  await expect(page.getByRole("textbox", { name: "骨架资源名称", exact: true })).toHaveValue("source-only-fixture");
  await page.getByRole("button", { name: "返回资源", exact: true }).click();
  await expect(page.getByRole("heading", { name: "我的资源", exact: true })).toBeVisible();
  const drafts = workbench.store.call("drafts", "list");
  expect(drafts).toHaveLength(1); expect(drafts[0].partCount).toBe(0);
  expect(workbench.store.call("projects", "list").projects).toHaveLength(1);
  await workbench.restart();
  await page.reload(); await page.getByRole("button", { name: "新建角色", exact: true }).click();
  await page.getByRole("button", { name: /继续 source-only-fixture/ }).click();
  await expect(page.getByRole("textbox", { name: "骨架资源名称", exact: true })).toHaveValue("source-only-fixture");
  expect(workbench.store.call("drafts", "get", [drafts[0].id]).document.sourceImage).toMatch(/^data:image\/png;base64,/);
});

test("saving a validated synthetic rig uses the shared writer and links its draft to the committed resource version", async ({ page, workbench }) => {
  const canvas = createCanvas(32, 32); canvas.getContext("2d").fillRect(8, 8, 16, 16);
  const image = canvas.toDataURL("image/png"), id = "synthetic-rig-resource";
  const document = { version: 1, id: "synthetic-rig", ownerResourceId: id, name: "合成骨架保存夹具", width: 64, height: 64,
    sourceImage: image, joints: [{ id: "root", parent: null, x: 32, y: 32 }],
    parts: [{ id: "body", bone: "root", x: 16, y: 16, width: 32, height: 32, z: 0, binding: "rigid", influences: ["root"],
      image, imageSource: "uploaded", completion: "ready" }],
    motions: [{ id: "idle", name: "Idle", duration: 1, loop: true, origin: "manual", poses: [{ time: 0, angles: {} }, { time: 1, angles: {} }] }] };
  const files = attachRigAuthoring(await buildRigFiles(document, pixelEnv), document), bundle = parseBundle(files);
  workbench.store.call("projects", "save", [{ id, name: document.name, files, skeletonPath: bundle.skeletonPath, edits: {}, generation: {} }]);
  await page.reload(); await openResource(page, document.name);
  await page.getByRole("button", { name: "骨架与动作", exact: true }).click();
  await page.getByRole("textbox", { name: "骨架资源名称", exact: true }).fill("合成骨架保存完成");
  await page.getByRole("button", { name: "保存为角色资源", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "资源名称", exact: true })).toHaveValue("合成骨架保存完成");
  const saved = workbench.store.call("projects", "get", [id]), draft = workbench.store.call("drafts", "get", [`resource-${id}`]);
  expect(draft.resourceUpdatedAt).toBe(saved.updatedAt); expect(draft.document.ownerResourceId).toBe(id);
  expect(readRigAuthoring(saved.files).parts[0].image).toBe(image);
});

test("refresh while saving prompts before leaving and retains the editor when dismissed", async ({ page }) => {
  await openResource(page);
  const gate = deferred(), arrived = deferred();
  await page.route(/\/api\/workspace\/(?:v2\/)?projects$/, async (route) => {
    if (route.request().postDataJSON().operation === "save") { arrived.resolve(); await gate.promise; }
    await route.continue();
  });
  try {
    await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("刷新前未确认的内容");
    await arrived.promise;
    const dialog = page.waitForEvent("dialog"); const reload = page.reload({ timeout: 2000 }).catch(() => {});
    const warning = await dialog; expect(warning.type()).toBe("beforeunload"); await warning.dismiss(); await reload;
    await expect(page.getByRole("textbox", { name: "资源名称", exact: true })).toHaveValue("刷新前未确认的内容");
    gate.resolve(); await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
    await page.reload(); await expect(page.getByRole("button", { name: "预览 刷新前未确认的内容", exact: true })).toBeVisible();
  } finally { gate.resolve(); }
});

test("exporting an untouched temporary template downloads a real editable ZIP and explicitly persists it", async ({ page, workbench }, testInfo) => {
  await openTemplateDraft(page);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("radio", { name: /可编辑工程备份/ }).check();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "校验并导出 ZIP", exact: true }).click();
  const download = await downloaded, path = testInfo.outputPath("temporary-template-editable.zip");
  await download.saveAs(path);
  const restored = parseBundle(unpackZip(new Uint8Array(await readFile(path))));
  expect(parseSkeleton(restored).data.animations).toHaveLength(7);
  expect(restored.parts.length).toBeGreaterThan(0);
  await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
  expect(workbench.store.call("projects", "list").projects).toHaveLength(2);
});

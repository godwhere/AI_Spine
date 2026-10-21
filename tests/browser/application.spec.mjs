import { test, expect } from "./fixtures.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { validateRigDocument } from "../../shared/rig-schema.mjs";

const nav = (page, name) => page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name });

test("template creation can cancel, then save and update one independent template through the UI", async ({ page, workbench }) => {
  const before = workbench.store.call("projects", "get", ["architecture-fixture"]);
  const add = page.getByRole("button", { name: "加入模板", exact: true }); await expect(add).toBeEnabled(); await add.click();
  await page.getByRole("textbox", { name: "模板名称", exact: true }).fill("Cancelled template");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(workbench.store.call("templates", "list")).toEqual([]);
  await add.click(); await page.getByRole("textbox", { name: "模板名称", exact: true }).fill("独立测试模板");
  await page.getByRole("button", { name: "保存模板", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模板库", exact: true })).toBeVisible();
  const first = workbench.store.call("templates", "list"); expect(first).toHaveLength(1);
  expect(first[0].sourceProjectId).toBe(before.id); expect(first[0].regionCount).toBe(49); expect(first[0].animationCount).toBe(7);
  await nav(page, /我的资源/).click();
  const update = page.getByRole("button", { name: "更新模板", exact: true }); await expect(update).toBeEnabled(); await update.click();
  await page.getByRole("textbox", { name: "模板名称", exact: true }).fill("更新后的独立模板");
  await page.getByRole("button", { name: "保存模板", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模板库", exact: true })).toBeVisible();
  const current = workbench.store.call("templates", "list"); expect(current).toHaveLength(1);
  expect(current[0].id).toBe(first[0].id); expect(current[0].createdAt).toBe(first[0].createdAt); expect(current[0].name).toBe("更新后的独立模板");
  expect(workbench.store.call("projects", "get", [before.id])).toEqual(before);
  await page.reload();
  await nav(page, /模板库/).click(); await page.getByRole("button", { name: "我创建的", exact: true }).click();
  await expect(page.getByRole("listitem", { name: /选择模板 更新后的独立模板/ })).toBeVisible();
});

test("visible fake-provider generation applies a mapped candidate, calibrates it and preserves source files across reload", async ({ page, workbench }) => {
  const before = workbench.store.call("projects", "get", ["architecture-fixture"]);
  await page.getByRole("button", { name: "预览 隔离测试角色", exact: true }).dblclick();
  await page.getByRole("button", { name: "AI 创作", exact: true }).click();
  await page.getByRole("tab", { name: "模板部件", exact: true }).click();
  await page.getByLabel("描述部件的材质与风格", { exact: true }).fill("Synthetic fixture only");
  await page.getByRole("button", { name: "生成 1 个部件", exact: true }).click();
  const apply = page.getByRole("button", { name: "应用并校准", exact: true }); await expect(apply).toBeEnabled({ timeout: 20_000 });
  const jobs = await workbench.jobs.list(before.id), completed = await workbench.jobs.get(jobs[0].id);
  expect(completed.status).toBe("completed"); expect(completed.images).toHaveLength(1);
  expect(workbench.store.call("projects", "get", [before.id]).edits).toEqual(before.edits);
  const native = await workbench.jobs.image(completed.id, completed.images[0].id);
  await page.getByRole("button", { name: "关闭 AI 创作", exact: true }).click();
  expect(workbench.store.call("projects", "get", [before.id]).edits).toEqual(before.edits);
  const history = "**/api/generation/jobs?*";
  await page.route(history, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [{ ...completed, projectId: "foreign-resource" }] }) }));
  await page.getByRole("button", { name: "AI 创作", exact: true }).click(); await page.getByRole("tab", { name: "模板部件", exact: true }).click();
  await expect(apply).toBeDisabled(); expect(workbench.store.call("projects", "get", [before.id]).edits).toEqual(before.edits);
  await page.getByRole("button", { name: "关闭 AI 创作", exact: true }).click(); await page.unroute(history);
  await page.getByRole("button", { name: "AI 创作", exact: true }).click(); await page.getByRole("tab", { name: "模板部件", exact: true }).click();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByRole("spinbutton", { name: "水平位置", exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "水平位置", exact: true }).fill("3");
  await page.getByRole("button", { name: "完成调整", exact: true }).click();
  const partId = completed.images[0].partId;
  await expect.poll(() => workbench.store.call("projects", "get", [before.id]).edits[partId]?.transform.x).toBe(3);
  await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
  expect(workbench.store.call("projects", "get", [before.id]).files).toEqual(before.files);
  expect(await workbench.jobs.image(completed.id, completed.images[0].id)).toEqual(native);
  await page.reload(); await page.getByRole("button", { name: "预览 隔离测试角色", exact: true }).dblclick();
  await page.getByRole("button", { name: "调整细节", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "水平位置", exact: true })).toHaveValue("3");
});

test("rig candidate application rejects stale geometry in the browser while retaining current joints and original artwork", async ({ page, workbench }) => {
  const canvas = createCanvas(64, 64); canvas.getContext("2d").fillRect(8, 8, 48, 48);
  const image = canvas.toDataURL("image/png"), id = "stale-geometry-fixture";
  const document = { version: 1, id, name: "Stale candidate fixture", width: 64, height: 64, sourceImage: image,
    joints: [{ id: "root", parent: null, x: 32, y: 32 }],
    parts: [{ id: "body", bone: "root", x: 16, y: 16, width: 24, height: 24, z: 0, binding: "rigid", influences: ["root"], image, imageSource: "uploaded", completion: "ready" }],
    motions: [{ id: "idle", name: "Idle", duration: 1, loop: true, origin: "manual", poses: [{ time: 0, angles: {} }, { time: 1, angles: {} }] }] };
  const baseline = validateRigDocument(document); workbench.store.call("drafts", "save", [baseline]);
  const job = await workbench.jobs.rigJobs.create({ version: 1, kind: "parts", projectId: id, prompt: "Synthetic candidate only", rig: baseline, partIds: ["body"], concurrency: 1 });
  await expect.poll(async () => (await workbench.jobs.rigJobs.get(job.id)).status).toBe("completed");
  await page.getByRole("button", { name: "新建角色", exact: true }).click(); await page.getByRole("button", { name: /继续 Stale candidate fixture/ }).click();
  await page.getByRole("button", { name: /1\s*结构与关节/ }).click(); await page.getByRole("spinbutton", { name: "关节 X", exact: true }).fill("34");
  await page.getByRole("button", { name: /2\s*拆分与补绘/ }).click(); await page.getByRole("button", { name: "应用 1 个补绘候选", exact: true }).click();
  await expect(page.getByText(/骨架、部件矩形或绑定已改变/)).toBeVisible();
  await expect.poll(() => workbench.store.call("drafts", "get", [id]).document.joints[0].x).toBe(34);
  const saved = workbench.store.call("drafts", "get", [id]).document;
  expect(saved.parts[0].image).toBe(image); expect(saved.motions).toEqual(baseline.motions); expect(saved.sourceImage).toBe(image);
});

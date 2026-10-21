import { test, expect } from "./fixtures.mjs";
import { encodeWorkspace } from "../../shared/workspace-codec.mjs";

const nav = (page, name) => page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name });
test("confirmed trash restoration and permanent deletion preserve custom templates and generation history across restart and a fresh browser", async ({ page, browser, workbench }) => {
  const id = "architecture-fixture";
  await page.getByRole("button", { name: "预览 隔离测试角色", exact: true }).dblclick();
  await page.getByRole("button", { name: "AI 创作", exact: true }).click(); await page.getByRole("tab", { name: "模板部件", exact: true }).click();
  await page.getByLabel("描述部件的材质与风格", { exact: true }).fill("Independent history fixture");
  await page.getByRole("button", { name: "生成 1 个部件", exact: true }).click();
  await expect(page.getByRole("button", { name: "应用并校准", exact: true })).toBeEnabled();
  const job = (await workbench.jobs.list(id))[0], native = await workbench.jobs.image(job.id, job.images[0].id);
  await page.getByRole("button", { name: "关闭 AI 创作", exact: true }).click(); await nav(page, /我的资源/).click();
  const original = workbench.store.call("projects", "get", [id]); expect(original.edits).toEqual({});
  await page.getByRole("button", { name: "加入模板", exact: true }).click();
  await page.getByRole("textbox", { name: "模板名称", exact: true }).fill("Independent lifetime template");
  await page.getByRole("button", { name: "保存模板", exact: true }).click(); await expect(page.getByRole("heading", { name: "模板库", exact: true })).toBeVisible();
  const metadata = workbench.store.call("templates", "list")[0], snapshot = workbench.store.call("templates", "get", [metadata.id]);
  async function trash() {
    await nav(page, /我的资源/).click(); await page.getByRole("button", { name: "删除资源", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect.poll(() => workbench.store.call("projects", "summary").trash.length).toBe(1);
    await nav(page, /回收站/).click();
  }
  await trash(); expect(workbench.store.call("projects", "read", [id]).files).toEqual(original.files);
  await page.getByRole("button", { name: "恢复资源", exact: true }).click();
  await expect.poll(() => workbench.store.call("projects", "summary").projects.length).toBe(1);
  expect(workbench.store.call("projects", "get", [id]).files).toEqual(original.files);
  await trash(); await page.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(page.getByRole("heading", { name: "永久删除资源", exact: true })).toBeVisible();
  expect(workbench.store.call("projects", "read", [id])).not.toBeNull();
  await page.getByRole("button", { name: "取消", exact: true }).click(); expect(workbench.store.call("projects", "summary").trash).toHaveLength(1);
  await page.getByRole("button", { name: "永久删除", exact: true }).click(); await page.getByRole("button", { name: "确认永久删除", exact: true }).click();
  await expect.poll(() => workbench.store.call("projects", "summary").trash.length).toBe(0);
  expect(workbench.store.call("projects", "read", [id])).toBeNull(); expect(workbench.store.call("templates", "get", [metadata.id])).toEqual(snapshot);
  const old = await page.request.post(`${workbench.origin}/api/workspace/migrate`, { headers: { Origin: workbench.origin },
    data: encodeWorkspace({ source: "ui-deleted-old-browser", snapshot: { "ai-spine-local-workbench": { projects: [original] } } }) });
  expect((await old.json()).value.skippedDeleted).toBe(1);
  await workbench.restart();
  const context = await browser.newContext();
  try {
    await context.route("**/*", (route) => { const url = new URL(route.request().url()); return url.origin === workbench.origin || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort(); });
    const reader = await context.newPage(); await reader.goto(workbench.origin);
    await expect(reader.getByRole("heading", { name: "我的资源", exact: true })).toBeVisible(); await expect(reader.getByRole("button", { name: /^预览 / })).toHaveCount(0);
    await nav(reader, /模板库/).click(); await reader.getByRole("button", { name: "我创建的", exact: true }).click();
    await reader.getByRole("listitem", { name: /^选择模板 Independent lifetime template/ }).click();
    await expect(reader.getByRole("button", { name: "创建角色", exact: true })).toBeEnabled();
    const history = await reader.request.get(`${workbench.origin}/api/generation/jobs?projectId=${id}`);
    expect((await history.json()).jobs.map((value) => value.id)).toContain(job.id);
    expect(await workbench.jobs.image(job.id, job.images[0].id)).toEqual(native);
    expect(workbench.store.call("projects", "summary").projects).toEqual([]); expect(workbench.store.call("templates", "get", [metadata.id])).toEqual(snapshot);
  } finally { await context.close(); }
});

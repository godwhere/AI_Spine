import { test, expect } from "./fixtures.mjs";

test("an intentionally emptied browser library remains empty across reload without seeding examples", async ({ page, workbench }) => {
  const examples = []; page.on("request", (request) => { if (request.url().includes("/examples/")) examples.push(request.url()); });
  workbench.store.call("projects", "trash", ["architecture-fixture"]);
  workbench.store.call("projects", "remove", [["architecture-fixture"]]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "我的资源", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^预览 / })).toHaveCount(0);
  expect(workbench.store.call("projects", "list").projects).toEqual([]);
  expect(examples).toEqual([]);
  await expect(page.locator(".desktop-titlebar")).toHaveCount(0);
});

test("a shared service failure keeps local edits visible and never creates an isolated browser project database", async ({ page, workbench }) => {
  await page.getByRole("button", { name: "预览 隔离测试角色", exact: true }).dblclick();
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name).sort());
  await page.route(/\/api\/workspace\/(?:v2\/)?projects$/, async (route) => {
    if (route.request().postDataJSON().operation === "save") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "隔离测试：共享后台不可用" }) });
    return route.continue();
  });
  await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("仅保留在本页的编辑");
  await expect(page.locator(".save-indicator")).toHaveText("保存失败");
  await expect(page.getByRole("textbox", { name: "资源名称", exact: true })).toHaveValue("仅保留在本页的编辑");
  expect(workbench.store.call("projects", "get", ["architecture-fixture"]).name).toBe("隔离测试角色");
  expect(await page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name).sort())).toEqual(databases);
});

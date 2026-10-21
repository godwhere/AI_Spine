import { test, expect } from "./fixtures.mjs";

test("the real React workbench opens against its isolated shared library", async ({ page, workbench }, testInfo) => {
  await expect(page.getByRole("heading", { name: "我的资源", exact: true })).toBeVisible();
  await expect(page.getByText("隔离测试角色", { exact: true }).first()).toBeVisible();
  expect(new URL(page.url()).port).not.toBe("4175");
  expect(workbench.store.call("projects", "list").projects.map((p) => p.id)).toEqual(["architecture-fixture"]);
  await page.screenshot({ path: testInfo.outputPath("resource-library.png"), fullPage: true });
});

test("template preview and view switches leave the resource library unchanged", async ({ page, workbench }, testInfo) => {
  const before = workbench.store.call("projects", "list");
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: /模板库/ }).click();
  await expect(page.getByRole("heading", { name: "模板库", exact: true })).toBeVisible();
  await page.getByRole("listitem", { name: "选择模板 青牙重刃战士", exact: true }).click();
  const motions = page.getByRole("combobox", { name: "选择预览动作", exact: true });
  await expect(motions).toBeEnabled();
  await expect(motions.getByRole("option")).toHaveCount(7);
  const names = await motions.getByRole("option").allTextContents();
  await motions.selectOption(names[1]); await expect(motions).toHaveValue(names[1]);
  await motions.selectOption(names[2]); await expect(motions).toHaveValue(names[2]);
  await page.getByRole("button", { name: "三列图片视图", exact: true }).click();
  await expect(page.getByRole("button", { name: "三列图片视图", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "列表视图", exact: true }).click();
  await page.getByRole("button", { name: "暂停预览", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("template-preview.png"), fullPage: true });
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: /我的资源/ }).click();
  await expect(page.getByRole("heading", { name: "我的资源", exact: true })).toBeVisible();
  expect(workbench.store.call("projects", "list")).toEqual(before);
});

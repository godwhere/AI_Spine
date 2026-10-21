import { test, expect } from "./fixtures.mjs";

const nav = (page, name) => page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("a late successful save receipt cannot put a remotely trashed resource back into the visible library", async ({ page, workbench }, testInfo) => {
  const other = await page.context().newPage(), committed = deferred(), release = deferred();
  await other.goto(workbench.origin);
  await page.getByRole("button", { name: "预览 隔离测试角色", exact: true }).dblclick();
  await page.route(/\/api\/workspace\/(?:v2\/)?projects$/, async (route) => {
    if (route.request().postDataJSON()?.operation !== "save") return route.continue();
    const response = await route.fetch(); committed.resolve(); await release.promise; await route.fulfill({ response });
  });
  try {
    await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("Saved before remote trash");
    await committed.promise;
    await other.getByRole("button", { name: "删除资源", exact: true }).click();
    await other.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(nav(page, /我的资源/)).toHaveText("我的资源0");
    await expect(nav(page, /回收站/)).toHaveText("回收站1");
    await page.evaluate(() => {
      window.libraryMembershipErrors = [];
      const navigation = document.querySelector('nav[aria-label="工作台导航"]');
      new MutationObserver(() => {
        const counts = [...navigation.querySelectorAll("button small")].map((element) => element.textContent);
        if (counts[0] !== "0" || counts[2] !== "1") window.libraryMembershipErrors.push(counts);
      }).observe(navigation, { subtree: true, childList: true, characterData: true });
    });
    release.resolve();
    await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
    await nav(page, /我的资源/).click();
    await expect(page.getByRole("button", { name: /^预览 / })).toHaveCount(0);
    await nav(page, /回收站/).click();
    await expect(page.getByRole("button", { name: "恢复资源", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.libraryMembershipErrors)).toEqual([]);
    const library = workbench.store.call("projects", "summary");
    expect(library.projects).toEqual([]); expect(library.trash).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("late-receipt-trash.png"), fullPage: true });
  } finally { release.resolve(); await other.close(); }
});

test("a failed initial built-in catalog recovers on a workspace refresh without reloading the page", async ({ page, workbench }, testInfo) => {
  let catalogRequests = 0, navigations = 0, failing = true;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await page.route("**/templates/catalog.json", async (route) => {
    catalogRequests++;
    if (failing) return route.fulfill({ status: 503, contentType: "application/json", body: '{}' });
    await route.continue();
  });
  await page.reload();
  await expect(nav(page, /模板库/)).toHaveText("模板库0");
  await expect(page.getByText("模板目录加载失败。", { exact: true })).toBeVisible();
  // Wait for the first status poll to establish its revision before the remote edit.
  await page.waitForResponse((response) => response.url().endsWith("/api/workspace/status") && response.ok());
  const failedRequests = catalogRequests; failing = false;
  const before = workbench.store.call("projects", "get", ["architecture-fixture"]);
  workbench.store.call("projects", "save", [{ ...before, name: "Refresh from another page" }]);
  await expect(nav(page, /模板库/)).toHaveText("模板库38");
  await nav(page, /模板库/).click();
  await expect(page.getByRole("listitem", { name: "选择模板 青牙重刃战士", exact: true })).toBeVisible();
  expect(catalogRequests).toBeGreaterThan(failedRequests); expect(navigations).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("catalog-recovered.png"), fullPage: true });
});

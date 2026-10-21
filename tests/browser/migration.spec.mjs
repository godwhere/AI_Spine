import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { WorkspaceMigration } from "../../server/workspace/migration.mjs";
import { test, expect } from "./fixtures.mjs";

const id = "architecture-fixture";
async function open(page) {
  await page.getByRole("button", { name: "预览 隔离测试角色", exact: true }).dblclick();
  await expect(page.getByRole("textbox", { name: "资源名称", exact: true })).toHaveValue("隔离测试角色");
}
async function observe(page, predicate) {
  const response = page.waitForResponse(async (response) => response.url().endsWith("/workspace/status") && response.ok() && predicate(await response.json()));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await response;
}
function migration(workbench, target) {
  const db = new DatabaseSync(join(workbench.root, "workspace", "workspace.sqlite"));
  const converter = new WorkspaceMigration(db);
  converter.begin(target, join(workbench.root, `before-format-${target}.sqlite`));
  return { db, converter };
}

test.describe("forward conversion", () => {
  test.use({ storageFormat: 1 });
  test("an open editor retains rejected maintenance edits and saves them after V2 activation and service restart", async ({ page, workbench }) => {
    await open(page);
    const original = workbench.store.call("projects", "get", [id]), identity = workbench.store.status().id;
    const { db, converter } = migration(workbench, 2);
    try {
      await converter.stage({ batchSize: 1, maxBatches: 1 });
      await workbench.restart();
      await observe(page, (status) => status.writable === false);
      await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("维护期间保留的编辑");
      await expect(page.locator(".save-indicator")).toHaveText("保存失败");
      expect(workbench.store.call("projects", "get", [id])).toEqual(original);
      await converter.stage({ batchSize: 1 }); converter.verify(); await converter.activate();
      await workbench.restart();
      await observe(page, (status) => status.version === 2 && status.writable === true);
      await expect(page.getByRole("textbox", { name: "资源名称", exact: true })).toHaveValue("维护期间保留的编辑");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
      const saved = workbench.store.call("projects", "get", [id]);
      expect(saved.name).toBe("维护期间保留的编辑"); expect(saved.files).toEqual(original.files);
      expect(workbench.store.status().id).toBe(identity);
      expect(workbench.store.v2.row("ai-spine-local-workbench", "projects", id).resource_version).toBe(2);
      await page.reload();
      await expect(page.getByRole("button", { name: "预览 维护期间保留的编辑", exact: true })).toBeVisible();
      expect(workbench.store.v2.check().consistent).toBe(true);
    } finally { db.close(); }
  });

  test("a fresh browser profile can read during maintenance and completes deferred legacy migration after abort", async ({ browser, workbench }) => {
    const { db, converter } = migration(workbench, 2), context = await browser.newContext();
    try {
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return url.origin === workbench.origin || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort();
      });
      const fresh = await context.newPage(); await fresh.goto(workbench.origin); await open(fresh);
      const marker = `ispine-shared-migration-${workbench.store.status().id}`;
      expect(await fresh.evaluate((key) => localStorage.getItem(key), marker)).toBeNull();
      await fresh.getByRole("textbox", { name: "资源名称", exact: true }).fill("新浏览器维护编辑");
      await expect(fresh.locator(".save-indicator")).toHaveText("保存失败");
      expect(workbench.store.call("projects", "get", [id]).name).toBe("隔离测试角色");
      converter.abort();
      await observe(fresh, (status) => status.writable === true);
      await expect.poll(() => fresh.evaluate((key) => localStorage.getItem(key), marker)).toBe("completed");
      await fresh.getByRole("button", { name: "保存", exact: true }).click();
      await expect(fresh.locator(".save-indicator")).toHaveText("已保存到本机");
      expect(workbench.store.call("projects", "get", [id]).name).toBe("新浏览器维护编辑");
      expect(workbench.store.status().version).toBe(1);
    } finally { await context.close(); db.close(); }
  });
});

test.describe("reverse conversion", () => {
  test.use({ storageFormat: 2 });
  test("a cached V2 editor keeps post-activation content and resumes conditional V1 saves after reverse conversion", async ({ page, workbench }) => {
    await open(page);
    await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("反向转换前的新内容");
    await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
    const saved = workbench.store.call("projects", "get", [id]), { db, converter } = migration(workbench, 1);
    try {
      await observe(page, (status) => status.writable === false);
      await converter.stage(); converter.verify(); await converter.activate(); await workbench.restart();
      await observe(page, (status) => status.version === 1 && status.writable === true);
      expect(workbench.store.call("projects", "get", [id])).toEqual(saved);
      await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("回退后继续编辑");
      await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
      expect(workbench.store.call("projects", "get", [id]).name).toBe("回退后继续编辑");
      const oldProtocol = await page.request.post(`${workbench.origin}/api/workspace/v2/projects`, { headers: { Origin: workbench.origin }, data: { operation: "summary" } });
      expect((await oldProtocol.json()).code).toBe("WORKSPACE_REFRESH_REQUIRED");
    } finally { db.close(); }
  });
});

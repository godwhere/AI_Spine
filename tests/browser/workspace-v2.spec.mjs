import { createCanvas } from "@napi-rs/canvas";
import { test, expect } from "./fixtures.mjs";

test.use({ storageFormat: 2 });
const nav = (page, name) => page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name });
async function open(page, name = "隔离测试角色") {
  await page.getByRole("button", { name: `预览 ${name}`, exact: true }).dblclick();
  await expect(page.getByRole("textbox", { name: "资源名称", exact: true })).toHaveValue(name);
}

test("V2 browser calibration and rename send small documents without reuploading unchanged source or replacement PNGs", async ({ page, workbench }, testInfo) => {
  await open(page);
  const before = workbench.store.call("projects", "get", ["architecture-fixture"]);
  await page.getByRole("button", { name: "调整细节", exact: true }).click();
  await expect(page.getByRole("button", { name: "完成调整", exact: true })).toBeEnabled();
  await page.getByRole("spinbutton", { name: "水平位置", exact: true }).fill("3");
  await page.getByRole("button", { name: "完成调整", exact: true }).click();
  await expect.poll(() => Object.values(workbench.store.call("projects", "get", [before.id]).edits)[0]?.transform.x).toBe(3);
  await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
  const first = workbench.store.call("projects", "get", [before.id]), requests = [];
  page.on("request", (request) => { if (request.url().includes("/api/workspace/v2/")) requests.push(request); });
  await page.getByRole("button", { name: "调整细节", exact: true }).click();
  await expect(page.getByRole("button", { name: "完成调整", exact: true })).toBeEnabled();
  await page.getByRole("spinbutton", { name: "水平位置", exact: true }).fill("8");
  await page.getByRole("button", { name: "完成调整", exact: true }).click();
  await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("协议二校准保存");
  await nav(page, /我的资源/).click();
  await expect(page.getByRole("button", { name: "预览 协议二校准保存", exact: true })).toBeVisible();
  const saved = workbench.store.call("projects", "get", [before.id]);
  expect(saved.files).toEqual(before.files);
  expect(Object.values(saved.edits)[0].image).toEqual(Object.values(first.edits)[0].image);
  expect(Object.values(saved.edits)[0].transform.x).toBe(8);
  const commands = requests.filter((request) => request.method() === "POST" && request.url().endsWith("/v2/projects") && request.postDataJSON()?.operation === "save");
  expect(commands.length).toBeGreaterThan(0);
  const thumbnails = new Set(commands.flatMap((request) => request.postDataJSON().payload.refs.filter((ref) => ref.path[0] === "thumbnail").map((ref) => ref.hash)));
  expect(requests.filter((request) => request.method() === "PUT").every((request) => thumbnails.has(new URL(request.url()).pathname.split("/").at(-1)))).toBe(true);
  expect(commands.every((request) => Buffer.byteLength(request.postData()) < 64 * 1024)).toBe(true);
  await page.reload(); await open(page, saved.name);
  await page.getByRole("button", { name: "调整细节", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "水平位置", exact: true })).toHaveValue("8");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(workbench.store.v2.check().consistent).toBe(true); expect(workbench.store.checkProjectIndex().consistent).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("v2-editor.png"), fullPage: true });
});

test("V2 browser recovers an unknown save by the original receipt before committing newer typed content", async ({ page, workbench }) => {
  await open(page); const saves = [];
  await page.route("**/api/workspace/v2/projects", async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation === "save") {
      saves.push(body);
      if (saves.length <= 2) { await route.fetch(); await route.abort("failed"); return; }
    }
    await route.continue();
  });
  await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("回执未确认 A");
  await expect(page.locator(".save-indicator")).toHaveText("保存失败");
  expect(workbench.store.call("projects", "get", ["architecture-fixture"]).name).toBe("回执未确认 A");
  expect(workbench.store.v2.row("ai-spine-local-workbench", "projects", "architecture-fixture").resource_version).toBe(2);
  await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("回执恢复后 C");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
  expect(saves.map((body) => body.payload.document.name)).toEqual(["回执未确认 A", "回执未确认 A", "回执未确认 A", "回执恢复后 C"]);
  expect(new Set(saves.slice(0, 3).map((body) => body.mutationId)).size).toBe(1);
  expect(saves[3].mutationId).not.toBe(saves[0].mutationId); expect(saves[3].expectedVersion).toBe(2);
  expect(workbench.store.v2.row("ai-spine-local-workbench", "projects", "architecture-fixture").resource_version).toBe(3);
});

test("V2 concurrent browser edits preserve the stale local draft and can save it as an independent resource", async ({ page, workbench }) => {
  await open(page); const other = await page.context().newPage();
  try {
    await other.goto(workbench.origin); await open(other);
    await page.getByRole("textbox", { name: "资源名称", exact: true }).fill("另一个页面的新版本");
    await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
    await other.getByRole("textbox", { name: "资源名称", exact: true }).fill("冲突后保留的本地内容");
    await expect(other.locator(".save-indicator")).toHaveText("保存失败");
    await expect(other.getByRole("textbox", { name: "资源名称", exact: true })).toHaveValue("冲突后保留的本地内容");
    await other.getByRole("button", { name: "另存为新资源", exact: true }).click();
    await expect(other.locator(".save-indicator")).toHaveText("已保存到本机");
    const list = workbench.store.call("projects", "list").projects; expect(list).toHaveLength(2);
    expect(new Set(list.map((record) => record.name))).toEqual(new Set(["另一个页面的新版本", "冲突后保留的本地内容"]));
  } finally { await other.close(); }
});

test("V2 draft keyframe edits keep source and independent part art out of uploads and survive restart", async ({ page, workbench }) => {
  const canvas = createCanvas(64, 64); canvas.getContext("2d").fillRect(8, 8, 48, 48);
  const image = canvas.toDataURL("image/png"), id = "motion-v2";
  const document = { version: 1, id, name: "V2 motion draft", width: 64, height: 64, sourceImage: image,
    joints: [{ id: "root", parent: null, x: 32, y: 32 }],
    parts: [{ id: "body", bone: "root", x: 8, y: 8, width: 48, height: 48, z: 0, binding: "rigid", influences: ["root"], image, imageSource: "uploaded", completion: "ready" }],
    motions: [{ id: "idle", name: "Idle", duration: 1, loop: true, origin: "manual", poses: [{ time: 0, angles: {} }, { time: .5, angles: {} }, { time: 1, angles: {} }] }] };
  workbench.store.call("drafts", "save", [document]);
  const baseline = workbench.store.call("drafts", "get", [id]).document;
  const requests = []; page.on("request", (request) => { if (request.url().includes("/api/workspace/v2/")) requests.push(request); });
  await page.getByRole("button", { name: "新建角色", exact: true }).click();
  await page.getByRole("button", { name: /继续 V2 motion draft/ }).click();
  await page.getByRole("button", { name: /4\s*动作与关键帧/ }).click();
  await page.getByRole("button", { name: "0.50s", exact: true }).click();
  await page.getByRole("spinbutton", { name: "关键帧时间（秒）", exact: true }).fill("0.4");
  await page.getByRole("spinbutton", { name: "骨骼角度（度）", exact: true }).fill("12");
  await nav(page, /我的资源/).click();
  await expect(page.getByRole("heading", { name: "我的资源", exact: true })).toBeVisible();
  const saved = workbench.store.call("drafts", "get", [id]);
  expect(saved.document.motions[0].poses[1]).toMatchObject({ time: .4, angles: { root: 12 } });
  expect(saved.document.sourceImage).toBe(image); expect(saved.document.parts).toEqual(baseline.parts); expect(saved.document.joints).toEqual(baseline.joints);
  expect(requests.filter((request) => request.method() === "PUT")).toHaveLength(0);
  expect(requests.filter((request) => request.method() === "POST" && request.postDataJSON()?.operation === "save").every((request) => Buffer.byteLength(request.postData()) < 64 * 1024)).toBe(true);
  await workbench.restart(); await page.reload(); await page.getByRole("button", { name: "新建角色", exact: true }).click();
  await page.getByRole("button", { name: /继续 V2 motion draft/ }).click();
  expect(workbench.store.call("drafts", "get", [id]).document).toEqual(saved.document);
  expect(workbench.store.call("projects", "list").projects).toHaveLength(1);
});

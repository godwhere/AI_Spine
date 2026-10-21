import { createCanvas } from "@napi-rs/canvas";
import { test, expect } from "./fixtures.mjs";

const nav = (page, name) => page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name });

test("rig panels share one session through real part and joint drags, undo, modal blocking and reload", async ({ page, workbench }, testInfo) => {
  const canvas = createCanvas(64, 64); canvas.getContext("2d").fillRect(8, 8, 48, 48);
  const image = canvas.toDataURL("image/png"), id = "panel-gesture-fixture";
  const document = { version: 1, id, name: "Gesture fixture", width: 64, height: 64, sourceImage: image,
    joints: [{ id: "root", parent: null, x: 32, y: 32 }, { id: "hand", parent: "root", x: 48, y: 32 }],
    parts: [{ id: "body", bone: "root", x: 16, y: 16, width: 24, height: 24, z: 0, binding: "rigid", influences: ["root"], image, imageSource: "uploaded", completion: "ready" }],
    motions: [{ id: "idle", name: "Idle", duration: 1, loop: true, origin: "manual", poses: [{ time: 0, angles: {} }, { time: 1, angles: {} }] }] };
  workbench.store.call("drafts", "save", [document]);
  const current = () => workbench.store.call("drafts", "get", [id]).document;
  const original = current();
  await page.getByRole("button", { name: "新建角色", exact: true }).click();
  await page.getByRole("button", { name: /继续 Gesture fixture/ }).click();
  await page.getByRole("button", { name: "手动调整", exact: true }).click();
  const handle = page.getByRole("button", { name: "移动部件 body", exact: true });
  const box = await handle.boundingBox();
  const scale = await page.getByRole("group", { name: "手动调整部件位置", exact: true }).evaluate((svg) => svg.getScreenCTM().a);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + scale * 3, box.y + box.height / 2 + scale * 2, { steps: 5 }); await page.mouse.up();
  await expect(page.getByRole("spinbutton", { name: "部件位置 X", exact: true })).toHaveValue("19");
  await expect.poll(() => current().parts[0].y).toBe(18);
  expect(current().joints).toEqual(original.joints); expect(current().motions).toEqual(original.motions); expect(current().parts[0].image).toBe(image);
  await page.getByRole("button", { name: "撤销骨架修改", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "部件位置 X", exact: true })).toHaveValue("16");
  await page.getByRole("button", { name: "重做骨架修改", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "部件位置 X", exact: true })).toHaveValue("19");
  await page.getByRole("button", { name: /1\s*结构与关节/ }).click();
  const joint = page.getByRole("button", { name: "关节 root", exact: true }), jointBox = await joint.boundingBox();
  await page.mouse.move(jointBox.x + jointBox.width / 2, jointBox.y + jointBox.height / 2); await page.mouse.down();
  await page.mouse.move(jointBox.x + jointBox.width / 2 + scale * 2, jointBox.y + jointBox.height / 2, { steps: 4 }); await page.mouse.up();
  await expect(page.getByRole("spinbutton", { name: "关节 X", exact: true })).toHaveValue("34");
  await page.getByRole("button", { name: /2\s*拆分与补绘/ }).click();
  await expect(page.getByRole("spinbutton", { name: "矩形 X", exact: true })).toHaveValue("19");
  await page.getByRole("button", { name: "校准部件图片", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await nav(page, /我的资源/).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "骨架资源名称", exact: true })).toHaveValue(document.name);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: /3\s*绑定与权重/ }).click();
  await expect(page.getByRole("combobox", { name: "骨架部件绑定类型", exact: true })).toHaveValue("rigid");
  await page.getByRole("button", { name: /4\s*动作与关键帧/ }).click();
  await expect(page.getByRole("textbox", { name: "AI 动作调整描述", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /5\s*验证与保存/ }).click();
  await expect(page.locator(".rig-inspector").getByRole("button", { name: "保存为角色资源", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("shared-rig-panels.png"), fullPage: true });
  await nav(page, /我的资源/).click();
  await expect(page.getByRole("heading", { name: "我的资源", exact: true })).toBeVisible();
  expect(current().joints[0].x).toBe(34); expect(current().parts[0].x).toBe(19); expect(current().parts[0].image).toBe(image);
  expect(current().motions).toEqual(original.motions); expect(workbench.store.call("projects", "list").projects).toHaveLength(1);
  await page.reload(); await page.getByRole("button", { name: "新建角色", exact: true }).click();
  await page.getByRole("button", { name: /继续 Gesture fixture/ }).click();
  await expect(page.getByRole("spinbutton", { name: "关节 X", exact: true })).toHaveValue("34");
});

test("manual viewer zoom and pan survive animation changes without changing the authored resource", async ({ page, workbench }) => {
  const before = workbench.store.call("projects", "get", ["architecture-fixture"]);
  await page.getByRole("button", { name: "预览 隔离测试角色", exact: true }).dblclick();
  await page.getByRole("button", { name: "暂停动画", exact: true }).click();
  const viewer = page.locator('.spine-viewer[aria-label="当前资源动画"]');
  await expect(viewer.locator(".viewer-message")).toHaveCount(0);
  const source = viewer.locator(".spine-canvas");
  const beforeScale = Number(await source.getAttribute("data-view-scale"));
  await page.getByRole("button", { name: "当前资源动画 放大", exact: true }).click();
  await expect.poll(async () => Number(await source.getAttribute("data-view-scale"))).toBeCloseTo(beforeScale * 1.2, 5);
  await expect(viewer.locator(".viewer-tools span")).toHaveText("120%");
  const overlay = viewer.locator(".selection-canvas"), box = await overlay.boundingBox();
  const camera = () => source.evaluate((canvas) => ({ scale: canvas.dataset.viewScale, center: canvas.dataset.viewCenter }));
  const initial = await camera();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 20, { steps: 5 }); await page.mouse.up();
  const initialCenter = initial.center.split(",").map(Number);
  const target = [initialCenter[0] - 35 / Number(initial.scale), initialCenter[1] + 20 / Number(initial.scale)];
  await expect.poll(async () => { const center = (await camera()).center.split(",").map(Number);
    return Math.max(...center.map((value, i) => Math.abs(value - target[i]))); }).toBeLessThan(0.0001);
  const panned = await camera();
  const motions = page.getByRole("combobox", { name: "校准动作", exact: true }), first = await motions.inputValue();
  const names = await motions.getByRole("option").allTextContents();
  await motions.selectOption(names.find((name) => name !== first)); await expect(viewer.locator(".viewer-tools span")).toHaveText("120%");
  await motions.selectOption(first); await expect(viewer.locator(".viewer-tools span")).toHaveText("120%");
  await expect(source).toHaveAttribute("data-animation", first);
  await expect.poll(camera).toEqual(panned);
  await nav(page, /我的资源/).click();
  expect(workbench.store.call("projects", "get", [before.id])).toEqual(before);
});

test("narrow template navigation retains fixed three-column pictures and independent resource view selection", async ({ page, workbench }, testInfo) => {
  const before = workbench.store.call("projects", "list"); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "网格视图", exact: true }).click();
  await nav(page, /模板库/).click();
  await page.getByRole("button", { name: "三列图片视图", exact: true }).click();
  const rows = page.getByRole("list", { name: "模板列表", exact: true });
  expect(await rows.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(3);
  await page.getByRole("listitem", { name: "选择模板 青牙重刃战士", exact: true }).click();
  await expect(page.getByRole("region", { name: "模板动画预览", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "返回列表", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("narrow-template-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "返回列表", exact: true }).click();
  await expect(rows).toBeVisible();
  await expect(page.getByRole("button", { name: "三列图片视图", exact: true })).toHaveAttribute("aria-pressed", "true");
  await nav(page, /我的资源/).click();
  await expect(page.getByRole("button", { name: "网格视图", exact: true })).toHaveAttribute("aria-pressed", "false");
  expect(workbench.store.call("projects", "list")).toEqual(before);
});

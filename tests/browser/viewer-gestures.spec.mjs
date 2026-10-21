import { test, expect } from "./fixtures.mjs";

const contexts = [
  { name: "resource library", label: "资源库角色", motion: "资源预览动作" },
  { name: "template library", label: "模板预览", motion: "选择预览动作", open: async (page) => {
    await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: /模板库/ }).click();
    await page.getByRole("listitem", { name: "选择模板 青牙重刃战士", exact: true }).click();
  } },
  { name: "editor", label: "当前资源动画", motion: "校准动作", open: async (page) => {
    await page.getByRole("button", { name: "预览 隔离测试角色", exact: true }).dblclick();
  } },
];

for (const context of contexts) for (const endEvent of ["pointerup", "pointercancel"]) {
  test(`${context.name} keeps queued pan updates after ${endEvent}`, async ({ page, workbench }) => {
    const before = workbench.store.call("projects", "get", ["architecture-fixture"]);
    await context.open?.(page);
    const viewer = page.locator(`.spine-viewer[aria-label="${context.label}"]`);
    const source = viewer.locator(".spine-canvas"), overlay = viewer.locator(".selection-canvas");
    await expect(source).toHaveAttribute("data-view-center", /,/);
    await expect(viewer.locator(".viewer-message")).toHaveCount(0);
    const camera = () => source.evaluate((canvas) => ({ scale: Number(canvas.dataset.viewScale), center: canvas.dataset.viewCenter }));
    const originalScale = (await camera()).scale;
    await page.getByRole("button", { name: `${context.label} 放大`, exact: true }).click();
    await expect(viewer.locator(".viewer-tools span")).toHaveText("120%");
    await expect.poll(async () => (await camera()).scale).toBeCloseTo(originalScale * 1.2, 5);
    const initial = await camera(), box = await overlay.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Queue multiple moves and end the gesture before React renders the batch.
    // Separate mouse.move calls allow rendering between events and miss this race.
    await overlay.evaluate((canvas, type) => {
      const box = canvas.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
      for (const [dx, dy] of [[10, 8], [37, -24]]) canvas.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 1, clientX: x + dx, clientY: y + dy, buttons: 1,
      }));
      canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x + 37, clientY: y - 24 }));
    }, endEvent);
    await page.mouse.up();
    await expect(viewer).toBeVisible();
    await expect(viewer.locator(".viewer-message")).toHaveCount(0);
    const center = initial.center.split(",").map(Number);
    const target = [center[0] - 37 / initial.scale, center[1] - 24 / initial.scale];
    await expect.poll(async () => {
      const actual = (await camera()).center.split(",").map(Number);
      return Math.max(...actual.map((value, i) => Math.abs(value - target[i])));
    }).toBeLessThan(0.0001);
    const panned = await camera();
    const motions = page.getByRole("combobox", { name: context.motion, exact: true });
    const first = await motions.inputValue(), names = await motions.getByRole("option").allTextContents();
    await motions.selectOption(names.find((name) => name !== first));
    await expect(source).not.toHaveAttribute("data-animation", first);
    await expect.poll(camera).toEqual(panned);
    await page.getByRole("button", { name: `${context.label} 适配画布`, exact: true }).click();
    await expect(viewer.locator(".viewer-tools span")).toHaveText("100%");
    await expect.poll(async () => (await camera()).center).not.toBe(panned.center);
    expect(workbench.store.call("projects", "get", [before.id])).toEqual(before);
  });
}

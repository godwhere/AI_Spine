import { createCanvas } from "@napi-rs/canvas";
import { test, expect } from "./fixtures.mjs";

test("indexed library metadata renders its local thumbnail and opens the original project", async ({ page, workbench }) => {
  const source = workbench.store.call("projects", "get", ["architecture-fixture"]);
  const image = createCanvas(64, 64), context = image.getContext("2d"); context.fillStyle = "#864bc2"; context.fillRect(8, 8, 48, 48);
  const saved = workbench.store.call("projects", "save", [{ ...source, id: "indexed-thumbnail", name: "Indexed thumbnail fixture", thumbnail: image.toDataURL("image/png") }]);
  const thumbnailRequests = []; page.on("request", (request) => { if (request.url().includes("/api/workspace/thumbnails/")) thumbnailRequests.push(request.url()); });
  const summaryResponse = page.waitForResponse((response) => /\/api\/workspace\/(?:v2\/)?projects$/.test(response.url()) && response.request().postDataJSON()?.operation === "summary");
  await page.reload();
  const summary = (await (await summaryResponse).json()).value;
  expect(summary.projects).toHaveLength(2); expect(JSON.stringify(summary).length).toBeLessThan(4096);
  expect(summary.projects.every((record) => !record.files && !record.edits && !record.generation)).toBe(true);
  await expect.poll(() => page.locator(".resource-library .explorer-thumbnail img").first().evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(thumbnailRequests.length).toBeGreaterThan(0);
  expect(thumbnailRequests.every((url) => new URL(url).origin === workbench.origin)).toBe(true);
  await page.getByRole("button", { name: "预览 Indexed thumbnail fixture", exact: true }).dblclick();
  await expect(page.getByRole("textbox", { name: "资源名称", exact: true })).toHaveValue(saved.name);
  expect(workbench.store.call("projects", "get", [saved.id])).toEqual(saved);
  expect(workbench.store.checkProjectIndex().consistent).toBe(true);
});

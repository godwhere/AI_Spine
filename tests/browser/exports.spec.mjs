import { readFile, writeFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import { test, expect } from "./fixtures.mjs";
import { createHumanoidDraft } from "../../engine/rig/create-draft.js";
import { buildRigFiles } from "../../engine/rig/build-files.js";
import { attachRigAuthoring, readRigAuthoring } from "../../engine/archive/rig-project.js";
import { parseBundle } from "../../engine/archive/bundle.js";
import { parseSkeleton } from "../../engine/spine/parse.js";
import { unpackZip } from "../../engine/archive/zip.js";
import { pixelEnv } from "../helpers.mjs";
import { startInteractionMeasurement, markInteraction, finishInteractionMeasurement } from "./performance.mjs";

const nav = (page) => page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: /我的资源/ });
const signature = (files, skeletonPath) => {
  const { data } = parseSkeleton(parseBundle(files, { skeletonPath }));
  return { bones: data.bones.map((bone) => [bone.name, bone.parent?.name, bone.length]), slots: data.slots.map((slot) => [slot.name, slot.boneData.name]),
    skins: data.skins.map((skin) => skin.name), motions: data.animations.map((motion) => [motion.name, motion.duration]),
    constraints: data.constraints.map((constraint) => [constraint.constructor.name, constraint.name]) };
};

async function nativeFixture() {
  const canvas = createCanvas(24, 24), context = canvas.getContext("2d"); context.fillStyle = "#864bc2"; context.fillRect(4, 4, 16, 16);
  const image = canvas.toDataURL("image/png");
  const document = createHumanoidDraft({ id: "native-export-fixture", name: "Native export fixture", width: 240, height: 360, sourceImage: image });
  document.parts = document.parts.map((part) => ({ ...part, image, imageSource: "uploaded", completion: "ready" }));
  const base = document.parts[0], variant = { ...base, id: "expression-closed", label: "Synthetic expression variant", attachmentGroup: "eyeLeft" };
  base.attachmentGroup = "eyeLeft"; document.parts.push(variant); document.defaultAttachments = { eyeLeft: base.id };
  document.motions[0].poses[1].attachments = { eyeLeft: variant.id };
  document.motions.push({ id: "release_test", name: "Release", duration: 1.1, loop: false, origin: "manual", poses: [
    { time: 0, feet: { left: true, right: true } }, { time: .17, angles: { torso: -7 }, root: { x: 2, y: 3 } },
    { time: .347, angles: { torso: 9, leftThigh: -23, leftShin: 49 }, root: { x: 4, y: 20 }, feet: { left: false, right: false } },
    { time: 1.1, angles: { torso: 40, leftThigh: -65, leftShin: 145 }, root: { x: 18, y: 100 } },
  ] });
  const files = attachRigAuthoring(await buildRigFiles(document, pixelEnv), document), bundle = parseBundle(files);
  return { id: "native-export-fixture", name: document.name, files, skeletonPath: bundle.skeletonPath, edits: {}, generation: {} };
}

for (const native of [false, true]) test(`${native ? "authored weighted rig" : "original template"} downloads and reimports runtime, editable and Unity ZIPs through visible browser controls`, async ({ page, workbench }, testInfo) => {
  let source = workbench.store.call("projects", "get", ["architecture-fixture"]);
  if (native) { source = workbench.store.call("projects", "save", [await nativeFixture()]); await page.reload(); }
  await startInteractionMeasurement(page);
  await page.getByRole("button", { name: `预览 ${source.name}`, exact: true }).dblclick();
  await page.getByRole("button", { name: "调整细节", exact: true }).click();
  await expect(page.getByRole("button", { name: "完成调整", exact: true })).toBeEnabled();
  await page.getByRole("spinbutton", { name: "水平位置", exact: true }).fill("2");
  await page.getByRole("button", { name: "完成调整", exact: true }).click();
  await expect.poll(() => Object.values(workbench.store.call("projects", "get", [source.id]).edits)[0]?.transform.x).toBe(2);
  await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
  source = workbench.store.call("projects", "get", [source.id]);
  const original = signature(source.files, source.skeletonPath), authored = readRigAuthoring(source.files);
  const selected = Object.keys(source.edits)[0];
  for (const [mode, label] of [["runtime", /Spine 运行时资源包/], ["project", /可编辑工程备份/], ["unity", /Unity 资源包/]]) {
    await markInteraction(page, `export-${mode}`);
    if (mode !== "runtime") { await nav(page).click(); await page.getByRole("button", { name: `预览 ${source.name}`, exact: true }).dblclick(); }
    await page.getByRole("button", { name: "导出", exact: true }).click(); await page.getByRole("radio", { name: label }).check();
    const event = page.waitForEvent("download"); await page.getByRole("button", { name: "校验并导出 ZIP", exact: true }).click();
    const download = await event, path = testInfo.outputPath(`${native ? "native" : "template"}-${mode}.zip`); await download.saveAs(path);
    const files = unpackZip(new Uint8Array(await readFile(path))), exported = parseBundle(files);
    expect(signature(files, exported.skeletonPath)).toEqual(original);
    expect(exported.files[exported.skeletonPath]).toEqual(source.files[source.skeletonPath]);
    expect(Boolean(files[".ai-spine/project.json"])).toBe(mode === "project");
    if (mode === "unity") expect(Object.keys(files).some((name) => name.endsWith(".atlas.txt"))).toBe(true);
    if (native) {
      const restored = readRigAuthoring(files); expect(restored.joints).toEqual(authored.joints); expect(restored.motions).toEqual(authored.motions);
      expect(restored.parts.map((part) => [part.id, part.binding, part.bone, part.influences, part.mesh])).toEqual(authored.parts.map((part) => [part.id, part.binding, part.bone, part.influences, part.mesh]));
      expect(restored.defaultAttachments).toEqual(authored.defaultAttachments); expect(restored.sourceImage).toBe(authored.sourceImage);
      expect(restored.parts.every((part) => typeof part.image === "string" && part.image.startsWith("data:image/png;base64,"))).toBe(true);
      expect(Object.keys(files).filter((name) => name.endsWith(".png")).length).toBeGreaterThan(1);
    }
    const beforeIds = new Set(workbench.store.call("projects", "list").projects.map((record) => record.id));
    await markInteraction(page, `import-${mode}`);
    await page.locator('input[type="file"][multiple]').setInputFiles(path);
    await expect.poll(() => workbench.store.call("projects", "list").projects.filter((record) => !beforeIds.has(record.id)).length).toBe(1);
    await expect(page.locator(".save-indicator")).toHaveText("已保存到本机");
    const name = `Roundtrip ${native ? "native" : "template"} ${mode}`;
    await page.getByRole("textbox", { name: "资源名称", exact: true }).fill(name);
    await expect.poll(() => workbench.store.call("projects", "list").projects.some((record) => record.name === name)).toBe(true);
    const row = workbench.store.call("projects", "list").projects.find((record) => record.name === name), imported = workbench.store.call("projects", "get", [row.id]);
    expect(row.id).not.toBe(source.id); expect(signature(imported.files, imported.skeletonPath)).toEqual(original);
    for (const [name, bytes] of Object.entries(exported.files).filter(([name]) => name.endsWith(".png"))) expect(imported.files[name]).toEqual(bytes);
    expect(mode === "project" ? imported.edits[selected].transform.x : Object.keys(imported.edits).length).toBe(mode === "project" ? 2 : 0);
    await expect(page.locator('.spine-viewer[aria-label="当前资源动画"] .viewer-message.error')).toHaveCount(0);
  }
  expect(workbench.store.call("projects", "get", [source.id])).toEqual(source);
  const interaction = await finishInteractionMeasurement(page);
  await writeFile(testInfo.outputPath("interaction-performance.json"), JSON.stringify({ native, ...interaction }, null, 2));
});

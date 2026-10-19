import { packager } from "@electron/packager";
import { createCanvas } from "@napi-rs/canvas";
import { mkdir, mkdtemp, cp, readFile, writeFile, rm, realpath, rename } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyDesktopExamples } from "./desktop-assets.mjs";

if (process.platform !== "darwin") throw new Error("This packaging target builds the local macOS application.");
const root = resolve(".");
await mkdir(join(root, "work"), { recursive: true });
const temp = await mkdtemp(join(root, "work/desktop-build-"));
try {
  const stage = join(temp, "app");
  await mkdir(join(stage, "dist"), { recursive: true });
  for (const folder of ["desktop", "server", "dist/client"]) await cp(join(root, folder), join(stage, folder), { recursive: true });
  await copyDesktopExamples(join(stage, "dist/client"));
  await cp(join(root, "THIRD_PARTY_NOTICES.md"), join(stage, "THIRD_PARTY_NOTICES.md"));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(join(stage, "package.json"), JSON.stringify({ name: "ai-spine-desktop", productName: "AI Spine",
    version: manifest.version, description: "Local Spine character animation workbench", type: "module", main: "desktop/bootstrap.cjs", author: "Ethan" }));
  const scoped = join(stage, "node_modules/@napi-rs");
  await mkdir(scoped, { recursive: true });
  const canvasRoot = dirname(await realpath(join(root, "node_modules/@napi-rs/canvas/package.json")));
  await cp(canvasRoot, join(scoped, "canvas"), { recursive: true, dereference: true });
  const canvasRequire = createRequire(join(canvasRoot, "package.json"));
  const platformName = `canvas-darwin-${process.arch}`;
  await cp(dirname(canvasRequire.resolve(`@napi-rs/${platformName}/package.json`)), join(scoped, platformName), { recursive: true });
  // Draw the app's own small interface icon; character artwork remains unchanged.
  const iconset = join(temp, "AI Spine.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    const dimension = size * scale, canvas = createCanvas(dimension, dimension), ctx = canvas.getContext("2d");
    ctx.scale(dimension / 1024, dimension / 1024);
    const gradient = ctx.createLinearGradient(0, 0, 1024, 1024);
    gradient.addColorStop(0, "#233c47"); gradient.addColorStop(1, "#0b151f");
    ctx.fillStyle = gradient; ctx.beginPath(); ctx.roundRect(32, 32, 960, 960, 218); ctx.fill();
    ctx.strokeStyle = "#73e4ba"; ctx.lineWidth = 76; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(700, 270); ctx.lineTo(330, 410); ctx.lineTo(694, 600); ctx.lineTo(322, 754); ctx.stroke();
    ctx.fillStyle = "#d6fff0";
    for (const [x, y] of [[700, 270], [330, 410], [694, 600], [322, 754]]) { ctx.beginPath(); ctx.arc(x, y, 63, 0, Math.PI * 2); ctx.fill(); }
    await writeFile(join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`), canvas.toBuffer("image/png"));
  }
  const icon = join(temp, "AI Spine.icns");
  execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", icon]);
  const [folder] = await packager({ dir: stage, out: join(temp, "packaged"), name: "AI Spine",
    platform: "darwin", arch: process.arch, appBundleId: "com.ethan.ai-spine", appCategoryType: "public.app-category.graphics-design",
    appVersion: manifest.version, electronVersion: manifest.devDependencies.electron, icon,
    asar: false, prune: false, overwrite: true });
  const target = join(root, "outputs/desktop/AI Spine.app");
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { force: true, recursive: true });
  // Keep framework symlinks relative to their bundle when moving out of staging.
  await rename(join(folder, "AI Spine.app"), target);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", target]);
  console.log(`Built: ${target}`);
} finally { await rm(temp, { recursive: true, force: true }); }

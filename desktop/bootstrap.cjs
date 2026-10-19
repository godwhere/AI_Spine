const { app, dialog } = require("electron");
const { mkdirSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");

// Configure the profile synchronously, before Electron's ready event and ESM load.
app.setName("AI Spine");
const dataRoot = join(app.getPath("appData"), "AI Spine");
mkdirSync(dataRoot, { recursive: true });
app.setPath("userData", dataRoot);
const log = join(dataRoot, "startup.log");
const fail = (error) => {
  appendFileSync(log, `${new Date().toISOString()} ${error?.stack || error}\n`);
  dialog.showErrorBox("AI Spine 启动失败", error?.message || String(error));
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
import("./main.mjs").catch(fail);

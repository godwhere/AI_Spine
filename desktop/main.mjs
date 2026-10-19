import { app, BrowserWindow, Menu, dialog, ipcMain, shell, screen } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import { startDesktopServer } from "./server.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let window, backend, allowClose = false, shutdown = false;
const stateFile = () => join(app.getPath("userData"), "window.json");
const action = (name) => window?.webContents.send("workbench:action", name);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { window?.restore(); window?.show(); window?.focus(); });
  app.on("before-quit", (event) => {
    if (shutdown) return;
    event.preventDefault();
    if (window && !allowClose) action("close");
    else void stop();
  });
  app.on("window-all-closed", () => { void stop(); });
  ipcMain.on("workbench:close-ready", (event) => {
    if (event.sender !== window?.webContents) return;
    allowClose = true;
    window.close();
  });
  await app.whenReady();
  try {
    app.setAccessibilitySupportEnabled(true);
    backend = await startDesktopServer({ clientRoot: join(root, "dist/client"), dataRoot: app.getPath("userData") });
    const area = screen.getPrimaryDisplay().workArea;
    let bounds = { width: Math.min(1440, area.width), height: Math.min(960, area.height) };
    try { bounds = { ...bounds, ...JSON.parse(await readFile(stateFile(), "utf8")) }; } catch { /* First launch. */ }
    bounds.width = Math.max(1100, Math.min(bounds.width, area.width));
    bounds.height = Math.max(740, Math.min(bounds.height, area.height));
    if (bounds.x !== undefined) bounds.x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width));
    if (bounds.y !== undefined) bounds.y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height));
    window = new BrowserWindow({ ...bounds, minWidth: 1100, minHeight: 740, show: false,
      title: "AI Spine", backgroundColor: "#0b1119", titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 17 },
      webPreferences: { preload: join(root, "desktop/preload.cjs"), nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false } });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== backend.origin) event.preventDefault();
    });
    window.webContents.session.on("will-download", (_event, item) => {
      item.setSaveDialogOptions({ title: "导出资源", defaultPath: join(app.getPath("downloads"), item.getFilename()),
        filters: [{ name: "Spine 资源包", extensions: ["zip", "png"] }] });
    });
    window.on("close", (event) => {
      if (!allowClose) { event.preventDefault(); action("close"); return; }
      const bounds = window.getNormalBounds();
      try {
        writeFileSync(stateFile() + ".tmp", JSON.stringify(bounds));
        renameSync(stateFile() + ".tmp", stateFile());
      } catch { /* Window state must not prevent saving and closing a project. */ }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "AI Spine", submenu: [{ role: "about", label: "关于 AI Spine" }, { type: "separator" },
        { label: "显示资源文件夹", click: () => { void shell.openPath(app.getPath("userData")); } },
        { type: "separator" }, { role: "hide", label: "隐藏 AI Spine" }, { role: "hideOthers", label: "隐藏其他应用" },
        { type: "separator" }, { role: "quit", label: "退出 AI Spine" }] },
      { label: "文件", submenu: [
        { label: "我的资源", accelerator: "CmdOrCtrl+1", click: () => action("library") },
        { label: "模板库", accelerator: "CmdOrCtrl+2", click: () => action("templates") },
        { type: "separator" }, { label: "导入资源…", accelerator: "CmdOrCtrl+O", click: () => action("import") },
        { label: "保存工程", accelerator: "CmdOrCtrl+S", click: () => action("save") },
        { label: "导出…", accelerator: "CmdOrCtrl+Shift+E", click: () => action("export") }] },
      { label: "编辑", submenu: [{ role: "undo", label: "撤销" }, { role: "redo", label: "重做" },
        { type: "separator" }, { role: "cut", label: "剪切" }, { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" }, { role: "selectAll", label: "全选" }] },
      { label: "窗口", submenu: [{ role: "minimize", label: "最小化" }, { role: "togglefullscreen", label: "进入全屏" }] },
      { label: "帮助", submenu: [{ label: "使用引导", click: () => action("guide") }] },
    ]));
    window.once("ready-to-show", () => { window.show(); window.focus(); });
    await window.loadURL(backend.origin);
  } catch (error) {
    dialog.showErrorBox("AI Spine 无法启动", error.code === "EADDRINUSE"
      ? "本机 4175 端口已被占用。请关闭另一份 AI Spine 后重新打开。" : error.message);
    await stop();
  }
}
async function stop() {
  if (shutdown) return;
  shutdown = true;
  await backend?.close();
  app.quit();
}

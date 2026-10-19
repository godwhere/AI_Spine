const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiSpineDesktop", Object.freeze({
  platform: process.platform,
  onAction(callback) {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("workbench:action", listener);
    return () => ipcRenderer.removeListener("workbench:action", listener);
  },
  closeReady() { ipcRenderer.send("workbench:close-ready"); },
}));

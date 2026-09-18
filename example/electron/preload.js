"use strict";
/**
 * Electron Preload Script for `uareu-napi`.
 * Exposes a secure API to the renderer process via `contextBridge`.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fingerprint", {
  listDevices: () => ipcRenderer.invoke("fp:list-devices"),
  scan: (options) => ipcRenderer.invoke("fp:scan", options),
  onHint: (callback) => {
    ipcRenderer.on("fp:hint", (_event, message) => callback(message));
  },
});

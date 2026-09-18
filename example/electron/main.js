"use strict";
/**
 * Electron Main Process Integration Boilerplate for `uareu-napi`.
 *
 * Requirements:
 *   npm install electron
 *   npx electron example/electron/main.js
 */

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const uareu = require("../..");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 650,
    height: 700,
    title: "U.are.U Fingerprint Scanner — Electron Demo",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

// 1. List connected readers
ipcMain.handle("fp:list-devices", async () => {
  try {
    return { success: true, devices: uareu.listDevices() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 2. Perform one-shot scan with live hints and BMP preview
ipcMain.handle("fp:scan", async (_event, options = {}) => {
  try {
    const result = await uareu.scanOnce({
      timeout: options.timeout || 15000,
      attemptTimeout: 5000,
      extract: true,
      bmp: true, // Generate BMP Buffer and Base64 Data URL
      pad: options.pad || false, // Hardware anti-spoofing
      onQuality: (_code, msg) => {
        // Stream live quality feedback to the renderer UI
        mainWindow?.webContents.send("fp:hint", msg);
      },
    });

    return {
      success: result.success,
      reason: result.reason,
      qualityText: result.qualityText,
      width: result.width,
      height: result.height,
      dpi: result.dpi,
      bmpDataUrl: result.bmpDataUrl || null,
      fmdBase64: result.fmd ? result.fmd.toString("base64") : null,
    };
  } catch (err) {
    return { success: false, reason: "error", error: err.message };
  }
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

# Electron Integration Guide for `uareu-napi`

This directory provides a production-ready reference pattern for integrating `uareu-napi` into Electron applications (e.g. Electron 17–32+).

---

## 1. Electron Architecture Overview

In Electron, biometric hardware interactions **must run in the Main process** and communicate with the Renderer via IPC:

```
┌─────────────────────────────────────────────────────────────┐
│                       RENDERER UI                           │
│  (Angular / React / Vue / Vanilla HTML + JS)                │
│                                                             │
│  • Clicks "Scan Fingerprint" button                         │
│  • Receives live hints ("Press harder", "Clean sensor")     │
│  • Displays captured fingerprint preview: <img src="..." /> │
└─────────────────┬───────────────────────▲───────────────────┘
                  │ invoke                │ send (hints)
┌─────────────────▼───────────────────────┴───────────────────┐
│                      PRELOAD SCRIPT                         │
│  (contextBridge.exposeInMainWorld)                          │
└─────────────────┬───────────────────────▲───────────────────┘
                  │                       │
┌─────────────────▼───────────────────────┴───────────────────┐
│                       MAIN PROCESS                          │
│                                                             │
│  const uareu = require("uareu-napi");                       │
│  • Non-blocking captureAsync / scanOnce                     │
│  • Hardware PAD (anti-spoofing)                             │
│  • Generates Base64 BMP preview via toBmpDataUrl()          │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. File Implementation Summary

### `main.js` (Main Process)
```js
const { app, BrowserWindow, ipcMain } = require("electron");
const uareu = require("uareu-napi");

let mainWindow;

ipcMain.handle("fp:scan", async () => {
  const result = await uareu.scanOnce({
    extract: true,
    bmp: true,       // Auto-generate BMP Buffer & Data URL
    timeout: 15000,
    attemptTimeout: 5000,
    onQuality: (code, msg) => {
      mainWindow?.webContents.send("fp:hint", msg);
    },
  });

  return {
    success: result.success,
    reason: result.reason,
    qualityText: result.qualityText,
    bmpDataUrl: result.bmpDataUrl || null,
    fmdBase64: result.fmd ? result.fmd.toString("base64") : null,
  };
});
```

### `preload.js` (Context Isolation Bridge)
```js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fingerprint", {
  scan: () => ipcRenderer.invoke("fp:scan"),
  onHint: (callback) => {
    ipcRenderer.on("fp:hint", (_event, msg) => callback(msg));
  },
});
```

### `index.html` (Renderer UI)
```html
<button id="scanBtn">Scan Fingerprint</button>
<p id="status">Standby</p>
<img id="preview" style="width: 250px; height: 275px; border: 1px solid #ccc;" />

<script>
  window.fingerprint.onHint((hint) => {
    document.getElementById("status").textContent = hint;
  });

  document.getElementById("scanBtn").addEventListener("click", async () => {
    document.getElementById("status").textContent = "Place your finger on sensor...";
    const result = await window.fingerprint.scan();
    if (result.success) {
      document.getElementById("status").textContent = "Verified!";
      document.getElementById("preview").src = result.bmpDataUrl;
    } else {
      document.getElementById("status").textContent = "Failed: " + result.reason;
    }
  });
</script>
```

---

## 3. Packaging Considerations (`electron-builder`)

If using `electron-builder`:
* If `asar: false`, native `.node` and `.dll` files load automatically without extra configuration.
* If `asar: true`, ensure native binaries and runtime DLLs are unpacked:
  ```json
  "asarUnpack": [
    "**/node_modules/uareu-napi/build/Release/*.node",
    "**/node_modules/uareu-napi/build/Release/*.dll"
  ]
  ```

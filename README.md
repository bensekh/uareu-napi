# uareu-napi

[![node](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](https://nodejs.org)
[![platform](https://img.shields.io/badge/platform-win32--x64-lightgrey)](#requirements)
[![napi](https://img.shields.io/badge/N--API-v8-blue)](#requirements)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Node.js / Electron bridge for the **U.are.U SDK** (DigitalPersona / HID / Crossmatch)
fingerprint readers: image capture (`dpfpdd.dll`), minutiae extraction and
matching (`dpfj.dll`).

- **Non-blocking** — `captureAsync` runs on a native thread pool; the JS event
  loop (and your Electron UI) never freezes.
- **Three API layers** — one-shot Promise (`scanOnce`), event-driven
  (`Scanner`), and low-level synchronous wrappers.
- **N-API v8 (ABI stable)** — one binary runs on **Node 16, Node 26 and
  Electron 17+** with no rebuild.
- **Self-contained package** — the prebuilt `.node` binary and all SDK DLLs
  ship inside the tarball; consumers just `require()`.
- **Full JSDoc** on every function — readable by humans and AI agents, with
  TypeScript definitions included.

## Requirements

- Windows x64
- U.are.U SDK installed (default location
  `C:\Program Files\DigitalPersona\U.are.U SDK`); override with the
  `UAREU_SDK_LIB` environment variable pointing to its `Windows\Lib\x64` folder
- Node.js >= 16 (any version — no rebuild needed thanks to N-API ABI stability)

## Install

```sh
# from a local folder
npm install D:\path\to\uareu-napi

# from a tarball
npm install uareu-napi-0.2.0.tgz

# from GitHub
npm install github:bensekh/uareu-napi
```

```js
const uareu = require("uareu-napi");
```

### Building from source

Only needed when developing this package (the published package already
contains the binary):

```sh
npm install
npm run build   # node-gyp via Node 16 (nvm) + copies SDK DLLs to build/Release
```

Build requirements: VS Build Tools 2017+, Node 16 available through nvm
(`nvm install 16.20.2`), and Python 3. The build script auto-detects both.

## Quick start

```js
const uareu = require("uareu-napi");

const result = await uareu.scanOnce({ timeout: 15000 });
if (result.success) {
  console.log("finger captured", result.width, "x", result.height);
} else {
  console.log("failed:", result.reason); // 'no-device' | 'timeout' | 'bad-quality'
}
```

## API

### 1. `scanOnce(options?) → Promise<ScanOnceResult>` — one-shot

Finds a reader, waits for a finger (automatically retrying while quality is
bad, until the total `timeout` budget runs out), optionally extracts the
minutiae template (FMD), then closes the reader. Fully non-blocking.

```js
const r = await uareu.scanOnce({
  deviceName: undefined,   // target by name (default: first found)
  deviceIndex: undefined,  // or target by 0-based index (e.g. 0, 1)
  deviceSerial: undefined, // or target by serial number substring
  selectDevice: undefined, // or custom callback: (devices) => devices[0]
  exclusive: true,         // lock out other applications
  timeout: 15000,          // total budget (ms)
  attemptTimeout: 5000,    // per attempt (ms)
  extract: false,          // true → r.fmd (Buffer with the minutiae template)
  bmp: false,              // true → r.bmp (Buffer) & r.bmpDataUrl (Data URL string)
  pad: false,              // true → enable hardware anti-spoofing (PAD)
  onQuality: (code, msg) => showHint(msg), // real-time UI feedback
});
```

Result (`ScanOnceResult`):

| Field | Description |
|---|---|
| `success` | `true` when a usable fingerprint was captured |
| `reason` | `null` \| `'no-device'` \| `'timeout'` \| `'bad-quality'` |
| `attempts` | number of capture attempts made |
| `image` | `Buffer` of raw grayscale pixels (on success) |
| `fmd` | `Buffer` minutiae template (on success, when `extract: true`) |
| `bmp` | `Buffer` of BMP image file (on success, when `bmp: true`) |
| `bmpDataUrl` | Base64 Data URL for `<img src="...">` (when `bmp: true`) |
| `width, height, dpi, bpp, score` | image metadata (on success) |
| `quality, qualityText` | last quality code + message (on failure) |

### 2. `openScanner(options?) → Scanner` — event-driven

Keeps the reader open and loops captures in the background — the fingerprint
equivalent of `nfc-pcsc`.

Events: `open` `{device}` · `scan` `{image, fmd, ...}` · `quality` `(code, msg)` ·
`error` `(Error)` · `close`.

```js
const scanner = uareu.openScanner({ extract: false });
scanner.on("scan",    (s)   => win.webContents.send("fp:scan", { ok: true }));
scanner.on("quality", (c,m) => win.webContents.send("fp:hint", m));
scanner.on("error",   (e)   => console.error(e));
await scanner.open();
scanner.start();
// ...
scanner.stop();        // pause; reader stays open, call start() to resume
await scanner.close();
```

### 3. Low-level API

All functions are fully documented with JSDoc (`index.js` / `index.d.ts`).

| Function | Type | Description |
|---|---|---|
| `init()` / `exit()` | sync, ref-counted | SDK lifecycle; `open()`/`close()` call them automatically |
| `version()` | sync | capture & fingerjet library versions |
| `listDevices()` | sync, auto-init | connected readers (`DeviceInfo[]`) |
| `waitForDevice(opts?)` | Promise | waits until a reader is plugged in (`DeviceInfo`) |
| `selectDevice(opts?)` | Promise | interactive or programmatic reader selection (`DeviceInfo`) |
| `open(name, exclusive?)` | sync | → reader handle (number) |
| `close(handle)` | sync | cancels any pending capture, then closes |
| `cancel(handle)` | sync | cancels a running `captureAsync` |
| `getCapabilities(handle)` | sync | resolutions, LED support, reader features |
| `getStatus(handle)` | sync | `{status, fingerDetected}` |
| `capture(handle, opts?)` | **blocking** | for CLI/worker use only — use `captureAsync` in Electron |
| `captureAsync(handle, opts?)` | **Promise** | one capture, non-blocking; resolves `{success, quality, image}` |
| `createFmdFromRaw(image, opts)` | sync (~ms) | raw pixels → FMD template |
| `createFmdFromFid(fid, fidType, fmdType?)` | sync | ANSI/ISO image record (FID) → FMD |
| `compare(fmd1, t1, fmd2, t2)` | sync | 1:1 → `{score, falseMatchRate}`; match if `< 1e-5` |
| `identify(probe, t, list, t?, threshold?)` | sync | 1:N search → ranked candidates (best first) |
| `startEnrollment / addToEnrollment / createEnrollmentFmd / finishEnrollment` | sync | multi-sample enrollment → storable template |
| `ledConfig / ledCtrl` | sync | accept/reject LEDs (exclusive mode) |
| `setPad(handle, bool)` | sync | Presentation Attack Detection (fake-finger check) |
| `selectEngine(engine?)` | sync | `C.ENGINE.DPFJ` / `DPFJ7` (Minex-certified) |
| `qualityText(code)` | sync | human-readable text for `C.QUALITY.*` codes |
| `toBmp(image, w, h, dpi?)` | sync | converts raw pixels → Windows BMP image `Buffer` |
| `toBmpDataUrl(image, w, h, dpi?)` | sync | converts raw pixels → Base64 Data URL (`data:image/bmp;base64,...`) |
| `C` | constants | `IMG_FMT, IMG_PROC, QUALITY, FID_FORMAT, FMD_FORMAT, LED, ENGINE, PROBABILITY_ONE, MAX_FMD_SIZE` |

### Example: enrollment + 1:1 verification

```js
// 1. Enroll (multiple finger placements until template is complete)
uareu.startEnrollment(uareu.C.FMD_FORMAT.DP_REG);
let ready = false;
while (!ready) {
  const s = await uareu.scanOnce({
    extract: true,
    fmdType: uareu.C.FMD_FORMAT.DP_PRE_REG,
    timeout: 30000,
  });
  if (!s.success) throw new Error(s.reason);
  ready = uareu.addToEnrollment(s.fmd, uareu.C.FMD_FORMAT.DP_PRE_REG);
}
const template = uareu.createEnrollmentFmd();   // Buffer (DP_REG) → store in your DB
uareu.finishEnrollment();

// 2. Verify
const v = await uareu.scanOnce({
  extract: true,
  fmdType: uareu.C.FMD_FORMAT.DP_VER,
});
const { score, falseMatchRate } = uareu.compare(
  v.fmd,
  uareu.C.FMD_FORMAT.DP_VER,
  template,
  uareu.C.FMD_FORMAT.DP_REG
);
const matched = falseMatchRate < 1 / 100000; // one-in-100,000 false-match rate
```

### Example: 1:N identification (search database)

```js
// candidate templates loaded from database (e.g. ISO 19794-2:2005)
const candidates = [aliceTemplate, bobTemplate, charlieTemplate];
const T = uareu.C.FMD_FORMAT.ISO_19794_2_2005;

// capture unknown probe fingerprint
const probe = await uareu.scanOnce({ extract: true, fmdType: T });

// search all candidates in memory in < 2ms
const matches = uareu.identify(probe.fmd, T, candidates, T);
if (matches.length > 0) {
  const matchIdx = matches[0].index; // matched candidate index
  console.log(`Identified user:`, users[matchIdx].name);
} else {
  console.log("Unrecognized fingerprint");
}
```

## Integration with Electron

**Main process** — a one-liner in an IPC handler:

```ts
import { ipcMain } from "electron";
const uareu = require("uareu-napi");

ipcMain.handle("fp:scan", () =>
  uareu.scanOnce({
    timeout: 15000,
    onQuality: (_code, msg) => win?.webContents.send("fp:hint", msg),
  })
);
```

**Renderer** — `invoke` returns a Promise; wrap it with RxJS if you prefer
Observables:

```ts
import { from } from "rxjs";
const result$ = from(ipcRenderer.invoke("fp:scan"));
result$.subscribe((r) =>
  showMessage(r.success ? "Finger captured" : r.qualityText ?? r.reason)
);
```

Electron notes:

- Electron 17 embeds Node 16; this package targets N-API v8, so
  **`electron-rebuild` is not needed**.
- `capture()` (the synchronous variant) blocks the main process — never call
  it from Electron; use `scanOnce` / `captureAsync` / `Scanner`.
- Packaging: with `asar: false` nothing extra is required. With asar enabled,
  add `asarUnpack: ["**/*.node", "**/*.dll"]` to your builder config.

## Capture quality (UI feedback)

`quality` is a bitmask of `C.QUALITY.*`; `qualityText()` translates it, e.g.
`NO_FINGER` → "not a finger", `FINGER_TOO_HIGH` → "finger too high",
`READER_DIRTY` → "reader needs cleaning". `scanOnce.onQuality` and the
`Scanner 'quality'` event deliver these directly to your hint UI.

## Error handling

- Promise-based APIs **resolve** on ordinary failures (finger not read) —
  check `success` / `reason`. They reject only on unexpected SDK errors.
- Low-level functions throw `Error` including the SDK code, e.g.
  `dpfpdd_open_ext failed (code 0x05ba001e)` (= device busy).
- `close()` while a `captureAsync` is in flight is safe: the handle is
  invalidated immediately, the capture is canceled, and the physical device
  is closed once the worker returns.

## Development

```
src/addon.cpp       N-API wrapper (sync + AsyncWorker) over dpfpdd/dpfj
index.js            JS API + JSDoc (Scanner, scanOnce, low-level)
index.d.ts          TypeScript definitions
binding.gyp         build config: SDK include/lib, NAPI_VERSION=8, C++17
scripts/build16.js  builds via Node 16 (nvm) — output runs on Node 16-26+
scripts/copy-dlls.js  copies SDK DLLs into build/Release
test/smoke.js       sync API test
test/async.js       scanOnce + Scanner events test
example/index.js    scanOnce usage example
example/enroll-and-verify.js  enrollment + 1:1 verification example
example/capture-image.js      capture + BMP file and Data URL preview example
example/identify-1-to-n.js    1:N biometric identification example
example/kiosk-scanner.js      continuous event-driven kiosk scanner example
example/select-device.js      multi-device selection and targeting example
example/led-feedback.js       hardware LED indicator and feedback control example
example/electron/             Electron IPC bridge & preview UI boilerplate
```

Run tests: `npm test` (passes without hardware; some paths need a physical
reader).

## Credits

This package is a from-scratch rewrite (N-API C++ addon) of
[lucasfelipecdm/uareu-node](https://github.com/lucasfelipecdm/uareu-node),
which pioneered a Node.js bridge for the U.are.U SDK.

## License

MIT — see [LICENSE](LICENSE).

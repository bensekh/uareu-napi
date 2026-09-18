"use strict";
/**
 * uareu-napi — Node.js / Electron bridge for the DigitalPersona (HID) U.are.U
 * fingerprint SDK (`dpfpdd.dll` for capture, `dpfj.dll` for feature
 * extraction and matching).
 *
 * Three API layers, pick what fits your host:
 *
 * 1. **High-level Promise API** — {@link scanOnce}: one call, resolves with
 *    the scan outcome. Non-blocking; safe for the Electron main process.
 *
 * 2. **Event-driven API** — {@link openScanner} returns a {@link Scanner}
 *    (EventEmitter) that keeps listening for fingers and emits `scan` /
 *    `quality` events — the fingerprint equivalent of `nfc-pcsc`.
 *
 * 3. **Low-level API** — thin wrappers over the C SDK (`open`, `capture`,
 *    `captureAsync`, `compare`, `identify`, enrollment, LEDs). Everything
 *    except `capture` is fast; `capture` is blocking and only meant for CLI
 *    scripts or worker threads.
 *
 * The native binary is N-API v8 (ABI stable): the same build runs on
 * Node 16, Node 26 and Electron 17+ without rebuilding.
 *
 * @module uareu-napi
 */

const path = require("path");
const fs = require("fs");
const { EventEmitter } = require("events");

// ---------------------------------------------------------------------------
// Native module + DLL resolution
// ---------------------------------------------------------------------------

/**
 * Folder containing `dpfpdd.dll`, `dpfj.dll` and friends. Defaults to the
 * installed U.are.U SDK; override with the `UAREU_SDK_LIB` env var.
 * The build step copies these DLLs next to the `.node` binary, so this
 * fallback is only needed when the copy step was skipped.
 * @type {string}
 */
const SDK_LIB =
  process.env.UAREU_SDK_LIB ||
  "C:\\Program Files\\DigitalPersona\\U.are.U SDK\\Windows\\Lib\\x64";

const localDll = path.join(__dirname, "build", "Release", "dpfpdd.dll");
if (!fs.existsSync(localDll) && fs.existsSync(SDK_LIB)) {
  if (!process.env.PATH.split(";").includes(SDK_LIB)) {
    process.env.PATH = SDK_LIB + ";" + process.env.PATH;
  }
}

const native = require("./build/Release/uareu.node");

/**
 * Numeric constants mirroring the SDK headers (`dpfpdd.h` / `dpfj.h`).
 * Pass these to the low-level functions.
 *
 * - `IMG_FMT`    — capture image format: `PIXEL_BUFFER` (raw grayscale),
 *                  `ANSI381`, `ISOIEC19794` (FID records).
 * - `IMG_PROC`   — image processing: `DEFAULT`, `PIV`, `ENHANCED`,
 *                  `ENHANCED_2`, `UNPROCESSED`.
 * - `QUALITY`    — capture quality / failure reason bitmask (see
 *                  {@link qualityText}).
 * - `FID_FORMAT` — fingerprint image record formats for
 *                  {@link createFmdFromFid}.
 * - `FMD_FORMAT` — minutiae template formats: `ISO_19794_2_2005`
 *                  (recommended), `ANSI_378_2004`, `DP_PRE_REG`, `DP_REG`,
 *                  `DP_VER`.
 * - `LED`        — LED ids, modes and commands for {@link ledConfig} /
 *                  {@link ledCtrl}.
 * - `ENGINE`     — matching engines for {@link selectEngine}: `DPFJ`,
 *                  `DPFJ7` (Minex-certified), `INNOVATRICS_ANSIISO`.
 * - `PROBABILITY_ONE` — denominator for false-match-rate scores.
 * - `MAX_FMD_SIZE`    — maximum size in bytes of a single-view FMD.
 *
 * @type {object}
 */
const C = native.C;

// ---------------------------------------------------------------------------
// Typedefs
// ---------------------------------------------------------------------------

/**
 * A connected fingerprint reader.
 * @typedef {object} DeviceInfo
 * @property {string} name      Unique device name — pass to {@link open}.
 * @property {string} vendor    Vendor name.
 * @property {string} product   Product name.
 * @property {string} serial    Serial number.
 * @property {number} modality  1 = swipe, 2 = area/placement.
 * @property {number} technology 1 = optical, 2 = capacitive, 3 = thermal.
 * @property {number} vendorId  USB VID.
 * @property {number} productId USB PID.
 */

/**
 * Result of a capture attempt.
 * @typedef {object} CaptureResult
 * @property {boolean} success  True when a usable fingerprint was captured.
 * @property {number}  quality  Bitmask from `C.QUALITY`; 0 = good. When
 *                              `success` is false this explains why
 *                              (see {@link qualityText}).
 * @property {number}  score    Internal image score.
 * @property {number}  width    Image width in pixels.
 * @property {number}  height   Image height in pixels.
 * @property {number}  dpi      Image resolution (dots per inch).
 * @property {number}  bpp      Bits per pixel (always 8).
 * @property {Buffer|null} image Raw pixels (row-major, `width*height` bytes)
 *                              when `success`; otherwise `null`.
 */

/**
 * Reader capabilities from {@link getCapabilities}.
 * @typedef {object} Capabilities
 * @property {boolean} canCaptureImage
 * @property {boolean} canStreamImage
 * @property {boolean} canExtractFeatures
 * @property {boolean} canMatch
 * @property {boolean} canIdentify
 * @property {boolean} hasFpStorage
 * @property {number}  indicatorType  LED capability bitmask.
 * @property {boolean} hasPowerMgmt
 * @property {boolean} hasCalibration
 * @property {boolean} pivCompliant
 * @property {number[]} resolutions   Supported dpi values, e.g. [500].
 */

/**
 * Options accepted by {@link capture} / {@link captureAsync}.
 * @typedef {object} CaptureOptions
 * @property {number} [fmt=C.IMG_FMT.PIXEL_BUFFER] Image format.
 * @property {number} [proc=C.IMG_PROC.DEFAULT]    Image processing.
 * @property {number} [dpi]      Resolution; defaults to the reader's first
 *                               supported resolution.
 * @property {number} [timeout=5000] Milliseconds to wait for a finger.
 */

/**
 * Options for {@link scanOnce}.
 * @typedef {object} ScanOnceOptions
 * @property {string}  [deviceName]     Specific reader; default: first found.
 * @property {boolean} [exclusive=true] Open exclusively (locks other apps).
 * @property {number}  [timeout=15000]  Total budget in ms across attempts.
 * @property {number}  [attemptTimeout=5000] Per-attempt wait in ms.
 * @property {boolean} [extract=false]  Also extract the minutiae template.
 * @property {number}  [fmdType=C.FMD_FORMAT.ISO_19794_2_2005] Template format
 *                                       used when `extract` is true.
 * @property {boolean} [bmp=false]      Convert raw image to BMP Buffer (`bmp`)
 *                                       and Data URL (`bmpDataUrl`).
 * @property {function(number,string):void} [onQuality] Called for every failed
 *                                       attempt with (qualityCode, message) —
 *                                       use to drive "please press your
 *                                       finger" UI feedback.
 */

/**
 * Outcome of {@link scanOnce}.
 * @typedef {object} ScanOnceResult
 * @property {boolean} success  A fingerprint was captured.
 * @property {?string} reason   `null` on success, else one of:
 *                              `'no-device'` (no reader connected),
 *                              `'timeout'` (no finger within budget),
 *                              `'bad-quality'` (finger repeatedly rejected).
 * @property {string}  [device] Name of the reader used.
 * @property {number}  attempts Number of capture attempts made.
 * @property {number}  [quality]      Last quality code (on failure).
 * @property {string}  [qualityText]  Human-readable last quality (on failure).
 * @property {number}  [width]   Image dimensions (on success).
 * @property {number}  [height]
 * @property {number}  [dpi]
 * @property {number}  [bpp]
 * @property {number}  [score]
 * @property {Buffer}  [image]  Raw pixels (on success).
 * @property {Buffer}  [fmd]    Minutiae template (on success, `extract` only).
 * @property {Buffer}  [bmp]    BMP image Buffer (on success, `bmp` only).
 * @property {string}  [bmpDataUrl] BMP Base64 data URL (on success, `bmp` only).
 */

/**
 * Options for {@link openScanner}.
 * @typedef {object} ScannerOptions
 * @property {string}  [deviceName]      Specific reader; default: first found.
 * @property {boolean} [exclusive=true]  Exclusive access.
 * @property {number}  [attemptTimeout=5000] Per-capture wait in ms.
 * @property {number}  [fmt=C.IMG_FMT.PIXEL_BUFFER]
 * @property {number}  [proc=C.IMG_PROC.DEFAULT]
 * @property {number}  [dpi]             Reader default when omitted.
 * @property {boolean} [extract=false]   Attach an FMD template to every
 *                                       `scan` event.
 * @property {number}  [fmdType=C.FMD_FORMAT.ISO_19794_2_2005]
 */

// ---------------------------------------------------------------------------
// SDK lifecycle (ref-counted)
// ---------------------------------------------------------------------------

let initCount = 0;

/**
 * Initialize the SDK. Reference-counted and idempotent — safe to call from
 * multiple places; the SDK is really initialized on the first call.
 * `open()` calls this automatically, so most code never needs it.
 * @returns {void}
 * @throws {Error} When the SDK/driver fails to initialize.
 */
function init() {
  if (initCount++ === 0) native.init();
}

/**
 * Release one SDK reference. The underlying `dpfpdd_exit()` (which closes
 * ALL open readers) runs only when the last reference is released.
 * `close()` calls this automatically.
 * @returns {void}
 */
function exit() {
  if (initCount > 0 && --initCount === 0) native.exit();
}

/**
 * SDK and engine versions.
 * @returns {{capture: {major:number,minor:number,maintenance:number},
 *            fingerjet: {major:number,minor:number,maintenance:number}}}
 */
function version() {
  return native.version();
}

/**
 * Select the fingerprint matching engine (global setting).
 * @param {number} [engine=C.ENGINE.DPFJ] One of `C.ENGINE.*`.
 * @returns {void}
 */
function selectEngine(engine) {
  native.selectEngine(engine === undefined ? C.ENGINE.DPFJ : engine);
}

/**
 * Enumerate connected fingerprint readers. Auto-initializes the SDK, so this
 * is a safe first call from any code path.
 * @returns {DeviceInfo[]} Array (possibly empty) of readers.
 * @throws {Error} On SDK failure.
 * @example
 * const readers = uareu.listDevices();
 * if (readers.length === 0) console.warn("no reader connected");
 */
function listDevices() {
  init();
  try {
    return native.listDevices();
  } finally {
    exit();
  }
}

// ---------------------------------------------------------------------------
// Reader handle lifecycle
// ---------------------------------------------------------------------------

/**
 * Open a reader. Reference-counts the SDK (see {@link init}).
 * @param {string}  name             Reader name from {@link listDevices}.
 * @param {boolean} [exclusive=true] Exclusive mode locks out other apps and
 *                                    enables LED control; cooperative mode
 *                                    shares the device.
 * @returns {number} Opaque reader handle for the other reader functions.
 * @throws {Error} When the name is unknown or the device is busy.
 */
function open(name, exclusive = true) {
  init();
  try {
    return native.open(name, exclusive);
  } catch (err) {
    exit();
    throw err;
  }
}

/**
 * Close a reader and release its SDK reference. Cancels any pending capture
 * first; if a `captureAsync` is still winding down, the physical close
 * happens as soon as it returns (the handle is invalid immediately).
 * @param {number} handle Handle from {@link open}.
 * @returns {void}
 */
function close(handle) {
  try {
    native.close(handle);
  } finally {
    exit();
  }
}

/**
 * Cancel a pending (async) capture on this reader. The corresponding
 * `captureAsync` promise resolves with `success:false` and
 * `quality = C.QUALITY.CANCELED`.
 * @param {number} handle
 * @returns {void}
 */
function cancel(handle) {
  native.cancel(handle);
}

/**
 * Reader capabilities (resolutions, LED support, ...). Fast, non-blocking.
 * @param {number} handle
 * @returns {Capabilities}
 */
function getCapabilities(handle) {
  return native.getCapabilities(handle);
}

/**
 * Current reader status. Fast, non-blocking.
 * @param {number} handle
 * @returns {{status: number, fingerDetected: boolean}} `status`: 0 ready,
 *          1 busy, 2 needs calibration, 3 failure.
 */
function getStatus(handle) {
  return native.getStatus(handle);
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Capture one fingerprint, **blocking** the current thread until a finger is
 * read or `timeout` elapses. Only use this in CLI scripts or worker threads —
 * in the Electron main process use {@link captureAsync} or {@link scanOnce}.
 * @param {number} handle
 * @param {CaptureOptions} [opts]
 * @returns {CaptureResult}
 * @throws {Error} On SDK error (bad handle, device failure, capture already
 *                 in progress).
 */
function capture(handle, opts) {
  return native.capture(handle, opts);
}

/**
 * Capture one fingerprint **without blocking** the event loop (runs on the
 * native thread pool). Rejects only on hard SDK errors; a finger that was
 * not read in time resolves with `success:false` and a `quality` code.
 * @param {number} handle
 * @param {CaptureOptions} [opts]
 * @returns {Promise<CaptureResult>}
 * @example
 * const cap = await uareu.captureAsync(h, { timeout: 10000 });
 * if (!cap.success) console.log("no read:", uareu.qualityText(cap.quality));
 */
function captureAsync(handle, opts) {
  return native.captureAsync(handle, opts);
}

// ---------------------------------------------------------------------------
// Feature extraction & matching (CPU-bound, ~10-100 ms, safe to call inline)
// ---------------------------------------------------------------------------

/**
 * Options for {@link createFmdFromRaw}.
 * @typedef {object} RawExtractOptions
 * @property {number} width   Image width (from CaptureResult).
 * @property {number} height  Image height.
 * @property {number} [dpi=500] Image resolution.
 * @property {number} [fingerPos=0] Finger position code (0 = unknown).
 * @property {number} [cbeffId=0]   CBEFF product id.
 * @property {number} [fmdType=C.FMD_FORMAT.ISO_19794_2_2005] Output format.
 */

/**
 * Extract a fingerprint minutiae template (FMD) from a raw pixel buffer.
 * @param {Buffer} image Raw pixels from {@link CaptureResult}.
 * @param {RawExtractOptions} opts
 * @returns {Buffer} FMD template — store it (DB) and compare later with
 *                   {@link compare} / {@link identify}.
 * @throws {Error} When the image is too small or has too few minutiae.
 */
function createFmdFromRaw(image, opts) {
  return native.createFmdFromRaw(image, opts);
}

/**
 * Extract an FMD from an ANSI/ISO fingerprint image record (FID).
 * @param {Buffer} fid  FID record (captured with `fmt` ANSI381/ISOIEC19794).
 * @param {number} fidType  One of `C.FID_FORMAT.*`.
 * @param {number} [fmdType=C.FMD_FORMAT.ISO_19794_2_2005] Output format.
 * @returns {Buffer}
 */
function createFmdFromFid(fid, fidType, fmdType) {
  return native.createFmdFromFid(fid, fidType, fmdType);
}

/**
 * 1:1 comparison of two FMD templates.
 * @param {Buffer} fmd1  First template.
 * @param {number} type1 Its format (`C.FMD_FORMAT.*`).
 * @param {Buffer} fmd2  Second template.
 * @param {number} type2 Its format.
 * @param {number} [view1=0] View index inside fmd1.
 * @param {number} [view2=0] View index inside fmd2.
 * @returns {{score: number, falseMatchRate: number}} `score` is the
 *          dissimilarity (0 = identical). A common match threshold is
 *          `falseMatchRate < 1e-5` (one-in-100,000).
 * @example
 * const { falseMatchRate } = uareu.compare(a, T, b, T);
 * const matched = falseMatchRate < 1 / 100000;
 */
function compare(fmd1, type1, fmd2, type2, view1 = 0, view2 = 0) {
  return native.compare(fmd1, type1, fmd2, type2, view1, view2);
}

/**
 * 1:N search of a probe FMD against a list of candidate FMDs.
 * @param {Buffer} probe
 * @param {number} probeType
 * @param {Buffer[]} list Candidate templates.
 * @param {number} [type=probeType] Format of the candidates.
 * @param {number} [threshold=C.PROBABILITY_ONE/100000] Max dissimilarity to
 *         accept a candidate.
 * @returns {Array<{index:number, viewIdx:number}>} Ranked candidates
 *          (best first); empty array = no match.
 */
function identify(probe, probeType, list, type, threshold) {
  return native.identify(probe, probeType, list, type, threshold);
}

// ---------------------------------------------------------------------------
// Enrollment (multi-sample template creation)
// ---------------------------------------------------------------------------

/**
 * Start an enrollment session.
 * @param {number} [fmdType=C.FMD_FORMAT.DP_REG] Output template format.
 * @returns {void}
 */
function startEnrollment(fmdType) {
  native.startEnrollment(fmdType === undefined ? C.FMD_FORMAT.DP_REG : fmdType);
}

/**
 * Add a sample FMD to the running enrollment.
 * @param {Buffer} fmd
 * @param {number} [fmdType=C.FMD_FORMAT.DP_PRE_REG] Format of the sample.
 * @returns {boolean} `true` = enrollment has enough samples, call
 *                    {@link createEnrollmentFmd}; `false` = needs another
 *                    scan.
 */
function addToEnrollment(fmd, fmdType) {
  return native.addToEnrollment(fmd, fmdType === undefined ? C.FMD_FORMAT.DP_PRE_REG : fmdType);
}

/**
 * Build the enrollment template from the added samples.
 * @returns {Buffer} Template ready for storage.
 */
function createEnrollmentFmd() {
  return native.createEnrollmentFmd();
}

/**
 * End the enrollment session and free its resources. Always call, even on
 * failure paths.
 * @returns {void}
 */
function finishEnrollment() {
  native.finishEnrollment();
}

// ---------------------------------------------------------------------------
// LEDs & spoof detection
// ---------------------------------------------------------------------------

/**
 * Configure LEDs (auto vs client-controlled). Requires exclusive mode.
 * @param {number} handle
 * @param {number} [ledId=C.LED.ALL]     Bitmask of `C.LED.*` ids.
 * @param {number} [mode=C.LED.MODE_CLIENT] `C.LED.MODE_AUTO` or `MODE_CLIENT`.
 * @returns {void}
 */
function ledConfig(handle, ledId, mode) {
  native.ledConfig(handle, ledId === undefined ? C.LED.ALL : ledId, mode === undefined ? C.LED.MODE_CLIENT : mode);
}

/**
 * Turn a client-controlled LED on/off.
 * @param {number} handle
 * @param {number} [ledId=C.LED.ACCEPT]
 * @param {number} [cmd=C.LED.CMD_OFF]  `C.LED.CMD_ON` or `CMD_OFF`.
 * @returns {void}
 */
function ledCtrl(handle, ledId, cmd) {
  native.ledCtrl(handle, ledId === undefined ? C.LED.ACCEPT : ledId, cmd === undefined ? C.LED.CMD_OFF : cmd);
}

/**
 * Enable/disable Presentation Attack Detection (fake-finger/spoof check).
 * When enabled, fake fingers fail capture with `C.QUALITY.FAKE_FINGER`.
 * @param {number} handle
 * @param {boolean} enable
 * @returns {void}
 */
function setPad(handle, enable) {
  native.setPad(handle, enable);
}

// ---------------------------------------------------------------------------
// Quality text
// ---------------------------------------------------------------------------

const QUALITY_TEXT = {
  [C.QUALITY.GOOD]: "good",
  [C.QUALITY.TIMED_OUT]: "capture timed out",
  [C.QUALITY.CANCELED]: "capture canceled",
  [C.QUALITY.NO_FINGER]: "not a finger",
  [C.QUALITY.FAKE_FINGER]: "fake finger detected",
  [C.QUALITY.FINGER_TOO_LEFT]: "finger too far left",
  [C.QUALITY.FINGER_TOO_RIGHT]: "finger too far right",
  [C.QUALITY.FINGER_TOO_HIGH]: "finger too high",
  [C.QUALITY.FINGER_TOO_LOW]: "finger too low",
  [C.QUALITY.FINGER_OFF_CENTER]: "finger off center",
  [C.QUALITY.SCAN_SKEWED]: "scan skewed",
  [C.QUALITY.SCAN_TOO_SHORT]: "scan too short",
  [C.QUALITY.SCAN_TOO_LONG]: "scan too long",
  [C.QUALITY.SCAN_TOO_SLOW]: "swipe too slow",
  [C.QUALITY.SCAN_TOO_FAST]: "swipe too fast",
  [C.QUALITY.SCAN_WRONG_DIRECTION]: "wrong swipe direction",
  [C.QUALITY.READER_DIRTY]: "reader needs cleaning",
};

/**
 * Human-readable text for a `C.QUALITY.*` code (English).
 * @param {number} quality
 * @returns {string}
 */
function qualityText(quality) {
  return QUALITY_TEXT[quality] || `unknown quality (code ${quality})`;
}

// ---------------------------------------------------------------------------
// Image conversion: BMP
// ---------------------------------------------------------------------------

/**
 * Converts a raw 8-bit grayscale pixel buffer (as returned by U.are.U capture)
 * into a standard Windows BMP image Buffer with a 256-color grayscale palette.
 *
 * Fully synchronous and dependency-free. The resulting Buffer can be saved
 * directly to disk (`.bmp`) or converted to a data URL for `<img src="...">`.
 *
 * @param {Buffer} rawImage Raw uncompressed 8-bit grayscale pixel array.
 * @param {number} width Image width in pixels.
 * @param {number} height Image height in pixels.
 * @param {number} [dpi=700] Resolution metadata in DPI.
 * @returns {Buffer} Valid BMP image file buffer.
 * @example
 * const bmp = uareu.toBmp(scan.image, scan.width, scan.height, scan.dpi);
 * fs.writeFileSync("fingerprint.bmp", bmp);
 */
function toBmp(rawImage, width, height, dpi = 700) {
  if (!Buffer.isBuffer(rawImage)) {
    throw new TypeError("toBmp: rawImage must be a Buffer");
  }
  if (!Number.isInteger(width) || width <= 0) {
    throw new TypeError("toBmp: width must be a positive integer");
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new TypeError("toBmp: height must be a positive integer");
  }

  const rowStride = (width + 3) & ~3;
  const imageSize = rowStride * height;
  const headerSize = 14 + 40 + 1024; // File header + DIB header + 256-color palette
  const fileSize = headerSize + imageSize;

  const buf = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER (14 bytes)
  buf.write("BM", 0, 2, "ascii");
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(0, 8);
  buf.writeUInt32LE(headerSize, 10);

  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // Positive height = bottom-up DIB
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(8, 28);
  buf.writeUInt32LE(0, 30); // BI_RGB (uncompressed)
  buf.writeUInt32LE(imageSize, 34);
  const ppm = Math.round((dpi || 700) * 39.3701);
  buf.writeInt32LE(ppm, 38);
  buf.writeInt32LE(ppm, 42);
  buf.writeUInt32LE(256, 46);
  buf.writeUInt32LE(0, 50);

  // 256-color grayscale palette (1024 bytes)
  let p = 54;
  for (let i = 0; i < 256; i++) {
    buf[p++] = i;
    buf[p++] = i;
    buf[p++] = i;
    buf[p++] = 0;
  }

  // Pixel data: bottom-to-top row order
  let dest = headerSize;
  const padding = rowStride - width;
  for (let y = height - 1; y >= 0; y--) {
    const src = y * width;
    rawImage.copy(buf, dest, src, src + width);
    dest += width;
    if (padding > 0) {
      buf.fill(0, dest, dest + padding);
      dest += padding;
    }
  }

  return buf;
}

/**
 * Converts a raw 8-bit grayscale pixel buffer into a Base64 Data URL
 * (`data:image/bmp;base64,...`) suitable for `<img src="...">` in Electron
 * or browser renderers.
 *
 * @param {Buffer} rawImage
 * @param {number} width
 * @param {number} height
 * @param {number} [dpi=700]
 * @returns {string} Base64 Data URL string.
 * @example
 * const dataUrl = uareu.toBmpDataUrl(scan.image, scan.width, scan.height);
 * // In Electron renderer:
 * // document.getElementById("fp-img").src = dataUrl;
 */
function toBmpDataUrl(rawImage, width, height, dpi = 700) {
  const bmp = toBmp(rawImage, width, height, dpi);
  return `data:image/bmp;base64,${bmp.toString("base64")}`;
}

// ---------------------------------------------------------------------------
// High-level: scanOnce
// ---------------------------------------------------------------------------

/**
 * One-shot fingerprint scan: find a reader, wait for a finger (retrying
 * automatically on bad quality until the total `timeout` budget runs out),
 * optionally extract the FMD template, then close the reader.
 *
 * Fully non-blocking — designed for the Electron main process behind
 * `ipcMain.handle`.
 *
 * @param {ScanOnceOptions} [opts]
 * @returns {Promise<ScanOnceResult>} Resolves on success AND on ordinary
 *          failures (inspect `success` / `reason`). Rejects only on
 *          unexpected SDK errors.
 * @example <caption>Electron main process</caption>
 * const uareu = require("uareu-napi");
 *
 * ipcMain.handle("fp:scan", () =>
 *   uareu.scanOnce({
 *     timeout: 15000,
 *     onQuality: (code, msg) => win.webContents.send("fp:hint", msg),
 *   })
 * );
 *
 * @example <caption>Renderer side</caption>
 * const r = await ipcRenderer.invoke("fp:scan");
 * if (r.success) showDialog("Jari terdeteksi");
 * else showDialog(r.reason === "timeout" ? "Waktu habis" : r.qualityText);
 */
async function scanOnce(opts = {}) {
  const timeout = opts.timeout === undefined ? 15000 : opts.timeout;
  const attemptTimeout = opts.attemptTimeout === undefined ? 5000 : opts.attemptTimeout;

  init();
  try {
    const devs = native.listDevices();
    const dev = opts.deviceName
      ? devs.find((d) => d.name === opts.deviceName)
      : devs[0];
    if (!dev) return { success: false, reason: "no-device", attempts: 0 };

    const h = open(dev.name, opts.exclusive !== false);
    try {
      const deadline = Date.now() + timeout;
      let attempts = 0;
      let lastQuality = null;

      while (Date.now() < deadline) {
        const per = Math.max(500, Math.min(attemptTimeout, deadline - Date.now()));
        const cap = await native.captureAsync(h, {
          fmt: opts.fmt,
          proc: opts.proc,
          dpi: opts.dpi,
          timeout: per,
        });
        attempts += 1;

        if (cap.quality === C.QUALITY.CANCELED) continue;

        if (cap.success) {
          const result = {
            success: true,
            reason: null,
            device: dev.name,
            attempts,
            width: cap.width,
            height: cap.height,
            dpi: cap.dpi,
            bpp: cap.bpp,
            score: cap.score,
            image: cap.image,
          };
          if (opts.extract) {
            result.fmd = native.createFmdFromRaw(cap.image, {
              width: cap.width,
              height: cap.height,
              dpi: cap.dpi,
              fmdType: opts.fmdType === undefined ? C.FMD_FORMAT.ISO_19794_2_2005 : opts.fmdType,
            });
          }
          if (opts.bmp) {
            result.bmp = toBmp(cap.image, cap.width, cap.height, cap.dpi);
            result.bmpDataUrl = toBmpDataUrl(cap.image, cap.width, cap.height, cap.dpi);
          }
          return result;
        }

        lastQuality = cap.quality;
        if (typeof opts.onQuality === "function") {
          opts.onQuality(cap.quality, qualityText(cap.quality));
        }
      }

      const reason =
        lastQuality !== null && (lastQuality & C.QUALITY.TIMED_OUT) === 0
          ? "bad-quality"
          : "timeout";
      return {
        success: false,
        reason,
        device: dev.name,
        attempts,
        quality: lastQuality,
        qualityText: lastQuality === null ? null : qualityText(lastQuality),
      };
    } finally {
      close(h);
    }
  } finally {
    exit();
  }
}

// ---------------------------------------------------------------------------
// High-level: Scanner (event-driven)
// ---------------------------------------------------------------------------

/**
 * Long-lived, event-driven fingerprint scanner. Keeps the reader open and
 * loops captures in the background, emitting events — the fingerprint
 * equivalent of `nfc-pcsc`'s `NFC`/`Reader` objects.
 *
 * @fires Scanner#open    `{ device: DeviceInfo }` reader opened, ready.
 * @fires Scanner#scan    Payload: `{ device, width, height, dpi, bpp, score,
 *                        image: Buffer, fmd: Buffer|null, quality: 0 }` —
 *                        a finger was successfully read.
 * @fires Scanner#quality `(qualityCode: number, message: string)` — an
 *                        attempt was rejected (finger too high, not a
 *                        finger, ...). The loop keeps running.
 * @fires Scanner#error   `(Error)` — unrecoverable SDK error; the loop
 *                        stopped.
 * @fires Scanner#close   The reader was closed via {@link Scanner#close}.
 *
 * @example
 * const scanner = uareu.openScanner();
 * scanner.on("scan", (s) => win.webContents.send("fp:scan", { ok: true }));
 * scanner.on("quality", (code, msg) => win.webContents.send("fp:hint", msg));
 * await scanner.open();
 * scanner.start();
 * // later:
 * await scanner.close();
 */
class Scanner extends EventEmitter {
  /**
   * @param {ScannerOptions} [options]
   */
  constructor(options = {}) {
    super();
    this._opts = options;
    this._device = null;
    this._handle = null;
    this._running = false;
    this._loop = null;
  }

  /** The reader this scanner is attached to, or `null`. @returns {DeviceInfo|null} */
  get device() {
    return this._device;
  }

  /** Whether the reader handle is open. @returns {boolean} */
  get isOpen() {
    return this._handle !== null;
  }

  /** Whether the capture loop is running. @returns {boolean} */
  get isScanning() {
    return this._running;
  }

  /**
   * Open the reader (first one, or `options.deviceName`). Emits `open`.
   * @returns {Promise<DeviceInfo>} The device that was opened.
   * @throws {Error} No matching reader connected, or device busy.
   */
  async open() {
    if (this._handle !== null) return this._device;
    const devs = listDevices();
    const dev = this._opts.deviceName
      ? devs.find((d) => d.name === this._opts.deviceName)
      : devs[0];
    if (!dev) {
      const err = new Error("no fingerprint reader connected");
      err.reason = "no-device";
      throw err;
    }
    this._handle = open(dev.name, this._opts.exclusive !== false);
    this._device = dev;
    this.emit("open", { device: dev });
    return dev;
  }

  /**
   * Start the background capture loop. Idempotent. Each successful read
   * emits `scan`; each rejected attempt emits `quality`.
   * @returns {this}
   */
  start() {
    if (this._handle === null) throw new Error("scanner not open — call open() first");
    if (this._running) return this;
    this._running = true;
    this._loop = this._runLoop();
    return this;
  }

  /**
   * Stop the capture loop (cancels the pending capture, if any). The reader
   * stays open; call {@link start} again to resume.
   * @returns {this}
   */
  stop() {
    this._running = false;
    if (this._handle !== null) {
      try {
        native.cancel(this._handle);
      } catch (_) {
        /* handle may already be closing */
      }
    }
    return this;
  }

  /**
   * Stop and close the reader, releasing the SDK reference. Emits `close`.
   * Safe to call multiple times.
   * @returns {Promise<void>}
   */
  async close() {
    this.stop();
    if (this._loop) {
      try {
        await this._loop;
      } catch (_) {
        /* reported via 'error' event */
      }
      this._loop = null;
    }
    if (this._handle !== null) {
      const h = this._handle;
      this._handle = null;
      this._device = null;
      close(h);
      this.emit("close");
    }
  }

  /** @private */
  async _runLoop() {
    const attemptTimeout =
      this._opts.attemptTimeout === undefined ? 5000 : this._opts.attemptTimeout;
    const captureOpts = {
      fmt: this._opts.fmt,
      proc: this._opts.proc,
      dpi: this._opts.dpi,
      timeout: attemptTimeout,
    };

    while (this._running) {
      let cap;
      try {
        cap = await native.captureAsync(this._handle, captureOpts);
      } catch (err) {
        if (this._running) this.emit("error", err);
        this._running = false;
        return;
      }
      if (!this._running) break;
      if (cap.quality === C.QUALITY.CANCELED) continue;

      if (cap.success) {
        const payload = {
          device: this._device ? this._device.name : null,
          width: cap.width,
          height: cap.height,
          dpi: cap.dpi,
          bpp: cap.bpp,
          score: cap.score,
          quality: cap.quality,
          image: cap.image,
          fmd: null,
        };
        if (this._opts.extract) {
          try {
            payload.fmd = native.createFmdFromRaw(cap.image, {
              width: cap.width,
              height: cap.height,
              dpi: cap.dpi,
              fmdType:
                this._opts.fmdType === undefined
                  ? C.FMD_FORMAT.ISO_19794_2_2005
                  : this._opts.fmdType,
            });
          } catch (err) {
            this.emit("error", err);
            continue;
          }
        }
        this.emit("scan", payload);
      } else {
        this.emit("quality", cap.quality, qualityText(cap.quality));
      }
    }
  }
}

/**
 * Create an event-driven {@link Scanner}.
 * @param {ScannerOptions} [options]
 * @returns {Scanner}
 */
function openScanner(options) {
  return new Scanner(options);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  C,
  qualityText,

  // lifecycle
  init,
  exit,
  version,
  selectEngine,
  listDevices,

  // reader
  open,
  close,
  cancel,
  getCapabilities,
  getStatus,

  // capture
  capture,
  captureAsync,

  // extraction & matching
  createFmdFromRaw,
  createFmdFromFid,
  compare,
  identify,

  // enrollment
  startEnrollment,
  addToEnrollment,
  createEnrollmentFmd,
  finishEnrollment,

  // extras
  ledConfig,
  ledCtrl,
  setPad,

  // image conversion
  toBmp,
  toBmpDataUrl,

  // high-level
  scanOnce,
  openScanner,
  Scanner,
};

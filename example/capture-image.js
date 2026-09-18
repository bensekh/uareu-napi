"use strict";
/**
 * Example: Capture fingerprint and convert raw image to BMP image file / Data URL.
 *
 * Workflow:
 *  1. Scans fingerprint using `scanOnce({ bmp: true })`.
 *  2. Saves the converted Windows BMP image buffer to `example/fingerprint.bmp`.
 *  3. Generates a Base64 Data URL ready for `<img src="...">` in Electron/browser.
 *
 * Run:
 *   node example/capture-image.js
 *   # or
 *   npm run example:image
 */

const fs = require("fs");
const path = require("path");
const uareu = require("..");

async function main() {
  uareu.init();
  const devices = uareu.listDevices();
  uareu.exit();

  if (devices.length === 0) {
    console.error("No fingerprint reader detected. Please plug in a U.are.U reader and retry.");
    process.exitCode = 1;
    return;
  }

  const reader = devices[0];
  console.log(`Using reader: ${reader.product} (${reader.name})`);
  console.log("=".repeat(60));
  console.log("FINGERPRINT IMAGE CAPTURE & BMP CONVERSION");
  console.log("=".repeat(60));
  console.log("Touch the sensor to capture an image...\n");

  const scan = await uareu.scanOnce({
    bmp: true, // Automatically converts raw grayscale to BMP Buffer & Data URL
    timeout: 15000,
    attemptTimeout: 5000,
    onQuality: (code, msg) => {
      if (code !== uareu.C.QUALITY.GOOD && code !== uareu.C.QUALITY.TIMED_OUT) {
        console.log(`  -> Hint: ${msg}`);
      }
    },
  });

  if (!scan.success) {
    console.error(`Capture failed: ${scan.reason}${scan.qualityText ? ` (${scan.qualityText})` : ""}`);
    process.exitCode = 1;
    return;
  }

  console.log("--- CAPTURE DETAILS ---");
  console.log(`Dimensions   : ${scan.width} x ${scan.height} pixels`);
  console.log(`Resolution   : ${scan.dpi} DPI (bits per pixel: ${scan.bpp})`);
  console.log(`Raw buffer   : ${scan.image.length} bytes`);
  console.log(`BMP buffer   : ${scan.bmp.length} bytes (standard 8-bit indexed BMP)`);

  // 1. Save BMP to file with timestamp
  const filename = `fingerprint-${Date.now()}.bmp`;
  const outPath = path.join(__dirname, filename);
  fs.writeFileSync(outPath, scan.bmp);
  console.log(`\n[✓] Saved image file: ${outPath}`);
  console.log("    -> You can open this .bmp file directly in Windows Photos / image viewers!");

  // 2. Demonstrate Data URL for Electron / Web UI
  console.log(`\n[✓] Generated Data URL:`);
  console.log(`    ${scan.bmpDataUrl.slice(0, 64)}... (${scan.bmpDataUrl.length} chars total)`);
  console.log(`    -> In Electron renderer: <img src="${scan.bmpDataUrl.slice(0, 32)}..." />`);
  console.log("-----------------------\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});

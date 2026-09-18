"use strict";
/**
 * Example: Event-Driven Continuous Kiosk Scanner.
 *
 * Demonstrates the long-lived `Scanner` (EventEmitter) class.
 * Ideal for attendance clocks, POS stations, or door access kiosks where
 * the fingerprint reader remains open 24/7 in the background.
 *
 * Events:
 *  - 'open'    : Reader initialized and opened.
 *  - 'scan'    : Finger captured successfully (emits raw image + FMD).
 *  - 'quality' : Rejected swipe/touch (too fast, off-center, not a finger).
 *  - 'error'   : Critical hardware/SDK error.
 *  - 'close'   : Clean shutdown.
 *
 * Run:
 *   node example/kiosk-scanner.js
 *   # or
 *   npm run example:kiosk
 *
 * Press Ctrl+C at any time to gracefully stop the scanner.
 */

const uareu = require("..");

async function main() {
  console.log("=".repeat(65));
  console.log("CONTINUOUS KIOSK SCANNER (EVENT-DRIVEN)");
  console.log("=".repeat(65));
  console.log("Initializing long-lived background scanner...\n");

  // Create scanner instance with FMD extraction enabled
  const scanner = uareu.openScanner({
    extract: true, // Extract FMD template on every scan
    fmdType: uareu.C.FMD_FORMAT.ISO_19794_2_2005,
    attemptTimeout: 4000,
  });

  let scanCount = 0;
  let lastScanTime = Date.now();

  // Event: Reader opened
  scanner.on("open", ({ device }) => {
    console.log(`[✓] Reader opened: ${device.product} (${device.name})`);
    console.log("    Scanner is now STANDBY. Touch or swipe your finger anytime.");
    console.log("    (Press Ctrl+C to stop cleanly)\n");
  });

  // Event: Successful scan
  scanner.on("scan", (event) => {
    scanCount++;
    const now = Date.now();
    const intervalSec = ((now - lastScanTime) / 1000).toFixed(1);
    lastScanTime = now;

    console.log(`>>> [SCAN #${scanCount}] Finger detected! (+${intervalSec}s since last scan)`);
    console.log(`    Dimensions : ${event.width}x${event.height} @${event.dpi}dpi`);
    console.log(`    Raw image  : ${event.image.length} bytes`);
    if (event.fmd) {
      console.log(`    FMD format : ISO 19794-2:2005 (${event.fmd.length} bytes)`);
    }
    console.log("    -> Ready for next person...\n");
  });

  // Event: Quality hint (non-fatal)
  scanner.on("quality", (code, msg) => {
    if (code !== uareu.C.QUALITY.GOOD && code !== uareu.C.QUALITY.TIMED_OUT) {
      console.log(`  [!] Hint: ${msg} (code: ${code})`);
    }
  });

  // Event: Fatal error
  scanner.on("error", (err) => {
    console.error(`  [X] Scanner error: ${err.message}`);
  });

  // Event: Scanner closed
  scanner.on("close", () => {
    console.log("\n[✓] Scanner closed cleanly. Hardware released.");
  });

  // Open and start continuous background capture loop
  try {
    await scanner.open();
    scanner.start();
  } catch (err) {
    console.error(`Failed to start scanner: ${err.message}`);
    process.exit(1);
  }

  // Graceful shutdown on SIGINT (Ctrl+C)
  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down scanner...");
    try {
      await scanner.close();
    } catch (_) {}
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});

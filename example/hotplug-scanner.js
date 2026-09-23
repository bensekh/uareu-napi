"use strict";
/**
 * Example: Hot-Plug Resilient Scanner (auto-reconnect).
 *
 * Demonstrates a 24/7 kiosk scanner that SURVIVES the USB reader being
 * unplugged and plugged back in — no restart needed:
 *
 *  - waitForDevice: true  -> start even if the reader is not plugged in yet
 *  - autoReconnect: true  -> unplug while scanning => 'disconnect' event,
 *                            replug => reader reopened + 'reconnect' event
 *  - reconnectTimeout: 0  -> never give up waiting for the reader
 *
 * Events:
 *  - 'open'      : Reader opened on startup.
 *  - 'scan'      : Finger captured successfully.
 *  - 'quality'   : Rejected touch (too fast, off-center, not a finger).
 *  - 'disconnect': Reader unplugged — now waiting for it to come back.
 *  - 'reconnect' : Reader plugged back in, scanning resumed.
 *  - 'error'     : Unrecoverable (only if a reconnectTimeout is set).
 *  - 'close'     : Clean shutdown.
 *
 * Run:
 *   node example/hotplug-scanner.js
 *   # or
 *   npm run example:hotplug
 *
 * Try it: while running, unplug the reader — watch 'disconnect' fire, then
 * plug it back in (or another one) and watch 'reconnect' resume scanning.
 * Press Ctrl+C at any time to stop gracefully.
 */

const uareu = require("..");

async function main() {
  console.log("=".repeat(65));
  console.log("HOT-PLUG RESILIENT SCANNER (AUTO-RECONNECT)");
  console.log("=".repeat(65));
  console.log("Starting scanner (waits for a reader if none is plugged in)...\n");

  const scanner = uareu.openScanner({
    extract: true,
    fmdType: uareu.C.FMD_FORMAT.ISO_19794_2_2005,
    attemptTimeout: 4000,

    // --- hot-plug resilience ---
    waitForDevice: true,    // don't fail at startup if the reader is absent
    openTimeout: 0,         // wait forever for the first connection
    autoReconnect: true,    // survive unplug/replug while scanning
    reconnectInterval: 500, // poll every 500ms for the reader to come back
    reconnectTimeout: 0,    // never give up waiting for it
  });

  let scanCount = 0;

  scanner.on("open", ({ device }) => {
    console.log(`[✓] Reader opened: ${device.product} (serial: ${device.serial})`);
    console.log("    Try unplugging the USB reader while it runs.\n");
  });

  scanner.on("scan", (event) => {
    scanCount++;
    console.log(`>>> [SCAN #${scanCount}] ${event.width}x${event.height}` +
      (event.fmd ? ` fmd=${event.fmd.length}B` : ""));
  });

  scanner.on("quality", (code, msg) => {
    if (code !== uareu.C.QUALITY.GOOD && code !== uareu.C.QUALITY.TIMED_OUT) {
      console.log(`  [!] Hint: ${msg}`);
    }
  });

  scanner.on("disconnect", ({ device, error }) => {
    console.log(`\n[!] READER DISCONNECTED: ${device ? device.product : "?"}`);
    console.log(`    cause: ${error.message}`);
    console.log("    Waiting for it to be plugged back in...\n");
  });

  scanner.on("reconnect", ({ device }) => {
    console.log(`\n[✓] READER RECONNECTED: ${device.product} (serial: ${device.serial})`);
    console.log("    Scanning resumed.\n");
  });

  scanner.on("error", (err) => {
    console.error(`  [X] Scanner error: ${err.message}`);
  });

  scanner.on("close", () => {
    console.log("\n[✓] Scanner closed cleanly. Hardware released.");
  });

  // open() waits (openTimeout: 0) until a reader appears, then scanning starts.
  await scanner.open();
  scanner.start();

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

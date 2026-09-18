"use strict";
/**
 * Example: Hardware LED Indicator & Feedback Control.
 *
 * Demonstrates how to control the physical LED light on U.are.U fingerprint
 * readers (such as the blue platen ring light on the U.are.U 4500).
 *
 * LED Modes:
 *  - `C.LED.MODE_AUTO`   : SDK/firmware controls LED behavior automatically.
 *  - `C.LED.MODE_CLIENT` : Your application controls LED on/off state.
 *
 * Requirements:
 *  - Must open the reader in EXCLUSIVE mode (`exclusive: true`) to control LEDs.
 *
 * Run:
 *   node example/led-feedback.js
 *   # or
 *   npm run example:led
 */

const uareu = require("..");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  uareu.init();
  const devices = uareu.listDevices();

  console.log("=".repeat(65));
  console.log("HARDWARE LED INDICATOR & FEEDBACK DEMO");
  console.log("=".repeat(65));

  if (devices.length === 0) {
    console.error("No fingerprint reader detected. Please plug in a reader and retry.");
    uareu.exit();
    process.exitCode = 1;
    return;
  }

  const dev = devices[0];
  console.log(`Target reader: ${dev.product} (${dev.name})\n`);

  // Opening in exclusive mode is required by U.are.U SDK for LED control
  const handle = uareu.open(dev.name, true);

  try {
    const caps = uareu.getCapabilities(handle);
    console.log(`Indicator type: ${caps.indicatorType} (0 = none, 1 = basic LED, 2 = multi-color)`);

    if (caps.indicatorType === 0) {
      console.log("\n[!] NOTICE: This reader model reports indicatorType = 0 (DPFPDD_LED_TYPE_NONE).");
      console.log("    On the U.are.U® 4500, the blue platen light is an optical capture illumination");
      console.log("    backlight controlled automatically by the optical sensor ASIC during scanning,");
      console.log("    rather than an independently programmable status indicator.");
      console.log("    Programmable status LEDs (accept/reject/multi-color) are hardware features");
      console.log("    supported on models such as U.are.U 5160, 5200, 5300, and TouchChip modules.\n");
      console.log("    The low-level SDK functions (ledConfig / ledCtrl) succeed without error,");
      console.log("    but physical blinking is only visible on readers where indicatorType >= 1.\n");
      return;
    }

    console.log("-----------------------------------------------------------------");
    console.log("STEP 1: Enabling Client-Controlled LED Mode");
    console.log("-----------------------------------------------------------------");
    uareu.ledConfig(handle, uareu.C.LED.ALL, uareu.C.LED.MODE_CLIENT);
    console.log("  -> Switched from hardware auto-mode to application client-mode.\n");
    await sleep(800);

    console.log("-----------------------------------------------------------------");
    console.log("STEP 2: Steady ON & Steady OFF");
    console.log("-----------------------------------------------------------------");
    console.log("  -> Turning LED ON for 1.5 seconds...");
    uareu.ledCtrl(handle, uareu.C.LED.MAIN, uareu.C.LED.CMD_ON);
    await sleep(1500);

    console.log("  -> Turning LED OFF for 1.0 second...");
    uareu.ledCtrl(handle, uareu.C.LED.MAIN, uareu.C.LED.CMD_OFF);
    await sleep(1000);
    console.log();

    console.log("-----------------------------------------------------------------");
    console.log("STEP 3: Simulating 'Verification Success' Pattern (2 Long Pulses)");
    console.log("-----------------------------------------------------------------");
    for (let i = 1; i <= 2; i++) {
      console.log(`  -> Pulse #${i}: ON`);
      uareu.ledCtrl(handle, uareu.C.LED.MAIN, uareu.C.LED.CMD_ON);
      await sleep(400);
      console.log(`  -> Pulse #${i}: OFF`);
      uareu.ledCtrl(handle, uareu.C.LED.MAIN, uareu.C.LED.CMD_OFF);
      await sleep(250);
    }
    console.log();

    console.log("-----------------------------------------------------------------");
    console.log("STEP 4: Simulating 'Verification Rejected' Pattern (5 Rapid Blinks)");
    console.log("-----------------------------------------------------------------");
    for (let i = 1; i <= 5; i++) {
      uareu.ledCtrl(handle, uareu.C.LED.MAIN, uareu.C.LED.CMD_ON);
      await sleep(100);
      uareu.ledCtrl(handle, uareu.C.LED.MAIN, uareu.C.LED.CMD_OFF);
      await sleep(100);
    }
    console.log("  -> Flashed 5 rapid blinks.\n");
    await sleep(500);

    console.log("-----------------------------------------------------------------");
    console.log("STEP 5: Restoring Hardware Default Mode (Auto)");
    console.log("-----------------------------------------------------------------");
    uareu.ledConfig(handle, uareu.C.LED.ALL, uareu.C.LED.MODE_AUTO);
    console.log("  -> Restored to automatic hardware mode.\n");
  } finally {
    uareu.close(handle);
    uareu.exit();
  }

  console.log("=".repeat(65));
  console.log("LED feedback demonstration completed.");
  console.log("=".repeat(65));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});

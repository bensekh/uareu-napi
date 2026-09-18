"use strict";
/**
 * Example: Selecting Fingerprint Reader (Multi-Device Support).
 *
 * Demonstrates how to target a specific fingerprint reader when multiple
 * scanners are connected to the host system.
 *
 * Supported Selection Methods:
 *  1. `deviceIndex`  : Select by 0-based integer index (e.g., `deviceIndex: 0` or `1`).
 *  2. `deviceSerial` : Select by serial number or substring (e.g., `deviceSerial: "ED086B38"`).
 *  3. `deviceName`   : Select by exact hardware device path.
 *  4. `selectDevice` : Custom callback function to dynamically pick a device from an array.
 *  5. `uareu.selectDevice()` : Interactive CLI prompt when multiple readers are detected.
 *
 * Run:
 *   node example/select-device.js
 *   # or
 *   npm run example:select
 */

const uareu = require("..");

async function main() {
  uareu.init();
  const devices = uareu.listDevices();
  uareu.exit();

  console.log("=".repeat(65));
  console.log("MULTI-DEVICE SELECTION DEMO");
  console.log("=".repeat(65));
  console.log(`Connected fingerprint readers: ${devices.length}\n`);

  if (devices.length === 0) {
    console.error("No fingerprint reader detected. Please plug in a reader and retry.");
    process.exitCode = 1;
    return;
  }

  // Display enumerated readers
  console.log("Detected Readers Table:");
  for (let i = 0; i < devices.length; i++) {
    console.log(`  [Index ${i}]`);
    console.log(`    Product : ${devices[i].product}`);
    console.log(`    Vendor  : ${devices[i].vendor}`);
    console.log(`    Serial  : ${devices[i].serial}`);
    console.log(`    Name    : ${devices[i].name}`);
  }
  console.log();

  if (devices.length > 1) {
    // -----------------------------------------------------------------------
    // Scenario A: Multiple readers connected -> Interactive selection
    // -----------------------------------------------------------------------
    console.log("Multiple readers detected! Prompting for selection...");
    const chosen = await uareu.selectDevice();
    console.log(`\nSelected scanner: ${chosen.product} [${chosen.serial}]`);

    console.log("\nInitiating scan on the selected reader (5s timeout)...");
    const scan = await uareu.scanOnce({
      deviceName: chosen.name,
      timeout: 5000,
      onQuality: (_code, msg) => console.log(`  Hint: ${msg}`),
    });

    if (scan.success) {
      console.log(`[✓] Capture successful on ${chosen.product} (${scan.width}x${scan.height})!`);
    } else {
      console.log(`[-] Scan finished: ${scan.reason}${scan.qualityText ? ` (${scan.qualityText})` : ""}`);
    }
  } else {
    // -----------------------------------------------------------------------
    // Scenario B: Single reader connected -> Demonstrate selection patterns
    // -----------------------------------------------------------------------
    const primary = devices[0];
    console.log(`Single reader connected (${primary.product}).`);
    console.log("Demonstrating programmatic device targeting options:\n");

    // Pattern 1: Select by deviceIndex (0)
    console.log("1. Targeting by 'deviceIndex: 0'...");
    const res1 = await uareu.scanOnce({
      deviceIndex: 0,
      timeout: 3000,
      attemptTimeout: 2000,
    });
    console.log(`   -> Resolved device: ${res1.device ? primary.product : "none"} (Status: ${res1.reason || "success"})\n`);

    // Pattern 2: Select by serial number
    const serialSub = primary.serial.slice(0, 8);
    console.log(`2. Targeting by 'deviceSerial: "${serialSub}"'...`);
    const res2 = await uareu.scanOnce({
      deviceSerial: serialSub,
      timeout: 3000,
      attemptTimeout: 2000,
    });
    console.log(`   -> Resolved device: ${res2.device ? primary.product : "none"} (Status: ${res2.reason || "success"})\n`);

    // Pattern 3: Custom selector callback
    console.log("3. Targeting via custom 'selectDevice' callback...");
    const res3 = await uareu.scanOnce({
      selectDevice: (allDevs) => {
        console.log(`   [Callback] Received list of ${allDevs.length} device(s)`);
        // Return chosen device, index, or name
        return allDevs[0];
      },
      timeout: 3000,
      attemptTimeout: 2000,
    });
    console.log(`   -> Resolved device: ${res3.device ? primary.product : "none"} (Status: ${res3.reason || "success"})\n`);

    // Pattern 4: Target a non-existent index (e.g. index 99)
    console.log("4. Targeting non-existent 'deviceIndex: 99'...");
    const res4 = await uareu.scanOnce({
      deviceIndex: 99,
      timeout: 1000,
    });
    console.log(`   -> Result: success=${res4.success}, reason="${res4.reason}" (gracefully handled)\n`);
  }

  console.log("=".repeat(65));
  console.log("Device selection demonstration completed.");
  console.log("=".repeat(65));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});

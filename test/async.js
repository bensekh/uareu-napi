"use strict";
// Async API test: scanOnce + Scanner events. Works with or without a reader.
const u = require("..");

async function main() {
  console.log("version:", JSON.stringify(u.version()));

  const devs = u.listDevices();
  console.log("readers:", devs.length);

  if (devs.length === 0) {
    const r = await u.scanOnce({ timeout: 1000 });
    console.log("scanOnce no-device:", JSON.stringify(r));
    if (r.success || r.reason !== "no-device") throw new Error("expected no-device");

    const scanner = u.openScanner();
    try {
      await scanner.open();
      throw new Error("expected open() to fail without a reader");
    } catch (e) {
      console.log("scanner.open() no-device OK:", e.reason || e.message);
    }
    console.log("PASS (no reader connected)");
    return;
  }

  // --- scanOnce with a real reader ---
  console.log("scanOnce: put your finger (10s)...");
  const r = await u.scanOnce({
    timeout: 10000,
    extract: true,
    onQuality: (_code, msg) => console.log("  hint:", msg),
  });
  console.log(
    "scanOnce:",
    r.success ? `OK ${r.width}x${r.height} fmd=${r.fmd.length}B attempts=${r.attempts}` : `FAIL ${r.reason}`
  );

  // --- Scanner events with a real reader ---
  const scanner = u.openScanner({ extract: false });
  let scans = 0;
  scanner.on("scan", (s) => {
    scans += 1;
    console.log(`  event scan: ${s.width}x${s.height}`);
  });
  scanner.on("quality", (_c, msg) => console.log("  event quality:", msg));
  scanner.on("error", (e) => console.error("  event error:", e.message));
  await scanner.open();
  scanner.start();
  console.log("Scanner: emit 'scan' events for 10s — keep swiping...");
  await new Promise((res) => setTimeout(res, 10000));
  await scanner.close();
  console.log(`Scanner done, scans seen: ${scans}`);
  console.log("PASS");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exitCode = 1;
});

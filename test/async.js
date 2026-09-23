"use strict";
// Async API test: scanOnce + Scanner events. Works with or without a reader.
const u = require("..");

async function main() {
  console.log("version:", JSON.stringify(u.version()));

  const devs = u.listDevices();
  console.log("readers:", devs.length);

  // --- cancellation: early-abort path (works headless, no reader needed) ---
  // An already-aborted signal must return "canceled" immediately without
  // ever touching the device.
  const ac0 = new AbortController();
  ac0.abort();
  const c0 = await u.scanOnce({ timeout: 0, signal: ac0.signal });
  console.log("scanOnce early-abort:", JSON.stringify(c0));
  if (c0.success || c0.reason !== "canceled") throw new Error("expected canceled");

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
      if (e.reason !== "no-device") throw new Error("expected reason no-device");
    }

    // waitForDevice: open() must wait and then reject with reason "timeout"
    const waiting = u.openScanner({ waitForDevice: true, openTimeout: 300 });
    try {
      await waiting.open();
      throw new Error("expected waitForDevice open() to time out");
    } catch (e) {
      console.log("scanner.open() waitForDevice timeout OK:", e.reason || e.message);
      if (e.reason !== "timeout") throw new Error("expected reason timeout");
    }

    // autoReconnect must not bypass the "open() first" requirement
    const ar = u.openScanner({ autoReconnect: true });
    try {
      ar.start();
      throw new Error("expected start() to fail before open()");
    } catch (e) {
      console.log("autoReconnect start() guard OK:", e.message);
    }

    // close() on a never-opened scanner: resolves, no events, no throw
    await ar.close();
    console.log("close() on unopened scanner OK");

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

  // --- cancellation: abort an infinite scan mid-flight, then re-open ---
  console.log("scanOnce cancel test: keep your finger OFF, abort in 3s...");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000); // simulate the UI Cancel button
  const rc = await u.scanOnce({ timeout: 0, signal: ac.signal });
  clearTimeout(t);
  console.log("scanOnce canceled:", JSON.stringify({ success: rc.success, reason: rc.reason, attempts: rc.attempts }));
  // Either the finger arrived before the abort (success) or the abort won
  // (reason === "canceled"); anything else is a bug.
  if (!rc.success && rc.reason !== "canceled") throw new Error("expected canceled");

  // A canceled scan must release the reader immediately: this follow-up open
  // would throw the device-busy error (0x05ba001f) if the handle leaked.
  const reopen = await u.scanOnce({ timeout: 1000 });
  console.log("reopen after cancel:", reopen.success ? "captured" : `reason=${reopen.reason}`);

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

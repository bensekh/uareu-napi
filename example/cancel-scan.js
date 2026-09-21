"use strict";
/**
 * Example: Infinite Scan + Cancel Button (AbortSignal).
 *
 * Demonstrates:
 *  1. `timeout: 0` (or Infinity) -> wait forever until a finger is touched.
 *  2. `signal: AbortSignal`      -> an in-progress scan is canceled instantly
 *     (e.g. the user clicks "Cancel" in the UI). Pressing ENTER below plays
 *     the role of that Cancel button.
 *  3. After canceling, the reader is released immediately, so the next scan
 *     opens fine instead of failing with the device-busy error (0x05ba001f).
 *
 * Run:
 *   node example/cancel-scan.js
 *   # or
 *   npm run example:cancel
 */

const readline = require("readline");
const uareu = require("..");

async function main() {
  uareu.init();
  const devices = uareu.listDevices();
  uareu.exit();

  if (devices.length === 0) {
    console.error("No fingerprint reader detected.");
    // The early-abort path still works without hardware: an already-aborted
    // signal returns "canceled" immediately without touching the device.
    const ac = new AbortController();
    ac.abort();
    const r = await uareu.scanOnce({ timeout: 0, signal: ac.signal });
    console.log("early-abort result:", JSON.stringify(r));
    process.exitCode = 1;
    return;
  }

  console.log(`Reader: ${devices[0].product} [${devices[0].serial}]`);
  console.log("Infinite scan (timeout: 0). Put your finger on the reader,");
  console.log("or press ENTER to simulate the UI Cancel button.\n");

  // AbortController is the standard Web/Node cancel primitive; in a real app
  // you would call ac.abort() from the Cancel button's click handler.
  const ac = new AbortController();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cancelPromise = new Promise((resolve) =>
    rl.question("[press ENTER to cancel] ", resolve)
  );

  // The scan promise resolves on success OR when the signal is aborted.
  const scanPromise = uareu.scanOnce({
    timeout: 0,          // wait forever — safe here because we pass a signal
    signal: ac.signal,   // ac.abort() instantly wakes the pending capture
    extract: true,
    onQuality: (_code, msg) => console.log("  hint:", msg),
  });

  // Whichever finishes first wins: finger captured, or ENTER pressed -> abort.
  await Promise.race([scanPromise, cancelPromise.then(() => ac.abort())]);
  rl.close();

  const r = await scanPromise;
  if (r.success) {
    console.log(
      `\nOK: ${r.width}x${r.height} @${r.dpi}dpi, fmd=${r.fmd.length}B, attempts=${r.attempts}`
    );
  } else {
    console.log(`\nScan ended: reason=${r.reason} attempts=${r.attempts}`);
  }

  // Proof that canceling released the device: a follow-up scan opens fine
  // instead of failing with the device-busy error (0x05ba001f).
  console.log("Follow-up scan (3s) to prove the reader was released...");
  const follow = await uareu.scanOnce({ timeout: 3000 });
  console.log(
    `Follow-up: ${follow.success ? "captured" : `reason=${follow.reason}`} (no device-busy)`
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
});

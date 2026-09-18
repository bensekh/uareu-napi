"use strict";
// Recommended usage example: one-shot scan for an Electron main process.
// See test/async.js for the event-driven Scanner variant.
const u = require("..");

async function main() {
  const result = await u.scanOnce({
    timeout: 15000, // total budget
    attemptTimeout: 5000, // per attempt
    extract: true, // also build the minutiae template (FMD)
    onQuality: (code, msg) => console.log("hint:", msg), // drive UI feedback
  });

  if (result.success) {
    console.log(
      `OK: ${result.width}x${result.height} @${result.dpi}dpi, ` +
        `image=${result.image.length}B, fmd=${result.fmd.length}B, attempts=${result.attempts}`
    );
    // e.g. send it over IPC to the renderer, or store result.fmd (Buffer)
    // in your database for later uareu.compare() / uareu.identify().
  } else {
    console.log(`FAILED: reason=${result.reason} attempts=${result.attempts}` +
      (result.qualityText ? ` last=${result.qualityText}` : ""));
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
});

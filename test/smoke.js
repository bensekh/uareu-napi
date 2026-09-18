"use strict";
// Smoke test: init, version, enumerate readers. If a reader is present it also
// captures one fingerprint and extracts an FMD.
const u = require("..");

function main() {
  u.init();
  console.log("SDK version:", JSON.stringify(u.version()));

  const devs = u.listDevices();
  console.log(`readers found: ${devs.length}`);
  for (const d of devs) {
    console.log(`  - ${d.name} [${d.vendor} ${d.product} sn=${d.serial}]`);
  }

  if (devs.length === 0) {
    console.log("no reader connected; skipping capture.");
    u.exit();
    return;
  }

  const h = u.open(devs[0].name, true);
  try {
    console.log("capabilities:", JSON.stringify(u.getCapabilities(h)));

    console.log("put your finger on the reader (timeout 8s)...");
    const cap = u.capture(h, {
      fmt: u.C.IMG_FMT.PIXEL_BUFFER,
      proc: u.C.IMG_PROC.DEFAULT,
      timeout: 8000,
    });
    if (!cap.success) {
      console.log("capture not successful:", u.qualityText(cap.quality));
      return;
    }
    console.log(
      `captured ${cap.width}x${cap.height} @${cap.dpi}dpi bpp=${cap.bpp} bytes=${cap.image.length}`
    );

    const fmd = u.createFmdFromRaw(cap.image, {
      width: cap.width,
      height: cap.height,
      dpi: cap.dpi,
      fmdType: u.C.FMD_FORMAT.ISO_19794_2_2005,
    });
    console.log(`FMD extracted: ${fmd.length} bytes`);
  } finally {
    u.close(h);
    u.exit();
  }
}

try {
  main();
} catch (e) {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
}

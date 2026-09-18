"use strict";
/**
 * Example: Fingerprint Enrollment followed by 1:1 Verification with 3 Retry Attempts.
 *
 * Workflow:
 *  1. Start enrollment session (`startEnrollment`).
 *  2. Prompt the user to place the same finger multiple times (typically 4 samples)
 *     until the SDK signals that enough features have been collected (`addToEnrollment`).
 *  3. Generate the final registration template (`createEnrollmentFmd`).
 *  4. Finish the enrollment session (`finishEnrollment`).
 *  5. Prompt the user to scan their finger for verification (`scanOnce` with DP_VER).
 *     Gives up to 3 attempts before concluding with a final match/reject result.
 *  6. Compare each verification sample against the enrolled template (`compare`).
 *
 * Run:
 *   node example/enroll-and-verify.js
 *   # or
 *   npm run example:enroll
 */

const uareu = require("..");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // 1. Check if any reader is available
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
  console.log("PHASE 1: ENROLLMENT (Recording Fingerprint)");
  console.log("=".repeat(60));
  console.log("You will need to place the same finger on the reader multiple times");
  console.log("(typically 4 times) until the template is complete.\n");

  // 2. Start enrollment session (DP_REG format for storage template)
  uareu.startEnrollment(uareu.C.FMD_FORMAT.DP_REG);

  let enrolledTemplate = null;
  try {
    let sampleNum = 1;
    let isReady = false;

    while (!isReady) {
      console.log(`[Sample #${sampleNum}] Place your finger on the sensor...`);

      const scan = await uareu.scanOnce({
        extract: true,
        fmdType: uareu.C.FMD_FORMAT.DP_PRE_REG, // Pre-registration feature set
        timeout: 15000,
        attemptTimeout: 5000,
        onQuality: (code, msg) => {
          if (code !== uareu.C.QUALITY.GOOD && code !== uareu.C.QUALITY.TIMED_OUT) {
            console.log(`  -> Hint: ${msg}`);
          }
        },
      });

      if (!scan.success) {
        console.log(`  -> Scan failed: ${scan.reason}${scan.qualityText ? ` (${scan.qualityText})` : ""}. Retrying...`);
        await sleep(500);
        continue;
      }

      console.log(`  -> Sample #${sampleNum} captured (${scan.width}x${scan.height} @${scan.dpi}dpi, fmd: ${scan.fmd.length} bytes).`);

      // Feed sample into enrollment engine
      try {
        isReady = uareu.addToEnrollment(scan.fmd, uareu.C.FMD_FORMAT.DP_PRE_REG);
      } catch (err) {
        console.error(`\n  -> Enrollment engine error: ${err.message}`);
        console.error("  -> The samples were too inconsistent or enrollment failed. Please re-run and use the same finger consistently.");
        return;
      }

      sampleNum++;

      if (!isReady) {
        console.log("  -> More samples required. Please lift your finger and place it again.\n");
        await sleep(1000); // Give user time to lift finger
      }
    }

    // 3. Create final enrolled template
    enrolledTemplate = uareu.createEnrollmentFmd();
    console.log("\nEnrollment successful!");
    console.log(`Enrolled Template Size: ${enrolledTemplate.length} bytes (DP_REG format)`);
    console.log("(In production, store this Buffer in your database)\n");
  } finally {
    // 4. Always close enrollment session to release SDK memory
    uareu.finishEnrollment();
  }

  if (!enrolledTemplate) {
    return;
  }

  // 5. Verification Phase (1:1 Match with up to 3 attempts)
  console.log("=".repeat(60));
  console.log("PHASE 2: VERIFICATION (Matching Fingerprint)");
  console.log("=".repeat(60));
  console.log("You have up to 3 attempts to verify your fingerprint.\n");
  await sleep(1200);

  const MAX_VERIFY_ATTEMPTS = 3;
  const MATCH_THRESHOLD = 1 / 100000; // Common industry threshold: FMR < 0.00001
  let verified = false;
  let lastComparison = null;

  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
    console.log(`[Verification Attempt #${attempt}/${MAX_VERIFY_ATTEMPTS}] Place finger on the sensor...`);

    const verifyScan = await uareu.scanOnce({
      extract: true,
      fmdType: uareu.C.FMD_FORMAT.DP_VER, // Verification feature set
      timeout: 15000,
      attemptTimeout: 5000,
      onQuality: (code, msg) => {
        if (code !== uareu.C.QUALITY.GOOD && code !== uareu.C.QUALITY.TIMED_OUT) {
          console.log(`  -> Hint: ${msg}`);
        }
      },
    });

    if (!verifyScan.success) {
      console.log(`  -> Scan failed: ${verifyScan.reason}${verifyScan.qualityText ? ` (${verifyScan.qualityText})` : ""}`);
      if (attempt < MAX_VERIFY_ATTEMPTS) {
        console.log(`  -> Retrying... (${MAX_VERIFY_ATTEMPTS - attempt} attempt(s) remaining)\n`);
        await sleep(1000);
      }
      continue;
    }

    console.log(`  -> Verification sample captured (${verifyScan.fmd.length} bytes). Comparing...`);

    // Compare verification FMD with the enrolled template
    const comparison = uareu.compare(
      verifyScan.fmd,
      uareu.C.FMD_FORMAT.DP_VER,
      enrolledTemplate,
      uareu.C.FMD_FORMAT.DP_REG
    );
    lastComparison = comparison;

    const isMatch = comparison.falseMatchRate < MATCH_THRESHOLD;

    if (isMatch) {
      verified = true;
      console.log(`\n--- RESULT (Attempt #${attempt}/${MAX_VERIFY_ATTEMPTS}) ---`);
      console.log(`Status            : VERIFIED (MATCH) [✓]`);
      console.log(`Dissimilarity     : ${comparison.score} (0 = identical)`);
      console.log(`False Match Rate  : ${comparison.falseMatchRate.toExponential(4)} (Threshold: < ${MATCH_THRESHOLD})`);
      console.log("---------------------------------\n");
      break;
    } else {
      console.log(`  -> Attempt #${attempt} did NOT match.`);
      console.log(`     (Dissimilarity: ${comparison.score}, FMR: ${comparison.falseMatchRate.toExponential(4)})`);
      if (attempt < MAX_VERIFY_ATTEMPTS) {
        console.log(`  -> Please reposition your finger and try again (${MAX_VERIFY_ATTEMPTS - attempt} attempt(s) remaining).\n`);
        await sleep(1200);
      }
    }
  }

  if (!verified) {
    console.log("\n--- FINAL RESULT ---");
    console.log("Status            : REJECTED (NO MATCH) [✗]");
    if (lastComparison) {
      console.log(`Last Dissimilarity: ${lastComparison.score} (0 = identical)`);
      console.log(`Last FMR          : ${lastComparison.falseMatchRate.toExponential(4)} (Threshold: < ${MATCH_THRESHOLD})`);
    }
    console.log(`Exhausted all ${MAX_VERIFY_ATTEMPTS} verification attempts.`);
    console.log("--------------------\n");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});

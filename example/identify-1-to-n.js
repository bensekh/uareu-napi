"use strict";
/**
 * Example: 1:N Biometric Identification.
 *
 * Workflow:
 *  1. Enroll multiple candidate fingerprints into an in-memory database:
 *     - User 1: "Alice" (e.g., Right Index Finger)
 *     - User 2: "Bob"   (e.g., Left Thumb or another finger)
 *  2. Search/Identify Phase (1:N):
 *     - The user touches the reader with ANY finger without identifying themselves first.
 *     - The native `dpfj_identify` engine searches the candidate database in memory (< 2 ms).
 *     - Identifies who the finger belongs to, or reports if it is unrecognized.
 *
 * Run:
 *   node example/identify-1-to-n.js
 *   # or
 *   npm run example:identify
 */

const uareu = require("..");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Format: ISO 19794-2:2005 standard minutiae template
const FMD_FORMAT = uareu.C.FMD_FORMAT.ISO_19794_2_2005;

async function scanFinger(promptMessage) {
  console.log(`\n${promptMessage}`);
  console.log("  -> Touch the sensor now...");

  const scan = await uareu.scanOnce({
    extract: true,
    fmdType: FMD_FORMAT,
    timeout: 15000,
    attemptTimeout: 5000,
    onQuality: (code, msg) => {
      if (code !== uareu.C.QUALITY.GOOD && code !== uareu.C.QUALITY.TIMED_OUT) {
        console.log(`     Hint: ${msg}`);
      }
    },
  });

  if (!scan.success) {
    throw new Error(`Scan failed: ${scan.reason}${scan.qualityText ? ` (${scan.qualityText})` : ""}`);
  }

  console.log(`  -> Captured template (${scan.fmd.length} bytes, ${scan.width}x${scan.height} @${scan.dpi}dpi)`);
  return scan.fmd;
}

async function main() {
  uareu.init();
  const devices = uareu.listDevices();
  uareu.exit();

  if (devices.length === 0) {
    console.error("No fingerprint reader detected. Please connect a U.are.U reader and retry.");
    process.exitCode = 1;
    return;
  }

  const reader = devices[0];
  console.log(`Using reader: ${reader.product} (${reader.name})`);
  console.log("=".repeat(65));
  console.log("1:N BIOMETRIC IDENTIFICATION DEMO");
  console.log("=".repeat(65));
  console.log("In this example, we will enroll two different fingers into an");
  console.log("in-memory database, then search for matching identities in real time.\n");

  // -------------------------------------------------------------------------
  // Step 1: Populate Database with 2 Profiles
  // -------------------------------------------------------------------------
  const database = [];

  console.log("-----------------------------------------------------------------");
  console.log("STEP 1: ENROLL USER 1");
  console.log("-----------------------------------------------------------------");
  const fmd1 = await scanFinger("Please place FINGER #1 on the sensor (e.g. Right Index)");
  database.push({
    id: "EMP-001",
    name: "Alice Johnson",
    finger: "Right Index Finger",
    fmd: fmd1,
  });
  console.log("  -> Registered User 1: 'Alice Johnson' [EMP-001]\n");
  await sleep(1500);

  console.log("-----------------------------------------------------------------");
  console.log("STEP 2: ENROLL USER 2");
  console.log("-----------------------------------------------------------------");
  const fmd2 = await scanFinger("Please place FINGER #2 on the sensor (e.g. Left Thumb or another finger)");
  database.push({
    id: "EMP-002",
    name: "Bob Smith",
    finger: "Left Thumb Finger",
    fmd: fmd2,
  });
  console.log("  -> Registered User 2: 'Bob Smith' [EMP-002]\n");
  await sleep(1500);

  console.log("=================================================================");
  console.log(`DATABASE READY: ${database.length} candidates loaded in memory.`);
  for (let i = 0; i < database.length; i++) {
    console.log(`  [#${i}] ${database[i].id} - ${database[i].name} (${database[i].finger})`);
  }
  console.log("=================================================================\n");

  // -------------------------------------------------------------------------
  // Step 2: 1:N Identification Queries
  // -------------------------------------------------------------------------
  console.log("Now we will test 1:N Identification twice.");
  console.log("You can touch with any finger to see if the system correctly");
  console.log("identifies the user, or rejects an unregistered finger.\n");
  await sleep(1500);

  // Extract candidate FMD array for the identify API
  const candidateFmds = database.map((entry) => entry.fmd);

  for (let queryNum = 1; queryNum <= 2; queryNum++) {
    console.log("-".repeat(65));
    console.log(`IDENTIFICATION TEST #${queryNum}/2`);
    console.log("-".repeat(65));

    let probeFmd;
    try {
      probeFmd = await scanFinger(`Touch sensor with ANY finger for test #${queryNum}...`);
    } catch (err) {
      console.error(`  -> ${err.message}`);
      continue;
    }

    // Measure native identify execution time
    const startTime = process.hrtime.bigint();

    // 1:N Search: dpfj_identify against all candidates in database
    // Default threshold: false match rate < 1/100,000 (0.00001)
    const threshold = uareu.C.PROBABILITY_ONE / 100000;
    const matches = uareu.identify(
      probeFmd,
      FMD_FORMAT,
      candidateFmds,
      FMD_FORMAT,
      threshold
    );

    const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1e6;

    console.log(`\n  Search completed in ${elapsedMs.toFixed(3)} ms across ${candidateFmds.length} candidates.`);

    if (matches.length > 0) {
      const bestMatch = matches[0];
      const identifiedUser = database[bestMatch.index];

      console.log(`  >>> STATUS: IDENTIFIED [✓] <<<`);
      console.log(`  ID         : ${identifiedUser.id}`);
      console.log(`  Name       : ${identifiedUser.name}`);
      console.log(`  Finger     : ${identifiedUser.finger}`);
      console.log(`  Db Index   : Candidate #${bestMatch.index} (View: ${bestMatch.viewIdx})`);
      if (matches.length > 1) {
        console.log(`  Other candidates found: ${matches.length - 1}`);
      }
    } else {
      console.log(`  >>> STATUS: UNRECOGNIZED [✗] <<<`);
      console.log("  No matching profile found in the database.");
    }

    console.log();
    if (queryNum < 2) {
      await sleep(1500);
    }
  }

  console.log("=".repeat(65));
  console.log("1:N Demonstration completed successfully.");
  console.log("=".repeat(65));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});

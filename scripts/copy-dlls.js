// Copies the U.are.U runtime DLLs next to the built .node so it loads without
// touching the system PATH.
const fs = require("fs");
const path = require("path");

const SDK_LIB =
  process.env.UAREU_SDK_LIB ||
  "C:\\Program Files\\DigitalPersona\\U.are.U SDK\\Windows\\Lib\\x64";

const dest = path.join(__dirname, "..", "build", "Release");
if (!fs.existsSync(dest)) {
  console.error("build/Release not found. Run node-gyp rebuild first.");
  process.exit(1);
}

let copied = 0;
for (const f of fs.readdirSync(SDK_LIB)) {
  if (!f.toLowerCase().endsWith(".dll")) continue;
  fs.copyFileSync(path.join(SDK_LIB, f), path.join(dest, f));
  copied++;
}
console.log(`copied ${copied} DLLs from ${SDK_LIB} -> ${dest}`);

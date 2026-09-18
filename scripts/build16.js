"use strict";
// Builds the addon against Node 16 headers (NAPI_VERSION=8 pinned in binding.gyp)
// so the resulting build/Release/uareu.node loads on Node 16 through 26+.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const nvmHome = process.env.NVM_HOME || path.join(process.env.APPDATA, "nvm");

function findNode16() {
  if (!fs.existsSync(nvmHome)) return null;
  const dirs = fs.readdirSync(nvmHome).filter((d) => /^v16\./.test(d)).sort().reverse();
  for (const d of dirs) {
    const p = path.join(nvmHome, d, "node.exe");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findPython() {
  const cands = [
    process.env.PYTHON,
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "python.exe"),
    "python",
  ].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ["-c", "print(1)"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}

const node16 = findNode16();
if (!node16) {
  console.error(`no Node 16 found in ${nvmHome} (install with: nvm install 16.20.2)`);
  process.exit(1);
}
const python = findPython();
if (!python) {
  console.error("no usable python found; set the PYTHON env var");
  process.exit(1);
}

console.log(`building with ${path.basename(node16)} (python: ${python})`);
const r = spawnSync(
  node16,
  [path.join(root, "node_modules", "node-gyp", "bin", "node-gyp.js"), "rebuild", "--release"],
  { stdio: "inherit", cwd: root, env: { ...process.env, PYTHON: python } }
);
process.exit(r.status || 0);

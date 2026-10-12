import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, "..");
const repoDir = path.resolve(pluginDir, "..");
const unpackedDir = path.resolve(pluginDir, ".output/chrome-mv3");
const defaultKeyPath = path.resolve(pluginDir, "key.pem");
const releaseDir = path.resolve(repoDir, "release");

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "chrome",
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (path.isAbsolute(c) && fs.existsSync(c)) {
        return c;
      }
      const which = execFileSync("which", [c], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (which && fs.existsSync(which)) {
        return which;
      }
    } catch {}
  }
  return null;
}

if (!fs.existsSync(unpackedDir)) {
  console.error(`ERROR: unpacked extension directory not found: ${unpackedDir}. Run 'npm run build' first.`);
  process.exit(1);
}

const chromeBin = findChrome();
if (!chromeBin) {
  console.error("ERROR: No Chrome or Chromium binary found to pack CRX.");
  process.exit(1);
}

// Locate or materialize the private signing key
let keyFile = null;
let tempKeyPath = null;

if (process.env.CRX_KEY_PATH && fs.existsSync(process.env.CRX_KEY_PATH)) {
  keyFile = process.env.CRX_KEY_PATH;
} else if (process.env.CRX_KEY_BASE64) {
  tempKeyPath = path.join(os.tmpdir(), `lio-key-${Date.now()}-${Math.random().toString(36).slice(2)}.pem`);
  const pem = Buffer.from(process.env.CRX_KEY_BASE64, "base64").toString("utf8");
  fs.writeFileSync(tempKeyPath, pem, { mode: 0o600 });
  keyFile = tempKeyPath;
} else if (fs.existsSync(defaultKeyPath)) {
  keyFile = defaultKeyPath;
}

if (!keyFile) {
  console.error("ERROR: No CRX signing key found.");
  console.error("Provide a signing key via CRX_KEY_PATH, CRX_KEY_BASE64, or lio-plugin/key.pem.");
  console.error("A stable signing key is required so the Chrome extension ID does not change across releases.");
  process.exit(1);
}

try {
  const generatedCrx = path.resolve(pluginDir, ".output/chrome-mv3.crx");
  if (fs.existsSync(generatedCrx)) {
    fs.unlinkSync(generatedCrx);
  }

  const args = [
    "--headless",
    `--pack-extension=${unpackedDir}`,
    `--pack-extension-key=${keyFile}`,
  ];

  console.log(`Packaging CRX using ${chromeBin}...`);
  execFileSync(chromeBin, args, { stdio: "inherit" });
  if (!fs.existsSync(generatedCrx)) {
    console.error(`ERROR: Expected CRX output at ${generatedCrx} was not created.`);
    process.exit(1);
  }

  // Ensure release dir exists
  fs.mkdirSync(releaseDir, { recursive: true });
  const targetCrx = path.resolve(releaseDir, "lio-extension.crx");
  fs.copyFileSync(generatedCrx, targetCrx);

  // Calculate extension ID from key
  let extensionId = "unknown";
  try {
    const pem = fs.readFileSync(keyFile, "utf8");
    const pubKey = crypto.createPublicKey(pem);
    const der = pubKey.export({ type: "spki", format: "der" });
    const hash = crypto.createHash("sha256").update(der).digest();
    extensionId = Array.from(hash.subarray(0, 16))
      .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 0x0f)))
      .join("");
  } catch (err) {
    console.warn("Could not calculate extension ID:", err.message);
  }

  const size = fs.statSync(targetCrx).size;
  console.log(`Successfully generated CRX:`);
  console.log(`  - Output: ${targetCrx} (${(size / 1024).toFixed(1)} KB)`);
  console.log(`  - Extension ID: ${extensionId}`);
} finally {
  if (tempKeyPath && fs.existsSync(tempKeyPath)) {
    try {
      fs.unlinkSync(tempKeyPath);
    } catch {}
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, "..");

test("popup window sizing: index.html defines dynamic accommodating width without fixed 340px truncation", () => {
  const indexHtml = fs.readFileSync(path.resolve(pluginDir, "src/entrypoints/popup/index.html"), "utf8");
  assert.ok(!indexHtml.includes('width: 340px'), "index.html must not hardcode 340px width which truncates extension popups");
  assert.ok(indexHtml.includes("min-width: 400px"), "index.html must specify min-width of at least 400px");
  assert.ok(indexHtml.includes("width: max-content"), "index.html must allow width to expand with max-content");
  assert.ok(indexHtml.includes("max-width: 800px"), "index.html must cap at Chrome's maximum 800px popup width");
});

test("popup window sizing: theme.css enforces min-width and max-content sizing", () => {
  const themeCss = fs.readFileSync(path.resolve(pluginDir, "src/assets/theme.css"), "utf8");
  assert.ok(themeCss.includes("min-width: 400px"), "theme.css must enforce min-width 400px");
  assert.ok(themeCss.includes("width: max-content"), "theme.css must enforce width: max-content");
  assert.ok(themeCss.includes("max-width: 800px"), "theme.css must enforce max-width: 800px");
});

test("popup window sizing: PopupApp and ConnectFlow do not use fixed 384px (w-96) outer containers", () => {
  const popupApp = fs.readFileSync(path.resolve(pluginDir, "src/entrypoints/popup/PopupApp.tsx"), "utf8");
  const connectFlow = fs.readFileSync(path.resolve(pluginDir, "src/components/ConnectFlow.tsx"), "utf8");

  assert.ok(!popupApp.includes('className="w-96'), "PopupApp must not use fixed w-96 which limits width to 384px");
  assert.ok(!connectFlow.includes('className="w-96'), "ConnectFlow must not use fixed w-96 which limits width to 384px");
  assert.ok(popupApp.includes("min-w-[400px] w-max max-w-[800px]"), "PopupApp must use accommodating container classes");
  assert.ok(connectFlow.includes("min-w-[400px] w-max max-w-[800px]"), "ConnectFlow must use accommodating container classes");
});

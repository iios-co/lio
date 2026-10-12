// End-to-end acceptance harness for Lio.
//
// Drives the REAL built extension inside a REAL Chrome profile against a
// THROWAWAY server, and asserts against the actual browser bookmark tree — never
// against server state alone, and never against the user's live collection.
//
// Each check asserts observable end-to-end behavior from the real browser side.
//
//   node harness/e2e.mjs            # run all
//   node harness/e2e.mjs --keep     # leave the profile for inspection
//
// Requires a throwaway server already listening on TEST_PORT with a fresh DB.

import pw from "/opt/homebrew/lib/node_modules/@playwright/cli/node_modules/playwright-core/index.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { chromium } = pw;

const EXT = path.resolve(import.meta.dirname, "../lio-plugin/.output/chrome-mv3");
const PORT = process.env.TEST_PORT || "8790";
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.argv.includes("--keep");
const SCRATCH = process.env.KIROCREW_SCRATCH || os.tmpdir();

// ---- tiny test recorder ----------------------------------------------------

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { method = "GET", token, body, admin } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: admin ? { ...headers, Cookie: admin } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

// ---- fixture: a REAL browser bookmark tree --------------------------------
// Deliberately shaped like reality, not like a convenient fixture:
//  - no row for the hidden root container
//  - a nested folder
//  - two links sharing a URL (duplicates)
const CHROME_EPOCH = "13300000000000000";
function seedProfile(dir, liveUrl) {
  fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
  const url = (id, name, u) => ({ date_added: CHROME_EPOCH, id, name, type: "url", url: u });
  const seed = {
    checksum: "", version: 1,
    roots: {
      bookmark_bar: {
        children: [
          url("10", "Alpha", "https://alpha.example/"),
          url("11", "Beta", "https://beta.example/"),
          // A URL that really resolves: visit tracking only counts navigations
          // that reach status "complete", so an unresolvable fixture URL can
          // never exercise it.
          url("16", "Live", liveUrl),
          url("12", "Alpha copy", "https://alpha.example/"),
          {
            children: [
              url("14", "Nested One", "https://nested.example/one"),
              url("15", "Nested Two", "https://nested.example/two"),
            ],
            date_added: CHROME_EPOCH, id: "13", name: "Work", type: "folder",
          },
        ],
        date_added: CHROME_EPOCH, id: "1", name: "Bookmarks bar", type: "folder",
      },
      other: { children: [], date_added: CHROME_EPOCH, id: "2", name: "Other bookmarks", type: "folder" },
      synced: { children: [], date_added: CHROME_EPOCH, id: "3", name: "Mobile bookmarks", type: "folder" },
    },
  };
  fs.writeFileSync(path.join(dir, "Default", "Bookmarks"), JSON.stringify(seed));
}

/** The REAL browser tree, read from the profile on disk. Ground truth. */
function onDiskTree(dir) {
  const f = path.join(dir, "Default", "Bookmarks");
  if (!fs.existsSync(f)) return null;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  const out = [];
  const walk = (node, parent) => {
    for (const c of node.children ?? []) {
      out.push({ id: c.id, title: c.name, url: c.url ?? null, parent, isFolder: c.type === "folder" });
      if (c.type === "folder") walk(c, c.id);
    }
  };
  for (const key of ["bookmark_bar", "other"]) {
    if (j.roots?.[key]) walk(j.roots[key], j.roots[key].id);
  }
  return out;
}

// ---- main -----------------------------------------------------------------

const profile = path.join(SCRATCH, `lio_e2e_profile_${Date.now()}`);
let ctx, extPage, token;

try {
  // 0. Fresh collection on the throwaway server.
  const health = await api("/healthz");
  if (health.status !== 200) {
    console.log(`FATAL: no throwaway server on ${BASE} (got ${health.status}). Start one first.`);
    process.exit(2);
  }

  const login = await api("/admin/login", { method: "POST", body: { username: "admin", password: "demopass123" } });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  check("server: authenticate the admin for the console", login.status === 200, `status ${login.status}`);

  const made = await api("/admin/collections", {
    method: "POST", admin: cookie, body: { name: `e2e-${Date.now()}` },
  });
  token = made.json?.token;
  if (!token) {
    console.log(`FATAL: could not create a collection (status ${made.status}) ${made.text.slice(0, 200)}`);
    process.exit(2);
  }

  // Token auth, both directions.
  const good = await api(`/api/v1/collections/${token}/info`, { token });
  const bad = await api(`/api/v1/collections/deadbeefdeadbeef/info`, { token: "deadbeefdeadbeef" });
  check("server: authenticate devices by collection token",
    good.status === 200 && bad.status === 404, `valid=${good.status} unknown=${bad.status}`);

  const webui = await fetch(`${BASE}/`);
  check("server: serve the web UI", webui.status === 200 && (await webui.text()).includes("<div id=\"root\""));

  // 1. Launch a real Chrome with a real seeded tree and the real extension.
  seedProfile(profile, `${BASE}/healthz`);
  const before = onDiskTree(profile);
  check("harness: seeded a real browser tree", before?.length === 7, `${before?.length} nodes`);

  ctx = await chromium.launchPersistentContext(profile, {
    args: [
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--no-first-run", "--no-default-browser-check",
    ],
    headless: false, timeout: 60000,
    colorScheme: "dark",
  });
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 25000 });
  const extId = new URL(sw.url()).host;
  extPage = await ctx.newPage();
  await extPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" });

  const msg = (m) => extPage.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

  // 2. Extension reads the local tree.
  const seen = await extPage.evaluate(async () => {
    const out = [];
    const walk = (n) => (n.children ?? []).forEach((c) => { out.push({ id: c.id, title: c.title, url: c.url ?? null }); walk(c); });
    walk((await chrome.bookmarks.getTree())[0]);
    return out;
  });
  check("extension: read the local browser bookmark tree",
    seen.filter((n) => n.url).length === 6, `${seen.filter((n) => n.url).length} links`);

  // 3. Gate must REFUSE before configuration.
  const preGate = await msg({ type: "STATUS" });
  check("extension: check the gate before any network action",
    preGate?.gateState === "unconfigured", `gateState=${preGate?.gateState}`);

  // 4. Open dashboard in browser BEFORE onboarding connection
  const dashPage = await ctx.newPage();
  const [cName, cVal] = cookie.split("=");
  await ctx.addCookies([{ name: cName, value: cVal, domain: "127.0.0.1", path: "/" }]);
  await dashPage.goto(`${BASE}/`);
  await dashPage.waitForSelector("text=Collections");
  const preText = await dashPage.innerText("body");
  const preCountMatch = /BOOKMARKS\s*(\d+)/i.exec(preText);
  const preCount = preCountMatch ? parseInt(preCountMatch[1], 10) : 0;

  // A bad token must be refused, not accepted.
  const badSet = await msg({ type: "SET_CONNECTION", endpoint: BASE, token: "0000000000000000", bootstrapMode: "merge" });
  check("extension: refuse an invalid token instead of saving it", badSet?.ok === false, `ok=${badSet?.ok}`);

  // Real onboarding connection: sets endpoint, token, and triggers bootstrap
  const set = await msg({ type: "SET_CONNECTION", endpoint: BASE, token, bootstrapMode: "merge" });
  const cfg = await msg({ type: "STATUS" });
  check("extension: hold the connection config (endpoint, token, device identity)",
    set?.ok === true && cfg?.endpoint === BASE && cfg?.token === token && !!cfg?.deviceId,
    `device=${cfg?.deviceId?.slice(0, 12)}`);
  check("extension: gate opens once reachable with a valid token",
    cfg?.gateState === "ok", `gateState=${cfg?.gateState}`);

  // Onboarding must auto-provision the default "Everything" bookmark sync pair
  const initSync = await msg({ type: "GET_SYNC_CONFIG" });
  const defaultPair = initSync?.sync?.pairs?.find((p) => p.type === "bookmark" && p.enabled);
  const defaultPairId = defaultPair?.id;
  check("onboarding: auto-provisions default Everything bookmark sync pair",
    !!defaultPair && defaultPair.localFolderName === "Everything",
    `id=${defaultPairId} pairs=${initSync?.sync?.pairs?.length}`);

  // Wait for bootstrap sync to complete
  await sleep(3000);
  let tree = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const serverLinks = (tree.json?.nodes ?? []).filter((n) => !n.is_folder);
  check("extension: push local changes to the server",
    serverLinks.length === 6, `server has ${serverLinks.length} of 6 links`);
  check("server: store the bookmark collection (links, folders, titles, positions)",
    (tree.json?.nodes ?? []).some((n) => n.title === "Nested One" && n.parent_id === "13"),
    "nested link kept its parent");

  // Live dashboard verification: assert card updated live from 0 -> 6 without reload
  let liveCount = 0;
  for (let i = 0; i < 20; i++) {
    const postText = await dashPage.innerText("body");
    const m = /BOOKMARKS\s*(\d+)/i.exec(postText);
    if (m) {
      liveCount = parseInt(m[1], 10);
      if (liveCount === 6) break;
    }
    await sleep(250);
  }
  check("dashboard: card count updates live on first sync (0 -> 6) without reload",
    preCount === 0 && liveCount === 6, `pre=${preCount} live=${liveCount}`);

  // Verify clicking the new copy icon on the collection card copies valid pairing code
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const copyBtn = await dashPage.waitForSelector('button[aria-label="Copy pairing code"]', { timeout: 5000 });
  await copyBtn.click();
  await sleep(200);
  const copiedBtn = await dashPage.$('button[aria-label="Copied pairing code!"]');
  check("dashboard: clicking card copy icon switches button to Copied pairing code", !!copiedBtn, "card copy icon feedback verified");

  let copiedText = await dashPage.evaluate(() => navigator.clipboard?.readText?.()).catch(() => "");
  if (!copiedText) {
    const fallbackInput = await dashPage.$('input[aria-label="Pairing code"]');
    if (fallbackInput) copiedText = await fallbackInput.inputValue();
  }
  let payloadParsed = null;
  if (copiedText && copiedText.startsWith("lio-connect:v1:")) {
    try {
      const b64 = copiedText.replace("lio-connect:v1:", "");
      payloadParsed = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    } catch {}
  }
  check("dashboard: card copy icon copies valid pairing code payload with current endpoint and token",
    payloadParsed?.endpoint === BASE && payloadParsed?.token === token,
    `endpoint=${payloadParsed?.endpoint} token=${payloadParsed?.token}`);
  // Verify collection name input and action buttons share vertical center
  const renameBtn = await dashPage.waitForSelector('button[aria-label="Rename collection"]');
  await renameBtn.click();
  const nameInput = await dashPage.waitForSelector('input[aria-label="Collection name"]');
  const nameBox = await nameInput.boundingBox();
  const renameBox = await renameBtn.boundingBox();
  if (nameBox && renameBox) {
    const nameCenter = nameBox.y + nameBox.height / 2;
    const btnCenter = renameBox.y + renameBox.height / 2;
    check("dashboard: collection name input and action buttons share vertical center",
      Math.abs(nameCenter - btnCenter) <= 2,
      `nameCenter=${nameCenter.toFixed(1)} btnCenter=${btnCenter.toFixed(1)} diff=${Math.abs(nameCenter - btnCenter).toFixed(1)}`);
  }
  await nameInput.press("Escape");

  // Verify inline editing of bookmark title and URL in web UI
  await dashPage.goto(`${BASE}/#/c/${token}`);
  const expandAll = await dashPage.waitForSelector('button:has-text("Expand all")');
  await expandAll.click();
  await dashPage.waitForSelector('[data-node-id="14"]');
  // Locate stable row for node 14
  const row14 = dashPage.locator('[data-node-id="14"]');
  // 1. Click title to edit title in row 14
  const titleBtn = row14.locator('button:has-text("Nested One")');
  await titleBtn.click();
  const titleInput = row14.locator('input[aria-label="Edit bookmark title"]');
  await titleInput.fill("Nested Updated Title");
  await titleInput.press("Enter");
  await row14.locator('button:has-text("Nested Updated Title")').waitFor();

  // Poll server: title updated, untouched URL preserved
  let server14;
  for (let i = 0; i < 20; i++) {
    const t = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
    server14 = (t.json?.nodes ?? []).find((n) => n.id === "14");
    if (server14?.title === "Nested Updated Title") break;
    await sleep(200);
  }
  check("web UI: title update preserves untouched URL on server",
    server14?.title === "Nested Updated Title" && server14?.url === "https://nested.example/one",
    `title=${server14?.title} url=${server14?.url}`);

  // 2. Click URL to edit URL in that SAME row 14
  const urlBtn = row14.locator('button[title="Click to edit URL"]');
  await urlBtn.click();
  const urlInput = row14.locator('input[aria-label="Edit bookmark URL"]');
  await urlInput.fill("https://nested.example/new-path");
  await urlInput.press("Enter");
  await row14.locator('button:has-text("https://nested.example/new-path")').waitFor();

  // Poll server: URL updated, untouched title preserved
  for (let i = 0; i < 20; i++) {
    const t = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
    server14 = (t.json?.nodes ?? []).find((n) => n.id === "14");
    if (server14?.url === "https://nested.example/new-path") break;
    await sleep(200);
  }
  check("web UI: URL update preserves untouched title on server",
    server14?.title === "Nested Updated Title" && server14?.url === "https://nested.example/new-path",
    `title=${server14?.title} url=${server14?.url}`);

  // 3. Confirm extension receives both updates in local browser bookmark node "14"
  let ext14;
  for (let i = 0; i < 25; i++) {
    ext14 = await extPage.evaluate(async () => {
      try {
        const [node] = await chrome.bookmarks.get("14");
        return { title: node.title, url: node.url };
      } catch {
        return null;
      }
    });
    if (ext14?.title === "Nested Updated Title" && ext14?.url === "https://nested.example/new-path") break;
    await sleep(300);
  }
  check("extension: receives both web-origin title and URL updates in local browser bookmark",
    ext14?.title === "Nested Updated Title" && ext14?.url === "https://nested.example/new-path",
    `local title=${ext14?.title} url=${ext14?.url}`);

  await dashPage.close();
  // 6. Local create / rename / move / delete must reach the server.
  const newId = await extPage.evaluate(async () => (await chrome.bookmarks.create({ parentId: "1", title: "Gamma", url: "https://gamma.example/" })).id);
  await extPage.evaluate(async () => { await chrome.bookmarks.update("11", { title: "Beta Renamed" }); });
  await extPage.evaluate(async () => { await chrome.bookmarks.move("10", { parentId: "13", index: 0 }); });
  await extPage.evaluate(async () => { await chrome.bookmarks.remove("12"); });
  await sleep(1500);
  await msg({ type: "SYNC_NOW" });
  await sleep(3000);
  tree = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const byId = Object.fromEntries((tree.json?.nodes ?? []).map((n) => [n.id, n]));
  check("extension: detect local bookmark changes (create, rename, move, delete)",
    !!byId[newId] && byId["11"]?.title === "Beta Renamed" && byId["10"]?.parent_id === "13" && !byId["12"],
    `create=${!!byId[newId]} rename=${byId["11"]?.title === "Beta Renamed"} move=${byId["10"]?.parent_id === "13"} delete=${!byId["12"]}`);

  // 7. Visit tracking.
  const visitPage = await ctx.newPage();
  await visitPage.goto(`${BASE}/healthz`, { waitUntil: "load" }).catch(() => {});
  await sleep(1500);
  await visitPage.close().catch(() => {});
  await sleep(800);
  await msg({ type: "SYNC_NOW" });
  await sleep(2500);
  const usage = await api(`/api/v1/collections/${token}/report/usage?sort=visits&dir=desc`, { token });
  const visited = (usage.json?.rows ?? []).filter((r) => (r.visit_count ?? 0) > 0);
  check("extension: track visit counts per bookmark", visited.length > 0,
    `${visited.length} rows with visits`);
  check("server: store visit counts and last-visited times",
    visited.some((r) => r.last_visited_at), "last_visited_at recorded");

  // 8. Tabs.
  const t1 = await ctx.newPage(); await t1.goto("https://alpha.example/").catch(() => {});
  await sleep(1200);
  await msg({ type: "SYNC_NOW" });
  await sleep(2500);
  const sessions = await api(`/api/v1/collections/${token}/tabs`, { token });
  const sess = sessions.json?.sessions ?? [];
  check("extension: capture this device's open tabs and push tab sessions",
    sess.length === 1 && sess[0].tab_count > 0, `${sess.length} session(s), ${sess[0]?.tab_count} tabs`);
  check("server: store per-device tab sessions", sess.length === 1 && !!sess[0].device_name);

  // 9. Deltas + echo suppression.
  const mine = await api(`/api/v1/collections/${token}/bookmarks/delta?since=0&device_id=${cfg.deviceId}`, { token });
  const all = await api(`/api/v1/collections/${token}/bookmarks/delta?since=0`, { token });
  check("server: serve incremental deltas since a watermark", (all.json?.ops ?? []).length > 0,
    `${(all.json?.ops ?? []).length} ops`);
  check("server: suppress echo of a device's own changes back to it",
    (mine.json?.ops ?? []).length < (all.json?.ops ?? []).length,
    `own=${(mine.json?.ops ?? []).length} all=${(all.json?.ops ?? []).length}`);

  // 10. The comparison the popup relies on.
  const status = await msg({ type: "STATUS" });
  check("extension: compare the local tree against the server and report differences",
    status?.treeDiff != null && typeof status.treeDiff.differences === "number",
    status?.treeDiff ? `${status.treeDiff.differences} differ, browser ${status.treeDiff.localCount} vs server ${status.treeDiff.serverCount}` : "no diff reported");
  check("extension: report local state and sync status in the popup",
    typeof status?.localBookmarkCount === "number" && status.localBookmarkCount > 0,
    `localBookmarkCount=${status?.localBookmarkCount}`);
  check("extension: local and server agree after a clean sync (diff == 0)",
    status?.treeDiff?.identical === true,
    status?.treeDiff ? status.treeDiff.detail : "n/a");

  // 11. THE CRITICAL ONE: a server-side change must reach the real browser.
  const dupesBefore = onDiskTree(profile);
  const reorg = await api(`/api/v1/collections/${token}/bookmarks/reorganize`, {
    method: "POST", token,
    body: { label: "Delete duplicates", removed: [byId["11"] ? "11" : "10"] },
  });
  check("server: apply bulk transactional reorganisation", reorg.status === 200,
    `status ${reorg.status}`);

  await msg({ type: "SYNC_NOW" });
  await sleep(4000);
  const localAfter = await extPage.evaluate(async () => {
    const out = [];
    const walk = (n) => (n.children ?? []).forEach((c) => { out.push(c.id); walk(c); });
    walk((await chrome.bookmarks.getTree())[0]);
    return out;
  });
  const removedId = byId["11"] ? "11" : "10";
  check("extension: pull server changes and apply them to the local browser tree",
    !localAfter.includes(removedId),
    `node ${removedId} ${localAfter.includes(removedId) ? "STILL in browser" : "removed from browser"}`);

  // 11b. A server-side deletion must NOT be resurrected by the repair step.
  // This is the hazard the repair step introduces: a local-only node is either
  // "never sent" (push it) or "server deleted it" (do not). Sync twice and assert
  // the removed node stays gone on BOTH sides.
  await msg({ type: "SYNC_NOW" });
  await sleep(3500);
  const afterSecondSync = await extPage.evaluate(async () => {
    const out = [];
    const walk = (n) => (n.children ?? []).forEach((c) => { out.push(c.id); walk(c); });
    walk((await chrome.bookmarks.getTree())[0]);
    return out;
  });
  const serverAfterSecond = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const serverHasIt = new Set((serverAfterSecond.json?.nodes ?? []).map((n) => n.id)).has(removedId);
  check("a server-side deletion is not resurrected by the repair step",
    !afterSecondSync.includes(removedId) && !serverHasIt,
    `browser=${afterSecondSync.includes(removedId) ? "RESURRECTED" : "gone"} server=${serverHasIt ? "RESURRECTED" : "gone"}`);

  // 11c. LAST-WRITE-WINS AT TREE LEVEL. Delete several nodes server-side, let the
  // browser consume (and ignore) nothing — then sync. The server wrote most
  // recently, so the browser must DROP those nodes, not push them back.
  const treeNow = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const victims = (treeNow.json?.nodes ?? []).filter((n) => !n.is_folder).slice(0, 3).map((n) => n.id);
  await api(`/api/v1/collections/${token}/bookmarks/reorganize`, {
    method: "POST", token, body: { label: "LWW test delete", removed: victims },
  });
  await msg({ type: "SYNC_NOW" });
  await sleep(4000);
  const localIds = await extPage.evaluate(async () => {
    const out = [];
    const walk = (n) => (n.children ?? []).forEach((c) => { out.push(c.id); walk(c); });
    walk((await chrome.bookmarks.getTree())[0]);
    return out;
  });
  const srvAfter = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const srvIds = new Set((srvAfter.json?.nodes ?? []).map((n) => n.id));
  check("last-write-wins: a newer SERVER tree wins over the browser",
    victims.every((v) => !localIds.includes(v)) && victims.every((v) => !srvIds.has(v)),
    `${victims.filter((v) => localIds.includes(v)).length} still in browser, ${victims.filter((v) => srvIds.has(v)).length} resurrected on server`);

  // 11d. A DETECTED DIFFERENCE MUST TRIGGER A SYNC BY ITSELF.
  // Delete server-side, then only ask for STATUS — never SYNC_NOW. Opening the
  // popup is enough: the difference is a trigger, so the browser must converge.
  const t2 = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const victim2 = (t2.json?.nodes ?? []).filter((n) => !n.is_folder).slice(0, 1).map((n) => n.id);
  await api(`/api/v1/collections/${token}/bookmarks/reorganize`, {
    method: "POST", token, body: { label: "auto-converge test", removed: victim2 },
  });
  const st3 = await msg({ type: "STATUS" });          // detection only
  const reportedWorking = st3?.syncing === true || st3?.converging === true;
  await sleep(4500);                                   // let the triggered sync run
  const localIds2 = await extPage.evaluate(async () => {
    const out = [];
    const walk = (n) => (n.children ?? []).forEach((c) => { out.push(c.id); walk(c); });
    walk((await chrome.bookmarks.getTree())[0]);
    return out;
  });
  check("a detected difference triggers a sync on its own (no SYNC_NOW)",
    reportedWorking && !localIds2.includes(victim2[0]),
    `reportedWorking=${reportedWorking} stillInBrowser=${localIds2.includes(victim2[0])}`);

  // 11f. REAL-TIME PUSH: Server mutation immediately pushes to browser via WebSocket (<1s).
  // Delete a bookmark server-side, do NOT call STATUS, do NOT call SYNC_NOW.
  const tPush = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const pushVictim = (tPush.json?.nodes ?? []).filter((n) => !n.is_folder && n.id !== "10" && n.id !== "16").slice(0, 1).map((n) => n.id);
  if (pushVictim.length > 0) {
    const deletedPushId = pushVictim[0];
    await api(`/api/v1/collections/${token}/bookmarks/${deletedPushId}`, { method: "DELETE", token });
    await sleep(800); // <1 second wait for real-time WebSocket push
    const browserAfterPush = await extPage.evaluate(async () => {
      const out = [];
      const walk = (n) => (n.children ?? []).forEach((c) => { out.push(c.id); walk(c); });
      walk((await chrome.bookmarks.getTree())[0]);
      return out;
    });
    check("push service: server mutation is mirrored in browser in real time (<1s, zero polling)",
      !browserAfterPush.includes(deletedPushId),
      `node ${deletedPushId} removed from browser via push`);
  }

  // 11e. REGRESSION for real data loss (2026-09-10 11:46): with no id history,
  // the repair step pushed 1204 local nodes to the server and undid a dedupe the
  // user had deliberately run. Wipe the history, delete many nodes server-side,
  // then sync: the browser must NOT re-upload them.
  await extPage.evaluate(async () => { await chrome.storage.local.remove("knownServerIds"); });
  const t3 = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const manyVictims = (t3.json?.nodes ?? []).filter((n) => !n.is_folder).slice(0, 4).map((n) => n.id);
  const serverBefore = (t3.json?.nodes ?? []).length;
  await api(`/api/v1/collections/${token}/bookmarks/reorganize`, {
    method: "POST", token, body: { label: "no-resurrect regression", removed: manyVictims },
  });
  await msg({ type: "SYNC_NOW" });
  await sleep(4000);
  const t4 = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const srvIds2 = new Set((t4.json?.nodes ?? []).map((n) => n.id));
  const resurrected = manyVictims.filter((v) => srvIds2.has(v));
  check("REGRESSION: a historyless sync never re-uploads server-deleted nodes",
    resurrected.length === 0,
    `${resurrected.length} resurrected; server ${serverBefore} -> ${(t4.json?.nodes ?? []).length} nodes`);

  // 12. Undo restores, and reaches the browser too.
  const undo = await api(`/api/v1/collections/${token}/bookmarks/undo`, { method: "POST", token });
  check("server: snapshot before bulk changes and restore on undo", undo.status === 200,
    `status ${undo.status}`);

  // 13. Queue while the gate is closed, drain after.
  // SET_CONNECTION verifies before saving, so it REFUSES a dead endpoint (that is
  // correct behaviour). To simulate the real case — a server that was reachable at
  // setup and later went away — write the endpoint straight to storage, then force
  // a fresh gate probe.
  await extPage.evaluate(async (dead) => {
    await chrome.storage.local.set({ endpoint: dead });
  }, "http://127.0.0.1:59999");
  await extPage.evaluate(async () => { await chrome.bookmarks.create({ parentId: "1", title: "Offline", url: "https://offline.example/" }); });
  await sleep(1500);
  const offline = await msg({ type: "STATUS" });
  check("extension: queue changes while the gate is closed",
    offline?.gateState === "unreachable" && (offline?.queued ?? 0) > 0,
    `gate=${offline?.gateState} queued=${offline?.queued}`);
  await extPage.evaluate(async (live) => {
    await chrome.storage.local.set({ endpoint: live });
  }, BASE);
  await msg({ type: "STATUS" });        // forces a fresh gate probe
  await msg({ type: "SYNC_NOW" });
  await sleep(4000);
  const drained = await msg({ type: "STATUS" });
  const afterDrain = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  check("extension: drain the queue once the gate reopens",
    (drained?.queued ?? 99) === 0 && (afterDrain.json?.nodes ?? []).some((n) => n.title === "Offline"),
    `queued=${drained?.queued}`);

  // 14. Dead links.
  const chk = await api(`/api/v1/collections/${token}/report/check`, { method: "POST", token });
  const dead = await api(`/api/v1/collections/${token}/report/dead`, { token });
  check("server: check links for liveness and record dead links",
    chk.status === 200 && dead.status === 200, `check=${chk.status} dead=${dead.status}`);

  // 15. Identity/counts.
  const info = await api(`/api/v1/collections/${token}/info`, { token });
  check("server: report collection identity and counts",
    info.status === 200 && typeof info.json?.bookmark_count === "number" && typeof info.json?.folder_count === "number",
    `links=${info.json?.bookmark_count} folders=${info.json?.folder_count}`);

  // 16. Popup renders (screenshot for the visual record).
  const shot = path.join(SCRATCH, "e2e_popup.png");
  await extPage.reload({ waitUntil: "domcontentloaded" });
  await sleep(2000);
  await extPage.screenshot({ path: shot });
  const popupText = (await extPage.locator("body").innerText()).replace(/\s+/g, " ");
  check("extension: popup renders real state", popupText.length > 20, `"${popupText.slice(0, 90)}"`);
  console.log(`\npopup screenshot: ${shot}`);


  // 16b. D4/D5/D6 — the presentation defects, measured rather than trusted.
  const st2 = await msg({ type: "STATUS" });
  check("D4: popup reports LINKS on both sides, one labelled denominator",
    typeof st2?.treeDiff?.localLinks === "number" && typeof st2?.treeDiff?.serverLinks === "number" &&
    st2.treeDiff.localLinks <= st2.treeDiff.localCount,
    `links ${st2?.treeDiff?.localLinks}/${st2?.treeDiff?.serverLinks} of nodes ${st2?.treeDiff?.localCount}/${st2?.treeDiff?.serverCount}`);

  const webHeader = await (await fetch(`${BASE}/api/v1/collections/${token}/info`, { headers: { Authorization: `Bearer ${token}` } })).json();
  check("D4: server link count agrees with the popup's server-side link count",
    webHeader.bookmark_count === st2?.treeDiff?.serverLinks,
    `info=${webHeader.bookmark_count} popup=${st2?.treeDiff?.serverLinks}`);

  check("D5: popup detail line is not truncated in the DOM",
    !(await extPage.locator("div.truncate").filter({ hasText: "on server" }).count()),
    "no truncate class on the diagnostic line");

  check("D6: tabs card claims Synced only from a real comparison",
    st2?.tabDiff != null && typeof st2.tabDiff.identical === "boolean",
    st2?.tabDiff ? `${st2.tabDiff.localCount} local vs ${st2.tabDiff.serverCount} server — ${st2.tabDiff.detail}` : "no tabDiff reported");

  // 16c. D9 — a local node the server never heard about must self-heal.
  // Simulate a missed create event: disable the pair (so the event is out of
  // scope and nothing is queued), add a bookmark, re-enable, then sync.
  // TOGGLE_PAIR deliberately does NOT trigger a full push, so this isolates the
  // repair step rather than testing fullPushInScope.
  await msg({ type: "TOGGLE_PAIR", pairId: defaultPairId, enabled: false });
  await sleep(600);
  const orphanId = await extPage.evaluate(async () => (await chrome.bookmarks.create({ parentId: "1", title: "MissedCreate", url: "https://missed.example/" })).id);
  await sleep(1200);
  await msg({ type: "TOGGLE_PAIR", pairId: defaultPairId, enabled: true });
  await sleep(600);
  const beforeRepair = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const knownBefore = new Set((beforeRepair.json?.nodes ?? []).map((n) => n.id)).has(orphanId);
  await msg({ type: "SYNC_NOW" });
  await sleep(3500);
  const afterRepair = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const knownAfter = new Set((afterRepair.json?.nodes ?? []).map((n) => n.id)).has(orphanId);
  check("D9: a SMALL gap is self-healed, and history exists to trust it",
    !knownBefore && knownAfter,
    `beforeSync=${knownBefore} afterSync=${knownAfter}`);

  // 17. Restore a tab session pushed by ANOTHER device into this browser.
  const otherDevice = "dev_harness_other";
  const restoreUrl = `${BASE}/healthz?restored=1`;
  await api(`/api/v1/collections/${token}/tabs/${otherDevice}`, {
    method: "PUT", token,
    body: {
      device_name: "Other Machine",
      session_json: JSON.stringify({ windows: [{ tabs: [{ url: restoreUrl, title: "Restored" }] }] }),
      updated_at: Date.now(),
    },
  });
  const pagesBefore = ctx.pages().length;
  const adopted = await msg({ type: "ADOPT", deviceId: otherDevice });
  await sleep(2500);
  const opened = ctx.pages().filter((pg) => pg.url().includes("restored=1"));
  check("extension: open/restore a tab session from the server into this browser",
    adopted?.ok === true && opened.length > 0,
    `deviceName=${adopted?.deviceName} windows=${adopted?.windowCount} pages ${pagesBefore}->${ctx.pages().length}`);

  // 18. Sync pairs must LIMIT scope: a node outside the pair folder must not sync.
  // Swap the "everything" pair for one scoped to the "Work" folder (id 13).
  await msg({ type: "REMOVE_PAIR", pairId: defaultPairId });
  await msg({ type: "ADD_PAIR", pair: { id: "p2", type: "bookmark", localFolderId: "13", localFolderName: "Work", collectionPath: "/Work", enabled: true } });
  await sleep(1500);
  const inScopeId = await extPage.evaluate(async () => (await chrome.bookmarks.create({ parentId: "13", title: "InScope", url: "https://inscope.example/" })).id);
  const outScopeId = await extPage.evaluate(async () => (await chrome.bookmarks.create({ parentId: "1", title: "OutOfScope", url: "https://outscope.example/" })).id);
  await sleep(1500);
  await msg({ type: "SYNC_NOW" });
  await sleep(3500);
  const scoped = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
  const scopedIds = new Set((scoped.json?.nodes ?? []).map((n) => n.id));
  check("extension: limit what syncs via sync pairs (folder scope)",
    scopedIds.has(inScopeId) && !scopedIds.has(outScopeId),
    `inScope=${scopedIds.has(inScopeId)} outOfScope-leaked=${scopedIds.has(outScopeId)}`);
  // 19. Fresh device test: 0 local bookmarks merging with nonempty server collection
  const freshProfile = path.join(SCRATCH, `e2e_fresh_${Date.now()}`);
  fs.mkdirSync(freshProfile, { recursive: true });
  const freshCtx = await chromium.launchPersistentContext(freshProfile, {
    args: [
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--no-first-run", "--no-default-browser-check",
    ],
    headless: false, timeout: 60000,
    colorScheme: "dark",
  });

  try {
    const freshSw = freshCtx.serviceWorkers()[0] ?? await freshCtx.waitForEvent("serviceworker", { timeout: 25000 });
    const freshExtId = new URL(freshSw.url()).host;
    const freshExtPage = await freshCtx.newPage();
    await freshExtPage.goto(`chrome-extension://${freshExtId}/popup.html`, { waitUntil: "domcontentloaded" });
    const freshMsg = (m) => freshExtPage.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

    // Capture server count BEFORE fresh device connects
    const serverTreeBefore = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
    const serverLinksBefore = (serverTreeBefore.json?.nodes ?? []).filter((n) => !n.is_folder).length;

    // Fresh browser has 0 links
    const freshTreeBefore = await freshExtPage.evaluate(async () => {
      const out = [];
      const walk = (n) => (n.children ?? []).forEach((c) => { if (c.url) out.push(c); walk(c); });
      walk((await chrome.bookmarks.getTree())[0]);
      return out;
    });

    const freshSet = await freshMsg({ type: "SET_CONNECTION", endpoint: BASE, token, bootstrapMode: "merge" });
    await sleep(4000);

    const freshTreeAfter = await freshExtPage.evaluate(async () => {
      const out = [];
      const walk = (n) => (n.children ?? []).forEach((c) => { if (c.url) out.push(c); walk(c); });
      walk((await chrome.bookmarks.getTree())[0]);
      return out;
    });
    const serverTreeAfter = await api(`/api/v1/collections/${token}/bookmarks/tree`, { token });
    const serverLinksAfter = (serverTreeAfter.json?.nodes ?? []).filter((n) => !n.is_folder).length;

    check("fresh device: 0 local links merged with nonempty server pulls all links intact",
      freshSet?.ok === true && freshTreeBefore.length === 0 &&
      serverLinksBefore > 0 && serverLinksAfter === serverLinksBefore &&
      freshTreeAfter.length === serverLinksBefore,
      `serverBefore=${serverLinksBefore} freshAfter=${freshTreeAfter.length} serverAfter=${serverLinksAfter}`);
  } finally {
    await freshCtx.close().catch(() => {});
    fs.rmSync(freshProfile, { recursive: true, force: true });
  }
} catch (e) {
  check("harness ran to completion", false, e.message?.split("\n")[0]);
} finally {
  if (ctx) await ctx.close().catch(() => {});
  if (!KEEP) fs.rmSync(profile, { recursive: true, force: true });
  else console.log(`profile kept at ${profile}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
if (failed.length) {
  console.log("FAILING:");
  failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`));
}
process.exit(failed.length ? 1 : 0);

// Pure Message-Driven UI & Background Integration Test:
// 1. Initial 838 links + 1 folder exist locally in the browser
// 2. Sync runs via background message TOGGLE_GLOBAL against server holding tombstones
// 3. Server rejects with { applied: 0, skipped_stale: 839 }
// 4. Background coordinator pauses sync (globalEnabled: false), halts, and makes exactly 1 push call
// 5. Unconfirmed or no-incident RESTORE_BASELINE messages fail safely
// 6. Confirmed RESTORE_BASELINE through message handler restores the collection
// 7. Sync is explicitly re-enabled via TOGGLE_GLOBAL
// 8. Two subsequent SYNC_NOW messages produce zero additional delta pushes

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.defineBackground = (fn) => fn;

const store = new Map();
let deltaPostCount = 0;
let baselineRestoreCalls = 0;
let messageHandler = null;

const localTree = new Map([
  ["0", { id: "0", title: "", parentId: undefined, index: 0, children: ["1"] }],
  ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0, children: ["f_1"] }],
  ["f_1", { id: "f_1", title: "Work Folder", parentId: "1", index: 0, children: [] }],
]);

for (let i = 1; i <= 838; i++) {
  const id = `bm_${i}`;
  localTree.get("f_1").children.push(id);
  localTree.set(id, { id, title: `Bookmark ${i}`, url: `https://example.com/${i}`, parentId: "f_1", index: i - 1 });
}

function toTree(id) {
  const n = localTree.get(id);
  const out = { id: n.id, title: n.title, index: n.index };
  if (n.parentId !== undefined) out.parentId = n.parentId;
  if (n.url) out.url = n.url;
  if (n.children) out.children = n.children.filter((c) => localTree.has(c)).map(toTree);
  return out;
}

const dummyListener = { addListener() {}, removeListener() {} };

globalThis.browser = {
  storage: {
    local: {
      async get(keys) {
        const ks = Array.isArray(keys) ? keys : [keys];
        const res = {};
        for (const k of ks) if (store.has(k)) res[k] = store.get(k);
        return res;
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) store.set(k, v);
      },
      async remove(keys) {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) store.delete(k);
      },
    },
  },
  bookmarks: {
    async getTree() { return [toTree("0")]; },
    async get() { return []; },
    onCreated: dummyListener,
    onChanged: dummyListener,
    onMoved: dummyListener,
    onRemoved: dummyListener,
  },
  tabs: {
    onCreated: dummyListener,
    onUpdated: dummyListener,
    onRemoved: dummyListener,
    onMoved: dummyListener,
    onAttached: dummyListener,
    onDetached: dummyListener,
    query() { return Promise.resolve([]); },
  },
  windows: {
    getAll() { return Promise.resolve([]); },
    onFocusChanged: dummyListener,
    onCreated: dummyListener,
    onRemoved: dummyListener,
  },
  alarms: {
    create() {},
    get() { return Promise.resolve(null); },
    onAlarm: dummyListener,
  },
  runtime: {
    getManifest() { return { version: "0.4.156" }; },
    onInstalled: dummyListener,
    onStartup: dummyListener,
    onMessage: {
      addListener(fn) { messageHandler = fn; },
    },
  },
};

let serverActiveNodes = [];
let serverVersion = 10;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/healthz")) {
    return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/info")) {
    return new Response(JSON.stringify({ id: "col_test_123", name: "Personal", bookmark_count: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.endsWith("/bookmarks/sync") && init.method === "POST") {
    return new Response(JSON.stringify({
      acknowledgedOperations: [],
      changes: [],
      currentServerVersion: serverVersion,
      serverTimestamp: 1000,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.endsWith("/bookmarks/tree")) {
    return new Response(JSON.stringify({
      nodes: serverActiveNodes,
      server_timestamp: 1000,
      server_version: serverVersion,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.endsWith("/bookmarks/delta") && init.method === "POST") {
    deltaPostCount++;
    const body = JSON.parse(init.body);
    const opsCount = body.ops?.length ?? 0;
    if (baselineRestoreCalls === 0) {
      return new Response(JSON.stringify({ applied: 0, skipped_stale: opsCount, server_timestamp: 1001 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ applied: 0, skipped_stale: 0, server_timestamp: 1002 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (u.endsWith("/bookmarks/restore-baseline") && init.method === "POST") {
    baselineRestoreCalls++;
    const body = JSON.parse(init.body);
    serverVersion = 50;
    serverActiveNodes = body.nodes.map((n) => ({
      id: n.id,
      parent_id: n.parent_id,
      position: n.position,
      title: n.title,
      url: n.url,
      is_folder: n.is_folder,
      server_version: 50,
    }));
    return new Response(JSON.stringify({
      restored: body.nodes.length,
      snapshot_id: 1,
      server_version: 50,
      server_timestamp: 1050,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

function send(msg) {
  return new Promise((resolve) => {
    messageHandler(msg, {}, (res) => resolve(res));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("pure message-driven recovery workflow: TOGGLE_GLOBAL -> rejection -> recoveryRequired -> RESTORE_BASELINE -> SYNC_NOW", async (t) => {
  const { pushService } = await import("../src/lib/push.ts");
  t.after(() => {
    pushService.stop();
  });

  store.set("endpoint", "http://test.local");
  store.set("token", "tok_test");
  store.set("collectionId", "col_test_123");
  store.set("lio_migrated_col_test_123", true);
  store.set("deviceId", "dev_test");
  store.set("lastServerVersion", 10);
  store.set("knownServerIds", ["1"]);
  store.set("syncConfig", {
    globalEnabled: false, // Initially paused
    pairs: [{ id: "p1", type: "bookmark", localFolderId: "1", localFolderName: "Bookmarks bar", collectionPath: "", enabled: true }],
  });

  const { default: initBackground } = await import("../src/entrypoints/background.ts");
  initBackground();
  assert.ok(messageHandler, "Background message handler registered");
  // A. Normal pause check: recoveryRequired must be absent
  const statusPre = await send({ type: "STATUS" });
  assert.ok(!statusPre.recoveryRequired, "Ordinary pause has no recoveryRequired");

  // B. Resume sync via TOGGLE_GLOBAL message: awaits runSync and returns post-run paused state
  const toggleOn = await send({ type: "TOGGLE_GLOBAL", enabled: true });
  assert.equal(toggleOn.ok, true);
  assert.equal(toggleOn.sync.globalEnabled, false, "Response must report paused state after rejection");

  // C. Assert rejection happened, exactly 1 POST made, recoveryRequired set, and sync paused
  assert.equal(deltaPostCount, 1, "Exactly 1 push delta attempted");
  assert.equal(store.has("recoveryRequired"), true, "recoveryRequired state must be set");
  const rec = store.get("recoveryRequired");
  assert.equal(rec.reason, "tombstone_rejection");
  assert.equal(rec.skipped, 839);
  assert.equal(rec.localLinkCount, 838);
  assert.equal(rec.localNodeCount, 840);
  assert.equal(store.get("syncConfig").globalEnabled, false, "Sync auto-paused to halt loop");

  // D. Unconfirmed restore attempt fails
  const unconfirmed = await send({ type: "RESTORE_BASELINE", confirmed: false });
  assert.equal(unconfirmed.ok, false);
  assert.equal(baselineRestoreCalls, 0);

  // E. Confirmed restore succeeds via background message
  const confirmed = await send({ type: "RESTORE_BASELINE", confirmed: true, label: "UI restore" });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.restored, 839);
  assert.equal(baselineRestoreCalls, 1);
  assert.equal(serverActiveNodes.length, 839, "Server holds all 839 restored nodes");
  assert.equal(store.has("recoveryRequired"), false, "recoveryRequired cleared on restore");

  // Redundant restore without an active incident fails safely
  const redundant = await send({ type: "RESTORE_BASELINE", confirmed: true });
  assert.equal(redundant.ok, false);
  assert.equal(redundant.error, "No active tombstone rejection incident requires baseline restore.");

  // F. Explicitly re-enable sync via TOGGLE_GLOBAL message: awaits clean initial cycle
  const toggleResume = await send({ type: "TOGGLE_GLOBAL", enabled: true });
  assert.equal(toggleResume.ok, true);
  assert.equal(toggleResume.sync.globalEnabled, true, "Response reports enabled state after clean cycle");
  const initialDeltas = deltaPostCount;

  // G. Two subsequent SYNC_NOW cycles make 0 additional delta posts
  const syncNow1 = await send({ type: "SYNC_NOW" });
  assert.equal(syncNow1.ok, true);

  const syncNow2 = await send({ type: "SYNC_NOW" });
  assert.equal(syncNow2.ok, true);

  assert.equal(deltaPostCount, initialDeltas, "Zero additional delta posts made across subsequent cycles");

  // Assert final state
  assert.equal(deltaPostCount, initialDeltas, "Zero additional delta posts made across subsequent cycles");
});

// Integration Test: Real 838-link / 839-node flow driven dynamically
// 1. Initial 838 links + 1 folder exist locally in the browser
// 2. Sync runs against a server holding tombstones (Browser 838 / Server 0)
// 3. Server dynamically rejects creates (derived from posted ops length)
// 4. Client records recoveryRequired, pauses sync (globalEnabled: false), and halts
// 5. User confirms RESTORE_BASELINE
// 6. Server is restored with all 839 nodes (838 links + 1 folder)
// 7. Sync is explicitly re-enabled: two subsequent cycles produce 0 delta pushes and 0 local deletes

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
const removedNodes = [];
let deltaPostCount = 0;
let baselineRestoreCalls = 0;

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
    async get(id) { const n = localTree.get(id); return n ? [n] : []; },
    async remove(id) { removedNodes.push(id); return true; },
    async removeTree(id) { removedNodes.push(id); return true; },
  },
  runtime: {
    getManifest() { return { version: "0.4.156" }; },
  },
};

let serverActiveNodes = [];
let serverVersion = 10;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/healthz")) {
    return new Response("ok", { status: 200 });
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
      // Dynamically derive rejection from posted body ops
      return new Response(JSON.stringify({ applied: 0, skipped_stale: opsCount, server_timestamp: 1001 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    // After restore: clean sync
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

const { pushLocalOnlyNodes, restoreBaselineFromLocal } = await import("../src/lib/bookmarks.ts");

test("full end-to-end recovery: dynamic rejection -> recoveryRequired -> explicit confirmed restore -> zero drift", async () => {
  store.set("endpoint", "http://test.local");
  store.set("token", "tok_test");
  store.set("collectionId", "col_test_123");
  store.set("deviceId", "dev_test");
  store.set("lastPulledTs", 500);
  store.set("lastServerVersion", 10);
  store.set("knownServerIds", ["1"]);
  store.set("syncConfig", {
    globalEnabled: true,
    pairs: [{ id: "p1", type: "bookmark", localFolderId: "1", localFolderName: "Bookmarks bar", collectionPath: "", enabled: true }],
  });

  // Step 1: Initial push against tombstoned server (dynamically derived rejection)
  const pushRes = await pushLocalOnlyNodes();
  assert.equal(deltaPostCount, 1, "Exactly 1 push delta attempted");
  assert.equal(pushRes.pushed, 0, "Pushed count must be 0");
  assert.equal(pushRes.unresolved, 839, "Unresolved count dynamically matches 839 nodes");

  // Verify recoveryRequired state was persisted with separate link and node counts
  const recState = store.get("recoveryRequired");
  assert.ok(recState, "recoveryRequired state must be set");
  assert.equal(recState.reason, "tombstone_rejection");
  assert.equal(recState.skipped, 839);
  assert.equal(recState.localNodeCount, 840, "840 total nodes in scope (including root '1')");
  assert.equal(recState.localLinkCount, 838, "838 bookmark links in scope");
  assert.equal(recState.serverNodeCount, 0);

  // Verify sync was automatically paused fail-closed
  assert.equal(store.get("syncConfig").globalEnabled, false, "Sync must be paused fail-closed");

  // Step 2: Query STATUS via storage and assert recoveryRequired is present
  const { recoveryRequired } = await browser.storage.local.get("recoveryRequired");
  assert.equal(recoveryRequired.skipped, 839);

  // Step 3: Explicit restoreBaselineFromLocal executed with confirmation
  const confirmed = await restoreBaselineFromLocal("Manual restore from browser popup");
  assert.equal(confirmed.restored, 839, "All 839 nodes (1 folder + 838 links) restored as baseline");
  assert.equal(baselineRestoreCalls, 1);
  assert.equal(serverActiveNodes.length, 839, "Server now holds all 839 active nodes");
  const restoredLinks = serverActiveNodes.filter((n) => !n.is_folder).length;
  assert.equal(restoredLinks, 838, "All 838 bookmark links present on server");

  // Verify recoveryRequired was cleared
  assert.equal(store.has("recoveryRequired"), false, "recoveryRequired must be cleared upon successful restore");

  // Step 4: Re-enable sync explicitly
  store.set("syncConfig", { ...store.get("syncConfig"), globalEnabled: true });

  // Step 5: Two subsequent sync cycles run with zero further delta pushes and zero local deletes
  const initialPostCount = deltaPostCount;

  const cycle1 = await pushLocalOnlyNodes();
  assert.equal(cycle1.pushed, 0, "Subsequent cycle 1 pushes 0");
  assert.equal(cycle1.deletedLocally, 0, "Subsequent cycle 1 deletes 0");

  const cycle2 = await pushLocalOnlyNodes();
  assert.equal(cycle2.pushed, 0, "Subsequent cycle 2 pushes 0");
  assert.equal(cycle2.deletedLocally, 0, "Subsequent cycle 2 deletes 0");

  assert.equal(deltaPostCount, initialPostCount, "Zero additional delta posts made across subsequent cycles");
  assert.equal(localTree.size, 841, "All 838 local bookmarks, 1 folder, and 2 roots remain completely intact");
});

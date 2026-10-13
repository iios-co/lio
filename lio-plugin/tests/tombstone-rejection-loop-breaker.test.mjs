// Test the rejection-aware accounting and infinite loop breaker:
// When the server rejects/skips creates because of existing tombstones (applied: 0, skipped_stale: 838),
// pushLocalOnlyNodes MUST:
// 1. Never log false success ("sent 838 missing bookmarks")
// 2. Never add rejected nodes to knownServerIds
// 3. Immediately halt and pause sync (globalEnabled: false) to prevent ping-pong loops
// 4. Report unresolved items accurately

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
const loggedEvents = [];

const localTree = new Map([
  ["0", { id: "0", title: "", parentId: undefined, index: 0, children: ["1"] }],
  ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0, children: [] }],
]);

for (let i = 1; i <= 838; i++) {
  const id = `bm_${i}`;
  localTree.get("1").children.push(id);
  localTree.set(id, { id, title: `Bookmark ${i}`, url: `https://example.com/${i}`, parentId: "1", index: i - 1 });
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
  },
};

let pushCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/bookmarks/tree")) {
    return new Response(JSON.stringify({
      nodes: [{ id: "1", parent_id: "0", title: "Bookmarks bar", url: null, is_folder: true, position: 0 }],
      server_timestamp: 1000,
      server_version: 1,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.endsWith("/bookmarks/delta") && init.method === "POST") {
    pushCalls++;
    // Simulate server rejecting all 838 creates due to deleted = 1 tombstones:
    return new Response(JSON.stringify({ applied: 0, skipped_stale: 838, server_timestamp: 1001 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const { pushLocalOnlyNodes } = await import("../src/lib/bookmarks.ts");

test("server tombstone rejection (applied:0, skipped_stale:838) immediately halts, pauses sync, and never loops", async () => {
  store.set("endpoint", "http://test.local");
  store.set("token", "tok_test");
  store.set("deviceId", "dev_test");
  store.set("lastPulledTs", 500);
  store.set("lastServerVersion", 1);
  store.set("knownServerIds", ["1"]);
  store.set("syncConfig", {
    globalEnabled: true,
    pairs: [{ id: "p1", type: "bookmark", localFolderId: "1", localFolderName: "Bookmarks bar", collectionPath: "", enabled: true }],
  });

  const res = await pushLocalOnlyNodes();

  // 1. Exactly 1 push call made
  assert.equal(pushCalls, 1, "Only 1 push call must be attempted");

  // 2. Reported pushed must be 0, unresolved must be 838
  assert.equal(res.pushed, 0, "Pushed count must be 0 when server rejected all");
  assert.equal(res.unresolved, 838, "Unresolved count must reflect the 838 rejected items");

  // 3. Known server IDs must NOT have been updated with rejected nodes
  const known = store.get("knownServerIds");
  assert.equal(known.length, 1, "Known IDs must not include rejected items");

  // 4. Circuit breaker must have paused sync to stop infinite loop
  const syncCfg = store.get("syncConfig");
  assert.equal(syncCfg.globalEnabled, false, "Sync must be automatically paused to stop ping-pong loop");
});

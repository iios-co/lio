// Test the exact resume/enable sync (TOGGLE_GLOBAL) sequence against a populated tree.
// Ensures that enabling sync, pausing, resuming, and triggering reconciliation
// NEVER deletes local bookmarks.

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
const removedNodes = [];
let pushedDeltas = [];

// Seed 914 bookmarks to mirror the exact user scenario
const localTree = new Map([
  ["0", { id: "0", title: "", parentId: undefined, index: 0, children: ["1"] }],
  ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0, children: [] }],
]);

const barChildren = localTree.get("1").children;
for (let i = 1; i <= 914; i++) {
  const id = `bm_${i}`;
  barChildren.push(id);
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
    async getTree() {
      return [toTree("0")];
    },
    async get(id) {
      const n = localTree.get(id);
      return n ? [n] : [];
    },
    async create(arg) {
      const id = "minted_" + Math.random().toString(36).slice(2, 7);
      const created = { id, title: arg.title, url: arg.url, parentId: arg.parentId, index: arg.index ?? 0 };
      localTree.set(id, created);
      return created;
    },
    async remove(id) {
      removedNodes.push(id);
      localTree.delete(id);
      return true;
    },
    async removeTree(id) {
      removedNodes.push(id);
      localTree.delete(id);
      return true;
    },
    async move() { return {}; },
    async update() { return {}; },
  },
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/bookmarks/tree")) {
    return new Response(JSON.stringify({
      nodes: [
        { id: "1", parent_id: "0", title: "Bookmarks bar", url: null, is_folder: true, position: 0 },
      ],
      server_timestamp: 1000,
      server_version: 1,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.endsWith("/bookmarks/delta") && init.method === "POST") {
    const body = JSON.parse(init.body);
    pushedDeltas.push(...body.ops);
    return new Response(JSON.stringify({ applied: body.ops.length, server_version: 2 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const { pushLocalOnlyNodes, reconcileFromServer } = await import("../src/lib/bookmarks.ts");

test("resuming sync (TOGGLE_GLOBAL) with 914 local bookmarks against empty server never deletes local nodes", async () => {
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

  // 1. Repair step (pushLocalOnlyNodes) runs on resume
  const repair = await pushLocalOnlyNodes();
  assert.equal(removedNodes.length, 0, "No bookmarks may be deleted locally on sync resume");
  assert.equal(repair.deletedLocally, 0);
  assert.equal(localTree.size, 916, "All 914 bookmarks plus 2 roots remain");

  // 2. Automated reconcile runs on resync trigger
  const reconcile = await reconcileFromServer();
  assert.equal(removedNodes.length, 0, "Automated reconcile must never delete local nodes missing on server");
  assert.equal(reconcile.deleted, 0);
  assert.equal(localTree.size, 916, "All 914 bookmarks still intact");
});

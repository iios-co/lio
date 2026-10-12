// Regression & Fault-Injection: Reconnecting from Collection A to Collection B
// with stale knownServerIds and uninitialized watermarks must NEVER delete local bookmarks.
// A merge on onboarding MUST be purely additive (union) and never call removeTree or emit deletes.

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
const removedNodes = [];
let pushedDeltas = [];

const localTree = new Map([
  ["0", { id: "0", title: "", parentId: undefined, index: 0, children: ["1"] }],
  ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0, children: ["f1", "b1", "b2"] }],
  ["f1", { id: "f1", title: "Folder 1", parentId: "1", index: 0, children: ["b3"] }],
  ["b1", { id: "b1", title: "Link 1", url: "https://example1.com", parentId: "1", index: 1 }],
  ["b2", { id: "b2", title: "Link 2", url: "https://example2.com", parentId: "1", index: 2 }],
  ["b3", { id: "b3", title: "Nested Link", url: "https://nested.com", parentId: "f1", index: 0 }],
]);

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
        { id: "srv_only", parent_id: "1", title: "Server Only", url: "https://server.com", is_folder: false, position: 0 },
      ],
      server_timestamp: 2000,
      server_version: 5,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.endsWith("/bookmarks/delta") && init.method === "POST") {
    const body = JSON.parse(init.body);
    pushedDeltas.push(...body.ops);
    return new Response(JSON.stringify({ applied: body.ops.length, server_version: 6 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const { bootstrap, pushLocalOnlyNodes } = await import("../src/lib/bookmarks.ts");

test("onboarding merge is strictly additive and never calls removeTree or emits delete deltas", async () => {
  // Simulate stale state from prior collection A
  store.set("endpoint", "http://old.collection");
  store.set("token", "old_token");
  store.set("lastPulledTs", 0);
  store.set("lastServerVersion", 0);
  store.set("bootstrapMode", "merge");
  store.set("knownServerIds", ["1", "f1", "b1", "b2", "b3", "stale_from_collection_a"]);
  store.set("syncConfig", {
    globalEnabled: true,
    pairs: [{ id: "p1", type: "bookmark", localFolderId: "1", localFolderName: "Bookmarks bar", collectionPath: "", enabled: true }],
  });

  const res = await bootstrap("merge");

  assert.equal(removedNodes.length, 0, "bootstrap merge must never call removeTree or remove locally");
  const deleteOps = pushedDeltas.filter((op) => op.op === "delete");
  assert.equal(deleteOps.length, 0, "bootstrap merge must never emit delete ops to the server");
  assert.ok(localTree.has("b1"), "Link 1 must not be deleted");
  assert.ok(localTree.has("b2"), "Link 2 must not be deleted");
  assert.ok(localTree.has("f1"), "Folder 1 must not be deleted");
  assert.ok(localTree.has("b3"), "Nested Link must not be deleted");
});

test("pushLocalOnlyNodes before clean baseline establishes never removes local nodes even with stale knownServerIds", async () => {
  removedNodes.length = 0;
  pushedDeltas = [];

  // Stale known IDs present, but watermark is 0 (no baseline established with new server)
  store.set("lastPulledTs", 0);
  store.set("lastServerVersion", 0);
  store.set("knownServerIds", ["f1", "b1", "b2", "b3"]);

  const repairRes = await pushLocalOnlyNodes();

  assert.equal(removedNodes.length, 0, "pushLocalOnlyNodes must not delete local nodes without a baseline");
  assert.equal(repairRes.deletedLocally, 0, "deletedLocally must be 0");
  assert.ok(localTree.has("b1"), "Link 1 preserved");
  assert.ok(localTree.has("b2"), "Link 2 preserved");
});

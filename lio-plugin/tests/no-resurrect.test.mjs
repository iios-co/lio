// Regression: Server-side deletions must arrive via explicit tombstone deltas,
// and are applied cleanly to the browser tree without resurrection.
// Local-only nodes absent from the server are NEVER deleted by heuristic inference.

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map([
  ["endpoint", "http://test.local"],
  ["token", "tok123"],
  ["deviceId", "dev_test"],
  ["syncConfig", {
    globalEnabled: true,
    pairs: [{ id: "p1", type: "bookmark", localFolderId: "1", localFolderName: "Bookmarks bar", collectionPath: "", enabled: true }],
  }],
  ["lastPulledTs", 1000],
  ["lastServerVersion", 1],
  ["knownServerIds", ["1", "keep"]],
]);

const nodes = new Map([
  ["0", { id: "0", title: "", parentId: undefined, index: 0, children: ["1"] }],
  ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0, children: ["keep", "gone_a", "gone_b", "gone_c", "fresh"] }],
  ["keep", { id: "keep", title: "Survivor", url: "https://keep.example/", parentId: "1", index: 0 }],
  ["gone_a", { id: "gone_a", title: "Deleted A", url: "https://a.example/", parentId: "1", index: 1 }],
  ["gone_b", { id: "gone_b", title: "Deleted B", url: "https://b.example/", parentId: "1", index: 2 }],
  ["gone_c", { id: "gone_c", title: "Deleted C", url: "https://c.example/", parentId: "1", index: 3 }],
  ["fresh", { id: "fresh", title: "Added locally", url: "https://fresh.example/", parentId: "1", index: 4 }],
]);

const removed = [];
let pushedOps = [];

function toTree(id) {
  const n = nodes.get(id);
  const out = { id: n.id, title: n.title, index: n.index };
  if (n.parentId !== undefined) out.parentId = n.parentId;
  if (n.url) out.url = n.url;
  if (n.children) out.children = n.children.filter((c) => nodes.has(c)).map(toTree);
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
      const n = nodes.get(id);
      return n ? [n] : [];
    },
    async create(arg) {
      const id = "minted_" + Math.random().toString(36).slice(2, 7);
      const created = { id, title: arg.title, url: arg.url, parentId: arg.parentId, index: arg.index ?? 0 };
      nodes.set(id, created);
      return created;
    },
    async remove(id) {
      removed.push(id);
      nodes.delete(id);
      return true;
    },
    async removeTree(id) {
      removed.push(id);
      nodes.delete(id);
      return true;
    },
    async move() { return {}; },
    async update() { return {}; },
  },
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/bookmarks/sync") && init.method === "POST") {
    // Deliver explicit tombstone delta operations for gone_a, gone_b, gone_c
    return new Response(JSON.stringify({
      acknowledgedOperations: [],
      changes: [
        { operation: "delete", itemId: "gone_a", data: { parentId: "1" } },
        { operation: "delete", itemId: "gone_b", data: { parentId: "1" } },
        { operation: "delete", itemId: "gone_c", data: { parentId: "1" } },
      ],
      currentServerVersion: 5,
      serverTimestamp: 2000,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.endsWith("/bookmarks/tree")) {
    return new Response(JSON.stringify({
      nodes: [
        { id: "1", parent_id: "0", title: "Bookmarks bar", url: null, is_folder: true, position: 0 },
        { id: "keep", parent_id: "1", title: "Survivor", url: "https://keep.example/", is_folder: false, position: 0 },
      ],
      server_timestamp: 2000,
      server_version: 5,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.endsWith("/bookmarks/delta") && init.method === "POST") {
    pushedOps = JSON.parse(init.body).ops ?? [];
    return new Response(JSON.stringify({ applied: pushedOps.length, server_version: 6 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const { syncTransaction, pushLocalOnlyNodes } = await import("../src/lib/bookmarks.ts");

test("explicit server tombstone deltas are applied locally via syncTransaction", async () => {
  const applied = await syncTransaction();
  assert.equal(applied, 3, "must apply the 3 delete tombstones");

  assert.deepEqual(
    removed.slice().sort(), ["gone_a", "gone_b", "gone_c"],
    "browser must remove the 3 items explicitly deleted on the server"
  );
  assert.equal(nodes.has("gone_a"), false);
  assert.equal(nodes.has("gone_b"), false);
  assert.equal(nodes.has("gone_c"), false);
});

test("pushLocalOnlyNodes pushes genuinely uncommitted local creations and never infers deletions", async () => {
  const r = await pushLocalOnlyNodes();

  const sent = pushedOps.filter((o) => o.op === "create").map((o) => o.node_id);
  assert.deepEqual(sent, ["fresh"], "only the real local creation is pushed");
  assert.ok(nodes.has("fresh"), "fresh remains in the browser");
  assert.ok(nodes.has("keep"), "survivor remains in the browser");
  assert.equal(r.deletedLocally, 0, "pushLocalOnlyNodes never deletes locally");
});

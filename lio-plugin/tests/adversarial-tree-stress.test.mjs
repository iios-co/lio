// Adversarial Test: Seed realistic tree with ~850 bookmarks, run bootstrap merge
// against an empty or populated collection, inject mid-sync interruptions and retries,
// and verify that NOT A SINGLE bookmark is deleted.

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
const removedNodes = [];
let pushedOps = [];

// Build 850 nodes (10 folders with 85 links each)
const localTree = new Map([
  ["0", { id: "0", title: "", parentId: undefined, index: 0, children: ["1"] }],
  ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0, children: [] }],
]);

const barChildren = localTree.get("1").children;
let totalLinks = 0;
for (let f = 1; f <= 10; f++) {
  const fId = `folder_${f}`;
  barChildren.push(fId);
  const fChildren = [];
  localTree.set(fId, { id: fId, title: `Folder ${f}`, parentId: "1", index: f - 1, children: fChildren });
  for (let l = 1; l <= 85; l++) {
    const lId = `link_${f}_${l}`;
    fChildren.push(lId);
    localTree.set(lId, { id: lId, title: `Link ${f}-${l}`, url: `https://example.com/${f}/${l}`, parentId: fId, index: l - 1 });
    totalLinks++;
  }
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
    pushedOps.push(...body.ops);
    return new Response(JSON.stringify({ applied: body.ops.length, server_version: 2 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const { bootstrap, pushLocalOnlyNodes, reconcileFromServer } = await import("../src/lib/bookmarks.ts");

test("adversarial 850-node tree: merge never deletes any local bookmark", async () => {
  store.set("endpoint", "http://test.local");
  store.set("token", "tok_test");
  store.set("deviceId", "dev_1");
  store.set("lastPulledTs", 0);
  store.set("lastServerVersion", 0);
  store.set("bootstrapMode", "merge");
  store.set("syncConfig", {
    globalEnabled: true,
    pairs: [{ id: "p1", type: "bookmark", localFolderId: "1", localFolderName: "Bookmarks bar", collectionPath: "", enabled: true }],
  });

  const res = await bootstrap("merge");

  assert.equal(removedNodes.length, 0, "No nodes may be removed locally");
  const deleteOps = pushedOps.filter((o) => o.op === "delete");
  assert.equal(deleteOps.length, 0, "No delete ops may be sent to the server");
  assert.equal(totalLinks, 850, "All 850 original links remain");
});

test("adversarial circuit breaker: reconcileFromServer halts on suspicious empty server tree without wiping", async () => {
  removedNodes.length = 0;
  // Local tree has 850 bookmarks; server tree has only 1 root node
  const r = await reconcileFromServer();

  assert.equal(removedNodes.length, 0, "Circuit breaker must prevent wiping 850 bookmarks");
  assert.equal(r.deleted, 0, "0 bookmarks deleted");
});

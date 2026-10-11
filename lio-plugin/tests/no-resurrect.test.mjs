// Regression: a deletion made ON THE SERVER must never be pushed back up.
//
// Scenario the user hit: pause syncing, delete 3 links server-side, unpause. The
// repair step (pushLocalOnlyNodes) sees 3 nodes that exist locally but not on the
// server and used to classify ALL local-only nodes as "the server never got this"
// — so it re-created them, silently undoing the deletion.
//
// The last observed server id set (`knownServerIds`) is what tells the two cases
// apart. A local-only node that WAS known was deleted server-side: apply the
// deletion locally. One that was never known really is a missed create: send it.
//
// Run: node --import ./tests/register-hooks.mjs --test tests/no-resurrect.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

// The server still holds the bar and one survivor. "gone_a/b/c" were deleted on
// the server while this browser was paused. "fresh" was created locally while
// paused and the server has never seen it.
const SERVER_ROWS = [
  { id: "1", parent_id: "0", title: "Bookmarks bar", url: null, is_folder: true, position: 0 },
  { id: "keep", parent_id: "1", title: "Survivor", url: "https://keep.example/", is_folder: false, position: 0 },
];

const store = new Map([
  ["endpoint", "http://test.local"],
  ["token", "tok123"],
  ["deviceId", "dev_test"],
  ["syncConfig", {
    globalEnabled: true,
    pairs: [{ id: "p1", type: "bookmark", localFolderId: "1", localFolderName: "Bookmarks bar", collectionPath: "", enabled: true }],
  }],
  // History: the server was last seen holding the three links it has since lost.
  ["knownServerIds", ["1", "keep", "gone_a", "gone_b", "gone_c"]],
]);

const nodes = new Map([
  ["0", { id: "0", title: "", parentId: undefined, index: 0, children: ["1"] }],
  ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0, children: ["keep", "gone_a", "gone_b", "gone_c", "fresh"] }],
  ["keep", { id: "keep", title: "Survivor", url: "https://keep.example/", parentId: "1", index: 0 }],
  ["gone_a", { id: "gone_a", title: "Deleted A", url: "https://a.example/", parentId: "1", index: 1 }],
  ["gone_b", { id: "gone_b", title: "Deleted B", url: "https://b.example/", parentId: "1", index: 2 }],
  ["gone_c", { id: "gone_c", title: "Deleted C", url: "https://c.example/", parentId: "1", index: 3 }],
  ["fresh", { id: "fresh", title: "Added while paused", url: "https://fresh.example/", parentId: "1", index: 4 }],
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
        const out = {};
        for (const k of ks) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
    },
  },
  bookmarks: {
    async getTree() { return [toTree("0")]; },
    async get(id) {
      const n = nodes.get(id);
      if (!n) throw new Error(`no node ${id}`);
      return [{ id: n.id, title: n.title, parentId: n.parentId, index: n.index, url: n.url }];
    },
    async remove(id) {
      if (!nodes.has(id)) throw new Error(`no node ${id}`);
      removed.push(id);
      nodes.delete(id);
    },
    async removeTree(id) {
      if (!nodes.has(id)) throw new Error(`no node ${id}`);
      removed.push(id);
      nodes.delete(id);
    },
  },
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/bookmarks/tree")) {
    return new Response(JSON.stringify({ nodes: SERVER_ROWS, server_timestamp: 1, server_version: 7 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (u.endsWith("/bookmarks/delta") && init.method === "POST") {
    pushedOps = JSON.parse(init.body).ops ?? JSON.parse(init.body).operations ?? [];
    return new Response(JSON.stringify({ applied: pushedOps.length, server_version: 8 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const { pushLocalOnlyNodes } = await import("../src/lib/bookmarks.ts");

test("a server-side deletion is applied locally, never pushed back as a create", async () => {
  const r = await pushLocalOnlyNodes();

  const resurrected = pushedOps.filter(
    (o) => o.op === "create" && ["gone_a", "gone_b", "gone_c"].includes(o.node_id)
  );
  assert.deepEqual(
    resurrected.map((o) => o.node_id), [],
    "the server deleted these, so re-creating them undoes the user's deletion"
  );

  assert.deepEqual(
    removed.slice().sort(), ["gone_a", "gone_b", "gone_c"],
    "the browser must lose exactly the three links the server dropped"
  );
  assert.equal(r.deletedLocally, 3, "and report them as applied locally");
});

test("a genuinely missed create is still sent to the server", async () => {
  const sent = pushedOps.filter((o) => o.op === "create").map((o) => o.node_id);
  assert.deepEqual(sent, ["fresh"],
    "a node the server never knew is a missed create and must still be pushed");
  assert.ok(nodes.has("fresh"), "and it stays in the browser");
  assert.ok(nodes.has("keep"), "a node present on both sides is untouched");
});

test("the deleted ids are dropped from the known set, so they cannot be re-pushed", async () => {
  const known = store.get("knownServerIds");
  for (const id of ["gone_a", "gone_b", "gone_c"]) {
    assert.ok(!known.includes(id), `${id} must not linger in the known set`);
  }
  assert.ok(known.includes("fresh"), "a freshly pushed node becomes known");
});

// Regression: a rearrangement made ON THE SERVER while this browser was not
// syncing must win — the browser must NOT push its stale order back up.
//
// Scenario the user hit: pause, move a folder up in the web UI, unpause. The
// repair step compared positions and unconditionally declared "the browser is the
// position authority", pushing a `move` that put the folder back where it was.
//
// Who wins is decided by watermarks, not by side: `server_version` on the row is
// the watermark of its last accepted server mutation, and `lastServerVersion` is
// the last watermark this browser consumed. A row that changed AFTER our
// watermark changed while we were not listening, so the server wins and the move
// is applied locally. A row at or below our watermark is state we have already
// seen, so a local difference is a genuine local edit and is pushed up.
//
// Run: node --import ./tests/register-hooks.mjs --test tests/server-position-authority.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
let serverRows = [];
let moved = [];
let pushedOps = [];
let nodes = new Map();

function resetLocalTree() {
  // bar "1" holds three folders in the order Alpha, Beta, Gamma.
  nodes = new Map([
    ["0", { id: "0", title: "", parentId: undefined, index: 0, children: ["1"] }],
    ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0, children: ["fA", "fB", "fC"] }],
    ["fA", { id: "fA", title: "Alpha", parentId: "1", index: 0, children: [] }],
    ["fB", { id: "fB", title: "Beta", parentId: "1", index: 1, children: [] }],
    ["fC", { id: "fC", title: "Gamma", parentId: "1", index: 2, children: [] }],
  ]);
}

async function resetAll({ lastServerVersion }) {
  store.clear();
  store.set("endpoint", "http://test.local");
  store.set("token", "tok123");
  store.set("collectionId", "col_test_123");
  store.set("lio_migrated_col_test_123", true);
  store.set("deviceId", "dev_test");
  store.set("lastServerVersion", lastServerVersion);
  store.set("syncConfig", {
    globalEnabled: true,
    pairs: [{
      id: "p1", type: "bookmark", localFolderId: "1",
      localFolderName: "Bookmarks bar", collectionPath: "", enabled: true,
    }],
  });
  store.set("knownServerIds", ["1", "fA", "fB", "fC"]);
  resetLocalTree();
  moved = [];
  pushedOps = [];
  await setMappings([
    { serverId: "fA", localId: "fA" },
    { serverId: "fB", localId: "fB" },
    { serverId: "fC", localId: "fC" },
  ]);
}

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
    async move(id, dest) {
      if (!nodes.has(id)) throw new Error(`no node ${id}`);
      moved.push({ id, parentId: dest.parentId, index: dest.index });
      // Reflect the move so a second pass sees converged state.
      const node = nodes.get(id);
      const oldParent = nodes.get(node.parentId);
      if (oldParent) oldParent.children = oldParent.children.filter((c) => c !== id);
      const newParent = nodes.get(dest.parentId ?? node.parentId);
      node.parentId = newParent.id;
      newParent.children.splice(dest.index, 0, id);
      newParent.children.forEach((c, i) => { nodes.get(c).index = i; });
      return { id, parentId: node.parentId, index: dest.index };
    },
    async remove(id) { nodes.delete(id); },
    async removeTree(id) { nodes.delete(id); },
  },
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/bookmarks/tree")) {
    return new Response(JSON.stringify({ nodes: serverRows, server_timestamp: 1, server_version: 99 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (u.endsWith("/bookmarks/delta") && init.method === "POST") {
    pushedOps = JSON.parse(init.body).ops ?? [];
    return new Response(JSON.stringify({ applied: pushedOps.length, server_version: 100 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const { pushLocalOnlyNodes } = await import("../src/lib/bookmarks.ts");
const { setMappings } = await import("../src/lib/idMap.ts");
test("a server rearrangement made after our watermark wins and is applied locally", async () => {
  // Server order: Gamma, Alpha, Beta. Gamma was moved to the front at server
  // version 50 — AFTER this browser's watermark of 10, so it moved while we were
  // paused.
  serverRows = [
    { id: "1",  parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true, server_version: 5 },
    { id: "fC", parent_id: "1", position: 0, title: "Gamma", url: null, is_folder: true, server_version: 50 },
    { id: "fA", parent_id: "1", position: 1, title: "Alpha", url: null, is_folder: true, server_version: 51 },
    { id: "fB", parent_id: "1", position: 2, title: "Beta",  url: null, is_folder: true, server_version: 52 },
  ];
  await resetAll({ lastServerVersion: 10 });

  await pushLocalOnlyNodes();

  const pushedMoves = pushedOps.filter((o) => o.op === "move").map((o) => o.node_id);
  assert.deepEqual(pushedMoves, [], (
    "the browser must not push its stale order back up — that is what moved the folder back"
  ));

  const movedIds = moved.map((m) => m.id).sort();
  assert.deepEqual(movedIds, ["fA", "fB", "fC"], (
    `every row the server rearranged must be applied locally, got ${JSON.stringify(moved)}`
  ));

  // And the browser now matches the server's order.
  assert.deepEqual(nodes.get("1").children, ["fC", "fA", "fB"],
    "the local tree must end up in the server's order");
});

test("a local move the server has already seen is still pushed up", async () => {
  // Same divergence, but every server row is at or below our watermark: the
  // server has shown us this state, so the difference is a genuine local edit.
  serverRows = [
    { id: "1",  parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true, server_version: 5 },
    { id: "fC", parent_id: "1", position: 0, title: "Gamma", url: null, is_folder: true, server_version: 6 },
    { id: "fA", parent_id: "1", position: 1, title: "Alpha", url: null, is_folder: true, server_version: 7 },
    { id: "fB", parent_id: "1", position: 2, title: "Beta",  url: null, is_folder: true, server_version: 8 },
  ];
  await resetAll({ lastServerVersion: 90 });

  await pushLocalOnlyNodes();

  assert.deepEqual(moved, [], "nothing may be rearranged locally when we are the newer side");

  const pushedMoves = pushedOps.filter((o) => o.op === "move").map((o) => o.node_id).sort();
  assert.deepEqual(pushedMoves, ["fA", "fB", "fC"],
    `a real local reorder must still reach the server, got ${JSON.stringify(pushedOps)}`);
});

test("an agreeing tree produces no moves in either direction", async () => {
  serverRows = [
    { id: "1",  parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true, server_version: 5 },
    { id: "fA", parent_id: "1", position: 0, title: "Alpha", url: null, is_folder: true, server_version: 50 },
    { id: "fB", parent_id: "1", position: 1, title: "Beta",  url: null, is_folder: true, server_version: 51 },
    { id: "fC", parent_id: "1", position: 2, title: "Gamma", url: null, is_folder: true, server_version: 52 },
  ];
  await resetAll({ lastServerVersion: 10 });

  await pushLocalOnlyNodes();

  assert.deepEqual(moved, [], "no local churn when the two sides already agree");
  assert.deepEqual(pushedOps.filter((o) => o.op === "move"), [],
    "and nothing pushed up either");
});

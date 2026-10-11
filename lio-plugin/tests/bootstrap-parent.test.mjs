// Regression: a merge must NEVER create a bookmark without a resolved parent.
//
// `browser.bookmarks.create({ parentId: undefined })` does not mean "top level" —
// Chrome files the node under "Other bookmarks". The bootstrap pull used to pass
// undefined whenever a server row's parent had no local counterpart, which
// flattened server subtrees into that folder. Flattened copies sit at a different
// folder path, so they no longer content-match, so the next bootstrap pulled the
// same rows again: one collection multiplied into thousands of duplicates.
//
// Run: node --import ./tests/register-hooks.mjs --test tests/bootstrap-parent.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const SERVER_ROWS = [
  { id: "s_f", parent_id: "1", title: "Work", url: null, is_folder: true, position: 0 },
  { id: "s_l", parent_id: "s_f", title: "Nested", url: "https://nested.example/", is_folder: false, position: 0 },
  // Parent "s_ghost" exists nowhere: not locally, not in the server payload. There
  // is no honest home for this row, so it must be SKIPPED, not filed elsewhere.
  { id: "s_orphan", parent_id: "s_ghost", title: "Orphan", url: "https://orphan.example/", is_folder: false, position: 0 },
];

const store = new Map([
  ["endpoint", "http://test.local"],
  ["token", "tok123"],
  ["deviceId", "dev_test"],
  ["syncConfig", { globalEnabled: true, pairs: [{ id: "p1", type: "bookmark", localFolderId: "1", localFolderName: "Bookmarks bar", collectionPath: "", enabled: true }] }],
]);

/** Local tree: the bar holds one link that matches nothing on the server. */
const nodes = new Map([
  ["0", { id: "0", title: "", parentId: undefined, index: 0, children: ["1"] }],
  ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0, children: ["l1"] }],
  ["l1", { id: "l1", title: "Local One", url: "https://local.example/", parentId: "1", index: 0 }],
]);

const created = [];
let nextId = 100;

function toTree(id) {
  const n = nodes.get(id);
  const out = { id: n.id, title: n.title, index: n.index };
  if (n.parentId !== undefined) out.parentId = n.parentId;
  if (n.url) out.url = n.url;
  if (n.children) out.children = n.children.map(toTree);
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
    async create(arg) {
      // The whole point of the fix: record exactly what parent was requested.
      created.push({ parentId: arg.parentId, title: arg.title, url: arg.url ?? null });
      const id = `new_${nextId++}`;
      nodes.set(id, { id, title: arg.title ?? "", url: arg.url, parentId: arg.parentId, index: arg.index ?? 0 });
      const parent = nodes.get(arg.parentId);
      if (parent) (parent.children ??= []).push(id);
      return { id, title: arg.title ?? "", url: arg.url, parentId: arg.parentId, index: arg.index ?? 0 };
    },
  },
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/bookmarks/tree")) {
    return new Response(JSON.stringify({ nodes: SERVER_ROWS, server_timestamp: 1, server_version: 1 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (u.endsWith("/bookmarks/delta") && init.method === "POST") {
    return new Response(JSON.stringify({ applied: 0, server_version: 2 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const { bootstrap } = await import("../src/lib/bookmarks.ts");

test("a merge never creates a bookmark without a resolved parent", async () => {
  await bootstrap("merge");

  assert.ok(created.length > 0, "the merge must have pulled something");

  const unparented = created.filter((c) => !c.parentId);
  assert.deepEqual(
    unparented, [],
    `every create must name a parent — Chrome files a parentless create under "Other bookmarks"`
  );
});

test("a server row whose parent has no local home is skipped, not misfiled", async () => {
  const orphan = created.find((c) => c.url === "https://orphan.example/");
  assert.equal(orphan, undefined, "the unparentable row must not be created at all");

  // The resolvable subtree still arrives, so the skip is targeted rather than a
  // blanket refusal to pull.
  const folder = created.find((c) => c.title === "Work");
  const nested = created.find((c) => c.url === "https://nested.example/");
  assert.ok(folder, "a server folder with a resolvable parent is still pulled");
  assert.equal(folder.parentId, "1", "it lands under the real local parent");
  assert.ok(nested, "its child link is still pulled");
  assert.equal(nested.parentId, folder ? nodes.get(nested.parentId)?.id : undefined,
    "the child lands under the folder Chrome just minted, not at a guessed parent");
});

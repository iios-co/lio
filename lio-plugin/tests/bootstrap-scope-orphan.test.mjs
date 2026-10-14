// Regression: scope narrowing must not turn server rows into "Other bookmarks" litter.
//
// The bootstrap pull resolves a server row's parent against the SCOPE-FILTERED
// local id set. A folder that really exists in the browser but sits OUTSIDE the
// sync pair is therefore absent from that set, so a server row parented to it
// resolved to `undefined` — and `bookmarks.create({ parentId: undefined })` files
// the node under "Other bookmarks". So the narrower the pair, the more rows got
// dumped into the one folder the user never named.
//
// Run: node --import ./tests/register-hooks.mjs --test tests/bootstrap-scope-orphan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

// The pair covers ONLY the Bookmarks bar ("1"). "arch" is a real local folder
// living in Other bookmarks ("2"), so it is deliberately out of scope.
const SERVER_ROWS = [
  // In scope: a new subfolder of the bar, holding a new link.
  { id: "s_sub", parent_id: "1", title: "Reading", url: null, is_folder: true, position: 0 },
  { id: "s_sub_link", parent_id: "s_sub", title: "In Bar", url: "https://inbar.example/", is_folder: false, position: 0 },
  // Out of scope: parent "arch" EXISTS in the browser but the pair excludes it.
  { id: "arch_link", parent_id: "arch", title: "Archived", url: "https://archived.example/", is_folder: false, position: 0 },
];

const store = new Map([
  ["endpoint", "http://test.local"],
  ["token", "tok123"],
  ["collectionId", "col_test_123"],
  ["deviceId", "dev_test"],
  ["syncConfig", {
    globalEnabled: true,
    pairs: [{ id: "p1", type: "bookmark", localFolderId: "1", localFolderName: "Bookmarks bar", collectionPath: "", enabled: true }],
  }],
]);

const nodes = new Map([
  ["0", { id: "0", title: "", parentId: undefined, index: 0, children: ["1", "2"] }],
  ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0, children: [] }],
  ["2", { id: "2", title: "Other bookmarks", parentId: "0", index: 1, children: ["arch"] }],
  ["arch", { id: "arch", title: "Archive", parentId: "2", index: 0, children: [] }],
]);

const created = [];
let nextId = 500;

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
      // Record the REQUESTED parent before any validation: that is the thing
      // under test.
      created.push({ parentId: arg.parentId, title: arg.title, url: arg.url ?? null });
      // Chrome-accurate: the root container refuses direct children, and an
      // unknown parent throws. A stub that accepted either would hide bugs.
      if (arg.parentId === "0") throw new Error("Can't modify the root bookmark folders.");
      if (arg.parentId !== undefined && !nodes.has(arg.parentId)) throw new Error("Can't find parent bookmark for bookmark.");
      const id = `new_${nextId++}`;
      const parentId = arg.parentId ?? "2"; // undefined => Chrome files under Other bookmarks
      nodes.set(id, { id, title: arg.title ?? "", url: arg.url, parentId, index: arg.index ?? 0 });
      const parent = nodes.get(parentId);
      if (parent) (parent.children ??= []).push(id);
      return { id, title: arg.title ?? "", url: arg.url, parentId, index: arg.index ?? 0 };
    },
  },
};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/bookmarks/tree")) {
    return new Response(JSON.stringify({ nodes: SERVER_ROWS, server_timestamp: 1, server_version: 1 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  if (u.endsWith("/bookmarks/delta")) {
    return new Response(JSON.stringify({ applied: 999, server_version: 2 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const { bootstrap } = await import("../src/lib/bookmarks.ts");

test("a server row parented OUTSIDE the sync pair is never dumped into Other bookmarks", async () => {
  await bootstrap("merge");

  const unparented = created.filter((c) => c.parentId === undefined);
  assert.deepEqual(
    unparented, [],
    "a parentless create lands in Other bookmarks — a folder the pair never named"
  );

  const stranded = created.find((c) => c.url === "https://archived.example/");
  assert.equal(stranded, undefined,
    "the row belongs under an out-of-scope folder, so it must be skipped rather than relocated");

  // Nothing may appear under Other bookmarks at all: the pair named only the bar.
  const otherChildren = nodes.get("2").children.filter((id) => id !== "arch");
  assert.deepEqual(otherChildren, [],
    "Other bookmarks must be untouched by a bar-only sync pair");
});

test("in-scope server rows are still pulled, under the folder the pair names", async () => {
  const folder = created.find((c) => c.title === "Reading");
  assert.ok(folder, "an in-scope server folder must still be pulled");
  assert.equal(folder.parentId, "1", "it lands in the Bookmarks bar, where the pair points");

  const link = created.find((c) => c.url === "https://inbar.example/");
  assert.ok(link, "its child link must still be pulled");
  const mintedFolderId = nodes.get(link.parentId);
  assert.ok(mintedFolderId, "the child lands under a real, existing parent");
  assert.equal(mintedFolderId.title, "Reading",
    "specifically under the folder Chrome just minted for the server folder");
});

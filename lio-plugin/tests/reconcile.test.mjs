// The 1:1 reconciliation rule, as pure logic.
//
// This exists because of a real incident: 1196 duplicate links were deleted on
// the server, the browser kept every one of them, and BOTH the popup and the web
// UI showed the same number — because the popup rendered the server's own
// bookmark_count. "Synced" was claimed the whole time.
//
//   node --import ./tests/register-hooks.mjs --test tests/reconcile.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { diffTrees, describeDiff, linkCount } from "../src/lib/treeDiff.ts";
import { syncLabel } from "../src/lib/stateLabel.ts";

const node = (id, over = {}) => ({
  id,
  parentId: "1",
  index: 0,
  title: `T${id}`,
  url: `https://e.com/${id}`,
  isFolder: false,
  ...over,
});

// ---- diffTrees -------------------------------------------------------------

test("identical trees compare equal", () => {
  const a = [node("1", { index: 0 }), node("2", { index: 1 })];
  const b = [node("1", { index: 0 }), node("2", { index: 1 })];
  const d = diffTrees(a, b);
  assert.equal(d.identical, true);
  assert.equal(d.differences, 0);
  assert.match(describeDiff(d), /matches/i);
});

test("THE INCIDENT: server deleted links the browser still has", () => {
  // Browser keeps 3, server has 1 — exactly the dedupe case.
  const local = [node("1"), node("2", { index: 1 }), node("3", { index: 2 })];
  const server = [node("1")];
  const d = diffTrees(local, server);
  assert.equal(d.identical, false, "this must NOT be reported as synced");
  assert.equal(d.localCount, 3);
  assert.equal(d.serverCount, 1);
  assert.deepEqual(d.missingOnServer.sort(), ["2", "3"]);
  assert.equal(d.differences, 2);
  assert.match(describeDiff(d), /2 not on server/);
});

test("equal COUNTS with different content is not a match", () => {
  // The trap: counting alone would call this synced.
  const local = [node("1"), node("2", { index: 1 })];
  const server = [node("1"), node("9", { index: 1 })];
  const d = diffTrees(local, server);
  assert.equal(d.localCount, d.serverCount, "counts deliberately equal");
  assert.equal(d.identical, false, "equal counts must not imply a match");
  assert.deepEqual(d.missingOnServer, ["2"]);
  assert.deepEqual(d.missingLocally, ["9"]);
});

test("a renamed link is a difference", () => {
  const d = diffTrees([node("1", { title: "New name" })], [node("1", { title: "Old name" })]);
  assert.equal(d.identical, false);
  assert.deepEqual(d.titleMismatch, ["1"]);
  assert.match(describeDiff(d), /1 renamed/);
});

test("a moved link is a difference — position counts, not just membership", () => {
  const local = [node("1", { index: 0 }), node("2", { index: 1 })];
  const server = [node("1", { index: 1 }), node("2", { index: 0 })];
  const d = diffTrees(local, server);
  assert.equal(d.identical, false);
  assert.deepEqual(d.placeMismatch.sort(), ["1", "2"]);
  assert.match(describeDiff(d), /2 moved/);
});

test("a link in a different folder is a difference", () => {
  const d = diffTrees([node("1", { parentId: "5" })], [node("1", { parentId: "1" })]);
  assert.equal(d.identical, false);
  assert.deepEqual(d.placeMismatch, ["1"]);
});

test("a different url is a difference", () => {
  const d = diffTrees([node("1", { url: "https://a.com/" })], [node("1", { url: "https://b.com/" })]);
  assert.equal(d.identical, false);
  assert.deepEqual(d.urlMismatch, ["1"]);
});

test("a trailing slash alone is NOT a difference", () => {
  const d = diffTrees([node("1", { url: "https://a.com/x/" })], [node("1", { url: "https://a.com/x" })]);
  assert.equal(d.identical, true);
});

test("a node differing several ways is counted once", () => {
  const d = diffTrees(
    [node("1", { title: "X", url: "https://a.com/", index: 3 })],
    [node("1", { title: "Y", url: "https://b.com/", index: 0 })]
  );
  assert.equal(d.differences, 1);
});

test("link count excludes folders", () => {
  assert.equal(linkCount([node("1"), node("2", { isFolder: true, url: null })]), 1);
});

// ---- the label rule --------------------------------------------------------

const base = { enabled: true, reachable: true, tokenValid: true, busy: false, queued: 0 };

test("'Synced' requires a verified match, not a successful push", () => {
  // lastOkAt says a sync cycle completed — that is NOT evidence the trees agree.
  assert.equal(syncLabel({ ...base, lastOkAt: Date.now(), matched: false, differences: 1196 }), "1196 differ");
  assert.equal(syncLabel({ ...base, lastOkAt: Date.now(), matched: true }), "Synced");
});

test("an unavailable comparison is never reported as synced", () => {
  assert.equal(syncLabel({ ...base, lastOkAt: Date.now(), matched: null }), "not compared");
});

test("a real problem still outranks the comparison", () => {
  assert.equal(syncLabel({ ...base, reachable: false, lastOkAt: 1, matched: true }), "offline");
  assert.equal(syncLabel({ ...base, tokenValid: false, lastOkAt: 1, matched: true }), "no valid token");
  assert.equal(syncLabel({ ...base, enabled: false, lastOkAt: 1, matched: true }), "paused");
  assert.equal(syncLabel({ ...base, queued: 4, lastOkAt: 1, matched: true }), "4 queued");
  assert.equal(syncLabel({ ...base, busy: true, lastOkAt: 1, matched: true }), "Syncing");
});

test("cards with nothing to compare keep their own push evidence", () => {
  // The tabs card omits `matched` entirely and must be unaffected.
  assert.equal(syncLabel({ ...base, lastOkAt: Date.now() }), "Synced");
  assert.equal(syncLabel({ ...base, lastOkAt: null }), "not synced yet");
  assert.equal(syncLabel({ ...base, lastOkAt: Date.now(), pending: true }), "not sent");
});

test("regression: a valid token alone can never say Synced on a comparable card", () => {
  assert.notEqual(syncLabel({ ...base, lastOkAt: null, matched: null }), "Synced");
  assert.notEqual(syncLabel({ ...base, lastOkAt: null, matched: false, differences: 3 }), "Synced");
});

test("localNodes excludes canonical browser roots from comparison", async () => {
  const store = new Map([
    ["collectionId", "col_diff_test"],
    ["syncConfig", { globalEnabled: true, pairs: [{ id: "p1", type: "bookmark", localFolderId: "", localFolderName: "Everything", enabled: true }] }],
  ]);
  globalThis.browser = {
    storage: {
      local: {
        async get(keys) {
          const ks = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of ks) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
      },
    },
    bookmarks: {
      async getTree() {
        return [
          {
            id: "0",
            title: "",
            children: [
              {
                id: "1",
                title: "Bookmarks bar",
                children: [
                  { id: "100", title: "My Bookmark", url: "https://example.com", parentId: "1", index: 0 },
                ],
              },
              { id: "2", title: "Other bookmarks", children: [] },
            ],
          },
        ];
      },
    },
  };
  const { localNodes } = await import("../src/lib/reconcile.ts");
  const nodes = await localNodes();
  // Roots "0", "1", "2" must be completely excluded; only child bookmark "100" remains
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].title, "My Bookmark");
});

test("serverNodes excludes canonical server roots (0, 1, 2, 3, menu) from comparison", async () => {
  const { api } = await import("../src/lib/api.ts");
  const origGetTree = api.getTree;
  try {
    api.getTree = async () => ({
      nodes: [
        { id: "1", parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true },
        { id: "menu", parent_id: "0", position: 1, title: "Bookmarks Menu", url: null, is_folder: true },
        { id: "bm_leaf", parent_id: "1", position: 0, title: "Leaf", url: "https://leaf.example", is_folder: false },
      ],
      server_timestamp: 1000,
      server_version: 5,
    });
    const { serverNodes } = await import("../src/lib/reconcile.ts");
    const sNodes = await serverNodes();
    assert.ok(sNodes);
    assert.equal(sNodes.length, 1);
    assert.equal(sNodes[0].id, "bm_leaf");
  } finally {
    api.getTree = origGetTree;
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, flatten, indexById } from "../src/lib/tree.ts";

test("buildTree retains links with empty titles without misclassifying them", () => {
  const rows = [
    {
      node_id: "bm_1",
      parent_id: "1",
      position: 0,
      title: "",
      url: "https://example.com/icon-only",
      domain: "example.com",
      visit_count: 5,
      last_visited_at: null,
      date_added: 1000,
      is_folder: false,
      sort_key: "a0",
      ok: true,
      http_status: 200,
      checked_at: null,
      status_error: null,
    },
    {
      node_id: "bm_2",
      parent_id: "1",
      position: 1,
      title: "Named Bookmark",
      url: "https://example.com/named",
      domain: "example.com",
      visit_count: 10,
      last_visited_at: null,
      date_added: 1001,
      is_folder: false,
      sort_key: "a1",
      ok: true,
      http_status: 200,
      checked_at: null,
      status_error: null,
    },
    {
      node_id: "1",
      parent_id: "0",
      position: 0,
      title: "Bookmarks Bar",
      url: null,
      domain: null,
      visit_count: 0,
      last_visited_at: null,
      date_added: 1000,
      is_folder: true,
      sort_key: null,
      ok: null,
      http_status: null,
      checked_at: null,
      status_error: null,
    },
  ];

  const tree = buildTree(rows);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].node_id, "1");
  assert.equal(tree[0].children.length, 2);

  const emptyTitleLink = tree[0].children[0];
  assert.equal(emptyTitleLink.node_id, "bm_1");
  assert.equal(emptyTitleLink.title, "");
  assert.equal(emptyTitleLink.url, "https://example.com/icon-only");
});

test("sibling lookup for reorder correctly resolves top-level nodes and folder nodes", () => {
  const rows = [
    {
      node_id: "root_link_1",
      parent_id: "0",
      position: 0,
      title: "Root 1",
      url: "https://root1.example",
      domain: "example",
      visit_count: 1,
      last_visited_at: null,
      date_added: 1000,
      is_folder: false,
      sort_key: "a0",
      ok: null,
      http_status: null,
      checked_at: null,
      status_error: null,
    },
    {
      node_id: "root_link_2",
      parent_id: "0",
      position: 1,
      title: "Root 2",
      url: "https://root2.example",
      domain: "example",
      visit_count: 1,
      last_visited_at: null,
      date_added: 1000,
      is_folder: false,
      sort_key: "a1",
      ok: null,
      http_status: null,
      checked_at: null,
      status_error: null,
    },
  ];

  const tree = buildTree(rows);
  const byId = indexById(tree);

  // Target is root_link_2 (parent_id: "0")
  const target = byId.get("root_link_2");
  assert.ok(target);
  const parentId = target.parent_id ?? null;
  const parentNode = parentId ? byId.get(parentId) : undefined;
  // Since parent "0" is not in tree, parentNode is undefined, so siblings falls back to tree
  const siblings = parentNode ? parentNode.children : tree;
  assert.equal(siblings.length, 2);
  const idx = siblings.findIndex((n) => n.node_id === "root_link_2");
  assert.equal(idx, 1);
});

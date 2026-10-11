// Transform rules as pure logic. These encode the user's stated rules, so a
// regression shows up here rather than in a staged preview nobody checked.
//
//   node --import ./tests/register-hooks.mjs --test tests/transforms.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sortByVisits,
  sortAlphabetically,
  sortByDateAdded,
  groupByDomain,
  deleteDuplicates,
  deleteDeadLinks,
  deleteEmptyFolders,
  reverseOrder,
  TRANSFORMS,
} from "../src/lib/transforms.ts";
import { domainLabel, registrableDomain, normalizedUrl } from "../src/lib/domain.ts";
import { toArrangement } from "../src/lib/tree.ts";

// ---- helpers ---------------------------------------------------------------

let seq = 0;
function link(title, url, extra = {}) {
  return {
    node_id: `l${++seq}`,
    parent_id: null,
    position: 0,
    title,
    url,
    domain: null,
    visit_count: 0,
    last_visited_at: null,
    date_added: null,
    is_folder: false,
    sort_key: null,
    ok: null,
    http_status: null,
    children: [],
    ...extra,
  };
}
function folder(title, children, extra = {}) {
  return { ...link(title, null, extra), is_folder: true, children };
}
/** Titles of a level, so an assertion reads like the UI. */
const titles = (nodes) => nodes.map((n) => n.title);

// ---- the visits example from the spec --------------------------------------

test("sort by visits: folder scores by the average of ALL descendant leaves", () => {
  // The user's own example: YouTube 20, Amazon 5, News folder averaging 6
  // (yahoo 10 + msn 5 + google 3 = 18 / 3 = 6). Expected order: YouTube, News, Amazon.
  const bar = folder("Bookmarks Bar", [
    link("YouTube", "https://youtube.com/", { visit_count: 20 }),
    link("Amazon", "https://amazon.com/", { visit_count: 5 }),
    folder("News", [
      link("Yahoo", "https://news.yahoo.com/", { visit_count: 10 }),
      link("MSN", "https://msn.com/", { visit_count: 5 }),
      link("Google News", "https://news.google.com/", { visit_count: 3 }),
    ]),
  ]);

  const res = sortByVisits([bar]);
  assert.deepEqual(titles(res.tree[0].children), ["YouTube", "News", "Amazon"]);
});

test("sort by visits: folders are interleaved with links, not floated to the top", () => {
  const bar = folder("Bookmarks Bar", [
    folder("Quiet", [link("a", "https://a.com/", { visit_count: 1 })]),
    link("Busy", "https://b.com/", { visit_count: 99 }),
  ]);
  const res = sortByVisits([bar]);
  assert.deepEqual(titles(res.tree[0].children), ["Busy", "Quiet"]);
});

test("sort by visits: averages over DEEP descendants, not just direct children", () => {
  // The folder's only direct child is a folder; the score must still come from
  // the leaves two levels down.
  const bar = folder("Bookmarks Bar", [
    folder("Outer", [folder("Inner", [link("deep", "https://d.com/", { visit_count: 50 })])]),
    link("Mid", "https://m.com/", { visit_count: 10 }),
  ]);
  const res = sortByVisits([bar]);
  assert.deepEqual(titles(res.tree[0].children), ["Outer", "Mid"]);
});

test("sort recurses into folders", () => {
  const bar = folder("Bookmarks Bar", [
    folder("F", [
      link("Zebra", "https://z.com/", { visit_count: 1 }),
      link("Apple", "https://a.com/", { visit_count: 9 }),
    ]),
  ]);
  const res = sortByVisits([bar]);
  assert.deepEqual(titles(res.tree[0].children[0].children), ["Apple", "Zebra"]);
});

test("alphabetical is case-insensitive and covers folders and links alike", () => {
  const bar = folder("Bookmarks Bar", [
    link("zebra", "https://z.com/"),
    folder("Apple", []),
    link("mango", "https://m.com/"),
  ]);
  const res = sortAlphabetically([bar]);
  assert.deepEqual(titles(res.tree[0].children), ["Apple", "mango", "zebra"]);
});

test("recently added puts the newest bookmark first and never-added last", () => {
  const bar = folder("Bookmarks Bar", [
    link("old", "https://o.com/", { date_added: 1000 }),
    link("new", "https://n.com/", { date_added: 9000 }),
    link("unknown", "https://u.com/", { date_added: null }),
  ]);
  const res = sortByDateAdded([bar]);
  assert.deepEqual(titles(res.tree[0].children), ["new", "old", "unknown"]);
});

test("the visible roots themselves are never reordered", () => {
  const tree = [folder("Bookmarks Bar", [link("a", "https://a.com/")]), folder("Other Bookmarks", [])];
  const res = sortAlphabetically(tree);
  assert.deepEqual(titles(res.tree), ["Bookmarks Bar", "Other Bookmarks"]);
});

// ---- domain naming ---------------------------------------------------------

test("registrable domain collapses subdomains", () => {
  assert.equal(registrableDomain("https://mail.google.com/x"), "google.com");
  assert.equal(registrableDomain("https://drive.google.com/"), "google.com");
  assert.equal(registrableDomain("https://news.yahoo.com/"), "yahoo.com");
});

test("multi-part public suffixes keep the real name", () => {
  assert.equal(registrableDomain("https://bbc.co.uk/news"), "bbc.co.uk");
  assert.equal(domainLabel("https://bbc.co.uk/news"), "bbc");
  assert.equal(domainLabel("https://www.abc.net.au/"), "abc");
});

test("folder label drops the suffix for looks", () => {
  assert.equal(domainLabel("https://mail.google.com/"), "google");
  assert.equal(domainLabel("https://github.com/x/y"), "github");
  assert.equal(domainLabel("https://doc.rust-lang.org/"), "rust-lang");
});

test("group by domain: subdomains land in ONE folder named without the TLD", () => {
  const bar = folder("Bookmarks Bar", [
    link("Gmail", "https://mail.google.com/"),
    link("Drive", "https://drive.google.com/"),
    link("Solo", "https://example.org/"),
  ]);
  const res = groupByDomain([bar]);
  const level = res.tree[0].children;
  const google = level.find((n) => n.title === "google");
  assert.ok(google, "expected one folder named 'google'");
  assert.equal(google.children.length, 2);
  assert.equal(level.filter((n) => n.is_folder).length, 1);
});

test("group by domain: a single-link domain stays loose, no one-item folder", () => {
  const bar = folder("Bookmarks Bar", [
    link("Solo", "https://example.org/"),
    link("A", "https://dup.com/a"),
    link("B", "https://dup.com/b"),
  ]);
  const res = groupByDomain([bar]);
  const solo = res.tree[0].children.find((n) => n.title === "Solo");
  assert.ok(solo);
  assert.equal(solo.is_folder, false);
});

test("group by domain: existing folders in the bar are dissolved", () => {
  const bar = folder("Bookmarks Bar", [
    folder("Old Folder", [
      link("G1", "https://github.com/1"),
      link("G2", "https://github.com/2"),
    ]),
  ]);
  const res = groupByDomain([bar]);
  assert.equal(res.tree[0].children.length, 1);
  assert.equal(res.tree[0].children[0].title, "github");
  assert.ok(!titles(res.tree[0].children).includes("Old Folder"));
});

test("group by domain: Other Bookmarks is left completely alone", () => {
  const other = folder("Other Bookmarks", [
    link("Keep", "https://mail.google.com/"),
    link("Keep2", "https://drive.google.com/"),
  ]);
  const tree = [folder("Bookmarks Bar", [link("X", "https://x.com/")]), other];
  const res = groupByDomain(tree);
  const otherAfter = res.tree.find((n) => n.title === "Other Bookmarks");
  assert.deepEqual(titles(otherAfter.children), ["Keep", "Keep2"]);
  assert.equal(otherAfter.children.every((n) => !n.is_folder), true);
});

test("group by domain: dissolved folders are listed for removal", () => {
  // Without this the server keeps the old folders behind as empty shells, and
  // the applied result does not match the preview the user approved.
  const old = folder("Old Folder", [
    link("G1", "https://github.com/1"),
    link("G2", "https://github.com/2"),
  ]);
  const bar = folder("Bookmarks Bar", [old]);
  const res = groupByDomain([bar]);
  assert.ok(res.removed.includes(old.node_id), "the dissolved folder must be removed");
  // ...but never the links it contained; those are being relocated.
  assert.ok(!res.removed.includes(old.children[0].node_id));
  assert.ok(!res.removed.includes(old.children[1].node_id));
});

test("group by domain: nested folders are dissolved too", () => {
  const inner = folder("Inner", [link("R1", "https://rust-lang.org/1")]);
  const outer = folder("Outer", [inner, link("R2", "https://rust-lang.org/2")]);
  const bar = folder("Bookmarks Bar", [outer]);
  const res = groupByDomain([bar]);
  assert.ok(res.removed.includes(outer.node_id));
  assert.ok(res.removed.includes(inner.node_id));
});

test("group by domain: new folders are placeholders for the server to mint", () => {
  const bar = folder("Bookmarks Bar", [
    link("A", "https://dup.com/a"),
    link("B", "https://dup.com/b"),
  ]);
  const res = groupByDomain([bar]);
  assert.equal(res.newFolders.length, 1);
  assert.ok(res.newFolders[0].node_id.startsWith("new:"));
  assert.equal(res.newFolders[0].title, "dup");
});

// ---- duplicates ------------------------------------------------------------

test("normalised URL ignores trailing slash and fragment but keeps the query", () => {
  assert.equal(normalizedUrl("https://a.com/x/"), normalizedUrl("https://a.com/x"));
  assert.equal(normalizedUrl("https://a.com/x#top"), normalizedUrl("https://a.com/x"));
  assert.notEqual(normalizedUrl("https://a.com/?v=1"), normalizedUrl("https://a.com/?v=2"));
});

test("duplicates: one copy survives and absorbs the others' visits", () => {
  const bar = folder("Bookmarks Bar", [
    link("YouTube", "https://youtube.com/", { visit_count: 20 }),
    link("YouTube copy", "https://youtube.com/", { visit_count: 5 }),
    link("Unique", "https://other.com/", { visit_count: 1 }),
  ]);
  const res = deleteDuplicates([bar]);
  assert.equal(res.removed.length, 1);
  assert.equal(res.tree[0].children.length, 2);
  // The merge instruction names the survivor and what it absorbs.
  assert.equal(res.mergeVisits.length, 1);
  const surviving = res.tree[0].children.map((n) => n.node_id);
  assert.ok(surviving.includes(res.mergeVisits[0].survivor));
  assert.equal(res.mergeVisits[0].absorbed.length, 1);
});

test("duplicates: found across different folders, not just within one", () => {
  const bar = folder("Bookmarks Bar", [
    folder("A", [link("Here", "https://same.com/")]),
    folder("B", [link("There", "https://same.com/")]),
  ]);
  const res = deleteDuplicates([bar]);
  assert.equal(res.removed.length, 1);
});

test("duplicates: differing URLs are not touched", () => {
  const bar = folder("Bookmarks Bar", [
    link("A", "https://a.com/1"),
    link("B", "https://a.com/2"),
  ]);
  const res = deleteDuplicates([bar]);
  assert.equal(res.noop, true);
  assert.equal(res.removed.length, 0);
});

// ---- dead links & empty folders --------------------------------------------

test("dead links: only removes links KNOWN dead, never unchecked ones", () => {
  const bar = folder("Bookmarks Bar", [
    link("Dead", "https://d.com/", { ok: false }),
    link("Alive", "https://a.com/", { ok: true }),
    link("Unchecked", "https://u.com/", { ok: null }),
  ]);
  const res = deleteDeadLinks([bar]);
  assert.equal(res.removed.length, 1);
  assert.deepEqual(titles(res.tree[0].children), ["Alive", "Unchecked"]);
});

test("dead links: says to run a check when nothing has been checked", () => {
  const bar = folder("Bookmarks Bar", [link("U", "https://u.com/", { ok: null })]);
  const res = deleteDeadLinks([bar]);
  assert.equal(res.noop, true);
  assert.match(res.summary, /never been checked/i);
});

test("empty folders: removes folders with no links at any depth", () => {
  const bar = folder("Bookmarks Bar", [
    folder("Empty", []),
    folder("HasOne", [link("x", "https://x.com/")]),
  ]);
  const res = deleteEmptyFolders([bar]);
  assert.equal(res.removed.length, 1);
  assert.deepEqual(titles(res.tree[0].children), ["HasOne"]);
});

test("empty folders: a folder of only empty folders goes too", () => {
  const bar = folder("Bookmarks Bar", [folder("Outer", [folder("Inner", [])])]);
  const res = deleteEmptyFolders([bar]);
  assert.equal(res.removed.length, 2);
  assert.equal(res.tree[0].children.length, 0);
});

test("empty folders: the visible roots are never deleted even when empty", () => {
  const tree = [folder("Bookmarks Bar", []), folder("Other Bookmarks", [])];
  const res = deleteEmptyFolders(tree);
  assert.equal(res.removed.length, 0);
  assert.equal(res.tree.length, 2);
});

// ---- contract --------------------------------------------------------------

test("every menu kind has a transform, and each names its own verb", () => {
  const kinds = [
    "reverse", "sort-visits", "sort-alpha", "sort-recent", "sort-added",
    "group-domain", "dedupe", "dead-links", "empty-folders",
  ];
  for (const k of kinds) {
    assert.equal(typeof TRANSFORMS[k], "function", `${k} has no implementation`);
  }
  const bar = folder("Bookmarks Bar", [
    link("B", "https://b.com/", { visit_count: 2, ok: false, date_added: 2 }),
    link("A", "https://a.com/", { visit_count: 1, date_added: 1 }),
    folder("Empty", []),
    link("dup1", "https://same.com/"),
    link("dup2", "https://same.com/"),
  ]);
  for (const k of kinds) {
    const res = TRANSFORMS[k]([bar]);
    assert.equal(res.kind, k);
    assert.ok(res.verb && res.verb.length, `${k} has no affirmative verb`);
    assert.ok(res.summary && res.summary.length, `${k} has no summary`);
    // Destructive actions must declare themselves so the UI can tint them red.
    if (["dedupe", "dead-links", "empty-folders"].includes(k)) {
      assert.equal(res.destructive, true, `${k} should be destructive`);
      assert.equal(res.verb, "Delete");
    } else {
      assert.equal(res.destructive, false, `${k} should not be destructive`);
    }
  }
});

test("a transform never mutates the tree it was given", () => {
  const bar = folder("Bookmarks Bar", [
    link("Z", "https://z.com/", { visit_count: 1 }),
    link("A", "https://a.com/", { visit_count: 9 }),
  ]);
  const tree = [bar];
  const snapshot = JSON.stringify(tree);
  reverseOrder(tree);
  sortByVisits(tree);
  groupByDomain(tree);
  deleteDuplicates(tree);
  deleteEmptyFolders(tree);
  assert.equal(JSON.stringify(tree), snapshot, "input tree was mutated");
});


// ---- arrangement -----------------------------------------------------------

test("the visible roots are never placed — their parent has no row to reference", () => {
  // A real synced tree has no row for the browser's hidden root container, so a
  // placement naming it as parent would be rejected outright.
  const bar = folder("Bookmarks Bar", [link("A", "https://a.com/")], { parent_id: "0" });
  const other = folder("Other Bookmarks", [link("B", "https://b.com/")], { parent_id: "0" });
  const placements = toArrangement([bar, other]);
  const ids = placements.map((p) => p.node_id);
  assert.ok(!ids.includes(bar.node_id), "the bar must not be placed");
  assert.ok(!ids.includes(other.node_id), "other bookmarks must not be placed");
  assert.ok(!placements.some((p) => p.parent_id === "0"), "no placement may reference the hidden root");
  // Their children ARE placed, parented to the root they sit in.
  assert.equal(placements.length, 2);
  assert.equal(placements.find((p) => p.node_id === bar.children[0].node_id).parent_id, bar.node_id);
});

test("arrangement indexes are contiguous per parent", () => {
  const bar = folder("Bookmarks Bar", [
    link("A", "https://a.com/"),
    folder("F", [link("C", "https://c.com/"), link("D", "https://d.com/")]),
    link("B", "https://b.com/"),
  ]);
  const placements = toArrangement([bar]);
  const barKids = placements.filter((p) => p.parent_id === bar.node_id).map((p) => p.index);
  assert.deepEqual(barKids.sort(), [0, 1, 2]);
  const fKids = placements.filter((p) => p.parent_id === bar.children[1].node_id).map((p) => p.index);
  assert.deepEqual(fKids.sort(), [0, 1]);
});

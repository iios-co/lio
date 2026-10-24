// Fresh-install content merge: matching by CONTENT (not id), with a uniqueness
// guard so deliberate duplicates are never falsely collapsed.
//
//   node --import ./tests/register-hooks.mjs --test tests/merge.test.mjs
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { planMerge } from "../src/lib/merge.ts";

// A link node.
const link = (id, parentId, title, url) => ({
  id, parentId, title, url, isFolder: false,
});
const folder = (id, parentId, title) => ({
  id, parentId, title, url: null, isFolder: true,
});

test("identical content under different ids matches (the fresh-install case)", () => {
  // Server has 3 links from device A (ids s*); fresh browser has the SAME 3
  // links under ids l*. A merge must pair them, not duplicate.
  const local = [
    link("l1", "1", "Alpha", "https://alpha.example/"),
    link("l2", "1", "Beta", "https://beta.example/"),
    link("l3", "1", "Gamma", "https://gamma.example/"),
  ];
  const server = [
    link("s1", "1", "Alpha", "https://alpha.example/"),
    link("s2", "1", "Beta", "https://beta.example/"),
    link("s3", "1", "Gamma", "https://gamma.example/"),
  ];
  const p = planMerge(local, server);
  assert.equal(p.matches.length, 3, "all three should match by content");
  assert.equal(p.localOnly.length, 0, "nothing local-only");
  assert.equal(p.serverPull.length, 0, "nothing server-only to pull");
  assert.equal(p.ambiguousLinks, 0);
});

test("browser extras are pushed, server extras are pulled", () => {
  const local = [
    link("l1", "1", "Alpha", "https://alpha.example/"),
    link("l2", "1", "LocalOnly", "https://localonly.example/"),
  ];
  const server = [
    link("s1", "1", "Alpha", "https://alpha.example/"),
    link("s2", "1", "ServerOnly", "https://serveronly.example/"),
  ];
  const p = planMerge(local, server);
  assert.equal(p.matches.length, 1);
  assert.deepEqual(p.localOnly, ["l2"], "browser-only link pushed up");
  assert.deepEqual(p.serverPull, ["s2"], "server-only link pulled down");
});

test("the 120-vs-100 case: 100 overlap merges, 20 extras push, total 120", () => {
  const local = [];
  const server = [];
  for (let i = 0; i < 100; i++) {
    local.push(link(`l${i}`, "1", `Site ${i}`, `https://site${i}.example/`));
    server.push(link(`s${i}`, "1", `Site ${i}`, `https://site${i}.example/`));
  }
  for (let i = 100; i < 120; i++) {
    local.push(link(`l${i}`, "1", `Extra ${i}`, `https://extra${i}.example/`));
  }
  const p = planMerge(local, server);
  assert.equal(p.matches.length, 100, "the 100 overlapping links merge");
  assert.equal(p.localOnly.length, 20, "the 20 browser-only links push");
  assert.equal(p.serverPull.length, 0, "server has nothing the browser lacks");
  // After the merge the union is 120, not 220.
  assert.equal(p.matches.length + p.localOnly.length + p.serverPull.length, 120);
});

test("a deliberate duplicate is matched 1-to-1 via multiset pairing without count growth", () => {
  // The user bookmarked alpha.example TWICE in both trees.
  // Multiset pairing pairs l1->s1 and l2->s2 deterministically so neither side duplicates.
  const local = [
    link("l1", "1", "Alpha", "https://alpha.example/"),
    link("l2", "1", "Alpha", "https://alpha.example/"),
  ];
  const server = [
    link("s1", "1", "Alpha", "https://alpha.example/"),
    link("s2", "1", "Alpha", "https://alpha.example/"),
  ];
  const p = planMerge(local, server);
  assert.equal(p.matches.length, 2, "both duplicate pairs are matched 1-to-1");
  assert.equal(p.localOnly.length, 0, "no local duplicates are pushed");
  assert.equal(p.serverPull.length, 0, "no server duplicates are pulled");
});

test("a trailing slash does not defeat matching", () => {
  const local = [link("l1", "1", "Alpha", "https://alpha.example")];
  const server = [link("s1", "1", "Alpha", "https://alpha.example/")];
  assert.equal(planMerge(local, server).matches.length, 1);
});

test("the same url in a DIFFERENT folder is a different link", () => {
  const local = [
    folder("lf", "1", "Work"),
    link("l1", "lf", "Doc", "https://doc.example/"),
  ];
  const server = [
    folder("sf", "1", "Personal"),
    link("s1", "sf", "Doc", "https://doc.example/"),
  ];
  const p = planMerge(local, server);
  assert.equal(p.matches.length, 0, "different folder path => not the same link");
});

test("matched under the same-named folder in both trees", () => {
  const local = [
    folder("lf", "1", "Work"),
    link("l1", "lf", "Doc", "https://doc.example/"),
  ];
  const server = [
    folder("sf", "1", "Work"),
    link("s1", "sf", "Doc", "https://doc.example/"),
  ];
  const p = planMerge(local, server);
  assert.equal(p.matches.length, 1, "same folder title => same link");
  // The server folder is redundant (its only link matched) so it is NOT pulled.
  assert.equal(p.serverPull.length, 0, "redundant server folder is not re-created");
});

test("a server folder holding an unmatched link IS pulled", () => {
  const local = [link("l1", "1", "Alpha", "https://alpha.example/")];
  const server = [
    link("s1", "1", "Alpha", "https://alpha.example/"),
    folder("sf", "1", "Research"),
    link("s2", "sf", "Paper", "https://paper.example/"),
  ];
  const p = planMerge(local, server);
  assert.equal(p.matches.length, 1);
  // Parents before children — and exactly the folder plus its unmatched link.
  assert.deepEqual(p.serverPull, ["sf", "s2"],
    "the folder is pulled before its unmatched link");
});

test("title is part of the content key (same url, different title)", () => {
  // Same url but the user renamed one — treat as different so neither is lost.
  const local = [link("l1", "1", "Alpha", "https://alpha.example/")];
  const server = [link("s1", "1", "Alpha RENAMED", "https://alpha.example/")];
  const p = planMerge(local, server);
  assert.equal(p.matches.length, 0, "differing title is not auto-merged");
});

test("empty trees produce an empty plan", () => {
  const p = planMerge([], []);
  assert.equal(p.matches.length, 0);
  assert.equal(p.localOnly.length, 0);
  assert.equal(p.serverPull.length, 0);
});

test("500 existing server links + new browser with 200 identical and 100 new links merges to 600", () => {
  // Server has 500 links parented under "1" (server DB never stores row for "1" itself).
  // Fresh browser tree includes the Bookmarks bar folder node "1", 200 identical links, and 100 new links.
  const server = [];
  for (let i = 0; i < 500; i++) {
    server.push(link(`s_${i}`, "1", `Link ${i}`, `https://example.com/${i}`));
  }

  const local = [
    folder("1", "0", "Bookmarks bar"),
  ];
  for (let i = 0; i < 200; i++) {
    local.push(link(`l_${i}`, "1", `Link ${i}`, `https://example.com/${i}`));
  }
  for (let i = 500; i < 600; i++) {
    local.push(link(`l_${i}`, "1", `Link ${i}`, `https://example.com/${i}`));
  }

  const p = planMerge(local, server, { "1": "1" });
  assert.equal(p.matches.length, 200, "200 identical links match");
  assert.equal(p.localOnly.length, 100, "100 new links pushed from browser");
  assert.equal(p.serverPull.length, 300, "300 existing server links pulled into browser");
  assert.equal(server.length + p.localOnly.length, 600, "Collection size must grow to 600, not 800");
  assert.equal(local.filter((n) => !n.isFolder).length + p.serverPull.length, 600, "Browser size must grow to 600, not 800");
});

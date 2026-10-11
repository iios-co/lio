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

test("a deliberate duplicate is NEVER falsely collapsed", () => {
  // The user bookmarked alpha.example TWICE in both trees. The content key is
  // ambiguous on both sides, so none of them may be matched — collapsing them
  // would lose a link the user wanted twice.
  const local = [
    link("l1", "1", "Alpha", "https://alpha.example/"),
    link("l2", "1", "Alpha", "https://alpha.example/"),
  ];
  const server = [
    link("s1", "1", "Alpha", "https://alpha.example/"),
    link("s2", "1", "Alpha", "https://alpha.example/"),
  ];
  const p = planMerge(local, server);
  assert.equal(p.matches.length, 0, "ambiguous content is not matched");
  assert.ok(p.ambiguousLinks > 0, "ambiguity is reported, not silently merged");
  assert.deepEqual(p.localOnly, ["l1", "l2"], "both local copies are kept");
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

// Unit test for the robust bookmark move-apply. Runnable with (Node 23.6+ runs
// TS natively):  node --test tests/reorder.test.mjs   (from lio-plugin/)
//
// Simulates both engine semantics for browser.bookmarks.move and asserts that a
// web-UI reorder (final target index) lands the node exactly, via at most one
// corrective move.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMove, clampIndex } from "../src/lib/reorderPlan.ts";

// A mock parent folder whose move() reproduces one engine's index semantics.
function makeParent(ids, semantics /* "chrome" | "firefox" */) {
  const arr = [...ids];
  return {
    order: () => arr.slice(),
    api: {
      async get(id) {
        const index = arr.indexOf(id);
        return index < 0 ? [] : [{ index, parentId: "p" }];
      },
      async move(id, { index }) {
        const from = arr.indexOf(id);
        if (from < 0) return {};
        arr.splice(from, 1);
        let insertAt = index;
        // Chrome: same-parent move to a higher index lands one slot short.
        if (semantics === "chrome" && from < index) insertAt = index - 1;
        if (insertAt < 0) insertAt = 0;
        if (insertAt > arr.length) insertAt = arr.length;
        arr.splice(insertAt, 0, id);
        return {};
      },
      async getChildren(parentId) {
        return arr.map((id, index) => ({ id, index, parentId }));
      },
    },
  };
}

test("clampIndex bounds the index", () => {
  assert.equal(clampIndex(-3, 5), 0);
  assert.equal(clampIndex(9, 5), 5);
  assert.equal(clampIndex(2, 5), 2);
});

for (const sem of ["chrome", "firefox"]) {
  test(`move down converges (${sem})`, async () => {
    const p = makeParent(["a", "b", "c", "d", "e"], sem);
    await applyMove(p.api, { nodeId: "a", parentId: "p", targetIndex: 3 });
    assert.deepEqual(p.order(), ["b", "c", "d", "a", "e"]);
  });

  test(`move up converges (${sem})`, async () => {
    const p = makeParent(["a", "b", "c", "d", "e"], sem);
    await applyMove(p.api, { nodeId: "e", parentId: "p", targetIndex: 0 });
    assert.deepEqual(p.order(), ["e", "a", "b", "c", "d"]);
  });

  test(`move to end converges (${sem})`, async () => {
    const p = makeParent(["a", "b", "c"], sem);
    await applyMove(p.api, { nodeId: "a", parentId: "p", targetIndex: 2 });
    assert.deepEqual(p.order(), ["b", "c", "a"]);
  });

  test(`no-op move stays put (${sem})`, async () => {
    const p = makeParent(["a", "b", "c"], sem);
    await applyMove(p.api, { nodeId: "b", parentId: "p", targetIndex: 1 });
    assert.deepEqual(p.order(), ["a", "b", "c"]);
  });
}

test("target index beyond length clamps to sibling count with getChildren", async () => {
  let landed = 0;
  const indices = [];
  const fakeApi = {
    async getChildren() {
      return [{}, {}, {}];
    },
    async move(_id, { index }) {
      indices.push(index);
      landed = index;
      return {};
    },
    async get() {
      return [{ index: landed, parentId: "p" }];
    },
  };
  await applyMove(fakeApi, { nodeId: "a", parentId: "p", targetIndex: 99 });
  assert.deepEqual(indices, [3], "Must clamp to 3 with zero corrective move when landed matches effective target");
});

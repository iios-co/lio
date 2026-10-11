// P8 regression test: concurrent createSyncOp calls must produce distinct operationIds
// Run: node --import ./tests/register-hooks.mjs --test tests/sync-op.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map([
  ["endpoint", "http://test.local"],
  ["token", "tok123"],
  ["deviceId", "dev_test"],
  ["clientSeq", 0],
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
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
    },
  },
};

const { createSyncOp } = await import("../src/lib/bookmarks.ts");

test("50 concurrent createSyncOp calls produce 50 distinct operationIds and sequences", async () => {
  const promises = Array.from({ length: 50 }, (_, i) =>
    createSyncOp(`node_${i}`, "create", { title: `Bookmark ${i}` })
  );

  const results = await Promise.all(promises);

  assert.equal(results.length, 50);

  const opIds = new Set(results.map((r) => r.operationId));
  assert.equal(opIds.size, 50, "All 50 operationIds must be distinct");

  const seqs = new Set(results.map((r) => r.clientSequence));
  assert.equal(seqs.size, 50, "All 50 clientSequences must be distinct");
});

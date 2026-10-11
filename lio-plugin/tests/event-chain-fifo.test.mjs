// Tests for eventChain FIFO ordering and error propagation
// Run: node --import ./tests/register-hooks.mjs --test tests/event-chain-fifo.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { enqueueBookmarkEvent, drainBookmarkEvents } = await import("../src/lib/bookmarks.ts");

test("enqueueBookmarkEvent executes tasks in strict FIFO order", async () => {
  const executionOrder = [];

  enqueueBookmarkEvent(async () => {
    await new Promise((r) => setTimeout(r, 15));
    executionOrder.push("first");
  });

  enqueueBookmarkEvent(async () => {
    await new Promise((r) => setTimeout(r, 5));
    executionOrder.push("second");
  });

  enqueueBookmarkEvent(async () => {
    executionOrder.push("third");
  });

  await drainBookmarkEvents();

  assert.deepEqual(executionOrder, ["first", "second", "third"], "Events must settle strictly in FIFO order");
});

test("drainBookmarkEvents throws captured error and clears state for subsequent events", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    enqueueBookmarkEvent(async () => {
      throw new Error("Bookmark mutation failed");
    });

    await assert.rejects(
      async () => {
        await drainBookmarkEvents();
      },
      { message: "Bookmark mutation failed" }
    );
  } finally {
    console.error = originalError;
  }
  // Subsequent event must execute without being blocked
  let recovered = false;
  enqueueBookmarkEvent(async () => {
    recovered = true;
  });

  await drainBookmarkEvents();
  assert.equal(recovered, true, "Subsequent events must run cleanly after error is drained");
});

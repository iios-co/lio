// Unit test for production SyncCoordinator
// Run: node --import ./tests/register-hooks.mjs --test tests/sync-coordinator.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { SyncCoordinator } = await import("../src/lib/syncCoordinator.ts");

test("SyncCoordinator coalesces concurrent requests into ordered single-flight cycles", async () => {
  let executions = 0;
  let drains = 0;

  const drainFn = async () => {
    drains++;
  };

  const runFn = async () => {
    executions++;
    await new Promise((r) => setTimeout(r, 15));
  };

  const coordinator = new SyncCoordinator(drainFn, runFn);

  // 1. Initial request triggers cycle 1
  const p1 = coordinator.requestSync();

  // 2. Second request arrives during flight of cycle 1
  await new Promise((r) => setTimeout(r, 5));
  const p2 = coordinator.requestSync();

  await Promise.all([p1, p2]);

  assert.equal(executions, 2, "Expected cycle 1 in flight + cycle 2 for subsequent request");
  assert.equal(drains, 2, "drainFn must run before each sync cycle");
});

test("SyncCoordinator handles requests arriving during loop shutdown without dropping them", async () => {
  let executions = 0;
  let hookFired = false;

  let coordinator;

  const drainFn = async () => {};
  const runFn = async () => {
    executions++;
    await new Promise((r) => setTimeout(r, 10));
    if (!hookFired) {
      hookFired = true;
      // Request arrives while runLoop is finishing this cycle
      void coordinator.requestSync();
    }
  };

  coordinator = new SyncCoordinator(drainFn, runFn);

  await coordinator.requestSync();
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(executions, 2, "Request arriving at loop completion must execute a follow-up cycle");
});

test("SyncCoordinator retries after a run failure and allows future requests to succeed", async () => {
  let attempts = 0;
  let shouldFail = true;

  const drainFn = async () => {};
  const runFn = async () => {
    attempts++;
    if (shouldFail) {
      shouldFail = false;
      throw new Error("Network offline");
    }
  };

  const coordinator = new SyncCoordinator(drainFn, runFn);

  // First request fails
  await assert.rejects(
    async () => {
      await coordinator.requestSync();
    },
    { message: "Network offline" }
  );

  // Coordinator is not permanently stuck; next request succeeds
  await coordinator.requestSync();
  assert.equal(attempts, 2, "Coordinator must recover and execute next request cleanly");
});

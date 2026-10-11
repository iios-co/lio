// The label rules, extracted as pure logic and tested. Every case here is a bug
// that actually shipped:
//
//  * "Synced" shown while OFFLINE (label derived from "token is valid").
//  * "not synced yet" shown on a card whose own sub-line said "sent just now"
//    (card ignored its own evidence and read the global cycle timestamp).
//  * "11 queued" shown on the tabs card, which owns no queue at all.
//
// Run: node --import ./tests/register-hooks.mjs --test tests/state-label.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { syncLabel, tabsPending } from "../src/lib/stateLabel.ts";

const base = {
  enabled: true, reachable: true, tokenValid: true,
  busy: false, queued: 0, lastOkAt: 1000, pending: false,
};

test("offline can never read Synced", () => {
  assert.equal(syncLabel({ ...base, reachable: false }), "offline");
  assert.equal(syncLabel({ ...base, reachable: false, lastOkAt: 999999 }), "offline");
});

test("invalid token can never read Synced", () => {
  assert.equal(syncLabel({ ...base, tokenValid: false }), "no valid token");
});

test("a valid token alone is NOT evidence of a sync", () => {
  assert.equal(syncLabel({ ...base, lastOkAt: null }), "not synced yet");
});

test("Synced requires this card's own work to have succeeded", () => {
  assert.equal(syncLabel({ ...base, lastOkAt: 1234 }), "Synced");
});

test("in-progress work beats a stale success", () => {
  assert.equal(syncLabel({ ...base, busy: true }), "Syncing");
});

test("unsent local state reads 'not sent', never Synced", () => {
  assert.equal(syncLabel({ ...base, pending: true }), "not sent");
});

test("queued work is reported", () => {
  assert.equal(syncLabel({ ...base, queued: 3 }), "3 queued");
});

test("paused is reported before any success claim", () => {
  assert.equal(syncLabel({ ...base, enabled: false }), "paused");
});

test("closing tabs offline leaves the tabs card pending, not synced", () => {
  assert.equal(tabsPending(20, { at: 1, count: 23 }), true);
  assert.equal(syncLabel({ ...base, reachable: false, pending: true }), "offline");
});

test("tabs are only 'sent' when the pushed count matches what is on screen", () => {
  assert.equal(tabsPending(20, { at: 1, count: 20 }), false);
  assert.equal(tabsPending(20, null), true, "never pushed = pending");
});

// ---- regressions for the "sent just now / not synced yet" contradiction ----

test("a card with its own successful push reads Synced, regardless of the sync cycle", () => {
  // The tabs card pushed 20 tabs and 20 are on screen. The 60s bookmark cycle
  // may not have completed yet — that is not this card's business.
  const pushed = { at: 5_000, count: 20 };
  assert.equal(
    syncLabel({ ...base, lastOkAt: pushed.at, queued: 0, pending: tabsPending(20, pushed) }),
    "Synced"
  );
});

test("a card must NOT report another card's queue", () => {
  // 11 bookmark ops are queued; the tabs card owns no queue, so it passes 0 and
  // must still report its own truth.
  const tabsCard = syncLabel({ ...base, queued: 0, lastOkAt: 7_000 });
  assert.equal(tabsCard, "Synced");
  const bookmarksCard = syncLabel({ ...base, queued: 11, lastOkAt: null });
  assert.equal(bookmarksCard, "11 queued");
});

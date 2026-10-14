// UI Popup Rendering & Branch Tests:
// Directly tests the production-exported resolvePopupBannerMode from src/lib/popupBanner.ts
// Verifies that:
// 1. When sync is active or gate closed: banner is completely hidden ("hidden")
// 2. When sync is paused normally: mode is "resume" (Resume rendered, Restore NEVER rendered)
// 3. When recoveryRequired with tombstone_rejection is present: mode is "recovery" (Resume HIDDEN, Restore rendered)

import { test } from "node:test";
import assert from "node:assert/strict";

const { resolvePopupBannerMode } = await import("../src/lib/popupBanner.ts");

test("popup banner: active sync or closed gate hides the banner completely", () => {
  assert.equal(
    resolvePopupBannerMode({ globalEnabled: true, gateClosed: false, recoveryRequired: null }),
    "hidden",
    "Banner must be hidden when sync is active"
  );
  assert.equal(
    resolvePopupBannerMode({ globalEnabled: false, gateClosed: true, recoveryRequired: null }),
    "hidden",
    "Banner must be hidden when gate is closed"
  );
});

test("popup banner: ordinary pause renders Resume only, never Restore", () => {
  const mode = resolvePopupBannerMode({
    globalEnabled: false,
    gateClosed: false,
    recoveryRequired: null,
  });

  assert.equal(mode, "resume", "Ordinary pause must enter resume mode (Resume button only)");
});

test("popup banner: tombstone rejection enters recovery mode, hiding Resume", () => {
  const mode = resolvePopupBannerMode({
    globalEnabled: false,
    gateClosed: false,
    recoveryRequired: {
      reason: "tombstone_rejection",
      applied: 0,
      skipped: 839,
      localNodeCount: 839,
      localLinkCount: 838,
      serverNodeCount: 0,
      timestamp: 123456789,
    },
  });
  assert.equal(mode, "recovery", "Tombstone rejection must enter recovery mode, hiding resume button");
});

test("popup banner: bootstrap_needed enters bootstrap mode with three-way choices", () => {
  const mode = resolvePopupBannerMode({
    globalEnabled: false,
    gateClosed: false,
    recoveryRequired: {
      reason: "bootstrap_needed",
      applied: 0,
      skipped: 0,
      localNodeCount: 839,
      localLinkCount: 838,
      serverNodeCount: 838,
      timestamp: 123456789,
    },
  });

  assert.equal(mode, "bootstrap", "bootstrap_needed must enter bootstrap mode");
});

test("popup banner: unstable_server_tree enters bootstrap mode with three-way choices", () => {
  const mode = resolvePopupBannerMode({
    globalEnabled: false,
    gateClosed: false,
    recoveryRequired: {
      reason: "unstable_server_tree",
      timestamp: 123456789,
      detail: "Transient tree mismatch",
    },
  });

  assert.equal(mode, "bootstrap", "unstable_server_tree must enter bootstrap mode");
});

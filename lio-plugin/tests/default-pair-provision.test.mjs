import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureOnboardingBookmarkPair } from "../src/lib/config.ts";

test("ensureOnboardingBookmarkPair auto-provisions Everything pair on onboarding with no bookmark pairs", () => {
  const emptySync = { globalEnabled: true, pairs: [] };

  const result = ensureOnboardingBookmarkPair(emptySync, true);
  assert.equal(result.provisioned, true);
  assert.equal(result.sync.pairs.length, 1);
  assert.equal(result.sync.pairs[0].id, "p_everything");
  assert.equal(result.sync.pairs[0].localFolderName, "Everything");
  assert.equal(result.sync.pairs[0].enabled, true);
});

test("ensureOnboardingBookmarkPair does NOT provision when not onboarding (settings reconnect)", () => {
  const emptySync = { globalEnabled: true, pairs: [] };

  const result = ensureOnboardingBookmarkPair(emptySync, false);
  assert.equal(result.provisioned, false);
  assert.equal(result.sync.pairs.length, 0);
});

test("ensureOnboardingBookmarkPair preserves intentionally disabled bookmark pairs", () => {
  const disabledPair = {
    id: "custom_pair",
    type: "bookmark",
    localFolderId: "123",
    localFolderName: "My Folder",
    collectionPath: "/My Folder",
    enabled: false,
  };
  const syncWithDisabled = { globalEnabled: true, pairs: [disabledPair] };

  const result = ensureOnboardingBookmarkPair(syncWithDisabled, true);
  assert.equal(result.provisioned, false);
  assert.equal(result.sync.pairs.length, 1);
  assert.equal(result.sync.pairs[0].id, "custom_pair");
  assert.equal(result.sync.pairs[0].enabled, false);
});

test("ensureOnboardingBookmarkPair does not duplicate on repeated onboarding", () => {
  const existingPair = {
    id: "p_everything",
    type: "bookmark",
    localFolderId: "",
    localFolderName: "Everything",
    collectionPath: "/",
    enabled: true,
  };
  const syncWithExisting = { globalEnabled: true, pairs: [existingPair] };

  const result = ensureOnboardingBookmarkPair(syncWithExisting, true);
  assert.equal(result.provisioned, false);
  assert.equal(result.sync.pairs.length, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map([
  ["endpoint", "http://test.local"],
  ["token", "tok123"],
  ["collectionId", "col_safeguards"],
  ["lio_migrated_col_safeguards", true],
  ["deviceId", "dev_test"],
  ["syncConfig", {
    globalEnabled: true,
    pairs: [{ id: "p1", type: "bookmark", localFolderId: "1", localFolderName: "Bookmarks bar", collectionPath: "", enabled: true }],
  }],
]);

let localBookmarks = new Map();
function resetLocalTree() {
  localBookmarks = new Map([
    ["0", { id: "0", title: "", parentId: undefined, index: 0, children: ["1"] }],
    ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0, children: ["b1"] }],
    ["b1", { id: "b1", title: "Keep Me", url: "https://keep.example/", parentId: "1", index: 0 }],
  ]);
}
resetLocalTree();

let createCalls = [];
let removeCalls = [];

globalThis.browser = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) {
          return Object.fromEntries(store.entries());
        }
        const ks = Array.isArray(keys) ? keys : [keys];
        const res = {};
        for (const k of ks) if (store.has(k)) res[k] = store.get(k);
        return res;
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) store.set(k, v);
      },
      async remove(keys) {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) store.delete(k);
      },
    },
  },
  bookmarks: {
    async getTree() {
      return [{
        id: "0",
        title: "",
        children: [{
          id: "1",
          title: "Bookmarks bar",
          children: [{ id: "b1", title: "Keep Me", url: "https://keep.example/", parentId: "1", index: 0 }],
        }],
      }];
    },
    async get(id) {
      const b = localBookmarks.get(id);
      return b ? [b] : [];
    },
    async getChildren(parentId) {
      const out = [];
      for (const b of localBookmarks.values()) {
        if (b.parentId === parentId) out.push(b);
      }
      return out;
    },
    async create(arg) {
      createCalls.push(arg);
      const id = "mock_created_" + (createCalls.length);
      const node = { id, title: arg.title ?? "", url: arg.url, parentId: arg.parentId, index: arg.index ?? 0 };
      localBookmarks.set(id, node);
      return node;
    },
    async remove(id) {
      removeCalls.push(id);
      localBookmarks.delete(id);
    },
    async removeTree(id) {
      removeCalls.push(id);
      localBookmarks.delete(id);
    },
  },
};

const { api } = await import("../src/lib/api.ts");
const {
  reconcileFromServer,
  syncTransaction,
  onCreated,
  onRemoved,
  drainBookmarkEvents,
} = await import("../src/lib/bookmarks.ts");
const { getServerId, getLocalId, setMapping, clearMappings, clearMemoryCache } = await import("../src/lib/idMap.ts");
const { peek, clear } = await import("../src/lib/queue.ts");
const { resetGate } = await import("../src/lib/gate.ts");
test("reconcileFromServer: stale snapshot version sets unstable_server_tree and causes ZERO mutations", async () => {
  createCalls = [];
  removeCalls = [];
  resetLocalTree();
  clearMemoryCache();
  await clearMappings("col_safeguards");
  await clear();
  store.set("syncConfig", { ...store.get("syncConfig"), globalEnabled: true });
  store.delete("recoveryRequired");

  api.info = async () => ({
    id: "col_safeguards",
    bookmark_count: 0,
    folder_count: 1,
  });

  let callCount = 0;
  api.getTree = async () => {
    callCount++;
    return {
      server_version: 5, // Below minimum 10
      server_timestamp: 1000,
      nodes: [{ id: "1", parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true }],
    };
  };

  const res = await reconcileFromServer({ minimumServerVersion: 10 });
  assert.equal(res.deleted, 0);
  assert.equal(res.created, 0);
  assert.equal(createCalls.length, 0, "Zero local creations attempted");
  assert.equal(removeCalls.length, 0, "Zero local deletions attempted");

  const rec = store.get("recoveryRequired");
  assert.ok(rec);
  assert.equal(rec.reason, "unstable_server_tree");
  assert.equal(store.get("syncConfig").globalEnabled, false, "Sync must be paused fail-closed");
});

test("reconcileFromServer: discordant consecutive snapshots set unstable_server_tree and cause ZERO mutations", async () => {
  createCalls = [];
  removeCalls = [];
  resetLocalTree();
  clearMemoryCache();
  await clearMappings("col_safeguards");
  await clear();
  store.set("syncConfig", { ...store.get("syncConfig"), globalEnabled: true });
  store.delete("recoveryRequired");

  api.info = async () => ({
    id: "col_safeguards",
    bookmark_count: 1,
    folder_count: 1,
  });

  let callCount = 0;
  api.getTree = async () => {
    callCount++;
    if (callCount === 1) {
      // Both version 10, but snapshot 1 has 1 node
      return {
        server_version: 10,
        server_timestamp: 1000,
        nodes: [{ id: "1", parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true }],
      };
    }
    // Snapshot 2 has 2 nodes
    return {
      server_version: 10,
      server_timestamp: 1050,
      nodes: [
        { id: "1", parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true },
        { id: "s1", parent_id: "1", position: 0, title: "Remote Link", url: "https://remote.example", is_folder: false },
      ],
    };
  };

  const res = await reconcileFromServer({ minimumServerVersion: 10 });
  assert.equal(res.deleted, 0);
  assert.equal(res.created, 0);
  assert.equal(createCalls.length, 0, "Zero local creations attempted on discordant snapshots");
  assert.equal(removeCalls.length, 0, "Zero local deletions attempted on discordant snapshots");

  const rec = store.get("recoveryRequired");
  assert.ok(rec);
  assert.equal(rec.reason, "unstable_server_tree");
  assert.equal(store.get("syncConfig").globalEnabled, false, "Sync must be paused fail-closed");
});

test("reconcileFromServer: identical partial snapshots with higher info count fail closed with unstable_server_tree", async () => {
  createCalls = [];
  removeCalls = [];
  resetLocalTree();
  clearMemoryCache();
  await clearMappings("col_safeguards");
  await clear();
  store.set("syncConfig", { ...store.get("syncConfig"), globalEnabled: true });
  store.delete("recoveryRequired");

  // Two consecutive identical snapshots returning 1 node
  api.getTree = async () => ({
    server_version: 10,
    server_timestamp: 1000,
    nodes: [{ id: "1", parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true }],
  });

  // But authoritative /info reports 6 bookmarks + 1 folder = 7 total active nodes
  api.info = async () => ({
    id: "col_safeguards",
    name: "Test Collection",
    bookmark_count: 6,
    folder_count: 1,
  });

  const res = await reconcileFromServer({ minimumServerVersion: 10 });
  assert.equal(res.deleted, 0);
  assert.equal(res.created, 0);
  assert.equal(createCalls.length, 0, "Zero local creations attempted on partial snapshot");
  assert.equal(removeCalls.length, 0, "Zero local deletions attempted on partial snapshot");

  const rec = store.get("recoveryRequired");
  assert.ok(rec);
  assert.equal(rec.reason, "unstable_server_tree");
  assert.equal(rec.actualNodes, 1);
  assert.equal(rec.expectedActive, 7);
  assert.equal(store.get("syncConfig").globalEnabled, false, "Sync must be paused fail-closed");
});

test("delayed bookmark events after guarded mutations are suppressed without dispatching ops", async (t) => {
  const { pushService } = await import("../src/lib/push.ts");
  t.after(() => {
    pushService.stop();
  });
  createCalls = [];
  removeCalls = [];
  resetLocalTree();
  clearMemoryCache();
  await clearMappings("col_safeguards");
  await clear();
  store.set("syncConfig", { ...store.get("syncConfig"), globalEnabled: true });
  store.delete("recoveryRequired");

  api.info = async () => ({
    id: "col_safeguards",
    bookmark_count: 1,
    folder_count: 1,
  });

  // Consistent server tree: 1 folder + 1 link = 2 nodes
  api.getTree = async () => ({
    server_version: 20,
    server_timestamp: 3000,
    nodes: [
      { id: "1", parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true },
      { id: "s_leaf", parent_id: "1", position: 0, title: "Remote Leaf", url: "https://leaf.example", is_folder: false },
    ],
  });

  const res = await reconcileFromServer({ minimumServerVersion: 20 });
  assert.equal(res.created, 1);
  assert.equal(createCalls.length, 1);
  const createdLocalId = "mock_created_1";

  // Simulate Chrome delivering onCreated and onRemoved AFTER reconcileFromServer returned
  onCreated(createdLocalId, {
    id: createdLocalId,
    title: "Remote Leaf",
    url: "https://leaf.example",
    parentId: "1",
    index: 0,
  });
  onRemoved("b1", { parentId: "1" });

  await drainBookmarkEvents();

  // Queue must be completely empty: suppressed events must not dispatch ops
  const ops = await peek();
  assert.equal(ops.length, 0, "Queue must hold zero ops from delayed events");

  // The mapping must remain mapped to s_leaf without being replaced
  assert.equal(await getServerId(createdLocalId), "s_leaf");
});

test("reconcileFromServer: stable tree and info agree at 1 node but expectedServerNodeCount is 8 fails closed with unstable_server_tree and aborted: true", async () => {
  createCalls = [];
  removeCalls = [];
  resetLocalTree();
  clearMemoryCache();
  await clearMappings("col_safeguards");
  await clear();
  store.set("syncConfig", { ...store.get("syncConfig"), globalEnabled: true });
  store.delete("recoveryRequired");

  // Both snapshots return 1 node
  api.getTree = async () => ({
    server_version: 10,
    server_timestamp: 1000,
    nodes: [{ id: "1", parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true }],
  });

  // /info also agrees: 0 bookmarks + 1 folder = 1 active node
  api.info = async () => ({
    id: "col_safeguards",
    name: "Test Collection",
    bookmark_count: 0,
    folder_count: 1,
  });

  // But delta marker said expectedServerNodeCount is 8
  const res = await reconcileFromServer({ minimumServerVersion: 10, expectedServerNodeCount: 8 });
  assert.equal(res.deleted, 0);
  assert.equal(res.created, 0);
  assert.equal(res.aborted, true, "Result must report aborted: true");
  assert.equal(createCalls.length, 0, "Zero local creations attempted");
  assert.equal(removeCalls.length, 0, "Zero local deletions attempted");

  const rec = store.get("recoveryRequired");
  assert.ok(rec);
  assert.equal(rec.reason, "unstable_server_tree");
  assert.equal(rec.actualNodes, 1);
  assert.equal(rec.expectedServerNodeCount, 8);
  assert.equal(store.get("syncConfig").globalEnabled, false, "Sync must be paused fail-closed");
});

test("syncTransaction: malformed one-sided resync metadata halts before applying changes and leaves watermark unchanged", async (t) => {
  const origFetch = globalThis.fetch;
  const origSyncBookmarks = api.syncBookmarks;
  t.after(() => {
    globalThis.fetch = origFetch;
    api.syncBookmarks = origSyncBookmarks;
    resetGate();
  });

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/healthz")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/info")) {
      return new Response(JSON.stringify({ id: "col_safeguards", name: "Safeguards", bookmark_count: 0, folder_count: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  resetGate();

  createCalls = [];
  removeCalls = [];
  resetLocalTree();
  clearMemoryCache();
  await clearMappings("col_safeguards");
  await clear();
  store.set("syncConfig", { ...store.get("syncConfig"), globalEnabled: true });
  store.set("knownServerIds", ["1", "bm_1", "bm_2"]);
  store.set("lastServerVersion", 5);
  store.set("lastPulledTs", 500);
  store.delete("recoveryRequired");

  let syncCalls = 0;
  // Server returns sync batch with malformed one-sided resync metadata (has removed but missing created)
  api.syncBookmarks = async () => {
    syncCalls++;
    return {
      acknowledgedOperations: [],
      changes: [
        { serverVersion: 10, itemId: "*", operation: "resync", data: { removed: 1 } }, // missing 'created'
      ],
      currentServerVersion: 10,
      serverTimestamp: 2000,
    };
  };

  const applied = await syncTransaction();
  assert.equal(syncCalls, 1, "api.syncBookmarks must be invoked to prove branch reachability");
  assert.equal(applied, 0);

  // Watermark must remain completely unchanged at 5 and 500
  assert.equal(store.get("lastServerVersion"), 5, "Watermark version must not advance");
  assert.equal(store.get("lastPulledTs"), 500, "Watermark timestamp must not advance");

  // Sync must be paused fail-closed
  assert.equal(store.get("syncConfig").globalEnabled, false, "Sync must be paused fail-closed");
  const rec = store.get("recoveryRequired");
  assert.ok(rec);
  assert.equal(rec.reason, "unstable_server_tree");
});

test("reconcileFromServer: sparse server positions are clamped during creation without Index out of bounds", async (t) => {
  createCalls = [];
  removeCalls = [];
  resetLocalTree();
  clearMemoryCache();
  await clearMappings("col_safeguards");
  await clear();
  store.set("syncConfig", { ...store.get("syncConfig"), globalEnabled: true });
  store.delete("recoveryRequired");

  // Strict browser mock: throws "Index out of bounds." if index exceeds current child count, exactly like Chrome
  const origCreate = browser.bookmarks.create;
  browser.bookmarks.create = async (arg) => {
    const siblings = [];
    for (const b of localBookmarks.values()) {
      if (b.parentId === arg.parentId) siblings.push(b);
    }
    if (arg.index !== undefined && arg.index > siblings.length) {
      throw new Error("Index out of bounds.");
    }
    return await origCreate(arg);
  };
  t.after(() => {
    browser.bookmarks.create = origCreate;
  });

  api.info = async () => ({
    id: "col_safeguards",
    bookmark_count: 1,
    folder_count: 2, // root 1 + f_work
  });

  api.getTree = async () => ({
    server_version: 30,
    server_timestamp: 5000,
    nodes: [
      { id: "1", parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true },
      { id: "f_work", parent_id: "1", position: 2, title: "Work", url: null, is_folder: true },
      { id: "b_leaf", parent_id: "f_work", position: 5, title: "Deep Link", url: "https://deep.example", is_folder: false },
    ],
  });

  const res = await reconcileFromServer({ minimumServerVersion: 30 });
  assert.equal(res.aborted, false, "Must not abort");
  assert.equal(res.created, 2, "Must create both the sparse folder and sparse leaf");

  // Assert both nodes are placed and mapped
  const localWork = [...localBookmarks.values()].find((b) => b.title === "Work");
  const localLeaf = [...localBookmarks.values()].find((b) => b.title === "Deep Link");
  assert.ok(localWork, "Work folder must be created locally");
  assert.ok(localLeaf, "Deep Link must be created locally");
  assert.equal(localLeaf.parentId, localWork.id, "Hierarchy must be preserved");
  assert.equal(await getServerId(localWork.id), "f_work");
  assert.equal(await getServerId(localLeaf.id), "b_leaf");
});

test("reconcileFromServer: failure during creation rolls back staged nodes and preserves original nodes and mappings", async (t) => {
  createCalls = [];
  removeCalls = [];
  resetLocalTree();
  clearMemoryCache();
  await clearMappings("col_safeguards");
  await clear();
  store.set("syncConfig", { ...store.get("syncConfig"), globalEnabled: true });
  store.delete("recoveryRequired");

  // Seed original mapping and snapshot full original tree
  await setMapping("s_b1", "b1", "col_safeguards");
  assert.equal(await getServerId("b1"), "s_b1");
  const originalTreeSnapshot = [...localBookmarks.entries()].map(([k, v]) => [k, { ...v }]);

  // Fail on the second create call
  let createdCount = 0;
  const origCreate = browser.bookmarks.create;
  browser.bookmarks.create = async (arg) => {
    createdCount++;
    if (createdCount === 2) {
      throw new Error("Disk full: Chrome bookmark create failed on second node");
    }
    return await origCreate(arg);
  };
  t.after(() => {
    browser.bookmarks.create = origCreate;
  });

  api.info = async () => ({
    id: "col_safeguards",
    bookmark_count: 3,
    folder_count: 1,
  });

  api.getTree = async () => ({
    server_version: 40,
    server_timestamp: 6000,
    nodes: [
      { id: "1", parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true },
      { id: "s_b1", parent_id: "1", position: 0, title: "Keep Me", url: "https://keep.example/", is_folder: false },
      { id: "s_new1", parent_id: "1", position: 1, title: "New Link 1", url: "https://new1.example", is_folder: false },
      { id: "s_new2", parent_id: "1", position: 2, title: "New Link 2", url: "https://new2.example", is_folder: false },
    ],
  });

  await assert.rejects(
    async () => {
      await reconcileFromServer({ minimumServerVersion: 40 });
    },
    { message: /Chrome bookmark create failed/ }
  );

  // Assert original local tree is 100% byte-for-byte identical
  assert.deepEqual(
    [...localBookmarks.entries()].map(([k, v]) => [k, { ...v }]),
    originalTreeSnapshot,
    "Original local tree must be 100% preserved"
  );
  assert.equal(await getServerId("b1"), "s_b1", "Original mapping must remain intact");
  assert.equal(await getLocalId("s_new1"), null, "Staged mapping for s_new1 must not exist");
  assert.equal(await getLocalId("s_new2"), null, "Staged mapping for s_new2 must not exist");

  // Op queue must be completely empty
  const ops = await peek();
  assert.equal(ops.length, 0, "No feedback ops may be queued after rollback");

  // Persisted idMap in storage must hold ONLY the original s_b1 <-> b1 mapping
  const key = "lio_id_map_col_safeguards";
  const storedMap = (await browser.storage.local.get(key))[key];
  assert.deepEqual(storedMap.serverToLocal, { s_b1: "b1" }, "Storage must hold only original mapping");
  assert.deepEqual(storedMap.localToServer, { b1: "s_b1" }, "Storage must hold only original mapping");
});
test("reconcileFromServer: empty authoritative target clears stale mappings atomically", async () => {
  createCalls = [];
  removeCalls = [];
  resetLocalTree();
  clearMemoryCache();
  await clearMappings("col_safeguards");
  await clear();
  store.set("syncConfig", { ...store.get("syncConfig"), globalEnabled: true });
  store.delete("recoveryRequired");

  // Seed stale mapping
  await setMapping("s_stale", "b1", "col_safeguards");
  assert.equal(await getServerId("b1"), "s_stale");

  api.info = async () => ({
    id: "col_safeguards",
    bookmark_count: 0,
    folder_count: 1,
  });

  api.getTree = async () => ({
    server_version: 50,
    server_timestamp: 7000,
    nodes: [
      { id: "1", parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true },
    ],
  });

  const res = await reconcileFromServer({ allowEmptyServerWipe: true, minimumServerVersion: 50 });
  assert.equal(res.aborted, false);
  assert.equal(res.deleted, 1, "Obsolete local node b1 deleted");

  // Stale mapping must be cleared
  assert.equal(await getServerId("b1"), null, "Stale mapping must be cleared on empty target");
});

test("reconcileFromServer: dedicated Chrome menu mapping survives replacement", async () => {
  createCalls = [];
  removeCalls = [];
  resetLocalTree();
  clearMemoryCache();
  await clearMappings("col_safeguards");
  await clear();
  store.set("syncConfig", {
    globalEnabled: true,
    pairs: [{ id: "p_everything", type: "bookmark", localFolderId: "", localFolderName: "Everything", enabled: true }],
  });
  store.delete("recoveryRequired");

  // Add dedicated menu folder locally (Chrome has no native menu root)
  localBookmarks.set("local_menu_folder", { id: "local_menu_folder", title: "Bookmarks Menu", parentId: "1", index: 1, isFolder: true });
  await setMapping("menu", "local_menu_folder", "col_safeguards");
  assert.equal(await getLocalId("menu"), "local_menu_folder");

  api.info = async () => ({
    id: "col_safeguards",
    bookmark_count: 1,
    folder_count: 2, // root 1 + menu
  });

  api.getTree = async () => ({
    server_version: 60,
    server_timestamp: 8000,
    nodes: [
      { id: "1", parent_id: "0", position: 0, title: "Bookmarks bar", url: null, is_folder: true },
      { id: "menu", parent_id: "0", position: 1, title: "Bookmarks Menu", url: null, is_folder: true },
      { id: "b_menu_link", parent_id: "menu", position: 0, title: "Menu Item", url: "https://menu.example", is_folder: false },
    ],
  });

  const res = await reconcileFromServer({ minimumServerVersion: 60 });
  assert.equal(res.aborted, false);

  // Dedicated menu mapping must survive replacement
  assert.equal(await getLocalId("menu"), "local_menu_folder", "Dedicated menu mapping must survive replacement");
  assert.equal(await getServerId("local_menu_folder"), "menu");
});

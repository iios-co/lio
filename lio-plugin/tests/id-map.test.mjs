import test from "node:test";
import assert from "node:assert/strict";

const localStore = new Map([
  ["endpoint", "http://test.local"],
  ["token", "tok123"],
  ["collectionId", ""], // Initially empty to test unconfigured check
  ["deviceId", "dev_test"],
]);

const bookmarksTree = [
  {
    id: "0",
    title: "",
    children: [
      { id: "1", title: "Bookmarks bar", children: [] },
      { id: "2", title: "Other bookmarks", children: [] },
      { id: "3", title: "Mobile bookmarks", children: [] },
    ],
  },
];

globalThis.browser = {
  storage: {
    local: {
      async get(keys) {
        if (!keys) return Object.fromEntries(localStore);
        const ks = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of ks) {
          if (localStore.has(k)) out[k] = localStore.get(k);
        }
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) localStore.set(k, v);
      },
      async remove(keys) {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) localStore.delete(k);
      },
    },
  },
  bookmarks: {
    async getTree() {
      return bookmarksTree;
    },
    async create(arg) {
      const id = "created_" + Math.random().toString(36).slice(2, 7);
      return { id, ...arg };
    },
  },
};

const {
  getServerId,
  getLocalId,
  setMapping,
  setMappings,
  removeByServerId,
  removeByLocalId,
  clearMappings,
  mintServerId,
  isLocalRoot,
  canonicalServerRootForLocal,
  localRootForServer,
  resetDetectedRoots,
  clearMemoryCache,
  ensureDedicatedLocalRoot,
} = await import("../src/lib/idMap.ts");

test("idMap requires collectionId and throws when unconfigured", async () => {
  await assert.rejects(
    async () => {
      await getServerId("105");
    },
    { message: /collectionId is not configured/ }
  );
});

test("idMap translates dynamic roots without aliasing distinct server roots", async () => {
  resetDetectedRoots();
  const cid = "col_test_roots";

  assert.equal(await isLocalRoot("1"), true);
  assert.equal(await isLocalRoot("2"), true);
  assert.equal(await isLocalRoot("custom_bm"), false);

  assert.equal(await canonicalServerRootForLocal("1"), "1");
  assert.equal(await canonicalServerRootForLocal("2"), "2");

  assert.equal(await localRootForServer("1", cid), "1");
  assert.equal(await localRootForServer("2", cid), "2");

  // Server "menu" does NOT alias to local "2" (Other Bookmarks) on Chrome!
  const menuLocal = await localRootForServer("menu", cid);
  assert.notEqual(menuLocal, "2");

  // On Chrome, ensuring dedicated local root creates a distinct folder for menu
  const dedicated = await ensureDedicatedLocalRoot("menu", cid);
  assert.notEqual(dedicated, "2");
  assert.equal(await localRootForServer("menu", cid), dedicated);
  assert.equal(await getServerId(dedicated, cid), "menu");
});

test("idMap maintains bijection and transactionally rejects dirty cache on storage failure", async () => {
  clearMemoryCache();
  const cid = "col_transactional";
  await clearMappings(cid);

  const serverId1 = mintServerId();
  const localId1 = "105";

  await setMapping(serverId1, localId1, cid);
  assert.equal(await getServerId(localId1, cid), serverId1);
  assert.equal(await getLocalId(serverId1, cid), localId1);

  // Simulate storage failure
  const originalSet = browser.storage.local.set;
  try {
    browser.storage.local.set = async () => {
      throw new Error("Disk full: storage rejected");
    };

    const serverIdFailed = mintServerId();
    await assert.rejects(
      async () => {
        await setMapping(serverIdFailed, "999", cid);
      },
      { message: /Disk full/ }
    );

    // Assert cache was NOT contaminated with unpersisted write
    assert.equal(await getServerId("999", cid), null);
    assert.equal(await getLocalId(serverIdFailed, cid), null);

    // Previous valid mapping is still intact
    assert.equal(await getServerId(localId1, cid), serverId1);
  } finally {
    browser.storage.local.set = originalSet;
  }
});

test("idMap serializes concurrent mutations and prevents lost updates", async () => {
  clearMemoryCache();
  const cid = "col_concurrency";
  await clearMappings(cid);

  const entries = Array.from({ length: 25 }, (_, i) => ({
    serverId: `srv_${i}`,
    localId: `loc_${i}`,
  }));

  // Fire 25 concurrent setMapping calls
  await Promise.all(entries.map((e) => setMapping(e.serverId, e.localId, cid)));

  // Every single mapping must survive in storage and memory
  for (const e of entries) {
    assert.equal(await getServerId(e.localId, cid), e.serverId);
    assert.equal(await getLocalId(e.serverId, cid), e.localId);
  }
  const key = `lio_id_map_${cid}`;
  const stored = (await browser.storage.local.get(key))[key];
  assert.equal(Object.keys(stored.serverToLocal).length, 25, "All 25 keys must be in persisted storage");
  assert.equal(Object.keys(stored.localToServer).length, 25, "All 25 local keys must be in persisted storage");
});

test("clearMappings and setMappings maintain strict sequential order under concurrency", async () => {
  clearMemoryCache();
  const cid = "col_clear_order";

  // 1. Seed old mapping
  await setMapping("srv_old", "loc_old", cid);
  assert.equal(await getServerId("loc_old", cid), "srv_old");

  // 2. Set up a deterministic barrier on browser.storage.local.remove
  const origRemove = browser.storage.local.remove;
  const { promise: removeStarted, resolve: markStarted } = Promise.withResolvers();
  const { promise: releaseRemove, resolve: proceedRemove } = Promise.withResolvers();

  browser.storage.local.remove = async (keys) => {
    markStarted();
    await releaseRemove;
    return await origRemove(keys);
  };

  try {
    // 3. Start clear (enters remove and blocks on barrier)
    const clearPromise = clearMappings(cid);
    await removeStarted;

    // 4. Start new set while clear is in-flight (must queue behind clear)
    const setPromise = setMapping("srv_new", "loc_new", cid);

    // 5. Release remove and await both operations
    proceedRemove();
    await Promise.all([clearPromise, setPromise]);

    // 6. Assert only new mapping persists
    assert.equal(await getServerId("loc_old", cid), null);
    assert.equal(await getServerId("loc_new", cid), "srv_new");
    assert.equal(await getLocalId("srv_new", cid), "loc_new");
  } finally {
    browser.storage.local.remove = origRemove;
  }
});

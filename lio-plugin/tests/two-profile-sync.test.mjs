import test from "node:test";
import assert from "node:assert/strict";

// Clean server tree seeded with 838 bookmarks from Profile 1
function createMockServer() {
  const nodes = [
    { id: "1", parent_id: null, position: 0, title: "Bookmarks bar", is_folder: true },
    { id: "2", parent_id: null, position: 1, title: "Other bookmarks", is_folder: true },
    { id: "folder_work", parent_id: "1", position: 0, title: "Work", is_folder: true },
  ];
  for (let i = 1; i <= 837; i++) {
    const url = `https://example.com/page_${i % 50}`; // duplicate URLs across bookmarks
    nodes.push({
      id: `bm_${i}`,
      parent_id: i % 2 === 0 ? "folder_work" : "1",
      position: i,
      title: `Bookmark ${i}`,
      url,
      is_folder: false,
      server_version: 1,
    });
  }
  return {
    nodes,
    server_timestamp: 1000,
    server_version: 1,
    pushCalls: 0,
    deltasPushed: 0,
  };
}

// Profile harness representing an isolated browser instance (e.g. Chrome Profile 1 vs Chrome Profile 2)
function createBrowserProfile(deviceId, idPrefix = 1000) {
  const storage = new Map();
  const bookmarks = new Map();
  let nextId = idPrefix;

  // Initial root folders
  bookmarks.set("1", { title: "Bookmarks bar", parentId: "0", index: 0, isFolder: true });
  bookmarks.set("2", { title: "Other bookmarks", parentId: "0", index: 1, isFolder: true });

  const mockBrowser = {
    storage: {
      local: {
        async get(keys) {
          if (!keys) return Object.fromEntries(storage);
          const ks = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of ks) if (storage.has(k)) out[k] = storage.get(k);
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) storage.set(k, v);
        },
        async remove(keys) {
          const ks = Array.isArray(keys) ? keys : [keys];
          for (const k of ks) storage.delete(k);
        },
      },
    },
    bookmarks: {
      async getTree() {
        const topChildren = [];
        for (const [id, node] of bookmarks) {
          if (node.parentId === "0" || !node.parentId) {
            topChildren.push({ id, ...node, children: [] });
          }
        }
        const roots = [
          {
            id: "0",
            title: "",
            children: topChildren,
          },
        ];
        const byParent = new Map();
        for (const [id, node] of bookmarks) {
          if (node.parentId === "0" || !node.parentId) continue;
          const p = node.parentId;
          const list = byParent.get(p) || [];
          list.push({ id, ...node });
          byParent.set(p, list);
        }
        function attach(parent) {
          const kids = byParent.get(parent.id);
          if (kids) {
            parent.children = kids.map((k) => ({ ...k, children: [] }));
            for (const c of parent.children) attach(c);
          }
        }
        for (const r of roots[0].children) attach(r);
        return roots;
      },
      async get(id) {
        if (id === "1") return [{ id: "1", title: "Bookmarks bar", children: [] }];
        if (id === "2") return [{ id: "2", title: "Other bookmarks", children: [] }];
        const n = bookmarks.get(id);
        if (!n) return [];
        return [{ id, ...n }];
      },
      async getChildren(id) {
        const out = [];
        for (const [childId, node] of bookmarks) {
          if (node.parentId === id) out.push({ id: childId, ...node });
        }
        return out;
      },
      async getSubTree(id) {
        const node = bookmarks.get(id);
        if (!node) return [];
        return [{ id, ...node, children: [] }];
      },
      async create(props) {
        const id = String(nextId++);
        const record = {
          title: props.title || "",
          url: props.url || null,
          parentId: props.parentId || "1",
          index: props.index ?? 0,
          isFolder: props.url == null,
        };
        bookmarks.set(id, record);
        return { id, ...record };
      },
      async update(id, changes) {
        const cur = bookmarks.get(id);
        if (cur) {
          bookmarks.set(id, { ...cur, ...changes });
        }
        return { id, ...(cur || changes) };
      },
      async move(id, dest) {
        const cur = bookmarks.get(id);
        if (cur) {
          cur.parentId = dest.parentId ?? cur.parentId;
          cur.index = dest.index ?? cur.index;
        }
        return { id, ...cur };
      },
      async remove(id) {
        bookmarks.delete(id);
      },
      async removeTree(id) {
        // Recursive deletion of folder and all descendants
        const toDelete = [id];
        let idx = 0;
        while (idx < toDelete.length) {
          const curId = toDelete[idx++];
          for (const [childId, node] of bookmarks) {
            if (node.parentId === curId) toDelete.push(childId);
          }
        }
        for (const delId of toDelete) {
          bookmarks.delete(delId);
        }
      },
    },
  };

  return { deviceId, storage, bookmarks, mockBrowser };
}

// Module imports
const { setConfig, setSyncConfig } = await import("../src/lib/config.ts");
const { reconcileFromServer, bootstrap, pushLocalOnlyNodes } = await import("../src/lib/bookmarks.ts");
const { api } = await import("../src/lib/api.ts");
const { clearMemoryCache, getServerId, getLocalId } = await import("../src/lib/idMap.ts");

test("Profile 2: 'Use Server' reconciles exactly with ZERO server writes and zero count growth", async () => {
  const server = createMockServer();
  api.getTree = async () => server;
  api.info = async () => ({
    id: "col_canonical_shared",
    name: "Mock Collection",
    bookmark_count: 838,
    folder_count: 2,
  });
  api.pushDelta = async (_device, ops) => {
    server.pushCalls++;
    server.deltasPushed += ops.length;
    return { applied: ops.length, skipped_stale: 0, server_timestamp: Date.now() };
  };
  // Create isolated Profile 2 (different machine, ID prefix 5000)
  const profile2 = createBrowserProfile("dev_profile_2", 5000);
  globalThis.browser = profile2.mockBrowser;
  clearMemoryCache();

  // Add local uncommitted junk to Profile 2
  profile2.bookmarks.set("9999", { title: "Local Junk", url: "https://junk.example", parentId: "1", index: 0, isFolder: false });

  await setConfig({
    endpoint: "http://mock.server",
    token: "tok_shared_token",
    collectionId: "col_canonical_shared",
    deviceId: profile2.deviceId,
  });
  await setSyncConfig({
    globalEnabled: true,
    pairs: [{ id: "p_everything", type: "bookmark", localFolderId: "", localFolderName: "Everything", enabled: true }],
  });

  // Execute "Use Server" on Profile 2
  const result = await reconcileFromServer();

  // Invariant 1: Server was NOT modified by even a single write
  assert.equal(server.pushCalls, 0, "Use Server must make 0 pushDelta calls to server");
  assert.equal(server.deltasPushed, 0, "Use Server must push 0 deltas to server");
  assert.equal(server.nodes.length, 840, "Server must retain exactly 840 nodes (roots 1,2 + 838 items)");

  // Invariant 2: Profile 2's local tree now matches the server exactly
  assert.equal(profile2.bookmarks.has("9999"), false, "Local junk must be deleted");
  assert.equal(result.created, 838, "Profile 2 created 838 server nodes locally");

  // Invariant 3: All server nodes are mapped to Profile 2's local IDs (5000+)
  const localIdForBm1 = await getLocalId("bm_1");
  assert.ok(localIdForBm1, "bm_1 must map to a local ID on Profile 2");
  assert.match(localIdForBm1, /^5\d+$/, "Profile 2 local ID must be in 5000+ range");
  assert.equal(await getServerId(localIdForBm1), "bm_1");

  // Invariant 4: Subsequent repair pass emits 0 operations (zero drift)
  const repair = await pushLocalOnlyNodes();
  assert.equal(repair.pushed, 0, "Repair pass must find 0 missing nodes");
  assert.equal(server.pushCalls, 0, "Server must remain untouched");
});

test("Profile 2: 'Merge' with identical 838 bookmarks under different IDs pairs without duplicates", async () => {
  const server = createMockServer();
  api.getTree = async () => server;
  api.info = async () => ({
    id: "col_canonical_shared",
    name: "Mock Collection",
    bookmark_count: server.nodes.filter((n) => !n.is_folder).length,
    folder_count: server.nodes.filter((n) => n.is_folder).length,
  });
  api.pushDelta = async (_device, ops) => {
    server.pushCalls++;
    server.deltasPushed += ops.length;
    return { applied: ops.length, skipped_stale: 0, server_timestamp: Date.now() };
  };

  // Profile 2 has the same 838 bookmarks, but Chrome on Profile 2 minted IDs 8000+
  const profile2 = createBrowserProfile("dev_profile_2_merge", 8000);
  globalThis.browser = profile2.mockBrowser;
  clearMemoryCache();

  // Populate Profile 2 with identical bookmarks under local IDs 8000+
  profile2.bookmarks.set("8000", { title: "Work", parentId: "1", index: 0, isFolder: true });
  for (let i = 1; i <= 837; i++) {
    const url = `https://example.com/page_${i % 50}`;
    profile2.bookmarks.set(String(8000 + i), {
      title: `Bookmark ${i}`,
      url,
      parentId: i % 2 === 0 ? "8000" : "1",
      index: i,
      isFolder: false,
    });
  }

  await setConfig({
    endpoint: "http://mock.server",
    token: "tok_shared_token",
    collectionId: "col_canonical_shared",
    deviceId: profile2.deviceId,
  });
  await setSyncConfig({
    globalEnabled: true,
    pairs: [{ id: "p_everything", type: "bookmark", localFolderId: "", localFolderName: "Everything", enabled: true }],
  });

  // Execute Merge on Profile 2
  const mergeResult = await bootstrap("merge");

  // Invariant 1: All bookmarks and folders matched 1-to-1 via multiset pairing
  assert.equal(mergeResult.pushed, 0, "0 duplicate creates pushed to server");
  assert.equal(mergeResult.pulled, 0, "0 duplicate creates pulled into browser");
  assert.equal(server.pushCalls, 0, "Server was not mutated");

  // Invariant 2: Server retains exactly 840 nodes (NEVER doubles to 1676)
  assert.equal(server.nodes.length, 840, "Server node count must stay 840, never double");

  // Invariant 3: Mappings are established for Profile 2's local IDs
  assert.equal(await getServerId("8000"), "folder_work", "Work folder mapped to folder_work");
  assert.equal(await getLocalId("folder_work"), "8000");

  // Invariant 4: Subsequent repair emits zero pushes
  const repair = await pushLocalOnlyNodes();
  assert.equal(repair.pushed, 0);
  assert.equal(server.pushCalls, 0);
});

test("Firefox Profile: roots (toolbar, unfiled, menu) map canonically and match server tree without duplicates", async () => {
  const server = {
    nodes: [
      { id: "1", parent_id: null, position: 0, title: "Bookmarks bar", is_folder: true },
      { id: "2", parent_id: null, position: 1, title: "Other bookmarks", is_folder: true },
      { id: "menu", parent_id: null, position: 2, title: "Bookmarks menu", is_folder: true },
      { id: "bm_tb", parent_id: "1", position: 0, title: "Toolbar Link", url: "https://toolbar.example", is_folder: false, server_version: 1 },
      { id: "bm_menu", parent_id: "menu", position: 0, title: "Menu Link", url: "https://menu.example", is_folder: false, server_version: 1 },
    ],
    server_timestamp: 1000,
    server_version: 1,
    pushCalls: 0,
    deltasPushed: 0,
  };
  api.getTree = async () => server;
  api.info = async () => ({
    id: "col_canonical_shared",
    name: "Mock Collection",
    bookmark_count: server.nodes.filter((n) => !n.is_folder).length,
    folder_count: server.nodes.filter((n) => n.is_folder).length,
  });
  api.pushDelta = async (_device, ops) => {
    server.pushCalls++;
    server.deltasPushed += ops.length;
    return { applied: ops.length, skipped_stale: 0, server_timestamp: Date.now() };
  };

  const firefoxProfile = createBrowserProfile("dev_firefox", 9000);
  // Replace Chrome roots with native Firefox roots
  firefoxProfile.bookmarks.clear();
  firefoxProfile.bookmarks.set("toolbar_____", { title: "Bookmarks Toolbar", parentId: "0", index: 0, isFolder: true });
  firefoxProfile.bookmarks.set("unfiled_____", { title: "Other Bookmarks", parentId: "0", index: 1, isFolder: true });
  firefoxProfile.bookmarks.set("menu________", { title: "Bookmarks Menu", parentId: "0", index: 2, isFolder: true });

  // Add matching bookmarks under Firefox roots
  firefoxProfile.bookmarks.set("ff_1", { title: "Toolbar Link", url: "https://toolbar.example", parentId: "toolbar_____", index: 0, isFolder: false });
  firefoxProfile.bookmarks.set("ff_2", { title: "Menu Link", url: "https://menu.example", parentId: "menu________", index: 0, isFolder: false });

  globalThis.browser = firefoxProfile.mockBrowser;
  clearMemoryCache();
  const { resetDetectedRoots } = await import("../src/lib/idMap.ts");
  resetDetectedRoots();
  await setConfig({
    endpoint: "http://mock.server",
    token: "tok_shared_token",
    collectionId: "col_canonical_shared",
    deviceId: firefoxProfile.deviceId,
  });
  await setSyncConfig({
    globalEnabled: true,
    pairs: [{ id: "p_everything", type: "bookmark", localFolderId: "", localFolderName: "Everything", enabled: true }],
  });

  const mergeResult = await bootstrap("merge");

  assert.equal(mergeResult.pushed, 0, "0 duplicate creates pushed to server");
  assert.equal(mergeResult.pulled, 0, "0 duplicate creates pulled into browser");
  assert.equal(server.pushCalls, 0, "Server was not mutated");

  // Check that Firefox local IDs map to canonical server IDs
  assert.equal(await getServerId("ff_1"), "bm_tb");
  assert.equal(await getServerId("ff_2"), "bm_menu");
  assert.equal(await getLocalId("bm_tb"), "ff_1");
  assert.equal(await getLocalId("bm_menu"), "ff_2");
});

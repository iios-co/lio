/**
 * Bidirectional mapping between server canonical node IDs and browser local bookmark IDs.
 *
 * Browsers (Chrome, Firefox, Safari, Edge) mint their own internal numeric or string
 * IDs (e.g. Chrome "15", Firefox "aBcD_12") when bookmarks are created locally.
 * Different browsers in the same collection NEVER share local IDs.
 *
 * This module ensures:
 * 1. The server's node ID is canonical across all devices in a collection.
 * 2. Each device maintains its own persistent local <-> server ID translation table.
 * 3. Browser root folders are dynamically detected from `browser.bookmarks.getTree()`,
 *    mapping them semantically to canonical server roots ("1", "2", "3", "menu") without
 *    aliasing distinct roots. Unsupported browser roots (such as Firefox Menu on Chrome)
 *    are assigned dedicated local folders so topologies never collide.
 * 4. Mappings are strictly namespaced per stable `collectionId` (cid). Token rotation
 *    never invalidates mappings. Unconfigured states fail loudly.
 * 5. Strict bijection is enforced: remapping an ID breaks prior reverse links.
 * 6. Storage persistence is atomic: cache is only updated after storage succeeds.
 */

import { getConfig } from "./config";

const BASE_STORAGE_KEY = "lio_id_map";

export interface BrowserRoots {
  barLocalId: string | null;     // maps to server "1"
  otherLocalId: string | null;   // maps to server "2"
  mobileLocalId: string | null;  // maps to server "3"
  menuLocalId: string | null;    // maps to server "menu" (native in Firefox)
  allRootIds: Set<string>;
}

let _detectedRoots: BrowserRoots | null = null;

/**
 * Dynamically discover this browser's root bookmark folders from the actual tree.
 * Works across Chrome, Edge, Brave, Firefox, Safari, and unbranded derivatives.
 */
export async function detectBrowserRoots(): Promise<BrowserRoots> {
  if (_detectedRoots) return _detectedRoots;

  const roots: BrowserRoots = {
    barLocalId: null,
    otherLocalId: null,
    mobileLocalId: null,
    menuLocalId: null,
    allRootIds: new Set<string>(),
  };

  try {
    const tree = (await browser.bookmarks.getTree().catch(() => [])) as Array<{
      id: string;
      title?: string;
      children?: Array<{ id: string; title?: string }>;
    }>;

    const top = tree[0];
    if (top) {
      roots.allRootIds.add(top.id);
      if (top.children) {
        for (const c of top.children) {
          roots.allRootIds.add(c.id);
          const title = (c.title || "").toLowerCase();
          const id = c.id;

          if (id === "1" || id === "toolbar_____" || title.includes("bar") || title.includes("toolbar")) {
            roots.barLocalId = id;
          } else if (id === "2" || id === "unfiled_____" || title.includes("other") || title.includes("unfiled")) {
            roots.otherLocalId = id;
          } else if (id === "3" || id === "mobile______" || title.includes("mobile")) {
            roots.mobileLocalId = id;
          } else if (id === "menu________" || title.includes("menu")) {
            roots.menuLocalId = id;
          }
        }

        // Positional fallbacks if titles did not match
        if (!roots.barLocalId && top.children[0]) roots.barLocalId = top.children[0].id;
        if (!roots.otherLocalId && top.children[1]) roots.otherLocalId = top.children[1].id;
        if (!roots.mobileLocalId && top.children[2]) roots.mobileLocalId = top.children[2].id;
      }
    }
  } catch {
    // If browser.bookmarks is not ready, static fallback IDs
    roots.allRootIds.add("0");
    roots.allRootIds.add("1");
    roots.allRootIds.add("2");
    roots.allRootIds.add("3");
    roots.allRootIds.add("toolbar_____");
    roots.allRootIds.add("unfiled_____");
    roots.allRootIds.add("mobile______");
    roots.allRootIds.add("menu________");
  }

  _detectedRoots = roots;
  return roots;
}

export function resetDetectedRoots(): void {
  _detectedRoots = null;
}

interface IdStore {
  serverToLocal: Record<string, string>;
  localToServer: Record<string, string>;
}

// In-memory cache keyed by stable collectionId
const _cache = new Map<string, IdStore>();

export function clearMemoryCache(): void {
  _cache.clear();
}

async function resolveCollectionId(explicitId?: string): Promise<string> {
  if (explicitId && typeof explicitId === "string" && explicitId.trim() !== "") {
    return explicitId;
  }
  const cfg = await getConfig();
  const cid = (cfg.collectionId || "").trim();
  if (!cid) {
    throw new Error("Cannot access idMap: stable collectionId is not configured. Connect to a collection first.");
  }
  return cid;
}
async function loadStore(collectionId?: string): Promise<{ store: IdStore; key: string; cid: string }> {
  const cid = await resolveCollectionId(collectionId);
  const key = `${BASE_STORAGE_KEY}_${cid}`;

  const cached = _cache.get(cid);
  if (cached) {
    return { store: cached, key, cid };
  }

  const raw = await browser.storage.local.get(key);
  const data = raw?.[key] as IdStore | undefined;
  let store: IdStore;
  if (data && typeof data.serverToLocal === "object" && typeof data.localToServer === "object") {
    store = data;
  } else {
    store = { serverToLocal: {}, localToServer: {} };
  }
  _cache.set(cid, store);
  return { store, key, cid };
}

/**
 * Apply a mutation transactionally:
 * Clones existing store, applies mutator, awaits storage write, and only publishes to
 * in-memory cache upon successful persistence. Storage failures reject without dirtying memory.
 */
const _mutationQueues = new Map<string, Promise<unknown>>();

async function enqueueMutation<T>(
  collectionId: string | undefined,
  op: (cid: string) => Promise<T>
): Promise<T> {
  const cid = await resolveCollectionId(collectionId);
  const prevQueue = _mutationQueues.get(cid) ?? Promise.resolve();

  const currentOp = (async () => {
    await prevQueue.catch(() => {});
    return await op(cid);
  })();

  _mutationQueues.set(cid, currentOp);
  try {
    return await currentOp;
  } finally {
    if (_mutationQueues.get(cid) === currentOp) {
      _mutationQueues.delete(cid);
    }
  }
}

async function mutateStore(
  collectionId: string | undefined,
  mutator: (draft: IdStore) => void
): Promise<void> {
  await enqueueMutation(collectionId, async (cid) => {
    const { store, key } = await loadStore(cid);
    const nextStore: IdStore = {
      serverToLocal: { ...store.serverToLocal },
      localToServer: { ...store.localToServer },
    };

    mutator(nextStore);

    // Await storage write FIRST. If it throws, _cache retains previous clean store.
    await browser.storage.local.set({ [key]: nextStore });
    _cache.set(cid, nextStore);
  });
}

/** Check if a local ID is a universal browser root */
export async function isLocalRoot(localId: string): Promise<boolean> {
  const roots = await detectBrowserRoots();
  return (
    roots.allRootIds.has(localId) ||
    localId === roots.barLocalId ||
    localId === roots.otherLocalId ||
    localId === roots.mobileLocalId ||
    localId === roots.menuLocalId
  );
}

/** Translate local root ID to canonical server root ID ("1", "2", "3", "menu") */
export async function canonicalServerRootForLocal(localRootId: string): Promise<string> {
  const roots = await detectBrowserRoots();
  if (localRootId === roots.barLocalId) return "1";
  if (localRootId === roots.otherLocalId) return "2";
  if (localRootId === roots.mobileLocalId) return "3";
  if (localRootId === roots.menuLocalId) return "menu";
  return localRootId;
}

/**
 * Translate canonical server root ID ("1", "2", "3", "menu") to this browser's local root ID.
 * Never aliases two server roots onto the same local ID.
 * If a browser lacks a native menu root (e.g. Chrome), resolves to an assigned dedicated folder.
 */
export async function localRootForServer(serverRootId: string, collectionId?: string): Promise<string | null> {
  const roots = await detectBrowserRoots();
  if (serverRootId === "1") return roots.barLocalId ?? "1";
  if (serverRootId === "2") return roots.otherLocalId ?? "2";
  if (serverRootId === "3") return roots.mobileLocalId ?? "3";
  if (serverRootId === "menu") {
    if (roots.menuLocalId) return roots.menuLocalId;
    // On Chrome/browsers without native menu root, look up dedicated local folder mapped for "menu"
    const { store } = await loadStore(collectionId);
    return store.serverToLocal["menu"] ?? null;
  }
  return null;
}

/**
 * Ensure an unsupported server root (such as Firefox "menu" on Chrome) has a dedicated local folder.
 * Never aliases onto Other Bookmarks ("2").
 */
export async function ensureDedicatedLocalRoot(serverRootId: string, collectionId?: string): Promise<string> {
  const existing = await localRootForServer(serverRootId, collectionId);
  if (existing) return existing;

  const roots = await detectBrowserRoots();
  const parentId = roots.otherLocalId ?? "2";
  const title = serverRootId === "menu" ? "Bookmarks Menu" : `Server Root (${serverRootId})`;

  // Create dedicated folder locally
  const created = (await browser.bookmarks.create({
    parentId,
    title,
  })) as { id: string };

  await setMapping(serverRootId, created.id, collectionId);
  return created.id;
}

/** Get canonical server ID for a local browser bookmark ID */
export async function getServerId(localId: string | null | undefined, collectionId?: string): Promise<string | null> {
  if (!localId) return null;
  if (await isLocalRoot(localId)) {
    return await canonicalServerRootForLocal(localId);
  }
  const { store } = await loadStore(collectionId);
  return store.localToServer[localId] ?? null;
}

/** Get local browser bookmark ID for a canonical server node ID */
export async function getLocalId(serverId: string | null | undefined, collectionId?: string): Promise<string | null> {
  if (!serverId) return null;
  if (serverId === "1" || serverId === "2" || serverId === "3") {
    return await localRootForServer(serverId, collectionId);
  }
  if (serverId === "menu") {
    return await localRootForServer(serverId, collectionId);
  }

  const { store } = await loadStore(collectionId);
  return store.serverToLocal[serverId] ?? null;
}

/** Set a bidirectional mapping between server node ID and local browser ID, maintaining strict bijection */
export async function setMapping(serverId: string, localId: string, collectionId?: string): Promise<void> {
  if (!serverId || !localId) return;
  if (await isLocalRoot(localId)) return; // Roots are static

  await mutateStore(collectionId, (draft) => {
    // Maintain strict bijection: break any prior reverse mappings
    const priorLocal = draft.serverToLocal[serverId];
    if (priorLocal && priorLocal !== localId) {
      delete draft.localToServer[priorLocal];
    }
    const priorServer = draft.localToServer[localId];
    if (priorServer && priorServer !== serverId) {
      delete draft.serverToLocal[priorServer];
    }

    draft.serverToLocal[serverId] = localId;
    draft.localToServer[localId] = serverId;
  });
}

/** Bulk set bidirectional mappings, maintaining strict bijection */
export async function setMappings(entries: Array<{ serverId: string; localId: string }>, collectionId?: string): Promise<void> {
  if (!entries.length) return;
  await mutateStore(collectionId, (draft) => {
    for (const { serverId, localId } of entries) {
      if (serverId && localId) {
        const priorLocal = draft.serverToLocal[serverId];
        if (priorLocal && priorLocal !== localId) {
          delete draft.localToServer[priorLocal];
        }
        const priorServer = draft.localToServer[localId];
        if (priorServer && priorServer !== serverId) {
          delete draft.serverToLocal[priorServer];
        }
        draft.serverToLocal[serverId] = localId;
        draft.localToServer[localId] = serverId;
      }
    }
  });
}

/** Atomically replace all mappings for a collection in a single queued write, enforcing strict bijection */
export async function replaceMappings(
  entries: Array<{ serverId: string; localId: string }>,
  collectionId?: string
): Promise<void> {
  await mutateStore(collectionId, (draft) => {
    draft.serverToLocal = {};
    draft.localToServer = {};
    for (const { serverId, localId } of entries) {
      if (serverId && localId) {
        const priorLocal = draft.serverToLocal[serverId];
        if (priorLocal && priorLocal !== localId) {
          delete draft.localToServer[priorLocal];
        }
        const priorServer = draft.localToServer[localId];
        if (priorServer && priorServer !== serverId) {
          delete draft.serverToLocal[priorServer];
        }
        draft.serverToLocal[serverId] = localId;
        draft.localToServer[localId] = serverId;
      }
    }
  });
}

/** Remove mapping by server ID */
export async function removeByServerId(serverId: string, collectionId?: string): Promise<void> {
  if (!serverId) return;
  await mutateStore(collectionId, (draft) => {
    const localId = draft.serverToLocal[serverId];
    if (localId) {
      delete draft.localToServer[localId];
    }
    delete draft.serverToLocal[serverId];
  });
}

/** Remove mapping by local ID */
export async function removeByLocalId(localId: string, collectionId?: string): Promise<void> {
  if (!localId) return;
  await mutateStore(collectionId, (draft) => {
    const serverId = draft.localToServer[localId];
    if (serverId) {
      delete draft.serverToLocal[serverId];
    }
    delete draft.localToServer[localId];
  });
}

/** Clear all stored mappings for a specific collection (e.g. on disconnect) */
export async function clearMappings(collectionId?: string): Promise<void> {
  await enqueueMutation(collectionId, async (cid) => {
    const key = `${BASE_STORAGE_KEY}_${cid}`;
    _cache.delete(cid);
    await browser.storage.local.remove(key);
  });
}

/** Mint a new canonical server node ID for a locally created bookmark */
export function mintServerId(): string {
  return "bm_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

// Bookmark sync: translate local browser.bookmarks events into delta ops (push),
// and apply remote delta ops onto the local tree (pull). The apply-guard is the
// client-side half of echo suppression: while writing remote changes into
// browser.bookmarks, the events those writes fire must NOT be re-pushed as our
// own deltas. The server-side half (pull excludes our device_id) is the backstop.

import {
  api,
  ApiError,
  type DeltaOp,
  type SyncOperation,
  type SyncOperationChanges,
  type SyncBatchRequest,
  type DeltaChange,
} from "./api";
import { getConfig, getSyncConfig, setSyncConfig, setWatermark, nextClientSequence, type SyncConfig } from "./config";
import { enqueue, enqueueBatch, peek, acknowledge, size as queueSize } from "./queue";
import { checkGate, resetGate } from "./gate";
import { log } from "./log";
import { pushService } from "./push";
import { applyMove, clampIndex } from "./reorderPlan";
import { planMerge, type MergeNode, interleaveRoundRobin } from "./merge";
import {
  getServerId,
  getLocalId,
  setMapping,
  setMappings,
  removeByServerId,
  removeByLocalId,
  clearMappings,
  replaceMappings,
  mintServerId,
  isLocalRoot,
  canonicalServerRootForLocal,
  localRootForServer,
  detectBrowserRoots,
} from "./idMap";
let applyingDepth = 0;

export function isApplyingRemote(): boolean {
  return applyingDepth > 0;
}
async function clearRecoveryIncident(): Promise<void> {
  if (typeof browser.storage?.local?.remove === "function") {
    await browser.storage.local.remove("recoveryRequired").catch(() => null);
  }
}


// ---- Sync scope: does a bookmark node fall within an enabled sync pair? -----

// Cache of local folder id -> set of ancestor folder ids (for subtree checks).
const ancestorCache = new Map<string, Set<string>>();
let ancestorBuiltAt = 0;

export function invalidateScopeCache(): void {
  ancestorCache.clear();
  ancestorBuiltAt = 0;
}

async function ancestorsOf(nodeId: string): Promise<Set<string>> {
  if (Date.now() - ancestorBuiltAt >= 15_000) {
    ancestorCache.clear();
    ancestorBuiltAt = Date.now();
  }
  const cached = ancestorCache.get(nodeId);
  if (cached) return cached;

  const set = new Set<string>();
  let cur: string | undefined = nodeId;
  for (let i = 0; i < 64 && cur; i++) {
    set.add(cur);
    const got: BNode[] | null = await browser.bookmarks.get(cur).catch(() => null);
    const parent: string | undefined = got && got[0] ? got[0].parentId : undefined;
    if (!parent || parent === cur) break;
    cur = parent;
  }
  ancestorCache.set(nodeId, set);
  return set;
}

export interface InScopeNode {
  id: string;
  parentId: string | null;
  index: number;
  title: string;
  url: string | null;
  isFolder: boolean;
  dateAdded?: number;
}

export function buildScopeFilter(
  tree: BNodeLike[],
  syncConfig: SyncConfig,
  onlyEnabled = true
): (id: string, parentId: string | null) => boolean {
  if (onlyEnabled && !syncConfig.globalEnabled) return () => false;
  const pairs = onlyEnabled
    ? syncConfig.pairs.filter((p) => p.type === "bookmark" && p.enabled)
    : syncConfig.pairs.filter((p) => p.type === "bookmark");
  if (pairs.length === 0) return onlyEnabled ? () => false : () => true;
  if (pairs.some((p) => !p.localFolderId)) return () => true;

  const targetFolders = new Set(pairs.map((p) => p.localFolderId).filter(Boolean));
  const inScopeIds = new Set<string>();

  function scan(nodes: BNodeLike[], inheritedInScope: boolean) {
    for (const n of nodes) {
      const isInScope = inheritedInScope || targetFolders.has(n.id);
      if (isInScope) inScopeIds.add(n.id);
      if (n.children) scan(n.children as BNodeLike[], isInScope);
    }
  }
  scan(tree, false);

  return (id: string, parentId: string | null) => {
    if (inScopeIds.has(id)) return true;
    if (parentId && inScopeIds.has(parentId)) return true;
    return false;
  };
}

export function walkInScope(
  tree: BNodeLike[],
  inScopePredicate: (id: string, parentId: string | null) => boolean
): InScopeNode[] {
  const result: InScopeNode[] = [];
  function walk(nodes: BNodeLike[]) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n) continue;
      const isRootContainer = !n.parentId && !(n.title ?? "").trim();
      const pid = n.parentId ?? null;
      const idx = typeof n.index === "number" ? n.index : i;
      if (!isRootContainer && n.id && inScopePredicate(n.id, pid)) {
        result.push({
          id: n.id,
          parentId: pid,
          index: idx,
          title: n.title ?? "",
          url: n.url ?? null,
          isFolder: n.url == null,
          dateAdded: n.dateAdded,
        });
      }
      if (n.children) {
        walk(n.children as BNodeLike[]);
      }
    }
  }
  walk(tree);
  return result;
}
// True if this node should sync: global on, and it's inside an enabled bookmark
// pair's local folder (a root/"" pair means everything).
export async function inSyncScope(
  nodeId: string,
  parentId?: string | null,
  syncConfig?: SyncConfig
): Promise<boolean> {
  const sync = syncConfig || (await getSyncConfig());
  if (!sync.globalEnabled) return false;
  const pairs = sync.pairs.filter((p) => p.type === "bookmark" && p.enabled);
  if (pairs.length === 0) return false;
  // "Sync everything" pair (empty/root local folder) covers all nodes.
  if (pairs.some((p) => !p.localFolderId)) return true;

  // Direct match: if parentId is itself the pair's synced folder, it is in scope.
  if (parentId && pairs.some((p) => p.localFolderId === parentId)) return true;

  // When a node was deleted in Chrome, browser.bookmarks.get(nodeId) returns null
  // because it is already gone. Walk up from parentId instead so deletes inside
  // scoped folders are never dropped.
  let anchor = nodeId;
  if (parentId) {
    const nodeExists = await browser.bookmarks.get(nodeId).catch(() => null);
    if (!nodeExists || !nodeExists.length) {
      anchor = parentId;
    }
  }
  if (!anchor) return false;
  const ancestors = await ancestorsOf(anchor);
  return pairs.some((p) => ancestors.has(p.localFolderId));
}
async function withApplyGuard<T>(fn: () => Promise<T>): Promise<T> {
  applyingDepth += 1;
  try {
    return await fn();
  } finally {
    applyingDepth -= 1;
  }
}
const _suppressedCreates = new Map<string, number>();
const _suppressedRemoves = new Map<string, number>();
const _suppressedChanges = new Map<string, number>();
const _suppressedMoves = new Map<string, number>();
const SUPPRESSION_TTL_MS = 60_000;

function cleanupSuppressed(map: Map<string, number>): void {
  const now = Date.now();
  for (const [k, exp] of map) {
    if (now > exp) map.delete(k);
  }
}

export function registerSuppressedCreate(localId: string): void {
  cleanupSuppressed(_suppressedCreates);
  _suppressedCreates.set(localId, Date.now() + SUPPRESSION_TTL_MS);
}

export function registerSuppressedRemove(localId: string): void {
  cleanupSuppressed(_suppressedRemoves);
  _suppressedRemoves.set(localId, Date.now() + SUPPRESSION_TTL_MS);
}

export function registerSuppressedChange(localId: string): void {
  cleanupSuppressed(_suppressedChanges);
  _suppressedChanges.set(localId, Date.now() + SUPPRESSION_TTL_MS);
}

export function registerSuppressedMove(localId: string): void {
  cleanupSuppressed(_suppressedMoves);
  _suppressedMoves.set(localId, Date.now() + SUPPRESSION_TTL_MS);
}

export function consumeSuppressedCreate(localId: string): boolean {
  cleanupSuppressed(_suppressedCreates);
  return _suppressedCreates.delete(localId);
}

export function consumeSuppressedRemove(localId: string): boolean {
  cleanupSuppressed(_suppressedRemoves);
  return _suppressedRemoves.delete(localId);
}

export function consumeSuppressedChange(localId: string): boolean {
  cleanupSuppressed(_suppressedChanges);
  return _suppressedChanges.delete(localId);
}

export function consumeSuppressedMove(localId: string): boolean {
  cleanupSuppressed(_suppressedMoves);
  return _suppressedMoves.delete(localId);
}

function now(): number {
  return Date.now();
}

// Best-effort favicon as a data URL from the site origin.
async function faviconFor(url?: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const u = new URL(url);
    // Only http(s) is fetchable; chrome://, about:, file: etc. are refused by
    // the browser, so don't even attempt them.
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const res = await fetch(`${u.origin}/favicon.ico`);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0 || blob.size > 100_000) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export const LAST_LOCAL_CHANGE_KEY = "lastLocalChangeAt";

export async function createSyncOp(
  itemId: string,
  operation: "create" | "update" | "move" | "delete",
  changes: SyncOperationChanges
): Promise<SyncOperation> {
  const cfg = await getConfig();
  const seq = await nextClientSequence();
  return {
    operationId: crypto.randomUUID(),
    clientId: cfg.deviceId,
    clientSequence: seq,
    itemId,
    operation,
    changes,
    lastServerVersion: cfg.lastServerVersion || 0,
  };
}

async function dispatch(op: SyncOperation): Promise<void> {
  await browser.storage.local.set({ [LAST_LOCAL_CHANGE_KEY]: Date.now() });
  await enqueue(op);
  pushService.notifyLocalActivity();
}

/**
 * Push the REAL current index of every child of `parentIds`.
 */
async function pushSiblingOrder(parentIds: (string | null | undefined)[]): Promise<void> {
  const seen = new Set<string>();
  const candidates: { serverId: string; serverParentId: string; index: number }[] = [];
  for (const pid of parentIds) {
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    const serverParentId = await getServerId(pid).catch(() => null);
    if (!serverParentId) continue;

    const kids = await browser.bookmarks.getChildren(pid).catch(() => null);
    if (!kids) continue;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (!(await inSyncScope(k.id, pid))) continue;
      const serverId = await getServerId(k.id).catch(() => null);
      if (!serverId) continue; // Skip unmapped children; their create will establish identity
      candidates.push({ serverId, serverParentId, index: i });
    }
  }
  if (!candidates.length) return;

  const cfg = await getConfig();
  const startSeq = await nextClientSequence(candidates.length);
  const ops: SyncOperation[] = candidates.map((c, idx) => ({
    operationId: crypto.randomUUID(),
    clientId: cfg.deviceId,
    clientSequence: startSeq + idx,
    itemId: c.serverId,
    operation: "move",
    changes: {
      parentId: c.serverParentId,
      index: c.index,
    },
    lastServerVersion: cfg.lastServerVersion || 0,
  }));
  await enqueueBatch(ops);
  pushService.notifyLocalActivity();
}

type BNode = Browser.bookmarks.BookmarkTreeNode;

let eventChain: Promise<void> = Promise.resolve();
let syncRequester: (() => void) | null = null;
let lastEventError: Error | null = null;

export function setBookmarkSyncRequester(cb: () => void): void {
  syncRequester = cb;
}

export function enqueueBookmarkEvent(fn: () => Promise<void>): Promise<void> {
  eventChain = eventChain
    .then(fn)
    .catch((err) => {
      lastEventError = err instanceof Error ? err : new Error(String(err));
      console.error("Bookmark event handler error:", err);
    })
    .finally(() => {
      if (syncRequester) syncRequester();
    });
  return eventChain;
}

export async function drainBookmarkEvents(): Promise<void> {
  const current = eventChain;
  await current;
  if (lastEventError) {
    const err = lastEventError;
    lastEventError = null;
    throw err;
  }
}

export function onCreated(id: string, node: BNode): void {
  if (consumeSuppressedCreate(id)) return;
  if (isApplyingRemote()) return;
  enqueueBookmarkEvent(async () => {
    if (!(await inSyncScope(id, node.parentId))) return;
    let serverId = await getServerId(id).catch(() => null);
    if (!serverId) {
      serverId = mintServerId();
      await setMapping(serverId, id);
    }
    const serverParentId = await getServerId(node.parentId).catch(() => null);
    const op = await createSyncOp(serverId, "create", {
      parentId: serverParentId,
      index: node.index ?? 0,
      title: node.title ?? "",
      url: node.url ?? null,
      isFolder: node.url == null,
      dateAdded: node.dateAdded ?? Date.now(),
      iconBase64: await faviconFor(node.url),
    });
    await dispatch(op);
  });
}

export function onChanged(
  id: string,
  changeInfo: { title?: string; url?: string }
): void {
  if (consumeSuppressedChange(id)) return;
  if (isApplyingRemote()) return;
  enqueueBookmarkEvent(async () => {
    const existing = await browser.bookmarks.get(id).catch(() => null);
    const parentId = existing && existing[0] ? existing[0].parentId : undefined;
    if (!(await inSyncScope(id, parentId))) return;
    const serverId = await getServerId(id).catch(() => null);
    if (!serverId) return;
    const op = await createSyncOp(serverId, "update", {
      title: changeInfo.title,
      url: changeInfo.url ?? null,
      iconBase64: await faviconFor(changeInfo.url),
      dateModified: Date.now(),
    });
    await dispatch(op);
  });
}

export function onMoved(
  id: string,
  moveInfo: { parentId?: string; index?: number; oldParentId?: string; oldIndex?: number }
): void {
  if (consumeSuppressedMove(id)) return;
  if (isApplyingRemote()) return;
  enqueueBookmarkEvent(async () => {
    const inOld = await inSyncScope(id, moveInfo.oldParentId);
    const inNew = await inSyncScope(id, moveInfo.parentId);
    if (!inOld && !inNew) return;

    if (!inOld && inNew) {
      // Moved outside -> inside sync scope: recursively create canonical server nodes
      const existing = (await browser.bookmarks.get(id).catch(() => null))?.[0];
      if (!existing) return;

      const createSubtree = async (node: BNodeLike) => {
        let serverId = await getServerId(node.id).catch(() => null);
        if (!serverId) {
          serverId = mintServerId();
          await setMapping(serverId, node.id);
        }
        const serverParentId = await getServerId(node.parentId).catch(() => null);
        const op = await createSyncOp(serverId, "create", {
          parentId: serverParentId,
          index: node.index ?? 0,
          title: node.title ?? "",
          url: node.url ?? null,
          isFolder: node.url == null,
          dateAdded: node.dateAdded ?? Date.now(),
          iconBase64: await faviconFor(node.url),
        });
        await dispatch(op);

        if (node.children) {
          for (const child of node.children) {
            await createSubtree(child as BNodeLike);
          }
        }
      };

      const subtree = (await browser.bookmarks.getSubTree(id).catch(() => null))?.[0];
      if (subtree) {
        await createSubtree(subtree as BNodeLike);
      } else {
        await createSubtree(existing as BNodeLike);
      }
      return;
    }

    if (inOld && !inNew) {
      // Moved inside -> outside sync scope: emit canonical delete on the server
      const serverId = await getServerId(id).catch(() => null);
      if (serverId) {
        const op = await createSyncOp(serverId, "delete", {});
        await dispatch(op);
      }
      return;
    }

    // Inside -> Inside: standard move
    const serverId = await getServerId(id).catch(() => null);
    const serverParentId = await getServerId(moveInfo.parentId).catch(() => null);
    if (serverId && serverParentId) {
      const op = await createSyncOp(serverId, "move", {
        parentId: serverParentId,
        index: moveInfo.index ?? 0,
      });
      await dispatch(op);
    }
  });
}

export function onRemoved(id: string, removeInfo?: { parentId?: string }): void {
  if (consumeSuppressedRemove(id)) return;
  if (isApplyingRemote()) return;
  enqueueBookmarkEvent(async () => {
    if (!(await inSyncScope(id, removeInfo?.parentId))) return;
    const serverId = await getServerId(id).catch(() => null);
    if (serverId) {
      const op = await createSyncOp(serverId, "delete", {});
      await dispatch(op);
    }
  });
}

// ---- Full-tree reconciliation (the `resync` marker) ------------------------
//
// A bulk server-side change (delete duplicates, group by domain, sort) is too
// broad to express as per-node ops, so the server appends ONE `resync` marker
// instead of thousands of moves. This function is what makes that marker mean
// something: it reads the server tree and reshapes the LOCAL BROWSER tree to
// match it.
//
// Without this the whole console is theatre — a dedupe removed 1196 links on the
// server while the user's browser kept every one of them, and the UI reported
// success.
//
// Order is deliberate: stage missing server nodes parents-before-children with
// rollback safety, delete obsolete local nodes, align titles/urls/positions,
// and atomically replace mappings. Server IDs are canonical and mapped to local
// browser IDs via idMap.
interface ServerNodeRow {
  id: string;
  parent_id: string | null;
  position: number;
  title: string;
  url: string | null;
  is_folder: boolean;
  /** Server watermark of this row's last accepted mutation. Lets the client tell
   *  "I have already seen this row's current state" from "the server moved it
   *  while I was not listening". */
  server_version?: number;
}

export interface ReconcileOptions {
  allowEmptyServerWipe?: boolean;
  minimumServerVersion?: number;
  expectedServerNodeCount?: number;
}

export async function reconcileFromServer(
  optionsOrAllowEmpty: boolean | ReconcileOptions = false
): Promise<{ deleted: number; created: number; updated: number; moved: number; aborted?: boolean }> {
  const opts: ReconcileOptions =
    typeof optionsOrAllowEmpty === "boolean"
      ? { allowEmptyServerWipe: optionsOrAllowEmpty }
      : optionsOrAllowEmpty;
  const allowEmptyServerWipe = opts.allowEmptyServerWipe ?? false;
  const minimumServerVersion = opts.minimumServerVersion ?? 0;
  const expectedServerNodeCount = opts.expectedServerNodeCount;
  const res1 = await api.getTree();
  if (!res1) return { deleted: 0, created: 0, updated: 0, moved: 0, aborted: true };
  const failUnstableTree = async (detail: string, meta: Record<string, unknown>) => {
    console.warn(`Lio: ${detail}`, meta);
    await browser.storage.local.set({
      recoveryRequired: {
        reason: "unstable_server_tree",
        detail,
        timestamp: Date.now(),
        ...meta,
      },
    });
    await log({
      kind: "error",
      title: "Sync paused: Unstable server tree",
      detail,
    });
    await setSyncConfig({ globalEnabled: false });
    return { deleted: 0, created: 0, updated: 0, moved: 0, aborted: true };
  };

  if (minimumServerVersion > 0 && (res1.server_version ?? 0) < minimumServerVersion) {
    return await failUnstableTree("Server tree snapshot version is behind required minimum version", {
      server_version: res1.server_version,
      minimumServerVersion,
    });
  }

  const { promise: delayPromise, resolve: delayResolve } = Promise.withResolvers<void>();
  setTimeout(delayResolve, 50);
  await delayPromise;

  const res2 = await api.getTree();
  if (!res2) return { deleted: 0, created: 0, updated: 0, moved: 0, aborted: true };
  if (minimumServerVersion > 0 && (res2.server_version ?? 0) < minimumServerVersion) {
    return await failUnstableTree("Second server tree snapshot version is behind required minimum version", {
      server_version: res2.server_version,
      minimumServerVersion,
    });
  }

  const ids1 = (res1.nodes as ServerNodeRow[] ?? []).map((n) => n.id).sort();
  const ids2 = (res2.nodes as ServerNodeRow[] ?? []).map((n) => n.id).sort();
  const versionsAgree = (res1.server_version ?? 0) === (res2.server_version ?? 0);
  const countAgrees = ids1.length === ids2.length;
  const setsAgree = countAgrees && ids1.every((id, idx) => id === ids2[idx]);

  if (!versionsAgree || !countAgrees || !setsAgree) {
    return await failUnstableTree("Consecutive server tree snapshots disagree", {
      v1: res1.server_version,
      v2: res2.server_version,
      count1: ids1.length,
      count2: ids2.length,
    });
  }

  const [info, cfg] = await Promise.all([api.info(), getConfig()]);
  if (!info || !info.id || !cfg.collectionId || info.id !== cfg.collectionId) {
    return await failUnstableTree("Collection identity mismatch or unavailable during reconcileFromServer", {
      infoId: info?.id,
      configuredId: cfg.collectionId,
    });
  }
  if (info.bookmark_count === undefined || info.folder_count === undefined) {
    return await failUnstableTree("Collection info is missing required count fields during reconcileFromServer", {
      info,
    });
  }
  const expectedActive = (info.bookmark_count ?? 0) + (info.folder_count ?? 0);
  const actualNodes = ids2.length;
  if (actualNodes !== expectedActive) {
    return await failUnstableTree("Server tree node count disagrees with authoritative collection info count", {
      actualNodes,
      expectedActive,
      bookmarkCount: info.bookmark_count,
      folderCount: info.folder_count,
    });
  }
  if (expectedServerNodeCount !== undefined) {
    if (actualNodes !== expectedServerNodeCount) {
      return await failUnstableTree("Server tree node count disagrees with delta marker expected count", {
        actualNodes,
        expectedServerNodeCount,
      });
    }
    if (expectedActive !== expectedServerNodeCount) {
      return await failUnstableTree("Authoritative info node count disagrees with delta marker expected count", {
        expectedActive,
        expectedServerNodeCount,
      });
    }
  }
  const res = res2;
  const server = (res.nodes as ServerNodeRow[]) ?? [];
  // Local, in-scope nodes in the real browser
  const roots = (await browser.bookmarks.getTree()) as BNodeLike[];
  const syncCfg = await getSyncConfig();
  const bootstrapSyncCfg = { ...syncCfg, globalEnabled: true };
  const inScopeNodes = walkInScope(roots, buildScopeFilter(roots, bootstrapSyncCfg));
  const serverById = new Map(server.map((n) => [n.id, n]));

  let deleted = 0, created = 0, updated = 0, moved = 0;
  const mappingsToSave: Array<{ serverId: string; localId: string }> = [];
  const placed = new Map<string, string>(); // serverId -> localId

  const rootsInfo = await detectBrowserRoots();
  // Pre-populate placed with canonical root folders
  placed.set("1", (await localRootForServer("1")) ?? "1");
  placed.set("2", (await localRootForServer("2")) ?? "2");
  placed.set("3", (await localRootForServer("3")) ?? "3");
  const menuLocal = await localRootForServer("menu");
  if (menuLocal) {
    placed.set("menu", menuLocal);
    if (!rootsInfo.menuLocalId) {
      mappingsToSave.push({ serverId: "menu", localId: menuLocal });
    }
  }
  // Translate scoped sync pairs to canonical server folder IDs
  const activePairs = bootstrapSyncCfg.pairs.filter((p) => p.type === "bookmark" && p.enabled);
  const isSyncEverything = activePairs.some((p) => !p.localFolderId);
  const scopedServerFolders = new Set<string>();
  if (!isSyncEverything) {
    for (const p of activePairs) {
      if (p.localFolderId) {
        const sid = await getServerId(p.localFolderId).catch(() => null);
        if (sid) scopedServerFolders.add(sid);
      }
    }
  }

  const inServerScope = (serverId: string): boolean => {
    if (activePairs.length === 0) return false;
    if (isSyncEverything) return true;
    let cur: string | null = serverId;
    for (let i = 0; i < 64 && cur; i++) {
      if (scopedServerFolders.has(cur)) return true;
      cur = serverById.get(cur)?.parent_id ?? null;
    }
    return false;
  };

  const isRoot = (id: string | null | undefined): boolean => !id || rootsInfo.allRootIds.has(id);
  const nonRootLocalLinks = inScopeNodes.filter((n) => !isRoot(n.id) && !n.isFolder).length;
  const nonRootServerLinks = server.filter((s) => !s.is_folder && !isRoot(s.id) && inServerScope(s.id)).length;

  // ADVERSARIAL CIRCUIT BREAKER:
  // If this browser holds bookmarks but the server tree has zero links,
  // refuse to wipe local bookmarks. Halt fail-closed with zero local and zero server mutations.
  if (!allowEmptyServerWipe && nonRootLocalLinks > 0 && nonRootServerLinks === 0) {
    console.warn("Lio: adversarial circuit breaker: refusing to wipe local bookmarks against empty server tree");
    await browser.storage.local.set({
      recoveryRequired: {
        reason: "empty_server_tree",
        localNodeCount: inScopeNodes.length,
        localLinkCount: nonRootLocalLinks,
        serverNodeCount: server.length,
        timestamp: Date.now(),
      },
    });
    await log({
      kind: "error",
      title: "Sync paused: Empty server tree detected",
      detail: "The server tree contains no bookmarks while this browser holds bookmarks. Wiping halted to prevent data loss.",
    });
    await setSyncConfig({ globalEnabled: false });
    return { deleted: 0, created: 0, updated: 0, moved: 0, aborted: true };
  }

  await withApplyGuard(async () => {
    // 1. Populate placed with server IDs whose mapped local nodes already exist in the browser
    const inScopeById = new Map(inScopeNodes.map((n) => [n.id, n]));
    for (const s of server) {
      if (placed.has(s.id)) continue;
      const mappedLocalId = await getLocalId(s.id).catch(() => null);
      if (mappedLocalId && inScopeById.has(mappedLocalId)) {
        placed.set(s.id, mappedLocalId);
        mappingsToSave.push({ serverId: s.id, localId: mappedLocalId });
      }
    }

    // 2. Identify missing in-scope server nodes to create
    const toCreate = server.filter((s) => inServerScope(s.id) && !placed.has(s.id));
    const depthOnServer = (n: ServerNodeRow): number => {
      let d = 0; let cur: string | null = n.parent_id;
      while (cur && d < 64) { cur = serverById.get(cur)?.parent_id ?? null; d += 1; }
      return d;
    };
    toCreate.sort((a, b) => {
      const depthDiff = depthOnServer(a) - depthOnServer(b);
      if (depthDiff !== 0) return depthDiff;
      if (a.parent_id !== b.parent_id) return (a.parent_id ?? "").localeCompare(b.parent_id ?? "");
      return (a.position ?? 0) - (b.position ?? 0);
    });

    const stagedLocalIds: string[] = [];
    try {
      for (const s of toCreate) {
        let parentLocalId: string | null = null;
        if (s.parent_id) {
          parentLocalId = placed.get(s.parent_id) ?? (await getLocalId(s.parent_id).catch(() => null));
        }
        if (!parentLocalId) {
          throw new Error(`Incomplete hierarchy: cannot resolve parent ${s.parent_id} for server node ${s.id} (${s.title})`);
        }
        const curChildren = await browser.bookmarks.getChildren(parentLocalId).catch(() => []);
        const clampedIndex = clampIndex(s.position ?? 0, Array.isArray(curChildren) ? curChildren.length : 0);
        const createParams: { parentId: string; title: string; url?: string; index: number } = {
          parentId: parentLocalId,
          title: s.title ?? "",
          index: clampedIndex,
        };
        if (!s.is_folder && s.url) {
          createParams.url = s.url;
        }
        const made = await browser.bookmarks.create(createParams);
        registerSuppressedCreate(made.id);
        stagedLocalIds.push(made.id);
        created += 1;
        placed.set(s.id, made.id);
        mappingsToSave.push({ serverId: s.id, localId: made.id });
      }

      // Assert every in-scope server node was successfully placed locally
      const inScopeServerNodes = server.filter((s) => inServerScope(s.id));
      for (const s of inScopeServerNodes) {
        if (!placed.has(s.id)) {
          throw new Error(`Incomplete replica: server node ${s.id} (${s.title}) could not be placed locally`);
        }
      }
    } catch (err) {
      // ROLLBACK: remove newly created nodes in reverse creation order, leave existing local tree and mappings untouched
      for (const id of stagedLocalIds.reverse()) {
        registerSuppressedRemove(id);
        await browser.bookmarks.removeTree(id).catch(() => browser.bookmarks.remove(id)).catch(() => {});
      }
      throw err;
    }

    // 3. Remove obsolete local nodes (nodes in scope that are NOT placed on the server)
    const placedLocalIds = new Set(placed.values());
    const obsoleteNodes = inScopeNodes.filter((n) => !isRoot(n.id) && !placedLocalIds.has(n.id));
    const obsoleteIds = new Set(obsoleteNodes.map((n) => n.id));

    // Highest removable obsolete roots (whose parent is a root, or outside inScope, or in placedLocalIds)
    const topRemovableObsolete = obsoleteNodes.filter(
      (n) => !n.parentId || isRoot(n.parentId) || placedLocalIds.has(n.parentId) || !obsoleteIds.has(n.parentId)
    );

    for (const n of obsoleteNodes) {
      registerSuppressedRemove(n.id);
    }

    for (const n of topRemovableObsolete) {
      const ok = await browser.bookmarks
        .removeTree(n.id)
        .catch(() => browser.bookmarks.remove(n.id))
        .then(() => true)
        .catch(() => false);
      if (!ok) {
        throw new Error(`Failed to remove obsolete local bookmark subtree ${n.id} during reconcileFromServer`);
      }
    }
    deleted = obsoleteNodes.length;

    // 4. Align titles, URLs, and positions locally to match server (after obsolete deletion so indices are final)
    for (const s of server) {
      const localId = placed.get(s.id) ?? (await getLocalId(s.id).catch(() => null));
      if (!localId || (await isLocalRoot(localId))) continue;

      const cur = await browser.bookmarks.get(localId).catch(() => null);
      if (!cur || !cur[0]) continue;
      const l = cur[0];

      const titleDiff = (l.title ?? "") !== (s.title ?? "");
      const urlDiff = !s.is_folder && l.url && s.url && l.url.replace(/\/+$/, "") !== s.url.replace(/\/+$/, "");
      if (titleDiff || urlDiff) {
        registerSuppressedChange(localId);
        const ok = await browser.bookmarks.update(localId, {
          title: s.title ?? "",
          url: s.is_folder ? undefined : (s.url ?? undefined),
        }).then(() => true).catch(() => false);
        if (ok) updated += 1;
      }

      const targetParentId = s.parent_id ? (placed.get(s.parent_id) ?? (await getLocalId(s.parent_id).catch(() => null))) : null;
      if (targetParentId && (l.parentId !== targetParentId || l.index !== s.position)) {
        registerSuppressedMove(localId);
        const ok = await applyMove(
          {
            get: (id) => browser.bookmarks.get(id),
            move: (id, dest) => browser.bookmarks.move(id, dest),
            getChildren: (id) => browser.bookmarks.getChildren(id),
          },
          { nodeId: localId, parentId: targetParentId, targetIndex: s.position }
        ).then(() => true).catch(() => false);
        if (ok) moved += 1;
      }
    }
  });

  // 5. Persist all updated mappings atomically in one queued write
  await replaceMappings(mappingsToSave);

  // Update knownServerIds
  await setKnownServerIds(server.map((s) => s.id));
  const migrationKey = `lio_migrated_${cfg.collectionId || "default"}`;
  await browser.storage.local.set({ [migrationKey]: true });
  await clearRecoveryIncident();

  // CRITICAL INVARIANT: ZERO API calls to pushDelta or syncBookmarks!
  await log({
    kind: "synced",
    title: "Reconciled with the server",
    detail: `${deleted} removed, ${created} added, ${updated} updated, ${moved} moved in this browser (0 sent to server).`,
  });

  return { deleted, created, updated, moved, aborted: false };
}

// ---- Initial bootstrap: a fresh browser joining a populated collection -----
//
// Server IDs are canonical and mapped to local browser IDs via idMap.
// The merge bootstrap matches 1:1 by path and multiset content without duplication;
// the server bootstrap reconciles local state strictly to match the server.
const KNOWN_IDS_KEY = "knownServerIds";

async function getKnownServerIds(): Promise<Set<string>> {
  const { [KNOWN_IDS_KEY]: v } = await browser.storage.local.get(KNOWN_IDS_KEY);
  return new Set(Array.isArray(v) ? (v as string[]) : []);
}

async function setKnownServerIds(ids: string[]): Promise<void> {
  await browser.storage.local.set({ [KNOWN_IDS_KEY]: ids });
}

export async function clearKnownServerIds(): Promise<void> {
  await browser.storage.local.remove(KNOWN_IDS_KEY);
}

export async function bootstrap(
  mode: "merge" | "server" | "browser",
  confirmed = false
): Promise<{ pulled: number; pushed: number; matched: number; ambiguous: number; removedFromServer: number }> {
  if (mode === "server") {
    const r = await reconcileFromServer({ allowEmptyServerWipe: confirmed });
    return { pulled: r.created, pushed: 0, matched: 0, ambiguous: 0, removedFromServer: 0 };
  }
  if (mode === "browser") {
    const r = await restoreBaselineFromLocal("Browser-wins initial bootstrap");
    return { pulled: 0, pushed: r.restored, matched: 0, ambiguous: 0, removedFromServer: 0 };
  }
  return bootstrapBrowserAuthoritative();
}

async function bootstrapBrowserAuthoritative(): Promise<{
  pulled: number; pushed: number; matched: number; ambiguous: number; removedFromServer: number;
}> {
  const cfg = await getConfig();
  const res = await api.getTree();
  const serverRows: ServerNodeRow[] = (res?.nodes as ServerNodeRow[]) ?? [];

  const roots = (await browser.bookmarks.getTree()) as BNodeLike[];
  const syncCfg = await getSyncConfig();
  const bootstrapSyncCfg = { ...syncCfg, globalEnabled: true };
  const inScopeNodes = walkInScope(roots, buildScopeFilter(roots, bootstrapSyncCfg));
  const localMerge: MergeNode[] = inScopeNodes.map((n) => ({
    id: n.id,
    parentId: n.parentId,
    title: n.title,
    url: n.url,
    isFolder: n.isFolder,
  }));

  const serverMerge: MergeNode[] = serverRows.map((n) => ({
    id: n.id, parentId: n.parent_id, title: n.title ?? "",
    url: n.url ?? null, isFolder: !!n.is_folder,
  }));

  const rootsInfo = await detectBrowserRoots();
  const localRootRoles: Record<string, string> = {};
  if (rootsInfo.barLocalId) localRootRoles[rootsInfo.barLocalId] = "1";
  if (rootsInfo.otherLocalId) localRootRoles[rootsInfo.otherLocalId] = "2";
  if (rootsInfo.mobileLocalId) localRootRoles[rootsInfo.mobileLocalId] = "3";
  if (rootsInfo.menuLocalId) localRootRoles[rootsInfo.menuLocalId] = "menu";

  const plan = planMerge(localMerge, serverMerge, localRootRoles);
  const serverById = new Map(serverRows.map((n) => [n.id, n]));

  // ---- Phase A: pull server-only links into the browser --------
  const placed = new Map<string, string>(); // serverId -> localId
  const mappingsToSave: Array<{ serverId: string; localId: string }> = [];
  let pulled = 0;

  // 1. Map existing matches (NO create deltas for matches!)
  for (const m of plan.matches) {
    placed.set(m.serverId, m.localId);
    mappingsToSave.push({ serverId: m.serverId, localId: m.localId });
  }
  for (const fm of plan.folderMatches ?? []) {
    placed.set(fm.serverId, fm.localId);
    mappingsToSave.push({ serverId: fm.serverId, localId: fm.localId });
  }
  // Pre-populate placed with canonical root folders
  placed.set("1", (await localRootForServer("1")) ?? "1");
  placed.set("2", (await localRootForServer("2")) ?? "2");
  placed.set("3", (await localRootForServer("3")) ?? "3");
  const menuLocal = await localRootForServer("menu");
  if (menuLocal) placed.set("menu", menuLocal);

  if (plan.serverPull.length) {
    const localIdSet = new Set(localMerge.map((n) => n.id));
    const resolveParent = async (serverParent: string | null): Promise<string | null> => {
      if (!serverParent) return null;
      if (placed.has(serverParent)) return placed.get(serverParent) ?? null;
      const mapped = await getLocalId(serverParent).catch(() => null);
      if (mapped) return mapped;
      if (localIdSet.has(serverParent)) return serverParent;
      return null;
    };

    await withApplyGuard(async () => {
      for (const sid of plan.serverPull) {
        const n = serverById.get(sid);
        if (!n) continue;
        const parentId = await resolveParent(n.parent_id);
        if (!parentId) continue;
        const made = await browser.bookmarks.create({
          parentId,
          title: n.title ?? "",
          url: n.is_folder ? undefined : (n.url ?? undefined),
          index: n.position,
        }).catch((e) => {
          console.warn(`Lio: bootstrap pull failed for ${sid} (${n.title}):`, e);
          return null;
        });
        if (!made) continue;
        placed.set(sid, made.id);
        mappingsToSave.push({ serverId: sid, localId: made.id });
        localIdSet.add(made.id);
        pulled += 1;
      }
    });
  }

  // ---- Phase B: calculate round-robin interleaved positions and push to server ----
  const localToCanonical = new Map<string, string>();
  const canonicalToLocal = new Map<string, string>();
  for (const m of plan.matches) {
    localToCanonical.set(m.localId, m.serverId);
    canonicalToLocal.set(m.serverId, m.localId);
  }
  for (const fm of plan.folderMatches ?? []) {
    localToCanonical.set(fm.localId, fm.serverId);
    canonicalToLocal.set(fm.serverId, fm.localId);
  }
  for (const [sid, lid] of placed) {
    localToCanonical.set(lid, sid);
    canonicalToLocal.set(sid, lid);
  }
  if (rootsInfo.barLocalId) {
    localToCanonical.set(rootsInfo.barLocalId, "1");
    canonicalToLocal.set("1", rootsInfo.barLocalId);
  }
  if (rootsInfo.otherLocalId) {
    localToCanonical.set(rootsInfo.otherLocalId, "2");
    canonicalToLocal.set("2", rootsInfo.otherLocalId);
  }
  if (rootsInfo.mobileLocalId) {
    localToCanonical.set(rootsInfo.mobileLocalId, "3");
    canonicalToLocal.set("3", rootsInfo.mobileLocalId);
  }
  if (rootsInfo.menuLocalId) {
    localToCanonical.set(rootsInfo.menuLocalId, "menu");
    canonicalToLocal.set("menu", rootsInfo.menuLocalId);
  }
  localToCanonical.set("1", "1");
  localToCanonical.set("2", "2");
  localToCanonical.set("3", "3");

  const ts = now();
  const localMergeMap = new Map(localMerge.map((n) => [n.id, n]));
  const isRoot = (id: string | null | undefined): boolean => !id || rootsInfo.allRootIds.has(id);

  // Ensure every localOnly node has a canonical serverId minted
  for (const lid of plan.localOnly) {
    if (isRoot(lid)) continue;
    let serverId = localToCanonical.get(lid);
    if (!serverId) {
      serverId = (await getServerId(lid).catch(() => null)) || mintServerId();
      localToCanonical.set(lid, serverId);
      canonicalToLocal.set(serverId, lid);
      mappingsToSave.push({ serverId, localId: lid });
    }
  }

  // Collect all parent container IDs (both server roots and folders)
  const parentContainerIds = new Set<string>();
  parentContainerIds.add("1");
  parentContainerIds.add("2");
  parentContainerIds.add("3");
  if (rootsInfo.menuLocalId || serverById.has("menu")) parentContainerIds.add("menu");
  for (const s of serverRows) {
    if (s.is_folder && !isRoot(s.id)) parentContainerIds.add(s.id);
  }
  for (const n of inScopeNodes) {
    if (n.isFolder && !isRoot(n.id)) {
      const sid = localToCanonical.get(n.id);
      if (sid) parentContainerIds.add(sid);
    }
  }

  const createOps: DeltaOp[] = [];
  const moveOps: DeltaOp[] = [];
  const localMoves: Array<{ localId: string; localParentId: string; targetIndex: number }> = [];

  if (plan.localOnly.length > 0) {
    for (const pId of parentContainerIds) {
      // Browser 1 children under pId in position order
      const sKids = serverRows.filter((s) => s.parent_id === pId && !isRoot(s.id));
      sKids.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
      const b1Ids = sKids.map((s) => s.id);

      // Browser 2 children under corresponding local parent in index order
      const localPId = canonicalToLocal.get(pId) ?? placed.get(pId) ?? (await localRootForServer(pId)) ?? pId;
      const lKids = inScopeNodes.filter((n) => n.parentId === localPId && !isRoot(n.id));
      lKids.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.id.localeCompare(b.id));
      const b2Ids = lKids.map((n) => localToCanonical.get(n.id)!).filter(Boolean);

      // Round-robin interleaved order: Browser 1 1st, Browser 2 1st, Browser 1 2nd, Browser 2 2nd, etc.
      const targetOrder = interleaveRoundRobin(b1Ids, b2Ids);

      for (let k = 0; k < targetOrder.length; k++) {
        const sid = targetOrder[k]!;
        const localId = canonicalToLocal.get(sid) ?? placed.get(sid) ?? (await getLocalId(sid).catch(() => null));
        if (localId && !isRoot(localId)) {
          localMoves.push({ localId, localParentId: localPId, targetIndex: k });
        }

        if (serverById.has(sid)) {
          const cur = serverById.get(sid)!;
          if (cur.position !== k) {
            moveOps.push({
              op: "move",
              node_id: sid,
              parent_id: pId,
              index: k,
              timestamp: ts,
            });
          }
        } else {
          // Node is local-only, needs op: 'create'
          const n = localMergeMap.get(localId!);
          if (n && !isRoot(n.id)) {
            createOps.push({
              op: "create",
              node_id: sid,
              parent_id: pId,
              index: k,
              title: n.title,
              url: n.url,
              is_folder: n.isFolder,
              date_added: ts,
              timestamp: ts,
            });
          }
        }
      }
    }
  }

  // Sort folder creates topologically before link creates
  const folderDepths = new Map<string, number>();
  const getDepth = (id: string): number => {
    if (folderDepths.has(id)) return folderDepths.get(id)!;
    if (isRoot(id)) return 0;
    const n = localMergeMap.get(placed.get(id) || id);
    if (!n || !n.parentId || isRoot(n.parentId)) {
      folderDepths.set(id, 1);
      return 1;
    }
    const d = 1 + getDepth(localToCanonical.get(n.parentId) || n.parentId);
    folderDepths.set(id, d);
    return d;
  };

  createOps.sort((a, b) => {
    if (a.is_folder && !b.is_folder) return -1;
    if (!a.is_folder && b.is_folder) return 1;
    return getDepth(a.node_id) - getDepth(b.node_id);
  });

  const ops: DeltaOp[] = [...createOps, ...moveOps];

  if (ops.length) {
    const pushRes = await api.pushDelta(cfg.deviceId, ops);
    if (!pushRes || (pushRes.applied ?? 0) < ops.length || (pushRes.skipped_stale ?? 0) > 0) {
      throw new Error(`Merge push rejected or incomplete: applied ${pushRes?.applied ?? 0} of ${ops.length}, skipped_stale ${pushRes?.skipped_stale ?? 0}`);
    }
  }

  // Align local bookmarks in Browser 2 in ascending targetIndex order
  await withApplyGuard(async () => {
    const byParent = new Map<string, Array<{ localId: string; targetIndex: number }>>();
    for (const m of localMoves) {
      const list = byParent.get(m.localParentId) ?? [];
      list.push(m);
      byParent.set(m.localParentId, list);
    }

    for (const [parentLid, moves] of byParent) {
      moves.sort((a, b) => a.targetIndex - b.targetIndex);
      for (const m of moves) {
        await applyMove(
          {
            get: (id) => browser.bookmarks.get(id),
            move: (id, dest) => browser.bookmarks.move(id, dest),
            getChildren: (id) => browser.bookmarks.getChildren(id),
          },
          { nodeId: m.localId, parentId: parentLid, targetIndex: m.targetIndex }
        ).catch(() => {});
      }
    }
  });

  // Persist all ID mappings
  if (mappingsToSave.length) {
    await setMappings(mappingsToSave);
  }

  // Record the converged server id set
  const afterRes = await api.getTree().catch(() => null);
  if (afterRes) {
    await setKnownServerIds((afterRes.nodes as { id: string }[]).map((n) => n.id));
  }
  const migrationKey = `lio_migrated_${cfg.collectionId || "default"}`;
  await browser.storage.local.set({ [migrationKey]: true });
  await clearRecoveryIncident();

  await log({
    kind: "synced",
    title: `Merged with the server: ${plan.matches.length} matched, ${pulled} pulled in, ${createOps.length} pushed, 0 removed from the server.` +
      (plan.ambiguousLinks ? ` ${plan.ambiguousLinks} duplicate-url link(s) were left as-is, not merged.` : ""),
  });

  return {
    pulled,
    pushed: createOps.length,
    matched: plan.matches.length,
    ambiguous: plan.ambiguousLinks,
    removedFromServer: 0,
  };
}
export async function restoreBaselineFromLocal(label = "Restore browser as baseline"): Promise<{
  restored: number; server_version: number;
}> {
  // Read current sync config and collect in-scope local nodes using active pairs
  const currentSync = await getSyncConfig();
  const roots = (await browser.bookmarks.getTree()) as BNodeLike[];
  // Keep pair-level enabled filtering intact by forcing globalEnabled: true
  const scopeFilter = buildScopeFilter(roots, { ...currentSync, globalEnabled: true });
  const inScope = walkInScope(roots, scopeFilter);

  if (inScope.length === 0) {
    throw new Error("Local in-scope tree is empty. Refusing to restore an empty baseline.");
  }

  // Pause sync fail-closed before any network calls
  await setSyncConfig({ globalEnabled: false });

  const treeRes = await api.getTree();
  if (!treeRes) {
    throw new Error("Cannot restore baseline: server tree could not be read.");
  }
  const initialNodes = (treeRes.nodes ?? []) as ServerNodeRow[];
  const expectedActive = initialNodes.length;
  const expectedVersion = treeRes.server_version ?? 0;

  const rootsInfo = await detectBrowserRoots();
  const isRoot = (id: string | null | undefined): boolean => !id || rootsInfo.allRootIds.has(id);

  const localToCanonical = new Map<string, string>();
  if (rootsInfo.barLocalId) localToCanonical.set(rootsInfo.barLocalId, "1");
  if (rootsInfo.otherLocalId) localToCanonical.set(rootsInfo.otherLocalId, "2");
  if (rootsInfo.mobileLocalId) localToCanonical.set(rootsInfo.mobileLocalId, "3");
  if (rootsInfo.menuLocalId) localToCanonical.set(rootsInfo.menuLocalId, "menu");
  localToCanonical.set("1", "1");
  localToCanonical.set("2", "2");
  localToCanonical.set("3", "3");

  const nonRootInScope = inScope.filter((n) => !isRoot(n.id));
  const parentOf = new Map(inScope.map((n) => [n.id, n.parentId]));
  const depthOf = (id: string): number => {
    let d = 0; let cur = parentOf.get(id);
    while (cur && parentOf.has(cur) && d < 64) { d += 1; cur = parentOf.get(cur); }
    return d;
  };
  nonRootInScope.sort((a, b) => depthOf(a.id) - depthOf(b.id));

  for (const n of nonRootInScope) {
    const canonicalId = mintServerId();
    localToCanonical.set(n.id, canonicalId);
  }

  const nodesPayload = nonRootInScope.map((n) => {
    const canonicalId = localToCanonical.get(n.id)!;
    const canonicalParentId = n.parentId ? localToCanonical.get(n.parentId) : null;
    if (!canonicalParentId) {
      throw new Error(`Unresolvable parent ${n.parentId} for local bookmark ${n.id} (${n.title}) during baseline restore`);
    }
    return {
      id: canonicalId,
      parent_id: canonicalParentId,
      position: n.index,
      title: n.title,
      url: n.url,
      is_folder: n.isFolder,
      date_added: n.dateAdded,
    };
  });

  const res = await api.restoreBaseline({
    label,
    expected_server_version: expectedVersion,
    expected_active_count: expectedActive,
    nodes: nodesPayload,
  });

  if (!res || res.restored !== nodesPayload.length) {
    throw new Error(`Server failed to restore expected node count: submitted ${nodesPayload.length}, restored ${res?.restored}`);
  }

  const verifiedTree = await api.getTree();
  const verifiedNodes = (verifiedTree?.nodes ?? []) as ServerNodeRow[];
  const verifiedById = new Map(verifiedNodes.map((n) => [n.id, n]));

  if (verifiedNodes.length !== nodesPayload.length) {
    throw new Error(`Baseline verification failed: expected exactly ${nodesPayload.length} active nodes on server, got ${verifiedNodes.length}`);
  }

  for (const p of nodesPayload) {
    const s = verifiedById.get(p.id);
    if (!s) {
      throw new Error(`Baseline verification failed: submitted node ${p.id} (${p.title}) missing on server.`);
    }
    if (
      s.title !== p.title ||
      (s.url ?? null) !== (p.url ?? null) ||
      Boolean(s.is_folder) !== Boolean(p.is_folder) ||
      (s.parent_id ?? null) !== (p.parent_id ?? null) ||
      s.position !== p.position
    ) {
      throw new Error(`Baseline verification mismatch for node ${p.id}: attributes differ.`);
    }
  }

  // Reset ID mappings for this collection so each local node maps to its canonical baseline server ID
  await clearMappings();
  const baselineMappings = nonRootInScope.map((n) => ({
    serverId: localToCanonical.get(n.id)!,
    localId: n.id,
  }));
  await setMappings(baselineMappings);

  await setWatermark(res.server_timestamp, res.server_version);
  await setKnownServerIds(verifiedNodes.map((n) => n.id));
  const cfg = await getConfig();
  const migrationKey = `lio_migrated_${cfg.collectionId || "default"}`;
  await browser.storage.local.set({ [migrationKey]: true });
  await clearRecoveryIncident();
  await log({
    kind: "synced",
    title: `Restored ${res.restored} bookmarks as server baseline`,
    detail: `Tombstones superseded. Authoritative baseline version is ${res.server_version}.`,
  });

  return { restored: res.restored, server_version: res.server_version };
}

interface BNodeLike {
  id: string;
  parentId?: string;
  index?: number;
  title?: string;
  url?: string;
  dateAdded?: number;
  children?: unknown[];
}

/**
 * Resolve nodes that exist in this browser but not on the server.
 *
 * "Local-only" is AMBIGUOUS and the two cases need opposite actions:
 *
 *   a) the server NEVER received it — a create event was missed (service worker
 *      asleep, gate closed and the op later dropped as poison, added before a
 *      pair existed). The browser is the authority for what exists, so SEND it.
 *   b) the server KNEW it and it is now gone — someone deleted it server-side
 *      (a dedupe, a console delete) and this browser has not applied that yet.
 *      Sending it would RESURRECT it and silently undo the user's deletion.
 *
 * Telling them apart needs history, so the last observed set of server ids is
 * persisted on every successful full-tree read. A local-only node that appears in
 * that set was known and then removed (case b); one that does not was never
 * received (case a).
 *
 * Getting this wrong is not cosmetic: with an unconditional push, loading a build
 * with this repair step would have re-uploaded 1196 duplicates a dedupe had just
 * removed, undoing the user's own action.
 */
export async function pushLocalOnlyNodes(): Promise<{
  pushed: number; deletedLocally: number; unresolved: number;
}> {
  const cfg = await getConfig();
  const res = await api.getTree();
  if (!res) return { pushed: 0, deletedLocally: 0, unresolved: 0 };
  const server = ((res.nodes as ServerNodeRow[]) ?? []);
  const serverById = new Map(server.map((n) => [n.id, n]));
  const serverIds = new Set(server.map((n) => n.id));
  const known = await getKnownServerIds();

  const roots = (await browser.bookmarks.getTree()) as BNodeLike[];
  const syncCfg = await getSyncConfig();
  const inScopeNodes = walkInScope(roots, buildScopeFilter(roots, syncCfg));
  const localOnly: { id: string; parentId: string | null; index: number; title: string; url: string | null; dateAdded?: number; depth: number }[] = [];
  const realignMoves: DeltaOp[] = [];
  // Server-authored placements this browser has not applied yet: the server moved
  // the row after our watermark, so it wins and the move lands HERE.
  const serverMoves: { id: string; parentId: string | null; index: number; depth: number }[] = [];
  const ts = now();
  // Depth within the in-scope set, so a doomed folder is removed after its
  // children rather than taking them with it mid-iteration.
  const parentOf = new Map(inScopeNodes.map((n) => [n.id, n.parentId]));
  const depthOfLocal = (id: string): number => {
    let d = 0;
    let cur: string | null | undefined = parentOf.get(id) ?? null;
    while (cur && parentOf.has(cur) && d < 64) { d += 1; cur = parentOf.get(cur) ?? null; }
    return d;
  };

  // In Git-style synchronization, a local node missing from the server is NEVER
  // assumed to be a server deletion. Deletions on the browser are ONLY performed by
  // explicit tombstone deltas (op: 'delete') received in syncTransaction / applyRemoteChange,
  // or an explicit user-initiated 'resync' (reconcileFromServer).
  // Therefore, pushLocalOnlyNodes NEVER infers or applies local deletions from set differences.
  const rootsInfo = await detectBrowserRoots();
  const isRoot = (id: string | null | undefined): boolean => !id || rootsInfo.allRootIds.has(id);

  // One-time upgrade migration check for profiles without mappings:
  const migrationKey = `lio_migrated_${cfg.collectionId || "default"}`;
  const { [migrationKey]: alreadyMigrated } = await browser.storage.local.get(migrationKey);

  if (!alreadyMigrated && server.length > 0) {
    const nonRootLocal = inScopeNodes.filter((n) => !isRoot(n.id));
    const nonRootServer = server.filter((s) => s.id !== "1" && s.id !== "2" && s.id !== "3" && s.id !== "menu");

    if (nonRootLocal.length === 0 && nonRootServer.length === 0) {
      await browser.storage.local.set({ [migrationKey]: true });
    } else {
      const localToCanonical = new Map<string, string>();
      const canonicalToLocal = new Map<string, string>();
      const newMappingsToSave: Array<{ serverId: string; localId: string }> = [];

      // Seed with existing valid mappings
      for (const n of nonRootLocal) {
        const sid = await getServerId(n.id).catch(() => null);
        if (sid && serverById.has(sid)) {
          localToCanonical.set(n.id, sid);
          canonicalToLocal.set(sid, n.id);
        }
      }

      // Run planMerge to discover remaining matching folders and links
      const localMerge: MergeNode[] = inScopeNodes.map((n) => ({
        id: n.id,
        parentId: n.parentId,
        title: n.title,
        url: n.url,
        isFolder: n.isFolder,
      }));
      const serverMerge: MergeNode[] = server.map((n) => ({
        id: n.id,
        parentId: n.parent_id,
        title: n.title ?? "",
        url: n.url ?? null,
        isFolder: !!n.is_folder,
      }));
      const localRootRoles: Record<string, string> = {};
      if (rootsInfo.barLocalId) localRootRoles[rootsInfo.barLocalId] = "1";
      if (rootsInfo.otherLocalId) localRootRoles[rootsInfo.otherLocalId] = "2";
      if (rootsInfo.mobileLocalId) localRootRoles[rootsInfo.mobileLocalId] = "3";
      if (rootsInfo.menuLocalId) localRootRoles[rootsInfo.menuLocalId] = "menu";

      const plan = planMerge(localMerge, serverMerge, localRootRoles);

      for (const fm of plan.folderMatches ?? []) {
        if (!localToCanonical.has(fm.localId) && !canonicalToLocal.has(fm.serverId)) {
          localToCanonical.set(fm.localId, fm.serverId);
          canonicalToLocal.set(fm.serverId, fm.localId);
          newMappingsToSave.push({ serverId: fm.serverId, localId: fm.localId });
        }
      }
      for (const m of plan.matches) {
        if (!localToCanonical.has(m.localId) && !canonicalToLocal.has(m.serverId)) {
          localToCanonical.set(m.localId, m.serverId);
          canonicalToLocal.set(m.serverId, m.localId);
          newMappingsToSave.push({ serverId: m.serverId, localId: m.localId });
        }
      }

      const allLocalCovered = nonRootLocal.every((n) => localToCanonical.has(n.id));
      const allServerCovered = nonRootServer.every((s) => canonicalToLocal.has(s.id));

      if (allLocalCovered && allServerCovered) {
        if (newMappingsToSave.length) {
          await setMappings(newMappingsToSave);
        }
        await browser.storage.local.set({ [migrationKey]: true });
      } else {
        // Tree divergence: do NOT set migrationKey! Pause sync and request decision.
        await browser.storage.local.set({
          recoveryRequired: {
            reason: "bootstrap_needed",
            localNodeCount: inScopeNodes.length,
            serverNodeCount: server.length,
            timestamp: Date.now(),
          },
        });
        await log({
          kind: "error",
          title: "Sync paused: Initial setup decision needed",
          detail: "Your browser bookmarks and server bookmarks differ. Choose Merge, Use Server, or Use Browser to sync.",
        });
        await setSyncConfig({ globalEnabled: false });
        return { pushed: 0, deletedLocally: 0, unresolved: nonRootLocal.length };
      }
    }
  }

  for (const n of inScopeNodes) {
    if (isRoot(n.id)) continue;
    const serverId = await getServerId(n.id).catch(() => null);
    const s = serverId ? serverById.get(serverId) : undefined;
    if (!s) {
      localOnly.push({
        id: n.id,
        parentId: n.parentId,
        index: n.index,
        title: n.title,
        url: n.url,
        dateAdded: n.dateAdded,
        depth: depthOfLocal(n.id),
      });
    } else {
      const localParent = n.parentId ?? null;
      const serverParent = s.parent_id ?? null;
      const mappedLocalParent = localParent ? (await getServerId(localParent).catch(() => null)) : null;
      const parentDiffers = (mappedLocalParent ?? localParent) !== serverParent;
      const positionDiffers = n.index !== s.position;
      if (parentDiffers || positionDiffers) {
        const rowVersion = s.server_version ?? 0;
        const seenVersion = cfg.lastServerVersion || 0;
        if (rowVersion >= seenVersion) {
          const targetLocalParent = serverParent ? (await getLocalId(serverParent).catch(() => null)) : null;
          if (serverParent && !targetLocalParent) {
            throw new Error(`Cannot apply server placement for ${n.id}: server parent ${serverParent} not resolved locally`);
          }
          serverMoves.push({
            id: n.id,
            parentId: targetLocalParent,
            index: s.position,
            depth: depthOfLocal(n.id),
          });
        } else {
          if (!serverId) {
            throw new Error(`Cannot realign node ${n.id}: missing canonical serverId`);
          }
          realignMoves.push({
            op: "move",
            node_id: serverId,
            parent_id: serverParent,
            index: n.index,
            timestamp: ts,
          });
        }
      }
    }
  }
  // Apply server-authored placements locally, shallowest-first so a parent is in
  // place before its children are positioned into it. Under the apply guard, so
  // these moves are not observed as local edits and pushed straight back up.
  let appliedServerMoves = 0;
  if (serverMoves.length) {
    serverMoves.sort((a, b) => a.depth - b.depth);
    await withApplyGuard(async () => {
      for (const m of serverMoves) {
        const ok = await applyMove(
          {
            get: (id) => browser.bookmarks.get(id),
            move: (id, dest) => browser.bookmarks.move(id, dest),
            getChildren: (id) => browser.bookmarks.getChildren(id),
          },
          {
            nodeId: m.id,
            parentId: m.parentId ?? undefined,
            targetIndex: m.index,
          }
        )
          .then(() => true)
          .catch((e) => {
            console.warn(`Lio: could not apply server placement for ${m.id}:`, (e as Error).message);
            return false;
          });
        if (ok) appliedServerMoves += 1;
      }
    });
  }
  // Collect all local node IDs so we can check for nodes deleted in Chrome.
  const localIdSet = new Set<string>();
  const collectLocalIds = (nodes: BNodeLike[]) => {
    for (const n of nodes) {
      if (n.id) localIdSet.add(n.id);
      if (n.children) collectLocalIds(n.children as BNodeLike[]);
    }
  };
  collectLocalIds(roots as BNodeLike[]);
  const protectedIds = new Set<string>(["0", "1", "2", "3"]);
  for (const id of protectedIds) localIdSet.add(id);

  // In Git-style synchronization, deletions from the browser to the server are ONLY
  // authored by explicit user deletion events recorded in onRemoved.
  // We NEVER infer server-side deletions by set subtraction.
  const serverDeletes: DeltaOp[] = [];

  localOnly.sort((a, b) => a.depth - b.depth); // parents before children
  const localToCanonical = new Map<string, string>();
  const mappingsToSave: Array<{ serverId: string; localId: string }> = [];
  const createOps: DeltaOp[] = [];

  for (const m of localOnly) {
    let serverId = localToCanonical.get(m.id) ?? (await getServerId(m.id).catch(() => null));
    if (!serverId) {
      serverId = mintServerId();
      localToCanonical.set(m.id, serverId);
      mappingsToSave.push({ serverId, localId: m.id });
    }
    const serverParentId = m.parentId
      ? (localToCanonical.get(m.parentId) ?? (await getServerId(m.parentId).catch(() => null)))
      : null;
    if (m.parentId && !serverParentId) {
      throw new Error(`Unresolvable parent ${m.parentId} for local bookmark ${m.id} (${m.title})`);
    }
    createOps.push({
      op: "create",
      node_id: serverId,
      parent_id: serverParentId,
      index: m.index,
      title: m.title,
      url: m.url,
      is_folder: m.url == null,
      date_added: m.dateAdded ?? ts,
      timestamp: ts,
    });
  }
  const ops = [...createOps, ...realignMoves, ...serverDeletes];
  let pushed = 0;
  if (ops.length > 0) {
    const res = await api.pushDelta(cfg.deviceId, ops).catch(() => null);
    if (!res) {
      return { pushed: 0, deletedLocally: 0, unresolved: ops.length };
    }
    const applied = res.applied ?? 0;
    const skipped = res.skipped_stale ?? 0;

    if (skipped > 0 || applied < ops.length) {
      console.warn(`Lio: server rejected ${skipped} of ${ops.length} ops (${applied} applied). Halting repair cycle.`);
      const localLinks = inScopeNodes.filter((n) => !n.isFolder).length;
      await browser.storage.local.set({
        recoveryRequired: {
          reason: "tombstone_rejection",
          applied,
          skipped,
          localNodeCount: inScopeNodes.length,
          localLinkCount: localLinks,
          serverNodeCount: server.length,
          timestamp: Date.now(),
        },
      });
      await log({
        kind: "error",
        title: `Sync paused: Server rejected ${skipped} bookmark changes`,
        detail: `The server holds tombstones or conflicting state for ${skipped} items. Paused to prevent a sync loop.`,
      });
      await setSyncConfig({ globalEnabled: false });
      return { pushed: 0, deletedLocally: 0, unresolved: skipped };
    }

    if (mappingsToSave.length) {
      await setMappings(mappingsToSave);
    }
    const migrationKey = `lio_migrated_${cfg.collectionId || "default"}`;
    await browser.storage.local.set({ [migrationKey]: true });
    await clearRecoveryIncident();

    pushed = localOnly.length;
    const parts: string[] = [];
    if (pushed > 0) parts.push(`sent ${pushed} missing bookmark${pushed === 1 ? "" : "s"}`);
    if (realignMoves.length > 0) parts.push(`realigned ${realignMoves.length} position${realignMoves.length === 1 ? "" : "s"}`);
    await log({
      kind: "synced",
      title: `Repaired server divergence: ${parts.join(", ")}`,
      detail: "Found by comparing this browser against the server.",
    });
  }

  if (appliedServerMoves > 0) {
    await log({
      kind: "synced",
      title: `Applied ${appliedServerMoves} server placement${appliedServerMoves === 1 ? "" : "s"} to this browser`,
      detail: "The server rearranged them while this browser was not syncing, so the server's order won.",
    });
  }

  const updatedKnown = new Set(serverIds);
  for (const op of serverDeletes) updatedKnown.delete(op.node_id);
  for (const op of createOps) updatedKnown.add(op.node_id);
  await setKnownServerIds([...updatedKnown]);
  return { pushed, deletedLocally: 0, unresolved: 0 };
}

async function applyRemoteChange(change: DeltaChange): Promise<void> {
  const { operation, itemId, data } = change;
  const parentId = data?.parentId;

  // Translate canonical server ID to local ID:
  const localId = await getLocalId(itemId);
  const localParentId = parentId ? await getLocalId(parentId) : null;
  const existing = localId ? await browser.bookmarks.get(localId).catch(() => null) : null;
  const cur = existing && existing.length ? existing[0]! : undefined;

  const inScopeRemote = localParentId ? await inSyncScope(localId || itemId, localParentId) : false;
  const inScopeLocal = cur ? await inSyncScope(cur.id, cur.parentId) : false;

  if (!inScopeRemote && !inScopeLocal) {
    return;
  }

  await withApplyGuard(async () => {
    if (operation === "delete") {
      if (localId) {
        const localExists = await browser.bookmarks.get(localId).catch(() => null);
        if (localExists && localExists.length) {
          registerSuppressedRemove(localId);
          const ok = await browser.bookmarks
            .removeTree(localId)
            .catch(() => browser.bookmarks.remove(localId))
            .then(() => true)
            .catch(() => false);
          if (!ok) {
            throw new Error(`Failed to remove local bookmark ${localId} for remote delete ${itemId}`);
          }
        }
        await removeByServerId(itemId);
      }
      return;
    }
    if (operation === "create" && !cur) {
      if (!inScopeRemote) return;
      if (!parentId) throw new Error(`Cannot apply remote create for ${itemId}: missing parentId`);
      if (!localParentId) {
        throw new Error(`Cannot apply remote create for ${itemId}: parent ${parentId} not resolved locally`);
      }
      const parentExists = await browser.bookmarks.get(localParentId).catch(() => null);
      if (!parentExists || !parentExists.length) {
        throw new Error(`Cannot apply remote create for ${itemId}: local parent ${localParentId} does not exist in browser`);
      }
      const made = await browser.bookmarks.create({
        parentId: localParentId,
        title: data.title || "",
        url: data.url || undefined,
        index: data.position,
      });
      if (made) {
        registerSuppressedCreate(made.id);
        await setMapping(itemId, made.id);
      }
      return;
    }
    if (cur && localId) {
      if (operation === "update") {
        registerSuppressedChange(localId);
        await browser.bookmarks.update(localId, {
          title: data.title ?? cur.title,
          url: data.url ?? cur.url,
        });
      } else if (operation === "move") {
        if (!inScopeRemote) return;
        if (data.parentId && !localParentId) {
          throw new Error(`Cannot apply remote move for ${itemId}: parent ${data.parentId} not resolved locally`);
        }
        registerSuppressedMove(localId);
        await applyMove(
          {
            get: (id) => browser.bookmarks.get(id),
            move: (id, dest) => browser.bookmarks.move(id, dest),
            getChildren: (id) => browser.bookmarks.getChildren(id),
          },
          {
            nodeId: localId,
            parentId: localParentId,
            targetIndex: data.position ?? cur.index ?? 0,
          }
        );
      }
    }
  });
}

let inFlightSync: Promise<number> | null = null;

/**
 * Sends the offline queue as one batch to the server and applies any server
 * changes locally. Note: the batch is sent as a whole without per-op fallback;
 * if the server rejects an operation, unacknowledged operations remain queued.
 */
export async function syncTransaction(): Promise<number> {
  if (inFlightSync) return inFlightSync;
  inFlightSync = (async () => {
    const gate = await checkGate();
    if (gate.state !== "ok") return 0;

    const cfg = await getConfig();
    const ops = await peek();

    const req: SyncBatchRequest = {
      clientId: cfg.deviceId,
      lastServerVersion: cfg.lastServerVersion || 0,
      operations: ops,
    };

    const res = await api.syncBookmarks(req);
    if (!res) return 0;

    if (res.acknowledgedOperations && res.acknowledgedOperations.length) {
      await acknowledge(res.acknowledgedOperations);
    }

    let applied = 0;
    let failed = 0;
    const knownBefore = await getKnownServerIds();
    const resyncChange = res.changes.find((o) => o.operation === "resync");
    let expectedServerNodeCount: number | undefined;
    let malformedResyncMarker = false;
    if (resyncChange && knownBefore.size > 0) {
      const data = resyncChange.data ?? {};
      const hasRem = data.removed !== undefined && data.removed !== null;
      const hasCre = data.created !== undefined && data.created !== null;

      if (!hasRem && !hasCre) {
        expectedServerNodeCount = undefined;
      } else if (!hasRem || !hasCre) {
        malformedResyncMarker = true;
      } else {
        const rem = Number(data.removed);
        const cre = Number(data.created);
        const valid =
          Number.isInteger(rem) &&
          rem >= 0 &&
          Number.isInteger(cre) &&
          cre >= 0 &&
          knownBefore.size - rem + cre >= 0;

        if (!valid) {
          malformedResyncMarker = true;
        } else {
          expectedServerNodeCount = knownBefore.size - rem + cre;
        }
      }
    }

    if (malformedResyncMarker) {
      await browser.storage.local.set({
        recoveryRequired: {
          reason: "unstable_server_tree",
          detail: "Malformed or impossible resync marker metadata",
          timestamp: Date.now(),
          knownSize: knownBefore.size,
          data: resyncChange?.data,
        },
      });
      await log({
        kind: "error",
        title: "Sync paused: Malformed resync metadata",
        detail: `Cannot compute expected server node count from resync marker: ${JSON.stringify(resyncChange?.data)}`,
      });
      await setSyncConfig({ globalEnabled: false });
      return applied;
    }
    let reconcileAborted = false;
    for (const remote of res.changes) {
      if (remote.operation === "resync") continue;
      try {
        await applyRemoteChange(remote);
        applied += 1;
      } catch (e) {
        failed += 1;
        console.warn(
          `Lio: could not apply remote ${remote.operation} ${remote.itemId}: ${(e as Error).message}`
        );
      }
    }

    if (resyncChange) {
      try {
        const r = await reconcileFromServer({
          minimumServerVersion: res.currentServerVersion ?? 0,
          expectedServerNodeCount,
        });
        if (r.aborted) {
          reconcileAborted = true;
          failed += 1;
        } else {
          applied += r.deleted + r.created + r.updated + r.moved;
        }
      } catch (e) {
        reconcileAborted = true;
        failed += 1;
        await log({
          kind: "error",
          title: "Could not reconcile with the server",
          detail: (e as Error).message,
        });
      }
    }

    if (failed > 0) {
      await log({
        kind: "error",
        title: `${failed} remote change${failed === 1 ? "" : "s"} could not be applied`,
        detail: "Skipped so sync can continue.",
      });
    }

    if (reconcileAborted) {
      return applied;
    }

    await setWatermark(res.serverTimestamp, res.currentServerVersion);
    return applied;
  })();

  try {
    return await inFlightSync;
  } finally {
    inFlightSync = null;
  }
}

export async function pullAndApply(): Promise<number> {
  return await syncTransaction();
}

export async function flushQueue(): Promise<{ flushed: number; dropped: number }> {
  const before = await queueSize();
  if (!before) return { flushed: 0, dropped: 0 };
  await syncTransaction();
  const after = await queueSize();
  return { flushed: Math.max(0, before - after), dropped: 0 };
}
// ---- Folder listing (for the sync-pair folder picker) ---------------------

export interface FolderInfo {
  id: string;
  title: string;
  depth: number;
}

export async function listFolders(): Promise<FolderInfo[]> {
  const roots = (await browser.bookmarks.getTree()) as BNode[];
  const out: FolderInfo[] = [];
  const walk = (nodes: BNode[], depth: number) => {
    for (const n of nodes) {
      if (!n.url) {
        // folder
        if (n.title) out.push({ id: n.id, title: n.title, depth });
        if (n.children) walk(n.children, depth + (n.title ? 1 : 0));
      }
    }
  };
  walk(roots, 0);
  return out;
}

// Push every in-scope bookmark now (used right after adding a pair / connecting).
export async function fullPushInScope(): Promise<number> {
  const cfg = await getConfig();
  const roots = (await browser.bookmarks.getTree()) as BNodeLike[];
  const syncCfg = await getSyncConfig();
  const inScopeNodes = walkInScope(roots, buildScopeFilter(roots, syncCfg));
  const ts = now();
  const ops: DeltaOp[] = inScopeNodes.map((n) => ({
    op: "create",
    node_id: n.id,
    parent_id: n.parentId,
    index: n.index,
    title: n.title,
    url: n.url,
    is_folder: n.isFolder,
    date_added: n.dateAdded ?? ts,
    timestamp: ts,
  }));
  if (!ops.length) return 0;
  await api.pushDelta(cfg.deviceId, ops);
  return ops.length;
}

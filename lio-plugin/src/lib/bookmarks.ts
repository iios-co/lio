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
import { applyMove } from "./reorderPlan";
import { planMerge, type MergeNode } from "./merge";

let applyingDepth = 0;

export function isApplyingRemote(): boolean {
  return applyingDepth > 0;
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
  const candidates: { id: string; parentId: string; index: number }[] = [];
  for (const pid of parentIds) {
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    const kids = await browser.bookmarks.getChildren(pid).catch(() => null);
    if (!kids) continue;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (!(await inSyncScope(k.id, pid))) continue;
      candidates.push({ id: k.id, parentId: pid, index: i });
    }
  }
  if (!candidates.length) return;

  const cfg = await getConfig();
  const startSeq = await nextClientSequence(candidates.length);
  const ops: SyncOperation[] = candidates.map((c, idx) => ({
    operationId: crypto.randomUUID(),
    clientId: cfg.deviceId,
    clientSequence: startSeq + idx,
    itemId: c.id,
    operation: "move",
    changes: {
      parentId: c.parentId,
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
  if (isApplyingRemote()) return;
  enqueueBookmarkEvent(async () => {
    if (!(await inSyncScope(id, node.parentId))) return;
    const op = await createSyncOp(id, "create", {
      parentId: node.parentId ?? null,
      index: node.index ?? 0,
      title: node.title ?? "",
      url: node.url ?? null,
      isFolder: node.url == null,
      dateAdded: node.dateAdded ?? Date.now(),
      iconBase64: await faviconFor(node.url),
    });
    await dispatch(op);
    await pushSiblingOrder([node.parentId]);
  });
}

export function onChanged(
  id: string,
  changeInfo: { title?: string; url?: string }
): void {
  if (isApplyingRemote()) return;
  enqueueBookmarkEvent(async () => {
    const existing = await browser.bookmarks.get(id).catch(() => null);
    const parentId = existing && existing[0] ? existing[0].parentId : undefined;
    if (!(await inSyncScope(id, parentId))) return;
    const op = await createSyncOp(id, "update", {
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
  if (isApplyingRemote()) return;
  enqueueBookmarkEvent(async () => {
    const inOld = await inSyncScope(id, moveInfo.oldParentId);
    const inNew = await inSyncScope(id, moveInfo.parentId);
    if (!inOld && !inNew) return;
    const op = await createSyncOp(id, "move", {
      parentId: moveInfo.parentId ?? null,
      index: moveInfo.index ?? 0,
    });
    await dispatch(op);
    await pushSiblingOrder([moveInfo.parentId, moveInfo.oldParentId]);
  });
}

export function onRemoved(id: string, removeInfo?: { parentId?: string }): void {
  if (isApplyingRemote()) return;
  enqueueBookmarkEvent(async () => {
    if (!(await inSyncScope(id, removeInfo?.parentId))) return;
    const op = await createSyncOp(id, "delete", {});
    await dispatch(op);
    await pushSiblingOrder([removeInfo?.parentId]);
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
// Order is deliberate: delete, then create parents-before-children, then fix
// titles/urls, then position. Doing moves before creates would place nodes
// against indices that are about to shift.
//
// The browser is the id authority. When the server holds a node the browser does
// not (e.g. a folder invented by group-by-domain), we create it locally — which
// mints a NEW browser id — then push that real id up and delete the server's
// placeholder row, so the two sides converge on ids the browser owns.

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

export async function reconcileFromServer(): Promise<{
  deleted: number; created: number; updated: number; moved: number;
}> {
  const cfg = await getConfig();
  const res = await api.getTree();
  if (!res) return { deleted: 0, created: 0, updated: 0, moved: 0 };
  const server = (res.nodes as ServerNodeRow[]) ?? [];

  // Local, in-scope, hidden root container excluded — the same node set that syncs.
  const roots = (await browser.bookmarks.getTree()) as BNodeLike[];
  const syncCfg = await getSyncConfig();
  const inScopeNodes = walkInScope(roots, buildScopeFilter(roots, syncCfg));
  const local = new Map<string, { parentId: string | null; index: number; title: string; url: string | null; isFolder: boolean }>(
    inScopeNodes.map((n) => [
      n.id,
      { parentId: n.parentId, index: n.index, title: n.title, url: n.url, isFolder: n.isFolder },
    ])
  );

  const serverById = new Map(server.map((n) => [n.id, n]));
  // Roots the browser owns and we must never delete or re-create.
  const protectedIds = new Set<string>(["0", "1", "2", "3"]);

  let deleted = 0, created = 0, updated = 0, moved = 0;
  const idRemap: { localId: string; serverId: string }[] = [];

  await withApplyGuard(async () => {
    // In Git-style synchronization, automatic reconciliation is strictly ADDITIVE:
    // Server nodes the browser lacks are pulled down; titles, URLs, and positions are aligned.
    // Local browser nodes missing from the server are NEVER automatically deleted by a resync marker.
    // Deletions on the browser happen ONLY when an explicit tombstone delete delta is delivered.
    // Therefore, deleted is always 0.
    // -- 2. create server nodes the browser lacks, parents first ------------
    const missing = server.filter((n) => !local.has(n.id) && !protectedIds.has(n.id));
    const depthOnServer = (n: ServerNodeRow): number => {
      let d = 0; let cur: string | null = n.parent_id;
      while (cur && d < 64) { cur = serverById.get(cur)?.parent_id ?? null; d += 1; }
      return d;
    };
    missing.sort((a, b) => depthOnServer(a) - depthOnServer(b));

    // server id -> the real browser id it ended up as
    const placed = new Map<string, string>();
    const resolveParent = (serverParent: string | null): string | undefined => {
      if (!serverParent) return undefined;
      if (placed.has(serverParent)) return placed.get(serverParent);
      if (local.has(serverParent) || protectedIds.has(serverParent)) return serverParent;
      return undefined; // parent unknown locally; let the browser default it
    };

    const syncCfg = await getSyncConfig();
    const activePairs = syncCfg.globalEnabled ? syncCfg.pairs.filter((p) => p.type === "bookmark" && p.enabled) : [];
    
    // Evaluate if a server node is within the synced pair folders using the SERVER'S hierarchy.
    const inServerScope = (serverId: string): boolean => {
      if (activePairs.length === 0) return false;
      if (activePairs.some((p) => !p.localFolderId || p.localFolderId === "1" || p.localFolderId === "2" || p.localFolderId === "3")) return true;
      let cur: string | null = serverId;
      for (let i = 0; i < 64 && cur; i++) {
        if (activePairs.some(p => p.localFolderId === cur)) return true;
        cur = serverById.get(cur)?.parent_id ?? null;
      }
      return false;
    };

    for (const n of missing) {
      if (!inServerScope(n.id)) continue;
      const parentId = resolveParent(n.parent_id);
      const madeNode = await browser.bookmarks
        .create({
          parentId,
          title: n.title ?? "",
          url: n.is_folder ? undefined : n.url ?? undefined,
          index: n.position,
        })
        .catch((e) => {
           console.warn(`Lio: failed to create ${n.id} (${n.title}):`, e);
           return null;
        });
      if (!madeNode) continue;
      created += 1;
      placed.set(n.id, madeNode.id);
      // The browser minted a different id than the server row: converge on ours.
      if (madeNode.id !== n.id) idRemap.push({ localId: madeNode.id, serverId: n.id });

      // Yield the event loop every 100 items to prevent Chrome IPC crashes during large bulk creates
      if (created % 100 === 0) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    // -- 3. titles and urls -------------------------------------------------
    for (const [id, l] of local) {
      const s = serverById.get(id);
      if (!s) continue;
      const titleDiffers = (l.title ?? "") !== (s.title ?? "");
      const urlDiffers = !l.isFolder && (l.url ?? "") !== (s.url ?? "") &&
        (l.url ?? "").replace(/\/+$/, "") !== (s.url ?? "").replace(/\/+$/, "");
      if (titleDiffers || urlDiffers) {
        const changes: { title?: string; url?: string } = {};
        if (titleDiffers) changes.title = s.title ?? "";
        if (urlDiffers && s.url) changes.url = s.url;
        const ok = await browser.bookmarks.update(id, changes).catch(() => null);
        if (ok) updated += 1;
      }
    }

    // -- 4. position, per parent, in the server's order ---------------------
    const groups = new Map<string, ServerNodeRow[]>();
    for (const n of server) {
      if (!n.parent_id) continue;
      const key = placed.get(n.parent_id) ?? n.parent_id;
      const list = groups.get(key) ?? [];
      list.push(n);
      groups.set(key, list);
    }
    for (const [parentId, siblings] of groups) {
      siblings.sort((a, b) => a.position - b.position);
      for (let i = 0; i < siblings.length; i++) {
        const target = siblings[i]!;
        const localId = placed.get(target.id) ?? target.id;
        const cur = await browser.bookmarks.get(localId).catch(() => null);
        if (!cur || !cur[0]) continue;
        if (cur[0].parentId !== parentId || cur[0].index !== i) {
          const ok = await applyMove(
            { get: (id) => browser.bookmarks.get(id), move: (id, dest) => browser.bookmarks.move(id, dest) },
            { nodeId: localId, parentId, targetIndex: i }
          ).then(() => true).catch(() => false);
          if (ok) moved += 1;
        }
      }
    }
  });

  // -- 5. converge ids: push the real browser ids, drop server placeholders --
  if (idRemap.length) {
    const ts = now();
    const ops: DeltaOp[] = [];
    for (const { localId, serverId } of idRemap) {
      const got = await browser.bookmarks.get(localId).catch(() => null);
      const n = got?.[0];
      if (!n) continue;
      ops.push({
        op: "create", node_id: n.id, parent_id: n.parentId ?? null, index: n.index ?? 0,
        title: n.title ?? "", url: n.url ?? null, is_folder: n.url == null,
        date_added: n.dateAdded ?? ts, timestamp: ts,
      });
      ops.push({ op: "delete", node_id: serverId, timestamp: ts });

      // State the new parent_id for all children under this remapped folder
      const children = await browser.bookmarks.getChildren(localId).catch(() => null);
      if (children) {
        for (let i = 0; i < children.length; i++) {
          const child = children[i]!;
          ops.push({
            op: "move",
            node_id: child.id,
            parent_id: localId,
            index: child.index ?? i,
            timestamp: ts,
          });
        }
      }
    }
    if (ops.length) await api.pushDelta(cfg.deviceId, ops).catch(() => null);
  }

  // Refresh and record the converged server id set
  const afterRes = await api.getTree().catch(() => null);
  if (afterRes) {
    await setKnownServerIds((afterRes.nodes as { id: string }[]).map((n) => n.id));
  }

  await log({
    kind: "synced",
    title: "Reconciled with the server",
    detail: `${deleted} removed, ${created} added, ${updated} renamed, ${moved} moved in this browser.`,
  });
  return { deleted, created, updated, moved };
}

// ---- Initial bootstrap: a fresh browser joining a populated collection -----
//
// The sync model assumes "the browser id IS the server id", which is false on a
// fresh install: Chrome mints new ids, so the same link exists twice — once under
// the server's id (from another device) and once under this browser's. A blind
// push therefore duplicates everything (observed live: server 100 + fresh browser
// 120 = 220 rows, 100 dupes).
//
// The user picks the policy at connection time (see OptionsApp):
//   "merge"   — union. Server-only links are pulled into the browser, then the
//               browser tree becomes the single truth pushed back, re-keying the
//               server onto browser ids so nothing is duplicated and visit history
//               survives (merge_from). Content-matched, uniqueness-guarded, so a
//               deliberate duplicate is never collapsed.
//   "server"  — the server wins: pull its whole tree, drop local-only links
//               (reconcileFromServer, the destructive resync path).
//   "browser" — this browser wins: push its whole tree, drop server-only links.
//
// Unlike reconcileFromServer, the merge/browser paths never reposition the local
// tree during a fresh profile — that step crashed Chrome's bookmark IPC on a
// brand-new profile, and positions are reasserted by normal sync afterwards.
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
  mode: "merge" | "server" | "browser"
): Promise<{ pulled: number; pushed: number; matched: number; ambiguous: number; removedFromServer: number }> {
  if (mode === "server") {
    const r = await reconcileFromServer();
    return { pulled: r.created, pushed: 0, matched: 0, ambiguous: 0, removedFromServer: 0 };
  }
  return bootstrapBrowserAuthoritative(mode === "merge");
}

// Shared executor for "merge" and "browser": the BROWSER tree is authoritative.
// `pullServerOnly` is true for merge (server-only links join the browser) and
// false for browser-wins (server-only links are deleted from the server instead).
async function bootstrapBrowserAuthoritative(pullServerOnly: boolean): Promise<{
  pulled: number; pushed: number; matched: number; ambiguous: number; removedFromServer: number;
}> {
  const cfg = await getConfig();
  const res = await api.getTree();
  const serverRows: ServerNodeRow[] = (res?.nodes as ServerNodeRow[]) ?? [];
  const protectedIds = new Set<string>(["0", "1", "2", "3"]);

  // In-scope local nodes as MergeNodes (root container excluded, like every walk).
  const roots = (await browser.bookmarks.getTree()) as BNodeLike[];
  const syncCfg = await getSyncConfig();
  const inScopeNodes = walkInScope(roots, buildScopeFilter(roots, syncCfg));
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

  const plan = planMerge(localMerge, serverMerge);
  const serverById = new Map(serverRows.map((n) => [n.id, n]));

  // ---- Phase A: pull server-only links into the browser (merge only) --------
  // serverId -> the new local id Chrome minted for it.
  const placed = new Map<string, string>();
  let pulled = 0;
  if (pullServerOnly && plan.serverPull.length) {
    const localIdSet = new Set(localMerge.map((n) => n.id));
    for (const id of protectedIds) localIdSet.add(id);
    // A server row whose parent has no local home must be SKIPPED. Passing
    // `parentId: undefined` to bookmarks.create does NOT mean "top level" —
    // Chrome silently files the node in "Other bookmarks". That is how a merge
    // flattened a whole server tree into that folder, and because the flattened
    // copies then sat at a different folder path they no longer content-matched,
    // so the NEXT bootstrap pulled everything again: 842 links became thousands.
    let unresolved = 0;
    const resolveParent = (serverParent: string | null): string | null => {
      if (!serverParent) return null;
      if (placed.has(serverParent)) return placed.get(serverParent) ?? null;
      if (localIdSet.has(serverParent)) return serverParent;
      return null;
    };
    await withApplyGuard(async () => {
      for (const sid of plan.serverPull) {
        const n = serverById.get(sid);
        if (!n) continue;
        const parentId = resolveParent(n.parent_id);
        if (!parentId) { unresolved += 1; continue; }
        const made = await browser.bookmarks.create({
          parentId,
          title: n.title ?? "",
          url: n.is_folder ? undefined : n.url ?? undefined,
          index: n.position,
        }).catch((e) => {
          console.warn(`Lio: bootstrap pull failed for ${sid} (${n.title}):`, e);
          return null;
        });
        if (!made) continue;
        placed.set(sid, made.id);
        localIdSet.add(made.id);
        pulled += 1;
        if (pulled % 250 === 0) {
          await log({ kind: "synced", title: `Merging: pulled ${pulled} of ${plan.serverPull.length} from the server…` });
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    });
    if (unresolved > 0) {
      // Loud on purpose: a skip means the server sent a row whose parent chain
      // never landed locally. Silently filing it anywhere is what created
      // thousands of duplicates, so it is reported, not hidden.
      await log({
        kind: "info",
        title: `Merge skipped ${unresolved} server node${unresolved === 1 ? "" : "s"} with no local parent`,
        detail: "They were NOT filed into Other bookmarks. The next sync places them once their folder exists.",
      });
    }
  }

  // ---- Phase B: the browser is now the union — make the server mirror it -----
  // browserId -> serverId for rows to adopt (inherit visits) rather than re-create.
  const mergeFrom = new Map<string, string>();
  for (const m of plan.matches) mergeFrom.set(m.localId, m.serverId);
  for (const [sid, lid] of placed) mergeFrom.set(lid, sid);

  // Re-read the browser so pulled nodes are included, ordered parents-first.
  const allLocal: { id: string; parentId: string | null; index: number; title: string; url: string | null; isFolder: boolean; depth: number }[] = [];
  const collectAll = async (nodes: BNodeLike[], depth: number) => {
    for (const n of nodes) {
      const isRootContainer = !n.parentId && !(n.title ?? "").trim();
      if (!isRootContainer && n.id && (await inSyncScope(n.id, n.parentId))) {
        allLocal.push({
          id: n.id, parentId: n.parentId ?? null, index: n.index ?? 0,
          title: n.title ?? "", url: n.url ?? null, isFolder: n.url == null, depth,
        });
      }
      if (n.children) await collectAll(n.children as BNodeLike[], depth + 1);
    }
  };
  await collectAll((await browser.bookmarks.getTree()) as BNodeLike[], 0);
  allLocal.sort((a, b) => a.depth - b.depth);

  const ts = now();
  const ops: DeltaOp[] = allLocal.map((n) => ({
    op: "create",
    node_id: n.id,
    parent_id: n.parentId,
    index: n.index,
    title: n.title,
    url: n.url,
    is_folder: n.isFolder,
    date_added: ts,
    timestamp: ts,
    merge_from: mergeFrom.get(n.id) ?? null,
  }));

  // In "merge" mode, a merge is strictly additive (union): NEVER emit deletes
  // to the server. Deletions on the server are only allowed in "browser" (browser-wins)
  // mode where pullServerOnly is false.
  const toDelete: string[] = [];
  if (!pullServerOnly) {
    const browserIds = new Set(allLocal.map((n) => n.id));
    const adopted = new Set(mergeFrom.values());
    const depthOnServer = (id: string): number => {
      let d = 0; let cur: string | null = serverById.get(id)?.parent_id ?? null;
      while (cur && serverById.has(cur) && d < 64) { d += 1; cur = serverById.get(cur)?.parent_id ?? null; }
      return d;
    };
    const serverDroppable = serverRows
      .map((n) => n.id)
      .filter((id) => !adopted.has(id) && !browserIds.has(id) && !protectedIds.has(id))
      .sort((a, b) => depthOnServer(b) - depthOnServer(a));
    for (const id of serverDroppable) {
      toDelete.push(id);
      ops.push({ op: "delete", node_id: id, timestamp: ts });
    }
  }
  if (ops.length) await api.pushDelta(cfg.deviceId, ops).catch(() => null);

  // Record the converged server id set so the repair step trusts it next cycle.
  const afterRes = await api.getTree().catch(() => null);
  if (afterRes) {
    await setKnownServerIds((afterRes.nodes as { id: string }[]).map((n) => n.id));
  }

  await log({
    kind: "synced",
    title: `Merged with the server: ${plan.matches.length} matched, ${pulled} pulled in, ${ops.length - toDelete.length} pushed, ${toDelete.length} removed from the server.` +
      (plan.ambiguousLinks ? ` ${plan.ambiguousLinks} duplicate-url link(s) were left as-is, not merged.` : ""),
  });

  return {
    pulled,
    pushed: ops.length - toDelete.length,
    matched: plan.matches.length,
    ambiguous: plan.ambiguousLinks,
    removedFromServer: toDelete.length,
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
  const initialNodes = (treeRes?.nodes ?? []) as ServerNodeRow[];
  const expectedActive = initialNodes.length;
  const expectedVersion = treeRes?.server_version ?? 0;

  const nodesPayload = inScope.map((n) => ({
    id: n.id,
    parent_id: n.parentId,
    position: n.index,
    title: n.title,
    url: n.url,
    is_folder: n.isFolder,
    date_added: n.dateAdded,
  }));

  const res = await api.restoreBaseline({
    label,
    expected_server_version: expectedVersion,
    expected_active_count: expectedActive,
    nodes: nodesPayload,
  });

  if (!res || res.restored !== nodesPayload.length) {
    throw new Error(`Server failed to restore expected node count: submitted ${nodesPayload.length}, restored ${res?.restored}`);
  }

  // Exact verification: Verify that EVERY submitted node exists on the server with matching attributes,
  // and that any unrelated pre-existing active server nodes were preserved.
  const verifiedTree = await api.getTree();
  const verifiedNodes = (verifiedTree?.nodes ?? []) as ServerNodeRow[];
  const verifiedById = new Map(verifiedNodes.map((n) => [n.id, n]));

  for (const local of inScope) {
    const s = verifiedById.get(local.id);
    if (!s) {
      throw new Error(`Baseline verification failed: submitted node ${local.id} (${local.title}) missing on server.`);
    }
    if (
      s.title !== local.title ||
      (s.url ?? null) !== (local.url ?? null) ||
      Boolean(s.is_folder) !== Boolean(local.isFolder) ||
      (s.parent_id ?? null) !== (local.parentId ?? null) ||
      s.position !== local.index
    ) {
      throw new Error(`Baseline verification mismatch for node ${local.id}: attributes differ.`);
    }
  }
  // Verify unrelated pre-existing active nodes remain active
  const submittedIdSet = new Set(nodesPayload.map((n) => n.id));
  for (const initial of initialNodes) {
    if (!submittedIdSet.has(initial.id) && !verifiedById.has(initial.id)) {
      throw new Error(`Baseline verification failed: pre-existing active node ${initial.id} was accidentally lost.`);
    }
  }

  await setWatermark(res.server_timestamp, res.server_version);
  await setKnownServerIds(verifiedNodes.map((n) => n.id));
  await browser.storage.local.remove("recoveryRequired");
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
  for (const n of inScopeNodes) {
    const s = serverById.get(n.id);
    if (!s) {
      localOnly.push({
        id: n.id,
        parentId: n.parentId,
        index: n.index,
        title: n.title,
        url: n.url,
        dateAdded: n.dateAdded,
        depth: 0,
      });
    } else {
      // Node is on both sides but sits somewhere different. WHO WINS is decided
      // by whether this browser has actually SEEN the server's current row.
      //
      // `s.server_version` is the watermark of the row's last accepted server
      // mutation; `cfg.lastServerVersion` is the last watermark this browser
      // consumed. If the row moved after that, the change happened while this
      // browser was not listening (paused, asleep, offline) — the server is
      // authoritative, so the move is applied HERE.
      //
      // Previously this branch unconditionally declared "the browser is the
      // position authority" and pushed a move up, so reorganising on the server
      // while paused was undone the moment sync resumed.
      const localParent = n.parentId ?? null;
      const serverParent = s.parent_id ?? null;
      const parentDiffers = localParent !== serverParent;
      const positionDiffers = n.index !== s.position;
      if (parentDiffers || positionDiffers) {
        const rowVersion = s.server_version ?? 0;
        const seenVersion = cfg.lastServerVersion || 0;
        if (rowVersion > seenVersion) {
          serverMoves.push({
            id: n.id,
            parentId: serverParent,
            index: s.position,
            depth: depthOfLocal(n.id),
          });
        } else {
          realignMoves.push({
            op: "move",
            node_id: n.id,
            parent_id: localParent,
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
        const ok = await browser.bookmarks
          .move(m.id, { parentId: m.parentId ?? undefined, index: m.index })
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
  const createOps: DeltaOp[] = localOnly.map((m) => ({
    op: "create",
    node_id: m.id,
    parent_id: m.parentId,
    index: m.index,
    title: m.title,
    url: m.url,
    is_folder: m.url == null,
    date_added: m.dateAdded ?? ts,
    timestamp: ts,
  }));

  const ops = [...createOps, ...realignMoves, ...serverDeletes];
  let pushed = 0;
  if (ops.length > 0) {
    const res = await api.pushDelta(cfg.deviceId, ops).catch(() => null);
    if (!res) {
      return { pushed: 0, deletedLocally: 0, unresolved: ops.length };
    }
    const applied = res.applied ?? 0;
    const skipped = res.skipped_stale ?? 0;

    // REJECTION-AWARE CIRCUIT BREAKER:
    // If the server rejected operations due to tombstones or staleness, we must NEVER
    // falsely claim success, must NOT mark rejected nodes as known, and must halt the
    // repair cycle to prevent infinite ping-pong retry loops.
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
      // Pause sync to break any automated retry loop
      await setSyncConfig({ globalEnabled: false });
      return { pushed: 0, deletedLocally: 0, unresolved: skipped };
    }

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
  for (const n of localOnly) updatedKnown.add(n.id);
  await setKnownServerIds([...updatedKnown]);
  return { pushed, deletedLocally: 0, unresolved: 0 };
}

async function applyRemoteChange(change: DeltaChange): Promise<void> {
  const { operation, itemId, data } = change;
  const parentId = data?.parentId;

  const existing = await browser.bookmarks.get(itemId).catch(() => null);
  const cur = existing && existing.length ? existing[0]! : undefined;

  const inScopeRemote = await inSyncScope(itemId, parentId);
  const inScopeLocal = cur ? await inSyncScope(itemId, cur.parentId) : false;

  if (!inScopeRemote && !inScopeLocal) {
    return;
  }

  await withApplyGuard(async () => {
    if (operation === "delete") {
      try {
        await browser.bookmarks
          .removeTree(itemId)
          .catch(() => browser.bookmarks.remove(itemId));
      } catch {
        /* already gone */
      }
      return;
    }
    if (operation === "create" && !cur) {
      if (!inScopeRemote) return;
      // Same trap as the bootstrap pull: `parentId: undefined` is NOT "top
      // level" — Chrome files the node under "Other bookmarks". A create whose
      // parent hasn't landed locally yet must be skipped; the repair pass
      // (pushLocalOnlyNodes) or the next full pull places it once the parent
      // exists, instead of stranding a copy in the wrong folder.
      if (!parentId) return;
      const parentExists = await browser.bookmarks.get(parentId).catch(() => null);
      if (!parentExists || !parentExists.length) return;
      await browser.bookmarks.create({
        parentId,
        title: data.title || "",
        url: data.url || undefined,
        index: data.position,
      });
      return;
    }
    if (cur) {
      if (operation === "update") {
        await browser.bookmarks.update(itemId, {
          title: data.title ?? cur.title,
          url: data.url ?? cur.url,
        });
      } else if (operation === "move") {
        if (!inScopeRemote) return;
        await applyMove(
          {
            get: (id) => browser.bookmarks.get(id),
            move: (id, dest) => browser.bookmarks.move(id, dest),
          },
          {
            nodeId: itemId,
            parentId: data.parentId ?? null,
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
    const wantsResync = res.changes.some((o) => o.operation === "resync");

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

    if (wantsResync) {
      try {
        const r = await reconcileFromServer();
        applied += r.deleted + r.created + r.updated + r.moved;
      } catch (e) {
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

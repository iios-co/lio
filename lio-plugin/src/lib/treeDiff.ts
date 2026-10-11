// PURE tree comparison: does the LOCAL browser tree match the server, node for node?
//
// Deliberately import-free (no browser, no network) so the rule that decides
// whether "Synced" may be displayed is unit-testable -- the same reason
// stateLabel.ts is kept separate. The browser/network readers live in
// reconcile.ts, which imports from here.
//
// This exists because the popup used to render the SERVER's bookmark_count as if
// it were the browser's own, so the popup and the web UI always showed the same
// figure no matter what the real browser tree held — and "Synced" was claimed
// from nothing more than a valid token. Both were claims without evidence.
//
// The rule this file implements: the extension reports what the BROWSER holds,
// and "Synced" may only be claimed when local and server agree 1:1 on every
// link — url, title AND position. Anything else reports the real difference.
//
// Comparison is by node id, which is exact: the server stores the browser's own
// bookmark ids, so the same id must carry the same url, title, parent and index
// on both sides.

/** One comparable node. `index` is its position among its siblings. */
export interface LeafRef {
  id: string;
  parentId: string | null;
  index: number;
  title: string;
  url: string | null;
  isFolder: boolean;
}

export interface TreeDiff {
  /** ALL nodes, links and folders. Used for the comparison itself. */
  localCount: number;
  serverCount: number;
  /** LINKS ONLY — the one denominator every surface displays. Folders are
   *  containers, not items, and mixing the two produced a popup showing 2145
   *  next to a web UI showing 856 for the same data. */
  localLinks: number;
  serverLinks: number;
  /** Exists in the browser, absent on the server. */
  missingOnServer: string[];
  /** Exists on the server, absent in the browser. */
  missingLocally: string[];
  titleMismatch: string[];
  urlMismatch: string[];
  /** Same node, different parent or different position among siblings. */
  placeMismatch: string[];
  /** Total nodes that differ in any way. */
  differences: number;
  /** True ONLY when every node matches on url, title and position. */
  identical: boolean;
}

/** Normalise a url for comparison; the browser and server can differ on a
 *  trailing slash without meaning anything different. */
function sameUrl(a: string | null, b: string | null): boolean {
  const norm = (u: string | null) => (u ?? "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/**
 * Compare two node sets. PURE — no browser, no network — so the rule that
 * decides whether "Synced" may be shown is unit-testable.
 */
export function diffTrees(local: LeafRef[], server: LeafRef[]): TreeDiff {
  const byIdServer = new Map(server.map((n) => [n.id, n]));
  const byIdLocal = new Map(local.map((n) => [n.id, n]));

  const missingOnServer: string[] = [];
  const titleMismatch: string[] = [];
  const urlMismatch: string[] = [];
  const placeMismatch: string[] = [];

  for (const l of local) {
    const s = byIdServer.get(l.id);
    if (!s) {
      missingOnServer.push(l.id);
      continue;
    }
    if ((l.title ?? "") !== (s.title ?? "")) titleMismatch.push(l.id);
    if (!sameUrl(l.url, s.url)) urlMismatch.push(l.id);
    if ((l.parentId ?? null) !== (s.parentId ?? null) || l.index !== s.index) {
      placeMismatch.push(l.id);
    }
  }

  const missingLocally = server.filter((s) => !byIdLocal.has(s.id)).map((s) => s.id);

  // A node counted once even if it differs in several ways.
  const differing = new Set([
    ...missingOnServer,
    ...missingLocally,
    ...titleMismatch,
    ...urlMismatch,
    ...placeMismatch,
  ]);

  return {
    localCount: local.length,
    serverCount: server.length,
    localLinks: local.filter((n) => !n.isFolder).length,
    serverLinks: server.filter((n) => !n.isFolder).length,
    missingOnServer,
    missingLocally,
    titleMismatch,
    urlMismatch,
    placeMismatch,
    differences: differing.size,
    identical: differing.size === 0,
  };
}

/** One line naming the biggest real discrepancy, for the popup. */
export function describeDiff(d: TreeDiff): string {
  if (d.identical) return "Every link, name and position matches.";
  const bits: string[] = [];
  if (d.missingOnServer.length) bits.push(`${d.missingOnServer.length} not on server`);
  if (d.missingLocally.length) bits.push(`${d.missingLocally.length} not in browser`);
  if (d.placeMismatch.length) bits.push(`${d.placeMismatch.length} moved`);
  if (d.titleMismatch.length) bits.push(`${d.titleMismatch.length} renamed`);
  if (d.urlMismatch.length) bits.push(`${d.urlMismatch.length} different url`);
  return bits.join(" · ");
}

/** Count only real links (folders excluded) — what the popup ring shows. */
export function linkCount(nodes: LeafRef[]): number {
  return nodes.filter((n) => !n.isFolder).length;
}

// PURE content-match merge for a fresh browser joining a collection that already
// has bookmarks.
//
// The whole sync model assumes "the browser id IS the server id". That holds once
// a device has synced, but a freshly-installed browser mints its OWN ids, so the
// same link exists under two different ids — the server's (from another device)
// and this browser's. Matching by id alone therefore sees zero overlap and pushes
// the browser's whole tree as brand-new creates, duplicating everything the server
// already had (observed live: server 100 links + fresh browser 120 = 220 rows,
// 100 of them duplicate urls).
//
// This module matches by CONTENT instead, and converges on the BROWSER's id (the
// established authority). It is deliberately conservative: two nodes are only
// treated as the same link when their content key (normalised url + title + folder
// path) is UNIQUE on BOTH sides. Any key that is ambiguous — a url the user
// deliberately bookmarked twice, in either tree — is left untouched, so a merge can
// never silently collapse links the user meant to keep apart.
//
// Pure: no browser, no network. The executor lives in bookmarks.ts.

export interface MergeNode {
  id: string;
  parentId: string | null;
  title: string;
  url: string | null;
  isFolder: boolean;
}

/** Normalise a url for matching: drop the trailing slash (browser and server can
 *  differ there without meaning anything different) and the scheme/case noise. */
function normUrl(u: string | null): string {
  if (!u) return "";
  let s = u.trim().replace(/\/+$/, "");
  s = s.replace(/^https?:\/\//i, "");
  return s.toLowerCase();
}

/** Folder path by TITLE, from the root down, so the same link in the same-named
 *  folder matches across devices that minted different folder ids. Roots that are
 *  browser-universal ("1"/"2"/"3" -> Bookmarks Bar / Other / Mobile) are named by
 *  their stable label so the path is comparable. */
const ROOT_NAMES: Record<string, string> = {
  "1": "Bookmarks bar",
  "2": "Other bookmarks",
  "3": "Mobile bookmarks",
};

function buildPaths(nodes: MergeNode[]): Map<string, string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const paths = new Map<string, string>();
  const pathOf = (id: string, depth: number): string => {
    if (paths.has(id)) return paths.get(id)!;
    if (depth > 64) return "";
    const n = byId.get(id);
    if (!n) return "";
    const parent = n.parentId;
    let label = n.title?.trim() || ROOT_NAMES[id] || "";
    if (parent === null || parent === undefined || !byId.has(parent)) {
      // A universal browser root: name it canonically.
      label = ROOT_NAMES[id] || label || "";
    }
    const p = parent ? pathOf(parent, depth + 1) : "";
    const full = p ? `${p}/${label}` : label;
    paths.set(id, full);
    return full;
  };
  for (const n of nodes) {
    if (n.parentId) pathOf(n.parentId, 0);
  }
  return paths;
}

/** Content key for a LINK (folders are matched structurally by their children,
 *  not by this key). Two links match iff these are equal. */
function linkKey(n: MergeNode, folderPaths: Map<string, string>): string {
  const folder = n.parentId ? folderPaths.get(n.parentId) ?? "" : "";
  return `${normUrl(n.url)}\u0000${(n.title || "").trim().toLowerCase()}\u0000${folder.toLowerCase()}`;
}

export interface MergePlan {
  /** local id -> server id, for links that are the SAME content. The browser id
   *  wins; the server row is re-keyed to it (converge), not duplicated. */
  matches: { localId: string; serverId: string }[];
  /** Local node ids that are genuinely new to the server: unmatched links plus
   *  the folders needed to hold them. Parents appear before children. */
  localOnly: string[];
  /** Server node ids this browser lacks and should pull down: unmatched server
   *  links plus the folders needed to hold them. A redundant server folder (every
   *  link inside already matched a local one) is NOT pulled, so the merge does not
   *  litter the browser with empty duplicate folders. Parents before children. */
  serverPull: string[];
  /** Keys present on both sides but AMBIGUOUS (a deliberate duplicate, or a url
   *  appearing more than once on one side). Reported so the UI can be honest that
   *  these were left alone rather than merged. */
  ambiguousLinks: number;
}

/**
 * Compute the merge between a fresh browser tree and the server tree.
 *
 * Only LINKS are content-matched. A folder is matched implicitly: once its links
 * are adopted under the browser's ids, a server folder with no remaining
 * server-only children is redundant and is not pulled. Folders that still have
 * unmatched links stay in serverOnly so their links can be created under them.
 */
export function planMerge(local: MergeNode[], server: MergeNode[]): MergePlan {
  const localPaths = buildPaths(local);
  const serverPaths = buildPaths(server);

  const localLinks = local.filter((n) => !n.isFolder && n.url);
  const serverLinks = server.filter((n) => !n.isFolder && n.url);

  const localByKey = new Map<string, MergeNode[]>();
  for (const n of localLinks) {
    const k = linkKey(n, localPaths);
    const list = localByKey.get(k) ?? [];
    list.push(n);
    localByKey.set(k, list);
  }
  const serverByKey = new Map<string, MergeNode[]>();
  for (const n of serverLinks) {
    const k = linkKey(n, serverPaths);
    const list = serverByKey.get(k) ?? [];
    list.push(n);
    serverByKey.set(k, list);
  }

  const matches: { localId: string; serverId: string }[] = [];
  const matchedLocal = new Set<string>();
  const matchedServer = new Set<string>();
  let ambiguousLinks = 0;

  for (const [k, locals] of localByKey) {
    const servers = serverByKey.get(k);
    if (!servers || servers.length === 0) continue;
    // Guard: only collapse when the key is UNIQUE on BOTH sides. Anything else is
    // ambiguous (a deliberate duplicate, or the same url twice on one side) and is
    // left alone — merging it would lose a link the user wanted twice.
    if (locals.length !== 1 || servers.length !== 1) {
      ambiguousLinks += Math.min(locals.length, servers.length);
      continue;
    }
    const l = locals[0]!;
    const s = servers[0]!;
    matches.push({ localId: l.id, serverId: s.id });
    matchedLocal.add(l.id);
    matchedServer.add(s.id);
  }

  // Order parents before children so the executor can create top-down.
  const localById = new Map(local.map((n) => [n.id, n]));
  const serverById = new Map(server.map((n) => [n.id, n]));
  const byDepth = (ids: string[], byId: Map<string, MergeNode>) =>
    ids.slice().sort((a, b) => depthOf(a, byId) - depthOf(b, byId));

  const localOnly = byDepth(
    local
      .filter((n) => !matchedLocal.has(n.id))
      .filter((n) => !n.isFolder || hasUnmatchedLink(n, local, matchedLocal))
      .map((n) => n.id),
    localById
  );
  const serverPull = byDepth(
    server
      .filter((n) => !matchedServer.has(n.id))
      .filter((n) => !n.isFolder || hasUnmatchedLink(n, server, matchedServer))
      .map((n) => n.id),
    serverById
  );

  return { matches, localOnly, serverPull, ambiguousLinks };
}

function depthOf(id: string, byId: Map<string, MergeNode>): number {
  let d = 0;
  let cur: string | null | undefined = byId.get(id)?.parentId ?? null;
  while (cur && byId.has(cur) && d < 64) {
    d += 1;
    cur = byId.get(cur)?.parentId ?? null;
  }
  return d;
}

/** A local folder is only pushed up if it still contains a link that wasn't
 *  matched to a server row — otherwise the server already has an equivalent
 *  folder and re-creating it would be a structural duplicate. */
function hasUnmatchedLink(
  folder: MergeNode,
  all: MergeNode[],
  matched: Set<string>
): boolean {
  const children = all.filter((n) => n.parentId === folder.id);
  for (const c of children) {
    if (c.isFolder) {
      if (hasUnmatchedLink(c, all, matched)) return true;
    } else if (!matched.has(c.id)) {
      return true;
    }
  }
  return false;
}

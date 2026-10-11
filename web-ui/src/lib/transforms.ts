// Organise transforms.
//
// A transform is PURE: tree in, tree out, plus a human summary of what it did.
// It never touches the network. The page stages the result, the user sees it
// immediately, and Cancel simply discards it — which is why the preview costs
// nothing and can never half-apply.
//
// Committing is a separate step (the bulk reorganize endpoint), so every
// transform automatically inherits Cancel/Apply and undo.

import {
  cloneTree,
  countLeaves,
  descendantLeaves,
  type NewFolder,
  type TreeNode,
} from "./tree";
import { domainLabel, normalizedUrl } from "./domain";

export type TransformKind =
  | "reverse"
  | "sort-visits"
  | "sort-alpha"
  | "sort-recent"
  | "sort-added"
  | "group-domain"
  | "dedupe"
  | "dead-links"
  | "empty-folders";

export interface TransformResult {
  kind: TransformKind;
  /** Short label for the banner, e.g. "Sort by visits". */
  label: string;
  /** What will happen, in plain language, with real counts. */
  summary: string;
  /** The staged tree to render. */
  tree: TreeNode[];
  /** Node ids this transform removes (dedupe / dead links / empty folders). */
  removed: string[];
  /**
   * Folders the transform invented, carrying `new:` placeholder ids. The server
   * mints the real ids at apply time and rewrites the placements that reference
   * them — so a preview can show folders that do not exist yet.
   */
  newFolders?: NewFolder[];
  /**
   * Visit counts to fold into a survivor before its duplicates are deleted, so
   * de-duplicating never silently loses visit history.
   */
  mergeVisits?: { survivor: string; absorbed: string[] }[];
  /** True when nothing would change — the page declines to arm it. */
  noop: boolean;
  /** Destructive transforms get the red treatment, reorders the neutral one. */
  destructive: boolean;
  /**
   * The affirmative button's word. Each action names its own outcome — "Delete"
   * for duplicates, "Group" for group-by-domain, "Sort" for a sort — because a
   * generic "Apply" makes the user guess what they are agreeing to.
   */
  verb: string;
}

/** Recursively reorder every level with `cmp`, leaving membership untouched. */
export function sortRecursively(
  nodes: TreeNode[],
  cmp: (a: TreeNode, b: TreeNode) => number
): TreeNode[] {
  const out = cloneTree(nodes);
  const walk = (list: TreeNode[]) => {
    list.sort(cmp);
    list.forEach((n) => {
      if (n.children.length) walk(n.children);
    });
  };
  // Sort INSIDE each visible root (Bookmarks Bar, Other Bookmarks), never the
  // roots themselves — those are browser-owned containers.
  out.forEach((root) => {
    if (root.is_folder) walk(root.children);
  });
  return out;
}

/**
 * How many nodes genuinely change place: same definition the server uses when
 * it reports `moved` back from a commit — a node whose (parent, index) differs.
 * Counting flattened-order mismatches instead would inflate the number (one
 * early change shifts every later row), so the preview would promise a count
 * the result then contradicts.
 */
export function countMoved(before: TreeNode[], after: TreeNode[]): number {
  const place = (nodes: TreeNode[]) => {
    const m = new Map<string, string>();
    const walk = (list: TreeNode[], parent: string | null) =>
      list.forEach((n, i) => {
        m.set(n.node_id, `${parent}#${i}`);
        walk(n.children, n.node_id);
      });
    walk(nodes, null);
    return m;
  };
  const a = place(before);
  const b = place(after);
  let moved = 0;
  b.forEach((pos, id) => {
    if (a.get(id) !== pos) moved++;
  });
  return moved;
}

export function totalLeaves(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.is_folder ? countLeaves(n) : 1), 0);
}

// ---- reverse ---------------------------------------------------------------

export function reverseOrder(tree: TreeNode[]): TransformResult {
  const out = cloneTree(tree);
  const walk = (list: TreeNode[]) => {
    list.reverse();
    list.forEach((n) => n.children.length && walk(n.children));
  };
  out.forEach((root) => root.is_folder && walk(root.children));
  const moved = countMoved(tree, out);
  return {
    kind: "reverse",
    label: "Reverse order",
    summary: moved
      ? `Reverses the order of ${moved} item${moved === 1 ? "" : "s"} at every level. Folder contents are kept together.`
      : "Nothing to reverse.",
    tree: out,
    removed: [],
    noop: moved === 0,
    destructive: false,
    verb: "Reverse",
  };
}

// ---- sorts -----------------------------------------------------------------

/**
 * A folder's score is the AVERAGE over all its descendant leaves, at any depth —
 * so a folder of heavily-used links ranks alongside a heavily-used link, and one
 * stale link cannot drag a busy folder down as much as a plain sum would.
 * Folders are INTERLEAVED with links rather than forced to the top, because the
 * question the sort answers is "what do I use most", not "what is a folder".
 */
function folderAverage(n: TreeNode, valueOf: (leaf: TreeNode) => number): number {
  const leaves = descendantLeaves(n);
  if (!leaves.length) return 0;
  return leaves.reduce((sum, l) => sum + valueOf(l), 0) / leaves.length;
}

function scoreOf(n: TreeNode, valueOf: (leaf: TreeNode) => number): number {
  return n.is_folder ? folderAverage(n, valueOf) : valueOf(n);
}

/** Descending numeric sort with a stable, human tiebreak on name. */
function byScoreDesc(valueOf: (leaf: TreeNode) => number) {
  return (a: TreeNode, b: TreeNode) => {
    const d = scoreOf(b, valueOf) - scoreOf(a, valueOf);
    if (d !== 0) return d;
    return (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
  };
}

function sortResult(
  kind: TransformKind,
  label: string,
  describe: (moved: number) => string,
  tree: TreeNode[],
  cmp: (a: TreeNode, b: TreeNode) => number,
  verb = "Sort"
): TransformResult {
  const out = sortRecursively(tree, cmp);
  const moved = countMoved(tree, out);
  return {
    kind,
    label,
    summary: moved ? describe(moved) : "Already in this order.",
    tree: out,
    removed: [],
    noop: moved === 0,
    destructive: false,
    verb,
  };
}

export function sortByVisits(tree: TreeNode[]): TransformResult {
  return sortResult(
    "sort-visits",
    "Most visited first",
    (m) =>
      `Reorders ${m} item${m === 1 ? "" : "s"}, most-visited first. A folder ranks by the average visits of every link inside it, at any depth, and sits among the links rather than above them.`,
    tree,
    byScoreDesc((l) => l.visit_count || 0)
  );
}

export function sortByRecentVisit(tree: TreeNode[]): TransformResult {
  return sortResult(
    "sort-recent",
    "Recently visited",
    (m) =>
      `Reorders ${m} item${m === 1 ? "" : "s"} by most recent visit. Never-visited links sink to the bottom; folders rank by their average.`,
    tree,
    byScoreDesc((l) => l.last_visited_at || 0)
  );
}

export function sortByDateAdded(tree: TreeNode[]): TransformResult {
  return sortResult(
    "sort-added",
    "Recently added",
    (m) => `Reorders ${m} item${m === 1 ? "" : "s"}, newest bookmark first. Folders rank by their average.`,
    tree,
    byScoreDesc((l) => l.date_added || 0)
  );
}

export function sortAlphabetically(tree: TreeNode[]): TransformResult {
  return sortResult(
    "sort-alpha",
    "Alphabetical",
    (m) =>
      `Reorders ${m} item${m === 1 ? "" : "s"} by name, A→Z, ignoring case. Folders are sorted in among the links.`,
    tree,
    (a, b) =>
      (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }) ||
      (a.title || "").localeCompare(b.title || "")
  );
}

// ---- group by domain -------------------------------------------------------

/** The visible root that maps to the browser's bookmarks bar. */
function findBar(tree: TreeNode[]): TreeNode | undefined {
  return (
    tree.find((n) => n.is_folder && /bookmarks\s*bar|bookmarks\s*toolbar/i.test(n.title || "")) ??
    tree.find((n) => n.is_folder)
  );
}

/**
 * Regroup the Bookmarks Bar by registrable domain.
 *
 * Scope is deliberately the Bookmarks Bar ONLY: Other Bookmarks is not visible
 * in the browser, so silently restructuring it would be a change the user cannot
 * see. Existing folders inside the bar are dissolved and their links reabsorbed;
 * a domain with a single link stays loose rather than getting a one-item folder;
 * folders are named by registrable domain with the suffix dropped ("google", not
 * "google.com"), and every subdomain collapses into that one folder.
 */
export function groupByDomain(tree: TreeNode[]): TransformResult {
  const out = cloneTree(tree);
  const bar = findBar(out);
  if (!bar) {
    return {
      kind: "group-domain",
      label: "Group by domain",
      summary: "No Bookmarks Bar found to group.",
      tree: out,
      removed: [],
      noop: true,
      destructive: false,
      verb: "Group",
    };
  }

  // Every link anywhere under the bar. The folders it currently sits in are
  // DISSOLVED: their links are reabsorbed into domain folders and the old
  // folders themselves must be deleted, or the server keeps them behind as empty
  // shells. They are listed in `removed`; the server is careful not to cascade
  // that removal onto the links being relocated in the same request.
  const leaves = descendantLeaves(bar);
  const dissolvedIds = folderIdsUnder(bar);
  const dissolved = dissolvedIds.length;
  if (!leaves.length) {
    return {
      kind: "group-domain",
      label: "Group by domain",
      summary: "The Bookmarks Bar has no links to group.",
      tree: out,
      removed: [],
      noop: true,
      destructive: false,
      verb: "Group",
    };
  }

  const buckets = new Map<string, TreeNode[]>();
  for (const leaf of leaves) {
    const key = domainLabel(leaf.url) || "other";
    const list = buckets.get(key) ?? [];
    list.push(leaf);
    buckets.set(key, list);
  }

  const newFolders: NewFolder[] = [];
  const children: TreeNode[] = [];
  // Domains A→Z, and the links inside each folder A→Z by name.
  const keys = [...buckets.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
  let folderSeq = 0;
  for (const key of keys) {
    const items = buckets.get(key)!.sort((a, b) =>
      (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" })
    );
    const only = items.length === 1 ? items[0] : undefined;
    if (only) {
      // A single link does not earn a folder — it stays loose in the bar.
      children.push({ ...only, children: [] });
      continue;
    }
    const placeholder = `new:dom-${folderSeq++}`;
    newFolders.push({
      node_id: placeholder,
      parent_id: bar.node_id,
      title: key,
      index: 0, // real index assigned below, once the level is ordered
    });
    children.push({
      ...bar,
      node_id: placeholder,
      parent_id: bar.node_id,
      title: key,
      url: null,
      is_folder: true,
      visit_count: 0,
      children: items.map((i) => ({ ...i, parent_id: placeholder, children: [] })),
    });
  }

  // Order the bar's new top level: folders and loose links interleaved, A→Z.
  children.sort((a, b) => (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }));
  children.forEach((c, i) => {
    c.position = i;
    const nf = newFolders.find((f) => f.node_id === c.node_id);
    if (nf) nf.index = i;
  });
  bar.children = children;

  const folderCount = newFolders.length;
  const loose = children.length - folderCount;
  return {
    kind: "group-domain",
    label: "Group by domain",
    summary:
      `Regroups ${leaves.length} link${leaves.length === 1 ? "" : "s"} in the Bookmarks Bar into ` +
      `${folderCount} domain folder${folderCount === 1 ? "" : "s"}` +
      (loose ? `, leaving ${loose} single-link domain${loose === 1 ? "" : "s"} loose` : "") +
      `. ${dissolved ? `Dissolves the ${dissolved} existing folder${dissolved === 1 ? "" : "s"} there. ` : ""}` +
      `Other Bookmarks is left alone.`,
    tree: out,
    newFolders,
    removed: dissolvedIds,
    noop: false,
    destructive: false,
    verb: "Group",
  };
}

/** Every folder id at any depth under a node (not the node itself). */
function folderIdsUnder(n: TreeNode): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode[]) =>
    list.forEach((c) => {
      if (c.is_folder) {
        out.push(c.node_id);
        walk(c.children);
      }
    });
  walk(n.children);
  return out;
}

// ---- clean up --------------------------------------------------------------

/** Remove ids from a tree, dropping folders' subtrees with them. */
function pruneIds(nodes: TreeNode[], doomed: Set<string>): TreeNode[] {
  return nodes
    .filter((n) => !doomed.has(n.node_id))
    .map((n) => ({ ...n, children: pruneIds(n.children, doomed) }));
}

function allLeaves(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: TreeNode[]) =>
    list.forEach((n) => (n.is_folder ? walk(n.children) : out.push(n)));
  walk(nodes);
  return out;
}

/**
 * Delete exact duplicates: same normalised URL. Which copy survives does not
 * matter — they point at the same page — so the first in tree order is kept and
 * the rest are dropped. The survivor ABSORBS the others' visit counts, so
 * de-duplicating never silently loses usage history (the server performs the
 * merge, and undo restores both the nodes and the original counts).
 */
export function deleteDuplicates(tree: TreeNode[]): TransformResult {
  const seen = new Map<string, TreeNode>();
  const doomed = new Set<string>();
  const mergeMap = new Map<string, string[]>();

  for (const leaf of allLeaves(tree)) {
    const key = normalizedUrl(leaf.url);
    if (!key) continue;
    const first = seen.get(key);
    if (!first) {
      seen.set(key, leaf);
      continue;
    }
    doomed.add(leaf.node_id);
    const list = mergeMap.get(first.node_id) ?? [];
    list.push(leaf.node_id);
    mergeMap.set(first.node_id, list);
  }

  const n = doomed.size;
  const groups = mergeMap.size;
  return {
    kind: "dedupe",
    label: "Delete duplicates",
    summary: n
      ? `Removes ${n} duplicate link${n === 1 ? "" : "s"} across ${groups} URL${groups === 1 ? "" : "s"}. ` +
        `One copy of each is kept — they point at the same page, so it does not matter which — and its visit count ` +
        `absorbs the copies', so no usage history is lost. Undo restores them.`
      : "No duplicate URLs found.",
    tree: pruneIds(tree, doomed),
    removed: [...doomed],
    mergeVisits: [...mergeMap.entries()].map(([survivor, absorbed]) => ({ survivor, absorbed })),
    noop: n === 0,
    destructive: true,
    verb: "Delete",
  };
}

/**
 * Delete links whose last liveness check FAILED. Links that were never checked
 * are left alone — "not checked" is not evidence of being dead, and deleting on
 * that basis would throw away working bookmarks. A link that was deliberately
 * SKIPPED (a LAN host the operator didn't allow, or a blocked address) is also
 * left alone, and reported separately from never-checked so the summary is not
 * misleading about why it has no verdict.
 */
export function deleteDeadLinks(tree: TreeNode[]): TransformResult {
  const leaves = allLeaves(tree);
  const doomed = new Set(
    leaves.filter((l) => l.ok === false).map((l) => l.node_id)
  );
  const skipped = leaves.filter((l) => l.ok === null && !!l.status_error).length;
  const unchecked = leaves.filter((l) => (l.ok === null || l.ok === undefined) && !l.status_error).length;
  const n = doomed.size;
  const leftover = [
    unchecked ? `${unchecked} have never been checked` : "",
    skipped ? `${skipped} skipped` : "",
  ].filter(Boolean).join(", ");
  return {
    kind: "dead-links",
    label: "Delete dead links",
    summary: n
      ? `Removes ${n} link${n === 1 ? "" : "s"} that failed the last liveness check.` +
        (leftover ? ` ${leftover} — run Check links first to include them.` : "")
      : leftover
        ? `No links are known to be dead. ${leftover} — run Check links first.`
        : "No dead links found.",
    tree: pruneIds(tree, doomed),
    removed: [...doomed],
    noop: n === 0,
    destructive: true,
    verb: "Delete",
  };
}

/**
 * Delete folders containing no links at any depth. Applied repeatedly, so a
 * folder whose only content is other empty folders also goes. The visible roots
 * (Bookmarks Bar, Other Bookmarks) are browser-owned and never removed.
 */
export function deleteEmptyFolders(tree: TreeNode[]): TransformResult {
  const doomed = new Set<string>();
  const rootIds = new Set(tree.map((r) => r.node_id));

  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (!n.is_folder) continue;
      walk(n.children);
      if (!rootIds.has(n.node_id) && countLeaves(n) === 0) doomed.add(n.node_id);
    }
  };
  walk(tree);

  const n = doomed.size;
  return {
    kind: "empty-folders",
    label: "Delete empty folders",
    summary: n
      ? `Removes ${n} folder${n === 1 ? "" : "s"} with no links inside at any depth. Folders whose only contents are other empty folders go too. Bookmarks Bar and Other Bookmarks are never removed.`
      : "No empty folders found.",
    tree: pruneIds(tree, doomed),
    removed: [...doomed],
    noop: n === 0,
    destructive: true,
    verb: "Delete",
  };
}

// ---- registry --------------------------------------------------------------

/** Every implemented transform, by kind. The page needs no switch statement. */
export const TRANSFORMS: Record<TransformKind, (tree: TreeNode[]) => TransformResult> = {
  reverse: reverseOrder,
  "sort-visits": sortByVisits,
  "sort-alpha": sortAlphabetically,
  "sort-recent": sortByRecentVisit,
  "sort-added": sortByDateAdded,
  "group-domain": groupByDomain,
  dedupe: deleteDuplicates,
  "dead-links": deleteDeadLinks,
  "empty-folders": deleteEmptyFolders,
};

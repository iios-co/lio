// The canonical bookmark-tree model. ONE implementation, shared by the view and
// by every organise transform — so a staged preview and the committed result can
// never be built by two different code paths.

import type { UsageRow } from "../types";

export interface TreeNode extends UsageRow {
  children: TreeNode[];
}

/** Build the hierarchy, each level in the browser's integer `position` order. */
export function buildTree(rows: UsageRow[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  rows.forEach((r) => byId.set(r.node_id, { ...r, children: [] }));
  const roots: TreeNode[] = [];
  byId.forEach((node) => {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });

  // Tie-break on node_id, not title. Real trees contain siblings sharing a
  // position integer, and the server ranks those by id — breaking the tie by
  // title here instead would order them differently from the server, so an
  // organise preview would promise a different result than it produced.
  const sortLevel = (list: TreeNode[]) => {
    list.sort((a, b) => a.position - b.position || a.node_id.localeCompare(b.node_id));
    list.forEach((n) => sortLevel(n.children));
  };
  sortLevel(roots);

  // Unwrap the browser's hidden root container (a top-level folder with no
  // title), so "Bookmarks Bar" / "Other Bookmarks" are the visible roots.
  const top: TreeNode[] = [];
  for (const n of roots) {
    if (n.is_folder && !(n.title || "").trim()) top.push(...n.children);
    else top.push(n);
  }
  top.sort((a, b) => a.position - b.position || a.node_id.localeCompare(b.node_id));
  return top;
}

/** Prune to nodes matching `q`, keeping ancestors of matches. */
export function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const ql = q.toLowerCase();
  const walk = (list: TreeNode[]): TreeNode[] =>
    list.reduce<TreeNode[]>((acc, n) => {
      const kids = walk(n.children);
      const hit =
        (n.title || "").toLowerCase().includes(ql) || (n.url || "").toLowerCase().includes(ql);
      if (hit || kids.length) acc.push({ ...n, children: kids });
      return acc;
    }, []);
  return walk(nodes);
}

/** Leaf (non-folder) descendants of a node. */
export function countLeaves(n: TreeNode): number {
  return n.children.reduce((sum, c) => sum + (c.is_folder ? countLeaves(c) : 1), 0);
}

/** Every leaf under a node, at any depth. */
export function descendantLeaves(n: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  for (const c of n.children) {
    if (c.is_folder) out.push(...descendantLeaves(c));
    else out.push(c);
  }
  return out;
}

export interface FlatRow {
  node: TreeNode;
  depth: number;
}

/** Flatten to the VISIBLE rows, so one DndContext can serve the whole tree. */
export function flatten(
  nodes: TreeNode[],
  expanded: Set<string>,
  forceOpen: boolean,
  depth = 0
): FlatRow[] {
  const out: FlatRow[] = [];
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.is_folder && (forceOpen || expanded.has(n.node_id)) && n.children.length) {
      out.push(...flatten(n.children, expanded, forceOpen, depth + 1));
    }
  }
  return out;
}

export function isDescendant(node: TreeNode, id: string): boolean {
  return node.children.some((c) => c.node_id === id || isDescendant(c, id));
}

/** Index nodes by id (all depths). */
export function indexById(nodes: TreeNode[]): Map<string, TreeNode> {
  const m = new Map<string, TreeNode>();
  const walk = (list: TreeNode[]) =>
    list.forEach((n) => {
      m.set(n.node_id, n);
      walk(n.children);
    });
  walk(nodes);
  return m;
}

/** Deep copy, so a transform can never mutate the tree the view is rendering. */
export function cloneTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((n) => ({ ...n, children: cloneTree(n.children) }));
}

// ---- Arrangement: the wire format for committing a reorganisation ----------

export interface PlacedNode {
  node_id: string;
  parent_id: string | null;
  index: number;
}

/** True if node represents a universal browser root container that must never be removed or re-parented. */
export function isBrowserRoot(n: TreeNode): boolean {
  if (
    n.node_id === "0" ||
    n.node_id === "1" ||
    n.node_id === "2" ||
    n.node_id === "3" ||
    n.node_id === "menu" ||
    n.node_id === "toolbar_____" ||
    n.node_id === "unfiled_____" ||
    n.node_id === "mobile______" ||
    n.node_id === "menu________"
  ) {
    return true;
  }
  const t = (n.title || "").trim().toLowerCase();
  return /^(bookmarks\s*(bar|toolbar|menu)|other\s*bookmarks|unfiled\s*bookmarks|mobile\s*bookmarks)$/i.test(t);
}

/**
 * Flatten a tree into explicit (parent, index) placements — what the bulk
 * reorganize endpoint consumes.
 *
 * The VISIBLE ROOTS themselves are deliberately NOT placed. They are the
 * browser's own containers (Bookmarks Bar, Other Bookmarks); no transform ever
 * reorders them, and their parent is the hidden root container, which the
 * extension does not sync as a node — so emitting a placement for them would
 * reference a parent id that has no row and get the whole request rejected.
 * Only their descendants are placed.
 */
export function toArrangement(nodes: TreeNode[]): PlacedNode[] {
  const out: PlacedNode[] = [];
  const walk = (list: TreeNode[], parentId: string | null) => {
    list.forEach((n, i) => {
      out.push({ node_id: n.node_id, parent_id: parentId, index: i });
      if (n.children && n.children.length) walk(n.children, n.node_id);
    });
  };
  const topNonRoots: TreeNode[] = [];
  for (const root of nodes) {
    if (isBrowserRoot(root)) {
      if (root.is_folder) walk(root.children, root.node_id);
    } else {
      topNonRoots.push(root);
    }
  }
  if (topNonRoots.length) {
    walk(topNonRoots, topNonRoots[0]?.parent_id ?? null);
  }
  return out;
}

/** New folders a transform invented, which must be created before placement. */
export interface NewFolder {
  node_id: string;
  parent_id: string | null;
  title: string;
  index: number;
}

export function isPlaceholderId(id: string): boolean {
  return id.startsWith("new:");
}

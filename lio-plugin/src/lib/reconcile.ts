// Reads the two trees the comparison needs: the real local browser tree, and the
// server's view of the same collection. The comparison itself is PURE and lives
// in treeDiff.ts so it can be unit-tested without a browser.

import { api } from "./api";
import { getSyncConfig } from "./config";
import { walkInScope, buildScopeFilter } from "./bookmarks";
import type { LeafRef } from "./treeDiff";

export type { LeafRef, TreeDiff } from "./treeDiff";
export { diffTrees, describeDiff, linkCount } from "./treeDiff";

interface BNode {
  id: string;
  parentId?: string;
  index?: number;
  title?: string;
  url?: string;
  children?: BNode[];
}

/**
 * Every in-scope node in the REAL browser tree. Mirrors `fullPushInScope`'s
 * rules exactly — same hidden-root-container skip, same scope filter — so the
 * comparison covers precisely the node set that is supposed to sync. If it used
 * different rules, a mismatch would just mean the two walks disagreed.
 */
export async function localNodes(): Promise<LeafRef[]> {
  const roots = (await browser.bookmarks.getTree()) as Browser.bookmarks.BookmarkTreeNode[];
  const syncCfg = await getSyncConfig();
  const filter = buildScopeFilter(roots, syncCfg);
  const nodes = walkInScope(roots, filter);
  return nodes.map((n) => ({
    id: n.id,
    parentId: n.parentId,
    index: n.index,
    title: n.title,
    url: n.url,
    isFolder: n.isFolder,
  }));
}

/**
 * Everything the browser actually holds under `folderId` ("" = the whole tree),
 * excluding the folder itself. This is a plain subtree read: it does NOT consult
 * the sync config, so pausing syncing never changes the local count.
 */
export async function folderNodes(folderId: string): Promise<LeafRef[]> {
  const out: LeafRef[] = [];
  const collect = (nodes: BNode[]) => {
    for (const n of nodes) {
      const isRootContainer = !n.parentId && !(n.title ?? "").trim();
      if (!isRootContainer) {
        out.push({
          id: n.id,
          parentId: n.parentId ?? null,
          index: n.index ?? 0,
          title: n.title ?? "",
          url: n.url ?? null,
          isFolder: n.url == null,
        });
      }
      if (n.children) collect(n.children);
    }
  };
  if (folderId) {
    const sub = (await browser.bookmarks.getSubTree(folderId).catch(() => [])) as BNode[];
    for (const root of sub) if (root.children) collect(root.children);
  } else {
    collect((await browser.bookmarks.getTree()) as BNode[]);
  }
  return out;
}

interface ServerNode {
  id: string;
  parent_id: string | null;
  position: number;
  title: string;
  url: string | null;
  is_folder: boolean;
}

/** The server's view of the same collection. Null when it could not be read —
 *  the caller must NOT treat that as "matched". */
export async function serverNodes(): Promise<LeafRef[] | null> {
  const res = await api.getTree();
  if (!res) return null;
  return (res.nodes as ServerNode[]).map((n) => ({
    id: n.id,
    parentId: n.parent_id ?? null,
    index: n.position ?? 0,
    title: n.title ?? "",
    url: n.url ?? null,
    isFolder: !!n.is_folder,
  }));
}

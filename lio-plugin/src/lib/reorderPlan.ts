// Robust bookmark move-apply, shared by the extension and its unit test.
//
// browser.bookmarks.move interprets the destination `index` inconsistently
// across engines: for a same-parent move to a HIGHER index, Chrome effectively
// counts the index against the pre-removal array (landing one slot short),
// while Firefox counts it against the post-removal array. A server reorder gives
// us the desired FINAL index, so we move, read the node back, and — if it didn't
// land where asked — issue exactly one corrective move. Browser-agnostic and
// bounded (no retry loops).

export interface BookmarkNodeLike {
  index?: number;
  parentId?: string;
}

export interface BookmarksMoveApi {
  get(id: string): Promise<BookmarkNodeLike[]>;
  move(id: string, dest: { parentId?: string; index?: number }): Promise<unknown>;
  getChildren?(id: string): Promise<unknown[]>;
}

export function clampIndex(i: number, len: number): number {
  if (!Number.isFinite(i) || i < 0) return 0;
  return i > len ? len : i;
}

async function currentIndex(bm: BookmarksMoveApi, id: string): Promise<number | null> {
  try {
    const got = await bm.get(id);
    const node = got && got[0];
    return node && typeof node.index === "number" ? node.index : null;
  } catch {
    return null;
  }
}

export async function applyMove(
  bm: BookmarksMoveApi,
  opts: { nodeId: string; parentId?: string | null; targetIndex: number }
): Promise<void> {
  const { nodeId, targetIndex } = opts;
  const parentId = opts.parentId || undefined;
  const doMove = (index: number) => bm.move(nodeId, { parentId, index });

  let siblingCount: number | null = null;
  if (parentId && typeof bm.getChildren === "function") {
    try {
      const kids = await bm.getChildren(parentId);
      if (Array.isArray(kids)) siblingCount = kids.length;
    } catch {
      /* fallback to heuristic */
    }
  }

  const firstMoveTarget = targetIndex < 0 ? 0 : targetIndex;
  const effectiveTarget = siblingCount == null ? firstMoveTarget : clampIndex(firstMoveTarget, siblingCount);
  await doMove(effectiveTarget);

  const landed = await currentIndex(bm, nodeId);
  if (landed == null || landed === effectiveTarget) return;

  // One correction, pushing in the direction of the shortfall.
  const corrected = effectiveTarget + (effectiveTarget - landed);
  const correctionBound = siblingCount ?? (Math.max(effectiveTarget, landed) + 1);
  await doMove(clampIndex(corrected, correctionBound));
}

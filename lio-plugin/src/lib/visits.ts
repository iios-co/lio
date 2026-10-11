// Visit tracking. When a tab finishes navigating to a URL that matches a synced
// bookmark, count an aggregate visit. Privacy: ONLY URLs that already exist as
// bookmarks in this browser are counted — general browsing is never recorded,
// and no `history` permission is needed (we use `tabs`, already held).
//
// Counts are deduped per-URL with a short cooldown, batched into
// browser.storage.local (survives SW restarts / offline), and flushed to
// POST /bookmarks/visits on the sync alarm.

import { api, type VisitIncrement } from "./api";
import { checkGate } from "./gate";

const PENDING_KEY = "visitPending";
const COOLDOWN_MS = 30_000;
const INDEX_TTL_MS = 60_000;

let urlIndex: Map<string, string> | null = null;
let indexBuiltAt = 0;
const lastCounted = new Map<string, number>();

interface PendingEntry { count: number; last: number }
type Pending = Record<string, PendingEntry>;

function normalize(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch {
    return null;
  }
}

async function buildIndex(): Promise<void> {
  const index = new Map<string, string>();
  const roots = await browser.bookmarks.getTree();
  const stack: Browser.bookmarks.BookmarkTreeNode[] = [...roots];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.url) {
      const n = normalize(node.url);
      if (n) index.set(n, node.id);
    }
    if (node.children) stack.push(...node.children);
  }
  urlIndex = index;
  indexBuiltAt = Date.now();
}

async function ensureIndex(): Promise<void> {
  if (!urlIndex || Date.now() - indexBuiltAt > INDEX_TTL_MS) await buildIndex();
}

async function readPending(): Promise<Pending> {
  const { [PENDING_KEY]: p } = await browser.storage.local.get(PENDING_KEY);
  return p && typeof p === "object" ? (p as Pending) : {};
}

async function writePending(p: Pending): Promise<void> {
  await browser.storage.local.set({ [PENDING_KEY]: p });
}

export async function recordVisit(url: string): Promise<void> {
  if (!url || !/^https?:/i.test(url)) return;
  const norm = normalize(url);
  if (!norm) return;

  const nowT = Date.now();
  const prev = lastCounted.get(norm);
  if (prev && nowT - prev < COOLDOWN_MS) return;

  await ensureIndex();
  const nodeId = urlIndex!.get(norm);
  if (!nodeId) return; // not a synced bookmark

  lastCounted.set(norm, nowT);
  const pending = await readPending();
  const entry = pending[nodeId] || { count: 0, last: 0 };
  entry.count += 1;
  entry.last = nowT;
  pending[nodeId] = entry;
  await writePending(pending);
}

let inFlightFlush: Promise<{ flushed: number }> | null = null;

export async function flushVisits(): Promise<{ flushed: number }> {
  if (inFlightFlush) return inFlightFlush;
  inFlightFlush = (async () => {
    try {
      const pending = await readPending();
      const nodeIds = Object.keys(pending);
      if (!nodeIds.length) return { flushed: 0 };

      // Gate: leave the pending counts untouched when the server is unreachable or
      // the token isn't recognised, so visits accumulate instead of being dropped.
      const gate = await checkGate();
      if (gate.state !== "ok") return { flushed: 0 };

      const increments: VisitIncrement[] = nodeIds.map((nodeId) => ({
        node_id: nodeId,
        count: pending[nodeId]!.count,
        last_visited_at: pending[nodeId]!.last,
      }));

      await api.pushVisits(increments);
      const after = await readPending();
      for (const nodeId of nodeIds) {
        const a = after[nodeId];
        if (a) {
          a.count -= pending[nodeId]!.count;
          if (a.count <= 0) delete after[nodeId];
        }
      }
      await writePending(after);
      return { flushed: increments.length };
    } finally {
      inFlightFlush = null;
    }
  })();
  return inFlightFlush;
}

export function invalidateVisitIndex(): void {
  urlIndex = null;
}

// Offline queue for bookmark sync operations. When lio-server is unreachable, ops are
// appended here (browser.storage.local) and flushed in sequence on reconnect.

import type { SyncOperation } from "./api";

const QUEUE_KEY = "opQueue";

async function readQueue(): Promise<SyncOperation[]> {
  const { [QUEUE_KEY]: q } = await browser.storage.local.get(QUEUE_KEY);
  return Array.isArray(q) ? (q as SyncOperation[]) : [];
}

async function writeQueue(q: SyncOperation[]): Promise<void> {
  await browser.storage.local.set({ [QUEUE_KEY]: q });
}

export async function enqueueBatch(newOps: SyncOperation[]): Promise<void> {
  if (!newOps.length) return;
  const q = await readQueue();
  const newMovesByItemId = new Map<string, SyncOperation>();
  for (const op of newOps) {
    if (op.operation === "move") {
      newMovesByItemId.set(op.itemId, op);
    }
  }

  const replacedItemIds = new Set<string>();
  const merged: SyncOperation[] = [];

  for (const existing of q) {
    if (existing.operation === "move" && newMovesByItemId.has(existing.itemId)) {
      const replacement = newMovesByItemId.get(existing.itemId)!;
      merged.push(replacement);
      replacedItemIds.add(existing.itemId);
    } else {
      merged.push(existing);
    }
  }

  for (const op of newOps) {
    if (!replacedItemIds.has(op.itemId)) {
      merged.push(op);
    }
  }

  await writeQueue(merged);
}

export async function enqueue(op: SyncOperation): Promise<void> {
  await enqueueBatch([op]);
}

export async function size(): Promise<number> {
  return (await readQueue()).length;
}

/** Current queue contents, oldest first. */
export async function peek(): Promise<SyncOperation[]> {
  const q = await readQueue();
  return [...q].sort((a, b) => a.clientSequence - b.clientSequence);
}



/**
 * Atomically remove recognized operation IDs from storage queue while
 * retaining any operations queued during an in-flight sync.
 */
export async function acknowledge(opIds: string[]): Promise<{ remaining: number; acknowledged: number }> {
  if (!opIds || !opIds.length) {
    const q = await readQueue();
    return { remaining: q.length, acknowledged: 0 };
  }
  const ackSet = new Set(opIds);
  const q = await readQueue();
  const kept = q.filter((op) => !ackSet.has(op.operationId));
  const acknowledged = q.length - kept.length;
  await writeQueue(kept);
  return { remaining: kept.length, acknowledged };
}


export async function clear(): Promise<void> {
  await writeQueue([]);
}

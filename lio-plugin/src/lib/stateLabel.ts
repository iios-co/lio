// The single source of truth for what a sync state may CLAIM.
//
// Kept pure and separate from the popup so it is unit-testable. Two real bugs
// live in this file's history, both from a card reading state it did not own:
//
//  1. "Synced" was derived from "the token is valid" — no evidence a sync ever
//     completed. The tab count is LOCAL and drops when tabs close, so it is
//     never evidence of anything being sent.
//  2. Evidence and queues are PER CARD. The bookmark delta queue said "11
//     queued" on the tabs card, which has no such queue; and the tabs card
//     showed "not synced yet" while its own push record said "sent just now".
//
// Hence: `lastOkAt` and `queued` describe THIS card only. Callers must pass the
// evidence belonging to the card being rendered.

export type SyncLabel =
  | "no valid token"
  | "offline"
  | "paused"
  | "Syncing"
  | "not sent"
  | "Synced"
  | "not synced yet"
  | "not compared"
  | "differs"
  | `${number} differ`
  | `${number} queued`;

export interface LabelInputs {
  enabled: boolean;
  reachable: boolean | null;
  tokenValid: boolean | null;
  busy: boolean;
  /** Items queued for THIS card's own queue. Pass 0 when the card has none. */
  queued: number;
  /** When THIS card's work last succeeded. Null = never. */
  lastOkAt: number | null;
  /** Local state exists that has not been sent (e.g. tabs closed since push). */
  pending?: boolean;
  /**
   * Result of an ACTUAL node-for-node comparison of local vs server: true only
   * when every link matches on url, title and position. `null` means no
   * comparison could be made (server unreadable) — which is NOT a match.
   *
   * Cards that have nothing to compare (the tabs card) omit this and keep
   * relying on their own push evidence.
   */
  matched?: boolean | null;
  /** How many nodes differ, when a comparison was made and failed. */
  differences?: number;
}

/** Priority order matters: a problem always outranks a success claim. */
export function syncLabel(i: LabelInputs): SyncLabel {
  if (i.tokenValid === false) return "no valid token";
  if (i.reachable === false) return "offline";
  if (!i.enabled) return "paused";
  if (i.busy) return "Syncing";
  if (i.pending) return "not sent";
  if (i.queued > 0) return `${i.queued} queued`;

  // A card that CAN be compared must be: comparison performed, and identical.
  // Neither a successful push nor a valid token is evidence the two trees agree
  // — the bulk-delete path proved that by removing 1196 links on the server
  // while the browser kept every one of them.
  if (i.matched !== undefined) {
    if (i.matched === null) return "not compared";
    if (i.matched === false) {
      return i.differences && i.differences > 0 ? `${i.differences} differ` : "differs";
    }
    return "Synced";
  }

  if (i.lastOkAt) return "Synced";
  return "not synced yet";
}

/** True when the tabs on screen are not the tabs that were last pushed. */
export function tabsPending(
  liveCount: number,
  pushed: { at: number; count: number } | null | undefined
): boolean {
  if (!pushed) return true;
  return pushed.count !== liveCount;
}

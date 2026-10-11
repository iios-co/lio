// The sync GATE — the single precondition check every network path must pass.
//
//   Can I reach the API at the configured URL?
//     no  -> STOP EVERYTHING, retry on the next tick        (state: "unreachable")
//     yes -> Can I access a collection with this token?
//              no  -> STOP EVERYTHING, show "no valid token" (state: "invalid-token")
//              yes -> do everything                          (state: "ok")
//
// Nothing else in the extension may decide this for itself. Before the gate,
// each path failed independently and swallowed its own error, so a bad token
// still pushed deltas, queued work and reported success.

import { getConfig } from "./config";
import { log } from "./log";

export type GateState = "unconfigured" | "unreachable" | "invalid-token" | "ok";

export interface Gate {
  state: GateState;
  checkedAt: number;
  detail: string | null;
  collectionName: string | null;
  /** The SERVER's link count. Named for its source on purpose: an earlier
   *  version of this field was rendered in the popup as if it were the
   *  browser's own count, so the popup could never disagree with the web UI. */
  serverBookmarkCount: number | null;
  serverLastChangeAt: number | null;
}

const FRESH_MS = 10_000; // reuse a recent verdict rather than re-probing per call
let cached: Gate | null = null;
let inFlight: Promise<Gate> | null = null;

export function lastGate(): Gate | null {
  return cached;
}

export function isGateOpen(): boolean {
  return cached?.state === "ok";
}

async function probe(): Promise<Gate> {
  const now = Date.now();
  const cfg = await getConfig();
  const base = (cfg.endpoint || "").replace(/\/+$/, "");

  if (!base || !cfg.token) {
    return { state: "unconfigured", checkedAt: now, detail: "Not configured.", collectionName: null, serverBookmarkCount: null, serverLastChangeAt: null };
  }

  // 1. Is the API reachable at all? /healthz needs no credential, so this
  //    cleanly separates "server down" from "token wrong".
  try {
    const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(10000) });
    if (!health.ok) {
      return { state: "unreachable", checkedAt: now, detail: `Server returned ${health.status} on /healthz.`, collectionName: null, serverBookmarkCount: null, serverLastChangeAt: null };
    }
  } catch (e) {
    return { state: "unreachable", checkedAt: now, detail: `Can't reach ${base}: ${(e as Error).message}`, collectionName: null, serverBookmarkCount: null, serverLastChangeAt: null };
  }

  // 2. Does the token grant access to a real collection?
  try {
    const r = await fetch(`${base}/api/v1/collections/${encodeURIComponent(cfg.token)}/info`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(10000), // 10 second timeout so gate never hangs
    });
    if (r.ok) {
      const info = (await r.json()) as { name?: string | null; bookmark_count?: number; last_change_at?: number | null };
      return {
        state: "ok",
        checkedAt: now,
        detail: null,
        collectionName: info?.name ?? null,
        serverBookmarkCount: info?.bookmark_count ?? 0,
        serverLastChangeAt: info?.last_change_at ?? null,
      };
    }
    if (r.status === 404 || r.status === 401 || r.status === 403) {
      return {
        state: "invalid-token",
        checkedAt: now,
        detail: "This server does not recognise the token — the collection may have been deleted or its token rotated.",
        collectionName: null,
        serverBookmarkCount: null,
        serverLastChangeAt: null,
      };
    }
    return { state: "unreachable", checkedAt: now, detail: `Server error ${r.status}.`, collectionName: null, serverBookmarkCount: null, serverLastChangeAt: null };
  } catch (e) {
    return { state: "unreachable", checkedAt: now, detail: (e as Error).message, collectionName: null, serverBookmarkCount: null, serverLastChangeAt: null };
  }
}

/** Evaluate the gate. Reuses a verdict younger than FRESH_MS unless `force`. */
export async function checkGate(force = false): Promise<Gate> {
  if (!force && cached && Date.now() - cached.checkedAt < FRESH_MS) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const previous = cached;
    const next = await probe();
    cached = next;
    inFlight = null;

    // Log only on transition, so a persistent outage doesn't spam the feed.
    if (previous?.state !== next.state) {
      if (next.state === "ok") {
        await log({ kind: "synced", title: `Connected${next.collectionName ? ` to ${next.collectionName}` : ""}`, detail: "Sync resumed." });
      } else if (next.state === "unreachable") {
        await log({ kind: "error", title: "Server unreachable — sync paused", detail: next.detail ?? undefined });
      } else if (next.state === "invalid-token") {
        await log({ kind: "error", title: "No valid token — sync stopped", detail: next.detail ?? undefined });
      }
    }
    return next;
  })();

  return inFlight;
}

/** Invalidate the cached verdict (e.g. after the connection is edited). */
export function resetGate(): void {
  cached = null;
}

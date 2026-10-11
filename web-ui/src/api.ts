// API client.
//
// Auth model:
//  - The ADMIN session (cookie, set by POST /admin/login) authorizes the whole
//    console. Admin routes rely on the cookie (credentials: 'include').
//  - Per-collection data routes are still token-based (the plugin uses them
//    too). The admin UI knows each collection's token from GET /admin/collections,
//    so when you open a collection we use ITS token as the Bearer credential.
//    You never type a token.

import type {
  CheckResult,
  CollectionSummary,
  DeadLinkRow,
  SortDir,
  SortField,
  TabHistorySession,
  TabSession,
  UsageRow,
} from "./types";

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parseError(res: Response): Promise<string> {
  let detail = res.statusText;
  try {
    const j = await res.json();
    if (j?.detail) detail = j.detail;
  } catch {
    /* ignore */
  }
  return detail;
}

// ---- Admin (cookie-authorized) --------------------------------------------

async function adminReq<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/admin${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new ApiError(res.status, await parseError(res));
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const admin = {
  version: async (): Promise<string> => {
    try {
      const r = await fetch("/version");
      const j = (await r.json()) as { version?: string };
      return j.version ?? "?";
    } catch {
      return "?";
    }
  },
  state: () =>
    adminReq<{ setup_needed: boolean; authenticated: boolean; username: string | null }>(
      "/state"
    ),
  setup: (username: string, password: string) =>
    adminReq<{ ok: boolean }>("/setup", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    adminReq<{ ok: boolean }>("/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => adminReq<{ ok: boolean }>("/logout", { method: "POST" }),
  session: () => adminReq<{ ok: boolean }>("/session"),
  collections: () =>
    adminReq<{ collections: CollectionSummary[] }>("/collections"),
  createCollection: (name: string) =>
    adminReq<{ id: string; name: string; token: string }>("/collections", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  rotateToken: (cid: string) =>
    adminReq<{ id: string; token: string }>(`/collections/${cid}/rotate`, {
      method: "POST",
    }),
  renameCollection: (cid: string, name: string) =>
    adminReq<{ id: string; name: string }>(`/collections/${cid}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteCollection: (cid: string) =>
    adminReq<{ ok: boolean }>(`/collections/${cid}`, { method: "DELETE" }),
};

// ---- Per-collection data (token-authorized) -------------------------------

async function collReq<T>(
  token: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(
    `/api/v1/collections/${encodeURIComponent(token)}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    }
  );
  if (!res.ok) throw new ApiError(res.status, await parseError(res));
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface UsageParams {
  sort: SortField;
  dir: SortDir;
  q?: string;
  domain?: string;
  includeFolders?: boolean;
}

export interface ReorderOpts {
  before?: string | null;
  after?: string | null;
  sort_key?: string;
  parent_id?: string | null;
  index?: number;
}

// ---- Bulk reorganize wire types -------------------------------------------

/** A node's target place. `parent_id` may reference a `new:` placeholder. */
export interface PlacementBody {
  id: string;
  parent_id: string | null;
  index: number;
}

/** A folder the transform invented; the server mints the real id. */
export interface NewFolderBody {
  id: string;
  parent_id: string | null;
  title: string;
  index: number;
}

/** Visit counts to fold into a survivor before the duplicates are removed. */
export interface VisitMergeBody {
  survivor: string;
  absorbed: string[];
}

export interface ReorganizeBody {
  label: string;
  new_folders?: NewFolderBody[];
  placements?: PlacementBody[];
  removed?: string[];
  merge_visits?: VisitMergeBody[];
}

export interface ReorganizeResult {
  moved: number;
  created: number;
  removed: number;
  visits_merged: number;
  snapshot_id: number;
  id_map: Record<string, string>;
  server_timestamp: number;
}

export interface SnapshotSummary {
  id: number;
  label: string;
  node_count: number;
  created_at: number;
}

export interface CheckProgressEvent {
  type: "start" | "checked" | "done";
  id?: string;
  url?: string;
  title?: string;
  verdict?: "ok" | "dead" | "skipped";
  http_status?: number | null;
  error?: string | null;
  current?: number;
  total?: number;
  checked?: number;
  ok?: number;
  dead?: number;
  skipped?: number;
  disabled?: boolean;
  skip_reason?: string | null;
}

export interface UndoResult {
  restored_from: number;
  label: string;
  node_count: number;
  remaining_snapshots: number;
  server_timestamp: number;
}

export const coll = {
  usage(token: string, params: UsageParams): Promise<{ rows: UsageRow[] }> {
    const sp = new URLSearchParams({ sort: params.sort, dir: params.dir });
    if (params.q) sp.set("q", params.q);
    if (params.domain) sp.set("domain", params.domain);
    if (params.includeFolders) sp.set("include_folders", "true");
    return collReq(token, `/report/usage?${sp.toString()}`);
  },
  sessions: (token: string): Promise<{ sessions: TabSession[] }> =>
    collReq(token, `/tabs`),
  adoptSession: (token: string, deviceId: string) =>
    collReq(token, `/tabs/${encodeURIComponent(deviceId)}/adopt`, { method: "POST" }),
  discardSession: (token: string, deviceId: string): Promise<void> =>
    collReq(token, `/tabs/${encodeURIComponent(deviceId)}`, { method: "DELETE" }),
  historySessions: (token: string, deviceId?: string): Promise<{ history: TabHistorySession[] }> =>
    collReq(token, deviceId ? `/tabs/history?device_id=${encodeURIComponent(deviceId)}` : `/tabs/history`),
  deleteHistorySession: (token: string, historyId: number): Promise<void> =>
    collReq(token, `/tabs/history/${historyId}`, { method: "DELETE" }),
  dead: (token: string): Promise<{ rows: DeadLinkRow[] }> =>
    collReq(token, `/report/dead`),
  check: (token: string): Promise<CheckResult> =>
    collReq(token, `/report/check`, { method: "POST" }),
  checkStream: async (
    token: string,
    onEvent: (event: CheckProgressEvent) => void,
    signal?: AbortSignal
  ): Promise<void> => {
    const res = await fetch(
      `/api/v1/collections/${encodeURIComponent(token)}/report/check?stream=true`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal,
      }
    );
    if (!res.ok) {
      throw new ApiError(res.status, await parseError(res));
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            onEvent(data);
          } catch {
            /* ignore non-JSON */
          }
        }
      }
    }
  },
  remove: (
    token: string,
    nodeId: string
  ): Promise<{ deleted: number; node_ids: string[] }> =>
    collReq(token, `/bookmarks/${encodeURIComponent(nodeId)}`, { method: "DELETE" }),
  reorder: (
    token: string,
    nodeId: string,
    opts: ReorderOpts
  ): Promise<{ node_id: string; sort_key: string }> =>
    collReq(token, `/bookmarks/${encodeURIComponent(nodeId)}/reorder`, {
      method: "PATCH",
      body: JSON.stringify(opts),
    }),

  /**
   * Commit a whole staged arrangement in ONE transactional request. Either the
   * entire rearrangement lands or the tree is left exactly as it was — which is
   * what lets the UI stage a sweeping change without risking a half-applied
   * tree. The server snapshots first, so `undo` can reverse it in one step.
   */
  reorganize: (token: string, body: ReorganizeBody): Promise<ReorganizeResult> =>
    collReq(token, `/bookmarks/reorganize`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** The undo stack for this collection (newest first, last 5 kept). */
  snapshots: (token: string): Promise<{ snapshots: SnapshotSummary[] }> =>
    collReq(token, `/bookmarks/snapshots`),

  /** Restore a snapshot, visit counts included. */
  undo: (token: string, snapshotId?: number): Promise<UndoResult> =>
    collReq(token, `/bookmarks/undo${snapshotId ? `?snapshot_id=${snapshotId}` : ""}`, { method: "POST" }),
};

export { ApiError };

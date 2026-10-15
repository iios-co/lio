// lio-server API client.

import { getConfig } from "./config";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface DeltaOp {
  op: "create" | "update" | "move" | "delete";
  node_id: string;
  parent_id?: string | null;
  index?: number;
  title?: string;
  url?: string | null;
  is_folder?: boolean;
  date_added?: number;
  timestamp: number;
  icon_base64?: string | null;
  /** On a `create`: the id of an existing server row that is the SAME link under
   *  this browser's new id. The server folds its visit history into the new row
   *  and removes the old one, so a fresh-install merge adopts the link instead of
   *  duplicating it. */
  merge_from?: string | null;
}
export interface SyncOperationChanges {
  parentId?: string | null;
  index?: number;
  title?: string;
  url?: string | null;
  isFolder?: boolean;
  dateAdded?: number;
  dateModified?: number;
  iconBase64?: string | null;
  mergeFrom?: string | null;
}

export interface SyncOperation {
  operationId: string;       // `${clientId}:${clientSequence}`
  clientId: string;          // Persistent client device UUID
  clientSequence: number;    // Monotonically increasing integer per client (1, 2, 3...)
  itemId: string;            // Bookmark node ID
  operation: "create" | "update" | "move" | "delete";
  changes: SyncOperationChanges;
  lastServerVersion: number; // The latest serverVersion the client held when issuing this op
}

export interface SyncBatchRequest {
  clientId: string;
  lastServerVersion: number;
  operations: SyncOperation[];
}

export interface DeltaChangeData {
  parentId?: string | null;
  position?: number;
  title?: string;
  url?: string | null;
  isFolder?: boolean;
  dateAdded?: number;
  dateModified?: number;
  iconBase64?: string | null;
  reason?: string;
  [key: string]: unknown;
}

export interface DeltaChange {
  serverVersion: number;     // Monotonically increasing server log ID
  itemId: string;
  operation: "create" | "update" | "move" | "delete" | "resync";
  data: DeltaChangeData;
}

export interface SyncBatchResponse {
  acknowledgedOperations: string[];
  changes: DeltaChange[];
  currentServerVersion: number;
  serverTimestamp: number;
}


export interface VisitIncrement {
  node_id: string;
  count: number;
  last_visited_at?: number;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const cfg = await getConfig();
  if (!cfg.endpoint || !cfg.token) {
    throw new ApiError(0, "Extension is not configured (missing endpoint or token).");
  }
  const base = cfg.endpoint.replace(/\/+$/, "");
  const url = `${base}/api/v1/collections/${encodeURIComponent(cfg.token)}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(body != null ? { "Content-Type": "application/json" } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000), // 30 sec timeout so it never hangs infinitely
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const j = await res.json();
        if (j?.detail) {
          if (typeof j.detail === "string") {
            detail = j.detail;
          } else if (Array.isArray(j.detail)) {
            detail = j.detail
              .map((d: unknown) => {
                if (d && typeof d === "object") {
                  if ("msg" in d && typeof d.msg === "string") return d.msg;
                  if ("detail" in d && typeof d.detail === "string") return d.detail;
                }
                return JSON.stringify(d);
              })
              .join("; ");
          } else {
            detail = JSON.stringify(j.detail);
          }
        }
      } catch { /* non-JSON */ }
      throw new ApiError(res.status, detail);
    }
    if (res.status === 204) return null;
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, (e as Error).message || "Network timeout or failure");
  }
}

export interface TabItem {
  title: string;
  url: string | null;
}

export interface TabSessionSummary {
  device_id: string;
  device_name: string;
  updated_at: number;
  tab_count: number;
  /** The actual captured tabs. The server has always returned these; the client
   *  type omitted them, so nothing could compare against what was really sent. */
  tabs?: TabItem[];
}

export interface CollectionInfo {
  /** Newest server-side change in ms, EXCLUDING this device's own writes when a
   *  device_id is supplied. The basis for tree-level last-write-wins. */
  last_change_at?: number | null;
  id: string;
  name: string | null;
  bookmark_count: number;
  folder_count: number;
  device_count: number;
}

export const api = {
  info: (deviceId?: string) =>
    request<CollectionInfo>(
      "GET",
      deviceId ? `/info?device_id=${encodeURIComponent(deviceId)}` : "/info"
    ),
  getTree: () => request<{ nodes: unknown[]; server_timestamp: number; server_version?: number }>("GET", "/bookmarks/tree"),
  syncBookmarks: (req: SyncBatchRequest) =>
    request<SyncBatchResponse>("POST", "/bookmarks/sync", req),
  pushDelta: async (deviceId: string, ops: DeltaOp[]) => {
    const CHUNK_SIZE = 5000;
    if (ops.length <= CHUNK_SIZE) {
      return request<{ applied: number; skipped_stale: number; server_timestamp: number }>(
        "POST", "/bookmarks/delta", { device_id: deviceId, ops }
      );
    }
    let applied = 0;
    let skipped_stale = 0;
    let server_timestamp = 0;
    for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
      const chunk = ops.slice(i, i + CHUNK_SIZE);
      const res = await request<{ applied: number; skipped_stale: number; server_timestamp: number }>(
        "POST", "/bookmarks/delta", { device_id: deviceId, ops: chunk }
      );
      if (!res) return null;
      applied += res.applied ?? 0;
      skipped_stale += res.skipped_stale ?? 0;
      server_timestamp = res.server_timestamp ?? server_timestamp;
    }
    return { applied, skipped_stale, server_timestamp };
  },
  pullDelta: (since: number, deviceId: string) =>
    request<{ ops: { op: string; node_id: string; payload: DeltaOp; timestamp: number }[]; server_timestamp: number }>(
      "GET", `/bookmarks/delta?since=${since}&device_id=${encodeURIComponent(deviceId)}`
    ),
  pushVisits: (increments: VisitIncrement[]) =>
    request<{ applied: number; unknown_nodes: number }>("POST", "/bookmarks/visits", { increments }),
  restoreBaseline: (body: {
    label: string;
    expected_server_version: number;
    expected_active_count: number;
    nodes: Array<{ id: string; parent_id?: string | null; position?: number; title: string; url?: string | null; is_folder?: boolean }>;
  }) =>
    request<{ restored: number; server_version: number; server_timestamp: number }>(
      "POST", "/bookmarks/restore-baseline", body
    ),
  putSession: (
    deviceId: string,
    deviceName: string,
    sessionJson: string,
    updatedAt: number,
    sessionBoundary = false,
  ) =>
    request<null>("PUT", `/tabs/${encodeURIComponent(deviceId)}`, {
      device_name: deviceName, session_json: sessionJson, updated_at: updatedAt,
      session_boundary: sessionBoundary,
    }),
  listSessions: (deviceId?: string) =>
    request<{ sessions: TabSessionSummary[] }>("GET", deviceId ? `/tabs?device_id=${encodeURIComponent(deviceId)}` : "/tabs"),
  adoptSession: (deviceId: string) =>
    request<{ device_id: string; device_name: string; session_json: string; updated_at: number }>(
      "POST", `/tabs/${encodeURIComponent(deviceId)}/adopt`
    ),
  listTabHistory: (deviceId?: string) =>
    request<{ history: { id: number; device_id: string; device_name: string; created_at: number; tab_count: number; tabs: { title: string; url: string | null }[] }[] }>(
      "GET", deviceId ? `/tabs/history?device_id=${encodeURIComponent(deviceId)}` : "/tabs/history"
    ),
  restoreHistorySession: (historyId: number) =>
    request<{ device_id: string; device_name: string; session_json: string; updated_at: number }>(
      "POST", `/tabs/history/${historyId}/restore`
    ),
  ping: async (): Promise<boolean> => {
    const cfg = await getConfig();
    const base = cfg.endpoint.replace(/\/+$/, "");
    const res = await fetch(`${base}/healthz`);
    return res.ok;
  },
};

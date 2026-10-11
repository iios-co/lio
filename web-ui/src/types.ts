// Types mirroring the lio-server API surface.

export interface UsageRow {
  node_id: string;
  parent_id: string | null;
  position: number;
  title: string;
  url: string | null;
  domain: string | null;
  visit_count: number;
  last_visited_at: number | null;
  date_added: number | null;
  is_folder: boolean;
  sort_key: string | null;
  ok: boolean | null;          // true alive, false dead, null never probed
  http_status: number | null;
  checked_at: number | null;   // when last probed or skipped
  status_error: string | null; // why dead, or why skipped (LAN/blocked)
}

export interface DeadLinkRow {
  node_id: string;
  title: string;
  url: string | null;
  http_status: number | null;
  error: string | null;
  checked_at: number | null;
}

export interface CheckResult {
  checked: number;
  ok: number;
  dead: number;
  skipped: number;
  disabled: boolean;            // server has liveness checking off
  skip_reason: string | null;   // why rows were skipped, in plain words
}

export type SortField =
  | "custom"
  | "name"
  | "domain"
  | "visits"
  | "date"
  | "last_visited";
export type SortDir = "asc" | "desc";
export type ViewMode = "grid" | "list";

export interface Filters {
  collection: string;
  view: ViewMode;
  sort: SortField;
  dir: SortDir;
  q: string;
  domain: string;
}

export interface CollectionSummary {
  id: string;
  name: string | null;
  token: string;
  created_at: string | null;
  token_rotated_at: number | null;
  bookmark_count: number;
  device_count: number;
  tab_count: number;
  last_activity: number | null;
}

export interface TabItem {
  title: string;
  url: string | null;
}

export interface TabSession {
  device_id: string;
  device_name: string;
  updated_at: number;
  tab_count: number;
  tabs: TabItem[];
}

export interface TabHistorySession {
  id: number;
  device_id: string;
  device_name: string;
  created_at: number;
  tab_count: number;
  tabs: TabItem[];
}

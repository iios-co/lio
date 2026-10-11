// Sync activity log — a capped ring buffer in browser.storage.local, powering
// the popup's Log view (v1 parity).

export interface LogEntry {
  id: string;
  kind: "syncing" | "synced" | "error" | "info";
  title: string;
  detail?: string;
  ts: number;
}

const LOG_KEY = "syncLog";
const MAX = 100;

export async function log(entry: Omit<LogEntry, "id" | "ts">): Promise<void> {
  const { [LOG_KEY]: existing } = await browser.storage.local.get(LOG_KEY);
  const arr: LogEntry[] = Array.isArray(existing) ? existing : [];
  arr.push({ ...entry, id: crypto.randomUUID(), ts: Date.now() });
  const capped = arr.length > MAX ? arr.slice(-MAX) : arr;
  await browser.storage.local.set({ [LOG_KEY]: capped });
}

export async function getLog(): Promise<LogEntry[]> {
  const { [LOG_KEY]: existing } = await browser.storage.local.get(LOG_KEY);
  const arr = Array.isArray(existing) ? (existing as LogEntry[]) : [];
  return arr.slice().reverse();
}

export async function clearLog(): Promise<void> {
  await browser.storage.local.set({ [LOG_KEY]: [] });
}

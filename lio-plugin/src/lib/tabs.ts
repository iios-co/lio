// Tab sync: capture local window/tab state and push it as this device's session
// snapshot, debounced so a burst of tab events collapses into one PUT.

import { api } from "./api";
import { getConfig } from "./config";
import { checkGate } from "./gate";

const DEBOUNCE_MS = 800;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

interface SnapWindow {
  window_id?: number;
  focused: boolean;
  tabs: { tab_index: number; title: string; url: string; favicon: string | null; pinned: boolean }[];
}

async function buildSnapshot(): Promise<SnapWindow[]> {
  const windows = await browser.windows.getAll({ populate: true });
  return windows
    .filter((w) => w.type === "normal")
    .map((w) => ({
      window_id: w.id,
      focused: !!w.focused,
      tabs: (w.tabs || []).map((t) => ({
        tab_index: t.index,
        title: t.title || "",
        url: t.url || "",
        favicon: t.favIconUrl || null,
        pinned: t.pinned || false,
      })),
    }));
}

// Set once per browser session, by the startup/install hooks. The FIRST push
// after that archives the snapshot the server still holds from the previous
// session, then the flag clears. A session is archived because it ended, never
// because a tab closed.
let pendingSessionBoundary = false;
let lastPushedJson: string | null = null;
let lastPushedDeviceName: string | null = null;

export function resetTabPushCache(): void {
  lastPushedJson = null;
  lastPushedDeviceName = null;
}

export function markSessionBoundary(): void {
  pendingSessionBoundary = true;
  lastPushedJson = null;
}

export async function pushNow(): Promise<void> {
  const cfg = await getConfig();
  if (!cfg.endpoint || !cfg.token) return;
  // Gate: no snapshot push while the server is unreachable or the token is not
  // recognised. The next snapshot after the gate opens carries current state, so
  // nothing needs queueing here.
  const gate = await checkGate();
  if (gate.state !== "ok") return;
  const snapshot = await buildSnapshot();
  const tabCount = snapshot.reduce((n, w) => n + w.tabs.length, 0);
  if (tabCount === 0) return; // don't clobber a good snapshot during shutdown
  const boundary = pendingSessionBoundary;
  const sessionJson = JSON.stringify(snapshot);
  const deviceName = cfg.deviceName || "Unnamed device";

  if (!lastPushedJson) {
    const stored = await browser.storage.local.get(["lastTabSnapshot", "lastTabDeviceName"]);
    lastPushedJson = (stored.lastTabSnapshot as string) || null;
    lastPushedDeviceName = (stored.lastTabDeviceName as string) || null;
  }

  // Purely event-driven: if tabs and device name are unchanged, skip pushing
  if (!boundary && sessionJson === lastPushedJson && deviceName === lastPushedDeviceName) {
    await browser.alarms?.clear?.("tabSyncDebounce");
    return;
  }

  try {
    await api.putSession(
      cfg.deviceId,
      deviceName,
      sessionJson,
      Date.now(),
      boundary,
    );
    // Only clear once the push actually landed, so a failed first push does not
    // silently lose the boundary and skip archiving the previous session.
    if (boundary) pendingSessionBoundary = false;
    lastPushedJson = sessionJson;
    lastPushedDeviceName = deviceName;
    await browser.alarms?.clear?.("tabSyncDebounce");
    // Record what was ACTUALLY pushed. The popup compares this against the live
    // tab count, so a local-only change can never be displayed as "synced".
    await browser.storage.local.set({
      lastTabPush: { at: Date.now(), count: tabCount },
      lastTabSnapshot: sessionJson,
      lastTabDeviceName: deviceName,
    });
  } catch (e) {
    console.warn("Lio: tab snapshot push failed:", (e as Error).message);
  }
}

export interface TabPushRecord {
  at: number;
  count: number;
}

export async function lastTabPush(): Promise<TabPushRecord | null> {
  const { lastTabPush: rec } = await browser.storage.local.get("lastTabPush");
  return (rec as TabPushRecord | undefined) ?? null;
}

export function scheduleTabSync(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void pushNow();
  }, DEBOUNCE_MS);
  browser.alarms?.create?.("tabSyncDebounce", { delayInMinutes: 0.03 });
}

export interface LocalTab {
  title: string;
  url: string;
  pinned: boolean;
  favicon: string | null;
}

// The tabs this device is currently syncing — i.e. exactly what the next
// snapshot push would contain. Drives the popup's rolling count, so the number
// the user sees is the number that gets synced, not a separate estimate.
/**
 * Compare this device's LIVE tabs against the session the server actually holds
 * for this device — url for url, in order.
 *
 * The tabs card used to claim "Synced" from push evidence alone (a recorded
 * `lastTabPush`), which proves only that *a* push once succeeded, not that what
 * is open now is what the server has. Same standard as the bookmarks card:
 * "Synced" requires an observed match. Returns null when the server's session
 * could not be read, which must NOT be treated as a match.
 */
export async function compareTabsWithServer(
  knownLive?: { count: number; windows: number; tabs: LocalTab[] }
): Promise<
  { identical: boolean; localCount: number; serverCount: number; detail: string } | null
> {
  const cfg = await getConfig();
  const live = knownLive || (await localTabs());
  const res = await api.listSessions(cfg.deviceId);
  if (!res) return null;
  const mine = (res.sessions ?? []).find((s) => s.device_id === cfg.deviceId);
  if (!mine) {
    return {
      identical: false,
      localCount: live.count,
      serverCount: 0,
      detail: "this device has no session on the server yet",
    };
  }

  const localUrls = [...live.tabs.map((t) => (t.url ?? "").replace(/\/+$/, "")).filter(Boolean)].sort();
  const serverUrls = [...(mine.tabs ?? []).map((t) => (t.url ?? "").replace(/\/+$/, "")).filter(Boolean)].sort();

  if (localUrls.length !== serverUrls.length) {
    const diff = Math.abs(localUrls.length - serverUrls.length);
    return {
      identical: false,
      localCount: localUrls.length,
      serverCount: serverUrls.length,
      detail: `${diff} tab${diff === 1 ? "" : "s"} ${localUrls.length > serverUrls.length ? "not sent yet" : "no longer open"}`,
    };
  }
  let mismatched = 0;
  for (let i = 0; i < localUrls.length; i++) {
    if (localUrls[i] !== serverUrls[i]) mismatched += 1;
  }
  return {
    identical: mismatched === 0,
    localCount: localUrls.length,
    serverCount: serverUrls.length,
    detail: mismatched === 0 ? "every tab matches" : `${mismatched} tab${mismatched === 1 ? "" : "s"} differ`,
  };
}

export async function localTabs(): Promise<{ count: number; windows: number; tabs: LocalTab[] }> {
  const snapshot = await buildSnapshot();
  const tabs = snapshot.flatMap((w) =>
    w.tabs.map((t) => ({
      title: t.title,
      url: t.url,
      pinned: t.pinned,
      favicon: t.favicon,
    }))
  );
  return { count: tabs.length, windows: snapshot.length, tabs };
}

function isBlankNewTab(url?: string): boolean {
  if (!url) return true;
  const u = url.trim().toLowerCase();
  return (
    u === "chrome://newtab/" ||
    u === "chrome://newtab" ||
    u === "about:blank" ||
    u === "about:newtab" ||
    u === "about:home" ||
    u === "chrome://welcome/" ||
    u === "edge://newtab/"
  );
}

export async function openSessionWindows(sessionJson: string): Promise<number> {
  let session: unknown;
  try {
    session = JSON.parse(sessionJson);
  } catch {
    throw new Error("Session payload was not valid JSON.");
  }
  let list: { tabs?: { url?: string }[] }[] = [];
  if (Array.isArray(session)) {
    list = session as { tabs?: { url?: string }[] }[];
  } else if (session && typeof session === "object" && "windows" in session && Array.isArray(session.windows)) {
    list = session.windows as { tabs?: { url?: string }[] }[];
  }

  const existingWindows = await browser.windows.getAll({ populate: true }).catch(() => []);
  const placeholderTabIds: number[] = [];
  for (const win of existingWindows) {
    if (win.tabs && win.tabs.length === 1) {
      const tab = win.tabs[0];
      if (tab?.id && isBlankNewTab(tab.url)) {
        placeholderTabIds.push(tab.id);
      }
    }
  }

  let opened = 0;
  for (const w of list) {
    const urls = (w.tabs || [])
      .map((t) => t.url)
      .filter((u): u is string => !!u && /^https?:/i.test(u));
    if (!urls.length) continue;
    await browser.windows.create({ url: urls });
    opened += 1;
  }

  if (opened > 0 && placeholderTabIds.length > 0) {
    for (const tabId of placeholderTabIds) {
      await browser.tabs.remove(tabId).catch(() => {});
    }
  }

  return opened;
}

export async function adoptSession(
  deviceId: string
): Promise<{ deviceName: string; windowCount: number }> {
  const adopted = await api.adoptSession(deviceId);
  if (!adopted) throw new Error("No session returned.");
  const count = await openSessionWindows(adopted.session_json);
  scheduleTabSync();
  return { deviceName: adopted.device_name, windowCount: count };
}

export async function restoreHistorySession(
  historyId: number
): Promise<{ deviceName: string; windowCount: number }> {
  const session = await api.restoreHistorySession(historyId);
  if (!session) throw new Error("No archived session returned.");
  const count = await openSessionWindows(session.session_json);
  scheduleTabSync();
  return { deviceName: session.device_name, windowCount: count };
}

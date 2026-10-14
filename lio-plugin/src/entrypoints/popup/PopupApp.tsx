import { useEffect, useRef, useState } from "react";
import { Logo, relTime } from "@/components/Logo";
import type { SyncConfig, SyncPair } from "@/lib/config";
import type { LogEntry } from "@/lib/log";
import { syncLabel, tabsPending } from "@/lib/stateLabel";
import { ConnectFlow } from "@/components/ConnectFlow";
import {
  clearSettingsDrafts,
  loadSettingsDrafts,
  parseConnectionString,
  saveSettingsDraftField,
} from "@/lib/drafts";
import { resolvePopupBannerMode } from "@/lib/popupBanner";
interface Status {
  ok: boolean; configured: boolean; reachable: boolean | null; lastError: string | null;
  // tokenValid: true = the server recognises this token and named the collection.
  // false = server reachable but token unknown/rejected (the dangerous case that
  // previously still showed a green "synced" pill). null = not checked.
  tokenValid: boolean | null;
  collectionName: string | null;
  /** What the BROWSER holds. Never the server's number. */
  localBookmarkCount?: number | null;
  /** What the SERVER holds, labelled as such. */
  serverBookmarkCount?: number | null;
  /** Real node-for-node comparison; null when the server could not be read. */
  treeDiff?: {
    identical: boolean; differences: number; detail: string;
    localCount: number; serverCount: number;
    localLinks: number; serverLinks: number;
  } | null;
  /** Live tabs vs the session the server holds for THIS device. Null = unknown. */
  tabDiff?: {
    identical: boolean; localCount: number; serverCount: number; detail: string;
  } | null;
  collectionCounts: { bookmarks: number; devices: number } | null;
  deviceName: string; deviceId: string; endpoint: string; queued: number; version: string;
  token?: string;
  syncIntervalSecs?: number;
  localTabCount?: number;
  localWindowCount?: number;
  // True only while the background is actually running a sync cycle.
  syncing?: boolean;
  /** True when a difference was detected and convergence was just started. */
  converging?: boolean;
  // Evidence for "Synced": when a cycle last COMPLETED, and what the last tab
  // snapshot push actually contained.
  lastSyncOkAt?: number | null;
  lastTabPush?: { at: number; count: number } | null;
  // Why the last cycle failed, if it did — surfaced so a stuck queue explains itself.
  lastSyncError?: { at: number; step: string; message: string } | null;
  pairStats?: Record<string, {
    localCount: number;
    serverCount: number;
    identical: boolean;
    differences: number;
    detail: string;
  }> | null;
  recoveryRequired?: {
    reason: string;
    applied: number;
    skipped: number;
    localNodeCount: number;
    localLinkCount: number;
    serverNodeCount: number;
    timestamp: number;
  } | null;
}
interface FolderInfo { id: string; title: string; depth: number }
interface Session { device_id: string; device_name: string; updated_at: number; tab_count: number }

function send<T = any>(msg: Record<string, unknown>): Promise<T> {
  return browser.runtime.sendMessage(msg) as Promise<T>;
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));

type View = "main" | "log" | "settings";

export function PopupApp() {
  const [status, setStatus] = useState<Status | null>(null);
  const [sync, setSync] = useState<SyncConfig | null>(null);
  const [view, setView] = useState<View>("main");
  const [notice, setNotice] = useState("");

  async function refresh() {
    const s = await send<Status>({ type: "STATUS" });
    setStatus(s);
    const sc = await send<{ ok: boolean; sync: SyncConfig }>({ type: "GET_SYNC_CONFIG" });
    if (sc?.ok) setSync(sc.sync);
    if (s?.configured && s.reachable === false) {
      setNotice(`Can't reach ${s.endpoint}`);
    } else if (s?.configured && s.tokenValid === false) {
      setNotice(s.lastError || "The server does not recognise this token.");
    } else if (s?.lastSyncError) {
      setNotice(`Sync failed at ${s.lastSyncError.step}: ${s.lastSyncError.message}`);
    } else setNotice("");
  }
  // The connection state was previously read ONCE on open, so a server coming
  // back (or dropping) was invisible until the popup was reopened. Poll while
  // open; the background alarm still does the real sync retry on its own cadence.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(id);
  }, []);

  async function toggleGlobal() {
    if (!sync) return;
    const r = await send<{ ok: boolean; sync: SyncConfig }>({ type: "TOGGLE_GLOBAL", enabled: !sync.globalEnabled });
    if (r?.ok) setSync(r.sync);
  }

  if (!status) {
    return <div className="w-96 p-8 text-center"><span className="pill pill-info">Loading…</span></div>;
  }
  // Not connected yet: the whole connect flow renders HERE, in the popup panel
  // hanging off the toolbar icon. There is no options page to send anyone to.
  if (!status.configured) return <ConnectFlow onDone={refresh} />;

  // GATE CLOSED -> the popup shows SETTINGS and the problem. No sync cards, no
  // counts, no "synced" pill: nothing may imply work is happening.
  const gateClosed = status.tokenValid === false || status.reachable === false;
  // Motion comes from REAL work, reported by the background worker.
  const busy = !!status.syncing;
  const shown: View = gateClosed ? "settings" : view;

  return (
    <div className="w-96 p-4">
      {/* Header: wordmark + version + live dot, then TWO toggling icons. */}
      <div className="flex items-center gap-2 mb-3">
        <button onClick={toggleGlobal} className="flex items-center gap-2"
          aria-label={sync?.globalEnabled ? "Pause syncing" : "Resume syncing"}
          aria-pressed={!sync?.globalEnabled}
          title={sync?.globalEnabled ? "Pause syncing" : "Resume syncing"}>
          <Logo size={20} withWordmark={false} active={busy} />
        </button>
        <span className="text-[10px] font-mono text-fg-subtle">v{status.version}</span>
        <span className="w-[7px] h-[7px] rounded-full" title={gateClosed ? "Sync stopped" : "Syncing"} style={{
          background: gateClosed ? "var(--red)" : sync?.globalEnabled ? "var(--green)" : "var(--orange)",
          boxShadow: `0 0 8px ${gateClosed ? "var(--red)" : sync?.globalEnabled ? "var(--green)" : "var(--orange)"}`,
        }} />
        <div className="ml-auto flex items-center gap-1.5">
          {/* Toggling, not tabs: pressing a lit icon returns to the main view. */}
          <IconBtn active={shown === "log"} title="Sync log"
            onClick={() => setView(view === "log" ? "main" : "log")}><PulseIcon /></IconBtn>
          <IconBtn active={shown === "settings"} title="Settings"
            onClick={() => setView(view === "settings" ? "main" : "settings")}><GearIcon /></IconBtn>
        </div>
      </div>

      {(() => {
        const bannerMode = resolvePopupBannerMode({
          globalEnabled: !!sync?.globalEnabled,
          gateClosed,
          recoveryRequired: status.recoveryRequired,
        });
        if (bannerMode === "hidden") return null;
        return (
          <div className="mb-3 space-y-2">
            {bannerMode === "recovery" ? (
              <div className="p-2.5 rounded-lg border border-red/40 bg-red/10 space-y-2 text-left">
                <p className="text-[11.5px] font-semibold text-red leading-tight">
                  Server Conflict Detected
                </p>
                <p className="text-[11px] text-fg-subtle leading-normal">
                  The server holds tombstones rejecting {status.recoveryRequired?.skipped} items (Browser: {status.recoveryRequired?.localLinkCount} links, Server: {status.recoveryRequired?.serverNodeCount} active).
                </p>
                <button
                  onClick={async () => {
                    const msg = `Restore this browser's ${status.recoveryRequired?.localLinkCount ?? ""} bookmarks as the authoritative collection baseline?\n\nThis will supersede any server-side tombstones. Sync will remain paused after restore until you manually resume.`;
                    if (!window.confirm(msg)) return;
                    const r = await send<{ ok: boolean; restored?: number; error?: string }>({
                      type: "RESTORE_BASELINE",
                      confirmed: true,
                      label: "Manual restore from browser popup",
                    });
                    if (r?.ok) {
                      setNotice(`Restored ${r.restored ?? "all"} bookmarks as authoritative baseline.`);
                      void refresh();
                    } else {
                      setNotice(`Baseline restore failed: ${r?.error ?? "Unknown error"}`);
                    }
                  }}
                  className="w-full py-1.5 rounded text-[11px] font-bold uppercase tracking-wider bg-blue text-white hover:opacity-90 transition-opacity text-center shadow-sm"
                >
                  Restore browser as baseline
                </button>
              </div>
            ) : bannerMode === "bootstrap" ? (
              <div className="p-2.5 rounded-lg border border-blue/40 bg-blue/10 space-y-2 text-left">
                <p className="text-[11.5px] font-semibold text-blue leading-tight">
                  Initial Setup Decision Needed
                </p>
                <p className="text-[11px] text-fg-subtle leading-normal">
                  Your browser ({status.recoveryRequired?.localNodeCount ?? 0} nodes) and server ({status.recoveryRequired?.serverNodeCount ?? 0} nodes) hold different bookmarks. Choose how to synchronize them:
                </p>
                <div className="space-y-1.5 pt-1">
                  <button
                    onClick={async () => {
                      const r = await send<{ ok: boolean; error?: string }>({
                        type: "RESOLVE_BOOTSTRAP",
                        mode: "merge",
                      });
                      if (r?.ok) {
                        setNotice("Merged browser with server.");
                        void refresh();
                      } else {
                        setNotice(`Merge failed: ${r?.error ?? "Unknown error"}`);
                      }
                    }}
                    className="w-full py-1.5 rounded text-[11px] font-bold uppercase tracking-wider bg-blue text-white hover:opacity-90 transition-opacity text-center shadow-sm"
                  >
                    Merge bookmarks
                  </button>
                  <button
                    onClick={async () => {
                      if (!window.confirm("Replace this browser's bookmarks with the server's tree?\n\nLocal bookmarks not on the server will be deleted.")) return;
                      const r = await send<{ ok: boolean; error?: string }>({
                        type: "RESOLVE_BOOTSTRAP",
                        mode: "server",
                        confirmed: true,
                      });
                      if (r?.ok) {
                        setNotice("Replaced browser bookmarks with server tree.");
                        void refresh();
                      } else {
                        setNotice(`Operation failed: ${r?.error ?? "Unknown error"}`);
                      }
                    }}
                    className="w-full py-1.5 rounded text-[11px] font-bold tracking-wider border border-blue text-blue hover:bg-blue/10 transition-colors text-center"
                  >
                    Use server's bookmarks
                  </button>
                  <button
                    onClick={async () => {
                      if (!window.confirm("Replace the server's bookmarks with this browser's tree?\n\nServer bookmarks not in this browser will be superseded.")) return;
                      const r = await send<{ ok: boolean; error?: string }>({
                        type: "RESOLVE_BOOTSTRAP",
                        mode: "browser",
                        confirmed: true,
                      });
                      if (r?.ok) {
                        setNotice("Restored browser bookmarks to server.");
                        void refresh();
                      } else {
                        setNotice(`Operation failed: ${r?.error ?? "Unknown error"}`);
                      }
                    }}
                    className="w-full py-1.5 rounded text-[11px] font-bold tracking-wider border border-border text-fg-subtle hover:text-fg hover:border-fg-subtle transition-colors text-center"
                  >
                    Use this browser's bookmarks
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={toggleGlobal} className="w-full py-2 rounded-lg text-[11px] font-bold uppercase tracking-widest transition-opacity hover:opacity-90"
                style={{ background: "color-mix(in srgb, var(--red) 12%, transparent)", border: "1px solid var(--red)", color: "var(--red)" }}>
                Sync paused — tap to resume
              </button>
            )}
          </div>
        );
      })()}
      {notice && <p className="text-[11.5px] leading-snug text-red mb-2.5">{notice}</p>}
      {status.reachable && <p className="hidden" />}

      {shown === "main" && <MainView sync={sync} syncing={busy} status={status} onChange={setSync} goSettings={() => setView("settings")} />}
      {shown === "log" && <LogView />}
      {shown === "settings" && <SettingsView sync={sync} status={status} onChange={setSync} onDisconnect={refresh} onRefresh={refresh} />}
    </div>
  );
}

// ---- Main: pairs list ------------------------------------------------------
function MainView({ sync, syncing, status, onChange, goSettings }: {
  sync: SyncConfig | null; syncing: boolean; status: Status;
  onChange: (s: SyncConfig) => void; goSettings: () => void;
}) {
  const pairs = sync?.pairs ?? [];
  async function toggle(p: SyncPair) {
    const r = await send<{ ok: boolean; sync: SyncConfig }>({ type: "TOGGLE_PAIR", pairId: p.id, enabled: !p.enabled });
    if (r?.ok) onChange(r.sync);
  }
  return (
    <div className="space-y-2.5" style={{ opacity: sync?.globalEnabled ? 1 : 0.55, pointerEvents: sync?.globalEnabled ? "auto" : "none" }}>
      {/* No "Sync now": sync is automatic and the toggle is the control. */}
      {pairs.length === 0 ? (
        <div className="card p-5 text-center">
          <p className="text-xs text-fg-subtle mb-3">No sync pairs yet. Choose what syncs in settings.</p>
          <button onClick={goSettings} className="lio-btn lio-btn-sm">Add a sync pair</button>
        </div>
      ) : pairs.map((p) => {
        const color = p.type === "bookmark" ? "var(--cyan)" : "var(--magenta)";
        const stats = p.type === "bookmark" && status.pairStats ? status.pairStats[p.id] : null;
        const matched = p.type === "bookmark"
          ? (stats ? stats.identical : (status.treeDiff ? status.treeDiff.identical : null))
          : (status.tabDiff ? status.tabDiff.identical : null);
        const busy = syncing && p.enabled && !matched;
        const name = p.type === "bookmark"
          ? (p.localFolderName || (p.localFolderId ? "Folder" : (status.collectionName || "Bookmarks Bar")))
          : "Open tabs";
        // The bookmark ring shows the BROWSER's own link count for this pair.
        const count = p.type === "bookmark"
          ? (stats ? stats.localCount : (p.localFolderId ? 0 : (status.localBookmarkCount ?? 0)))
          : (status.localTabCount ?? 0);
        return (
          <div key={p.id} className="card p-3.5" style={{ opacity: p.enabled ? 1 : 0.5 }}>
            <div className="flex items-center gap-3">
              {/* The COUNT lives in the ring. */}
              <span className={`lio-ring${busy ? " is-busy" : ""}`} style={{ color }}>
                {busy && <span className="lio-arc" />}
                <b>{count}</b>
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold truncate text-fg">
                    {name}
                  </span>
                  <StatePill enabled={p.enabled} status={status} busy={busy}
                    lastOkAt={status.lastSyncOkAt ?? null} queued={status.queued}
                    matched={matched}
                    differences={p.type === "bookmark" ? (stats ? stats.differences : status.treeDiff?.differences) : undefined} />
                  <label className="ml-auto inline-flex cursor-pointer shrink-0">
                    <input type="checkbox" className="sr-only peer" checked={p.enabled} onChange={() => toggle(p)}
                      aria-label={`Sync ${p.localFolderName || "Everything"}`} />
                    <span className="w-[34px] h-[18px] rounded-full transition-colors relative" style={{ background: p.enabled ? color : "var(--border)" }}>
                      <span className="absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform" style={{ transform: p.enabled ? "translateX(16px)" : "none" }} />
                    </span>
                  </label>
                </div>
                {/* No `truncate`: this line carries the diagnostic, and cutting
                    it off hid exactly the part worth reading. */}
                <div className="text-[11px] text-fg-subtle mt-1.5 leading-snug">
                  {p.type === "bookmark"
                    ? (stats
                        ? `${stats.localCount} links here · ${stats.serverCount} on server`
                        : (status.treeDiff
                            ? `${status.treeDiff.localLinks} links here · ${status.treeDiff.serverLinks} on server`
                            : `${count} links`))
                    : (status.tabDiff
                        ? `${status.tabDiff.localCount} tabs here · ${status.tabDiff.serverCount} on server — ${status.tabDiff.detail}`
                        : `${status.localTabCount ?? 0} tabs`)}
                </div>
              </div>
            </div>
          </div>
        );
      })}
      <LiveTabsCard status={status} syncing={syncing} />
    </div>
  );
}

// This device's open tabs — a ROLLING count of exactly the set that gets synced
// (it reads the same snapshot builder the push uses), refreshed while the popup
// is open, with the tab list on demand.
function formatSessionTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return `Today at ${timeStr}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${timeStr}`;
  const dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${dateStr} at ${timeStr}`;
}

function LiveTabsCard({ status, syncing }: { status: Status; syncing: boolean }) {
  type LocalTabRow = { title: string; url: string; pinned: boolean; favicon: string | null };
  const [data, setData] = useState<{ count: number; windows: number; tabs: LocalTabRow[] } | null>(null);
  const [history, setHistory] = useState<{ id: number; device_name: string; created_at: number; tab_count: number }[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const r = await send<{ ok: boolean; count: number; windows: number; tabs: LocalTabRow[] }>({ type: "LOCAL_TABS" });
      if (alive && r?.ok) setData({ count: r.count, windows: r.windows, tabs: r.tabs });
    };
    void read();
    const id = setInterval(read, 2000); // rolling while the popup is open
    return () => { alive = false; clearInterval(id); };
  }, []);

  const count = data?.count ?? 0;
  const busy = syncing && (!status.tabDiff || !status.tabDiff.identical);
  // The live count is LOCAL. It only counts as sent when a snapshot push
  // recorded this same count. Otherwise the card says so.
  const pushed = status.lastTabPush;
  const pending = tabsPending(count, pushed);
  return (
    <div className="card p-3.5">
      <div className="flex items-center gap-3">
        <span className={`lio-ring${busy ? " is-busy" : ""}`} style={{ color: "var(--magenta)" }}>
          {busy && <span className="lio-arc" />}
          <b>{count}</b>
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate text-fg">Open tabs</span>
            {/* Same standard as the bookmarks card: "Synced" requires an
                OBSERVED match against the session the server actually holds for
                this device, not merely a push that once succeeded. */}
            <StatePill enabled status={status} busy={busy} pending={pending}
                       lastOkAt={pushed?.at ?? null} queued={0}
                       matched={status.tabDiff ? status.tabDiff.identical : null} />
            <button onClick={async () => {
              const next = !open;
              setOpen(next);
              if (next) {
                const r = await send<{ ok: boolean; history: { id: number; device_name: string; created_at: number; tab_count: number }[] }>({ type: "LIST_TAB_HISTORY" });
                if (r?.ok) setHistory(r.history || []);
              }
            }} className="lio-btn lio-btn-sm ml-auto shrink-0">
              {open ? "Hide" : "Show"}
            </button>
          </div>
          {/* No `truncate`: this line carries the evidence. */}
          <div className="text-[11px] text-fg-subtle mt-1.5 leading-snug">
            {!data
              ? "counting…"
              : status.tabDiff
                ? `${status.tabDiff.localCount} tabs here · ${status.tabDiff.serverCount} on server — ${status.tabDiff.detail}`
                : `${count} tabs here · server not compared`}
          </div>
        </div>
      </div>

      {open && (
        <div className="mt-2.5 border-t border-border pt-2 space-y-2">
          {data && data.tabs.length > 0 && (
            <div className="max-h-36 overflow-auto">
              {data.tabs.map((t, i) => (
                <div key={`${t.url}-${i}`}
                  className="flex items-center gap-2 py-1 rounded-md px-1 hover:bg-[color-mix(in_srgb,var(--magenta)_13%,transparent)]">
                  <TabFavicon url={t.url} title={t.title} favicon={t.favicon} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg" title={t.url}>
                    {t.title || t.url}
                  </span>
                  {t.pinned && <span className="pill pill-info !py-0 !text-[9px]">pin</span>}
                </div>
              ))}
            </div>
          )}

          {history.length > 0 && (
            <div className="border-t border-border/50 pt-1.5">
              <span className="text-[10px] font-semibold text-fg-subtle block mb-1">Previous sessions</span>
              <div className="space-y-1">
                {history.slice(0, 3).map((h) => (
                  <div key={h.id} className="flex items-center justify-between text-[11px] py-1.5 px-2 rounded bg-[color-mix(in_srgb,var(--fg)_4%,transparent)]">
                    <div className="truncate flex-1">
                      <div className="text-fg font-medium truncate">
                        {h.device_name} · {h.tab_count} tab{h.tab_count === 1 ? "" : "s"}
                      </div>
                      <div className="text-[10px] text-fg-subtle">
                        {formatSessionTime(h.created_at)}
                      </div>
                    </div>
                    <button
                      disabled={restoring}
                      onClick={async () => {
                        setRestoring(true);
                        await send({ type: "RESTORE_HISTORY", historyId: h.id });
                        setRestoring(false);
                      }}
                      className="btn-ghost text-[10px] px-2 py-0.5 ml-2 shrink-0 accent-magenta font-semibold"
                    >
                      {restoring ? "Opening…" : "Restore"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Favicon with a deterministic letter fallback. It must NEVER build a URL from a
// privileged scheme: Chrome refuses to load chrome://…/favicon.ico from a page
// and logs "Not allowed to load local resource" against popup.html. So an <img>
// is only rendered for an http(s) source — internal pages get a chip.
function TabFavicon({ url, title, favicon }: { url: string; title: string; favicon?: string | null }) {
  const [failed, setFailed] = useState(false);

  let host = "";
  let isWeb = false;
  try {
    const u = new URL(url);
    isWeb = u.protocol === "http:" || u.protocol === "https:";
    host = u.hostname.replace(/^www\./, "");
  } catch { /* not a parseable URL */ }

  const provided = favicon && /^https?:/i.test(favicon) ? favicon : null;
  const src = provided ?? (isWeb ? `${new URL(url).origin}/favicon.ico` : null);

  if (!src || failed) {
    const basis = host || title || url || "?";
    const letter = (basis.replace(/[^a-z0-9]/gi, "").charAt(0) || "•").toUpperCase();
    let h = 0;
    for (const ch of basis) h = (h * 31 + ch.charCodeAt(0)) & 0x7fffffff;
    const palette = ["var(--blue)", "var(--cyan)", "var(--magenta)", "var(--green)", "var(--orange)", "var(--purple)"];
    const color = palette[h % palette.length]!;
    return (
      <span aria-hidden className="grid place-items-center w-3.5 h-3.5 rounded-[3px] text-[8px] font-bold shrink-0"
        style={{ color, background: `color-mix(in srgb, ${color} 20%, transparent)` }}>
        {letter}
      </span>
    );
  }
  return <img src={src} alt="" onError={() => setFailed(true)}
    className="w-3.5 h-3.5 rounded-[3px] object-contain shrink-0" />;
}

// The pill states the TRUTH about this pair, in priority order. It used to read
// solely from the toggle, so it said "synced" even when the server had never
// accepted anything — the exact failure this ordering prevents.
// The pill renders whatever the shared, unit-tested rules in lib/stateLabel.ts
// decide. The component holds no judgement of its own — that is deliberate, so
// the claim shown and the claim tested are the same code.
function StatePill({ enabled, status, busy, pending, lastOkAt, queued, matched, differences }: {
  enabled: boolean; status: Status; busy?: boolean; pending?: boolean;
  // Evidence and queue belong to the CARD, not the extension as a whole.
  lastOkAt: number | null; queued: number;
  // Result of a real local-vs-server comparison for THIS card. Undefined when
  // the card has nothing to compare; null when the comparison could not be made.
  matched?: boolean | null; differences?: number;
}) {
  const label = syncLabel({
    enabled,
    reachable: status.reachable ?? null,
    tokenValid: status.tokenValid ?? null,
    busy: !!busy,
    queued,
    lastOkAt,
    pending: !!pending,
    matched,
    differences,
  });

  const tone =
    label === "no valid token" ? "pill-dead"
    : label.endsWith("differ") ? "pill-warn"
    : label === "offline" || label === "paused" || label === "not sent" ? "pill-warn"
    : label === "Synced" ? "pill-ok"
    : "pill-info";
  const withDot =
    label !== "paused" && label !== "not synced yet" && label !== "not compared";

  return (
    <span className={`pill ${tone}`}>
      {withDot && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      {label}
    </span>
  );
}

// ---- Log view --------------------------------------------------------------
function LogView() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  useEffect(() => { void (async () => { const r = await send<{ ok: boolean; log: LogEntry[] }>({ type: "GET_LOG" }); if (r?.ok) setEntries(r.log); })(); }, []);
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-fg inline-flex items-center gap-1.5"><PulseIcon />Sync log</span>
        <button onClick={async () => { await send({ type: "CLEAR_LOG" }); setEntries([]); }} className="btn-ghost text-[10px] px-2 py-1">Clear</button>
      </div>
      <div className="rounded-lg border border-border overflow-y-auto divide-y divide-border" style={{ maxHeight: 320, background: "var(--bg)" }}>
        {entries.length === 0 ? (
          <p className="text-center text-xs text-fg-subtle py-8">No activity yet.</p>
        ) : entries.map((e) => (
          <div key={e.id} className="flex items-start gap-2.5 px-3 py-2">
            <span className="mt-0.5" style={{ color: e.kind === "error" ? "var(--red)" : e.kind === "synced" ? "var(--green)" : "var(--cyan)" }}>
              {e.kind === "syncing" ? <RefreshIcon spin /> : e.kind === "error" ? "✗" : e.kind === "synced" ? "✓" : "•"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold text-fg truncate">{e.title}</div>
              {e.detail && <div className="text-[10px] text-fg-subtle truncate">{e.detail}</div>}
            </div>
            <span className="text-[9px] text-fg-subtle whitespace-nowrap">{relTime(e.ts)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Connection is EDITABLE right here. The previous version masked the token behind
// a Show button that only revealed the string "(hidden in popup)" and pushed you
// to a separate options tab — which is worst exactly when the token is wrong and
// needs fixing. Masking a credential on your own machine buys nothing; the field
// starts masked only against shoulder-surfing and reveals for real.
function ConnectionCard({ status, onSaved }: { status: Status; onSaved: () => void }) {
  const [endpoint, setEndpoint] = useState(status.endpoint);
  const [token, setToken] = useState(status.token ?? "");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const endpointEdited = useRef(false);
  const tokenEdited = useRef(false);

  useEffect(() => {
    void (async () => {
      const drafts = await loadSettingsDrafts();
      if (!endpointEdited.current && typeof drafts.endpoint === "string") {
        setEndpoint(drafts.endpoint);
      }
      if (!tokenEdited.current && typeof drafts.token === "string") {
        setToken(drafts.token);
      }
    })();
  }, []);

  const updateEndpoint = (val: string) => {
    endpointEdited.current = true;
    setEndpoint(val);
    void saveSettingsDraftField("endpoint", val);
  };
  const updateToken = (val: string) => {
    tokenEdited.current = true;
    setToken(val);
    void saveSettingsDraftField("token", val);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    const parsed = parseConnectionString(text);
    if (parsed) {
      e.preventDefault();
      updateEndpoint(parsed.endpoint);
      updateToken(parsed.token);
    }
  };

  const dirty = endpoint !== status.endpoint || token !== (status.token ?? "");
  const broken = status.tokenValid === false || status.reachable === false;

  async function save() {
    setBusy(true); setError(""); setSaved("");
    const r = await send<{ ok: boolean; error?: string; collectionName?: string }>({
      type: "SET_CONNECTION", endpoint, token,
    });
    setBusy(false);
    if (r?.ok) {
      await clearSettingsDrafts();
      setSaved(r.collectionName ? `Connected to ${r.collectionName}` : "Connected");
      onSaved();
    } else {
      setError(r?.error || "Could not save.");
    }
  }

  return (
    <div className="card p-3 space-y-2">
      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Server</span>
        <input value={endpoint} onChange={(e) => updateEndpoint(e.target.value)} onPaste={handlePaste}
          placeholder="http://127.0.0.1:8787"
          className="w-full mt-0.5 bg-bg border border-border rounded-lg px-2 py-1 text-[11px] font-mono text-fg focus:border-blue outline-none" />
      </label>

      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Collection token</span>
        <span className="flex items-center gap-1.5 mt-0.5">
          <input
            value={token}
            onChange={(e) => updateToken(e.target.value)}
            onPaste={handlePaste}
            type={reveal ? "text" : "password"}
            spellCheck={false}
            autoComplete="off"
            placeholder="paste the token from the dashboard"
            className={`flex-1 min-w-0 bg-bg border rounded-lg px-2 py-1 text-[11px] font-mono text-cyan focus:border-blue outline-none ${
              broken ? "border-red" : "border-border"
            }`}
          />
          <button onClick={() => setReveal((v) => !v)} className="btn-ghost text-[10px] px-2 py-1"
            title={reveal ? "Hide token" : "Reveal token"}>
            {reveal ? "Hide" : "Show"}
          </button>
        </span>
      </label>

      {error && <p className="text-[10px] text-red">{error}</p>}
      {saved && !error && <p className="text-[10px] text-green">{saved}</p>}
      {!error && !saved && status.tokenValid === false && (
        <p className="text-[10px] text-orange">
          Paste the current token from the dashboard, then Save.
        </p>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <button onClick={save} disabled={busy || !dirty || !endpoint.trim() || !token.trim()}
          className="btn-primary text-[11px] px-2.5 py-1 disabled:opacity-50">
          {busy ? "Checking…" : "Save & verify"}
        </button>
        <button onClick={onSaved} disabled={busy} className="btn-ghost text-[11px] px-2.5 py-1">
          Retry now
        </button>
        <button onClick={async () => {
          if (confirm("Disconnect this browser from the collection?")) {
            await browser.storage.local.set({ endpoint: "", token: "" });
            onSaved();
          }
        }} className="text-[11px] text-red ml-auto">Disconnect</button>
      </div>

      <p className="text-[10px] text-fg-subtle">
        Rechecks automatically every {Math.round((status.syncIntervalSecs ?? 60) / 60) || 1} min
        {status.queued > 0 ? ` · ${status.queued} change${status.queued === 1 ? "" : "s"} queued` : ""}.
      </p>
    </div>
  );
}

// ---- Settings view ---------------------------------------------------------
function SettingsView({ sync, status, onChange, onDisconnect, onRefresh }: {
  sync: SyncConfig | null; status: Status; onChange: (s: SyncConfig) => void; onDisconnect: () => void; onRefresh?: () => void;
}) {
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [folder, setFolder] = useState<FolderInfo | null>(null);
  const [collPath, setCollPath] = useState("");

  useEffect(() => { void (async () => { const r = await send<{ ok: boolean; folders: FolderInfo[] }>({ type: "LIST_FOLDERS" }); if (r?.ok) setFolders(r.folders); })(); }, []);

  async function addPair() {
    const pair: SyncPair = {
      id: uuid(), type: "bookmark",
      localFolderId: folder?.id ?? "", localFolderName: folder?.title ?? "Everything",
      collectionPath: "", enabled: true,
    };
    const r = await send<{ ok: boolean; sync: SyncConfig }>({ type: "ADD_PAIR", pair });
    if (r?.ok) { onChange(r.sync); setFolder(null); setCollPath(""); }
  }
  async function removePair(id: string) {
    const r = await send<{ ok: boolean; sync: SyncConfig }>({ type: "REMOVE_PAIR", pairId: id });
    if (r?.ok) onChange(r.sync);
  }

  async function forceRebuild() {
    if (!confirm("This will overwrite your browser bookmarks to exactly match the server's tree (including deletions of local un-pushed links). Proceed?")) return;
    await send({ type: "FORCE_RECONCILE" });
    if (onRefresh) void onRefresh();
  }

  const pairs = sync?.pairs ?? [];
  return (
    <div className="space-y-4">
      {/* Connection */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-bold text-fg">Connection</span>
          <span className="pill" style={{
            color: status.tokenValid === false ? "var(--red)"
              : status.reachable ? "var(--green)" : "var(--orange)",
          }}>
            ● {status.tokenValid === false ? "unknown token"
              : status.reachable ? "connected" : "offline"}
          </span>
        </div>
        <ConnectionCard status={status} onSaved={onDisconnect} />
      </div>

      {/* Bookmark sync pairs */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold text-fg">Bookmark sync</span>
          <button onClick={forceRebuild} disabled={!status.reachable} className="btn-ghost py-0.5 px-2 text-[10px] accent-orange" title="Forcibly erase browser tree and pull server bookmarks">
            ⟳ Pull server bookmarks
          </button>
        </div>
        {pairs.filter((p) => p.type === "bookmark").map((p) => (
          <div key={p.id} className="flex items-center justify-between p-2.5 mt-2 rounded-lg border border-border">
            <span className="text-[11px] truncate">
              <span style={{ color: "var(--cyan)" }}>{p.localFolderName || "Everything"}</span>
            </span>
            <button onClick={() => removePair(p.id)} className="text-fg-subtle hover:text-red transition-colors p-1" title="Remove pair">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        ))}
        {/* Add pair form */}
        <div className="card p-4 mt-2">
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-2">Sync scope</div>
          <label className="block text-[9px] uppercase tracking-wider mb-1" style={{ color: "var(--cyan)" }}>Browser folder</label>
          <select className="field mb-2 w-full" value={folder?.id ?? ""} onChange={(e) => {
            const f = folders.find((x) => x.id === e.target.value) ?? null; setFolder(f);
          }}>
            <option value="">Everything (Root)</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{"\u00A0".repeat(f.depth * 2)}{f.title}</option>)}
          </select>
          <button onClick={addPair} className="lio-btn w-full mt-3">Add to sync</button>
        </div>
      </div>
    </div>
  );
}

// ---- Small UI bits ---------------------------------------------------------
function IconBtn({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className="p-1.5 rounded-lg transition-colors"
      style={{ color: active ? "var(--cyan)" : "var(--fg-subtle)", background: active ? "color-mix(in srgb, var(--cyan) 12%, transparent)" : "transparent" }}>
      {children}
    </button>
  );
}
const ic = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
function PulseIcon() { return <svg {...ic}><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>; }
function GearIcon() { return <svg {...ic}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>; }
function LockIcon() { return <svg {...ic} width={13} height={13}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>; }
function RefreshIcon({ spin }: { spin?: boolean }) { return <svg {...ic} width={13} height={13} className={spin ? "spin" : ""}><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></svg>; }

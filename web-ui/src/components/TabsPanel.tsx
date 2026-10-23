import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { coll } from "../api";
import type { TabHistorySession, TabItem, TabSession } from "../types";
import { formatDateTime, hostOf, relTime } from "../util";
import { Favicon } from "./Favicon";

// Device tabs, rendered with the SAME structure as the bookmarks tree: one glass
// panel, a collapsible parent row per device (the "folder" idiom), and child
// rows whose geometry matches a bookmark row exactly — favicon, title, inline
// host, hover actions. Accents are magenta here, blue there; nothing else differs.
export function TabsPanel({ token, query = "" }: { token: string; query?: string }) {
  const [view, setView] = useState<"active" | "history">("active");
  const { data, isLoading } = useQuery({
    queryKey: ["sessions", token],
    queryFn: () => coll.sessions(token),
  });
  const historyQuery = useQuery({
    queryKey: ["sessions-history", token],
    queryFn: () => coll.historySessions(token),
  });

  const sessions = data?.sessions ?? [];
  const history = historyQuery.data?.history ?? [];
  const ql = query.trim().toLowerCase();

  const filteredSessions = ql
    ? sessions
        .map((s) => ({
          ...s,
          tabs: (s.tabs ?? []).filter(
            (t) =>
              (t.title || "").toLowerCase().includes(ql) ||
              (t.url || "").toLowerCase().includes(ql)
          ),
        }))
        .filter((s) => s.tabs.length > 0 || (s.device_name || "").toLowerCase().includes(ql))
    : sessions;
  const orderedSessions = [...filteredSessions].sort((a, b) => {
    const diff = (b.updated_at ?? 0) - (a.updated_at ?? 0);
    if (diff !== 0) return diff;
    return a.device_id.localeCompare(b.device_id);
  });

  const filteredHistory = ql
    ? history
        .map((h) => ({
          ...h,
          tabs: (h.tabs ?? []).filter(
            (t) =>
              (t.title || "").toLowerCase().includes(ql) ||
              (t.url || "").toLowerCase().includes(ql)
          ),
        }))
        .filter((h) => h.tabs.length > 0 || (h.device_name || "").toLowerCase().includes(ql))
    : history;
  const orderedHistory = [...filteredHistory].sort((a, b) => {
    const diff = (b.created_at ?? 0) - (a.created_at ?? 0);
    if (diff !== 0) return diff;
    return a.id - b.id;
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 p-1 glass rounded-xl w-fit">
        <button
          onClick={() => setView("active")}
          className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors ${
            view === "active" ? "bg-[var(--fg)] text-[var(--bg)] shadow-sm" : "text-fg-subtle hover:text-fg"
          }`}
        >
          Active devices ({sessions.length})
        </button>
        <button
          onClick={() => setView("history")}
          className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors ${
            view === "history" ? "bg-[var(--fg)] text-[var(--bg)] shadow-sm" : "text-fg-subtle hover:text-fg"
          }`}
        >
          Archived history ({history.length})
        </button>
      </div>

      {view === "active" ? (
        isLoading ? (
          <p className="text-fg-subtle text-sm px-1 py-6 text-center">Loading sessions…</p>
        ) : orderedSessions.length === 0 ? (
          <p className="text-fg-subtle text-sm px-1 py-6 text-center">
            {ql
              ? "No tabs match your search."
              : "No device tabs yet. Enable tab sync in the extension to push a browser’s open tabs here."}
          </p>
        ) : (
          <>
            <div className="glass rounded-2xl p-2">
              {orderedSessions.map((s) => (
                <DeviceRows key={s.device_id} token={token} session={s} />
              ))}
            </div>
            <p className="mt-2 px-1 text-[11px] text-fg-subtle">
              Click a device to fold its tabs away. Adopt opens every tab here and clears the session.
            </p>
          </>
        )
      ) : historyQuery.isLoading ? (
        <p className="text-fg-subtle text-sm px-1 py-6 text-center">Loading archived history…</p>
      ) : orderedHistory.length === 0 ? (
        <p className="text-fg-subtle text-sm px-1 py-6 text-center">
          {ql ? "No archived tabs match your search." : "No archived sessions yet. When a browser closes or drops tabs, previous sessions are saved here."}
        </p>
      ) : (
        <>
          <div className="glass rounded-2xl p-2">
            {orderedHistory.map((h) => (
              <HistoryRows key={h.id} token={token} session={h} />
            ))}
          </div>
          <p className="mt-2 px-1 text-[11px] text-fg-subtle">
            Past closed sessions preserved automatically so you never lose tabs when restarting or closing browsers.
          </p>
        </>
      )}
    </div>
  );
}

function DeviceRows({ token, session }: { token: string; session: TabSession }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
  const [confirming, setConfirming] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sessions", token] });
  const adopt = useMutation({
    mutationFn: () => coll.adoptSession(token, session.device_id),
    onSuccess: invalidate,
  });
  const discard = useMutation({
    mutationFn: () => coll.discardSession(token, session.device_id),
    onSuccess: () => { setConfirming(false); invalidate(); },
  });

  const tabs = session.tabs ?? [];
  const openAll = () => tabs.forEach((t) => t.url && window.open(t.url, "_blank", "noopener,noreferrer"));

  return (
    <>
      {/* Device row — same shape as a folder row in the bookmarks tree */}
      <div className="group relative flex items-center gap-2 pr-1.5 py-1.5 rounded-lg transition-colors hover:bg-[color-mix(in_srgb,var(--magenta)_13%,transparent)]">
        <button onClick={() => setOpen((v) => !v)}
          className="w-4 h-4 grid place-items-center text-fg-subtle hover:text-fg shrink-0"
          aria-label={open ? "Collapse device" : "Expand device"}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
            style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
            <path d="M9 6l6 6-6 6" /></svg>
        </button>

        <span className="grid place-items-center w-5 h-5 text-magenta shrink-0" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18" /></svg>
        </span>

        <button onClick={() => setOpen((v) => !v)}
          className="text-sm font-medium text-fg truncate text-left min-w-0 flex-1">
          {session.device_name || "Unknown device"}
          <span className="ml-2 text-[11px] font-normal text-fg-subtle">{relTime(session.updated_at)}</span>
        </button>

        {confirming ? (
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="text-[11px] text-red mr-1">Discard {session.tab_count} captured tabs?</span>
            <button onClick={() => setConfirming(false)} className="btn-ghost btn-sm">Cancel</button>
            <button onClick={() => discard.mutate()} disabled={discard.isPending} className="btn-danger btn-sm">
              {discard.isPending ? "Working…" : "Discard"}
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] px-1.5 py-0.5 rounded-full text-magenta bg-[color-mix(in_srgb,var(--magenta)_16%,transparent)]">
              {session.tab_count}
            </span>
            {tabs.some((t) => t.url) && (
              <button onClick={openAll} className="btn-ghost btn-sm accent-magenta opacity-0 group-hover:opacity-100 transition-opacity">
                Open all
              </button>
            )}
            <button onClick={() => adopt.mutate()} disabled={adopt.isPending}
              className="btn-ghost btn-sm accent-magenta opacity-0 group-hover:opacity-100 transition-opacity"
              title="Open every tab here and clear the session">
              {adopt.isPending ? "Adopting…" : "Adopt"}
            </button>
            <button onClick={() => setConfirming(true)} aria-label="Discard session"
              className="btn-danger btn-sm btn-icon opacity-0 group-hover:opacity-100 transition-opacity">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" /></svg>
            </button>
          </span>
        )}
      </div>

      {/* Tab rows — geometry identical to a bookmark leaf row */}
      {open && (tabs.length === 0
        ? <p className="text-fg-subtle text-xs pl-[26px] py-1.5">Session has no tabs.</p>
        : tabs.map((t, i) => <TabRow key={`${t.url ?? "x"}-${i}`} tab={t} />))}
    </>
  );
}

function HistoryRows({ token, session }: { token: string; session: TabHistorySession }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
  const [confirming, setConfirming] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["sessions-history", token] });
  const discard = useMutation({
    mutationFn: () => coll.deleteHistorySession(token, session.id),
    onSuccess: () => { setConfirming(false); invalidate(); },
  });

  const tabs = session.tabs ?? [];
  const openAll = () => tabs.forEach((t) => t.url && window.open(t.url, "_blank", "noopener,noreferrer"));

  return (
    <>
      <div className="group relative flex items-center gap-2 pr-1.5 py-1.5 rounded-lg transition-colors hover:bg-[color-mix(in_srgb,var(--magenta)_13%,transparent)]">
        <button onClick={() => setOpen((v) => !v)}
          className="w-4 h-4 grid place-items-center text-fg-subtle hover:text-fg shrink-0"
          aria-label={open ? "Collapse session" : "Expand session"}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
            style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
            <path d="M9 6l6 6-6 6" /></svg>
        </button>

        <span className="grid place-items-center w-5 h-5 text-fg-subtle shrink-0" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
        </span>

        <span className="font-semibold text-sm text-fg truncate flex-1 flex items-baseline gap-2">
          {session.device_name}
          <span className="text-[11px] font-normal text-fg-subtle">
            {tabs.length} tab{tabs.length === 1 ? "" : "s"} · saved {formatDateTime(session.created_at)} ({relTime(session.created_at)})
          </span>
        </span>

        {confirming ? (
          <span className="flex items-center gap-1 shrink-0">
            <button onClick={() => discard.mutate()} disabled={discard.isPending}
              className="btn-danger btn-sm">
              {discard.isPending ? "Deleting…" : "Confirm delete"}
            </button>
            <button onClick={() => setConfirming(false)} className="btn-ghost btn-sm">Cancel</button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 shrink-0">
            {tabs.some((t) => t.url) && (
              <button onClick={openAll} className="btn-ghost btn-sm accent-magenta opacity-0 group-hover:opacity-100 transition-opacity">
                Open all
              </button>
            )}
            <button onClick={() => setConfirming(true)} aria-label="Delete archived session"
              className="btn-danger btn-sm btn-icon opacity-0 group-hover:opacity-100 transition-opacity">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" /></svg>
            </button>
          </span>
        )}
      </div>

      {open && (tabs.length === 0
        ? <p className="text-fg-subtle text-xs pl-[26px] py-1.5">Archived session has no tabs.</p>
        : tabs.map((t, i) => <TabRow key={`${t.url ?? "x"}-${i}`} tab={t} />))}
    </>
  );
}

function TabRow({ tab }: { tab: TabItem }) {
  const host = hostOf(tab.url);
  const openTab = () => tab.url && window.open(tab.url, "_blank", "noopener,noreferrer");

  return (
    <div style={{ marginLeft: 18 }}
      className="group relative flex items-center gap-2 pr-1.5 py-1.5 rounded-lg transition-colors hover:bg-[color-mix(in_srgb,var(--magenta)_13%,transparent)]">
      <span className="absolute left-[-9px] top-0 bottom-0 w-px bg-border" aria-hidden />
      <span className="w-4 shrink-0" />
      <Favicon url={tab.url} title={tab.title} />
      <span className="min-w-0 flex-1 truncate text-sm text-fg" title={tab.url || tab.title}>
        {tab.title || tab.url || "Untitled tab"}
        {host && <span className="ml-2 text-[11px] text-fg-subtle">{host}</span>}
      </span>
      {tab.url && (
        <button onClick={openTab} aria-label="Open in new tab"
          className="btn-ghost btn-sm btn-icon opacity-0 group-hover:opacity-100 transition-opacity">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14L21 3" /></svg>
        </button>
      )}
    </div>
  );
}

import { useEffect, useRef, useState, useMemo } from "react";
import { coll, type CheckProgressEvent } from "../api";

export interface CheckedLinkItem {
  id: string;
  url: string;
  title: string;
  verdict: "ok" | "dead" | "skipped";
  http_status?: number | null;
  error?: string | null;
}

export function CheckLinksModal({
  token,
  onClose,
}: {
  token: string;
  onClose: () => void;
}) {
  const [running, setRunning] = useState(true);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0);
  const [currentUrl, setCurrentUrl] = useState<string>("");
  const [items, setItems] = useState<CheckedLinkItem[]>([]);
  const [summary, setSummary] = useState<{
    checked: number;
    ok: number;
    dead: number;
    skipped: number;
    skipReason?: string | null;
  } | null>(null);
  const [filter, setFilter] = useState<"all" | "dead" | "ok" | "skipped">("all");
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    void (async () => {
      try {
        await coll.checkStream(
          token,
          (ev: CheckProgressEvent) => {
            if (ev.type === "start") {
              setTotal(ev.total ?? 0);
            } else if (ev.type === "checked") {
              setCurrent(ev.current ?? 0);
              setCurrentUrl(ev.url ?? "");
              if (ev.id && ev.url) {
                setItems((prev) => [
                  ...prev,
                  {
                    id: ev.id!,
                    url: ev.url!,
                    title: ev.title || "",
                    verdict: ev.verdict || "ok",
                    http_status: ev.http_status,
                    error: ev.error,
                  },
                ]);
              }
            } else if (ev.type === "done") {
              setRunning(false);
              setCurrentUrl("");
              setSummary({
                checked: ev.checked ?? 0,
                ok: ev.ok ?? 0,
                dead: ev.dead ?? 0,
                skipped: ev.skipped ?? 0,
                skipReason: ev.skip_reason,
              });
              if ((ev.dead ?? 0) > 0) {
                setFilter("dead");
              }
            }
          },
          controller.signal
        );
      } catch (err: unknown) {
        if (!controller.signal.aborted) {
          console.warn("Check links error:", err);
          setRunning(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [token]);

  // Auto-scroll list as items arrive
  useEffect(() => {
    if (running && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [items.length, running]);

  const deadCount = useMemo(() => items.filter((i) => i.verdict === "dead").length, [items]);
  const okCount = useMemo(() => items.filter((i) => i.verdict === "ok").length, [items]);
  const skippedCount = useMemo(() => items.filter((i) => i.verdict === "skipped").length, [items]);

  const displayedItems = useMemo(() => {
    if (filter === "dead") return items.filter((i) => i.verdict === "dead");
    if (filter === "ok") return items.filter((i) => i.verdict === "ok");
    if (filter === "skipped") return items.filter((i) => i.verdict === "skipped");
    return items;
  }, [items, filter]);

  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-bg border border-border rounded-2xl shadow-2xl max-w-2xl w-full flex flex-col max-h-[85vh] overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-fg">
              {running ? "Checking link liveness…" : "Link Check Complete"}
            </h2>
            <p className="text-xs text-fg-subtle mt-0.5">
              {running
                ? total > 0
                  ? `${current} of ${total} links probed (${percent}%)`
                  : "Starting liveness check…"
                : `${summary?.checked ?? current} checked · ${summary?.ok ?? okCount} alive · ${summary?.dead ?? deadCount} dead${summary?.skipped ? ` · ${summary.skipped} skipped` : ""}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-subtle hover:text-fg p-1.5 rounded-lg hover:bg-surface transition-colors"
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-border h-1 relative overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue to-teal transition-all duration-150"
            style={{ width: running ? `${Math.max(3, percent)}%` : "100%" }}
          />
        </div>

        {/* Current probed link indicator */}
        {running && currentUrl && (
          <div className="px-5 py-2 bg-surface border-b border-border/50 text-xs text-fg-muted flex items-center gap-2 truncate">
            <span className="w-2 h-2 rounded-full bg-teal animate-pulse shrink-0" />
            <span className="text-fg-subtle shrink-0">Checking:</span>
            <span className="truncate font-mono text-[11px] text-fg">{currentUrl}</span>
          </div>
        )}

        {/* Filter Tabs & Counters */}
        <div className="px-5 py-2.5 border-b border-border bg-bg/50 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={`px-2.5 py-1 text-xs rounded-lg font-medium transition-colors ${
                filter === "all" ? "bg-surface-2 text-fg shadow-sm border border-border" : "text-fg-subtle hover:text-fg"
              }`}
            >
              All ({items.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter("dead")}
              className={`px-2.5 py-1 text-xs rounded-lg font-medium transition-colors flex items-center gap-1.5 ${
                filter === "dead" ? "bg-red/15 text-red border border-red/30" : "text-fg-subtle hover:text-red"
              }`}
            >
              <span>Dead</span>
              {deadCount > 0 && (
                <span className="px-1.5 py-0.2 text-[10px] rounded-full bg-red/20 text-red font-bold">
                  {deadCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setFilter("ok")}
              className={`px-2.5 py-1 text-xs rounded-lg font-medium transition-colors ${
                filter === "ok" ? "bg-green/15 text-green border border-green/30" : "text-fg-subtle hover:text-green"
              }`}
            >
              Alive ({okCount})
            </button>
            {skippedCount > 0 && (
              <button
                type="button"
                onClick={() => setFilter("skipped")}
                className={`px-2.5 py-1 text-xs rounded-lg font-medium transition-colors ${
                  filter === "skipped" ? "bg-surface-2 text-fg border border-border" : "text-fg-subtle hover:text-fg"
                }`}
              >
                Skipped ({skippedCount})
              </button>
            )}
          </div>

          <div className="text-xs text-fg-subtle font-mono">
            {displayedItems.length} listed
          </div>
        </div>

        {/* Live List */}
        <div ref={listRef} className="flex-1 overflow-y-auto p-4 flex flex-col gap-2 min-h-[220px]">
          {displayedItems.length === 0 ? (
            <div className="h-full flex items-center justify-center text-fg-subtle text-xs py-12">
              {running ? "Probing links…" : filter === "dead" ? "No dead links found." : "No links in this view."}
            </div>
          ) : (
            displayedItems.map((item) => (
              <div
                key={item.id}
                className="p-2.5 rounded-xl border border-border bg-surface hover:bg-surface-2 transition-colors flex items-start gap-3 text-left"
              >
                {/* Badge */}
                <div className="shrink-0 pt-0.5">
                  {item.verdict === "ok" ? (
                    <span className="px-2 py-0.5 text-[10.5px] font-semibold rounded-md bg-green/15 text-green border border-green/30">
                      {item.http_status ?? 200} OK
                    </span>
                  ) : item.verdict === "dead" ? (
                    <span className="px-2 py-0.5 text-[10.5px] font-semibold rounded-md bg-red/15 text-red border border-red/30">
                      {item.http_status ? `HTTP ${item.http_status}` : "DEAD"}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 text-[10.5px] font-medium rounded-md bg-surface-2 text-fg-subtle border border-border">
                      SKIPPED
                    </span>
                  )}
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-fg truncate">
                    {item.title || item.url}
                  </div>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-fg-subtle truncate block font-mono hover:text-blue hover:underline mt-0.5"
                  >
                    {item.url}
                  </a>
                  {item.error && item.verdict === "dead" && (
                    <div className="text-[10.5px] text-red/90 mt-1 font-mono leading-tight truncate">
                      {item.error}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-border bg-surface flex items-center justify-between gap-3">
          <div className="text-xs text-fg-subtle truncate">
            {summary?.skipReason && (
              <span className="text-orange">{summary.skipReason}</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {running ? (
              <button
                type="button"
                onClick={() => {
                  abortRef.current?.abort();
                  setRunning(false);
                }}
                className="btn-ghost btn-sm text-red hover:text-red"
              >
                Stop check
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="btn-primary btn-sm"
            >
              {running ? "Close" : "Done"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { coll, type SnapshotSummary } from "../api";
import { relTime } from "../util";

export function SnapshotsMenu({
  token,
  onRestore,
  disabled,
}: {
  token: string;
  onRestore: (id: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState<SnapshotSummary | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const { data, refetch } = useQuery({
    queryKey: ["snapshots", token],
    queryFn: () => coll.snapshots(token),
    enabled: open,
  });

  useEffect(() => {
    if (!open) {
      setArmed(null);
      return;
    }
    const click = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setArmed(null);
      }
    };
    document.addEventListener("mousedown", click);
    return () => document.removeEventListener("mousedown", click);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          if (!open) refetch();
          setOpen(!open);
        }}
        disabled={disabled}
        className="btn-ghost"
      >
        History
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-bg shadow-xl border border-border rounded-xl p-2 z-50">
          <div className="px-3 py-2 text-xs font-bold text-fg-subtle border-b border-border mb-2 flex items-center justify-between">
            <span>Restorable Snapshots</span>
            <span className="text-[11px] font-normal text-fg-subtle">Replaces current tree</span>
          </div>

          {armed ? (
            <div
              className="rounded-xl px-3.5 py-3 m-1 flex flex-col gap-2.5"
              style={{
                background: "color-mix(in srgb, var(--orange) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--orange) 32%, transparent)",
              }}
            >
              <div className="text-[12px] font-semibold text-fg">
                Restore to &ldquo;{armed.label}&rdquo;?
              </div>
              <p className="text-[11.5px] leading-snug text-fg-muted">
                This will replace your current tree with {armed.node_count} nodes from {relTime(armed.created_at)}.
              </p>
              <div className="flex items-center justify-end gap-2 mt-1">
                <button
                  type="button"
                  onClick={() => setArmed(null)}
                  className="btn-ghost btn-sm"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onRestore(armed.id);
                    setArmed(null);
                    setOpen(false);
                  }}
                  className="btn-warn btn-sm"
                >
                  Restore
                </button>
              </div>
            </div>
          ) : !data || data.snapshots.length === 0 ? (
            <div className="px-3 py-2 text-xs text-fg-subtle">
              No snapshots available. Sweeping bulk actions take snapshots automatically.
            </div>
          ) : (
            <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {data.snapshots.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setArmed(s)}
                  className="flex flex-col items-start px-3 py-2 rounded-lg hover:bg-neutral-800 transition-colors text-left group"
                >
                  <span className="text-sm font-medium text-fg group-hover:text-fg-bright">{s.label}</span>
                  <span className="text-xs text-fg-subtle">
                    {s.node_count} nodes · {relTime(s.created_at)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

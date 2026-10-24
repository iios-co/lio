import { useState } from "react";
import type { TransformResult } from "../lib/transforms";
import type { UsageRow } from "../types";

export function StagedBanner({
  staged,
  doomedNodes = [],
  applying,
  onCancel,
  onApply,
}: {
  staged: TransformResult;
  doomedNodes?: UsageRow[];
  applying: boolean;
  onCancel: () => void;
  onApply: () => void;
}) {
  const [expanded, setExpanded] = useState(doomedNodes.length > 0 && doomedNodes.length <= 15);
  const color = staged.destructive ? "var(--red)" : "var(--orange)";

  return (
    <div
      className="rounded-xl px-4 py-3.5 mb-4 flex flex-col gap-2.5"
      style={{
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
      }}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold" style={{ color }}>
            {staged.label} — preview
          </div>
          <p className="text-[11.5px] leading-snug text-fg-muted mt-0.5">{staged.summary}</p>
          {doomedNodes.length > 0 && (() => {
            const hasFolders = doomedNodes.some((n) => n.is_folder);
            const hasLinks = doomedNodes.some((n) => !n.is_folder);
            const noun = hasFolders && hasLinks ? "item" : hasFolders ? "folder" : "link";
            return (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="text-[11px] font-medium text-fg underline hover:text-fg-bright mt-1 inline-flex items-center gap-1 cursor-pointer"
              >
                <span>{expanded ? "Hide" : "Show"} {doomedNodes.length} {noun}{doomedNodes.length === 1 ? "" : "s"} to be removed</span>
                <span className="text-[9px]">{expanded ? "▲" : "▼"}</span>
              </button>
            );
          })()}
        </div>
        <button type="button" onClick={onCancel} disabled={applying} className="btn-ghost btn-sm shrink-0">
          Cancel
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={applying}
          className={`${staged.destructive ? "btn-danger" : "btn-warn"} btn-sm shrink-0`}
        >
          {applying ? "Working…" : staged.verb}
        </button>
      </div>

      {doomedNodes.length > 0 && expanded && (
        <div className="pt-2 border-t border-border/40 flex flex-col gap-1.5 max-h-64 overflow-y-auto">
          {doomedNodes.map((node) => (
            <div
              key={node.node_id}
              className="px-2.5 py-1.5 rounded-lg bg-surface/80 border border-border/50 flex items-center justify-between gap-2 text-left"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-fg truncate">
                  {node.title || node.url}
                </div>
                <div className="text-[10.5px] text-fg-subtle truncate font-mono">
                  {node.url}
                </div>
              </div>
              {node.ok === false && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-red/20 text-red border border-red/30 shrink-0 font-mono">
                  {node.http_status ? `HTTP ${node.http_status}` : (node.status_error || "DEAD")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

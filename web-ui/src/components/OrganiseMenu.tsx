import { useEffect, useRef, useState } from "react";
import type { TransformKind } from "../lib/transforms";

interface Action {
  kind: TransformKind;
  label: string;
  hint: string;
  destructive?: boolean;
}

// Grouped so the destructive actions are visually separated from reorders.
const GROUPS: { title: string; actions: Action[] }[] = [
  {
    title: "Sort",
    actions: [
      { kind: "sort-visits", label: "Most visited first", hint: "Folders rank by their average" },
      { kind: "sort-alpha", label: "Alphabetical", hint: "By name, A→Z" },
      { kind: "sort-recent", label: "Recently visited", hint: "Newest visit first" },
      { kind: "sort-added", label: "Recently added", hint: "Newest bookmark first" },
      { kind: "reverse", label: "Reverse order", hint: "Flip every level" },
    ],
  },
  {
    title: "Restructure",
    actions: [
      { kind: "group-domain", label: "Group by domain", hint: "Replaces folders in Bookmarks Bar" },
    ],
  },
  {
    title: "Clean up",
    actions: [
      { kind: "dedupe", label: "Delete duplicates", hint: "Same URL, visits merged; removes duplicate folders", destructive: true },
      { kind: "dead-links", label: "Delete dead links", hint: "Failed the last check", destructive: true },
      { kind: "empty-folders", label: "Delete empty folders", hint: "No links inside", destructive: true },
    ],
  },
];

export function OrganiseMenu({
  enabled,
  onPick,
}: {
  /** Kinds that are implemented; anything else renders disabled. */
  enabled: TransformKind[];
  onPick: (kind: TransformKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} className="btn-ghost" aria-expanded={open}>
        Organise
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" className="ml-0.5">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 z-30 glass rounded-xl p-1.5 fade-up"
          style={{ boxShadow: "0 24px 48px -24px rgba(0,0,0,0.8)" }}>
          {GROUPS.map((g, gi) => (
            <div key={g.title}>
              {gi > 0 && <div className="h-px bg-border my-1.5" />}
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.11em] text-fg-subtle">
                {g.title}
              </div>
              {g.actions.map((a) => {
                const on = enabled.includes(a.kind);
                return (
                  <button
                    key={a.kind}
                    disabled={!on}
                    onClick={() => { setOpen(false); onPick(a.kind); }}
                    title={on ? a.hint : "Not available yet"}
                    className="w-full text-left px-2 py-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[color-mix(in_srgb,var(--blue)_13%,transparent)]"
                  >
                    <span className="block text-[12.5px] font-medium"
                      style={{ color: a.destructive ? "var(--red)" : "var(--fg)" }}>
                      {a.label}
                    </span>
                    <span className="block text-[10.5px] text-fg-subtle">{a.hint}</span>
                  </button>
                );
              })}
            </div>
          ))}
          <p className="px-2 pt-1.5 pb-1 text-[10px] text-fg-subtle">
            Every action previews first — nothing changes until you press Apply.
          </p>
        </div>
      )}
    </div>
  );
}

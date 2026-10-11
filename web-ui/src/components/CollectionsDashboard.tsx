import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { admin } from "../api";
import type { CollectionSummary } from "../types";
import { relTime } from "../util";
import { Logo } from "./Logo";
import { BuildStamp } from "./BuildStamp";
import { navigate } from "../router";

interface Props {
  onLogout: () => void;
}

export function CollectionsDashboard({ onLogout }: Props) {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["collections"],
    queryFn: () => admin.collections(),
  });

  const [newName, setNewName] = useState("");
  const [revealed, setRevealed] = useState<{ name: string; token: string } | null>(null);

  const create = useMutation({
    mutationFn: (name: string) => admin.createCollection(name),
    onSuccess: (res) => {
      setRevealed({ name: res.name, token: res.token });
      setNewName("");
      qc.invalidateQueries({ queryKey: ["collections"] });
    },
  });

  const collections = data?.collections ?? [];

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-border bg-[color-mix(in_srgb,var(--bg)_75%,transparent)] backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-5 py-3.5 flex items-center justify-between">
          <Logo size={34} />
          <div className="flex items-center gap-3">
            <BuildStamp />
            <button onClick={async () => { await admin.logout(); onLogout(); }}
              className="btn-ghost btn-sm">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-7">
        <div className="mb-7">
          <h1 className="text-lg font-semibold text-fg mb-0.5">Collections</h1>
          <p className="text-sm text-fg-subtle">
            Each collection has its own sync token. Create one, then paste its token into the browser extension.
          </p>
        </div>

        <div className="glass rounded-2xl p-3 mb-6 flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && newName.trim() && create.mutate(newName.trim())}
            placeholder="New collection name — e.g. Personal, Work, Research"
            className="field flex-1 !bg-transparent !border-transparent"
          />
          <button
            onClick={() => newName.trim() && create.mutate(newName.trim())}
            disabled={!newName.trim() || create.isPending}
            className="btn-primary"
          >
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>

        {revealed && (
          <TokenReveal name={revealed.name} token={revealed.token} onClose={() => setRevealed(null)} />
        )}

        {isLoading && <p className="text-fg-subtle text-sm">Loading…</p>}
        {isError && <p className="text-red text-sm">{(error as Error).message}</p>}
        {!isLoading && collections.length === 0 && (
          <div className="glass rounded-2xl p-10 text-center text-fg-subtle text-sm">
            No collections yet. Create your first one above.
          </div>
        )}

        <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(360px,1fr))] items-start">
          {collections.map((c) => (
            <CollectionCard key={c.id} c={c} />
          ))}
        </div>
      </main>
    </div>
  );
}

// ---- Card -----------------------------------------------------------------
// Fixed row order:
//   1. Name              (edit) (delete)
//   2. Token             (rotate)
//   3. Bookmarks | Open Tabs   — equal halves
//   4. ONE confirm slot  — same position and layout for every action; only the
//      accent colour changes. At most one action can be armed at a time.

type Armed = null | "delete" | "rotate";

function CollectionCard({ c }: { c: CollectionSummary }) {
  const qc = useQueryClient();
  const [armed, setArmed] = useState<Armed>(null);
  const [editing, setEditing] = useState(false);
  const [rotated, setRotated] = useState(false);

  const rename = useMutation({
    mutationFn: (name: string) => admin.renameCollection(c.id, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["collections"] }),
  });
  const rotate = useMutation({
    mutationFn: () => admin.rotateToken(c.id),
    onSuccess: () => {
      setArmed(null);
      setRotated(true);
      setTimeout(() => setRotated(false), 2500);
      qc.invalidateQueries({ queryKey: ["collections"] });
    },
  });
  const del = useMutation({
    mutationFn: () => admin.deleteCollection(c.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["collections"] }),
  });

  return (
    <div className="card p-4 fade-up flex flex-col gap-3">
      {/* 1 — Name (edit) (delete) */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <NameField
            name={c.name || "Untitled"}
            editing={editing}
            pending={rename.isPending}
            onStart={() => setEditing(true)}
            onDone={(v) => {
              setEditing(false);
              if (v && v !== c.name) rename.mutate(v);
            }}
          />
          <div className="text-[11px] text-fg-subtle mt-0.5">active {relTime(c.last_activity)}</div>
        </div>
        <IconBtn label="Rename collection" tone="plain" onClick={() => setEditing(true)}>
          <PencilIcon />
        </IconBtn>
        <IconBtn label="Delete collection" tone="red" pressed={armed === "delete"}
          onClick={() => setArmed(armed === "delete" ? null : "delete")}>
          <TrashIcon />
        </IconBtn>
      </div>

      {/* 2 — Token (rotate) */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <input
            readOnly
            value={c.token}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Sync token"
            className={`field font-mono !text-cyan ${rotated ? "!border-green" : ""}`}
          />
          {rotated && <span className="pill pill-ok absolute -top-2 right-2 !py-0 !text-[10px]">new</span>}
        </div>
        <IconBtn label="Rotate token" tone="orange" pressed={armed === "rotate"}
          onClick={() => setArmed(armed === "rotate" ? null : "rotate")}>
          <RotateIcon />
        </IconBtn>
      </div>

      {/* 3 — Bookmarks | Open Tabs, evenly spaced */}
      <div className="grid grid-cols-2 gap-2">
        <StatPanel label="Bookmarks" count={c.bookmark_count} accent="var(--blue)"
          onClick={() => navigate({ name: "bookmarks", token: c.token })} />
        <StatPanel label="Open Tabs" count={c.tab_count} accent="var(--magenta)"
          onClick={() => navigate({ name: "tabs", token: c.token })} />
      </div>

      {/* 4 — one confirm slot, identical for every action */}
      {armed && (
        <ConfirmSlot
          tone={armed === "delete" ? "red" : "orange"}
          description={
            armed === "delete"
              ? `Deletes “${c.name || "Untitled"}” with ${c.bookmark_count} bookmarks and ${c.tab_count} tabs. This cannot be undone.`
              : "A new token invalidates the current one — every device must be updated."
          }
          affirmative={armed === "delete" ? "Delete" : "Rotate"}
          pending={armed === "delete" ? del.isPending : rotate.isPending}
          onConfirm={() => (armed === "delete" ? del.mutate() : rotate.mutate())}
          onCancel={() => setArmed(null)}
        />
      )}
    </div>
  );
}

function StatPanel({ label, count, accent, onClick }: {
  label: string; count: number; accent: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-xl border border-border bg-[color-mix(in_srgb,var(--bg)_55%,transparent)] px-3 py-2.5 transition-colors"
      style={{ ["--accent" as string]: accent }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = `color-mix(in srgb, ${accent} 55%, transparent)`;
        e.currentTarget.style.background = `color-mix(in srgb, ${accent} 10%, transparent)`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "";
        e.currentTarget.style.background = "";
      }}
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.11em]" style={{ color: accent }}>
        {label}
      </span>
      <span className="mt-1.5 flex items-center justify-between">
        <span className="text-2xl font-bold leading-none tabular-nums" style={{ color: accent }}>{count}</span>
        <span className="text-base leading-none opacity-60 group-hover:opacity-100 transition-opacity"
          style={{ color: accent }}>›</span>
      </span>
    </button>
  );
}

// The single confirm presentation: description on the left, Cancel then the
// affirmative on the right. Affirmative always uses the tinted-outline shape;
// only its accent differs by severity.
function ConfirmSlot({ tone, description, affirmative, pending, onConfirm, onCancel }: {
  tone: "red" | "orange";
  description: string;
  affirmative: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const color = tone === "red" ? "var(--red)" : "var(--orange)";
  return (
    <div
      className="rounded-xl px-3 py-2.5 flex items-center gap-3"
      style={{
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
      }}
    >
      <p className="flex-1 text-[11.5px] leading-snug" style={{ color }}>{description}</p>
      <button onClick={onCancel} className="btn-ghost btn-sm">Cancel</button>
      <button
        onClick={onConfirm}
        disabled={pending}
        className={`${tone === "red" ? "btn-danger" : "btn-warn"} btn-sm`}
      >
        {pending ? "Working…" : affirmative}
      </button>
    </div>
  );
}

function NameField({ name, editing, pending, onStart, onDone }: {
  name: string; editing: boolean; pending: boolean; onStart: () => void; onDone: (v: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(name); }, [name, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onDone(draft.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") onDone(draft.trim());
          else if (e.key === "Escape") { setDraft(name); onDone(name); }
        }}
        maxLength={120}
        aria-label="Collection name"
        className="field field-sm !text-[15px] !font-semibold !border-blue"
      />
    );
  }
  return (
    <button onClick={onStart} title="Click to rename"
      className="block max-w-full text-[15px] font-semibold text-fg hover:text-blue transition-colors truncate text-left">
      {name}{pending && <span className="ml-2 text-[10px] font-normal text-fg-subtle">saving…</span>}
    </button>
  );
}

function IconBtn({ label, onClick, tone, pressed, children }: {
  label: string; onClick: () => void; tone: "plain" | "orange" | "red";
  pressed?: boolean; children: React.ReactNode;
}) {
  const variant =
    tone === "red" ? "btn-danger" : tone === "orange" ? "btn-warn" : "btn-ghost";
  return (
    <button title={label} aria-label={label} aria-pressed={pressed}
      onClick={onClick} className={`${variant} btn-sm btn-icon shrink-0`}>
      {children}
    </button>
  );
}

const _ic = {
  width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};
function RotateIcon() { return <svg {..._ic}><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></svg>; }
function TrashIcon() { return <svg {..._ic}><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" /></svg>; }
function PencilIcon() { return <svg {..._ic}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>; }

function TokenReveal({ name, token, onClose }: { name: string; token: string; onClose: () => void }) {
  return (
    <div className="mb-6 card p-4 fade-up" style={{ boxShadow: "0 0 30px rgba(122,162,247,0.3)" }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-fg">{name} — sync token</span>
        <button onClick={onClose} className="btn-ghost btn-sm">Dismiss</button>
      </div>
      <p className="text-xs text-fg-subtle mb-2">
        Paste this into the Lio extension on each device. Store it safely — you can rotate it from the card if it leaks.
      </p>
      <div className="flex items-center gap-2">
        <input readOnly value={token} onFocus={(e) => e.currentTarget.select()}
          className="field font-mono !text-cyan" />
        <button onClick={() => navigator.clipboard?.writeText(token)} className="btn-primary">Copy</button>
      </div>
    </div>
  );
}

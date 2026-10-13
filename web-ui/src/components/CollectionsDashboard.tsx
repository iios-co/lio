import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatConnectionString } from "../lib/connectCode";
import { useCollectionWebSocket } from "../lib/useCollectionWebSocket";
import { admin } from "../api";
import type { CollectionSummary } from "../types";
import { copyToClipboard, relTime } from "../util";
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
    refetchOnWindowFocus: true,
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
        <div className="max-w-6xl mx-auto px-5 py-2.5 flex items-center justify-between">
          <Logo size={24} withWordmark={false} />
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
        <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
          <div>
            <h1 className="text-lg font-semibold text-fg mb-0.5">Collections</h1>
            <p className="text-sm text-fg-subtle">
              Each collection has its own sync token. Create one, then paste its token into the browser extension.
            </p>
          </div>

          <div className="glass rounded-2xl p-3 flex items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !create.isPending) {
                  create.mutate(newName.trim() || "Personal");
                }
              }}
              placeholder="New collection name — e.g. Personal, Work, Research"
              className="field flex-1 !bg-transparent !border-transparent"
            />
            <button
              onClick={() => create.mutate(newName.trim() || "Personal")}
              disabled={create.isPending}
              className="btn-primary"
            >
              {create.isPending ? "Creating…" : "Create"}
            </button>
          </div>
        </div>

        {revealed && (
          <TokenReveal name={revealed.name} token={revealed.token} onClose={() => setRevealed(null)} />
        )}

        {isLoading && <p className="text-fg-subtle text-sm">Loading…</p>}
        {isError && <p className="text-red text-sm">{(error as Error).message}</p>}
        {!isLoading && collections.length === 0 && (
          <div className="glass rounded-2xl p-10 text-center text-fg-subtle text-sm">
            <p className="mb-4 text-fg font-medium">No collections yet. Create your first collection to start syncing.</p>
            <button
              onClick={() => create.mutate("Personal")}
              disabled={create.isPending}
              className="btn-primary"
            >
              {create.isPending ? "Creating…" : "Create 'Personal' Collection"}
            </button>
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
  useCollectionWebSocket(c.token);
  const qc = useQueryClient();
  const [armed, setArmed] = useState<Armed>(null);
  const [editing, setEditing] = useState(false);
  const [rotated, setRotated] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [showPairingFallback, setShowPairingFallback] = useState(false);
  const [cardCopyError, setCardCopyError] = useState("");

  const pairingCode = useMemo(() => {
    try {
      return formatConnectionString({ endpoint: window.location.origin, token: c.token });
    } catch {
      return "";
    }
  }, [c.token]);

  const copyPairingCode = async () => {
    if (!pairingCode) return;
    const ok = await copyToClipboard(pairingCode);
    if (ok) {
      setCardCopyError("");
      setShowPairingFallback(false);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } else {
      setCopiedCode(false);
      setShowPairingFallback(true);
      setCardCopyError("Could not copy automatically. Select and copy the pairing code below:");
    }
  };

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
      <div>
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
          </div>
          <IconBtn label="Rename collection" tone="plain" onClick={() => setEditing(true)}>
            <PencilIcon />
          </IconBtn>
          <IconBtn label="Delete collection" tone="red" pressed={armed === "delete"}
            onClick={() => setArmed(armed === "delete" ? null : "delete")}>
            <TrashIcon />
          </IconBtn>
        </div>
        <div className="text-[11px] text-fg-subtle mt-0.5">active {relTime(c.last_activity)}</div>
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
        <IconBtn
          label={copiedCode ? "Copied pairing code!" : "Copy pairing code"}
          tone={copiedCode ? "green" : "plain"}
          onClick={copyPairingCode}
        >
          {copiedCode ? <CheckIcon /> : <CopyIcon />}
        </IconBtn>
        <IconBtn label="Rotate token" tone="orange" pressed={armed === "rotate"}
          onClick={() => setArmed(armed === "rotate" ? null : "rotate")}>
          <RotateIcon />
        </IconBtn>
      </div>
      {showPairingFallback && pairingCode && (
        <div role="status" aria-live="polite" className="fade-up">
          <p className="text-[11px] text-orange mb-1">{cardCopyError}</p>
          <input
            readOnly
            value={pairingCode}
            onFocus={(e) => e.currentTarget.select()}
            autoFocus
            aria-label="Pairing code"
            className="field font-mono !text-cyan text-xs w-full"
          />
        </div>
      )}

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
        className="field field-sm !text-[15px] !font-semibold !border-blue w-full h-[32px] py-1 leading-normal"
      />
    );
  }
  return (
    <button onClick={onStart} title="Click to rename"
      className="block max-w-full text-[15px] font-semibold text-fg hover:text-blue transition-colors truncate text-left leading-normal py-1">
      {name}{pending && <span className="ml-2 text-[10px] font-normal text-fg-subtle">saving…</span>}
    </button>
  );
}

function IconBtn({ label, onClick, tone, pressed, children }: {
  label: string; onClick: () => void; tone: "plain" | "orange" | "red" | "green";
  pressed?: boolean; children: React.ReactNode;
}) {
  const variant =
    tone === "red" ? "btn-danger" : tone === "orange" ? "btn-warn" : tone === "green" ? "btn-ghost !text-green" : "btn-ghost";
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
function CopyIcon() {
  return (
    <svg {..._ic}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg {..._ic}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function TrashIcon() { return <svg {..._ic}><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" /></svg>; }
function PencilIcon() { return <svg {..._ic}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>; }

function TokenReveal({ name, token, onClose }: { name: string; token: string; onClose: () => void }) {
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedPairing, setCopiedPairing] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [viewMode, setViewMode] = useState<"pairing" | "raw">("pairing");

  const pairingCode = useMemo(() => {
    try {
      return formatConnectionString({ endpoint: window.location.origin, token });
    } catch {
      return "";
    }
  }, [token]);

  const copyPairing = async () => {
    if (!pairingCode) return;
    const ok = await copyToClipboard(pairingCode);
    if (ok) {
      setCopyError("");
      setCopiedToken(false);
      setCopiedPairing(true);
      setTimeout(() => setCopiedPairing(false), 2000);
    } else {
      setViewMode("pairing");
      setCopyError("Could not write to clipboard automatically. The pairing code is shown below — select and copy it manually.");
    }
  };

  const copyToken = async () => {
    const ok = await copyToClipboard(token);
    if (ok) {
      setCopyError("");
      setCopiedPairing(false);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    } else {
      setViewMode("raw");
      setCopyError("Could not write to clipboard automatically. The token is shown below — select and copy it manually.");
    }
  };

  const activeValue = viewMode === "pairing" ? (pairingCode || token) : token;

  return (
    <div className="mb-6 card p-4 fade-up" style={{ boxShadow: "0 0 30px rgba(122,162,247,0.3)" }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-fg">{name} — sync token & pairing</span>
        <button onClick={onClose} className="btn-ghost btn-sm">Dismiss</button>
      </div>
      <p className="text-xs text-fg-subtle mb-3">
        Use <b>Copy Pairing Code</b> to fill both the server URL and token into the extension with a single paste.
      </p>

      <div className="flex items-center gap-2 mb-2">
        <button
          type="button"
          onClick={() => setViewMode("pairing")}
          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
            viewMode === "pairing"
              ? "bg-[color-mix(in_srgb,var(--cyan)_20%,transparent)] text-cyan font-medium"
              : "text-fg-subtle hover:text-fg"
          }`}
        >
          Pairing Code (1-Click Paste)
        </button>
        <button
          type="button"
          onClick={() => setViewMode("raw")}
          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
            viewMode === "raw"
              ? "bg-[color-mix(in_srgb,var(--cyan)_20%,transparent)] text-cyan font-medium"
              : "text-fg-subtle hover:text-fg"
          }`}
        >
          Raw Token Only
        </button>
      </div>

      <div className="flex items-center gap-2 mb-1">
        <input
          readOnly
          value={activeValue}
          onFocus={(e) => e.currentTarget.select()}
          className="field font-mono !text-cyan flex-1 text-xs"
        />
        {pairingCode && (
          <button onClick={copyPairing} className="btn-primary text-xs px-3 py-1.5 whitespace-nowrap">
            {copiedPairing ? "Copied Code!" : "Copy Pairing Code"}
          </button>
        )}
        <button onClick={copyToken} className="btn-ghost text-xs px-3 py-1.5 whitespace-nowrap">
          {copiedToken ? "Copied!" : "Copy Token"}
        </button>
      </div>
      {copyError && <p className="text-xs text-orange mt-2">{copyError}</p>}
    </div>
  );
}

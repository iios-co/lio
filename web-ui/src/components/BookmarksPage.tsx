import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { coll } from "../api";
import type { CollectionSummary } from "../types";
import { navigate } from "../router";
import { TreeView } from "./TreeView";
import { BuildStamp } from "./BuildStamp";
import { OrganiseMenu } from "./OrganiseMenu";
import { SnapshotsMenu } from "./SnapshotsMenu";
import { StagedBanner } from "./StagedBanner";
import { buildTree, toArrangement } from "../lib/tree";
import { TRANSFORMS, type TransformKind, type TransformResult } from "../lib/transforms";
import { useCollectionWebSocket } from "../lib/useCollectionWebSocket";
import { relTime } from "../util";
import { CheckLinksModal } from "./CheckLinksModal";

// Bookmarks page (route: #/c/<token>).
//
// Organise actions run as a STAGED PREVIEW: the transform is pure, the result is
// held in local state and rendered immediately, and Cancel simply drops it. The
// server is untouched until Apply, so a preview can never half-commit. While a
// preview is staged the tree is frozen — what is on screen is not what the server
// holds, so dragging or deleting would act on a stale arrangement.
export function BookmarksPage({ collection }: { collection: CollectionSummary }) {
  const token = collection.token;
  useCollectionWebSocket(token);
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [staged, setStaged] = useState<TransformResult | null>(null);
  const [notice, setNotice] = useState("");
  const [checkingLinks, setCheckingLinks] = useState(false);
  // What the last apply did, so Undo names the action it will reverse.
  const [lastApplied, setLastApplied] = useState<string>("");
  const queryKey = ["usage", token, "tree"];
  const { data, isLoading, isError, error } = useQuery({
    queryKey,
    queryFn: () => coll.usage(token, { sort: "custom", dir: "asc", includeFolders: true }),
  });


  // Committing a staged arrangement: one transactional request. The server
  // snapshots first, so a sweeping change stays reversible.
  const apply = useMutation({
    mutationFn: (t: TransformResult) =>
      coll.reorganize(token, {
        label: t.label,
        placements: toArrangement(t.tree).map((p) => ({
          id: p.node_id,
          parent_id: p.parent_id,
          index: p.index,
        })),
        new_folders: t.newFolders?.map((f) => ({
          id: f.node_id,
          parent_id: f.parent_id,
          title: f.title,
          index: f.index,
        })),
        removed: t.removed,
        merge_visits: t.mergeVisits,
      }),
    onSuccess: (res, t) => {
      setStaged(null);
      setLastApplied(t.label);
      const bits = [`${res.moved} moved`];
      if (res.created) bits.push(`${res.created} folder${res.created === 1 ? "" : "s"} created`);
      if (res.removed) bits.push(`${res.removed} removed`);
      if (res.visits_merged) bits.push(`${res.visits_merged} visit count${res.visits_merged === 1 ? "" : "s"} merged`);
      setNotice(`${t.label} applied — ${bits.join(", ")}.`);
      qc.invalidateQueries({ queryKey: ["usage", token] });
    },
    onError: (e: Error) => setNotice(`Could not apply: ${e.message}. The tree is unchanged.`),
  });

  const undo = useMutation({
    mutationFn: (snapshotId?: number) => coll.undo(token, snapshotId),
    onSuccess: (res) => {
      setLastApplied("");
      setNotice(`Undone: ${res.label} — ${res.node_count} nodes restored.`);
      qc.invalidateQueries({ queryKey: ["usage", token] });
    },
    onError: (e: Error) => setNotice(`Could not undo: ${e.message}`),
  });

  const rows = data?.rows ?? [];
  const rowsById = useMemo(() => new Map(rows.map((r) => [r.node_id, r])), [rows]);
  const doomedNodes = useMemo(() => {
    if (!staged || !staged.removed || !staged.removed.length) return [];
    return staged.removed.map((id) => rowsById.get(id)).filter(Boolean) as typeof rows;
  }, [staged, rowsById]);
  const liveTree = useMemo(() => buildTree(rows), [rows]);
  const leaves = rows.filter((r) => !r.is_folder);
  const deadCount = leaves.filter((r) => r.ok === false).length;
  const folderCount = rows.filter((r) => r.is_folder).length;
  // The most recent liveness verdict across all links, so the UI can say when the
  // last check ran rather than showing a button with no notion of recency.
  const lastCheckedAt = leaves.reduce<number | null>(
    (max, r) => (r.checked_at && (!max || r.checked_at > max) ? r.checked_at : max),
    null,
  );

  // Every action in the menu is backed by a transform in the registry, so the
  // menu and the implementations cannot drift apart.
  const implemented = Object.keys(TRANSFORMS) as TransformKind[];

  function runTransform(kind: TransformKind) {
    setNotice("");
    const fn = TRANSFORMS[kind];
    if (!fn) return;
    const result = fn(liveTree);
    // A transform that would change nothing is reported, not staged — an empty
    // preview with a live Apply button would be a lie.
    if (result.noop) {
      setNotice(result.summary);
      return;
    }
    setStaged(result);
  }

  const shownTree = staged ? staged.tree : liveTree;

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-border bg-[color-mix(in_srgb,var(--bg)_75%,transparent)] backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-5 py-3.5 flex items-center gap-3">
          <button onClick={() => navigate({ name: "collections" })}
            className="btn-ghost btn-sm" title="Back to collections">← Collections</button>
          <span className="text-lg font-semibold text-fg">{collection.name || "Untitled"}</span>
          {/* LINKS is the one denominator every surface uses. Folders are
              counted separately and labelled, never silently folded into the
              same number — the popup showing all nodes while this showed links
              made the two surfaces disagree about identical data. */}
          <span className="text-xs text-fg-subtle">
            {leaves.length} link{leaves.length === 1 ? "" : "s"}
            {folderCount > 0 && <span> · {folderCount} folder{folderCount === 1 ? "" : "s"}</span>}
            {deadCount > 0 && <span className="text-red"> · {deadCount} dead</span>}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <BuildStamp />
            <button onClick={() => navigate({ name: "tabs", token })}
              className="btn-ghost btn-sm accent-magenta" title="View device tab sessions">Tabs ›</button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-5">
        <div className="flex items-center gap-2 mb-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search bookmarks…"
            className="field flex-1"
            disabled={!!staged}
          />
          <button
            onClick={() => setCheckingLinks(true)}
            disabled={checkingLinks || !!staged}
            className="btn-ghost accent-orange"
            title={lastCheckedAt
              ? `Last checked ${relTime(lastCheckedAt)}`
              : "These links have not been checked for liveness yet"}
          >
            {lastCheckedAt ? `Check links · ${relTime(lastCheckedAt)}` : "Check links"}
          </button>
          {!staged && <SnapshotsMenu token={token} onRestore={(id) => undo.mutate(id)} disabled={undo.isPending} />}
          {!staged && <OrganiseMenu enabled={implemented} onPick={runTransform} />}
        </div>

        {/* Dead links get a direct action, not just a count: the whole point of
            checking is to be able to act on the result. Reuses the same staged
            preview as the Organise menu, so it is never a silent delete. */}
        {deadCount > 0 && !staged && (
          <div className="rounded-xl px-3.5 py-3 mb-4 flex items-center gap-3"
            style={{ background: "color-mix(in srgb, var(--red) 9%, transparent)",
                     border: "1px solid color-mix(in srgb, var(--red) 30%, transparent)" }}>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-red">
                {deadCount} dead link{deadCount === 1 ? "" : "s"}
              </div>
              <p className="text-[11.5px] leading-snug text-fg-muted mt-0.5">
                Failed the last liveness check{lastCheckedAt ? ` (${relTime(lastCheckedAt)})` : ""}.
                Review them marked <span className="pill pill-dead !py-0 !text-[10px]">dead</span> in the tree, or stage them all for deletion.
              </p>
            </div>
            <button onClick={() => runTransform("dead-links")} className="btn-danger btn-sm shrink-0">
              Review & delete…
            </button>
          </div>
        )}

        {staged && (
          <StagedBanner
            staged={staged}
            doomedNodes={doomedNodes}
            applying={apply.isPending}
            onCancel={() => setStaged(null)}
            onApply={() => apply.mutate(staged)}
          />
        )}
        {(notice || lastApplied) && (
          <div className="flex items-center gap-2.5 mb-3">
            {notice && <p className="text-[11.5px] text-orange">{notice}</p>}
            {lastApplied && !staged && (
              <button
                onClick={() => undo.mutate()}
                disabled={undo.isPending}
                className="btn-ghost btn-sm accent-orange"
                title={`Undo "${lastApplied}"`}
              >
                {undo.isPending ? "Undoing…" : "Undo"}
              </button>
            )}
          </div>
        )}

        {isLoading && <p className="text-fg-subtle text-sm">Loading…</p>}
        {isError && <p className="text-red text-sm">{(error as Error)?.message ?? "Failed to load."}</p>}
        {!isLoading && !isError && rows.length === 0 && (
          <p className="text-fg-subtle text-sm">No bookmarks yet. Sync some from the extension.</p>
        )}
        {shownTree.length > 0 && (
          <TreeView nodes={shownTree} token={token} query={staged ? "" : q} frozen={!!staged} />
        )}

      {checkingLinks && (
        <CheckLinksModal
          token={token}
          onClose={() => {
            setCheckingLinks(false);
            qc.invalidateQueries({ queryKey: ["usage", token] });
          }}
        />
      )}
      </main>
    </div>
  );
}

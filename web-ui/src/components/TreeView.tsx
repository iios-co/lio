import {
  DndContext, DragOverlay, PointerSensor, pointerWithin, rectIntersection,
  useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { coll } from "../api";
import { relTime } from "../util";
import {
  countLeaves, filterTree, flatten, indexById, isDescendant, type TreeNode,
} from "../lib/tree";
import { Favicon } from "./Favicon";

export function TreeView({ nodes, token, query = "", frozen = false }: {
  /** The tree to render — the live tree, or a STAGED preview of a transform. */
  nodes: TreeNode[];
  token: string;
  query?: string;
  /** While a preview is staged, drag and delete are locked: the tree on screen
   *  is not what the server holds, so editing it would commit against stale ids. */
  frozen?: boolean;
}) {
  const fullTree = nodes;
  const searching = query.trim().length > 0;
  // Frozen or searching: the visible tree isn't the server's, so no editing.
  const locked = frozen || searching;
  const tree = useMemo(() => (searching ? filterTree(fullTree, query.trim()) : fullTree), [fullTree, query, searching]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const qc = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const allFolderIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (items: TreeNode[]) => {
      for (const item of items) {
        if (item.is_folder) {
          ids.push(item.node_id);
          if (item.children) walk(item.children);
        }
      }
    };
    walk(tree);
    return ids;
  }, [tree]);

  const allExpanded = allFolderIds.length > 0 && allFolderIds.every((id) => expanded.has(id));

  const toggleAll = () => {
    if (allExpanded) {
      setExpanded(new Set());
    } else {
      setExpanded(new Set(allFolderIds));
    }
  };

  const flat = useMemo(() => flatten(tree, expanded, searching), [tree, expanded, searching]);
  const byId = useMemo(() => indexById(tree), [tree]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["usage", token] });

  const move = useMutation({
    mutationFn: (v: { nodeId: string; parentId: string | null; index: number }) =>
      coll.reorder(token, v.nodeId, { parent_id: v.parentId, index: v.index }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (nodeId: string) => coll.remove(token, nodeId),
    onSuccess: () => { setConfirmDel(null); invalidate(); },
  });
  const updateNode = useMutation({
    mutationFn: (v: { nodeId: string; patch: { title?: string; url?: string } }) =>
      coll.update(token, v.nodeId, v.patch),
    onSuccess: invalidate,
  });
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  function onDragEnd(e: DragEndEvent) {
    setDragId(null);
    const activeId = String(e.active.id);
    const overRaw = e.over?.id ? String(e.over.id) : null;
    if (!overRaw) return;

    const dragged = byId.get(activeId);
    if (!dragged) return;

    // Dropping on a folder's "into" zone nests the node inside that folder.
    const intoFolder = overRaw.startsWith("into:");
    const overId = intoFolder ? overRaw.slice(5) : overRaw;
    if (overId === activeId) return;

    const target = byId.get(overId);
    if (!target) return;
    // Never move a folder into its own subtree.
    if (dragged.is_folder && isDescendant(dragged, overId)) return;

    if (intoFolder && target.is_folder) {
      move.mutate({ nodeId: activeId, parentId: overId, index: 0 });
      setExpanded((prev) => new Set(prev).add(overId));
      return;
    }

    // Otherwise become a sibling of the target, at the target's slot.
    const parentId = target.parent_id ?? null;
    const siblings = parentId ? (byId.get(parentId)?.children ?? []) : tree;
    const idx = siblings.findIndex((n) => n.node_id === overId);
    move.mutate({ nodeId: activeId, parentId, index: idx < 0 ? 0 : idx });
  }

  if (!tree.length) {
    return (
      <p className="text-fg-subtle text-sm px-1 py-6 text-center">
        {searching ? "No bookmarks match your search." : "This collection is empty."}
      </p>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-xs font-semibold text-fg-subtle">Structure</span>
        {allFolderIds.length > 0 && (
          <button onClick={toggleAll} className="btn-ghost btn-sm text-[11px] py-0.5 px-2">
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={(args) => {
          const within = pointerWithin(args);
          return within.length ? within : rectIntersection(args);
        }}
        onDragStart={(e: DragStartEvent) => setDragId(String(e.active.id))}
        onDragCancel={() => setDragId(null)}
        onDragEnd={onDragEnd}
      >
        <div className="glass rounded-2xl p-2">
          {flat.map(({ node, depth }) => (
            <Row
              key={node.node_id}
              node={node}
              depth={depth}
              open={searching || expanded.has(node.node_id)}
              searching={locked}
              locked={locked}
              dragging={dragId === node.node_id}
              confirming={confirmDel === node.node_id}
              deleting={remove.isPending && confirmDel === node.node_id}
              onToggle={() => toggle(node.node_id)}
              onAskDelete={() => setConfirmDel(node.node_id)}
              onCancelDelete={() => setConfirmDel(null)}
              onConfirmDelete={() => remove.mutate(node.node_id)}
              onUpdate={async (patch) => {
                try {
                  await updateNode.mutateAsync({ nodeId: node.node_id, patch });
                  return true;
                } catch {
                  return false;
                }
              }}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragId && byId.get(dragId) ? (
            <div className="glass rounded-lg px-3 py-1.5 text-sm text-fg shadow-lg">
              {byId.get(dragId)!.title || byId.get(dragId)!.url}
            </div>
          ) : null}
        </DragOverlay>
        {!locked && (
          <p className="mt-2 px-1 text-[11px] text-fg-subtle">
            Drag a row onto a folder to move into it, or between rows to reorder.
          </p>
        )}
      </DndContext>
    </div>
  );
}

function Row({
  node, depth, open, searching, locked, dragging, confirming, deleting,
  onToggle, onAskDelete, onCancelDelete, onConfirmDelete, onUpdate,
}: {
  node: TreeNode; depth: number; open: boolean; searching: boolean; locked: boolean; dragging: boolean;
  confirming: boolean; deleting: boolean;
  onToggle: () => void; onAskDelete: () => void; onCancelDelete: () => void; onConfirmDelete: () => void;
  onUpdate: (patch: { title?: string; url?: string }) => Promise<boolean>;
}) {
  const drag = useDraggable({ id: node.node_id, disabled: searching });
  // Sibling drop slot.
  const sibling = useDroppable({ id: node.node_id, disabled: searching });
  // Folders get a second, inner drop zone that means "put it inside me".
  const into = useDroppable({ id: `into:${node.node_id}`, disabled: searching || !node.is_folder });

  const dead = node.ok === false;
  // A "skipped" link was deliberately not probed (LAN host the operator didn't
  // allow, or a blocked address). Distinguished from "never checked" (null
  // ok, no error) so the row doesn't lie about why there is no verdict.
  const skipped = node.ok === null && !!node.status_error;
  const statusTitle = dead
    ? `Dead — ${node.http_status ? `HTTP ${node.http_status}` : node.status_error || "unreachable"}${node.checked_at ? ` · checked ${relTime(node.checked_at)}` : ""}`
    : skipped
      ? node.status_error || "Not checked"
      : node.ok === true && node.checked_at
        ? `Alive · checked ${relTime(node.checked_at)}`
        : null;
  const openLink = () => node.url && window.open(node.url, "_blank", "noopener,noreferrer");

  const nesting = node.is_folder && into.isOver;
  const siblingOver = sibling.isOver && !nesting;

  const [editingField, setEditingField] = useState<null | "title" | "url">(null);
  const [draftTitle, setDraftTitle] = useState(node.title || "");
  const [draftUrl, setDraftUrl] = useState(node.url || "");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [editError, setEditError] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingField) {
      setDraftTitle(node.title || "");
      setDraftUrl(node.url || "");
      setEditError("");
      setSaving(false);
    }
  }, [node.title, node.url, editingField]);

  useEffect(() => {
    if (editingField === "title") {
      titleInputRef.current?.select();
    } else if (editingField === "url") {
      urlInputRef.current?.select();
    }
  }, [editingField]);

  const commitTitle = async () => {
    if (savingRef.current) return;
    const val = draftTitle.trim();
    if (!val) {
      setEditError("Title cannot be empty");
      return;
    }
    if (val === node.title) {
      setEditingField(null);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setEditError("");
    try {
      const ok = await onUpdate({ title: val });
      if (ok) {
        setEditingField(null);
      } else {
        setEditError("Failed to update title");
      }
    } catch {
      setEditError("Failed to update title");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const commitUrl = async () => {
    if (savingRef.current) return;
    const val = draftUrl.trim();
    if (!val) {
      setEditError("URL cannot be empty");
      return;
    }
    try {
      const u = new URL(val);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        setEditError("URL must start with http:// or https://");
        return;
      }
    } catch {
      setEditError("Invalid URL format");
      return;
    }
    if (val === node.url) {
      setEditingField(null);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setEditError("");
    try {
      const ok = await onUpdate({ url: val });
      if (ok) {
        setEditingField(null);
      } else {
        setEditError("Failed to update URL");
      }
    } catch {
      setEditError("Failed to update URL");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div ref={sibling.setNodeRef} style={{ marginLeft: depth * 18 }} data-node-id={node.node_id}>
      <div
        ref={drag.setNodeRef}
        {...(searching || !!editingField ? {} : { ...drag.attributes, ...drag.listeners })}
        className={`group relative flex items-center gap-2 pr-1.5 py-1.5 rounded-lg transition-colors
          ${dragging ? "opacity-40" : ""}
          ${nesting ? "ring-2 ring-blue bg-[color-mix(in_srgb,var(--blue)_20%,transparent)]" : ""}
          ${siblingOver && !nesting ? "shadow-[inset_0_2px_0_0_var(--blue)]" : ""}
          ${!nesting && !siblingOver ? "hover:bg-[color-mix(in_srgb,var(--blue)_13%,transparent)]" : ""}`}
      >
        {depth > 0 && <span className="absolute left-[-9px] top-0 bottom-0 w-px bg-border" aria-hidden />}

        {node.is_folder ? (
          <button onClick={(e) => { e.stopPropagation(); onToggle(); }} onPointerDown={(e) => e.stopPropagation()}
            className="w-4 h-4 grid place-items-center text-fg-subtle hover:text-fg shrink-0"
            aria-label={open ? "Collapse folder" : "Expand folder"}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
              style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
              <path d="M9 6l6 6-6 6" /></svg>
          </button>
        ) : <span className="w-4 shrink-0" />}

        {node.is_folder ? (
          <span ref={into.setNodeRef} className="flex items-center gap-2 min-w-0 flex-1">
            <span className="grid place-items-center w-5 h-5 text-blue shrink-0" aria-hidden>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
            </span>
            {/* NO onPointerDown stopPropagation here. This button spans the row
                (flex-1), so swallowing pointerdown hid every folder row from the
                drag sensor — folders could not be reordered at all, while links
                (which have no such button) could. The sensor needs 6px of travel
                to activate, so a stationary click still toggles. */}
            <button onClick={(e) => { e.stopPropagation(); onToggle(); }}
              className="text-sm font-medium text-fg truncate text-left min-w-0 flex-1 flex items-center gap-1.5">
              <span>{node.title || "Folder"}</span>
              <span className="text-[11px] text-fg-subtle font-normal">({countLeaves(node)})</span>
            </button>
          </span>
        ) : (
          <>
            <Favicon url={node.url} title={node.title} />
            {editingField === "title" ? (
              <form
                onSubmit={(e) => { e.preventDefault(); void commitTitle(); }}
                className="min-w-0 flex-1 flex flex-col gap-0.5"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1.5 w-full">
                  <input
                    ref={titleInputRef}
                    value={draftTitle}
                    disabled={saving}
                    onChange={(e) => { setDraftTitle(e.target.value); setEditError(""); }}
                    onBlur={() => { if (!saving) void commitTitle(); }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setDraftTitle(node.title || ""); setEditingField(null); }
                    }}
                    aria-label="Edit bookmark title"
                    className="field field-sm !text-sm !py-0.5 !px-2 w-full !border-blue"
                  />
                  {saving && <span className="text-[10px] text-fg-subtle shrink-0">saving…</span>}
                </div>
                {editError && <span role="status" aria-live="polite" className="text-[10px] text-red">{editError}</span>}
              </form>
            ) : editingField === "url" ? (
              <form
                onSubmit={(e) => { e.preventDefault(); void commitUrl(); }}
                className="min-w-0 flex-1 flex flex-col gap-0.5"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1.5 w-full">
                  <input
                    ref={urlInputRef}
                    value={draftUrl}
                    disabled={saving}
                    type="url"
                    onChange={(e) => { setDraftUrl(e.target.value); setEditError(""); }}
                    onBlur={() => { if (!saving) void commitUrl(); }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setDraftUrl(node.url || ""); setEditingField(null); }
                    }}
                    aria-label="Edit bookmark URL"
                    className="field field-sm !text-xs !py-0.5 !px-2 w-full !border-blue font-mono text-cyan"
                  />
                  {saving && <span className="text-[10px] text-fg-subtle shrink-0">saving…</span>}
                </div>
                {editError && <span role="status" aria-live="polite" className="text-[10px] text-red">{editError}</span>}
              </form>
            ) : (
              <span className="min-w-0 flex-1 flex items-center gap-2 truncate">
                <button
                  type="button"
                  disabled={locked}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!locked) {
                      setDraftTitle(node.title || "");
                      setEditingField("title");
                    }
                  }}
                  title={locked ? undefined : "Click to edit title"}
                  className="text-sm font-medium text-fg hover:text-blue transition-colors truncate text-left disabled:hover:text-fg"
                >
                  {node.title || node.url || "Untitled"}
                </button>
                {node.url && (
                  <button
                    type="button"
                    disabled={locked}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!locked) {
                        setDraftUrl(node.url || "");
                        setEditingField("url");
                      }
                    }}
                    title={locked ? undefined : "Click to edit URL"}
                    className="text-[11px] text-fg-subtle hover:text-blue transition-colors truncate text-left font-mono shrink-0 max-w-[200px] disabled:hover:text-fg-subtle"
                  >
                    {node.url}
                  </button>
                )}
              </span>
            )}
          </>
        )}

        {confirming ? (
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="text-[11px] text-red mr-1">
              {node.is_folder ? `Delete folder and ${countLeaves(node)} items?` : "Delete this link?"}
            </span>
            <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onCancelDelete(); }}
              className="btn-ghost btn-sm">Cancel</button>
            <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onConfirmDelete(); }}
              disabled={deleting} className="btn-danger btn-sm">{deleting ? "Working…" : "Delete"}</button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 shrink-0">
            {node.is_folder ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full text-blue bg-[color-mix(in_srgb,var(--blue)_16%,transparent)]">
                {countLeaves(node)}
              </span>
            ) : (
              <>
                {node.visit_count > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-highlight text-cyan opacity-0 group-hover:opacity-100 transition-opacity">
                    {node.visit_count}▸
                  </span>
                )}
                {dead && (
                  <span className="pill pill-dead !py-0 !text-[10px]" title={statusTitle || "Dead link"}>dead</span>
                )}
                {node.ok === true && (
                  <span className="pill !py-0 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: "var(--green)", background: "color-mix(in srgb, var(--green) 14%, transparent)", borderColor: "color-mix(in srgb, var(--green) 30%, transparent)" }}
                    title={statusTitle || "Alive"}>ok</span>
                )}
                {skipped && (
                  <span className="pill !py-0 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                    title={statusTitle || "Not checked"}>skipped</span>
                )}
                <span className="text-[10px] text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity hidden sm:inline">
                  {relTime(node.last_visited_at)}
                </span>
                {node.url && (
                  <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openLink(); }}
                    aria-label="Open in new tab"
                    className="btn-ghost btn-sm btn-icon opacity-0 group-hover:opacity-100 transition-opacity">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14L21 3" /></svg>
                  </button>
                )}
              </>
            )}
            <button onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onAskDelete(); }}
              aria-label={node.is_folder ? "Delete folder" : "Delete link"}
              className="btn-danger btn-sm btn-icon opacity-0 group-hover:opacity-100 transition-opacity">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" /></svg>
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

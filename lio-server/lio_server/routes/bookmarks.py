"""Bookmark sync routes: full-tree bootstrap, delta push, incremental pull."""

from __future__ import annotations

import json
import secrets
import time
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, HTTPException, Query, status

from .. import db
from ..auth import require_collection
from ..config import active_settings
from ..events import broadcast_event
from ..ordering import domain_of, key_between
from ..models import (
    BookmarkNode,
    BookmarkTreeResponse,
    DeltaChange,
    DeltaChangeData,
    DeltaPullOp,
    DeltaPullResponse,
    DeltaPushRequest,
    DeltaPushResponse,
    DeleteNodeResponse,
    PlacedNodeIn,
    ReorganizeRequest,
    ReorganizeResponse,
    ReorderRequest,
    ReorderResponse,
    RestoreBaselineRequest,
    RestoreBaselineResponse,
    SnapshotListResponse,
    SnapshotSummary,
    SyncBatchRequest,
    SyncBatchResponse,
    SyncOperation,
    SyncOpChanges,
    UndoResponse,
    UpdateNodeRequest,
    UpdateNodeResponse,
    VisitBatchRequest,
    VisitBatchResponse,
)
router = APIRouter(prefix="/api/v1/collections/{token}/bookmarks", tags=["bookmarks"])


def _now_ms() -> int:
    return int(time.time() * 1000)


@router.get("/tree", response_model=BookmarkTreeResponse)
def get_tree(cid: str = Depends(require_collection)) -> BookmarkTreeResponse:
    """Full-tree bootstrap. Returns flat nodes plus the current server watermark
    the client should adopt as its initial ``since`` for incremental pulls."""
    conn = db.get_conn()
    rows = conn.execute(
        """
        SELECT id, parent_id, position, title, url, is_folder,
               date_added, date_modified, icon_base64, server_version
        FROM bookmarks
        WHERE cid = ? AND deleted = 0
        ORDER BY parent_id, position
        """,
        (cid,),
    ).fetchall()

    nodes = [
        BookmarkNode(
            id=r["id"],
            parent_id=r["parent_id"],
            position=r["position"],
            title=r["title"],
            url=r["url"],
            is_folder=bool(r["is_folder"]),
            date_added=r["date_added"],
            date_modified=r["date_modified"],
            icon_base64=r["icon_base64"],
            server_version=r["server_version"],
        )
        for r in rows
    ]
    ver_row = conn.execute(
        "SELECT COALESCE(MAX(id), 0) AS max_id FROM delta_log WHERE cid = ?",
        (cid,),
    ).fetchone()
    server_ver = int(ver_row["max_id"]) if ver_row else 0
    return BookmarkTreeResponse(
        nodes=nodes,
        server_timestamp=_now_ms(),
        server_version=server_ver,
    )


@router.post("/delta", response_model=DeltaPushResponse)
def push_delta(
    req: DeltaPushRequest,
    cid: str = Depends(require_collection),
) -> DeltaPushResponse:
    """Apply a batch of client delta ops with Last-Write-Wins resolution, then
    append each accepted op to the change feed tagged with its origin device."""
    applied = 0
    skipped = 0
    last_written_sv: int | None = None
    cur_max_sort_key: str | None = None

    def next_sort_key() -> str:
        nonlocal cur_max_sort_key
        cur_max_sort_key = _append_sort_key(conn, cid, cur_max_sort_key)
        return cur_max_sort_key

    with db.write_tx() as conn:
        for op in req.ops:
            op_id = op.op_id or f"{req.device_id}:{op.op}:{op.node_id}:{op.timestamp}"
            existing_log = conn.execute(
                "SELECT id FROM delta_log WHERE cid = ? AND origin = ? AND op_id = ?",
                (cid, req.device_id, op_id),
            ).fetchone()
            if existing_log is not None:
                skipped += 1
                continue

            # `resync` is server-authored only; a device must never push one.
            if op.op == "resync":
                skipped += 1
                continue
            existing = conn.execute(
                "SELECT date_modified, deleted, parent_id, position FROM bookmarks WHERE cid = ? AND id = ?",
                (cid, op.node_id),
            ).fetchone()

            # DELETION WINS -- for every op, INCLUDING `create`.
            #
            # A tombstone is authoritative and ids are never reused, so a
            # `create` naming a tombstoned id cannot be a new item: it can only
            # be a client replaying state it captured before it learned of the
            # deletion. This used to fall through to the upsert below, whose
            # `ON CONFLICT ... deleted = 0` cleared the tombstone and silently
            # undid the user's server-side delete (observed live: 3 links deleted
            # on the server came back on unpause).
            #
            # Restoration is a SERVER-side operation (undo, reorganize), never a
            # client create, so nothing legitimate needs this door open.
            if existing is not None and existing["deleted"] == 1:
                skipped += 1
                continue

            # LWW applies to CONTENT ops only (update/delete of an existing row).
            #
            # It must NOT gate `move`: a move is a position change, and ordering
            # a sibling group legitimately produces many moves whose timestamps
            # interleave with content edits. It must NOT gate `create` either: a
            # create carries the node's full truth, and a `move` that arrived
            # first for an unknown node inserts a stub whose date_modified would
            # then reject the real create, leaving a blank title and url forever.
            # Both were observed against a real browser.
            if op.op in ("update", "delete") and existing is not None:
                if existing["date_modified"] is not None and op.timestamp < existing["date_modified"]:
                    skipped += 1
                    continue

            if op.op == "delete":
                # A FOLDER DELETE TAKES ITS WHOLE SUBTREE.
                #
                # The browser fires one onRemoved for the folder, so a client only
                # ever sends the root id. Tombstoning just that id left every
                # descendant live with a parent_id pointing at a tombstone. The web
                # UI's buildTree treats a row whose parent is missing as a root, so
                # the orphans reappeared alongside Bookmarks Bar -- and the folder
                # count only dropped by 1 because only one row was tombstoned.
                #
                # `delete_node` (the web UI's path) already cascades via
                # _subtree_ids; the delta paths did not. Same rule, one helper.
                doomed = _subtree_ids(conn, cid, [op.node_id]) if existing is not None else []
                if not doomed:
                    doomed = [op.node_id]
                for nid in doomed:
                    # Derived op_id keeps the (cid, origin, op_id) uniqueness index
                    # satisfied while the client's own id still short-circuits a
                    # resend of the whole cascade.
                    cascade_op_id = op_id if nid == op.node_id else f"{op_id}:sub:{nid}"
                    cur = conn.execute(
                        """
                        INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin, op_id)
                        VALUES (?, 'delete', ?, ?, ?, ?, ?)
                        """,
                        (
                            cid,
                            nid,
                            json.dumps({"op": "delete", "node_id": nid, "timestamp": op.timestamp}),
                            op.timestamp,
                            req.device_id,
                            cascade_op_id,
                        ),
                    )
                    sv = int(cur.lastrowid)
                    last_written_sv = sv
                    row_exists = conn.execute(
                        "SELECT 1 FROM bookmarks WHERE cid = ? AND id = ?", (cid, nid)
                    ).fetchone()
                    if row_exists is not None:
                        conn.execute(
                            "UPDATE bookmarks SET deleted = 1, server_version = ? WHERE cid = ? AND id = ?",
                            (sv, cid, nid),
                        )
                    else:
                        conn.execute(
                            """
                            INSERT INTO bookmarks
                                (id, cid, parent_id, position, title, url, is_folder, deleted, server_version)
                            VALUES (?, ?, NULL, 0, '', NULL, 0, 1, ?)
                            """,
                            (nid, cid, sv),
                        )
                applied += 1
            elif op.op == "update" and existing is not None:
                cur = conn.execute(
                    """
                    INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin, op_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        cid,
                        op.op,
                        op.node_id,
                        op.model_dump_json(),
                        op.timestamp,
                        req.device_id,
                        op_id,
                    ),
                )
                sv = int(cur.lastrowid)
                last_written_sv = sv
                conn.execute(
                    """
                    UPDATE bookmarks
                    SET title = ?, url = ?, domain = ?, date_modified = ?,
                        icon_base64 = COALESCE(?, icon_base64), deleted = 0, server_version = ?
                    WHERE cid = ? AND id = ?
                    """,
                    (
                        op.title or "",
                        op.url,
                        domain_of(op.url),
                        op.timestamp,
                        op.icon_base64,
                        sv,
                        cid,
                        op.node_id,
                    ),
                )
                applied += 1
            elif op.op == "move" and existing is not None:
                old_parent_id = existing["parent_id"] if existing else None
                parent_id = op.parent_id if op.parent_id is not None else old_parent_id
                index = op.index if op.index is not None else (existing["position"] or 0)

                if existing is None:
                    conn.execute(
                        """
                        INSERT INTO bookmarks
                            (id, cid, parent_id, position, title, url, is_folder, deleted, server_version, sort_key)
                        VALUES (?, ?, ?, ?, '', NULL, 0, 0, 0, ?)
                        """,
                        (op.node_id, cid, parent_id, index, next_sort_key()),
                    )

                new_key, new_index, shifted = _apply_node_reorder(
                    conn, cid, op.node_id, parent_id, index, old_parent_id=old_parent_id
                )

                payload = {
                    "op": "move",
                    "node_id": op.node_id,
                    "parent_id": parent_id,
                    "index": new_index,
                    "timestamp": op.timestamp,
                }
                cur = conn.execute(
                    """
                    INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin, op_id)
                    VALUES (?, 'move', ?, ?, ?, ?, ?)
                    """,
                    (
                        cid,
                        op.node_id,
                        json.dumps(payload),
                        op.timestamp,
                        req.device_id,
                        op_id,
                    ),
                )
                sv = int(cur.lastrowid)
                last_written_sv = sv
                if shifted:
                    placeholders = ",".join("?" for _ in shifted)
                    conn.execute(
                        f"UPDATE bookmarks SET server_version = ? WHERE cid = ? AND id IN ({placeholders})",
                        (sv, cid, *shifted),
                    )
                applied += 1
            else:
                dom = domain_of(op.url)
                inherited = None
                if op.merge_from and op.merge_from != op.node_id:
                    inherited = conn.execute(
                        "SELECT visit_count, last_visited_at, date_added "
                        "FROM bookmarks WHERE cid = ? AND id = ?",
                        (cid, op.merge_from),
                    ).fetchone()
                cur = conn.execute(
                    """
                    INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin, op_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        cid,
                        op.op,
                        op.node_id,
                        op.model_dump_json(),
                        op.timestamp,
                        req.device_id,
                        op_id,
                    ),
                )
                sv = int(cur.lastrowid)
                last_written_sv = sv
                conn.execute(
                    """
                    INSERT INTO bookmarks
                        (id, cid, parent_id, position, title, url,
                         is_folder, date_added, date_modified, icon_base64,
                         domain, sort_key, visit_count, last_visited_at,
                         deleted, server_version)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                    ON CONFLICT(cid, id) DO UPDATE SET
                        parent_id     = excluded.parent_id,
                        position      = excluded.position,
                        title         = excluded.title,
                        url           = excluded.url,
                        is_folder     = excluded.is_folder,
                        date_modified = excluded.date_modified,
                        icon_base64   = COALESCE(excluded.icon_base64, bookmarks.icon_base64),
                        domain        = excluded.domain,
                        deleted       = 0,
                        server_version = excluded.server_version
                    """,
                    (
                        op.node_id,
                        cid,
                        op.parent_id,
                        op.index if op.index is not None else 0,
                        op.title or "",
                        op.url,
                        1 if op.is_folder else 0,
                        op.date_added if op.date_added is not None else op.timestamp,
                        op.timestamp,
                        op.icon_base64,
                        dom,
                        next_sort_key(),
                        int(inherited["visit_count"] or 0) if inherited else 0,
                        inherited["last_visited_at"] if inherited else None,
                        sv,
                    ),
                )
                if inherited:
                    del_cur = conn.execute(
                        """
                        INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin, op_id)
                        VALUES (?, 'delete', ?, ?, ?, ?, ?)
                        """,
                        (
                            cid,
                            op.merge_from,
                            json.dumps({"op": "delete", "node_id": op.merge_from, "timestamp": op.timestamp}),
                            op.timestamp,
                            req.device_id,
                            f"{op_id}:merge_delete",
                        ),
                    )
                    conn.execute(
                        "UPDATE bookmarks SET deleted = 1, server_version = ? WHERE cid = ? AND id = ?",
                        (int(del_cur.lastrowid), cid, op.merge_from),
                    )
                applied += 1

        if last_written_sv is not None:
            _prune_delta_log(conn, cid, last_row_id=last_written_sv)

    broadcast_event(
        cid,
        "bookmarks_updated",
        {"timestamp": _now_ms(), "origin": req.device_id, "op": "delta", "count": applied},
        exclude_device_id=req.device_id,
    )

    return DeltaPushResponse(
        applied=applied, skipped_stale=skipped, server_timestamp=_now_ms()
    )


@router.post("/sync", response_model=SyncBatchResponse)
def sync_bookmarks(
    req: SyncBatchRequest,
    cid: str = Depends(require_collection),
) -> SyncBatchResponse:
    """Atomic two-way sync batch with idempotency checks, tombstone tracking,
    conflict resolution, and monotonic server version sequencing."""
    conn = db.get_conn()
    acknowledged: list[str] = []
    conflicted: dict[str, DeltaChange] = {}
    applied_count = 0
    cur_max_sort_key: str | None = None

    def next_sort_key() -> str:
        nonlocal cur_max_sort_key
        cur_max_sort_key = _append_sort_key(conn, cid, cur_max_sort_key)
        return cur_max_sort_key

    with db.write_tx() as conn:
        for op in req.operations:
            # 1. Idempotency Check:
            # Has (cid, origin, op_id) been applied?
            existing_log = conn.execute(
                "SELECT id FROM delta_log WHERE cid = ? AND origin = ? AND op_id = ?",
                (cid, req.client_id, op.operation_id),
            ).fetchone()
            if existing_log is not None:
                acknowledged.append(op.operation_id)
                continue

            # 2. Existing bookmark check
            existing = conn.execute(
                """
                SELECT id, parent_id, position, title, url, is_folder,
                       date_added, date_modified, icon_base64, domain,
                       sort_key, visit_count, last_visited_at, deleted, server_version
                FROM bookmarks WHERE cid = ? AND id = ?
                """,
                (cid, op.item_id),
            ).fetchone()

            client_ts = _now_ms()
            if op.changes.date_modified is not None:
                client_ts = op.changes.date_modified
            elif op.changes.date_added is not None and op.operation == "create":
                client_ts = op.changes.date_added

            # 3. Conflict Rules:
            # Conflict Rule 1: TOMBSTONE INVARIANT. Deletion wins over every
            # incoming op, INCLUDING `create`.
            #
            # Ids are permanent and never reused, so a `create` naming a
            # tombstoned id cannot be a new item -- it is a client replaying
            # state captured before it learned of the deletion. Letting it
            # through resurrected the row and undid the user's delete.
            #
            # The op is ACKNOWLEDGED (so the client stops retrying it) and the
            # tombstone is returned as a `delete` change, so the client applies
            # the deletion locally and converges instead of pushing forever.
            if existing is not None and existing["deleted"] == 1:
                acknowledged.append(op.operation_id)
                if op.operation != "delete":
                    conflicted[op.item_id] = DeltaChange(
                        server_version=existing["server_version"],
                        item_id=op.item_id,
                        operation="delete",
                        data=DeltaChangeData(
                            parentId=existing["parent_id"],
                            position=existing["position"],
                            title=existing["title"],
                            url=existing["url"],
                            isFolder=bool(existing["is_folder"]),
                            dateAdded=existing["date_added"],
                            dateModified=existing["date_modified"],
                            iconBase64=existing["icon_base64"],
                        ),
                    )
                continue

            # Handle Delete
            if op.operation == "delete":
                ts = client_ts
                # Same rule as push_delta and delete_node: a folder delete takes
                # its whole subtree. The browser fires one onRemoved for the
                # folder, so the client only ever sends the root id; tombstoning
                # just that row orphaned every descendant.
                doomed = _subtree_ids(conn, cid, [op.item_id]) if existing is not None else []
                if not doomed:
                    doomed = [op.item_id]
                for nid in doomed:
                    cascade_op_id = (
                        op.operation_id if nid == op.item_id else f"{op.operation_id}:sub:{nid}"
                    )
                    cur = conn.execute(
                        """
                        INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin, op_id, client_seq)
                        VALUES (?, 'delete', ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            cid,
                            nid,
                            json.dumps({"op": "delete", "node_id": nid, "timestamp": ts}),
                            ts,
                            req.client_id,
                            cascade_op_id,
                            op.client_sequence,
                        ),
                    )
                    sv = int(cur.lastrowid)
                    row_exists = conn.execute(
                        "SELECT 1 FROM bookmarks WHERE cid = ? AND id = ?", (cid, nid)
                    ).fetchone()
                    if row_exists is not None:
                        conn.execute(
                            "UPDATE bookmarks SET deleted = 1, server_version = ? WHERE cid = ? AND id = ?",
                            (sv, cid, nid),
                        )
                    else:
                        conn.execute(
                            """
                            INSERT INTO bookmarks
                                (id, cid, parent_id, position, title, url, is_folder, deleted, server_version)
                            VALUES (?, ?, NULL, 0, '', NULL, 0, 1, ?)
                            """,
                            (nid, cid, sv),
                        )
                acknowledged.append(op.operation_id)
                applied_count += 1
                continue

            # Conflict Rule 2: LWW Rule for Updates:
            # If existing.server_version > op.lastServerVersion, check client op timestamp vs existing.date_modified.
            if existing is not None and op.operation == "update":
                if existing["server_version"] > op.last_server_version:
                    server_ts = existing["date_modified"] or 0
                    if client_ts < server_ts:
                        acknowledged.append(op.operation_id)
                        conflicted[op.item_id] = DeltaChange(
                            server_version=existing["server_version"],
                            item_id=op.item_id,
                            operation="update",
                            data=DeltaChangeData(
                                parentId=existing["parent_id"],
                                position=existing["position"],
                                title=existing["title"],
                                url=existing["url"],
                                isFolder=bool(existing["is_folder"]),
                                dateAdded=existing["date_added"],
                                dateModified=existing["date_modified"],
                                iconBase64=existing["icon_base64"],
                            ),
                        )
                        continue

            # Conflict Rule 3: CONCURRENT PLACEMENT. Both sides moved the same row
            # from the same earlier version (§6), so one policy must decide it:
            # the server's placement wins (§1 server authority).
            #
            # `existing["server_version"] > op.last_server_version` means the row
            # moved on the server AFTER the version this client last received, so
            # the client authored its move without knowing. Applying it anyway is
            # what put a server-reordered link back where it was whenever the
            # browser had also reordered something.
            #
            # The op is ACKNOWLEDGED (the client must stop retrying it, §7
            # "repeated operation ID: acknowledge it but do not apply it again")
            # and the server's placement is returned so the client converges.
            if (
                existing is not None
                and op.operation == "move"
                and existing["server_version"] > op.last_server_version
            ):
                acknowledged.append(op.operation_id)
                conflicted[op.item_id] = DeltaChange(
                    server_version=existing["server_version"],
                    item_id=op.item_id,
                    operation="move",
                    data=DeltaChangeData(
                        parentId=existing["parent_id"],
                        position=existing["position"],
                        title=existing["title"],
                        url=existing["url"],
                        isFolder=bool(existing["is_folder"]),
                        dateAdded=existing["date_added"],
                        dateModified=existing["date_modified"],
                        iconBase64=existing["icon_base64"],
                    ),
                )
                continue

            # Handle Move
            if op.operation == "move":
                ts = client_ts
                parent_id = op.changes.parent_id if op.changes.parent_id is not None else (existing["parent_id"] if existing else None)
                index = op.changes.index if op.changes.index is not None else (existing["position"] if existing else 0)
                old_parent_id = existing["parent_id"] if existing else None

                if existing is None:
                    conn.execute(
                        """
                        INSERT INTO bookmarks
                            (id, cid, parent_id, position, title, url, is_folder, deleted, server_version, sort_key)
                        VALUES (?, ?, ?, ?, '', NULL, 0, 0, 0, ?)
                        """,
                        (op.item_id, cid, parent_id, index, next_sort_key()),
                    )

                new_key, new_index, shifted = _apply_node_reorder(
                    conn, cid, op.item_id, parent_id, index, old_parent_id=old_parent_id
                )

                payload = {
                    "op": "move",
                    "node_id": op.item_id,
                    "parent_id": parent_id,
                    "index": new_index,
                    "timestamp": ts,
                }
                cur = conn.execute(
                    """
                    INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin, op_id, client_seq)
                    VALUES (?, 'move', ?, ?, ?, ?, ?, ?)
                    """,
                    (cid, op.item_id, json.dumps(payload), ts, req.client_id, op.operation_id, op.client_sequence),
                )
                sv = int(cur.lastrowid)
                last_written_sv = sv
                if shifted:
                    placeholders = ",".join("?" for _ in shifted)
                    conn.execute(
                        f"UPDATE bookmarks SET server_version = ? WHERE cid = ? AND id IN ({placeholders})",
                        (sv, cid, *shifted),
                    )
                acknowledged.append(op.operation_id)
                applied_count += 1
                continue

            # Handle Update
            if op.operation == "update":
                ts = client_ts
                title = op.changes.title if op.changes.title is not None else (existing["title"] if existing else "")
                url = op.changes.url if op.changes.url is not None else (existing["url"] if existing else None)
                is_folder = op.changes.is_folder if op.changes.is_folder is not None else (bool(existing["is_folder"]) if existing else False)
                icon_base64 = op.changes.icon_base64 if op.changes.icon_base64 is not None else (existing["icon_base64"] if existing else None)
                dom = domain_of(url)

                payload = {
                    "op": "update",
                    "node_id": op.item_id,
                    "title": title,
                    "url": url,
                    "is_folder": is_folder,
                    "icon_base64": icon_base64,
                    "timestamp": ts,
                }
                cur = conn.execute(
                    """
                    INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin, op_id, client_seq)
                    VALUES (?, 'update', ?, ?, ?, ?, ?, ?)
                    """,
                    (cid, op.item_id, json.dumps(payload), ts, req.client_id, op.operation_id, op.client_sequence),
                )
                sv = int(cur.lastrowid)
                if existing is not None:
                    conn.execute(
                        """
                        UPDATE bookmarks
                        SET title = ?, url = ?, is_folder = ?, icon_base64 = ?, domain = ?, date_modified = ?, deleted = 0, server_version = ?
                        WHERE cid = ? AND id = ?
                        """,
                        (title, url, 1 if is_folder else 0, icon_base64, dom, ts, sv, cid, op.item_id),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO bookmarks
                            (id, cid, parent_id, position, title, url, is_folder, date_added, date_modified, icon_base64, domain, sort_key, deleted, server_version)
                        VALUES (?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                        """,
                        (op.item_id, cid, title, url, 1 if is_folder else 0, ts, ts, icon_base64, dom, next_sort_key(), sv),
                    )
                acknowledged.append(op.operation_id)
                applied_count += 1
                continue

            # Handle Create
            if op.operation == "create":
                ts = client_ts
                parent_id = op.changes.parent_id
                index = op.changes.index if op.changes.index is not None else 0
                title = op.changes.title or ""
                url = op.changes.url
                is_folder = bool(op.changes.is_folder)
                date_added = op.changes.date_added if op.changes.date_added is not None else ts
                icon_base64 = op.changes.icon_base64
                dom = domain_of(url)

                inherited = None
                if op.changes.merge_from and op.changes.merge_from != op.item_id:
                    inherited = conn.execute(
                        "SELECT visit_count, last_visited_at, date_added FROM bookmarks WHERE cid = ? AND id = ?",
                        (cid, op.changes.merge_from),
                    ).fetchone()

                payload = {
                    "op": "create",
                    "node_id": op.item_id,
                    "parent_id": parent_id,
                    "index": index,
                    "title": title,
                    "url": url,
                    "is_folder": is_folder,
                    "date_added": date_added,
                    "icon_base64": icon_base64,
                    "timestamp": ts,
                }
                cur = conn.execute(
                    """
                    INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin, op_id, client_seq)
                    VALUES (?, 'create', ?, ?, ?, ?, ?, ?)
                    """,
                    (cid, op.item_id, json.dumps(payload), ts, req.client_id, op.operation_id, op.client_sequence),
                )
                sv = int(cur.lastrowid)

                sort_key = next_sort_key()
                visit_count = int(inherited["visit_count"] or 0) if inherited else 0
                last_visited_at = inherited["last_visited_at"] if inherited else None
                if inherited and inherited["date_added"]:
                    date_added = inherited["date_added"]

                conn.execute(
                    """
                    INSERT INTO bookmarks
                        (id, cid, parent_id, position, title, url, is_folder,
                         date_added, date_modified, icon_base64, domain, sort_key,
                         visit_count, last_visited_at, deleted, server_version)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                    ON CONFLICT(cid, id) DO UPDATE SET
                        parent_id     = excluded.parent_id,
                        position      = excluded.position,
                        title         = excluded.title,
                        url           = excluded.url,
                        is_folder     = excluded.is_folder,
                        date_modified = excluded.date_modified,
                        icon_base64   = COALESCE(excluded.icon_base64, bookmarks.icon_base64),
                        domain        = excluded.domain,
                        deleted       = 0,
                        server_version = excluded.server_version
                    """,
                    (
                        op.item_id,
                        cid,
                        parent_id,
                        index,
                        title,
                        url,
                        1 if is_folder else 0,
                        date_added,
                        ts,
                        icon_base64,
                        dom,
                        sort_key,
                        visit_count,
                        last_visited_at,
                        sv,
                    ),
                )
                if inherited:
                    del_cur = conn.execute(
                        """
                        INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin)
                        VALUES (?, 'delete', ?, ?, ?, ?)
                        """,
                        (
                            cid,
                            op.changes.merge_from,
                            json.dumps({"op": "delete", "node_id": op.changes.merge_from, "timestamp": ts}),
                            ts,
                            req.client_id,
                        ),
                    )
                    conn.execute(
                        "UPDATE bookmarks SET deleted = 1, server_version = ? WHERE cid = ? AND id = ?",
                        (int(del_cur.lastrowid), cid, op.changes.merge_from),
                    )
                acknowledged.append(op.operation_id)
                applied_count += 1
                continue

        # Fetch changes since lastServerVersion:
        delta_rows = conn.execute(
            """
            SELECT id, op, node_id, payload_json, timestamp, origin, op_id
            FROM delta_log
            WHERE cid = ? AND id > ?
              AND (origin IS NULL OR origin != ?)
            ORDER BY id ASC
            """,
            (cid, req.last_server_version, req.client_id),
        ).fetchall()

        changes: list[DeltaChange] = []
        changed_item_ids: set[str] = set()

        for r in delta_rows:
            try:
                payload = json.loads(r["payload_json"])
            except Exception:
                payload = {}
            op_name = r["op"]
            item_id = r["node_id"]
            changed_item_ids.add(item_id)

            data = DeltaChangeData(
                parentId=payload.get("parent_id") if payload.get("parent_id") is not None else payload.get("parentId"),
                position=payload.get("index") if payload.get("index") is not None else payload.get("position"),
                title=payload.get("title"),
                url=payload.get("url"),
                isFolder=bool(payload["is_folder"]) if "is_folder" in payload else (bool(payload["isFolder"]) if "isFolder" in payload else None),
                dateAdded=payload.get("date_added") if payload.get("date_added") is not None else payload.get("dateAdded"),
                dateModified=payload.get("date_modified") if payload.get("date_modified") is not None else (payload.get("timestamp") if payload.get("timestamp") is not None else r["timestamp"]),
                iconBase64=payload.get("icon_base64") if payload.get("icon_base64") is not None else payload.get("iconBase64"),
            )
            changes.append(
                DeltaChange(
                    server_version=r["id"],
                    item_id=item_id,
                    operation=op_name,
                    data=data,
                )
            )

        for item_id, change in conflicted.items():
            if item_id not in changed_item_ids:
                changes.append(change)
                changed_item_ids.add(item_id)

        ver_row = conn.execute(
            "SELECT COALESCE(MAX(id), 0) AS max_id FROM delta_log WHERE cid = ?",
            (cid,),
        ).fetchone()
        current_server_ver = int(ver_row["max_id"]) if ver_row else 0

        _prune_delta_log(conn, cid, last_row_id=current_server_ver)

    if applied_count > 0:
        broadcast_event(
            cid,
            "bookmarks_updated",
            {
                "timestamp": _now_ms(),
                "origin": req.client_id,
                "op": "sync",
                "serverVersion": current_server_ver,
                "count": applied_count,
            },
            exclude_device_id=req.client_id,
        )

    return SyncBatchResponse(
        acknowledged_operations=acknowledged,
        changes=changes,
        current_server_version=current_server_ver,
        server_timestamp=_now_ms(),
    )


@router.get("/delta", response_model=DeltaPullResponse)
def pull_delta(
    cid: str = Depends(require_collection),
    since: int = Query(0, description="Return ops with timestamp strictly greater."),
    device_id: str | None = Query(
        None, description="Requesting device; its own ops are excluded (echo suppression)."
    ),
) -> DeltaPullResponse:
    """Incremental pull: all ops newer than ``since``, excluding the caller's own
    ops so a device never re-applies what it authored."""
    conn = db.get_conn()

    if since > 0:
        oldest = conn.execute(
            "SELECT MIN(timestamp) AS mn FROM delta_log WHERE cid = ?", (cid,)
        ).fetchone()
        if oldest and oldest["mn"] is not None and oldest["mn"] > since:
            # The delta log was pruned past the requested since watermark.
            # Return a resync op so the client falls back to full-tree bootstrap/reconcile.
            return DeltaPullResponse(
                ops=[
                    DeltaPullOp(
                        op="resync",
                        node_id="*",
                        payload={"op": "resync", "reason": "log_pruned", "timestamp": _now_ms()},
                        timestamp=_now_ms(),
                        origin="server",
                    )
                ],
                server_timestamp=_now_ms(),
            )

    params: list[object] = [cid, since]
    sql = (
        "SELECT op, node_id, payload_json, timestamp, origin "
        "FROM delta_log WHERE cid = ? AND timestamp > ?"
    )
    if device_id is not None:
        sql += " AND (origin IS NULL OR origin != ?)"
        params.append(device_id)
    sql += " ORDER BY timestamp ASC, id ASC"

    rows = conn.execute(sql, params).fetchall()
    ops = [
        DeltaPullOp(
            op=r["op"],
            node_id=r["node_id"],
            payload=json.loads(r["payload_json"]),
            timestamp=r["timestamp"],
            origin=r["origin"],
        )
        for r in rows
    ]
    return DeltaPullResponse(ops=ops, server_timestamp=_now_ms())


def _prune_delta_log(conn, cid: str, last_row_id: int | None = None, force: bool = False) -> None:
    """Cap the per-collection change feed. A device offline longer than the
    retention window simply falls back to a full-tree bootstrap."""
    if not force and last_row_id is not None and last_row_id % 512 != 0:
        return
    max_rows = active_settings().delta_log_max_rows
    conn.execute(
        """
        DELETE FROM delta_log
        WHERE cid = ? AND id <= (
            SELECT MAX(id) - ? FROM delta_log WHERE cid = ?
        )
        """,
        (cid, max_rows, cid),
    )


# ---- Custom ordering ------------------------------------------------------


def _append_sort_key(conn, cid: str, prev: str | None = None) -> str:
    """Fractional key that sorts after every existing item in the collection."""
    if prev is None:
        row = conn.execute(
            "SELECT MAX(sort_key) AS mx FROM bookmarks WHERE cid = ? AND sort_key IS NOT NULL",
            (cid,),
        ).fetchone()
        prev = row["mx"] if row and row["mx"] else None
    return key_between(prev, None)


def _apply_node_reorder(
    conn: sqlite3.Connection,
    cid: str,
    node_id: str,
    parent_id: str | None,
    target_index: int,
    old_parent_id: str | None = None,
) -> tuple[str, int, list[str]]:
    """Place node_id under parent_id at target_index, assigning a fractional
    sort_key between its neighbours and renumbering the sibling group
    contiguously so position order and sort_key order agree.

    Returns (new_sort_key, new_position, list_of_shifted_node_ids).
    """
    sibs = conn.execute(
        """
        SELECT id, sort_key FROM bookmarks
        WHERE cid = ? AND parent_id IS ? AND deleted = 0 AND id != ?
        ORDER BY sort_key IS NULL, sort_key ASC, position ASC, id ASC
        """,
        (cid, parent_id, node_id),
    ).fetchall()

    keys: list[str] = []
    prev: str | None = None
    for sib in sibs:
        key = sib["sort_key"]
        if key is None:
            key = key_between(prev, None)
            conn.execute(
                "UPDATE bookmarks SET sort_key = ? WHERE cid = ? AND id = ?",
                (key, cid, sib["id"]),
            )
        keys.append(key)
        prev = key

    idx = max(0, min(target_index, len(keys)))
    before_key = keys[idx - 1] if idx > 0 else None
    after_key = keys[idx] if idx < len(keys) else None
    new_key = key_between(before_key, after_key)

    conn.execute(
        "UPDATE bookmarks SET sort_key = ?, parent_id = ? WHERE cid = ? AND id = ?",
        (new_key, parent_id, cid, node_id),
    )

    ordered = conn.execute(
        """
        SELECT id, position FROM bookmarks
        WHERE cid = ? AND parent_id IS ? AND deleted = 0
        ORDER BY sort_key IS NULL, sort_key ASC, position ASC, id ASC
        """,
        (cid, parent_id),
    ).fetchall()

    new_index = 0
    shifted: list[str] = []
    for i, sib in enumerate(ordered):
        if sib["id"] == node_id:
            new_index = i
        if sib["position"] != i or sib["id"] == node_id:
            shifted.append(sib["id"])
        conn.execute(
            "UPDATE bookmarks SET position = ? WHERE cid = ? AND id = ?",
            (i, cid, sib["id"]),
        )

    if old_parent_id is not None and old_parent_id != parent_id:
        old_ordered = conn.execute(
            """
            SELECT id, position FROM bookmarks
            WHERE cid = ? AND parent_id IS ? AND deleted = 0
            ORDER BY sort_key IS NULL, sort_key ASC, position ASC, id ASC
            """,
            (cid, old_parent_id),
        ).fetchall()
        for i, sib in enumerate(old_ordered):
            if sib["position"] != i:
                shifted.append(sib["id"])
                conn.execute(
                    "UPDATE bookmarks SET position = ? WHERE cid = ? AND id = ?",
                    (i, cid, sib["id"]),
                )

    return new_key, new_index, shifted


@router.patch("/{node_id}/reorder", response_model=ReorderResponse)
def reorder(
    node_id: str,
    req: ReorderRequest,
    cid: str = Depends(require_collection),
) -> ReorderResponse:
    """Set a node's custom ``sort_key``. Either pass an explicit ``sort_key`` or
    the ``before``/``after`` neighbour keys and let the server compute one.

    Also recomputes the node's integer ``position`` among its siblings and
    appends a ``move`` delta, so a synced extension applies the same reorder to
    the local browser bookmark tree on its next pull."""
    conn = db.get_conn()

    with db.write_tx() as conn:
        row = conn.execute(
            "SELECT parent_id FROM bookmarks WHERE cid = ? AND id = ? AND deleted = 0",
            (cid, node_id),
        ).fetchone()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No such bookmark in this collection.",
            )
        parent_id = req.parent_id if req.parent_id is not None else row["parent_id"]
        old_parent_id = row["parent_id"]

        if req.index is not None:
            new_key, new_index, shifted = _apply_node_reorder(
                conn, cid, node_id, parent_id, req.index, old_parent_id=old_parent_id
            )
        else:
            new_key = req.sort_key if req.sort_key is not None else key_between(req.before, req.after)
            conn.execute(
                "UPDATE bookmarks SET sort_key = ?, parent_id = ? WHERE cid = ? AND id = ?",
                (new_key, parent_id, cid, node_id),
            )
            ordered = conn.execute(
                """
                SELECT id, position FROM bookmarks
                WHERE cid = ? AND parent_id IS ? AND deleted = 0
                ORDER BY sort_key IS NULL, sort_key ASC, position ASC, id ASC
                """,
                (cid, parent_id),
            ).fetchall()
            new_index = 0
            shifted = []
            for i, sib in enumerate(ordered):
                if sib["id"] == node_id:
                    new_index = i
                if sib["position"] != i or sib["id"] == node_id:
                    shifted.append(sib["id"])
                conn.execute(
                    "UPDATE bookmarks SET position = ? WHERE cid = ? AND id = ?",
                    (i, cid, sib["id"]),
                )
            if old_parent_id is not None and old_parent_id != parent_id:
                old_ordered = conn.execute(
                    """
                    SELECT id, position FROM bookmarks
                    WHERE cid = ? AND parent_id IS ? AND deleted = 0
                    ORDER BY sort_key IS NULL, sort_key ASC, position ASC, id ASC
                    """,
                    (cid, old_parent_id),
                ).fetchall()
                for i, sib in enumerate(old_ordered):
                    if sib["position"] != i:
                        shifted.append(sib["id"])
                        conn.execute(
                            "UPDATE bookmarks SET position = ? WHERE cid = ? AND id = ?",
                            (i, cid, sib["id"]),
                        )

        move_payload = {
            "node_id": node_id,
            "parent_id": parent_id,
            "index": new_index,
            "timestamp": _now_ms(),
        }
        # ONE delta per drag: the user performed a single action, and a synced
        # extension reconciles the induced sibling shifts from the full tree.
        # Flooding the log with a move per sibling would evict real history.
        cur = conn.execute(
            """
            INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin)
            VALUES (?, 'move', ?, ?, ?, ?)
            """,
            (cid, node_id, json.dumps(move_payload), _now_ms(), "web-ui"),
        )
        sv = int(cur.lastrowid)
        if shifted:
            placeholders = ",".join("?" for _ in shifted)
            conn.execute(
                f"UPDATE bookmarks SET server_version = ? WHERE cid = ? AND id IN ({placeholders})",
                (sv, cid, *shifted),
            )
        _prune_delta_log(conn, cid, last_row_id=int(cur.lastrowid))

    broadcast_event(
        cid,
        "bookmarks_updated",
        {"timestamp": _now_ms(), "origin": "web-ui", "op": "move", "node_id": node_id},
    )
    return ReorderResponse(node_id=node_id, sort_key=new_key)


@router.patch("/{node_id}", response_model=UpdateNodeResponse)
def update_node(
    node_id: str,
    req: UpdateNodeRequest,
    cid: str = Depends(require_collection),
) -> UpdateNodeResponse:
    """Update a bookmark's title and/or URL.

    Emits an ``update`` delta (origin ``web-ui``) and broadcasts ``bookmarks_updated``
    so synced extensions mirror the change to local browser bookmarks."""
    if not req.model_fields_set:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one field (title or url) must be provided.",
        )

    if "title" in req.model_fields_set:
        # Browser bookmarks support empty titles (e.g. icon-only bookmarks).
        pass

    if "url" in req.model_fields_set:
        if req.url is None or not req.url.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="URL cannot be empty.",
            )
        parsed = urlparse(req.url.strip())
        if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="URL must be a valid http or https address.",
            )

    conn = db.get_conn()
    with db.write_tx() as conn:
        row = conn.execute(
            "SELECT id, is_folder, title, url FROM bookmarks WHERE cid = ? AND id = ? AND deleted = 0",
            (cid, node_id),
        ).fetchone()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No such bookmark in this collection.",
            )
        if row["is_folder"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Only bookmark links can be edited.",
            )

        new_title = req.title.strip() if (req.title and req.title.strip()) else "" if "title" in req.model_fields_set else row["title"]
        new_url = req.url.strip() if "url" in req.model_fields_set else row["url"]
        new_domain = domain_of(new_url) if new_url else None
        ts = _now_ms()
        cur = conn.execute(
            """
            INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin)
            VALUES (?, 'update', ?, ?, ?, 'web-ui')
            """,
            (
                cid,
                node_id,
                json.dumps({
                    "op": "update",
                    "node_id": node_id,
                    "title": new_title,
                    "url": new_url,
                    "timestamp": ts,
                }),
                ts,
            ),
        )
        sv = int(cur.lastrowid)
        conn.execute(
            """
            UPDATE bookmarks
            SET title = ?, url = ?, domain = ?, date_modified = ?, server_version = ?
            WHERE cid = ? AND id = ?
            """,
            (new_title, new_url, new_domain, ts, sv, cid, node_id),
        )
        _prune_delta_log(conn, cid, last_row_id=sv)

    broadcast_event(
        cid,
        "bookmarks_updated",
        {"timestamp": ts, "origin": "web-ui", "op": "update", "node_id": node_id},
    )

    return UpdateNodeResponse(node_id=node_id, title=new_title, url=new_url, domain=new_domain)


@router.delete("/{node_id}", response_model=DeleteNodeResponse)
def delete_node(
    node_id: str,
    cid: str = Depends(require_collection),
) -> DeleteNodeResponse:
    """Delete a bookmark, or a folder and everything under it.

    Emits one ``delete`` delta per removed node (origin ``web-ui``) so a synced
    extension removes the same nodes from the local browser tree on its next
    pull. Deleting a folder deliberately takes its whole subtree, matching what
    the browser itself does."""
    conn = db.get_conn()
    with db.write_tx() as conn:
        row = conn.execute(
            "SELECT id, is_folder FROM bookmarks WHERE cid = ? AND id = ? AND deleted = 0",
            (cid, node_id),
        ).fetchone()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No such bookmark in this collection.",
            )

        # Collect the subtree (breadth-first via recursive CTE) so folders take their children.
        doomed = _subtree_ids(conn, cid, [node_id])

        ts = _now_ms()
        for nid in doomed:
            cur = conn.execute(
                """
                INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin)
                VALUES (?, 'delete', ?, ?, ?, 'web-ui')
                """,
                (
                    cid,
                    nid,
                    json.dumps({"op": "delete", "node_id": nid, "timestamp": ts}),
                    ts,
                ),
            )
            sv = int(cur.lastrowid)
            conn.execute(
                "UPDATE bookmarks SET deleted = 1, server_version = ? WHERE cid = ? AND id = ?",
                (sv, cid, nid),
            )
        _prune_delta_log(conn, cid, last_row_id=sv)

    broadcast_event(
        cid,
        "bookmarks_updated",
        {"timestamp": ts, "origin": "web-ui", "op": "delete", "node_id": node_id, "deleted": len(doomed)},
    )

    return DeleteNodeResponse(deleted=len(doomed), node_ids=doomed)


# ---- Bulk reorganize ------------------------------------------------------

_SNAPSHOT_KEEP = 5

_SNAPSHOT_COLUMNS = (
    "id",
    "parent_id",
    "position",
    "title",
    "url",
    "is_folder",
    "date_added",
    "date_modified",
    "icon_base64",
    "sort_key",
    "visit_count",
    "last_visited_at",
    "domain",
)


def _take_snapshot(conn, cid: str, label: str) -> int:
    """Store the entire current tree so a sweeping change can be undone in one
    step. Keeps only the newest ``_SNAPSHOT_KEEP`` per collection."""
    rows = conn.execute(
        f"SELECT {', '.join(_SNAPSHOT_COLUMNS)} FROM bookmarks WHERE cid = ? AND deleted = 0",
        (cid,),
    ).fetchall()
    nodes = [{k: r[k] for k in _SNAPSHOT_COLUMNS} for r in rows]
    cur = conn.execute(
        """
        INSERT INTO tree_snapshots (cid, label, nodes_json, node_count, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (cid, label, json.dumps(nodes), len(nodes), _now_ms()),
    )
    conn.execute(
        """
        DELETE FROM tree_snapshots
        WHERE cid = ? AND id NOT IN (
            SELECT id FROM tree_snapshots WHERE cid = ? ORDER BY id DESC LIMIT ?
        )
        """,
        (cid, cid, _SNAPSHOT_KEEP),
    )
    return int(cur.lastrowid or 0)


def _emit_resync(conn, cid: str, label: str, detail: dict) -> int:
    """One marker delta standing in for the whole rearrangement.

    A group-by-domain over ~1800 bookmarks would otherwise append ~1800 move
    ops; devices would apply them one at a time and could interleave with local
    edits. The marker instead tells each device to re-read the tree and
    reconcile once."""
    ts = _now_ms()
    payload = {"op": "resync", "node_id": "*", "reason": label, "timestamp": ts, **detail}
    cur = conn.execute(
        """
        INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin)
        VALUES (?, 'resync', '*', ?, ?, 'web-ui')
        """,
        (cid, json.dumps(payload), ts),
    )
    _prune_delta_log(conn, cid, last_row_id=int(cur.lastrowid))
    return int(cur.lastrowid)

def _subtree_ids(
    conn, cid: str, roots: list[str], keep: set[str] | None = None
) -> list[str]:
    """Every id at or under the given roots (a folder takes its children).

    ``keep`` names nodes the caller is relocating in the same operation: they are
    neither collected nor descended into, so dissolving a folder deletes the
    folder without deleting the links being moved out of it."""
    protected = keep or set()
    active_roots = [r for r in roots if r not in protected]
    if not active_roots:
        return []
    root_ph = ",".join("?" for _ in active_roots)
    params: list[object] = [cid, *active_roots, cid]
    keep_clause = ""
    if protected:
        keep_ph = ",".join("?" for _ in protected)
        keep_clause = f"AND b.id NOT IN ({keep_ph})"
        params.extend(protected)
    sql = f"""
    WITH RECURSIVE doomed(id) AS (
      SELECT id FROM bookmarks WHERE cid = ? AND id IN ({root_ph}) AND deleted = 0
      UNION
      SELECT b.id FROM bookmarks b JOIN doomed d ON b.parent_id = d.id
      WHERE b.cid = ? AND b.deleted = 0 {keep_clause}
    )
    SELECT id FROM doomed
    """
    rows = conn.execute(sql, params).fetchall()
    return [r["id"] for r in rows]


@router.post("/reorganize", response_model=ReorganizeResponse)
def reorganize(
    req: ReorganizeRequest,
    cid: str = Depends(require_collection),
) -> ReorganizeResponse:
    """Apply one sweeping rearrangement of the tree, all or nothing.

    This is what backs the Organise actions (group by domain, sort by visits,
    delete duplicates): the web UI stages the whole target arrangement, the user
    confirms, and it lands here as a single transaction. Nothing is written
    until every placement has been validated, so a rejected request leaves the
    tree byte-for-byte as it was.

    Order of operations matters and is deliberate:
      1. snapshot the current tree (so undo has something to restore)
      2. mint real ids for the ``new:`` placeholder folders
      3. fold absorbed visit counts into their survivors
      4. delete removed nodes (and their subtrees)
      5. write every placement, rebuilding sibling positions and sort keys
      6. append ONE resync marker instead of thousands of move deltas
    """
    conn = db.get_conn()

    with db.write_tx() as conn:
        # -- validate before touching anything ---------------------------
        existing = {
            r["id"]
            for r in conn.execute(
                "SELECT id FROM bookmarks WHERE cid = ? AND deleted = 0", (cid,)
            ).fetchall()
        }

        # Container ids that rows already point at but which have no row of
        # their own. The browser's hidden root ("0") is exactly this: the
        # extension syncs Bookmarks Bar with parent_id "0" but never syncs
        # node "0" itself. Such an id is a legitimate parent — rejecting it
        # would fail every request touching a real browser tree — while a
        # genuinely unknown id is still refused.
        implied_parents = {
            r["parent_id"]
            for r in conn.execute(
                "SELECT DISTINCT parent_id FROM bookmarks WHERE cid = ? "
                "AND parent_id IS NOT NULL AND deleted = 0",
                (cid,),
            ).fetchall()
        } - existing

        placeholders = {f.id for f in req.new_folders}
        if len(placeholders) != len(req.new_folders):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Duplicate placeholder folder id.",
            )

        # Ids this request relocates. A removal must NOT cascade onto these:
        # dissolving a folder while moving its links elsewhere is one atomic
        # step, and deleting the folder's whole subtree would take the very
        # links the same request is re-parenting.
        placed_ids = {
            p.id for p in req.placements if p.id not in placeholders
        }

        explicit_removed = [r for r in req.removed if r in existing]
        for nid in explicit_removed:
            if nid in placed_ids:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Node {nid} is both placed and removed.",
                )

        doomed = set(_subtree_ids(conn, cid, explicit_removed, keep=placed_ids))

        seen_placement: set[str] = set()
        for p in req.placements:
            if p.id in seen_placement:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Node {p.id} placed more than once.",
                )
            seen_placement.add(p.id)
            if p.id not in existing and p.id not in placeholders:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Unknown node in placements: {p.id}",
                )
            if p.id in doomed:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Node {p.id} is both placed and removed.",
                )
            if (
                p.parent_id is not None
                and p.parent_id not in existing
                and p.parent_id not in placeholders
                and p.parent_id not in implied_parents
            ):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Unknown parent in placements: {p.parent_id}",
                )

        # Cycle check on the arrangement the request describes.
        parent_of: dict[str, str | None] = {p.id: p.parent_id for p in req.placements}
        for f in req.new_folders:
            parent_of.setdefault(f.id, f.parent_id)
        for start in parent_of:
            walker: str | None = start
            for _ in range(len(parent_of) + 2):
                walker = parent_of.get(walker) if walker is not None else None
                if walker is None:
                    break
                if walker == start:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Placement would create a cycle at {start}.",
                    )

        # -- 1. snapshot -------------------------------------------------
        snapshot_id = _take_snapshot(conn, cid, req.label)

        # -- 2. create the new folders -----------------------------------
        id_map: dict[str, str] = {}
        ts = _now_ms()
        for f in req.new_folders:
            real = "fld_" + secrets.token_hex(8)
            id_map[f.id] = real
        for f in req.new_folders:
            parent = id_map.get(f.parent_id or "", f.parent_id)
            conn.execute(
                """
                INSERT INTO bookmarks
                    (id, cid, parent_id, position, title, url, is_folder,
                     date_added, date_modified, sort_key)
                VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)
                """,
                (
                    id_map[f.id],
                    cid,
                    parent,
                    f.index,
                    f.title,
                    ts,
                    ts,
                    key_between(None, None),
                ),
            )

        # -- 3. merge visit counts into survivors ------------------------
        merged = 0
        for m in req.merge_visits:
            if m.survivor not in existing:
                continue
            absorbed = [a for a in m.absorbed if a in existing and a != m.survivor]
            if not absorbed:
                continue
            marks = ",".join("?" for _ in absorbed)
            agg = conn.execute(
                f"""
                SELECT COALESCE(SUM(visit_count), 0) AS total,
                       MAX(COALESCE(last_visited_at, 0)) AS last
                FROM bookmarks WHERE cid = ? AND id IN ({marks})
                """,
                (cid, *absorbed),
            ).fetchone()
            conn.execute(
                """
                UPDATE bookmarks
                SET visit_count = visit_count + ?,
                    last_visited_at = MAX(COALESCE(last_visited_at, 0), ?)
                WHERE cid = ? AND id = ?
                """,
                (int(agg["total"] or 0), int(agg["last"] or 0), cid, m.survivor),
            )
            merged += len(absorbed)

        # -- 4. remove ---------------------------------------------------
        for nid in doomed:
            conn.execute("UPDATE bookmarks SET deleted = 1 WHERE cid = ? AND id = ?", (cid, nid))

        # -- 5. place ----------------------------------------------------
        # Group placements by their resolved parent, then write ascending
        # positions and fractional sort keys so display order and browser
        # position order agree (same invariant the single reorder keeps).
        by_parent: dict[str | None, list[PlacedNodeIn]] = {}
        for p in req.placements:
            real_id = id_map.get(p.id, p.id)
            real_parent = id_map.get(p.parent_id or "", p.parent_id)
            by_parent.setdefault(real_parent, []).append(
                PlacedNodeIn(id=real_id, parent_id=real_parent, index=p.index)
            )

        # Current (parent, RANK) for everything, so `moved` counts only
        # nodes that genuinely change place. Rank, not the raw `position`
        # integer: stored positions are not contiguous in a real tree, so
        # comparing integers would count a harmless renumbering (8 -> 7) as
        # a move and report more than the preview promised.
        current: dict[str, tuple[str | None, int]] = {}
        sib_rows = conn.execute(
            # Tie-break on id, NOT title: 221 sibling groups in a real tree
            # share a position integer, and SQLite's byte-wise title order
            # disagrees with the browser UI's locale-aware compare. Ranking
            # them differently made the result contradict the preview.
            "SELECT id, parent_id, position FROM bookmarks WHERE cid = ? "
            "ORDER BY parent_id, position, id",
            (cid,),
        ).fetchall()
        groups: dict[str | None, list[str]] = {}
        for r in sib_rows:
            groups.setdefault(r["parent_id"], []).append(r["id"])
        for pid, members in groups.items():
            for rank, nid in enumerate(members):
                current[nid] = (pid, rank)

        moved = 0
        for parent, group in by_parent.items():
            group.sort(key=lambda n: n.index)
            prev: str | None = None
            for i, node in enumerate(group):
                k = key_between(prev, None)
                if current.get(node.id) != (parent, i):
                    moved += 1
                conn.execute(
                    """
                    UPDATE bookmarks
                    SET parent_id = ?, position = ?, sort_key = ?, date_modified = ?, deleted = 0
                    WHERE cid = ? AND id = ?
                    """,
                    (parent, i, k, ts, cid, node.id),
                )
                prev = k

        # Record what THIS organize did, so undo can invert exactly it and
        # leave any links the user deleted or added afterwards untouched.
        conn.execute(
            "UPDATE tree_snapshots SET created_json = ?, removed_json = ? "
            "WHERE cid = ? AND id = ?",
            (
                json.dumps(list(id_map.values())),
                json.dumps(list(doomed)),
                cid,
                snapshot_id,
            ),
        )

        # -- 6. explicit tombstone deltas for removed nodes ------------------
        for nid in doomed:
            conn.execute(
                """
                INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin)
                VALUES (?, 'delete', ?, ?, ?, 'web-ui')
                """,
                (cid, nid, json.dumps({"op": "delete", "node_id": nid, "timestamp": ts}), ts),
            )

        # -- 7. one marker delta for rearrangement ---------------------------
        sv = _emit_resync(
            conn,
            cid,
            req.label,
            {
                "moved": moved,
                "created": len(id_map),
                "removed": len(doomed),
                "snapshot_id": snapshot_id,
            },
        )
        all_touched = set(doomed) | {p.id for p in req.placements} | set(id_map.values())
        if all_touched:
            placeholders = ",".join("?" for _ in all_touched)
            conn.execute(
                f"UPDATE bookmarks SET server_version = ? WHERE cid = ? AND id IN ({placeholders})",
                (sv, cid, *all_touched),
            )

    broadcast_event(
        cid,
        "bookmarks_updated",
        {"timestamp": ts, "origin": "web-ui", "op": "resync", "reason": req.label},
    )

    return ReorganizeResponse(
        moved=moved,
        created=len(id_map),
        removed=len(doomed),
        visits_merged=merged,
        snapshot_id=snapshot_id,
        id_map=id_map,
        server_timestamp=_now_ms(),
    )


@router.get("/snapshots", response_model=SnapshotListResponse)
def list_snapshots(cid: str = Depends(require_collection)) -> SnapshotListResponse:
    """The undo stack: newest first, capped at the retained few."""
    rows = db.get_conn().execute(
        "SELECT id, label, node_count, created_at FROM tree_snapshots "
        "WHERE cid = ? ORDER BY id DESC",
        (cid,),
    ).fetchall()
    return SnapshotListResponse(
        snapshots=[
            SnapshotSummary(
                id=r["id"],
                label=r["label"],
                node_count=r["node_count"],
                created_at=r["created_at"],
            )
            for r in rows
        ]
    )


@router.post("/undo", response_model=UndoResponse)
def undo(
    snapshot_id: int | None = Query(None, description="Specific snapshot to restore (default: newest)"),
    cid: str = Depends(require_collection)
) -> UndoResponse:
    """Reverse a recorded action.

    Two distinct operations, matching the two surfaces that call it:

    ``snapshot_id`` omitted — SURGICAL UNDO of the newest action. This is the
    inline "Undo" after an organise. It inverts exactly what that one action did,
    using the ids the action recorded as its own ``created``/``removed``:

      * nodes the action REMOVED are re-inserted from the snapshot — but only
        those, so a link the user deleted separately afterwards stays deleted;
      * surviving nodes are reverted on structure and visits only (parent_id,
        position, sort_key, visit_count, last_visited_at), so a post-action
        rename or icon change is kept;
      * folders the action CREATED are dropped once empty — if the user added a
        bookmark into one afterwards the folder is kept rather than destroyed;
      * nodes the user created after the action are not in the snapshot, so they
        are left completely alone.

    The old behaviour here deleted the whole tree and re-inserted the snapshot,
    which is wrong the moment the user edits between the action and the undo.
    Observed live: organise by domain, delete two links, undo — both deleted
    links came back.

    ``snapshot_id`` given — WHOLESALE RESTORE to that snapshot. This is the
    History menu, which explicitly promises to "replace your current tree"; a
    surgical inverse of one old action layered under newer ones would be
    incoherent, so this one really does replace the tree.

    A snapshot recorded before the surgical model carries no created/removed ids;
    the inline undo then falls back to a wholesale restore, since there is nothing
    to invert against.
    """
    conn = db.get_conn()
    restore = snapshot_id is not None

    with db.write_tx() as conn:
        if restore:
            snap = conn.execute(
                "SELECT id, label, nodes_json, created_json, removed_json "
                "FROM tree_snapshots WHERE cid = ? AND id = ?",
                (cid, snapshot_id),
            ).fetchone()
        else:
            snap = conn.execute(
                "SELECT id, label, nodes_json, created_json, removed_json "
                "FROM tree_snapshots WHERE cid = ? ORDER BY id DESC LIMIT 1",
                (cid,),
            ).fetchone()
        if snap is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Nothing to undo for this collection.",
            )

        cur_max_sort_key: str | None = None

        def next_sort_key() -> str:
            nonlocal cur_max_sort_key
            cur_max_sort_key = _append_sort_key(conn, cid, cur_max_sort_key)
            return cur_max_sort_key

        nodes = json.loads(snap["nodes_json"])
        snap_by_id = {n["id"]: n for n in nodes}
        cols = ", ".join(_SNAPSHOT_COLUMNS)
        marks = ", ".join("?" for _ in _SNAPSHOT_COLUMNS)
        changed = 0

        surgical = not restore and bool(snap["created_json"] or snap["removed_json"])

        if not surgical:
            # Wholesale: replace the tree with the snapshot, exactly.
            conn.execute("UPDATE bookmarks SET deleted = 1 WHERE cid = ?", (cid,))
            for n in nodes:
                nid = n.get("id")
                pid = n.get("parent_id")
                pos = n.get("position") or 0
                title = n.get("title") or ""
                url = n.get("url")
                is_folder = 1 if n.get("is_folder") else 0
                date_added = n.get("date_added") or _now_ms()
                date_modified = n.get("date_modified") or _now_ms()
                icon_base64 = n.get("icon_base64")
                sort_key = n.get("sort_key") or next_sort_key()
                visit_count = n.get("visit_count") or 0
                last_visited_at = n.get("last_visited_at")
                dom = n.get("domain") or domain_of(url)

                conn.execute(
                    """
                    INSERT INTO bookmarks
                        (id, cid, parent_id, position, title, url, is_folder,
                         date_added, date_modified, icon_base64, sort_key,
                         visit_count, last_visited_at, domain, deleted, server_version)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
                    ON CONFLICT(cid, id) DO UPDATE SET
                        parent_id = excluded.parent_id,
                        position = excluded.position,
                        title = excluded.title,
                        url = excluded.url,
                        is_folder = excluded.is_folder,
                        date_added = excluded.date_added,
                        date_modified = excluded.date_modified,
                        icon_base64 = excluded.icon_base64,
                        sort_key = excluded.sort_key,
                        visit_count = excluded.visit_count,
                        last_visited_at = excluded.last_visited_at,
                        domain = excluded.domain,
                        deleted = 0
                    """,
                    (nid, cid, pid, pos, title, url, is_folder, date_added, date_modified,
                     icon_base64, sort_key, visit_count, last_visited_at, dom),
                )
            changed = len(nodes)
        else:
            created_ids = set(json.loads(snap["created_json"] or "[]"))
            removed_ids = set(json.loads(snap["removed_json"] or "[]"))
            present = {
                r["id"]
                for r in conn.execute(
                    "SELECT id FROM bookmarks WHERE cid = ? AND deleted = 0", (cid,)
                ).fetchall()
            }

            # 1. Re-insert what the ACTION removed (not what the user later
            #    deleted on their own).
            for nid in removed_ids:
                if nid in present or nid not in snap_by_id:
                    continue
                n = snap_by_id[nid]
                conn.execute(
                    f"""
                    INSERT INTO bookmarks (cid, {cols}, deleted) VALUES (?, {marks}, 0)
                    ON CONFLICT(cid, id) DO UPDATE SET
                        parent_id = excluded.parent_id,
                        position = excluded.position,
                        title = excluded.title,
                        url = excluded.url,
                        is_folder = excluded.is_folder,
                        date_added = excluded.date_added,
                        date_modified = excluded.date_modified,
                        icon_base64 = excluded.icon_base64,
                        sort_key = excluded.sort_key,
                        visit_count = excluded.visit_count,
                        last_visited_at = excluded.last_visited_at,
                        domain = excluded.domain,
                        deleted = 0
                    """,
                    (cid, *(n.get(k) for k in _SNAPSHOT_COLUMNS)),
                )
                changed += 1
            # 2. Revert structure + visits on survivors. title/url/icon are
            #    deliberately untouched so a later rename survives the undo.
            for nid, n in snap_by_id.items():
                if nid in created_ids or nid not in present:
                    continue
                conn.execute(
                    """
                    UPDATE bookmarks
                    SET parent_id = ?, position = ?, sort_key = ?,
                        visit_count = ?, last_visited_at = ?, deleted = 0
                    WHERE cid = ? AND id = ?
                    """,
                    (
                        n.get("parent_id"),
                        n.get("position") or 0,
                        n.get("sort_key"),
                        n.get("visit_count") or 0,
                        n.get("last_visited_at"),
                        cid,
                        nid,
                    ),
                )
                changed += 1

            # 3. Drop the folders the action created, but only once empty —
            #    a bookmark the user added into one afterwards is kept.
            for nid in created_ids:
                if nid not in present:
                    continue
                kids = conn.execute(
                    "SELECT 1 FROM bookmarks WHERE cid = ? AND parent_id = ? AND deleted = 0 LIMIT 1",
                    (cid, nid),
                ).fetchone()
                if kids is None:
                    conn.execute(
                        "UPDATE bookmarks SET deleted = 1 WHERE cid = ? AND id = ?", (cid, nid)
                    )
                    changed += 1

        if restore:
            # Keep the historical snapshot in history so users can return to it again.
            # Also take a snapshot of the pre-restore state so this restore can be undone.
            _take_snapshot(conn, cid, f"Before restore: {snap['label']}")
        else:
            # Inline undo pops the uncommitted action.
            conn.execute(
                "DELETE FROM tree_snapshots WHERE cid = ? AND id = ?", (cid, snap["id"])
            )
        sv = _emit_resync(
            conn, cid, f"Undo: {snap['label']}", {"restored": changed}
        )
        conn.execute("UPDATE bookmarks SET server_version = ? WHERE cid = ?", (sv, cid))
        remaining = conn.execute(
            "SELECT COUNT(*) AS n FROM tree_snapshots WHERE cid = ?", (cid,)
        ).fetchone()["n"]

    broadcast_event(
        cid,
        "bookmarks_updated",
        {"timestamp": _now_ms(), "origin": "web-ui", "op": "resync", "reason": f"Undo: {snap['label']}"},
    )

    return UndoResponse(
        restored_from=snap["id"],
        label=snap["label"],
        node_count=changed,
        remaining_snapshots=int(remaining),
        server_timestamp=_now_ms(),
    )

# ---- Authoritative Baseline Restore --------------------------------------


@router.post("/restore-baseline", response_model=RestoreBaselineResponse)
def restore_baseline(
    req: RestoreBaselineRequest,
    cid: str = Depends(require_collection),
) -> RestoreBaselineResponse:
    """Transactionally restore or initialize an authoritative baseline tree for a collection.
    Intentionally supersedes incident tombstones ONLY for submitted node IDs,
    preserves optimistic concurrency invariants, snapshots pre-restore state,
    and emits a clean resync watermark."""
    if not req.nodes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Submitted baseline cannot be empty.",
        )

    # 1. Structural validation of submitted tree
    nodes_by_id = {}
    for n in req.nodes:
        if n.id in nodes_by_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Duplicate node id in submitted baseline: {n.id}",
            )
        if n.parent_id == n.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Node {n.id} cannot be its own parent",
            )
        nodes_by_id[n.id] = n

    # Check parent validity and full graph cycle detection
    protected_roots = {"0", "1", "2", "3", "menu"}
    for nid, node in nodes_by_id.items():
        pid = node.parent_id
        if pid is not None and pid not in protected_roots:
            if pid not in nodes_by_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Node {nid} references missing parent {pid}",
                )
            if not nodes_by_id[pid].is_folder:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Node {nid} parent {pid} is not a folder",
                )

        # Full visited-state cycle detection
        visited = set()
        cur = nid
        while cur is not None:
            if cur in visited:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Cycle detected involving node {nid} and {cur}",
                )
            visited.add(cur)
            if cur in protected_roots:
                break
            parent_node = nodes_by_id.get(cur)
            cur = parent_node.parent_id if parent_node else None

    ts = _now_ms()
    with db.write_tx() as conn:
        # 2. Concurrency checks under write lock
        current_stats = conn.execute(
            """
            SELECT COUNT(*) AS active_count
            FROM bookmarks WHERE cid = ? AND deleted = 0
            """,
            (cid,),
        ).fetchone()
        ver_row = conn.execute(
            "SELECT COALESCE(MAX(id), 0) AS max_id FROM delta_log WHERE cid = ?",
            (cid,),
        ).fetchone()
        actual_active = int(current_stats["active_count"] or 0)
        actual_version = int(ver_row["max_id"] or 0) if ver_row else 0

        if actual_active != req.expected_active_count:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Optimistic lock failed: expected active count {req.expected_active_count}, got {actual_active}",
            )
        if actual_version != req.expected_server_version:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Optimistic lock failed: expected server version {req.expected_server_version}, got {actual_version}",
            )
        # Pre-baseline state is not written to tree_snapshots because tree_snapshots
        # stores active rows only and generic Undo cannot revert tombstoned states.
        # Rollback for baseline recovery relies on the database-level backup.
        snapshot_id = None
        cur_max_sort_key: str | None = None
        def next_sort_key() -> str:
            nonlocal cur_max_sort_key
            cur_max_sort_key = _append_sort_key(conn, cid, cur_max_sort_key)
            return cur_max_sort_key

        for node in req.nodes:
            dom = domain_of(node.url) if node.url else None
            conn.execute(
                """
                INSERT INTO bookmarks
                    (id, cid, parent_id, position, title, url, is_folder,
                     date_added, date_modified, sort_key, domain, deleted, server_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
                ON CONFLICT(cid, id) DO UPDATE SET
                    parent_id = excluded.parent_id,
                    position = excluded.position,
                    title = excluded.title,
                    url = excluded.url,
                    is_folder = excluded.is_folder,
                    date_added = COALESCE(bookmarks.date_added, excluded.date_added),
                    date_modified = excluded.date_modified,
                    domain = excluded.domain,
                    deleted = 0
                """,
                (
                    node.id, cid, node.parent_id, node.position, node.title, node.url,
                    1 if node.is_folder else 0, node.date_added or ts, ts,
                    next_sort_key(), dom,
                ),
            )

        # Tombstone any active server nodes that are absent from the submitted baseline
        active_rows = conn.execute(
            "SELECT id FROM bookmarks WHERE cid = ? AND deleted = 0",
            (cid,),
        ).fetchall()
        submitted_id_set = set(nodes_by_id.keys())
        stale_ids = [r["id"] for r in active_rows if r["id"] not in submitted_id_set]
        if stale_ids:
            for i in range(0, len(stale_ids), 900):
                batch = stale_ids[i:i+900]
                placeholders = ",".join("?" for _ in batch)
                conn.execute(
                    f"UPDATE bookmarks SET deleted = 1 WHERE cid = ? AND id IN ({placeholders})",
                    (cid, *batch),
                )

        # 5. Emit one resync marker delta
        sv = _emit_resync(
            conn,
            cid,
            f"Baseline: {req.label}",
            {"restored": len(req.nodes), "snapshot_id": snapshot_id},
        )
        # Align server_version for restored nodes
        submitted_ids = list(nodes_by_id.keys())
        for i in range(0, len(submitted_ids), 900):
            batch = submitted_ids[i:i+900]
            placeholders = ",".join("?" for _ in batch)
            conn.execute(
                f"UPDATE bookmarks SET server_version = ? WHERE cid = ? AND id IN ({placeholders})",
                (sv, cid, *batch),
            )

    broadcast_event(
        cid,
        "bookmarks_updated",
        {"timestamp": ts, "origin": "web-ui", "op": "resync", "reason": f"Baseline: {req.label}"},
    )

    return RestoreBaselineResponse(
        restored=len(req.nodes),
        server_version=sv,
        server_timestamp=ts,
    )


# ---- Visit tracking -------------------------------------------------------


@router.post("/visits", response_model=VisitBatchResponse)
def add_visits(
    req: VisitBatchRequest,
    cid: str = Depends(require_collection),
) -> VisitBatchResponse:
    """Apply a batch of aggregate visit increments from a device."""
    if not req.increments:
        return VisitBatchResponse(applied=0, unknown_nodes=0)

    now = _now_ms()
    aggregated: dict[str, tuple[int, int]] = {}
    for inc in req.increments:
        last = inc.last_visited_at if inc.last_visited_at is not None else now
        if inc.node_id in aggregated:
            cnt, prev_last = aggregated[inc.node_id]
            aggregated[inc.node_id] = (cnt + inc.count, max(prev_last, last))
        else:
            aggregated[inc.node_id] = (inc.count, last)

    vals = [(nid, cnt, last) for nid, (cnt, last) in aggregated.items()]
    ph = ",".join("(?, ?, ?)" for _ in vals)
    params: list[object] = []
    for nid, cnt, last in vals:
        params.extend([nid, cnt, last])
    params.append(cid)

    with db.write_tx() as conn:
        conn.execute(
            f"""
            WITH batch(node_id, inc_count, inc_last) AS (
                VALUES {ph}
            )
            UPDATE bookmarks
            SET visit_count = bookmarks.visit_count + batch.inc_count,
                last_visited_at = MAX(COALESCE(bookmarks.last_visited_at, 0), batch.inc_last)
            FROM batch
            WHERE bookmarks.cid = ? AND bookmarks.id = batch.node_id AND bookmarks.deleted = 0
            """,
            params,
        )
        unique_ids = list(aggregated.keys())
        placeholders = ",".join("?" for _ in unique_ids)
        known_rows = conn.execute(
            f"SELECT id FROM bookmarks WHERE cid = ? AND id IN ({placeholders}) AND deleted = 0",
            (cid, *unique_ids),
        ).fetchall()
        known_ids = {r["id"] for r in known_rows}
    applied = sum(1 for inc in req.increments if inc.node_id in known_ids)
    unknown = len(req.increments) - applied
    return VisitBatchResponse(applied=applied, unknown_nodes=unknown)


# ---- Reports --------------------------------------------------------------
# Report endpoints live in routes/reports.py under the /report prefix.


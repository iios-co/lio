"""Tab session routes: push snapshot, list device sessions, adopt (consume)."""

from __future__ import annotations

import json
import time

from fastapi import APIRouter, Depends, HTTPException, Query, status

from .. import db
from ..auth import require_collection
from ..events import broadcast_event
from ..models import (
    TabAdoptResponse,
    TabHistoryResponse,
    TabHistorySummary,
    TabItem,
    TabSessionIn,
    TabSessionsResponse,
    TabSessionSummary,
)

router = APIRouter(prefix="/api/v1/collections/{token}/tabs", tags=["tabs"])

# Two snapshots are "the same session" when their URL sets overlap at least this
# much (Jaccard). Keyed on similarity rather than tab-count difference: a session
# losing two tabs is still that session, and the old `<=1` count rule inserted
# near-identical rows that spent the retention cap on redundancy.
_ARCHIVE_DISTINCT_RATIO = 0.9


def _now_ms() -> int:
    return int(time.time() * 1000)


def _count_tabs(session_json: str) -> int:
    """Best-effort tab count for the popup summary. Tolerates either a list of
    windows (each with a ``tabs`` array) or a flat list of tabs."""
    try:
        data = json.loads(session_json)
    except (ValueError, TypeError):
        return 0
    if isinstance(data, dict):
        data = data.get("windows", data.get("tabs", []))
    if not isinstance(data, list):
        return 0
    total = 0
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("tabs"), list):
            total += len(item["tabs"])
        else:
            total += 1
    return total


def _extract_tabs(session_json: str) -> list[TabItem]:
    """Flatten a device session blob into a list of {title, url} tab items.
    Tolerates a dict of windows, a list of windows each with a ``tabs`` array,
    or a flat list of tab objects."""
    try:
        data = json.loads(session_json)
    except (ValueError, TypeError):
        return []
    if isinstance(data, dict):
        data = data.get("windows", data.get("tabs", []))
    if not isinstance(data, list):
        return []

    def as_item(t: object) -> TabItem:
        if isinstance(t, dict):
            return TabItem(title=str(t.get("title") or ""), url=t.get("url"))
        return TabItem(title=str(t), url=None)

    out: list[TabItem] = []
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("tabs"), list):
            out.extend(as_item(t) for t in item["tabs"])
        else:
            out.append(as_item(item))
    return out


def _session_url_set(session_json: str) -> set[str]:
    tabs = _extract_tabs(session_json)
    return {t.url for t in tabs if t.url}




@router.put("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def put_session(
    device_id: str,
    body: TabSessionIn,
    cid: str = Depends(require_collection),
) -> None:
    """Continuous snapshot upsert for one device."""
    updated_at = body.updated_at if body.updated_at is not None else _now_ms()
    tab_count = _count_tabs(body.session_json)
    with db.write_tx() as conn:
        existing = conn.execute(
            "SELECT device_name, session_json, updated_at, tab_count FROM device_tabs WHERE cid = ? AND device_id = ?",
            (cid, device_id),
        ).fetchone()

        # If identical snapshot and device name on a live update (not a session boundary),
        # skip rewriting updated_at and skip broadcasting an event.
        if (
            existing
            and not body.session_boundary
            and existing["device_name"] == body.device_name
            and existing["session_json"] == body.session_json
        ):
            return

        # ARCHIVE ONLY AT A SESSION BOUNDARY.
        #
        # A past session is worth restoring because the session ENDED -- the
        # browser was closed, the machine restarted, or you are on another device.
        # It is never worth archiving because a tab closed.
        #
        # This used to trigger on `tab_count < existing["tab_count"]`, inferring a
        # boundary from a falling tab count. Normal browsing does that constantly,
        # so closing two tabs minted a "past session" (observed live: 8 of 24
        # adjacent rows >=85% identical, four inside ~10 seconds), and that churn
        # evicted genuinely distinct older sessions through the 25-row cap.
        #
        # Now the CLIENT states the boundary explicitly: it sets
        # `session_boundary` on its first push after browser startup or an
        # extension install/update. Everything else is a live snapshot upsert.
        if body.session_boundary and existing and existing["tab_count"] >= 2:
            existing_urls = _session_url_set(existing["session_json"])
            if existing_urls:
                latest = conn.execute(
                    """
                    SELECT id, session_json, created_at, tab_count
                    FROM tab_session_history
                    WHERE cid = ? AND device_id = ?
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (cid, device_id),
                ).fetchone()

                should_insert = True
                if latest:
                    latest_urls = _session_url_set(latest["session_json"])
                    # Similarity, not count difference. The old guard skipped only
                    # when the counts differed by <=1, so a two-tab difference
                    # inserted a near-identical row (observed live: 0.947 overlap,
                    # 11 seconds apart, both shown as "Today at 1:52 PM").
                    union = existing_urls | latest_urls
                    overlap = len(existing_urls & latest_urls) / len(union) if union else 1.0
                    if overlap >= _ARCHIVE_DISTINCT_RATIO:
                        should_insert = False
                        # Keep the fuller snapshot: restoring the larger set of
                        # tabs loses nothing.
                        if existing["tab_count"] > latest["tab_count"]:
                            conn.execute(
                                """
                                UPDATE tab_session_history
                                SET session_json = ?, tab_count = ?, created_at = ?
                                WHERE id = ?
                                """,
                                (existing["session_json"], existing["tab_count"], existing["updated_at"], latest["id"]),
                            )

                if should_insert:
                    conn.execute(
                        """
                        INSERT INTO tab_session_history (cid, device_id, device_name, session_json, tab_count, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            cid,
                            device_id,
                            existing["device_name"],
                            existing["session_json"],
                            existing["tab_count"],
                            existing["updated_at"],
                        ),
                    )
                    conn.execute(
                        """
                        DELETE FROM tab_session_history
                        WHERE cid = ? AND device_id = ? AND id NOT IN (
                            SELECT id FROM tab_session_history
                            WHERE cid = ? AND device_id = ?
                            ORDER BY created_at DESC LIMIT 25
                        )
                        """,
                        (cid, device_id, cid, device_id),
                    )
        conn.execute(
            """
            INSERT INTO device_tabs (cid, device_id, device_name, session_json, updated_at, tab_count)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(cid, device_id) DO UPDATE SET
                device_name  = excluded.device_name,
                session_json = excluded.session_json,
                updated_at   = excluded.updated_at,
                tab_count    = excluded.tab_count
            """,
            (cid, device_id, body.device_name, body.session_json, updated_at, tab_count),
        )

    broadcast_event(
        cid,
        "tabs_updated",
        {"timestamp": updated_at, "origin": device_id, "device_id": device_id},
        exclude_device_id=device_id,
    )


@router.get("", response_model=TabSessionsResponse)
def list_sessions(
    cid: str = Depends(require_collection),
    device_id: str | None = Query(None, description="Optional device_id to fetch only one session."),
) -> TabSessionsResponse:
    """List device sessions in the collection for the popup picker."""
    conn = db.get_conn()
    if device_id:
        rows = conn.execute(
            """
            SELECT device_id, device_name, session_json, updated_at, tab_count
            FROM device_tabs WHERE cid = ? AND device_id = ?
            """,
            (cid, device_id),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT device_id, device_name, session_json, updated_at, tab_count
            FROM device_tabs WHERE cid = ?
            ORDER BY updated_at DESC, device_id ASC
            """,
            (cid,),
        ).fetchall()
    sessions = [
        TabSessionSummary(
            device_id=r["device_id"],
            device_name=r["device_name"],
            updated_at=r["updated_at"],
            tab_count=r["tab_count"] if r["tab_count"] is not None else _count_tabs(r["session_json"]),
            tabs=_extract_tabs(r["session_json"]),
        )
        for r in rows
    ]
    return TabSessionsResponse(sessions=sessions)


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(
    device_id: str,
    cid: str = Depends(require_collection),
) -> None:
    """Discard a device's tab session without opening it. Unlike ``adopt`` this
    returns nothing — it is the 'throw it away' counterpart."""
    with db.write_tx() as conn:
        cur = conn.execute(
            "DELETE FROM device_tabs WHERE cid = ? AND device_id = ?",
            (cid, device_id),
        )
    if cur.rowcount == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No session for that device in this collection.",
        )

    broadcast_event(
        cid,
        "tabs_updated",
        {"timestamp": _now_ms(), "origin": "web-ui", "device_id": device_id},
    )


@router.post("/{device_id}/adopt", response_model=TabAdoptResponse)
def adopt_session(
    device_id: str,
    cid: str = Depends(require_collection),
) -> TabAdoptResponse:
    """Return a device's session and consume (delete) it in one transaction, so
    the same snapshot cannot be adopted twice."""
    with db.write_tx() as conn:
        row = conn.execute(
            """
            SELECT device_id, device_name, session_json, updated_at
            FROM device_tabs WHERE cid = ? AND device_id = ?
            """,
            (cid, device_id),
        ).fetchone()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No session for that device in this collection.",
            )
        conn.execute(
            "DELETE FROM device_tabs WHERE cid = ? AND device_id = ?",
            (cid, device_id),
        )

    broadcast_event(
        cid,
        "tabs_updated",
        {"timestamp": _now_ms(), "origin": "web-ui", "device_id": device_id},
    )

    return TabAdoptResponse(
        device_id=row["device_id"],
        device_name=row["device_name"],
        session_json=row["session_json"],
        updated_at=row["updated_at"],
    )


@router.get("/history", response_model=TabHistoryResponse)
def list_tab_history(
    cid: str = Depends(require_collection),
    device_id: str | None = Query(None, description="Filter history to a specific device."),
    limit: int = Query(50, ge=1, le=200),
) -> TabHistoryResponse:
    """List archived past tab sessions across devices."""
    conn = db.get_conn()
    if device_id:
        rows = conn.execute(
            """
            SELECT id, device_id, device_name, session_json, tab_count, created_at
            FROM tab_session_history WHERE cid = ? AND device_id = ?
            ORDER BY created_at DESC LIMIT ?
            """,
            (cid, device_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT id, device_id, device_name, session_json, tab_count, created_at
            FROM tab_session_history WHERE cid = ?
            ORDER BY created_at DESC LIMIT ?
            """,
            (cid, limit),
        ).fetchall()
    history = [
        TabHistorySummary(
            id=r["id"],
            device_id=r["device_id"],
            device_name=r["device_name"],
            created_at=r["created_at"],
            tab_count=r["tab_count"],
            tabs=_extract_tabs(r["session_json"]),
        )
        for r in rows
    ]
    return TabHistoryResponse(history=history)


@router.post("/history/{history_id}/restore", response_model=TabAdoptResponse)
def restore_history_session(
    history_id: int,
    cid: str = Depends(require_collection),
) -> TabAdoptResponse:
    """Retrieve an archived tab session to restore it into the browser."""
    conn = db.get_conn()
    row = conn.execute(
        "SELECT id, device_id, device_name, session_json, created_at FROM tab_session_history WHERE cid = ? AND id = ?",
        (cid, history_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such archived session.")
    return TabAdoptResponse(
        device_id=row["device_id"],
        device_name=row["device_name"],
        session_json=row["session_json"],
        updated_at=row["created_at"],
    )


@router.delete("/history/{history_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_history_session(
    history_id: int,
    cid: str = Depends(require_collection),
) -> None:
    """Discard an archived session."""
    with db.write_tx() as conn:
        cur = conn.execute("DELETE FROM tab_session_history WHERE cid = ? AND id = ?", (cid, history_id))
    if cur.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such archived session.")

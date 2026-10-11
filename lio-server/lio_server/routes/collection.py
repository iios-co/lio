"""Collection identity: what does this token actually point at?

The extension needs more than a 200 to trust its configuration — it needs the
collection's real name and size. Without this a device could only test
reachability, which is how a stale token was able to report a healthy sync.
"""

from __future__ import annotations

import json
import time
from fastapi import APIRouter, Depends, Path, Query, WebSocket, WebSocketDisconnect, status

from .. import db
from ..auth import require_collection, resolve_cid
from ..config import active_settings
from ..events import manager
from ..models import CollectionInfoResponse

router = APIRouter(prefix="/api/v1/collections/{token}", tags=["collection"])


@router.websocket("/ws")
async def collection_websocket(
    websocket: WebSocket,
    token: str = Path(...),
    device_id: str | None = Query(None),
) -> None:
    """Real-time push WebSocket for collection changes."""
    settings = active_settings()
    if settings.allowed_tokens and token not in settings.allowed_tokens:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Token not permitted")
        return
    cid = resolve_cid(token)
    if cid is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Invalid token")
        return

    await websocket.accept()
    await manager.connect(websocket, cid, device_id)
    try:
        await websocket.send_json({
            "event": "connected",
            "cid": cid,
            "device_id": device_id,
            "server_timestamp": int(time.time() * 1000),
        })
        while True:
            text = await websocket.receive_text()
            try:
                msg = json.loads(text)
            except Exception:
                continue
            if isinstance(msg, dict) and msg.get("action") == "ping":
                await websocket.send_json({
                    "event": "pong",
                    "timestamp": int(time.time() * 1000),
                })
    except WebSocketDisconnect:
        pass
    except Exception as e:
        import logging
        logging.getLogger("lio_server.collection").warning("WebSocket error: %s", e)
    finally:
        await manager.disconnect(websocket, cid)


@router.get("/info", response_model=CollectionInfoResponse)
def collection_info(
    cid: str = Depends(require_collection),
    device_id: str | None = Query(
        None,
        description="Exclude this device's own writes from last_change_at, so a "
        "client can tell whether the OTHER side changed more recently than it did.",
    ),
) -> CollectionInfoResponse:
    """Identity and size of the collection this token resolves to. A 404 from
    the auth dependency means the token is not recognised by this server.

    ``last_change_at`` is what lets a client apply last-write-wins to the TREE as a
    whole rather than only per node: if the server changed more recently than the
    client did, the client reconciles to the server; otherwise it sends its own
    state. Without it, a client comparing trees can see a difference but has no
    basis for deciding which side is authoritative."""
    conn = db.get_conn()
    row = conn.execute(
        """
        SELECT c.id, c.name,
               (SELECT COUNT(*) FROM bookmarks b
                 WHERE b.cid = c.id AND b.is_folder = 0 AND b.deleted = 0) AS bookmark_count,
               (SELECT COUNT(*) FROM bookmarks b
                 WHERE b.cid = c.id AND b.is_folder = 1 AND b.deleted = 0) AS folder_count,
               (SELECT COUNT(*) FROM device_tabs d WHERE d.cid = c.id) AS device_count
        FROM collections c WHERE c.id = ?
        """,
        (cid,),
    ).fetchone()

    if device_id:
        last = conn.execute(
            "SELECT MAX(timestamp) AS mx FROM delta_log WHERE cid = ? "
            "AND (origin IS NULL OR origin != ?)",
            (cid, device_id),
        ).fetchone()
    else:
        last = conn.execute(
            "SELECT MAX(timestamp) AS mx FROM delta_log WHERE cid = ?", (cid,)
        ).fetchone()

    return CollectionInfoResponse(
        last_change_at=(last["mx"] if last else None),
        id=row["id"],
        name=row["name"],
        bookmark_count=row["bookmark_count"] or 0,
        folder_count=row["folder_count"] or 0,
        device_count=row["device_count"] or 0,
    )

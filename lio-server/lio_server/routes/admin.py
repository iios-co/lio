"""Admin console API: server-wide management of collections and their tokens.

Gated by a session cookie issued after checking LIO_ADMIN_PASSWORD. The admin is
the central authority: it creates collections (which mints their token), lists
all of them with stats, rotates a token without losing data (thanks to the
stable collection id), and deletes collections.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status

from .. import db
from ..auth import (
    ADMIN_COOKIE,
    admin_is_configured,
    check_admin_credentials,
    issue_admin_cookie,
    new_collection_id,
    new_token,
    require_admin,
    revoke_admin_session,
    setup_first_account,
    store_account,
    stored_username,
    _verify as _verify_cookie,
)
from ..config import active_settings
from .tabs import _count_tabs
from ..models import (
    AdminLoginRequest,
    AdminSetupRequest,
    AdminStateResponse,
    CollectionListResponse,
    CollectionSummary,
    CreateCollectionRequest,
    CreateCollectionResponse,
    RenameCollectionRequest,
    RenameCollectionResponse,
    RotateTokenResponse,
)

router = APIRouter(prefix="/admin", tags=["admin"])


def _now_ms() -> int:
    return int(time.time() * 1000)


@router.get("/state", response_model=AdminStateResponse)
def admin_state(lio_admin: str | None = Cookie(default=None)) -> AdminStateResponse:
    """Public: tells the UI whether first-run setup is needed and whether the
    caller is already authenticated. Never leaks the password or its hash."""
    settings = active_settings()
    configured = admin_is_configured(settings)
    authed = bool(
        configured and lio_admin and _verify_cookie(lio_admin, settings.session_secret)
    )
    return AdminStateResponse(
        setup_needed=not configured,
        authenticated=authed,
        username=stored_username() if authed else None,
    )


@router.post("/setup")
def setup(body: AdminSetupRequest, response: Response) -> dict[str, bool]:
    """First-run: create the single admin account. Refused once one exists."""
    settings = active_settings()
    setup_first_account(body.username.strip(), body.password, settings)
    response.set_cookie(
        ADMIN_COOKIE,
        issue_admin_cookie(settings),
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        max_age=7 * 24 * 3600,
    )
    return {"ok": True}


@router.post("/login")
def login(body: AdminLoginRequest, response: Response) -> dict[str, bool]:
    settings = active_settings()
    if not admin_is_configured(settings):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No admin account set. Complete first-run setup.",
        )
    if not check_admin_credentials(body.username.strip(), body.password, settings):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )
    response.set_cookie(
        ADMIN_COOKIE,
        issue_admin_cookie(settings),
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        max_age=7 * 24 * 3600,
    )
    return {"ok": True}


@router.post("/logout")
def logout(response: Response, _: None = Depends(require_admin)) -> dict[str, bool]:
    revoke_admin_session()
    response.delete_cookie(ADMIN_COOKIE)
    return {"ok": True}


@router.get("/session")
def session(_: None = Depends(require_admin)) -> dict[str, bool]:
    """Returns 200 if the caller has a valid admin session, else 401."""
    return {"ok": True}


@router.get("/collections", response_model=CollectionListResponse)
def list_collections(_: None = Depends(require_admin)) -> CollectionListResponse:
    conn = db.get_conn()
    rows = conn.execute(
        """
        SELECT c.id, c.name, c.token, c.created_at, c.token_rotated_at,
               (SELECT COUNT(*) FROM bookmarks b WHERE b.cid = c.id AND b.is_folder = 0 AND b.deleted = 0)
                   AS bookmark_count,
               (SELECT COUNT(*) FROM device_tabs d WHERE d.cid = c.id) AS device_count,
               (SELECT MAX(ts) FROM (
                   SELECT MAX(timestamp) AS ts FROM delta_log dl WHERE dl.cid = c.id
                   UNION ALL
                   SELECT MAX(updated_at) AS ts FROM device_tabs dt WHERE dt.cid = c.id
               )) AS last_activity
        FROM collections c
        ORDER BY c.created_at DESC
        """
    ).fetchall()

    # Total captured tabs per collection (read from aggregated tab_count column).
    tab_totals = {
        r["cid"]: int(r["total"] or 0)
        for r in conn.execute(
            "SELECT cid, SUM(COALESCE(tab_count, 0)) AS total FROM device_tabs GROUP BY cid"
        ).fetchall()
    }
    return CollectionListResponse(
        collections=[
            CollectionSummary(
                id=r["id"],
                name=r["name"],
                token=r["token"],
                created_at=str(r["created_at"]) if r["created_at"] is not None else None,
                token_rotated_at=r["token_rotated_at"],
                bookmark_count=r["bookmark_count"] or 0,
                device_count=r["device_count"] or 0,
                tab_count=tab_totals.get(r["id"], 0),
                last_activity=r["last_activity"],
            )
            for r in rows
        ]
    )


@router.post("/collections", response_model=CreateCollectionResponse)
def create_collection(
    body: CreateCollectionRequest, _: None = Depends(require_admin)
) -> CreateCollectionResponse:
    """Create a collection and mint its token."""
    cid = new_collection_id()
    token = new_token()
    with db.write_tx() as conn:
        conn.execute(
            "INSERT INTO collections (id, token, name) VALUES (?, ?, ?)",
            (cid, token, body.name.strip() or "Untitled"),
        )
    return CreateCollectionResponse(id=cid, name=body.name.strip() or "Untitled", token=token)


@router.patch("/collections/{cid}", response_model=RenameCollectionResponse)
def rename_collection(
    cid: str, body: RenameCollectionRequest, _: None = Depends(require_admin)
) -> RenameCollectionResponse:
    """Rename a collection in place (inline edit from the dashboard card)."""
    name = body.name.strip() or "Untitled"
    with db.write_tx() as conn:
        cur = conn.execute(
            "UPDATE collections SET name = ? WHERE id = ?",
            (name, cid),
        )
    if cur.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such collection.")
    return RenameCollectionResponse(id=cid, name=name)


@router.post("/collections/{cid}/rotate", response_model=RotateTokenResponse)
def rotate_token(cid: str, _: None = Depends(require_admin)) -> RotateTokenResponse:
    """Issue a new token for the collection. Data is untouched (keyed on cid);
    devices must be updated with the new token to keep syncing."""
    token = new_token()
    with db.write_tx() as conn:
        cur = conn.execute(
            "UPDATE collections SET token = ?, token_rotated_at = ? WHERE id = ?",
            (token, _now_ms(), cid),
        )
    if cur.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such collection.")
    return RotateTokenResponse(id=cid, token=token)


@router.delete("/collections/{cid}")
def delete_collection(cid: str, _: None = Depends(require_admin)) -> dict[str, bool]:
    with db.write_tx() as conn:
        cur = conn.execute("DELETE FROM collections WHERE id = ?", (cid,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such collection.")
    return {"ok": True}

"""Reporting routes: usage (sortable), dead links, and liveness checks."""

from __future__ import annotations

import ipaddress
import socket
import time
import urllib.error
import urllib.request
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
import ssl
from .. import db
from ..auth import require_collection
from ..config import active_settings
from ..models import (
    CheckResponse,
    DeadLinkReportResponse,
    DeadLinkRow,
    UsageReportResponse,
    UsageRow,
)

router = APIRouter(prefix="/api/v1/collections/{token}/report", tags=["reports"])

# Whitelist of sortable columns → real column names (prevents SQL injection via
# a user-supplied sort field).
_SORT_COLUMNS = {
    "custom": "sort_key",
    "name": "title",
    "domain": "domain",
    "visits": "visit_count",
    "date": "date_added",
    "last_visited": "last_visited_at",
}


def _now_ms() -> int:
    return int(time.time() * 1000)


@router.get("/usage", response_model=UsageReportResponse)
def usage(
    cid: str = Depends(require_collection),
    sort: str = Query("visits", description="custom|name|domain|visits|date|last_visited"),
    dir: str = Query("desc", description="asc|desc"),
    q: str | None = Query(None, description="Case-insensitive title/url substring."),
    domain: str | None = Query(None, description="Filter to one domain."),
    include_folders: bool = Query(False),
    limit: int | None = Query(None, ge=1, le=50_000, description="Max links to return."),
    offset: int = Query(0, ge=0, description="Pagination offset."),
) -> UsageReportResponse:
    """Links ordered by the chosen column, joined with liveness status."""
    conn = db.get_conn()
    col = _SORT_COLUMNS.get(sort, "visit_count")
    direction = "ASC" if dir.lower() == "asc" else "DESC"

    where = ["b.cid = ?", "b.deleted = 0"]
    params: list[object] = [cid]
    if not include_folders:
        where.append("b.is_folder = 0")
    if q:
        where.append("(b.title LIKE ? OR b.url LIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    if domain:
        where.append("b.domain = ?")
        params.append(domain)

    sql = f"""
        SELECT b.id, b.parent_id, b.position,
               b.title, b.url, b.domain, b.visit_count, b.last_visited_at, b.date_added,
               b.is_folder, b.sort_key, s.ok AS ok, s.http_status AS http_status,
               s.checked_at AS checked_at, s.error AS status_error
        FROM bookmarks b
        LEFT JOIN link_status s ON s.cid = b.cid AND s.node_id = b.id
        WHERE {" AND ".join(where)}
        ORDER BY {col} {direction}, b.title ASC
    """
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        params += [limit, offset]
    rows = conn.execute(sql, params).fetchall()
    out = [
        UsageRow(
            node_id=r["id"],
            parent_id=r["parent_id"],
            position=r["position"] or 0,
            title=r["title"],
            url=r["url"],
            domain=r["domain"],
            visit_count=r["visit_count"] or 0,
            last_visited_at=r["last_visited_at"],
            date_added=r["date_added"],
            is_folder=bool(r["is_folder"]),
            sort_key=r["sort_key"],
            ok=None if r["ok"] is None else bool(r["ok"]),
            http_status=r["http_status"],
            checked_at=r["checked_at"],
            status_error=r["status_error"],
        )
        for r in rows
    ]
    return UsageReportResponse(rows=out)


@router.get("/dead", response_model=DeadLinkReportResponse)
def dead_links(cid: str = Depends(require_collection)) -> DeadLinkReportResponse:
    """Links whose last liveness check failed."""
    conn = db.get_conn()
    rows = conn.execute(
        """
        SELECT b.id, b.title, b.url, s.http_status, s.error, s.checked_at
        FROM link_status s
        JOIN bookmarks b ON b.cid = s.cid AND b.id = s.node_id
        WHERE s.cid = ? AND s.ok = 0 AND b.deleted = 0
        ORDER BY s.checked_at DESC
        """,
        (cid,),
    ).fetchall()
    return DeadLinkReportResponse(
        rows=[
            DeadLinkRow(
                node_id=r["id"],
                title=r["title"],
                url=r["url"],
                http_status=r["http_status"],
                error=r["error"],
                checked_at=r["checked_at"],
            )
            for r in rows
        ]
    )


def _classify_host(url: str) -> str:
    """Classify a URL's target for the liveness sweep. Returns one of:

      "public"        — a normal internet host; safe to probe.
      "lan"           — RFC1918 / IPv6-ULA private space (e.g. 10.0.5.10,
                        192.168.1.1). A self-hosted bookmark set is full of these;
                        probing them is the whole point, but only with the
                        operator's say-so (deadlink_allow_private).
      "always_block"  — loopback, link-local (which includes the cloud metadata
                        address 169.254.169.254), reserved, multicast, or the
                        unspecified address. NEVER probed, regardless of any
                        setting: that is what stops this authenticated route from
                        becoming an SSRF oracle against the host or its cloud.

    A hostname that resolves to several addresses is classified by its WORST
    address (DNS-rebinding safe): if any resolved IP is always_block, the whole
    URL is.
    """
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in ("http", "https"):
        return "always_block"
    host = parsed.hostname
    if not host:
        return "always_block"
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return "public"  # DNS failure is handled as a dead link, not blocked here

    worst = "public"
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if (
            ip.is_loopback or ip.is_link_local or ip.is_reserved
            or ip.is_multicast or ip.is_unspecified
        ):
            return "always_block"  # worst possible: stop now
        if ip.is_private:
            worst = "lan"
    return worst


_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


def _has_internet_connectivity() -> bool:
    """Quick DNS canary to check if the host server can reach the internet."""
    try:
        socket.getaddrinfo("1.1.1.1", 53, socket.AF_INET)
        return True
    except Exception:
        return False


def _probe(
    url: str,
    timeout: float,
    is_lan: bool = False,
    allow_private: bool = False,
    verify_ssl: bool = True,
) -> tuple[int | None, bool, str | None]:
    """HEAD (falling back to GET) a URL, checking each redirect hop against SSRF guards.
    Returns (status, ok, error)."""
    headers = {
        "User-Agent": _BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, hdrs, newurl):
            return None

    context = ssl.create_default_context() if verify_ssl else ssl._create_unverified_context()
    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=context))

    for method in ("HEAD", "GET"):
        current_url = url
        hops = 0
        while hops < 10:
            cls = _classify_host(current_url)
            if cls == "always_block":
                return None, False, _BLOCKED_REASON
            if cls == "lan" and not allow_private:
                return None, False, _LAN_REASON

            req = urllib.request.Request(current_url, method=method, headers=headers)
            try:
                with opener.open(req, timeout=timeout) as resp:
                    code = resp.getcode()
                    return code, 200 <= code < 400, None
            except urllib.error.HTTPError as e:
                if e.code in (301, 302, 303, 307, 308):
                    loc = e.headers.get("Location")
                    if not loc:
                        return e.code, True, None
                    current_url = urllib.parse.urljoin(current_url, loc)
                    hops += 1
                    continue
                if e.code in (401, 403):
                    return e.code, True, None
                if method == "GET":
                    return e.code, 200 <= e.code < 400, f"HTTP {e.code}"
                break
            except urllib.error.URLError as e:
                if method == "GET":
                    return None, False, str(e.reason)
                break
            except (TimeoutError, socket.timeout):
                if method == "GET":
                    return None, False, "timeout"
                break
            except Exception as e:
                if method == "GET":
                    return None, False, str(e) or type(e).__name__
                break
    return None, False, "unreachable"


_BLOCKED_REASON = "Blocked host (loopback, link-local or reserved) — never probed."
_LAN_REASON = "LAN host — not probed. Set LIO_DEADLINK_ALLOW_PRIVATE=1 to check it."


@router.post("/check")
def check(
    cid: str = Depends(require_collection),
    timeout: float = Query(5.0, ge=1.0, le=30.0),
    stream: bool = Query(False),
):
    """Run a liveness sweep over the collection's links.

    Manual and authenticated only (the console's "Check links" button) — never
    background polling. When stream=true, yields Server-Sent Events with progress
    and individual link results. When stream=false, returns CheckResponse JSON.
    """
    settings = active_settings()
    conn = db.get_conn()
    rows = conn.execute(
        "SELECT id, url, title FROM bookmarks WHERE cid = ? AND is_folder = 0 AND url IS NOT NULL AND deleted = 0",
        (cid,),
    ).fetchall()

    if not stream:
        if not settings.deadlink_check_enabled:
            return CheckResponse(
                checked=0, ok=0, dead=0, skipped=len(rows), disabled=True,
                skip_reason="Liveness checking is off on this server (LIO_DEADLINK_CHECK=0).",
            )

        allow_private = getattr(settings, "deadlink_allow_private", False)

        def work(item):
            node_id, url = item["id"], item["url"]
            cls = _classify_host(url)
            if cls == "always_block":
                return node_id, "skipped", None, _BLOCKED_REASON
            if cls == "lan" and not allow_private:
                return node_id, "skipped", None, _LAN_REASON
            status_code, is_ok, err = _probe(
                url, timeout, is_lan=(cls == "lan"),
                allow_private=allow_private,
                verify_ssl=getattr(settings, "deadlink_verify_ssl", True),
            )
            return node_id, ("ok" if is_ok else "dead"), status_code, err

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(work, rows))

        checked = ok = dead = skipped = 0
        skipped_lan = skipped_blocked = 0
        now = _now_ms()
        with db.write_tx() as conn:
            for node_id, verdict, status_code, err in results:
                if verdict == "skipped":
                    skipped += 1
                    if err == _BLOCKED_REASON:
                        skipped_blocked += 1
                    else:
                        skipped_lan += 1
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO link_status
                            (cid, node_id, http_status, ok, checked_at, error)
                        VALUES (?, ?, NULL, NULL, ?, ?)
                        """,
                        (cid, node_id, now, err),
                    )
                    continue
                checked += 1
                is_ok = verdict == "ok"
                ok += 1 if is_ok else 0
                dead += 0 if is_ok else 1
                conn.execute(
                    """
                    INSERT INTO link_status (cid, node_id, http_status, ok, checked_at, error)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(cid, node_id) DO UPDATE SET
                        http_status = excluded.http_status,
                        ok          = excluded.ok,
                        checked_at  = excluded.checked_at,
                        error       = excluded.error
                    """,
                    (cid, node_id, status_code, 1 if is_ok else 0, now, err),
                )


        reason_parts = []
        if skipped_blocked:
            reason_parts.append(f"{skipped_blocked} blocked (loopback/link-local)")
        if skipped_lan:
            reason_parts.append(
                f"{skipped_lan} LAN host(s) not probed — set LIO_DEADLINK_ALLOW_PRIVATE=1 to include them"
            )
        return CheckResponse(
            checked=checked, ok=ok, dead=dead, skipped=skipped,
            skip_reason="; ".join(reason_parts) if reason_parts else None,
        )

    # Streaming mode (SSE)
    def event_stream():
        items = [{"id": r["id"], "url": r["url"], "title": r["title"]} for r in rows]
        total = len(items)

        yield f"data: {json.dumps({'type': 'start', 'total': total})}\n\n"

        if not settings.deadlink_check_enabled:
            yield f"data: {json.dumps({'type': 'done', 'checked': 0, 'ok': 0, 'dead': 0, 'skipped': total, 'disabled': True, 'skip_reason': 'Liveness checking is off on this server (LIO_DEADLINK_CHECK=0).'})}\n\n"
            return

        allow_private = getattr(settings, "deadlink_allow_private", False)

        def probe_item(item):
            node_id, url, title = item["id"], item["url"], item["title"]
            cls = _classify_host(url)
            if cls == "always_block":
                return node_id, url, title, "skipped", None, _BLOCKED_REASON
            if cls == "lan" and not allow_private:
                return node_id, url, title, "skipped", None, _LAN_REASON
            status_code, is_ok, err = _probe(
                url, timeout, is_lan=(cls == "lan"),
                allow_private=allow_private,
                verify_ssl=getattr(settings, "deadlink_verify_ssl", True),
            )
            return node_id, url, title, ("ok" if is_ok else "dead"), status_code, err

        checked = ok = dead = skipped = 0
        skipped_lan = skipped_blocked = 0
        now = _now_ms()
        deadline = time.monotonic() + max(30.0, timeout * 4)

        buffered_skipped: list[tuple[str, str | None]] = []
        buffered_checked: list[tuple[str, int | None, int, str | None]] = []

        def flush_batch():
            nonlocal buffered_skipped, buffered_checked
            if not buffered_skipped and not buffered_checked:
                return
            with db.write_tx() as conn:
                if buffered_skipped:
                    conn.executemany(
                        """
                        INSERT OR IGNORE INTO link_status
                            (cid, node_id, http_status, ok, checked_at, error)
                        VALUES (?, ?, NULL, NULL, ?, ?)
                        """,
                        [(cid, nid, now, err) for nid, err in buffered_skipped],
                    )
                    buffered_skipped = []
                if buffered_checked:
                    conn.executemany(
                        """
                        INSERT INTO link_status (cid, node_id, http_status, ok, checked_at, error)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(cid, node_id) DO UPDATE SET
                            http_status = excluded.http_status,
                            ok          = excluded.ok,
                            checked_at  = excluded.checked_at,
                            error       = excluded.error
                        """,
                        [(cid, nid, sc, ok_flag, now, err) for nid, sc, ok_flag, err in buffered_checked],
                    )
                    buffered_checked = []

        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(probe_item, it) for it in items]
            idx = 0
            for fut in as_completed(futures):
                if time.monotonic() > deadline:
                    break
                idx += 1
                node_id, url, title, verdict, status_code, err = fut.result()
                if verdict == "skipped":
                    skipped += 1
                    if err == _BLOCKED_REASON:
                        skipped_blocked += 1
                    else:
                        skipped_lan += 1
                    buffered_skipped.append((node_id, err))
                else:
                    checked += 1
                    is_ok = verdict == "ok"
                    if is_ok:
                        ok += 1
                    else:
                        dead += 1
                    buffered_checked.append((node_id, status_code, 1 if is_ok else 0, err))

                if len(buffered_skipped) + len(buffered_checked) >= 50:
                    flush_batch()

                event_payload = {
                    "type": "checked",
                    "id": node_id,
                    "url": url,
                    "title": title,
                    "verdict": verdict,
                    "http_status": status_code,
                    "error": err,
                    "current": idx,
                    "total": total,
                }
                yield f"data: {json.dumps(event_payload)}\n\n"

        flush_batch()
        reason_parts = []
        if skipped_blocked:
            reason_parts.append(f"{skipped_blocked} blocked (loopback/link-local)")
        if skipped_lan:
            reason_parts.append(
                f"{skipped_lan} LAN host(s) not probed — set LIO_DEADLINK_ALLOW_PRIVATE=1 to include them"
            )
        done_payload = {
            "type": "done",
            "checked": checked,
            "ok": ok,
            "dead": dead,
            "skipped": skipped,
            "skip_reason": "; ".join(reason_parts) if reason_parts else None,
        }
        yield f"data: {json.dumps(done_payload)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")

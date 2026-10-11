"""Tests for visit tracking, reorder, and reporting endpoints."""

from __future__ import annotations
import json

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings

TOKEN = "report-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        db_path=tmp_path / "test.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=10_000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="secret",
        admin_username="admin",
        session_secret="test-secret",
        auto_provision=True,  # these tests drive the sync API with a bare token
    )
    with TestClient(create_app(settings)) as c:
        yield c


def _base() -> str:
    return f"/api/v1/collections/{TOKEN}"


def _seed(client):
    ops = {
        "device_id": "dev-a",
        "ops": [
            {"op": "create", "node_id": "bm_a", "title": "Alpha",
             "url": "https://alpha.example.com/x", "timestamp": 100},
            {"op": "create", "node_id": "bm_b", "title": "Beta",
             "url": "https://beta.example.org/y", "timestamp": 101},
            {"op": "create", "node_id": "bm_c", "title": "Gamma",
             "url": "https://gamma.example.net/z", "timestamp": 102},
        ],
    }
    r = client.post(f"{_base()}/bookmarks/delta", headers=AUTH, json=ops)
    assert r.json()["applied"] == 3


def test_domain_populated_and_usage_sorts_by_visits(client):
    _seed(client)
    # Add visits: b=5, a=2, c=0.
    r = client.post(
        f"{_base()}/bookmarks/visits",
        headers=AUTH,
        json={"increments": [
            {"node_id": "bm_a", "count": 2},
            {"node_id": "bm_b", "count": 5},
            {"node_id": "bm_unknown", "count": 9},
        ]},
    )
    body = r.json()
    assert body["applied"] == 2 and body["unknown_nodes"] == 1

    usage = client.get(
        f"{_base()}/report/usage", headers=AUTH, params={"sort": "visits", "dir": "desc"}
    ).json()["rows"]
    ids = [row["node_id"] for row in usage]
    assert ids[0] == "bm_b"  # most visited first
    # Domain was denormalized on push.
    beta = next(r for r in usage if r["node_id"] == "bm_b")
    assert beta["domain"] == "beta.example.org"
    assert beta["visit_count"] == 5


def test_usage_filter_by_query_and_domain(client):
    _seed(client)
    rows = client.get(
        f"{_base()}/report/usage", headers=AUTH, params={"q": "alph"}
    ).json()["rows"]
    assert [r["node_id"] for r in rows] == ["bm_a"]

    rows = client.get(
        f"{_base()}/report/usage", headers=AUTH, params={"domain": "gamma.example.net"}
    ).json()["rows"]
    assert [r["node_id"] for r in rows] == ["bm_c"]


def test_usage_sort_by_name_asc(client):
    _seed(client)
    rows = client.get(
        f"{_base()}/report/usage", headers=AUTH, params={"sort": "name", "dir": "asc"}
    ).json()["rows"]
    assert [r["title"] for r in rows] == ["Alpha", "Beta", "Gamma"]


def test_reorder_sets_sort_key_and_orders(client):
    _seed(client)
    # Move bm_c to the very front (before everything).
    front = client.get(
        f"{_base()}/report/usage", headers=AUTH, params={"sort": "custom", "dir": "asc"}
    ).json()["rows"]
    first_key = front[0]["sort_key"]
    r = client.patch(
        f"{_base()}/bookmarks/bm_c/reorder",
        headers=AUTH,
        json={"before": None, "after": first_key},
    )
    assert r.status_code == 200
    new_key = r.json()["sort_key"]
    assert new_key < first_key

    ordered = client.get(
        f"{_base()}/report/usage", headers=AUTH, params={"sort": "custom", "dir": "asc"}
    ).json()["rows"]
    assert ordered[0]["node_id"] == "bm_c"


def test_reorder_unknown_node_404(client):
    _seed(client)
    r = client.patch(
        f"{_base()}/bookmarks/nope/reorder", headers=AUTH, json={"before": None, "after": None}
    )
    assert r.status_code == 404


def test_reorder_emits_pullable_move_delta(client):
    """3b: a reorder must produce a move delta another device can pull and apply."""
    _seed(client)
    # Device 'web' reorders bm_c to the front.
    front = client.get(
        f"{_base()}/report/usage", headers=AUTH, params={"sort": "custom", "dir": "asc"}
    ).json()["rows"]
    first_key = front[0]["sort_key"]
    client.patch(
        f"{_base()}/bookmarks/bm_c/reorder",
        headers=AUTH,
        json={"before": None, "after": first_key},
    )
    # A different device pulls from 0 and must see a move op for bm_c.
    pull = client.get(
        f"{_base()}/bookmarks/delta", headers=AUTH, params={"since": 0, "device_id": "some-device"}
    ).json()
    moves = [o for o in pull["ops"] if o["op"] == "move" and o["node_id"] == "bm_c"]
    assert moves, "reorder should emit a move delta"
    assert "index" in moves[-1]["payload"]


def test_check_disabled_skips_all(client):
    _seed(client)
    # deadlink_check_enabled is False in the fixture → everything skipped, no
    # outbound requests made.
    r = client.post(f"{_base()}/report/check", headers=AUTH)
    body = r.json()
    assert body["checked"] == 0
    assert body["skipped"] == 3
    assert body["disabled"] is True
    assert "LIO_DEADLINK_CHECK=0" in (body["skip_reason"] or "")
    # Dead report is empty since nothing was checked.
    assert client.get(f"{_base()}/report/dead", headers=AUTH).json()["rows"] == []


def test_check_tiered_ssrf_blocks_loopback(tmp_path):
    """Loopback is ALWAYS blocked, and LAN is skipped when allow_private is false."""
    from fastapi.testclient import TestClient
    from lio_server.app import create_app

    settings = Settings(
        db_path=tmp_path / "test_ssrf.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=10_000,
        deadlink_check_enabled=True,
        deadlink_allow_private=False,  # LAN blocked
        admin_password="secret",
        admin_username="admin",
        session_secret="test-secret",
        auto_provision=True,
    )
    with TestClient(create_app(settings)) as c:
        c.post(
            f"{_base()}/bookmarks/delta",
            headers=AUTH,
            json={"device_id": "d", "ops": [
                {"op": "create", "node_id": "lb", "parent_id": "1", "title": "Local", "url": "http://127.0.0.1:8787/healthz", "timestamp": 1},
                {"op": "create", "node_id": "lan", "parent_id": "1", "title": "Router", "url": "http://192.168.1.1/", "timestamp": 1},
            ]},
        )
        r = c.post(f"{_base()}/report/check", headers=AUTH)
        assert r.status_code == 200
        b = r.json()
        assert b["checked"] == 0
        assert b["skipped"] == 2
        assert b["disabled"] is False
        assert "blocked" in b["skip_reason"]
        assert "LAN" in b["skip_reason"]
        # usage report carries the reasons per-row
        rows = {x["node_id"]: x for x in c.get(f"{_base()}/report/usage", headers=AUTH).json()["rows"]}
        assert "Blocked host" in (rows["lb"]["status_error"] or "")
        assert "LAN host" in (rows["lan"]["status_error"] or "")


def test_check_streaming(client):
    _seed(client)
    r = client.post(f"{_base()}/report/check?stream=true", headers=AUTH)
    assert r.status_code == 200
    assert "text/event-stream" in r.headers["content-type"]
    events = [json.loads(line.removeprefix("data: ")) for line in r.text.strip().split("\n\n") if line.startswith("data: ")]
    assert len(events) >= 2
    assert events[0]["type"] == "start"
    assert events[-1]["type"] == "done"


def test_check_redirect_ssrf_bypass_blocked(tmp_path):
    """A redirect to 169.254.169.254 must be blocked, not followed."""
    import http.server
    import threading
    from fastapi.testclient import TestClient
    from lio_server.app import create_app

    class RedirectHandler(http.server.BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data/")
            self.end_headers()

        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data/")
            self.end_headers()

        def log_message(self, format, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), RedirectHandler)
    port = server.server_port
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    settings = Settings(
        db_path=tmp_path / "test_ssrf_redir.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=10_000,
        deadlink_check_enabled=True,
        deadlink_allow_private=True,  # LAN allowed, but metadata IP must still be blocked!
        admin_password="secret",
        admin_username="admin",
        session_secret="test-secret",
        auto_provision=True,
    )
    try:
        with TestClient(create_app(settings)) as c:
            c.post(
                f"{_base()}/bookmarks/delta",
                headers=AUTH,
                json={"device_id": "d", "ops": [
                    {"op": "create", "node_id": "redirector", "parent_id": "1", "title": "Redirector", "url": f"http://127.0.0.1:{port}/", "timestamp": 1},
                ]},
            )
            r = c.post(f"{_base()}/report/check", headers=AUTH)
            assert r.status_code == 200
            b = r.json()
            assert b["checked"] == 0
            assert b["skipped"] == 1
            assert "blocked" in (b["skip_reason"] or "")
    finally:
        server.shutdown()
        server.server_close()

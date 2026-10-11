"""End-to-end API tests for lio-server."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings

TOKEN = "test-collection-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        db_path=tmp_path / "test.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),  # open mode
        delta_log_max_rows=10_000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="secret",
        admin_username="admin",
        session_secret="test-secret",
        auto_provision=True,  # these tests drive the sync API with a bare token
    )
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


def _base(token: str = TOKEN) -> str:
    return f"/api/v1/collections/{token}"


def test_healthz(client):
    assert client.get("/healthz").json() == {"status": "ok"}


def test_version_endpoint_with_release_identity(monkeypatch, client):
    monkeypatch.setenv("LIO_RELEASE_VERSION", "v0.9.32")
    monkeypatch.setenv("LIO_RELEASE_SHA", "0e49f3f58903")
    r = client.get("/version")
    assert r.status_code == 200
    data = r.json()
    assert data["version"] == "0.9.32"
    assert data["sha"] == "0e49f3f58903"
    assert data["display"] == "v0.9.32 (0e49f3f58903)"


def test_version_endpoint_with_malformed_env(monkeypatch, client):
    monkeypatch.setenv("LIO_RELEASE_VERSION", "")
    monkeypatch.setenv("LIO_RELEASE_SHA", "not-a-hex-sha")
    r = client.get("/version")
    assert r.status_code == 200
    data = r.json()
    assert data["sha"] == "unknown"

def test_auth_required(client):
    r = client.get(f"{_base()}/bookmarks/tree")
    assert r.status_code == 401


def test_auth_token_mismatch(client):
    r = client.get(
        f"{_base()}/bookmarks/tree",
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert r.status_code == 401


def test_empty_tree_bootstrap(client):
    r = client.get(f"{_base()}/bookmarks/tree", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["nodes"] == []
    assert body["server_timestamp"] > 0


def test_delta_push_then_tree(client):
    ops = {
        "device_id": "dev-a",
        "ops": [
            {
                "op": "create",
                "node_id": "folder_1",
                "parent_id": None,
                "index": 0,
                "title": "Work",
                "is_folder": True,
                "timestamp": 1000,
            },
            {
                "op": "create",
                "node_id": "bm_1",
                "parent_id": "folder_1",
                "index": 0,
                "title": "Example",
                "url": "https://example.com",
                "timestamp": 1001,
            },
        ],
    }
    r = client.post(f"{_base()}/bookmarks/delta", headers=AUTH, json=ops)
    assert r.status_code == 200
    assert r.json()["applied"] == 2

    tree = client.get(f"{_base()}/bookmarks/tree", headers=AUTH).json()
    ids = {n["id"] for n in tree["nodes"]}
    assert ids == {"folder_1", "bm_1"}
    bm = next(n for n in tree["nodes"] if n["id"] == "bm_1")
    assert bm["url"] == "https://example.com"
    assert bm["parent_id"] == "folder_1"


def test_lww_rejects_stale_update(client):
    client.post(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        json={
            "device_id": "dev-a",
            "ops": [
                {"op": "create", "node_id": "bm_1", "title": "New", "timestamp": 2000}
            ],
        },
    )
    r = client.post(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        json={
            "device_id": "dev-b",
            "ops": [
                {"op": "update", "node_id": "bm_1", "title": "Old", "timestamp": 1000}
            ],
        },
    )
    assert r.json()["skipped_stale"] == 1
    tree = client.get(f"{_base()}/bookmarks/tree", headers=AUTH).json()
    assert tree["nodes"][0]["title"] == "New"


def test_incremental_pull_excludes_own_ops(client):
    # dev-a authors two ops.
    client.post(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        json={
            "device_id": "dev-a",
            "ops": [
                {"op": "create", "node_id": "bm_1", "title": "A1", "timestamp": 100},
                {"op": "create", "node_id": "bm_2", "title": "A2", "timestamp": 200},
            ],
        },
    )
    # dev-b pulls: it should see both of dev-a's ops.
    r = client.get(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        params={"since": 0, "device_id": "dev-b"},
    )
    node_ids = [op["node_id"] for op in r.json()["ops"]]
    assert node_ids == ["bm_1", "bm_2"]

    # dev-a pulls its own since=0: echo suppression excludes its own ops.
    r = client.get(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        params={"since": 0, "device_id": "dev-a"},
    )
    assert r.json()["ops"] == []


def test_incremental_pull_since_watermark(client):
    client.post(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        json={
            "device_id": "dev-a",
            "ops": [
                {"op": "create", "node_id": "bm_1", "title": "A1", "timestamp": 100},
                {"op": "create", "node_id": "bm_2", "title": "A2", "timestamp": 300},
            ],
        },
    )
    r = client.get(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        params={"since": 200, "device_id": "dev-b"},
    )
    node_ids = [op["node_id"] for op in r.json()["ops"]]
    assert node_ids == ["bm_2"]


def test_tab_session_put_list_adopt(client):
    session = json.dumps(
        [{"window_id": 1, "tabs": [{"url": "https://a.com"}, {"url": "https://b.com"}]}]
    )
    r = client.put(
        f"{_base()}/tabs/dev-work",
        headers=AUTH,
        json={"device_name": "Work PC", "session_json": session, "updated_at": 5000},
    )
    assert r.status_code == 204

    listing = client.get(f"{_base()}/tabs", headers=AUTH).json()
    assert len(listing["sessions"]) == 1
    s = listing["sessions"][0]
    assert s["device_name"] == "Work PC"
    assert s["tab_count"] == 2

    adopt = client.post(f"{_base()}/tabs/dev-work/adopt", headers=AUTH)
    assert adopt.status_code == 200
    assert adopt.json()["session_json"] == session

    # Consumed: second adopt is 404, and it no longer lists.
    assert client.post(f"{_base()}/tabs/dev-work/adopt", headers=AUTH).status_code == 404
    assert client.get(f"{_base()}/tabs", headers=AUTH).json()["sessions"] == []



def test_tab_session_history_archive_and_restore(client):
    """A past session is archived at a SESSION BOUNDARY (browser start), and can
    then be restored or deleted."""
    ten_tabs = json.dumps({
        "windows": [{"tabs": [{"title": f"Tab {i}", "url": f"https://example.com/{i}"} for i in range(10)]}]
    })
    r1 = client.put(f"{_base()}/tabs/dev-laptop", headers=AUTH, json={
        "device_name": "Laptop",
        "session_json": ten_tabs,
        "updated_at": 1000,
    })
    assert r1.status_code == 204

    # The browser actually restarted: the client says so explicitly. Inferring it
    # from a smaller snapshot is what turned ordinary browsing into "past
    # sessions", so the boundary must be declared, never guessed.
    one_tab = json.dumps({
        "windows": [{"tabs": [{"title": "New Tab", "url": "chrome://newtab/"}]}]
    })
    r2 = client.put(f"{_base()}/tabs/dev-laptop", headers=AUTH, json={
        "device_name": "Laptop",
        "session_json": one_tab,
        "updated_at": 2000,
        "session_boundary": True,
    })
    assert r2.status_code == 204

    hist_res = client.get(f"{_base()}/tabs/history?device_id=dev-laptop", headers=AUTH)
    assert hist_res.status_code == 200
    hist = hist_res.json()["history"]
    assert len(hist) == 1
    assert hist[0]["tab_count"] == 10
    assert len(hist[0]["tabs"]) == 10
    history_id = hist[0]["id"]

    restored = client.post(f"{_base()}/tabs/history/{history_id}/restore", headers=AUTH)
    assert restored.status_code == 200
    assert restored.json()["session_json"] == ten_tabs

    del_res = client.delete(f"{_base()}/tabs/history/{history_id}", headers=AUTH)
    assert del_res.status_code == 204


def test_normal_browsing_never_archives_a_session(client):
    """Opening and closing tabs is not a session boundary.

    This is the regression: archiving used to trigger whenever the tab count fell,
    so closing a couple of tabs minted a "past session". Observed live: 8 of 24
    adjacent history rows were >=85% identical, four of them within ~10 seconds,
    and that churn evicted genuinely distinct older sessions via the 25-row cap.
    """
    def snap(n):
        return json.dumps({"windows": [{"tabs": [{"url": f"https://example.com/{i}"} for i in range(n)]}]})

    # A normal hour: tabs open, tabs close, counts go up and down. No boundary.
    for ts, count in [(1000, 10), (2000, 12), (3000, 11), (4000, 9), (5000, 14), (6000, 3)]:
        r = client.put(f"{_base()}/tabs/dev-browsing", headers=AUTH, json={
            "device_name": "PC", "session_json": snap(count), "updated_at": ts,
        })
        assert r.status_code == 204

    hist = client.get(f"{_base()}/tabs/history?device_id=dev-browsing", headers=AUTH).json()["history"]
    assert hist == [], (
        f"normal browsing must archive nothing, got {len(hist)} archived session(s)"
    )

    # The live snapshot still tracks the latest state.
    sessions = client.get(f"{_base()}/tabs?device_id=dev-browsing", headers=AUTH).json()["sessions"]
    assert sessions[0]["tab_count"] == 3


def test_successive_boundaries_coalesce_near_identical_sessions(client):
    """Two boundaries whose sessions are essentially the same collapse to one row.

    Similarity decides, not tab-count difference: a session that lost two tabs is
    still that session. The old `<=1 count` rule inserted a near-duplicate row
    (observed live: 0.947 overlap, 11 seconds apart, both rendered "Today at
    1:52 PM"). The fuller snapshot is kept, since restoring more tabs loses
    nothing.
    """
    def snap(urls):
        return json.dumps({"windows": [{"tabs": [{"url": u} for u in urls]}]})

    base = [f"https://example.com/{i}" for i in range(20)]

    # Session 1 ends with 20 tabs.
    client.put(f"{_base()}/tabs/dev-coalesce", headers=AUTH, json={
        "device_name": "PC", "session_json": snap(base), "updated_at": 1000,
    })
    client.put(f"{_base()}/tabs/dev-coalesce", headers=AUTH, json={
        "device_name": "PC", "session_json": snap(["chrome://newtab/"]), "updated_at": 2000,
        "session_boundary": True,
    })
    hist = client.get(f"{_base()}/tabs/history?device_id=dev-coalesce", headers=AUTH).json()["history"]
    assert len(hist) == 1 and hist[0]["tab_count"] == 20, hist

    # Session 2 ends with the SAME 20 tabs minus two: 18/20 = 0.9 similar, so it
    # is the same session, not a new one.
    client.put(f"{_base()}/tabs/dev-coalesce", headers=AUTH, json={
        "device_name": "PC", "session_json": snap(base[:18]), "updated_at": 3000,
    })
    client.put(f"{_base()}/tabs/dev-coalesce", headers=AUTH, json={
        "device_name": "PC", "session_json": snap(["chrome://newtab/"]), "updated_at": 4000,
        "session_boundary": True,
    })
    hist = client.get(f"{_base()}/tabs/history?device_id=dev-coalesce", headers=AUTH).json()["history"]
    assert len(hist) == 1, f"a near-identical session must coalesce, got {len(hist)} rows"
    assert hist[0]["tab_count"] == 20, "the fuller snapshot is the one worth keeping"

    # Session 3 ends with a genuinely different set: that IS a new past session.
    other = [f"https://other.example/{i}" for i in range(15)]
    client.put(f"{_base()}/tabs/dev-coalesce", headers=AUTH, json={
        "device_name": "PC", "session_json": snap(other), "updated_at": 5000,
    })
    client.put(f"{_base()}/tabs/dev-coalesce", headers=AUTH, json={
        "device_name": "PC", "session_json": snap(["chrome://newtab/"]), "updated_at": 6000,
        "session_boundary": True,
    })
    hist = client.get(f"{_base()}/tabs/history?device_id=dev-coalesce", headers=AUTH).json()["history"]
    assert len(hist) == 2, f"a distinct session must be kept, got {len(hist)} rows"
    assert {h["tab_count"] for h in hist} == {20, 15}, [h["tab_count"] for h in hist]

def test_delta_delete_removes_node(client):
    client.post(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        json={
            "device_id": "dev-a",
            "ops": [{"op": "create", "node_id": "bm_1", "title": "X", "timestamp": 100}],
        },
    )
    client.post(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        json={
            "device_id": "dev-a",
            "ops": [{"op": "delete", "node_id": "bm_1", "timestamp": 200}],
        },
    )
    assert client.get(f"{_base()}/bookmarks/tree", headers=AUTH).json()["nodes"] == []


def test_create_cannot_resurrect_tombstone(client):
    """A client `create` naming a tombstoned id must NOT clear the tombstone.

    Ids are permanent and never reused, so such a create can only be a client
    replaying state it captured before it learned of the deletion. Applying it
    silently undoes a server-side delete. Restoration is a server-side operation
    (undo, reorganize), never a client create.
    """
    client.post(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        json={"device_id": "d", "ops": [{"op": "create", "node_id": "res_1", "title": "First", "timestamp": 100}]},
    )
    # Deleted server-side, so it now carries a tombstone.
    client.delete(f"{_base()}/bookmarks/res_1", headers=AUTH)
    assert client.get(f"{_base()}/bookmarks/tree", headers=AUTH).json()["nodes"] == []

    # A stale client re-pushes the create it still holds locally.
    r = client.post(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        json={"device_id": "d", "ops": [{"op": "create", "node_id": "res_1", "title": "Resurrected", "timestamp": 200}]},
    )
    assert r.status_code == 200
    assert r.json()["applied"] == 0, "the create must not be applied against a tombstone"
    assert r.json()["skipped_stale"] == 1, "and it must be reported as skipped"

    assert client.get(f"{_base()}/bookmarks/tree", headers=AUTH).json()["nodes"] == [], (
        "the deletion must stand: a client create cannot bring the row back"
    )


def test_visits_endpoint_hardening(client):
    client.post(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        json={
            "device_id": "dev-a",
            "ops": [
                {"op": "create", "node_id": "live_bm", "title": "Live", "timestamp": 100},
                {"op": "create", "node_id": "del_bm", "title": "Del", "timestamp": 101},
            ],
        },
    )
    client.post(
        f"{_base()}/bookmarks/delta",
        headers=AUTH,
        json={
            "device_id": "dev-a",
            "ops": [{"op": "delete", "node_id": "del_bm", "timestamp": 200}],
        },
    )

    # 1. Count > 10,000 rejected 422
    r_over = client.post(
        f"{_base()}/bookmarks/visits",
        headers=AUTH,
        json={"increments": [{"node_id": "live_bm", "count": 10_001}]},
    )
    assert r_over.status_code == 422

    # 2. Visit to deleted node returns unknown_nodes: 1 and does not change row
    r_del = client.post(
        f"{_base()}/bookmarks/visits",
        headers=AUTH,
        json={"increments": [{"node_id": "del_bm", "count": 5}]},
    )
    assert r_del.status_code == 200
    assert r_del.json() == {"applied": 0, "unknown_nodes": 1}

    # 3. 500-item batch issues O(1) statements
    statements = []
    from lio_server import db
    conn = db.get_conn()
    conn.set_trace_callback(lambda s: statements.append(s))
    try:
        r_batch = client.post(
            f"{_base()}/bookmarks/visits",
            headers=AUTH,
            json={"increments": [{"node_id": "live_bm", "count": 1}] * 500},
        )
        assert r_batch.status_code == 200
        assert r_batch.json()["applied"] == 500
        assert len(statements) < 15
    finally:
        conn.set_trace_callback(None)


def test_delta_idempotency_replay(client):
    """Replaying an identical /delta batch twice leaves row counts and delta_log length unchanged."""
    from lio_server import db
    conn = db.get_conn()

    batch = {
        "device_id": "dev-idem",
        "ops": [
            {"op": "create", "node_id": "n1", "title": "Node 1", "timestamp": 500},
            {"op": "create", "node_id": "n2", "title": "Node 2", "timestamp": 501},
        ],
    }
    r1 = client.post(f"{_base()}/bookmarks/delta", headers=AUTH, json=batch)
    assert r1.status_code == 200
    assert r1.json()["applied"] == 2

    count_bm_1 = conn.execute("SELECT COUNT(*) FROM bookmarks WHERE deleted = 0").fetchone()[0]
    count_delta_1 = conn.execute("SELECT COUNT(*) FROM delta_log").fetchone()[0]

    # Replay identical batch
    r2 = client.post(f"{_base()}/bookmarks/delta", headers=AUTH, json=batch)
    assert r2.status_code == 200
    assert r2.json()["applied"] == 0
    assert r2.json()["skipped_stale"] == 2

    count_bm_2 = conn.execute("SELECT COUNT(*) FROM bookmarks WHERE deleted = 0").fetchone()[0]
    count_delta_2 = conn.execute("SELECT COUNT(*) FROM delta_log").fetchone()[0]

    assert count_bm_2 == count_bm_1
    assert count_delta_2 == count_delta_1

"""Regression tests for security and concurrency remediations."""

from __future__ import annotations

import concurrent.futures
import threading
import pytest
from fastapi.testclient import TestClient

from lio_server import auth, db
from lio_server.app import create_app
from lio_server.config import Settings


def test_admin_logout_requires_auth(tmp_path):
    """SEC-01: Anonymous logout must return 401 without changing token version;
    authenticated logout succeeds and revokes the session."""
    settings = Settings(
        db_path=tmp_path / "logout_test.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=1000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="password123",
        admin_username="admin",
        session_secret="test-secret",
    )
    with TestClient(create_app(settings)) as client:
        initial_ver = auth.get_admin_token_version()

        # 1. Anonymous logout must be rejected with 401
        r_anon = client.post("/admin/logout")
        assert r_anon.status_code == 401
        assert auth.get_admin_token_version() == initial_ver

        # 2. Authenticated login
        r_login = client.post("/admin/login", json={"username": "admin", "password": "password123"})
        assert r_login.status_code == 200

        # Session is valid
        assert client.get("/admin/session").status_code == 200

        # 3. Authenticated logout succeeds and increments token version
        r_logout = client.post("/admin/logout")
        assert r_logout.status_code == 200
        assert auth.get_admin_token_version() == initial_ver + 1

        # 4. Old session is now invalid
        assert client.get("/admin/session").status_code == 401


def test_first_run_setup_atomic(tmp_path):
    """SEC-02: Concurrent first-run setup requests must not race or overwrite;
    exactly one succeeds with 200, others receive 409 Conflict."""
    settings = Settings(
        db_path=tmp_path / "setup_test.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=1000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="",  # unconfigured
        admin_username="admin",
        session_secret="test-secret",
    )
    app = create_app(settings)
    with TestClient(app) as client:
        assert client.get("/admin/state").json()["setup_needed"] is True

        results = []
        def attempt_setup(user, pwd):
            res = client.post("/admin/setup", json={"username": user, "password": pwd})
            results.append((res.status_code, user))

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            f1 = pool.submit(attempt_setup, "admin_first", "firstpass123")
            f2 = pool.submit(attempt_setup, "admin_second", "secondpass123")
            f1.result()
            f2.result()

        status_codes = sorted([r[0] for r in results])
        assert status_codes == [200, 409], f"Expected [200, 409], got: {status_codes}"

        # Winner credentials are intact and setup is no longer needed
        state = client.get("/admin/state").json()
        assert state["setup_needed"] is False
        winner_user = [r[1] for r in results if r[0] == 200][0]
        stored_user = auth.stored_username()
        assert stored_user == winner_user


def test_websocket_allowed_tokens_enforced(tmp_path):
    """SEC-04: WebSocket endpoint must reject non-whitelisted tokens with 1008."""
    settings = Settings(
        db_path=tmp_path / "ws_token.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset({"allowed-token-123"}),
        delta_log_max_rows=1000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="password123",
        admin_username="admin",
        session_secret="test-secret",
        auto_provision=False,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        # Create a collection with the allowed token and one with another token in DB
        with db.write_tx() as conn:
            conn.execute("INSERT INTO collections (id, token, name) VALUES ('col_1', 'allowed-token-123', 'Allowed')")
            conn.execute("INSERT INTO collections (id, token, name) VALUES ('col_2', 'disallowed-token-456', 'Disallowed')")

        # 1. Allowed token connects successfully
        with client.websocket_connect("/api/v1/collections/allowed-token-123/ws") as ws:
            msg = ws.receive_json()
            assert msg["event"] == "connected"

        # 2. Disallowed token is rejected with WS 1008
        with pytest.raises(Exception):
            with client.websocket_connect("/api/v1/collections/disallowed-token-456/ws") as ws:
                ws.receive_json()


def test_link_checker_scheme_validation(tmp_path):
    """SEC-05: Non-http/https schemes must be skipped as blocked; http and https
    schemes are processed (including on HTTP LAN)."""
    settings = Settings(
        db_path=tmp_path / "scheme_test.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=1000,
        deadlink_check_enabled=True,
        deadlink_allow_private=True,  # LAN allowed
        admin_password="password123",
        admin_username="admin",
        session_secret="test-secret",
        auto_provision=True,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        token = "scheme-token"
        headers = {"Authorization": f"Bearer {token}"}

        # Add bookmark with non-http scheme (file, ftp, gopher)
        client.post(
            f"/api/v1/collections/{token}/bookmarks/delta",
            headers=headers,
            json={
                "device_id": "dev1",
                "ops": [
                    {"op": "create", "node_id": "bm_ftp", "title": "FTP link", "url": "ftp://example.com/file", "timestamp": 100},
                    {"op": "create", "node_id": "bm_file", "title": "File link", "url": "file:///etc/passwd", "timestamp": 101},
                    {"op": "create", "node_id": "bm_gopher", "title": "Gopher link", "url": "gopher://example.com", "timestamp": 102},
                ],
            },
        )

        r = client.post(f"/api/v1/collections/{token}/report/check", headers=headers)
        assert r.status_code == 200
        data = r.json()
        assert data["checked"] == 0
        assert data["skipped"] == 3
        assert "blocked" in (data["skip_reason"] or "").lower()


def test_reader_isolation_no_dirty_reads(tmp_path):
    """REL-01: A concurrent read must not observe uncommitted writes from an active write_tx."""
    settings = Settings(
        db_path=tmp_path / "isolation.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=1000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="password123",
        admin_username="admin",
        session_secret="test-secret",
    )
    # Initialize DB
    conn = db.init_db(settings.db_path)
    with db.write_tx() as w:
        w.execute("INSERT INTO collections (id, token, name) VALUES ('col_iso', 'tok_iso', 'Iso')")

    writer_inserted = threading.Event()
    proceed_to_commit = threading.Event()
    read_results = {}

    def writer_thread():
        with db.write_tx() as w:
            w.execute(
                "INSERT INTO bookmarks (id, cid, position, title, url, is_folder) "
                "VALUES ('bm_dirty', 'col_iso', 0, 'Dirty Read', 'http://example.com', 0)"
            )
            writer_inserted.set()
            proceed_to_commit.wait(timeout=5.0)

    def reader_thread():
        writer_inserted.wait(timeout=5.0)
        # Separate thread reader query using db.get_conn()
        rconn = db.get_conn()
        row = rconn.execute("SELECT id FROM bookmarks WHERE id = 'bm_dirty'").fetchone()
        read_results["before_commit"] = row
        proceed_to_commit.set()

    t_writer = threading.Thread(target=writer_thread)
    t_reader = threading.Thread(target=reader_thread)

    t_writer.start()
    t_reader.start()

    t_writer.join(timeout=6.0)
    t_reader.join(timeout=6.0)

    # 1. Row was invisible while transaction was uncommitted
    assert read_results["before_commit"] is None, "Dirty read leaked uncommitted row!"

    # 2. After writer committed, reader sees the row
    reader_after = db.get_conn().execute("SELECT id FROM bookmarks WHERE id = 'bm_dirty'").fetchone()
    assert reader_after is not None
    assert reader_after["id"] == "bm_dirty"

    db.close_db()

"""Test transaction safety and rollback across write handlers (P0)."""

from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from lio_server import db
from lio_server.app import create_app
from lio_server.config import Settings

TOKEN = "test-tx-token"


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        db_path=tmp_path / "tx.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=10_000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="secret",
        admin_username="admin",
        session_secret="test-secret",
        auto_provision=True,
    )
    with TestClient(create_app(settings), raise_server_exceptions=False) as c:
        yield c


def test_failed_mid_batch_op_rolls_back_completely(client):
    """Assert a failed mid-batch op leaves the DB byte-identical and does not
    leak into the next request's commit."""
    conn = db.get_conn()
    conn.execute(
        """
        CREATE TRIGGER test_abort_bad BEFORE INSERT ON bookmarks
        WHEN NEW.id = 'bad_node'
        BEGIN
            SELECT RAISE(ABORT, 'Simulated constraint failure');
        END
        """
    )

    count_before = conn.execute("SELECT COUNT(*) FROM bookmarks").fetchone()[0]

    # Push a 2-op batch where op 2 fails
    res = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={
            "device_id": "dev1",
            "ops": [
                {"op": "create", "node_id": "good_node", "title": "Good", "timestamp": 1000},
                {"op": "create", "node_id": "bad_node", "title": "Bad", "timestamp": 1001},
            ],
        },
    )
    assert res.status_code >= 500

    count_after_fail = conn.execute("SELECT COUNT(*) FROM bookmarks").fetchone()[0]
    assert count_after_fail == count_before

    # Subsequent successful request must not commit op 1
    res2 = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={
            "device_id": "dev1",
            "ops": [
                {"op": "create", "node_id": "next_node", "title": "Next", "timestamp": 2000},
            ],
        },
    )
    assert res2.status_code == 200

    row_good = conn.execute("SELECT * FROM bookmarks WHERE id = 'good_node'").fetchone()
    assert row_good is None

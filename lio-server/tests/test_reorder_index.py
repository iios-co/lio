"""Index-based reorder: display order (sort_key) tracks browser position order."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings

TOKEN = "reordertok123456"


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        db_path=tmp_path / "reorder.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=10_000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="hunter2",
        admin_username="admin",
        session_secret="fixed-secret",
        auto_provision=True,  # these tests drive the sync API with a bare token
    )
    with TestClient(create_app(settings)) as c:
        yield c


def _h() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def _push(client, nodes):
    ops = [
        {"op": "create", "node_id": nid, "title": nid, "url": f"https://{nid}.com",
         "parent_id": None, "index": i, "timestamp": 1000 + i}
        for i, nid in enumerate(nodes)
    ]
    r = client.post(f"/api/v1/collections/{TOKEN}/bookmarks/delta",
                    headers=_h(), json={"device_id": "d", "ops": ops})
    assert r.status_code == 200


def _order(client):
    rows = client.get(
        f"/api/v1/collections/{TOKEN}/report/usage?sort=custom&dir=asc&include_folders=true",
        headers=_h(),
    ).json()["rows"]
    # rows come back ordered by sort_key asc; positions must agree with that order.
    assert [r["position"] for r in rows] == sorted(r["position"] for r in rows)
    return [r["node_id"] for r in rows]


def test_index_reorder_moves_to_front(client):
    _push(client, ["a", "b", "c", "d"])
    # Move "d" to index 0.
    r = client.patch(f"/api/v1/collections/{TOKEN}/bookmarks/d/reorder",
                     headers=_h(), json={"index": 0})
    assert r.status_code == 200
    assert _order(client) == ["d", "a", "b", "c"]


def test_index_reorder_middle_and_positions_consistent(client):
    _push(client, ["a", "b", "c", "d", "e"])
    # Move "a" to index 3.
    client.patch(f"/api/v1/collections/{TOKEN}/bookmarks/a/reorder",
                 headers=_h(), json={"index": 3})
    assert _order(client) == ["b", "c", "d", "a", "e"]
    # A second move still keeps sort_key/position consistent (self-healing).
    client.patch(f"/api/v1/collections/{TOKEN}/bookmarks/e/reorder",
                 headers=_h(), json={"index": 0})
    assert _order(client) == ["e", "b", "c", "d", "a"]

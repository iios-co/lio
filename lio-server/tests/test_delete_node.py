"""Deleting a bookmark / folder subtree from the web UI."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings

TOKEN = "deletetok12345678"


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        db_path=tmp_path / "del.db",
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


def _seed(client) -> None:
    ops = [
        {"op": "create", "node_id": "f1", "parent_id": None, "index": 0, "title": "Folder",
         "is_folder": True, "timestamp": 1000},
        {"op": "create", "node_id": "a", "parent_id": "f1", "index": 0, "title": "A",
         "url": "https://a.com", "timestamp": 1001},
        {"op": "create", "node_id": "b", "parent_id": "f1", "index": 1, "title": "B",
         "url": "https://b.com", "timestamp": 1002},
        {"op": "create", "node_id": "loose", "parent_id": None, "index": 1, "title": "Loose",
         "url": "https://loose.com", "timestamp": 1003},
    ]
    r = client.post(f"/api/v1/collections/{TOKEN}/bookmarks/delta",
                    headers=_h(), json={"device_id": "d", "ops": ops})
    assert r.json()["applied"] == 4


def _ids(client) -> list[str]:
    tree = client.get(f"/api/v1/collections/{TOKEN}/bookmarks/tree", headers=_h()).json()
    return sorted(n["id"] for n in tree["nodes"])


def test_delete_single_link(client):
    _seed(client)
    r = client.delete(f"/api/v1/collections/{TOKEN}/bookmarks/loose", headers=_h())
    assert r.status_code == 200
    assert r.json()["deleted"] == 1
    assert _ids(client) == ["a", "b", "f1"]


def test_delete_folder_takes_subtree(client):
    _seed(client)
    r = client.delete(f"/api/v1/collections/{TOKEN}/bookmarks/f1", headers=_h())
    assert r.status_code == 200
    assert r.json()["deleted"] == 3  # folder + 2 children
    assert _ids(client) == ["loose"]


def test_delete_emits_delta_for_devices(client):
    _seed(client)
    client.delete(f"/api/v1/collections/{TOKEN}/bookmarks/f1", headers=_h())
    pulled = client.get(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta?since=0&device_id=other",
        headers=_h(),
    ).json()["ops"]
    deletes = {o["node_id"] for o in pulled if o["op"] == "delete"}
    assert {"f1", "a", "b"} <= deletes


def test_delete_unknown_node_404(client):
    _seed(client)
    assert client.delete(
        f"/api/v1/collections/{TOKEN}/bookmarks/nope", headers=_h()
    ).status_code == 404


def test_discard_tab_session(client):
    body = {"device_name": "Laptop", "session_json": '{"tabs":[{"title":"A","url":"https://a.com"}]}'}
    assert client.put(
        f"/api/v1/collections/{TOKEN}/tabs/dev1", headers=_h(), json=body
    ).status_code == 204
    assert len(client.get(f"/api/v1/collections/{TOKEN}/tabs", headers=_h()).json()["sessions"]) == 1

    # Discard removes it without returning the session.
    assert client.delete(f"/api/v1/collections/{TOKEN}/tabs/dev1", headers=_h()).status_code == 204
    assert client.get(f"/api/v1/collections/{TOKEN}/tabs", headers=_h()).json()["sessions"] == []

    # Discarding again is a 404.
    assert client.delete(f"/api/v1/collections/{TOKEN}/tabs/dev1", headers=_h()).status_code == 404

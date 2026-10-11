"""Tests for the admin console: login, collection CRUD, and token rotation."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        db_path=tmp_path / "admin.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=10_000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="hunter2",
        admin_username="admin",
        session_secret="fixed-secret",
    )
    with TestClient(create_app(settings)) as c:
        yield c


def _login(client) -> None:
    r = client.post("/admin/login", json={"username": "admin", "password": "hunter2"})
    assert r.status_code == 200


def test_login_required_for_collections(client):
    assert client.get("/admin/collections").status_code == 401


def test_bad_password_rejected(client):
    assert client.post("/admin/login", json={"username": "admin", "password": "wrong"}).status_code == 401


def test_create_list_and_use_collection(client):
    _login(client)
    r = client.post("/admin/collections", json={"name": "Work"})
    assert r.status_code == 200
    created = r.json()
    token = created["token"]
    assert token and created["name"] == "Work"

    listed = client.get("/admin/collections").json()["collections"]
    assert len(listed) == 1
    assert listed[0]["token"] == token
    assert listed[0]["bookmark_count"] == 0

    # The minted token works against the sync API.
    push = client.post(
        f"/api/v1/collections/{token}/bookmarks/delta",
        headers={"Authorization": f"Bearer {token}"},
        json={"device_id": "d", "ops": [
            {"op": "create", "node_id": "b1", "title": "X",
             "url": "https://x.com", "timestamp": 1}
        ]},
    )
    assert push.json()["applied"] == 1

    listed = client.get("/admin/collections").json()["collections"]
    assert listed[0]["bookmark_count"] == 1


def test_rotate_token_preserves_data(client):
    _login(client)
    created = client.post("/admin/collections", json={"name": "Work"}).json()
    cid, old_token = created["id"], created["token"]

    client.post(
        f"/api/v1/collections/{old_token}/bookmarks/delta",
        headers={"Authorization": f"Bearer {old_token}"},
        json={"device_id": "d", "ops": [
            {"op": "create", "node_id": "b1", "title": "Keep",
             "url": "https://k.com", "timestamp": 1}
        ]},
    )

    rot = client.post(f"/admin/collections/{cid}/rotate")
    assert rot.status_code == 200
    new_token = rot.json()["token"]
    assert new_token != old_token

    # The old token is no longer recognised. It must be REJECTED — not quietly
    # provisioned into a new empty collection, which is what let a device with a
    # stale token report a healthy sync while writing nowhere.
    old_tree = client.get(
        f"/api/v1/collections/{old_token}/bookmarks/tree",
        headers={"Authorization": f"Bearer {old_token}"},
    )
    assert old_tree.status_code == 404

    # And no phantom collection was created as a side effect.
    assert len(client.get("/admin/collections").json()["collections"]) == 1

    # New token sees the preserved data (same cid).
    new_tree = client.get(
        f"/api/v1/collections/{new_token}/bookmarks/tree",
        headers={"Authorization": f"Bearer {new_token}"},
    ).json()
    assert [n["id"] for n in new_tree["nodes"]] == ["b1"]


def test_rename_collection(client):
    _login(client)
    cid = client.post("/admin/collections", json={"name": "Work"}).json()["id"]

    r = client.patch(f"/admin/collections/{cid}", json={"name": "  Personal  "})
    assert r.status_code == 200
    assert r.json()["name"] == "Personal"  # trimmed

    listed = client.get("/admin/collections").json()["collections"]
    assert listed[0]["name"] == "Personal"

    # Unknown collection → 404; empty name rejected by validation.
    assert client.patch("/admin/collections/col_nope", json={"name": "X"}).status_code == 404
    assert client.patch(f"/admin/collections/{cid}", json={"name": ""}).status_code == 422


def test_minted_token_is_16_chars(client):
    _login(client)
    created = client.post("/admin/collections", json={"name": "Work"}).json()
    assert len(created["token"]) == 16
    rot = client.post(f"/admin/collections/{created['id']}/rotate").json()
    assert len(rot["token"]) == 16


def test_delete_collection(client):
    _login(client)
    created = client.post("/admin/collections", json={"name": "Temp"}).json()
    cid = created["id"]
    assert client.delete(f"/admin/collections/{cid}").status_code == 200
    assert client.get("/admin/collections").json()["collections"] == []
    assert client.delete(f"/admin/collections/{cid}").status_code == 404

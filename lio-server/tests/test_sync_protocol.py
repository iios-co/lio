"""Tests for the deterministic sync protocol (/bookmarks/sync)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings

TOKEN = "test-sync-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        db_path=tmp_path / "sync_test.db",
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
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


def _base() -> str:
    return f"/api/v1/collections/{TOKEN}/bookmarks"


def test_idempotency_and_sequence_verification(client):
    """Sending the same operationId twice returns ACK without duplicating rows."""
    batch = {
        "clientId": "dev1",
        "lastServerVersion": 0,
        "operations": [
            {
                "operationId": "dev1:1",
                "clientId": "dev1",
                "clientSequence": 1,
                "itemId": "bm_1",
                "operation": "create",
                "changes": {
                    "title": "Example",
                    "url": "https://example.com",
                    "parentId": None,
                    "index": 0,
                    "isFolder": False,
                },
                "lastServerVersion": 0,
            }
        ],
    }

    # 1. First push
    r1 = client.post(f"{_base()}/sync", json=batch, headers=AUTH)
    assert r1.status_code == 200, r1.text
    data1 = r1.json()
    assert data1["acknowledgedOperations"] == ["dev1:1"]
    v1 = data1["currentServerVersion"]
    assert v1 >= 1

    # Check tree has 1 item
    tree_res = client.get(f"{_base()}/tree", headers=AUTH)
    assert len(tree_res.json()["nodes"]) == 1
    assert tree_res.json()["nodes"][0]["id"] == "bm_1"

    # 2. Resend exact same batch
    r2 = client.post(f"{_base()}/sync", json=batch, headers=AUTH)
    assert r2.status_code == 200
    data2 = r2.json()
    assert data2["acknowledgedOperations"] == ["dev1:1"]
    assert data2["currentServerVersion"] == v1  # version should not advance on idempotent replay

    # Tree still has exactly 1 item
    tree_res2 = client.get(f"{_base()}/tree", headers=AUTH)
    assert len(tree_res2.json()["nodes"]) == 1


def test_durable_tombstone_and_deletion_replay(client):
    """A deleted bookmark leaves a tombstone and is distributed to other clients."""
    # 1. Client A creates bm_1
    create_batch = {
        "clientId": "devA",
        "lastServerVersion": 0,
        "operations": [
            {
                "operationId": "devA:1",
                "clientId": "devA",
                "clientSequence": 1,
                "itemId": "bm_1",
                "operation": "create",
                "changes": {
                    "title": "To Delete",
                    "url": "https://delete.me",
                },
                "lastServerVersion": 0,
            }
        ],
    }
    r_create = client.post(f"{_base()}/sync", json=create_batch, headers=AUTH)
    v_create = r_create.json()["currentServerVersion"]

    # 2. Client A deletes bm_1
    delete_batch = {
        "clientId": "devA",
        "lastServerVersion": v_create,
        "operations": [
            {
                "operationId": "devA:2",
                "clientId": "devA",
                "clientSequence": 2,
                "itemId": "bm_1",
                "operation": "delete",
                "changes": {},
                "lastServerVersion": v_create,
            }
        ],
    }
    r_delete = client.post(f"{_base()}/sync", json=delete_batch, headers=AUTH)
    assert r_delete.status_code == 200
    assert r_delete.json()["acknowledgedOperations"] == ["devA:2"]
    v_delete = r_delete.json()["currentServerVersion"]
    assert v_delete > v_create

    # Tree must NOT include deleted item
    tree = client.get(f"{_base()}/tree", headers=AUTH).json()
    assert len(tree["nodes"]) == 0

    # 3. Client B syncs with lastServerVersion = v_create
    b_sync = {
        "clientId": "devB",
        "lastServerVersion": v_create,
        "operations": [],
    }
    r_b = client.post(f"{_base()}/sync", json=b_sync, headers=AUTH)
    assert r_b.status_code == 200
    b_data = r_b.json()
    assert b_data["currentServerVersion"] == v_delete
    assert len(b_data["changes"]) == 1
    ch = b_data["changes"][0]
    assert ch["itemId"] == "bm_1"
    assert ch["operation"] == "delete"
    assert ch["serverVersion"] == v_delete


def test_concurrent_conflict_resolution_tombstone_wins(client):
    """An update from a stale client on an already-deleted item is rejected."""
    # 1. Create bm_x
    client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devA",
            "lastServerVersion": 0,
            "operations": [
                {
                    "operationId": "devA:1",
                    "clientId": "devA",
                    "clientSequence": 1,
                    "itemId": "bm_x",
                    "operation": "create",
                    "changes": {"title": "Initial", "url": "https://x.com"},
                    "lastServerVersion": 0,
                }
            ],
        },
        headers=AUTH,
    )

    # 2. Delete bm_x
    r_del = client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devA",
            "lastServerVersion": 1,
            "operations": [
                {
                    "operationId": "devA:2",
                    "clientId": "devA",
                    "clientSequence": 2,
                    "itemId": "bm_x",
                    "operation": "delete",
                    "changes": {},
                    "lastServerVersion": 1,
                }
            ],
        },
        headers=AUTH,
    )
    v_del = r_del.json()["currentServerVersion"]

    # 3. Stale Client B sends update with lastServerVersion = 1 (before delete)
    r_stale = client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devB",
            "lastServerVersion": 1,
            "operations": [
                {
                    "operationId": "devB:1",
                    "clientId": "devB",
                    "clientSequence": 1,
                    "itemId": "bm_x",
                    "operation": "update",
                    "changes": {"title": "Stale Update"},
                    "lastServerVersion": 1,
                }
            ],
        },
        headers=AUTH,
    )
    assert r_stale.status_code == 200
    stale_data = r_stale.json()
    # Op must be ACKed so client doesn't retry forever
    assert stale_data["acknowledgedOperations"] == ["devB:1"]
    # Server changes must include the deletion of bm_x
    del_changes = [c for c in stale_data["changes"] if c["itemId"] == "bm_x" and c["operation"] == "delete"]
    assert len(del_changes) == 1
    assert del_changes[0]["serverVersion"] == v_del

    # Tree still has 0 items
    tree = client.get(f"{_base()}/tree", headers=AUTH).json()
    assert len(tree["nodes"]) == 0


def test_lww_conflict_resolution_for_updates(client):
    """An older update arriving after a newer update is rejected and overwritten with server state."""
    # 1. Create bm_y
    client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devA",
            "lastServerVersion": 0,
            "operations": [
                {
                    "operationId": "devA:1",
                    "clientId": "devA",
                    "clientSequence": 1,
                    "itemId": "bm_y",
                    "operation": "create",
                    "changes": {"title": "Initial", "url": "https://y.com", "dateAdded": 1000},
                    "lastServerVersion": 0,
                }
            ],
        },
        headers=AUTH,
    )

    # 2. Newer update from devA at timestamp 2000
    client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devA",
            "lastServerVersion": 1,
            "operations": [
                {
                    "operationId": "devA:2",
                    "clientId": "devA",
                    "clientSequence": 2,
                    "itemId": "bm_y",
                    "operation": "update",
                    "changes": {"title": "Newer Title", "dateModified": 2000},
                    "lastServerVersion": 1,
                }
            ],
        },
        headers=AUTH,
    )

    # 3. Older update from devB with timestamp 1500 and lastServerVersion = 1
    r_older = client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devB",
            "lastServerVersion": 1,
            "operations": [
                {
                    "operationId": "devB:1",
                    "clientId": "devB",
                    "clientSequence": 1,
                    "itemId": "bm_y",
                    "operation": "update",
                    "changes": {"title": "Older Title", "dateModified": 1500},
                    "lastServerVersion": 1,
                }
            ],
        },
        headers=AUTH,
    )
    assert r_older.status_code == 200
    res = r_older.json()
    assert res["acknowledgedOperations"] == ["devB:1"]

    # Tree retains "Newer Title"
    tree = client.get(f"{_base()}/tree", headers=AUTH).json()
    assert tree["nodes"][0]["title"] == "Newer Title"


def test_create_against_tombstone_is_refused_and_client_told_to_delete(client):
    """The user's scenario: pause, delete server-side, unpause.

    On resume the client re-pushes the items it still holds locally. Ids are
    permanent and never reused, so a `create` naming a tombstoned id can only be
    stale client state -- deletion wins. The op is ACKNOWLEDGED so the client
    stops retrying, and the tombstone comes back as a `delete` change so the
    client applies the deletion locally and converges.
    """
    ids = ["bm_p1", "bm_p2", "bm_p3"]

    r = client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devA",
            "lastServerVersion": 0,
            "operations": [
                {
                    "operationId": f"devA:create:{i}",
                    "clientId": "devA",
                    "clientSequence": n,
                    "itemId": i,
                    "operation": "create",
                    "changes": {"title": f"Link {i}", "url": f"https://{i}.example/"},
                    "lastServerVersion": 0,
                }
                for n, i in enumerate(ids, start=1)
            ],
        },
        headers=AUTH,
    )
    assert r.status_code == 200
    v_created = r.json()["currentServerVersion"]
    assert len(client.get(f"{_base()}/tree", headers=AUTH).json()["nodes"]) == 3

    # Deleted on the SERVER (web UI / console) while the client is paused.
    for i in ids:
        assert client.delete(f"{_base()}/{i}", headers=AUTH).status_code == 200
    assert client.get(f"{_base()}/tree", headers=AUTH).json()["nodes"] == []

    # Unpause: the client still holds all three and pushes them as creates,
    # unaware of the deletion, from its pre-deletion watermark.
    r_resume = client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devA",
            "lastServerVersion": v_created,
            "operations": [
                {
                    "operationId": f"devA:resume:{i}",
                    "clientId": "devA",
                    "clientSequence": 10 + n,
                    "itemId": i,
                    "operation": "create",
                    "changes": {"title": f"Link {i}", "url": f"https://{i}.example/"},
                    "lastServerVersion": v_created,
                }
                for n, i in enumerate(ids, start=1)
            ],
        },
        headers=AUTH,
    )
    assert r_resume.status_code == 200
    body = r_resume.json()

    assert client.get(f"{_base()}/tree", headers=AUTH).json()["nodes"] == [], (
        "server-side deletions must stand; a client create cannot resurrect them"
    )

    # Acknowledged, so the client retires the ops instead of retrying forever.
    for i in ids:
        assert f"devA:resume:{i}" in body["acknowledgedOperations"]

    # And told to delete locally, so the two sides actually converge.
    delete_targets = {c["itemId"] for c in body["changes"] if c["operation"] == "delete"}
    assert set(ids) <= delete_targets, (
        f"client must receive a delete for every tombstoned id, got {delete_targets}"
    )


def _tree_rows(client):
    r = client.get(f"{_base()}/tree", headers=AUTH)
    assert r.status_code == 200
    return {n["id"]: n for n in r.json()["nodes"]}


def test_concurrent_move_server_placement_wins(client):
    """The user's scenario: pause, reorder a link on the SERVER, reorder one in the
    BROWSER, unpause.

    Both sides moved from the same earlier version, so this is a real conflict
    (§6) and one deterministic policy must settle it: the server is authoritative
    (§1). The client's queued move is acknowledged so it stops retrying, and the
    server's placement comes back as a change so the client converges.
    """
    seed = {
        "clientId": "devA",
        "lastServerVersion": 0,
        "operations": [
            {
                "operationId": f"devA:seed:{nid}",
                "clientId": "devA",
                "clientSequence": n,
                "itemId": nid,
                "operation": "create",
                "changes": {
                    "parentId": parent,
                    "index": idx,
                    "title": title,
                    "url": url,
                    "isFolder": url is None,
                },
                "lastServerVersion": 0,
            }
            for n, (nid, parent, idx, title, url) in enumerate(
                [
                    ("bar", None, 0, "Bookmarks Bar", None),
                    ("lA", "bar", 0, "Alpha", "https://a.example/"),
                    ("lB", "bar", 1, "Beta", "https://b.example/"),
                    ("lC", "bar", 2, "Gamma", "https://c.example/"),
                ],
                start=1,
            )
        ],
    }
    r = client.post(f"{_base()}/sync", json=seed, headers=AUTH)
    assert r.status_code == 200, r.text
    paused_at = r.json()["currentServerVersion"]

    # --- while the client is paused: the SERVER moves Gamma to the front -------
    r_reorder = client.patch(
        f"{_base()}/lC/reorder", headers=AUTH, json={"parent_id": "bar", "index": 0}
    )
    assert r_reorder.status_code == 200, r_reorder.text
    server_order = sorted(
        (n["position"], nid) for nid, n in _tree_rows(client).items() if n["parent_id"] == "bar"
    )
    assert [nid for _, nid in server_order] == ["lC", "lA", "lB"], server_order

    # --- unpause: the browser pushes ITS reorder, authored without knowing -----
    # It moved Alpha to the front locally, from its pre-reorder watermark.
    r_resume = client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devA",
            "lastServerVersion": paused_at,
            "operations": [
                {
                    "operationId": "devA:move:lA",
                    "clientId": "devA",
                    "clientSequence": 20,
                    "itemId": "lA",
                    "operation": "move",
                    "changes": {"parentId": "bar", "index": 0},
                    "lastServerVersion": paused_at,
                }
            ],
        },
        headers=AUTH,
    )
    assert r_resume.status_code == 200, r_resume.text
    body = r_resume.json()

    final = sorted(
        (n["position"], nid) for nid, n in _tree_rows(client).items() if n["parent_id"] == "bar"
    )
    assert [nid for _, nid in final] == ["lC", "lA", "lB"], (
        f"the server's placement must stand, got {final}"
    )

    assert "devA:move:lA" in body["acknowledgedOperations"], (
        "the op must be acknowledged so the client stops resending it"
    )

    moved_back = {c["itemId"]: c for c in body["changes"] if c["operation"] == "move"}
    assert "lA" in moved_back, (
        f"the client must be told the server's placement for the row it moved, got {list(moved_back)}"
    )
    assert moved_back["lA"]["data"]["position"] == 1, (
        f"and that placement is the server's index, got {moved_back['lA']['data']['position']}"
    )


def test_a_move_from_a_current_client_is_still_applied(client):
    """The gate must only catch STALE moves: a client that has seen the server's
    latest version is authoring a genuine new move and it must land."""
    r = client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devA",
            "lastServerVersion": 0,
            "operations": [
                {
                    "operationId": f"devA:seed:{nid}",
                    "clientId": "devA",
                    "clientSequence": n,
                    "itemId": nid,
                    "operation": "create",
                    "changes": {"parentId": parent, "index": idx, "title": nid, "isFolder": False,
                               "url": f"https://{nid}.example/"},
                    "lastServerVersion": 0,
                }
                for n, (nid, parent, idx) in enumerate(
                    [("bar", None, 0), ("lA", "bar", 0), ("lB", "bar", 1)], start=1
                )
            ],
        },
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    current = r.json()["currentServerVersion"]

    r_move = client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devA",
            "lastServerVersion": current,
            "operations": [
                {
                    "operationId": "devA:move:lB",
                    "clientId": "devA",
                    "clientSequence": 9,
                    "itemId": "lB",
                    "operation": "move",
                    "changes": {"parentId": "bar", "index": 0},
                    "lastServerVersion": current,
                }
            ],
        },
        headers=AUTH,
    )
    assert r_move.status_code == 200, r_move.text
    assert "devA:move:lB" in r_move.json()["acknowledgedOperations"]

    rows = _tree_rows(client)
    assert rows["lB"]["position"] == 0, (
        f"an up-to-date client's move must be applied, got position {rows['lB']['position']}"
    )
    assert rows["lA"]["position"] == 1, (
        f"sibling lA must be shifted to position 1, got position {rows['lA']['position']}"
    )


def test_sync_move_updates_sort_key_and_sibling_positions(client):
    """Moving a bookmark via /sync atomically updates sort_key, renumbers siblings,
    and updates server_version on shifted rows."""
    r = client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devA",
            "lastServerVersion": 0,
            "operations": [
                {
                    "operationId": f"devA:seed:{nid}",
                    "clientId": "devA",
                    "clientSequence": n,
                    "itemId": nid,
                    "operation": "create",
                    "changes": {"parentId": "bar", "index": idx, "title": nid, "url": f"https://{nid}.example"},
                    "lastServerVersion": 0,
                }
                for n, (nid, idx) in enumerate([("b0", 0), ("b1", 1), ("b2", 2)], start=1)
            ],
        },
        headers=AUTH,
    )
    assert r.status_code == 200
    v1 = r.json()["currentServerVersion"]

    # Move b2 from index 2 to index 0
    r_move = client.post(
        f"{_base()}/sync",
        json={
            "clientId": "devA",
            "lastServerVersion": v1,
            "operations": [
                {
                    "operationId": "devA:move:b2",
                    "clientId": "devA",
                    "clientSequence": 10,
                    "itemId": "b2",
                    "operation": "move",
                    "changes": {"parentId": "bar", "index": 0},
                    "lastServerVersion": v1,
                }
            ],
        },
        headers=AUTH,
    )
    assert r_move.status_code == 200

    rows = _tree_rows(client)
    assert rows["b2"]["position"] == 0
    assert rows["b0"]["position"] == 1
    assert rows["b1"]["position"] == 2

    # Usage report sorted by custom (sort_key) reflects the new order
    rep = client.get(f"/api/v1/collections/{TOKEN}/report/usage?sort=custom&dir=asc", headers=AUTH).json()
    rep_ids = [row["node_id"] for row in rep["rows"]]
    assert rep_ids == ["b2", "b0", "b1"]


"""A folder delete from a CLIENT must take its whole subtree.

The browser fires one `onRemoved` for a deleted folder, so a client only ever
sends the root id. Both client-facing paths (`/bookmarks/delta` and
`/bookmarks/sync`) used to tombstone just that row, leaving every descendant live
with a `parent_id` pointing at a tombstone. Two visible consequences:

  * The web UI's `buildTree` treats a row whose parent is missing as a root, so
    the orphaned subfolders reappeared at top level beside Bookmarks Bar.
  * `folder_count` dropped by exactly 1 no matter how deep the deleted folder
    was, because only one row had been tombstoned.

`delete_node` (the web UI's own path) already cascaded via `_subtree_ids`. These
tests pin the same rule onto the client paths.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings

TOKEN = "cascadetoken12345"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        db_path=tmp_path / "cascade.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=10_000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="hunter2",
        admin_username="admin",
        session_secret="fixed-secret",
        auto_provision=True,
    )
    with TestClient(create_app(settings)) as c:
        yield c


def _base() -> str:
    return f"/api/v1/collections/{TOKEN}/bookmarks"


# bar
#  └── top            (the folder the user deletes)
#       ├── mid_a ── deep_a ── link_deep
#       ├── mid_b
#       └── link_top
# plus a sibling that must survive untouched.
TREE = [
    ("bar", None, "Bookmarks Bar", None, True),
    ("top", "bar", "Top", None, True),
    ("mid_a", "top", "Mid A", None, True),
    ("mid_b", "top", "Mid B", None, True),
    ("deep_a", "mid_a", "Deep A", None, True),
    ("link_deep", "deep_a", "Deep link", "https://deep.example/", False),
    ("link_top", "top", "Top link", "https://top.example/", False),
    ("keep_folder", "bar", "Keep", None, True),
    ("keep_link", "keep_folder", "Keep link", "https://keep.example/", False),
]

DOOMED = {"top", "mid_a", "mid_b", "deep_a", "link_deep", "link_top"}
SURVIVORS = {"bar", "keep_folder", "keep_link"}


def _seed(client):
    ops = [
        {
            "op": "create",
            "node_id": nid,
            "parent_id": parent,
            "index": i,
            "title": title,
            "url": url,
            "is_folder": folder,
            "timestamp": 1_000 + i,
        }
        for i, (nid, parent, title, url, folder) in enumerate(TREE)
    ]
    r = client.post(
        f"{_base()}/delta", headers=AUTH, json={"device_id": "seed", "ops": ops}
    )
    assert r.status_code == 200, r.text


def _rows(client):
    r = client.get(f"{_base()}/tree", headers=AUTH)
    assert r.status_code == 200
    return {n["id"]: n for n in r.json()["nodes"]}


def _info(client):
    r = client.get(f"/api/v1/collections/{TOKEN}/info", headers=AUTH)
    assert r.status_code == 200
    return r.json()


def test_delta_delete_of_a_folder_removes_its_whole_subtree(client):
    _seed(client)
    assert len(_rows(client)) == len(TREE)

    r = client.post(
        f"{_base()}/delta",
        headers=AUTH,
        json={
            "device_id": "devA",
            "ops": [{"op": "delete", "node_id": "top", "timestamp": 5_000}],
        },
    )
    assert r.status_code == 200, r.text

    rows = _rows(client)
    assert DOOMED.isdisjoint(rows), (
        f"every node under the deleted folder must be gone, still present: {DOOMED & set(rows)}"
    )
    assert SURVIVORS <= set(rows), f"unrelated nodes must survive, missing: {SURVIVORS - set(rows)}"


def test_sync_delete_of_a_folder_removes_its_whole_subtree(client):
    _seed(client)

    r = client.post(
        f"{_base()}/sync",
        headers=AUTH,
        json={
            "clientId": "devB",
            "lastServerVersion": 0,
            "operations": [
                {
                    "operationId": "devB:del:top",
                    "clientId": "devB",
                    "clientSequence": 1,
                    "itemId": "top",
                    "operation": "delete",
                    "changes": {},
                    "lastServerVersion": 0,
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    assert "devB:del:top" in r.json()["acknowledgedOperations"]

    rows = _rows(client)
    assert DOOMED.isdisjoint(rows), (
        f"the sync path must cascade too, still present: {DOOMED & set(rows)}"
    )
    assert SURVIVORS <= set(rows)


def test_no_row_is_left_pointing_at_a_deleted_parent(client):
    """An orphan is what made the subfolders reappear at top level in the web UI."""
    _seed(client)
    client.post(
        f"{_base()}/delta",
        headers=AUTH,
        json={
            "device_id": "devA",
            "ops": [{"op": "delete", "node_id": "top", "timestamp": 5_000}],
        },
    )

    rows = _rows(client)
    live = set(rows)
    orphans = {
        nid: n["parent_id"]
        for nid, n in rows.items()
        if n["parent_id"] is not None and n["parent_id"] not in live
    }
    assert orphans == {}, (
        f"these rows survive with a dead parent and would render as roots: {orphans}"
    )


def test_folder_count_drops_by_the_whole_subtree(client):
    """`folder_count` already counts folders at EVERY depth, so the "-1" the user
    saw was not a counting bug: only one row had actually been tombstoned. With
    the cascade in place the count must fall by the whole nest."""
    _seed(client)
    before = _info(client)
    # bar, top, mid_a, mid_b, deep_a, keep_folder
    assert before["folder_count"] == 6, before
    assert before["bookmark_count"] == 3, before

    client.post(
        f"{_base()}/delta",
        headers=AUTH,
        json={
            "device_id": "devA",
            "ops": [{"op": "delete", "node_id": "top", "timestamp": 5_000}],
        },
    )

    after = _info(client)
    # top, mid_a, mid_b, deep_a all go; bar and keep_folder remain.
    assert after["folder_count"] == 2, (
        f"deleting a folder holding 3 nested folders must subtract 4, "
        f"got {before['folder_count']} -> {after['folder_count']}"
    )
    # link_deep and link_top go with it; keep_link remains.
    assert after["bookmark_count"] == 1, after


def test_cascade_is_replayed_to_other_clients(client):
    """Other devices converge only if they receive a delete for EVERY removed id."""
    _seed(client)
    base = client.get(f"{_base()}/delta?since=0", headers=AUTH)
    assert base.status_code == 200
    seen = len(base.json()["ops"])

    client.post(
        f"{_base()}/delta",
        headers=AUTH,
        json={
            "device_id": "devA",
            "ops": [{"op": "delete", "node_id": "top", "timestamp": 5_000}],
        },
    )

    r = client.get(f"{_base()}/delta?since=0", headers=AUTH)
    new_ops = r.json()["ops"][seen:]
    deleted_ids = {o["node_id"] for o in new_ops if o["op"] == "delete"}
    assert DOOMED <= deleted_ids, (
        f"a peer must be told about every removed node, missing: {DOOMED - deleted_ids}"
    )


def test_resending_the_same_folder_delete_is_idempotent(client):
    """Clients retain unacknowledged ops and may resend them; the cascade must not
    append a second set of deltas."""
    _seed(client)
    payload = {
        "device_id": "devA",
        "ops": [{"op": "delete", "node_id": "top", "op_id": "devA:del:top", "timestamp": 5_000}],
    }

    first = client.post(f"{_base()}/delta", headers=AUTH, json=payload)
    assert first.status_code == 200, first.text
    after_first = len(client.get(f"{_base()}/delta?since=0", headers=AUTH).json()["ops"])

    second = client.post(f"{_base()}/delta", headers=AUTH, json=payload)
    assert second.status_code == 200, second.text
    assert second.json()["applied"] == 0, "a replayed delete must not be applied twice"

    after_second = len(client.get(f"{_base()}/delta?since=0", headers=AUTH).json()["ops"])
    assert after_second == after_first, (
        f"the resend appended {after_second - after_first} duplicate delta rows"
    )

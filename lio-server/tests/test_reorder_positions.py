"""Reorder must leave the sibling group in a coherent, propagatable order.

Two defects observed live when dragging a FOLDER in the web UI:

  1. Only the moved node's ``position`` was rewritten, so the rest of the group
     kept stale values and one drag produced duplicate positions (0, 0, 1).
     ``position`` is the only order the extension ever sees -- /bookmarks/tree
     does not return ``sort_key`` -- so an ambiguous position cannot propagate.

  2. With a MIX of NULL and real ``sort_key`` values, the sibling query's
     ``ORDER BY sort_key IS NULL, sort_key`` sorts every keyed row ahead of every
     unkeyed one. Neighbour keys read off unkeyed rows were both None, and
     ``key_between(None, None)`` places the node FIRST regardless of the index the
     drag asked for.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings

TOKEN = "reordertoken1234"


def _settings(tmp_path) -> Settings:
    return Settings(
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
        auto_provision=True,
    )


@pytest.fixture()
def client(tmp_path):
    with TestClient(create_app(_settings(tmp_path))) as c:
        yield c


def _h() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def _seed(client, nodes):
    # Index is per PARENT, not global across the list: a browser numbers each
    # sibling group 0..n-1. Seeding one running counter left groups starting at a
    # nonzero offset, so the first reorder "normalised" positions and looked like
    # a shift that never happened.
    per_parent: dict[str | None, int] = {}
    ops = []
    for n, (nid, parent, title, url, folder) in enumerate(nodes):
        idx = per_parent.get(parent, 0)
        per_parent[parent] = idx + 1
        ops.append(
            {
                "op": "create",
                "node_id": nid,
                "parent_id": parent,
                "index": idx,
                "title": title,
                "url": url,
                "is_folder": folder,
                "timestamp": 1_000 + n,
            }
        )
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta",
        headers=_h(),
        json={"device_id": "seed", "ops": ops},
    )
    assert r.status_code == 200, r.text


def _children(client, parent_id):
    """Sibling group as the EXTENSION sees it: ordered by position alone."""
    r = client.get(f"/api/v1/collections/{TOKEN}/bookmarks/tree", headers=_h())
    assert r.status_code == 200
    kids = [n for n in r.json()["nodes"] if n["parent_id"] == parent_id]
    kids.sort(key=lambda n: n["position"])
    return kids


# Three sibling FOLDERS, seeded with no sort_key at all -- the real starting state
# for a collection built by extension pushes.
FOLDERS = [
    ("bar", None, "Bookmarks Bar", None, True),
    ("fA", "bar", "Alpha", None, True),
    ("fB", "bar", "Beta", None, True),
    ("fC", "bar", "Gamma", None, True),
]


def test_reorder_leaves_positions_contiguous_and_unique(client):
    _seed(client, FOLDERS)

    r = client.patch(
        f"/api/v1/collections/{TOKEN}/bookmarks/fC/reorder",
        headers=_h(),
        json={"parent_id": "bar", "index": 1},
    )
    assert r.status_code == 200, r.text

    kids = _children(client, "bar")
    positions = [n["position"] for n in kids]
    assert positions == list(range(len(kids))), (
        f"positions must be contiguous 0..n-1 for the order to be unambiguous, got {positions}"
    )
    assert len(set(positions)) == len(positions), f"duplicate positions: {positions}"


def test_reorder_honours_the_requested_index_on_unkeyed_siblings(client):
    _seed(client, FOLDERS)

    # Drop Gamma into slot 1: between Alpha and Beta. Nothing has a sort_key yet,
    # which is exactly the case that used to collapse to "first".
    r = client.patch(
        f"/api/v1/collections/{TOKEN}/bookmarks/fC/reorder",
        headers=_h(),
        json={"parent_id": "bar", "index": 1},
    )
    assert r.status_code == 200, r.text

    titles = [n["title"] for n in _children(client, "bar")]
    assert titles == ["Alpha", "Gamma", "Beta"], (
        f"Gamma was dropped at index 1, so it must sit between Alpha and Beta, got {titles}"
    )


def test_reorder_to_last_slot_lands_last(client):
    _seed(client, FOLDERS)

    r = client.patch(
        f"/api/v1/collections/{TOKEN}/bookmarks/fA/reorder",
        headers=_h(),
        json={"parent_id": "bar", "index": 2},
    )
    assert r.status_code == 200, r.text

    titles = [n["title"] for n in _children(client, "bar")]
    assert titles == ["Beta", "Gamma", "Alpha"], f"Alpha must land last, got {titles}"


def test_successive_reorders_stay_coherent(client):
    """Repeated drags must not drift: every pass stays contiguous and ordered."""
    _seed(client, FOLDERS)

    for node_id, index, expected in [
        ("fC", 0, ["Gamma", "Alpha", "Beta"]),
        ("fA", 2, ["Gamma", "Beta", "Alpha"]),
        ("fB", 0, ["Beta", "Gamma", "Alpha"]),
    ]:
        r = client.patch(
            f"/api/v1/collections/{TOKEN}/bookmarks/{node_id}/reorder",
            headers=_h(),
            json={"parent_id": "bar", "index": index},
        )
        assert r.status_code == 200, r.text

        kids = _children(client, "bar")
        positions = [n["position"] for n in kids]
        assert positions == list(range(len(kids))), f"drift after moving {node_id}: {positions}"
        assert [n["title"] for n in kids] == expected, (
            f"after moving {node_id} to {index}: expected {expected}, got {[n['title'] for n in kids]}"
        )


def test_reorder_emits_one_move_delta_the_extension_can_apply(client):
    """The extension applies `move` deltas by index, so the delta must carry the
    same index the tree now reports."""
    _seed(client, FOLDERS)

    before = client.get(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta?since=0", headers=_h()
    )
    assert before.status_code == 200
    seen = len(before.json()["ops"])

    r = client.patch(
        f"/api/v1/collections/{TOKEN}/bookmarks/fC/reorder",
        headers=_h(),
        json={"parent_id": "bar", "index": 1},
    )
    assert r.status_code == 200, r.text

    after = client.get(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta?since=0", headers=_h()
    )
    moves = [o for o in after.json()["ops"][seen:] if o["op"] == "move"]
    assert len(moves) == 1, f"one drag is one move delta, got {len(moves)}"

    reported = moves[0]["payload"]["index"]
    actual = next(n["position"] for n in _children(client, "bar") if n["id"] == "fC")
    assert reported == actual, (
        f"the move delta says index {reported} but the tree says {actual}; "
        "the extension would apply the wrong slot"
    )


def _versions(client, parent_id):
    """Per-row `server_version` as the extension sees it, keyed by id."""
    r = client.get(f"/api/v1/collections/{TOKEN}/bookmarks/tree", headers=_h())
    assert r.status_code == 200
    return {
        n["id"]: (n["position"], n["server_version"])
        for n in r.json()["nodes"]
        if n["parent_id"] == parent_id
    }


def test_every_row_the_reorder_shifts_gets_a_fresh_server_version(client):
    """A drag renumbers SIBLINGS too, and those shifts are server-authored.

    The extension decides who wins a position disagreement by comparing a row's
    `server_version` against the watermark it last consumed. If a shifted sibling
    keeps a stale watermark, the extension concludes it has already seen that row
    and pushes its own (older) position back up -- undoing the server's reorder.
    That is the concurrent-edit case: reorder on the server AND in the browser,
    then resume.
    """
    _seed(client, FOLDERS)
    before = _versions(client, "bar")
    assert [before[i][0] for i in ("fA", "fB", "fC")] == [0, 1, 2], before

    # Move Gamma to the front: Alpha 0->1 and Beta 1->2 are shifted by it.
    r = client.patch(
        f"/api/v1/collections/{TOKEN}/bookmarks/fC/reorder",
        headers=_h(),
        json={"parent_id": "bar", "index": 0},
    )
    assert r.status_code == 200, r.text

    after = _versions(client, "bar")
    assert [after[i][0] for i in ("fC", "fA", "fB")] == [0, 1, 2], after

    for nid in ("fA", "fB", "fC"):
        old_pos, old_ver = before[nid]
        new_pos, new_ver = after[nid]
        assert new_pos != old_pos, f"{nid} should have shifted: {old_pos} -> {new_pos}"
        assert new_ver > old_ver, (
            f"{nid} moved {old_pos} -> {new_pos} but its server_version stayed "
            f"{old_ver}; a client would treat the new position as already-seen "
            f"and push its stale order back up"
        )


def test_a_row_the_reorder_did_not_touch_keeps_its_server_version(client):
    """The bump must be surgical: an untouched row keeps its watermark, so a
    genuine local edit to it is still recognised as a local edit."""
    _seed(client, FOLDERS + [("other", "bar", "Other", None, True)])
    # Sibling group is now Alpha, Beta, Gamma, Other.
    before = _versions(client, "bar")

    # Swap the first two only: Gamma and Other keep their slots.
    r = client.patch(
        f"/api/v1/collections/{TOKEN}/bookmarks/fB/reorder",
        headers=_h(),
        json={"parent_id": "bar", "index": 0},
    )
    assert r.status_code == 200, r.text

    after = _versions(client, "bar")
    assert after["fC"][0] == before["fC"][0], "Gamma's slot should be unchanged"
    assert after["fC"][1] == before["fC"][1], (
        "an unshifted row must keep its server_version, or every reorder would "
        "make the whole group look server-authored"
    )
    assert after["other"][1] == before["other"][1]

"""Bulk reorganize: transactional apply, one resync delta, snapshot + undo.

These cover the guarantees the Organise actions in the web UI depend on. The
important ones are negative: a rejected request must leave the tree untouched,
and a sweeping change must NOT flood the delta log with per-node moves.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings


TOKEN = "reorgtoken123456"


def _settings(tmp_path, *, auto_provision: bool = True) -> Settings:
    return Settings(
        db_path=tmp_path / "reorg.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=10_000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="hunter2",
        admin_username="admin",
        session_secret="fixed-secret",
        auto_provision=auto_provision,
    )


@pytest.fixture()
def client(tmp_path):
    with TestClient(create_app(_settings(tmp_path))) as c:
        yield c


@pytest.fixture()
def strict(tmp_path):
    """Auto-provisioning off — an unknown token must be refused."""
    with TestClient(create_app(_settings(tmp_path, auto_provision=False))) as c:
        yield c


def _h(token: str = TOKEN) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _seed(client, nodes):
    """Push a starting tree via the delta endpoint."""
    ops = []
    for i, (nid, parent, title, url, folder) in enumerate(nodes):
        ops.append(
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
        )
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta",
                headers=_h(),
json={"device_id": "seed", "ops": ops},
    )
    assert r.status_code == 200, r.text
    return r


BASE = [
    ("bar", None, "Bookmarks Bar", None, True),
    ("f1", "bar", "News", None, True),
    ("n1", "f1", "Yahoo", "https://news.yahoo.com/", False),
    ("n2", "f1", "MSN", "https://msn.com/", False),
    ("l1", "bar", "YouTube", "https://youtube.com/", False),
    ("l2", "bar", "Amazon", "https://amazon.com/", False),
]


def _tree(client):
    r = client.get(f"/api/v1/collections/{TOKEN}/bookmarks/tree", headers=_h())
    assert r.status_code == 200
    return {n["id"]: n for n in r.json()["nodes"]}


def _deltas(client, since=0):
    r = client.get(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta",         headers=_h(),
params={"since": since}
    )
    assert r.status_code == 200
    return r.json()["ops"]


def test_reorganize_applies_placements_and_rebuilds_positions(client):
    _seed(client, BASE)
    # Reverse the bar's children.
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
                headers=_h(),
json={
            "label": "Reverse order",
            "placements": [
                {"id": "l2", "parent_id": "bar", "index": 0},
                {"id": "l1", "parent_id": "bar", "index": 1},
                {"id": "f1", "parent_id": "bar", "index": 2},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Reversing three siblings leaves the MIDDLE one where it was, so two move —
    # not three. `moved` reports what visibly changed, matching the preview.
    assert body["moved"] == 2
    assert body["created"] == 0
    assert body["removed"] == 0

    tree = _tree(client)
    assert tree["l2"]["position"] == 0
    assert tree["l1"]["position"] == 1
    assert tree["f1"]["position"] == 2
    # sort_key must agree with position order, or the UI and the browser disagree.
    keys = [tree[i]["id"] for i in ("l2", "l1", "f1")]
    assert keys == ["l2", "l1", "f1"]


def test_reapplying_the_same_order_reports_zero_moved(client):
    """`moved` must mean "changed place", not "row rewritten" — otherwise the
    banner promises one number and the result reports a bigger one."""
    _seed(client, BASE)
    tree = _tree(client)
    kids = sorted(
        [n for n in tree.values() if n["parent_id"] == "bar"], key=lambda n: n["position"]
    )
    same = [{"id": n["id"], "parent_id": "bar", "index": i} for i, n in enumerate(kids)]
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
        headers=_h(),
        json={"label": "no-op", "placements": same},
    )
    assert r.status_code == 200, r.text
    assert r.json()["moved"] == 0


def test_sweeping_change_emits_exactly_one_resync_delta(client):
    """The whole point of the endpoint: one marker, not one op per node."""
    _seed(client, BASE)
    before = len(_deltas(client))
    client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
                headers=_h(),
json={
            "label": "Group by domain",
            "placements": [
                {"id": "l1", "parent_id": "bar", "index": 0},
                {"id": "l2", "parent_id": "bar", "index": 1},
                {"id": "n1", "parent_id": "bar", "index": 2},
                {"id": "n2", "parent_id": "bar", "index": 3},
            ],
        },
    )
    new = _deltas(client)[before:]
    assert len(new) == 1
    assert new[0]["op"] == "resync"
    assert new[0]["origin"] == "web-ui"
    assert new[0]["payload"]["reason"] == "Group by domain"


def test_new_folders_get_real_ids_and_placements_resolve(client):
    _seed(client, BASE)
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
                headers=_h(),
json={
            "label": "Group by domain",
            "new_folders": [
                {"id": "new:google", "parent_id": "bar", "title": "google", "index": 0}
            ],
            "placements": [
                {"id": "new:google", "parent_id": "bar", "index": 0},
                {"id": "l1", "parent_id": "new:google", "index": 0},
            ],
        },
    )
    assert r.status_code == 200, r.text
    real = r.json()["id_map"]["new:google"]
    assert real.startswith("fld_")

    tree = _tree(client)
    assert tree[real]["is_folder"] is True
    assert tree[real]["title"] == "google"
    # The link was re-parented into the freshly minted folder.
    assert tree["l1"]["parent_id"] == real


def test_removed_folder_takes_its_subtree(client):
    _seed(client, BASE)
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
                headers=_h(),
json={"label": "Delete empty folders", "removed": ["f1"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["removed"] == 3  # the folder plus both children

    tree = _tree(client)
    for gone in ("f1", "n1", "n2"):
        assert gone not in tree


def test_dissolving_a_folder_keeps_the_links_it_is_moving_out(client):
    """Group-by-domain deletes the old folders AND relocates their links in one
    request. The removal must not cascade onto the links being moved, or the
    operation would silently destroy bookmarks."""
    _seed(client, BASE)
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
        headers=_h(),
        json={
            "label": "Group by domain",
            # The News folder is dissolved...
            "removed": ["f1"],
            # ...while both of its links are re-parented up to the bar.
            "placements": [
                {"id": "n1", "parent_id": "bar", "index": 0},
                {"id": "n2", "parent_id": "bar", "index": 1},
            ],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["removed"] == 1, "only the folder itself should be removed"

    tree = _tree(client)
    assert "f1" not in tree, "the dissolved folder should be gone"
    assert "n1" in tree and "n2" in tree, "relocated links were destroyed"
    assert tree["n1"]["parent_id"] == "bar"
    assert tree["n2"]["parent_id"] == "bar"


def test_removing_a_folder_without_relocating_still_takes_its_children(client):
    """The cascade is only suppressed for nodes the request actually relocates."""
    _seed(client, BASE)
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
        headers=_h(),
        json={"label": "Delete folder", "removed": ["f1"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["removed"] == 3
    tree = _tree(client)
    for gone in ("f1", "n1", "n2"):
        assert gone not in tree


def test_duplicate_visits_are_summed_into_the_survivor(client):
    _seed(
        client,
        BASE
        + [("dup", "bar", "YouTube copy", "https://youtube.com/", False)],
    )
    client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/visits",
                headers=_h(),
json={
            "increments": [
                {"node_id": "l1", "count": 20},
                {"node_id": "dup", "count": 5},
            ]
        },
    )
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
                headers=_h(),
json={
            "label": "Delete duplicates",
            "removed": ["dup"],
            "merge_visits": [{"survivor": "l1", "absorbed": ["dup"]}],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["visits_merged"] == 1

    usage_rows = client.get(f"/api/v1/collections/{TOKEN}/report/usage", headers=_h()).json()["rows"]
    counts = {row["node_id"]: row["visit_count"] for row in usage_rows}
    assert counts["l1"] == 25  # 20 + the absorbed 5, not 20
    assert "dup" not in counts


# ---- Negative cases: a rejected request must change nothing ---------------


@pytest.mark.parametrize(
    "payload,reason",
    [
        ({"placements": [{"id": "ghost", "parent_id": "bar", "index": 0}]}, "unknown node"),
        (
            {"placements": [{"id": "l1", "parent_id": "ghost", "index": 0}]},
            "unknown parent",
        ),
        (
            {
                "placements": [
                    {"id": "l1", "parent_id": "bar", "index": 0},
                    {"id": "l1", "parent_id": "bar", "index": 1},
                ]
            },
            "placed twice",
        ),
        (
            {
                "removed": ["l1"],
                "placements": [{"id": "l1", "parent_id": "bar", "index": 0}],
            },
            "placed and removed",
        ),
    ],
)
def test_invalid_request_is_rejected_and_tree_is_untouched(client, payload, reason):
    _seed(client, BASE)
    before = _tree(client)
    before_deltas = len(_deltas(client))

    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
                headers=_h(),
json={"label": "bad", **payload},
    )
    assert r.status_code == 400, f"{reason}: {r.status_code} {r.text}"

    assert _tree(client) == before, f"{reason} left the tree modified"
    assert len(_deltas(client)) == before_deltas, f"{reason} still wrote a delta"
    # A rejected apply must not leave an undo entry behind either.
    snaps = client.get(f"/api/v1/collections/{TOKEN}/bookmarks/snapshots", headers=_h()).json()
    assert snaps["snapshots"] == []


def test_real_browser_tree_without_a_root_container_row_is_accepted(client):
    """Regression: a real synced tree has NO row for the browser's hidden root.

    The extension syncs "Bookmarks Bar" with parent_id "0" but never syncs node
    "0" itself, so "0" is referenced as a parent by a row that exists while
    having no row of its own. Rejecting it as unknown broke every organise action
    against a real collection, while the seeded test fixture (which did create
    node "0") passed.
    """
    # Note: NO node with id "0" — exactly like a real device's first sync.
    _seed(
        client,
        [
            ("1", "0", "Bookmarks Bar", None, True),
            ("a", "1", "Alpha", "https://a.com/", False),
            ("b", "1", "Beta", "https://b.com/", False),
        ],
    )
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
        headers=_h(),
        json={
            "label": "Alphabetical",
            # The root itself is placed, still referencing the phantom parent "0".
            "placements": [
                {"id": "1", "parent_id": "0", "index": 0},
                {"id": "b", "parent_id": "1", "index": 0},
                {"id": "a", "parent_id": "1", "index": 1},
            ],
        },
    )
    assert r.status_code == 200, r.text
    tree = _tree(client)
    assert tree["b"]["position"] == 0
    assert tree["a"]["position"] == 1
    # The root keeps its phantom parent rather than being orphaned.
    assert tree["1"]["parent_id"] == "0"


def test_a_genuinely_unknown_parent_is_still_rejected(client):
    """The phantom-parent allowance must not become a blanket pass."""
    _seed(client, BASE)
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
        headers=_h(),
        json={
            "label": "bad",
            "placements": [{"id": "l1", "parent_id": "nonsense", "index": 0}],
        },
    )
    assert r.status_code == 400
    assert "Unknown parent" in r.text


def test_cycle_is_rejected(client):
    _seed(client, BASE)
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
                headers=_h(),
json={
            "label": "cycle",
            "placements": [
                {"id": "f1", "parent_id": "bar", "index": 0},
                {"id": "bar", "parent_id": "f1", "index": 0},
            ],
        },
    )
    assert r.status_code == 400
    assert "cycle" in r.text.lower()


# ---- Undo ----------------------------------------------------------------


def test_undo_restores_the_previous_arrangement_exactly(client):
    _seed(client, BASE)
    before = _tree(client)

    client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
                headers=_h(),
json={
            "label": "Reverse order",
            "placements": [
                {"id": "l2", "parent_id": "bar", "index": 0},
                {"id": "l1", "parent_id": "bar", "index": 1},
                {"id": "f1", "parent_id": "bar", "index": 2},
            ],
        },
    )
    assert _tree(client) != before

    r = client.post(f"/api/v1/collections/{TOKEN}/bookmarks/undo", headers=_h())
    assert r.status_code == 200, r.text
    assert r.json()["label"] == "Reverse order"
    assert r.json()["remaining_snapshots"] == 0

    after = _tree(client)
    for nid, node in before.items():
        assert after[nid]["parent_id"] == node["parent_id"]
        assert after[nid]["position"] == node["position"]


def test_undo_restores_deleted_nodes_and_their_visit_counts(client):
    """Undo must be the inverse of apply, including the visit merge."""
    _seed(client, BASE + [("dup", "bar", "YouTube copy", "https://youtube.com/", False)])
    client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/visits",
                headers=_h(),
json={
            "increments": [
                {"node_id": "l1", "count": 20},
                {"node_id": "dup", "count": 5},
            ]
        },
    )
    client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
                headers=_h(),
json={
            "label": "Delete duplicates",
            "removed": ["dup"],
            "merge_visits": [{"survivor": "l1", "absorbed": ["dup"]}],
        },
    )
    client.post(f"/api/v1/collections/{TOKEN}/bookmarks/undo", headers=_h())

    rows = client.get(f"/api/v1/collections/{TOKEN}/report/usage", headers=_h()).json()["rows"]
    counts = {row["node_id"]: row["visit_count"] for row in rows}
    assert "dup" in counts, "undo did not bring the duplicate back"
    assert counts["dup"] == 5
    assert counts["l1"] == 20, "survivor kept the absorbed visits after undo"


def test_undo_does_not_resurrect_nodes_deleted_after_organize(client):
    """Undo must invert the organize, NOT time-travel and resurrect later deletes."""
    _seed(client, BASE)
    # 1. Organize into a new folder.
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
        headers=_h(),
        json={
            "label": "Group into folder",
            "new_folders": [{"id": "new:sub", "parent_id": "bar", "title": "Sub", "index": 0}],
            "placements": [
                {"id": "l1", "parent_id": "new:sub", "index": 0},
                {"id": "l2", "parent_id": "new:sub", "index": 1},
            ],
        },
    )
    assert r.status_code == 200
    # 2. User deletes l1 afterwards.
    del_r = client.delete(f"/api/v1/collections/{TOKEN}/bookmarks/l1", headers=_h())
    assert del_r.status_code == 200
    assert "l1" not in _tree(client)
    # 3. User undos the organize.
    undo_r = client.post(f"/api/v1/collections/{TOKEN}/bookmarks/undo", headers=_h())
    assert undo_r.status_code == 200
    tree = _tree(client)
    assert "l1" not in tree, "undo resurrected a link the user deleted afterwards"
    assert "l2" in tree, "undo should keep l2"
    assert tree["l2"]["parent_id"] == "bar", "l2 should be moved back out of the domain folder"
    assert not any(n.get("title") == "Sub" for n in tree.values()), "new folder should be dropped"



def test_undo_surgical_preserves_post_action_rename(client):
    """Undo's surgical path must preserve a post-action rename while reverting structure."""
    _seed(client, BASE)
    # 1. Organize into a new folder.
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
        headers=_h(),
        json={
            "label": "Group into folder",
            "new_folders": [{"id": "new:sub", "parent_id": "bar", "title": "Sub", "index": 0}],
            "placements": [
                {"id": "l1", "parent_id": "new:sub", "index": 0},
            ],
        },
    )
    assert r.status_code == 200
    # 2. Rename l1 afterwards with fresh timestamp > organize time.
    import time
    fresh_ts = int(time.time() * 1000) + 2000
    r_rename = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta",
        headers=_h(),
        json={
            "device_id": "d",
            "ops": [
                {"op": "update", "node_id": "l1", "title": "Renamed After Organize", "timestamp": fresh_ts},
            ],
        },
    )
    assert r_rename.status_code == 200
    assert r_rename.json()["applied"] == 1
    # 3. Undo the organize.
    undo_r = client.post(f"/api/v1/collections/{TOKEN}/bookmarks/undo", headers=_h())
    assert undo_r.status_code == 200
    tree = _tree(client)
    assert tree["l1"]["parent_id"] == "bar", "structure reverted: l1 moved back to bar"
    assert tree["l1"]["title"] == "Renamed After Organize", "post-action rename preserved"

def test_undo_with_no_snapshot_is_404(client):
    _seed(client, BASE)
    r = client.post(f"/api/v1/collections/{TOKEN}/bookmarks/undo", headers=_h())
    assert r.status_code == 404


def test_snapshot_stack_is_capped_at_five(client):
    _seed(client, BASE)
    for i in range(7):
        r = client.post(
            f"/api/v1/collections/{TOKEN}/bookmarks/reorganize",
                    headers=_h(),
json={
                "label": f"pass {i}",
                "placements": [{"id": "l1", "parent_id": "bar", "index": 0}],
            },
        )
        assert r.status_code == 200
    snaps = client.get(f"/api/v1/collections/{TOKEN}/bookmarks/snapshots", headers=_h()).json()[
        "snapshots"
    ]
    assert len(snaps) == 5
    assert snaps[0]["label"] == "pass 6"  # newest first
    assert snaps[-1]["label"] == "pass 2"  # oldest two dropped


def test_reorganize_requires_a_valid_token(strict):
    """An unknown token must be refused, not auto-provisioned into a phantom
    collection that silently accepts a whole-tree rearrangement."""
    bogus = "not-a-real-token"
    r = strict.post(
        f"/api/v1/collections/{bogus}/bookmarks/reorganize",
        headers=_h(bogus),
        json={"label": "x", "placements": []},
    )
    assert r.status_code == 404

    # And with no credential at all.
    r = strict.post(
        f"/api/v1/collections/{bogus}/bookmarks/reorganize",
        json={"label": "x", "placements": []},
    )
    assert r.status_code == 401


def test_device_cannot_push_a_resync_marker(client):
    _seed(client, BASE)
    r = client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta",
                headers=_h(),
json={
            "device_id": "rogue",
            "ops": [{"op": "resync", "node_id": "*", "timestamp": 9_000}],
        },
    )
    assert r.status_code == 200
    assert r.json()["applied"] == 0
    assert r.json()["skipped_stale"] == 1


# ---- delta op fidelity ----------------------------------------------------
# Regression cover for silent data loss: the upsert used to write EVERY column
# from EVERY op, so an `update` (title only) nulled parent_id and position, and a
# `move` (parent/index only) blanked title and url. Both were observed against a
# real browser: renaming orphaned a node to the top level, moving erased its name
# and address.


def test_update_op_preserves_parent_and_position(client):
    _seed(client, BASE)
    client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta",
        headers=_h(),
        json={"device_id": "d", "ops": [
            {"op": "update", "node_id": "n1", "title": "Yahoo Renamed",
             "url": "https://news.yahoo.com/", "timestamp": 9_000},
        ]},
    )
    tree = _tree(client)
    assert tree["n1"]["title"] == "Yahoo Renamed"
    assert tree["n1"]["parent_id"] == "f1", "rename must not orphan the node"


def test_move_op_preserves_title_and_url(client):
    _seed(client, BASE)
    client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta",
        headers=_h(),
        json={"device_id": "d", "ops": [
            {"op": "move", "node_id": "n1", "parent_id": "bar", "index": 0,
             "timestamp": 9_000},
        ]},
    )
    tree = _tree(client)
    assert tree["n1"]["parent_id"] == "bar"
    assert tree["n1"]["position"] == 0
    assert tree["n1"]["title"] == "Yahoo", "move must not blank the title"
    assert tree["n1"]["url"] == "https://news.yahoo.com/", "move must not blank the url"


def test_update_for_an_unknown_node_still_inserts_it(client):
    """A device may legitimately push an update for a node we have never seen."""
    _seed(client, BASE)
    client.post(
        f"/api/v1/collections/{TOKEN}/bookmarks/delta",
        headers=_h(),
        json={"device_id": "d", "ops": [
            {"op": "update", "node_id": "brandnew", "parent_id": "bar", "index": 0,
             "title": "New", "url": "https://new.example/", "timestamp": 9_000},
        ]},
    )
    assert "brandnew" in _tree(client)

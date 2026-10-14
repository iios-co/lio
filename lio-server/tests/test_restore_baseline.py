import pytest
from starlette.testclient import TestClient

from lio_server import db
from lio_server.app import create_app
from lio_server.config import Settings

TOKEN = "tok123"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture()
def client(tmp_path):
    settings = Settings(
        db_path=tmp_path / "test_baseline.db",
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


def _base(token=TOKEN):
    return f"/api/v1/collections/{token}/bookmarks"


def test_restore_baseline_validation(client):
    # 1. Empty nodes list rejected
    r = client.post(f"{_base()}/restore-baseline", headers=AUTH, json={
        "label": "empty",
        "expected_server_version": 0,
        "expected_active_count": 0,
        "nodes": [],
    })
    assert r.status_code == 400
    assert "empty" in r.json()["detail"].lower()

    # 2. Duplicate node IDs rejected
    r = client.post(f"{_base()}/restore-baseline", headers=AUTH, json={
        "label": "dupe",
        "expected_server_version": 0,
        "expected_active_count": 0,
        "nodes": [
            {"id": "bm_1", "parent_id": "1", "is_folder": False, "title": "A", "url": "https://a.com"},
            {"id": "bm_1", "parent_id": "1", "is_folder": False, "title": "B", "url": "https://b.com"},
        ],
    })
    assert r.status_code == 400
    assert "duplicate" in r.json()["detail"].lower()

    # 3. Missing parent rejected
    r = client.post(f"{_base()}/restore-baseline", headers=AUTH, json={
        "label": "missing parent",
        "expected_server_version": 0,
        "expected_active_count": 0,
        "nodes": [
            {"id": "bm_1", "parent_id": "nonexistent_folder", "is_folder": False, "title": "A", "url": "https://a.com"},
        ],
    })
    assert r.status_code == 400
    assert "missing parent" in r.json()["detail"].lower()

    # 4. Parent is a link (not a folder) rejected
    r = client.post(f"{_base()}/restore-baseline", headers=AUTH, json={
        "label": "parent is link",
        "expected_server_version": 0,
        "expected_active_count": 0,
        "nodes": [
            {"id": "bm_link", "parent_id": "1", "is_folder": False, "title": "Link", "url": "https://a.com"},
            {"id": "bm_child", "parent_id": "bm_link", "is_folder": False, "title": "Child", "url": "https://b.com"},
        ],
    })
    assert r.status_code == 400
    assert "not a folder" in r.json()["detail"].lower()

    # 5. Self-parent cycle rejected
    r = client.post(f"{_base()}/restore-baseline", headers=AUTH, json={
        "label": "self parent",
        "expected_server_version": 0,
        "expected_active_count": 0,
        "nodes": [
            {"id": "f_cycle", "parent_id": "f_cycle", "is_folder": True, "title": "Cycle Folder"},
        ],
    })
    assert r.status_code == 400

    # 6. Arbitrary-length multi-node cycle rejected (e.g. A -> B -> C -> A)
    r = client.post(f"{_base()}/restore-baseline", headers=AUTH, json={
        "label": "3-node cycle",
        "expected_server_version": 0,
        "expected_active_count": 0,
        "nodes": [
            {"id": "f_a", "parent_id": "f_c", "is_folder": True, "title": "A"},
            {"id": "f_b", "parent_id": "f_a", "is_folder": True, "title": "B"},
            {"id": "f_c", "parent_id": "f_b", "is_folder": True, "title": "C"},
        ],
    })
    assert r.status_code == 400
    assert "cycle" in r.json()["detail"].lower()


def test_restore_baseline_concurrency_and_tombstone_isolation(client):
    # Setup: 1 active bookmark, 2 tombstoned bookmarks
    client.post(f"{_base()}/delta", headers=AUTH, json={
        "device_id": "dev-setup",
        "ops": [
            {"op": "create", "node_id": "tomb_1", "is_folder": False, "title": "Tombstone 1", "url": "https://t1.com", "timestamp": 100},
            {"op": "create", "node_id": "tomb_2", "is_folder": False, "title": "Tombstone 2", "url": "https://t2.com", "timestamp": 101},
            {"op": "create", "node_id": "active_keep", "is_folder": False, "title": "Active Keep", "url": "https://keep.com", "timestamp": 102},
            {"op": "delete", "node_id": "tomb_1", "timestamp": 200},
            {"op": "delete", "node_id": "tomb_2", "timestamp": 201},
        ],
    })

    tree = client.get(f"{_base()}/tree", headers=AUTH).json()
    assert len(tree["nodes"]) == 1
    assert tree["nodes"][0]["id"] == "active_keep"
    cur_version = tree["server_version"]

    # 1. Stale active count rejected with 409
    r = client.post(f"{_base()}/restore-baseline", headers=AUTH, json={
        "label": "stale count",
        "expected_server_version": cur_version,
        "expected_active_count": 999,
        "nodes": [{"id": "tomb_1", "parent_id": "1", "is_folder": False, "title": "Revived", "url": "https://t1.com"}],
    })
    assert r.status_code == 409

    # 2. Stale server version rejected with 409
    r = client.post(f"{_base()}/restore-baseline", headers=AUTH, json={
        "label": "stale version",
        "expected_server_version": cur_version + 999,
        "expected_active_count": 1,
        "nodes": [{"id": "tomb_1", "parent_id": "1", "is_folder": False, "title": "Revived", "url": "https://t1.com"}],
    })
    assert r.status_code == 409

    # 3. Successful restore: revives ONLY tomb_1, keeps tomb_2 deleted, and preserves active_keep
    r = client.post(f"{_base()}/restore-baseline", headers=AUTH, json={
        "label": "authoritative restore",
        "expected_server_version": cur_version,
        "expected_active_count": 1,
        "nodes": [
            {"id": "active_keep", "parent_id": "1", "is_folder": False, "title": "Active Keep", "url": "https://keep.com"},
            {"id": "tomb_1", "parent_id": "1", "is_folder": False, "title": "Revived T1", "url": "https://t1.com"},
        ],
    })
    assert r.status_code == 200
    data = r.json()
    assert data["restored"] == 2
    assert data["server_version"] > cur_version

    # Verify server state:
    new_tree = client.get(f"{_base()}/tree", headers=AUTH).json()
    new_ids = {n["id"] for n in new_tree["nodes"]}
    assert new_ids == {"active_keep", "tomb_1"}

    # Verify tomb_2 is STILL deleted in DB (never revived by accident)
    with db.get_conn() as conn:
        tomb2_row = conn.execute("SELECT deleted FROM bookmarks WHERE id = 'tomb_2'").fetchone()
        assert tomb2_row is not None
        assert tomb2_row["deleted"] == 1


def test_restore_baseline_838_node_convergence(client):
    # Simulate exact incident:
    # 1. Initial 838 nodes exist on server, then get wiped/tombstoned (Server active count: 0)
    setup_ops = []
    for i in range(1, 839):
        setup_ops.append({"op": "create", "node_id": f"bm_{i}", "parent_id": "1", "is_folder": False, "title": f"Link {i}", "url": f"https://example.com/{i}", "timestamp": 100})
    for i in range(1, 839):
        setup_ops.append({"op": "delete", "node_id": f"bm_{i}", "timestamp": 200})

    # Batch post setup
    for i in range(0, len(setup_ops), 500):
        client.post(f"{_base()}/delta", headers=AUTH, json={"device_id": "dev-setup", "ops": setup_ops[i:i+500]})

    # Server state is now: 0 active nodes, but 838 tombstones exist in DB
    tree0 = client.get(f"{_base()}/tree", headers=AUTH).json()
    assert len(tree0["nodes"]) == 0
    cur_ver = tree0["server_version"]
    assert cur_ver > 0

    # 2. Authoritative restore with 838 nodes from backup
    restore_nodes = [
        {"id": f"bm_{i}", "parent_id": "1", "position": i - 1, "is_folder": False, "title": f"Restored Link {i}", "url": f"https://example.com/{i}"}
        for i in range(1, 839)
    ]
    r = client.post(f"{_base()}/restore-baseline", headers=AUTH, json={
        "label": "Restore 838 from backup",
        "expected_server_version": cur_ver,
        "expected_active_count": 0,
        "nodes": restore_nodes,
    })
    assert r.status_code == 200
    res = r.json()
    assert res["restored"] == 838

    # 3. Server now reflects all 838 active nodes
    tree_after = client.get(f"{_base()}/tree", headers=AUTH).json()
    assert len(tree_after["nodes"]) == 838
    assert tree_after["server_version"] > cur_ver


def test_restore_baseline_accepts_canonical_menu_root(client):
    tree0 = client.get(f"{_base()}/tree", headers=AUTH).json()
    cur_ver = tree0["server_version"]
    cur_count = len(tree0["nodes"])
    r = client.post(f"{_base()}/restore-baseline", headers=AUTH, json={
        "label": "menu root test",
        "expected_server_version": cur_ver,
        "expected_active_count": cur_count,
        "nodes": [
            {"id": "bm_menu_1", "parent_id": "menu", "is_folder": False, "title": "Menu Item", "url": "https://menu.example"},
        ],
    })
    assert r.status_code == 200
    assert r.json()["restored"] == 1

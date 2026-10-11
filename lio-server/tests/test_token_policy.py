"""Token policy: an unknown token must be REJECTED, not silently provisioned.

Regression cover for a real incident: with open-mode auto-provisioning, a device
holding a deleted collection's token kept getting 200s from a phantom collection
the server invented (named after the token), so the extension displayed a healthy
green "synced" state while writing nowhere the user could see.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings


def _settings(tmp_path, *, auto_provision: bool) -> Settings:
    return Settings(
        db_path=tmp_path / "policy.db",
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
def strict(tmp_path):
    with TestClient(create_app(_settings(tmp_path, auto_provision=False))) as c:
        yield c


@pytest.fixture()
def open_mode(tmp_path):
    with TestClient(create_app(_settings(tmp_path, auto_provision=True))) as c:
        yield c


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_unknown_token_is_rejected_by_default(strict):
    bad = "staletoken1234567"
    for path in ("/bookmarks/tree", "/info", "/tabs"):
        r = strict.get(f"/api/v1/collections/{bad}{path}", headers=_h(bad))
        assert r.status_code == 404, f"{path} should reject an unknown token"

    # And it must NOT have invented a collection as a side effect.
    strict.post("/admin/login", json={"username": "admin", "password": "hunter2"})
    assert strict.get("/admin/collections").json()["collections"] == []


def test_pushing_with_unknown_token_is_rejected(strict):
    bad = "staletoken1234567"
    r = strict.post(
        f"/api/v1/collections/{bad}/bookmarks/delta",
        headers=_h(bad),
        json={"device_id": "d", "ops": [
            {"op": "create", "node_id": "x", "title": "X",
             "url": "https://x.com", "timestamp": 1}
        ]},
    )
    assert r.status_code == 404


def test_real_token_reports_its_identity(strict):
    strict.post("/admin/login", json={"username": "admin", "password": "hunter2"})
    made = strict.post("/admin/collections", json={"name": "Personal"}).json()
    token = made["token"]

    info = strict.get(f"/api/v1/collections/{token}/info", headers=_h(token))
    assert info.status_code == 200
    body = info.json()
    assert body["name"] == "Personal"
    assert body["id"] == made["id"]
    assert body["bookmark_count"] == 0


def test_open_mode_still_available_when_explicitly_enabled(open_mode):
    token = "freshtoken1234567"
    r = open_mode.get(f"/api/v1/collections/{token}/info", headers=_h(token))
    assert r.status_code == 200
    # Provisioned collections are named after their token — the phantom signature.
    assert r.json()["name"] == token

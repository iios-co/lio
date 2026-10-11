"""First-run setup flow: no env password, set one via /admin/setup."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings


@pytest.fixture()
def client(tmp_path):
    # No env admin_password → first-run setup is required.
    settings = Settings(
        db_path=tmp_path / "setup.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=10_000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="",
        admin_username="admin",  # not configured via env
        session_secret="fixed-secret",
    )
    with TestClient(create_app(settings)) as c:
        yield c


def test_state_reports_setup_needed(client):
    st = client.get("/admin/state").json()
    assert st["setup_needed"] is True
    assert st["authenticated"] is False


def test_login_refused_before_setup(client):
    r = client.post("/admin/login", json={"username": "owner", "password": "whatever12"})
    assert r.status_code == 409  # no password set yet


def test_setup_sets_password_and_logs_in(client):
    r = client.post("/admin/setup", json={"username": "owner", "password": "correct horse battery"})
    assert r.status_code == 200
    # Cookie set → already authenticated.
    st = client.get("/admin/state").json()
    assert st["setup_needed"] is False
    assert st["authenticated"] is True
    # Admin routes now work.
    assert client.get("/admin/collections").status_code == 200


def test_setup_rejects_short_password(client):
    r = client.post("/admin/setup", json={"username": "owner", "password": "short"})
    assert r.status_code == 422  # min_length=8


def test_setup_refused_once_configured(client):
    assert client.post("/admin/setup", json={"username": "owner", "password": "correct horse battery"}).status_code == 200
    # Second setup attempt is refused.
    r = client.post("/admin/setup", json={"username": "owner", "password": "another password"})
    assert r.status_code == 409


def test_login_after_setup_with_fresh_client(client, tmp_path):
    client.post("/admin/setup", json={"username": "owner", "password": "correct horse battery"})
    client.cookies.clear()
    assert client.get("/admin/state").json()["authenticated"] is False
    # Wrong password rejected.
    assert client.post("/admin/login", json={"username": "owner", "password": "wrong"}).status_code == 401
    # Correct password but WRONG username rejected.
    assert (
        client.post(
            "/admin/login", json={"username": "someone", "password": "correct horse battery"}
        ).status_code
        == 401
    )
    # Correct username + password accepted.
    assert (
        client.post("/admin/login", json={"username": "owner", "password": "correct horse battery"}).status_code
        == 200
    )

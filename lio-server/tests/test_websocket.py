"""Tests for real-time WebSocket push service."""

import pytest
from fastapi.testclient import TestClient

from lio_server.app import create_app
from lio_server.config import Settings


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        db_path=tmp_path / "test_ws.db",
        host="127.0.0.1",
        port=8787,
        allowed_tokens=frozenset(),
        delta_log_max_rows=1000,
        deadlink_check_enabled=False,
        deadlink_allow_private=False,
        admin_password="password123",
        admin_username="admin",
        session_secret="test-secret",
        auto_provision=True,
    )
    app = create_app(settings)
    with TestClient(app) as tc:
        tc.post("/admin/login", json={"username": "admin", "password": "password123"})
        r = tc.post("/admin/collections", json={"name": "Work"})
        assert r.status_code == 200
        token = r.json()["token"]
        tc.token = token
        yield tc


def test_websocket_invalid_token(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/api/v1/collections/invalid_token_xyz/ws") as ws:
            ws.receive_json()


def test_websocket_connected_and_ping_pong(client):
    with client.websocket_connect(f"/api/v1/collections/{client.token}/ws?device_id=dev1") as ws:
        msg = ws.receive_json()
        assert msg["event"] == "connected"
        assert msg["device_id"] == "dev1"
        assert "cid" in msg

        ws.send_json({"action": "ping"})
        pong = ws.receive_json()
        assert pong["event"] == "pong"


def test_websocket_broadcasts_on_delta_push(client):
    with client.websocket_connect(f"/api/v1/collections/{client.token}/ws?device_id=dev2") as ws:
        msg = ws.receive_json()
        assert msg["event"] == "connected"

        auth_headers = {"Authorization": f"Bearer {client.token}"}
        # Push delta from dev1
        r = client.post(
            f"/api/v1/collections/{client.token}/bookmarks/delta",
            headers=auth_headers,
            json={
                "device_id": "dev1",
                "ops": [
                    {
                        "op": "create",
                        "node_id": "b1",
                        "parent_id": "1",
                        "index": 0,
                        "title": "Example",
                        "url": "https://example.com",
                        "timestamp": 1000,
                    }
                ],
            },
        )
        assert r.status_code == 200

        # dev2 must receive the broadcast
        event = ws.receive_json()
        assert event["event"] == "bookmarks_updated"
        assert event["origin"] == "dev1"
        assert event["op"] == "delta"


def test_websocket_broadcasts_on_delete_and_reorganize(client):
    auth_headers = {"Authorization": f"Bearer {client.token}"}
    # Create a bookmark first
    client.post(
        f"/api/v1/collections/{client.token}/bookmarks/delta",
        headers=auth_headers,
        json={
            "device_id": "dev1",
            "ops": [
                {
                    "op": "create",
                    "node_id": "b1",
                    "parent_id": "1",
                    "index": 0,
                    "title": "Example",
                    "url": "https://example.com",
                    "timestamp": 1000,
                }
            ],
        },
    )

    with client.websocket_connect(f"/api/v1/collections/{client.token}/ws?device_id=ext1") as ws:
        ws.receive_json()  # connected event

        # Delete node
        r = client.delete(
            f"/api/v1/collections/{client.token}/bookmarks/b1",
            headers=auth_headers,
        )
        assert r.status_code == 200

        event = ws.receive_json()
        assert event["event"] == "bookmarks_updated"
        assert event["op"] == "delete"
        assert event["origin"] == "web-ui"

        # Reorganize
        r = client.post(
            f"/api/v1/collections/{client.token}/bookmarks/reorganize",
            headers=auth_headers,
            json={
                "label": "Test Reorganize",
                "placements": [],
                "removed": [],
            },
        )
        assert r.status_code == 200

        event2 = ws.receive_json()
        assert event2["event"] == "bookmarks_updated"
        assert event2["op"] == "resync"
        assert event2["origin"] == "web-ui"


def test_websocket_tabs_broadcast_and_idempotency(client):
    auth_headers = {"Authorization": f"Bearer {client.token}"}
    with client.websocket_connect(f"/api/v1/collections/{client.token}/ws?device_id=listener") as ws:
        ws.receive_json()  # connected event

        # dev1 pushes tabs -> broadcast must arrive at listener
        r = client.put(
            f"/api/v1/collections/{client.token}/tabs/dev1",
            headers=auth_headers,
            json={
                "device_name": "Laptop",
                "session_json": '{"tabs":[{"title":"A","url":"https://a.com"}]}',
                "updated_at": 1000,
            },
        )
        assert r.status_code == 204

        event = ws.receive_json()
        assert event["event"] == "tabs_updated"
        assert event["origin"] == "dev1"
        assert event["device_id"] == "dev1"

        # dev1 pushes IDENTICAL tabs -> no broadcast should be sent
        r = client.put(
            f"/api/v1/collections/{client.token}/tabs/dev1",
            headers=auth_headers,
            json={
                "device_name": "Laptop",
                "session_json": '{"tabs":[{"title":"A","url":"https://a.com"}]}',
                "updated_at": 2000,
            },
        )
        assert r.status_code == 204

        # Send ping to verify no tabs_updated was queued
        ws.send_json({"action": "ping"})
        msg = ws.receive_json()
        assert msg["event"] == "pong", f"Expected pong but got {msg}"

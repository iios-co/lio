"""Migration test: a legacy token-keyed database upgrades to the cid schema."""

from __future__ import annotations

import sqlite3

from lio_server import db


# The original shipped shape: collections keyed on token, children carry `token`.
_LEGACY = """
CREATE TABLE collections (token TEXT PRIMARY KEY, name TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE bookmarks (
    id TEXT NOT NULL, token TEXT NOT NULL, parent_id TEXT, position INTEGER NOT NULL,
    title TEXT NOT NULL, url TEXT, is_folder INTEGER NOT NULL DEFAULT 0,
    date_added INTEGER, date_modified INTEGER, icon_base64 TEXT,
    PRIMARY KEY (token, id));
CREATE TABLE delta_log (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL,
    op TEXT NOT NULL, node_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    timestamp INTEGER NOT NULL, origin TEXT);
CREATE TABLE device_tabs (device_id TEXT NOT NULL, token TEXT NOT NULL,
    device_name TEXT NOT NULL, session_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (token, device_id));
CREATE TABLE link_status (token TEXT NOT NULL, node_id TEXT NOT NULL, http_status INTEGER,
    ok INTEGER, checked_at INTEGER, error TEXT, PRIMARY KEY (token, node_id));
"""


def test_legacy_upgrade_preserves_data(tmp_path):
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(_LEGACY)
    conn.execute("INSERT INTO collections (token, name) VALUES ('tok1', 'Work')")
    conn.execute(
        "INSERT INTO bookmarks (id, token, parent_id, position, title, url, is_folder) "
        "VALUES ('n1', 'tok1', NULL, 0, 'Old', 'https://old.example.com', 0)"
    )
    conn.execute(
        "INSERT INTO device_tabs (device_id, token, device_name, session_json, updated_at) "
        "VALUES ('d1', 'tok1', 'Laptop', '[]', 123)"
    )
    conn.commit()
    conn.close()

    migrated = db.init_db(path)
    try:
        # New identity model in place.
        ccols = {r["name"] for r in migrated.execute("PRAGMA table_info(collections)")}
        assert "id" in ccols and "token" in ccols and "token_rotated_at" in ccols
        bcols = {r["name"] for r in migrated.execute("PRAGMA table_info(bookmarks)")}
        assert "cid" in bcols and "token" not in bcols

        # Collection retained its token and got a stable id.
        col = migrated.execute("SELECT id, token, name FROM collections").fetchone()
        assert col["token"] == "tok1" and col["name"] == "Work"
        assert col["id"].startswith("col_")

        # Child rows re-pointed to the cid.
        bm = migrated.execute(
            "SELECT cid, title FROM bookmarks WHERE id = 'n1'"
        ).fetchone()
        assert bm["cid"] == col["id"] and bm["title"] == "Old"
        dt = migrated.execute("SELECT cid FROM device_tabs WHERE device_id = 'd1'").fetchone()
        assert dt["cid"] == col["id"]

        # No leftover __old tables.
        tables = {
            r["name"]
            for r in migrated.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert not any(t.endswith("__old") for t in tables)
    finally:
        db.close_db()


def test_fresh_db_is_cid_keyed(tmp_path):
    conn = db.init_db(tmp_path / "new.db")
    try:
        bcols = {r["name"] for r in conn.execute("PRAGMA table_info(bookmarks)")}
        assert "cid" in bcols and "token" not in bcols
    finally:
        db.close_db()


def test_init_db_idempotent(tmp_path):
    path = tmp_path / "x.db"
    db.init_db(path)
    db.close_db()
    db.init_db(path)  # must not raise
    db.close_db()

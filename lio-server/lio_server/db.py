"""SQLite access layer for lio-server.

A single module-level connection is used with SQLite's WAL journal mode, which
supports one writer plus concurrent readers. FastAPI runs route handlers in a
threadpool, so the connection is created with ``check_same_thread=False`` and all
writes are serialized through a module-level lock to keep them safe.
"""

from __future__ import annotations

import secrets
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

_SCHEMA_PATH = Path(__file__).with_name("schema.sql")

_db_path: Path | None = None
_write_conn: sqlite3.Connection | None = None
_conn: sqlite3.Connection | None = None
_write_lock = threading.Lock()
_local = threading.local()
_open_conns_lock = threading.Lock()
_open_conns: set[sqlite3.Connection] = set()


def _create_connection(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA cache_size = -32000")     # 32 MB
    conn.execute("PRAGMA mmap_size = 268435456")   # 256 MB
    conn.execute("PRAGMA wal_autocheckpoint = 512")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: Path) -> sqlite3.Connection:
    """Open (creating if needed) the database, upgrade its shape if legacy, then
    apply the current schema and reconcile added columns/indexes."""
    global _conn, _write_conn, _db_path
    close_db()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    _db_path = db_path
    conn = _create_connection(db_path)
    # A legacy (token-keyed) DB must be converted BEFORE the current schema is
    # applied, because CREATE TABLE IF NOT EXISTS won't reshape existing tables.
    _upgrade_identity_model(conn)

    conn.executescript(_SCHEMA_PATH.read_text(encoding="utf-8"))
    _migrate(conn)
    conn.commit()
    _write_conn = conn
    _conn = conn
    return conn


_BOOKMARK_ADDED_COLUMNS: tuple[tuple[str, str], ...] = (
    ("sort_key", "TEXT"),
    ("visit_count", "INTEGER NOT NULL DEFAULT 0"),
    ("last_visited_at", "INTEGER"),
    ("domain", "TEXT"),
    ("deleted", "INTEGER NOT NULL DEFAULT 0"),
    ("server_version", "INTEGER NOT NULL DEFAULT 0"),
)

_DELTA_LOG_ADDED_COLUMNS: tuple[tuple[str, str], ...] = (
    ("op_id", "TEXT"),
    ("client_seq", "INTEGER"),
)

_SNAPSHOT_ADDED_COLUMNS: tuple[tuple[str, str], ...] = (
    ("created_json", "TEXT"),
    ("removed_json", "TEXT"),
)
_DEVICE_TABS_ADDED_COLUMNS: tuple[tuple[str, str], ...] = (
    ("tab_count", "INTEGER NOT NULL DEFAULT 0"),
)

_ALLOWED_TABLES = frozenset({
    "bookmarks", "delta_log", "device_tabs", "link_status",
    "collections", "tree_snapshots", "app_settings", "tab_session_history"
})


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    if table not in _ALLOWED_TABLES:
        raise ValueError(f"Unknown or disallowed table: {table}")
    return {
        row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
    }




def _is_legacy(conn: sqlite3.Connection) -> bool:
    """Legacy = the pre-rotation shape where `collections` is keyed on `token`
    and child tables carry a `token` column (rather than `id`/`cid`)."""
    tables = {
        row["name"]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    if "collections" not in tables:
        return False  # fresh DB
    cols = _table_columns(conn, "collections")
    return "id" not in cols and "token" in cols


def _upgrade_identity_model(conn: sqlite3.Connection) -> None:
    """Convert a legacy token-keyed DB to the stable-id (cid) schema, preserving
    all data. Each existing token becomes a collection with a fresh stable id;
    child rows are re-pointed from token to that id."""
    if not _is_legacy(conn):
        return

    conn.execute("PRAGMA foreign_keys = OFF")
    with _write_lock:
        # Ensure analytics columns exist on the OLD bookmarks table so the copy
        # below can select them uniformly.
        existing = _table_columns(conn, "bookmarks")
        for name, ddl in _BOOKMARK_ADDED_COLUMNS:
            if name not in existing:
                conn.execute(f"ALTER TABLE bookmarks ADD COLUMN {name} {ddl}")

        # token -> new stable id
        rows = conn.execute("SELECT token, name, created_at FROM collections").fetchall()
        token_to_cid = {r["token"]: "col_" + secrets.token_hex(12) for r in rows}

        # Rename old tables aside.
        for t in ("collections", "bookmarks", "delta_log", "device_tabs", "link_status"):
            if t in {
                row["name"]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }:
                conn.execute(f"ALTER TABLE {t} RENAME TO {t}__old")

        # Create the new schema.
        conn.executescript(_SCHEMA_PATH.read_text(encoding="utf-8"))

        # Copy collections.
        for r in rows:
            conn.execute(
                "INSERT INTO collections (id, token, name, created_at) VALUES (?, ?, ?, ?)",
                (token_to_cid[r["token"]], r["token"], r["name"], r["created_at"]),
            )

        # Copy child tables, mapping token -> cid.
        conn.execute(
            """INSERT INTO bookmarks
                 (id, cid, parent_id, position, title, url, is_folder, date_added,
                  date_modified, icon_base64, sort_key, visit_count, last_visited_at, domain)
               SELECT b.id, c.id, b.parent_id, b.position, b.title, b.url, b.is_folder,
                      b.date_added, b.date_modified, b.icon_base64, b.sort_key,
                      b.visit_count, b.last_visited_at, b.domain
               FROM bookmarks__old b JOIN collections c ON c.token = b.token"""
        )
        conn.execute(
            """INSERT INTO delta_log (cid, op, node_id, payload_json, timestamp, origin)
               SELECT c.id, d.op, d.node_id, d.payload_json, d.timestamp, d.origin
               FROM delta_log__old d JOIN collections c ON c.token = d.token"""
        )
        conn.execute(
            """INSERT INTO device_tabs (device_id, cid, device_name, session_json, updated_at)
               SELECT t.device_id, c.id, t.device_name, t.session_json, t.updated_at
               FROM device_tabs__old t JOIN collections c ON c.token = t.token"""
        )
        conn.execute(
            """INSERT INTO link_status (cid, node_id, http_status, ok, checked_at, error)
               SELECT c.id, s.node_id, s.http_status, s.ok, s.checked_at, s.error
               FROM link_status__old s JOIN collections c ON c.token = s.token"""
        )

        for t in ("bookmarks", "delta_log", "device_tabs", "link_status", "collections"):
            conn.execute(f"DROP TABLE IF EXISTS {t}__old")
        conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")


def _migrate(conn: sqlite3.Connection) -> None:
    """Idempotently add any bookmarks columns missing from an older (already
    cid-keyed) database, then create the analytics indexes."""
    existing = _table_columns(conn, "bookmarks")
    for name, ddl in _BOOKMARK_ADDED_COLUMNS:
        if name not in existing:
            conn.execute(f"ALTER TABLE bookmarks ADD COLUMN {name} {ddl}")
    delta_cols = _table_columns(conn, "delta_log")
    for name, ddl in _DELTA_LOG_ADDED_COLUMNS:
        if name not in delta_cols:
            conn.execute(f"ALTER TABLE delta_log ADD COLUMN {name} {ddl}")

    snap_cols = _table_columns(conn, "tree_snapshots")
    for name, ddl in _SNAPSHOT_ADDED_COLUMNS:
        if name not in snap_cols:
            conn.execute(f"ALTER TABLE tree_snapshots ADD COLUMN {name} {ddl}")
    tabs_cols = _table_columns(conn, "device_tabs")
    for name, ddl in _DEVICE_TABS_ADDED_COLUMNS:
        if name not in tabs_cols:
            conn.execute(f"ALTER TABLE device_tabs ADD COLUMN {name} {ddl}")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_bookmarks_cid_visits "
        "ON bookmarks (cid, visit_count)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_bookmarks_cid_domain "
        "ON bookmarks (cid, domain)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_delta_log_cid_id "
        "ON delta_log (cid, id)"
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_delta_log_idempotency "
        "ON delta_log (cid, origin, op_id) WHERE op_id IS NOT NULL"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_bookmarks_cid_sortkey "
        "ON bookmarks (cid, sort_key)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_bookmarks_cid_visits_title "
        "ON bookmarks (cid, visit_count, title)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tab_session_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            cid          TEXT NOT NULL,
            device_id    TEXT NOT NULL,
            device_name  TEXT NOT NULL,
            session_json TEXT NOT NULL,
            tab_count    INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            FOREIGN KEY (cid) REFERENCES collections(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tab_history_cid_dev "
        "ON tab_session_history (cid, device_id, created_at DESC)"
    )


def get_conn() -> sqlite3.Connection:
    if _db_path is None or _write_conn is None:
        raise RuntimeError("Database not initialized; call init_db() first.")
    tx_conn = getattr(_local, "tx_conn", None)
    if tx_conn is not None:
        return tx_conn
    reader = getattr(_local, "reader_conn", None)
    if reader is not None:
        try:
            reader.execute("SELECT 1")
        except Exception:
            reader = None
            _local.reader_conn = None
    if reader is None:
        reader = _create_connection(_db_path)
        _local.reader_conn = reader
        with _open_conns_lock:
            _open_conns.add(reader)
    return reader


@contextmanager
def write_tx():
    """Serialize writers, commit on success, roll back on ANY exception.

    Separates reader connections from the active writer to prevent uncommitted read leaks.
    """
    if _write_conn is None:
        raise RuntimeError("Database not initialized; call init_db() first.")
    with _write_lock:
        _write_conn.execute("BEGIN IMMEDIATE")
        _local.tx_conn = _write_conn
        try:
            yield _write_conn
            _write_conn.commit()
        except BaseException:
            if _write_conn.in_transaction:
                _write_conn.rollback()
            raise
        finally:
            _local.tx_conn = None


def close_db() -> None:
    global _conn, _write_conn, _db_path
    if _write_conn is not None:
        try:
            _write_conn.close()
        except Exception:
            pass
        _write_conn = None
        _conn = None
    with _open_conns_lock:
        for c in _open_conns:
            try:
                c.close()
            except Exception:
                pass
        _open_conns.clear()
    _local.reader_conn = None
    _local.tx_conn = None
    _db_path = None

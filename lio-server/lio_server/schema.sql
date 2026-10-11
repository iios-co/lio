-- Lio server SQLite schema.
-- Applied idempotently at startup via db.init_db().
--
-- Identity model: a collection has a STABLE `id` (never changes) and a
-- ROTATABLE `token` (the browser/device credential; unique, can be renewed
-- without losing data). All child tables key on the collection id (`cid`), so
-- renewing a token is a one-row update on `collections` and orphans nothing.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS collections (
    id          TEXT PRIMARY KEY,        -- stable collection identity
    token       TEXT NOT NULL UNIQUE,    -- rotatable device credential
    name        TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    token_rotated_at INTEGER             -- ms of last rotation, NULL if never
);

CREATE INDEX IF NOT EXISTS idx_collections_token ON collections (token);

CREATE TABLE IF NOT EXISTS bookmarks (
    id            TEXT NOT NULL,
    cid           TEXT NOT NULL,
    parent_id     TEXT,
    position      INTEGER NOT NULL,
    title         TEXT NOT NULL,
    url           TEXT,
    is_folder     INTEGER NOT NULL DEFAULT 0,
    date_added    INTEGER,
    date_modified INTEGER,
    icon_base64   TEXT,
    sort_key      TEXT,                   -- fractional index for custom UI order
    visit_count   INTEGER NOT NULL DEFAULT 0,
    last_visited_at INTEGER,
    domain        TEXT,                   -- denormalized url host for sort/group
    deleted       INTEGER NOT NULL DEFAULT 0, -- tombstone indicator
    server_version INTEGER NOT NULL DEFAULT 0, -- server watermark of last mutation
    PRIMARY KEY (cid, id),
    FOREIGN KEY (cid) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_cid_parent
    ON bookmarks (cid, parent_id, position);
-- Analytics-column indexes are created in db._migrate() after the columns exist.

-- Append-only change feed powering incremental "changes since timestamp" pull.
CREATE TABLE IF NOT EXISTS delta_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cid          TEXT NOT NULL,
    op           TEXT NOT NULL,          -- 'create' | 'update' | 'move' | 'delete'
    node_id      TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    timestamp    INTEGER NOT NULL,       -- client wall-clock ms (LWW basis)
    origin       TEXT,                   -- device_id that authored the op (echo suppression)
    op_id        TEXT,                   -- client idempotency key
    client_seq   INTEGER,                -- client monotonic sequence number
    FOREIGN KEY (cid) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_delta_log_cid_ts
    ON delta_log (cid, timestamp, id);
CREATE INDEX IF NOT EXISTS idx_delta_log_cid_id
    ON delta_log (cid, id);
-- Idempotency index is created in db._migrate() after op_id column is added.

CREATE TABLE IF NOT EXISTS device_tabs (
    device_id    TEXT NOT NULL,
    cid          TEXT NOT NULL,
    device_name  TEXT NOT NULL,
    session_json TEXT NOT NULL,          -- JSON blob of windows & tabs
    updated_at   INTEGER NOT NULL,
    tab_count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (cid, device_id),
    FOREIGN KEY (cid) REFERENCES collections(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tab_session_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cid          TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    device_name  TEXT NOT NULL,
    session_json TEXT NOT NULL,
    tab_count    INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    FOREIGN KEY (cid) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tab_history_cid_dev
    ON tab_session_history (cid, device_id, created_at DESC);


-- Liveness results for dead-link reporting.
CREATE TABLE IF NOT EXISTS link_status (
    cid         TEXT NOT NULL,
    node_id     TEXT NOT NULL,
    http_status INTEGER,                 -- last observed HTTP status; NULL = never checked
    ok          INTEGER,                 -- 1 alive, 0 dead/unreachable
    checked_at  INTEGER,                 -- ms
    error       TEXT,                    -- reason when not ok
    PRIMARY KEY (cid, node_id),
    FOREIGN KEY (cid) REFERENCES collections(id) ON DELETE CASCADE
);

-- Pre-apply snapshots of the whole bookmark tree, written by the bulk
-- reorganize endpoint so a sweeping change (group by domain, delete duplicates)
-- can be undone as one step. Only the newest few per collection are kept.
CREATE TABLE IF NOT EXISTS tree_snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    cid        TEXT NOT NULL,
    label      TEXT NOT NULL,           -- the action that was about to run
    nodes_json TEXT NOT NULL,           -- full node list as it was before
    node_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,        -- ms
    -- What THIS action itself did, so undo can invert exactly it and leave any
    -- later edits (links the user deleted or added afterwards) untouched. A
    -- wholesale restore would resurrect post-action deletes; recording the
    -- action's own created/removed ids makes undo surgical.
    created_json TEXT,                  -- JSON list of ids the action created
    removed_json TEXT,                   -- JSON list of ids the action removed
    FOREIGN KEY (cid) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tree_snapshots_cid
    ON tree_snapshots (cid, id DESC);

-- Server-wide key/value settings. Holds the admin password hash set via the
-- first-run setup flow (key = 'admin_password_hash').
CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

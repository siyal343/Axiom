use rusqlite::Connection;

use crate::error::IpcError;

const CONNECTION_PRAGMAS_SQL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
"#;

const SCHEMA_MIGRATION_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS workspace_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO workspace_meta (key, value) VALUES
    ('schema_version', '1'),
    ('camera_x', '0.0'),
    ('camera_y', '0.0'),
    ('camera_zoom', '1.0'),
    ('last_focus_id', ''),
    ('token_budget', '6000');

CREATE TABLE IF NOT EXISTS nodes (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL
                         CHECK (type IN ('core', 'branch', 'loophole', 'probe', 'synthesis')),
    status          TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('draft', 'active', 'resolved', 'dismissed', 'locked')),
    title           TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL DEFAULT '',
    summary         TEXT NOT NULL DEFAULT '',
    content_hash    TEXT NOT NULL DEFAULT '',
    summary_hash    TEXT NOT NULL DEFAULT '',

    severity        TEXT CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
    lens            TEXT NOT NULL DEFAULT 'manual'
                         CHECK (lens IN ('manual', 'red_team', 'edge_case', 'diverge', 'feynman', 'synthesize', 'custom')),
    created_by      TEXT NOT NULL DEFAULT 'user'
                         CHECK (created_by IN ('user', 'ai')),
    model           TEXT,
    token_count     INTEGER NOT NULL DEFAULT 0,

    pin_global      INTEGER NOT NULL DEFAULT 0 CHECK (pin_global IN (0, 1)),
    exclude_from_ai INTEGER NOT NULL DEFAULT 0 CHECK (exclude_from_ai IN (0, 1)),

    x               REAL NOT NULL DEFAULT 0.0,
    y               REAL NOT NULL DEFAULT 0.0,
    width           REAL NOT NULL DEFAULT 320.0,
    height          REAL NOT NULL DEFAULT 180.0,
    collapsed       INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),

    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
    id          TEXT PRIMARY KEY,
    source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    type        TEXT NOT NULL
                     CHECK (type IN ('derives', 'branches', 'challenges', 'resolves', 'synthesizes', 'references')),
    weight      TEXT NOT NULL DEFAULT 'summary'
                     CHECK (weight IN ('full', 'summary')),
    created_at  INTEGER NOT NULL,
    UNIQUE (source_id, target_id, type),
    CHECK (source_id != target_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_source  ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target  ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_nodes_status  ON nodes(type, status);
CREATE INDEX IF NOT EXISTS idx_nodes_pinned  ON nodes(pin_global) WHERE pin_global = 1;
CREATE INDEX IF NOT EXISTS idx_nodes_stale_summary
    ON nodes(updated_at) WHERE content_hash != summary_hash AND exclude_from_ai = 0;

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    title,
    content,
    summary,
    content='nodes',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, title, content, summary)
    VALUES (new.rowid, new.title, new.content, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, content, summary)
    VALUES ('delete', old.rowid, old.title, old.content, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE OF title, content, summary ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, content, summary)
    VALUES ('delete', old.rowid, old.title, old.content, old.summary);
    INSERT INTO nodes_fts(rowid, title, content, summary)
    VALUES (new.rowid, new.title, new.content, new.summary);
END;
"#;

pub fn run_migrations(conn: &Connection) -> Result<(), IpcError> {
    conn.execute_batch(CONNECTION_PRAGMAS_SQL)?;
    conn.execute_batch(SCHEMA_MIGRATION_SQL)?;
    Ok(())
}

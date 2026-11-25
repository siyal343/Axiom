use rusqlite::Connection;

use crate::error::IpcError;

const CONNECTION_PRAGMAS_SQL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
"#;

const SCHEMA_V2_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS workspace_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO workspace_meta (key, value) VALUES
    ('schema_version', '2'),
    ('system_prompt', ''),
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
                         CHECK (lens IN ('manual', 'red_team', 'edge_case', 'diverge', 'feynman', 'synthesize', 'research', 'study', 'custom')),
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

CREATE TABLE IF NOT EXISTS ai_runs (
    spawned_node_id   TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    run_id            TEXT NOT NULL,
    lens              TEXT NOT NULL,
    model             TEXT,
    input_hashes_json TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
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

const MIGRATE_V1_TO_V2_SQL: &str = r#"
DROP TRIGGER IF EXISTS nodes_ai;
DROP TRIGGER IF EXISTS nodes_ad;
DROP TRIGGER IF EXISTS nodes_au;

CREATE TABLE nodes_v2 (
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
                         CHECK (lens IN ('manual', 'red_team', 'edge_case', 'diverge', 'feynman', 'synthesize', 'research', 'study', 'custom')),
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

INSERT INTO nodes_v2 (
    rowid, id, type, status, title, content, summary, content_hash, summary_hash,
    severity, lens, created_by, model, token_count,
    pin_global, exclude_from_ai, x, y, width, height, collapsed,
    created_at, updated_at
)
SELECT
    rowid, id, type, status, title, content, summary, content_hash, summary_hash,
    severity, lens, created_by, model, token_count,
    pin_global, exclude_from_ai, x, y, width, height, collapsed,
    created_at, updated_at
FROM nodes;

DROP TABLE nodes;
ALTER TABLE nodes_v2 RENAME TO nodes;

CREATE INDEX IF NOT EXISTS idx_nodes_status  ON nodes(type, status);
CREATE INDEX IF NOT EXISTS idx_nodes_pinned  ON nodes(pin_global) WHERE pin_global = 1;
CREATE INDEX IF NOT EXISTS idx_nodes_stale_summary
    ON nodes(updated_at) WHERE content_hash != summary_hash AND exclude_from_ai = 0;

CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, title, content, summary)
    VALUES (new.rowid, new.title, new.content, new.summary);
END;

CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, content, summary)
    VALUES ('delete', old.rowid, old.title, old.content, old.summary);
END;

CREATE TRIGGER nodes_au AFTER UPDATE OF title, content, summary ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, content, summary)
    VALUES ('delete', old.rowid, old.title, old.content, old.summary);
    INSERT INTO nodes_fts(rowid, title, content, summary)
    VALUES (new.rowid, new.title, new.content, new.summary);
END;

INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');

CREATE TABLE IF NOT EXISTS ai_runs (
    spawned_node_id   TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    run_id            TEXT NOT NULL,
    lens              TEXT NOT NULL,
    model             TEXT,
    input_hashes_json TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
);

INSERT OR IGNORE INTO workspace_meta (key, value) VALUES ('system_prompt', '');
INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('schema_version', '2');
"#;

fn migrate_v1_to_v2(conn: &Connection) -> Result<(), IpcError> {
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let res = (|| -> Result<(), IpcError> {
        conn.execute_batch("BEGIN IMMEDIATE;")?;
        if let Err(err) = conn.execute_batch(MIGRATE_V1_TO_V2_SQL) {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(err.into());
        }
        conn.execute_batch("COMMIT;")?;
        Ok(())
    })();
    let fk_res = conn.execute_batch("PRAGMA foreign_keys = ON;");
    res?;
    fk_res?;
    Ok(())
}

pub fn run_migrations(conn: &Connection) -> Result<(), IpcError> {
    conn.execute_batch(CONNECTION_PRAGMAS_SQL)?;
    let nodes_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes')",
        [],
        |r| r.get(0),
    )?;
    if !nodes_exists {
        conn.execute_batch(SCHEMA_V2_SQL)?;
        return Ok(());
    }

    let version: i64 = conn
        .query_row(
            "SELECT value FROM workspace_meta WHERE key = 'schema_version'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(1);
    if version < 2 {
        migrate_v1_to_v2(conn)?;
    }
    Ok(())
}

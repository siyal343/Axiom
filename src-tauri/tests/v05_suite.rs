use rusqlite::Connection;
use tempfile::tempdir;

use axiom_canvas_lib::db::queries::{apply_ops, search_nodes, upsert_ai_run_provenance};
use axiom_canvas_lib::db::{hydrate_or_seed_workspace, open_connection};
use axiom_canvas_lib::graph::checkpoints::{
    create_checkpoint, delete_checkpoint, diff_checkpoint, list_checkpoints, restore_checkpoint,
};
use axiom_canvas_lib::graph::external_refs::{
    compute_external_ref_statuses, detach_external_ref, pull_external_reference, sync_external_ref,
};
use axiom_canvas_lib::graph::models::{
    compute_content_hash, estimate_tokens, ContextControls, CreatedBy, EdgeDto, EdgeType,
    EdgeWeight, ExternalRefStatusKind, GraphOp, LensKind, NodeDto, NodeLayout, NodeLensOrigin,
    NodeMetadata, NodeStatus, NodeType, ProvenanceInput, StaleReason,
};
use axiom_canvas_lib::graph::provenance::compute_stale_nodes;
use axiom_canvas_lib::graph::spatial::{DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH};
use axiom_canvas_lib::graph::GraphEngine;
use axiom_canvas_lib::ipc::ActiveWorkspace;

fn make_node(
    id: &str,
    node_type: NodeType,
    title: &str,
    content: &str,
    x: f64,
    y: f64,
) -> NodeDto {
    let content_hash = compute_content_hash(title, content);
    let token_count = estimate_tokens(&format!("{title}\n{content}"));
    NodeDto {
        id: id.to_owned(),
        node_type,
        status: NodeStatus::Active,
        title: title.to_owned(),
        content: content.to_owned(),
        summary: String::new(),
        content_hash,
        summary_hash: String::new(),
        metadata: NodeMetadata {
            severity: None,
            lens: NodeLensOrigin::Manual,
            created_by: CreatedBy::User,
            model: None,
            token_count,
        },
        context_controls: ContextControls {
            pin_global: false,
            exclude_from_ai: false,
        },
        layout: NodeLayout {
            x,
            y,
            width: DEFAULT_NODE_WIDTH,
            height: DEFAULT_NODE_HEIGHT,
            collapsed: false,
        },
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
    }
}

fn make_edge(id: &str, source_id: &str, target_id: &str, edge_type: EdgeType) -> EdgeDto {
    EdgeDto {
        id: id.to_owned(),
        source_id: source_id.to_owned(),
        target_id: target_id.to_owned(),
        edge_type,
        weight: EdgeWeight::Summary,
        created_at: 1_700_000_000_000,
    }
}

#[test]
fn v2_to_v3_migration_preserves_rows_fts_and_creates_external_refs_and_checkpoints() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("legacy_v2.sqlite");

    {
        let conn = Connection::open(&db_path).expect("open raw v2 sqlite");
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE workspace_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT INTO workspace_meta (key, value) VALUES
                ('schema_version', '2'),
                ('system_prompt', 'Be concise'),
                ('camera_x', '0.0'),
                ('camera_y', '0.0'),
                ('camera_zoom', '1.0'),
                ('last_focus_id', 'n_v2_core'),
                ('token_budget', '6000');
            CREATE TABLE nodes (
                id              TEXT PRIMARY KEY,
                type            TEXT NOT NULL CHECK (type IN ('core', 'branch', 'loophole', 'probe', 'synthesis')),
                status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'resolved', 'dismissed', 'locked')),
                title           TEXT NOT NULL DEFAULT '',
                content         TEXT NOT NULL DEFAULT '',
                summary         TEXT NOT NULL DEFAULT '',
                content_hash    TEXT NOT NULL DEFAULT '',
                summary_hash    TEXT NOT NULL DEFAULT '',
                severity        TEXT CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
                lens            TEXT NOT NULL DEFAULT 'manual' CHECK (lens IN ('manual', 'red_team', 'edge_case', 'diverge', 'feynman', 'synthesize', 'research', 'study', 'custom')),
                created_by      TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'ai')),
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
            CREATE TABLE edges (
                id          TEXT PRIMARY KEY,
                source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                type        TEXT NOT NULL CHECK (type IN ('derives', 'branches', 'challenges', 'resolves', 'synthesizes', 'references')),
                weight      TEXT NOT NULL DEFAULT 'summary' CHECK (weight IN ('full', 'summary')),
                created_at  INTEGER NOT NULL,
                UNIQUE (source_id, target_id, type),
                CHECK (source_id != target_id)
            );
            CREATE TABLE ai_runs (
                spawned_node_id   TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
                run_id            TEXT NOT NULL,
                lens              TEXT NOT NULL,
                model             TEXT,
                input_hashes_json TEXT NOT NULL,
                prompt_tokens     INTEGER NOT NULL DEFAULT 0,
                created_at        INTEGER NOT NULL
            );
            CREATE VIRTUAL TABLE nodes_fts USING fts5(
                title, content, summary,
                content='nodes', content_rowid='rowid', tokenize='porter unicode61'
            );
            CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
                INSERT INTO nodes_fts(rowid, title, content, summary) VALUES (new.rowid, new.title, new.content, new.summary);
            END;
            CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
                INSERT INTO nodes_fts(nodes_fts, rowid, title, content, summary) VALUES ('delete', old.rowid, old.title, old.content, old.summary);
            END;
            CREATE TRIGGER nodes_au AFTER UPDATE OF title, content, summary ON nodes BEGIN
                INSERT INTO nodes_fts(nodes_fts, rowid, title, content, summary) VALUES ('delete', old.rowid, old.title, old.content, old.summary);
                INSERT INTO nodes_fts(rowid, title, content, summary) VALUES (new.rowid, new.title, new.content, new.summary);
            END;
            INSERT INTO nodes (id, type, status, title, content, summary, content_hash, summary_hash, lens, created_by, token_count, created_at, updated_at)
            VALUES
                ('n_v2_core', 'core', 'active', 'Idempotent Ledger', 'Double-entry invariants and WAL replay', '', 'h_core', '', 'manual', 'user', 12, 100, 100),
                ('n_v2_branch', 'branch', 'active', 'Outbox Relay', 'Transactional outbox worker', '', 'h_branch', '', 'research', 'ai', 10, 101, 101);
            INSERT INTO edges (id, source_id, target_id, type, weight, created_at)
            VALUES ('e_v2', 'n_v2_core', 'n_v2_branch', 'branches', 'summary', 102);
            "#,
        )
        .expect("seed v2 schema");
    }

    let mut conn = open_connection(&db_path).expect("migrate v2 to v3");

    let schema_version: String = conn
        .query_row(
            "SELECT value FROM workspace_meta WHERE key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .expect("schema_version");
    assert_eq!(schema_version, "3");

    for table in ["external_refs", "checkpoints"] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |r| r.get(0),
            )
            .expect("check table existence");
        assert_eq!(exists, 1, "expected table {table} to exist");
    }

    let snap = hydrate_or_seed_workspace(&mut conn, &db_path.to_string_lossy())
        .expect("hydrate v3 workspace");
    assert_eq!(snap.nodes.len(), 2);
    assert_eq!(snap.edges.len(), 1);
    assert_eq!(snap.system_prompt, "Be concise");

    let hits = search_nodes(&conn, "invariants", 10).expect("fts preserved");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "n_v2_core");
}

#[test]
fn cross_flow_live_ref_lifecycle_tracks_sync_out_of_sync_staleness_missing_and_detach() {
    let dir = tempdir().expect("tempdir");
    let source_path = dir.path().join("flow_source.sqlite");
    let local_path = dir.path().join("flow_local.sqlite");

    // 1. Seed source flow
    let mut source_conn = open_connection(&source_path).expect("open source db");
    let mut source_engine = GraphEngine::default();
    let src_node = make_node(
        "n_src_spec",
        NodeType::Core,
        "Auth Token Spec",
        "Ed25519 signed tokens with 15m TTL",
        0.0,
        0.0,
    );
    apply_ops(
        &mut source_conn,
        &mut source_engine,
        &[GraphOp::CreateNode { node: src_node }],
    )
    .expect("seed source node");

    // 2. Seed local flow with root + downstream AI node
    let mut local_conn = open_connection(&local_path).expect("open local db");
    let mut local_engine = GraphEngine::default();
    let local_root = make_node(
        "n_local_root",
        NodeType::Core,
        "Gateway Design",
        "API gateway verification pipeline",
        0.0,
        0.0,
    );
    apply_ops(
        &mut local_conn,
        &mut local_engine,
        &[GraphOp::CreateNode { node: local_root }],
    )
    .expect("seed local root");

    // 3. Pull external reference into local flow attached to n_local_root
    let pulled = pull_external_reference(
        &mut local_conn,
        &mut local_engine,
        "ws_1",
        "flow_src",
        "Auth Flow",
        &source_path,
        "n_src_spec",
        Some("n_local_root"),
    )
    .expect("pull external reference");

    assert_eq!(pulled.node.title, "Auth Token Spec");
    assert_eq!(pulled.external_ref.status, ExternalRefStatusKind::Synced);
    let edge = pulled.edge.expect("references edge created");
    assert_eq!(edge.source_id, "n_local_root");
    assert_eq!(edge.target_id, pulled.node.id);
    assert_eq!(edge.edge_type, EdgeType::References);

    // Attach a downstream AI node referencing the pulled node for provenance staleness check
    let mut ai_node = make_node(
        "n_ai_downstream",
        NodeType::Probe,
        "Verifier Analysis",
        "Checks Ed25519 signature latency",
        700.0,
        0.0,
    );
    ai_node.metadata.lens = NodeLensOrigin::Research;
    ai_node.metadata.created_by = CreatedBy::Ai;
    apply_ops(
        &mut local_conn,
        &mut local_engine,
        &[
            GraphOp::CreateNode { node: ai_node },
            GraphOp::CreateEdge {
                edge: make_edge(
                    "e_ref_ai",
                    &pulled.node.id,
                    "n_ai_downstream",
                    EdgeType::Derives,
                ),
            },
        ],
    )
    .expect("create downstream ai node");

    upsert_ai_run_provenance(
        &local_conn,
        "n_ai_downstream",
        "run_1",
        LensKind::Research,
        Some("gpt-4o"),
        &[ProvenanceInput {
            node_id: pulled.node.id.clone(),
            title: pulled.node.title.clone(),
            content_hash: pulled.node.content_hash.clone(),
        }],
        120,
        1_700_000_000_100,
    )
    .expect("record ai provenance");

    let statuses_initial =
        compute_external_ref_statuses(&local_conn, &local_engine).expect("initial statuses");
    assert_eq!(statuses_initial.len(), 1);
    assert_eq!(statuses_initial[0].status, ExternalRefStatusKind::Synced);
    assert_eq!(
        statuses_initial[0].source_title.as_deref(),
        Some("Auth Token Spec")
    );
    assert!(compute_stale_nodes(&local_conn, &local_engine)
        .expect("compute stale")
        .is_empty());

    // 4. Modify source node in Flow A -> OutOfSync
    apply_ops(
        &mut source_conn,
        &mut source_engine,
        &[GraphOp::UpdateNodeText {
            id: "n_src_spec".to_owned(),
            title: "Auth Token Spec v2".to_owned(),
            content: "Ed25519 with 5m TTL and key rotation".to_owned(),
        }],
    )
    .expect("update source node");

    let statuses_changed =
        compute_external_ref_statuses(&local_conn, &local_engine).expect("out_of_sync statuses");
    assert_eq!(statuses_changed[0].status, ExternalRefStatusKind::OutOfSync);
    assert_eq!(
        statuses_changed[0].source_title.as_deref(),
        Some("Auth Token Spec v2")
    );

    // 5. Sync in Flow B -> Synced + triggers downstream AI provenance staleness
    let synced_node = sync_external_ref(&mut local_conn, &mut local_engine, &pulled.node.id)
        .expect("sync external ref");
    assert_eq!(synced_node.title, "Auth Token Spec v2");
    assert_eq!(
        synced_node.content,
        "Ed25519 with 5m TTL and key rotation"
    );

    let statuses_after_sync =
        compute_external_ref_statuses(&local_conn, &local_engine).expect("synced again");
    assert_eq!(statuses_after_sync[0].status, ExternalRefStatusKind::Synced);

    let stale = compute_stale_nodes(&local_conn, &local_engine).expect("downstream stale");
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].node_id, "n_ai_downstream");
    assert_eq!(stale[0].changed_inputs[0].node_id, pulled.node.id);
    assert_eq!(stale[0].changed_inputs[0].reason, StaleReason::Modified);

    // FTS5 in local flow reflects synced text
    let fts_hits = search_nodes(&local_conn, "rotation", 10).expect("fts after sync");
    assert_eq!(fts_hits.len(), 1);
    assert_eq!(fts_hits[0].id, pulled.node.id);

    // 6. Delete source node -> SourceMissing
    apply_ops(
        &mut source_conn,
        &mut source_engine,
        &[GraphOp::DeleteNodes {
            ids: vec!["n_src_spec".to_owned()],
        }],
    )
    .expect("delete source node");

    let statuses_missing =
        compute_external_ref_statuses(&local_conn, &local_engine).expect("source missing");
    assert_eq!(
        statuses_missing[0].status,
        ExternalRefStatusKind::SourceMissing
    );
    assert_eq!(statuses_missing[0].source_title, None);

    // 7. Detach external ref -> no longer tracked, local node kept
    detach_external_ref(&mut local_conn, &pulled.node.id).expect("detach external ref");
    assert!(
        compute_external_ref_statuses(&local_conn, &local_engine)
            .expect("statuses after detach")
            .is_empty()
    );
    assert!(local_engine.nodes.contains_key(&pulled.node.id));
}

#[test]
fn checkpoint_create_diff_restore_with_auto_backup_and_delete() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("ckpt.sqlite");
    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();

    let n1 = make_node("n1", NodeType::Core, "Core API", "v1 body", 0.0, 0.0);
    let n2 = make_node(
        "n2",
        NodeType::Branch,
        "Legacy Cache",
        "Memcached shard",
        400.0,
        0.0,
    );
    let e1 = make_edge("e1", "n1", "n2", EdgeType::Branches);

    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: n1 },
            GraphOp::CreateNode { node: n2 },
            GraphOp::CreateEdge { edge: e1 },
        ],
    )
    .expect("seed graph");

    let mut active = ActiveWorkspace {
        path: db_path.to_string_lossy().into_owned(),
        engine,
        token_budget: 5000,
        system_prompt: "v1 prompt".to_owned(),
    };

    let ckpt = create_checkpoint(
        &mut conn,
        &active.engine,
        &active.system_prompt,
        active.token_budget,
        "Baseline v1",
        "Initial design",
    )
    .expect("create checkpoint");
    assert_eq!(ckpt.node_count, 2);
    assert_eq!(ckpt.edge_count, 1);

    let listed = list_checkpoints(&conn).expect("list checkpoints");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, ckpt.id);

    // Mutate graph: modify n1, remove n2 (and e1), add n3 + e2
    let n3 = make_node(
        "n3",
        NodeType::Synthesis,
        "Redis Cluster",
        "Sharded cache replacement",
        420.0,
        120.0,
    );
    let e2 = make_edge("e2", "n1", "n3", EdgeType::Synthesizes);
    apply_ops(
        &mut conn,
        &mut active.engine,
        &[
            GraphOp::UpdateNodeText {
                id: "n1".to_owned(),
                title: "Core API v2".to_owned(),
                content: "v2 body".to_owned(),
            },
            GraphOp::UpdateNodeMeta {
                id: "n1".to_owned(),
                node_type: None,
                status: None,
                severity: None,
                pin_global: Some(true),
                exclude_from_ai: None,
                collapsed: None,
            },
            GraphOp::DeleteNodes {
                ids: vec!["n2".to_owned()],
            },
            GraphOp::CreateNode { node: n3 },
            GraphOp::CreateEdge { edge: e2 },
        ],
    )
    .expect("mutate graph");
    active.system_prompt = "v2 prompt".to_owned();
    active.token_budget = 8000;

    let diff = diff_checkpoint(&conn, &active.engine, &ckpt.id).expect("diff checkpoint");
    assert_eq!(diff.added_nodes.len(), 1);
    assert_eq!(diff.added_nodes[0].node_id, "n3");
    assert_eq!(diff.removed_nodes.len(), 1);
    assert_eq!(diff.removed_nodes[0].node_id, "n2");
    assert_eq!(diff.modified_nodes.len(), 1);
    assert_eq!(diff.modified_nodes[0].node_id, "n1");
    assert_eq!(
        diff.modified_nodes[0].changes,
        vec!["title", "content", "pin_global"]
    );
    assert_eq!(diff.added_edges_count, 1);
    assert_eq!(diff.removed_edges_count, 1);

    // Restore Baseline v1 -> creates auto-backup and restores exact graph + FTS5
    let restored = restore_checkpoint(&mut conn, &mut active, &ckpt.id).expect("restore");
    assert_eq!(restored.nodes.len(), 2);
    assert_eq!(restored.edges.len(), 1);
    assert_eq!(restored.system_prompt, "v1 prompt");
    assert_eq!(restored.token_budget, 5000);
    assert!(active.engine.nodes.contains_key("n2"));
    assert!(!active.engine.nodes.contains_key("n3"));
    assert_eq!(active.engine.nodes["n1"].title, "Core API");
    assert!(!active.engine.nodes["n1"].context_controls.pin_global);

    // FTS5 rebuilt on restore
    assert_eq!(
        search_nodes(&conn, "Memcached", 10)
            .expect("fts restored")
            .len(),
        1
    );
    assert!(search_nodes(&conn, "Redis", 10)
        .expect("fts removed n3")
        .is_empty());

    // Auto-backup created before restore
    let after_restore = list_checkpoints(&conn).expect("list after restore");
    assert_eq!(after_restore.len(), 2);
    let backup = after_restore
        .iter()
        .find(|c| c.name.starts_with("Auto-backup before restore: Baseline v1"))
        .expect("auto-backup present");
    assert_eq!(backup.node_count, 2);
    assert_eq!(backup.edge_count, 1);

    // Delete checkpoint
    delete_checkpoint(&mut conn, &backup.id).expect("delete backup");
    let final_list = list_checkpoints(&conn).expect("list after delete");
    assert_eq!(final_list.len(), 1);
    assert_eq!(final_list[0].id, ckpt.id);
}

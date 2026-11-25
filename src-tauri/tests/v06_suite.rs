use rusqlite::Connection;
use tempfile::tempdir;

use axiom_canvas_lib::db::json_io::{export_json, import_json};
use axiom_canvas_lib::db::queries::{apply_ops, search_nodes};
use axiom_canvas_lib::db::{hydrate_or_seed_workspace, open_connection};
use axiom_canvas_lib::graph::checkpoints::{create_checkpoint, restore_checkpoint};
use axiom_canvas_lib::graph::compiler::compile_context;
use axiom_canvas_lib::graph::models::{
    compute_content_hash, estimate_tokens, ContextControls, CreatedBy, EdgeDto, EdgeType,
    EdgeWeight, GraphOp, NodeDto, NodeLayout, NodeLensOrigin, NodeMetadata, NodeStatus, NodeType,
    Severity, StudyCardDto, StudyCardKind, StudyRating,
};
use axiom_canvas_lib::graph::spatial::{DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH};
use axiom_canvas_lib::graph::study::{
    apply_sm2_review, create_study_card, delete_study_card, extract_study_candidates,
    list_study_cards, review_study_card, sync_study_deck,
};
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
            severity: if node_type == NodeType::Loophole {
                Some(Severity::High)
            } else {
                None
            },
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
fn v3_to_v4_migration_preserves_data_and_creates_study_cards_and_canvas_groups() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("legacy_v3.sqlite");

    {
        let conn = Connection::open(&db_path).expect("open raw v3 sqlite");
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE workspace_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT INTO workspace_meta (key, value) VALUES
                ('schema_version', '3'),
                ('system_prompt', 'Stay grounded'),
                ('camera_x', '10.0'),
                ('camera_y', '20.0'),
                ('camera_zoom', '1.0'),
                ('last_focus_id', 'n_v3_core'),
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
            CREATE TABLE external_refs (
                local_node_id       TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
                source_workspace_id TEXT NOT NULL,
                source_flow_id      TEXT NOT NULL,
                source_flow_name    TEXT NOT NULL,
                source_db_path      TEXT NOT NULL,
                source_node_id      TEXT NOT NULL,
                synced_hash         TEXT NOT NULL,
                synced_at           INTEGER NOT NULL
            );
            CREATE TABLE checkpoints (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                note          TEXT NOT NULL DEFAULT '',
                snapshot_json TEXT NOT NULL,
                node_count    INTEGER NOT NULL DEFAULT 0,
                edge_count    INTEGER NOT NULL DEFAULT 0,
                created_at    INTEGER NOT NULL
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
            VALUES ('n_v3_core', 'core', 'active', 'Raft Consensus', 'Leader election and log replication', '', 'h1', '', 'manual', 'user', 10, 100, 100);
            "#,
        )
        .expect("seed v3 schema");
    }

    let mut conn = open_connection(&db_path).expect("migrate v3 to v4");

    let schema_version: String = conn
        .query_row(
            "SELECT value FROM workspace_meta WHERE key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .expect("schema_version");
    assert_eq!(schema_version, "4");

    for table in ["study_cards", "canvas_groups"] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |r| r.get(0),
            )
            .expect("table exists");
        assert_eq!(exists, 1, "expected table {table} to exist");
    }

    for index in ["idx_study_cards_due_at", "idx_study_cards_node_id"] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                [index],
                |r| r.get(0),
            )
            .expect("index exists");
        assert_eq!(exists, 1, "expected index {index} to exist");
    }

    let snap = hydrate_or_seed_workspace(&mut conn, &db_path.to_string_lossy())
        .expect("hydrate v4 workspace");
    assert_eq!(snap.nodes.len(), 1);
    assert_eq!(snap.nodes[0].id, "n_v3_core");
    assert!(snap.groups.is_empty());
    assert_eq!(snap.system_prompt, "Stay grounded");

    let hits = search_nodes(&conn, "replication", 10).expect("fts preserved");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "n_v3_core");
}

#[test]
fn canvas_groups_crud_delete_nodes_pruning_checkpoints_and_json_roundtrip() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("groups.sqlite");
    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();

    let n1 = make_node("n1", NodeType::Core, "Auth Service", "JWT verification", 0.0, 0.0);
    let n2 = make_node("n2", NodeType::Branch, "Session Store", "Redis cluster", 380.0, 0.0);
    let n3 = make_node("n3", NodeType::Probe, "Audit Log", "Append-only sink", 0.0, 260.0);

    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: n1 },
            GraphOp::CreateNode { node: n2 },
            GraphOp::CreateNode { node: n3 },
            GraphOp::CreateGroup {
                id: "grp_1".to_owned(),
                title: "Auth Cluster".to_owned(),
                color_key: "cobalt".to_owned(),
                member_ids: vec!["n1".to_owned(), "n2".to_owned(), "n1".to_owned()],
            },
        ],
    )
    .expect("create nodes and group");

    assert_eq!(engine.groups.len(), 1);
    assert_eq!(engine.groups["grp_1"].member_ids, vec!["n1", "n2"]);

    apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::UpdateGroup {
            id: "grp_1".to_owned(),
            title: Some("Security Boundary".to_owned()),
            color_key: Some("emerald".to_owned()),
            member_ids: Some(vec!["n1".to_owned(), "n2".to_owned(), "n3".to_owned()]),
            collapsed: Some(true),
        }],
    )
    .expect("update group");

    let updated_grp = &engine.groups["grp_1"];
    assert_eq!(updated_grp.title, "Security Boundary");
    assert_eq!(updated_grp.color_key, "emerald");
    assert!(updated_grp.collapsed);
    assert_eq!(updated_grp.member_ids, vec!["n1", "n2", "n3"]);

    let hydrated =
        hydrate_or_seed_workspace(&mut conn, &db_path.to_string_lossy()).expect("hydrate");
    assert_eq!(hydrated.groups.len(), 1);
    assert_eq!(hydrated.groups[0].title, "Security Boundary");
    assert!(hydrated.groups[0].collapsed);

    // DeleteNodes prunes deleted node IDs from canvas_groups.member_ids in SQLite and memory.
    apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::DeleteNodes {
            ids: vec!["n2".to_owned()],
        }],
    )
    .expect("delete n2");

    assert_eq!(engine.groups["grp_1"].member_ids, vec!["n1", "n3"]);
    let after_delete_snap =
        hydrate_or_seed_workspace(&mut conn, &db_path.to_string_lossy()).expect("hydrate");
    assert_eq!(after_delete_snap.groups[0].member_ids, vec!["n1", "n3"]);

    // Create a manual study card for JSON roundtrip check
    let manual_card = create_study_card(
        &mut conn,
        Some("n1"),
        "What signs the JWT?",
        "Ed25519 private key",
        StudyCardKind::Manual,
    )
    .expect("create manual study card");

    // Checkpoint preserves and restores groups
    let mut active = ActiveWorkspace {
        path: db_path.to_string_lossy().into_owned(),
        engine,
        token_budget: 6000,
        system_prompt: String::new(),
    };
    let ckpt = create_checkpoint(
        &mut conn,
        &active.engine,
        &active.system_prompt,
        active.token_budget,
        "With Group",
        "",
    )
    .expect("create checkpoint");

    apply_ops(
        &mut conn,
        &mut active.engine,
        &[GraphOp::DeleteGroup {
            id: "grp_1".to_owned(),
        }],
    )
    .expect("delete group");
    assert!(active.engine.groups.is_empty());

    let restored = restore_checkpoint(&mut conn, &mut active, &ckpt.id).expect("restore");
    assert_eq!(restored.groups.len(), 1);
    assert_eq!(restored.groups[0].id, "grp_1");
    assert_eq!(active.engine.groups["grp_1"].member_ids, vec!["n1", "n3"]);

    // JSON export & import preserves groups and study cards
    let export_path = dir.path().join("workspace.json");
    export_json(&conn, &export_path).expect("export json");

    let imported_db_path = dir.path().join("imported.sqlite");
    let imported_snap = import_json(&export_path, &imported_db_path).expect("import json");
    assert_eq!(imported_snap.groups.len(), 1);
    assert_eq!(imported_snap.groups[0].title, "Security Boundary");

    let imported_conn = open_connection(&imported_db_path).expect("open imported db");
    let imported_cards = list_study_cards(&imported_conn, false).expect("list imported cards");
    assert_eq!(imported_cards.len(), 1);
    assert_eq!(imported_cards[0].id, manual_card.id);
    assert_eq!(imported_cards[0].prompt, "What signs the JWT?");

    // Legacy v3 JSON without groups/study_cards deserializes cleanly
    let legacy_json_path = dir.path().join("legacy_v3.json");
    std::fs::write(
        &legacy_json_path,
        r#"{
          "format": "axiom-workspace",
          "version": 1,
          "exported_at": 100,
          "meta": {
            "camera": { "x": 0.0, "y": 0.0, "zoom": 1.0, "last_focus_id": "n1" },
            "token_budget": 6000
          },
          "nodes": [],
          "edges": []
        }"#,
    )
    .expect("write legacy json");
    let legacy_db_path = dir.path().join("legacy_imported.sqlite");
    let legacy_snap = import_json(&legacy_json_path, &legacy_db_path).expect("import legacy");
    assert!(legacy_snap.groups.is_empty());
}

#[test]
fn compiler_annotates_grouped_nodes_with_group_titles() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("compiler_groups.sqlite");
    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();

    let mut pin = make_node("n_pin", NodeType::Core, "Global SLA", "p99 < 20ms", 0.0, 0.0);
    pin.context_controls.pin_global = true;
    let anc = make_node("n_anc", NodeType::Core, "Storage Engine", "SQLite WAL", 0.0, 200.0);
    let focus = make_node(
        "n_focus",
        NodeType::Branch,
        "Replication Loop",
        "Streams WAL frames",
        380.0,
        200.0,
    );
    let e1 = make_edge("e1", "n_anc", "n_focus", EdgeType::Derives);

    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: pin },
            GraphOp::CreateNode { node: anc },
            GraphOp::CreateNode { node: focus },
            GraphOp::CreateEdge { edge: e1 },
            GraphOp::CreateGroup {
                id: "g_storage".to_owned(),
                title: "Storage Layer".to_owned(),
                color_key: "cobalt".to_owned(),
                member_ids: vec!["n_anc".to_owned(), "n_focus".to_owned()],
            },
            GraphOp::CreateGroup {
                id: "g_crit".to_owned(),
                title: "Critical Path".to_owned(),
                color_key: "amber".to_owned(),
                member_ids: vec!["n_focus".to_owned()],
            },
        ],
    )
    .expect("seed grouped graph");

    let compiled = compile_context(&engine, &["n_focus".to_owned()], 6000);
    assert!(compiled
        .prompt_text
        .contains("### Storage Engine [Core · derives] [GROUP: Storage Layer]"));
    assert!(compiled
        .prompt_text
        .contains("### Replication Loop [Branch] [GROUP: Critical Path, Storage Layer]"));
    assert!(compiled.prompt_text.contains("### Global SLA\np99 < 20ms"));
    assert!(!compiled
        .prompt_text
        .contains("### Global SLA [GROUP:"));
}

#[test]
fn sm2_scheduler_intervals_and_bounds_for_all_ratings() {
    let base_ms: i64 = 1_700_000_000_000;
    let day_ms: i64 = 86_400_000;

    let make_card = || StudyCardDto {
        id: "c1".to_owned(),
        node_id: None,
        prompt: "Q".to_owned(),
        answer: "A".to_owned(),
        card_kind: StudyCardKind::Manual,
        repetitions: 0,
        interval_days: 0,
        ease_factor: 2.5,
        lapses: 0,
        due_at: base_ms,
        last_reviewed_at: None,
        created_at: base_ms,
        updated_at: base_ms,
    };

    // Good: rep 0 -> 1d, rep 1 -> 6d, rep 2 -> round(6 * 2.5) = 15d
    let mut good_card = make_card();
    apply_sm2_review(&mut good_card, StudyRating::Good, base_ms);
    assert_eq!(good_card.repetitions, 1);
    assert_eq!(good_card.interval_days, 1);
    assert_eq!(good_card.due_at, base_ms + day_ms);
    assert!((good_card.ease_factor - 2.5).abs() < 1e-9);

    apply_sm2_review(&mut good_card, StudyRating::Good, base_ms + day_ms);
    assert_eq!(good_card.repetitions, 2);
    assert_eq!(good_card.interval_days, 6);
    assert_eq!(good_card.due_at, base_ms + 7 * day_ms);

    apply_sm2_review(&mut good_card, StudyRating::Good, base_ms + 7 * day_ms);
    assert_eq!(good_card.repetitions, 3);
    assert_eq!(good_card.interval_days, 15);
    assert_eq!(good_card.due_at, base_ms + 22 * day_ms);

    // Hard: rep 0 -> 1d, rep 1 -> 3d, rep 2 -> round(3 * 1.2) = 4d
    let mut hard_card = make_card();
    apply_sm2_review(&mut hard_card, StudyRating::Hard, base_ms);
    assert_eq!(hard_card.repetitions, 1);
    assert_eq!(hard_card.interval_days, 1);
    assert!((hard_card.ease_factor - 2.35).abs() < 1e-9);

    apply_sm2_review(&mut hard_card, StudyRating::Hard, base_ms);
    assert_eq!(hard_card.repetitions, 2);
    assert_eq!(hard_card.interval_days, 3);
    assert!((hard_card.ease_factor - 2.20).abs() < 1e-9);

    apply_sm2_review(&mut hard_card, StudyRating::Hard, base_ms);
    assert_eq!(hard_card.repetitions, 3);
    assert_eq!(hard_card.interval_days, 4);

    // Easy: rep 0 -> 4d, rep 1 -> round(4 * 2.65 * 1.3) = 14d, ease_factor capped at 3.5
    let mut easy_card = make_card();
    apply_sm2_review(&mut easy_card, StudyRating::Easy, base_ms);
    assert_eq!(easy_card.repetitions, 1);
    assert_eq!(easy_card.interval_days, 4);
    assert!((easy_card.ease_factor - 2.65).abs() < 1e-9);

    apply_sm2_review(&mut easy_card, StudyRating::Easy, base_ms);
    assert_eq!(easy_card.repetitions, 2);
    assert_eq!(easy_card.interval_days, 14);
    assert!((easy_card.ease_factor - 2.80).abs() < 1e-9);

    for _ in 0..10 {
        apply_sm2_review(&mut easy_card, StudyRating::Easy, base_ms);
    }
    assert!((easy_card.ease_factor - 3.5).abs() < 1e-9);

    // Again: resets reps & interval, increments lapses, floors ease_factor at 1.3, due in +60s
    let mut lapse_card = good_card.clone();
    apply_sm2_review(&mut lapse_card, StudyRating::Again, base_ms);
    assert_eq!(lapse_card.repetitions, 0);
    assert_eq!(lapse_card.interval_days, 0);
    assert_eq!(lapse_card.lapses, 1);
    assert!((lapse_card.ease_factor - 2.3).abs() < 1e-9);
    assert_eq!(lapse_card.due_at, base_ms + 60_000);

    for _ in 0..10 {
        apply_sm2_review(&mut lapse_card, StudyRating::Again, base_ms);
    }
    assert!((lapse_card.ease_factor - 1.3).abs() < 1e-9);
}

#[test]
fn extract_and_sync_study_deck_preserves_sm2_and_cleans_resolved_loopholes() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("study_sync.sqlite");
    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();

    // 1. @study node with explicit Q:/A:
    let study_qa = make_node(
        "n_study_qa",
        NodeType::Probe,
        "WAL Mode @study",
        "Q: Why does SQLite WAL allow concurrent readers?\nA: Readers see a consistent snapshot before the latest append frame.",
        0.0,
        0.0,
    );

    // 2. lens == Study node with LENS_STUDY numbered quiz format
    let mut study_quiz = make_node(
        "n_study_quiz",
        NodeType::Probe,
        "Study & Recall: Backpressure",
        "1. **Q:** What happens without bounded queues? — **A:** Memory grows unbounded until OOM.\n2. **Q:** How does TCP signal backpressure? — **A:** By shrinking the receive window to zero.",
        360.0,
        0.0,
    );
    study_quiz.metadata.lens = NodeLensOrigin::Study;

    // 3. @study fallback without Q:/A:, plus a placeholder Thinking... node to skip
    let study_fallback = make_node(
        "n_study_fallback",
        NodeType::Core,
        "Idempotency Key @study",
        "Clients attach a unique key so retries execute at most once.",
        0.0,
        220.0,
    );
    let study_placeholder = make_node(
        "n_study_placeholder",
        NodeType::Probe,
        "Draft @study",
        "Thinking...",
        0.0,
        440.0,
    );

    // 4. @feynman node (>= 15 chars) and too-short @feynman node (< 15 chars)
    let feynman_ok = make_node(
        "n_feynman_ok",
        NodeType::Probe,
        "Paxos Majority Quorums @feynman",
        "Any two majorities share at least one acceptor, guaranteeing state visibility across terms.",
        360.0,
        220.0,
    );
    let feynman_short = make_node(
        "n_feynman_short",
        NodeType::Probe,
        "Too Short @feynman",
        "Brief note",
        360.0,
        440.0,
    );

    // 5. Core node challenged by an active loophole
    let target_node = make_node(
        "n_target",
        NodeType::Core,
        "Token Validator",
        "Verifies JWT expiry timestamps locally.",
        720.0,
        0.0,
    );
    let loophole_node = make_node(
        "n_loophole",
        NodeType::Loophole,
        "Clock Skew Replay",
        "NTP drift lets expired tokens pass validation across nodes.",
        720.0,
        220.0,
    );
    let challenge_edge = make_edge("e_chal", "n_loophole", "n_target", EdgeType::Challenges);

    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: study_qa },
            GraphOp::CreateNode { node: study_quiz },
            GraphOp::CreateNode {
                node: study_fallback,
            },
            GraphOp::CreateNode {
                node: study_placeholder,
            },
            GraphOp::CreateNode { node: feynman_ok },
            GraphOp::CreateNode {
                node: feynman_short,
            },
            GraphOp::CreateNode { node: target_node },
            GraphOp::CreateNode {
                node: loophole_node,
            },
            GraphOp::CreateEdge {
                edge: challenge_edge,
            },
        ],
    )
    .expect("seed study graph");

    let candidates = extract_study_candidates(&engine);
    assert_eq!(candidates.len(), 5);

    let first_sync = sync_study_deck(&mut conn, &engine).expect("first sync");
    assert_eq!(first_sync.added_count, 5);
    assert_eq!(first_sync.cards.len(), 5);

    let qa_card = first_sync
        .cards
        .iter()
        .find(|c| c.node_id.as_deref() == Some("n_study_qa"))
        .expect("qa card");
    assert_eq!(qa_card.prompt, "Why does SQLite WAL allow concurrent readers?");
    assert_eq!(
        qa_card.answer,
        "Readers see a consistent snapshot before the latest append frame."
    );

    let quiz_card = first_sync
        .cards
        .iter()
        .find(|c| c.node_id.as_deref() == Some("n_study_quiz"))
        .expect("quiz card");
    assert!(quiz_card.prompt.contains("1. What happens without bounded queues?"));
    assert!(quiz_card.answer.contains("2. By shrinking the receive window to zero."));

    let feynman_card = first_sync
        .cards
        .iter()
        .find(|c| c.node_id.as_deref() == Some("n_feynman_ok"))
        .expect("feynman card");
    assert_eq!(
        feynman_card.prompt,
        "Explain from first principles: Paxos Majority Quorums @feynman"
    );

    let loophole_card = first_sync
        .cards
        .iter()
        .find(|c| c.node_id.as_deref() == Some("n_target") && c.card_kind == StudyCardKind::Loophole)
        .expect("loophole card");
    assert_eq!(
        loophole_card.prompt,
        "What failure mode or loophole threatens \"Token Validator\"?"
    );
    assert!(loophole_card.answer.contains("Clock Skew Replay"));

    // Create a manual card (must never be overwritten or deleted by sync)
    let manual = create_study_card(
        &mut conn,
        None,
        "Define linearizability",
        "Every operation appears to take effect atomically between invocation and response.",
        StudyCardKind::Manual,
    )
    .expect("create manual card");

    // Review qa_card with Good so it gets SM-2 state + future due_at
    let review_now = 1_700_000_000_000_i64;
    let reviewed = review_study_card(&mut conn, &qa_card.id, StudyRating::Good, review_now)
        .expect("review qa card");
    assert_eq!(reviewed.repetitions, 1);
    assert_eq!(reviewed.interval_days, 1);
    assert_eq!(reviewed.due_at, review_now + 86_400_000);

    // Edit n_study_qa answer and resolve n_loophole
    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::UpdateNodeText {
                id: "n_study_qa".to_owned(),
                title: "WAL Mode @study".to_owned(),
                content: "Q: Why does SQLite WAL allow concurrent readers?\nA: Readers pin a WAL end mark and never block writers."
                    .to_owned(),
            },
            GraphOp::UpdateNodeMeta {
                id: "n_loophole".to_owned(),
                node_type: None,
                status: Some(NodeStatus::Resolved),
                severity: None,
                pin_global: None,
                exclude_from_ai: None,
                collapsed: None,
            },
        ],
    )
    .expect("edit study node and resolve loophole");

    let second_sync = sync_study_deck(&mut conn, &engine).expect("second sync");
    assert_eq!(second_sync.added_count, 0);
    // 5 original - 1 resolved loophole + 1 manual = 5 cards
    assert_eq!(second_sync.cards.len(), 5);

    let refreshed_qa = second_sync
        .cards
        .iter()
        .find(|c| c.id == qa_card.id)
        .expect("qa card preserved");
    assert_eq!(
        refreshed_qa.answer,
        "Readers pin a WAL end mark and never block writers."
    );
    assert_eq!(refreshed_qa.repetitions, 1);
    assert_eq!(refreshed_qa.interval_days, 1);
    assert_eq!(refreshed_qa.due_at, review_now + 86_400_000);
    assert_eq!(refreshed_qa.last_reviewed_at, Some(review_now));

    assert!(
        !second_sync
            .cards
            .iter()
            .any(|c| c.card_kind == StudyCardKind::Loophole),
        "resolved loophole card should be auto-deleted"
    );
    assert!(second_sync.cards.iter().any(|c| c.id == manual.id));

    // Verify due_only filter and delete_study_card
    let due_cards = list_study_cards(&conn, true).expect("list due cards");
    assert!(!due_cards.iter().any(|c| c.id == qa_card.id));

    delete_study_card(&mut conn, &manual.id).expect("delete manual card");
    let remaining = list_study_cards(&conn, false).expect("list remaining");
    assert_eq!(remaining.len(), 4);
}

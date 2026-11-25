use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use rusqlite::Connection;
use tempfile::tempdir;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use axiom_canvas_lib::ai::provider::{
    build_openai_compat_body, is_reasoning_openai_model, LlmStreamRequest,
};
use axiom_canvas_lib::ai::runner::{execute_lens_run, LensRunParams};
use axiom_canvas_lib::db::queries::{
    apply_ops, find_related_nodes, save_flow_system_prompt, search_nodes,
    search_nodes_with_provenance,
};
use axiom_canvas_lib::db::{hydrate_or_seed_workspace, open_connection};
use axiom_canvas_lib::graph::models::{
    compute_content_hash, estimate_tokens, ContextControls, CreatedBy, EdgeDto, EdgeType,
    EdgeWeight, GraphOp, LensKind, ModelTierConfig, NodeDto, NodeLayout, NodeLensOrigin,
    NodeMetadata, NodeStatus, NodeType, ProviderKind, StaleReason,
};
use axiom_canvas_lib::graph::provenance::{acknowledge_stale_node, compute_stale_nodes};
use axiom_canvas_lib::graph::spatial::{
    compute_tidy_subtree, effective_height, DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH, H_GAP,
};
use axiom_canvas_lib::graph::GraphEngine;
use axiom_canvas_lib::ipc::commands::search_workspace_flows_in_catalog;
use axiom_canvas_lib::ipc::ActiveWorkspace;
use axiom_canvas_lib::workspaces::WorkspaceCatalogStore;

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
                Some(axiom_canvas_lib::graph::models::Severity::High)
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

fn rects_overlap(a: &NodeDto, b: &NodeDto) -> bool {
    let ax2 = a.layout.x + a.layout.width;
    let ay2 = a.layout.y + effective_height(a);
    let bx2 = b.layout.x + b.layout.width;
    let by2 = b.layout.y + effective_height(b);
    a.layout.x < bx2 && ax2 > b.layout.x && a.layout.y < by2 && ay2 > b.layout.y
}

#[test]
fn v1_to_v2_migration_preserves_rows_fts_edges_and_enables_research_study_origins() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("legacy_v1.sqlite");

    // Create a true Schema v1 SQLite file without ai_runs, system_prompt, or research/study CHECK values.
    {
        let conn = Connection::open(&db_path).expect("open raw v1 sqlite");
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE workspace_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT INTO workspace_meta (key, value) VALUES
                ('schema_version', '1'),
                ('camera_x', '12.5'),
                ('camera_y', '-8.0'),
                ('camera_zoom', '1.25'),
                ('last_focus_id', 'n_v1_core'),
                ('token_budget', '4096');
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
                lens            TEXT NOT NULL DEFAULT 'manual' CHECK (lens IN ('manual', 'red_team', 'edge_case', 'diverge', 'feynman', 'synthesize', 'custom')),
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
                ('n_v1_core', 'core', 'active', 'Raft Consensus Core', 'Preserves linearizability under partitions', '', 'h1', '', 'manual', 'user', 10, 100, 100),
                ('n_v1_lh', 'loophole', 'active', 'Clock Drift Flaw', 'Lease timers skew', '', 'h2', '', 'red_team', 'ai', 8, 101, 101);
            INSERT INTO edges (id, source_id, target_id, type, weight, created_at)
            VALUES ('e_v1', 'n_v1_lh', 'n_v1_core', 'challenges', 'summary', 102);
            "#,
        )
        .expect("seed v1 schema");
    }

    // Open through Axiom migration runner -> upgrades v1 -> v2.
    let mut conn = open_connection(&db_path).expect("migrate v1 to v2");

    let schema_version: String = conn
        .query_row(
            "SELECT value FROM workspace_meta WHERE key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .expect("schema_version");
    assert!(schema_version.parse::<i64>().unwrap_or(0) >= 2);

    let fk_enabled: i64 = conn
        .query_row("PRAGMA foreign_keys;", [], |r| r.get(0))
        .expect("foreign_keys pragma");
    assert_eq!(fk_enabled, 1);

    let ai_runs_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ai_runs'",
            [],
            |r| r.get(0),
        )
        .expect("ai_runs table");
    assert_eq!(ai_runs_exists, 1);

    let snap = hydrate_or_seed_workspace(&mut conn, &db_path.to_string_lossy())
        .expect("hydrate migrated workspace");
    assert_eq!(snap.nodes.len(), 2);
    assert_eq!(snap.edges.len(), 1);
    assert_eq!(snap.token_budget, 4096);
    assert_eq!(snap.system_prompt, "");

    // FTS5 rebuilt and searchable after migration.
    let fts_hits = search_nodes(&conn, "linearizability", 10).expect("fts after migration");
    assert_eq!(fts_hits.len(), 1);
    assert_eq!(fts_hits[0].id, "n_v1_core");

    // Native research & study origins accepted by v2 CHECK constraint.
    let mut engine = GraphEngine::from_snapshot(&snap.nodes, &snap.edges);
    let mut res_node = make_node("n_res", NodeType::Probe, "Research Probe", "Empirical bounds", 300.0, 0.0);
    res_node.metadata.lens = NodeLensOrigin::Research;
    let mut study_node = make_node("n_stu", NodeType::Probe, "Study Guide", "Active recall", 300.0, 220.0);
    study_node.metadata.lens = NodeLensOrigin::Study;
    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: res_node },
            GraphOp::CreateNode { node: study_node },
        ],
    )
    .expect("insert research and study origin nodes");

    // Flow system prompt round-trips.
    save_flow_system_prompt(&mut conn, "Always cite RFC sections.").expect("save system prompt");
    let snap2 = hydrate_or_seed_workspace(&mut conn, &db_path.to_string_lossy())
        .expect("rehydrate with system prompt");
    assert_eq!(snap2.system_prompt, "Always cite RFC sections.");
}

#[tokio::test]
async fn provenance_lifecycle_tracks_modified_deleted_acknowledge_and_stale_filter() {
    let captured_sys_prompts = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured_ref = captured_sys_prompts.clone();

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
    let addr = listener.local_addr().expect("addr");
    let base_url = format!("http://{addr}");

    thread::spawn(move || {
        for stream_res in listener.incoming() {
            let Ok(mut stream) = stream_res else { break };
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            let mut content_len = 0usize;
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).is_err() {
                    break;
                }
                let tr = h.trim_end_matches(['\r', '\n']);
                if tr.is_empty() {
                    break;
                }
                if let Some((k, v)) = tr.split_once(':') {
                    if k.eq_ignore_ascii_case("content-length") {
                        content_len = v.trim().parse().unwrap_or(0);
                    }
                }
            }
            let mut body_bytes = vec![0u8; content_len];
            if content_len > 0 {
                let _ = reader.read_exact(&mut body_bytes);
            }
            if let Ok(json_body) = serde_json::from_slice::<serde_json::Value>(&body_bytes) {
                if let Some(sys) = json_body.pointer("/messages/0/content").and_then(|v| v.as_str()) {
                    if let Ok(mut list) = captured_ref.lock() {
                        list.push(sys.to_owned());
                    }
                }
            }

            let sse = format!(
                "data: {}\n\ndata: [DONE]\n\n",
                serde_json::json!({
                    "choices": [{
                        "delta": {
                            "content": "@@NODE type=probe edge=derives title=\"Research Finding\"\nDerived from root and pin.\n@@END\n"
                        }
                    }]
                })
            );
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}",
                sse.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });

    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("prov.sqlite");
    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();

    let root = make_node("n_root", NodeType::Core, "Root Spec", "Initial spec v1", 0.0, 0.0);
    let mut pin = make_node("n_pin", NodeType::Core, "Latency Budget", "p99 < 20ms", -380.0, 0.0);
    pin.context_controls.pin_global = true;

    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: root },
            GraphOp::CreateNode { node: pin },
        ],
    )
    .expect("seed nodes");

    let ws = Arc::new(RwLock::new(Some(ActiveWorkspace {
        path: db_path.to_string_lossy().into_owned(),
        engine,
        token_budget: 6000,
        system_prompt: "Prefer formal invariants.".to_owned(),
    })));
    let db = Arc::new(Mutex::new(Some(conn)));
    let active_runs = Arc::new(Mutex::new(HashMap::new()));
    let (summary_tx, _summary_rx) = mpsc::unbounded_channel();
    let ws_gen = Arc::new(AtomicU64::new(1));

    let spawned = execute_lens_run(
        LensRunParams {
            run_id: "run_prov".to_owned(),
            lens: LensKind::Research,
            focus_ids: vec!["n_root".to_owned()],
            custom_prompt: None,
            in_place: false,
            custom_lens: None,
            config: ModelTierConfig {
                provider: ProviderKind::OpenaiCompat,
                base_url,
                model: "gpt-4o".to_owned(),
                has_api_key: false,
                temperature: 0.4,
                max_tokens: 512,
            },
            api_key: None,
            token_budget: 6000,
            expected_generation: 1,
            prepared: None,
        },
        ws.clone(),
        db.clone(),
        ws_gen,
        active_runs,
        summary_tx,
        reqwest::Client::new(),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .expect("research lens run");

    assert_eq!(spawned.len(), 1);
    let ai_node_id = spawned[0].clone();

    // Verify flow system instructions were appended to system_prompt.
    {
        let prompts = captured_sys_prompts.lock().expect("sys prompts");
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].contains("[FLOW SYSTEM INSTRUCTIONS]\nPrefer formal invariants."));
    }

    let mut ws_g = ws.write().expect("ws write");
    let mut db_g = db.lock().expect("db lock");
    let active = ws_g.as_mut().expect("active");
    let conn_ref = db_g.as_mut().expect("conn");

    assert_eq!(
        active.engine.nodes[&ai_node_id].metadata.lens,
        NodeLensOrigin::Research
    );

    // Initially fresh -> 0 stale nodes.
    assert!(compute_stale_nodes(conn_ref, &active.engine)
        .expect("compute stale")
        .is_empty());

    // Editing the spawned AI node itself must NOT mark it stale.
    apply_ops(
        conn_ref,
        &mut active.engine,
        &[GraphOp::UpdateNodeText {
            id: ai_node_id.clone(),
            title: "Research Finding Edited".to_owned(),
            content: "Minor copy edit.".to_owned(),
        }],
    )
    .expect("edit spawned node");
    assert!(compute_stale_nodes(conn_ref, &active.engine)
        .expect("still not stale")
        .is_empty());

    // Editing upstream n_root marks ai_node_id stale with Modified.
    apply_ops(
        conn_ref,
        &mut active.engine,
        &[GraphOp::UpdateNodeText {
            id: "n_root".to_owned(),
            title: "Root Spec".to_owned(),
            content: "Updated spec v2".to_owned(),
        }],
    )
    .expect("modify root");

    let stale = compute_stale_nodes(conn_ref, &active.engine).expect("stale after modify");
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].node_id, ai_node_id);
    assert_eq!(stale[0].lens, LensKind::Research);
    assert_eq!(stale[0].changed_inputs.len(), 1);
    assert_eq!(stale[0].changed_inputs[0].node_id, "n_root");
    assert_eq!(stale[0].changed_inputs[0].reason, StaleReason::Modified);

    let stale_hits =
        search_nodes_with_provenance(conn_ref, &active.engine, "stale:true", 30).expect("stale:true");
    assert_eq!(stale_hits.len(), 1);
    assert_eq!(stale_hits[0].id, ai_node_id);

    let fresh_hits =
        search_nodes_with_provenance(conn_ref, &active.engine, "stale:false", 30).expect("stale:false");
    assert!(!fresh_hits.iter().any(|h| h.id == ai_node_id));

    // Acknowledge clears Modified staleness.
    acknowledge_stale_node(conn_ref, &active.engine, &ai_node_id).expect("ack modified");
    assert!(compute_stale_nodes(conn_ref, &active.engine)
        .expect("cleared after ack")
        .is_empty());

    // Deleting upstream n_pin marks ai_node_id stale with Deleted.
    apply_ops(
        conn_ref,
        &mut active.engine,
        &[GraphOp::DeleteNodes {
            ids: vec!["n_pin".to_owned()],
        }],
    )
    .expect("delete pin");

    let stale_del = compute_stale_nodes(conn_ref, &active.engine).expect("stale after delete");
    assert_eq!(stale_del.len(), 1);
    assert_eq!(stale_del[0].changed_inputs[0].node_id, "n_pin");
    assert_eq!(stale_del[0].changed_inputs[0].reason, StaleReason::Deleted);

    acknowledge_stale_node(conn_ref, &active.engine, &ai_node_id).expect("ack deleted");
    assert!(compute_stale_nodes(conn_ref, &active.engine)
        .expect("cleared after ack deleted")
        .is_empty());
}

#[test]
fn find_related_nodes_ranks_bm25_and_excludes_direct_neighbors_and_dismissed() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("related.sqlite");
    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();

    let focus = make_node(
        "n_focus",
        NodeType::Core,
        "Raft Consensus Quorum",
        "Leader election and log replication safety",
        0.0,
        0.0,
    );
    let neighbor = make_node(
        "n_neighbor",
        NodeType::Branch,
        "Raft Consensus Neighbor",
        "Directly connected leader election node",
        400.0,
        0.0,
    );
    let strong = make_node(
        "n_strong",
        NodeType::Branch,
        "Raft Consensus Leader Election",
        "Quorum safety and log replication proof",
        800.0,
        0.0,
    );
    let weak = make_node(
        "n_weak",
        NodeType::Probe,
        "Storage Notes",
        "Mentions quorum briefly in passing",
        800.0,
        240.0,
    );
    let mut dismissed = make_node(
        "n_dismissed",
        NodeType::Loophole,
        "Raft Consensus Dismissed",
        "Leader election quorum",
        800.0,
        480.0,
    );
    dismissed.status = NodeStatus::Dismissed;

    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: focus },
            GraphOp::CreateNode { node: neighbor },
            GraphOp::CreateNode { node: strong },
            GraphOp::CreateNode { node: weak },
            GraphOp::CreateNode { node: dismissed },
            GraphOp::CreateEdge {
                edge: make_edge("e_fn", "n_focus", "n_neighbor", EdgeType::Derives),
            },
        ],
    )
    .expect("seed related graph");

    let hits = find_related_nodes(&conn, &engine, "n_focus", 10).expect("find_related_nodes");
    let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(ids, vec!["n_strong", "n_weak"]);
    assert!(hits[0].score >= hits[1].score);
    assert!(hits[0].score > 0.0);
}

#[test]
fn workspace_wide_search_scans_active_and_sibling_flows_read_only() {
    let dir = tempdir().expect("tempdir");
    let store = WorkspaceCatalogStore::with_root_dir(dir.path().to_path_buf());
    let initial = store.load_or_init().expect("init catalog");
    let ws_id = initial.workspaces[0].id.clone();
    let active_flow_id = initial.active_flow_id.clone();
    let active_db_path = PathBuf::from(&initial.workspaces[0].flows[0].db_path);

    let (cat2, sibling_flow) = store
        .create_flow(&ws_id, "Sibling Flow", "blank")
        .expect("create sibling flow");
    let (_cat3, _missing_flow) = store
        .create_flow(&ws_id, "Missing Flow", "blank")
        .expect("create missing flow without sqlite file");
    let (catalog, _) = store
        .set_active(&ws_id, &active_flow_id)
        .expect("switch back to active flow");
    assert_eq!(catalog.active_flow_id, active_flow_id);

    // Seed active flow DB
    let mut active_conn = open_connection(&active_db_path).expect("open active db");
    let mut active_engine = GraphEngine::default();
    let n_active = make_node(
        "n_active_hit",
        NodeType::Core,
        "Zero-Copy Ringbuffer",
        "Lock-free SPSC telemetry queue",
        0.0,
        0.0,
    );
    apply_ops(
        &mut active_conn,
        &mut active_engine,
        &[GraphOp::CreateNode { node: n_active }],
    )
    .expect("seed active flow");

    // Seed sibling flow DB on disk and close connection so read-only query reads from disk
    let sibling_db_path = PathBuf::from(&sibling_flow.db_path);
    {
        let mut sib_conn = open_connection(&sibling_db_path).expect("open sibling db");
        let mut sib_engine = GraphEngine::default();
        let n_sib = make_node(
            "n_sib_hit",
            NodeType::Branch,
            "Telemetry Compression",
            "Delta encoding over lock-free ringbuffer",
            0.0,
            0.0,
        );
        apply_ops(
            &mut sib_conn,
            &mut sib_engine,
            &[GraphOp::CreateNode { node: n_sib }],
        )
        .expect("seed sibling flow");
    }

    let _ = cat2;
    let hits = search_workspace_flows_in_catalog(
        &catalog,
        Some(&active_conn),
        Some(&active_engine),
        Some(&active_db_path.to_string_lossy()),
        "telemetry",
        30,
    )
    .expect("workspace-wide search");

    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].flow_id, active_flow_id);
    assert_eq!(hits[0].hit.id, "n_active_hit");
    assert_eq!(hits[1].flow_id, sibling_flow.id);
    assert_eq!(hits[1].flow_name, "Sibling Flow");
    assert_eq!(hits[1].hit.id, "n_sib_hit");
}

#[test]
fn reasoning_openai_models_omit_temperature_and_use_max_completion_tokens() {
    for reasoning_model in ["o3-mini", "o1", "gpt-5", "gpt-5.1", "openai/o4-mini"] {
        assert!(
            is_reasoning_openai_model(reasoning_model),
            "expected reasoning model: {reasoning_model}"
        );
        let req = LlmStreamRequest {
            system_prompt: "sys".to_owned(),
            user_prompt: "usr".to_owned(),
            config: ModelTierConfig {
                provider: ProviderKind::OpenaiCompat,
                base_url: "https://api.openai.com/v1".to_owned(),
                model: reasoning_model.to_owned(),
                has_api_key: true,
                temperature: 0.3,
                max_tokens: 4096,
            },
            api_key: None,
        };
        let body = build_openai_compat_body(&req);
        assert!(body.get("temperature").is_none());
        assert!(body.get("max_tokens").is_none());
        assert_eq!(body["max_completion_tokens"], serde_json::json!(4096));
    }

    assert!(!is_reasoning_openai_model("gpt-4o"));
    let std_req = LlmStreamRequest {
        system_prompt: "sys".to_owned(),
        user_prompt: "usr".to_owned(),
        config: ModelTierConfig {
            provider: ProviderKind::OpenaiCompat,
            base_url: "https://api.openai.com/v1".to_owned(),
            model: "gpt-4o".to_owned(),
            has_api_key: true,
            temperature: 0.3,
            max_tokens: 2048,
        },
        api_key: None,
    };
    let std_body = build_openai_compat_body(&std_req);
    assert!(std_body.get("max_completion_tokens").is_none());
    assert_eq!(std_body["max_tokens"], serde_json::json!(2048));
    assert!((std_body["temperature"].as_f64().expect("temp") - 0.3).abs() < 1e-5);
}

#[test]
fn tidy_subtree_handles_synthesizes_spine_and_resolves_mitigations_without_overlap() {
    let root = make_node("root", NodeType::Core, "Root", "", 0.0, 0.0);
    let branch = make_node("b1", NodeType::Branch, "Branch 1", "", 40.0, 50.0);
    let synth = make_node("s1", NodeType::Synthesis, "Synthesis", "", 60.0, 80.0);
    let loophole = make_node("lh1", NodeType::Loophole, "Loophole", "", 800.0, -400.0);
    let mitigation = make_node("mit1", NodeType::Branch, "Mitigation", "", -500.0, -500.0);

    let mut engine = GraphEngine::from_snapshot(
        &[root, branch, synth, loophole, mitigation],
        &[
            make_edge("e1", "root", "b1", EdgeType::Branches),
            make_edge("e2", "b1", "s1", EdgeType::Synthesizes),
            make_edge("e3", "lh1", "b1", EdgeType::Challenges),
            make_edge("e4", "mit1", "lh1", EdgeType::Resolves),
        ],
    );

    let updates = compute_tidy_subtree(&engine, "root").expect("tidy subtree");
    for u in &updates {
        if let Some(node) = engine.nodes.get_mut(&u.id) {
            node.layout.x = u.x;
            node.layout.y = u.y;
            let updated = node.clone();
            engine.spatial.upsert(&updated);
        }
    }

    let b1 = &engine.nodes["b1"];
    let s1 = &engine.nodes["s1"];
    let lh1 = &engine.nodes["lh1"];
    let mit1 = &engine.nodes["mit1"];

    assert!(
        s1.layout.x >= b1.layout.x + b1.layout.width + H_GAP - 1e-6,
        "synthesis child must sit to the right of b1"
    );
    assert!(
        lh1.layout.y > b1.layout.y,
        "loophole must sit below b1"
    );
    assert!(
        (mit1.layout.y - lh1.layout.y).abs() < 1e-6 || mit1.layout.y > lh1.layout.y,
        "mitigation must sit adjacent to loophole"
    );

    let all = engine.all_nodes_sorted();
    for i in 0..all.len() {
        for j in (i + 1)..all.len() {
            assert!(
                !rects_overlap(&all[i], &all[j]),
                "overlap between {} and {}",
                all[i].id,
                all[j].id
            );
        }
    }
}

use std::time::{Duration, Instant};

use rusqlite::params;
use tempfile::NamedTempFile;

use axiom_canvas_lib::ai::parser::{LensDefaults, NodeStreamParser, ParsedEvent};
use axiom_canvas_lib::db::json_io::{export_json, import_json};
use axiom_canvas_lib::db::open_connection;
use axiom_canvas_lib::db::queries::{apply_ops, search_nodes, spawn_connected_node};
use axiom_canvas_lib::error::IpcErrorCode;
use axiom_canvas_lib::graph::compiler::compile_context;
use axiom_canvas_lib::graph::models::{
    compute_content_hash, estimate_tokens, CameraState, ContextControls, CreatedBy, EdgeDto,
    EdgeType, EdgeWeight, GraphOp, InclusionMode, NodeDto, NodeLayout, NodeLensOrigin,
    NodeMetadata, NodeStatus, NodeType, Severity,
};
use axiom_canvas_lib::graph::spatial::{
    compute_tidy_subtree, effective_height, find_free_position, DEFAULT_NODE_HEIGHT,
    DEFAULT_NODE_WIDTH, H_GAP,
};
use axiom_canvas_lib::graph::GraphEngine;

fn make_node(id: &str, node_type: NodeType, title: &str, content: &str, x: f64, y: f64) -> NodeDto {
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

fn rects_overlap(a: &NodeDto, b: &NodeDto) -> bool {
    let ax2 = a.layout.x + a.layout.width;
    let ay2 = a.layout.y + effective_height(a);
    let bx2 = b.layout.x + b.layout.width;
    let by2 = b.layout.y + effective_height(b);
    a.layout.x < bx2 && ax2 > b.layout.x && a.layout.y < by2 && ay2 > b.layout.y
}

#[test]
fn ut_rs_01_migrations_cascade_and_fts_delete() {
    let tmp = NamedTempFile::new().expect("create temp file");
    let mut conn = open_connection(tmp.path()).expect("open sqlite connection");

    let journal: String = conn
        .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
        .expect("query journal_mode");
    assert_eq!(journal.to_lowercase(), "wal");

    let fk: i64 = conn
        .query_row("PRAGMA foreign_keys;", [], |r| r.get(0))
        .expect("query foreign_keys");
    assert_eq!(fk, 1);

    let fts_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='nodes_fts'",
            [],
            |r| r.get(0),
        )
        .expect("query fts table");
    assert_eq!(fts_count, 1);

    let mut engine = GraphEngine::default();
    let n1 = make_node("node_1", NodeType::Core, "Zookeeper Quorum", "Consensus protocol", 0.0, 0.0);
    let n2 = make_node("node_2", NodeType::Branch, "Follower", "Read replica", 420.0, 0.0);
    let e1 = make_edge("edge_1", "node_1", "node_2", EdgeType::Derives);

    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: n1 },
            GraphOp::CreateNode { node: n2 },
            GraphOp::CreateEdge { edge: e1 },
        ],
    )
    .expect("seed nodes and edge");

    let fts_before: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM nodes_fts WHERE nodes_fts MATCH 'zookeeper'",
            [],
            |r| r.get(0),
        )
        .expect("fts query before delete");
    assert_eq!(fts_before, 1);

    let (del_res, _) = apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::DeleteNodes {
            ids: vec!["node_1".to_owned()],
        }],
    )
    .expect("delete node_1");

    assert_eq!(del_res.deleted_node_ids, vec!["node_1".to_owned()]);
    assert_eq!(del_res.deleted_edge_ids, vec!["edge_1".to_owned()]);

    let edge_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
        .expect("count edges");
    assert_eq!(edge_count, 0);

    let fts_after: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM nodes_fts WHERE nodes_fts MATCH 'zookeeper'",
            [],
            |r| r.get(0),
        )
        .expect("fts query after delete");
    assert_eq!(fts_after, 0);
}

#[test]
fn ut_rs_02_move_nodes_fts_immunity_and_resolves_auto_flip() {
    let tmp = NamedTempFile::new().expect("create temp file");
    let mut conn = open_connection(tmp.path()).expect("open sqlite connection");
    let mut engine = GraphEngine::default();

    let core = make_node("node_core", NodeType::Core, "API Gateway", "Handles TLS termination", 0.0, 0.0);
    let loophole = make_node(
        "node_lh",
        NodeType::Loophole,
        "Cert Expiry Risk",
        "No automated rotation",
        0.0,
        240.0,
    );
    let fix = make_node(
        "node_fix",
        NodeType::Branch,
        "ACME Renewer",
        "Automated cert renewal daemon",
        420.0,
        240.0,
    );
    let challenge = make_edge("edge_ch", "node_lh", "node_core", EdgeType::Challenges);

    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: core },
            GraphOp::CreateNode { node: loophole },
            GraphOp::CreateNode { node: fix },
            GraphOp::CreateEdge { edge: challenge },
        ],
    )
    .expect("create initial graph");

    let (hash_before, updated_before): (String, i64) = conn
        .query_row(
            "SELECT content_hash, updated_at FROM nodes WHERE id = 'node_core'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("fetch node_core before move");

    let fts_before: Vec<Vec<u8>> = {
        let mut stmt = conn
            .prepare("SELECT block FROM nodes_fts_data ORDER BY id ASC")
            .expect("prepare fts data");
        stmt.query_map([], |r| r.get(0))
            .expect("query fts data")
            .map(|r| r.expect("block"))
            .collect()
    };

    apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::MoveNodes {
            moves: vec![axiom_canvas_lib::graph::models::NodePositionUpdate {
                id: "node_core".to_owned(),
                x: 512.0,
                y: -128.0,
            }],
        }],
    )
    .expect("move node_core");

    let (hash_after, updated_after): (String, i64) = conn
        .query_row(
            "SELECT content_hash, updated_at FROM nodes WHERE id = 'node_core'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("fetch node_core after move");
    assert_eq!(hash_before, hash_after);
    assert_eq!(updated_before, updated_after);

    let fts_after: Vec<Vec<u8>> = {
        let mut stmt = conn
            .prepare("SELECT block FROM nodes_fts_data ORDER BY id ASC")
            .expect("prepare fts data");
        stmt.query_map([], |r| r.get(0))
            .expect("query fts data")
            .map(|r| r.expect("block"))
            .collect()
    };
    assert_eq!(fts_before, fts_after);

    let resolve_edge = make_edge("edge_res", "node_fix", "node_lh", EdgeType::Resolves);
    let (res, _) = apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::CreateEdge { edge: resolve_edge }],
    )
    .expect("create resolves edge");

    let resolved_dto = res
        .updated_nodes
        .iter()
        .find(|n| n.id == "node_lh")
        .expect("loophole returned in updated_nodes");
    assert_eq!(resolved_dto.status, NodeStatus::Resolved);
    assert_eq!(
        engine.nodes.get("node_lh").expect("in engine").status,
        NodeStatus::Resolved
    );

    // Verify locked guard & duplicate edge error
    apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::UpdateNodeMeta {
            id: "node_core".to_owned(),
            node_type: None,
            status: Some(NodeStatus::Locked),
            severity: None,
            pin_global: None,
            exclude_from_ai: None,
            collapsed: None,
        }],
    )
    .expect("lock node_core");

    let lock_err = apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::UpdateNodeText {
            id: "node_core".to_owned(),
            title: "Tampered".to_owned(),
            content: "Nope".to_owned(),
        }],
    )
    .expect_err("updating locked node must fail");
    assert_eq!(lock_err.code, IpcErrorCode::NodeLocked);

    let dup_err = apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::CreateEdge {
            edge: make_edge("edge_res_dup", "node_fix", "node_lh", EdgeType::Resolves),
        }],
    )
    .expect_err("duplicate edge must fail");
    assert_eq!(dup_err.code, IpcErrorCode::DuplicateEdge);
}

#[test]
fn ut_rs_03_search_nodes_filters_bm25_and_sanitization() {
    let tmp = NamedTempFile::new().expect("create temp file");
    let mut conn = open_connection(tmp.path()).expect("open sqlite connection");
    let mut engine = GraphEngine::default();

    let mut lh_crit = make_node(
        "node_lh_crit",
        NodeType::Loophole,
        "Consensus Quorum Split",
        "Network partition causes dual leaders",
        0.0,
        0.0,
    );
    lh_crit.metadata.severity = Some(Severity::Critical);

    let mut lh_med = make_node(
        "node_lh_med",
        NodeType::Loophole,
        "Consensus Retry Storm",
        "Client retries saturate gateway",
        0.0,
        200.0,
    );
    lh_med.metadata.severity = Some(Severity::Medium);

    let mut lh_resolved = make_node(
        "node_lh_res",
        NodeType::Loophole,
        "Consensus Legacy Bug",
        "Already fixed",
        0.0,
        400.0,
    );
    lh_resolved.status = NodeStatus::Resolved;
    lh_resolved.metadata.severity = Some(Severity::Critical);

    let br_active = make_node(
        "node_br",
        NodeType::Branch,
        "Consensus Raft Option",
        "foo bar baz details",
        400.0,
        0.0,
    );

    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: lh_crit },
            GraphOp::CreateNode { node: lh_med },
            GraphOp::CreateNode { node: lh_resolved },
            GraphOp::CreateNode { node: br_active },
        ],
    )
    .expect("seed searchable nodes");

    let filtered = search_nodes(&conn, "status:active type:loophole consen", 30)
        .expect("filtered bm25 search");
    let ids: Vec<&str> = filtered.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&"node_lh_crit"));
    assert!(ids.contains(&"node_lh_med"));

    let structured_only = search_nodes(&conn, "status:active type:loophole", 30)
        .expect("structured-only severity ordering");
    assert_eq!(structured_only.len(), 2);
    assert_eq!(structured_only[0].id, "node_lh_crit");
    assert_eq!(structured_only[1].id, "node_lh_med");

    let malformed = search_nodes(&conn, "\"foo:(bar", 30)
        .expect("malformed FTS5 punctuation must not error");
    assert_eq!(malformed.len(), 1);
    assert_eq!(malformed[0].id, "node_br");
}

#[test]
fn ut_rs_04_compiler_sibling_isolation() {
    let p = make_node("p", NodeType::Core, "Parent", "Core architecture", 0.0, 0.0);
    let b1 = make_node("b1", NodeType::Branch, "Branch One", "Approach A", 420.0, 0.0);
    let b2 = make_node("b2", NodeType::Branch, "Branch Two", "Approach B", 420.0, 220.0);

    let engine = GraphEngine::from_snapshot(
        &[p, b1, b2],
        &[
            make_edge("e1", "p", "b1", EdgeType::Branches),
            make_edge("e2", "p", "b2", EdgeType::Branches),
        ],
    );

    let compiled = compile_context(&engine, &["b1".to_owned()], 6000);
    assert!(compiled.xray.node_modes.contains_key("p"));
    assert!(compiled.xray.node_modes.contains_key("b1"));
    assert!(!compiled.xray.node_modes.contains_key("b2"));
    assert!(compiled.prompt_text.contains("Branch One"));
    assert!(!compiled.prompt_text.contains("Branch Two"));
}

#[test]
fn ut_rs_05_compiler_diamond_dag_dedup() {
    let root = make_node("n_root", NodeType::Core, "Root Spec", "Single source", 0.0, 0.0);
    let a = make_node("n_a", NodeType::Branch, "Path A", "Left arm", 420.0, 0.0);
    let b = make_node("n_b", NodeType::Branch, "Path B", "Right arm", 420.0, 220.0);
    let merge = make_node("n_merge", NodeType::Synthesis, "Decision", "Merged result", 840.0, 110.0);

    let engine = GraphEngine::from_snapshot(
        &[root, a, b, merge],
        &[
            make_edge("e1", "n_root", "n_a", EdgeType::Branches),
            make_edge("e2", "n_root", "n_b", EdgeType::Branches),
            make_edge("e3", "n_a", "n_merge", EdgeType::Synthesizes),
            make_edge("e4", "n_b", "n_merge", EdgeType::Synthesizes),
        ],
    );

    let compiled = compile_context(&engine, &["n_merge".to_owned()], 6000);
    assert_eq!(compiled.prompt_text.matches("### Root Spec").count(), 1);
    let root_pos = compiled.prompt_text.find("Root Spec").expect("root present");
    let a_pos = compiled.prompt_text.find("Path A").expect("path A present");
    let b_pos = compiled.prompt_text.find("Path B").expect("path B present");
    assert!(root_pos < a_pos && root_pos < b_pos);
}

#[test]
fn ut_rs_06_compiler_cycle_safety() {
    let a = make_node("n_a", NodeType::Core, "Node A", "Alpha", 0.0, 0.0);
    let b = make_node("n_b", NodeType::Branch, "Node B", "Beta", 420.0, 0.0);
    let c = make_node("n_c", NodeType::Branch, "Node C", "Gamma", 840.0, 0.0);

    let engine = GraphEngine::from_snapshot(
        &[a, b, c],
        &[
            make_edge("e1", "n_a", "n_b", EdgeType::Derives),
            make_edge("e2", "n_b", "n_c", EdgeType::Derives),
            make_edge("e3", "n_c", "n_a", EdgeType::Derives),
        ],
    );

    let t0 = Instant::now();
    let compiled1 = compile_context(&engine, &["n_a".to_owned()], 6000);
    let elapsed = t0.elapsed();
    let compiled2 = compile_context(&engine, &["n_a".to_owned()], 6000);

    assert!(elapsed < Duration::from_millis(5), "cycle compile took {:?}", elapsed);
    assert_eq!(compiled1.prompt_text, compiled2.prompt_text);
    assert!(compiled1.xray.node_modes.contains_key("n_a"));
    assert!(compiled1.xray.node_modes.contains_key("n_b"));
    assert!(compiled1.xray.node_modes.contains_key("n_c"));
}

#[test]
fn ut_rs_07_compiler_exclude_passthrough() {
    let root = make_node("n_root", NodeType::Core, "Root Truth", "Essential invariant", 0.0, 0.0);
    let mut mid = make_node("n_mid", NodeType::Branch, "Muted Scratchpad", "Ignore me", 420.0, 0.0);
    mid.context_controls.exclude_from_ai = true;
    let leaf = make_node("n_leaf", NodeType::Branch, "Leaf Task", "Final step", 840.0, 0.0);

    let engine = GraphEngine::from_snapshot(
        &[root, mid, leaf],
        &[
            make_edge("e1", "n_root", "n_mid", EdgeType::Derives),
            make_edge("e2", "n_mid", "n_leaf", EdgeType::Derives),
        ],
    );

    let compiled = compile_context(&engine, &["n_leaf".to_owned()], 6000);
    assert!(compiled.xray.node_modes.contains_key("n_root"));
    assert!(!compiled.xray.node_modes.contains_key("n_mid"));
    assert!(compiled.prompt_text.contains("Root Truth"));
    assert!(!compiled.prompt_text.contains("Muted Scratchpad"));
}

#[test]
fn ut_rs_08_compiler_distance_decay_budget() {
    let body = "X".repeat(400); // ~100 tokens
    let mut nodes = Vec::new();
    let mut edges = Vec::new();

    for i in 0..5 {
        let id = format!("n_{i}");
        let mut n = make_node(&id, NodeType::Branch, &format!("Node {i}"), &body, (i as f64) * 400.0, 0.0);
        n.summary = format!("Summary {i}"); // ~3 tokens
        nodes.push(n);
    }
    // n_4 -> n_3 -> n_2 -> n_1 -> n_0 (focus = n_0)
    // depths: n_0=0, n_1=1, n_2=2, n_3=3, n_4=4
    edges.push(make_edge("e43", "n_4", "n_3", EdgeType::Derives));
    edges.push(make_edge("e32", "n_3", "n_2", EdgeType::Derives));
    edges.push(make_edge("e21", "n_2", "n_1", EdgeType::Derives));
    edges.push(make_edge("e10", "n_1", "n_0", EdgeType::Derives));

    let engine = GraphEngine::from_snapshot(&nodes, &edges);

    // Focus(n_0)=~102 + Direct(n_1)=~102 + Summary(n_2,n_3,n_4)=~9 = ~213.
    // Upgrading n_2 adds ~99 -> ~312. Upgrading n_3 would need ~411.
    // Budget 350 allows depth 0-2 full and keeps depth 3-4 as Summary.
    let compiled = compile_context(&engine, &["n_0".to_owned()], 350);

    assert_eq!(compiled.xray.node_modes.get("n_0"), Some(&InclusionMode::Focus));
    assert_eq!(compiled.xray.node_modes.get("n_1"), Some(&InclusionMode::Full));
    assert_eq!(compiled.xray.node_modes.get("n_2"), Some(&InclusionMode::Full));
    assert_eq!(compiled.xray.node_modes.get("n_3"), Some(&InclusionMode::Summary));
    assert_eq!(compiled.xray.node_modes.get("n_4"), Some(&InclusionMode::Summary));
    assert!(compiled.prompt_text.contains("### Node 3 (summary)"));
    assert!(compiled.prompt_text.contains("### Node 4 (summary)"));
}

#[test]
fn ut_rs_09_compiler_loophole_propagation_and_global_pin() {
    let anc = make_node("n_anc", NodeType::Core, "Storage Layer", "WAL append", 0.0, 0.0);
    let focus = make_node("n_focus", NodeType::Branch, "Query Planner", "Joins", 420.0, 0.0);

    let lh_active = make_node("n_lh_act", NodeType::Loophole, "Fsync Stall", "Blocks writer", 0.0, 220.0);
    let mut lh_resolved = make_node("n_lh_res", NodeType::Loophole, "Old Leak", "Fixed", 0.0, 420.0);
    lh_resolved.status = NodeStatus::Resolved;
    let mut lh_dismissed = make_node("n_lh_dis", NodeType::Loophole, "Non-Issue", "Ignored", 0.0, 620.0);
    lh_dismissed.status = NodeStatus::Dismissed;

    let mut pin = make_node("n_pin", NodeType::Core, "SLO Constraint", "p99 < 10ms", -400.0, -300.0);
    pin.context_controls.pin_global = true;

    let engine = GraphEngine::from_snapshot(
        &[anc, focus, lh_active, lh_resolved, lh_dismissed, pin],
        &[
            make_edge("e1", "n_anc", "n_focus", EdgeType::Derives),
            make_edge("e2", "n_lh_act", "n_anc", EdgeType::Challenges),
            make_edge("e3", "n_lh_res", "n_anc", EdgeType::Challenges),
            make_edge("e4", "n_lh_dis", "n_anc", EdgeType::Challenges),
        ],
    );

    let compiled = compile_context(&engine, &["n_focus".to_owned()], 6000);
    assert!(compiled.prompt_text.contains("[GLOBAL CONSTRAINTS]"));
    assert!(compiled.prompt_text.contains("SLO Constraint"));
    assert!(compiled.prompt_text.contains("[UNRESOLVED LOOPHOLES]"));
    assert!(compiled.prompt_text.contains("Fsync Stall"));
    assert!(!compiled.prompt_text.contains("Old Leak"));
    assert!(!compiled.prompt_text.contains("Non-Issue"));
    assert_eq!(compiled.xray.node_modes.get("n_pin"), Some(&InclusionMode::Pin));
    assert_eq!(compiled.xray.node_modes.get("n_lh_act"), Some(&InclusionMode::Loophole));
}

#[test]
fn ut_rs_10_compiler_one_hop_reference() {
    let focus = make_node("n_focus", NodeType::Core, "Service A", "Main service", 0.0, 0.0);
    let mut r = make_node("n_ref", NodeType::Core, "Auth RFC", "Full RFC text", 0.0, 300.0);
    r.summary = "JWT RS256 summary".to_owned();
    let r_parent = make_node("n_ref_parent", NodeType::Core, "Legacy OAuth1", "Do not traverse", -400.0, 300.0);

    let engine = GraphEngine::from_snapshot(
        &[focus, r, r_parent],
        &[
            make_edge("e_ref", "n_focus", "n_ref", EdgeType::References),
            make_edge("e_rp", "n_ref_parent", "n_ref", EdgeType::Derives),
        ],
    );

    let compiled = compile_context(&engine, &["n_focus".to_owned()], 6000);
    assert_eq!(compiled.xray.node_modes.get("n_ref"), Some(&InclusionMode::Reference));
    assert!(!compiled.xray.node_modes.contains_key("n_ref_parent"));
    assert!(compiled.prompt_text.contains("JWT RS256 summary"));
    assert!(!compiled.prompt_text.contains("Legacy OAuth1"));
}

#[test]
fn ut_rs_11_rtree_non_overlap() {
    let tmp = NamedTempFile::new().expect("create temp file");
    let mut conn = open_connection(tmp.path()).expect("open sqlite connection");
    let mut engine = GraphEngine::default();

    let root = make_node("node_root", NodeType::Core, "Root", "", 0.0, 0.0);
    apply_ops(&mut conn, &mut engine, &[GraphOp::CreateNode { node: root }])
        .expect("create root");

    // 10 sequential children off root
    for i in 0..10 {
        spawn_connected_node(
            &mut conn,
            &mut engine,
            "node_root",
            EdgeType::Derives,
            NodeType::Branch,
            Some(format!("Child {i}")),
        )
        .expect("spawn sequential child");
    }

    // 3 Diverge siblings reserved sequentially into engine.spatial
    for batch_idx in 0..3 {
        let root_ref = engine.nodes.get("node_root").expect("root exists").clone();
        let (x, y) = find_free_position(
            &engine.spatial,
            &[&root_ref],
            NodeType::Branch,
            DEFAULT_NODE_WIDTH,
            DEFAULT_NODE_HEIGHT,
            batch_idx,
        );
        let div_node = make_node(
            &format!("node_div_{batch_idx}"),
            NodeType::Branch,
            &format!("Diverge {batch_idx}"),
            "",
            x,
            y,
        );
        apply_ops(&mut conn, &mut engine, &[GraphOp::CreateNode { node: div_node }])
            .expect("create diverge sibling");
    }

    // 4 Red-Team loopholes off root
    for batch_idx in 0..4 {
        let root_ref = engine.nodes.get("node_root").expect("root exists").clone();
        let (x, y) = find_free_position(
            &engine.spatial,
            &[&root_ref],
            NodeType::Loophole,
            DEFAULT_NODE_WIDTH,
            DEFAULT_NODE_HEIGHT,
            batch_idx,
        );
        let lh_node = make_node(
            &format!("node_lh_{batch_idx}"),
            NodeType::Loophole,
            &format!("Loophole {batch_idx}"),
            "",
            x,
            y,
        );
        apply_ops(&mut conn, &mut engine, &[GraphOp::CreateNode { node: lh_node }])
            .expect("create loophole");
    }

    let all_nodes = engine.all_nodes_sorted();
    assert_eq!(all_nodes.len(), 18);
    for i in 0..all_nodes.len() {
        for j in (i + 1)..all_nodes.len() {
            assert!(
                !rects_overlap(&all_nodes[i], &all_nodes[j]),
                "overlap between {} and {}",
                all_nodes[i].id,
                all_nodes[j].id
            );
        }
    }
}

#[test]
fn ut_rs_12_tidy_subtree_layout_and_external_avoidance() {
    let root = make_node("root", NodeType::Core, "Root", "", 100.0, 100.0);
    // Deliberately overlapping/misaligned children
    let c1 = make_node("c1", NodeType::Branch, "Child 1", "", 150.0, 120.0);
    let c2 = make_node("c2", NodeType::Branch, "Child 2", "", 160.0, 130.0);
    let probe = make_node("p1", NodeType::Probe, "Feynman Probe", "", 900.0, 900.0);
    let loophole = make_node("l1", NodeType::Loophole, "Edge Loophole", "", 900.0, -500.0);

    // External unmoved node sitting directly where c1 might land (x = 100 + 320 + 100 = 520)
    let ext_x = 100.0 + DEFAULT_NODE_WIDTH + H_GAP;
    let ext = make_node("ext", NodeType::Core, "External Obstacle", "", ext_x, 0.0);

    let mut engine = GraphEngine::from_snapshot(
        &[root, c1, c2, probe, loophole, ext],
        &[
            make_edge("e1", "root", "c1", EdgeType::Branches),
            make_edge("e2", "root", "c2", EdgeType::Branches),
            make_edge("e3", "root", "p1", EdgeType::Derives),
            make_edge("e4", "l1", "c1", EdgeType::Challenges),
        ],
    );

    let updates = compute_tidy_subtree(&engine, "root").expect("tidy_subtree succeeds");
    assert!(!updates.iter().any(|u| u.id == "root"), "root must remain stationary");
    assert!(!updates.iter().any(|u| u.id == "ext"), "external node must remain stationary");

    for u in &updates {
        if let Some(node) = engine.nodes.get_mut(&u.id) {
            node.layout.x = u.x;
            node.layout.y = u.y;
            let updated = node.clone();
            engine.spatial.upsert(&updated);
        }
    }

    let root_after = engine.nodes.get("root").expect("root");
    let p1_after = engine.nodes.get("p1").expect("p1");
    let c1_after = engine.nodes.get("c1").expect("c1");
    let c2_after = engine.nodes.get("c2").expect("c2");
    let l1_after = engine.nodes.get("l1").expect("l1");

    assert!(p1_after.layout.y < root_after.layout.y, "probe must be above root");
    assert!(l1_after.layout.y > c1_after.layout.y, "loophole must be below parent c1");
    assert!(c1_after.layout.x >= root_after.layout.x + root_after.layout.width + H_GAP - 1e-6);
    assert!(c2_after.layout.x >= root_after.layout.x + root_after.layout.width + H_GAP - 1e-6);

    let all = engine.all_nodes_sorted();
    for i in 0..all.len() {
        for j in (i + 1)..all.len() {
            assert!(
                !rects_overlap(&all[i], &all[j]),
                "tidy overlap between {} ({:?}) and {} ({:?})",
                all[i].id,
                (all[i].layout.x, all[i].layout.y),
                all[j].id,
                (all[j].layout.x, all[j].layout.y),
            );
        }
    }
}

#[test]
fn ut_rs_13_parser_multi_card_and_3byte_chunks() {
    let payload = concat!(
        "@@NODE type=loophole edge=challenges severity=critical title=\"Split \\\"Brain\\\" Risk\"\n",
        "\n",
        "First card body.\n",
        "@@END\n",
        "@@NODE title=\"Second \\\"Quoted\\\" Card\" edge=branches type=branch\n",
        "Second card body line 1.\n",
        "Second card body line 2.\n",
        "@@NODE type=probe edge=derives title=\"Third \\\"Probe\\\"\"\n",
        "Third card body.\n",
        "@@END\n"
    );

    let mut parser = NodeStreamParser::new(LensDefaults {
        node_type: NodeType::Branch,
        edge_type: EdgeType::Derives,
        severity: None,
        title: "Fallback".to_owned(),
    });

    let mut events = Vec::new();
    for chunk in payload.as_bytes().chunks(3) {
        let s = std::str::from_utf8(chunk).expect("ASCII 3-byte chunk");
        events.extend(parser.feed(s));
    }
    events.extend(parser.finish());

    let mut spawned = Vec::new();
    let mut bodies = Vec::new();
    let mut cur_body = String::new();
    let mut finalized_count = 0usize;

    for ev in events {
        match ev {
            ParsedEvent::SpawnNode { meta } => {
                spawned.push(meta);
                cur_body.clear();
            }
            ParsedEvent::TokenDelta(d) => cur_body.push_str(&d),
            ParsedEvent::FinalizeNode => {
                bodies.push(cur_body.clone());
                finalized_count += 1;
            }
        }
    }

    assert_eq!(spawned.len(), 3);
    assert_eq!(finalized_count, 3);
    assert_eq!(spawned[0].node_type, NodeType::Loophole);
    assert_eq!(spawned[0].edge_type, EdgeType::Challenges);
    assert_eq!(spawned[0].severity, Some(Severity::Critical));
    assert_eq!(spawned[0].title, "Split \"Brain\" Risk");
    assert_eq!(bodies[0], "First card body.");

    assert_eq!(spawned[1].node_type, NodeType::Branch);
    assert_eq!(spawned[1].edge_type, EdgeType::Branches);
    assert_eq!(spawned[1].title, "Second \"Quoted\" Card");
    assert_eq!(bodies[1], "Second card body line 1.\nSecond card body line 2.");

    assert_eq!(spawned[2].node_type, NodeType::Probe);
    assert_eq!(spawned[2].edge_type, EdgeType::Derives);
    assert_eq!(spawned[2].title, "Third \"Probe\"");
    assert_eq!(bodies[2], "Third card body.");
}

#[test]
fn ut_rs_14_parser_fence_immunity() {
    let payload = concat!(
        "@@NODE type=branch edge=derives title=\"Example Spec\"\n",
        "Here is a sample:\n",
        "```markdown\n",
        "@@NODE type=core title=\"fake\"\n",
        "inside fence\n",
        "@@END\n",
        "```\n",
        "After fence.\n",
        "@@END\n"
    );

    let mut parser = NodeStreamParser::new(LensDefaults {
        node_type: NodeType::Branch,
        edge_type: EdgeType::Derives,
        severity: None,
        title: "Fallback".to_owned(),
    });

    let mut events = parser.feed(payload);
    events.extend(parser.finish());

    let spawn_count = events
        .iter()
        .filter(|e| matches!(e, ParsedEvent::SpawnNode { .. }))
        .count();
    let finalize_count = events
        .iter()
        .filter(|e| matches!(e, ParsedEvent::FinalizeNode))
        .count();
    let body: String = events
        .iter()
        .filter_map(|e| match e {
            ParsedEvent::TokenDelta(s) => Some(s.as_str()),
            _ => None,
        })
        .collect();

    assert_eq!(spawn_count, 1);
    assert_eq!(finalize_count, 1);
    assert!(body.contains("@@NODE type=core title=\"fake\""));
    assert!(body.contains("After fence."));
}

#[test]
fn ut_rs_15_parser_protocol_violation_fallback() {
    let prose = "This model completely ignored the protocol instructions.\nIt wrote plain prose across lines without any card headers at all.\nYet we still preserve every byte.";

    let mut parser = NodeStreamParser::new(LensDefaults {
        node_type: NodeType::Probe,
        edge_type: EdgeType::Derives,
        severity: None,
        title: "Feynman Explanation".to_owned(),
    });

    let mut events = Vec::new();
    for chunk in prose.as_bytes().chunks(11) {
        let s = std::str::from_utf8(chunk).expect("valid utf8");
        events.extend(parser.feed(s));
    }
    events.extend(parser.finish());

    let mut spawned = Vec::new();
    let mut body = String::new();
    let mut finalized = 0usize;
    for ev in events {
        match ev {
            ParsedEvent::SpawnNode { meta } => spawned.push(meta),
            ParsedEvent::TokenDelta(d) => body.push_str(&d),
            ParsedEvent::FinalizeNode => finalized += 1,
        }
    }

    assert_eq!(spawned.len(), 1);
    assert_eq!(finalized, 1);
    assert_eq!(spawned[0].node_type, NodeType::Probe);
    assert_eq!(spawned[0].edge_type, EdgeType::Derives);
    assert_eq!(spawned[0].title, "Feynman Explanation");
    assert_eq!(body, prose);
}

#[test]
fn ut_rs_16_json_deterministic_round_trip() {
    let dir = tempfile::tempdir().expect("create temp dir");
    let db1_path = dir.path().join("ws1.sqlite");
    let db2_path = dir.path().join("ws2.sqlite");
    let json1_path = dir.path().join("export1.json");
    let json2_path = dir.path().join("export2.json");

    let mut conn1 = open_connection(&db1_path).expect("open db1");
    let mut engine1 = GraphEngine::default();

    let mut n_b = make_node("node_02", NodeType::Branch, "Branch B", "Content B", 420.0, 20.0);
    n_b.context_controls.pin_global = true;
    let n_a = make_node("node_01", NodeType::Core, "Core A", "Content A", 0.0, 0.0);
    let edge = make_edge("edge_01", "node_01", "node_02", EdgeType::Branches);

    apply_ops(
        &mut conn1,
        &mut engine1,
        &[
            GraphOp::CreateNode { node: n_b },
            GraphOp::CreateNode { node: n_a },
            GraphOp::CreateEdge { edge },
        ],
    )
    .expect("seed db1");

    axiom_canvas_lib::db::queries::save_camera(
        &mut conn1,
        &CameraState {
            x: 12.5,
            y: -44.0,
            zoom: 1.25,
            last_focus_id: Some("node_01".to_owned()),
        },
    )
    .expect("save camera");

    export_json(&conn1, &json1_path).expect("export json 1");
    let snap2 = import_json(&json1_path, &db2_path).expect("import json into db2");
    assert_eq!(snap2.nodes.len(), 2);
    assert_eq!(snap2.edges.len(), 1);
    assert_eq!(snap2.camera.last_focus_id.as_deref(), Some("node_01"));

    let conn2 = open_connection(&db2_path).expect("open db2");
    export_json(&conn2, &json2_path).expect("export json 2");

    let raw1 = std::fs::read_to_string(&json1_path).expect("read json 1");
    let raw2 = std::fs::read_to_string(&json2_path).expect("read json 2");

    let mut val1: serde_json::Value = serde_json::from_str(&raw1).expect("parse json 1");
    let mut val2: serde_json::Value = serde_json::from_str(&raw2).expect("parse json 2");
    val1["exported_at"] = serde_json::json!(0);
    val2["exported_at"] = serde_json::json!(0);

    assert_eq!(
        serde_json::to_string_pretty(&val1).expect("ser 1"),
        serde_json::to_string_pretty(&val2).expect("ser 2")
    );
}

#[test]
fn bench_500_node_compile_and_search() {
    let tmp = NamedTempFile::new().expect("create temp file");
    let mut conn = open_connection(tmp.path()).expect("open sqlite connection");

    let mut nodes = Vec::with_capacity(500);
    let mut edges = Vec::with_capacity(700);
    let mut edge_counter = 0usize;

    for i in 0..500usize {
        let id = format!("node_{i:04}");
        let node_type = match i % 10 {
            0 => NodeType::Core,
            6 | 7 => NodeType::Loophole,
            8 => NodeType::Probe,
            9 => NodeType::Synthesis,
            _ => NodeType::Branch,
        };
        let mut n = make_node(
            &id,
            node_type,
            &format!("Architecture Component {i}"),
            &format!(
                "Detailed design spec for component {i} covering latency, sharding, and durability."
            ),
            ((i % 25) as f64) * 380.0,
            ((i / 25) as f64) * 240.0,
        );
        n.summary = format!("Summary for component {i}.");
        if node_type == NodeType::Loophole {
            n.metadata.severity = Some(if i % 20 == 6 {
                Severity::Critical
            } else {
                Severity::High
            });
        }
        if i == 0 || i == 1 {
            n.context_controls.pin_global = true;
        }
        nodes.push(n);
    }

    // Build 499 spine edges + 201 cross/challenge/reference edges = 700 edges total
    for i in 1..500usize {
        let parent = (i - 1) / 2;
        let edge_type = match nodes[i].node_type {
            NodeType::Loophole => EdgeType::Challenges,
            NodeType::Synthesis => EdgeType::Synthesizes,
            NodeType::Branch if i % 2 == 0 => EdgeType::Branches,
            _ => EdgeType::Derives,
        };
        let (src, dst) = if edge_type == EdgeType::Challenges {
            (format!("node_{i:04}"), format!("node_{parent:04}"))
        } else {
            (format!("node_{parent:04}"), format!("node_{i:04}"))
        };
        edges.push(make_edge(&format!("edge_{edge_counter:04}"), &src, &dst, edge_type));
        edge_counter += 1;
    }

    let mut extra = 0usize;
    while edges.len() < 700 {
        let src_idx = (extra * 7 + 3) % 499;
        let dst_idx = (src_idx + 1 + (extra % 17)) % 500;
        if src_idx != dst_idx {
            let candidate_type = EdgeType::References;
            let already = edges.iter().any(|e| {
                e.source_id == format!("node_{src_idx:04}")
                    && e.target_id == format!("node_{dst_idx:04}")
                    && e.edge_type == candidate_type
            });
            if !already {
                edges.push(make_edge(
                    &format!("edge_{edge_counter:04}"),
                    &format!("node_{src_idx:04}"),
                    &format!("node_{dst_idx:04}"),
                    candidate_type,
                ));
                edge_counter += 1;
            }
        }
        extra += 1;
    }

    // Bulk insert in one transaction
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .expect("begin bulk tx");
    for n in &nodes {
        tx.execute(
            "INSERT INTO nodes (
                id, type, status, title, content, summary, content_hash, summary_hash,
                severity, lens, created_by, model, token_count,
                pin_global, exclude_from_ai, x, y, width, height, collapsed,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            params![
                n.id,
                n.node_type.as_str(),
                n.status.as_str(),
                n.title,
                n.content,
                n.summary,
                n.content_hash,
                n.summary_hash,
                n.metadata.severity.map(Severity::as_str),
                n.metadata.lens.as_str(),
                n.metadata.created_by.as_str(),
                n.metadata.model,
                i64::from(n.metadata.token_count),
                i64::from(n.context_controls.pin_global),
                i64::from(n.context_controls.exclude_from_ai),
                n.layout.x,
                n.layout.y,
                n.layout.width,
                n.layout.height,
                i64::from(n.layout.collapsed),
                n.created_at,
                n.updated_at,
            ],
        )
        .expect("insert node");
    }
    for e in &edges {
        tx.execute(
            "INSERT INTO edges (id, source_id, target_id, type, weight, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                e.id,
                e.source_id,
                e.target_id,
                e.edge_type.as_str(),
                e.weight.as_str(),
                e.created_at,
            ],
        )
        .expect("insert edge");
    }
    tx.commit().expect("commit 500-node fixture");

    let engine = GraphEngine::from_snapshot(&nodes, &edges);

    let compile_start = Instant::now();
    let compiled = compile_context(&engine, &["node_0499".to_owned()], 6000);
    let compile_elapsed = compile_start.elapsed();
    println!(
        "[BENCH] 500-node, 700-edge compile_context: {:?} (modes={}, active_edges={})",
        compile_elapsed,
        compiled.xray.node_modes.len(),
        compiled.xray.active_edges.len()
    );
    assert!(
        compile_elapsed < Duration::from_millis(5),
        "compile_context exceeded 5ms budget: {:?}",
        compile_elapsed
    );

    let search_start = Instant::now();
    let hits = search_nodes(&conn, "status:active arch", 30).expect("search 500-node graph");
    let search_elapsed = search_start.elapsed();
    println!(
        "[BENCH] 500-node, 700-edge search_nodes: {:?} (hits={})",
        search_elapsed,
        hits.len()
    );
    assert!(!hits.is_empty());
    assert!(
        search_elapsed < Duration::from_millis(15),
        "search_nodes exceeded 15ms budget: {:?}",
        search_elapsed
    );
}

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use tempfile::tempdir;

use axiom_canvas_lib::db::json_io::{export_json, import_json};
use axiom_canvas_lib::db::queries::{apply_ops, search_nodes};
use axiom_canvas_lib::db::stress::{generate_stress_graph_500, seed_stress_500_into_workspace};
use axiom_canvas_lib::db::{hydrate_or_seed_workspace, open_connection};
use axiom_canvas_lib::error::IpcErrorCode;
use axiom_canvas_lib::graph::compiler::compile_context;
use axiom_canvas_lib::graph::models::{
    compute_content_hash, estimate_tokens, ContextControls, CreatedBy, EdgeType, GraphOp, NodeDto,
    NodeLayout, NodeLensOrigin, NodeMetadata, NodeStatus, NodeType,
};
use axiom_canvas_lib::graph::spatial::{effective_height, DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH};
use axiom_canvas_lib::graph::GraphEngine;

fn rects_overlap(a: &NodeDto, b: &NodeDto) -> bool {
    let ax2 = a.layout.x + a.layout.width;
    let ay2 = a.layout.y + effective_height(a);
    let bx2 = b.layout.x + b.layout.width;
    let by2 = b.layout.y + effective_height(b);
    a.layout.x < bx2 && ax2 > b.layout.x && a.layout.y < by2 && ay2 > b.layout.y
}

fn make_sentinel_node(id: &str, title: &str) -> NodeDto {
    let content = "Sentinel node body that must survive invalid import.";
    let content_hash = compute_content_hash(title, content);
    let token_count = estimate_tokens(&format!("{title}\n{content}"));
    NodeDto {
        id: id.to_owned(),
        node_type: NodeType::Core,
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
            x: 0.0,
            y: 0.0,
            width: DEFAULT_NODE_WIDTH,
            height: DEFAULT_NODE_HEIGHT,
            collapsed: false,
        },
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
    }
}

#[test]
fn stress_500_generator_produces_exact_500_nodes_700_edges_and_passes_budgets() {
    let (nodes, edges) = generate_stress_graph_500();
    assert_eq!(nodes.len(), 500);
    assert_eq!(edges.len(), 700);

    let mut type_counts: HashMap<NodeType, usize> = HashMap::new();
    let mut node_ids: HashSet<&str> = HashSet::with_capacity(nodes.len());
    let mut active_loophole_count = 0usize;
    let mut has_katex = false;
    let mut has_code_fence = false;
    let mut has_pin = false;
    let mut has_exclude = false;
    let mut has_locked = false;
    let mut has_collapsed = false;

    for node in &nodes {
        assert!(node_ids.insert(node.id.as_str()));
        *type_counts.entry(node.node_type).or_insert(0) += 1;
        if node.node_type == NodeType::Loophole && node.status == NodeStatus::Active {
            active_loophole_count += 1;
        }
        if node.content.contains('$') && node.content.contains("$$") {
            has_katex = true;
        }
        if node.content.contains("```") {
            has_code_fence = true;
        }
        if node.context_controls.pin_global {
            has_pin = true;
        }
        if node.context_controls.exclude_from_ai {
            has_exclude = true;
        }
        if node.status == NodeStatus::Locked {
            has_locked = true;
        }
        if node.layout.collapsed {
            has_collapsed = true;
        }
    }

    assert!(type_counts.get(&NodeType::Core).copied().unwrap_or(0) > 0);
    assert!(type_counts.get(&NodeType::Branch).copied().unwrap_or(0) > 0);
    assert!(type_counts.get(&NodeType::Loophole).copied().unwrap_or(0) > 0);
    assert!(type_counts.get(&NodeType::Probe).copied().unwrap_or(0) > 0);
    assert!(type_counts.get(&NodeType::Synthesis).copied().unwrap_or(0) > 0);
    assert!(active_loophole_count > 0);
    assert!(has_katex);
    assert!(has_code_fence);
    assert!(has_pin);
    assert!(has_exclude);
    assert!(has_locked);
    assert!(has_collapsed);

    // Verify non-overlapping coordinates across all 500 generated nodes.
    for (i, a) in nodes.iter().enumerate() {
        for b in nodes.iter().skip(i + 1) {
            assert!(
                !rects_overlap(a, b),
                "Generated nodes {} and {} overlap",
                a.id,
                b.id
            );
        }
    }

    // Verify zero self-loops, zero duplicate triples, and diamond merges on Synthesis nodes.
    let mut edge_triples: HashSet<(&str, &str, EdgeType)> = HashSet::with_capacity(edges.len());
    let mut incoming_counts: HashMap<&str, usize> = HashMap::new();
    for edge in &edges {
        assert_ne!(edge.source_id, edge.target_id);
        assert!(node_ids.contains(edge.source_id.as_str()));
        assert!(node_ids.contains(edge.target_id.as_str()));
        assert!(edge_triples.insert((
            edge.source_id.as_str(),
            edge.target_id.as_str(),
            edge.edge_type
        )));
        *incoming_counts.entry(edge.target_id.as_str()).or_insert(0) += 1;
    }

    let synthesis_diamonds = nodes
        .iter()
        .filter(|n| {
            n.node_type == NodeType::Synthesis
                && incoming_counts.get(n.id.as_str()).copied().unwrap_or(0) >= 2
        })
        .count();
    assert!(synthesis_diamonds > 0);

    // Seed workspace and verify cold boot, compile_context, and search_nodes budgets.
    let dir = tempdir().expect("create temp dir");
    let db_path = dir.path().join("stress500.sqlite");
    let path_str = db_path.to_string_lossy().into_owned();

    {
        let mut conn = open_connection(&db_path).expect("open db");
        let mut engine = GraphEngine::default();
        let seeded = seed_stress_500_into_workspace(&mut conn, &mut engine, &path_str)
            .expect("seed 500-node stress workspace");
        assert_eq!(seeded.nodes.len(), 500);
        assert_eq!(seeded.edges.len(), 700);
    }

    let t_boot = Instant::now();
    let mut cold_conn = open_connection(&db_path).expect("cold open db");
    let snap = hydrate_or_seed_workspace(&mut cold_conn, &path_str).expect("hydrate workspace");
    let cold_engine = GraphEngine::from_snapshot(&snap.nodes, &snap.edges);
    let boot_ms = t_boot.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(snap.nodes.len(), 500);
    assert_eq!(snap.edges.len(), 700);
    println!("[BENCH] 500-node cold boot: {boot_ms:.2} ms");
    assert!(
        boot_ms < 800.0,
        "500-node cold boot took {boot_ms:.2} ms (budget < 800 ms)"
    );

    let focus_id = nodes
        .iter()
        .rev()
        .find(|n| n.node_type == NodeType::Synthesis)
        .map(|n| n.id.clone())
        .unwrap_or_else(|| "stress_node_499".to_owned());

    let t_compile = Instant::now();
    let compiled = compile_context(&cold_engine, &[focus_id], snap.token_budget);
    let compile_ms = t_compile.elapsed().as_secs_f64() * 1000.0;
    println!(
        "[BENCH] 500-node compile_context: {compile_ms:.3} ms ({} tokens)",
        compiled.xray.total_tokens
    );
    assert!(compiled.xray.total_tokens <= snap.token_budget);
    assert!(
        compile_ms < 5.0,
        "compile_context took {compile_ms:.3} ms (budget < 5 ms)"
    );

    let t_search = Instant::now();
    let hits = search_nodes(&cold_conn, "consensus", 30).expect("search_nodes");
    let search_ms = t_search.elapsed().as_secs_f64() * 1000.0;
    println!(
        "[BENCH] 500-node search_nodes: {search_ms:.3} ms ({} hits)",
        hits.len()
    );
    assert!(!hits.is_empty());
    assert!(
        search_ms < 15.0,
        "search_nodes took {search_ms:.3} ms (budget < 15 ms)"
    );
}

#[test]
fn stress_500_json_export_import_round_trip_is_byte_identical() {
    let dir = tempdir().expect("create temp dir");
    let db1_path = dir.path().join("ws1.sqlite");
    let db2_path = dir.path().join("ws2.sqlite");
    let json1_path = dir.path().join("export1.json");
    let json2_path = dir.path().join("export2.json");

    let mut conn1 = open_connection(&db1_path).expect("open db1");
    let mut engine1 = GraphEngine::default();
    seed_stress_500_into_workspace(&mut conn1, &mut engine1, &db1_path.to_string_lossy())
        .expect("seed 500-node workspace");
    export_json(&conn1, &json1_path).expect("export json 1");

    let imported = import_json(&json1_path, &db2_path).expect("import json into db2");
    assert_eq!(imported.nodes.len(), 500);
    assert_eq!(imported.edges.len(), 700);

    let conn2 = open_connection(&db2_path).expect("open db2");
    export_json(&conn2, &json2_path).expect("export json 2");

    let raw1 = std::fs::read_to_string(&json1_path).expect("read json 1");
    let raw2 = std::fs::read_to_string(&json2_path).expect("read json 2");
    let mut val1: serde_json::Value = serde_json::from_str(&raw1).expect("parse json 1");
    let mut val2: serde_json::Value = serde_json::from_str(&raw2).expect("parse json 2");
    val1["exported_at"] = serde_json::json!(0);
    val2["exported_at"] = serde_json::json!(0);

    assert_eq!(
        serde_json::to_string_pretty(&val1).expect("serialize val1"),
        serde_json::to_string_pretty(&val2).expect("serialize val2")
    );
}

#[test]
fn import_json_rejects_invalid_payload_without_clobbering_existing_db() {
    let dir = tempdir().expect("create temp dir");
    let existing_db_path = dir.path().join("existing.sqlite");
    let seed_db_path = dir.path().join("seed.sqlite");
    let base_json_path = dir.path().join("base.json");

    {
        let mut existing_conn = open_connection(&existing_db_path).expect("open existing db");
        let mut existing_engine = GraphEngine::default();
        let sentinel = make_sentinel_node("sentinel_node", "Keep Existing Sentinel");
        apply_ops(
            &mut existing_conn,
            &mut existing_engine,
            &[GraphOp::CreateNode { node: sentinel }],
        )
        .expect("insert sentinel node");
    }

    {
        let mut seed_conn = open_connection(&seed_db_path).expect("open seed db");
        let mut seed_engine = GraphEngine::default();
        let n1 = make_sentinel_node("node_a", "Node A");
        let n2 = make_sentinel_node("node_b", "Node B");
        apply_ops(
            &mut seed_conn,
            &mut seed_engine,
            &[
                GraphOp::CreateNode { node: n1 },
                GraphOp::CreateNode { node: n2 },
            ],
        )
        .expect("seed valid export base");
        export_json(&seed_conn, &base_json_path).expect("export base json");
    }

    let base_raw = std::fs::read_to_string(&base_json_path).expect("read base json");
    let base_val: serde_json::Value = serde_json::from_str(&base_raw).expect("parse base json");

    let mut invalid_version = base_val.clone();
    invalid_version["version"] = serde_json::json!(99);

    let mut invalid_format = base_val.clone();
    invalid_format["format"] = serde_json::json!("not-axiom");

    let mut dup_node = base_val.clone();
    let cloned_first = dup_node["nodes"][0].clone();
    if let Some(arr) = dup_node["nodes"].as_array_mut() {
        arr.push(cloned_first);
    }

    let mut dangling_edge = base_val.clone();
    if let Some(arr) = dangling_edge["edges"].as_array_mut() {
        arr.push(serde_json::json!({
            "id": "edge_dangling",
            "source_id": "node_a",
            "target_id": "missing_node",
            "type": "derives",
            "weight": "summary",
            "created_at": 1_700_000_000_000i64
        }));
    }

    let invalid_cases = [
        ("invalid_version.json", invalid_version),
        ("invalid_format.json", invalid_format),
        ("dup_node.json", dup_node),
        ("dangling_edge.json", dangling_edge),
    ];

    for (filename, payload) in invalid_cases {
        let bad_path = dir.path().join(filename);
        std::fs::write(
            &bad_path,
            serde_json::to_string_pretty(&payload).expect("serialize invalid payload"),
        )
        .expect("write invalid json");

        let err = import_json(&bad_path, &existing_db_path)
            .expect_err("invalid payload must be rejected");
        assert_eq!(
            err.code,
            IpcErrorCode::ValidationError,
            "unexpected error code for {filename}: {err:?}"
        );
    }

    // Duplicate (source_id, target_id, type) triple also fails before clobbering.
    let mut dup_triple = base_val;
    if let Some(arr) = dup_triple["edges"].as_array_mut() {
        arr.push(serde_json::json!({
            "id": "edge_1",
            "source_id": "node_a",
            "target_id": "node_b",
            "type": "derives",
            "weight": "summary",
            "created_at": 1_700_000_000_000i64
        }));
        arr.push(serde_json::json!({
            "id": "edge_2",
            "source_id": "node_a",
            "target_id": "node_b",
            "type": "derives",
            "weight": "full",
            "created_at": 1_700_000_000_001i64
        }));
    }
    let dup_triple_path = dir.path().join("dup_triple.json");
    std::fs::write(
        &dup_triple_path,
        serde_json::to_string_pretty(&dup_triple).expect("serialize dup triple"),
    )
    .expect("write dup triple json");
    let dup_err = import_json(&dup_triple_path, &existing_db_path)
        .expect_err("duplicate edge triple must fail");
    assert_eq!(dup_err.code, IpcErrorCode::DuplicateEdge);

    // Existing SQLite file remains completely intact.
    let mut reopened = open_connection(&existing_db_path).expect("reopen existing db");
    let snap = hydrate_or_seed_workspace(&mut reopened, &existing_db_path.to_string_lossy())
        .expect("hydrate existing db");
    assert_eq!(snap.nodes.len(), 1);
    assert_eq!(snap.nodes[0].id, "sentinel_node");
    assert_eq!(snap.nodes[0].title, "Keep Existing Sentinel");
}

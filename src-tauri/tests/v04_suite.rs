use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use tempfile::tempdir;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use axiom_canvas_lib::ai::runner::{execute_lens_run, LensRunParams};
use axiom_canvas_lib::db::queries::{apply_ops, upsert_ai_run_provenance};
use axiom_canvas_lib::db::{hydrate_or_seed_workspace, open_connection};
use axiom_canvas_lib::error::IpcErrorCode;
use axiom_canvas_lib::graph::diagnostics::compute_graph_diagnostics;
use axiom_canvas_lib::graph::importer::{import_markdown_outline, parse_markdown_outline};
use axiom_canvas_lib::graph::models::{
    compute_content_hash, estimate_tokens, ContextControls, CreatedBy, CustomLensDef, EdgeDto,
    EdgeType, EdgeWeight, GraphOp, LensKind, ModelTierConfig, NodeDto, NodeLayout, NodeLensOrigin,
    NodeMetadata, NodeStatus, NodeType, ProvenanceInput, ProviderKind, SaveSettingsInput,
    Severity,
};
use axiom_canvas_lib::graph::spatial::{effective_height, DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH};
use axiom_canvas_lib::graph::GraphEngine;
use axiom_canvas_lib::ipc::ActiveWorkspace;
use axiom_canvas_lib::settings::SettingsStore;

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
                Some(Severity::Medium)
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

fn base_tier(base_url: &str, model: &str) -> ModelTierConfig {
    ModelTierConfig {
        provider: ProviderKind::OpenaiCompat,
        base_url: base_url.to_owned(),
        model: model.to_owned(),
        has_api_key: false,
        temperature: 0.4,
        max_tokens: 1024,
    }
}

fn save_input_with_lenses(custom_lenses: Vec<CustomLensDef>) -> SaveSettingsInput {
    SaveSettingsInput {
        reasoning: base_tier("https://api.openai.com/v1", "gpt-4o"),
        reasoning_api_key: None,
        utility: base_tier("https://api.openai.com/v1", "gpt-4o-mini"),
        utility_api_key: None,
        default_token_budget: 6000,
        auto_summarize: true,
        theme: "dark".to_owned(),
        custom_lenses,
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
fn settings_store_validates_normalizes_and_persists_custom_lenses() {
    let dir = tempdir().expect("tempdir");
    let store = SettingsStore::with_config_path(dir.path().join("settings.json"), false);

    // 1. Normalization + generated ULID when id is empty + persistence
    let saved = store
        .save(save_input_with_lenses(vec![CustomLensDef {
            id: "   ".to_owned(),
            name: "  Cost Audit  ".to_owned(),
            tag: "  @Cost_Audit  ".to_owned(),
            description: "Check cloud unit economics".to_owned(),
            prompt_template: "Identify top 3 cost drivers and unit economics bounds.".to_owned(),
            default_node_type: NodeType::Loophole,
            default_edge_type: EdgeType::Challenges,
            default_severity: Some(Severity::High),
        }]))
        .expect("valid custom lens saves");

    assert_eq!(saved.custom_lenses.len(), 1);
    let persisted = &saved.custom_lenses[0];
    assert!(persisted.id.starts_with("lens_"));
    assert_eq!(persisted.name, "Cost Audit");
    assert_eq!(persisted.tag, "cost_audit");
    assert_eq!(persisted.default_node_type, NodeType::Loophole);
    assert_eq!(persisted.default_edge_type, EdgeType::Challenges);
    assert_eq!(persisted.default_severity, Some(Severity::High));

    let found = store
        .find_custom_lens(&persisted.id)
        .expect("lookup")
        .expect("found custom lens");
    assert_eq!(found, *persisted);

    // 2. Built-in tag collision rejection
    for reserved in ["@feynman", "RED-TEAM", "@triage", "custom", "loopholes"] {
        let err = store
            .save(save_input_with_lenses(vec![CustomLensDef {
                id: String::new(),
                name: "Collide".to_owned(),
                tag: reserved.to_owned(),
                description: String::new(),
                prompt_template: "Do work".to_owned(),
                default_node_type: NodeType::Probe,
                default_edge_type: EdgeType::Derives,
                default_severity: None,
            }]))
            .expect_err("reserved tag must fail");
        assert_eq!(err.code, IpcErrorCode::ValidationError);
    }

    // 3. Invalid characters / length rejection
    for bad_tag in ["", "a", "has space", "bad!tag", "this_tag_name_is_way_too_long_25"] {
        let err = store
            .save(save_input_with_lenses(vec![CustomLensDef {
                id: String::new(),
                name: "Bad Tag".to_owned(),
                tag: bad_tag.to_owned(),
                description: String::new(),
                prompt_template: "Do work".to_owned(),
                default_node_type: NodeType::Core,
                default_edge_type: EdgeType::Derives,
                default_severity: None,
            }]))
            .expect_err("invalid tag must fail");
        assert_eq!(err.code, IpcErrorCode::ValidationError);
    }

    // 4. Duplicate custom tag rejection
    let dup_err = store
        .save(save_input_with_lenses(vec![
            CustomLensDef {
                id: "lens_1".to_owned(),
                name: "First".to_owned(),
                tag: "@latency".to_owned(),
                description: String::new(),
                prompt_template: "Check p99.".to_owned(),
                default_node_type: NodeType::Probe,
                default_edge_type: EdgeType::Derives,
                default_severity: None,
            },
            CustomLensDef {
                id: "lens_2".to_owned(),
                name: "Second".to_owned(),
                tag: "LATENCY".to_owned(),
                description: String::new(),
                prompt_template: "Check tail.".to_owned(),
                default_node_type: NodeType::Probe,
                default_edge_type: EdgeType::Derives,
                default_severity: None,
            },
        ]))
        .expect_err("duplicate custom tag must fail");
    assert_eq!(dup_err.code, IpcErrorCode::ValidationError);

    // 5. Empty name or empty prompt_template rejected
    let empty_name = store
        .save(save_input_with_lenses(vec![CustomLensDef {
            id: String::new(),
            name: "   ".to_owned(),
            tag: "valid_tag".to_owned(),
            description: String::new(),
            prompt_template: "Template".to_owned(),
            default_node_type: NodeType::Core,
            default_edge_type: EdgeType::Derives,
            default_severity: None,
        }]))
        .expect_err("empty name must fail");
    assert_eq!(empty_name.code, IpcErrorCode::ValidationError);

    let empty_tpl = store
        .save(save_input_with_lenses(vec![CustomLensDef {
            id: String::new(),
            name: "Valid Name".to_owned(),
            tag: "valid_tag".to_owned(),
            description: String::new(),
            prompt_template: "   ".to_owned(),
            default_node_type: NodeType::Core,
            default_edge_type: EdgeType::Derives,
            default_severity: None,
        }]))
        .expect_err("empty prompt_template must fail");
    assert_eq!(empty_tpl.code, IpcErrorCode::ValidationError);
}

#[tokio::test]
async fn execute_lens_run_supports_custom_lens_with_empty_prompt_and_custom_defaults() {
    let captured_sys = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured_ref = captured_sys.clone();

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let addr = listener.local_addr().expect("addr");
    let base_url = format!("http://{addr}");

    thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
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
                if let Some(sys) = json_body.pointer("/messages/0/content").and_then(|v| v.as_str())
                {
                    if let Ok(mut list) = captured_ref.lock() {
                        list.push(sys.to_owned());
                    }
                }
            }

            // Omit @@NODE header deliberately so NodeStreamParser exercises custom_defaults!
            let sse = format!(
                "data: {}\n\ndata: [DONE]\n\n",
                serde_json::json!({
                    "choices": [{
                        "delta": {
                            "content": "Unbounded NAT egress traffic costs $0.09/GB across AZ boundaries."
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
    let db_path = dir.path().join("custom_lens.sqlite");
    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();
    let root = make_node(
        "n_root",
        NodeType::Core,
        "Multi-AZ Mesh",
        "All service calls cross availability zones",
        0.0,
        0.0,
    );
    apply_ops(&mut conn, &mut engine, &[GraphOp::CreateNode { node: root }]).expect("seed");

    let ws = Arc::new(RwLock::new(Some(ActiveWorkspace {
        path: db_path.to_string_lossy().into_owned(),
        engine,
        token_budget: 6000,
        system_prompt: String::new(),
    })));
    let db = Arc::new(Mutex::new(Some(conn)));
    let active_runs = Arc::new(Mutex::new(HashMap::new()));
    let (summary_tx, _rx) = mpsc::unbounded_channel();

    let custom_lens = CustomLensDef {
        id: "lens_cost".to_owned(),
        name: "Cost Audit".to_owned(),
        tag: "cost".to_owned(),
        description: "Audit cloud cost traps".to_owned(),
        prompt_template: "Expose hidden cloud egress or storage multiplier traps.".to_owned(),
        default_node_type: NodeType::Loophole,
        default_edge_type: EdgeType::Challenges,
        default_severity: Some(Severity::High),
    };

    let spawned = execute_lens_run(
        LensRunParams {
            run_id: "run_custom_lens".to_owned(),
            lens: LensKind::Custom,
            focus_ids: vec!["n_root".to_owned()],
            custom_prompt: None, // Empty custom_prompt must succeed when custom_lens is present
            in_place: false,
            custom_lens: Some(custom_lens),
            config: base_tier(&base_url, "gpt-4o"),
            api_key: None,
            token_budget: 6000,
            expected_generation: 1,
            prepared: None,
        },
        ws.clone(),
        db,
        Arc::new(AtomicU64::new(1)),
        active_runs,
        summary_tx,
        reqwest::Client::new(),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .expect("custom lens run succeeds with empty custom_prompt");

    assert_eq!(spawned.len(), 1);

    let prompts = captured_sys.lock().expect("sys prompts");
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].contains("Cost Audit"));
    assert!(prompts[0].contains("Expose hidden cloud egress or storage multiplier traps."));
    assert!(prompts[0].contains("type=loophole edge=challenges severity=high"));

    let ws_g = ws.read().expect("ws read");
    let eng = &ws_g.as_ref().expect("active").engine;
    let node = eng.nodes.get(&spawned[0]).expect("spawned node");
    assert_eq!(node.title, "Cost Audit");
    assert_eq!(node.node_type, NodeType::Loophole);
    assert_eq!(node.metadata.severity, Some(Severity::High));
    assert_eq!(node.metadata.lens, NodeLensOrigin::Custom);
    let out = eng.outgoing.get(&node.id).expect("challenges edge");
    assert_eq!(out[0].edge_type, EdgeType::Challenges);
    assert_eq!(out[0].target_id, "n_root");
}

#[test]
fn compute_graph_diagnostics_detects_cycles_loopholes_stale_orphans_heavy_and_score() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("diag.sqlite");
    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();

    // Clean single-node graph -> 100 health score, 0 orphans
    let mut root = make_node("n_a", NodeType::Core, "Core A", "Short core", 0.0, 0.0);
    root.context_controls.pin_global = true;
    apply_ops(&mut conn, &mut engine, &[GraphOp::CreateNode { node: root }]).expect("seed root");

    let clean = compute_graph_diagnostics(&conn, &engine).expect("clean diagnostics");
    assert_eq!(clean.health_score, 100);
    assert_eq!(clean.node_count, 1);
    assert_eq!(clean.pin_count, 1);
    assert!(clean.orphan_nodes.is_empty());

    // Now build a complex graph with cycles, severity-sorted loopholes, stale AI node, orphan, and heavy unsummarized node
    let b = make_node("n_b", NodeType::Branch, "Branch B", "Part of cycle", 400.0, 0.0);
    let c = make_node("n_c", NodeType::Synthesis, "Synth C", "Closes cycle", 800.0, 0.0);

    let mut lh_low = make_node("n_lh_low", NodeType::Loophole, "Minor Glitch", "Low", 0.0, 240.0);
    lh_low.metadata.severity = Some(Severity::Low);

    let mut lh_crit = make_node(
        "n_lh_crit",
        NodeType::Loophole,
        "Data Loss Bug",
        "Critical",
        400.0,
        240.0,
    );
    lh_crit.metadata.severity = Some(Severity::Critical);

    let mut lh_resolved = make_node(
        "n_lh_done",
        NodeType::Loophole,
        "Resolved Issue",
        "Done",
        800.0,
        240.0,
    );
    lh_resolved.metadata.severity = Some(Severity::Critical);
    lh_resolved.status = NodeStatus::Resolved;

    let heavy_body = "Detailed systems specification with many constraints and invariants. ".repeat(18);
    let mut heavy_orphan = make_node(
        "n_orphan_heavy",
        NodeType::Core,
        "Heavy Orphan",
        &heavy_body,
        1200.0,
        0.0,
    );
    heavy_orphan.context_controls.exclude_from_ai = false;

    let mut excluded_heavy = make_node(
        "n_excl",
        NodeType::Core,
        "Excluded Heavy",
        &heavy_body,
        1200.0,
        240.0,
    );
    excluded_heavy.context_controls.exclude_from_ai = true;

    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: b },
            GraphOp::CreateNode { node: c },
            GraphOp::CreateNode { node: lh_low },
            GraphOp::CreateNode { node: lh_crit },
            GraphOp::CreateNode { node: lh_resolved },
            GraphOp::CreateNode { node: heavy_orphan },
            GraphOp::CreateNode { node: excluded_heavy },
            GraphOp::CreateEdge {
                edge: make_edge("e1", "n_a", "n_b", EdgeType::Branches),
            },
            GraphOp::CreateEdge {
                edge: make_edge("e2", "n_b", "n_c", EdgeType::Synthesizes),
            },
            GraphOp::CreateEdge {
                edge: make_edge("e3", "n_c", "n_a", EdgeType::Derives),
            },
            GraphOp::CreateEdge {
                edge: make_edge("e4", "n_lh_low", "n_a", EdgeType::Challenges),
            },
            GraphOp::CreateEdge {
                edge: make_edge("e5", "n_lh_crit", "n_b", EdgeType::Challenges),
            },
            GraphOp::CreateEdge {
                edge: make_edge("e6", "n_lh_done", "n_b", EdgeType::Challenges),
            },
        ],
    )
    .expect("seed complex graph");

    // Mark n_c as an AI node whose upstream n_a had a stale hash
    upsert_ai_run_provenance(
        &conn,
        "n_c",
        "run_prev",
        LensKind::Synthesize,
        Some("gpt-4o"),
        &[ProvenanceInput {
            node_id: "n_a".to_owned(),
            title: "Core A".to_owned(),
            content_hash: "outdated_hash".to_owned(),
        }],
        120,
        1_700_000_000_000,
    )
    .expect("insert provenance");

    let diag = compute_graph_diagnostics(&conn, &engine).expect("compute diagnostics");
    assert_eq!(diag.node_count, 8);
    assert_eq!(diag.edge_count, 6);
    assert_eq!(diag.pin_count, 1);
    assert_eq!(diag.excluded_count, 1);

    // Unresolved loopholes: Critical before Low, resolved excluded
    let lh_ids: Vec<&str> = diag
        .unresolved_loopholes
        .iter()
        .map(|l| l.node_id.as_str())
        .collect();
    assert_eq!(lh_ids, vec!["n_lh_crit", "n_lh_low"]);
    assert!(diag.unresolved_loopholes[0].detail.contains("Branch B"));

    // Tarjan SCC cycle: n_a, n_b, n_c
    assert_eq!(diag.cycles.len(), 1);
    assert_eq!(diag.cycles[0].node_ids, vec!["n_a", "n_b", "n_c"]);
    assert_eq!(diag.cycles[0].titles, vec!["Core A", "Branch B", "Synth C"]);

    // Stale AI node
    assert_eq!(diag.stale_ai_nodes.len(), 1);
    assert_eq!(diag.stale_ai_nodes[0].node_id, "n_c");
    assert!(diag.stale_ai_nodes[0].detail.contains("modified"));

    // Orphans: n_excl and n_orphan_heavy sorted id ASC
    let orphan_ids: Vec<&str> = diag
        .orphan_nodes
        .iter()
        .map(|o| o.node_id.as_str())
        .collect();
    assert_eq!(orphan_ids, vec!["n_excl", "n_orphan_heavy"]);

    // Unsummarized heavy: excludes n_excl (exclude_from_ai = true)
    assert_eq!(diag.unsummarized_heavy_nodes.len(), 1);
    assert_eq!(diag.unsummarized_heavy_nodes[0].node_id, "n_orphan_heavy");

    // Penalty: 15 (crit) + 2 (low) + 6 (stale) + 12 (cycle) + 6 (2 orphans) + 2 (heavy) = 43 -> 57
    assert_eq!(diag.health_score, 57);
}

#[test]
fn import_markdown_outline_parses_semantics_respects_fences_and_layouts_without_overlap() {
    let md = r#"
# Storage Architecture
Core append-only WAL design.

```python
# Not a heading inside fenced code block
def write_entry():
    pass
```

## Question: Why use io_uring?
Async submission queue avoids syscall overhead.

## Option: Direct O_DIRECT IO
Bypass kernel page cache.

### Risk: Page Alignment Overhead
Unaligned buffers fail with EINVAL.

### Critical: Power Loss Torn Write
Partial sector flush corrupts tail frame.

## Decision: Dual-Ring Commit Log
Combine O_DIRECT with CRC32C checksums.
"#;

    let sections = parse_markdown_outline(md).expect("parse outline");
    assert_eq!(sections.len(), 6);
    assert_eq!(sections[0].title, "Storage Architecture");
    assert!(sections[0].content.contains("# Not a heading inside fenced code block"));
    assert_eq!(sections[0].node_type, NodeType::Core);
    assert_eq!(sections[0].parent_idx, None);

    assert_eq!(sections[1].title, "Question: Why use io_uring?");
    assert_eq!(sections[1].node_type, NodeType::Probe);
    assert_eq!(sections[1].edge_type, EdgeType::Derives);
    assert_eq!(sections[1].parent_idx, Some(0));

    assert_eq!(sections[2].title, "Option: Direct O_DIRECT IO");
    assert_eq!(sections[2].node_type, NodeType::Branch);
    assert_eq!(sections[2].edge_type, EdgeType::Branches);
    assert_eq!(sections[2].parent_idx, Some(0));

    assert_eq!(sections[3].title, "Risk: Page Alignment Overhead");
    assert_eq!(sections[3].node_type, NodeType::Loophole);
    assert_eq!(sections[3].edge_type, EdgeType::Challenges);
    assert_eq!(sections[3].severity, Some(Severity::Medium));
    assert_eq!(sections[3].parent_idx, Some(2));

    assert_eq!(sections[4].title, "Critical: Power Loss Torn Write");
    assert_eq!(sections[4].node_type, NodeType::Loophole);
    assert_eq!(sections[4].edge_type, EdgeType::Challenges);
    assert_eq!(sections[4].severity, Some(Severity::Critical));
    assert_eq!(sections[4].parent_idx, Some(2));

    assert_eq!(sections[5].title, "Decision: Dual-Ring Commit Log");
    assert_eq!(sections[5].node_type, NodeType::Synthesis);
    assert_eq!(sections[5].edge_type, EdgeType::Derives);
    assert_eq!(sections[5].parent_idx, Some(0));

    // Import into SQLite workspace attached to an existing parent node
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("import.sqlite");
    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();
    let existing = make_node("n_anchor", NodeType::Core, "Platform Spec", "Top", 0.0, 0.0);
    apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::CreateNode { node: existing }],
    )
    .expect("seed anchor");

    // Reject unknown parent_id
    let missing_err = import_markdown_outline(&mut conn, &mut engine, md, Some("missing_id"))
        .expect_err("unknown parent_id must fail");
    assert_eq!(missing_err.code, IpcErrorCode::ValidationError);

    let res = import_markdown_outline(&mut conn, &mut engine, md, Some("n_anchor"))
        .expect("import outline under anchor");
    assert_eq!(res.created_nodes.len(), 6);
    assert_eq!(res.created_edges.len(), 6);

    // Edge linking root_id to n_anchor exists
    assert!(res
        .created_edges
        .iter()
        .any(|e| e.source_id == "n_anchor" && e.target_id == res.root_id && e.edge_type == EdgeType::Derives));

    // Risk/Critical edges point from loophole -> Option parent
    let option_node = res
        .created_nodes
        .iter()
        .find(|n| n.title == "Option: Direct O_DIRECT IO")
        .expect("option node");
    let crit_node = res
        .created_nodes
        .iter()
        .find(|n| n.title == "Critical: Power Loss Torn Write")
        .expect("crit node");
    assert!(res.created_edges.iter().any(|e| {
        e.source_id == crit_node.id
            && e.target_id == option_node.id
            && e.edge_type == EdgeType::Challenges
    }));

    // Zero overlaps across ALL nodes on canvas
    let all = engine.all_nodes_sorted();
    assert_eq!(all.len(), 7);
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

    // Rehydrate from SQLite to prove atomic DB persistence
    let snap = hydrate_or_seed_workspace(&mut conn, &db_path.to_string_lossy()).expect("rehydrate");
    assert_eq!(snap.nodes.len(), 7);
    assert_eq!(snap.edges.len(), 6);

    // Plain text fallback (no ATX headings)
    let plain = "Distributed Cache Plan\nUse consistent hashing.\nAdd read-through fallback.";
    let plain_res =
        import_markdown_outline(&mut conn, &mut engine, plain, None).expect("plain import");
    assert_eq!(plain_res.created_nodes.len(), 1);
    assert_eq!(plain_res.created_nodes[0].title, "Distributed Cache Plan");
    assert!(plain_res.created_nodes[0]
        .content
        .contains("Use consistent hashing."));
}

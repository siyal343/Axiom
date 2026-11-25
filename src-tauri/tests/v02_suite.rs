use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tempfile::tempdir;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use axiom_canvas_lib::ai::provider::{stream_completion, LlmStreamRequest};
use axiom_canvas_lib::ai::runner::{execute_lens_run, LensRunParams};
use axiom_canvas_lib::ai::summarizer::spawn_summarizer_worker;
use axiom_canvas_lib::db::json_io::{export_json, import_json};
use axiom_canvas_lib::db::queries::{
    apply_ops, list_stale_summary_node_ids, save_token_budget,
};
use axiom_canvas_lib::db::{hydrate_or_seed_workspace, open_connection};
use axiom_canvas_lib::error::IpcErrorCode;
use axiom_canvas_lib::graph::compiler::compile_context;
use axiom_canvas_lib::graph::exporter::{compile_markdown_artifact, write_artifact_atomic};
use axiom_canvas_lib::graph::models::{
    compute_content_hash, estimate_tokens, ArtifactFormat, ArtifactScope, ContextControls,
    CreatedBy, EdgeDto, EdgeType, EdgeWeight, GraphOp, InclusionMode, LensKind, LensStreamEvent,
    ModelTierConfig, NodeDto, NodeLayout, NodeLensOrigin, NodeMetadata, NodeStatus, NodeType,
    ProviderKind, SaveSettingsInput, Severity, SummaryUpdatedEvent,
};
use axiom_canvas_lib::graph::spatial::{DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH};
use axiom_canvas_lib::graph::GraphEngine;
use axiom_canvas_lib::ipc::{ActiveWorkspace, AppState};
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
fn locked_node_blocks_delete_and_meta_mutations_until_explicit_unlock() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("locked.sqlite");
    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();

    let n1 = make_node("n1", NodeType::Core, "Locked Core", "Critical spec", 0.0, 0.0);
    let n2 = make_node("n2", NodeType::Branch, "Child", "Follow-up", 400.0, 0.0);
    let e1 = make_edge("e1", "n1", "n2", EdgeType::Derives);

    apply_ops(
        &mut conn,
        &mut engine,
        &[
            GraphOp::CreateNode { node: n1 },
            GraphOp::CreateNode { node: n2 },
            GraphOp::CreateEdge { edge: e1 },
            GraphOp::UpdateNodeMeta {
                id: "n1".to_owned(),
                node_type: None,
                status: Some(NodeStatus::Locked),
                severity: None,
                pin_global: None,
                exclude_from_ai: None,
                collapsed: None,
            },
        ],
    )
    .expect("seed and lock n1");

    // 1. DeleteNodes on a locked node must fail with NodeLocked and keep node + edge intact.
    let del_err = apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::DeleteNodes {
            ids: vec!["n1".to_owned()],
        }],
    )
    .expect_err("deleting locked node must fail");
    assert_eq!(del_err.code, IpcErrorCode::NodeLocked);
    assert!(engine.nodes.contains_key("n1"));
    assert!(engine.get_edge("e1").is_some());

    // 2. UpdateNodeMeta with status: None must fail with NodeLocked.
    let meta_none_err = apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::UpdateNodeMeta {
            id: "n1".to_owned(),
            node_type: None,
            status: None,
            severity: None,
            pin_global: Some(true),
            exclude_from_ai: None,
            collapsed: None,
        }],
    )
    .expect_err("meta patch on locked node with status=None must fail");
    assert_eq!(meta_none_err.code, IpcErrorCode::NodeLocked);
    assert!(!engine.nodes["n1"].context_controls.pin_global);

    // 3. UpdateNodeMeta with status: Some(Locked) must also fail with NodeLocked.
    let meta_locked_err = apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::UpdateNodeMeta {
            id: "n1".to_owned(),
            node_type: None,
            status: Some(NodeStatus::Locked),
            severity: None,
            pin_global: None,
            exclude_from_ai: Some(true),
            collapsed: None,
        }],
    )
    .expect_err("meta patch on locked node with status=Locked must fail");
    assert_eq!(meta_locked_err.code, IpcErrorCode::NodeLocked);
    assert!(!engine.nodes["n1"].context_controls.exclude_from_ai);

    // 4. Explicit unlock via status: Some(Active) succeeds, and then delete succeeds.
    apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::UpdateNodeMeta {
            id: "n1".to_owned(),
            node_type: None,
            status: Some(NodeStatus::Active),
            severity: None,
            pin_global: Some(true),
            exclude_from_ai: None,
            collapsed: None,
        }],
    )
    .expect("explicit unlock must succeed");
    assert_eq!(engine.nodes["n1"].status, NodeStatus::Active);
    assert!(engine.nodes["n1"].context_controls.pin_global);

    let (del_ok, _) = apply_ops(
        &mut conn,
        &mut engine,
        &[GraphOp::DeleteNodes {
            ids: vec!["n1".to_owned()],
        }],
    )
    .expect("delete after unlock must succeed");
    assert_eq!(del_ok.deleted_node_ids, vec!["n1".to_owned()]);
    assert!(!engine.nodes.contains_key("n1"));
}

#[test]
fn export_json_is_byte_identical_across_calls_and_failed_import_preserves_existing_db() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("ws.sqlite");
    let json1_path = dir.path().join("export1.json");
    let json2_path = dir.path().join("export2.json");

    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();
    let n1 = make_node("n1", NodeType::Core, "Deterministic", "Stable body", 0.0, 0.0);
    apply_ops(&mut conn, &mut engine, &[GraphOp::CreateNode { node: n1 }]).expect("seed");
    save_token_budget(&mut conn, 8192).expect("save token budget");

    export_json(&conn, &json1_path).expect("export 1");
    thread::sleep(Duration::from_millis(15));
    export_json(&conn, &json2_path).expect("export 2");

    let raw1 = std::fs::read_to_string(&json1_path).expect("read json 1");
    let raw2 = std::fs::read_to_string(&json2_path).expect("read json 2");
    assert_eq!(raw1, raw2, "two exports must be byte-for-byte identical including exported_at");

    // Verify token_budget persisted in DB and JSON
    let val: serde_json::Value = serde_json::from_str(&raw1).expect("parse export");
    assert_eq!(val["meta"]["token_budget"], serde_json::json!(8192));

    // Malformed JSON import must fail and leave existing DB + directory clean.
    let bad_json = dir.path().join("malformed.json");
    std::fs::write(&bad_json, "{ not valid json").expect("write bad json");
    let err = import_json(&bad_json, &db_path).expect_err("malformed json must fail");
    assert_eq!(err.code, IpcErrorCode::ValidationError);

    // Existing DB still intact
    let snap = hydrate_or_seed_workspace(&mut conn, &db_path.to_string_lossy()).expect("hydrate");
    assert_eq!(snap.nodes.len(), 1);
    assert_eq!(snap.nodes[0].id, "n1");
    assert_eq!(snap.token_budget, 8192);

    // Ensure no leftover staging files in dir
    let leftovers: Vec<String> = std::fs::read_dir(dir.path())
        .expect("read dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".importing-"))
        .collect();
    assert!(leftovers.is_empty(), "leftover staging files found: {leftovers:?}");
}

#[test]
fn compiler_v2_accounts_empty_summary_cost_pin_loopholes_parent_relations_and_xray_fields() {
    let long_content = "Detailed architectural specification text. ".repeat(12); // ~125 tokens
    let mut old_anc = make_node("n_old", NodeType::Core, "Ancient Spec", &long_content, 0.0, 0.0);
    old_anc.summary = String::new(); // Empty summary -> must fall back to token_count

    let parent = make_node("n_par", NodeType::Core, "Direct Parent", "Parent body", 400.0, 0.0);
    let focus = make_node("n_foc", NodeType::Branch, "Focus Design", "Focus body", 800.0, 0.0);

    let mut pin = make_node("n_pin", NodeType::Core, "Global SLO", "p99 < 15ms", -400.0, 0.0);
    pin.context_controls.pin_global = true;

    let mut pin_lh = make_node(
        "n_pin_lh",
        NodeType::Loophole,
        "SLO Tail Latency Breach",
        "Cold cache misses exceed 15ms",
        -400.0,
        220.0,
    );
    pin_lh.metadata.severity = Some(Severity::Critical);

    let expected_old_tokens = old_anc.metadata.token_count;

    let engine = GraphEngine::from_snapshot(
        &[old_anc, parent, focus, pin, pin_lh],
        &[
            make_edge("e1", "n_old", "n_par", EdgeType::Derives),
            make_edge("e2", "n_par", "n_foc", EdgeType::Branches),
            make_edge("e3", "n_pin_lh", "n_pin", EdgeType::Challenges),
        ],
    );

    // Budget deliberately tight so overflow = true
    let compiled = compile_context(&engine, &["n_foc".to_owned()], 50);

    // 1. Empty summary uses full token_count (not title tokens)
    assert_eq!(
        compiled.xray.mode_tokens.get(&InclusionMode::Summary).copied(),
        Some(expected_old_tokens)
    );
    // 2. Loophole targeting Global Pin is harvested into [UNRESOLVED LOOPHOLES]
    assert_eq!(
        compiled.xray.node_modes.get("n_pin_lh"),
        Some(&InclusionMode::Loophole)
    );
    assert!(compiled.prompt_text.contains("[UNRESOLVED LOOPHOLES]"));
    assert!(compiled.prompt_text.contains("SLO Tail Latency Breach"));
    // 3. Direct parent heading includes incoming edge relation
    assert!(compiled.prompt_text.contains("### Direct Parent [Core · branches]"));
    // 4. Extended CompiledXray fields
    assert!(compiled.xray.overflow);
    assert_eq!(compiled.xray.prompt_preview, compiled.prompt_text);
    let sum_mode_tokens: u32 = compiled.xray.mode_tokens.values().sum();
    assert_eq!(sum_mode_tokens, compiled.xray.total_tokens);
}

#[test]
fn artifact_compiler_adr_brief_mermaid_are_deterministic_cycle_safe_and_pair_mitigations() {
    let mut pin = make_node("n_pin", NodeType::Core, "Zero Data Loss", "RPO = 0", -400.0, 0.0);
    pin.context_controls.pin_global = true;

    let core = make_node("n_core", NodeType::Core, "WAL Engine", "Append-only commit log", 0.0, 0.0);
    let branch = make_node("n_branch", NodeType::Branch, "Async Replication", "Lower write latency", 400.0, 120.0);
    let probe = make_node("n_probe", NodeType::Probe, "Why fsync?", "Page cache vs disk durability", 400.0, -140.0);
    let synth = make_node("n_synth", NodeType::Synthesis, "Sync Quorum", "Quorum commit before ack", 800.0, 0.0);
    let ref_doc = make_node("n_ref", NodeType::Core, "Raft Paper", "Section 5.4 safety proof", 800.0, 260.0);

    let mut lh_open = make_node(
        "n_lh_open",
        NodeType::Loophole,
        "Split Brain Risk",
        "Dual leader writes during partition",
        0.0,
        240.0,
    );
    lh_open.metadata.severity = Some(Severity::Critical);

    let mut lh_fixed = make_node(
        "n_lh_fixed",
        NodeType::Loophole,
        "Log Truncation",
        "Unbounded WAL growth",
        400.0,
        340.0,
    );
    lh_fixed.metadata.severity = Some(Severity::Medium);
    lh_fixed.status = NodeStatus::Resolved;

    let mitigation = make_node(
        "n_mit",
        NodeType::Branch,
        "Snapshot Compaction",
        "Compact WAL every 64MB",
        800.0,
        420.0,
    );

    let mut excluded = make_node(
        "n_excl",
        NodeType::Branch,
        "Private Scratchpad",
        "Should not appear",
        1200.0,
        0.0,
    );
    excluded.context_controls.exclude_from_ai = true;

    let engine = GraphEngine::from_snapshot(
        &[pin, core, branch, probe, synth, ref_doc, lh_open, lh_fixed, mitigation, excluded],
        &[
            // Intentional cycle between core and branch to verify cycle safety
            make_edge("e1", "n_core", "n_branch", EdgeType::Branches),
            make_edge("e2", "n_branch", "n_core", EdgeType::Derives),
            make_edge("e3", "n_core", "n_probe", EdgeType::Derives),
            make_edge("e4", "n_branch", "n_synth", EdgeType::Synthesizes),
            make_edge("e5", "n_core", "n_synth", EdgeType::Synthesizes),
            make_edge("e6", "n_lh_open", "n_core", EdgeType::Challenges),
            make_edge("e7", "n_lh_fixed", "n_branch", EdgeType::Challenges),
            make_edge("e8", "n_mit", "n_lh_fixed", EdgeType::Resolves),
            make_edge("e9", "n_synth", "n_ref", EdgeType::References),
            make_edge("e10", "n_synth", "n_excl", EdgeType::Derives),
        ],
    );

    let focus = vec!["n_synth".to_owned()];

    for fmt in [ArtifactFormat::Adr, ArtifactFormat::Brief, ArtifactFormat::Mermaid] {
        let a1 = compile_markdown_artifact(&engine, &focus, ArtifactScope::Subgraph, fmt);
        let a2 = compile_markdown_artifact(&engine, &focus, ArtifactScope::Subgraph, fmt);
        assert_eq!(a1.markdown, a2.markdown, "artifact output must be deterministic for {fmt:?}");
        assert_eq!(a1.unresolved_loophole_count, 1);
        assert!(!a1.markdown.contains("Private Scratchpad"));
    }

    let adr = compile_markdown_artifact(&engine, &focus, ArtifactScope::Subgraph, ArtifactFormat::Adr);
    assert!(adr.markdown.contains("## Context & Global Constraints"));
    assert!(adr.markdown.contains("## Decision Spine"));
    assert!(adr.markdown.contains("## Alternatives Considered"));
    assert!(adr.markdown.contains("## Risk & Loophole Register"));
    assert!(adr.markdown.contains("OPEN CRITICAL"));
    assert!(adr.markdown.contains("Snapshot Compaction"));
    assert!(adr.markdown.contains("## Architecture Graph"));
    assert!(adr.markdown.contains("```mermaid\nflowchart LR"));

    let brief = compile_markdown_artifact(&engine, &focus, ArtifactScope::Workspace, ArtifactFormat::Brief);
    assert!(brief.markdown.contains("## Key Takeaways & Synthesis"));
    assert!(brief.markdown.contains("## Core Concepts & Derivations"));
    assert!(brief.markdown.contains("## Probing Questions & Study Checks"));
    assert!(brief.markdown.contains("## Open Challenges & Mitigations"));
    assert!(brief.markdown.contains("## References"));
    assert!(brief.markdown.contains("Raft Paper"));
    assert!(brief.markdown.contains("Snapshot Compaction"));

    let mermaid = compile_markdown_artifact(&engine, &focus, ArtifactScope::Subgraph, ArtifactFormat::Mermaid);
    assert!(mermaid.markdown.contains("flowchart LR"));
    assert!(mermaid.markdown.contains("-->|resolves|"));
    assert!(mermaid.markdown.contains("==>|challenges|"));

    // Atomic file write check
    let out_dir = tempdir().expect("out_dir");
    let out_file = out_dir.path().join("nested").join("adr.md");
    write_artifact_atomic(&out_file, &adr.markdown).expect("write artifact atomic");
    assert_eq!(
        std::fs::read_to_string(&out_file).expect("read artifact"),
        adr.markdown
    );
    let tmp_leftovers: Vec<String> = std::fs::read_dir(out_dir.path().join("nested"))
        .expect("read nested dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tmp"))
        .collect();
    assert!(tmp_leftovers.is_empty());
}

#[tokio::test]
async fn generation_guard_aborts_stale_lens_and_summarizer_writes_and_anthropic_requires_key() {
    // 1. Anthropic missing API key fails fast with ProviderAuth without network call
    let hit_counter = Arc::new(AtomicUsize::new(0));
    let hit_clone = hit_counter.clone();
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let base_url = format!("http://{addr}");

    let app_state = Arc::new(AppState::new().0);
    let gen_ref = app_state.workspace_generation.clone();
    let active_runs = app_state.active_runs.clone();

    thread::spawn(move || {
        for stream_res in listener.incoming() {
            let Ok(mut stream) = stream_res else { break };
            hit_clone.fetch_add(1, Ordering::SeqCst);
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
            if content_len > 0 {
                let mut buf = vec![0u8; content_len];
                let _ = reader.read_exact(&mut buf);
            }

            // Simulate workspace switch occurring BEFORE response streams back!
            let _ = gen_ref.fetch_add(1, Ordering::SeqCst);
            if let Ok(mut runs) = active_runs.lock() {
                for tok in runs.values() {
                    tok.cancel();
                }
                runs.clear();
            }

            let sse = format!(
                "data: {}\n\ndata: [DONE]\n\n",
                serde_json::json!({
                    "choices": [{
                        "delta": {
                            "content": "@@NODE type=branch edge=branches title=\"Stale\"\nShould never write.\n@@END\n"
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

    let auth_err = stream_completion(
        &app_state.http_client,
        LlmStreamRequest {
            system_prompt: "sys".to_owned(),
            user_prompt: "usr".to_owned(),
            config: ModelTierConfig {
                provider: ProviderKind::Anthropic,
                base_url: base_url.clone(),
                model: "claude-sonnet-4-20250514".to_owned(),
                has_api_key: false,
                temperature: 0.4,
                max_tokens: 256,
            },
            api_key: Some("   ".to_owned()),
        },
        CancellationToken::new(),
        |_| Ok(()),
    )
    .await
    .expect_err("whitespace Anthropic key must fail fast");
    assert_eq!(auth_err.code, IpcErrorCode::ProviderAuth);
    assert_eq!(hit_counter.load(Ordering::SeqCst), 0);

    // 2. Stale workspace generation aborts lens run cleanly without mutating new workspace
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("gen.sqlite");
    let mut conn = open_connection(&db_path).expect("open db");
    let mut engine = GraphEngine::default();
    let root = make_node("n_root", NodeType::Core, "Root", "Initial", 0.0, 0.0);
    apply_ops(&mut conn, &mut engine, &[GraphOp::CreateNode { node: root }]).expect("seed");

    {
        let mut ws_g = app_state.workspace.write().expect("ws write");
        let mut db_g = app_state.db.lock().expect("db lock");
        *ws_g = Some(ActiveWorkspace {
            path: db_path.to_string_lossy().into_owned(),
            engine,
            token_budget: 6000,
        });
        *db_g = Some(conn);
    }

    let expected_gen = app_state.workspace_generation.load(Ordering::SeqCst);
    let cancel = CancellationToken::new();
    {
        let mut runs = app_state.active_runs.lock().expect("runs lock");
        runs.insert("run_stale".to_owned(), cancel.clone());
    }

    let events = Arc::new(Mutex::new(Vec::new()));
    let events_ref = events.clone();

    let spawned = execute_lens_run(
        LensRunParams {
            run_id: "run_stale".to_owned(),
            lens: LensKind::Diverge,
            focus_ids: vec!["n_root".to_owned()],
            custom_prompt: None,
            in_place: false,
            config: ModelTierConfig {
                provider: ProviderKind::OpenaiCompat,
                base_url,
                model: "gpt-4o".to_owned(),
                has_api_key: false,
                temperature: 0.4,
                max_tokens: 256,
            },
            api_key: None,
            token_budget: 6000,
            expected_generation: expected_gen,
            prepared: None,
        },
        app_state.workspace.clone(),
        app_state.db.clone(),
        app_state.workspace_generation.clone(),
        app_state.active_runs.clone(),
        app_state.summary_tx.clone(),
        app_state.http_client.clone(),
        cancel,
        move |evt| {
            if let Ok(mut list) = events_ref.lock() {
                list.push(evt);
            }
        },
    )
    .await
    .expect("stale run aborts cleanly");

    assert!(spawned.is_empty(), "stale run must not spawn nodes into new generation");
    {
        let ws_g = app_state.workspace.read().expect("ws read");
        assert_eq!(ws_g.as_ref().expect("ws").engine.nodes.len(), 1);
    }
    {
        let evts = events.lock().expect("events");
        assert!(evts.iter().any(|e| matches!(
            e,
            LensStreamEvent::RunCompleted {
                cancelled: true,
                ..
            }
        )));
    }

    // 3. Stale summary query excludes draft/excluded nodes & summarizer aborts mid-flight on generation bump
    let long_content = "Detailed distributed consensus specification and proof obligations. ".repeat(6);
    let long_node = make_node("n_long", NodeType::Core, "Long Spec", &long_content, 400.0, 0.0);
    let mut draft_node = make_node("n_draft", NodeType::Branch, "Draft Spec", "Draft text", 800.0, 0.0);
    draft_node.status = NodeStatus::Draft;
    let mut excl_node = make_node("n_excl", NodeType::Branch, "Excl Spec", "Excluded text", 1200.0, 0.0);
    excl_node.context_controls.exclude_from_ai = true;

    {
        let mut ws_g = app_state.workspace.write().expect("ws write");
        let mut db_g = app_state.db.lock().expect("db lock");
        let active = ws_g.as_mut().expect("ws");
        let conn_ref = db_g.as_mut().expect("conn");
        apply_ops(
            conn_ref,
            &mut active.engine,
            &[
                GraphOp::CreateNode { node: long_node },
                GraphOp::CreateNode { node: draft_node },
                GraphOp::CreateNode { node: excl_node },
            ],
        )
        .expect("seed extra nodes");

        let stale = list_stale_summary_node_ids(conn_ref, 64).expect("list stale");
        assert_eq!(stale, vec!["n_root".to_owned(), "n_long".to_owned()]);
    }

    let ws_gen_sum = Arc::new(AtomicU64::new(1));
    let ws_gen_sum_srv = ws_gen_sum.clone();
    let sum_listener = TcpListener::bind("127.0.0.1:0").expect("bind sum mock");
    let sum_addr = sum_listener.local_addr().expect("sum addr");
    let sum_base_url = format!("http://{sum_addr}");
    thread::spawn(move || {
        if let Ok((mut stream, _)) = sum_listener.accept() {
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
            if content_len > 0 {
                let mut buf = vec![0u8; content_len];
                let _ = reader.read_exact(&mut buf);
            }
            // Bump generation while utility LLM request is in-flight!
            ws_gen_sum_srv.fetch_add(1, Ordering::SeqCst);
            let line_json = serde_json::json!({
                "choices": [{ "delta": { "content": "Stale summary that must not persist." } }]
            });
            let sse = format!("data: {line_json}\n\ndata: [DONE]\n\n");
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}",
                sse.len()
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });

    let settings = Arc::new(SettingsStore::with_config_path(
        dir.path().join("settings.json"),
        false,
    ));
    settings
        .save(SaveSettingsInput {
            reasoning: ModelTierConfig {
                provider: ProviderKind::OpenaiCompat,
                base_url: sum_base_url.clone(),
                model: "gpt-4o".to_owned(),
                has_api_key: false,
                temperature: 0.4,
                max_tokens: 256,
            },
            reasoning_api_key: None,
            utility: ModelTierConfig {
                provider: ProviderKind::OpenaiCompat,
                base_url: sum_base_url,
                model: "gpt-4o-mini".to_owned(),
                has_api_key: false,
                temperature: 0.2,
                max_tokens: 256,
            },
            utility_api_key: None,
            default_token_budget: 6000,
            auto_summarize: true,
            theme: "dark".to_owned(),
        })
        .expect("save settings");

    let (sum_tx, sum_rx) = mpsc::unbounded_channel();
    let (evt_tx, mut evt_rx) = mpsc::unbounded_channel::<SummaryUpdatedEvent>();
    let worker = spawn_summarizer_worker(
        sum_rx,
        app_state.workspace.clone(),
        app_state.db.clone(),
        ws_gen_sum.clone(),
        reqwest::Client::new(),
        settings,
        Duration::from_millis(30),
        move |evt| {
            let _ = evt_tx.send(evt);
        },
    );

    sum_tx.send("n_long".to_owned()).expect("send n_long");
    let stale_evt = tokio::time::timeout(Duration::from_millis(350), evt_rx.recv()).await;
    assert!(stale_evt.is_err(), "mid-flight generation bump must abort summary write");
    {
        let ws_g = app_state.workspace.read().expect("ws read");
        assert!(ws_g.as_ref().expect("ws").engine.nodes["n_long"].summary.is_empty());
    }

    drop(sum_tx);
    let _ = worker.await;
}

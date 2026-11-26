use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use axiom_canvas_lib::ai::provider::{build_anthropic_body, stream_completion, LlmStreamRequest};
use axiom_canvas_lib::ai::runner::{execute_lens_run, LensRunParams};
use axiom_canvas_lib::ai::summarizer::spawn_summarizer_worker;
use axiom_canvas_lib::db::open_connection;
use axiom_canvas_lib::db::queries::{apply_ops, update_node_summary};
use axiom_canvas_lib::error::IpcErrorCode;
use axiom_canvas_lib::graph::models::{
    compute_content_hash, estimate_tokens, ContextControls, CreatedBy, EdgeType, GraphOp,
    LensKind, LensStreamEvent, ModelTierConfig, NodeDto, NodeLayout, NodeLensOrigin, NodeMetadata,
    NodeStatus, NodeType, ProviderKind, SaveSettingsInput, SummaryUpdatedEvent,
};
use axiom_canvas_lib::graph::spatial::effective_height;
use axiom_canvas_lib::graph::GraphEngine;
use axiom_canvas_lib::ipc::ActiveWorkspace;
use axiom_canvas_lib::settings::SettingsStore;

struct CapturedRequest {
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

enum MockResponseAction {
    Immediate {
        status_line: &'static str,
        content_type: &'static str,
        body: String,
    },
    ChunkedPause {
        first_chunk: String,
        pause: Duration,
        second_chunk: String,
    },
}

struct MockServer {
    base_url: String,
    captured: Arc<Mutex<Vec<CapturedRequest>>>,
    hit_count: Arc<AtomicUsize>,
}

fn spawn_mock_server<F>(handler: F) -> MockServer
where
    F: Fn(&CapturedRequest) -> MockResponseAction + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
    let addr = listener.local_addr().expect("mock local_addr");
    let base_url = format!("http://{addr}");
    let captured = Arc::new(Mutex::new(Vec::new()));
    let hit_count = Arc::new(AtomicUsize::new(0));
    let captured_ref = captured.clone();
    let hits_ref = hit_count.clone();
    let handler = Arc::new(handler);

    thread::spawn(move || {
        for stream_res in listener.incoming() {
            let Ok(mut stream) = stream_res else {
                break;
            };
            let captured_inner = captured_ref.clone();
            let hits_inner = hits_ref.clone();
            let handler_inner = handler.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().expect("clone tcp stream"));
                let mut req_line = String::new();
                if reader.read_line(&mut req_line).is_err() || req_line.trim().is_empty() {
                    return;
                }
                let path = req_line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .to_owned();

                let mut headers = HashMap::new();
                let mut content_len: usize = 0;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        return;
                    }
                    let trimmed = line.trim_end_matches(['\r', '\n']);
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some((k, v)) = trimmed.split_once(':') {
                        let key = k.trim().to_ascii_lowercase();
                        let val = v.trim().to_owned();
                        if key == "content-length" {
                            content_len = val.parse::<usize>().unwrap_or(0);
                        }
                        headers.insert(key, val);
                    }
                }

                let mut body_bytes = vec![0u8; content_len];
                if content_len > 0 {
                    let _ = reader.read_exact(&mut body_bytes);
                }
                let body = String::from_utf8_lossy(&body_bytes).into_owned();
                let req = CapturedRequest {
                    path,
                    headers,
                    body,
                };
                hits_inner.fetch_add(1, Ordering::SeqCst);
                let action = handler_inner(&req);
                if let Ok(mut list) = captured_inner.lock() {
                    list.push(req);
                }

                match action {
                    MockResponseAction::Immediate {
                        status_line,
                        content_type,
                        body,
                    } => {
                        let resp = format!(
                            "HTTP/1.1 {status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes());
                        let _ = stream.flush();
                    }
                    MockResponseAction::ChunkedPause {
                        first_chunk,
                        pause,
                        second_chunk,
                    } => {
                        let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
                        let _ = stream.write_all(header.as_bytes());
                        let c1 = format!("{:x}\r\n{first_chunk}\r\n", first_chunk.len());
                        let _ = stream.write_all(c1.as_bytes());
                        let _ = stream.flush();
                        thread::sleep(pause);
                        let c2 = format!("{:x}\r\n{second_chunk}\r\n0\r\n\r\n", second_chunk.len());
                        let _ = stream.write_all(c2.as_bytes());
                        let _ = stream.flush();
                    }
                }
            });
        }
    });

    MockServer {
        base_url,
        captured,
        hit_count,
    }
}

fn make_focus_node(id: &str, title: &str, content: &str, x: f64, y: f64) -> NodeDto {
    NodeDto {
        id: id.to_owned(),
        node_type: NodeType::Core,
        status: NodeStatus::Active,
        title: title.to_owned(),
        content: content.to_owned(),
        summary: String::new(),
        content_hash: compute_content_hash(title, content),
        summary_hash: String::new(),
        metadata: NodeMetadata {
            severity: None,
            lens: NodeLensOrigin::Manual,
            created_by: CreatedBy::User,
            model: None,
            token_count: estimate_tokens(&format!("{title}\n{content}")),
        },
        context_controls: ContextControls {
            pin_global: false,
            exclude_from_ai: false,
        },
        layout: NodeLayout {
            x,
            y,
            width: 320.0,
            height: 180.0,
            collapsed: false,
        },
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
    }
}

struct WorkspaceFixture {
    _tmp: tempfile::NamedTempFile,
    ws: Arc<RwLock<Option<ActiveWorkspace>>>,
    db: Arc<Mutex<Option<rusqlite::Connection>>>,
}

fn setup_workspace(nodes: Vec<NodeDto>) -> WorkspaceFixture {
    let tmp = tempfile::NamedTempFile::new().expect("temp sqlite");
    let mut conn = open_connection(tmp.path()).expect("open sqlite");
    let mut engine = GraphEngine::default();
    let ops: Vec<GraphOp> = nodes
        .into_iter()
        .map(|node| GraphOp::CreateNode { node })
        .collect();
    apply_ops(&mut conn, &mut engine, &ops).expect("seed nodes");

    let ws = Arc::new(RwLock::new(Some(ActiveWorkspace {
        path: tmp.path().to_string_lossy().into_owned(),
        engine,
        token_budget: 6000,
        system_prompt: String::new(),
    })));
    let db = Arc::new(Mutex::new(Some(conn)));
    WorkspaceFixture { _tmp: tmp, ws, db }
}

fn rects_overlap(a: &NodeDto, b: &NodeDto) -> bool {
    let ax2 = a.layout.x + a.layout.width;
    let ay2 = a.layout.y + effective_height(a);
    let bx2 = b.layout.x + b.layout.width;
    let by2 = b.layout.y + effective_height(b);
    a.layout.x < bx2 && ax2 > b.layout.x && a.layout.y < by2 && ay2 > b.layout.y
}

#[tokio::test]
async fn openai_sse_diverge_3x_spawns_non_overlapping_branches_and_persists() {
    let sse_payload = [
        "@@NODE type=branch edge=branches title=\"Branch Alpha\"\nAlpha mechanism.\n@@END\n",
        "@@NODE type=branch edge=branches title=\"Branch Beta\"\nBeta mechanism.\n@@END\n",
        "@@NODE type=branch edge=branches title=\"Branch Gamma\"\nGamma mechanism.\n@@END\n",
    ]
    .concat();

    let mut sse_body = String::from(": keepalive\n\n");
    for chunk in sse_payload.as_bytes().chunks(24) {
        let s = std::str::from_utf8(chunk).expect("utf8");
        let line = serde_json::json!({
            "choices": [{ "delta": { "content": s } }]
        });
        sse_body.push_str(&format!("data: {line}\n\n"));
    }
    sse_body.push_str("data: [DONE]\n\n");

    let srv = spawn_mock_server(move |_req| {
        MockResponseAction::Immediate {
            status_line: "200 OK",
            content_type: "text/event-stream",
            body: sse_body.clone(),
        }
    });

    let focus = make_focus_node("node_root", "Gateway", "Core design", 0.0, 0.0);
    let fx = setup_workspace(vec![focus]);
    let active_runs = Arc::new(Mutex::new(HashMap::new()));
    let (summary_tx, _summary_rx) = mpsc::unbounded_channel();
    let events = Arc::new(Mutex::new(Vec::new()));
    let events_ref = events.clone();

    let ws_gen = Arc::new(AtomicU64::new(1));
    let spawned = execute_lens_run(
        LensRunParams {
            run_id: "run_diverge".to_owned(),
            lens: LensKind::Diverge,
            focus_ids: vec!["node_root".to_owned()],
            custom_prompt: None,
            in_place: false,
            custom_lens: None,
            config: ModelTierConfig {
                provider: ProviderKind::OpenaiCompat,
                base_url: srv.base_url,
                model: "gpt-4o".to_owned(),
                has_api_key: true,
                temperature: 0.4,
                max_tokens: 2048,
            },
            api_key: Some("sk-test-key".to_owned()),
            token_budget: 6000,
            expected_generation: 1,
            prepared: None,
        },
        fx.ws.clone(),
        fx.db,
        ws_gen,
        active_runs,
        summary_tx,
        reqwest::Client::new(),
        CancellationToken::new(),
        move |evt| {
            if let Ok(mut list) = events_ref.lock() {
                list.push(evt);
            }
        },
    )
    .await
    .expect("diverge run succeeds");

    assert_eq!(spawned.len(), 3);

    let reqs = srv.captured.lock().expect("captured");
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].path, "/chat/completions");
    assert_eq!(
        reqs[0].headers.get("authorization").map(String::as_str),
        Some("Bearer sk-test-key")
    );

    let ws_guard = fx.ws.read().expect("ws read");
    let engine = &ws_guard.as_ref().expect("active").engine;
    assert_eq!(engine.nodes.len(), 4);

    let all_nodes = engine.all_nodes_sorted();
    for i in 0..all_nodes.len() {
        for j in (i + 1)..all_nodes.len() {
            assert!(!rects_overlap(&all_nodes[i], &all_nodes[j]));
        }
    }

    for sid in &spawned {
        let node = engine.nodes.get(sid).expect("spawned node");
        assert_eq!(node.status, NodeStatus::Active);
        assert_eq!(node.node_type, NodeType::Branch);
        let in_edges = engine.incoming.get(sid).expect("incoming edge");
        assert_eq!(in_edges.len(), 1);
        assert_eq!(in_edges[0].source_id, "node_root");
        assert_eq!(in_edges[0].edge_type, EdgeType::Branches);
    }

    let evts = events.lock().expect("events");
    assert!(evts.iter().any(|e| matches!(
        e,
        LensStreamEvent::RunCompleted {
            cancelled: false,
            ..
        }
    )));
}

#[tokio::test]
async fn anthropic_sse_red_team_checks_headers_and_challenges_direction() {
    let payload = "@@NODE type=loophole edge=challenges severity=critical title=\"Lock Contention\"\nWriter starves readers.\n@@END\n";
    let ev1 = serde_json::json!({
        "type": "content_block_delta",
        "delta": { "type": "text_delta", "text": payload }
    });
    let ev2 = serde_json::json!({ "type": "message_stop" });
    let sse_body = format!("event: content_block_delta\ndata: {ev1}\n\nevent: message_stop\ndata: {ev2}\n\n");

    let srv = spawn_mock_server(move |_req| {
        MockResponseAction::Immediate {
            status_line: "200 OK",
            content_type: "text/event-stream",
            body: sse_body.clone(),
        }
    });

    let focus = make_focus_node("node_root", "Storage", "WAL engine", 0.0, 0.0);
    let fx = setup_workspace(vec![focus]);
    let active_runs = Arc::new(Mutex::new(HashMap::new()));
    let (summary_tx, _rx) = mpsc::unbounded_channel();

    let ws_gen = Arc::new(AtomicU64::new(1));
    let spawned = execute_lens_run(
        LensRunParams {
            run_id: "run_rt".to_owned(),
            lens: LensKind::RedTeam,
            focus_ids: vec!["node_root".to_owned()],
            custom_prompt: None,
            in_place: false,
            custom_lens: None,
            config: ModelTierConfig {
                provider: ProviderKind::Anthropic,
                base_url: srv.base_url,
                model: "claude-sonnet-4-20250514".to_owned(),
                has_api_key: true,
                temperature: 0.4,
                max_tokens: 2048,
            },
            api_key: Some("ant-key-999".to_owned()),
            token_budget: 6000,
            expected_generation: 1,
            prepared: None,
        },
        fx.ws.clone(),
        fx.db,
        ws_gen,
        active_runs,
        summary_tx,
        reqwest::Client::new(),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .expect("anthropic run succeeds");

    assert_eq!(spawned.len(), 1);
    let reqs = srv.captured.lock().expect("captured");
    assert_eq!(reqs[0].path, "/messages");
    assert_eq!(
        reqs[0].headers.get("x-api-key").map(String::as_str),
        Some("ant-key-999")
    );
    assert_eq!(
        reqs[0].headers.get("anthropic-version").map(String::as_str),
        Some("2023-06-01")
    );

    let ws_guard = fx.ws.read().expect("ws read");
    let engine = &ws_guard.as_ref().expect("active").engine;
    let lh = engine.nodes.get(&spawned[0]).expect("loophole");
    assert_eq!(lh.node_type, NodeType::Loophole);
    let out = engine.outgoing.get(&spawned[0]).expect("outgoing challenges");
    assert_eq!(out[0].target_id, "node_root");
    assert_eq!(out[0].edge_type, EdgeType::Challenges);
}

#[tokio::test]
async fn ollama_ndjson_feynman_places_probe_above_and_derives_from_focus() {
    let l1 = serde_json::json!({
        "message": { "content": "@@NODE type=probe edge=derives title=\"First Principles: WAL\"\n" },
        "done": false
    });
    let l2 = serde_json::json!({
        "message": { "content": "Sequential writes avoid random seeks.\n@@END\n" },
        "done": false
    });
    let l3 = serde_json::json!({
        "message": { "content": "" },
        "done": true
    });
    let ndjson = format!("{l1}\n{l2}\n{l3}\n");

    let srv = spawn_mock_server(move |_req| {
        MockResponseAction::Immediate {
            status_line: "200 OK",
            content_type: "application/x-ndjson",
            body: ndjson.clone(),
        }
    });

    let focus = make_focus_node("node_root", "WAL", "Append log", 100.0, 300.0);
    let fx = setup_workspace(vec![focus]);
    let active_runs = Arc::new(Mutex::new(HashMap::new()));
    let (summary_tx, _rx) = mpsc::unbounded_channel();

    let ws_gen = Arc::new(AtomicU64::new(1));
    let spawned = execute_lens_run(
        LensRunParams {
            run_id: "run_feynman".to_owned(),
            lens: LensKind::Feynman,
            focus_ids: vec!["node_root".to_owned()],
            custom_prompt: None,
            in_place: false,
            custom_lens: None,
            config: ModelTierConfig {
                provider: ProviderKind::Ollama,
                base_url: srv.base_url,
                model: "qwen2.5:14b".to_owned(),
                has_api_key: false,
                temperature: 0.4,
                max_tokens: 2048,
            },
            api_key: None,
            token_budget: 6000,
            expected_generation: 1,
            prepared: None,
        },
        fx.ws.clone(),
        fx.db,
        ws_gen,
        active_runs,
        summary_tx,
        reqwest::Client::new(),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .expect("ollama run succeeds");

    assert_eq!(spawned.len(), 1);
    let reqs = srv.captured.lock().expect("captured");
    assert_eq!(reqs[0].path, "/api/chat");

    let ws_guard = fx.ws.read().expect("ws read");
    let engine = &ws_guard.as_ref().expect("active").engine;
    let probe = engine.nodes.get(&spawned[0]).expect("probe");
    let anchor = engine.nodes.get("node_root").expect("root");
    assert_eq!(probe.node_type, NodeType::Probe);
    assert!(probe.layout.y < anchor.layout.y, "probe must spawn above anchor");
    let in_edges = engine.incoming.get(&spawned[0]).expect("derives edge");
    assert_eq!(in_edges[0].source_id, "node_root");
    assert_eq!(in_edges[0].edge_type, EdgeType::Derives);
}

#[tokio::test]
async fn mid_stream_cancellation_persists_partial_text_and_emits_cancelled() {
    let c1 = format!(
        "data: {}\n\n",
        serde_json::json!({
            "choices": [{
                "delta": { "content": "@@NODE type=branch edge=branches title=\"Partial\"\nPartial body saved" }
            }]
        })
    );
    let c2 = format!(
        "data: {}\n\n",
        serde_json::json!({
            "choices": [{
                "delta": { "content": " should never arrive\n@@END\n" }
            }]
        })
    );

    let srv = spawn_mock_server(move |_req| {
        MockResponseAction::ChunkedPause {
            first_chunk: c1.clone(),
            pause: Duration::from_secs(3),
            second_chunk: c2.clone(),
        }
    });

    let focus = make_focus_node("node_root", "Root", "Design", 0.0, 0.0);
    let fx = setup_workspace(vec![focus]);
    let active_runs = Arc::new(Mutex::new(HashMap::new()));
    let (summary_tx, _rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let cancel_trigger = cancel.clone();
    let events = Arc::new(Mutex::new(Vec::new()));
    let events_ref = events.clone();

    let ws_gen = Arc::new(AtomicU64::new(1));
    let spawned = execute_lens_run(
        LensRunParams {
            run_id: "run_cancel".to_owned(),
            lens: LensKind::Diverge,
            focus_ids: vec!["node_root".to_owned()],
            custom_prompt: None,
            in_place: false,
            custom_lens: None,
            config: ModelTierConfig {
                provider: ProviderKind::OpenaiCompat,
                base_url: srv.base_url,
                model: "gpt-4o".to_owned(),
                has_api_key: false,
                temperature: 0.4,
                max_tokens: 2048,
            },
            api_key: None,
            token_budget: 6000,
            expected_generation: 1,
            prepared: None,
        },
        fx.ws.clone(),
        fx.db,
        ws_gen,
        active_runs,
        summary_tx,
        reqwest::Client::new(),
        cancel,
        move |evt| {
            if matches!(evt, LensStreamEvent::TokenDelta { .. }) {
                cancel_trigger.cancel();
            }
            if let Ok(mut list) = events_ref.lock() {
                list.push(evt);
            }
        },
    )
    .await
    .expect("cancelled run returns Ok");

    assert_eq!(spawned.len(), 1);
    let ws_guard = fx.ws.read().expect("ws read");
    let node = ws_guard
        .as_ref()
        .expect("active")
        .engine
        .nodes
        .get(&spawned[0])
        .expect("partial node persisted");
    assert_eq!(node.status, NodeStatus::Active);
    assert!(node.content.contains("Partial body saved"));
    assert!(!node.content.contains("should never arrive"));

    let evts = events.lock().expect("events");
    assert!(evts
        .iter()
        .any(|e| matches!(e, LensStreamEvent::NodeFinalized { .. })));
    assert!(evts.iter().any(|e| matches!(
        e,
        LensStreamEvent::RunCompleted {
            cancelled: true,
            ..
        }
    )));
}

#[tokio::test]
async fn http_error_status_maps_to_structured_ipc_errors() {
    let srv = spawn_mock_server(|req| {
        if req.body.contains("case_401") {
            MockResponseAction::Immediate {
                status_line: "401 Unauthorized",
                content_type: "application/json",
                body: "{\"error\":\"bad key\"}".to_owned(),
            }
        } else if req.body.contains("case_503") {
            MockResponseAction::Immediate {
                status_line: "503 Service Unavailable",
                content_type: "text/plain",
                body: "overloaded".to_owned(),
            }
        } else {
            MockResponseAction::Immediate {
                status_line: "400 Bad Request",
                content_type: "text/plain",
                body: "invalid model".to_owned(),
            }
        }
    });

    let client = reqwest::Client::new();
    let cfg = ModelTierConfig {
        provider: ProviderKind::OpenaiCompat,
        base_url: srv.base_url,
        model: "gpt-4o".to_owned(),
        has_api_key: false,
        temperature: 0.4,
        max_tokens: 64,
    };

    for (marker, expected) in [
        ("case_401", IpcErrorCode::ProviderAuth),
        ("case_503", IpcErrorCode::ProviderNetwork),
        ("case_400", IpcErrorCode::ValidationError),
    ] {
        let err = stream_completion(
            &client,
            LlmStreamRequest {
                system_prompt: "sys".to_owned(),
                user_prompt: marker.to_owned(),
                config: cfg.clone(),
                api_key: None,
            },
            CancellationToken::new(),
            |_| Ok(()),
        )
        .await
        .expect_err("expected HTTP error");
        assert_eq!(err.code, expected);
    }
}

#[tokio::test]
async fn summarizer_fast_path_llm_path_and_stale_hash_abort() {
    let dir = tempfile::tempdir().expect("temp dir");
    let settings = Arc::new(SettingsStore::with_config_path(
        dir.path().join("settings.json"),
        false,
    ));

    let srv = spawn_mock_server(|_req| {
        let line = serde_json::json!({
            "choices": [{ "delta": { "content": "Compressed 2-sentence summary." } }]
        });
        MockResponseAction::Immediate {
            status_line: "200 OK",
            content_type: "text/event-stream",
            body: format!("data: {line}\n\ndata: [DONE]\n\n"),
        }
    });

    settings
        .save(SaveSettingsInput {
            reasoning: ModelTierConfig {
                provider: ProviderKind::OpenaiCompat,
                base_url: srv.base_url.clone(),
                model: "gpt-4o".to_owned(),
                has_api_key: false,
                temperature: 0.4,
                max_tokens: 2048,
            },
            reasoning_api_key: None,
            utility: ModelTierConfig {
                provider: ProviderKind::OpenaiCompat,
                base_url: srv.base_url,
                model: "gpt-4o-mini".to_owned(),
                has_api_key: false,
                temperature: 0.2,
                max_tokens: 256,
            },
            utility_api_key: None,
            default_token_budget: 6000,
            auto_summarize: true,
            theme: "dark".to_owned(),
            custom_lenses: Vec::new(),
        })
        .expect("save settings");

    let short_node = make_focus_node("n_short", "Short", "Concise invariant under 160 chars.", 0.0, 0.0);
    let long_body = "Detailed distributed consensus specification. ".repeat(8);
    let long_node = make_focus_node("n_long", "Long", &long_body, 400.0, 0.0);
    let fx = setup_workspace(vec![short_node, long_node]);

    let (summary_tx, summary_rx) = mpsc::unbounded_channel();
    let (evt_tx, mut evt_rx) = mpsc::unbounded_channel::<SummaryUpdatedEvent>();
    let ws_gen = Arc::new(AtomicU64::new(1));
    let worker = spawn_summarizer_worker(
        summary_rx,
        fx.ws.clone(),
        fx.db.clone(),
        ws_gen,
        reqwest::Client::new(),
        settings,
        Duration::from_millis(60),
        move |evt| {
            let _ = evt_tx.send(evt);
        },
    );

    // 1. Fast path <= 160 chars -> 0 HTTP hits
    summary_tx.send("n_short".to_owned()).expect("send short");
    let evt_short = tokio::time::timeout(Duration::from_secs(2), evt_rx.recv())
        .await
        .expect("wait short evt")
        .expect("short evt");
    assert_eq!(evt_short.node_id, "n_short");
    assert_eq!(evt_short.summary, "Concise invariant under 160 chars.");
    assert_eq!(srv.hit_count.load(Ordering::SeqCst), 0);

    // 2. LLM path > 160 chars -> 1 HTTP hit
    summary_tx.send("n_long".to_owned()).expect("send long");
    let evt_long = tokio::time::timeout(Duration::from_secs(2), evt_rx.recv())
        .await
        .expect("wait long evt")
        .expect("long evt");
    assert_eq!(evt_long.node_id, "n_long");
    assert_eq!(evt_long.summary, "Compressed 2-sentence summary.");
    assert_eq!(srv.hit_count.load(Ordering::SeqCst), 1);

    // 3. Stale content_hash abort check
    {
        let mut ws_guard = fx.ws.write().expect("ws write");
        let mut db_guard = fx.db.lock().expect("db lock");
        let active = ws_guard.as_mut().expect("active");
        let conn = db_guard.as_mut().expect("conn");
        let updated = update_node_summary(
            conn,
            &mut active.engine,
            "n_long",
            "stale_mismatch_hash",
            "Should not overwrite",
            "stale_mismatch_hash",
        )
        .expect("update_node_summary");
        assert!(!updated);
    }

    drop(summary_tx);
    let _ = worker.await;
}

#[test]
fn settings_store_never_writes_api_keys_to_json() {
    let dir = tempfile::tempdir().expect("temp dir");
    let cfg_path = dir.path().join("settings.json");
    let store = SettingsStore::with_config_path(cfg_path.clone(), false);

    let saved = store
        .save(SaveSettingsInput {
            reasoning: ModelTierConfig {
                provider: ProviderKind::Anthropic,
                base_url: "https://api.anthropic.com/v1".to_owned(),
                model: "claude-sonnet-4-20250514".to_owned(),
                has_api_key: false,
                temperature: 0.4,
                max_tokens: 2048,
            },
            reasoning_api_key: Some("sk-ant-super-secret-value".to_owned()),
            utility: ModelTierConfig {
                provider: ProviderKind::Ollama,
                base_url: "http://127.0.0.1:11434".to_owned(),
                model: "qwen2.5:14b".to_owned(),
                has_api_key: false,
                temperature: 0.2,
                max_tokens: 256,
            },
            utility_api_key: Some("sk-util-super-secret-value".to_owned()),
            default_token_budget: 8000,
            auto_summarize: false,
            theme: "light".to_owned(),
            custom_lenses: Vec::new(),
        })
        .expect("save settings");

    assert_eq!(saved.default_token_budget, 8000);
    assert!(!saved.auto_summarize);
    assert_eq!(saved.theme, "light");

    let json_text = std::fs::read_to_string(&cfg_path).expect("read settings.json");
    assert!(!json_text.contains("sk-ant-super-secret-value"));
    assert!(!json_text.contains("sk-util-super-secret-value"));

    let reloaded = store.load_dto().expect("reload settings");
    assert_eq!(reloaded.reasoning.provider, ProviderKind::Anthropic);
    assert_eq!(reloaded.utility.provider, ProviderKind::Ollama);
    assert_eq!(reloaded.default_token_budget, 8000);
}

#[test]
fn spawn_summarizer_worker_works_outside_tokio_runtime() {
    let dir = tempfile::tempdir().expect("temp dir");
    let settings = Arc::new(SettingsStore::with_config_path(
        dir.path().join("settings.json"),
        false,
    ));
    let fx = setup_workspace(vec![make_focus_node(
        "n_sync",
        "Sync Test",
        "Short note under 160 chars.",
        0.0,
        0.0,
    )]);

    let (summary_tx, summary_rx) = mpsc::unbounded_channel();
    let (evt_tx, evt_rx) = std::sync::mpsc::channel::<SummaryUpdatedEvent>();
    let ws_gen = Arc::new(AtomicU64::new(1));
    let _worker = spawn_summarizer_worker(
        summary_rx,
        fx.ws.clone(),
        fx.db.clone(),
        ws_gen,
        reqwest::Client::new(),
        settings,
        Duration::from_millis(30),
        move |evt| {
            let _ = evt_tx.send(evt);
        },
    );

    summary_tx.send("n_sync".to_owned()).expect("send n_sync");
    let evt = evt_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("receive summary event outside tokio runtime");
    assert_eq!(evt.node_id, "n_sync");
    assert_eq!(evt.summary, "Short note under 160 chars.");
    drop(summary_tx);
}

#[test]
fn deepseek_anthropic_body_disables_thinking_for_non_reasoner_models() {
    let base_req = |base_url: &str, model: &str| LlmStreamRequest {
        system_prompt: "sys".to_owned(),
        user_prompt: "usr".to_owned(),
        config: ModelTierConfig {
            provider: ProviderKind::Anthropic,
            base_url: base_url.to_owned(),
            model: model.to_owned(),
            has_api_key: true,
            temperature: 0.4,
            max_tokens: 2048,
        },
        api_key: Some("k".to_owned()),
    };

    let ds_flash = build_anthropic_body(&base_req("https://api.deepseek.com/anthropic", "deepseek-flash"));
    assert_eq!(ds_flash["thinking"]["type"], "disabled");

    let ds_reasoner = build_anthropic_body(&base_req("https://api.deepseek.com/anthropic", "deepseek-reasoner"));
    assert!(ds_reasoner.get("thinking").is_none());

    let claude = build_anthropic_body(&base_req("https://api.anthropic.com/v1", "claude-3-7-sonnet"));
    assert!(claude.get("thinking").is_none());
}

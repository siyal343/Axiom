use std::collections::HashSet;

use rusqlite::{params, Connection, TransactionBehavior};

use crate::db::queries::{insert_edge_tx, insert_node_tx};
use crate::error::IpcError;
use crate::graph::models::{
    compute_content_hash, estimate_tokens, CameraState, ContextControls, CreatedBy, EdgeDto,
    EdgeType, EdgeWeight, NodeDto, NodeLayout, NodeLensOrigin, NodeMetadata, NodeStatus, NodeType,
    Severity, WorkspaceSnapshot,
};
use crate::graph::spatial::{DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH};
use crate::graph::GraphEngine;

const STRESS_NODE_COUNT: usize = 500;
const STRESS_EDGE_COUNT: usize = 700;
const STRESS_ROWS_PER_COL: usize = 20;
const STRESS_COL_STEP: f64 = 420.0;
const STRESS_ROW_STEP: f64 = 240.0;
const STRESS_BASE_TS_MS: i64 = 1_700_000_000_000;
const DEFAULT_TOKEN_BUDGET: u32 = 6000;

fn stress_node_id(idx: usize) -> String {
    format!("stress_node_{idx:03}")
}

fn stress_edge_id(idx: usize) -> String {
    format!("stress_edge_{idx:03}")
}

fn push_stress_edge(
    edges: &mut Vec<EdgeDto>,
    seen_triples: &mut HashSet<(usize, usize, EdgeType)>,
    src: usize,
    dst: usize,
    edge_type: EdgeType,
    weight: EdgeWeight,
) {
    if src == dst || src >= STRESS_NODE_COUNT || dst >= STRESS_NODE_COUNT {
        return;
    }
    if edges.len() >= STRESS_EDGE_COUNT {
        return;
    }
    if !seen_triples.insert((src, dst, edge_type)) {
        return;
    }
    let edge_idx = edges.len();
    edges.push(EdgeDto {
        id: stress_edge_id(edge_idx),
        source_id: stress_node_id(src),
        target_id: stress_node_id(dst),
        edge_type,
        weight,
        created_at: STRESS_BASE_TS_MS + (edge_idx as i64) * 1000,
    });
}

fn stress_node_type(idx: usize) -> NodeType {
    if idx == 0 || idx % 25 == 0 {
        NodeType::Core
    } else {
        match idx % 5 {
            1 => NodeType::Branch,
            2 => NodeType::Loophole,
            3 => NodeType::Probe,
            4 => NodeType::Synthesis,
            _ => {
                if idx % 2 == 0 {
                    NodeType::Branch
                } else {
                    NodeType::Probe
                }
            }
        }
    }
}

fn stress_node_status(idx: usize, node_type: NodeType) -> NodeStatus {
    match node_type {
        NodeType::Loophole => match idx % 6 {
            2 => NodeStatus::Active,
            4 => NodeStatus::Resolved,
            0 => NodeStatus::Dismissed,
            _ => NodeStatus::Active,
        },
        NodeType::Core => {
            if idx > 0 && idx % 50 == 0 {
                NodeStatus::Locked
            } else {
                NodeStatus::Active
            }
        }
        _ => {
            if idx % 17 == 0 {
                NodeStatus::Locked
            } else if idx % 13 == 0 {
                NodeStatus::Draft
            } else if idx % 15 == 0 {
                NodeStatus::Resolved
            } else {
                NodeStatus::Active
            }
        }
    }
}

fn stress_severity(idx: usize, node_type: NodeType) -> Option<Severity> {
    if node_type != NodeType::Loophole {
        return None;
    }
    Some(match idx % 4 {
        0 => Severity::Low,
        1 => Severity::Medium,
        2 => Severity::High,
        _ => Severity::Critical,
    })
}

fn stress_lens_origin(idx: usize, node_type: NodeType) -> NodeLensOrigin {
    match node_type {
        NodeType::Core => NodeLensOrigin::Manual,
        NodeType::Branch => {
            if idx % 2 == 0 {
                NodeLensOrigin::Diverge
            } else {
                NodeLensOrigin::Manual
            }
        }
        NodeType::Loophole => {
            if idx % 2 == 0 {
                NodeLensOrigin::RedTeam
            } else {
                NodeLensOrigin::EdgeCase
            }
        }
        NodeType::Probe => NodeLensOrigin::Feynman,
        NodeType::Synthesis => NodeLensOrigin::Synthesize,
    }
}

fn stress_code_snippet(idx: usize) -> &'static str {
    match idx % 3 {
        0 => {
            "```rust\npub fn check_quorum(acks: usize, replicas: usize) -> bool {\n    acks * 2 > replicas\n}\n```"
        }
        1 => {
            "```typescript\nexport function boundedRetry(attempt: number, capMs = 8000): number {\n  return Math.min(capMs, 100 * Math.pow(2, attempt));\n}\n```"
        }
        _ => {
            "```sql\nSELECT id, title FROM nodes_fts WHERE nodes_fts MATCH 'title:consensus' LIMIT 20;\n```"
        }
    }
}

fn stress_topic(idx: usize) -> &'static str {
    const TOPICS: [&str; 8] = [
        "Consensus Quorum",
        "WAL Backpressure",
        "Sharded Ring",
        "Latency Tail",
        "Snapshot Isolation",
        "Idempotency Key",
        "Circuit Breaker",
        "Spatial R-Tree",
    ];
    TOPICS[idx % TOPICS.len()]
}

pub fn generate_stress_graph_500() -> (Vec<NodeDto>, Vec<EdgeDto>) {
    let mut nodes = Vec::with_capacity(STRESS_NODE_COUNT);

    for idx in 0..STRESS_NODE_COUNT {
        let node_type = stress_node_type(idx);
        let status = stress_node_status(idx, node_type);
        let severity = stress_severity(idx, node_type);
        let lens = stress_lens_origin(idx, node_type);
        let created_by = if idx % 3 == 0 {
            CreatedBy::User
        } else {
            CreatedBy::Ai
        };

        let col = idx / STRESS_ROWS_PER_COL;
        let row = idx % STRESS_ROWS_PER_COL;
        let x = (col as f64) * STRESS_COL_STEP;
        let y = (row as f64) * STRESS_ROW_STEP;
        let collapsed = idx > 0 && idx % 11 == 0;

        let pin_global = idx == 0 || idx == 25 || idx == 50;
        let exclude_from_ai = idx > 0 && idx % 19 == 0;

        let topic = stress_topic(idx);
        let title = if idx == 0 {
            "Core Stress Root: Distributed Axiom Architecture".to_owned()
        } else {
            format!("{topic} #{idx:03}")
        };

        let content = format!(
            "Track {col} node {idx} analyzing **{topic}** under load budget $B = 6000$ tokens and $O(N \\log N)$ culling.\n\n\
             $$\\text{{Latency}}_{{p95}} \\le \\frac{{\\text{{Budget}}_{{{col}}}}}{{\\alpha + {row} + 1}}$$\n\n\
             {}",
            stress_code_snippet(idx)
        );
        let summary = format!("Summary for node {idx:03}: {topic} invariant and bounded cost.");
        let content_hash = compute_content_hash(&title, &content);
        let summary_hash = content_hash.clone();
        let token_count = estimate_tokens(&content);
        let ts = STRESS_BASE_TS_MS + (idx as i64) * 1000;

        nodes.push(NodeDto {
            id: stress_node_id(idx),
            node_type,
            status,
            title,
            content,
            summary,
            content_hash,
            summary_hash,
            metadata: NodeMetadata {
                severity,
                lens,
                created_by,
                model: if created_by == CreatedBy::Ai {
                    Some("stress-synth-v1".to_owned())
                } else {
                    None
                },
                token_count,
            },
            context_controls: ContextControls {
                pin_global,
                exclude_from_ai,
            },
            layout: NodeLayout {
                x,
                y,
                width: DEFAULT_NODE_WIDTH,
                height: DEFAULT_NODE_HEIGHT,
                collapsed,
            },
            created_at: ts,
            updated_at: ts,
        });
    }

    let mut edges = Vec::with_capacity(STRESS_EDGE_COUNT);
    let mut seen_triples: HashSet<(usize, usize, EdgeType)> =
        HashSet::with_capacity(STRESS_EDGE_COUNT);

    // 1. Primary 499-edge DAG backbone covering nodes 1..499.
    for (idx, node) in nodes.iter().enumerate().skip(1) {
        let parent = if idx < STRESS_ROWS_PER_COL {
            0
        } else {
            idx - STRESS_ROWS_PER_COL
        };
        let edge_type = match node.node_type {
            NodeType::Loophole => EdgeType::Challenges,
            NodeType::Synthesis => EdgeType::Synthesizes,
            _ if idx % 3 == 0 => EdgeType::Branches,
            _ => EdgeType::Derives,
        };
        let weight = if idx % 4 == 0 {
            EdgeWeight::Summary
        } else {
            EdgeWeight::Full
        };
        push_stress_edge(&mut edges, &mut seen_triples, parent, idx, edge_type, weight);
    }

    // 2. Diamond multi-parent merges into Synthesis nodes.
    for (idx, node) in nodes.iter().enumerate().skip(STRESS_ROWS_PER_COL) {
        if edges.len() >= STRESS_EDGE_COUNT {
            break;
        }
        if node.node_type == NodeType::Synthesis {
            let col = idx / STRESS_ROWS_PER_COL;
            let row = idx % STRESS_ROWS_PER_COL;
            let alt_parent = (col - 1) * STRESS_ROWS_PER_COL + ((row + 1) % STRESS_ROWS_PER_COL);
            push_stress_edge(
                &mut edges,
                &mut seen_triples,
                alt_parent,
                idx,
                EdgeType::Synthesizes,
                EdgeWeight::Summary,
            );
        }
    }

    // 3. Resolution edges targeting Loopholes.
    for (idx, node) in nodes.iter().enumerate().skip(5) {
        if edges.len() >= STRESS_EDGE_COUNT {
            break;
        }
        if node.node_type == NodeType::Loophole {
            let resolver = (idx + 1) % STRESS_NODE_COUNT;
            push_stress_edge(
                &mut edges,
                &mut seen_triples,
                resolver,
                idx,
                EdgeType::Resolves,
                EdgeWeight::Summary,
            );
        }
    }

    // 4. Deterministic cross-track Reference edges to reach exact 700 edges.
    let mut cursor = 0usize;
    while edges.len() < STRESS_EDGE_COUNT && cursor < STRESS_NODE_COUNT * 4 {
        let src = cursor % STRESS_NODE_COUNT;
        let stride = 23 + (cursor / STRESS_NODE_COUNT) * 7;
        let dst = (src + stride) % STRESS_NODE_COUNT;
        push_stress_edge(
            &mut edges,
            &mut seen_triples,
            src,
            dst,
            EdgeType::References,
            EdgeWeight::Summary,
        );
        cursor += 1;
    }

    (nodes, edges)
}

pub fn seed_stress_500_into_workspace(
    conn: &mut Connection,
    engine: &mut GraphEngine,
    path: &str,
) -> Result<WorkspaceSnapshot, IpcError> {
    let (nodes, edges) = generate_stress_graph_500();
    let root_id = nodes
        .first()
        .map(|n| n.id.clone())
        .unwrap_or_else(|| stress_node_id(0));

    let camera = CameraState {
        x: 120.0,
        y: 80.0,
        zoom: 1.0,
        last_focus_id: Some(root_id.clone()),
    };

    let token_budget: u32 = conn
        .query_row(
            "SELECT value FROM workspace_meta WHERE key = 'token_budget'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(DEFAULT_TOKEN_BUDGET);

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("DELETE FROM edges", [])?;
    tx.execute("DELETE FROM nodes", [])?;

    for node in &nodes {
        insert_node_tx(&tx, node)?;
    }
    for edge in &edges {
        insert_edge_tx(&tx, edge)?;
    }

    let meta_pairs = [
        ("camera_x", camera.x.to_string()),
        ("camera_y", camera.y.to_string()),
        ("camera_zoom", camera.zoom.to_string()),
        ("last_focus_id", root_id),
        ("token_budget", token_budget.to_string()),
    ];
    for (key, value) in meta_pairs {
        tx.execute(
            "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }
    tx.commit()?;

    *engine = GraphEngine::from_snapshot(&nodes, &edges);

    Ok(WorkspaceSnapshot {
        path: path.to_owned(),
        nodes,
        edges,
        camera,
        token_budget,
    })
}

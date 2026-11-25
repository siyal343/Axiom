use std::cmp::Reverse;
use std::collections::{BTreeSet, HashMap};

use rusqlite::Connection;

use crate::error::IpcError;
use crate::graph::models::{
    CycleDiagnostic, DiagnosticItem, EdgeType, GraphDiagnostics, NodeStatus, NodeType, Severity,
    StaleReason,
};
use crate::graph::provenance::compute_stale_nodes;
use crate::graph::GraphEngine;

const HEAVY_UNSUMMARIZED_THRESHOLD: u32 = 250;

fn severity_rank(sev: Option<Severity>) -> u8 {
    match sev {
        Some(Severity::Critical) => 4,
        Some(Severity::High) => 3,
        Some(Severity::Medium) => 2,
        Some(Severity::Low) => 1,
        None => 0,
    }
}

fn is_spine_cycle_edge(edge_type: EdgeType) -> bool {
    matches!(
        edge_type,
        EdgeType::Derives | EdgeType::Branches | EdgeType::Synthesizes
    )
}

fn find_spine_sccs(engine: &GraphEngine) -> Vec<Vec<String>> {
    let mut node_ids: Vec<String> = engine.nodes.keys().cloned().collect();
    node_ids.sort();

    let id_to_idx: HashMap<&str, usize> = node_ids
        .iter()
        .enumerate()
        .map(|(idx, id)| (id.as_str(), idx))
        .collect();

    let mut adj: Vec<Vec<usize>> = Vec::with_capacity(node_ids.len());
    for id in &node_ids {
        let mut neighbors = BTreeSet::new();
        if let Some(out_edges) = engine.outgoing.get(id) {
            for edge in out_edges {
                if is_spine_cycle_edge(edge.edge_type) {
                    if let Some(&target_idx) = id_to_idx.get(edge.target_id.as_str()) {
                        neighbors.insert(target_idx);
                    }
                }
            }
        }
        adj.push(neighbors.into_iter().collect());
    }

    // Iterative Tarjan's SCC so deep graphs never overflow the call stack.
    let n = node_ids.len();
    let mut index_counter: usize = 0;
    let mut indices: Vec<Option<usize>> = vec![None; n];
    let mut lowlink: Vec<usize> = vec![0; n];
    let mut on_stack: Vec<bool> = vec![false; n];
    let mut tarjan_stack: Vec<usize> = Vec::new();
    let mut call_stack: Vec<(usize, usize)> = Vec::new();
    let mut sccs: Vec<Vec<String>> = Vec::new();

    for start in 0..n {
        if indices[start].is_some() {
            continue;
        }
        indices[start] = Some(index_counter);
        lowlink[start] = index_counter;
        index_counter += 1;
        tarjan_stack.push(start);
        on_stack[start] = true;
        call_stack.push((start, 0));

        while let Some((v, next_edge)) = call_stack.last_mut() {
            let v_idx = *v;
            if *next_edge < adj[v_idx].len() {
                let w = adj[v_idx][*next_edge];
                *next_edge += 1;
                if indices[w].is_none() {
                    indices[w] = Some(index_counter);
                    lowlink[w] = index_counter;
                    index_counter += 1;
                    tarjan_stack.push(w);
                    on_stack[w] = true;
                    call_stack.push((w, 0));
                } else if on_stack[w] {
                    if let Some(w_idx) = indices[w] {
                        lowlink[v_idx] = lowlink[v_idx].min(w_idx);
                    }
                }
            } else {
                call_stack.pop();
                if let Some(&(parent, _)) = call_stack.last() {
                    lowlink[parent] = lowlink[parent].min(lowlink[v_idx]);
                }
                if indices[v_idx] == Some(lowlink[v_idx]) {
                    let mut component = Vec::new();
                    while let Some(w) = tarjan_stack.pop() {
                        on_stack[w] = false;
                        component.push(node_ids[w].clone());
                        if w == v_idx {
                            break;
                        }
                    }
                    if component.len() >= 2 {
                        component.sort();
                        sccs.push(component);
                    }
                }
            }
        }
    }

    sccs.sort_by(|a, b| a.first().cmp(&b.first()));
    sccs
}

pub fn compute_graph_diagnostics(
    conn: &Connection,
    engine: &GraphEngine,
) -> Result<GraphDiagnostics, IpcError> {
    let node_count = engine.nodes.len();
    let edge_count: usize = engine.outgoing.values().map(Vec::len).sum();
    let mut total_tokens: u32 = 0;
    let mut pin_count: usize = 0;
    let mut excluded_count: usize = 0;

    let mut unresolved_loopholes: Vec<DiagnosticItem> = Vec::new();
    let mut orphan_nodes: Vec<DiagnosticItem> = Vec::new();
    let mut unsummarized_heavy_nodes: Vec<DiagnosticItem> = Vec::new();

    for node in engine.nodes.values() {
        total_tokens = total_tokens.saturating_add(node.metadata.token_count);
        if node.context_controls.pin_global {
            pin_count += 1;
        }
        if node.context_controls.exclude_from_ai {
            excluded_count += 1;
        }

        if node.node_type == NodeType::Loophole && node.status == NodeStatus::Active {
            let mut challenged_titles: Vec<String> = engine
                .outgoing
                .get(&node.id)
                .into_iter()
                .flatten()
                .filter(|edge| edge.edge_type == EdgeType::Challenges)
                .filter_map(|edge| engine.nodes.get(&edge.target_id))
                .map(|target| target.title.clone())
                .collect();
            challenged_titles.sort();
            challenged_titles.dedup();
            let detail = if challenged_titles.is_empty() {
                "Unattached active loophole".to_owned()
            } else {
                format!("Challenges: {}", challenged_titles.join(", "))
            };
            unresolved_loopholes.push(DiagnosticItem {
                node_id: node.id.clone(),
                title: node.title.clone(),
                node_type: node.node_type,
                severity: node.metadata.severity,
                detail,
                token_count: node.metadata.token_count,
            });
        }

        if node_count > 1 {
            let has_in = engine
                .incoming
                .get(&node.id)
                .is_some_and(|edges| !edges.is_empty());
            let has_out = engine
                .outgoing
                .get(&node.id)
                .is_some_and(|edges| !edges.is_empty());
            if !has_in && !has_out {
                orphan_nodes.push(DiagnosticItem {
                    node_id: node.id.clone(),
                    title: node.title.clone(),
                    node_type: node.node_type,
                    severity: node.metadata.severity,
                    detail: "No incoming or outgoing edges".to_owned(),
                    token_count: node.metadata.token_count,
                });
            }
        }

        if !node.context_controls.exclude_from_ai
            && node.status != NodeStatus::Draft
            && node.metadata.token_count >= HEAVY_UNSUMMARIZED_THRESHOLD
            && node.summary.trim().is_empty()
        {
            unsummarized_heavy_nodes.push(DiagnosticItem {
                node_id: node.id.clone(),
                title: node.title.clone(),
                node_type: node.node_type,
                severity: node.metadata.severity,
                detail: format!("{} tokens with empty summary", node.metadata.token_count),
                token_count: node.metadata.token_count,
            });
        }
    }

    unresolved_loopholes.sort_by(|a, b| {
        severity_rank(b.severity)
            .cmp(&severity_rank(a.severity))
            .then_with(|| a.node_id.cmp(&b.node_id))
    });
    orphan_nodes.sort_by(|a, b| a.node_id.cmp(&b.node_id));
    unsummarized_heavy_nodes.sort_by_key(|item| (Reverse(item.token_count), item.node_id.clone()));

    let stale_infos = compute_stale_nodes(conn, engine)?;
    let stale_ai_nodes: Vec<DiagnosticItem> = stale_infos
        .into_iter()
        .filter_map(|info| {
            let node = engine.nodes.get(&info.node_id)?;
            let changes: Vec<String> = info
                .changed_inputs
                .iter()
                .map(|c| {
                    let kind = match c.reason {
                        StaleReason::Modified => "modified",
                        StaleReason::Deleted => "deleted",
                    };
                    format!("{} ({kind})", c.title)
                })
                .collect();
            Some(DiagnosticItem {
                node_id: node.id.clone(),
                title: node.title.clone(),
                node_type: node.node_type,
                severity: node.metadata.severity,
                detail: format!("Upstream changed: {}", changes.join(", ")),
                token_count: node.metadata.token_count,
            })
        })
        .collect();

    let cycles: Vec<CycleDiagnostic> = find_spine_sccs(engine)
        .into_iter()
        .map(|node_ids| {
            let titles = node_ids
                .iter()
                .map(|id| {
                    engine
                        .nodes
                        .get(id)
                        .map_or_else(|| id.clone(), |n| n.title.clone())
                })
                .collect();
            CycleDiagnostic { node_ids, titles }
        })
        .collect();

    let mut loophole_penalty: i32 = 0;
    for item in &unresolved_loopholes {
        let p = match item.severity {
            Some(Severity::Critical) => 15,
            Some(Severity::High) => 10,
            Some(Severity::Medium) | None => 5,
            Some(Severity::Low) => 2,
        };
        loophole_penalty += p;
    }
    loophole_penalty = loophole_penalty.min(50);

    let stale_penalty = ((stale_ai_nodes.len() as i32) * 6).min(24);
    let cycle_penalty = ((cycles.len() as i32) * 12).min(36);
    let orphan_penalty = ((orphan_nodes.len() as i32) * 3).min(15);
    let heavy_penalty = ((unsummarized_heavy_nodes.len() as i32) * 2).min(12);

    let total_penalty =
        loophole_penalty + stale_penalty + cycle_penalty + orphan_penalty + heavy_penalty;
    let health_score = (100 - total_penalty).clamp(0, 100) as u8;

    Ok(GraphDiagnostics {
        health_score,
        node_count,
        edge_count,
        total_tokens,
        pin_count,
        excluded_count,
        unresolved_loopholes,
        stale_ai_nodes,
        cycles,
        orphan_nodes,
        unsummarized_heavy_nodes,
    })
}

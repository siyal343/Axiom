use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};

use crate::graph::models::{
    estimate_tokens, CompiledXray, EdgeType, EdgeWeight, InclusionMode, NodeDto, NodeStatus,
    ProvenanceInput, Severity,
};
use crate::graph::GraphEngine;

#[derive(Debug, Clone)]
pub struct CompiledContext {
    pub prompt_text: String,
    pub xray: CompiledXray,
    pub provenance_inputs: Vec<ProvenanceInput>,
}

pub(crate) fn is_ancestor_edge(t: EdgeType) -> bool {
    matches!(t, EdgeType::Derives | EdgeType::Branches | EdgeType::Synthesizes)
}

pub fn compile_context(
    engine: &GraphEngine,
    focus_ids: &[String],
    token_budget: u32,
) -> CompiledContext {
    let mut node_modes: HashMap<String, InclusionMode> = HashMap::new();
    let mut active_edges: HashSet<String> = HashSet::new();
    let focus_set: HashSet<&str> = focus_ids.iter().map(String::as_str).collect();

    // -------------------------------------------------------------------------
    // STEP 1: Collect Global Pins (sorted by id ASC for deterministic prompt order)
    // -------------------------------------------------------------------------
    let mut global_pins: Vec<&NodeDto> = engine
        .nodes
        .values()
        .filter(|n| {
            n.context_controls.pin_global
                && !n.context_controls.exclude_from_ai
                && !focus_set.contains(n.id.as_str())
        })
        .collect();
    global_pins.sort_by(|a, b| a.id.cmp(&b.id));
    for pin in &global_pins {
        node_modes.insert(pin.id.clone(), InclusionMode::Pin);
    }

    // -------------------------------------------------------------------------
    // STEP 2: Backward BFS on Ancestor Edges (Shortest hop distance per node)
    // Walks THROUGH exclude_from_ai nodes so muting a scratchpad node never
    // severs lineage to upstream specs.
    // -------------------------------------------------------------------------
    let mut depth_map: HashMap<String, u32> = HashMap::new();
    let mut queue: VecDeque<(String, u32)> = VecDeque::new();

    for fid in focus_ids {
        if engine.nodes.contains_key(fid) && !depth_map.contains_key(fid) {
            depth_map.insert(fid.clone(), 0);
            queue.push_back((fid.clone(), 0));
        }
    }

    while let Some((curr_id, depth)) = queue.pop_front() {
        if let Some(in_edges) = engine.incoming.get(&curr_id) {
            for edge in in_edges {
                if !is_ancestor_edge(edge.edge_type) {
                    continue;
                }
                active_edges.insert(edge.id.clone());
                let next_depth = depth + 1;
                let should_visit = match depth_map.get(&edge.source_id) {
                    Some(&existing) => next_depth < existing,
                    None => true,
                };
                if should_visit {
                    depth_map.insert(edge.source_id.clone(), next_depth);
                    queue.push_back((edge.source_id.clone(), next_depth));
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // STEP 3: Cycle-Safe Topological Sort of Ancestor Subgraph (Kahn's Algorithm)
    // Deduplicates diamond DAGs and guarantees root-to-focus ordering.
    // -------------------------------------------------------------------------
    let ancestor_id_set: HashSet<String> = depth_map
        .keys()
        .filter(|id| !focus_set.contains(id.as_str()))
        .cloned()
        .collect();

    let topo_ids = kahn_topo_sort_cycle_safe(engine, &ancestor_id_set, &depth_map);

    let topo_ancestors: Vec<&NodeDto> = topo_ids
        .iter()
        .filter_map(|id| engine.nodes.get(id))
        .filter(|n| !n.context_controls.exclude_from_ai && !n.context_controls.pin_global)
        .collect();

    // -------------------------------------------------------------------------
    // STEP 4: Harvest Active Loopholes (`challenges` incoming to focus or ancestors)
    // -------------------------------------------------------------------------
    let mut relevant_targets: Vec<String> = focus_ids.to_vec();
    for anc in &topo_ancestors {
        relevant_targets.push(anc.id.clone());
    }
    for pin in &global_pins {
        relevant_targets.push(pin.id.clone());
    }

    let mut loophole_targets: HashMap<String, Vec<String>> = HashMap::new();
    for target_id in &relevant_targets {
        if let Some(in_edges) = engine.incoming.get(target_id) {
            for edge in in_edges {
                if edge.edge_type != EdgeType::Challenges {
                    continue;
                }
                if let Some(src) = engine.nodes.get(&edge.source_id) {
                    if src.status == NodeStatus::Active && !src.context_controls.exclude_from_ai {
                        active_edges.insert(edge.id.clone());
                        if let Some(target_node) = engine.nodes.get(target_id) {
                            loophole_targets
                                .entry(src.id.clone())
                                .or_default()
                                .push(target_node.title.clone());
                        }
                    }
                }
            }
        }
    }

    let mut active_loopholes: Vec<(&NodeDto, Vec<String>)> = loophole_targets
        .into_iter()
        .filter_map(|(id, mut targets)| {
            targets.sort();
            targets.dedup();
            engine.nodes.get(&id).map(|n| (n, targets))
        })
        .collect();
    active_loopholes.sort_by(|(a, _), (b, _)| {
        severity_rank(b.metadata.severity)
            .cmp(&severity_rank(a.metadata.severity))
            .then_with(|| a.id.cmp(&b.id))
    });

    // -------------------------------------------------------------------------
    // STEP 5: Harvest One-Hop References (`references` outgoing from focus nodes)
    // -------------------------------------------------------------------------
    let mut seen_refs: HashSet<&str> = relevant_targets.iter().map(String::as_str).collect();
    for p in &global_pins {
        seen_refs.insert(p.id.as_str());
    }
    for (lh, _) in &active_loopholes {
        seen_refs.insert(lh.id.as_str());
    }

    let mut references: Vec<(&NodeDto, EdgeWeight)> = Vec::new();
    for fid in focus_ids {
        if let Some(out_edges) = engine.outgoing.get(fid) {
            for edge in out_edges {
                if edge.edge_type != EdgeType::References {
                    continue;
                }
                if let Some(ref_node) = engine.nodes.get(&edge.target_id) {
                    if !ref_node.context_controls.exclude_from_ai
                        && !seen_refs.contains(ref_node.id.as_str())
                    {
                        seen_refs.insert(ref_node.id.as_str());
                        active_edges.insert(edge.id.clone());
                        references.push((ref_node, edge.weight));
                    }
                }
            }
        }
    }
    references.sort_by(|(a, _), (b, _)| a.id.cmp(&b.id));

    // -------------------------------------------------------------------------
    // STEP 6: Distance-Decay Token Budgeting
    // -------------------------------------------------------------------------
    let mut used_tokens: u32 = 0;
    let mut anc_full_mode: HashMap<&str, bool> = HashMap::new();
    let mut mode_tokens: HashMap<InclusionMode, u32> = HashMap::new();

    for p in &global_pins {
        used_tokens = used_tokens.saturating_add(p.metadata.token_count);
        let entry = mode_tokens.entry(InclusionMode::Pin).or_insert(0);
        *entry = entry.saturating_add(p.metadata.token_count);
    }

    let mut seen_focus: HashSet<&str> = HashSet::new();
    let mut focus_nodes: Vec<&NodeDto> = Vec::new();
    for fid in focus_ids {
        if seen_focus.insert(fid.as_str()) {
            if let Some(node) = engine.nodes.get(fid) {
                focus_nodes.push(node);
            }
        }
    }
    for f in &focus_nodes {
        node_modes.insert(f.id.clone(), InclusionMode::Focus);
        used_tokens = used_tokens.saturating_add(f.metadata.token_count);
        let entry = mode_tokens.entry(InclusionMode::Focus).or_insert(0);
        *entry = entry.saturating_add(f.metadata.token_count);
    }

    let mut direct_parents: Vec<&NodeDto> = Vec::new();
    let mut older_ancestors: Vec<&NodeDto> = Vec::new();
    for anc in &topo_ancestors {
        let d = *depth_map.get(&anc.id).unwrap_or(&99);
        if d == 1 {
            direct_parents.push(anc);
            anc_full_mode.insert(anc.id.as_str(), true);
            node_modes.insert(anc.id.clone(), InclusionMode::Full);
            used_tokens = used_tokens.saturating_add(anc.metadata.token_count);
            let entry = mode_tokens.entry(InclusionMode::Full).or_insert(0);
            *entry = entry.saturating_add(anc.metadata.token_count);
        } else {
            older_ancestors.push(anc);
        }
    }

    for (lh, _) in &active_loopholes {
        node_modes.insert(lh.id.clone(), InclusionMode::Loophole);
        used_tokens = used_tokens.saturating_add(lh.metadata.token_count);
        let entry = mode_tokens.entry(InclusionMode::Loophole).or_insert(0);
        *entry = entry.saturating_add(lh.metadata.token_count);
    }

    let summary_cost = |n: &NodeDto| -> u32 {
        if !n.summary.is_empty() {
            estimate_tokens(&n.summary)
        } else {
            n.metadata.token_count
        }
    };
    for anc in &older_ancestors {
        anc_full_mode.insert(anc.id.as_str(), false);
        node_modes.insert(anc.id.clone(), InclusionMode::Summary);
        used_tokens = used_tokens.saturating_add(summary_cost(anc));
    }

    let mut by_proximity = older_ancestors.clone();
    by_proximity.sort_by(|a, b| {
        let da = *depth_map.get(&a.id).unwrap_or(&99);
        let db = *depth_map.get(&b.id).unwrap_or(&99);
        da.cmp(&db).then_with(|| a.id.cmp(&b.id))
    });

    for anc in by_proximity {
        let upgrade_delta = anc.metadata.token_count.saturating_sub(summary_cost(anc));
        if used_tokens.saturating_add(upgrade_delta) <= token_budget {
            anc_full_mode.insert(anc.id.as_str(), true);
            node_modes.insert(anc.id.clone(), InclusionMode::Full);
            used_tokens = used_tokens.saturating_add(upgrade_delta);
        }
    }

    for anc in &older_ancestors {
        let base_cost = summary_cost(anc);
        if *anc_full_mode.get(anc.id.as_str()).unwrap_or(&false) {
            let final_cost = base_cost.max(anc.metadata.token_count);
            let entry = mode_tokens.entry(InclusionMode::Full).or_insert(0);
            *entry = entry.saturating_add(final_cost);
        } else {
            let entry = mode_tokens.entry(InclusionMode::Summary).or_insert(0);
            *entry = entry.saturating_add(base_cost);
        }
    }

    for (ref_node, weight) in &references {
        node_modes.insert(ref_node.id.clone(), InclusionMode::Reference);
        let cost = match weight {
            EdgeWeight::Full => ref_node.metadata.token_count,
            EdgeWeight::Summary => summary_cost(ref_node),
        };
        used_tokens = used_tokens.saturating_add(cost);
        let entry = mode_tokens.entry(InclusionMode::Reference).or_insert(0);
        *entry = entry.saturating_add(cost);
    }

    // -------------------------------------------------------------------------
    // STEP 7: Deterministic Section Assembly
    // -------------------------------------------------------------------------
    let mut sections: Vec<String> = Vec::new();

    if !global_pins.is_empty() {
        let body = global_pins
            .iter()
            .map(|n| format!("### {}{}\n{}", n.title, group_annotation(engine, &n.id), n.content))
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("[GLOBAL CONSTRAINTS]\n{body}"));
    }

    if !older_ancestors.is_empty() {
        let body = older_ancestors
            .iter()
            .map(|n| {
                let is_full = *anc_full_mode.get(n.id.as_str()).unwrap_or(&false);
                let grp = group_annotation(engine, &n.id);
                if is_full || n.summary.is_empty() {
                    format!("### {}{}\n{}", n.title, grp, n.content)
                } else {
                    format!("### {} (summary){}\n{}", n.title, grp, n.summary)
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("[BACKGROUND ANCESTORS]\n{body}"));
    }

    if !direct_parents.is_empty() {
        let body = direct_parents
            .iter()
            .map(|n| {
                let mut relations: Vec<&'static str> = engine
                    .outgoing
                    .get(&n.id)
                    .map(|edges| {
                        edges
                            .iter()
                            .filter(|e| {
                                is_ancestor_edge(e.edge_type)
                                    && focus_set.contains(e.target_id.as_str())
                            })
                            .map(|e| e.edge_type.as_str())
                            .collect()
                    })
                    .unwrap_or_default();
                relations.sort_unstable();
                relations.dedup();
                let grp = group_annotation(engine, &n.id);
                if relations.is_empty() {
                    format!("### {} [{:?}]{}\n{}", n.title, n.node_type, grp, n.content)
                } else {
                    format!(
                        "### {} [{:?} · {}]{}\n{}",
                        n.title,
                        n.node_type,
                        relations.join(", "),
                        grp,
                        n.content
                    )
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("[DIRECT PARENTS & INPUTS]\n{body}"));
    }

    if !active_loopholes.is_empty() {
        let body = active_loopholes
            .iter()
            .map(|(lh, targets)| {
                let sev = format!("{:?}", lh.metadata.severity.unwrap_or(Severity::Medium))
                    .to_uppercase();
                let grp = group_annotation(engine, &lh.id);
                format!(
                    "### [{}] {} (challenges: {}){}\n{}",
                    sev,
                    lh.title,
                    targets.join(", "),
                    grp,
                    lh.content
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("[UNRESOLVED LOOPHOLES]\n{body}"));
    }

    if !references.is_empty() {
        let body = references
            .iter()
            .map(|(n, weight)| {
                let text = match weight {
                    EdgeWeight::Full => &n.content,
                    EdgeWeight::Summary if !n.summary.is_empty() => &n.summary,
                    EdgeWeight::Summary => &n.content,
                };
                format!("### {}{}\n{}", n.title, group_annotation(engine, &n.id), text)
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("[REFERENCED CONTEXT]\n{body}"));
    }

    let focus_body = focus_nodes
        .iter()
        .map(|n| {
            format!(
                "### {} [{:?}]{}\n{}",
                n.title,
                n.node_type,
                group_annotation(engine, &n.id),
                n.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    sections.push(format!("[FOCUS NODE]\n{focus_body}"));

    let mut active_edge_list: Vec<String> = active_edges.into_iter().collect();
    active_edge_list.sort();

    let mut provenance_inputs: Vec<ProvenanceInput> = node_modes
        .keys()
        .filter_map(|id| {
            engine.nodes.get(id).map(|n| ProvenanceInput {
                node_id: n.id.clone(),
                title: n.title.clone(),
                content_hash: n.content_hash.clone(),
            })
        })
        .collect();
    provenance_inputs.sort_by(|a, b| a.node_id.cmp(&b.node_id));

    let prompt_text = sections.join("\n\n---\n\n");
    let prompt_preview = prompt_text.clone();

    CompiledContext {
        prompt_text,
        xray: CompiledXray {
            total_tokens: used_tokens,
            budget_tokens: token_budget,
            overflow: used_tokens > token_budget,
            node_modes,
            mode_tokens,
            active_edges: active_edge_list,
            prompt_preview,
        },
        provenance_inputs,
    }
}

pub(crate) fn kahn_topo_sort_cycle_safe(
    engine: &GraphEngine,
    subset: &HashSet<String>,
    depth_map: &HashMap<String, u32>,
) -> Vec<String> {
    let mut in_degree: HashMap<String, usize> = subset.iter().map(|id| (id.clone(), 0)).collect();
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();

    for id in subset {
        if let Some(out_edges) = engine.outgoing.get(id) {
            for edge in out_edges {
                if is_ancestor_edge(edge.edge_type) && subset.contains(&edge.target_id) {
                    adj.entry(id.clone())
                        .or_default()
                        .push(edge.target_id.clone());
                    *in_degree.entry(edge.target_id.clone()).or_insert(0) += 1;
                }
            }
        }
    }

    let mut ready: BinaryHeap<(u32, Reverse<String>)> = BinaryHeap::new();
    for (id, &deg) in &in_degree {
        if deg == 0 {
            let d = *depth_map.get(id).unwrap_or(&0);
            ready.push((d, Reverse(id.clone())));
        }
    }

    let mut result: Vec<String> = Vec::with_capacity(subset.len());
    while let Some((_, Reverse(u))) = ready.pop() {
        result.push(u.clone());
        if let Some(neighbors) = adj.get(&u) {
            for v in neighbors {
                if let Some(deg) = in_degree.get_mut(v) {
                    *deg -= 1;
                    if *deg == 0 {
                        let d = *depth_map.get(v).unwrap_or(&0);
                        ready.push((d, Reverse(v.clone())));
                    }
                }
            }
        }
    }

    if result.len() < subset.len() {
        let emitted: HashSet<&str> = result.iter().map(String::as_str).collect();
        let mut remaining: Vec<String> = subset
            .iter()
            .filter(|id| !emitted.contains(id.as_str()))
            .cloned()
            .collect();
        remaining.sort_by(|a, b| {
            let da = *depth_map.get(a).unwrap_or(&0);
            let db = *depth_map.get(b).unwrap_or(&0);
            db.cmp(&da).then_with(|| a.cmp(b))
        });
        result.extend(remaining);
    }

    result
}

fn group_annotation(engine: &GraphEngine, node_id: &str) -> String {
    if engine.groups.is_empty() {
        return String::new();
    }
    let mut titles: Vec<&str> = engine
        .groups
        .values()
        .filter(|g| g.member_ids.iter().any(|mid| mid == node_id))
        .map(|g| g.title.as_str())
        .collect();
    if titles.is_empty() {
        return String::new();
    }
    titles.sort_unstable();
    titles.dedup();
    format!(" [GROUP: {}]", titles.join(", "))
}

fn severity_rank(s: Option<Severity>) -> u8 {
    match s {
        Some(Severity::Critical) => 4,
        Some(Severity::High) => 3,
        Some(Severity::Medium) => 2,
        Some(Severity::Low) => 1,
        None => 0,
    }
}

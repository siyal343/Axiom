use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::Path;

use crate::error::IpcError;
use crate::graph::compiler::{is_ancestor_edge, kahn_topo_sort_cycle_safe};
use crate::graph::models::{
    ArtifactFormat, ArtifactScope, CompiledArtifact, EdgeDto, EdgeType, NodeDto, NodeStatus,
    NodeType, Severity,
};
use crate::graph::GraphEngine;

fn severity_rank(s: Option<Severity>) -> u8 {
    match s {
        Some(Severity::Critical) => 4,
        Some(Severity::High) => 3,
        Some(Severity::Medium) => 2,
        Some(Severity::Low) => 1,
        None => 0,
    }
}

fn severity_label(s: Option<Severity>) -> &'static str {
    match s {
        Some(Severity::Critical) => "CRITICAL",
        Some(Severity::High) => "HIGH",
        Some(Severity::Medium) => "MEDIUM",
        Some(Severity::Low) => "LOW",
        None => "MEDIUM",
    }
}

fn node_body(node: &NodeDto) -> &str {
    let content = node.content.trim();
    if !content.is_empty() {
        content
    } else {
        node.summary.trim()
    }
}

fn node_summary_or_content(node: &NodeDto) -> &str {
    let summary = node.summary.trim();
    if !summary.is_empty() {
        summary
    } else {
        node.content.trim()
    }
}

fn is_unresolved_loophole(node: &NodeDto) -> bool {
    node.node_type == NodeType::Loophole
        && !matches!(node.status, NodeStatus::Resolved | NodeStatus::Dismissed)
}

fn escape_mermaid_label(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = false;
    for ch in raw.trim().chars() {
        let mapped = match ch {
            '"' => '\'',
            '\r' | '\n' | '\t' => ' ',
            '|' => '/',
            '<' | '>' => ' ',
            _ => ch,
        };
        if mapped == ' ' {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(mapped);
            prev_space = false;
        }
    }
    if out.is_empty() {
        "Untitled".to_owned()
    } else {
        out
    }
}

fn escape_md_table_cell(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = false;
    for ch in raw.trim().chars() {
        let mapped = match ch {
            '\r' | '\n' | '\t' => ' ',
            '|' => '/',
            _ => ch,
        };
        if mapped == ' ' {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(mapped);
            prev_space = false;
        }
    }
    out
}

fn collect_subgraph(
    engine: &GraphEngine,
    focus_ids: &[String],
    scope: ArtifactScope,
) -> (HashSet<String>, HashMap<String, u32>) {
    let mut depth_map: HashMap<String, u32> = HashMap::new();

    if scope == ArtifactScope::Workspace || focus_ids.is_empty() {
        let selected: HashSet<String> = engine
            .nodes
            .values()
            .filter(|n| !n.context_controls.exclude_from_ai)
            .map(|n| {
                depth_map.insert(n.id.clone(), 0);
                n.id.clone()
            })
            .collect();
        return (selected, depth_map);
    }

    let mut raw_spine: HashSet<String> = HashSet::new();
    let mut back_queue: VecDeque<(String, u32)> = VecDeque::new();
    let mut fwd_queue: VecDeque<(String, u32)> = VecDeque::new();

    for fid in focus_ids {
        if engine.nodes.contains_key(fid) && raw_spine.insert(fid.clone()) {
            depth_map.insert(fid.clone(), 0);
            back_queue.push_back((fid.clone(), 0));
            fwd_queue.push_back((fid.clone(), 0));
        }
    }

    // Backward BFS along ancestor edges (passes through exclude_from_ai nodes to preserve lineage).
    let mut back_visited: HashSet<String> = raw_spine.clone();
    while let Some((curr_id, depth)) = back_queue.pop_front() {
        if let Some(in_edges) = engine.incoming.get(&curr_id) {
            for edge in in_edges {
                if !is_ancestor_edge(edge.edge_type) {
                    continue;
                }
                let next_depth = depth.saturating_add(1);
                if back_visited.insert(edge.source_id.clone()) {
                    raw_spine.insert(edge.source_id.clone());
                    depth_map
                        .entry(edge.source_id.clone())
                        .and_modify(|d| *d = (*d).min(next_depth))
                        .or_insert(next_depth);
                    back_queue.push_back((edge.source_id.clone(), next_depth));
                }
            }
        }
    }

    // Forward BFS along descendant edges (passes through exclude_from_ai nodes to preserve lineage).
    let mut fwd_visited: HashSet<String> = focus_ids
        .iter()
        .filter(|id| engine.nodes.contains_key(*id))
        .cloned()
        .collect();
    while let Some((curr_id, depth)) = fwd_queue.pop_front() {
        if let Some(out_edges) = engine.outgoing.get(&curr_id) {
            for edge in out_edges {
                if !is_ancestor_edge(edge.edge_type) {
                    continue;
                }
                let next_depth = depth.saturating_add(1);
                if fwd_visited.insert(edge.target_id.clone()) {
                    raw_spine.insert(edge.target_id.clone());
                    depth_map
                        .entry(edge.target_id.clone())
                        .and_modify(|d| *d = (*d).min(next_depth))
                        .or_insert(next_depth);
                    fwd_queue.push_back((edge.target_id.clone(), next_depth));
                }
            }
        }
    }

    // Include non-excluded global pins.
    for node in engine.nodes.values() {
        if node.context_controls.pin_global && !node.context_controls.exclude_from_ai {
            raw_spine.insert(node.id.clone());
            depth_map.entry(node.id.clone()).or_insert(0);
        }
    }

    // Include attached Challenges, Resolves, and References.
    let mut all_candidates = raw_spine.clone();
    let mut attached_loopholes: Vec<String> = Vec::new();
    for id in &raw_spine {
        if let Some(in_edges) = engine.incoming.get(id) {
            for edge in in_edges {
                if matches!(edge.edge_type, EdgeType::Challenges | EdgeType::Resolves)
                    && engine.nodes.contains_key(&edge.source_id)
                {
                    all_candidates.insert(edge.source_id.clone());
                    depth_map.entry(edge.source_id.clone()).or_insert(1);
                    if edge.edge_type == EdgeType::Challenges {
                        attached_loopholes.push(edge.source_id.clone());
                    }
                }
            }
        }
        if let Some(out_edges) = engine.outgoing.get(id) {
            for edge in out_edges {
                if edge.edge_type == EdgeType::References
                    && engine.nodes.contains_key(&edge.target_id)
                {
                    all_candidates.insert(edge.target_id.clone());
                    depth_map.entry(edge.target_id.clone()).or_insert(1);
                }
            }
        }
    }

    // Include mitigations (`Resolves`) targeting any harvested loophole.
    for lh_id in attached_loopholes {
        if let Some(in_edges) = engine.incoming.get(&lh_id) {
            for edge in in_edges {
                if edge.edge_type == EdgeType::Resolves
                    && engine.nodes.contains_key(&edge.source_id)
                {
                    all_candidates.insert(edge.source_id.clone());
                    depth_map.entry(edge.source_id.clone()).or_insert(1);
                }
            }
        }
    }

    let selected: HashSet<String> = all_candidates
        .into_iter()
        .filter(|id| {
            engine
                .nodes
                .get(id)
                .is_some_and(|n| !n.context_controls.exclude_from_ai)
        })
        .collect();

    (selected, depth_map)
}

fn render_mermaid_flowchart(nodes: &[&NodeDto], edges: &[&EdgeDto]) -> String {
    let mut sorted_nodes: Vec<&NodeDto> = nodes.to_vec();
    sorted_nodes.sort_by(|a, b| a.id.cmp(&b.id));

    let mut alias_map: HashMap<&str, String> = HashMap::with_capacity(sorted_nodes.len());
    let mut lines: Vec<String> = Vec::with_capacity(sorted_nodes.len() + edges.len() + 1);
    lines.push("flowchart LR".to_owned());

    for (idx, node) in sorted_nodes.iter().enumerate() {
        let alias = format!("n{idx}");
        let label = escape_mermaid_label(&node.title);
        let decl = match node.node_type {
            NodeType::Core => format!("    {alias}[\"{label}\"]"),
            NodeType::Branch => format!("    {alias}([\"{label}\"])"),
            NodeType::Loophole => format!("    {alias}{{\"{label}\"}}"),
            NodeType::Probe => format!("    {alias}[/\"{label}\"/]"),
            NodeType::Synthesis => format!("    {alias}[[\"{label}\"]]"),
        };
        lines.push(decl);
        alias_map.insert(node.id.as_str(), alias);
    }

    let mut sorted_edges: Vec<&EdgeDto> = edges.to_vec();
    sorted_edges.sort_by(|a, b| {
        a.source_id
            .cmp(&b.source_id)
            .then_with(|| a.target_id.cmp(&b.target_id))
            .then_with(|| a.edge_type.as_str().cmp(b.edge_type.as_str()))
            .then_with(|| a.id.cmp(&b.id))
    });

    for edge in sorted_edges {
        if let (Some(src), Some(dst)) = (
            alias_map.get(edge.source_id.as_str()),
            alias_map.get(edge.target_id.as_str()),
        ) {
            let arrow = match edge.edge_type {
                EdgeType::Derives => "-->|derives|",
                EdgeType::Branches => "-.->|branches|",
                EdgeType::Challenges => "==>|challenges|",
                EdgeType::Resolves => "-->|resolves|",
                EdgeType::Synthesizes => "==>|synthesizes|",
                EdgeType::References => "-.->|references|",
            };
            lines.push(format!("    {src} {arrow} {dst}"));
        }
    }

    lines.join("\n")
}

fn collect_loophole_mitigations<'a>(
    engine: &'a GraphEngine,
    loophole_id: &str,
    selected_ids: &HashSet<String>,
) -> Vec<&'a NodeDto> {
    let mut mitigations: Vec<&NodeDto> = engine
        .incoming
        .get(loophole_id)
        .map(|edges| {
            edges
                .iter()
                .filter(|e| {
                    e.edge_type == EdgeType::Resolves && selected_ids.contains(&e.source_id)
                })
                .filter_map(|e| engine.nodes.get(&e.source_id))
                .collect()
        })
        .unwrap_or_default();
    mitigations.sort_by(|a, b| a.id.cmp(&b.id));
    mitigations.dedup_by(|a, b| a.id == b.id);
    mitigations
}

fn format_node_section_entry(node: &NodeDto) -> String {
    let body = node_body(node);
    if body.is_empty() {
        format!(
            "### {} (`{}` · `{}`)",
            node.title,
            node.node_type.as_str(),
            node.status.as_str()
        )
    } else {
        format!(
            "### {} (`{}` · `{}`)\n\n{}",
            node.title,
            node.node_type.as_str(),
            node.status.as_str(),
            body
        )
    }
}

pub fn compile_markdown_artifact(
    engine: &GraphEngine,
    focus_ids: &[String],
    scope: ArtifactScope,
    format: ArtifactFormat,
) -> CompiledArtifact {
    let effective_scope = if scope == ArtifactScope::Subgraph && focus_ids.is_empty() {
        ArtifactScope::Workspace
    } else {
        scope
    };

    let (selected_ids, depth_map) = collect_subgraph(engine, focus_ids, effective_scope);
    let topo_ids = kahn_topo_sort_cycle_safe(engine, &selected_ids, &depth_map);

    let topo_nodes: Vec<&NodeDto> = topo_ids
        .iter()
        .filter_map(|id| engine.nodes.get(id))
        .collect();

    let mut selected_edges: Vec<&EdgeDto> = engine
        .outgoing
        .values()
        .flatten()
        .filter(|e| selected_ids.contains(&e.source_id) && selected_ids.contains(&e.target_id))
        .collect();
    selected_edges.sort_by(|a, b| a.id.cmp(&b.id));
    selected_edges.dedup_by(|a, b| a.id == b.id);

    let node_count = topo_nodes.len();
    let edge_count = selected_edges.len();
    let unresolved_loophole_count = topo_nodes
        .iter()
        .filter(|n| is_unresolved_loophole(n))
        .count();

    let focus_title = focus_ids
        .iter()
        .filter(|id| selected_ids.contains(*id))
        .filter_map(|id| engine.nodes.get(id))
        .map(|n| n.title.trim())
        .find(|t| !t.is_empty());

    let title = match (format, effective_scope, focus_title) {
        (ArtifactFormat::Adr, ArtifactScope::Subgraph, Some(t)) => {
            format!("Architecture Decision Record: {t}")
        }
        (ArtifactFormat::Adr, _, _) => "Architecture Decision Record".to_owned(),
        (ArtifactFormat::Brief, ArtifactScope::Subgraph, Some(t)) => {
            format!("Technical Brief: {t}")
        }
        (ArtifactFormat::Brief, _, _) => "Technical Brief".to_owned(),
        (ArtifactFormat::Mermaid, ArtifactScope::Subgraph, Some(t)) => {
            format!("Architecture Graph: {t}")
        }
        (ArtifactFormat::Mermaid, _, _) => "Architecture Graph".to_owned(),
    };

    let scope_label = match effective_scope {
        ArtifactScope::Subgraph => "subgraph",
        ArtifactScope::Workspace => "workspace",
    };

    let markdown = match format {
        ArtifactFormat::Mermaid => {
            let chart = render_mermaid_flowchart(&topo_nodes, &selected_edges);
            format!(
                "# {title}\n\n> **Scope:** `{scope_label}` | **Nodes:** {node_count} | **Edges:** {edge_count} | **Unresolved Loopholes:** {unresolved_loophole_count}\n\n```mermaid\n{chart}\n```"
            )
        }
        ArtifactFormat::Adr => {
            let mut out: Vec<String> = Vec::new();
            out.push(format!("# {title}"));
            out.push(format!(
                "> **Scope:** `{scope_label}` | **Nodes:** {node_count} | **Edges:** {edge_count} | **Unresolved Loopholes:** {unresolved_loophole_count}"
            ));

            let mut global_pins: Vec<&NodeDto> = topo_nodes
                .iter()
                .copied()
                .filter(|n| n.context_controls.pin_global)
                .collect();
            global_pins.sort_by(|a, b| a.id.cmp(&b.id));

            out.push("## Context & Global Constraints".to_owned());
            if global_pins.is_empty() {
                out.push("_No global constraints pinned._".to_owned());
            } else {
                for pin in &global_pins {
                    out.push(format_node_section_entry(pin));
                }
            }

            let spine_nodes: Vec<&NodeDto> = topo_nodes
                .iter()
                .copied()
                .filter(|n| matches!(n.node_type, NodeType::Core | NodeType::Synthesis))
                .collect();
            out.push("## Decision Spine".to_owned());
            if spine_nodes.is_empty() {
                out.push("_No core or synthesis nodes in selection._".to_owned());
            } else {
                for node in spine_nodes {
                    out.push(format_node_section_entry(node));
                }
            }

            let branch_nodes: Vec<&NodeDto> = topo_nodes
                .iter()
                .copied()
                .filter(|n| n.node_type == NodeType::Branch)
                .collect();
            out.push("## Alternatives Considered".to_owned());
            if branch_nodes.is_empty() {
                out.push("_No alternative branches recorded._".to_owned());
            } else {
                for node in branch_nodes {
                    out.push(format_node_section_entry(node));
                }
            }

            let mut loopholes: Vec<&NodeDto> = topo_nodes
                .iter()
                .copied()
                .filter(|n| n.node_type == NodeType::Loophole)
                .collect();
            loopholes.sort_by(|a, b| {
                severity_rank(b.metadata.severity)
                    .cmp(&severity_rank(a.metadata.severity))
                    .then_with(|| a.id.cmp(&b.id))
            });

            out.push("## Risk & Loophole Register".to_owned());
            if loopholes.is_empty() {
                out.push("_No loopholes recorded._".to_owned());
            } else {
                let mut table_lines = vec![
                    "| Loophole | Severity | Status | Mitigation (`resolves`) |".to_owned(),
                    "| --- | --- | --- | --- |".to_owned(),
                ];
                for lh in loopholes {
                    let sev_str = severity_label(lh.metadata.severity);
                    let is_open_severe = is_unresolved_loophole(lh)
                        && matches!(
                            lh.metadata.severity,
                            Some(Severity::High | Severity::Critical)
                        );
                    let status_cell = if is_open_severe {
                        format!("**OPEN {}** (`{}`)", sev_str, lh.status.as_str())
                    } else {
                        format!("`{}`", lh.status.as_str())
                    };
                    let mitigations = collect_loophole_mitigations(engine, &lh.id, &selected_ids);
                    let mitigation_cell = if mitigations.is_empty() {
                        "_None_".to_owned()
                    } else {
                        mitigations
                            .iter()
                            .map(|m| {
                                let detail = node_summary_or_content(m);
                                if detail.is_empty() {
                                    escape_md_table_cell(&m.title)
                                } else {
                                    format!(
                                        "**{}**: {}",
                                        escape_md_table_cell(&m.title),
                                        escape_md_table_cell(detail)
                                    )
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("; ")
                    };
                    let title_cell = if is_open_severe {
                        format!("[!{sev_str}] {}", escape_md_table_cell(&lh.title))
                    } else {
                        escape_md_table_cell(&lh.title)
                    };
                    table_lines.push(format!(
                        "| {title_cell} | {sev_str} | {status_cell} | {mitigation_cell} |"
                    ));
                }
                out.push(table_lines.join("\n"));
            }

            let chart = render_mermaid_flowchart(&topo_nodes, &selected_edges);
            out.push("## Architecture Graph".to_owned());
            out.push(format!("```mermaid\n{chart}\n```"));

            out.join("\n\n")
        }
        ArtifactFormat::Brief => {
            let mut out: Vec<String> = Vec::new();
            out.push(format!("# {title}"));
            out.push(format!(
                "> **Scope:** `{scope_label}` | **Nodes:** {node_count} | **Edges:** {edge_count} | **Unresolved Loopholes:** {unresolved_loophole_count}"
            ));

            let synthesis_nodes: Vec<&NodeDto> = topo_nodes
                .iter()
                .copied()
                .filter(|n| n.node_type == NodeType::Synthesis)
                .collect();
            out.push("## Key Takeaways & Synthesis".to_owned());
            if synthesis_nodes.is_empty() {
                out.push("_No synthesis nodes recorded._".to_owned());
            } else {
                for node in synthesis_nodes {
                    out.push(format_node_section_entry(node));
                }
            }

            let core_branch_nodes: Vec<&NodeDto> = topo_nodes
                .iter()
                .copied()
                .filter(|n| matches!(n.node_type, NodeType::Core | NodeType::Branch))
                .collect();
            out.push("## Core Concepts & Derivations".to_owned());
            if core_branch_nodes.is_empty() {
                out.push("_No core or branch concepts in selection._".to_owned());
            } else {
                for node in core_branch_nodes {
                    out.push(format_node_section_entry(node));
                }
            }

            let probe_nodes: Vec<&NodeDto> = topo_nodes
                .iter()
                .copied()
                .filter(|n| n.node_type == NodeType::Probe)
                .collect();
            out.push("## Probing Questions & Study Checks".to_owned());
            if probe_nodes.is_empty() {
                out.push("_No probing questions recorded._".to_owned());
            } else {
                for node in probe_nodes {
                    out.push(format_node_section_entry(node));
                }
            }

            let mut loopholes: Vec<&NodeDto> = topo_nodes
                .iter()
                .copied()
                .filter(|n| n.node_type == NodeType::Loophole)
                .collect();
            loopholes.sort_by(|a, b| {
                severity_rank(b.metadata.severity)
                    .cmp(&severity_rank(a.metadata.severity))
                    .then_with(|| a.id.cmp(&b.id))
            });
            out.push("## Open Challenges & Mitigations".to_owned());
            if loopholes.is_empty() {
                out.push("_No challenges recorded._".to_owned());
            } else {
                for lh in loopholes {
                    let sev_str = severity_label(lh.metadata.severity);
                    let mitigations = collect_loophole_mitigations(engine, &lh.id, &selected_ids);
                    let body = node_body(lh);
                    let mut entry = format!(
                        "### [{}] {} (`{}`)",
                        sev_str,
                        lh.title,
                        lh.status.as_str()
                    );
                    if !body.is_empty() {
                        entry.push_str(&format!("\n\n{body}"));
                    }
                    if !mitigations.is_empty() {
                        let mit_lines = mitigations
                            .iter()
                            .map(|m| {
                                let detail = node_summary_or_content(m);
                                if detail.is_empty() {
                                    format!("- **Mitigation:** {}", m.title)
                                } else {
                                    format!("- **Mitigation ({})**: {}", m.title, detail)
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        entry.push_str(&format!("\n\n{mit_lines}"));
                    }
                    out.push(entry);
                }
            }

            let mut ref_ids: HashSet<&str> = HashSet::new();
            let mut ref_nodes: Vec<&NodeDto> = Vec::new();
            for edge in &selected_edges {
                if edge.edge_type == EdgeType::References
                    && ref_ids.insert(edge.target_id.as_str())
                {
                    if let Some(target) = engine.nodes.get(&edge.target_id) {
                        ref_nodes.push(target);
                    }
                }
            }
            ref_nodes.sort_by(|a, b| a.id.cmp(&b.id));

            out.push("## References".to_owned());
            if ref_nodes.is_empty() {
                out.push("_No external references linked._".to_owned());
            } else {
                for node in ref_nodes {
                    let detail = node_summary_or_content(node);
                    if detail.is_empty() {
                        out.push(format!("- **{}**", node.title));
                    } else {
                        out.push(format!("- **{}**: {}", node.title, detail));
                    }
                }
            }

            out.join("\n\n")
        }
    };

    CompiledArtifact {
        format,
        scope: effective_scope,
        title,
        markdown,
        node_count,
        edge_count,
        unresolved_loophole_count,
    }
}

pub fn write_artifact_atomic(dest_path: &Path, markdown: &str) -> Result<(), IpcError> {
    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let file_stem = dest_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("artifact.md");
    let tmp_path = dest_path.with_file_name(format!(".{file_stem}.{}.tmp", ulid::Ulid::new()));
    {
        let mut file = std::fs::File::create(&tmp_path)?;
        file.write_all(markdown.as_bytes())?;
        file.sync_all()?;
    }
    if let Err(err) = std::fs::rename(&tmp_path, dest_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(err.into());
    }
    Ok(())
}

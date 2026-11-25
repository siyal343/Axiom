use rusqlite::Connection;

use crate::db;
use crate::error::IpcError;
use crate::graph::models::{
    compute_content_hash, estimate_tokens, now_epoch_ms, ContextControls, CreatedBy, EdgeDto,
    EdgeType, EdgeWeight, GraphOp, ImportOutlineResult, NodeDto, NodeLayout, NodeLensOrigin,
    NodeMetadata, NodeStatus, NodeType, Severity,
};
use crate::graph::spatial::{
    compute_tidy_subtree, find_free_position, resolve_overlaps, DEFAULT_NODE_HEIGHT,
    DEFAULT_NODE_WIDTH, H_GAP, V_GAP,
};
use crate::graph::GraphEngine;

const MAX_OUTLINE_SECTIONS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlineSection {
    pub level: u8,
    pub title: String,
    pub content: String,
    pub parent_idx: Option<usize>,
    pub node_type: NodeType,
    pub edge_type: EdgeType,
    pub severity: Option<Severity>,
}

fn update_fence_state(in_fence: &mut Option<(char, usize)>, trimmed_start: &str) {
    let Some(first) = trimmed_start.chars().next() else {
        return;
    };
    if first != '`' && first != '~' {
        return;
    }
    let count = trimmed_start.chars().take_while(|&c| c == first).count();
    if count < 3 {
        return;
    }
    let rest = &trimmed_start[count..];

    match *in_fence {
        None => {
            if first == '~' || !rest.contains('`') {
                *in_fence = Some((first, count));
            }
        }
        Some((fc, min_len)) => {
            if first == fc && count >= min_len && rest.trim().is_empty() {
                *in_fence = None;
            }
        }
    }
}

fn parse_atx_heading(line: &str) -> Option<(u8, String)> {
    let trimmed = line.trim_start();
    let hashes = trimmed.bytes().take_while(|&b| b == b'#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &trimmed[hashes..];
    if !rest.starts_with([' ', '\t']) {
        return None;
    }
    let title = rest.trim().trim_end_matches('#').trim();
    if title.is_empty() {
        return None;
    }
    Some((hashes as u8, title.to_owned()))
}

fn classify_section(title: &str) -> (NodeType, EdgeType, Option<Severity>) {
    let lower = title.trim().to_ascii_lowercase();
    if lower.starts_with("critical:") {
        (
            NodeType::Loophole,
            EdgeType::Challenges,
            Some(Severity::Critical),
        )
    } else if lower.starts_with("high:") {
        (
            NodeType::Loophole,
            EdgeType::Challenges,
            Some(Severity::High),
        )
    } else if lower.starts_with("risk:")
        || lower.starts_with("loophole:")
        || lower.starts_with("failure:")
        || lower.starts_with("warning:")
    {
        (
            NodeType::Loophole,
            EdgeType::Challenges,
            Some(Severity::Medium),
        )
    } else if lower.starts_with("question:")
        || lower.starts_with("why:")
        || lower.starts_with("probe:")
        || lower.starts_with("open question:")
    {
        (NodeType::Probe, EdgeType::Derives, None)
    } else if lower.starts_with("option:")
        || lower.starts_with("alternative:")
        || lower.starts_with("branch:")
    {
        (NodeType::Branch, EdgeType::Branches, None)
    } else if lower.starts_with("decision:")
        || lower.starts_with("synthesis:")
        || lower.starts_with("conclusion:")
    {
        (NodeType::Synthesis, EdgeType::Derives, None)
    } else {
        (NodeType::Core, EdgeType::Derives, None)
    }
}

pub fn parse_markdown_outline(markdown: &str) -> Result<Vec<OutlineSection>, IpcError> {
    if markdown.trim().is_empty() {
        return Err(IpcError::validation("Markdown outline cannot be empty"));
    }

    let mut sections: Vec<OutlineSection> = Vec::new();
    let mut stack: Vec<(u8, usize)> = Vec::new();
    let mut body_lines: Vec<String> = Vec::new();
    let mut preamble_lines: Vec<String> = Vec::new();
    let mut in_fence: Option<(char, usize)> = None;
    let mut hit_cap = false;

    for raw_line in markdown.lines() {
        let line = raw_line.trim_end_matches('\r');
        let trimmed_start = line.trim_start();
        let was_in_fence = in_fence.is_some();
        update_fence_state(&mut in_fence, trimmed_start);

        if !was_in_fence {
            if let Some((level, title)) = parse_atx_heading(line) {
                if let Some(last) = sections.last_mut() {
                    last.content = body_lines.join("\n").trim().to_owned();
                    body_lines.clear();
                } else {
                    let pre = preamble_lines.join("\n").trim().to_owned();
                    preamble_lines.clear();
                    if !pre.is_empty() {
                        body_lines.push(pre);
                    }
                }

                if sections.len() >= MAX_OUTLINE_SECTIONS {
                    hit_cap = true;
                    break;
                }

                while let Some(&(prev_level, _)) = stack.last() {
                    if prev_level >= level {
                        stack.pop();
                    } else {
                        break;
                    }
                }
                let parent_idx = stack.last().map(|&(_, idx)| idx);
                let new_idx = sections.len();
                stack.push((level, new_idx));

                let (node_type, edge_type, severity) = classify_section(&title);
                sections.push(OutlineSection {
                    level,
                    title,
                    content: String::new(),
                    parent_idx,
                    node_type,
                    edge_type,
                    severity,
                });
                continue;
            }
        }

        if sections.is_empty() {
            preamble_lines.push(line.to_owned());
        } else {
            body_lines.push(line.to_owned());
        }
    }

    if !hit_cap {
        if let Some(last) = sections.last_mut() {
            last.content = body_lines.join("\n").trim().to_owned();
        }
    }

    if sections.is_empty() {
        let lines: Vec<&str> = markdown.lines().map(|l| l.trim_end_matches('\r')).collect();
        let first_idx = lines.iter().position(|l| !l.trim().is_empty());
        let (title, body) = match first_idx {
            Some(idx) => {
                let first = lines[idx].trim();
                let title = if first.is_empty() {
                    "Imported Notes".to_owned()
                } else {
                    first.to_owned()
                };
                let rest = lines[(idx + 1)..].join("\n").trim().to_owned();
                (title, rest)
            }
            None => ("Imported Notes".to_owned(), String::new()),
        };
        let (node_type, edge_type, severity) = classify_section(&title);
        sections.push(OutlineSection {
            level: 1,
            title,
            content: body,
            parent_idx: None,
            node_type,
            edge_type,
            severity,
        });
    }

    Ok(sections)
}

pub fn import_markdown_outline(
    conn: &mut Connection,
    engine: &mut GraphEngine,
    markdown: &str,
    parent_id: Option<&str>,
) -> Result<ImportOutlineResult, IpcError> {
    if let Some(pid) = parent_id {
        if !engine.nodes.contains_key(pid) {
            return Err(IpcError::validation(format!("Parent node {pid} not found")));
        }
    }

    let sections = parse_markdown_outline(markdown)?;
    let now = now_epoch_ms();
    let existing_ids: std::collections::HashSet<String> = engine.nodes.keys().cloned().collect();

    let node_ids: Vec<String> = (0..sections.len())
        .map(|_| format!("node_{}", ulid::Ulid::new()))
        .collect();

    let anchor_nodes: Vec<NodeDto> = parent_id
        .and_then(|pid| engine.nodes.get(pid).cloned())
        .into_iter()
        .collect();
    let anchor_refs: Vec<&NodeDto> = anchor_nodes.iter().collect();
    let (base_x, base_y) = find_free_position(
        &engine.spatial,
        &anchor_refs,
        sections[0].node_type,
        DEFAULT_NODE_WIDTH,
        DEFAULT_NODE_HEIGHT,
        0,
    );

    let mut ops: Vec<GraphOp> = Vec::with_capacity(sections.len() * 2);
    let mut created_edges: Vec<EdgeDto> = Vec::with_capacity(sections.len());

    for (idx, sec) in sections.iter().enumerate() {
        let id = node_ids[idx].clone();
        let content_hash = compute_content_hash(&sec.title, &sec.content);
        let token_count = estimate_tokens(&format!("{}\n{}", sec.title, sec.content));

        // Initial staggered placement; tidy_subtree refines layout right after commit.
        let init_x = base_x + (f64::from(sec.level.saturating_sub(1))) * (DEFAULT_NODE_WIDTH + H_GAP);
        let init_y = base_y + (idx as f64) * (DEFAULT_NODE_HEIGHT + V_GAP);

        let node = NodeDto {
            id: id.clone(),
            node_type: sec.node_type,
            status: NodeStatus::Active,
            title: sec.title.clone(),
            content: sec.content.clone(),
            summary: String::new(),
            content_hash,
            summary_hash: String::new(),
            metadata: NodeMetadata {
                severity: sec.severity,
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
                x: init_x,
                y: init_y,
                width: DEFAULT_NODE_WIDTH,
                height: DEFAULT_NODE_HEIGHT,
                collapsed: false,
            },
            created_at: now,
            updated_at: now,
        };
        ops.push(GraphOp::CreateNode { node });

        let target_parent = match sec.parent_idx {
            Some(p_idx) => Some(node_ids[p_idx].as_str()),
            None => parent_id,
        };

        if let Some(pid) = target_parent {
            let (source_id, target_id) = match sec.edge_type {
                EdgeType::Challenges | EdgeType::Resolves => (id.clone(), pid.to_owned()),
                EdgeType::Derives
                | EdgeType::Branches
                | EdgeType::Synthesizes
                | EdgeType::References => (pid.to_owned(), id.clone()),
            };
            let edge = EdgeDto {
                id: format!("edge_{}", ulid::Ulid::new()),
                source_id,
                target_id,
                edge_type: sec.edge_type,
                weight: EdgeWeight::Summary,
                created_at: now,
            };
            ops.push(GraphOp::CreateEdge { edge: edge.clone() });
            created_edges.push(edge);
        }
    }

    db::queries::apply_ops(conn, engine, &ops)?;

    let root_id = node_ids[0].clone();
    if let Some(pid) = parent_id {
        let tidy_moves = compute_tidy_subtree(engine, pid)?;
        if !tidy_moves.is_empty() {
            db::queries::apply_ops(conn, engine, &[GraphOp::MoveNodes { moves: tidy_moves }])?;
        }
    } else {
        let top_roots: Vec<String> = sections
            .iter()
            .enumerate()
            .filter(|(_, s)| s.parent_idx.is_none())
            .map(|(idx, _)| node_ids[idx].clone())
            .collect();
        for top_id in &top_roots {
            let tidy_moves = compute_tidy_subtree(engine, top_id)?;
            if !tidy_moves.is_empty() {
                db::queries::apply_ops(conn, engine, &[GraphOp::MoveNodes { moves: tidy_moves }])?;
            }
        }
        if top_roots.len() > 1 {
            let overlap_moves = resolve_overlaps(engine, &existing_ids);
            if !overlap_moves.is_empty() {
                db::queries::apply_ops(
                    conn,
                    engine,
                    &[GraphOp::MoveNodes {
                        moves: overlap_moves,
                    }],
                )?;
            }
        }
    }

    let created_nodes: Vec<NodeDto> = node_ids
        .iter()
        .filter_map(|id| engine.nodes.get(id).cloned())
        .collect();

    Ok(ImportOutlineResult {
        root_id,
        created_nodes,
        created_edges,
    })
}

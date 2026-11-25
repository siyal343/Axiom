use std::collections::{HashMap, HashSet};

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, Row, Transaction, TransactionBehavior};

use crate::error::IpcError;
use crate::graph::models::{
    compute_content_hash, estimate_tokens, now_epoch_ms, ApplyResult, CameraState, ContextControls,
    CreatedBy, EdgeDto, EdgeType, EdgeWeight, GraphOp, NodeDto, NodeLayout, NodeLensOrigin,
    NodeMetadata, NodeStatus, NodeType, SearchHit, Severity, SpawnDirection,
};
use crate::graph::spatial::{
    directional_slot, find_best_open_direction, find_free_position,
    find_free_position_in_direction, DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH,
};
use crate::graph::GraphEngine;

enum EngineMutation {
    UpsertNode(NodeDto),
    RemoveNode(String),
    MoveNode(String, f64, f64),
    ResizeNode(String, f64, f64),
    AddEdge(EdgeDto),
    UpdateEdgeWeight(String, EdgeWeight),
    RemoveEdge(String),
}

pub(crate) fn insert_node_tx(tx: &Transaction<'_>, node: &NodeDto) -> Result<(), IpcError> {
    tx.execute(
        "INSERT INTO nodes (
            id, type, status, title, content, summary, content_hash, summary_hash,
            severity, lens, created_by, model, token_count,
            pin_global, exclude_from_ai, x, y, width, height, collapsed,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
        params![
            node.id,
            node.node_type.as_str(),
            node.status.as_str(),
            node.title,
            node.content,
            node.summary,
            node.content_hash,
            node.summary_hash,
            node.metadata.severity.map(Severity::as_str),
            node.metadata.lens.as_str(),
            node.metadata.created_by.as_str(),
            node.metadata.model,
            i64::from(node.metadata.token_count),
            i64::from(node.context_controls.pin_global),
            i64::from(node.context_controls.exclude_from_ai),
            node.layout.x,
            node.layout.y,
            node.layout.width,
            node.layout.height,
            i64::from(node.layout.collapsed),
            node.created_at,
            node.updated_at,
        ],
    )?;
    Ok(())
}

pub(crate) fn insert_edge_tx(tx: &Transaction<'_>, edge: &EdgeDto) -> Result<(), IpcError> {
    tx.execute(
        "INSERT INTO edges (id, source_id, target_id, type, weight, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            edge.id,
            edge.source_id,
            edge.target_id,
            edge.edge_type.as_str(),
            edge.weight.as_str(),
            edge.created_at,
        ],
    )?;
    Ok(())
}

fn staged_node(
    engine: &GraphEngine,
    overrides: &HashMap<String, Option<NodeDto>>,
    id: &str,
) -> Option<NodeDto> {
    if let Some(entry) = overrides.get(id) {
        entry.clone()
    } else {
        engine.nodes.get(id).cloned()
    }
}

fn record_updated_node(
    updated_map: &mut HashMap<String, NodeDto>,
    updated_order: &mut Vec<String>,
    node: NodeDto,
) {
    if !updated_map.contains_key(&node.id) {
        updated_order.push(node.id.clone());
    }
    updated_map.insert(node.id.clone(), node);
}

pub fn apply_ops(
    conn: &mut Connection,
    engine: &mut GraphEngine,
    ops: &[GraphOp],
) -> Result<(ApplyResult, Vec<String>), IpcError> {
    if ops.is_empty() {
        return Ok((
            ApplyResult {
                updated_nodes: Vec::new(),
                deleted_node_ids: Vec::new(),
                deleted_edge_ids: Vec::new(),
            },
            Vec::new(),
        ));
    }

    let now = now_epoch_ms();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let mut node_overrides: HashMap<String, Option<NodeDto>> = HashMap::new();
    let mut mutations: Vec<EngineMutation> = Vec::new();
    let mut updated_map: HashMap<String, NodeDto> = HashMap::new();
    let mut updated_order: Vec<String> = Vec::new();
    let mut deleted_node_ids: Vec<String> = Vec::new();
    let mut deleted_node_seen: HashSet<String> = HashSet::new();
    let mut deleted_edge_ids: Vec<String> = Vec::new();
    let mut deleted_edge_seen: HashSet<String> = HashSet::new();
    let mut summary_ids: Vec<String> = Vec::new();
    let mut summary_seen: HashSet<String> = HashSet::new();

    for op in ops {
        match op {
            GraphOp::CreateNode { node } => {
                if staged_node(engine, &node_overrides, &node.id).is_some() {
                    return Err(IpcError::validation(format!(
                        "Node {} already exists",
                        node.id
                    )));
                }
                let mut final_node = node.clone();
                final_node.content_hash =
                    compute_content_hash(&final_node.title, &final_node.content);
                final_node.metadata.token_count =
                    estimate_tokens(&format!("{}\n{}", final_node.title, final_node.content));
                if final_node.created_at <= 0 {
                    final_node.created_at = now;
                }
                final_node.updated_at = now;

                insert_node_tx(&tx, &final_node)?;

                if final_node.content_hash != final_node.summary_hash
                    && !final_node.context_controls.exclude_from_ai
                    && summary_seen.insert(final_node.id.clone())
                {
                    summary_ids.push(final_node.id.clone());
                }

                node_overrides.insert(final_node.id.clone(), Some(final_node.clone()));
                mutations.push(EngineMutation::UpsertNode(final_node.clone()));
                record_updated_node(&mut updated_map, &mut updated_order, final_node);
            }
            GraphOp::UpdateNodeText { id, title, content } => {
                let mut node = staged_node(engine, &node_overrides, id)
                    .ok_or_else(|| IpcError::validation(format!("Node {id} not found")))?;
                if node.status == NodeStatus::Locked {
                    return Err(IpcError::node_locked(id));
                }

                let content_hash = compute_content_hash(title, content);
                let token_count = estimate_tokens(&format!("{title}\n{content}"));
                tx.execute(
                    "UPDATE nodes
                     SET title = ?1, content = ?2, content_hash = ?3, token_count = ?4, updated_at = ?5
                     WHERE id = ?6",
                    params![
                        title,
                        content,
                        content_hash,
                        i64::from(token_count),
                        now,
                        id,
                    ],
                )?;

                node.title = title.clone();
                node.content = content.clone();
                node.content_hash = content_hash;
                node.metadata.token_count = token_count;
                node.updated_at = now;

                if node.content_hash != node.summary_hash
                    && !node.context_controls.exclude_from_ai
                    && summary_seen.insert(node.id.clone())
                {
                    summary_ids.push(node.id.clone());
                }

                node_overrides.insert(id.clone(), Some(node.clone()));
                mutations.push(EngineMutation::UpsertNode(node.clone()));
                record_updated_node(&mut updated_map, &mut updated_order, node);
            }
            GraphOp::UpdateNodeMeta {
                id,
                node_type,
                status,
                severity,
                pin_global,
                exclude_from_ai,
                collapsed,
            } => {
                let mut node = staged_node(engine, &node_overrides, id)
                    .ok_or_else(|| IpcError::validation(format!("Node {id} not found")))?;

                if let Some(t) = node_type {
                    node.node_type = *t;
                }
                if let Some(s) = status {
                    node.status = *s;
                }
                if let Some(sev) = severity {
                    node.metadata.severity = *sev;
                }
                if let Some(pin) = pin_global {
                    node.context_controls.pin_global = *pin;
                }
                if let Some(excl) = exclude_from_ai {
                    node.context_controls.exclude_from_ai = *excl;
                }
                if let Some(col) = collapsed {
                    node.layout.collapsed = *col;
                }
                node.updated_at = now;

                tx.execute(
                    "UPDATE nodes
                     SET type = ?1, status = ?2, severity = ?3, pin_global = ?4,
                         exclude_from_ai = ?5, collapsed = ?6, updated_at = ?7
                     WHERE id = ?8",
                    params![
                        node.node_type.as_str(),
                        node.status.as_str(),
                        node.metadata.severity.map(Severity::as_str),
                        i64::from(node.context_controls.pin_global),
                        i64::from(node.context_controls.exclude_from_ai),
                        i64::from(node.layout.collapsed),
                        node.updated_at,
                        id,
                    ],
                )?;

                node_overrides.insert(id.clone(), Some(node.clone()));
                mutations.push(EngineMutation::UpsertNode(node.clone()));
                record_updated_node(&mut updated_map, &mut updated_order, node);
            }
            GraphOp::MoveNodes { moves } => {
                for m in moves {
                    let mut node = staged_node(engine, &node_overrides, &m.id)
                        .ok_or_else(|| IpcError::validation(format!("Node {} not found", m.id)))?;
                    // Intentionally updates ONLY x, y so FTS5 column-scoped trigger nodes_au never fires.
                    tx.execute(
                        "UPDATE nodes SET x = ?1, y = ?2 WHERE id = ?3",
                        params![m.x, m.y, m.id],
                    )?;
                    node.layout.x = m.x;
                    node.layout.y = m.y;
                    node_overrides.insert(m.id.clone(), Some(node));
                    mutations.push(EngineMutation::MoveNode(m.id.clone(), m.x, m.y));
                }
            }
            GraphOp::ResizeNodes { sizes } => {
                for s in sizes {
                    let mut node = staged_node(engine, &node_overrides, &s.id)
                        .ok_or_else(|| IpcError::validation(format!("Node {} not found", s.id)))?;
                    tx.execute(
                        "UPDATE nodes SET width = ?1, height = ?2 WHERE id = ?3",
                        params![s.width, s.height, s.id],
                    )?;
                    node.layout.width = s.width;
                    node.layout.height = s.height;
                    node_overrides.insert(s.id.clone(), Some(node));
                    mutations.push(EngineMutation::ResizeNode(s.id.clone(), s.width, s.height));
                }
            }
            GraphOp::DeleteNodes { ids } => {
                for id in ids {
                    let incident_ids: Vec<String> = {
                        let mut stmt = tx.prepare(
                            "SELECT id FROM edges WHERE source_id = ?1 OR target_id = ?1 ORDER BY id ASC",
                        )?;
                        let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
                        let mut collected = Vec::new();
                        for row in rows {
                            collected.push(row?);
                        }
                        collected
                    };

                    for eid in incident_ids {
                        if deleted_edge_seen.insert(eid.clone()) {
                            deleted_edge_ids.push(eid);
                        }
                    }

                    let affected = tx.execute("DELETE FROM nodes WHERE id = ?1", params![id])?;
                    if affected > 0 && deleted_node_seen.insert(id.clone()) {
                        deleted_node_ids.push(id.clone());
                    }
                    node_overrides.insert(id.clone(), None);
                    mutations.push(EngineMutation::RemoveNode(id.clone()));
                }
            }
            GraphOp::CreateEdge { edge } => {
                if edge.source_id == edge.target_id {
                    return Err(IpcError::validation("Self-loop edges are not allowed"));
                }
                if staged_node(engine, &node_overrides, &edge.source_id).is_none() {
                    return Err(IpcError::validation(format!(
                        "Edge source node {} not found",
                        edge.source_id
                    )));
                }
                let target_node = staged_node(engine, &node_overrides, &edge.target_id)
                    .ok_or_else(|| {
                        IpcError::validation(format!(
                            "Edge target node {} not found",
                            edge.target_id
                        ))
                    })?;

                let dup_exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM edges WHERE source_id = ?1 AND target_id = ?2 AND type = ?3)",
                    params![edge.source_id, edge.target_id, edge.edge_type.as_str()],
                    |r| r.get(0),
                )?;
                if dup_exists {
                    return Err(IpcError::duplicate_edge(format!(
                        "Duplicate {} edge from {} to {}",
                        edge.edge_type.as_str(),
                        edge.source_id,
                        edge.target_id
                    )));
                }

                let mut final_edge = edge.clone();
                if final_edge.created_at <= 0 {
                    final_edge.created_at = now;
                }
                insert_edge_tx(&tx, &final_edge)?;
                mutations.push(EngineMutation::AddEdge(final_edge));

                if edge.edge_type == EdgeType::Resolves
                    && target_node.node_type == NodeType::Loophole
                {
                    let mut resolved = target_node;
                    resolved.status = NodeStatus::Resolved;
                    resolved.updated_at = now;
                    tx.execute(
                        "UPDATE nodes SET status = 'resolved', updated_at = ?1 WHERE id = ?2",
                        params![now, resolved.id],
                    )?;
                    node_overrides.insert(resolved.id.clone(), Some(resolved.clone()));
                    mutations.push(EngineMutation::UpsertNode(resolved.clone()));
                    record_updated_node(&mut updated_map, &mut updated_order, resolved);
                }
            }
            GraphOp::UpdateEdgeWeight { id, weight } => {
                let affected = tx.execute(
                    "UPDATE edges SET weight = ?1 WHERE id = ?2",
                    params![weight.as_str(), id],
                )?;
                if affected == 0 {
                    return Err(IpcError::validation(format!("Edge {id} not found")));
                }
                mutations.push(EngineMutation::UpdateEdgeWeight(id.clone(), *weight));
            }
            GraphOp::DeleteEdge { id } => {
                let affected = tx.execute("DELETE FROM edges WHERE id = ?1", params![id])?;
                if affected > 0 && deleted_edge_seen.insert(id.clone()) {
                    deleted_edge_ids.push(id.clone());
                }
                mutations.push(EngineMutation::RemoveEdge(id.clone()));
            }
        }
    }

    tx.commit()?;

    // Mutate in-memory GraphEngine ONLY after SQLite commit succeeds.
    for mutation in mutations {
        match mutation {
            EngineMutation::UpsertNode(node) => engine.upsert_node(node),
            EngineMutation::RemoveNode(id) => {
                engine.remove_node(&id);
            }
            EngineMutation::MoveNode(id, x, y) => {
                if let Some(node) = engine.nodes.get_mut(&id) {
                    node.layout.x = x;
                    node.layout.y = y;
                    let updated = node.clone();
                    engine.spatial.upsert(&updated);
                }
            }
            EngineMutation::ResizeNode(id, width, height) => {
                if let Some(node) = engine.nodes.get_mut(&id) {
                    node.layout.width = width;
                    node.layout.height = height;
                    let updated = node.clone();
                    engine.spatial.upsert(&updated);
                }
            }
            EngineMutation::AddEdge(edge) => engine.add_edge(edge),
            EngineMutation::UpdateEdgeWeight(id, weight) => {
                engine.update_edge_weight(&id, weight);
            }
            EngineMutation::RemoveEdge(id) => {
                engine.remove_edge(&id);
            }
        }
    }

    let updated_nodes: Vec<NodeDto> = updated_order
        .into_iter()
        .filter(|id| !deleted_node_seen.contains(id))
        .filter_map(|id| updated_map.remove(&id))
        .collect();

    Ok((
        ApplyResult {
            updated_nodes,
            deleted_node_ids,
            deleted_edge_ids,
        },
        summary_ids,
    ))
}

pub fn spawn_connected_node(
    conn: &mut Connection,
    engine: &mut GraphEngine,
    parent_id: &str,
    edge_type: EdgeType,
    node_type: NodeType,
    title: Option<String>,
    direction: Option<SpawnDirection>,
) -> Result<(NodeDto, EdgeDto), IpcError> {
    let parent = engine
        .nodes
        .get(parent_id)
        .ok_or_else(|| IpcError::validation(format!("Parent node {parent_id} not found")))?;

    let (x, y) = match direction {
        Some(dir) => find_free_position_in_direction(
            &engine.spatial,
            parent,
            dir,
            DEFAULT_NODE_WIDTH,
            DEFAULT_NODE_HEIGHT,
        ),
        None => {
            let best_dir = find_best_open_direction(
                &engine.spatial,
                parent,
                DEFAULT_NODE_WIDTH,
                DEFAULT_NODE_HEIGHT,
            );
            let (sx, sy) =
                directional_slot(parent, best_dir, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT);
            if !engine
                .spatial
                .intersects_rect(sx, sy, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT)
            {
                find_free_position_in_direction(
                    &engine.spatial,
                    parent,
                    best_dir,
                    DEFAULT_NODE_WIDTH,
                    DEFAULT_NODE_HEIGHT,
                )
            } else {
                find_free_position(
                    &engine.spatial,
                    &[parent],
                    node_type,
                    DEFAULT_NODE_WIDTH,
                    DEFAULT_NODE_HEIGHT,
                    0,
                )
            }
        }
    };

    let resolved_title = match title {
        Some(t) if !t.trim().is_empty() => t,
        _ => match node_type {
            NodeType::Core => "Core Concept".to_owned(),
            NodeType::Branch => "Branch".to_owned(),
            NodeType::Loophole => "Loophole".to_owned(),
            NodeType::Probe => "Probe".to_owned(),
            NodeType::Synthesis => "Synthesis".to_owned(),
        },
    };

    let now = now_epoch_ms();
    let new_id = format!("node_{}", ulid::Ulid::new());
    let content = String::new();
    let content_hash = compute_content_hash(&resolved_title, &content);
    let token_count = estimate_tokens(&format!("{resolved_title}\n{content}"));

    let node = NodeDto {
        id: new_id.clone(),
        node_type,
        status: NodeStatus::Active,
        title: resolved_title,
        content,
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
        created_at: now,
        updated_at: now,
    };

    let (source_id, target_id) = match edge_type {
        EdgeType::Challenges | EdgeType::Resolves => (new_id.clone(), parent_id.to_owned()),
        EdgeType::Derives
        | EdgeType::Branches
        | EdgeType::Synthesizes
        | EdgeType::References => (parent_id.to_owned(), new_id.clone()),
    };

    let edge = EdgeDto {
        id: format!("edge_{}", ulid::Ulid::new()),
        source_id,
        target_id,
        edge_type,
        weight: EdgeWeight::Summary,
        created_at: now,
    };

    let (apply_res, _) = apply_ops(
        conn,
        engine,
        &[
            GraphOp::CreateNode { node: node.clone() },
            GraphOp::CreateEdge { edge: edge.clone() },
        ],
    )?;

    let persisted_node = apply_res
        .updated_nodes
        .into_iter()
        .find(|n| n.id == new_id)
        .unwrap_or(node);

    Ok((persisted_node, edge))
}

#[derive(Default)]
struct SearchFilters {
    status: Option<NodeStatus>,
    node_type: Option<NodeType>,
    severity: Option<Severity>,
    pinned: Option<bool>,
    excluded: Option<bool>,
    fts_terms: Vec<String>,
}

fn sanitize_fts_tokens(raw: &str, out: &mut Vec<String>) {
    let mut current = String::new();
    for ch in raw.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            for lc in ch.to_lowercase() {
                current.push(lc);
            }
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
}

fn parse_bool_filter(val: &str) -> Option<bool> {
    if val.eq_ignore_ascii_case("true") || val == "1" {
        Some(true)
    } else if val.eq_ignore_ascii_case("false") || val == "0" {
        Some(false)
    } else {
        None
    }
}

fn parse_search_query(query: &str) -> SearchFilters {
    let mut filters = SearchFilters::default();

    for token in query.split_whitespace() {
        if let Some(val) = token.strip_prefix("status:") {
            if let Ok(status) = NodeStatus::from_db_str(&val.to_lowercase()) {
                filters.status = Some(status);
                continue;
            }
        }
        if let Some(val) = token.strip_prefix("type:") {
            if let Ok(nt) = NodeType::from_db_str(&val.to_lowercase()) {
                filters.node_type = Some(nt);
                continue;
            }
        }
        if let Some(val) = token.strip_prefix("severity:") {
            if let Ok(sev) = Severity::from_db_str(&val.to_lowercase()) {
                filters.severity = Some(sev);
                continue;
            }
        }
        if let Some(val) = token.strip_prefix("pinned:") {
            if let Some(b) = parse_bool_filter(val) {
                filters.pinned = Some(b);
                continue;
            }
        }
        if let Some(val) = token.strip_prefix("excluded:") {
            if let Some(b) = parse_bool_filter(val) {
                filters.excluded = Some(b);
                continue;
            }
        }

        sanitize_fts_tokens(token, &mut filters.fts_terms);
    }

    filters
}

fn row_to_search_hit(row: &Row<'_>) -> rusqlite::Result<SearchHit> {
    let type_str: String = row.get(2)?;
    let status_str: String = row.get(3)?;
    let sev_opt: Option<String> = row.get(4)?;

    let node_type = NodeType::from_db_str(&type_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let status = NodeStatus::from_db_str(&status_str).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let severity = match sev_opt {
        Some(ref s) => Some(Severity::from_db_str(s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
        })?),
        None => None,
    };

    Ok(SearchHit {
        id: row.get(0)?,
        title: row.get(1)?,
        node_type,
        status,
        severity,
        snippet: row.get(5)?,
        x: row.get(6)?,
        y: row.get(7)?,
    })
}

pub fn search_nodes(
    conn: &Connection,
    query: &str,
    limit: u32,
) -> Result<Vec<SearchHit>, IpcError> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let filters = parse_search_query(query);
    let mut where_clauses: Vec<String> = Vec::new();
    let mut sql_params: Vec<Value> = Vec::new();

    if !filters.fts_terms.is_empty() {
        let mut fts_query = String::new();
        let last_idx = filters.fts_terms.len() - 1;
        for (idx, term) in filters.fts_terms.iter().enumerate() {
            if idx > 0 {
                fts_query.push(' ');
            }
            fts_query.push_str(term);
            if idx == last_idx {
                fts_query.push('*');
            }
        }
        sql_params.push(Value::Text(fts_query));
        where_clauses.push(format!("nodes_fts MATCH ?{}", sql_params.len()));
    }

    if let Some(status) = filters.status {
        sql_params.push(Value::Text(status.as_str().to_owned()));
        where_clauses.push(format!("n.status = ?{}", sql_params.len()));
    }
    if let Some(node_type) = filters.node_type {
        sql_params.push(Value::Text(node_type.as_str().to_owned()));
        where_clauses.push(format!("n.type = ?{}", sql_params.len()));
    }
    if let Some(severity) = filters.severity {
        sql_params.push(Value::Text(severity.as_str().to_owned()));
        where_clauses.push(format!("n.severity = ?{}", sql_params.len()));
    }
    if let Some(pinned) = filters.pinned {
        sql_params.push(Value::Integer(i64::from(pinned)));
        where_clauses.push(format!("n.pin_global = ?{}", sql_params.len()));
    }
    if let Some(excluded) = filters.excluded {
        sql_params.push(Value::Integer(i64::from(excluded)));
        where_clauses.push(format!("n.exclude_from_ai = ?{}", sql_params.len()));
    }

    sql_params.push(Value::Integer(i64::from(limit)));
    let limit_param = sql_params.len();

    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_clauses.join(" AND "))
    };

    let sql = if !filters.fts_terms.is_empty() {
        format!(
            "SELECT n.id, n.title, n.type, n.status, n.severity,
                    COALESCE(NULLIF(snippet(nodes_fts, -1, '', '', '...', 16), ''), substr(n.content, 1, 120)),
                    n.x, n.y
             FROM nodes_fts
             JOIN nodes n ON n.rowid = nodes_fts.rowid
             {where_sql}
             ORDER BY bm25(nodes_fts, 4.0, 1.0, 2.0) ASC, n.updated_at DESC
             LIMIT ?{limit_param}"
        )
    } else {
        format!(
            "SELECT n.id, n.title, n.type, n.status, n.severity,
                    substr(CASE WHEN n.summary != '' THEN n.summary ELSE n.content END, 1, 120),
                    n.x, n.y
             FROM nodes n
             {where_sql}
             ORDER BY
                CASE n.severity
                    WHEN 'critical' THEN 4
                    WHEN 'high' THEN 3
                    WHEN 'medium' THEN 2
                    WHEN 'low' THEN 1
                    ELSE 0
                END DESC,
                n.updated_at DESC
             LIMIT ?{limit_param}"
        )
    };

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(sql_params.iter()), row_to_search_hit)?;
    let mut hits = Vec::new();
    for row in rows {
        hits.push(row?);
    }
    Ok(hits)
}

pub fn save_camera(conn: &mut Connection, camera: &CameraState) -> Result<(), IpcError> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let entries = [
        ("camera_x", camera.x.to_string()),
        ("camera_y", camera.y.to_string()),
        ("camera_zoom", camera.zoom.to_string()),
        (
            "last_focus_id",
            camera.last_focus_id.clone().unwrap_or_default(),
        ),
    ];
    for (key, value) in entries {
        tx.execute(
            "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn update_node_summary(
    conn: &mut Connection,
    engine: &mut GraphEngine,
    node_id: &str,
    expected_content_hash: &str,
    summary: &str,
    summary_hash: &str,
) -> Result<bool, IpcError> {
    let Some(existing) = engine.nodes.get(node_id) else {
        return Ok(false);
    };
    if existing.content_hash != expected_content_hash {
        return Ok(false);
    }

    let now = now_epoch_ms();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let affected = tx.execute(
        "UPDATE nodes SET summary = ?1, summary_hash = ?2, updated_at = ?3
         WHERE id = ?4 AND content_hash = ?5",
        params![summary, summary_hash, now, node_id, expected_content_hash],
    )?;
    if affected == 0 {
        tx.rollback()?;
        return Ok(false);
    }
    tx.commit()?;

    if let Some(node) = engine.nodes.get_mut(node_id) {
        node.summary = summary.to_owned();
        node.summary_hash = summary_hash.to_owned();
        node.updated_at = now;
    }

    Ok(true)
}

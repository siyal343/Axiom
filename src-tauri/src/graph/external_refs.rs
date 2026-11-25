use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};

use crate::db::queries::apply_ops;
use crate::db::row_to_node_dto;
use crate::error::IpcError;
use crate::graph::models::{
    compute_content_hash, estimate_tokens, now_epoch_ms, ContextControls, CreatedBy, EdgeDto,
    EdgeType, EdgeWeight, ExternalRefInfo, ExternalRefStatusKind, GraphOp, NodeDto, NodeLayout,
    NodeLensOrigin, NodeMetadata, NodeStatus, PullExternalRefResult,
};
use crate::graph::spatial::find_free_position;
use crate::graph::GraphEngine;

const SELECT_NODE_SQL: &str = "SELECT id, type, status, title, content, summary, content_hash, summary_hash,
        severity, lens, created_by, model, token_count,
        pin_global, exclude_from_ai, x, y, width, height, collapsed,
        created_at, updated_at
 FROM nodes
 WHERE id = ?1";

fn open_readonly_db(path: &Path) -> Result<Connection, IpcError> {
    if !path.exists() {
        return Err(IpcError::validation(format!(
            "Source flow database '{}' does not exist",
            path.display()
        )));
    }
    let ro_conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let _ = ro_conn.busy_timeout(Duration::from_millis(1000));
    Ok(ro_conn)
}

fn read_source_node(ro_conn: &Connection, source_node_id: &str) -> Result<Option<NodeDto>, IpcError> {
    let node = ro_conn
        .query_row(SELECT_NODE_SQL, params![source_node_id], row_to_node_dto)
        .optional()?;
    Ok(node)
}

#[allow(clippy::too_many_arguments)]
pub fn pull_external_reference(
    conn: &mut Connection,
    engine: &mut GraphEngine,
    source_workspace_id: &str,
    source_flow_id: &str,
    source_flow_name: &str,
    source_db_path: &Path,
    source_node_id: &str,
    attach_to_node_id: Option<&str>,
) -> Result<PullExternalRefResult, IpcError> {
    let trimmed_source_id = source_node_id.trim();
    if trimmed_source_id.is_empty() {
        return Err(IpcError::validation("Source node id cannot be empty"));
    }

    let source = {
        let ro_conn = open_readonly_db(source_db_path)?;
        read_source_node(&ro_conn, trimmed_source_id)?.ok_or_else(|| {
            IpcError::validation(format!(
                "Source node '{trimmed_source_id}' not found in flow '{source_flow_name}'"
            ))
        })?
    };

    let attach_id = attach_to_node_id
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(parent_id) = attach_id {
        if !engine.nodes.contains_key(parent_id) {
            return Err(IpcError::validation(format!(
                "Attachment target node '{parent_id}' not found"
            )));
        }
    }

    let width = source.layout.width.max(240.0);
    let height = source.layout.height.max(140.0);
    let anchors: Vec<&NodeDto> = match attach_id.and_then(|id| engine.nodes.get(id)) {
        Some(parent) => vec![parent],
        None => Vec::new(),
    };
    let (x, y) = find_free_position(&engine.spatial, &anchors, source.node_type, width, height, 0);

    let now = now_epoch_ms();
    let local_id = format!("node_{}", ulid::Ulid::new());
    let synced_hash = source.content_hash.clone();
    let token_count = if source.metadata.token_count > 0 {
        source.metadata.token_count
    } else {
        estimate_tokens(&format!("{}\n{}", source.title, source.content))
    };

    let local_node = NodeDto {
        id: local_id.clone(),
        node_type: source.node_type,
        status: NodeStatus::Active,
        title: source.title.clone(),
        content: source.content.clone(),
        summary: source.summary.clone(),
        content_hash: synced_hash.clone(),
        summary_hash: source.summary_hash.clone(),
        metadata: NodeMetadata {
            severity: source.metadata.severity,
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
            width,
            height,
            collapsed: false,
        },
        created_at: now,
        updated_at: now,
    };

    let created_edge = attach_id.map(|parent_id| EdgeDto {
        id: format!("edge_{}", ulid::Ulid::new()),
        source_id: parent_id.to_owned(),
        target_id: local_id.clone(),
        edge_type: EdgeType::References,
        weight: EdgeWeight::Summary,
        created_at: now,
    });

    let mut ops = vec![GraphOp::CreateNode {
        node: local_node.clone(),
    }];
    if let Some(ref edge) = created_edge {
        ops.push(GraphOp::CreateEdge { edge: edge.clone() });
    }

    let (apply_res, _) = apply_ops(conn, engine, &ops)?;
    let persisted_node = apply_res
        .updated_nodes
        .into_iter()
        .find(|n| n.id == local_id)
        .unwrap_or(local_node);

    let source_db_str = source_db_path.to_string_lossy().into_owned();
    conn.execute(
        "INSERT INTO external_refs (
            local_node_id, source_workspace_id, source_flow_id, source_flow_name,
            source_db_path, source_node_id, synced_hash, synced_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            persisted_node.id,
            source_workspace_id,
            source_flow_id,
            source_flow_name,
            source_db_str,
            trimmed_source_id,
            synced_hash,
            now,
        ],
    )?;

    let external_ref = ExternalRefInfo {
        local_node_id: persisted_node.id.clone(),
        source_workspace_id: source_workspace_id.to_owned(),
        source_flow_id: source_flow_id.to_owned(),
        source_flow_name: source_flow_name.to_owned(),
        source_node_id: trimmed_source_id.to_owned(),
        synced_hash,
        synced_at: now,
        status: ExternalRefStatusKind::Synced,
        source_title: Some(source.title),
    };

    Ok(PullExternalRefResult {
        node: persisted_node,
        edge: created_edge,
        external_ref,
    })
}

struct StoredExternalRef {
    local_node_id: String,
    source_workspace_id: String,
    source_flow_id: String,
    source_flow_name: String,
    source_db_path: String,
    source_node_id: String,
    synced_hash: String,
    synced_at: i64,
}

pub fn compute_external_ref_statuses(
    conn: &Connection,
    engine: &GraphEngine,
) -> Result<Vec<ExternalRefInfo>, IpcError> {
    let stored_rows: Vec<StoredExternalRef> = {
        let mut stmt = conn.prepare(
            "SELECT local_node_id, source_workspace_id, source_flow_id, source_flow_name,
                    source_db_path, source_node_id, synced_hash, synced_at
             FROM external_refs
             ORDER BY local_node_id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(StoredExternalRef {
                local_node_id: row.get(0)?,
                source_workspace_id: row.get(1)?,
                source_flow_id: row.get(2)?,
                source_flow_name: row.get(3)?,
                source_db_path: row.get(4)?,
                source_node_id: row.get(5)?,
                synced_hash: row.get(6)?,
                synced_at: row.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let item = row?;
            if engine.nodes.contains_key(&item.local_node_id) {
                out.push(item);
            }
        }
        out
    };

    if stored_rows.is_empty() {
        return Ok(Vec::new());
    }

    let mut by_db_path: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, row) in stored_rows.iter().enumerate() {
        by_db_path
            .entry(row.source_db_path.clone())
            .or_default()
            .push(idx);
    }

    let mut statuses: Vec<Option<(ExternalRefStatusKind, Option<String>)>> =
        vec![None; stored_rows.len()];

    for (db_path, indices) in by_db_path {
        let Ok(ro_conn) = open_readonly_db(Path::new(&db_path)) else {
            for idx in indices {
                statuses[idx] = Some((ExternalRefStatusKind::SourceMissing, None));
            }
            continue;
        };

        let Ok(mut stmt) = ro_conn.prepare("SELECT title, content_hash FROM nodes WHERE id = ?1")
        else {
            for idx in indices {
                statuses[idx] = Some((ExternalRefStatusKind::SourceMissing, None));
            }
            continue;
        };

        for idx in indices {
            let row = &stored_rows[idx];
            let found = stmt
                .query_row(params![row.source_node_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .optional()
                .ok()
                .flatten();
            statuses[idx] = Some(match found {
                Some((title, content_hash)) => {
                    let kind = if content_hash == row.synced_hash {
                        ExternalRefStatusKind::Synced
                    } else {
                        ExternalRefStatusKind::OutOfSync
                    };
                    (kind, Some(title))
                }
                None => (ExternalRefStatusKind::SourceMissing, None),
            });
        }
    }

    let mut out = Vec::with_capacity(stored_rows.len());
    for (idx, row) in stored_rows.into_iter().enumerate() {
        let (status, source_title) = statuses[idx]
            .take()
            .unwrap_or((ExternalRefStatusKind::SourceMissing, None));
        out.push(ExternalRefInfo {
            local_node_id: row.local_node_id,
            source_workspace_id: row.source_workspace_id,
            source_flow_id: row.source_flow_id,
            source_flow_name: row.source_flow_name,
            source_node_id: row.source_node_id,
            synced_hash: row.synced_hash,
            synced_at: row.synced_at,
            status,
            source_title,
        });
    }

    Ok(out)
}

pub fn sync_external_ref(
    conn: &mut Connection,
    engine: &mut GraphEngine,
    local_node_id: &str,
) -> Result<NodeDto, IpcError> {
    let mut updated = engine
        .nodes
        .get(local_node_id)
        .cloned()
        .ok_or_else(|| IpcError::validation(format!("Node '{local_node_id}' not found")))?;

    let (source_db_path, source_node_id): (String, String) = conn
        .query_row(
            "SELECT source_db_path, source_node_id FROM external_refs WHERE local_node_id = ?1",
            params![local_node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| {
            IpcError::validation(format!(
                "Node '{local_node_id}' does not have an external reference"
            ))
        })?;

    let source = {
        let ro_conn = open_readonly_db(Path::new(&source_db_path))?;
        read_source_node(&ro_conn, &source_node_id)?.ok_or_else(|| {
            IpcError::validation(format!(
                "Source node '{source_node_id}' is missing from '{source_db_path}'"
            ))
        })?
    };

    let now = now_epoch_ms();
    let content_hash = if source.content_hash.is_empty() {
        compute_content_hash(&source.title, &source.content)
    } else {
        source.content_hash.clone()
    };
    let token_count = if source.metadata.token_count > 0 {
        source.metadata.token_count
    } else {
        estimate_tokens(&format!("{}\n{}", source.title, source.content))
    };

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let affected = tx.execute(
        "UPDATE nodes
         SET title = ?1, content = ?2, summary = ?3, content_hash = ?4,
             summary_hash = ?5, token_count = ?6, updated_at = ?7
         WHERE id = ?8",
        params![
            source.title,
            source.content,
            source.summary,
            content_hash,
            source.summary_hash,
            i64::from(token_count),
            now,
            local_node_id,
        ],
    )?;
    if affected == 0 {
        return Err(IpcError::validation(format!(
            "Local node '{local_node_id}' not found in database"
        )));
    }
    tx.execute(
        "UPDATE external_refs SET synced_hash = ?1, synced_at = ?2 WHERE local_node_id = ?3",
        params![content_hash, now, local_node_id],
    )?;
    tx.commit()?;

    updated.title = source.title;
    updated.content = source.content;
    updated.summary = source.summary;
    updated.content_hash = content_hash;
    updated.summary_hash = source.summary_hash;
    updated.metadata.token_count = token_count;
    updated.updated_at = now;

    engine.upsert_node(updated.clone());
    Ok(updated)
}

pub fn detach_external_ref(conn: &mut Connection, local_node_id: &str) -> Result<(), IpcError> {
    conn.execute(
        "DELETE FROM external_refs WHERE local_node_id = ?1",
        params![local_node_id],
    )?;
    Ok(())
}

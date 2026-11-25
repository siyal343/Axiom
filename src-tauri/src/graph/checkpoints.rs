use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::db::queries::{insert_edge_tx, insert_node_tx};
use crate::error::IpcError;
use crate::graph::models::{
    now_epoch_ms, CameraState, CheckpointDiff, CheckpointNodeChange, CheckpointSummary, EdgeDto,
    EdgeType, NodeDto, WorkspaceSnapshot,
};
use crate::graph::GraphEngine;
use crate::ipc::ActiveWorkspace;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckpointPayload {
    nodes: Vec<NodeDto>,
    edges: Vec<EdgeDto>,
    system_prompt: String,
    token_budget: u32,
}

pub fn create_checkpoint(
    conn: &mut Connection,
    engine: &GraphEngine,
    system_prompt: &str,
    token_budget: u32,
    name: &str,
    note: &str,
) -> Result<CheckpointSummary, IpcError> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err(IpcError::validation("Checkpoint name cannot be empty"));
    }

    let nodes = engine.all_nodes_sorted();
    let edges = engine.all_edges_sorted();
    let node_count = nodes.len();
    let edge_count = edges.len();

    let payload = CheckpointPayload {
        nodes,
        edges,
        system_prompt: system_prompt.to_owned(),
        token_budget,
    };
    let snapshot_json = serde_json::to_string(&payload)?;
    let id = format!("ckpt_{}", ulid::Ulid::new());
    let created_at = now_epoch_ms();
    let trimmed_note = note.trim().to_owned();

    conn.execute(
        "INSERT INTO checkpoints (id, name, note, snapshot_json, node_count, edge_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            trimmed_name,
            trimmed_note,
            snapshot_json,
            i64::try_from(node_count).unwrap_or(i64::MAX),
            i64::try_from(edge_count).unwrap_or(i64::MAX),
            created_at,
        ],
    )?;

    Ok(CheckpointSummary {
        id,
        name: trimmed_name.to_owned(),
        note: trimmed_note,
        node_count,
        edge_count,
        created_at,
    })
}

pub fn list_checkpoints(conn: &Connection) -> Result<Vec<CheckpointSummary>, IpcError> {
    let mut stmt = conn.prepare(
        "SELECT id, name, note, node_count, edge_count, created_at
         FROM checkpoints
         ORDER BY created_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let node_count_raw: i64 = row.get(3)?;
        let edge_count_raw: i64 = row.get(4)?;
        Ok(CheckpointSummary {
            id: row.get(0)?,
            name: row.get(1)?,
            note: row.get(2)?,
            node_count: usize::try_from(node_count_raw).unwrap_or(0),
            edge_count: usize::try_from(edge_count_raw).unwrap_or(0),
            created_at: row.get(5)?,
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn load_checkpoint_payload(
    conn: &Connection,
    checkpoint_id: &str,
) -> Result<(String, CheckpointPayload), IpcError> {
    let found: Option<(String, String)> = conn
        .query_row(
            "SELECT name, snapshot_json FROM checkpoints WHERE id = ?1",
            params![checkpoint_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (name, snapshot_json) = found.ok_or_else(|| {
        IpcError::validation(format!("Checkpoint '{checkpoint_id}' not found"))
    })?;
    let payload: CheckpointPayload = serde_json::from_str(&snapshot_json)?;
    Ok((name, payload))
}

pub fn diff_checkpoint(
    conn: &Connection,
    engine: &GraphEngine,
    checkpoint_id: &str,
) -> Result<CheckpointDiff, IpcError> {
    let (checkpoint_name, payload) = load_checkpoint_payload(conn, checkpoint_id)?;

    let saved_nodes: HashMap<&str, &NodeDto> = payload
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), n))
        .collect();

    let mut added_nodes = Vec::new();
    let mut removed_nodes = Vec::new();
    let mut modified_nodes = Vec::new();

    for (id, current) in &engine.nodes {
        match saved_nodes.get(id.as_str()) {
            None => added_nodes.push(CheckpointNodeChange {
                node_id: id.clone(),
                title: current.title.clone(),
                node_type: current.node_type,
                changes: vec!["added".to_owned()],
            }),
            Some(saved) => {
                let mut changes = Vec::new();
                if saved.title != current.title {
                    changes.push("title".to_owned());
                }
                if saved.content != current.content {
                    changes.push("content".to_owned());
                }
                if saved.status != current.status {
                    changes.push("status".to_owned());
                }
                if saved.node_type != current.node_type {
                    changes.push("type".to_owned());
                }
                if saved.context_controls.pin_global != current.context_controls.pin_global {
                    changes.push("pin_global".to_owned());
                }
                if saved.context_controls.exclude_from_ai
                    != current.context_controls.exclude_from_ai
                {
                    changes.push("exclude_from_ai".to_owned());
                }
                if !changes.is_empty() {
                    modified_nodes.push(CheckpointNodeChange {
                        node_id: id.clone(),
                        title: current.title.clone(),
                        node_type: current.node_type,
                        changes,
                    });
                }
            }
        }
    }

    for saved in &payload.nodes {
        if !engine.nodes.contains_key(&saved.id) {
            removed_nodes.push(CheckpointNodeChange {
                node_id: saved.id.clone(),
                title: saved.title.clone(),
                node_type: saved.node_type,
                changes: vec!["removed".to_owned()],
            });
        }
    }

    added_nodes.sort_by(|a, b| a.node_id.cmp(&b.node_id));
    removed_nodes.sort_by(|a, b| a.node_id.cmp(&b.node_id));
    modified_nodes.sort_by(|a, b| a.node_id.cmp(&b.node_id));

    let saved_triples: HashSet<(&str, &str, EdgeType)> = payload
        .edges
        .iter()
        .map(|e| (e.source_id.as_str(), e.target_id.as_str(), e.edge_type))
        .collect();
    let current_triples: HashSet<(&str, &str, EdgeType)> = engine
        .outgoing
        .values()
        .flatten()
        .map(|e| (e.source_id.as_str(), e.target_id.as_str(), e.edge_type))
        .collect();

    let added_edges_count = current_triples.difference(&saved_triples).count();
    let removed_edges_count = saved_triples.difference(&current_triples).count();

    Ok(CheckpointDiff {
        checkpoint_id: checkpoint_id.to_owned(),
        checkpoint_name,
        added_nodes,
        removed_nodes,
        modified_nodes,
        added_edges_count,
        removed_edges_count,
    })
}

fn read_camera_state(conn: &Connection) -> Result<CameraState, IpcError> {
    let mut stmt = conn.prepare(
        "SELECT key, value FROM workspace_meta
         WHERE key IN ('camera_x', 'camera_y', 'camera_zoom', 'last_focus_id')",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    Ok(CameraState {
        x: map
            .get("camera_x")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0),
        y: map
            .get("camera_y")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0),
        zoom: map
            .get("camera_zoom")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(1.0),
        last_focus_id: map
            .get("last_focus_id")
            .filter(|v| !v.is_empty())
            .cloned(),
    })
}

pub fn restore_checkpoint(
    conn: &mut Connection,
    active: &mut ActiveWorkspace,
    checkpoint_id: &str,
) -> Result<WorkspaceSnapshot, IpcError> {
    let (target_name, payload) = load_checkpoint_payload(conn, checkpoint_id)?;

    create_checkpoint(
        conn,
        &active.engine,
        &active.system_prompt,
        active.token_budget,
        &format!("Auto-backup before restore: {target_name}"),
        "",
    )?;

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("DELETE FROM edges", [])?;
    tx.execute("DELETE FROM nodes", [])?;

    for node in &payload.nodes {
        insert_node_tx(&tx, node)?;
    }
    for edge in &payload.edges {
        insert_edge_tx(&tx, edge)?;
    }

    tx.execute(
        "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('system_prompt', ?1)",
        params![payload.system_prompt],
    )?;
    tx.execute(
        "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('token_budget', ?1)",
        params![payload.token_budget.to_string()],
    )?;
    tx.execute("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')", [])?;
    tx.commit()?;

    active.engine = GraphEngine::from_snapshot(&payload.nodes, &payload.edges);
    active.system_prompt = payload.system_prompt.clone();
    active.token_budget = payload.token_budget;

    let camera = read_camera_state(conn)?;
    Ok(WorkspaceSnapshot {
        path: active.path.clone(),
        nodes: payload.nodes,
        edges: payload.edges,
        camera,
        token_budget: payload.token_budget,
        system_prompt: payload.system_prompt,
    })
}

pub fn delete_checkpoint(conn: &mut Connection, checkpoint_id: &str) -> Result<(), IpcError> {
    conn.execute("DELETE FROM checkpoints WHERE id = ?1", params![checkpoint_id])?;
    Ok(())
}

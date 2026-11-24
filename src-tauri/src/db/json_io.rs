use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::db::queries::{insert_edge_tx, insert_node_tx};
use crate::db::{open_connection, row_to_edge_dto, row_to_node_dto};
use crate::error::IpcError;
use crate::graph::models::{now_epoch_ms, CameraState, EdgeDto, NodeDto, WorkspaceSnapshot};

const AXIOM_EXPORT_FORMAT: &str = "axiom-workspace";
const AXIOM_EXPORT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceJsonMeta {
    camera: CameraState,
    token_budget: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AxiomWorkspaceJson {
    format: String,
    version: u32,
    exported_at: i64,
    meta: WorkspaceJsonMeta,
    nodes: Vec<NodeDto>,
    edges: Vec<EdgeDto>,
}

fn read_workspace_meta(conn: &Connection) -> Result<WorkspaceJsonMeta, IpcError> {
    let mut stmt = conn.prepare("SELECT key, value FROM workspace_meta")?;
    let rows = stmt.query_map([], |row| {
        let k: String = row.get(0)?;
        let v: String = row.get(1)?;
        Ok((k, v))
    })?;
    let mut map = HashMap::new();
    for pair in rows {
        let (k, v) = pair?;
        map.insert(k, v);
    }

    let x = map
        .get("camera_x")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let y = map
        .get("camera_y")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let zoom = map
        .get("camera_zoom")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(1.0);
    let last_focus_id = map
        .get("last_focus_id")
        .filter(|v| !v.is_empty())
        .cloned();
    let token_budget = map
        .get("token_budget")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(6000);

    Ok(WorkspaceJsonMeta {
        camera: CameraState {
            x,
            y,
            zoom,
            last_focus_id,
        },
        token_budget,
    })
}

pub fn export_json(conn: &Connection, dest_path: &Path) -> Result<(), IpcError> {
    let meta = read_workspace_meta(conn)?;

    let nodes: Vec<NodeDto> = {
        let mut stmt = conn.prepare(
            "SELECT id, type, status, title, content, summary, content_hash, summary_hash,
                    severity, lens, created_by, model, token_count,
                    pin_global, exclude_from_ai, x, y, width, height, collapsed,
                    created_at, updated_at
             FROM nodes
             ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([], row_to_node_dto)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        out
    };

    let edges: Vec<EdgeDto> = {
        let mut stmt = conn.prepare(
            "SELECT id, source_id, target_id, type, weight, created_at
             FROM edges
             ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([], row_to_edge_dto)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        out
    };

    let payload = AxiomWorkspaceJson {
        format: AXIOM_EXPORT_FORMAT.to_owned(),
        version: AXIOM_EXPORT_VERSION,
        exported_at: now_epoch_ms(),
        meta,
        nodes,
        edges,
    };

    let json = serde_json::to_string_pretty(&payload)?;

    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let file_stem = dest_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("export.json");
    let tmp_path = dest_path.with_file_name(format!(".{file_stem}.{}.tmp", ulid::Ulid::new()));

    {
        let mut file = std::fs::File::create(&tmp_path)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
    }

    if let Err(err) = std::fs::rename(&tmp_path, dest_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(err.into());
    }

    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), IpcError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

fn validate_workspace_json(doc: &AxiomWorkspaceJson) -> Result<(), IpcError> {
    if doc.format != AXIOM_EXPORT_FORMAT {
        return Err(IpcError::validation(format!(
            "Invalid export format '{}', expected '{}'",
            doc.format, AXIOM_EXPORT_FORMAT
        )));
    }
    if doc.version != AXIOM_EXPORT_VERSION {
        return Err(IpcError::validation(format!(
            "Unsupported export version {}, expected {}",
            doc.version, AXIOM_EXPORT_VERSION
        )));
    }

    let mut node_ids: HashSet<&str> = HashSet::with_capacity(doc.nodes.len());
    for node in &doc.nodes {
        if node.id.trim().is_empty() {
            return Err(IpcError::validation("Node id cannot be empty"));
        }
        if !node_ids.insert(node.id.as_str()) {
            return Err(IpcError::validation(format!(
                "Duplicate node id '{}' in import payload",
                node.id
            )));
        }
    }

    let mut edge_ids: HashSet<&str> = HashSet::with_capacity(doc.edges.len());
    let mut edge_triples: HashSet<(&str, &str, &str)> = HashSet::with_capacity(doc.edges.len());
    for edge in &doc.edges {
        if edge.id.trim().is_empty() {
            return Err(IpcError::validation("Edge id cannot be empty"));
        }
        if !edge_ids.insert(edge.id.as_str()) {
            return Err(IpcError::validation(format!(
                "Duplicate edge id '{}' in import payload",
                edge.id
            )));
        }
        if edge.source_id == edge.target_id {
            return Err(IpcError::validation(format!(
                "Edge '{}' forms a self-loop on node '{}'",
                edge.id, edge.source_id
            )));
        }
        if !node_ids.contains(edge.source_id.as_str()) {
            return Err(IpcError::validation(format!(
                "Edge '{}' references missing source_id '{}'",
                edge.id, edge.source_id
            )));
        }
        if !node_ids.contains(edge.target_id.as_str()) {
            return Err(IpcError::validation(format!(
                "Edge '{}' references missing target_id '{}'",
                edge.id, edge.target_id
            )));
        }
        let triple = (
            edge.source_id.as_str(),
            edge.target_id.as_str(),
            edge.edge_type.as_str(),
        );
        if !edge_triples.insert(triple) {
            return Err(IpcError::duplicate_edge(format!(
                "Duplicate edge ({}, {}, {}) in import payload",
                edge.source_id,
                edge.target_id,
                edge.edge_type.as_str()
            )));
        }
    }

    Ok(())
}

pub fn import_json(
    src_path: &Path,
    dest_sqlite_path: &Path,
) -> Result<WorkspaceSnapshot, IpcError> {
    let raw = std::fs::read_to_string(src_path)?;
    let doc: AxiomWorkspaceJson = serde_json::from_str(&raw)?;

    validate_workspace_json(&doc)?;

    let wal_path = PathBuf::from(format!("{}-wal", dest_sqlite_path.to_string_lossy()));
    let shm_path = PathBuf::from(format!("{}-shm", dest_sqlite_path.to_string_lossy()));
    remove_if_exists(dest_sqlite_path)?;
    remove_if_exists(&wal_path)?;
    remove_if_exists(&shm_path)?;

    let mut conn = open_connection(dest_sqlite_path)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let meta_pairs = [
        ("schema_version", "1".to_owned()),
        ("camera_x", doc.meta.camera.x.to_string()),
        ("camera_y", doc.meta.camera.y.to_string()),
        ("camera_zoom", doc.meta.camera.zoom.to_string()),
        (
            "last_focus_id",
            doc.meta.camera.last_focus_id.clone().unwrap_or_default(),
        ),
        ("token_budget", doc.meta.token_budget.to_string()),
    ];
    for (key, value) in meta_pairs {
        tx.execute(
            "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }

    for node in &doc.nodes {
        insert_node_tx(&tx, node)?;
    }
    for edge in &doc.edges {
        insert_edge_tx(&tx, edge)?;
    }

    tx.commit()?;

    Ok(WorkspaceSnapshot {
        path: dest_sqlite_path.to_string_lossy().into_owned(),
        nodes: doc.nodes,
        edges: doc.edges,
        camera: doc.meta.camera,
        token_budget: doc.meta.token_budget,
    })
}

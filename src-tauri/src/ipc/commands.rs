use std::path::{Path, PathBuf};

use crate::db;
use crate::error::IpcError;
use crate::graph::compiler::compile_context;
use crate::graph::models::{
    ApplyResult, CameraState, CompiledXray, EdgeType, GraphOp, NodePositionUpdate, NodeType,
    SearchHit, SpawnConnectedResult, WorkspaceSnapshot,
};
use crate::graph::spatial::compute_tidy_subtree;
use crate::graph::GraphEngine;
use crate::ipc::{ActiveWorkspace, AppState};

#[tauri::command]
pub fn open_workspace(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, IpcError> {
    let resolved_path = if path.trim().is_empty() {
        db::default_workspace_path()?
    } else {
        PathBuf::from(path.trim())
    };
    let path_str = resolved_path.to_string_lossy().into_owned();

    let mut conn = db::open_connection(&resolved_path)?;
    let snapshot = db::hydrate_or_seed_workspace(&mut conn, &path_str)?;
    let engine = GraphEngine::from_snapshot(&snapshot.nodes, &snapshot.edges);

    // Canonical lock ordering: ALWAYS acquire workspace lock BEFORE db lock.
    let mut workspace_guard = state
        .workspace
        .write()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let mut db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;

    *workspace_guard = Some(ActiveWorkspace {
        path: path_str,
        engine,
        token_budget: snapshot.token_budget,
    });
    *db_guard = Some(conn);

    Ok(snapshot)
}

#[tauri::command]
pub fn apply_ops(
    ops: Vec<GraphOp>,
    state: tauri::State<'_, AppState>,
) -> Result<ApplyResult, IpcError> {
    // Canonical lock ordering: workspace BEFORE db.
    let mut workspace_guard = state
        .workspace
        .write()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let mut db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;

    let active = workspace_guard
        .as_mut()
        .ok_or_else(IpcError::workspace_not_open)?;
    let conn = db_guard
        .as_mut()
        .ok_or_else(IpcError::workspace_not_open)?;

    let (result, summary_ids) = db::queries::apply_ops(conn, &mut active.engine, &ops)?;
    for id in summary_ids {
        let _ = state.summary_tx.send(id);
    }

    Ok(result)
}

#[tauri::command]
pub fn spawn_connected_node(
    parent_id: String,
    edge_type: EdgeType,
    node_type: NodeType,
    title: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<SpawnConnectedResult, IpcError> {
    let mut workspace_guard = state
        .workspace
        .write()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let mut db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;

    let active = workspace_guard
        .as_mut()
        .ok_or_else(IpcError::workspace_not_open)?;
    let conn = db_guard
        .as_mut()
        .ok_or_else(IpcError::workspace_not_open)?;

    let (node, edge) = db::queries::spawn_connected_node(
        conn,
        &mut active.engine,
        &parent_id,
        edge_type,
        node_type,
        title,
    )?;
    if !node.context_controls.exclude_from_ai && node.content_hash != node.summary_hash {
        let _ = state.summary_tx.send(node.id.clone());
    }

    Ok(SpawnConnectedResult { node, edge })
}

#[tauri::command]
pub fn compile_xray(
    focus_ids: Vec<String>,
    token_budget: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<CompiledXray, IpcError> {
    let workspace_guard = state
        .workspace
        .read()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let active = workspace_guard
        .as_ref()
        .ok_or_else(IpcError::workspace_not_open)?;

    let budget = token_budget.unwrap_or(active.token_budget);
    let compiled = compile_context(&active.engine, &focus_ids, budget);
    Ok(compiled.xray)
}

#[tauri::command]
pub fn search_nodes(
    query: String,
    limit: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SearchHit>, IpcError> {
    let db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;
    let conn = db_guard
        .as_ref()
        .ok_or_else(IpcError::workspace_not_open)?;

    db::queries::search_nodes(conn, &query, limit.unwrap_or(30))
}

#[tauri::command]
pub fn tidy_subtree(
    root_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<NodePositionUpdate>, IpcError> {
    let mut workspace_guard = state
        .workspace
        .write()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let mut db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;

    let active = workspace_guard
        .as_mut()
        .ok_or_else(IpcError::workspace_not_open)?;
    let conn = db_guard
        .as_mut()
        .ok_or_else(IpcError::workspace_not_open)?;

    let updates = compute_tidy_subtree(&active.engine, &root_id)?;
    if !updates.is_empty() {
        db::queries::apply_ops(
            conn,
            &mut active.engine,
            &[GraphOp::MoveNodes {
                moves: updates.clone(),
            }],
        )?;
    }

    Ok(updates)
}

#[tauri::command]
pub fn save_camera(
    camera: CameraState,
    state: tauri::State<'_, AppState>,
) -> Result<(), IpcError> {
    let mut db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;
    let conn = db_guard
        .as_mut()
        .ok_or_else(IpcError::workspace_not_open)?;

    db::queries::save_camera(conn, &camera)
}

#[tauri::command]
pub fn export_json(
    dest_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), IpcError> {
    let db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;
    let conn = db_guard
        .as_ref()
        .ok_or_else(IpcError::workspace_not_open)?;

    db::json_io::export_json(conn, Path::new(dest_path.trim()))
}

#[tauri::command]
pub fn import_json(
    src_path: String,
    dest_sqlite_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, IpcError> {
    let dest_path = PathBuf::from(dest_sqlite_path.trim());

    let mut workspace_guard = state
        .workspace
        .write()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let mut db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;

    // Release any existing connection before overwriting destination SQLite/WAL files.
    *db_guard = None;
    *workspace_guard = None;

    let snapshot = db::json_io::import_json(Path::new(src_path.trim()), &dest_path)?;
    let conn = db::open_connection(&dest_path)?;
    let engine = GraphEngine::from_snapshot(&snapshot.nodes, &snapshot.edges);

    *workspace_guard = Some(ActiveWorkspace {
        path: snapshot.path.clone(),
        engine,
        token_budget: snapshot.token_budget,
    });
    *db_guard = Some(conn);

    Ok(snapshot)
}

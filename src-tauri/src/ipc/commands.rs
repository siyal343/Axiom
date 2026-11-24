use std::path::PathBuf;

use crate::db;
use crate::error::IpcError;
use crate::graph::models::WorkspaceSnapshot;
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
    });
    *db_guard = Some(conn);

    Ok(snapshot)
}

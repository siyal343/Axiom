use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use tokio_util::sync::CancellationToken;

use crate::ai;
use crate::ai::runner::{execute_lens_run, prepare_lens_context, LensRunParams};
use crate::db;
use crate::error::IpcError;
use crate::graph::compiler::compile_context;
use crate::graph::models::{
    AppSettingsDto, ApplyResult, CameraState, CompiledXray, EdgeType, GraphOp, LensKind,
    LensStreamEvent, NodePositionUpdate, NodeType, OpenFlowResult, SaveSettingsInput, SearchHit,
    SpawnConnectedResult, SpawnDirection, TestConnectionResult, WorkspaceCatalogDto,
    WorkspaceEntryDto, WorkspaceSnapshot,
};
use crate::graph::spatial::{
    compute_tidy_subtree, resolve_overlaps as compute_resolve_overlaps,
};
use crate::graph::GraphEngine;
use crate::ipc::{ActiveWorkspace, AppState};

fn open_workspace_internal(
    resolved_path: PathBuf,
    template_opt: Option<&str>,
    state: &AppState,
) -> Result<WorkspaceSnapshot, IpcError> {
    let path_str = resolved_path.to_string_lossy().into_owned();

    let mut conn = db::open_connection(&resolved_path)?;
    let mut snapshot = match template_opt {
        Some(tpl) => db::seed_flow_template(&mut conn, &path_str, tpl)?,
        None => db::hydrate_or_seed_workspace(&mut conn, &path_str)?,
    };
    let mut engine = GraphEngine::from_snapshot(&snapshot.nodes, &snapshot.edges);

    if (cfg!(debug_assertions) || cfg!(test))
        && state.seed_stress_on_open.swap(false, Ordering::SeqCst)
    {
        snapshot = db::stress::seed_stress_500_into_workspace(&mut conn, &mut engine, &path_str)?;
    }

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
pub fn open_workspace(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, IpcError> {
    let resolved_path = if path.trim().is_empty() {
        db::default_workspace_path()?
    } else {
        PathBuf::from(path.trim())
    };
    open_workspace_internal(resolved_path, None, &state)
}

#[tauri::command]
pub fn list_workspace_catalog(
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceCatalogDto, IpcError> {
    state.workspaces.load_or_init()
}

#[tauri::command]
pub fn create_workspace(
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceEntryDto, IpcError> {
    state.workspaces.create_workspace(&name)
}

#[tauri::command]
pub fn rename_workspace(
    workspace_id: String,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceCatalogDto, IpcError> {
    state.workspaces.rename_workspace(&workspace_id, &name)
}

#[tauri::command]
pub fn delete_workspace(
    workspace_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceCatalogDto, IpcError> {
    {
        // Canonical lock ordering: ALWAYS acquire workspace lock BEFORE db lock.
        let mut workspace_guard = state
            .workspace
            .write()
            .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
        let mut db_guard = state
            .db
            .lock()
            .map_err(|_| IpcError::db("Database lock poisoned"))?;
        let catalog_before = state.workspaces.load_or_init()?;
        let active_path = workspace_guard.as_ref().map(|w| w.path.clone());
        let matches_deleted = catalog_before
            .workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .is_some_and(|w| {
                active_path
                    .as_deref()
                    .is_some_and(|p| w.flows.iter().any(|f| f.db_path == p))
            });
        if matches_deleted {
            // Release SQLite handle before deleting files on Windows.
            *db_guard = None;
            *workspace_guard = None;
        }
    }

    state.workspaces.delete_workspace(&workspace_id)
}

#[tauri::command]
pub fn create_flow(
    workspace_id: String,
    name: String,
    template: String,
    state: tauri::State<'_, AppState>,
) -> Result<OpenFlowResult, IpcError> {
    let (catalog, flow) = state
        .workspaces
        .create_flow(&workspace_id, &name, &template)?;
    let snapshot =
        open_workspace_internal(PathBuf::from(&flow.db_path), Some(&flow.template), &state)?;
    Ok(OpenFlowResult { catalog, snapshot })
}

#[tauri::command]
pub fn open_flow(
    workspace_id: String,
    flow_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<OpenFlowResult, IpcError> {
    let (catalog, flow) = state.workspaces.set_active(&workspace_id, &flow_id)?;
    let snapshot =
        open_workspace_internal(PathBuf::from(&flow.db_path), Some(&flow.template), &state)?;
    Ok(OpenFlowResult { catalog, snapshot })
}

#[tauri::command]
pub fn rename_flow(
    workspace_id: String,
    flow_id: String,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceCatalogDto, IpcError> {
    state.workspaces.rename_flow(&workspace_id, &flow_id, &name)
}

#[tauri::command]
pub fn delete_flow(
    workspace_id: String,
    flow_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceCatalogDto, IpcError> {
    {
        let mut workspace_guard = state
            .workspace
            .write()
            .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
        let mut db_guard = state
            .db
            .lock()
            .map_err(|_| IpcError::db("Database lock poisoned"))?;
        let catalog_before = state.workspaces.load_or_init()?;
        let active_path = workspace_guard.as_ref().map(|w| w.path.clone());
        let matches_deleted = catalog_before
            .workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .and_then(|w| w.flows.iter().find(|f| f.id == flow_id))
            .is_some_and(|f| active_path.as_deref() == Some(f.db_path.as_str()));
        if matches_deleted {
            *db_guard = None;
            *workspace_guard = None;
        }
    }

    state.workspaces.delete_flow(&workspace_id, &flow_id)
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
    direction: Option<SpawnDirection>,
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
        direction,
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
pub fn resolve_overlaps(
    pinned_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<NodePositionUpdate>, IpcError> {
    // Canonical lock ordering: ALWAYS acquire workspace lock BEFORE db lock.
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

    let pinned_set: HashSet<String> = pinned_ids.into_iter().collect();
    let updates = compute_resolve_overlaps(&active.engine, &pinned_set);
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

#[tauri::command]
pub fn run_lens(
    lens: LensKind,
    focus_ids: Vec<String>,
    custom_prompt: Option<String>,
    on_event: tauri::ipc::Channel<LensStreamEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<String, IpcError> {
    let token_budget = {
        let ws_guard = state
            .workspace
            .read()
            .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
        let active = ws_guard
            .as_ref()
            .ok_or_else(IpcError::workspace_not_open)?;
        active.token_budget
    };

    prepare_lens_context(
        &state.workspace,
        lens,
        &focus_ids,
        token_budget,
        custom_prompt.as_deref(),
    )?;

    let (config, api_key) = state.settings.tier_config_and_key("reasoning")?;
    let run_id = format!("run_{}", ulid::Ulid::new());
    let cancel = CancellationToken::new();

    {
        let mut runs = state
            .active_runs
            .lock()
            .map_err(|_| IpcError::db("Active runs lock poisoned"))?;
        runs.insert(run_id.clone(), cancel.clone());
    }

    let workspace = state.workspace.clone();
    let db = state.db.clone();
    let active_runs = state.active_runs.clone();
    let summary_tx = state.summary_tx.clone();
    let http_client = state.http_client.clone();
    let spawned_run_id = run_id.clone();

    tauri::async_runtime::spawn(async move {
        let _ = execute_lens_run(
            LensRunParams {
                run_id: spawned_run_id,
                lens,
                focus_ids,
                custom_prompt,
                config,
                api_key,
                token_budget,
            },
            workspace,
            db,
            active_runs,
            summary_tx,
            http_client,
            cancel,
            move |evt| {
                let _ = on_event.send(evt);
            },
        )
        .await;
    });

    Ok(run_id)
}

#[tauri::command]
pub fn cancel_run(run_id: String, state: tauri::State<'_, AppState>) -> Result<(), IpcError> {
    let runs = state
        .active_runs
        .lock()
        .map_err(|_| IpcError::db("Active runs lock poisoned"))?;
    let Some(token) = runs.get(&run_id) else {
        return Err(IpcError::run_not_found(&run_id));
    };
    token.cancel();
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, AppState>) -> Result<AppSettingsDto, IpcError> {
    state.settings.load_dto()
}

#[tauri::command]
pub fn save_settings(
    input: SaveSettingsInput,
    state: tauri::State<'_, AppState>,
) -> Result<AppSettingsDto, IpcError> {
    let saved = state.settings.save(input)?;

    let mut ws_guard = state
        .workspace
        .write()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    if let Some(active) = ws_guard.as_mut() {
        active.token_budget = saved.default_token_budget;
    }

    Ok(saved)
}

#[tauri::command]
pub async fn test_provider_connection(
    tier: String,
    state: tauri::State<'_, AppState>,
) -> Result<TestConnectionResult, IpcError> {
    let (config, api_key) = state.settings.tier_config_and_key(&tier)?;
    Ok(ai::provider::test_connection(&state.http_client, &config, api_key).await)
}

#[tauri::command]
pub fn seed_stress_500(state: tauri::State<'_, AppState>) -> Result<WorkspaceSnapshot, IpcError> {
    if !cfg!(debug_assertions) && !cfg!(test) {
        return Err(IpcError::validation(
            "Stress generator is only available in development builds",
        ));
    }

    // Canonical lock ordering: ALWAYS acquire workspace lock BEFORE db lock.
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

    let snapshot =
        db::stress::seed_stress_500_into_workspace(conn, &mut active.engine, &active.path)?;
    active.token_budget = snapshot.token_budget;
    Ok(snapshot)
}

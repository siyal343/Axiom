use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use tokio_util::sync::CancellationToken;

use crate::ai;
use crate::ai::runner::{execute_lens_run, prepare_lens_context, LensRunParams};
use crate::db;
use crate::error::IpcError;
use crate::graph::compiler::compile_context;
use crate::graph::models::{
    AppSettingsDto, ApplyResult, ArtifactFormat, ArtifactScope, CameraState, CompiledArtifact,
    CompiledXray, EdgeType, GraphOp, LensKind, LensStreamEvent, NodePositionUpdate, NodeType,
    OpenFlowResult, RelatedNodeHit, SaveSettingsInput, SearchHit, SpawnConnectedResult,
    SpawnDirection, StaleNodeInfo, TestConnectionResult, WorkspaceCatalogDto, WorkspaceEntryDto,
    WorkspaceSearchHit, WorkspaceSnapshot,
};
use crate::graph::provenance::{acknowledge_stale_node as ack_stale_node_db, compute_stale_nodes};
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
    state.bump_generation_and_cancel_runs();

    let path_str = resolved_path.to_string_lossy().into_owned();

    let mut conn = db::open_connection(&resolved_path)?;
    let is_fresh_seed = template_opt.is_some()
        && conn
            .query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0)
            == 0;
    let mut snapshot = match template_opt {
        Some(tpl) => db::seed_flow_template(&mut conn, &path_str, tpl)?,
        None => db::hydrate_or_seed_workspace(&mut conn, &path_str)?,
    };
    if template_opt.is_some() {
        if let Ok(settings) = state.settings.load_dto() {
            if (is_fresh_seed || snapshot.token_budget == 6000)
                && snapshot.token_budget != settings.default_token_budget
            {
                db::queries::save_token_budget(&mut conn, settings.default_token_budget)?;
                snapshot.token_budget = settings.default_token_budget;
            }
        }
    }
    let mut engine = GraphEngine::from_snapshot(&snapshot.nodes, &snapshot.edges);

    if (cfg!(debug_assertions) || cfg!(test))
        && state.seed_stress_on_open.swap(false, Ordering::SeqCst)
    {
        snapshot = db::stress::seed_stress_500_into_workspace(&mut conn, &mut engine, &path_str)?;
    }

    let stale_ids = db::queries::list_stale_summary_node_ids(&conn, 64)?;

    // Canonical lock ordering: ALWAYS acquire workspace lock BEFORE db lock.
    {
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
            system_prompt: snapshot.system_prompt.clone(),
        });
        *db_guard = Some(conn);
    }

    for id in stale_ids {
        let _ = state.summary_tx.send(id);
    }

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
            state.bump_generation_and_cancel_runs();
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
            state.bump_generation_and_cancel_runs();
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
    let max_hits = limit.unwrap_or(30);
    let parsed = db::queries::parse_search_query(&query);
    if parsed.stale_filter.is_some() {
        // Canonical lock ordering: ALWAYS acquire workspace lock BEFORE db lock.
        let workspace_guard = state
            .workspace
            .read()
            .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
        let db_guard = state
            .db
            .lock()
            .map_err(|_| IpcError::db("Database lock poisoned"))?;
        let active = workspace_guard
            .as_ref()
            .ok_or_else(IpcError::workspace_not_open)?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(IpcError::workspace_not_open)?;
        return db::queries::search_nodes_with_provenance(conn, &active.engine, &query, max_hits);
    }

    let db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;
    let conn = db_guard
        .as_ref()
        .ok_or_else(IpcError::workspace_not_open)?;

    db::queries::search_nodes(conn, &query, max_hits)
}

#[tauri::command]
pub fn find_related_nodes(
    node_id: String,
    limit: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RelatedNodeHit>, IpcError> {
    // Canonical lock ordering: ALWAYS acquire workspace lock BEFORE db lock.
    let workspace_guard = state
        .workspace
        .read()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;

    let active = workspace_guard
        .as_ref()
        .ok_or_else(IpcError::workspace_not_open)?;
    let conn = db_guard
        .as_ref()
        .ok_or_else(IpcError::workspace_not_open)?;

    db::queries::find_related_nodes(conn, &active.engine, &node_id, limit.unwrap_or(10))
}

fn append_sibling_flow_hits(
    active_ws: &WorkspaceEntryDto,
    active_flow_id: &str,
    searched_active: bool,
    active_path: Option<&str>,
    query: &str,
    max_hits: usize,
    results: &mut Vec<WorkspaceSearchHit>,
) {
    let mut sibling_flows: Vec<_> = active_ws
        .flows
        .iter()
        .filter(|f| !(searched_active && f.id == active_flow_id))
        .collect();
    sibling_flows.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });

    for flow in sibling_flows {
        if results.len() >= max_hits {
            break;
        }
        if searched_active && active_path == Some(flow.db_path.as_str()) {
            continue;
        }
        let db_path = Path::new(&flow.db_path);
        if !db_path.exists() {
            continue;
        }
        let Ok(ro_conn) = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) else {
            continue;
        };
        let _ = ro_conn.busy_timeout(Duration::from_millis(1000));
        let remaining = u32::try_from(max_hits - results.len()).unwrap_or(u32::MAX);
        if let Ok(hits) = db::queries::search_nodes(&ro_conn, query, remaining) {
            for hit in hits {
                results.push(WorkspaceSearchHit {
                    workspace_id: active_ws.id.clone(),
                    flow_id: flow.id.clone(),
                    flow_name: flow.name.clone(),
                    hit,
                });
                if results.len() >= max_hits {
                    break;
                }
            }
        }
    }
}

pub fn search_workspace_flows_in_catalog(
    catalog: &WorkspaceCatalogDto,
    active_conn: Option<&Connection>,
    active_engine: Option<&GraphEngine>,
    active_path: Option<&str>,
    query: &str,
    limit: u32,
) -> Result<Vec<WorkspaceSearchHit>, IpcError> {
    let max_hits = limit as usize;
    if max_hits == 0 {
        return Ok(Vec::new());
    }

    let Some(active_ws) = catalog
        .workspaces
        .iter()
        .find(|w| w.id == catalog.active_workspace_id)
    else {
        return Ok(Vec::new());
    };

    let mut results: Vec<WorkspaceSearchHit> = Vec::new();
    let mut searched_active = false;

    if let Some(active_flow) = active_ws
        .flows
        .iter()
        .find(|f| f.id == catalog.active_flow_id)
    {
        if let Some(conn) = active_conn {
            let hits = if let Some(engine) = active_engine {
                db::queries::search_nodes_with_provenance(conn, engine, query, limit)?
            } else {
                db::queries::search_nodes(conn, query, limit)?
            };
            for hit in hits {
                results.push(WorkspaceSearchHit {
                    workspace_id: active_ws.id.clone(),
                    flow_id: active_flow.id.clone(),
                    flow_name: active_flow.name.clone(),
                    hit,
                });
                if results.len() >= max_hits {
                    return Ok(results);
                }
            }
            searched_active = true;
        }
    }

    append_sibling_flow_hits(
        active_ws,
        &catalog.active_flow_id,
        searched_active,
        active_path,
        query,
        max_hits,
        &mut results,
    );

    results.truncate(max_hits);
    Ok(results)
}

#[tauri::command]
pub fn search_workspace_flows(
    query: String,
    limit: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<WorkspaceSearchHit>, IpcError> {
    let max_hits = limit.unwrap_or(30);
    if max_hits == 0 {
        return Ok(Vec::new());
    }
    let catalog = state.workspaces.load_or_init()?;
    let Some(active_ws) = catalog
        .workspaces
        .iter()
        .find(|w| w.id == catalog.active_workspace_id)
    else {
        return Ok(Vec::new());
    };

    let mut results: Vec<WorkspaceSearchHit> = Vec::new();
    let mut searched_active = false;
    let mut active_path_opt: Option<String> = None;

    {
        // Canonical lock ordering: ALWAYS acquire workspace lock BEFORE db lock.
        let workspace_guard = state
            .workspace
            .read()
            .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
        let db_guard = state
            .db
            .lock()
            .map_err(|_| IpcError::db("Database lock poisoned"))?;

        if let (Some(active), Some(conn)) = (workspace_guard.as_ref(), db_guard.as_ref()) {
            active_path_opt = Some(active.path.clone());
            if let Some(active_flow) = active_ws
                .flows
                .iter()
                .find(|f| f.id == catalog.active_flow_id)
            {
                let hits = db::queries::search_nodes_with_provenance(
                    conn,
                    &active.engine,
                    &query,
                    max_hits,
                )?;
                for hit in hits {
                    results.push(WorkspaceSearchHit {
                        workspace_id: active_ws.id.clone(),
                        flow_id: active_flow.id.clone(),
                        flow_name: active_flow.name.clone(),
                        hit,
                    });
                    if results.len() >= max_hits as usize {
                        return Ok(results);
                    }
                }
                searched_active = true;
            }
        }
    }

    append_sibling_flow_hits(
        active_ws,
        &catalog.active_flow_id,
        searched_active,
        active_path_opt.as_deref(),
        &query,
        max_hits as usize,
        &mut results,
    );

    results.truncate(max_hits as usize);
    Ok(results)
}

#[tauri::command]
pub fn save_flow_system_prompt(
    prompt: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), IpcError> {
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

    db::queries::save_flow_system_prompt(conn, &prompt)?;
    active.system_prompt = prompt;
    Ok(())
}

#[tauri::command]
pub fn get_stale_nodes(state: tauri::State<'_, AppState>) -> Result<Vec<StaleNodeInfo>, IpcError> {
    // Canonical lock ordering: ALWAYS acquire workspace lock BEFORE db lock.
    let workspace_guard = state
        .workspace
        .read()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;

    let active = workspace_guard
        .as_ref()
        .ok_or_else(IpcError::workspace_not_open)?;
    let conn = db_guard
        .as_ref()
        .ok_or_else(IpcError::workspace_not_open)?;

    compute_stale_nodes(conn, &active.engine)
}

#[tauri::command]
pub fn acknowledge_stale_node(
    node_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), IpcError> {
    // Canonical lock ordering: ALWAYS acquire workspace lock BEFORE db lock.
    let workspace_guard = state
        .workspace
        .read()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let mut db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;

    let active = workspace_guard
        .as_ref()
        .ok_or_else(IpcError::workspace_not_open)?;
    let conn = db_guard
        .as_mut()
        .ok_or_else(IpcError::workspace_not_open)?;

    ack_stale_node_db(conn, &active.engine, &node_id)
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
    let staged = db::json_io::stage_import_json(Path::new(src_path.trim()), &dest_path)?;

    let mut workspace_guard = state
        .workspace
        .write()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let mut db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;

    state.bump_generation_and_cancel_runs();

    // Release any existing connection before overwriting destination SQLite/WAL files.
    *db_guard = None;
    *workspace_guard = None;

    let snapshot = staged.commit(&dest_path)?;
    let conn = db::open_connection(&dest_path)?;
    let engine = GraphEngine::from_snapshot(&snapshot.nodes, &snapshot.edges);

    *workspace_guard = Some(ActiveWorkspace {
        path: snapshot.path.clone(),
        engine,
        token_budget: snapshot.token_budget,
        system_prompt: snapshot.system_prompt.clone(),
    });
    *db_guard = Some(conn);

    Ok(snapshot)
}

#[tauri::command]
pub fn export_markdown_artifact(
    focus_ids: Vec<String>,
    scope: ArtifactScope,
    format: ArtifactFormat,
    dest_path: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<CompiledArtifact, IpcError> {
    let artifact = {
        let workspace_guard = state
            .workspace
            .read()
            .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
        let active = workspace_guard
            .as_ref()
            .ok_or_else(IpcError::workspace_not_open)?;
        crate::graph::exporter::compile_markdown_artifact(
            &active.engine,
            &focus_ids,
            scope,
            format,
        )
    };

    if let Some(raw_dest) = dest_path {
        let trimmed = raw_dest.trim();
        if !trimmed.is_empty() {
            crate::graph::exporter::write_artifact_atomic(
                Path::new(trimmed),
                &artifact.markdown,
            )?;
        }
    }

    Ok(artifact)
}

#[tauri::command]
pub fn run_lens(
    lens: LensKind,
    focus_ids: Vec<String>,
    custom_prompt: Option<String>,
    in_place: Option<bool>,
    on_event: tauri::ipc::Channel<LensStreamEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<String, IpcError> {
    let in_place = in_place.unwrap_or(false);
    let expected_generation = state.workspace_generation.load(Ordering::SeqCst);
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

    let prepared = prepare_lens_context(
        &state.workspace,
        lens,
        &focus_ids,
        token_budget,
        custom_prompt.as_deref(),
        in_place,
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
    let workspace_generation = state.workspace_generation.clone();
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
                in_place,
                config,
                api_key,
                token_budget,
                expected_generation,
                prepared: Some(prepared),
            },
            workspace,
            db,
            workspace_generation,
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

    // Canonical lock ordering: ALWAYS acquire workspace lock BEFORE db lock.
    let mut ws_guard = state
        .workspace
        .write()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let mut db_guard = state
        .db
        .lock()
        .map_err(|_| IpcError::db("Database lock poisoned"))?;
    if let Some(active) = ws_guard.as_mut() {
        active.token_budget = saved.default_token_budget;
    }
    if let Some(conn) = db_guard.as_mut() {
        db::queries::save_token_budget(conn, saved.default_token_budget)?;
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

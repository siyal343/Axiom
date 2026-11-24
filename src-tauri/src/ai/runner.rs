use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use rusqlite::Connection;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ai::parser::{NodeStreamParser, ParsedEvent, ParsedNodeMeta};
use crate::ai::prompts::{lens_defaults, lens_prompt, lens_to_origin, BASE_SYSTEM_PROMPT};
use crate::ai::provider::{stream_completion, LlmStreamRequest};
use crate::db;
use crate::error::IpcError;
use crate::graph::compiler::compile_context;
use crate::graph::models::{
    compute_content_hash, estimate_tokens, now_epoch_ms, ContextControls, CreatedBy, EdgeDto,
    EdgeType, EdgeWeight, GraphOp, LensKind, LensStreamEvent, ModelTierConfig, NodeDto,
    NodeLayout, NodeMetadata, NodeStatus,
};
use crate::graph::spatial::{find_free_position, DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH};
use crate::ipc::ActiveWorkspace;

pub struct LensRunParams {
    pub run_id: String,
    pub lens: LensKind,
    pub focus_ids: Vec<String>,
    pub custom_prompt: Option<String>,
    pub config: ModelTierConfig,
    pub api_key: Option<String>,
    pub token_budget: u32,
}

pub fn prepare_lens_context(
    workspace: &Arc<RwLock<Option<ActiveWorkspace>>>,
    lens: LensKind,
    focus_ids: &[String],
    token_budget: u32,
    custom_prompt: Option<&str>,
) -> Result<String, IpcError> {
    if focus_ids.is_empty() {
        return Err(IpcError::validation(
            "Select at least one focus node before running an AI lens",
        ));
    }
    if lens == LensKind::Synthesize && focus_ids.len() < 2 {
        return Err(IpcError::validation(
            "Synthesize lens requires at least 2 selected focus nodes",
        ));
    }
    if lens == LensKind::Custom {
        let instr = custom_prompt.map(str::trim).unwrap_or("");
        if instr.is_empty() {
            return Err(IpcError::validation(
                "Custom prompt instruction cannot be empty",
            ));
        }
    }

    let guard = workspace
        .read()
        .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
    let active = guard.as_ref().ok_or_else(IpcError::workspace_not_open)?;

    for fid in focus_ids {
        if !active.engine.nodes.contains_key(fid) {
            return Err(IpcError::validation(format!(
                "Focus node {fid} not found in workspace"
            )));
        }
    }

    let compiled = compile_context(&active.engine, focus_ids, token_budget);
    Ok(compiled.prompt_text)
}

#[allow(clippy::too_many_arguments)]
pub async fn execute_lens_run(
    params: LensRunParams,
    workspace: Arc<RwLock<Option<ActiveWorkspace>>>,
    db: Arc<Mutex<Option<Connection>>>,
    active_runs: Arc<Mutex<HashMap<String, CancellationToken>>>,
    summary_tx: mpsc::UnboundedSender<String>,
    http_client: reqwest::Client,
    cancel: CancellationToken,
    mut emit_event: impl FnMut(LensStreamEvent) + Send,
) -> Result<Vec<String>, IpcError> {
    let context_result = prepare_lens_context(
        &workspace,
        params.lens,
        &params.focus_ids,
        params.token_budget,
        params.custom_prompt.as_deref(),
    );

    let compiled_prompt = match context_result {
        Ok(prompt) => prompt,
        Err(err) => {
            if let Ok(mut runs) = active_runs.lock() {
                runs.remove(&params.run_id);
            }
            emit_event(LensStreamEvent::RunError {
                run_id: params.run_id,
                code: err.code.as_str().to_owned(),
                message: err.message.clone(),
            });
            return Err(err);
        }
    };

    let system_prompt = format!("{BASE_SYSTEM_PROMPT}\n\n{}", lens_prompt(params.lens));
    let user_prompt = if params.lens == LensKind::Custom {
        let instruction = params.custom_prompt.as_deref().unwrap_or("").trim();
        format!("{compiled_prompt}\n\n---\n\n[USER INSTRUCTION]\n{instruction}")
    } else {
        compiled_prompt
    };

    let mut parser = NodeStreamParser::new(lens_defaults(params.lens));
    let mut active_node_id: Option<String> = None;
    let mut active_title = String::new();
    let mut active_content = String::new();
    let mut spawned_ids: Vec<String> = Vec::new();
    let mut batch_index: usize = 0;

    let spawn_skeleton = |meta: ParsedNodeMeta,
                          batch_idx: &mut usize,
                          active_node_id: &mut Option<String>,
                          active_title: &mut String,
                          active_content: &mut String,
                          spawned_ids: &mut Vec<String>,
                          emit: &mut dyn FnMut(LensStreamEvent)|
     -> Result<(), IpcError> {
        let mut ws_guard = workspace
            .write()
            .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
        let mut db_guard = db
            .lock()
            .map_err(|_| IpcError::db("Database lock poisoned"))?;

        let active = ws_guard
            .as_mut()
            .ok_or_else(IpcError::workspace_not_open)?;
        let conn = db_guard
            .as_mut()
            .ok_or_else(IpcError::workspace_not_open)?;

        let anchors: Vec<NodeDto> = params
            .focus_ids
            .iter()
            .filter_map(|fid| active.engine.nodes.get(fid).cloned())
            .collect();
        let anchor_refs: Vec<&NodeDto> = anchors.iter().collect();
        let (x, y) = find_free_position(
            &active.engine.spatial,
            &anchor_refs,
            meta.node_type,
            DEFAULT_NODE_WIDTH,
            DEFAULT_NODE_HEIGHT,
            *batch_idx,
        );
        *batch_idx += 1;

        let now = now_epoch_ms();
        let node_id = format!("node_{}", ulid::Ulid::new());
        let draft_node = NodeDto {
            id: node_id.clone(),
            node_type: meta.node_type,
            status: NodeStatus::Draft,
            title: meta.title.clone(),
            content: String::new(),
            summary: String::new(),
            content_hash: compute_content_hash(&meta.title, ""),
            summary_hash: String::new(),
            metadata: NodeMetadata {
                severity: meta.severity,
                lens: lens_to_origin(params.lens),
                created_by: CreatedBy::Ai,
                model: Some(params.config.model.clone()),
                token_count: estimate_tokens(&meta.title),
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

        let mut edges: Vec<EdgeDto> = Vec::new();
        match meta.edge_type {
            EdgeType::Challenges | EdgeType::Resolves => {
                if let Some(target_id) = params.focus_ids.first() {
                    edges.push(EdgeDto {
                        id: format!("edge_{}", ulid::Ulid::new()),
                        source_id: node_id.clone(),
                        target_id: target_id.clone(),
                        edge_type: meta.edge_type,
                        weight: EdgeWeight::Summary,
                        created_at: now,
                    });
                }
            }
            EdgeType::Synthesizes => {
                for fid in &params.focus_ids {
                    edges.push(EdgeDto {
                        id: format!("edge_{}", ulid::Ulid::new()),
                        source_id: fid.clone(),
                        target_id: node_id.clone(),
                        edge_type: EdgeType::Synthesizes,
                        weight: EdgeWeight::Summary,
                        created_at: now,
                    });
                }
            }
            EdgeType::Derives | EdgeType::Branches | EdgeType::References => {
                if let Some(src_id) = params.focus_ids.first() {
                    edges.push(EdgeDto {
                        id: format!("edge_{}", ulid::Ulid::new()),
                        source_id: src_id.clone(),
                        target_id: node_id.clone(),
                        edge_type: meta.edge_type,
                        weight: EdgeWeight::Summary,
                        created_at: now,
                    });
                }
            }
        }

        let mut ops: Vec<GraphOp> = Vec::with_capacity(1 + edges.len());
        ops.push(GraphOp::CreateNode {
            node: draft_node.clone(),
        });
        for edge in &edges {
            ops.push(GraphOp::CreateEdge { edge: edge.clone() });
        }

        let (apply_res, _) = db::queries::apply_ops(conn, &mut active.engine, &ops)?;
        let persisted = apply_res
            .updated_nodes
            .into_iter()
            .find(|n| n.id == node_id)
            .unwrap_or(draft_node);

        *active_node_id = Some(persisted.id.clone());
        *active_title = persisted.title.clone();
        active_content.clear();
        spawned_ids.push(persisted.id.clone());

        emit(LensStreamEvent::SkeletonSpawned {
            node: persisted,
            edges,
        });
        Ok(())
    };

    let finalize_active = |active_node_id: &mut Option<String>,
                           active_title: &mut String,
                           active_content: &mut String,
                           emit: &mut dyn FnMut(LensStreamEvent)|
     -> Result<(), IpcError> {
        let Some(nid) = active_node_id.take() else {
            return Ok(());
        };
        let final_content = active_content.trim_end().to_owned();
        let final_title = active_title.clone();
        active_content.clear();

        let finalized_node = {
            let mut ws_guard = workspace
                .write()
                .map_err(|_| IpcError::db("Workspace lock poisoned"))?;
            let mut db_guard = db
                .lock()
                .map_err(|_| IpcError::db("Database lock poisoned"))?;

            let active = ws_guard
                .as_mut()
                .ok_or_else(IpcError::workspace_not_open)?;
            let conn = db_guard
                .as_mut()
                .ok_or_else(IpcError::workspace_not_open)?;

            let (res, _) = db::queries::apply_ops(
                conn,
                &mut active.engine,
                &[
                    GraphOp::UpdateNodeText {
                        id: nid.clone(),
                        title: final_title,
                        content: final_content,
                    },
                    GraphOp::UpdateNodeMeta {
                        id: nid.clone(),
                        node_type: None,
                        status: Some(NodeStatus::Active),
                        severity: None,
                        pin_global: None,
                        exclude_from_ai: None,
                        collapsed: None,
                    },
                ],
            )?;
            res.updated_nodes.into_iter().find(|n| n.id == nid)
        };

        if let Some(node) = finalized_node {
            emit(LensStreamEvent::NodeFinalized { node });
        }
        let _ = summary_tx.send(nid);
        Ok(())
    };

    let mut handle_events = |events: Vec<ParsedEvent>,
                             batch_idx: &mut usize,
                             active_node_id: &mut Option<String>,
                             active_title: &mut String,
                             active_content: &mut String,
                             spawned_ids: &mut Vec<String>,
                             emit: &mut dyn FnMut(LensStreamEvent)|
     -> Result<(), IpcError> {
        for ev in events {
            match ev {
                ParsedEvent::SpawnNode { meta } => {
                    spawn_skeleton(
                        meta,
                        batch_idx,
                        active_node_id,
                        active_title,
                        active_content,
                        spawned_ids,
                        emit,
                    )?;
                }
                ParsedEvent::TokenDelta(chunk) => {
                    if let Some(ref nid) = *active_node_id {
                        active_content.push_str(&chunk);
                        emit(LensStreamEvent::TokenDelta {
                            node_id: nid.clone(),
                            chunk,
                        });
                    }
                }
                ParsedEvent::FinalizeNode => {
                    finalize_active(active_node_id, active_title, active_content, emit)?;
                }
            }
        }
        Ok(())
    };

    let llm_req = LlmStreamRequest {
        system_prompt,
        user_prompt,
        config: params.config.clone(),
        api_key: params.api_key,
    };

    let stream_res = stream_completion(&http_client, llm_req, cancel.clone(), |chunk| {
        let events = parser.feed(&chunk);
        handle_events(
            events,
            &mut batch_index,
            &mut active_node_id,
            &mut active_title,
            &mut active_content,
            &mut spawned_ids,
            &mut emit_event,
        )
    })
    .await;

    let tail_events = parser.finish();
    let tail_res = handle_events(
        tail_events,
        &mut batch_index,
        &mut active_node_id,
        &mut active_title,
        &mut active_content,
        &mut spawned_ids,
        &mut emit_event,
    );

    if let Ok(mut runs) = active_runs.lock() {
        runs.remove(&params.run_id);
    }

    if cancel.is_cancelled() {
        emit_event(LensStreamEvent::RunCompleted {
            run_id: params.run_id,
            spawned_ids: spawned_ids.clone(),
            cancelled: true,
        });
        return Ok(spawned_ids);
    }

    if let Err(err) = stream_res {
        emit_event(LensStreamEvent::RunError {
            run_id: params.run_id,
            code: err.code.as_str().to_owned(),
            message: err.message.clone(),
        });
        return Err(err);
    }

    if let Err(err) = tail_res {
        emit_event(LensStreamEvent::RunError {
            run_id: params.run_id,
            code: err.code.as_str().to_owned(),
            message: err.message.clone(),
        });
        return Err(err);
    }

    emit_event(LensStreamEvent::RunCompleted {
        run_id: params.run_id,
        spawned_ids: spawned_ids.clone(),
        cancelled: false,
    });
    Ok(spawned_ids)
}

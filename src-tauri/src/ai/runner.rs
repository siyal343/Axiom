use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use rusqlite::Connection;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ai::parser::{LensDefaults, NodeStreamParser, ParsedEvent, ParsedNodeMeta};
use crate::ai::prompts::{lens_defaults, lens_prompt, lens_to_origin, BASE_SYSTEM_PROMPT};
use crate::ai::provider::{stream_completion, LlmStreamRequest};
use crate::db;
use crate::error::IpcError;
use crate::graph::compiler::compile_context;
use crate::graph::models::{
    compute_content_hash, estimate_tokens, now_epoch_ms, ContextControls, CreatedBy,
    CustomLensDef, EdgeDto, EdgeType, EdgeWeight, GraphOp, LensKind, LensStreamEvent,
    ModelTierConfig, NodeDto, NodeLayout, NodeMetadata, NodeStatus, ProvenanceInput,
};
use crate::graph::spatial::{find_free_position, DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH};
use crate::ipc::ActiveWorkspace;

#[derive(Debug, Clone)]
pub struct PreparedLensRun {
    pub compiled_prompt: String,
    pub flow_system_prompt: String,
    pub provenance_inputs: Vec<ProvenanceInput>,
    pub prompt_tokens: u32,
    pub custom_lens_prompt: Option<String>,
    pub custom_defaults: Option<LensDefaults>,
}

pub struct LensRunParams {
    pub run_id: String,
    pub lens: LensKind,
    pub focus_ids: Vec<String>,
    pub custom_prompt: Option<String>,
    pub in_place: bool,
    pub custom_lens: Option<CustomLensDef>,
    pub config: ModelTierConfig,
    pub api_key: Option<String>,
    pub token_budget: u32,
    pub expected_generation: u64,
    pub prepared: Option<PreparedLensRun>,
}

pub fn is_generic_lens_title(title: &str) -> bool {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return true;
    }
    const GENERIC_TITLES: &[&str] = &[
        "AI Response",
        "First Principles",
        "Study & Recall",
        "Research Brief",
        "Alternative Branch",
        "Synthesis Decision",
        "Red-Team Finding",
        "Edge-Case Matrix",
    ];
    GENERIC_TITLES
        .iter()
        .any(|g| trimmed.eq_ignore_ascii_case(g))
}

pub fn derive_title_from_prompt(prompt: Option<&str>, fallback: &str) -> String {
    let mut text = prompt.unwrap_or("").trim();
    if let Some(after_at) = text.strip_prefix('@') {
        let tag_len = after_at
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .unwrap_or(after_at.len());
        if tag_len > 0 {
            let rem = &after_at[tag_len..];
            if rem.is_empty() {
                text = "";
            } else if let Some(after_colon) = rem.strip_prefix(':') {
                if after_colon.is_empty() || after_colon.starts_with(char::is_whitespace) {
                    text = after_colon.trim();
                }
            } else if rem.starts_with(char::is_whitespace) {
                text = rem.trim();
            }
        }
    }

    let is_trim_punct = |c: char| c.is_whitespace() || matches!(c, '?' | '!' | '.' | ',' | ':');
    let cleaned = text.trim_matches(is_trim_punct);
    if cleaned.is_empty() {
        return fallback.to_owned();
    }

    let mut phrase = String::new();
    for (idx, word) in cleaned.split_whitespace().take(6).enumerate() {
        let word_chars = word.chars().count();
        let current_chars = phrase.chars().count();
        if idx == 0 {
            if word_chars > 48 {
                phrase.extend(word.chars().take(48));
                break;
            }
            phrase.push_str(word);
        } else if current_chars + 1 + word_chars <= 48 {
            phrase.push(' ');
            phrase.push_str(word);
        } else {
            break;
        }
    }

    let final_trimmed = phrase.trim_matches(is_trim_punct);
    if final_trimmed.is_empty() {
        return fallback.to_owned();
    }

    let mut chars = final_trimmed.chars();
    match chars.next() {
        None => fallback.to_owned(),
        Some(first) => {
            let mut out = first.to_uppercase().to_string();
            out.push_str(chars.as_str());
            out
        }
    }
}

fn build_custom_lens_prompt(def: &CustomLensDef, custom_prompt: Option<&str>) -> String {
    let severity_attr = def
        .default_severity
        .map(|s| format!(" severity={}", s.as_str()))
        .unwrap_or_default();
    let mut out = format!(
        "CUSTOM LENS: {}\n{}\n\nOUTPUT FORMAT:\nEmit 1 or more blocks using:\n@@NODE type={} edge={}{} title=\"<concise title>\"\n<Dense, concrete Markdown response>\n@@END",
        def.name.trim(),
        def.prompt_template.trim(),
        def.default_node_type.as_str(),
        def.default_edge_type.as_str(),
        severity_attr,
    );
    if let Some(extra) = custom_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str(&format!("\n\n[USER INSTRUCTION]\n{extra}"));
    }
    out
}

pub fn prepare_lens_context(
    workspace: &Arc<RwLock<Option<ActiveWorkspace>>>,
    lens: LensKind,
    focus_ids: &[String],
    token_budget: u32,
    custom_prompt: Option<&str>,
    in_place: bool,
    custom_lens: Option<&CustomLensDef>,
) -> Result<PreparedLensRun, IpcError> {
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
    if lens == LensKind::Custom && custom_lens.is_none() {
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

    if in_place {
        if let Some(target_id) = focus_ids.first() {
            if let Some(target_node) = active.engine.nodes.get(target_id) {
                if target_node.status == NodeStatus::Locked {
                    return Err(IpcError::node_locked(target_id));
                }
            }
        }
    }

    let compiled = compile_context(&active.engine, focus_ids, token_budget);
    let (custom_lens_prompt, custom_defaults) = match custom_lens {
        Some(def) => (
            Some(build_custom_lens_prompt(def, custom_prompt)),
            Some(LensDefaults {
                node_type: def.default_node_type,
                edge_type: def.default_edge_type,
                severity: def.default_severity,
                title: def.name.clone(),
            }),
        ),
        None => (None, None),
    };

    Ok(PreparedLensRun {
        compiled_prompt: compiled.prompt_text,
        flow_system_prompt: active.system_prompt.clone(),
        provenance_inputs: compiled.provenance_inputs,
        prompt_tokens: compiled.xray.total_tokens,
        custom_lens_prompt,
        custom_defaults,
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn execute_lens_run(
    mut params: LensRunParams,
    workspace: Arc<RwLock<Option<ActiveWorkspace>>>,
    db: Arc<Mutex<Option<Connection>>>,
    workspace_generation: Arc<AtomicU64>,
    active_runs: Arc<Mutex<HashMap<String, CancellationToken>>>,
    summary_tx: mpsc::UnboundedSender<String>,
    http_client: reqwest::Client,
    cancel: CancellationToken,
    mut emit_event: impl FnMut(LensStreamEvent) + Send,
) -> Result<Vec<String>, IpcError> {
    let in_place = params.in_place;
    let context_result = match params.prepared.take() {
        Some(prepared) => Ok(prepared),
        None => prepare_lens_context(
            &workspace,
            params.lens,
            &params.focus_ids,
            params.token_budget,
            params.custom_prompt.as_deref(),
            in_place,
            params.custom_lens.as_ref(),
        ),
    };

    let prepared = match context_result {
        Ok(prepared) => prepared,
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
    let compiled_prompt = prepared.compiled_prompt;
    let flow_system_prompt = prepared.flow_system_prompt;
    let provenance_inputs = prepared.provenance_inputs;
    let prompt_tokens = prepared.prompt_tokens;
    let custom_lens_prompt = prepared.custom_lens_prompt;
    let custom_defaults = prepared.custom_defaults;

    if workspace_generation.load(Ordering::SeqCst) != params.expected_generation {
        if let Ok(mut runs) = active_runs.lock() {
            runs.remove(&params.run_id);
        }
        emit_event(LensStreamEvent::RunCompleted {
            run_id: params.run_id,
            spawned_ids: Vec::new(),
            cancelled: true,
        });
        return Ok(Vec::new());
    }

    let active_lens_prompt = custom_lens_prompt
        .as_deref()
        .unwrap_or_else(|| lens_prompt(params.lens));
    let mut system_prompt = format!("{BASE_SYSTEM_PROMPT}\n\n{active_lens_prompt}");
    if in_place {
        system_prompt.push_str(
            "\n\nIN-PLACE MODE: Emit ONE @@NODE block with a concise 3-7 word title=\"...\" summarizing the question and answer, containing only the answer body.",
        );
    }
    let trimmed_flow_prompt = flow_system_prompt.trim();
    if !trimmed_flow_prompt.is_empty() {
        system_prompt.push_str(&format!(
            "\n\n[FLOW SYSTEM INSTRUCTIONS]\n{trimmed_flow_prompt}"
        ));
    }
    let extra_instruction = params.custom_prompt.as_deref().unwrap_or("").trim();
    let user_prompt = if extra_instruction.is_empty() {
        compiled_prompt
    } else {
        format!("{compiled_prompt}\n\n---\n\n[USER INSTRUCTION]\n{extra_instruction}")
    };

    let mut parser =
        NodeStreamParser::new(custom_defaults.unwrap_or_else(|| lens_defaults(params.lens)));
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

        if workspace_generation.load(Ordering::SeqCst) != params.expected_generation {
            cancel.cancel();
            return Ok(());
        }

        let active = ws_guard
            .as_mut()
            .ok_or_else(IpcError::workspace_not_open)?;
        let conn = db_guard
            .as_mut()
            .ok_or_else(IpcError::workspace_not_open)?;

        if in_place {
            if let Some(ref existing_nid) = *active_node_id {
                let heading_chunk = format!("\n\n### {}\n\n", meta.title);
                active_content.push_str(&heading_chunk);
                emit(LensStreamEvent::TokenDelta {
                    node_id: existing_nid.clone(),
                    chunk: heading_chunk,
                });
                return Ok(());
            }

            let target_id = params
                .focus_ids
                .first()
                .ok_or_else(|| IpcError::validation("Missing focus node for in-place lens"))?
                .clone();
            let existing = active
                .engine
                .nodes
                .get(&target_id)
                .ok_or_else(|| IpcError::validation(format!("Focus node {target_id} not found")))?
                .clone();
            if existing.status == NodeStatus::Locked {
                return Err(IpcError::node_locked(&target_id));
            }

            let derived_title = if is_generic_lens_title(&meta.title) {
                derive_title_from_prompt(params.custom_prompt.as_deref(), &meta.title)
            } else {
                meta.title.trim().to_owned()
            };
            let auto_title = if derived_title.is_empty() {
                existing.title.clone()
            } else {
                derived_title
            };
            let prefix = if existing.content.trim().is_empty() {
                String::new()
            } else {
                format!("{}\n\n---\n\n", existing.content.trim_end())
            };

            let ops = vec![
                GraphOp::UpdateNodeText {
                    id: target_id.clone(),
                    title: auto_title.clone(),
                    content: prefix.clone(),
                },
                GraphOp::UpdateNodeMeta {
                    id: target_id.clone(),
                    node_type: None,
                    status: Some(NodeStatus::Draft),
                    severity: None,
                    pin_global: None,
                    exclude_from_ai: None,
                    collapsed: None,
                },
            ];
            let (apply_res, _) = db::queries::apply_ops(conn, &mut active.engine, &ops)?;
            let updated_target = apply_res
                .updated_nodes
                .into_iter()
                .find(|n| n.id == target_id)
                .unwrap_or(existing);

            *active_node_id = Some(target_id.clone());
            *active_title = auto_title;
            *active_content = prefix;
            spawned_ids.push(target_id);

            emit(LensStreamEvent::SkeletonSpawned {
                node: updated_target,
                edges: Vec::new(),
            });
            return Ok(());
        }

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

            if workspace_generation.load(Ordering::SeqCst) != params.expected_generation {
                cancel.cancel();
                return Ok(());
            }

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
            let _ = db::queries::upsert_ai_run_provenance(
                conn,
                &nid,
                &params.run_id,
                params.lens,
                Some(params.config.model.as_str()),
                &provenance_inputs,
                prompt_tokens,
                now_epoch_ms(),
            );
            res.updated_nodes.into_iter().find(|n| n.id == nid)
        };

        if let Some(node) = finalized_node {
            emit(LensStreamEvent::NodeFinalized { node });
        }
        let _ = summary_tx.send(nid);
        Ok(())
    };

    let handle_events = |events: Vec<ParsedEvent>,
                             batch_idx: &mut usize,
                             active_node_id: &mut Option<String>,
                             active_title: &mut String,
                             active_content: &mut String,
                             spawned_ids: &mut Vec<String>,
                             emit: &mut dyn FnMut(LensStreamEvent)|
     -> Result<(), IpcError> {
        for ev in events {
            if workspace_generation.load(Ordering::SeqCst) != params.expected_generation {
                cancel.cancel();
                return Ok(());
            }
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
                    if !in_place {
                        finalize_active(active_node_id, active_title, active_content, emit)?;
                    }
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

    let tail_res = if workspace_generation.load(Ordering::SeqCst) == params.expected_generation {
        let tail_events = parser.finish();
        handle_events(
            tail_events,
            &mut batch_index,
            &mut active_node_id,
            &mut active_title,
            &mut active_content,
            &mut spawned_ids,
            &mut emit_event,
        )
    } else {
        Ok(())
    };

    if let Ok(mut runs) = active_runs.lock() {
        runs.remove(&params.run_id);
    }

    if workspace_generation.load(Ordering::SeqCst) != params.expected_generation {
        emit_event(LensStreamEvent::RunCompleted {
            run_id: params.run_id,
            spawned_ids: spawned_ids.clone(),
            cancelled: true,
        });
        return Ok(spawned_ids);
    }

    if cancel.is_cancelled() {
        if in_place && active_node_id.is_some() {
            let _ = finalize_active(
                &mut active_node_id,
                &mut active_title,
                &mut active_content,
                &mut emit_event,
            );
        }
        emit_event(LensStreamEvent::RunCompleted {
            run_id: params.run_id,
            spawned_ids: spawned_ids.clone(),
            cancelled: true,
        });
        return Ok(spawned_ids);
    }

    if let Err(err) = stream_res {
        if in_place && active_node_id.is_some() {
            let _ = finalize_active(
                &mut active_node_id,
                &mut active_title,
                &mut active_content,
                &mut emit_event,
            );
        }
        emit_event(LensStreamEvent::RunError {
            run_id: params.run_id,
            code: err.code.as_str().to_owned(),
            message: err.message.clone(),
        });
        return Err(err);
    }

    if let Err(err) = tail_res {
        if in_place && active_node_id.is_some() {
            let _ = finalize_active(
                &mut active_node_id,
                &mut active_title,
                &mut active_content,
                &mut emit_event,
            );
        }
        emit_event(LensStreamEvent::RunError {
            run_id: params.run_id,
            code: err.code.as_str().to_owned(),
            message: err.message.clone(),
        });
        return Err(err);
    }

    if in_place && active_node_id.is_some() {
        finalize_active(
            &mut active_node_id,
            &mut active_title,
            &mut active_content,
            &mut emit_event,
        )?;
    }

    emit_event(LensStreamEvent::RunCompleted {
        run_id: params.run_id,
        spawned_ids: spawned_ids.clone(),
        cancelled: false,
    });
    Ok(spawned_ids)
}

#[cfg(test)]
mod tests {
    use super::{derive_title_from_prompt, is_generic_lens_title};

    #[test]
    fn derive_title_strips_tags_punctuation_and_caps_words() {
        assert_eq!(
            derive_title_from_prompt(Some("@feynman why does Raft need pre-vote?"), "Fallback"),
            "Why does Raft need pre-vote"
        );
        assert_eq!(
            derive_title_from_prompt(
                Some("@custom: compare leader election in Raft Paxos Zab Viewstamped Replication"),
                "Fallback"
            ),
            "Compare leader election in Raft Paxos"
        );
        assert_eq!(
            derive_title_from_prompt(Some("@study   "), "Study & Recall"),
            "Study & Recall"
        );
        assert_eq!(
            derive_title_from_prompt(Some("  ?!.,:  "), "Default Title"),
            "Default Title"
        );
        assert_eq!(derive_title_from_prompt(None, "Default Title"), "Default Title");
    }

    #[test]
    fn recognizes_generic_lens_titles() {
        for title in [
            "",
            "   ",
            "AI Response",
            "first principles",
            "Study & Recall",
            "Research Brief",
            "Alternative Branch",
            "Synthesis Decision",
            "Red-Team Finding",
            "Edge-Case Matrix",
        ] {
            assert!(is_generic_lens_title(title), "expected generic: {title}");
        }
        assert!(!is_generic_lens_title("Raft Leader Election Safety"));
    }
}

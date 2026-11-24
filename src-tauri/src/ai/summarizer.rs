use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::ai::prompts::UTILITY_SUMMARY_PROMPT;
use crate::ai::provider::{stream_completion, LlmStreamRequest};
use crate::db;
use crate::graph::models::{NodeStatus, SummaryUpdatedEvent};
use crate::ipc::ActiveWorkspace;
use crate::settings::SettingsStore;

pub fn spawn_summarizer_worker<F>(
    mut summary_rx: mpsc::UnboundedReceiver<String>,
    workspace: Arc<RwLock<Option<ActiveWorkspace>>>,
    db: Arc<Mutex<Option<Connection>>>,
    http_client: reqwest::Client,
    settings: Arc<SettingsStore>,
    debounce: Duration,
    emit_event: F,
) -> tokio::task::JoinHandle<()>
where
    F: Fn(SummaryUpdatedEvent) + Send + Sync + 'static,
{
    tokio::spawn(async move {
        let mut pending: HashMap<String, Instant> = HashMap::new();

        loop {
            let next_deadline = pending.values().copied().min();

            tokio::select! {
                maybe_id = summary_rx.recv() => {
                    match maybe_id {
                        Some(node_id) => {
                            pending.insert(node_id, Instant::now() + debounce);
                        }
                        None => break,
                    }
                }
                () = async {
                    if let Some(deadline) = next_deadline {
                        tokio::time::sleep_until(deadline).await;
                    }
                }, if next_deadline.is_some() => {
                    let now = Instant::now();
                    let due_ids: Vec<String> = pending
                        .iter()
                        .filter_map(|(id, &dl)| if dl <= now { Some(id.clone()) } else { None })
                        .collect();
                    for id in &due_ids {
                        pending.remove(id);
                    }

                    for node_id in due_ids {
                        process_single_node(
                            &node_id,
                            &workspace,
                            &db,
                            &http_client,
                            &settings,
                            &emit_event,
                        )
                        .await;
                    }
                }
            }
        }
    })
}

async fn process_single_node<F>(
    node_id: &str,
    workspace: &Arc<RwLock<Option<ActiveWorkspace>>>,
    db: &Arc<Mutex<Option<Connection>>>,
    http_client: &reqwest::Client,
    settings: &Arc<SettingsStore>,
    emit_event: &F,
) where
    F: Fn(SummaryUpdatedEvent) + Send + Sync + 'static,
{
    let Ok(app_settings) = settings.load_dto() else {
        return;
    };
    if !app_settings.auto_summarize {
        return;
    }

    let snapshot = {
        let Ok(ws_guard) = workspace.read() else {
            return;
        };
        let Some(active) = ws_guard.as_ref() else {
            return;
        };
        let Some(node) = active.engine.nodes.get(node_id) else {
            return;
        };
        if node.context_controls.exclude_from_ai
            || node.status == NodeStatus::Draft
            || node.content_hash == node.summary_hash
            || node.content.trim().is_empty()
        {
            return;
        }
        (
            node.title.clone(),
            node.content.clone(),
            node.content_hash.clone(),
        )
    };

    let (title, content, expected_hash) = snapshot;
    let trimmed = content.trim();

    let summary_text = if trimmed.chars().count() <= 160 {
        trimmed.to_owned()
    } else {
        let Ok((utility_cfg, utility_key)) = settings.tier_config_and_key("utility") else {
            return;
        };
        let req = LlmStreamRequest {
            system_prompt: UTILITY_SUMMARY_PROMPT.to_owned(),
            user_prompt: format!("Title: {title}\n\n{trimmed}"),
            config: utility_cfg,
            api_key: utility_key,
        };
        let cancel = CancellationToken::new();
        let mut buf = String::new();
        let cancel_on_timeout = cancel.clone();
        let stream_fut = stream_completion(http_client, req, cancel, |chunk| {
            buf.push_str(&chunk);
            Ok(())
        });

        match tokio::time::timeout(Duration::from_secs(20), stream_fut).await {
            Ok(Ok(())) => {
                let s = buf.trim().to_owned();
                if s.is_empty() {
                    return;
                }
                s
            }
            Ok(Err(_)) | Err(_) => {
                cancel_on_timeout.cancel();
                return;
            }
        }
    };

    let updated = {
        let Ok(mut ws_guard) = workspace.write() else {
            return;
        };
        let Ok(mut db_guard) = db.lock() else {
            return;
        };
        let (Some(active), Some(conn)) = (ws_guard.as_mut(), db_guard.as_mut()) else {
            return;
        };
        db::queries::update_node_summary(
            conn,
            &mut active.engine,
            node_id,
            &expected_hash,
            &summary_text,
            &expected_hash,
        )
        .unwrap_or(false)
    };

    if updated {
        emit_event(SummaryUpdatedEvent {
            node_id: node_id.to_owned(),
            summary: summary_text,
            summary_hash: expected_hash,
        });
    }
}

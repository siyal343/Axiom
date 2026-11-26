use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::IpcError;
use crate::graph::models::{ModelTierConfig, ProviderKind, TestConnectionResult};

#[derive(Debug, Clone)]
pub struct LlmStreamRequest {
    pub system_prompt: String,
    pub user_prompt: String,
    pub config: ModelTierConfig,
    pub api_key: Option<String>,
}

pub fn is_reasoning_openai_model(model: &str) -> bool {
    let trimmed = model.trim();
    let bare = trimmed
        .rsplit_once('/')
        .map(|(_, name)| name)
        .unwrap_or(trimmed);
    let lower = bare.to_ascii_lowercase();
    let matches_prefix = |prefix: &str| {
        lower == prefix
            || lower
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('-') || rest.starts_with('.'))
    };
    matches_prefix("o1")
        || matches_prefix("o3")
        || matches_prefix("gpt-5")
        || lower.starts_with("o4-")
}

pub fn build_openai_compat_body(req: &LlmStreamRequest) -> serde_json::Value {
    let messages = json!([
        { "role": "system", "content": req.system_prompt },
        { "role": "user", "content": req.user_prompt },
    ]);
    if is_reasoning_openai_model(&req.config.model) {
        json!({
            "model": req.config.model,
            "stream": true,
            "max_completion_tokens": req.config.max_tokens,
            "messages": messages,
        })
    } else {
        json!({
            "model": req.config.model,
            "stream": true,
            "temperature": req.config.temperature,
            "max_tokens": req.config.max_tokens,
            "messages": messages,
        })
    }
}

pub fn build_anthropic_body(req: &LlmStreamRequest) -> serde_json::Value {
    let base_low = req.config.base_url.to_ascii_lowercase();
    let model_low = req.config.model.to_ascii_lowercase();
    let mut body = json!({
        "model": req.config.model,
        "stream": true,
        "temperature": req.config.temperature,
        "max_tokens": req.config.max_tokens,
        "system": req.system_prompt,
        "messages": [
            { "role": "user", "content": req.user_prompt }
        ]
    });

    // DeepSeek's Anthropic gateway defaults non-reasoner aliases like `deepseek-flash`
    // to thinking mode, which can exhaust 2048-token budgets before emitting text.
    if base_low.contains("deepseek.com") && !model_low.contains("reasoner") {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("thinking".to_owned(), json!({ "type": "disabled" }));
        }
    }

    body
}

fn map_reqwest_error(err: reqwest::Error) -> IpcError {
    IpcError::provider_network(err.without_url().to_string())
}

fn cap_snippet(raw: &str, max_chars: usize) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_owned()
    } else {
        let end: String = trimmed.chars().take(max_chars).collect();
        format!("{end}...")
    }
}

fn parse_protocol_line(
    provider: ProviderKind,
    line: &str,
    on_chunk: &mut impl FnMut(String) -> Result<(), IpcError>,
) -> Result<bool, IpcError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    match provider {
        ProviderKind::OpenaiCompat => {
            if trimmed.starts_with(':') {
                return Ok(false);
            }
            let Some(payload) = trimmed.strip_prefix("data:") else {
                return Ok(false);
            };
            let data = payload.trim_start();
            if data == "[DONE]" {
                return Ok(true);
            }
            let val: serde_json::Value = serde_json::from_str(data)?;
            if let Some(content) = val
                .pointer("/choices/0/delta/content")
                .and_then(|c| c.as_str())
            {
                if !content.is_empty() {
                    on_chunk(content.to_owned())?;
                }
            }
            Ok(false)
        }
        ProviderKind::Anthropic => {
            if trimmed.starts_with(':') {
                return Ok(false);
            }
            let Some(payload) = trimmed.strip_prefix("data:") else {
                return Ok(false);
            };
            let data = payload.trim_start();
            let val: serde_json::Value = serde_json::from_str(data)?;
            match val.get("type").and_then(|t| t.as_str()) {
                Some("message_stop") => Ok(true),
                Some("content_block_delta") => {
                    if val.pointer("/delta/type").and_then(|t| t.as_str()) == Some("text_delta") {
                        if let Some(text) = val.pointer("/delta/text").and_then(|t| t.as_str()) {
                            if !text.is_empty() {
                                on_chunk(text.to_owned())?;
                            }
                        }
                    }
                    Ok(false)
                }
                Some("error") => {
                    let msg = val
                        .pointer("/error/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Anthropic stream error");
                    let err_type = val
                        .pointer("/error/type")
                        .and_then(|t| t.as_str())
                        .unwrap_or("");
                    if err_type == "authentication_error" {
                        Err(IpcError::provider_auth(msg))
                    } else {
                        Err(IpcError::provider_network(msg))
                    }
                }
                _ => Ok(false),
            }
        }
        ProviderKind::Ollama => {
            let val: serde_json::Value = serde_json::from_str(trimmed)?;
            if let Some(err_msg) = val.get("error").and_then(|e| e.as_str()) {
                return Err(IpcError::provider_network(err_msg));
            }
            if let Some(text) = val.pointer("/message/content").and_then(|c| c.as_str()) {
                if !text.is_empty() {
                    on_chunk(text.to_owned())?;
                }
            }
            Ok(val.get("done").and_then(|d| d.as_bool()) == Some(true))
        }
    }
}

pub async fn stream_completion(
    client: &reqwest::Client,
    req: LlmStreamRequest,
    cancel: CancellationToken,
    mut on_chunk: impl FnMut(String) -> Result<(), IpcError>,
) -> Result<(), IpcError> {
    let base = req.config.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(IpcError::validation("Provider base URL cannot be empty"));
    }

    let key_trimmed = req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let builder = match req.config.provider {
        ProviderKind::OpenaiCompat => {
            let url = format!("{base}/chat/completions");
            let body = build_openai_compat_body(&req);
            let mut b = client
                .post(url)
                .header("Content-Type", "application/json")
                .json(&body);
            if let Some(key) = key_trimmed {
                b = b.header("Authorization", format!("Bearer {key}"));
            }
            b
        }
        ProviderKind::Anthropic => {
            let key = key_trimmed
                .ok_or_else(|| IpcError::provider_auth("Anthropic API key is missing"))?;
            let url = format!("{base}/messages");
            let body = build_anthropic_body(&req);
            client
                .post(url)
                .header("Content-Type", "application/json")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
        }
        ProviderKind::Ollama => {
            let url = format!("{base}/api/chat");
            client
                .post(url)
                .header("Content-Type", "application/json")
                .json(&json!({
                    "model": req.config.model,
                    "stream": true,
                    "options": {
                        "temperature": req.config.temperature,
                        "num_predict": req.config.max_tokens,
                    },
                    "messages": [
                        { "role": "system", "content": req.system_prompt },
                        { "role": "user", "content": req.user_prompt },
                    ]
                }))
        }
    };

    let response = tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        res = builder.send() => res.map_err(map_reqwest_error)?,
    };

    let status = response.status();
    if !status.is_success() {
        let code = status.as_u16();
        let body_text = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            res = response.text() => res.unwrap_or_default(),
        };
        let snippet = cap_snippet(&body_text, 240);
        let msg = if snippet.is_empty() {
            format!("Provider returned HTTP {code}")
        } else {
            format!("HTTP {code}: {snippet}")
        };
        return match code {
            401 | 403 => Err(IpcError::provider_auth(msg)),
            429 | 500..=599 => Err(IpcError::provider_network(msg)),
            _ => Err(IpcError::validation(msg)),
        };
    }

    let mut stream = response.bytes_stream();
    let mut byte_buf: Vec<u8> = Vec::new();

    loop {
        let next_item = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            item = stream.next() => item,
        };
        match next_item {
            None => break,
            Some(Err(err)) => return Err(map_reqwest_error(err)),
            Some(Ok(chunk)) => {
                byte_buf.extend_from_slice(&chunk);
                while let Some(nl_pos) = byte_buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = byte_buf.drain(..=nl_pos).collect();
                    let line_str = String::from_utf8_lossy(&line_bytes);
                    let line = line_str.trim_end_matches(['\r', '\n']);
                    if parse_protocol_line(req.config.provider, line, &mut on_chunk)? {
                        return Ok(());
                    }
                }
            }
        }
    }

    if !byte_buf.is_empty() {
        let trailing = String::from_utf8_lossy(&byte_buf);
        let _ = parse_protocol_line(req.config.provider, trailing.trim_end(), &mut on_chunk)?;
    }

    Ok(())
}

pub async fn test_connection(
    client: &reqwest::Client,
    config: &ModelTierConfig,
    api_key: Option<String>,
) -> TestConnectionResult {
    let started = Instant::now();
    let cancel = CancellationToken::new();
    let mut test_cfg = config.clone();
    test_cfg.max_tokens = 16;

    let req = LlmStreamRequest {
        system_prompt: "You are a connectivity probe.".to_owned(),
        user_prompt: "Reply with OK.".to_owned(),
        config: test_cfg,
        api_key,
    };

    let mut received = String::new();
    let cancel_clone = cancel.clone();
    let fut = stream_completion(client, req, cancel_clone.clone(), |chunk| {
        if !chunk.is_empty() {
            received.push_str(&chunk);
            cancel_clone.cancel();
        }
        Ok(())
    });

    let outcome = tokio::time::timeout(Duration::from_secs(15), fut).await;
    let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    match outcome {
        Ok(Ok(())) => TestConnectionResult {
            ok: true,
            latency_ms,
            message: if received.trim().is_empty() {
                "Connected (stream accepted)".to_owned()
            } else {
                format!("Connected ({} bytes received)", received.len())
            },
        },
        Ok(Err(err)) => TestConnectionResult {
            ok: false,
            latency_ms,
            message: err.message,
        },
        Err(_) => {
            cancel.cancel();
            TestConnectionResult {
                ok: false,
                latency_ms,
                message: "Connection test timed out after 15s".to_owned(),
            }
        }
    }
}

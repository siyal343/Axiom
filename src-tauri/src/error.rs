use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[allow(dead_code)]
pub enum IpcErrorCode {
    WorkspaceNotOpen,
    DbError,
    ValidationError,
    NodeLocked,
    DuplicateEdge,
    ProviderAuth,
    ProviderNetwork,
    RunNotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize, Error)]
#[error("{code:?}: {message}")]
pub struct IpcError {
    pub code: IpcErrorCode,
    pub message: String,
}

#[allow(dead_code)]
impl IpcError {
    pub fn new(code: IpcErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn workspace_not_open() -> Self {
        Self::new(IpcErrorCode::WorkspaceNotOpen, "No workspace is currently open")
    }

    pub fn db(message: impl Into<String>) -> Self {
        Self::new(IpcErrorCode::DbError, message)
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(IpcErrorCode::ValidationError, message)
    }

    pub fn node_locked(id: &str) -> Self {
        Self::new(IpcErrorCode::NodeLocked, format!("Node {id} is locked"))
    }

    pub fn duplicate_edge(message: impl Into<String>) -> Self {
        Self::new(IpcErrorCode::DuplicateEdge, message)
    }

    pub fn provider_auth(message: impl Into<String>) -> Self {
        Self::new(IpcErrorCode::ProviderAuth, message)
    }

    pub fn provider_network(message: impl Into<String>) -> Self {
        Self::new(IpcErrorCode::ProviderNetwork, message)
    }

    pub fn run_not_found(run_id: &str) -> Self {
        Self::new(IpcErrorCode::RunNotFound, format!("Run {run_id} not found"))
    }
}

impl From<rusqlite::Error> for IpcError {
    fn from(err: rusqlite::Error) -> Self {
        Self::db(err.to_string())
    }
}

impl From<std::io::Error> for IpcError {
    fn from(err: std::io::Error) -> Self {
        Self::db(err.to_string())
    }
}

impl From<serde_json::Error> for IpcError {
    fn from(err: serde_json::Error) -> Self {
        Self::validation(err.to_string())
    }
}

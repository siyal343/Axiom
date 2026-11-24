pub mod commands;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use rusqlite::Connection;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::graph::GraphEngine;

#[allow(dead_code)]
pub struct ActiveWorkspace {
    pub path: String,
    pub engine: GraphEngine,
}

#[allow(dead_code)]
pub struct AppState {
    pub workspace: Arc<RwLock<Option<ActiveWorkspace>>>,
    pub db: Arc<Mutex<Option<Connection>>>,
    pub active_runs: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub summary_tx: mpsc::UnboundedSender<String>,
}

impl AppState {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<String>) {
        let (summary_tx, summary_rx) = mpsc::unbounded_channel();
        (
            Self {
                workspace: Arc::new(RwLock::new(None)),
                db: Arc::new(Mutex::new(None)),
                active_runs: Arc::new(Mutex::new(HashMap::new())),
                summary_tx,
            },
            summary_rx,
        )
    }
}

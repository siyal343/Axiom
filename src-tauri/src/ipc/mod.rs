pub mod commands;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::graph::GraphEngine;
use crate::settings::SettingsStore;
use crate::workspaces::WorkspaceCatalogStore;

pub struct ActiveWorkspace {
    pub path: String,
    pub engine: GraphEngine,
    pub token_budget: u32,
}

pub struct AppState {
    pub workspace: Arc<RwLock<Option<ActiveWorkspace>>>,
    pub db: Arc<Mutex<Option<Connection>>>,
    pub active_runs: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub summary_tx: mpsc::UnboundedSender<String>,
    pub http_client: reqwest::Client,
    pub settings: Arc<SettingsStore>,
    pub workspaces: Arc<WorkspaceCatalogStore>,
    pub seed_stress_on_open: Arc<AtomicBool>,
}

impl AppState {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<String>) {
        let (summary_tx, summary_rx) = mpsc::unbounded_channel();
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let settings = Arc::new(SettingsStore::new().unwrap_or_else(|_| {
            SettingsStore::with_config_path(PathBuf::from("axiom-settings.json"), false)
        }));
        let workspaces = Arc::new(WorkspaceCatalogStore::new().unwrap_or_else(|_| {
            WorkspaceCatalogStore::with_root_dir(PathBuf::from(".axiom"))
        }));
        (
            Self {
                workspace: Arc::new(RwLock::new(None)),
                db: Arc::new(Mutex::new(None)),
                active_runs: Arc::new(Mutex::new(HashMap::new())),
                summary_tx,
                http_client,
                settings,
                workspaces,
                seed_stress_on_open: Arc::new(AtomicBool::new(false)),
            },
            summary_rx,
        )
    }
}

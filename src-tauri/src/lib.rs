pub mod ai;
pub mod db;
pub mod error;
pub mod graph;
pub mod ipc;
pub mod settings;
pub mod workspaces;

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::Emitter;

use ipc::AppState;

pub fn run() {
    let (app_state, summary_rx) = AppState::new();
    if cfg!(debug_assertions) && std::env::args().any(|a| a == "--seed-stress-500") {
        app_state
            .seed_stress_on_open
            .store(true, Ordering::SeqCst);
    }
    let workspace = app_state.workspace.clone();
    let db = app_state.db.clone();
    let workspace_generation = app_state.workspace_generation.clone();
    let http_client = app_state.http_client.clone();
    let settings = app_state.settings.clone();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            ai::summarizer::spawn_summarizer_worker(
                summary_rx,
                workspace,
                db,
                workspace_generation,
                http_client,
                settings,
                Duration::from_millis(1500),
                move |evt| {
                    let _ = app_handle.emit("axiom://summary-updated", evt);
                },
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::commands::open_workspace,
            ipc::commands::list_workspace_catalog,
            ipc::commands::create_workspace,
            ipc::commands::rename_workspace,
            ipc::commands::delete_workspace,
            ipc::commands::create_flow,
            ipc::commands::open_flow,
            ipc::commands::rename_flow,
            ipc::commands::delete_flow,
            ipc::commands::apply_ops,
            ipc::commands::spawn_connected_node,
            ipc::commands::compile_xray,
            ipc::commands::search_nodes,
            ipc::commands::tidy_subtree,
            ipc::commands::resolve_overlaps,
            ipc::commands::save_camera,
            ipc::commands::export_json,
            ipc::commands::import_json,
            ipc::commands::export_markdown_artifact,
            ipc::commands::run_lens,
            ipc::commands::cancel_run,
            ipc::commands::get_settings,
            ipc::commands::save_settings,
            ipc::commands::test_provider_connection,
            ipc::commands::seed_stress_500,
        ]);

    if let Err(err) = builder.run(tauri::generate_context!()) {
        eprintln!("Failed to run Axiom application: {err}");
    }
}

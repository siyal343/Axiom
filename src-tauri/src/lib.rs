pub mod ai;
pub mod db;
pub mod error;
pub mod graph;
pub mod ipc;

use ipc::AppState;

pub fn run() {
    let (app_state, mut summary_rx) = AppState::new();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(move |_app| {
            // Slice 0 placeholder drain; Slice 4 replaces with debounced summarizer worker.
            tauri::async_runtime::spawn(async move {
                while summary_rx.recv().await.is_some() {}
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::commands::open_workspace,
            ipc::commands::apply_ops,
            ipc::commands::spawn_connected_node,
            ipc::commands::compile_xray,
            ipc::commands::search_nodes,
            ipc::commands::tidy_subtree,
            ipc::commands::save_camera,
            ipc::commands::export_json,
            ipc::commands::import_json,
        ]);

    if let Err(err) = builder.run(tauri::generate_context!()) {
        eprintln!("Failed to run Axiom application: {err}");
    }
}

mod db;
mod error;
mod graph;
mod ipc;

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
        .invoke_handler(tauri::generate_handler![ipc::commands::open_workspace]);

    if let Err(err) = builder.run(tauri::generate_context!()) {
        eprintln!("Failed to run Axiom application: {err}");
    }
}

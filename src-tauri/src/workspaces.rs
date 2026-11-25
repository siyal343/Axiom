use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::IpcError;
use crate::graph::models::{now_epoch_ms, FlowEntryDto, WorkspaceCatalogDto, WorkspaceEntryDto};

const VALID_TEMPLATES: [&str; 4] = ["blank", "engineering", "research", "study"];

pub struct WorkspaceCatalogStore {
    root_dir: PathBuf,
    catalog_path: PathBuf,
    default_db_path: PathBuf,
    lock: Mutex<()>,
}

impl WorkspaceCatalogStore {
    pub fn new() -> Result<Self, IpcError> {
        let home = dirs::home_dir()
            .ok_or_else(|| IpcError::db("Unable to resolve user home directory for workspaces"))?;
        Ok(Self::with_root_dir(home.join(".axiom")))
    }

    pub fn with_root_dir(root: PathBuf) -> Self {
        let catalog_path = root.join("catalog.json");
        let default_db_path = root.join("default.sqlite");
        Self {
            root_dir: root,
            catalog_path,
            default_db_path,
            lock: Mutex::new(()),
        }
    }

    fn flow_db_path(&self, workspace_id: &str, flow_id: &str) -> PathBuf {
        self.root_dir
            .join("workspaces")
            .join(workspace_id)
            .join(format!("{flow_id}.sqlite"))
    }

    fn write_atomic(&self, catalog: &WorkspaceCatalogDto) -> Result<(), IpcError> {
        if let Some(parent) = self.catalog_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let json = serde_json::to_string_pretty(catalog)?;
        let file_name = self
            .catalog_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("catalog.json");
        let tmp_path = self
            .catalog_path
            .with_file_name(format!(".{file_name}.{}.tmp", ulid::Ulid::new()));
        {
            let mut f = std::fs::File::create(&tmp_path)?;
            f.write_all(json.as_bytes())?;
            f.sync_all()?;
        }
        if let Err(err) = std::fs::rename(&tmp_path, &self.catalog_path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(err.into());
        }
        Ok(())
    }

    fn load_or_init_locked(&self) -> Result<WorkspaceCatalogDto, IpcError> {
        if self.catalog_path.exists() {
            let raw = std::fs::read_to_string(&self.catalog_path)?;
            let mut catalog: WorkspaceCatalogDto = serde_json::from_str(&raw)?;
            if !catalog.workspaces.is_empty() {
                ensure_active_pointers(&mut catalog);
                return Ok(catalog);
            }
        }

        let now = now_epoch_ms();
        let ws_id = format!("ws_{}", ulid::Ulid::new());
        let flow_id = format!("flow_{}", ulid::Ulid::new());
        let default_flow = FlowEntryDto {
            id: flow_id.clone(),
            workspace_id: ws_id.clone(),
            name: "Main Flow".to_owned(),
            template: "engineering".to_owned(),
            db_path: self.default_db_path.to_string_lossy().into_owned(),
            updated_at: now,
        };
        let default_ws = WorkspaceEntryDto {
            id: ws_id.clone(),
            name: "Default Workspace".to_owned(),
            created_at: now,
            flows: vec![default_flow],
        };
        let catalog = WorkspaceCatalogDto {
            workspaces: vec![default_ws],
            active_workspace_id: ws_id,
            active_flow_id: flow_id,
        };
        self.write_atomic(&catalog)?;
        Ok(catalog)
    }

    pub fn load_or_init(&self) -> Result<WorkspaceCatalogDto, IpcError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| IpcError::db("Workspace catalog lock poisoned"))?;
        self.load_or_init_locked()
    }

    pub fn create_workspace(&self, name: &str) -> Result<WorkspaceEntryDto, IpcError> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(IpcError::validation("Workspace name cannot be empty"));
        }

        let _guard = self
            .lock
            .lock()
            .map_err(|_| IpcError::db("Workspace catalog lock poisoned"))?;
        let mut catalog = self.load_or_init_locked()?;
        let now = now_epoch_ms();
        let ws_id = format!("ws_{}", ulid::Ulid::new());
        let flow_id = format!("flow_{}", ulid::Ulid::new());
        let flow_db = self
            .flow_db_path(&ws_id, &flow_id)
            .to_string_lossy()
            .into_owned();
        let flow = FlowEntryDto {
            id: flow_id,
            workspace_id: ws_id.clone(),
            name: "Main Flow".to_owned(),
            template: "engineering".to_owned(),
            db_path: flow_db,
            updated_at: now,
        };
        let ws = WorkspaceEntryDto {
            id: ws_id,
            name: trimmed.to_owned(),
            created_at: now,
            flows: vec![flow],
        };
        catalog.workspaces.push(ws.clone());
        self.write_atomic(&catalog)?;
        Ok(ws)
    }

    pub fn rename_workspace(
        &self,
        workspace_id: &str,
        name: &str,
    ) -> Result<WorkspaceCatalogDto, IpcError> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(IpcError::validation("Workspace name cannot be empty"));
        }

        let _guard = self
            .lock
            .lock()
            .map_err(|_| IpcError::db("Workspace catalog lock poisoned"))?;
        let mut catalog = self.load_or_init_locked()?;
        let ws = catalog
            .workspaces
            .iter_mut()
            .find(|w| w.id == workspace_id)
            .ok_or_else(|| IpcError::validation(format!("Workspace {workspace_id} not found")))?;
        ws.name = trimmed.to_owned();
        self.write_atomic(&catalog)?;
        Ok(catalog)
    }

    pub fn delete_workspace(&self, workspace_id: &str) -> Result<WorkspaceCatalogDto, IpcError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| IpcError::db("Workspace catalog lock poisoned"))?;
        let mut catalog = self.load_or_init_locked()?;
        if catalog.workspaces.len() <= 1 {
            return Err(IpcError::validation(
                "Cannot delete the last remaining workspace",
            ));
        }

        let idx = catalog
            .workspaces
            .iter()
            .position(|w| w.id == workspace_id)
            .ok_or_else(|| IpcError::validation(format!("Workspace {workspace_id} not found")))?;
        let removed = catalog.workspaces.remove(idx);

        for flow in &removed.flows {
            cleanup_sqlite_files(Path::new(&flow.db_path));
        }
        let ws_dir = self.root_dir.join("workspaces").join(&removed.id);
        if ws_dir.exists() {
            let _ = std::fs::remove_dir_all(&ws_dir);
        }

        ensure_active_pointers(&mut catalog);
        self.write_atomic(&catalog)?;
        Ok(catalog)
    }

    pub fn create_flow(
        &self,
        workspace_id: &str,
        name: &str,
        template: &str,
    ) -> Result<(WorkspaceCatalogDto, FlowEntryDto), IpcError> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(IpcError::validation("Flow name cannot be empty"));
        }
        let normalized_template = template.trim().to_ascii_lowercase();
        if !VALID_TEMPLATES.contains(&normalized_template.as_str()) {
            return Err(IpcError::validation(format!(
                "Invalid flow template '{}', expected one of: blank, engineering, research, study",
                template
            )));
        }

        let _guard = self
            .lock
            .lock()
            .map_err(|_| IpcError::db("Workspace catalog lock poisoned"))?;
        let mut catalog = self.load_or_init_locked()?;
        let ws = catalog
            .workspaces
            .iter_mut()
            .find(|w| w.id == workspace_id)
            .ok_or_else(|| IpcError::validation(format!("Workspace {workspace_id} not found")))?;

        let now = now_epoch_ms();
        let flow_id = format!("flow_{}", ulid::Ulid::new());
        let flow = FlowEntryDto {
            id: flow_id.clone(),
            workspace_id: ws.id.clone(),
            name: trimmed.to_owned(),
            template: normalized_template,
            db_path: self
                .flow_db_path(&ws.id, &flow_id)
                .to_string_lossy()
                .into_owned(),
            updated_at: now,
        };
        ws.flows.push(flow.clone());
        catalog.active_workspace_id = ws.id.clone();
        catalog.active_flow_id = flow.id.clone();
        self.write_atomic(&catalog)?;
        Ok((catalog, flow))
    }

    pub fn set_active(
        &self,
        workspace_id: &str,
        flow_id: &str,
    ) -> Result<(WorkspaceCatalogDto, FlowEntryDto), IpcError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| IpcError::db("Workspace catalog lock poisoned"))?;
        let mut catalog = self.load_or_init_locked()?;
        let ws = catalog
            .workspaces
            .iter_mut()
            .find(|w| w.id == workspace_id)
            .ok_or_else(|| IpcError::validation(format!("Workspace {workspace_id} not found")))?;
        let flow = ws
            .flows
            .iter_mut()
            .find(|f| f.id == flow_id)
            .ok_or_else(|| {
                IpcError::validation(format!(
                    "Flow {flow_id} not found in workspace {workspace_id}"
                ))
            })?;
        flow.updated_at = now_epoch_ms();
        let found = flow.clone();
        catalog.active_workspace_id = workspace_id.to_owned();
        catalog.active_flow_id = flow_id.to_owned();
        self.write_atomic(&catalog)?;
        Ok((catalog, found))
    }

    pub fn rename_flow(
        &self,
        workspace_id: &str,
        flow_id: &str,
        name: &str,
    ) -> Result<WorkspaceCatalogDto, IpcError> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(IpcError::validation("Flow name cannot be empty"));
        }

        let _guard = self
            .lock
            .lock()
            .map_err(|_| IpcError::db("Workspace catalog lock poisoned"))?;
        let mut catalog = self.load_or_init_locked()?;
        let ws = catalog
            .workspaces
            .iter_mut()
            .find(|w| w.id == workspace_id)
            .ok_or_else(|| IpcError::validation(format!("Workspace {workspace_id} not found")))?;
        let flow = ws
            .flows
            .iter_mut()
            .find(|f| f.id == flow_id)
            .ok_or_else(|| {
                IpcError::validation(format!(
                    "Flow {flow_id} not found in workspace {workspace_id}"
                ))
            })?;
        flow.name = trimmed.to_owned();
        flow.updated_at = now_epoch_ms();
        self.write_atomic(&catalog)?;
        Ok(catalog)
    }

    pub fn delete_flow(
        &self,
        workspace_id: &str,
        flow_id: &str,
    ) -> Result<WorkspaceCatalogDto, IpcError> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| IpcError::db("Workspace catalog lock poisoned"))?;
        let mut catalog = self.load_or_init_locked()?;
        let ws_count = catalog.workspaces.len();
        let ws = catalog
            .workspaces
            .iter_mut()
            .find(|w| w.id == workspace_id)
            .ok_or_else(|| IpcError::validation(format!("Workspace {workspace_id} not found")))?;

        let flow_idx = ws
            .flows
            .iter()
            .position(|f| f.id == flow_id)
            .ok_or_else(|| {
                IpcError::validation(format!(
                    "Flow {flow_id} not found in workspace {workspace_id}"
                ))
            })?;

        if ws_count == 1 && ws.flows.len() <= 1 {
            return Err(IpcError::validation(
                "Cannot delete the sole flow in the only remaining workspace",
            ));
        }

        let removed = ws.flows.remove(flow_idx);
        cleanup_sqlite_files(Path::new(&removed.db_path));

        if ws.flows.is_empty() {
            let now = now_epoch_ms();
            let fallback_id = format!("flow_{}", ulid::Ulid::new());
            let fallback_db = self
                .flow_db_path(&ws.id, &fallback_id)
                .to_string_lossy()
                .into_owned();
            ws.flows.push(FlowEntryDto {
                id: fallback_id,
                workspace_id: ws.id.clone(),
                name: "Untitled Flow".to_owned(),
                template: "blank".to_owned(),
                db_path: fallback_db,
                updated_at: now,
            });
        }

        ensure_active_pointers(&mut catalog);
        self.write_atomic(&catalog)?;
        Ok(catalog)
    }
}

fn ensure_active_pointers(catalog: &mut WorkspaceCatalogDto) {
    let active_ws_idx = catalog
        .workspaces
        .iter()
        .position(|w| w.id == catalog.active_workspace_id)
        .unwrap_or(0);
    if let Some(ws) = catalog.workspaces.get(active_ws_idx) {
        catalog.active_workspace_id = ws.id.clone();
        let has_active_flow = ws.flows.iter().any(|f| f.id == catalog.active_flow_id);
        if !has_active_flow {
            if let Some(first_flow) = ws.flows.first() {
                catalog.active_flow_id = first_flow.id.clone();
            }
        }
    }
}

fn cleanup_sqlite_files(db_path: &Path) {
    let base = db_path.to_string_lossy();
    let wal = PathBuf::from(format!("{base}-wal"));
    let shm = PathBuf::from(format!("{base}-shm"));
    for target in [db_path, wal.as_path(), shm.as_path()] {
        let _ = std::fs::remove_file(target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::prompts::{lens_defaults, lens_prompt, lens_to_origin};
    use crate::db::{open_connection, seed_flow_template};
    use crate::error::IpcErrorCode;
    use crate::graph::models::{LensKind, NodeLensOrigin, NodeType};

    #[test]
    fn catalog_init_preserves_default_workspace_and_default_sqlite_path() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = WorkspaceCatalogStore::with_root_dir(dir.path().to_path_buf());
        let catalog = store.load_or_init().expect("init catalog");

        assert_eq!(catalog.workspaces.len(), 1);
        assert_eq!(catalog.workspaces[0].name, "Default Workspace");
        assert_eq!(catalog.workspaces[0].flows.len(), 1);
        assert_eq!(catalog.workspaces[0].flows[0].name, "Main Flow");
        assert_eq!(catalog.workspaces[0].flows[0].template, "engineering");
        assert_eq!(
            PathBuf::from(&catalog.workspaces[0].flows[0].db_path),
            dir.path().join("default.sqlite")
        );
        assert_eq!(catalog.active_workspace_id, catalog.workspaces[0].id);
        assert_eq!(catalog.active_flow_id, catalog.workspaces[0].flows[0].id);

        // Second load returns exact persisted IDs
        let reloaded = store.load_or_init().expect("reload catalog");
        assert_eq!(reloaded.workspaces[0].id, catalog.workspaces[0].id);
        assert_eq!(reloaded.active_flow_id, catalog.active_flow_id);
    }

    #[test]
    fn workspace_crud_creates_renames_deletes_and_rejects_last_workspace() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = WorkspaceCatalogStore::with_root_dir(dir.path().to_path_buf());
        let initial = store.load_or_init().expect("init catalog");
        let default_ws_id = initial.workspaces[0].id.clone();

        let err = store
            .delete_workspace(&default_ws_id)
            .expect_err("cannot delete sole workspace");
        assert_eq!(err.code, IpcErrorCode::ValidationError);

        let bio_ws = store.create_workspace("Bio Lab").expect("create workspace");
        assert_eq!(bio_ws.name, "Bio Lab");
        assert_eq!(bio_ws.flows.len(), 1);

        let renamed = store
            .rename_workspace(&bio_ws.id, "Molecular Research")
            .expect("rename workspace");
        assert!(renamed
            .workspaces
            .iter()
            .any(|w| w.id == bio_ws.id && w.name == "Molecular Research"));

        // Touch sqlite + wal files for the workspace flow to confirm cleanup
        let flow_db = PathBuf::from(&bio_ws.flows[0].db_path);
        std::fs::create_dir_all(flow_db.parent().expect("flow dir")).expect("mkdir");
        std::fs::write(&flow_db, b"dummy").expect("write db");
        std::fs::write(format!("{}-wal", flow_db.to_string_lossy()), b"wal").expect("write wal");

        let after_del = store
            .delete_workspace(&bio_ws.id)
            .expect("delete second workspace");
        assert_eq!(after_del.workspaces.len(), 1);
        assert!(!flow_db.exists());
        assert!(!PathBuf::from(format!("{}-wal", flow_db.to_string_lossy())).exists());
    }

    #[test]
    fn flow_crud_creates_switches_renames_deletes_and_handles_last_flow() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = WorkspaceCatalogStore::with_root_dir(dir.path().to_path_buf());
        let initial = store.load_or_init().expect("init catalog");
        let ws1 = initial.workspaces[0].id.clone();
        let f1 = initial.workspaces[0].flows[0].id.clone();

        // Sole flow in sole workspace cannot be deleted
        let sole_err = store
            .delete_flow(&ws1, &f1)
            .expect_err("sole flow in sole workspace rejected");
        assert_eq!(sole_err.code, IpcErrorCode::ValidationError);

        // Create second flow and second workspace
        let (cat2, research_flow) = store
            .create_flow(&ws1, "Quantum Optics", "research")
            .expect("create research flow");
        assert_eq!(cat2.active_flow_id, research_flow.id);
        assert_eq!(research_flow.template, "research");

        let cat_renamed = store
            .rename_flow(&ws1, &research_flow.id, "Quantum Optics v2")
            .expect("rename flow");
        let found = cat_renamed.workspaces[0]
            .flows
            .iter()
            .find(|f| f.id == research_flow.id)
            .expect("flow present");
        assert_eq!(found.name, "Quantum Optics v2");

        let (cat_switched, active_back) = store.set_active(&ws1, &f1).expect("set active flow");
        assert_eq!(cat_switched.active_flow_id, f1);
        assert_eq!(active_back.id, f1);

        let ws2 = store.create_workspace("Study").expect("create ws2");
        let cat_after_ws2_del = store
            .delete_flow(&ws2.id, &ws2.flows[0].id)
            .expect("deleting last flow in multi-workspace setup auto-creates Untitled Flow");
        let ws2_after = cat_after_ws2_del
            .workspaces
            .iter()
            .find(|w| w.id == ws2.id)
            .expect("ws2 still exists");
        assert_eq!(ws2_after.flows.len(), 1);
        assert_eq!(ws2_after.flows[0].name, "Untitled Flow");
        assert_eq!(ws2_after.flows[0].template, "blank");
    }

    #[test]
    fn seed_flow_template_seeds_research_study_and_blank_templates() {
        let dir = tempfile::tempdir().expect("temp dir");

        let blank_path = dir.path().join("blank.sqlite");
        let mut blank_conn = open_connection(&blank_path).expect("open blank db");
        let blank_snap =
            seed_flow_template(&mut blank_conn, &blank_path.to_string_lossy(), "blank")
                .expect("seed blank");
        assert_eq!(blank_snap.nodes.len(), 1);
        assert_eq!(blank_snap.nodes[0].title, "New Topic");
        assert!(blank_snap.edges.is_empty());

        let research_path = dir.path().join("research.sqlite");
        let mut research_conn = open_connection(&research_path).expect("open research db");
        let research_snap =
            seed_flow_template(&mut research_conn, &research_path.to_string_lossy(), "research")
                .expect("seed research");
        assert_eq!(research_snap.nodes.len(), 3);
        assert_eq!(research_snap.edges.len(), 2);
        assert!(research_snap
            .nodes
            .iter()
            .any(|n| n.title == "Research Question"));
        assert!(research_snap
            .nodes
            .iter()
            .any(|n| n.title == "Literature & Evidence"));
        assert!(research_snap
            .nodes
            .iter()
            .any(|n| n.title == "Hypotheses & Gaps"));

        let study_path = dir.path().join("study.sqlite");
        let mut study_conn = open_connection(&study_path).expect("open study db");
        let study_snap =
            seed_flow_template(&mut study_conn, &study_path.to_string_lossy(), "study")
                .expect("seed study");
        assert_eq!(study_snap.nodes.len(), 3);
        assert_eq!(study_snap.edges.len(), 2);
        assert!(study_snap
            .nodes
            .iter()
            .any(|n| n.title == "Topic to Master"));
        assert!(study_snap
            .nodes
            .iter()
            .any(|n| n.title == "First-Principles Breakdown"));
        assert!(study_snap
            .nodes
            .iter()
            .any(|n| n.title == "Active Recall Questions"));
    }

    #[test]
    fn research_and_study_lenses_have_prompts_defaults_and_sqlite_safe_origins() {
        assert!(lens_prompt(LensKind::Research).contains("Core Findings"));
        assert!(lens_prompt(LensKind::Study).contains("Active-Recall Quiz"));
        assert_eq!(lens_defaults(LensKind::Research).title, "Research Brief");
        assert_eq!(lens_defaults(LensKind::Research).node_type, NodeType::Probe);
        assert_eq!(lens_defaults(LensKind::Study).title, "Study & Recall");
        assert_eq!(lens_defaults(LensKind::Study).node_type, NodeType::Probe);
        assert_eq!(lens_to_origin(LensKind::Research), NodeLensOrigin::Custom);
        assert_eq!(lens_to_origin(LensKind::Study), NodeLensOrigin::Feynman);
    }
}

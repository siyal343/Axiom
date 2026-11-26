pub mod json_io;
pub mod migrations;
pub mod queries;
pub mod stress;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, Row, TransactionBehavior};

use crate::error::IpcError;
use crate::graph::models::{
    compute_content_hash, estimate_tokens, now_epoch_ms, CameraState, CanvasGroupDto,
    ContextControls, CreatedBy, EdgeDto, EdgeType, EdgeWeight, NodeDto, NodeLayout, NodeLensOrigin,
    NodeMetadata, NodeStatus, NodeType, Severity, WorkspaceSnapshot,
};

pub fn default_workspace_path() -> Result<PathBuf, IpcError> {
    let home = dirs::home_dir()
        .ok_or_else(|| IpcError::db("Unable to resolve user home directory for default workspace"))?;
    Ok(home.join(".axiom").join("default.sqlite"))
}

pub fn open_connection(path: &Path) -> Result<Connection, IpcError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let conn = Connection::open(path)?;
    migrations::run_migrations(&conn)?;
    Ok(conn)
}

fn map_from_sql_err(err: IpcError, col_idx: usize) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        col_idx,
        rusqlite::types::Type::Text,
        Box::new(err),
    )
}

pub(crate) fn row_to_node_dto(row: &Row<'_>) -> rusqlite::Result<NodeDto> {
    let type_str: String = row.get(1)?;
    let status_str: String = row.get(2)?;
    let severity_opt: Option<String> = row.get(8)?;
    let lens_str: String = row.get(9)?;
    let created_by_str: String = row.get(10)?;
    let pin_global: i64 = row.get(13)?;
    let exclude_from_ai: i64 = row.get(14)?;
    let collapsed: i64 = row.get(19)?;
    let token_count_raw: i64 = row.get(12)?;

    let node_type = NodeType::from_db_str(&type_str).map_err(|e| map_from_sql_err(e, 1))?;
    let status = NodeStatus::from_db_str(&status_str).map_err(|e| map_from_sql_err(e, 2))?;
    let severity = match severity_opt {
        Some(ref s) => Some(Severity::from_db_str(s).map_err(|e| map_from_sql_err(e, 8))?),
        None => None,
    };
    let lens = NodeLensOrigin::from_db_str(&lens_str).map_err(|e| map_from_sql_err(e, 9))?;
    let created_by =
        CreatedBy::from_db_str(&created_by_str).map_err(|e| map_from_sql_err(e, 10))?;

    Ok(NodeDto {
        id: row.get(0)?,
        node_type,
        status,
        title: row.get(3)?,
        content: row.get(4)?,
        summary: row.get(5)?,
        content_hash: row.get(6)?,
        summary_hash: row.get(7)?,
        metadata: NodeMetadata {
            severity,
            lens,
            created_by,
            model: row.get(11)?,
            token_count: u32::try_from(token_count_raw).unwrap_or(0),
        },
        context_controls: ContextControls {
            pin_global: pin_global != 0,
            exclude_from_ai: exclude_from_ai != 0,
        },
        layout: NodeLayout {
            x: row.get(15)?,
            y: row.get(16)?,
            width: row.get(17)?,
            height: row.get(18)?,
            collapsed: collapsed != 0,
        },
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
    })
}

pub(crate) fn row_to_edge_dto(row: &Row<'_>) -> rusqlite::Result<EdgeDto> {
    let type_str: String = row.get(3)?;
    let weight_str: String = row.get(4)?;
    let edge_type = EdgeType::from_db_str(&type_str).map_err(|e| map_from_sql_err(e, 3))?;
    let weight = EdgeWeight::from_db_str(&weight_str).map_err(|e| map_from_sql_err(e, 4))?;

    Ok(EdgeDto {
        id: row.get(0)?,
        source_id: row.get(1)?,
        target_id: row.get(2)?,
        edge_type,
        weight,
        created_at: row.get(5)?,
    })
}

pub(crate) fn row_to_canvas_group_dto(row: &Row<'_>) -> rusqlite::Result<CanvasGroupDto> {
    let member_ids_json: String = row.get(3)?;
    let member_ids: Vec<String> = serde_json::from_str(&member_ids_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let collapsed_raw: i64 = row.get(4)?;
    Ok(CanvasGroupDto {
        id: row.get(0)?,
        title: row.get(1)?,
        color_key: row.get(2)?,
        member_ids,
        collapsed: collapsed_raw != 0,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

pub fn hydrate_or_seed_workspace(
    conn: &mut Connection,
    path_str: &str,
) -> Result<WorkspaceSnapshot, IpcError> {
    let mut nodes: Vec<NodeDto> = {
        let mut stmt = conn.prepare(
            "SELECT id, type, status, title, content, summary, content_hash, summary_hash,
                    severity, lens, created_by, model, token_count,
                    pin_global, exclude_from_ai, x, y, width, height, collapsed,
                    created_at, updated_at
             FROM nodes
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], row_to_node_dto)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        out
    };

    let edges: Vec<EdgeDto> = {
        let mut stmt = conn.prepare(
            "SELECT id, source_id, target_id, type, weight, created_at
             FROM edges
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], row_to_edge_dto)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        out
    };

    let groups: Vec<CanvasGroupDto> = {
        let mut stmt = conn.prepare(
            "SELECT id, title, color_key, member_ids, collapsed, created_at, updated_at
             FROM canvas_groups
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], row_to_canvas_group_dto)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        out
    };

    let meta: HashMap<String, String> = {
        let mut stmt = conn.prepare("SELECT key, value FROM workspace_meta")?;
        let rows = stmt.query_map([], |row| {
            let k: String = row.get(0)?;
            let v: String = row.get(1)?;
            Ok((k, v))
        })?;
        let mut map = HashMap::new();
        for pair in rows {
            let (k, v) = pair?;
            map.insert(k, v);
        }
        map
    };

    let camera_x = meta
        .get("camera_x")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let camera_y = meta
        .get("camera_y")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let camera_zoom = meta
        .get("camera_zoom")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(1.0);
    let mut last_focus_id = meta
        .get("last_focus_id")
        .filter(|v| !v.is_empty())
        .cloned();
    let token_budget = meta
        .get("token_budget")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(6000);
    let system_prompt = meta.get("system_prompt").cloned().unwrap_or_default();

    if nodes.is_empty() {
        let now = now_epoch_ms();
        let title = String::from("System Architecture");
        let content = String::new();
        let content_hash = compute_content_hash(&title, &content);
        let starter = NodeDto {
            id: format!("node_{}", ulid::Ulid::new()),
            node_type: NodeType::Core,
            status: NodeStatus::Active,
            title,
            content,
            summary: String::new(),
            content_hash,
            summary_hash: String::new(),
            metadata: NodeMetadata {
                severity: None,
                lens: NodeLensOrigin::Manual,
                created_by: CreatedBy::User,
                model: None,
                token_count: estimate_tokens("System Architecture"),
            },
            context_controls: ContextControls {
                pin_global: false,
                exclude_from_ai: false,
            },
            layout: NodeLayout {
                x: 0.0,
                y: 0.0,
                width: 320.0,
                height: 180.0,
                collapsed: false,
            },
            created_at: now,
            updated_at: now,
        };

        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO nodes (
                id, type, status, title, content, summary, content_hash, summary_hash,
                severity, lens, created_by, model, token_count,
                pin_global, exclude_from_ai, x, y, width, height, collapsed,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            params![
                starter.id,
                starter.node_type.as_str(),
                starter.status.as_str(),
                starter.title,
                starter.content,
                starter.summary,
                starter.content_hash,
                starter.summary_hash,
                Option::<&str>::None,
                starter.metadata.lens.as_str(),
                starter.metadata.created_by.as_str(),
                starter.metadata.model,
                i64::from(starter.metadata.token_count),
                0_i64,
                0_i64,
                starter.layout.x,
                starter.layout.y,
                starter.layout.width,
                starter.layout.height,
                0_i64,
                starter.created_at,
                starter.updated_at,
            ],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('last_focus_id', ?1)",
            params![starter.id],
        )?;
        tx.commit()?;

        last_focus_id = Some(starter.id.clone());
        nodes.push(starter);
    }

    Ok(WorkspaceSnapshot {
        path: path_str.to_owned(),
        nodes,
        edges,
        groups,
        camera: CameraState {
            x: camera_x,
            y: camera_y,
            zoom: camera_zoom,
            last_focus_id,
        },
        token_budget,
        system_prompt,
    })
}

fn make_template_node(
    node_type: NodeType,
    title: &str,
    content: &str,
    x: f64,
    y: f64,
    now: i64,
) -> NodeDto {
    let content_hash = compute_content_hash(title, content);
    let token_count = estimate_tokens(&format!("{title}\n{content}"));
    NodeDto {
        id: format!("node_{}", ulid::Ulid::new()),
        node_type,
        status: NodeStatus::Active,
        title: title.to_owned(),
        content: content.to_owned(),
        summary: String::new(),
        content_hash,
        summary_hash: String::new(),
        metadata: NodeMetadata {
            severity: None,
            lens: NodeLensOrigin::Manual,
            created_by: CreatedBy::User,
            model: None,
            token_count,
        },
        context_controls: ContextControls {
            pin_global: false,
            exclude_from_ai: false,
        },
        layout: NodeLayout {
            x,
            y,
            width: 320.0,
            height: 180.0,
            collapsed: false,
        },
        created_at: now,
        updated_at: now,
    }
}

fn make_template_edge(
    source_id: &str,
    target_id: &str,
    edge_type: EdgeType,
    now: i64,
) -> EdgeDto {
    EdgeDto {
        id: format!("edge_{}", ulid::Ulid::new()),
        source_id: source_id.to_owned(),
        target_id: target_id.to_owned(),
        edge_type,
        weight: EdgeWeight::Summary,
        created_at: now,
    }
}

pub fn seed_flow_template(
    conn: &mut Connection,
    path_str: &str,
    template: &str,
) -> Result<WorkspaceSnapshot, IpcError> {
    let existing_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM nodes", [], |row| row.get(0))?;
    let normalized = template.trim().to_ascii_lowercase();
    if existing_count > 0 || normalized == "engineering" {
        return hydrate_or_seed_workspace(conn, path_str);
    }

    let now = now_epoch_ms();
    let (nodes, edges): (Vec<NodeDto>, Vec<EdgeDto>) = match normalized.as_str() {
        "blank" => {
            let starter = make_template_node(NodeType::Core, "New Topic", "", 0.0, 0.0, now);
            (vec![starter], Vec::new())
        }
        "research" => {
            let root = make_template_node(
                NodeType::Core,
                "Research Question",
                "Define the central hypothesis, measurable variables, and scope.",
                0.0,
                0.0,
                now,
            );
            let lit = make_template_node(
                NodeType::Probe,
                "Literature & Evidence",
                "Key prior studies, datasets, and baseline empirical bounds.",
                420.0,
                -110.0,
                now,
            );
            let gaps = make_template_node(
                NodeType::Branch,
                "Hypotheses & Gaps",
                "Competing mechanisms, confounders, and open experimental tests.",
                420.0,
                120.0,
                now,
            );
            let e1 = make_template_edge(&root.id, &lit.id, EdgeType::Derives, now);
            let e2 = make_template_edge(&root.id, &gaps.id, EdgeType::Branches, now);
            (vec![root, lit, gaps], vec![e1, e2])
        }
        "study" => {
            let root = make_template_node(
                NodeType::Core,
                "Topic to Master",
                "State the physical or computational law, knowns/unknowns with units, and assumptions.\n\n```axiom-sim\n{\"title\":\"2nd-Order Transient Sensitivity\",\"domain\":\"controls\",\"preset\":\"second_order_step\",\"caption\":\"Vary ζ and ωn to link damping to %OS and settling time Ts.\"}\n```\n\nTip: Press Tab on any concept and run @feynman or @study to build intuition, worked checks, interactive sims, and flashcards.",
                0.0,
                0.0,
                now,
            );
            let breakdown = make_template_node(
                NodeType::Probe,
                "First-Principles Breakdown",
                "@feynman First principles & boundary limits: explain why the governing relation holds, variable units, and the exact regime where the approximation breaks down.",
                420.0,
                -110.0,
                now,
            );
            let recall = make_template_node(
                NodeType::Probe,
                "Active Recall Questions",
                "@study\n**Q:** Before substituting numbers into an engineering formula, what must you verify first? — **A:** Confirm the physical assumptions and boundary regime hold (e.g., steady state, linearity, laminar $Re < 2300$, consistent units).",
                420.0,
                120.0,
                now,
            );
            let e1 = make_template_edge(&root.id, &breakdown.id, EdgeType::Derives, now);
            let e2 = make_template_edge(&root.id, &recall.id, EdgeType::Derives, now);
            (vec![root, breakdown, recall], vec![e1, e2])
        }
        _ => return hydrate_or_seed_workspace(conn, path_str),
    };

    let focus_id = nodes.first().map(|n| n.id.clone());
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for node in &nodes {
        queries::insert_node_tx(&tx, node)?;
    }
    for edge in &edges {
        queries::insert_edge_tx(&tx, edge)?;
    }
    if let Some(ref fid) = focus_id {
        tx.execute(
            "INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('last_focus_id', ?1)",
            params![fid],
        )?;
    }
    tx.commit()?;

    let mut snap = hydrate_or_seed_workspace(conn, path_str)?;
    if snap.camera.last_focus_id.is_none() {
        snap.camera.last_focus_id = focus_id;
    }
    Ok(snap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn open_enables_wal_fk_fts5_and_seeds_starter_node() {
        let tmp = NamedTempFile::new().expect("create temp file");
        let mut conn = open_connection(tmp.path()).expect("open sqlite connection");

        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
            .expect("query journal_mode");
        assert_eq!(journal_mode.to_lowercase(), "wal");

        let fk_enabled: i64 = conn
            .query_row("PRAGMA foreign_keys;", [], |r| r.get(0))
            .expect("query foreign_keys");
        assert_eq!(fk_enabled, 1);

        let fts_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='nodes_fts'",
                [],
                |r| r.get(0),
            )
            .expect("query nodes_fts existence");
        assert_eq!(fts_exists, 1);

        let trigger_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='nodes_au'",
                [],
                |r| r.get(0),
            )
            .expect("query nodes_au trigger");
        assert!(trigger_sql.contains("UPDATE OF title, content, summary ON nodes"));

        let snap = hydrate_or_seed_workspace(&mut conn, &tmp.path().display().to_string())
            .expect("seed workspace");
        assert_eq!(snap.nodes.len(), 1);
        assert_eq!(snap.nodes[0].node_type, NodeType::Core);
        assert_eq!(snap.nodes[0].title, "System Architecture");
        assert_eq!(snap.camera.last_focus_id.as_deref(), Some(snap.nodes[0].id.as_str()));
        assert_eq!(snap.token_budget, 6000);
    }

    #[test]
    fn move_node_coordinates_does_not_fire_fts_update_trigger() {
        let tmp = NamedTempFile::new().expect("create temp file");
        let mut conn = open_connection(tmp.path()).expect("open sqlite connection");
        let snap = hydrate_or_seed_workspace(&mut conn, &tmp.path().display().to_string())
            .expect("seed workspace");
        let node_id = &snap.nodes[0].id;

        // Track FTS5 writes via a shadow test table or verify total_changes / trigger independence:
        // Replace nodes_fts_data inspection by checking rows/version before and after coordinate update.
        let before_data: Vec<Vec<u8>> = {
            let mut stmt = conn
                .prepare("SELECT block FROM nodes_fts_data ORDER BY id ASC")
                .expect("prepare fts data");
            stmt.query_map([], |r| r.get(0))
                .expect("query fts data")
                .map(|r| r.expect("fts block"))
                .collect()
        };

        conn.execute(
            "UPDATE nodes SET x = 144.0, y = -96.0 WHERE id = ?1",
            params![node_id],
        )
        .expect("update node position");

        let after_data: Vec<Vec<u8>> = {
            let mut stmt = conn
                .prepare("SELECT block FROM nodes_fts_data ORDER BY id ASC")
                .expect("prepare fts data");
            stmt.query_map([], |r| r.get(0))
                .expect("query fts data")
                .map(|r| r.expect("fts block"))
                .collect()
        };

        assert_eq!(before_data, after_data);
    }
}

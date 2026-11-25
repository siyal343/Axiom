use rusqlite::{params, Connection, OptionalExtension};

use crate::error::IpcError;
use crate::graph::models::{
    LensKind, ProvenanceInput, StaleInputChange, StaleNodeInfo, StaleReason,
};
use crate::graph::GraphEngine;

pub fn compute_stale_nodes(
    conn: &Connection,
    engine: &GraphEngine,
) -> Result<Vec<StaleNodeInfo>, IpcError> {
    let mut stmt = conn.prepare(
        "SELECT spawned_node_id, run_id, lens, model, input_hashes_json, created_at
         FROM ai_runs
         ORDER BY spawned_node_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;

    let mut stale = Vec::new();
    for row in rows {
        let (spawned_node_id, run_id, lens_str, model, input_hashes_json, created_at) = row?;
        if !engine.nodes.contains_key(&spawned_node_id) {
            continue;
        }
        let lens = LensKind::from_db_str(&lens_str)?;
        let inputs: Vec<ProvenanceInput> = serde_json::from_str(&input_hashes_json)?;
        let mut changed_inputs = Vec::new();
        for inp in inputs {
            match engine.nodes.get(&inp.node_id) {
                None => changed_inputs.push(StaleInputChange {
                    node_id: inp.node_id,
                    title: inp.title,
                    reason: StaleReason::Deleted,
                }),
                Some(current) if current.content_hash != inp.content_hash => {
                    changed_inputs.push(StaleInputChange {
                        node_id: inp.node_id,
                        title: current.title.clone(),
                        reason: StaleReason::Modified,
                    });
                }
                Some(_) => {}
            }
        }
        if !changed_inputs.is_empty() {
            stale.push(StaleNodeInfo {
                node_id: spawned_node_id,
                run_id,
                lens,
                model,
                created_at,
                changed_inputs,
            });
        }
    }

    Ok(stale)
}

pub fn acknowledge_stale_node(
    conn: &mut Connection,
    engine: &GraphEngine,
    node_id: &str,
) -> Result<(), IpcError> {
    let existing_json: Option<String> = conn
        .query_row(
            "SELECT input_hashes_json FROM ai_runs WHERE spawned_node_id = ?1",
            params![node_id],
            |row| row.get(0),
        )
        .optional()?;

    let Some(raw_json) = existing_json else {
        return Ok(());
    };

    let inputs: Vec<ProvenanceInput> = serde_json::from_str(&raw_json)?;
    let refreshed: Vec<ProvenanceInput> = inputs
        .into_iter()
        .filter(|inp| inp.node_id != node_id)
        .filter_map(|inp| {
            engine.nodes.get(&inp.node_id).map(|current| ProvenanceInput {
                node_id: current.id.clone(),
                title: current.title.clone(),
                content_hash: current.content_hash.clone(),
            })
        })
        .collect();

    let updated_json = serde_json::to_string(&refreshed)?;
    conn.execute(
        "UPDATE ai_runs SET input_hashes_json = ?1 WHERE spawned_node_id = ?2",
        params![updated_json, node_id],
    )?;
    Ok(())
}

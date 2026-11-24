use std::collections::{HashMap, HashSet, VecDeque};

use rstar::{RTree, RTreeObject, AABB};

use crate::error::IpcError;
use crate::graph::models::{EdgeType, NodeDto, NodePositionUpdate, NodeType};
use crate::graph::GraphEngine;

pub const DEFAULT_NODE_WIDTH: f64 = 320.0;
pub const DEFAULT_NODE_HEIGHT: f64 = 180.0;
pub const COLLAPSED_HEIGHT: f64 = 44.0;
pub const H_GAP: f64 = 100.0;
pub const V_GAP: f64 = 36.0;
pub const SIDE_GAP: f64 = 48.0;
pub const COLLISION_MARGIN: f64 = 20.0;

pub fn effective_height(node: &NodeDto) -> f64 {
    if node.layout.collapsed {
        COLLAPSED_HEIGHT
    } else {
        node.layout.height
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpatialBox {
    pub id: String,
    pub min: [f64; 2],
    pub max: [f64; 2],
}

impl SpatialBox {
    pub fn from_rect(id: impl Into<String>, x: f64, y: f64, width: f64, height: f64) -> Self {
        let half = COLLISION_MARGIN / 2.0;
        Self {
            id: id.into(),
            min: [x - half, y - half],
            max: [x + width + half, y + height + half],
        }
    }

    pub fn from_node(node: &NodeDto) -> Self {
        Self::from_rect(
            node.id.clone(),
            node.layout.x,
            node.layout.y,
            node.layout.width,
            effective_height(node),
        )
    }
}

impl RTreeObject for SpatialBox {
    type Envelope = AABB<[f64; 2]>;

    fn envelope(&self) -> Self::Envelope {
        AABB::from_corners(self.min, self.max)
    }
}

#[derive(Debug, Clone, Default)]
pub struct SpatialIndex {
    tree: RTree<SpatialBox>,
    boxes: HashMap<String, SpatialBox>,
}

impl SpatialIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_nodes(nodes: &[NodeDto]) -> Self {
        let mut boxes = HashMap::with_capacity(nodes.len());
        for node in nodes {
            boxes.insert(node.id.clone(), SpatialBox::from_node(node));
        }
        let items: Vec<SpatialBox> = boxes.values().cloned().collect();
        Self {
            tree: RTree::bulk_load(items),
            boxes,
        }
    }

    pub fn upsert(&mut self, node: &NodeDto) {
        self.upsert_rect(
            node.id.clone(),
            node.layout.x,
            node.layout.y,
            node.layout.width,
            effective_height(node),
        );
    }

    pub fn upsert_rect(
        &mut self,
        id: impl Into<String>,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) {
        let id_str = id.into();
        if let Some(old) = self.boxes.remove(&id_str) {
            self.tree.remove(&old);
        }
        let entry = SpatialBox::from_rect(id_str.clone(), x, y, width, height);
        self.tree.insert(entry.clone());
        self.boxes.insert(id_str, entry);
    }

    pub fn remove(&mut self, id: &str) {
        if let Some(old) = self.boxes.remove(id) {
            self.tree.remove(&old);
        }
    }

    pub fn intersects_rect(&self, x: f64, y: f64, width: f64, height: f64) -> bool {
        let half = COLLISION_MARGIN / 2.0;
        let query = AABB::from_corners(
            [x - half, y - half],
            [x + width + half, y + height + half],
        );
        self.tree.locate_in_envelope_intersecting(&query).next().is_some()
    }
}

fn nudge_clear_directional(
    index: &SpatialIndex,
    direction: i8, // -1 = up only, 1 = down only, 0 = alternating down-first
    start_x: f64,
    start_y: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let step = 40.0_f64;
    let mut cur_x = start_x;
    let cur_y = start_y;

    for _ in 0..100 {
        if !index.intersects_rect(cur_x, cur_y, width, height) {
            return (cur_x, cur_y);
        }
        for k in 1..=30 {
            if direction >= 0 {
                let down_y = cur_y + (k as f64) * step;
                if !index.intersects_rect(cur_x, down_y, width, height) {
                    return (cur_x, down_y);
                }
            }
            if direction <= 0 {
                let up_y = cur_y - (k as f64) * step;
                if !index.intersects_rect(cur_x, up_y, width, height) {
                    return (cur_x, up_y);
                }
            }
        }
        cur_x += width + H_GAP;
    }

    (cur_x, cur_y)
}

fn nudge_clear(
    index: &SpatialIndex,
    node_type: NodeType,
    start_x: f64,
    start_y: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let direction = match node_type {
        NodeType::Probe => -1,
        NodeType::Loophole | NodeType::Core | NodeType::Branch | NodeType::Synthesis => 0,
    };
    nudge_clear_directional(index, direction, start_x, start_y, width, height)
}

pub fn find_free_position(
    index: &SpatialIndex,
    anchors: &[&NodeDto],
    node_type: NodeType,
    width: f64,
    height: f64,
    batch_index: usize,
) -> (f64, f64) {
    let (px, py) = if anchors.is_empty() {
        (0.0, (batch_index as f64) * (height + V_GAP))
    } else {
        let primary = anchors[0];
        match node_type {
            NodeType::Synthesis if anchors.len() > 1 => {
                let max_right = anchors
                    .iter()
                    .map(|a| a.layout.x + a.layout.width)
                    .fold(f64::NEG_INFINITY, f64::max);
                let mean_y =
                    anchors.iter().map(|a| a.layout.y).sum::<f64>() / (anchors.len() as f64);
                (
                    max_right + H_GAP,
                    mean_y + (batch_index as f64) * (height + V_GAP),
                )
            }
            NodeType::Core | NodeType::Branch | NodeType::Synthesis => (
                primary.layout.x + primary.layout.width + H_GAP,
                primary.layout.y + (batch_index as f64) * (height + V_GAP),
            ),
            NodeType::Loophole => {
                let col = batch_index % 2;
                let row = batch_index / 2;
                (
                    primary.layout.x + (col as f64) * (DEFAULT_NODE_WIDTH + 24.0),
                    primary.layout.y
                        + effective_height(primary)
                        + SIDE_GAP
                        + (row as f64) * (DEFAULT_NODE_HEIGHT + V_GAP),
                )
            }
            NodeType::Probe => (
                primary.layout.x + (batch_index as f64) * (DEFAULT_NODE_WIDTH + 24.0),
                primary.layout.y - height - SIDE_GAP,
            ),
        }
    };

    nudge_clear(index, node_type, px, py, width, height)
}

struct SubtreeSpan {
    probe_band: f64,
    loophole_band: f64,
    own_span: f64,
    subtree_height: f64,
}

fn compute_loophole_offsets(engine: &GraphEngine, loophole_ids: &[String]) -> (f64, Vec<(f64, f64)>) {
    if loophole_ids.is_empty() {
        return (0.0, Vec::new());
    }
    let mut offsets = Vec::with_capacity(loophole_ids.len());
    let mut current_row_y = 0.0_f64;
    let mut idx = 0;

    while idx < loophole_ids.len() {
        let left_node = engine.nodes.get(&loophole_ids[idx]);
        let left_w = left_node.map_or(DEFAULT_NODE_WIDTH, |n| n.layout.width);
        let left_h = left_node.map_or(DEFAULT_NODE_HEIGHT, effective_height);
        offsets.push((0.0, current_row_y));

        let mut row_h = left_h;
        if idx + 1 < loophole_ids.len() {
            let right_node = engine.nodes.get(&loophole_ids[idx + 1]);
            let right_h = right_node.map_or(DEFAULT_NODE_HEIGHT, effective_height);
            offsets.push((left_w + 24.0, current_row_y));
            row_h = row_h.max(right_h);
        }

        current_row_y += row_h;
        if idx + 2 < loophole_ids.len() {
            current_row_y += V_GAP;
        }
        idx += 2;
    }

    (SIDE_GAP + current_row_y, offsets)
}

pub fn compute_tidy_subtree(
    engine: &GraphEngine,
    root_id: &str,
) -> Result<Vec<NodePositionUpdate>, IpcError> {
    let root = engine
        .nodes
        .get(root_id)
        .ok_or_else(|| IpcError::validation(format!("Root node {root_id} not found")))?;

    // Step 1: Collect spine tree via BFS from root_id (cycle-safe with visited set).
    let mut visited: HashSet<String> = HashSet::new();
    visited.insert(root_id.to_owned());

    let mut bfs_order: Vec<String> = Vec::new();
    let mut spine_children: HashMap<String, Vec<String>> = HashMap::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back(root_id.to_owned());

    while let Some(u_id) = queue.pop_front() {
        bfs_order.push(u_id.clone());
        let mut children: Vec<(&NodeDto, String)> = Vec::new();
        if let Some(out_edges) = engine.outgoing.get(&u_id) {
            for edge in out_edges {
                if !matches!(edge.edge_type, EdgeType::Derives | EdgeType::Branches) {
                    continue;
                }
                if let Some(target) = engine.nodes.get(&edge.target_id) {
                    if matches!(target.node_type, NodeType::Probe | NodeType::Loophole) {
                        continue;
                    }
                    if visited.insert(target.id.clone()) {
                        children.push((target, target.id.clone()));
                    }
                }
            }
        }
        children.sort_by(|(a, _), (b, _)| {
            a.layout
                .y
                .total_cmp(&b.layout.y)
                .then_with(|| a.layout.x.total_cmp(&b.layout.x))
                .then_with(|| a.id.cmp(&b.id))
        });
        let child_ids: Vec<String> = children.into_iter().map(|(_, id)| id).collect();
        for cid in &child_ids {
            queue.push_back(cid.clone());
        }
        spine_children.insert(u_id, child_ids);
    }

    // Collect directly attached Probe (above) and Loophole (below) satellites per spine node.
    let mut assigned_satellites: HashSet<String> = HashSet::new();
    let mut probes_of: HashMap<String, Vec<String>> = HashMap::new();
    let mut loopholes_of: HashMap<String, Vec<String>> = HashMap::new();

    for u_id in &bfs_order {
        let mut probes: Vec<&NodeDto> = Vec::new();
        if let Some(out_edges) = engine.outgoing.get(u_id) {
            for edge in out_edges {
                if edge.edge_type != EdgeType::Derives {
                    continue;
                }
                if let Some(target) = engine.nodes.get(&edge.target_id) {
                    if target.node_type == NodeType::Probe
                        && !visited.contains(&target.id)
                        && !assigned_satellites.contains(&target.id)
                    {
                        probes.push(target);
                    }
                }
            }
        }
        probes.sort_by(|a, b| {
            a.layout
                .x
                .total_cmp(&b.layout.x)
                .then_with(|| a.id.cmp(&b.id))
        });
        let probe_ids: Vec<String> = probes
            .into_iter()
            .filter(|n| assigned_satellites.insert(n.id.clone()))
            .map(|n| n.id.clone())
            .collect();
        probes_of.insert(u_id.clone(), probe_ids);

        let mut loopholes: Vec<&NodeDto> = Vec::new();
        if let Some(in_edges) = engine.incoming.get(u_id) {
            for edge in in_edges {
                if edge.edge_type != EdgeType::Challenges {
                    continue;
                }
                if let Some(src) = engine.nodes.get(&edge.source_id) {
                    if src.node_type == NodeType::Loophole
                        && !visited.contains(&src.id)
                        && !assigned_satellites.contains(&src.id)
                    {
                        loopholes.push(src);
                    }
                }
            }
        }
        loopholes.sort_by(|a, b| {
            a.layout
                .x
                .total_cmp(&b.layout.x)
                .then_with(|| a.id.cmp(&b.id))
        });
        let loophole_ids: Vec<String> = loopholes
            .into_iter()
            .filter(|n| assigned_satellites.insert(n.id.clone()))
            .map(|n| n.id.clone())
            .collect();
        loopholes_of.insert(u_id.clone(), loophole_ids);
    }

    // Step 2: Bottom-up pass to compute vertical spans.
    let mut spans: HashMap<String, SubtreeSpan> = HashMap::with_capacity(bfs_order.len());
    let mut loophole_layouts: HashMap<String, Vec<(f64, f64)>> = HashMap::new();

    for u_id in bfs_order.iter().rev() {
        let Some(u_node) = engine.nodes.get(u_id) else {
            continue;
        };
        let u_h = effective_height(u_node);
        let probe_band = probes_of
            .get(u_id)
            .filter(|ps| !ps.is_empty())
            .map_or(0.0, |ps| {
                let max_p_h = ps
                    .iter()
                    .filter_map(|pid| engine.nodes.get(pid))
                    .map(effective_height)
                    .fold(0.0_f64, f64::max);
                max_p_h + SIDE_GAP
            });

        let l_ids = loopholes_of.get(u_id).map(Vec::as_slice).unwrap_or(&[]);
        let (loophole_band, l_offsets) = compute_loophole_offsets(engine, l_ids);
        loophole_layouts.insert(u_id.clone(), l_offsets);

        let own_span = u_h + probe_band + loophole_band;
        let children = spine_children.get(u_id).map(Vec::as_slice).unwrap_or(&[]);
        let children_span = if children.is_empty() {
            0.0
        } else {
            let sum_h: f64 = children
                .iter()
                .filter_map(|cid| spans.get(cid))
                .map(|s| s.subtree_height)
                .sum();
            sum_h + ((children.len() - 1) as f64) * V_GAP
        };

        spans.insert(
            u_id.clone(),
            SubtreeSpan {
                probe_band,
                loophole_band,
                own_span,
                subtree_height: own_span.max(children_span),
            },
        );
    }

    // Step 3, 4 & 5: Top-down left-to-right placement with immediate scratch R-tree reservation.
    let mut moved_set: HashSet<&str> = HashSet::new();
    for id in &bfs_order {
        if id != root_id {
            moved_set.insert(id.as_str());
        }
    }
    for ps in probes_of.values() {
        for id in ps {
            moved_set.insert(id.as_str());
        }
    }
    for ls in loopholes_of.values() {
        for id in ls {
            moved_set.insert(id.as_str());
        }
    }

    let external_nodes: Vec<NodeDto> = engine
        .nodes
        .values()
        .filter(|n| !moved_set.contains(n.id.as_str()))
        .cloned()
        .collect();
    let mut scratch = SpatialIndex::from_nodes(&external_nodes);

    let mut final_positions: HashMap<String, (f64, f64)> = HashMap::new();
    final_positions.insert(root_id.to_owned(), (root.layout.x, root.layout.y));
    let mut updates = Vec::new();

    for u_id in &bfs_order {
        let Some(u_node) = engine.nodes.get(u_id) else {
            continue;
        };
        let Some(&(ux, uy)) = final_positions.get(u_id) else {
            continue;
        };
        let u_h = effective_height(u_node);

        // Finalize Probe satellites strictly above u
        if let Some(ps) = probes_of.get(u_id) {
            let mut px = ux;
            for pid in ps {
                if let Some(p_node) = engine.nodes.get(pid) {
                    let pw = p_node.layout.width;
                    let ph = effective_height(p_node);
                    let py = uy - ph - SIDE_GAP;
                    let (fx, fy) = if scratch.intersects_rect(px, py, pw, ph) {
                        nudge_clear_directional(&scratch, -1, px, py, pw, ph)
                    } else {
                        (px, py)
                    };
                    scratch.upsert_rect(pid.clone(), fx, fy, pw, ph);
                    final_positions.insert(pid.clone(), (fx, fy));
                    if (fx - p_node.layout.x).abs() > 1e-6 || (fy - p_node.layout.y).abs() > 1e-6 {
                        updates.push(NodePositionUpdate {
                            id: pid.clone(),
                            x: fx,
                            y: fy,
                        });
                    }
                    px = fx + pw + 24.0;
                }
            }
        }

        // Finalize Loophole satellites strictly below u
        if let (Some(ls), Some(offsets)) = (loopholes_of.get(u_id), loophole_layouts.get(u_id)) {
            let base_y = uy + u_h + SIDE_GAP;
            for (lid, &(dx, dy)) in ls.iter().zip(offsets.iter()) {
                if let Some(l_node) = engine.nodes.get(lid) {
                    let lw = l_node.layout.width;
                    let lh = effective_height(l_node);
                    let px = ux + dx;
                    let py = base_y + dy;
                    let (fx, fy) = if scratch.intersects_rect(px, py, lw, lh) {
                        nudge_clear_directional(&scratch, 1, px, py, lw, lh)
                    } else {
                        (px, py)
                    };
                    scratch.upsert_rect(lid.clone(), fx, fy, lw, lh);
                    final_positions.insert(lid.clone(), (fx, fy));
                    if (fx - l_node.layout.x).abs() > 1e-6 || (fy - l_node.layout.y).abs() > 1e-6 {
                        updates.push(NodePositionUpdate {
                            id: lid.clone(),
                            x: fx,
                            y: fy,
                        });
                    }
                }
            }
        }

        // Propose and finalize spine children relative to u's finalized (ux, uy)
        let children = spine_children.get(u_id).map(Vec::as_slice).unwrap_or(&[]);
        if children.is_empty() {
            continue;
        }
        let total_children_h: f64 = children
            .iter()
            .filter_map(|cid| spans.get(cid))
            .map(|s| s.subtree_height)
            .sum::<f64>()
            + ((children.len() - 1) as f64) * V_GAP;

        let child_x = ux + u_node.layout.width + H_GAP;
        let parent_mid_y = uy + u_h / 2.0;
        let mut cursor_y = parent_mid_y - total_children_h / 2.0;

        for cid in children {
            if let (Some(c_span), Some(c_node)) = (spans.get(cid), engine.nodes.get(cid)) {
                let block_top = cursor_y + (c_span.subtree_height - c_span.own_span) / 2.0;
                let c_y = block_top + c_span.probe_band;
                let cw = c_node.layout.width;
                let ch = effective_height(c_node);
                let (fx, fy) = if scratch.intersects_rect(child_x, c_y, cw, ch) {
                    nudge_clear_directional(&scratch, 0, child_x, c_y, cw, ch)
                } else {
                    (child_x, c_y)
                };
                scratch.upsert_rect(cid.clone(), fx, fy, cw, ch);
                final_positions.insert(cid.clone(), (fx, fy));
                if (fx - c_node.layout.x).abs() > 1e-6 || (fy - c_node.layout.y).abs() > 1e-6 {
                    updates.push(NodePositionUpdate {
                        id: cid.clone(),
                        x: fx,
                        y: fy,
                    });
                }
                cursor_y += c_span.subtree_height + V_GAP;
            }
        }
    }

    Ok(updates)
}

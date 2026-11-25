pub mod compiler;
pub mod exporter;
pub mod models;
pub mod spatial;

use std::collections::HashMap;

use models::{EdgeDto, EdgeWeight, NodeDto};
use spatial::SpatialIndex;

#[derive(Debug, Default)]
pub struct GraphEngine {
    pub nodes: HashMap<String, NodeDto>,
    pub incoming: HashMap<String, Vec<EdgeDto>>,
    pub outgoing: HashMap<String, Vec<EdgeDto>>,
    pub spatial: SpatialIndex,
}

impl GraphEngine {
    pub fn from_snapshot(nodes: &[NodeDto], edges: &[EdgeDto]) -> Self {
        let mut engine = Self {
            nodes: HashMap::with_capacity(nodes.len()),
            incoming: HashMap::new(),
            outgoing: HashMap::new(),
            spatial: SpatialIndex::from_nodes(nodes),
        };
        for node in nodes {
            engine.nodes.insert(node.id.clone(), node.clone());
        }
        for edge in edges {
            engine.add_edge(edge.clone());
        }
        engine
    }

    pub fn upsert_node(&mut self, node: NodeDto) {
        self.spatial.upsert(&node);
        self.nodes.insert(node.id.clone(), node);
    }

    pub fn remove_node(&mut self, id: &str) -> Option<NodeDto> {
        self.spatial.remove(id);
        let removed = self.nodes.remove(id);

        if let Some(out_edges) = self.outgoing.remove(id) {
            for edge in out_edges {
                if let Some(target_in) = self.incoming.get_mut(&edge.target_id) {
                    target_in.retain(|e| e.id != edge.id);
                }
            }
        }
        if let Some(in_edges) = self.incoming.remove(id) {
            for edge in in_edges {
                if let Some(src_out) = self.outgoing.get_mut(&edge.source_id) {
                    src_out.retain(|e| e.id != edge.id);
                }
            }
        }

        removed
    }

    pub fn add_edge(&mut self, edge: EdgeDto) {
        let out_list = self.outgoing.entry(edge.source_id.clone()).or_default();
        if !out_list.iter().any(|e| e.id == edge.id) {
            out_list.push(edge.clone());
        }
        let in_list = self.incoming.entry(edge.target_id.clone()).or_default();
        if !in_list.iter().any(|e| e.id == edge.id) {
            in_list.push(edge);
        }
    }

    pub fn remove_edge(&mut self, id: &str) -> Option<EdgeDto> {
        let edge = self.get_edge(id)?.clone();
        if let Some(out_list) = self.outgoing.get_mut(&edge.source_id) {
            out_list.retain(|e| e.id != id);
        }
        if let Some(in_list) = self.incoming.get_mut(&edge.target_id) {
            in_list.retain(|e| e.id != id);
        }
        Some(edge)
    }

    pub fn update_edge_weight(&mut self, id: &str, weight: EdgeWeight) -> bool {
        let mut updated = false;
        if let Some(edge) = self.get_edge(id).cloned() {
            if let Some(out_list) = self.outgoing.get_mut(&edge.source_id) {
                for e in out_list {
                    if e.id == id {
                        e.weight = weight;
                        updated = true;
                    }
                }
            }
            if let Some(in_list) = self.incoming.get_mut(&edge.target_id) {
                for e in in_list {
                    if e.id == id {
                        e.weight = weight;
                        updated = true;
                    }
                }
            }
        }
        updated
    }

    pub fn get_edge(&self, id: &str) -> Option<&EdgeDto> {
        self.outgoing.values().flatten().find(|e| e.id == id)
    }

    pub fn all_nodes_sorted(&self) -> Vec<NodeDto> {
        let mut out: Vec<NodeDto> = self.nodes.values().cloned().collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn all_edges_sorted(&self) -> Vec<EdgeDto> {
        let mut out: Vec<EdgeDto> = self.outgoing.values().flatten().cloned().collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }
}

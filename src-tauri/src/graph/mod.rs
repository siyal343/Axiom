pub mod models;

use std::collections::HashMap;

use models::{EdgeDto, NodeDto};

#[derive(Debug, Default)]
#[allow(dead_code)]
pub struct GraphEngine {
    pub nodes: HashMap<String, NodeDto>,
    pub incoming: HashMap<String, Vec<EdgeDto>>,
    pub outgoing: HashMap<String, Vec<EdgeDto>>,
}

impl GraphEngine {
    pub fn from_snapshot(nodes: &[NodeDto], edges: &[EdgeDto]) -> Self {
        let mut engine = Self::default();
        for node in nodes {
            engine.nodes.insert(node.id.clone(), node.clone());
        }
        for edge in edges {
            engine
                .outgoing
                .entry(edge.source_id.clone())
                .or_default()
                .push(edge.clone());
            engine
                .incoming
                .entry(edge.target_id.clone())
                .or_default()
                .push(edge.clone());
        }
        engine
    }
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::IpcError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    Core,
    Branch,
    Loophole,
    Probe,
    Synthesis,
}

impl NodeType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Branch => "branch",
            Self::Loophole => "loophole",
            Self::Probe => "probe",
            Self::Synthesis => "synthesis",
        }
    }

    pub fn from_db_str(s: &str) -> Result<Self, IpcError> {
        match s {
            "core" => Ok(Self::Core),
            "branch" => Ok(Self::Branch),
            "loophole" => Ok(Self::Loophole),
            "probe" => Ok(Self::Probe),
            "synthesis" => Ok(Self::Synthesis),
            other => Err(IpcError::db(format!("Invalid node type: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Draft,
    Active,
    Resolved,
    Dismissed,
    Locked,
}

impl NodeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Active => "active",
            Self::Resolved => "resolved",
            Self::Dismissed => "dismissed",
            Self::Locked => "locked",
        }
    }

    pub fn from_db_str(s: &str) -> Result<Self, IpcError> {
        match s {
            "draft" => Ok(Self::Draft),
            "active" => Ok(Self::Active),
            "resolved" => Ok(Self::Resolved),
            "dismissed" => Ok(Self::Dismissed),
            "locked" => Ok(Self::Locked),
            other => Err(IpcError::db(format!("Invalid node status: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

impl Severity {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }

    pub fn from_db_str(s: &str) -> Result<Self, IpcError> {
        match s {
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "critical" => Ok(Self::Critical),
            other => Err(IpcError::db(format!("Invalid severity: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeLensOrigin {
    Manual,
    RedTeam,
    EdgeCase,
    Diverge,
    Feynman,
    Synthesize,
    Custom,
}

impl NodeLensOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::RedTeam => "red_team",
            Self::EdgeCase => "edge_case",
            Self::Diverge => "diverge",
            Self::Feynman => "feynman",
            Self::Synthesize => "synthesize",
            Self::Custom => "custom",
        }
    }

    pub fn from_db_str(s: &str) -> Result<Self, IpcError> {
        match s {
            "manual" => Ok(Self::Manual),
            "red_team" => Ok(Self::RedTeam),
            "edge_case" => Ok(Self::EdgeCase),
            "diverge" => Ok(Self::Diverge),
            "feynman" => Ok(Self::Feynman),
            "synthesize" => Ok(Self::Synthesize),
            "custom" => Ok(Self::Custom),
            other => Err(IpcError::db(format!("Invalid node lens origin: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum LensKind {
    RedTeam,
    EdgeCase,
    Diverge,
    Feynman,
    Synthesize,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreatedBy {
    User,
    Ai,
}

impl CreatedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Ai => "ai",
        }
    }

    pub fn from_db_str(s: &str) -> Result<Self, IpcError> {
        match s {
            "user" => Ok(Self::User),
            "ai" => Ok(Self::Ai),
            other => Err(IpcError::db(format!("Invalid created_by: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeType {
    Derives,
    Branches,
    Challenges,
    Resolves,
    Synthesizes,
    References,
}

impl EdgeType {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Derives => "derives",
            Self::Branches => "branches",
            Self::Challenges => "challenges",
            Self::Resolves => "resolves",
            Self::Synthesizes => "synthesizes",
            Self::References => "references",
        }
    }

    pub fn from_db_str(s: &str) -> Result<Self, IpcError> {
        match s {
            "derives" => Ok(Self::Derives),
            "branches" => Ok(Self::Branches),
            "challenges" => Ok(Self::Challenges),
            "resolves" => Ok(Self::Resolves),
            "synthesizes" => Ok(Self::Synthesizes),
            "references" => Ok(Self::References),
            other => Err(IpcError::db(format!("Invalid edge type: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeWeight {
    Full,
    Summary,
}

impl EdgeWeight {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Summary => "summary",
        }
    }

    pub fn from_db_str(s: &str) -> Result<Self, IpcError> {
        match s {
            "full" => Ok(Self::Full),
            "summary" => Ok(Self::Summary),
            other => Err(IpcError::db(format!("Invalid edge weight: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum InclusionMode {
    Pin,
    Focus,
    Full,
    Summary,
    Loophole,
    Reference,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMetadata {
    pub severity: Option<Severity>,
    pub lens: NodeLensOrigin,
    pub created_by: CreatedBy,
    pub model: Option<String>,
    pub token_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextControls {
    pub pin_global: bool,
    pub exclude_from_ai: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeLayout {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeDto {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub status: NodeStatus,
    pub title: String,
    pub content: String,
    pub summary: String,
    pub content_hash: String,
    pub summary_hash: String,
    pub metadata: NodeMetadata,
    pub context_controls: ContextControls,
    pub layout: NodeLayout,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeDto {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    #[serde(rename = "type")]
    pub edge_type: EdgeType,
    pub weight: EdgeWeight,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraState {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
    pub last_focus_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    pub path: String,
    pub nodes: Vec<NodeDto>,
    pub edges: Vec<EdgeDto>,
    pub camera: CameraState,
    pub token_budget: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct NodePositionUpdate {
    pub id: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct NodeSizeUpdate {
    pub id: String,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
#[allow(dead_code)]
pub enum GraphOp {
    CreateNode {
        node: NodeDto,
    },
    UpdateNodeText {
        id: String,
        title: String,
        content: String,
    },
    UpdateNodeMeta {
        id: String,
        node_type: Option<NodeType>,
        status: Option<NodeStatus>,
        severity: Option<Option<Severity>>,
        pin_global: Option<bool>,
        exclude_from_ai: Option<bool>,
        collapsed: Option<bool>,
    },
    MoveNodes {
        moves: Vec<NodePositionUpdate>,
    },
    ResizeNodes {
        sizes: Vec<NodeSizeUpdate>,
    },
    DeleteNodes {
        ids: Vec<String>,
    },
    CreateEdge {
        edge: EdgeDto,
    },
    UpdateEdgeWeight {
        id: String,
        weight: EdgeWeight,
    },
    DeleteEdge {
        id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ApplyResult {
    pub updated_nodes: Vec<NodeDto>,
    pub deleted_node_ids: Vec<String>,
    pub deleted_edge_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct CompiledXray {
    pub total_tokens: u32,
    pub budget_tokens: u32,
    pub node_modes: HashMap<String, InclusionMode>,
    pub active_edges: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub status: NodeStatus,
    pub severity: Option<Severity>,
    pub snippet: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[allow(dead_code)]
pub enum LensStreamEvent {
    SkeletonSpawned {
        node: NodeDto,
        edges: Vec<EdgeDto>,
    },
    TokenDelta {
        node_id: String,
        chunk: String,
    },
    NodeFinalized {
        node: NodeDto,
    },
    RunCompleted {
        run_id: String,
        spawned_ids: Vec<String>,
        cancelled: bool,
    },
    RunError {
        run_id: String,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ProviderKind {
    OpenaiCompat,
    Anthropic,
    Ollama,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ModelTierConfig {
    pub provider: ProviderKind,
    pub base_url: String,
    pub model: String,
    pub has_api_key: bool,
    pub temperature: f32,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct AppSettingsDto {
    pub reasoning: ModelTierConfig,
    pub utility: ModelTierConfig,
    pub default_token_budget: u32,
    pub auto_summarize: bool,
    pub theme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct SaveSettingsInput {
    pub reasoning: ModelTierConfig,
    pub reasoning_api_key: Option<String>,
    pub utility: ModelTierConfig,
    pub utility_api_key: Option<String>,
    pub default_token_budget: u32,
    pub auto_summarize: bool,
    pub theme: String,
}

pub fn estimate_tokens(text: &str) -> u32 {
    if text.is_empty() {
        0
    } else {
        u32::try_from(text.len().div_ceil(4)).unwrap_or(u32::MAX)
    }
}

pub fn compute_content_hash(title: &str, content: &str) -> String {
    let input = format!("{title}\n{content}");
    blake3::hash(input.as_bytes()).to_hex().to_string()
}

pub fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

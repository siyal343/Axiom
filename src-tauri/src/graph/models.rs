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
    Research,
    Study,
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
            Self::Research => "research",
            Self::Study => "study",
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
            "research" => Ok(Self::Research),
            "study" => Ok(Self::Study),
            "custom" => Ok(Self::Custom),
            other => Err(IpcError::db(format!("Invalid node lens origin: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LensKind {
    RedTeam,
    EdgeCase,
    Diverge,
    Feynman,
    Synthesize,
    Research,
    Study,
    Custom,
}

impl LensKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RedTeam => "red_team",
            Self::EdgeCase => "edge_case",
            Self::Diverge => "diverge",
            Self::Feynman => "feynman",
            Self::Synthesize => "synthesize",
            Self::Research => "research",
            Self::Study => "study",
            Self::Custom => "custom",
        }
    }

    pub fn from_db_str(s: &str) -> Result<Self, IpcError> {
        match s {
            "red_team" => Ok(Self::RedTeam),
            "edge_case" => Ok(Self::EdgeCase),
            "diverge" => Ok(Self::Diverge),
            "feynman" => Ok(Self::Feynman),
            "synthesize" => Ok(Self::Synthesize),
            "research" => Ok(Self::Research),
            "study" => Ok(Self::Study),
            "custom" => Ok(Self::Custom),
            other => Err(IpcError::db(format!("Invalid lens kind: {other}"))),
        }
    }
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
pub enum SpawnDirection {
    Right,
    Left,
    Top,
    Bottom,
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
    #[serde(default)]
    pub system_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodePositionUpdate {
    pub id: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeSizeUpdate {
    pub id: String,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
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
pub struct ApplyResult {
    pub updated_nodes: Vec<NodeDto>,
    pub deleted_node_ids: Vec<String>,
    pub deleted_edge_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnConnectedResult {
    pub node: NodeDto,
    pub edge: EdgeDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledXray {
    pub total_tokens: u32,
    pub budget_tokens: u32,
    pub overflow: bool,
    pub node_modes: HashMap<String, InclusionMode>,
    pub mode_tokens: HashMap<InclusionMode, u32>,
    pub active_edges: Vec<String>,
    pub prompt_preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactScope {
    Subgraph,
    Workspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactFormat {
    Adr,
    Brief,
    Mermaid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledArtifact {
    pub format: ArtifactFormat,
    pub scope: ArtifactScope,
    pub title: String,
    pub markdown: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub unresolved_loophole_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct WorkspaceSearchHit {
    pub workspace_id: String,
    pub flow_id: String,
    pub flow_name: String,
    pub hit: SearchHit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelatedNodeHit {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub status: NodeStatus,
    pub snippet: String,
    pub score: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvenanceInput {
    pub node_id: String,
    pub title: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StaleReason {
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StaleInputChange {
    pub node_id: String,
    pub title: String,
    pub reason: StaleReason,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaleNodeInfo {
    pub node_id: String,
    pub run_id: String,
    pub lens: LensKind,
    pub model: Option<String>,
    pub created_at: i64,
    pub changed_inputs: Vec<StaleInputChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
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
pub enum ProviderKind {
    OpenaiCompat,
    Anthropic,
    Ollama,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelTierConfig {
    pub provider: ProviderKind,
    pub base_url: String,
    pub model: String,
    pub has_api_key: bool,
    pub temperature: f32,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomLensDef {
    pub id: String,
    pub name: String,
    pub tag: String,
    pub description: String,
    pub prompt_template: String,
    pub default_node_type: NodeType,
    pub default_edge_type: EdgeType,
    pub default_severity: Option<Severity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettingsDto {
    pub reasoning: ModelTierConfig,
    pub utility: ModelTierConfig,
    pub default_token_budget: u32,
    pub auto_summarize: bool,
    pub theme: String,
    #[serde(default)]
    pub custom_lenses: Vec<CustomLensDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveSettingsInput {
    pub reasoning: ModelTierConfig,
    pub reasoning_api_key: Option<String>,
    pub utility: ModelTierConfig,
    pub utility_api_key: Option<String>,
    pub default_token_budget: u32,
    pub auto_summarize: bool,
    pub theme: String,
    #[serde(default)]
    pub custom_lenses: Vec<CustomLensDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticItem {
    pub node_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub severity: Option<Severity>,
    pub detail: String,
    pub token_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CycleDiagnostic {
    pub node_ids: Vec<String>,
    pub titles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphDiagnostics {
    pub health_score: u8,
    pub node_count: usize,
    pub edge_count: usize,
    pub total_tokens: u32,
    pub pin_count: usize,
    pub excluded_count: usize,
    pub unresolved_loopholes: Vec<DiagnosticItem>,
    pub stale_ai_nodes: Vec<DiagnosticItem>,
    pub cycles: Vec<CycleDiagnostic>,
    pub orphan_nodes: Vec<DiagnosticItem>,
    pub unsummarized_heavy_nodes: Vec<DiagnosticItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportOutlineResult {
    pub root_id: String,
    pub created_nodes: Vec<NodeDto>,
    pub created_edges: Vec<EdgeDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryUpdatedEvent {
    pub node_id: String,
    pub summary: String,
    pub summary_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestConnectionResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowEntryDto {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub template: String,
    pub db_path: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceEntryDto {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub flows: Vec<FlowEntryDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceCatalogDto {
    pub workspaces: Vec<WorkspaceEntryDto>,
    pub active_workspace_id: String,
    pub active_flow_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenFlowResult {
    pub catalog: WorkspaceCatalogDto,
    pub snapshot: WorkspaceSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalRefStatusKind {
    Synced,
    OutOfSync,
    SourceMissing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalRefInfo {
    pub local_node_id: String,
    pub source_workspace_id: String,
    pub source_flow_id: String,
    pub source_flow_name: String,
    pub source_node_id: String,
    pub synced_hash: String,
    pub synced_at: i64,
    pub status: ExternalRefStatusKind,
    pub source_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullExternalRefResult {
    pub node: NodeDto,
    pub edge: Option<EdgeDto>,
    pub external_ref: ExternalRefInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointSummary {
    pub id: String,
    pub name: String,
    pub note: String,
    pub node_count: usize,
    pub edge_count: usize,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointNodeChange {
    pub node_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointDiff {
    pub checkpoint_id: String,
    pub checkpoint_name: String,
    pub added_nodes: Vec<CheckpointNodeChange>,
    pub removed_nodes: Vec<CheckpointNodeChange>,
    pub modified_nodes: Vec<CheckpointNodeChange>,
    pub added_edges_count: usize,
    pub removed_edges_count: usize,
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

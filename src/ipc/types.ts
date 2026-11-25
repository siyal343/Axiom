export type NodeType = "core" | "branch" | "loophole" | "probe" | "synthesis";
export type NodeStatus = "draft" | "active" | "resolved" | "dismissed" | "locked";
export type Severity = "low" | "medium" | "high" | "critical";
export type NodeLensOrigin =
  | "manual"
  | "red_team"
  | "edge_case"
  | "diverge"
  | "feynman"
  | "synthesize"
  | "research"
  | "study"
  | "custom";
export type LensKind =
  | "red_team"
  | "edge_case"
  | "diverge"
  | "feynman"
  | "synthesize"
  | "custom"
  | "research"
  | "study";
export type CreatedBy = "user" | "ai";
export type EdgeType =
  | "derives"
  | "branches"
  | "challenges"
  | "resolves"
  | "synthesizes"
  | "references";
export type EdgeWeight = "full" | "summary";
export type SpawnDirection = "right" | "left" | "top" | "bottom";
export type InclusionMode = "pin" | "focus" | "full" | "summary" | "loophole" | "reference";
export type ProviderKind = "openai_compat" | "anthropic" | "ollama";

export interface NodeMetadata {
  severity: Severity | null;
  lens: NodeLensOrigin;
  created_by: CreatedBy;
  model: string | null;
  token_count: number;
}

export interface ContextControls {
  pin_global: boolean;
  exclude_from_ai: boolean;
}

export interface NodeLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed: boolean;
}

export interface NodeDto {
  id: string;
  type: NodeType;
  status: NodeStatus;
  title: string;
  content: string;
  summary: string;
  content_hash: string;
  summary_hash: string;
  metadata: NodeMetadata;
  context_controls: ContextControls;
  layout: NodeLayout;
  created_at: number;
  updated_at: number;
}

export interface EdgeDto {
  id: string;
  source_id: string;
  target_id: string;
  type: EdgeType;
  weight: EdgeWeight;
  created_at: number;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  last_focus_id: string | null;
}

export interface WorkspaceSnapshot {
  path: string;
  nodes: NodeDto[];
  edges: EdgeDto[];
  camera: CameraState;
  token_budget: number;
  system_prompt?: string;
}

export interface NodePositionUpdate {
  id: string;
  x: number;
  y: number;
}

export interface NodeSizeUpdate {
  id: string;
  width: number;
  height: number;
}

export type GraphOp =
  | { op: "create_node"; node: NodeDto }
  | { op: "update_node_text"; id: string; title: string; content: string }
  | {
      op: "update_node_meta";
      id: string;
      node_type?: NodeType;
      status?: NodeStatus;
      severity?: Severity | null;
      pin_global?: boolean;
      exclude_from_ai?: boolean;
      collapsed?: boolean;
    }
  | { op: "move_nodes"; moves: NodePositionUpdate[] }
  | { op: "resize_nodes"; sizes: NodeSizeUpdate[] }
  | { op: "delete_nodes"; ids: string[] }
  | { op: "create_edge"; edge: EdgeDto }
  | { op: "update_edge_weight"; id: string; weight: EdgeWeight }
  | { op: "delete_edge"; id: string };

export interface ApplyResult {
  updated_nodes: NodeDto[];
  deleted_node_ids: string[];
  deleted_edge_ids: string[];
}

export interface CompiledXray {
  total_tokens: number;
  budget_tokens: number;
  node_modes: Record<string, InclusionMode>;
  active_edges: string[];
  overflow?: boolean;
  mode_tokens?: Partial<Record<InclusionMode, number>>;
  prompt_preview?: string;
}

export type ArtifactScope = "subgraph" | "workspace";
export type ArtifactFormat = "adr" | "brief" | "mermaid";

export interface CompiledArtifact {
  format: ArtifactFormat;
  scope: ArtifactScope;
  title: string;
  markdown: string;
  node_count: number;
  edge_count: number;
  unresolved_loophole_count: number;
}

export interface SearchHit {
  id: string;
  title: string;
  type: NodeType;
  status: NodeStatus;
  severity: Severity | null;
  snippet: string;
  x: number;
  y: number;
}

export type LensStreamEvent =
  | { kind: "skeleton_spawned"; node: NodeDto; edges: EdgeDto[] }
  | { kind: "token_delta"; node_id: string; chunk: string }
  | { kind: "node_finalized"; node: NodeDto }
  | { kind: "run_completed"; run_id: string; spawned_ids: string[]; cancelled: boolean }
  | { kind: "run_error"; run_id: string; code: string; message: string };

export interface ModelTierConfig {
  provider: ProviderKind;
  base_url: string;
  model: string;
  has_api_key: boolean;
  temperature: number;
  max_tokens: number;
}

export interface CustomLensDef {
  id: string;
  name: string;
  tag: string;
  description: string;
  prompt_template: string;
  default_node_type: NodeType;
  default_edge_type: EdgeType;
  default_severity: Severity | null;
}

export interface AppSettingsDto {
  reasoning: ModelTierConfig;
  utility: ModelTierConfig;
  default_token_budget: number;
  auto_summarize: boolean;
  theme: "dark" | "light";
  custom_lenses?: CustomLensDef[];
}

export interface SaveSettingsInput {
  reasoning: ModelTierConfig;
  reasoning_api_key?: string | null;
  utility: ModelTierConfig;
  utility_api_key?: string | null;
  default_token_budget: number;
  auto_summarize: boolean;
  theme: "dark" | "light";
  custom_lenses?: CustomLensDef[];
}

export interface SummaryUpdatedEvent {
  node_id: string;
  summary: string;
  summary_hash: string;
}

export interface TestConnectionResult {
  ok: boolean;
  latency_ms: number;
  message: string;
}

export interface IpcError {
  code:
    | "WORKSPACE_NOT_OPEN"
    | "DB_ERROR"
    | "VALIDATION_ERROR"
    | "NODE_LOCKED"
    | "DUPLICATE_EDGE"
    | "PROVIDER_AUTH"
    | "PROVIDER_NETWORK"
    | "RUN_NOT_FOUND";
  message: string;
}

export type FlowTemplate = "blank" | "research" | "study" | "engineering";

export interface FlowEntryDto {
  id: string;
  workspace_id: string;
  name: string;
  template: FlowTemplate;
  db_path: string;
  updated_at: number;
}

export interface WorkspaceEntryDto {
  id: string;
  name: string;
  created_at: number;
  flows: FlowEntryDto[];
}

export interface WorkspaceCatalogDto {
  workspaces: WorkspaceEntryDto[];
  active_workspace_id: string;
  active_flow_id: string;
}

export interface OpenFlowResult {
  catalog: WorkspaceCatalogDto;
  snapshot: WorkspaceSnapshot;
}

export type StaleReason = "modified" | "deleted";

export interface StaleInputChange {
  node_id: string;
  title: string;
  reason: StaleReason;
}

export interface StaleNodeInfo {
  node_id: string;
  run_id: string;
  lens: LensKind;
  model: string | null;
  created_at: number;
  changed_inputs: StaleInputChange[];
}

export interface WorkspaceSearchHit {
  workspace_id: string;
  flow_id: string;
  flow_name: string;
  hit: SearchHit;
}

export interface RelatedNodeHit {
  id: string;
  title: string;
  type: NodeType;
  status: NodeStatus;
  snippet: string;
  score: number;
  x: number;
  y: number;
}

export interface DiagnosticItem {
  node_id: string;
  title: string;
  type: NodeType;
  severity: Severity | null;
  detail: string;
  token_count: number;
}

export interface CycleDiagnostic {
  node_ids: string[];
  titles: string[];
}

export interface GraphDiagnostics {
  health_score: number;
  node_count: number;
  edge_count: number;
  total_tokens: number;
  pin_count: number;
  excluded_count: number;
  unresolved_loopholes: DiagnosticItem[];
  stale_ai_nodes: DiagnosticItem[];
  cycles: CycleDiagnostic[];
  orphan_nodes: DiagnosticItem[];
  unsummarized_heavy_nodes: DiagnosticItem[];
}

export interface ImportOutlineResult {
  root_id: string;
  created_nodes: NodeDto[];
  created_edges: EdgeDto[];
}

export type ExternalRefStatusKind = "synced" | "out_of_sync" | "source_missing";

export interface ExternalRefInfo {
  local_node_id: string;
  source_workspace_id: string;
  source_flow_id: string;
  source_flow_name: string;
  source_node_id: string;
  synced_hash: string;
  synced_at: number;
  status: ExternalRefStatusKind;
  source_title: string | null;
}

export interface PullExternalRefResult {
  node: NodeDto;
  edge: EdgeDto | null;
  external_ref: ExternalRefInfo;
}

export interface CheckpointSummary {
  id: string;
  name: string;
  note: string;
  node_count: number;
  edge_count: number;
  created_at: number;
}

export interface CheckpointNodeChange {
  node_id: string;
  title: string;
  type: NodeType;
  changes: string[];
}

export interface CheckpointDiff {
  checkpoint_id: string;
  checkpoint_name: string;
  added_nodes: CheckpointNodeChange[];
  removed_nodes: CheckpointNodeChange[];
  modified_nodes: CheckpointNodeChange[];
  added_edges_count: number;
  removed_edges_count: number;
}

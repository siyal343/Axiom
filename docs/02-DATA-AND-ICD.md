# Part 2: Data Architecture, Typed IPC Contract & Repository Blueprint

## File: `docs/02-DATA-AND-ICD.md`

```markdown
# Data Architecture & Interface Control Document (ICD)
**Project:** Axiom — Infinite Canvas AI Companion
**Version:** 1.0 (MVP Baseline)
**Scope:** SQLite WAL/FTS5 Persistence, Canonical Rust/TS DTOs, Tauri v2 IPC Contract, JSON Export Format, Repository Layout

---

## 1. SQLite Database Specification

Each workspace is a single `.sqlite` file stored locally. Opening a workspace MUST execute the connection pragmas immediately before any migration or query.

### 1.1 Connection Pragmas & Migration DDL (`src-tauri/src/db/migrations.rs`)

```sql
-- Execute on EVERY connection open before queries
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;

-- Schema version tracking and workspace viewport persistence
CREATE TABLE IF NOT EXISTS workspace_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO workspace_meta (key, value) VALUES
    ('schema_version', '1'),
    ('camera_x', '0.0'),
    ('camera_y', '0.0'),
    ('camera_zoom', '1.0'),
    ('last_focus_id', ''),
    ('token_budget', '6000');

-- Core graph nodes
-- Note: Implicit INTEGER rowid is required by external-content FTS5. Do NOT add WITHOUT ROWID.
CREATE TABLE IF NOT EXISTS nodes (
    id              TEXT PRIMARY KEY,                  -- ULID prefixed: "node_01J..."
    type            TEXT NOT NULL
                         CHECK (type IN ('core', 'branch', 'loophole', 'probe', 'synthesis')),
    status          TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('draft', 'active', 'resolved', 'dismissed', 'locked')),
    title           TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL DEFAULT '',
    summary         TEXT NOT NULL DEFAULT '',
    content_hash    TEXT NOT NULL DEFAULT '',          -- BLAKE3 hex of "{title}\n{content}"
    summary_hash    TEXT NOT NULL DEFAULT '',          -- Matches content_hash when summary is fresh

    -- Metadata
    severity        TEXT CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
    lens            TEXT NOT NULL DEFAULT 'manual'
                         CHECK (lens IN ('manual', 'red_team', 'edge_case', 'diverge', 'feynman', 'synthesize', 'custom')),
    created_by      TEXT NOT NULL DEFAULT 'user'
                         CHECK (created_by IN ('user', 'ai')),
    model           TEXT,
    token_count     INTEGER NOT NULL DEFAULT 0,

    -- Context controls (SQLite boolean 0/1)
    pin_global      INTEGER NOT NULL DEFAULT 0 CHECK (pin_global IN (0, 1)),
    exclude_from_ai INTEGER NOT NULL DEFAULT 0 CHECK (exclude_from_ai IN (0, 1)),

    -- Spatial layout (world coordinates)
    x               REAL NOT NULL DEFAULT 0.0,
    y               REAL NOT NULL DEFAULT 0.0,
    width           REAL NOT NULL DEFAULT 320.0,
    height          REAL NOT NULL DEFAULT 180.0,       -- Updated on DOM card measure for accurate R-tree AABB
    collapsed       INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),

    created_at      INTEGER NOT NULL,                  -- Unix epoch ms
    updated_at      INTEGER NOT NULL
);

-- Directed semantic edges (source_id -> target_id)
CREATE TABLE IF NOT EXISTS edges (
    id          TEXT PRIMARY KEY,                      -- ULID prefixed: "edge_01J..."
    source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    type        TEXT NOT NULL
                     CHECK (type IN ('derives', 'branches', 'challenges', 'resolves', 'synthesizes', 'references')),
    weight      TEXT NOT NULL DEFAULT 'summary'
                     CHECK (weight IN ('full', 'summary')),
    created_at  INTEGER NOT NULL,
    UNIQUE (source_id, target_id, type),
    CHECK (source_id != target_id)                     -- Self-loops forbidden
);

-- Operational indexes
CREATE INDEX IF NOT EXISTS idx_edges_source  ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target  ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_nodes_status  ON nodes(type, status);
CREATE INDEX IF NOT EXISTS idx_nodes_pinned  ON nodes(pin_global) WHERE pin_global = 1;
CREATE INDEX IF NOT EXISTS idx_nodes_stale_summary
    ON nodes(updated_at) WHERE content_hash != summary_hash AND exclude_from_ai = 0;

-- External-content FTS5 virtual table (zero text duplication on disk)
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    title,
    content,
    summary,
    content='nodes',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- FTS5 sync triggers: AFTER UPDATE is strictly column-scoped so (x, y, width, height)
-- dragging NEVER triggers full-text re-indexing.
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, title, content, summary)
    VALUES (new.rowid, new.title, new.content, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, content, summary)
    VALUES ('delete', old.rowid, old.title, old.content, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE OF title, content, summary ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, content, summary)
    VALUES ('delete', old.rowid, old.title, old.content, old.summary);
    INSERT INTO nodes_fts(rowid, title, content, summary)
    VALUES (new.rowid, new.title, new.content, new.summary);
END;

```

### 1.2 Canonical Edge Direction Convention

Antigravity 2.0 MUST enforce exact edge directionality across UI actions, AI spawning, and graph traversal:

| Edge Type | `source_id` | `target_id` | Context Compiler Traversal Direction |
| --- | --- | --- | --- |
| `derives` | Parent Node | Child Node | Backward (`incoming` of child) |
| `branches` | Parent Node | Alternative Branch | Backward (`incoming` of branch); blocks sibling bleed |
| `challenges` | Loophole Node | Challenged Target | `incoming` of target; injects source if `status == active` |
| `resolves` | Fix / Mitigation Node | Resolved Loophole | Informational & triage closure (auto-marks target `resolved` on creation) |
| `synthesizes` | Input Branch Node | Synthesis Decision | Backward (`incoming` of synthesis) |
| `references` | Focus / Citing Node | Referenced Node | One-hop `outgoing` of focus node only |

### 1.3 Command Palette (`search_nodes`) Query Grammar

`search_nodes` parses whitespace-delimited tokens into structured SQL filters plus an FTS5 prefix query:

* Recognized prefixes:
* `status:<draft|active|resolved|dismissed|locked>`
* `type:<core|branch|loophole|probe|synthesis>`
* `severity:<low|medium|high|critical>`
* `pinned:<true|false>`
* `excluded:<true|false>`


* Remaining tokens are sanitized (strip FTS5 special operators `" * ^ ( ) :`), joined with spaces, and appended with `*` on the final term for live prefix matching.
* Ranking:
* When free-text terms exist: `ORDER BY bm25(nodes_fts, 4.0, 1.0, 2.0) ASC, n.updated_at DESC`.
* When only structured filters exist (e.g., `status:active type:loophole`): skip FTS5 join and order by severity priority (`critical > high > medium > low`) then `n.updated_at DESC`.



---

## 2. Canonical Data Models (Rust & Mirrored TypeScript)

All IPC payloads use `snake_case` field names and internally tagged enums (`#[serde(tag = "...")]`). TypeScript mirrors MUST match byte-for-byte.

### 2.1 Rust Models (`src-tauri/src/graph/models.rs`)

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    Core,
    Branch,
    Loophole,
    Probe,
    Synthesis,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeWeight {
    Full,
    Summary,
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
    pub updated_nodes: Vec<NodeDto>,    // Returns recalculated hashes, token_counts, updated_at
    pub deleted_node_ids: Vec<String>,
    pub deleted_edge_ids: Vec<String>,  // Includes cascade-deleted edges for client Undo/Redo capture
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompiledXray {
    pub total_tokens: u32,
    pub budget_tokens: u32,
    pub node_modes: HashMap<String, InclusionMode>,
    pub active_edges: Vec<String>,
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
    pub base_url: String,               // e.g. "[https://api.openai.com/v1](https://api.openai.com/v1)" or "[http://127.0.0.1:11434](http://127.0.0.1:11434)"
    pub model: String,                  // e.g. "gpt-4.1", "claude-sonnet-4-20250514", "qwen2.5:14b"
    pub has_api_key: bool,              // True if stored in OS keychain; key itself is NEVER returned
    pub temperature: f32,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettingsDto {
    pub reasoning: ModelTierConfig,
    pub utility: ModelTierConfig,
    pub default_token_budget: u32,
    pub auto_summarize: bool,
    pub theme: String,                  // "dark" | "light"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveSettingsInput {
    pub reasoning: ModelTierConfig,
    pub reasoning_api_key: Option<String>, // Some("") clears key; None keeps existing key
    pub utility: ModelTierConfig,
    pub utility_api_key: Option<String>,
    pub default_token_budget: u32,
    pub auto_summarize: bool,
    pub theme: String,
}

```

### 2.2 Mirrored TypeScript Types (`src/ipc/types.ts`)

```typescript
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
  | "custom";
export type LensKind = "red_team" | "edge_case" | "diverge" | "feynman" | "synthesize" | "custom";
export type CreatedBy = "user" | "ai";
export type EdgeType =
  | "derives"
  | "branches"
  | "challenges"
  | "resolves"
  | "synthesizes"
  | "references";
export type EdgeWeight = "full" | "summary";
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

export interface AppSettingsDto {
  reasoning: ModelTierConfig;
  utility: ModelTierConfig;
  default_token_budget: number;
  auto_summarize: boolean;
  theme: "dark" | "light";
}

export interface SaveSettingsInput {
  reasoning: ModelTierConfig;
  reasoning_api_key?: string | null;
  utility: ModelTierConfig;
  utility_api_key?: string | null;
  default_token_budget: number;
  auto_summarize: boolean;
  theme: "dark" | "light";
}

export interface SummaryUpdatedEvent {
  node_id: string;
  summary: string;
  summary_hash: string;
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

```

---

## 3. Tauri v2 IPC Command & Event Contract

### 3.1 Backend `AppState` Concurrency Model

`AppState` holds four synchronized primitives managed by Tauri:

1. `workspace: Arc<RwLock<Option<ActiveWorkspace>>>` — Holds the in-memory `GraphEngine` (HashMaps + `rstar` R-tree) and workspace file path. Read locks serve `compile_xray` concurrently; short write locks commit `apply_ops` and `tidy_subtree`.
2. `db: Arc<Mutex<Option<rusqlite::Connection>>>` — Dedicated SQLite WAL connection guarded by a std/tokio mutex (SQLite transactions execute via `tokio::task::spawn_blocking` if heavy, or direct sub-ms mutex for small ops).
3. `active_runs: Arc<Mutex<HashMap<String, CancellationToken>>>` — Tracks in-flight SSE streams keyed by `run_id`.
4. `summary_tx: mpsc::UnboundedSender<String>` — Feeds modified `node_id`s into the debounced background summary worker.

**Lock Ordering Rule (Deadlock Prevention):** Always acquire `workspace` BEFORE `db`, and NEVER hold either lock across an `await` network call.

### 3.2 Command Surface (`src-tauri/src/ipc/commands.rs`)

| Command | Arguments (camelCase in JS invoke) | Return Type | Behavior & Side Effects |
| --- | --- | --- | --- |
| `open_workspace` | `{ path: string }` | `WorkspaceSnapshot` | Opens/creates `.sqlite` file, runs pragmas + DDL, hydrates `GraphEngine` + R-tree, spawns default starter `core` node if DB is completely empty, returns full snapshot. |
| `apply_ops` | `{ ops: GraphOp[] }` | `ApplyResult` | Validates `locked` status guards, executes all ops atomically in one SQLite `BEGIN IMMEDIATE ... COMMIT` transaction, updates `GraphEngine` + R-tree, recalculates `content_hash` (BLAKE3) & `token_count` (`ceil(len / 4)`), enqueues changed IDs to `summary_tx`. Note: `CreateEdge` of type `resolves` automatically sets target loophole `status = resolved` in the same transaction. |
| `spawn_connected_node` | `{ parentId: string, edgeType: EdgeType, nodeType: NodeType, title?: string }` | `{ node: NodeDto, edge: EdgeDto }` | Convenience atomic command for `Tab` (`derives`), `Shift+Enter` (`branches`), and loophole fix (`resolves`): computes collision-free `(x, y)` via Rust R-tree, persists node + edge, returns both. |
| `compile_xray` | `{ focusIds: string[], tokenBudget?: number }` | `CompiledXray` | Pure read-locked execution of `graph::compiler::compile_context`. Zero DB I/O, zero network calls. Target latency under 5 ms. |
| `run_lens` | `{ lens: LensKind, focusIds: string[], customPrompt?: string, onEvent: Channel<LensStreamEvent> }` | `string` (`run_id`) | Validates `focusIds` (`Synthesize` requires at least 2 IDs), compiles context, registers `CancellationToken`, spawns Tokio SSE task, returns `run_id` immediately. Streams `SkeletonSpawned`, `TokenDelta`, `NodeFinalized`, `RunCompleted` over `onEvent`. |
| `cancel_run` | `{ runId: string }` | `void` | Fires `CancellationToken::cancel()` for `runId`. Active SSE task aborts HTTP read, persists partial buffered node text, emits `NodeFinalized` + `RunCompleted { cancelled: true }`. |
| `search_nodes` | `{ query: string, limit?: number }` | `SearchHit[]` | Parses structured filters + FTS5 BM25 query; default `limit = 30`. |
| `tidy_subtree` | `{ rootId: string }` | `NodePositionUpdate[]` | Runs deterministic Reingold-Tilford-inspired left-to-right tree layout + R-tree collision nudge on `rootId` descendants, commits via `MoveNodes` transaction, returns updated positions for smooth frontend interpolation. |
| `save_camera` | `{ camera: CameraState }` | `void` | Debounced persistence of `camera_x`, `camera_y`, `camera_zoom`, `last_focus_id` into `workspace_meta`. |
| `export_json` | `{ destPath: string }` | `void` | Writes deterministic, ID-sorted pretty JSON (Section 4) atomically via temp file + rename. |
| `import_json` | `{ srcPath: string, destSqlitePath: string }` | `WorkspaceSnapshot` | Validates schema `version == 1`, creates/populates a new SQLite workspace file, opens and returns snapshot. |
| `get_settings` | `{}` | `AppSettingsDto` | Reads non-secret settings from Tauri app config dir (`settings.json`) and checks OS Keychain existence flags (`has_api_key`). |
| `save_settings` | `{ input: SaveSettingsInput }` | `AppSettingsDto` | Writes config JSON; writes/deletes API keys in OS Keychain under service `"dev.axiom.canvas"`, keys `"reasoning_api_key"` and `"utility_api_key"`. |
| `test_provider_connection` | `{ tier: "reasoning" | "utility" }` | `{ ok: boolean, latency_ms: number, message: string }` |

### 3.3 Global Backend-to-Frontend Events

* `axiom://summary-updated` — Payload: `SummaryUpdatedEvent`. Emitted by the background summary worker after updating SQLite and in-memory `GraphEngine`. Frontend updates the node's `summary` and `summary_hash` silently without triggering card re-layout.

### 3.4 Standardized Error Serialization

Every `#[tauri::command]` returns `Result<T, IpcError>`. Tauri serializes `IpcError` as JSON so the frontend displays non-intrusive toast notifications keyed by `code` (e.g., `NODE_LOCKED` triggers a subtle shake on the locked card; `PROVIDER_AUTH` offers a one-click jump to Settings).

---

## 4. Deterministic JSON Export Schema (`axiom-workspace-v1`)

Exported files MUST sort `nodes` by `id ASC` and `edges` by `id ASC` and use 2-space indentation so `git diff` stays clean and minimal.

```json
{
  "format": "axiom-workspace",
  "version": 1,
  "exported_at": 1763980800000,
  "meta": {
    "camera": { "x": 0.0, "y": 0.0, "zoom": 1.0, "last_focus_id": "node_01J..." },
    "token_budget": 6000
  },
  "nodes": [
    /* Array of NodeDto sorted by id ASC */
  ],
  "edges": [
    /* Array of EdgeDto sorted by id ASC */
  ]
}

```

---

## 5. Exact Repository Structure & Dependency Manifests

### 5.1 Directory Layout

```text
axiom-canvas/
├── AGENTS.md
├── docs/
│   ├── 01-SRS.md
│   ├── 02-DATA-AND-ICD.md
│   ├── 03-ALGORITHMS-AND-AI.md
│   ├── 04-UI-UX-AND-RENDERING.md
│   └── 05-VV-AND-SLICES.md
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── styles/
│   │   └── theme.css               # Monochrome palette, semantic accents, typography tokens
│   ├── ipc/
│   │   ├── types.ts                # Exact mirror of Rust DTOs
│   │   └── client.ts               # Typed invoke() wrappers, Channel bridge, event listeners
│   ├── store/
│   │   ├── graphStore.ts           # Signals/Maps for nodes, edges, active runs, settings
│   │   ├── history.ts              # Command-pattern Undo/Redo ring buffer (capacity 100)
│   │   └── selection.ts            # Focus ID, multi-select Set, Hold-V X-Ray map, modal state
│   ├── canvas/
│   │   ├── camera.ts               # Pan/zoom matrix, world<->screen math, Smart Fit, rAF loop
│   │   ├── spatialIndex.ts         # rbush wrapper for viewport culling
│   │   ├── renderer2d.ts           # Single <canvas>: procedural dot grid, Bezier edges, X-Ray, LOD < 0.45x
│   │   └── pointer.ts              # Space+Drag pan, box select, multi-node drag, Alt-drag edge connect
│   ├── cards/
│   │   ├── CardLayer.tsx           # GPU translate3d layer mounting only viewport-culled visible cards
│   │   ├── NodeCard.tsx            # Static cached card + semantic border + hover pill + streaming pulse
│   │   ├── markdownCache.ts        # Content-hash memoized markdown-it + KaTeX + highlight.js + DOMPurify
│   │   └── LiveEditorOverlay.tsx   # Single mounted CodeMirror 6 instance (Edit Mode only)
│   ├── input/
│   │   ├── keymap.ts               # 3-state modal router + A-chord state machine + global shortcuts
│   │   └── topologyNav.ts          # H/J/K/L parent, child, sibling, and loophole triage traversal
│   └── overlays/
│       ├── CommandPalette.tsx      # Cmd/Ctrl+K fuzzy FTS5 jumper + structured filter chips
│       ├── CustomPromptBar.tsx     # Ephemeral A+Space inline prompt input under focus node
│       ├── XrayHud.tsx             # Floating live token bar visible while holding V
│       ├── SettingsModal.tsx       # Dual-tier provider config, API key entry, connection test
│       └── ToastStack.tsx          # Ephemeral bottom-right error/status pills
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    └── src/
        ├── main.rs
        ├── lib.rs                  # AppState setup, plugin/command registration
        ├── error.rs                # IpcError enum + From<...> impls
        ├── settings.rs             # settings.json + OS keyring read/write
        ├── db/
        │   ├── mod.rs              # Connection open, PRAGMAs, migration runner
        │   ├── migrations.rs       # Embedded SQL DDL (Section 1.1)
        │   ├── queries.rs          # Transactional apply_ops, FTS5 search_nodes, camera save
        │   └── json_io.rs          # Deterministic export_json / import_json
        ├── graph/
        │   ├── mod.rs              # GraphEngine: HashMap<id, NodeDto>, incoming/outgoing adjacency
        │   ├── models.rs           # Canonical Rust DTOs (Section 2.1)
        │   ├── spatial.rs          # rstar R-tree collision placement & tidy_subtree algorithm
        │   └── compiler.rs         # Backward BFS, Kahn cycle-safe topo sort, distance-decay compiler
        ├── ai/
        │   ├── mod.rs
        │   ├── prompts.rs          # Verbatim base prompt, 5 lens prompts, custom & summary prompts
        │   ├── parser.rs           # Fence-aware @@NODE / @@END streaming state machine
        │   ├── provider.rs         # OpenAI-compat SSE, Anthropic SSE, Ollama NDJSON clients
        │   ├── runner.rs           # Coordinates stream -> R-tree placement -> SQLite -> Channel
        │   └── summarizer.rs       # Debounced (1500ms) background utility-model worker
        └── ipc/
            └── commands.rs         # All #[tauri::command] handlers

```

### 5.2 `src-tauri/Cargo.toml` (Locked Baseline)

```toml
[package]
name = "axiom-canvas"
version = "0.1.0"
edition = "2021"

[lib]
name = "axiom_canvas_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.32", features = ["bundled", "modern_sqlite"] }
rstar = "0.12"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time"] }
tokio-util = "0.7"
futures-util = "0.3"
reqwest = { version = "0.12", default-features = false, features = ["json", "stream", "rustls-tls"] }
ulid = "1"
blake3 = "1"
thiserror = "2"
keyring = "3"
dirs = "5"

[dev-dependencies]
tempfile = "3"

```

### 5.3 `package.json` (Locked Baseline)

```json
{
  "name": "axiom-canvas",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "tauri": "tauri"
  },
  "dependencies": {
    "@codemirror/commands": "^6.7.0",
    "@codemirror/lang-markdown": "^6.3.0",
    "@codemirror/state": "^6.4.0",
    "@codemirror/view": "^6.35.0",
    "@preact/signals": "^1.3.0",
    "@tauri-apps/api": "^2.1.0",
    "@tauri-apps/plugin-dialog": "^2.1.0",
    "dompurify": "^3.1.0",
    "highlight.js": "^11.10.0",
    "katex": "^0.16.11",
    "markdown-it": "^14.1.0",
    "preact": "^10.24.0",
    "rbush": "^4.0.1"
  },
  "devDependencies": {
    "@preact/preset-vite": "^2.9.0",
    "@tauri-apps/cli": "^2.1.0",
    "@types/dompurify": "^3.0.5",
    "@types/katex": "^0.16.7",
    "@types/markdown-it": "^14.1.2",
    "@types/rbush": "^3.0.4",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}

```

### 5.4 Tauri Security & CSP Lock (`src-tauri/tauri.conf.json` excerpt)

```json
{
  "app": {
    "security": {
      "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src ipc: [http://ipc.localhost](http://ipc.localhost)"
    }
  }
}

```

*Note: All outbound LLM network requests execute exclusively from the Rust backend via `reqwest`, so the WebView CSP blocks all arbitrary remote `connect-src` origins completely.*

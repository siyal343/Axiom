# Axiom v0.2 Architecture & Design Record

**Date:** 2026-11-25  
**Scope:** Rust Engine Hardening, Context Compiler v2, Deterministic Artifact Compiler, and Interactive Graph & Context Workbench  
**Status:** Implemented and verified locally across Rust and TypeScript suites.

---

## 1. Executive Summary & Ownership Goals

Axiom v0.1 established the Slice 0–5 foundation: local-first SQLite WAL + FTS5 storage, an `rstar`-backed spatial layout engine, a deterministic distance-decay context compiler, a three-layer `requestAnimationFrame` canvas + single CodeMirror 6 overlay, and multi-provider streaming AI lenses.

Axiom v0.2 elevates that foundation from a working canvas prototype into a durable, interactive **engineering & research reasoning workbench** across three pillars while preserving every non-negotiable invariant in `AGENTS.md`:

1. **Pillar 1 — Rust Engine Hardening & Context Compiler v2:** Eliminated cross-workspace stream contamination, incomplete locked-node guards, token-budget drift, blocking sequential summarization, non-deterministic JSON timestamps, unsafe non-atomic JSON imports, and context-compiler blind spots.
2. **Pillar 2 — Deterministic Artifact Compiler (`ADR` / `Brief` / `Mermaid`):** Added a pure-Rust graph-to-Markdown/Mermaid compiler (`src-tauri/src/graph/exporter.rs`) so engineering decisions, trade-offs, and loophole mitigations flow out of Axiom into PRs, RFCs, and documentation without manual copy-paste.
3. **Pillar 3 — Interactive Graph & Context Workbench (Frontend UX):** Made edges first-class selectable/editable objects, enabled port-drag edge wiring and full 6-type edge creation (`1`–`6`), restored full pointer parity in Bird's-Eye LOD (`< 0.45x`), upgraded Context X-Ray to an inspectable sticky debugger (`Shift+V`), added a camera-synced multi-select action bar, added a Canvas2D minimap (`M`), added global severity-ordered loophole navigation (`[` / `]`), and fixed browser-mode persistence.

---

## 2. Invariants & Constraints Preserved

Every v0.2 change was designed to strictly uphold the six architectural invariants in `AGENTS.md`:

| Invariant | How v0.2 Preserves It |
| --- | --- |
| **1. One Live Editor Rule** | Zero CodeMirror instances exist in `navigate` mode. `LiveEditorOverlay.tsx` remains the sole editor overlay and fixed a stale-hash cache pre-warm bug on commit. |
| **2. Decoupled 60–120 FPS Camera Loop** | Idle edge hover updates `PointerOverlayState.hoveredEdgeId` without touching Preact signals. `EdgeInspectorPill`, `MinimapOverlay`, `.multi-select-pill`, and `.edge-popover` track pan/zoom exclusively via `CanvasCameraController.subscribeFrame()` mutating DOM `transform` or `<canvas>` directly. Measured 500N/700E p95 draw time is **4.700 ms** (budget: 16.6 ms). |
| **3. Zoom LOD Cutoff (`0.45x`)** | `CardLayer` unmounts below `0.45x`. `pointer.ts` now falls back to `viewportSpatialIndex.queryRect()` so clicking, double-clicking, connecting, and context-menu actions work seamlessly in Bird's-Eye view without mounting DOM cards. |
| **4. Single-Source-of-Truth Context & Artifact Compilation** | Both `compile_xray` and `run_lens` call `graph::compiler::compile_context()`, and `run_lens` compiles once per run via `PreparedLensRun`. Artifact export (`ADR`, `Brief`, `Mermaid`) executes strictly in Rust (`graph::exporter::compile_markdown_artifact`). |
| **5. Streaming Framing Immunity** | `NodeStreamParser` remains untouched in Rust; `run_lens` and `summarizer` now enforce `workspace_generation` fencing across async boundaries. |
| **6. Atomic Local Persistence** | `apply_ops` enforces `NodeStatus::Locked` across edits, metadata changes, and deletes; `import_json` builds and checkpoints a staged SQLite file before touching active handles or destination files; browser mode persists mutations via debounced `localStorage` + `beforeunload` flush. |

---

## 3. Detailed Subsystem Changes

### 3.1 Rust Engine Hardening (`src-tauri/src/`)

- **Workspace Generation Guard (`ipc/mod.rs`, `ipc/commands.rs`, `ai/runner.rs`):**
  - `AppState` now tracks `workspace_generation: Arc<AtomicU64>` and exposes `bump_generation_and_cancel_runs()`.
  - Switching workspaces/flows (`open_workspace_internal`), deleting the active workspace/flow, or committing an `import_json` cancels all in-flight runs and increments `workspace_generation`.
  - `execute_lens_run` checks `workspace_generation` before every DB/engine mutation; on mismatch it aborts cleanly and emits `LensStreamEvent::RunCompleted { cancelled: true, .. }` without contaminating the newly opened workspace.
  - `run_lens` compiles context once via `prepare_lens_context() -> PreparedLensRun`, eliminating the prior double compilation.
- **Stream & Provider Reliability (`ipc/mod.rs`, `ai/provider.rs`):**
  - Replaced the 120 s total request timeout on `reqwest::Client` with `.connect_timeout(Duration::from_secs(15)).read_timeout(Duration::from_secs(90))` so slow local Ollama or long reasoning streams do not abort mid-response.
  - `ProviderKind::Anthropic` now fails fast with `IpcErrorCode::ProviderAuth` when the API key is missing or whitespace-empty.
- **Locked-Node Integrity, Token Budget & Stale Summarization (`db/queries.rs`, `ai/summarizer.rs`):**
  - `apply_ops` now rejects `GraphOp::DeleteNodes` and `GraphOp::UpdateNodeMeta` (unless explicitly unlocking via `status: Some(non_locked)`) when a target node has `status == NodeStatus::Locked`.
  - Added `db::queries::save_token_budget` so `save_settings` persists `default_token_budget` into `workspace_meta` and newly seeded flows inherit the configured budget.
  - Added `db::queries::list_stale_summary_node_ids` leveraging `idx_nodes_stale_summary` and enqueues up to 64 stale nodes on workspace open.
  - `ai::summarizer::spawn_summarizer_worker` now runs bounded concurrent tasks (`Semaphore(2)`) with generation checks so an offline/slow utility endpoint cannot stall the debounce loop or write into a switched workspace.
- **Deterministic JSON & Staged Import (`db/json_io.rs`):**
  - `export_json` computes `exported_at` deterministically from the maximum `updated_at` (or edge `created_at`, or `0`) rather than wall-clock time, guaranteeing byte-identical exports for unchanged graphs.
  - `stage_import_json` validates JSON and populates/checkpoints a sibling `.importing-<ulid>.sqlite` staging file with RAII cleanup before `ipc::commands::import_json` releases active DB handles or replaces the destination file.

### 3.2 Context Compiler v2 (`src-tauri/src/graph/compiler.rs`, `models.rs`)

- **Accurate Empty-Summary Costing:** Fixed `summary_cost(n)` to charge `n.metadata.token_count` whenever `n.summary.is_empty()` (matching Step 7's fallback to `&n.content`) instead of under-reporting as `estimate_tokens(&n.title)`.
- **Global Pin Loophole Harvesting:** Step 4 now includes `global_pins` IDs in `relevant_targets` so unresolved `Challenges` edges targeting pinned Global Constraints always enter `[UNRESOLVED LOOPHOLES]`.
- **Direct Parent Relation Labels:** `[DIRECT PARENTS & INPUTS]` headings now surface the incoming edge relation(s) (e.g., `### Title [Core · branches]`), while keeping all six canonical section headers intact.
- **Diagnostic X-Ray Payload (`CompiledXray`):** Extended with `overflow: bool`, `mode_tokens: HashMap<InclusionMode, u32>`, and `prompt_preview: String`.

### 3.3 Deterministic Artifact Compiler (`src-tauri/src/graph/exporter.rs`)

- Reuses `pub(crate) kahn_topo_sort_cycle_safe` and `is_ancestor_edge` from `graph::compiler`.
- Exposes `compile_markdown_artifact(engine, focus_ids, scope, format) -> CompiledArtifact` and Tauri IPC command `export_markdown_artifact`.
- **Scopes:**
  - `subgraph`: Collects focus node(s), backward ancestors (`Derives`/`Branches`/`Synthesizes`), forward descendants, attached `Challenges`/`Resolves`/`References`, and non-excluded Global Pins.
  - `workspace`: Compiles all non-excluded nodes in the active flow.
- **Formats:**
  - `adr`: `# <Title>`, summary stats, `## Context & Global Constraints`, `## Decision Spine`, `## Alternatives Considered`, `## Risk & Loophole Register` (pairing `Challenges` loopholes with `Resolves` mitigations and flagging open `High`/`Critical` items), and an embedded `flowchart LR` Mermaid block.
  - `brief`: Structured Research / Study Brief (`## Key Takeaways & Synthesis`, `## Core Concepts & Derivations`, `## Probing Questions & Study Checks`, `## Open Challenges & Mitigations`, `## References`).
  - `mermaid`: Standalone deterministic `flowchart LR` with safe IDs (`n0`, `n1`, ...), escaped labels, semantic node shapes, and typed arrows.
- When `dest_path` is provided, writes atomically via temp file + `sync_all` + rename.

### 3.4 Frontend Graph Workbench & UX (`src/`)

- **First-Class Edges & Direct Wiring (`renderer2d.ts`, `pointer.ts`, `NodeCard.tsx`, `EdgeInspectorPill.tsx`):**
  - `hitTestEdge` and `getEdgeMidpointWorld` perform zoom-scaled cubic Bezier distance hit-testing and midpoint projection.
  - Clicking an edge selects `selectedEdgeId` and anchors `EdgeInspectorPill` directly via `subscribeFrame` with undoable **Type** (`6` types), **Weight** (`summary` ↔ `full` + live `axiom:xray-refresh`), **Reverse** (`⇄`), and **Delete** (`×` / `Backspace` / `Delete`).
  - `.node-port` handles support dual gestures: click (`< 6px`) spawns a child in that direction; drag (`>= 6px`) draws a live port-anchored Bezier preview to wire any target card.
  - `connect_edge` (`E`) highlights `connectSourceId` on both Canvas2D and DOM cards and accepts pointer clicks on any target node; `.edge-popover` exposes all 6 `EdgeType`s with `1`–`6` hotkeys and tracks camera pan/zoom via `subscribeFrame`.
- **Bird's-Eye LOD Pointer Parity (`pointer.ts`):**
  - Falls back to `hitTestNodeAtWorld()` (`viewportSpatialIndex.queryRect`) in `onPointerDown`, `onDblClick`, and `onContextMenu` when `< 0.45x` LOD hides DOM cards.
- **Post-Drag Overlap Undo Consistency (`pointer.ts`, `graphStore.ts`):**
  - `resolveAndAnimateOverlaps` returns `Promise<NodePositionUpdate[]>`, allowing `pointer.ts` to record dragged cards and overlap-displaced neighbors together in a single undoable `Move node(s)` history entry.
- **Interactive Sticky Context X-Ray (`XrayHud.tsx`, `keymap.ts`):**
  - `Shift+V` (or HUD Pin button) pins X-Ray open with `pointer-events: auto` and auto-recompiles on graph, focus, selection, budget, or `axiom:xray-refresh` changes.
  - Displays `OVER BUDGET` indicator, per-mode token & node counts, and an expandable monospace **Inspect Prompt** viewer with 1-click Copy.
- **Multi-Select Bulk Parity, Minimap, Loophole Stepper & Artifact Export (`App.tsx`, `NodeContextMenu.tsx`, `MinimapOverlay.tsx`, `ArtifactExportModal.tsx`, `CommandPalette.tsx`, `SettingsModal.tsx`, `ShortcutsModal.tsx`, `workspaceCatalogStore.ts`):**
  - Camera-synced `.multi-select-pill` (`N selected` + `Synthesize`, `Pin`, `Exclude`, `Fold`, `Fit`, `Delete`), `Ctrl/Cmd+A` Select All, `F` fit selection/subtree, `C` bulk fold, and bulk `NodeContextMenu` actions + **Type / Severity** switchers.
  - Toggleable HiDPI `184×112px` `<canvas>` `MinimapOverlay` (`M`) with click/drag panning.
  - Conditional `⚠ N` unresolved loophole counter in `.canvas-controls` (auto-shifted when `WorkspaceSidebar` is open) + `[` / `]` severity-ordered loophole cycling.
  - `ArtifactExportModal` (`ADR / RFC`, `Research Brief`, `Mermaid Graph`) wired to `CommandPalette` (`> Export ...`) and `NodeContextMenu` (`Export Subgraph…`).
  - Fixed `LiveEditorOverlay` stale-hash cache pollution, `SettingsModal` numeric draft editing, `ShortcutsModal` binding accuracy, `.xray-hud` / `.ai-thinking-pill` vertical stacking, and browser-mode debounced `localStorage` + `beforeunload` persistence.

---

## 4. Measured Verification Results (Post-Final-Edit)

All checks ran cleanly on Windows (`win32`) after the final code edit:

- **TypeScript (`npx tsc --noEmit`):** Passed with `0` errors.
- **Production Bundle (`npm run build`):** Built `166` modules in `6.89s`.
- **Frontend Tests (`npm test -- --run`):** **19 test files passed, 55 tests passed** (`0` failed, `0` skipped), including:
  - `src/canvas/__tests__/edgeAndBirdsEye.test.ts` (6 tests): edge hit-testing, selection/deselection, Bird's-Eye LOD (`0.30x`) click/dblclick/contextmenu, `connect_edge` click completion, port-drag `< 6px` vs `>= 6px`.
  - `src/overlays/__tests__/v02Workbench.test.tsx` (4 tests): sticky `Shift+V` X-Ray + prompt preview, multi-select bulk actions & Type/Severity switchers, `edgePopover` `1`–`6` keys + `Ctrl+A` + `C` + `[` / `]`, and `ArtifactExportModal`.
  - `src/canvas/__tests__/stress500.test.ts`: **500 nodes / 700 edges, 120 frames: `p95 drawMs = 4.700 ms`, `avgDrawMs = 3.447 ms`** (measured).
- **Rust Clippy (`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`):** Passed with `0` warnings.
- **Rust Tests (`cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture`):** **44 tests passed** (`0` failed, `0` skipped):
  - `lib.rs` unit tests: `9` passed
  - `tests/slice1_suite.rs`: `19` passed (`500-node, 700-edge compile_context: 276.3µs`, `search_nodes: 2.8542ms` — measured)
  - `tests/slice4_suite.rs`: `8` passed
  - `tests/slice5_suite.rs`: `3` passed (`500-node cold boot: 26.29 ms`, `compile_context: 1.721 ms`, `search_nodes: 6.479 ms` — measured)
  - `tests/v02_suite.rs`: `5` passed (locked node delete/meta guards, deterministic `export_json` + safe `import_json`, Compiler v2 accuracy/diagnostics, Artifact Compiler determinism/pairing/atomic write, generation guard cancellation).

---

## 5. Future Roadmap (v0.3 Candidates)

1. **Schema v2 Migration & Upstream AI Provenance (`ai_runs`):** Track input BLAKE3 hashes per generated node to flag downstream syntheses as stale when a pinned Global Constraint changes, and persist `research`/`study` lens origins natively in SQLite.
2. **Workspace-Wide FTS5 Search & Cross-Flow Reference Proxies:** Query across all flows in a workspace from `Cmd/Ctrl+K` and link shared invariants across sibling flows via hash-verified read-only proxy nodes.
3. **Custom User Lenses & Reasoning-Model Parameter Profiles:** User-defined lenses in `settings.json` and automatic `max_completion_tokens` / `reasoning_content` handling for reasoning-tier models.

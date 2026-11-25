# Axiom v0.4 Architecture & Design Record

**Date:** 2026-11-25  
**Scope:** Custom User Lenses (`@tags`), Rust Graph Health Diagnostics (Tarjan SCC Cycle Detection), and Atomic Markdown Outline Paste-to-Graph Importer  
**Status:** Implemented and verified locally across Rust and TypeScript suites.

---

## 1. Executive Summary & Ownership Goals

Axiom v0.3 introduced Schema v2, AI input provenance & staleness detection, and workspace-wide FTS5 knowledge discovery. Axiom v0.4 delivers three high-leverage productivity features that let users tailor AI reasoning to their exact domain, audit large graphs structurally, and ingest existing documents into spatial thinking trees in seconds—all while preserving every invariant in `AGENTS.md`:

1. **Feature 1 — Custom User Lenses (`@tags` Everywhere):** Users can author, install from starter presets (`@threat`, `@rollout`, `@reviewer2`), edit, and persist reusable custom AI lenses inside `settings.json`, automatically wired into CodeMirror inline `@tag` autocomplete, `CommandPalette` `@` mode, `CustomPromptBar`, `NodeContextMenu`, and Rust `run_lens`.
2. **Feature 2 — Rust Graph Health Diagnostics (`diagnostics.rs` + `DiagnosticsModal`):** Sub-millisecond Rust structural analyzer computing a deterministic `0–100` health score, Tarjan strongly connected component (SCC) ancestor dependency cycles, severity-ordered unresolved loopholes, stale AI nodes, disconnected orphans, and heavy unsummarized nodes (`>= 250` tokens without a summary), with 1-click camera jump, **Mark Fresh**, and **Queue Summaries** actions.
3. **Feature 3 — Atomic Markdown Outline Paste-to-Graph Importer (`importer.rs` + `OutlineImportModal`):** Fence-aware Rust ATX Markdown parser that transforms pasted RFCs, design docs, or study notes (`#`..`######` plus semantic title prefixes like `Risk:`, `Option:`, `Question:`, `Decision:`) into an R-tree-laid-out subgraph in one atomic SQLite transaction—fully undoable in a single `Ctrl/Cmd+Z` step.

---

## 2. Feature 1 — Custom User Lenses (`@tags`)

- **Schema & Validation (`src-tauri/src/graph/models.rs`, `settings.rs`):**
  - Added `CustomLensDef { id, name, tag, description, prompt_template, default_node_type, default_edge_type, default_severity }` and `#[serde(default)] custom_lenses: Vec<CustomLensDef>` to `StoredSettings`, `AppSettingsDto`, and `SaveSettingsInput` (maintaining full backwards compatibility with prior `settings.json` files).
  - `SettingsStore::save` normalizes tags (trim, strip leading `@`, lowercase), enforces `[a-z0-9_-]{2,24}`, rejects collisions against all 30 built-in tags and aliases (`RESERVED_LENS_TAGS`), rejects duplicate custom tags and empty names/prompts, and assigns `lens_<ULID>` IDs when blank.
- **Rust Execution (`src-tauri/src/ai/runner.rs`, `ipc/commands.rs`):**
  - `run_lens` accepts `custom_lens_id: Option<String>`, looks up the lens via `SettingsStore::find_custom_lens`, and builds `PreparedLensRun` with `custom_lens_prompt` and `custom_defaults` (`LensDefaults`). Empty inline `custom_prompt` arguments are allowed when a custom lens provides `prompt_template`, and `NodeStreamParser` uses the custom lens's default node/edge/severity semantics.
- **Unified Frontend Registry (`src/input/actionTags.ts`, `src/store/aiRunner.ts`, `SettingsModal.tsx`, `CommandPalette.tsx`, `NodeContextMenu.tsx`, `App.tsx`):**
  - `customLensesSignal` + `getAllActionTags()` merge built-in `ACTION_TAGS` with user custom lenses so CodeMirror (`LiveEditorOverlay`), `CommandPalette`, `CustomPromptBar`, and `NodeContextMenu` stay automatically synchronized without duplicating tag parsing logic.
  - `BUILTIN_LENS_PRESETS` provides 1-click starter installs inside `SettingsModal`: `@threat` (STRIDE Threat Model), `@rollout` (Zero-Downtime Rollout), and `@reviewer2` (Reviewer #2 Critique).
  - `activeRunLabel` surfaces the custom lens name inside `.ai-thinking-pill` during streaming.

---

## 3. Feature 2 — Rust Graph Health Diagnostics (`src-tauri/src/graph/diagnostics.rs`)

- **Deterministic Analysis (`compute_graph_diagnostics`):**
  - **`unresolved_loopholes`:** Active `Loophole` nodes sorted `Critical > High > Medium > Low` then `id ASC`, citing challenged parent titles in `detail`.
  - **`stale_ai_nodes`:** Delegates to `provenance::compute_stale_nodes(conn, engine)` so upstream hash mismatches and deletions appear alongside structural checks.
  - **`cycles`:** Iterative Tarjan's SCC algorithm over `EdgeType::Derives | EdgeType::Branches | EdgeType::Synthesizes` (visiting nodes in sorted `id ASC` order), surfacing every SCC with `len >= 2` as `CycleDiagnostic { node_ids, titles }`.
  - **`orphan_nodes`:** Disconnected nodes (`0` incoming and `0` outgoing edges) whenever `engine.nodes.len() > 1`.
  - **`unsummarized_heavy_nodes`:** Non-excluded, non-draft nodes with `token_count >= 250` and empty `summary`, sorted `token_count DESC, id ASC`.
  - **`health_score`:** Starts at `100` and subtracts capped category penalties (`Critical -15`, `High -10`, `Medium -5`, `Low -2` capped at `50`; `stale -6` capped at `24`; `cycle -12` capped at `36`; `orphan -3` capped at `15`; `heavy -2` capped at `12`), clamped to `0..=100`.
- **IPC & Workbench UI (`ipc/commands.rs`, `src/overlays/DiagnosticsModal.tsx`, `keymap.ts`, `App.tsx`):**
  - Exposes `get_graph_diagnostics` and `enqueue_stale_summaries(limit)` (enqueues stale summaries into `summary_tx`).
  - Opened via `Shift+H`, `> Graph Health & Diagnostics`, or the `.canvas-controls` `♥ Health` button. Provides 1-click **Jump** to any flagged node, **Mark Fresh** for stale nodes, and **Queue Summaries** for heavy unsummarized nodes.

---

## 4. Feature 3 — Atomic Markdown Outline Importer (`src-tauri/src/graph/importer.rs`)

- **Fence-Aware Parser (`parse_markdown_outline`):**
  - Tracks ```` ``` ```` and `~~~` code fences so `#` comments inside code blocks are preserved as card body content rather than split into headings.
  - Parses ATX headings `#`..`######` (capped at `100` sections, with single-card fallback for plain-text notes) using a heading-level stack `(level, section_idx)` to reconstruct hierarchy.
  - Infers node/edge semantics from title prefixes: `risk:` / `loophole:` / `failure:` / `warning:` / `critical:` / `high:` → `Loophole` (`Challenges`); `question:` / `why:` / `probe:` / `open question:` → `Probe` (`Derives`); `option:` / `alternative:` / `branch:` → `Branch` (`Branches`); `decision:` / `synthesis:` / `conclusion:` → `Synthesis` (`Derives`); default → `Core` (`Derives`).
- **Atomic Persistence & Collision-Free Layout (`import_markdown_outline`):**
  - Validates optional `parent_id`, computes root placement via `spatial::find_free_position`, creates all nodes and edges in a single atomic `db::queries::apply_ops` transaction, runs `spatial::compute_tidy_subtree` (plus `resolve_overlaps` with existing nodes pinned if multiple roots exist), persists `MoveNodes`, and enqueues non-excluded nodes for background summarization.
- **Undoable Frontend Flow (`src/overlays/OutlineImportModal.tsx`):**
  - Accessible from `CommandPalette` (`> Import Markdown Outline`) and `NodeContextMenu` (`Import Outline Here…`).
  - Hydrates returned nodes/edges into `nodesMap` / `edgesMap` / `viewportSpatialIndex`, pushes a single `"Import Markdown outline"` entry to `graphHistory`, selects `root_id`, and fits the camera smoothly to the new subgraph.

---

## 5. Measured Verification Results (Post-Final-Edit)

- **TypeScript (`npx tsc --noEmit`):** Passed with `0` errors.
- **Vite Production Build (`npm run build`):** `170` modules built in `8.25s`.
- **Vitest (`npm test -- --run`):** **23 test files passed, 70 tests passed** (`0` failed, `0` skipped), including:
  - `src/overlays/__tests__/v04LensesAndTools.test.tsx` (4 tests): dynamic custom `@threat` lens parsing/execution, `SettingsModal` preset install/save, `DiagnosticsModal` mocked IPC & actions, `OutlineImportModal` atomic import + single undo entry + camera fit.
  - `src/overlays/__tests__/v04WorkbenchIntegration.test.tsx` (3 tests): `CommandPalette` v0.4 commands & live `@` custom lenses, `Shift+H` / `Esc` keymap routing, `NodeContextMenu` Custom Lenses group & `Import Outline Here…`.
  - `src/canvas/__tests__/stress500.test.ts`: **500 nodes / 700 edges, 120 frames: `p95 drawMs = 9.241 ms`, `avgDrawMs = 3.447 ms`** (measured).
- **Rust Clippy (`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`):** Passed with `0` warnings.
- **Rust Tests (`cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture`):** **54 tests passed** (`0` failed, `0` skipped): `lib.rs` (`9`), `slice1_suite` (`19`), `slice4_suite` (`8`), `slice5_suite` (`3`), `v02_suite` (`5`), `v03_suite` (`6`), `v04_suite` (`4`).

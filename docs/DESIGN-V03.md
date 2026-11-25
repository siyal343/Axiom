# Axiom v0.3 Architecture & Design Record

**Date:** 2026-11-25  
**Scope:** Schema v2 Migration, AI Provenance & Upstream Staleness Engine, Workspace-Wide FTS5 Knowledge Discovery, Reasoning-Model Compatibility, `tidy_subtree` Completeness & Spatial Spine Breadcrumb  
**Status:** Implemented and verified locally across Rust and TypeScript suites.

---

## 1. Executive Summary & Ownership Goals

Axiom v0.2 delivered first-class interactive edges, sticky X-Ray debugging, a Canvas2D minimap, and deterministic `ADR` / `Brief` / `Mermaid` exports. Axiom v0.3 closes the next three highest-leverage engineering & research gaps while preserving all six invariants in `AGENTS.md`:

1. **Pillar 1 — Schema v2 + AI Provenance & Upstream Staleness Engine:** Added a versioned SQLite `v1 -> v2` migration (`ai_runs` provenance table, native `research`/`study` lens origins, and per-flow `system_prompt`). Every finalized AI node now records the exact BLAKE3 `content_hash` values of the compiled pins, ancestors, loopholes, and references that produced it, enabling sub-millisecond detection when upstream assumptions change or vanish.
2. **Pillar 2 — Workspace-Wide FTS5 Search & Local BM25 Related Nodes:** Broke down per-flow silos using zero-ML SQLite FTS5 (`search_workspace_flows` across all `.sqlite` flows in a workspace from `Cmd/Ctrl+K`, plus `find_related_nodes` BM25 discovery with 1-click `references` linking).
3. **Pillar 3 — Reasoning-Model Compatibility, Per-Flow System Prompts, `tidy_subtree` Completeness & Spatial Spine Breadcrumb:** Added `max_completion_tokens` / omitted-`temperature` support for OpenAI reasoning models (`o1`, `o3`, `o4-`, `gpt-5`), persisted per-flow system instructions, extended `tidy_subtree` to lay out `Synthesizes` and `Resolves` nodes, and added a clickable root-to-focus `SpineBreadcrumb`.

---

## 2. Schema v2 & Migration Mechanics (`src-tauri/src/db/migrations.rs`)

- **Fresh Databases:** Initialize directly at `schema_version = '2'` with:
  - `workspace_meta('system_prompt', '')`
  - `nodes.lens` `CHECK` constraint expanded to include `'research'` and `'study'`
  - `ai_runs(spawned_node_id PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, run_id, lens, model, input_hashes_json, prompt_tokens, created_at)`
- **Existing v1 Databases (`migrate_v1_to_v2`):**
  1. Disables `PRAGMA foreign_keys = OFF` outside the transaction and guarantees restoration of `PRAGMA foreign_keys = ON` even on error.
  2. Inside `BEGIN IMMEDIATE`, drops FTS5 triggers, recreates `nodes_v2` with the expanded `lens` constraint, copies all rows **preserving `rowid`** so external-content `nodes_fts` rowids stay aligned, swaps tables, recreates indexes/triggers, runs `INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`, creates `ai_runs`, seeds `system_prompt`, and updates `schema_version = '2'`.
- **Native Origins (`src-tauri/src/ai/prompts.rs`, `src/cards/nodeAccent.ts`):** `lens_to_origin` now maps `LensKind::Research -> NodeLensOrigin::Research` and `LensKind::Study -> NodeLensOrigin::Study` natively without lossy fallback mapping.

---

## 3. AI Provenance & Upstream Staleness Engine

- **Capture (`src-tauri/src/graph/compiler.rs`, `ai/runner.rs`, `db/queries.rs`):**
  - `CompiledContext` emits `provenance_inputs: Vec<ProvenanceInput>` (sorted `node_id ASC`) covering every node in `node_modes`.
  - On AI node finalization (both spawned and `in_place` runs), `upsert_ai_run_provenance` persists `ai_runs` while filtering out `spawned_node_id` so user edits to the AI card itself never mark it stale.
- **Detection & Acknowledgement (`src-tauri/src/graph/provenance.rs`, `ipc/commands.rs`):**
  - `compute_stale_nodes` compares each recorded input against `GraphEngine.nodes`, classifying missing nodes as `StaleReason::Deleted` and hash mismatches as `StaleReason::Modified`.
  - `acknowledge_stale_node` updates retained inputs to their current hashes/titles and prunes deleted inputs.
  - `search_nodes` supports `stale:true` / `stale:false` tokens via `search_nodes_with_provenance`.
- **Frontend Experience (`NodeCard.tsx`, `renderer2d.ts`, `NodeContextMenu.tsx`, `CommandPalette.tsx`, `App.tsx`):**
  - `App.tsx` debounces `refreshStaleNodes()` (`250 ms`) on workspace ready / `graphVersion` changes in Tauri runtime and exposes an ambient `⟳ N stale` pill in `.canvas-controls` when stale nodes exist.
  - Stale cards display an amber `STALE` badge (`node-badge--stale`) that opens `.stale-popover` listing exact `Modified` / `Deleted` upstream inputs with **Re-run** (`axiom:rerun-stale`) and **Mark Fresh** (`axiom:ack-stale`) actions; Bird's-Eye LOD (`< 0.45x`) draws an amber indicator dot (`#f59e0b`).

---

## 4. Workspace-Wide FTS5 Search & Local BM25 Related Nodes

- **Multi-Flow Search (`src-tauri/src/ipc/commands.rs::search_workspace_flows`):**
  - Searches the active flow via `state.db` and opens sibling flow `.sqlite` files in read-only mode (`SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`, `busy_timeout = 1000`), ignoring unreadable sibling files gracefully and sorting active flow first then `updated_at DESC`.
  - `CommandPalette.tsx` adds a `This Flow` | `All Flows` toggle (plus `all:` prefix shorthand) and `openFlowAndFocusNode()` in `workspaceCatalogStore.ts` for one-click flow switching and camera centering.
- **Related Nodes Discovery (`src-tauri/src/db/queries.rs::find_related_nodes`, `RelatedNodesPopover.tsx`):**
  - Extracts top 10 non-stopword tokens (`len >= 3`) from the focus node, queries `nodes_fts` via `bm25(nodes_fts, 4.0, 1.0, 2.0) ASC`, and excludes self, direct incoming/outgoing neighbors, and dismissed nodes.
  - `RelatedNodesPopover` offers **Jump** and undoable **Link Ref** (`references` edge) actions in Tauri runtime and a clear desktop-runtime notice in browser preview mode.

---

## 5. Reasoning-Model Compatibility, Flow System Prompts, `tidy_subtree` & Spine Breadcrumb

- **OpenAI Reasoning-Model Profiles (`src-tauri/src/ai/provider.rs`):** `is_reasoning_openai_model` detects `o1`, `o3`, `o4-`, and `gpt-5` models (with or without `provider/` prefix) and `build_openai_compat_body` switches from `max_tokens` + `temperature` to `max_completion_tokens` without `temperature`.
- **Per-Flow System Instructions (`SettingsModal.tsx`, `ai/runner.rs`, `db/queries.rs`):** Persisted in `workspace_meta.system_prompt` and appended under `[FLOW SYSTEM INSTRUCTIONS]` in `PreparedLensRun`.
- **Complete `tidy_subtree` (`src-tauri/src/graph/spatial.rs`):** Now traverses `EdgeType::Synthesizes` in spine BFS and positions incoming `EdgeType::Resolves` mitigation nodes adjacent to their target loopholes without overlapping.
- **Spatial Spine Breadcrumb (`src/overlays/SpineBreadcrumb.tsx`):** Pure `computeSpineBreadcrumb` walks deterministic earliest parents (`created_at ASC`, `id ASC`, cycle-safe) and renders a compact root-to-focus trail in Navigate Mode (`items.length >= 2`) for instant ancestor navigation.

---

## 6. Measured Verification Results (Post-Final-Edit)

- **TypeScript (`npx tsc --noEmit`):** Passed with `0` errors.
- **Vite Production Build (`npm run build`):** `168` modules built in `6.84s`.
- **Vitest (`npm test -- --run`):** **21 test files passed, 63 tests passed** (`0` failed, `0` skipped), including:
  - `src/cards/__tests__/v03CardsAndBreadcrumb.test.tsx` (4 tests): native `research`/`study` tones, `NodeCard` `STALE` popover + `ack`/`rerun` events, `SpineBreadcrumb` cycle safety/truncation/camera pan, `RelatedNodesPopover` browser fallback + mocked Tauri `Link Ref`.
  - `src/overlays/__tests__/v03DiscoveryAndPrompt.test.tsx` (4 tests): `stale:true` filtering, `All Flows` IPC search + `all:` prefix, `SettingsModal` Flow System Instructions persistence, `NodeContextMenu` stale/related actions.
  - `src/canvas/__tests__/stress500.test.ts`: **500 nodes / 700 edges, 120 frames: `p95 drawMs = 5.379 ms`, `avgDrawMs = 3.214 ms`** (measured).
- **Rust Clippy (`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`):** Passed with `0` warnings.
- **Rust Tests (`cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture`):** **50 tests passed** (`0` failed, `0` skipped): `lib.rs` (`9`), `slice1_suite` (`19`), `slice4_suite` (`8`), `slice5_suite` (`3`), `v02_suite` (`5`), `v03_suite` (`6`).

---

## 7. Future Roadmap (v0.4 Candidates)

1. **Custom User Lenses & Prompt Templates:** Store user-defined lens presets (prompt + default node/edge types + icon tone) in `settings.json` and expose them under `@` tags and `A` chord.
2. **Cross-Flow Reference Proxy Nodes:** Allow linking a read-only `Reference` proxy card across flows in the same workspace with BLAKE3 hash-sync indicators.
3. **Interactive Onboarding Tour & Release Packaging Smoke Test:** First-run interactive sample flow (`Engineering` / `Research` / `Study`) + automated Tauri WebView2 smoke test in Windows CI.

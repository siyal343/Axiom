# Axiom v0.5 Architecture & Design Record

**Date:** 2026-11-25  
**Scope:** Schema v3 Migration, Cross-Flow Live Reference Cards (`external_refs`), Named Graph Checkpoints & Structural Diff (`checkpoints`), Subtree Focus Spotlight (`Shift+F`), and Multi-Select Spatial Alignment  
**Status:** Implemented, verified across Rust and TypeScript suites, and built as a release portable executable.

---

## 1. Executive Summary & Ownership Goals

Axiom v0.4 introduced custom user lenses, Tarjan SCC graph health diagnostics, and atomic Markdown outline import. Axiom v0.5 addresses the next three high-value multi-flow and structural workflow gaps while preserving all six invariants in `AGENTS.md`:

1. **Feature 1 — Cross-Flow Live Reference Cards (Schema v3 `external_refs` + Rust Sync Engine):** Link any node from a sibling flow in the active workspace directly onto the current canvas (`+ Link` inside `CommandPalette` `All Flows`). Rust tracks BLAKE3 `synced_hash` drift (`synced` / `out_of_sync` / `source_missing`), supports one-click **Pull Latest** (updating local content and triggering downstream `ai_runs` staleness detection), **Open Source**, and **Detach**.
2. **Feature 2 — Named Graph Checkpoints & Structural Diff (Schema v3 `checkpoints` + `CheckpointsModal`):** Save named graph milestones inside SQLite, inspect field-level structural diffs (`added_nodes`, `removed_nodes`, `modified_nodes`, edge count deltas) with 1-click camera jump, and restore any checkpoint safely after writing an automatic pre-restore backup checkpoint.
3. **Feature 3 — Subtree Focus Spotlight (`Shift+F`) & Multi-Select Spatial Alignment:** Non-destructively dim unrelated branches on both DOM cards and Canvas2D edges/Bird's-Eye cards around the focused node's causal lineage, and align/distribute multi-selected nodes (`Left`, `Top`, `Distribute H`, `Distribute V`) in one undoable batch from `.multi-select-pill`.

---

## 2. Schema v3 Migration (`src-tauri/src/db/migrations.rs`, `json_io.rs`)

- **Fresh & Upgraded Databases (`schema_version = '3'`):**
  - `external_refs(local_node_id PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, source_workspace_id, source_flow_id, source_flow_name, source_db_path, source_node_id, synced_hash, synced_at)`
  - `checkpoints(id PRIMARY KEY, name, note, snapshot_json, node_count, edge_count, created_at)`
- **`migrate_v2_to_v3`:** Runs inside `IMMEDIATE` transaction whenever `schema_version < 3`, creating both additive tables without disturbing existing `nodes`, `edges`, `ai_runs`, or `nodes_fts` data.

---

## 3. Feature 1 — Cross-Flow Live Reference Engine (`src-tauri/src/graph/external_refs.rs`)

- **Pull (`pull_external_reference`):** Opens the sibling flow `.sqlite` read-only (`SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`), places a new local card via `spatial::find_free_position` (optionally linked by a `References` edge to `attach_to_node_id`), persists the card atomically via `apply_ops`, and records the source pointer + `synced_hash` in `external_refs`.
- **Drift Detection (`compute_external_ref_statuses`):** Groups active references by `source_db_path` so each source SQLite file is opened read-only at most once per refresh, returning `synced`, `out_of_sync`, or `source_missing`.
- **Sync & Detach (`sync_external_ref`, `detach_external_ref`):** `sync_external_ref` atomically updates local `title`, `content`, `summary`, `content_hash`, `summary_hash`, `token_count`, and `external_refs.synced_hash` inside one `IMMEDIATE` transaction—causing downstream `ai_runs` referencing the synced node to surface as stale automatically.
- **Workbench UI (`NodeCard.tsx`, `renderer2d.ts`, `CommandPalette.tsx`, `NodeContextMenu.tsx`, `graphStore.ts`):**
  - `CommandPalette` `All Flows` adds a `+ Link` action on hits from sibling flows.
  - Linked cards show `LINKED` / `OUT OF SYNC` / `MISSING` badges opening `.extref-popover` (`Pull Latest`, `Open Source`, `Detach`), and Bird's-Eye LOD (`< 0.45x`) renders a `#06b6d4` indicator dot on out-of-sync cards.

---

## 4. Feature 2 — Named Checkpoints & Structural Diff (`src-tauri/src/graph/checkpoints.rs`)

- **Create & List (`create_checkpoint`, `list_checkpoints`, `delete_checkpoint`):** Serializes sorted `nodes`, `edges`, `system_prompt`, and `token_budget` deterministically into `checkpoints.snapshot_json`.
- **Structural Diff (`diff_checkpoint`):** Compares the saved snapshot against the live `GraphEngine`, producing `added_nodes`, `removed_nodes`, `modified_nodes` (reporting human-readable field deltas across title, content, status, type, `pin_global`, and `exclude_from_ai`), plus `added_edges_count` and `removed_edges_count`.
- **Safe Restore (`restore_checkpoint`):** Automatically saves `"Auto-backup before restore: <name>"` first, bumps `workspace_generation` and cancels active AI runs (`state.bump_generation_and_cancel_runs()`), replaces `edges`/`nodes`/`workspace_meta` and rebuilds `nodes_fts` inside one `IMMEDIATE` transaction, and returns the hydrated `WorkspaceSnapshot`.
- **Workbench UI (`src/overlays/CheckpointsModal.tsx`, `keymap.ts` `Shift+S`):** Save milestones, inspect diffs with 1-click **Jump** to any added/modified node, restore with automatic backup, or delete checkpoints.

---

## 5. Feature 3 — Focus Spotlight & Multi-Select Alignment

- **Causal Lineage Spotlight (`src/input/topologyNav.ts::collectSpotlightIds`, `Shift+F`, `NodeCard.tsx`, `renderer2d.ts`):**
  - Collects the focused node, cycle-safe backward spine ancestors (`derives`, `branches`, `synthesizes`), forward subtree descendants, and 1-hop `challenges`/`resolves`/`references` neighbors.
  - Unrelated DOM cards receive `.node-card--spotlight-dim`, unrelated Canvas2D edges dim to `0.18` alpha, and Bird's-Eye cards outside the set dim to `0.22` alpha (exempting active X-Ray).
- **Multi-Select Spatial Alignment (`src/input/topologyNav.ts::computeAlignmentMoves`, `App.tsx`):**
  - Adds undoable **Left (`L`)**, **Top (`T`)**, **Distribute Horizontal (`H`, 3+ nodes)**, and **Distribute Vertical (`V`, 3+ nodes)** controls to the camera-synced `.multi-select-pill`.

---

## 6. Measured Verification Results (Post-Final-Edit)

- **TypeScript (`npx tsc --noEmit`):** Passed with `0` errors.
- **Vite Production Build (`npm run build`):** `171` modules built in `7.34s`.
- **Vitest (`npm test -- --run`):** **25 test files passed, 77 tests passed** (`0` failed, `0` skipped, `0` unhandled errors), including:
  - `src/overlays/__tests__/v05CheckpointsAndSpotlight.test.tsx` (4 tests): `collectSpotlightIds`, `computeAlignmentMoves`, `NodeCard` external ref badges/spotlight dimming + `renderer2d` Bird's-Eye dot, and `CheckpointsModal` lifecycle.
  - `src/overlays/__tests__/v05CrossFlowAndAlign.test.tsx` (3 tests): `CommandPalette` `All Flows` `+ Link`, `Shift+F` / `Shift+S` / `Esc` keymap routing, and `NodeContextMenu` external-ref actions.
  - `src/canvas/__tests__/stress500.test.ts`: **500 nodes / 700 edges, 120 frames: `p95 drawMs = 7.139 ms`, `avgDrawMs = 3.169 ms`** (measured).
- **Rust Clippy (`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`):** Passed with `0` warnings.
- **Rust Tests (`cargo test --manifest-path src-tauri/Cargo.toml`):** **57 tests passed** (`0` failed, `0` skipped): `lib.rs` (`9`), `slice1_suite` (`19`), `slice4_suite` (`8`), `slice5_suite` (`3`), `v02_suite` (`5`), `v03_suite` (`6`), `v04_suite` (`4`), `v05_suite` (`3`).

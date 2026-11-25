# Axiom v0.6 Architecture & Design Record

**Date:** 2026-11-26  
**Scope:** Canvas2D Theme Palette Synchronization Fix, SM-2 Study & Active Recall Studio (`study_cards`, `graph::study`, `StudyDeckModal`), Spatial Canvas Groups / Regions (`canvas_groups`, `CanvasGroupDto`, `[GROUP: ...]` context annotations), and Schema v4 Migration  
**Status:** Implemented in source and test suites; verification gates pending execution (see Section 6).

---

## 1. Executive Summary & v0.6 Goals

Axiom v0.5 introduced cross-flow live reference cards, named graph checkpoints with structural diffs, focus spotlight, and multi-select spatial alignment. Axiom v0.6 resolves a Canvas2D theme synchronization bug and delivers two major study and spatial organization workflows while preserving all six architectural invariants in `AGENTS.md`:

1. **Bugfix — Canvas2D Theme Palette Synchronization (`src/canvas/renderer2d.ts`, `src/store/graphStore.ts`, `src/styles/theme.css`):** Ensures `getPalette(themeKey)` checks and reconciles the DOM `data-theme` attribute before reading CSS custom properties, keeps `setTheme` synchronous with DOM updates, and aligns `:root` / `[data-theme]` `color-scheme` declarations.
2. **Feature 1 — SM-2 Study & Active Recall Studio (Schema v4 `study_cards` + `graph::study` + `StudyDeckModal`):** Extracts recall cards automatically from `@study` (`Q:`/`A:` or fallback), `@feynman`, and unresolved `challenges` loopholes while preserving SM-2 scheduling state across syncs, supports manual flashcards, exposes 5 Tauri IPC commands with a browser `localStorage` fallback, and provides an accessible `<dialog closedby="any">` review studio (`Shift+Q`) with KaTeX/code rendering and keyboard grading (`1`–`4`).
3. **Feature 2 — Spatial Canvas Groups / Regions (Schema v4 `canvas_groups` + `GraphOp` + `[GROUP: ...]` Context Compiler Annotations):** Groups multi-selected nodes (`G` or `.multi-select-pill`) into named, color-coded spatial regions rendered on Canvas2D with an `O(1)` empty skip, supports 60–120 FPS multi-node header dragging without Preact re-renders, annotates grouped nodes with `[GROUP: <Title>]` in `compiler::compile_context`, and preserves backwards compatibility across JSON export/import and checkpoints.

---

## 2. Canvas2D Theme Palette Synchronization Fix

In prior builds, switching themes could leave Canvas2D reading stale CSS variables if `getComputedStyle(document.documentElement)` ran before `document.documentElement` received the updated `data-theme` attribute.

- **Synchronous `getPalette(themeKey)` Guard (`src/canvas/renderer2d.ts`):**
  - Reads `document.documentElement.getAttribute("data-theme")`.
  - When `domTheme !== themeKey` (`themeMismatch`), writes `document.documentElement.setAttribute("data-theme", themeKey)` immediately and bypasses `cachedPalette` so `getComputedStyle(document.documentElement)` resolves the active theme tokens on the same frame.
  - Caches `ThemePalette` under `(cachedPaletteKey, cachedPalette)` only when `cachedPaletteKey === themeKey && !themeMismatch`.
- **Synchronous `setTheme(nextTheme)` (`src/store/graphStore.ts`):**
  - Updates `theme.value = nextTheme`, synchronously applies `document.documentElement.setAttribute("data-theme", nextTheme)`, and calls `cameraControllerRef.current?.markDirty()`.
- **CSS `color-scheme` & Group Palette Tokens (`src/styles/theme.css`):**
  - `:root, [data-theme="dark"]` declares `color-scheme: dark;` and defines `--group-cobalt`, `--group-emerald`, `--group-amber`, `--group-rose`, `--group-violet`, and `--group-slate`.
  - `[data-theme="light"]` declares `color-scheme: light;` alongside light-mode counterparts for all six `--group-*` tokens, read by `getPalette(themeKey)` into `ThemePalette`.

---

## 3. Feature 1 — SM-2 Study & Active Recall Studio

### 3.1 Schema v4 `study_cards` Table (`src-tauri/src/db/migrations.rs`)

- **Table `study_cards`:** `id TEXT PRIMARY KEY NOT NULL`, `node_id TEXT` (`FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE`), `prompt TEXT NOT NULL`, `answer TEXT NOT NULL`, `card_kind TEXT NOT NULL DEFAULT 'qa' CHECK(card_kind IN ('qa','feynman','loophole','manual'))`, `repetitions INTEGER NOT NULL DEFAULT 0`, `interval_days INTEGER NOT NULL DEFAULT 0`, `ease_factor REAL NOT NULL DEFAULT 2.5`, `lapses INTEGER NOT NULL DEFAULT 0`, `due_at INTEGER NOT NULL`, `last_reviewed_at INTEGER`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`.
- **Indexes:** `idx_study_cards_due_at` on `study_cards(due_at)` and `idx_study_cards_node_id` on `study_cards(node_id)`.

### 3.2 Rust SM-2 Engine & Candidate Extraction (`src-tauri/src/graph/study.rs`, `models.rs`)

- **Models (`models.rs`):** `StudyRating` (`again`, `hard`, `good`, `easy`), `StudyCardKind` (`qa`, `feynman`, `loophole`, `manual`), `StudyCardDto`, and `StudySyncResult { cards, added_count }`.
- **SM-2 Scheduling (`apply_sm2_review`):**
  - **`Again`:** Resets `repetitions = 0` and `interval_days = 0`, increments `lapses`, reduces `ease_factor` by `0.2` (floor `1.3`), and sets `due_at = now_ms + 60_000` (`MS_PER_MINUTE`).
  - **`Hard`:** Sets `interval_days` to `1` (`rep == 0`), `3` (`rep == 1`), or `round(interval_days * 1.2).max(1)` (`rep >= 2`), increments `repetitions`, reduces `ease_factor` by `0.15` (floor `1.3`), and advances `due_at` by `interval_days * 86_400_000` (`MS_PER_DAY`).
  - **`Good`:** Sets `interval_days` to `1` (`rep == 0`), `6` (`rep == 1`), or `round(interval_days * ease_factor).max(1)` (`rep >= 2`), increments `repetitions`, keeps `ease_factor` unchanged, and advances `due_at` by `interval_days * MS_PER_DAY`.
  - **`Easy`:** Sets `interval_days` to `4` (`rep == 0`) or `round(interval_days * ease_factor * 1.3).max(1)` (`rep >= 1`), increments `repetitions`, increases `ease_factor` by `0.15` (cap `3.5`), and advances `due_at` by `interval_days * MS_PER_DAY`.
- **Candidate Extraction (`extract_study_candidates`):** Iterates `engine.all_nodes_sorted()`, skipping `NodeStatus::Dismissed` nodes and placeholder content (`""`, `"thinking..."`, `"thinking…"`, `"..."`, `"todo"`):
  - **`qa`:** Matches nodes with `@study` (in `title` or `content`) or `metadata.lens == NodeLensOrigin::Study`. `parse_qa_blocks` extracts `Q:` / `A:` and `Question:` / `Answer:` blocks (including Markdown bold/underline markers and inline `— A:` separators, combining multiple pairs into numbered lists), or falls back to `(title, content)` when `title` is non-empty.
  - **`feynman`:** Matches nodes with `@feynman` or `metadata.lens == NodeLensOrigin::Feynman` whose `content` has at least `15` characters and non-placeholder `title`, generating prompt `"Explain from first principles: <title>"`.
  - **`loophole`:** For any node with non-empty `title`, inspects incoming `challenges` edges from `active` loophole nodes (sorted by severity `critical > high > medium > low`, then `id ASC`), formats up to `3` loopholes (`format_loophole_answer`, 180-char excerpt of `summary` or `content`), and emits prompt `"What failure mode or loophole threatens \"<title>\"?"`.
- **Non-Destructive Sync (`sync_study_deck`):**
  - Runs inside `TransactionBehavior::Immediate`.
  - Preserves `manual` cards and preserves existing `repetitions`, `interval_days`, `ease_factor`, `lapses`, `due_at`, and `last_reviewed_at` on matched `(node_id, card_kind)` cards while refreshing `prompt` and `answer` when source text changes.
  - Deletes `loophole` cards whose target node no longer has active incoming `challenges` edges.

### 3.3 IPC Commands, Browser Fallback & Studio UI

- **Tauri IPC (`src-tauri/src/ipc/commands.rs`, `src-tauri/src/lib.rs`, `src/ipc/client.ts`):** `sync_study_deck`, `list_study_cards`, `create_study_card`, `review_study_card`, and `delete_study_card`.
- **Frontend Store (`src/store/studyStore.ts`):** Mirrors SM-2 (`applySm2ReviewLocal`) and extraction (`extractStudyCandidatesLocal`) for non-Tauri browser execution, persisting cards per active flow under `localStorage` key `"axiom_study_cards_v1_<scopeId>"` with an in-memory `Map` fallback (`memoryStudyStorage`). Exposes reactive `studyCards`, `studyModalOpen`, `studyScope` (`"due" | "flow" | "subtree"`), `studyLoading`, `studyFocusNodeId`, `studyCreateFormOpen`, and computed `dueStudyCount`.
- **Modal UX & Entry Points (`src/overlays/StudyDeckModal.tsx`, `src/input/keymap.ts`, `src/App.tsx`, `src/overlays/NodeContextMenu.tsx`, `src/overlays/CommandPalette.tsx`):**
  - Uses native `<dialog class="study-dialog" closedby="any" aria-labelledby="study-dialog-title">` with a pointer-outside light-dismiss fallback when `"closedBy" in HTMLDialogElement.prototype` is unavailable.
  - Renders Markdown, fenced code blocks, and KaTeX math through `renderMarkdownToSanitizedHtml` (DOMPurify-sanitized) on both prompt and revealed answer faces.
  - Keyboard controls inside the modal: `Space` or `Enter` reveals the answer, `1`–`4` grades `Again` / `Hard` / `Good` / `Easy` (showing `formatIntervalPreview` durations), `J` jumps to `activeCard.node_id` and animates the camera (`clampZoom(Math.max(cam.zoom, 0.85))`), and `Esc` closes the dialog.
  - Entry points: `Shift+Q` in Navigate Mode, **Study** button in `.canvas-controls` with live `.study-due-pill` due badge, **Add Study Card** and **Study Deck (`Shift+Q`)** in `NodeContextMenu`, and **> Study & Recall Drill (Shift+Q)** in `CommandPalette`.

---

## 4. Feature 2 — Spatial Canvas Groups / Regions

### 4.1 Schema v4 `canvas_groups` & Rust Engine (`migrations.rs`, `models.rs`, `graph/mod.rs`, `db/queries.rs`)

- **Table `canvas_groups`:** `id TEXT PRIMARY KEY NOT NULL`, `title TEXT NOT NULL`, `color_key TEXT NOT NULL DEFAULT 'cobalt'`, `member_ids TEXT NOT NULL DEFAULT '[]'` (JSON array), `collapsed INTEGER NOT NULL DEFAULT 0`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`.
- **Models & Ops (`models.rs`, `src/ipc/types.ts`):** `CanvasGroupDto` and three `GraphOp` variants:
  - `CreateGroup { id, title, color_key, member_ids }`
  - `UpdateGroup { id, title, color_key, member_ids, collapsed }`
  - `DeleteGroup { id }`
- **Atomic Persistence & Pruning (`db/queries.rs`, `graph/mod.rs`, `src/store/graphStore.ts`, `src/store/history.ts`):**
  - `apply_ops` executes `CreateGroup`, `UpdateGroup`, and `DeleteGroup` inside the same `IMMEDIATE` transaction as node/edge edits, updating `GraphEngine.groups` only after `tx.commit()` succeeds.
  - `GraphOp::DeleteNodes` automatically prunes deleted node IDs from `canvas_groups.member_ids` in SQLite, `GraphEngine::remove_node`, and `pruneDeletedNodesFromGroups` in TypeScript.
  - `src/store/history.ts` supplies `buildCreateGroupWithInverse`, `buildUpdateGroupWithInverse`, `buildDeleteGroupWithInverse`, and captures `restoreGroupOps` in `buildDeleteWithInverse` so deleting a grouped node and pressing `Ctrl/Cmd+Z` restores both the node and its group membership.

### 4.2 Canvas2D Rendering & 60–120 FPS Header Drag (`renderer2d.ts`, `pointer.ts`)

- **O(1) Empty Skip & Bounds (`src/canvas/renderer2d.ts`):**
  - Pass `2.5` in `renderCanvas2d` checks `groupCount > 0` before iterating, preserving the 500-node render budget when no groups exist.
  - `computeGroupBounds(group, sceneRects)` wraps live member rectangles (accounting for `dragOffsets` and `resizeSizes`) with `GROUP_PADDING = 26` and `GROUP_TOP_HEADER = 38`, culls off-screen groups against `minEdgeVx..maxEdgeVy`, draws the tinted dashed/solid rounded region, and draws the header chip `<title> · <memberCount>` when `cam.zoom >= 0.2`.
  - `hitTestGroupHeader(scenePoint, groups, sceneRects, zoom)` tests the top header band in reverse order (topmost group first) with a zoom-scaled vertical tolerance (`padY = Math.min(10, 4 / Math.max(0.25, zoom))`).
- **Decoupled Group Dragging (`src/canvas/pointer.ts`):**
  - Hovering a group header sets `hoveredGroupId` and switches the cursor to `grab`.
  - Clicking a group header selects all live member nodes, sets `selectedGroupId`, and starts a `node_drag` gesture with `groupId: hitGroup.id`.
  - Dragging moves every member card via `dragOffsets` and `applyDragDomTransforms()` (`style.transform = translate3d(...)`) directly in DOM refs at 60–120 FPS with zero Preact re-renders, committing one `"Move group"` undoable `move_nodes` entry and running `resolveAndAnimateOverlaps`.

### 4.3 Context Compiler Integration & Workbench Controls

- **Context Compiler (`src-tauri/src/graph/compiler.rs`):**
  - `group_annotation(engine, node_id)` appends sorted, deduplicated ` [GROUP: <Title1>, <Title2>]` suffixes to node headings across `[GLOBAL CONSTRAINTS]`, `[BACKGROUND ANCESTORS]`, `[DIRECT PARENTS & INPUTS]`, `[UNRESOLVED LOOPHOLES]`, `[REFERENCED CONTEXT]`, and `[FOCUS NODE]`.
  - Both `compile_xray` (`Hold V`) and `run_lens` call `compile_context()`, ensuring identical group awareness between X-Ray previews and live AI prompts.
- **Workbench Controls (`src/App.tsx`, `src/input/keymap.ts`, `src/overlays/CommandPalette.tsx`):**
  - Press `G` with 2+ nodes selected, click **Group (G)** in `.multi-select-pill`, or run **> Group Selected Nodes (G)** in `CommandPalette`.
  - Selecting a group displays `.group-inspector-pill` with an inline title `<input>`, six color swatches (`cobalt`, `emerald`, `amber`, `rose`, `violet`, `slate`), **Add / Sync Selection** (when `selectedIds` differs from `member_ids`), and **Ungroup**.

### 4.4 Schema v4 JSON Export/Import & Checkpoints Compatibility (`json_io.rs`, `checkpoints.rs`)

- **`AxiomWorkspaceJson` (`src-tauri/src/db/json_io.rs`):** Adds `#[serde(default)] pub groups: Vec<CanvasGroupDto>` and `#[serde(default)] pub study_cards: Vec<StudyCardDto>`, keeping `version = 1` and `format = "axiom-workspace"` so legacy v3 JSON exports without those fields deserialize and import cleanly.
- **`CheckpointPayload` (`src-tauri/src/graph/checkpoints.rs`):** Adds `#[serde(default)] pub groups: Vec<CanvasGroupDto>` so checkpoints created on v4 persist and restore `canvas_groups` alongside nodes and edges while v3 checkpoints restore with `groups = []`.

---

## 5. Schema v4 Summary (`src-tauri/src/db/migrations.rs`)

- `migrate_v3_to_v4` runs inside `BEGIN IMMEDIATE` when `schema_version < 4`:
  - Creates `study_cards`, `idx_study_cards_due_at`, and `idx_study_cards_node_id`.
  - Creates `canvas_groups`.
  - Sets `workspace_meta.schema_version = '4'`.

---

## 6. Verification Checklist & Status

### Statically Implemented Automated Tests
- **Rust Integration Suite (`src-tauri/tests/v06_suite.rs`, 5 tests implemented):**
  1. `v3_to_v4_migration_preserves_data_and_creates_study_cards_and_canvas_groups`: Verifies v3-to-v4 migration, `schema_version = '4'`, `study_cards`/`canvas_groups` tables and indexes, `nodes_fts` preservation, and snapshot hydration.
  2. `canvas_groups_crud_delete_nodes_pruning_checkpoints_and_json_roundtrip`: Verifies `CreateGroup`/`UpdateGroup`/`DeleteGroup`, `DeleteNodes` group member pruning, checkpoint restore of groups, Schema v4 JSON roundtrip (including `study_cards`), and legacy v3 JSON import compatibility.
  3. `compiler_annotates_grouped_nodes_with_group_titles`: Verifies deterministic `[GROUP: ...]` header annotations in `compile_context`.
  4. `sm2_scheduler_intervals_and_bounds_for_all_ratings`: Verifies `Again`/`Hard`/`Good`/`Easy` intervals, `lapses`, and `ease_factor` `[1.3, 3.5]` bounds.
  5. `extract_and_sync_study_deck_preserves_sm2_and_cleans_resolved_loopholes`: Verifies `@study` Q:/A: (single & numbered quiz), `@study` fallback, placeholder skipping, `@feynman` 15-char threshold, active loophole extraction, `sync_study_deck` SM-2 state preservation on edits, resolved loophole pruning, `due_only` filtering, and manual card deletion.
- **TypeScript / Preact Suite (`src/overlays/__tests__/v06StudyAndGroups.test.tsx`, 5 tests implemented):**
  1. `applySm2ReviewLocal` intervals and ease bounds for `again`, `hard`, `good`, and `easy`.
  2. `syncStudyDeckAction` extraction (`@study` Q:/A:, `@feynman`, active `challenges` loophole) and pruning when loopholes resolve.
  3. `StudyDeckModal` `<dialog closedby="any">` attributes, KaTeX answer reveal, `Good` grading update, and `J`/button jump-to-node camera animation.
  4. `computeGroupBounds`, `hitTestGroupHeader`, `createCanvasGroup`, `updateCanvasGroup`, `buildDeleteWithInverse` pruning, `performUndo` restoration, and `deleteCanvasGroup`.
  5. `getPalette` `data-theme` synchronization, `setTheme` DOM update + `markDirty`, and Canvas2D group rendering (`Replication · 2`).

### CI / Live Verification Gates Pending Execution
The following verification commands were **not** executed during this documentation pass and remain pending CI / release-gate execution:
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] `npm test -- --run` (Vitest)
- [ ] `npx tsc --noEmit`
- [ ] `npm run build`
- [ ] 500-node stress benchmark (`src/canvas/__tests__/stress500.test.ts`) confirming zero regression with `O(1)` empty-group skip

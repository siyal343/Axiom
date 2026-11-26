# Axiom v0.6 Architecture & Design Record

**Date:** 2026-11-26  
**Scope:** Canvas2D Theme Palette Synchronization Fix, SM-2 Study & Active Recall Studio (`study_cards`, `graph::study`, `StudyDeckModal`), Spatial Canvas Groups / Regions (`canvas_groups`, `CanvasGroupDto`, `[GROUP: ...]` context annotations), Schema v4 Migration, v0.6.1 UI/UX Polish, and v0.6.2 Undergraduate Study Mode Polish  
**Status:** Implemented in source and test suites; CI & live browser verification gates pending execution (see Section 8).

---

## 1. Executive Summary & v0.6 Goals

Axiom v0.5 introduced cross-flow live reference cards, named graph checkpoints with structural diffs, focus spotlight, and multi-select spatial alignment. Axiom v0.6 resolves a Canvas2D theme synchronization bug and delivers two major study and spatial organization workflows while preserving all six architectural invariants in `AGENTS.md`:

1. **Bugfix — Canvas2D Theme Palette Synchronization (`src/canvas/renderer2d.ts`, `src/store/graphStore.ts`, `src/styles/theme.css`):** Ensures `getPalette(themeKey)` checks and reconciles the DOM `data-theme` attribute before reading CSS custom properties, keeps `setTheme` synchronous with DOM updates, and aligns `:root` / `[data-theme]` `color-scheme` declarations.
2. **Feature 1 — SM-2 Study & Active Recall Studio (Schema v4 `study_cards` + `graph::study` + `StudyDeckModal`):** Extracts recall cards automatically from `@study` (`Q:`/`A:` or fallback), `@feynman`, and unresolved `challenges` loopholes while preserving SM-2 scheduling state across syncs and inline edits, supports manual flashcards, exposes 6 Tauri IPC commands with a browser `localStorage` fallback, and provides an accessible `<dialog closedby="any">` review studio (`Shift+Q`) with KaTeX/code rendering, closed-book attempt comparison, non-spoiling hints, interleaving, and keyboard grading (`1`–`4`).
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

- **Tauri IPC (`src-tauri/src/ipc/commands.rs`, `src-tauri/src/lib.rs`, `src/ipc/client.ts`):** `sync_study_deck`, `list_study_cards`, `create_study_card`, `review_study_card`, `update_study_card`, and `delete_study_card`.
- **Frontend Store (`src/store/studyStore.ts`):** Mirrors SM-2 (`applySm2ReviewLocal`) and extraction (`extractStudyCandidatesLocal`) for non-Tauri browser execution, persisting cards per active flow under `localStorage` key `"axiom_study_cards_v1_<scopeId>"` with an in-memory `Map` fallback (`memoryStudyStorage`). Exposes reactive `studyCards`, `studyModalOpen`, `studyScope` (`"due" | "flow" | "subtree"`), `studyLoading`, `studyFocusNodeId`, `studyCreateFormOpen`, and computed `dueStudyCount`.
- **Modal UX & Entry Points (`src/overlays/StudyDeckModal.tsx`, `src/input/keymap.ts`, `src/App.tsx`, `src/overlays/NodeContextMenu.tsx`, `src/overlays/CommandPalette.tsx`):**
  - Uses native `<dialog class="study-dialog" closedby="any" aria-labelledby="study-dialog-title">` with a pointer-outside light-dismiss fallback when `"closedBy" in HTMLDialogElement.prototype` is unavailable.
  - Renders Markdown, fenced code blocks, and KaTeX math through `renderMarkdownToSanitizedHtml` (DOMPurify-sanitized) on both prompt and revealed answer faces.
  - In the empty state (`!activeCard && !loading`), hides the header **+ New Card** button so **+ Create Flashcard** is the single empty-state CTA; pressing `Esc` closes an open `studyCreateFormOpen` draft form first before closing the dialog.
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
  - `computeGroupBounds(group, sceneRects)` wraps live member rectangles (accounting for `dragOffsets` and `resizeSizes`) with `GROUP_PADDING = 26` and `GROUP_TOP_HEADER = 38`, culls off-screen groups against `minEdgeVx..maxEdgeVy`, draws the tinted dashed/solid rounded region, and positions the header chip `<title> · <memberCount>` via `resolveGroupChipRect` (cascading colliding chips horizontally within `maxRightX`, or stepping upward when constrained) when `cam.zoom >= 0.2`.
  - `hitTestGroupHeader(scenePoint, groups, sceneRects, zoom)` runs `resolveGroupChipRect` in the same order and tests cascaded chip rectangles first before testing header bands in reverse order (topmost group first) with zoom-scaled tolerances (`padX = Math.min(8, 3 / Math.max(0.25, zoom))`, `padY = Math.min(10, 4 / Math.max(0.25, zoom))`).
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
- **`CheckpointPayload` (`src-tauri/src/graph/checkpoints.rs`):**
  - Adds `#[serde(default)] pub groups: Vec<CanvasGroupDto>` and `#[serde(default)] pub study_cards: Vec<StudyCardDto>` (populated via `db_list_study_cards(conn, None)` during `create_checkpoint`).
  - During `restore_checkpoint`, clears `study_cards`, `canvas_groups`, `edges`, and `nodes` inside `TransactionBehavior::Immediate`, tracks `restored_node_ids`, and restores each `StudyCardDto` via `insert_study_card_tx` whenever `card.node_id` is `None` (standalone) or present in `restored_node_ids`. Legacy pre-v4 or pre-study checkpoints deserialize cleanly with `groups = []` and `study_cards = []`.

---

## 5. Schema v4 Summary (`src-tauri/src/db/migrations.rs`)

- `migrate_v3_to_v4` runs inside `BEGIN IMMEDIATE` when `schema_version < 4`:
  - Creates `study_cards`, `idx_study_cards_due_at`, and `idx_study_cards_node_id`.
  - Creates `canvas_groups`.
  - Sets `workspace_meta.schema_version = '4'`.

---

## 6. v0.6.1 UX & UI Polish Pass Summary

A follow-up UI/UX de-bloating, spatial clamping, and accessibility pass (detailed in [UI-UX-AUDIT.md](UI-UX-AUDIT.md#L164)) refined the v0.6 surfaces without altering backend invariants:

- **3-Tab `SettingsModal` (`src/overlays/SettingsModal.tsx`, `src/store/aiRunner.ts`):** Organizes settings into **General** (`"general"`), **Providers & Models** (`"providers"`), and **Prompt & Lenses** (`"prompt_lenses"`) via `settingsActiveTab` and `openSettingsModal(tab?)`.
- **Modal Focus Trapping (`src/overlays/useDialogFocusTrap.ts`):** Traps `Tab` / `Shift+Tab` inside `SettingsModal`, `ArtifactExportModal`, `CheckpointsModal`, `DiagnosticsModal`, `OutlineImportModal`, and `ShortcutsModal`, suppresses outer `dialog:focus` / `[role="dialog"]:focus` / `.settings-modal:focus` rings, and restores trigger focus on close.
- **Chrome Consolidation & Spatial Clamping:** Compacts `NodeContextMenu` (`288px` 2-column action/lens grids + horizontal `Type`/`Severity` chips), hides `.sidebar-toggle-bar` via `.sidebar-toggle-bar--hidden` while the sidebar is open, deduplicates `CommandPalette` / `StudyDeckModal` actions, right-aligns `.hover-pill`, clamps `.multi-select-pill` / `.edge-popover` / `.edge-inspector-pill` against measured bounds, raises bottom pills to `68px`, lifts `ToastStack` via `.toast-stack--above-minimap`, fits `.minimap-card__canvas` (`box-sizing: border-box`), reserves `78px` bottom clearance on `.live-editor-overlay`, and aligns `.spine-breadcrumb__crumb`, `6px` thin scrollbars, `--text-on-accent`, and double-click `onDblClick` hit-testing.

---

## 7. Study Mode Polish (v0.6.2 — Undergraduate Engineering Mastery)

A targeted study workflow upgrade in v0.6.2 aligns Axiom's AI lenses, flow templates, card editing, and `StudyDeckModal` recall loop with closed-book undergraduate engineering mastery:

### 7.1 Upgraded `LENS_FEYNMAN` and `LENS_STUDY` Prompts (`src-tauri/src/ai/prompts.rs`, `src/input/actionTags.ts`)

- **`LENS_FEYNMAN` (`@@NODE type=probe edge=derives title="First Principles: <core concept>"`):** Replaces surface definitions with a five-part first-principles structure:
  1. **Causal Mechanism:** 3–4 sentences grounded in physical or computational constraints explaining *why* the mechanism behaves as it does.
  2. **Governing Rule / Relation:** Key equation, invariant, or complexity bound in KaTeX with every variable and physical/SI/computational unit defined.
  3. **Assumptions & Breakdown Limits:** Explicit approximations and the operating regime where the model holds versus fails (steady vs. transient, linear vs. saturated, $O(\cdot)$, SNR, stress, Reynolds, or bandwidth limits).
  4. **Concrete Walkthrough:** Tiny numerical or state-transition worked example with units.
  5. **Common Trap:** Top misconception or sign/unit/regime error.
- **`LENS_STUDY` (`@@NODE type=probe edge=derives title="Study & Recall: <core topic>"`):** Produces a closed-book engineering mastery sheet with four sections:
  1. **Core Intuition:** 2–3 sentence physical or mathematical explanation without jargon.
  2. **Governing Equations, Units & Validity Regime:** KaTeX relations (`$...$` / `$$...$$`) with variable legend, physical/SI/computational units, and explicit boundary/regime assumptions.
  3. **Worked Example (Setup → Solve → Sanity Check):** Given quantities with units and verified assumptions (`Setup`), step-by-step algebra or state trace (`Solve`), and a dimensional-analysis or limiting-case verification (`Sanity Check`).
  4. **Active-Recall Quiz:** Three numbered `**Q:** ... — **A:** ...` items testing boundary-condition/assumption traps, problem setup or derivation steps, and interleaved principle discrimination across competing laws or models.
- **`ACTION_TAGS` (`src/input/actionTags.ts`):** Updates `@feynman` (`"Deconstruct first principles, units, regime limits, and traps"`) and `@study` (`"Build intuition, worked checks, and active-recall quizzes"`) descriptions to match the upgraded lenses.

### 7.2 Actionable `"study"` Flow Template & Fence-Safe Content Tag Matching

- **Actionable `"study"` Template (`src-tauri/src/db/mod.rs::seed_flow_template`, `src/store/workspaceCatalogStore.ts::buildTemplateSnapshot`):** Seeds three connected cards (`Topic to Master` -> `derives` -> `First-Principles Breakdown` and `Active Recall Questions`):
  - `Topic to Master` (`core`) prompts the student to record knowns/unknowns with units and assumptions and includes a prose tip mentioning `@feynman` and `@study`.
  - `First-Principles Breakdown` (`probe`) begins with `@feynman First principles & boundary limits: ...` (`>= 15` chars), immediately extracting a `feynman` card.
  - `Active Recall Questions` (`probe`) begins with `@study` and an engineering assumption-check `**Q:** ... — **A:** ...` item, immediately extracting a `qa` card (`2` starter flashcards on initial `sync_study_deck`).
- **Line-Start Non-Fenced Content Matching (`src-tauri/src/graph/study.rs::has_content_tag`, `src/store/studyStore.ts::hasContentTag`):** While `has_tag` / `hasTag` continues matching tag tokens in `title`, `has_content_tag` / `hasContentTag` scans `content` line by line outside ```` ``` ```` and `~~~` fenced code blocks and matches `@study` / `@feynman` only when a trimmed line starts with the tag followed by end-of-line, whitespace, or `:`. Inline prose mentions (such as the tip inside `Topic to Master`) no longer spawn spurious flashcards.

### 7.3 SM-2-Preserving Inline Card Editing (`update_study_card`)

- **Rust Backend (`src-tauri/src/graph/study.rs::update_study_card`, `src-tauri/src/db/queries.rs::update_study_card_text_tx`, `src-tauri/src/ipc/commands.rs::update_study_card`, `src-tauri/src/lib.rs`):** Trims `card_id`, `prompt`, and `answer`, rejects blank inputs or missing card IDs with `IpcErrorCode::ValidationError`, and updates only `prompt`, `answer`, and `updated_at` inside `TransactionBehavior::Immediate` so `repetitions`, `interval_days`, `ease_factor`, `lapses`, `due_at`, and `last_reviewed_at` remain intact.
- **TypeScript IPC & Store (`src/ipc/client.ts::updateStudyCard`, `src/store/studyStore.ts::updateStudyCardAction`):** Mirrors blank validation, invokes `update_study_card` under Tauri, and updates `localStorage` / `memoryStudyStorage` in browser fallback mode while preserving SM-2 state.

### 7.4 `StudyDeckModal` Closed-Book Active Recall Loop (`src/overlays/StudyDeckModal.tsx`, `src/store/studyStore.ts`, `src/overlays/ShortcutsModal.tsx`)

- **Closed-Book Attempt Comparison (`A` / **Write attempt**):** Toggles and auto-focuses `#study-attempt-textarea` before reveal; when non-empty on reveal, renders **Your Closed-Book Attempt** (`.study-card-face--attempt`) directly above the **Answer** face for self-comparison.
- **Non-Spoiling Hint (`H` / **Hint** via `extractHintFromAnswer`):** Strips Markdown bold/underline/backtick markers, formats multi-item numbered answers as `1/<N>: <clue>...`, caps short single-line answers at ~45% length (minimum `10` chars) and longer lines at `72` chars, and backs off before unbalanced `$` delimiters so KaTeX spans remain intact and unspoiled.
- **Interleaved Drill (`Interleave` via `interleaveStudyCards`):** Uses a deterministic seeded PRNG (`createSeededRng`) plus greedy reordering so consecutive cards avoid matching on both `node_id` and `card_kind` when alternatives exist.
- **Inline Edit (`E` / **Edit**):** Opens the form prefilled with the active card's `prompt` and `answer`, labels it `Preserves SM-2`, and commits through `updateStudyCardAction`.
- **Live Scope Counts & Ephemeral Session Progress:** Scope tabs display live totals (`Due Now (<n>)`, `Current Flow (<n>)`, `Focused Subtree (<n>)`), `.study-queue-breakdown` shows `<dueInScopeCount> due · <allCards.length> in flow`, and `sessionStats` tracks ephemeral `reviewed`, `strong` (`hard`/`good`/`easy`), and `again` counts per modal session. `ShortcutsModal` documents the study loop (`Space / H / A / E / 1–4`).

---

## 8. Verification Checklist & Status

### Statically Implemented Automated Tests
- **Rust Integration Suite (`src-tauri/tests/v06_suite.rs`, 7 tests implemented):**
  1. `v3_to_v4_migration_preserves_data_and_creates_study_cards_and_canvas_groups`: Verifies v3-to-v4 migration, `schema_version = '4'`, `study_cards`/`canvas_groups` tables and indexes, `nodes_fts` preservation, and snapshot hydration.
  2. `canvas_groups_crud_delete_nodes_pruning_checkpoints_and_json_roundtrip`: Verifies `CreateGroup`/`UpdateGroup`/`DeleteGroup`, `DeleteNodes` group member pruning, checkpoint restore of groups, Schema v4 JSON roundtrip (including `study_cards`), and legacy v3 JSON import compatibility.
  3. `compiler_annotates_grouped_nodes_with_group_titles`: Verifies deterministic `[GROUP: ...]` header annotations in `compile_context`.
  4. `sm2_scheduler_intervals_and_bounds_for_all_ratings`: Verifies `Again`/`Hard`/`Good`/`Easy` intervals, `lapses`, and `ease_factor` `[1.3, 3.5]` bounds.
  5. `extract_and_sync_study_deck_preserves_sm2_and_cleans_resolved_loopholes`: Verifies `@study` Q:/A: (single & numbered quiz), `@study` fallback, placeholder skipping, `@feynman` 15-char threshold, active loophole extraction, `sync_study_deck` SM-2 state preservation on edits, resolved loophole pruning, `due_only` filtering, and manual card deletion.
  6. `update_study_card_edits_text_preserves_sm2_and_rejects_blank`: Verifies `update_study_card` trims and persists edited `prompt`/`answer` while preserving SM-2 `repetitions`, `interval_days`, `ease_factor`, `lapses`, `due_at`, and `last_reviewed_at`, and rejects blank prompts/answers or missing card IDs with `ValidationError`.
  7. `study_flow_template_extracts_two_starter_flashcards_immediately`: Verifies `seed_flow_template(..., "study")` + `sync_study_deck` extracts exactly `2` starter flashcards (`Feynman` and `Qa`) while ignoring inline prose tag mentions in `Topic to Master`.
- **TypeScript / Preact Suite (`src/overlays/__tests__/v06StudyAndGroups.test.tsx`, 14 tests implemented):**
  1. `applySm2ReviewLocal` intervals and ease bounds for `again`, `hard`, `good`, and `easy`.
  2. `syncStudyDeckAction` extraction (`@study` Q:/A:, `@feynman`, active `challenges` loophole) and pruning when loopholes resolve.
  3. `StudyDeckModal` `<dialog closedby="any">` attributes, KaTeX answer reveal, `Good` grading update, and `J`/button jump-to-node camera animation.
  4. `computeGroupBounds`, `hitTestGroupHeader`, `createCanvasGroup`, `updateCanvasGroup`, `buildDeleteWithInverse` pruning, `performUndo` restoration, and `deleteCanvasGroup`.
  5. `getPalette` `data-theme` synchronization, `setTheme` DOM update + `markDirty`, and Canvas2D group rendering (`Replication · 2`).
  6. `offsets overlapping Canvas2D group chips horizontally and hitTestGroupHeader picks the cascaded chip`.
  7. `supports 3-tab switching in SettingsModal across General, Providers & Models, and Prompt & Lenses`.
  8. `traps Tab and Shift+Tab inside DiagnosticsModal and CheckpointsModal without leaking to canvas controls`.
  9. `lifts ToastStack above minimap with toast-stack--above-minimap when minimapOpen is true`.
  10. `omits duplicate + New Card button in StudyDeckModal empty state and closes form then dialog on Esc`.
  11. `extractHintFromAnswer and interleaveStudyCards are pure, non-spoiling, and deterministic`.
  12. `updateStudyCardAction edits prompt/answer while preserving SM-2 state and rejecting blanks`.
  13. `StudyDeckModal supports live tab counts, Hint (H), Write attempt (A) comparison, Interleave, inline Edit, and session summary`.
  14. `study flow template seeds actionable @feynman & @study nodes that extract 2 starter flashcards`.

### CI & Live Browser Verification Gates Pending Execution
The following verification commands and visual checks were **not** executed for the v0.6.1 / v0.6.2 polish commits and remain pending CI & live browser re-verification:
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] `npm test -- --run` (Vitest)
- [ ] `npx tsc --noEmit`
- [ ] `npm run build`
- [ ] 500-node stress benchmark (`src/canvas/__tests__/stress500.test.ts`) confirming zero regression with `O(1)` empty-group skip
- [ ] Live Chromium & Tauri WebView2 visual re-verification of v0.6.1 overlays, focus rings, and theme contrast

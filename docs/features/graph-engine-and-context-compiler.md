# Graph engine and context compiler

The Rust graph engine under `src-tauri/src/graph/` serves as the single source of truth for graph semantics, collision-free spatial placement, deterministic context compilation, structured search, and stream card framing.

## Node types, statuses, and guards

Each `NodeDto` in `src-tauri/src/graph/models.rs` stores its semantic type, lifecycle status, content hashes, metadata, context controls, and world-space layout.

### Node types

| Type (`NodeType`) | Default title in `spawn_connected_node` | Intended role |
| --- | --- | --- |
| `core` | `Core Concept` | Primary specification, component, or foundational decision |
| `branch` | `Branch` | Alternative design path, trade-off, or sub-component |
| `loophole` | `Loophole` | Risk, edge case, or failure mode (defaults to `medium` severity when spawned) |
| `probe` | `Probe` | First-principles explanation or clarifying inquiry |
| `synthesis` | `Synthesis` | Merged decision combining multiple input branches |

### Lifecycle statuses and locked-node guard

Nodes carry one of five `NodeStatus` values: `draft`, `active`, `resolved`, `dismissed`, or `locked`.

- **`draft`:** In-progress streamed or unfinalized content.
- **`active`:** Normal live node; for `loophole` nodes, `active` marks unresolved challenges that propagate into context compilation.
- **`resolved`:** Addressed `loophole` node excluded from `[UNRESOLVED LOOPHOLES]` and muted visually on the canvas.
- **`dismissed`:** Ignored `loophole` node excluded from `[UNRESOLVED LOOPHOLES]` and muted visually on the canvas.
- **`locked`:** Protected node whose text is immutable. Attempting `UpdateNodeText` on a `locked` node fails with `IpcErrorCode::NodeLocked` (`NODE_LOCKED`) in `src-tauri/src/db/queries.rs`, and `enterEditMode` in `src/store/selection.ts` rejects editing and triggers a shake animation (`triggerLockedShake`).

Nodes also track `Severity` (`low`, `medium`, `high`, `critical`), `NodeLensOrigin` (`manual`, `red_team`, `edge_case`, `diverge`, `feynman`, `synthesize`, `custom`), `CreatedBy` (`user`, `ai`), and boolean `ContextControls` (`pin_global` and `exclude_from_ai`).

## Directed edges and canonical directionality

Every edge in `EdgeDto` is directed (`source_id -> target_id`) with one of six `EdgeType` values and an `EdgeWeight` (`full` or `summary`). Self-loops (`source_id == target_id`) fail with `VALIDATION_ERROR`, and duplicate `(source_id, target_id, type)` triples fail with `DUPLICATE_EDGE`.

| Edge type (`EdgeType`) | Canonical direction | Role in graph and compiler |
| --- | --- | --- |
| `derives` | `parent -> child` | Causal lineage included in ancestor traversal |
| `branches` | `parent -> child` | Design option or divergence included in ancestor traversal |
| `synthesizes` | `source -> synthesis` | Convergence edge included in ancestor traversal |
| `references` | `focus -> target` | One-hop lateral citation included only from focus nodes |
| `challenges` | `loophole -> target` | Marks an active loophole targeting a node |
| `resolves` | `fix -> loophole` | Links a mitigation to a loophole and triggers status auto-flip |

When `spawn_connected_node` creates a node connected to `parent_id`, it enforces canonical directionality automatically:

- For `challenges` and `resolves`, the edge points from the spawned node to the anchor node (`new_id -> parent_id`).
- For `derives`, `branches`, `synthesizes`, and `references`, the edge points from the anchor node to the spawned node (`parent_id -> new_id`).

When `apply_ops` processes `CreateEdge` with `type == resolves` targeting a `loophole` node, it atomically updates the target loophole's status to `resolved` inside the same SQLite transaction and returns the updated `NodeDto` in `ApplyResult.updated_nodes`.

## Collision-free placement and subtree layout

`src-tauri/src/graph/spatial.rs` prevents overlapping cards using `SpatialIndex`, an `rstar::RTree<SpatialBox>` wrapper keyed by node ID.

### Spatial constants and bounding boxes

Each `SpatialBox` expands a node's rectangle by half of `COLLISION_MARGIN` (`10.0` world units on each side) and uses `effective_height` (`COLLAPSED_HEIGHT` = `44.0` when `collapsed` is true, or `node.layout.height` otherwise):

- `DEFAULT_NODE_WIDTH`: `320.0`
- `DEFAULT_NODE_HEIGHT`: `180.0`
- `COLLAPSED_HEIGHT`: `44.0`
- `H_GAP`: `100.0`
- `V_GAP`: `36.0`
- `SIDE_GAP`: `48.0`
- `COLLISION_MARGIN`: `20.0`

### Directional and collision-free placement

`spawn_connected_node` accepts an optional `direction: Option<SpawnDirection>` (`right`, `left`, `top`, `bottom`):

- **Explicit direction:** When `direction` is `Some(dir)`, `find_free_position_in_direction` computes the cardinal slot (`directional_slot`: `H_GAP` = `100.0` horizontally, `SIDE_GAP` = `48.0` vertically) and nudges clear in `40.0`-unit steps (`nudge_clear_with_step`, stepping left by `-(width + H_GAP)` for `left` and nudging upward only for `top`).
- **Automatic open direction:** When `direction` is `None`, `find_best_open_direction` checks `right`, `bottom`, `left`, and `top` in order and picks the first uncolliding cardinal slot, falling back to `find_free_position` if every cardinal slot is occupied.

`find_free_position` computes an initial anchor candidate based on `node_type` and `batch_index` (used by multi-card AI lens runs):

- **`core`, `branch`, and single-anchor `synthesis`:** Placed at `primary.x + primary.width + H_GAP`, stacked vertically by `batch_index * (height + V_GAP)`.
- **Multi-anchor `synthesis`:** Placed at `max(anchor.x + anchor.width) + H_GAP` and centered on the mean `y` of all anchor nodes.
- **`loophole`:** Placed beneath the primary node (`primary.y + effective_height(primary) + SIDE_GAP`) in a two-column grid (`DEFAULT_NODE_WIDTH + 24.0` column pitch).
- **`probe`:** Placed over the primary node at a negative Y offset (`primary.y - height - SIDE_GAP`), advancing horizontally by `batch_index * (DEFAULT_NODE_WIDTH + 24.0)`.

If the candidate box intersects any stored node in `SpatialIndex`, `nudge_clear` shifts it in `40.0`-unit steps (up to `30` vertical steps per column across up to `100` horizontal `width + H_GAP` shifts). `probe` nodes nudge upward only; all other node types alternate downward first, then upward.

### Automatic overlap resolution

`resolve_overlaps` in `src-tauri/src/graph/spatial.rs` (exposed through the `resolve_overlaps` IPC command) separates colliding cards after drags, resizes, or AI card growth:

- **Deterministic iterative separation:** Sorts all node IDs lexicographically and runs up to `24` passes against `SpatialIndex` using `COLLISION_MARGIN` (`20.0`) plus `EXTRA_CLEARANCE` (`4.0`).
- **Pinned-node priority:** Separates intersecting pairs along the minimum penetration axis (`overlap_x` compared to `overlap_y`), keeping nodes in `pinned_ids` stationary when displacing unpinned neighbors and splitting displacement `50/50` between unpinned pairs.
- **FTS5-safe persistence:** The `resolve_overlaps` IPC command persists updated coordinates through `GraphOp::MoveNodes` so `nodes_fts` never re-indexes.

### Subtree tidying

The `tidy_subtree` IPC command runs `compute_tidy_subtree` in `src-tauri/src/graph/spatial.rs` and persists coordinate updates through `GraphOp::MoveNodes` (preserving FTS5 index immunity):

1. **Spine traversal:** Runs a cycle-safe breadth-first search (BFS) from `root_id` over outgoing `derives` and `branches` edges, skipping `probe` and `loophole` nodes and sorting children by `(y, x, id)`.
2. **Satellite grouping:** Attaches direct `probe` satellites (outgoing `derives` edges) at negative Y offsets over each spine node and direct `loophole` satellites (incoming `challenges` edges) beneath each spine node in two-column rows (`compute_loophole_offsets`).
3. **Bottom-up span calculation:** Computes each subtree's `SubtreeSpan` (`probe_band`, `own_span`, and `subtree_height`).
4. **Top-down placement with external avoidance:** Seeds a scratch `SpatialIndex` with all nodes outside the subtree, keeps `root_id` stationary, places each spine child and satellite top-down left-to-right, nudges around collisions, and inserts each placed box into the scratch R-tree immediately.

## Deterministic context compiler

Both the `compile_xray` IPC command and `compile_context` in `src-tauri/src/graph/compiler.rs` run the same seven-step deterministic pipeline for a list of `focus_ids` and a `token_budget` (default `6000`).

1. **Collect global pins:** Selects all nodes with `pin_global == true` and `exclude_from_ai == false` (excluding focus nodes), sorted by `id ASC` with `InclusionMode::Pin`.
2. **Backward BFS on ancestor edges:** Traverses incoming `derives`, `branches`, and `synthesizes` edges from `focus_ids` to record the shortest hop distance (`depth_map`) to every ancestor. Because traversal walks backward along incoming edges only, uninvolved sibling branches are isolated. Traversal walks _through_ nodes marked `exclude_from_ai == true` so muting an intermediate scratchpad node never severs lineage to upstream specifications.
3. **Cycle-safe Kahn topological sort:** `kahn_topo_sort_cycle_safe` sorts ancestors into root-to-focus order using a min-heap prioritized by `(depth, id)`. This deduplicates diamond directed acyclic graphs (DAGs) so shared ancestors appear once. If edges form a cycle, remaining cycle members append in deterministic `(depth DESC, id ASC)` order. Ancestors marked `exclude_from_ai` or `pin_global` are filtered out after ordering.
4. **Harvest active loopholes:** Inspects incoming `challenges` edges targeting any node in `focus_ids` or `topo_ancestors`. Only `loophole` sources with `status == active` and `exclude_from_ai == false` are included (`InclusionMode::Loophole`), sorted by severity (`critical`, `high`, `medium`, `low`) and then `id ASC`.
5. **Harvest one-hop references:** Inspects outgoing `references` edges from `focus_ids` only (non-transitive), skipping nodes already included or marked `exclude_from_ai`, sorted by `id ASC` (`InclusionMode::Reference`).
6. **Apply distance-decay token budgeting:** Accounts for token counts (`text.len().div_ceil(4)`) in priority order: global pins, focus nodes (`InclusionMode::Focus`), depth-`1` direct parents (`InclusionMode::Full`), and active loopholes (`InclusionMode::Loophole`). Ancestors at depth `2` or greater start at `InclusionMode::Summary` cost (using `summary` if non-empty, or `title` otherwise) and upgrade to `InclusionMode::Full` in `(depth ASC, id ASC)` order while `used_tokens + upgrade_delta <= token_budget`. Reference nodes charge `Full` or `Summary` tokens based on edge weight.
7. **Assemble deterministic sections:** Joins non-empty sections with `\n\n---\n\n` in a fixed order:
   1. `[GLOBAL CONSTRAINTS]`
   2. `[BACKGROUND ANCESTORS]` (uses `(summary)` header when downgraded and `summary` is non-empty)
   3. `[DIRECT PARENTS & INPUTS]`
   4. `[UNRESOLVED LOOPHOLES]` (includes severity tag and challenged target titles)
   5. `[REFERENCED CONTEXT]`
   6. `[FOCUS NODE]`

   For every included node, `group_annotation` checks `engine.groups` and appends ` [GROUP: <Title1>, <Title2>]` (sorted and deduplicated) to the node's Markdown heading so both `compile_xray` (`Hold V`) and `run_lens` share spatial group context.

`compile_context` returns both the compiled `prompt_text` and a `CompiledXray` payload (`total_tokens`, `budget_tokens`, `node_modes`, and sorted `active_edges`).

## Spatial canvas groups

`GraphEngine` (`src-tauri/src/graph/mod.rs`) maintains `groups: HashMap<String, CanvasGroupDto>` alongside `nodes` and `edges`. Each `CanvasGroupDto` in `src-tauri/src/graph/models.rs` stores `id`, `title`, `color_key`, `member_ids`, `collapsed`, `created_at`, and `updated_at`.

- **Group `GraphOp` variants:** `CreateGroup { id, title, color_key, member_ids }`, `UpdateGroup { id, title, color_key, member_ids, collapsed }`, and `DeleteGroup { id }` execute atomically through `apply_ops` (`src-tauri/src/db/queries.rs`) and update `GraphEngine::upsert_group` / `GraphEngine::remove_group` only after commit.
- **Automatic member pruning:** When `GraphEngine::remove_node` or `GraphOp::DeleteNodes` removes a node, its ID is automatically retained out of `member_ids` across all groups.

## Spaced-repetition study engine (`graph::study`)

`src-tauri/src/graph/study.rs` implements candidate extraction from the live graph and SM-2 spaced-repetition scheduling over `StudyCardDto` (`StudyCardKind`: `qa`, `feynman`, `loophole`, `manual`; `StudyRating`: `again`, `hard`, `good`, `easy`).

- **Candidate extraction (`extract_study_candidates`):** Iterates `engine.all_nodes_sorted()`, skipping `NodeStatus::Dismissed` nodes and placeholder content (`""`, `"thinking..."`, `"thinking…"`, `"..."`, `"todo"`):
  - **`qa`:** Matches nodes tagged `@study` or with `metadata.lens == NodeLensOrigin::Study`. `parse_qa_blocks` parses explicit `Q:`/`A:` or `Question:`/`Answer:` blocks (including bold/underline Markdown and inline `— A:` forms, numbering multi-pair quizzes) and falls back to `(title, content)` when `title` is non-empty.
  - **`feynman`:** Matches nodes tagged `@feynman` or with `metadata.lens == NodeLensOrigin::Feynman` whose `content` has at least `15` characters and non-placeholder `title`, prompting `"Explain from first principles: <title>"`.
  - **`loophole`:** For any node with non-empty `title`, collects incoming `challenges` edges from `active` loopholes sorted by severity (`critical > high > medium > low`, then `id ASC`), formats up to `3` loopholes via `format_loophole_answer`, and prompts `"What failure mode or loophole threatens \"<title>\"?"`.
- **Non-destructive deck sync (`sync_study_deck`):** Updates changed `prompt`/`answer` fields on existing `(node_id, card_kind)` rows without resetting SM-2 progress (`repetitions`, `interval_days`, `ease_factor`, `lapses`, `due_at`, `last_reviewed_at`), leaves `manual` cards untouched, inserts newly discovered cards with `due_at = now_ms` and `ease_factor = 2.5`, and removes `loophole` cards whose target node no longer has active challenges.
- **SM-2 scheduling (`apply_sm2_review`):**
  - `Again`: `repetitions = 0`, `interval_days = 0`, `lapses += 1`, `ease_factor = (ease_factor - 0.2).max(1.3)`, `due_at = now_ms + 60_000`.
  - `Hard`: `interval_days = 1` (rep `0`), `3` (rep `1`), or `round(interval_days * 1.2).max(1)` (rep `>= 2`); `repetitions += 1`; `ease_factor = (ease_factor - 0.15).max(1.3)`.
  - `Good`: `interval_days = 1` (rep `0`), `6` (rep `1`), or `round(interval_days * ease_factor).max(1)` (rep `>= 2`); `repetitions += 1`.
  - `Easy`: `interval_days = 4` (rep `0`) or `round(interval_days * ease_factor * 1.3).max(1)` (rep `>= 1`); `repetitions += 1`; `ease_factor = (ease_factor + 0.15).min(3.5)`.

## Full-text and structured node search

`search_nodes` in `src-tauri/src/db/queries.rs` parses a hybrid query string into structured filters and sanitized FTS5 terms.

### Supported filter tokens

| Token | Accepted values | Behavior |
| --- | --- | --- |
| `status:<VALUE>` | `draft`, `active`, `resolved`, `dismissed`, `locked` | Filters `n.status` (case-insensitive) |
| `type:<VALUE>` | `core`, `branch`, `loophole`, `probe`, `synthesis` | Filters `n.type` (case-insensitive) |
| `severity:<VALUE>` | `low`, `medium`, `high`, `critical` | Filters `n.severity` (case-insensitive) |
| `pinned:<BOOL>` | `true`, `false`, `1`, `0` | Filters `n.pin_global` |
| `excluded:<BOOL>` | `true`, `false`, `1`, `0` | Filters `n.exclude_from_ai` |

### Token sanitization and ranking

Any token that does not match a valid structured filter passes through `sanitize_fts_tokens`, which strips non-alphanumeric punctuation (preserving underscores), lowercases terms, and appends `*` to the final term for prefix matching. Stripping punctuation prevents malformed user queries (such as unmatched quotes or colons) from causing FTS5 syntax errors.

- **When free-text terms are present:** Queries `nodes_fts JOIN nodes` ordered by `bm25(nodes_fts, 4.0, 1.0, 2.0) ASC, n.updated_at DESC` (weighting `title` 4.0, `content` 1.0, and `summary` 2.0) and generates snippets with SQLite `snippet(nodes_fts, ...)`.
- **When only structured filters (or empty text) are present:** Queries `nodes` directly, ordered by severity (`critical` down to `low`) and then `n.updated_at DESC`.

## Fence-aware stream parser

`NodeStreamParser` in `src-tauri/src/ai/parser.rs` parses line-delimited multi-card streams without buffering giant JSON payloads.

### Framing protocol

Card headers begin on their own line with `@@NODE` followed by optional `key=value` attributes (`type`, `edge`, `severity`, and quoted or unquoted `title` with `\n`, `\t`, and `\"` escape handling), and card bodies end at `@@END` or the next `@@NODE` header. The parser buffers partial lines across arbitrary byte/UTF-8 chunks and emits `ParsedEvent::SpawnNode`, `ParsedEvent::TokenDelta`, and `ParsedEvent::FinalizeNode`.

### Code-fence immunity and fallback

- **Code-fence tracking:** Inside a card (`ParserState::InNode`), `update_fence_state` tracks triple-or-longer backtick (`` ` ``) and tilde (`~`) fenced blocks. While inside a fence, lines matching `@@NODE` or `@@END` are treated as literal card body text rather than framing delimiters.
- **Protocol-violation fallback:** If a stream stays in `ParserState::Preamble` for at least `120` bytes or at least two newlines without starting with `@` (or ends in `finish()` with non-empty preamble text), `NodeStreamParser` emits `SpawnNode` using the supplied `LensDefaults` and streams all prose as `TokenDelta` events so no output is lost.

## Multi-workspace catalog and flow templates

`WorkspaceCatalogStore` in `src-tauri/src/workspaces.rs` manages multiple project workspaces and per-topic flows on top of isolated SQLite databases:

- **Atomic catalog storage:** `WorkspaceCatalogStore` persists `WorkspaceCatalogDto` to `~/.axiom/catalog.json` (with `with_root_dir` for unit tests) using a temporary `.tmp` sibling file, `sync_all()`, and atomic rename.
- **First-run preservation:** When no `catalog.json` exists, `load_or_init` creates **Default Workspace** with **Main Flow** pointing to `~/.axiom/default.sqlite` so prior user workspaces remain intact. Added flows write isolated SQLite files to `~/.axiom/workspaces/<workspace_id>/<flow_id>.sqlite`.
- **Workspace and flow CRUD:** Exposed IPC commands (`list_workspace_catalog`, `create_workspace`, `rename_workspace`, `delete_workspace`, `create_flow`, `open_flow`, `rename_flow`, and `delete_flow`) share `open_workspace_internal` in `src-tauri/src/ipc/commands.rs`, locking `state.workspace` before `state.db`. Deleting a flow removes its `.sqlite`, `-wal`, and `-shm` files; deleting the last workspace is rejected.
- **Template seeding (`seed_flow_template`):** In `src-tauri/src/db/mod.rs`, `seed_flow_template` initializes empty flow databases for `"blank"` (`New Topic`), `"research"` (`Research Question` connected to `Literature & Evidence` and `Hypotheses & Gaps`), `"study"` (`Topic to Master` connected to `First-Principles Breakdown` and `Active Recall Questions`), and `"engineering"` (delegating to `hydrate_or_seed_workspace` with `System Architecture`).
- **Browser fallback:** Outside Tauri, `src/store/workspaceCatalogStore.ts` mirrors the catalog under `localStorage` key `"axiom_catalog_v1"` and flow snapshots under `"axiom_flow_<id>"` (with an in-memory `Map` fallback), saving the outgoing flow snapshot and clearing `graphHistory` on every flow switch.

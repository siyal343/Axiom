# Keyboard navigation and overlays

Axiom implements a modal keyboard router, topological graph traversal, an invertible undo and redo ring buffer, a Context X-Ray heads-up display (HUD), an FTS5-backed Command Palette, and an ephemeral toast notification stack.

## Modal router and edit mode isolation

`src/store/selection.ts` defines five mutually exclusive `ModalState` modes: `navigate`, `edit`, `command`, `chord_a`, and `connect_edge`. `createKeymapHandler` in `src/input/keymap.ts` routes keyboard events strictly by active mode:

- **`edit` mode isolation:** When `modalState` equals `"edit"`, `handleKeyDown` returns immediately before inspecting any key. Typing `h`, `j`, `k`, `l`, `a`, `d`, or any other character triggers zero graph commands. In `navigate` and `connect_edge` modes, the router also skips events originating inside `input`, `textarea`, `select`, `[contenteditable='true']`, or `.cm-editor` elements, and in `navigate` mode skips `Tab` and `Enter` when focus sits on a `<button>`, `[role="button"]`, `.hover-pill`, or `.edge-popover` control.
- **`command` mode:** Passes typing and navigation keys to `CommandPalette`, `CustomPromptBar`, and `SettingsModal`, intercepting only `Escape` to close overlays.
- **`chord_a` mode:** Entered by pressing `A` in `navigate` mode and displaying a bottom hint pill listing the available lens shortcuts. A `1500` ms timeout (`chordTimeoutMs`) resets the mode to `"navigate"` if no valid follow-up key arrives. Pressing `R` (`red_team`), `E` (`edge_case`), `D` (`diverge`), `F` (`feynman`), `S` (`synthesize` when two or more nodes are selected, or a warning toast otherwise), or `Space` (`custom`, opening **Custom AI Prompt**) invokes `triggerLens` (`src/store/aiRunner.ts`) and resets to `"navigate"`. Pressing `Escape`, any unmapped key, or blurring the window exits `chord_a` cleanly.
- **`connect_edge` mode:** Entered by pressing `E` on a focused node. Displays a bottom status banner and restricts keyboard input to topological navigation (`H`, `J`, `K`, `L`, and arrow keys), `Enter` (opens the **References** / **Resolves** / **Derives** edge popover anchored at the top center of the target node), and `E` or `Escape` to cancel.

## Navigate mode keyboard bindings

When `modalState` equals `"navigate"`, `keymap.ts` and `src/input/topologyNav.ts` handle all navigation, authoring, layout, and history shortcuts.

### Topological navigation and multi-selection

Sibling lists and child candidates in `src/input/topologyNav.ts` sort deterministically by `(layout.y, layout.x, id)`. When a directional move places the target node outside an `80` px inner viewport margin, `ensureNodeVisible` smoothly pans the camera (`200` ms) to center the target card.

| Shortcut | Action |
| --- | --- |
| `H` or `ArrowLeft` | Focuses the parent node (`findParentTarget`); for a `loophole` node, jumps to the challenged target node |
| `L` or `ArrowRight` | Focuses the first child (`findFirstChildTarget`), prioritizing spine edges (`derives`, `branches`, `synthesizes`) over `probe` and `loophole` satellites |
| `J` or `ArrowDown` | Focuses the next sibling (`findSiblingTarget`), wrapping within the same parent or root tier |
| `K` or `ArrowUp` | Focuses the previous sibling (`findSiblingTarget`), wrapping within the same parent or root tier |
| `Shift+J` or `Shift+ArrowDown` | Extends multi-selection to the next sibling |
| `Shift+K` or `Shift+ArrowUp` | Extends multi-selection to the previous sibling |

### Node authoring, connection, and metadata controls

| Shortcut | Action |
| --- | --- |
| `Enter` | Enters Edit Mode on the focused node; if `status` equals `locked`, triggers a shake animation (`triggerLockedShake`) and warning toast |
| `Tab` | Spawns a connected `core` child (`resolves` if the focused node is a `loophole`, `derives` otherwise), records undo history, and enters Edit Mode |
| `Shift+Enter` | Spawns a `branch` sibling connected with a `branches` edge from the focused node's parent (or from the focused node when at root), records undo history, and enters Edit Mode |
| `N` | Spawns a detached `core` node titled `New Concept` at the viewport center (nudged clear in `40` px steps by `findFreeViewportNodePos`), records undo history, and enters Edit Mode |
| `E` | Enters `connect_edge` mode with the focused node as the edge source |
| `P` | Toggles `pin_global` on all selected nodes (or the focused node), undoable |
| `X` | Toggles `exclude_from_ai` on all selected nodes (or the focused node), undoable |
| `R` | Toggles a focused `loophole` node between `active` and `resolved`, undoable |
| `Shift+R` | Toggles `status` between `locked` and `active` across selected or focused nodes, undoable |
| `C` | Toggles `collapsed` on the focused node, undoable |
| `Shift+C` | Folds or unfolds every node in the focused subtree (`collectSubtreeIds`), undoable |

### Layout, camera fit, X-Ray, and deletion

| Shortcut | Action |
| --- | --- |
| `T` | Invokes Rust `tidy_subtree` on the focused node, updates card positions (`applyTidyPositions`), and records a `move_nodes` undo entry |
| `G` | Wraps `2` or more selected nodes into a named color-coded spatial group (`createCanvasGroup`) and opens `.group-inspector-pill` |
| `F` | Animates (`220` ms) the camera to fit the focused subtree with `80` px padding (`computeFitTransform`) |
| `F` then `F` (within `500` ms) | Animates (`220` ms) the camera to fit every node in the workspace |
| Hold `V` | Calls `compile_xray` on selected or focused nodes (`compileXray` with local fallback outside Tauri) to highlight Context X-Ray halos and display `XrayHud`; releasing `V` or blurring the window clears `xrayState` |
| `Backspace` or `Delete` | Runs two-step loophole triage: when one `active` `loophole` is targeted, the first press sets `status` to `dismissed` (undoable); a second press (or any deletion of non-active loopholes, other node types, or multi-selections) deletes the node(s) and captures incident edges for undo |
| `Cmd/Ctrl+Z` | Undoes the latest graph mutation (`performUndo`) |
| `Cmd/Ctrl+Shift+Z` or `Ctrl+Y` | Redoes the most recently undone mutation (`performRedo`) |
| `Cmd/Ctrl+=` or `Cmd/Ctrl++` | Zooms in by `1.15x` anchored at the viewport center (`zoomByStep(1.15)`) |
| `Cmd/Ctrl+-` or `Cmd/Ctrl+_` | Zooms out by `1 / 1.15` anchored at the viewport center (`zoomByStep(1 / 1.15)`) |
| `Cmd/Ctrl+0` | Resets camera zoom to `100%` (`1.0x`) anchored at the viewport center (`resetZoom`) |
| `Shift+Q` | Toggles **Study & Recall Studio** (`StudyDeckModal`) and syncs due flashcards from the active flow |
| `?` | Toggles **Keyboard Shortcuts** (`ShortcutsModal` in `src/overlays/ShortcutsModal.tsx`) |
| `Cmd/Ctrl+K` | Opens **Command Palette** (`openCommandPalette`) |
| `Cmd/Ctrl+,` | Opens **Settings** (`openSettingsModal`) |
| `Escape` | Follows a strict priority order: (1) cancels an active AI stream (`cancelActiveRun`), (2) closes `edgePopover`, **Keyboard Shortcuts**, **Command Palette**, **Custom AI Prompt**, **Settings**, `triageBanner`, `chord_a`, or `connect_edge`, and (3) collapses multi-selection down to `focusId` |

## Context X-Ray overlay

When `Hold V` activates `xrayState`, `XrayHud` in `src/overlays/XrayHud.tsx` mounts an `<aside class="xray-hud">` overlay displaying:

- **Token budget gauge:** Shows `total_tokens / budget_tokens` and percentage utilization, shifting the progress bar from the standard accent color to `--warn` when exceeding `85%` and `--over` when exceeding `100%`.
- **Mode legend:** Displays six color-coded chips (**Pin**, **Focus**, **Full**, **Summary**, **Loophole**, and **Reference**) matching the Canvas2D halo colors drawn by `renderCanvas2d`.

## Invertible undo and redo history

`UndoRedoHistory` in `src/store/history.ts` maintains a ring buffer with `HISTORY_CAPACITY = 100`, exposed through the `graphHistory` singleton and reactive `canUndoSignal` and `canRedoSignal` flags.

- **Forward and inverse pairs:** Every `HistoryEntry` stores paired `forward` and `inverse` `GraphOp` arrays built by `buildCreateNodeWithInverse`, `buildUpdateTextWithInverse`, `buildUpdateMetaWithInverse`, `buildMoveNodesWithInverse`, `buildDeleteWithInverse`, `buildCreateGroupWithInverse`, `buildUpdateGroupWithInverse`, and `buildDeleteGroupWithInverse`.
- **Cascade-deleted edge and group membership restoration:** When deleting nodes, `buildDeleteWithInverse` snapshots full `NodeDto` records, all incident `EdgeDto` records from `edgesMap`, and `restoreGroupOps` (`update_group` member lists for affected groups in `groupsMap`) so undoing a deletion recreates nodes, edges, and group membership atomically.
- **Loophole resolution tracking:** `spawnChild` and `handleConnectEdge` record the target loophole's prior status in the inverse patch when creating a `resolves` edge, so undoing the creation restores the loophole's previous status.
- **Branch truncation and failure recovery:** Pushing an entry after one or more undos discards the forward redo tail. If `performUndo` encounters an IPC or database error, it restores the entry onto `graphHistory` before rethrowing. Loading a workspace (`loadSnapshot`) clears the history buffer.

## Command Palette and toast notifications

`CommandPalette` (`src/overlays/CommandPalette.tsx`) and `ToastStack` (`src/overlays/ToastStack.tsx`) provide search navigation and non-blocking feedback.

### Command Palette search, actions, and Perf HUD

Opening **Command Palette** (`Cmd/Ctrl+K`, `aria-modal="true"`) focuses the search input, provides a **> Commands** mode toggle alongside five node-filter chips (`status:active`, `type:loophole`, `severity:critical`, `pinned:true`, `excluded:true`), and supports three views:

- **Quick Actions (empty query with zero node hits):** When the search input is empty and returns zero node hits, displays **Quick Actions** (`QUICK_ACTION_IDS`: **> Open Workspace**, **> New Workspace**, **> Toggle Theme**, **> Settings**, and **> Toggle Perf HUD**) so you can run workspace actions directly.
- **Node search mode:** Debounces non-empty queries by `60` ms and calls Rust `searchNodes(query, 30)` when running inside Tauri, falling back to `searchNodesLocally` in browser environments or on IPC errors. Pressing `ArrowDown` or `ArrowUp` cycles through hits; pressing `Enter` or clicking a hit closes **Command Palette**, selects that node, and animates the camera (`220` ms, zoom clamped to at least `0.85x`) to center the card.
- **Action mode:** Activated by entering `>` or clicking **> Commands**; filters workspace, appearance, preference, and diagnostic commands with substring and fuzzy subsequence matching: **> Export JSON**, **> Import JSON**, **> Open Workspace**, **> New Workspace**, **> Toggle Theme**, **> Settings**, **> Toggle Perf HUD**, **> Study & Recall Drill (Shift+Q)**, **> Group Selected Nodes (G)**, and dev-only **> Seed Stress 500** (`import.meta.env.DEV`).
- **Performance HUD (`PerfHud`):** Toggled from **> Toggle Perf HUD** (or opened automatically when seeding the dev stress graph), `src/overlays/PerfHud.tsx` polls `globalFrameTracker.getStats()` every `250` ms to display live **FPS**, **p95 draw**, **Graph** counts, **DOM cards**, and **LOD** state without writing signals inside the render loop.

Pressing `Escape` or clicking the backdrop closes **Command Palette**.

### Keyboard shortcuts reference modal

Pressing `?` in Navigate Mode (or clicking **Keyboard shortcuts** in the bottom-left controls) opens **Keyboard Shortcuts** (`src/overlays/ShortcutsModal.tsx`, `aria-modal="true"`), organizing shortcuts into four tables: **Navigation & Editing**, **Graph & Context**, **AI Lenses & Triage**, and **Canvas & Workspace**. Pressing `Escape`, clicking **Close (Esc)**, or clicking the backdrop closes the dialog.

### Ephemeral toast stack, canvas controls, and floating pills

`ToastStack` renders up to four concurrent toast items (`info`, `warning`, and `error` variants) with optional action buttons, auto-dismissing `error` or action toasts after `5000` ms and `info` or `warning` toasts after `3200` ms. `notifyIpcError` parses structured `IpcError` payloads so `NODE_LOCKED` displays as a `warning` toast and all other IPC errors display as `error` toasts.

`src/App.tsx` also renders persistent and contextual canvas controls in Navigate Mode:

- **Bottom-left canvas controls (`.canvas-controls`):** Provides **Zoom out** (`−`), a live zoom percentage readout button (**Reset zoom to 100%**) updated directly through `subscribeFrame` without Preact re-renders, **Zoom in** (`+`), **Study** (opening `StudyDeckModal` with a live `.study-due-pill` badge when `dueStudyCount > 0`), and **Keyboard shortcuts** (`?`).
- **Empty-canvas onboarding prompt (`.empty-canvas-prompt`):** Appears centered on the canvas when `nodesMap.size === 0` in `"navigate"` mode, summarizing `N`, `Ctrl+K`, and `?` shortcuts alongside a **+ New Node** button that creates and opens a `core` card at the viewport center.
- **Multi-select synthesis and group pill (`.multi-select-pill`):** When two or more cards are selected outside Bird's-Eye LOD and active pointer drags, provides **Synthesize (A S)** (`triggerLens("synthesize")`), **Group (G)** (`createCanvasGroup`), bulk **Pin (P)** / **Exclude (X)** / **Fold (C)** / **Fit (F)**, alignment controls, and **Delete**.
- **Spatial group inspector pill (`.group-inspector-pill`):** Appears when `selectedGroupId` is active outside drags and Bird's-Eye LOD, offering inline title editing, six color swatches (`cobalt`, `emerald`, `amber`, `rose`, `violet`, `slate`), **Add / Sync Selection** (when `selectedIds` differs from `member_ids`), and **Ungroup**.
- **Red-Team loophole triage pill:** When a `red_team` run completes and auto-focuses the first spawned loophole, `.triage-hint-pill` displays `Triage: J/K step · R resolve · Tab fix · Backspace dismiss` for `8000` ms (dismissible early with `Escape`).

## Study & Recall Studio (`StudyDeckModal`) and Context Menu Actions

`StudyDeckModal` (`src/overlays/StudyDeckModal.tsx`, `Shift+Q`) renders as a native `<dialog class="study-dialog" closedby="any" aria-labelledby="study-dialog-title">` (with a pointer-outside light-dismiss fallback when `closedBy` is absent on `HTMLDialogElement.prototype`):

- **Scopes and manual authoring:** Switches between **Due Now** (`due`), **Current Flow** (`flow`), and **Focused Subtree** (`subtree`), and provides an inline **+ New Card** form linked to `studyFocusNodeId` (or standalone when no node is focused).
- **Keyboard-first recall loop:** Renders Markdown, code blocks, and KaTeX math via `renderMarkdownToSanitizedHtml`. Press `Space` or `Enter` to reveal the answer, `1`–`4` to grade (`Again`, `Hard`, `Good`, `Easy`) with SM-2 interval previews (`formatIntervalPreview`), `J` to jump to the source node (`clampZoom(Math.max(cam.zoom, 0.85))`), or `Esc` to close.
- **`NodeContextMenu` integration:** Right-clicking any node offers **Add Study Card** (opens `StudyDeckModal` in `flow` scope with the create form focused on that node) and **Study Deck (`Shift+Q`)**.

# Keyboard navigation and overlays

Axiom implements a modal keyboard router, topological graph traversal, an invertible undo and redo ring buffer, a Context X-Ray heads-up display (HUD), an FTS5-backed Command Palette, and an ephemeral toast notification stack.

## Modal router and edit mode isolation

`src/store/selection.ts` defines five mutually exclusive `ModalState` modes: `navigate`, `edit`, `command`, `chord_a`, and `connect_edge`. `createKeymapHandler` in `src/input/keymap.ts` routes keyboard events strictly by active mode:

- **`edit` mode isolation:** When `modalState` equals `"edit"`, `handleKeyDown` returns immediately before inspecting any key. Typing `h`, `j`, `k`, `l`, `a`, `d`, or any other character triggers zero graph commands. In `navigate` and `connect_edge` modes, the router also skips events originating inside `input`, `textarea`, `select`, `[contenteditable='true']`, or `.cm-editor` elements.
- **`command` mode:** Passes typing and navigation keys to `CommandPalette`, intercepting only `Escape` to close overlays.
- **`chord_a` mode:** Entered by pressing `A` in `navigate` mode and displaying a bottom hint pill listing the available lens shortcuts. A `1500` ms timeout (`chordTimeoutMs`) resets the mode to `"navigate"` if no valid follow-up key arrives. Pressing `R` (`red_team`), `E` (`edge_case`), `D` (`diverge`), `F` (`feynman`), `S` (`synthesize` when two or more nodes are selected, or a warning toast otherwise), or `Space` (`custom`) invokes `onTriggerLens` and resets to `"navigate"`. Pressing `Escape`, any unmapped key, or blurring the window exits `chord_a` cleanly.
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
| `F` | Animates (`220` ms) the camera to fit the focused subtree with `80` px padding (`computeFitTransform`) |
| `F` then `F` (within `500` ms) | Animates (`220` ms) the camera to fit every node in the workspace |
| Hold `V` | Calls `compile_xray` on selected or focused nodes (`compileXray` with local fallback outside Tauri) to highlight Context X-Ray halos and display `XrayHud`; releasing `V` or blurring the window clears `xrayState` |
| `Backspace` or `Delete` | Runs two-step loophole triage: when one `active` `loophole` is targeted, the first press sets `status` to `dismissed` (undoable); a second press (or any deletion of non-active loopholes, other node types, or multi-selections) deletes the node(s) and captures incident edges for undo |
| `Cmd/Ctrl+Z` | Undoes the latest graph mutation (`performUndo`) |
| `Cmd/Ctrl+Shift+Z` or `Ctrl+Y` | Redoes the most recently undone mutation (`performRedo`) |
| `Cmd/Ctrl+K` | Opens **Command Palette** (`openCommandPalette`) |
| `Cmd/Ctrl+,` | Displays an informational toast noting that the settings modal arrives in a later slice |
| `Escape` | Follows a strict priority order: cancels an active run hook if provided, closes `edgePopover`, **Command Palette**, `chord_a`, or `connect_edge`, or collapses multi-selection down to `focusId` |

## Context X-Ray overlay

When `Hold V` activates `xrayState`, `XrayHud` in `src/overlays/XrayHud.tsx` mounts an `<aside class="xray-hud">` overlay displaying:

- **Token budget gauge:** Shows `total_tokens / budget_tokens` and percentage utilization, shifting the progress bar from the standard accent color to `--warn` when exceeding `85%` and `--over` when exceeding `100%`.
- **Mode legend:** Displays six color-coded chips (**Pin**, **Focus**, **Full**, **Summary**, **Loophole**, and **Reference**) matching the Canvas2D halo colors drawn by `renderCanvas2d`.

## Invertible undo and redo history

`UndoRedoHistory` in `src/store/history.ts` maintains a ring buffer with `HISTORY_CAPACITY = 100`, exposed through the `graphHistory` singleton and reactive `canUndoSignal` and `canRedoSignal` flags.

- **Forward and inverse pairs:** Every `HistoryEntry` stores paired `forward` and `inverse` `GraphOp` arrays built by `buildCreateNodeWithInverse`, `buildUpdateTextWithInverse`, `buildUpdateMetaWithInverse`, `buildMoveNodesWithInverse`, and `buildDeleteWithInverse`.
- **Cascade-deleted edge restoration:** When deleting nodes, `buildDeleteWithInverse` snapshots full `NodeDto` records and all incident `EdgeDto` records from `edgesMap` so undoing a deletion recreates both nodes and edges atomically.
- **Loophole resolution tracking:** `spawnChild` and `handleConnectEdge` record the target loophole's prior status in the inverse patch when creating a `resolves` edge, so undoing the creation restores the loophole's previous status.
- **Branch truncation and failure recovery:** Pushing an entry after one or more undos discards the forward redo tail. If `performUndo` encounters an IPC or database error, it restores the entry onto `graphHistory` before rethrowing. Loading a workspace (`loadSnapshot`) clears the history buffer.

## Command Palette and toast notifications

`CommandPalette` (`src/overlays/CommandPalette.tsx`) and `ToastStack` (`src/overlays/ToastStack.tsx`) provide search navigation and non-blocking feedback.

### Command Palette search and jump

Opening **Command Palette** (`Cmd/Ctrl+K`) focuses the search input, exposes five toggleable filter chips (`status:active`, `type:loophole`, `severity:critical`, `pinned:true`, `excluded:true`), and debounces queries by `60` ms:

- **Tauri search and local fallback:** Queries Rust `searchNodes(query, 30)` when running inside Tauri, falling back to `searchNodesLocally` (which evaluates structured filters and case-insensitive substring matches sorted by severity and `updated_at`) in browser environments or on IPC errors.
- **Keyboard selection and camera glide:** Pressing `ArrowDown` or `ArrowUp` cycles through matching hits. Pressing `Enter` or clicking a hit closes **Command Palette**, selects that node, and animates the camera (`220` ms, zoom clamped to at least `0.85x`) to center the card. Pressing `Escape` or clicking the backdrop closes the dialog.

### Ephemeral toast stack

`ToastStack` renders up to four concurrent toast items (`info`, `warning`, and `error` variants) with optional action buttons and a `2800` ms auto-dismiss timer. `notifyIpcError` parses structured `IpcError` payloads so `NODE_LOCKED` displays as a `warning` toast and all other IPC errors display as `error` toasts.

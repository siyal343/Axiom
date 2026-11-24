# Part 4 (Final): UI/UX Rendering Spec, Slice Plan & Verification Matrix

## File: `docs/04-UI-UX-AND-RENDERING.md`

```markdown
# UI/UX Design & 3-Layer Rendering Specification
**Project:** Axiom — Infinite Canvas AI Companion
**Version:** 1.0 (MVP Baseline)
**Scope:** Monochrome Design Tokens, Node Visual States, 3-Layer Canvas/DOM Pipeline, Modal Keyboard & Pointer Engine, Ephemeral Overlays

---

## 1. Visual Language & Design Tokens (`src/styles/theme.css`)

Axiom uses a strictly monochrome matte surface where color carries exclusively **semantic meaning** (node role, loophole severity, or Context X-Ray inclusion mode). Chrome occupies less than 5% of the viewport at rest—no docked sidebars, no ribbon toolbars, no persistent chat pane.

### 1.1 CSS Custom Properties

```css
:root,
[data-theme="dark"] {
  /* Surfaces */
  --bg-canvas: #0e1013;
  --bg-dot: #232730;
  --bg-card: #15181e;
  --bg-card-elevated: #1b1f27;
  --bg-pill: rgba(24, 28, 36, 0.88);
  --bg-code: #101318;

  /* Borders & Hairlines */
  --border-subtle: #262b36;
  --border-strong: #3a4252;
  --edge-default: #3f4756;
  --edge-branch: #5b7fa6;
  --edge-challenge: #d97706;
  --edge-resolve: #2f855a;
  --edge-reference: #4b5563;

  /* Typography */
  --text-primary: #e6eaf0;
  --text-secondary: #98a2b3;
  --text-muted: #667085;
  --font-ui: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, monospace;

  /* Semantic Node Accents (left 3px bar or header tint only) */
  --accent-core: #cbd5e1;
  --accent-branch: #60a5fa;
  --accent-probe: #38bdf8;
  --accent-synthesis: #34d399;
  --accent-loophole-low: #eab308;
  --accent-loophole-med: #f59e0b;
  --accent-loophole-high: #ef4444;
  --accent-loophole-crit: #dc2626;

  /* Interactive & Focus States */
  --ring-focus: #e2e8f0;
  --ring-edit: #60a5fa;
  --ring-multi: #94a3b8;

  /* Context X-Ray (Hold V) Glow Palette */
  --xray-pin: #c084fc;        /* Purple: Global Constraint */
  --xray-focus: #22d3ee;      /* Cyan: Focus Node(s) */
  --xray-full: #4ade80;       /* Green: Full Content Ancestor */
  --xray-summary: #60a5fa;    /* Blue: Compressed Summary Ancestor */
  --xray-loophole: #f59e0b;   /* Amber: Active Unresolved Loophole */
  --xray-reference: #94a3b8;  /* Slate: One-Hop Reference */

  /* Radii & Shadows */
  --radius-card: 8px;
  --radius-pill: 999px;
  --shadow-card: 0 2px 8px rgba(0, 0, 0, 0.35);
  --shadow-edit: 0 8px 28px rgba(0, 0, 0, 0.55), 0 0 0 1.5px var(--ring-edit);
}

[data-theme="light"] {
  --bg-canvas: #f6f7f9;
  --bg-dot: #d5dae2;
  --bg-card: #ffffff;
  --bg-card-elevated: #ffffff;
  --bg-pill: rgba(255, 255, 255, 0.92);
  --bg-code: #f1f3f6;
  --border-subtle: #dde2ea;
  --border-strong: #b8c2d1;
  --edge-default: #98a2b3;
  --text-primary: #111827;
  --text-secondary: #4b5563;
  --text-muted: #6b7280;
  --ring-focus: #111827;
  --shadow-card: 0 2px 6px rgba(15, 23, 42, 0.08);
  --shadow-edit: 0 8px 24px rgba(15, 23, 42, 0.14), 0 0 0 1.5px var(--ring-edit);
}

```

---

## 2. Node Card Anatomy & Visual States

Every node card has a default width of `320px` (expandable up to `520px` for wide tables like `Edge-Case Matrix`), `12px 14px` internal padding, `13.5px` body font (`line-height: 1.5`), and `14px` semibold header title.

| Node State / Type | Visual Cue |
| --- | --- |
| **`core`** | Crisp 1px `--border-subtle` outline; neutral `--accent-core` header tag. |
| **`branch`** | 3px left accent bar in `--accent-branch`; incoming edge rendered as dashed Bezier (`[6, 4]`). |
| **`loophole` (`active`)** | 3px left accent bar colored by severity (`med` = amber, `high`/`crit` = red) + compact severity chip (`HIGH`) in top-right header. |
| **`loophole` (`resolved` / `dismissed`)** | Opacity `0.48`, accent bar desaturated to `--border-strong`, strikethrough on title, warning badge removed from parent. |
| **`probe`** | 3px left accent bar in `--accent-probe`; slightly muted surface tint to distinguish side-quests from main spine. |
| **`synthesis`** | Double border (`box-shadow: inset 0 0 0 1px var(--accent-synthesis)`) + subtle filled header band. |
| **`pin_global == true`** | Compact purple pin icon + `PIN` micro-badge in top-right corner of header. |
| **`exclude_from_ai == true`** | Dashed card border (`1.5px dashed var(--border-strong)`), opacity `0.65`, small crossed-eye icon (`NO AI`). |
| **`status == locked`** | Small padlock icon in header; attempting `Enter` triggers a 180 ms horizontal shake animation and subtle toast (`Node is locked — press L or unlock via pill`). |
| **Streaming (`status == draft`)** | Subtle animated border pulse (`@keyframes pulse-border`, 1.4 s ease-in-out) + small `Esc to stop` indicator in footer. |
| **Collapsed (`collapsed == true`)** | Single-line `44px` height pill showing semantic bar, title, pin/lock icons, and unresolved loophole badge count (e.g., `⚠ 2`). |
| **Unresolved Loophole Badge** | Any node with one or more incoming `active` `challenges` edges displays a compact amber/red pill (`⚠ N`) in its top-right corner. |

### 2.1 Floating Contextual Hover Pill

Appears `8px` above the hovered or focused node in Navigate Mode (fade-in `120ms`, hidden during pan/drag/edit/zoom below `0.45x`):

* Contains strictly **5 compact icon-text triggers**: `+ Child (Tab)` | `AI Lens (A)` | `Pin (P)` | `Collapse (C)` | `More (...)` (toggles Exclude, Lock, Resolved, Delete).
* When **2 or more nodes** are multi-selected, the individual pill hides and a single floating **`Synthesize (A S)`** pill anchors above the selection bounding box center.

---

## 3. Three-Layer Rendering Pipeline

To maintain 60-120 FPS at 500+ nodes, zero reactive Preact re-renders are permitted during pan, zoom, or drag.

```text
┌────────────────────────────────────────────────────────────────────┐
│ Layer 3: Ephemeral Overlays (Preact, fixed screen coords)          │
│  - LiveEditorOverlay (0 mounted in Navigate; 1 CodeMirror in Edit) │
│  - CommandPalette (Cmd/Ctrl+K) | CustomPromptBar (A+Space)         │
│  - XrayHud (Hold V) | SettingsModal | ToastStack                   │
├────────────────────────────────────────────────────────────────────┤
│ Layer 2: Viewport-Culled Static Cards (Preact + direct DOM matrix) │
│  - Mounted ONLY when camera.zoom >= 0.45                           │
│  - Culled via rbush AABB query (viewport + 200px prefetch margin)  │
│  - Positioned via GPU translate3d(camX, camY, 0) scale(zoom)       │
├────────────────────────────────────────────────────────────────────┤
│ Layer 1: Full-Viewport Canvas2D (Raw TypeScript rAF loop)          │
│  - Procedural dot grid (screen-space modulo, zero retained objs)   │
│  - All directed Bezier edges + directional arrowheads              │
│  - Hold-V X-Ray glow halos & illuminated ancestor edges            │
│  - Bird's-Eye LOD nodes when camera.zoom < 0.45                    │
│  - Marquee box-select & live Alt-drag edge preview                 │
└────────────────────────────────────────────────────────────────────┘

```

### 3.1 Camera Math & rAF Loop (`src/canvas/camera.ts`)

* **Transform Model:** World coordinate `(wx, wy)` maps to screen `(sx, sy)` via:
* `sx = wx * zoom + tx`
* `sy = wy * zoom + ty`
* Inverse: `wx = (sx - tx) / zoom`, `wy = (sy - ty) / zoom`


* **Zoom Bounds:** `MIN_ZOOM = 0.12`, `MAX_ZOOM = 2.50`, `LOD_THRESHOLD = 0.45`.
* **Cursor-Anchored Zoom:** When wheel delta applies `nextZoom`, adjust `(tx, ty)` so the world point under cursor `(mx, my)` stays stationary:
* `tx = mx - ((mx - tx) / zoom) * nextZoom`
* `ty = my - ((my - ty) / zoom) * nextZoom`


* **Single-Frame Dirty Flag:** `camera.markDirty()` schedules one `requestAnimationFrame` callback that:
1. Redraws `renderer2d.ts` (hi-DPI scaled by `window.devicePixelRatio`).
2. Mutates `cardLayerRef.style.transform = "translate3d(" + tx + "px, " + ty + "px, 0) scale(" + zoom + ")"` directly.
3. Checks if viewport moved more than `80px` since last cull OR crossed the `0.45x` LOD threshold—ONLY then updates the `visibleNodeIds` signal via `rbush` query.


* **Smart Fit (`F` / Double-`F`):** Computes bounding box of target node set with `80px` screen padding and smoothly interpolates `(tx, ty, zoom)` over `220ms` cubic-out easing.
* **Debounced Persistence:** Fires `save_camera` IPC `1000ms` after camera motion settles.

### 3.2 Canvas2D Structural Renderer (`src/canvas/renderer2d.ts`)

1. **Procedural Dot Grid:** Spacing `24px` in world space; when `24 * zoom < 10`, double effective step (`48px`, `96px`) so dots never alias into solid noise. Fade opacity smoothly between `zoom = 0.25` and `0.50`.
2. **Cubic Bezier Edges:**
* **Spine edges (`derives`, `branches`, `synthesizes`):** Connect source right-center `(sx + sw, sy + sh/2)` to target left-center `(tx, ty + th/2)` with horizontal control offset `dx = max(48, abs(tx - sx_right) * 0.45)`.
* **Off-axis edges (`challenges`, `resolves`, `references`):** Automatically choose nearest cardinal port pair (top/bottom for vertical satellites, left/right for horizontal links) to avoid awkward curve loops.
* **Visual styles:**
* `derives` / `synthesizes`: `1.5px` solid `--edge-default`.
* `branches`: `1.5px` dashed `[6, 4]` `--edge-branch`.
* `challenges`: `1.75px` solid `--edge-challenge` (dimmed to `0.3` alpha if source loophole is `resolved`/`dismissed`).
* `resolves`: `1.5px` dotted `[2, 4]` `--edge-resolve`.
* `references`: `1.25px` dashed `[3, 5]` `--edge-reference`.




3. **Hold-V X-Ray Pass:** When `xrayState` is active:
* Dim all non-participating edges to `0.12` alpha and non-participating cards (via CSS class on `CardLayer`) to `0.22` opacity.
* Draw `2.5px` illuminated edges for `xrayState.active_edges` and colored rounded-rect halo rings (`6px` spread) around every node in `xrayState.node_modes`.


4. **Bird's-Eye LOD (`zoom < 0.45`):**
* Iterate visible nodes from `rbush`, draw crisp rounded rect (`border-radius: 6px`), `4px` semantic left bar, truncated single-line title (clipped to box width; hidden below `zoom = 0.20`), and solid amber/red corner dot if unresolved loopholes exist.



### 3.3 Static Card Cache & Single Live Editor (`src/cards/`)

* **`markdownCache.ts`:** LRU cache (max 600 entries) keyed by `content_hash`. Renders `markdown-it` -> KaTeX math (`$...$` inline, `$$...$$` display) -> `highlight.js` fenced blocks -> `DOMPurify.sanitize(html, { ADD_TAGS: ['math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'annotation'], ADD_ATTR: ['class', 'style'] })`.
* **Card Height Sync:** Each mounted `NodeCard` attaches a debounced `ResizeObserver`. When rendered height differs from `node.layout.height` by more than `4px`, update `rbush` locally and emit a batched `ResizeNodes` op (non-undoable layout sync) so Rust R-tree collision math matches true rendered heights.
* **`LiveEditorOverlay.tsx`:**
* Mounted ONLY when `modalState === "edit"` and `focusId !== null`.
* Positioned in screen coordinates directly over the focused node (`top`, `left`, `width`, `minHeight` mapped through `camera.worldToScreen` and scaled cleanly so typing stays crisp and unblurred).
* Header input (`<input>`) edits `node.title`; pressing `Tab` or `DownArrow` at end moves into the CodeMirror 6 body editor (`markdown()` language, minimal monochrome theme, soft wrap).
* **`Esc`:** Commits `UpdateNodeText` (if changed) via `apply_ops` + Undo history, unmounts CodeMirror, restores `Navigate` mode.
* **`Cmd/Ctrl + Enter`:** Commits changes and immediately opens the `A`-chord lens bar (or fires `CustomPromptBar`) on the saved node.



---

## 4. Modal Keyboard & Pointer Interaction Specification

### 4.1 Three-State Input Router (`src/input/keymap.ts`)

Maintain `modalState: "navigate" | "edit" | "command" | "chord_a" | "connect_edge"`:

1. **`Navigate` (Default):** All single-key spatial and graph shortcuts active.
2. **`Edit`:** Entered via `Enter` or double-click on unlocked node. Only `Esc` and `Cmd/Ctrl+Enter` are intercepted by router; all other keys flow to CodeMirror 6.
3. **`Command`:** Entered via `Cmd/Ctrl+K`, `A Space`, or Settings modal. `Esc` closes overlay and returns to `Navigate`.
4. **`Chord A`:** Pressing `A` in Navigate Mode enters `chord_a` for `1500ms` and displays a compact bottom-center chord hint pill (`R Red-Team · E Edge Cases · D Diverge 3x · F Feynman · S Synthesize · Space Prompt`). Pressing a valid key fires the lens; `Esc`, timeout, or invalid key cancels cleanly.
5. **`Connect Edge`:** Pressing `E` in Navigate Mode highlights candidate target nodes; clicking a target (or pressing `Enter` after navigating) opens a 2-option popover (`references` / `resolves`) and creates the edge.

### 4.2 Complete Keyboard Binding Table (Navigate Mode)

| Key | Action | Exact Behavior |
| --- | --- | --- |
| `H` / `ArrowLeft` | Jump Parent | Focus primary incoming spine parent (`derives`/`branches`/`synthesizes`, or challenged target if focused on a `loophole`). Auto-pan if off-screen. |
| `L` / `ArrowRight` | Jump Child | Focus first outgoing spine child (sorted by `y ASC`). |
| `J` / `ArrowDown` | Next Sibling | Cycle to next sibling sharing the same parent (or next loophole in triage group), sorted by `y ASC` then `x ASC`. |
| `K` / `ArrowUp` | Prev Sibling | Cycle to previous sibling. |
| `Shift + J / K` | Extend Multi-Select | Adds next/previous sibling to `selectedIds` set (enables `A S` Synthesize). |
| `Enter` | Enter Edit Mode | Mounts `LiveEditorOverlay` on focused node (rejected with shake if `locked`). |
| `Tab` | Spawn Child | Calls `spawn_connected_node(focusId, edgeType: focusedIsLoophole ? "resolves" : "derives", nodeType: "core")`, focuses new node, enters Edit Mode. |
| `Shift + Enter` | Spawn Branch Sibling | Calls `spawn_connected_node(parentOfFocus ?? focusId, edgeType: "branches", nodeType: "branch")`, focuses new node, enters Edit Mode. |
| `N` | New Free Node | Creates detached `core` node at viewport center (R-tree nudged), enters Edit Mode. |
| `E` | Connect Edge | Enters `connect_edge` mode to link `references` or `resolves`. |
| `P` | Toggle Global Pin | Toggles `pin_global` on all selected nodes. |
| `X` | Toggle AI Exclude | Toggles `exclude_from_ai` on all selected nodes. |
| `R` | Toggle Resolved | On `loophole`: toggles `active <-> resolved`. On other types: toggles `active <-> locked` when combined with `Shift+R`. |
| `C` | Collapse Node | Toggles `collapsed` on focused node. |
| `Shift + C` | Fold Subtree | Toggles `collapsed` across focused node's descendants. |
| `T` | Tidy Subtree | Invokes `tidy_subtree(focusId)` and animates nodes to returned positions (`180ms`). |
| `F` / `F F` | Smart Fit | Single `F`: fits focused subtree. Double `F` (within 500 ms): fits entire workspace. |
| `Hold V` | Context X-Ray | On `keydown` (non-repeat): calls `compile_xray(selectedOrFocusIds)` and shows X-Ray glow + `XrayHud`. On `keyup` (or window blur): clears X-Ray immediately. |
| `Backspace` / `Delete` | Delete / Dismiss | If focused on `active` loophole during triage: first press marks `dismissed`; second press deletes node (undoable). For other nodes: deletes selected nodes via `DeleteNodes` (undoable). |
| `Cmd/Ctrl + Z` | Undo | Pops top inverse op batch from `history.ts` and submits to `apply_ops`. |
| `Cmd/Ctrl + Shift + Z` | Redo | Reapplies undone op batch. |
| `Cmd/Ctrl + K` | Command Palette | Opens fuzzy FTS5 search & filter overlay. |
| `Cmd/Ctrl + ,` | Settings | Opens `SettingsModal`. |
| `Esc` | Cancel / Clear | Priority order: (1) cancel active AI stream via `cancel_run`, (2) close overlay/chord, (3) clear multi-select down to single focus. |

### 4.3 Loophole Triage Flow

When `Red-Team` (`A R`) completes (`RunCompleted` with `spawned_ids.length > 0` and user has not manually moved focus away):

1. Focus automatically shifts to `spawned_ids[0]` (highest severity loophole).
2. A subtle transient hint appears in the bottom-center pill: `Triage: J/K step · R resolve · Tab fix · Backspace dismiss`.
3. Pressing `Tab` on an active loophole spawns a `core` mitigation node wired via `resolves` (`fix_node -> loophole`), automatically marking the loophole `resolved`.

### 4.4 Pointer Ergonomics (`src/canvas/pointer.ts`)

* **Pan:** `Space + Left-Drag` or `Middle-Mouse Drag` (changes cursor to `grab`/`grabbing`).
* **Node Select & Multi-Drag:** Click selects node; `Shift+Click` toggles in `selectedIds`; dragging any selected node moves the entire selection smoothly via local optimistic coordinates in `rAF` and commits ONE `MoveNodes` op on `pointerup` (with snap-to-12px grid when `Alt` is NOT held).
* **Marquee Box-Select:** Left-drag on empty canvas draws a subtle translucent rectangle on Layer 1 and selects all intersecting nodes on `pointerup`.
* **Port-Free Edge Drag (`Alt + Drag` from node):** Draws a live Bezier preview line on Layer 1 from source node to cursor. Dropping onto another node opens a minimal 2-button popover (`References` | `Resolves` | `Derives`).

---

## 5. Undo/Redo Ring Buffer (`src/store/history.ts`)

* Capacity: `100` atomic entries.
* Every user-initiated mutation records `{ forward: GraphOp[], inverse: GraphOp[] }` BEFORE dispatching `apply_ops`:
* `CreateNode` <-> `DeleteNodes`
* `DeleteNodes` <-> `CreateNode` (full snapshot of deleted nodes) + `CreateEdge` (full snapshot of cascade-deleted edges returned in `ApplyResult.deleted_edge_ids` captured beforehand)
* `UpdateNodeText` <-> `UpdateNodeText` (previous title & content)
* `MoveNodes` / `tidy_subtree` <-> `MoveNodes` (previous coordinates)
* `UpdateNodeMeta` <-> `UpdateNodeMeta` (previous flags)


* AI-generated runs push a single grouped Undo entry upon `RunCompleted` (`forward: create spawned nodes + edges`, `inverse: DeleteNodes(spawned_ids)`) so one `Cmd/Ctrl+Z` cleanly rolls back an entire 3-branch `Diverge` or `Red-Team` pass.

```

---

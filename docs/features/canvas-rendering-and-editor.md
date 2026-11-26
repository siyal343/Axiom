# Canvas rendering and editor

Axiom renders the infinite workspace using a three-layer pipeline designed to keep pan, zoom, and node-dragging loops decoupled from Preact component reconciliation while maintaining a single live CodeMirror 6 editor instance.

## Three-layer rendering pipeline

`src/App.tsx` mounts three stacked layers inside `.axiom-canvas-shell`:

1. **Layer 1 — Full-viewport Canvas2D (`.canvas-layer`):** Drawn by `renderCanvas2d` in `src/canvas/renderer2d.ts` with device-pixel-ratio scaling. Renders the background fill, procedural dot grid (base `24` px world step that doubles when screen spacing drops under `10` px and fades out under `0.50x` zoom), spatial canvas groups (skipped in `O(1)` when `groups` is empty), dynamic 4-side cubic Bezier edges with obstacle deflection, animated directional connection pulses, `Hold V` X-Ray halos, Bird's-Eye level-of-detail (LOD) cards under `0.45x` zoom, marquee box-select rectangles, and live `Alt+Drag` edge previews.

### Theme palette synchronization and spatial canvas groups

`src/canvas/renderer2d.ts` and `src/store/graphStore.ts` keep Canvas2D colors synchronized with CSS custom properties in `src/styles/theme.css`:

- **Live `data-theme` synchronization (`getPalette` & `setTheme`):** `setTheme(nextTheme)` updates `theme.value`, sets `document.documentElement.setAttribute("data-theme", nextTheme)` synchronously, and marks the camera dirty. Before returning a cached `ThemePalette`, `getPalette(themeKey)` verifies `document.documentElement.getAttribute("data-theme") === themeKey`; on any mismatch it sets `data-theme` immediately and refreshes the CSS variable cache via `getComputedStyle(document.documentElement)`. `src/styles/theme.css` declares `color-scheme: dark;` on `:root, [data-theme="dark"]` and `color-scheme: light;` on `[data-theme="light"]`, alongside six `--group-*` accent variables (`cobalt`, `emerald`, `amber`, `rose`, `violet`, `slate`).
- **Spatial group pass (`computeGroupBounds` & `hitTestGroupHeader`):** When `groups` is non-empty (`O(1)` skip otherwise), `renderCanvas2d` computes each group's live bounding box with `computeGroupBounds(group, sceneRects)` (`GROUP_PADDING = 26`, `GROUP_TOP_HEADER = 38`, `headerH = 26`, respecting active `dragOffsets` and `resizeSizes`), culls off-screen groups, draws the tinted dashed/solid region, and draws the `<title> · <memberCount>` header chip whenever `cam.zoom >= 0.2`. `hitTestGroupHeader(scenePoint, groups, sceneRects, zoom)` tests headers in reverse paint order for hover cursors and click/drag selection.
2. **Layer 2 — GPU-transformed static cards (`CardLayer` in `src/cards/CardLayer.tsx`):** Positions `.card-layer` with `transform: translate3d(x, y, 0) scale(zoom)` (`transform-origin: 0 0`) and renders only the viewport-culled `NodeCard` elements listed in `visibleNodeIds`.
3. **Layer 3 — Single live editor and ephemeral pills:** `LiveEditorOverlay` (`src/cards/LiveEditorOverlay.tsx`) mounts when `modalState` equals `"edit"`, accompanied by `.node-context-menu`, `.workspace-sidebar`, `.multi-select-pill`, `.group-inspector-pill`, and `.edge-popover` controls.

### Dynamic edge routing and visual emphasis

Every edge in `renderCanvas2d` uses `computeDynamicEdgeCurve` and `nearestPortPair` rather than fixed left-to-right anchors:

- **Viewport-culled obstacles and edges:** Before drawing edges, `renderCanvas2d` expands the world viewport by `240` px (`edgePad`). It skips edges whose combined `(srcRect, dstRect)` bounding box falls outside those bounds and restricts obstacle deflection checks (`visibleObstacles`) to on-screen nodes when `cam.zoom >= 0.45`.
- **4-side port selection:** `nearestPortPair` evaluates all `16` cardinal port pairs between source and target rectangles, scoring Euclidean distance plus an alignment penalty whenever the connecting vector opposes a port's outward normal `(nx, ny)`. As cards move `360°` around each other, edges transition cleanly to the facing sides.
- **Obstacle bow deflection:** When an edge's direct midpoint falls within `12` px of any visible third node's bounding box (`id !== srcId && id !== dstId`), `computeDynamicEdgeCurve` shifts the cubic Bezier control points perpendicularly around the nearest obstacle edge so connections stay visible instead of tunneling behind cards.
- **Semantic styling and incident glow:** Base strokes use `2.0` px width (`2.25` px for `challenges`, `1.75` px for `references`) with round caps and `8.5` px arrowheads. Edges incident to `focusId`, `hoveredId`, or any actively dragged or resized card increase to `2.75` px width with a matching colored glow (`shadowBlur = 8`).
- **Animated directional connection flow:** When `animateEdges` is true, `renderCanvas2d` draws marching dashes (`lineDashOffset` driven by `animTimeMs`) from source to target along each non-dimmed edge and draws a `3.2` px traveling directional orb along emphasized incident edges. `App.tsx` disables `CanvasCameraController.setContinuousAnimation` automatically in Bird's-Eye LOD (`cam.zoom < 0.45`), when `edgesMap.size === 0`, when `prefers-reduced-motion: reduce` matches, or when you toggle **Pause connection flow** / **Play connection flow** in `.canvas-controls`.

### Semantic node color-coding

`resolveNodeTone` in `src/cards/nodeAccent.ts` assigns each node one of `11` semantic tones (`user`, `feynman`, `study`, `research`, `diverge`, `synthesize`, `red_team`, `edge_case`, `triage`, `custom`, and `ai`) and caches lookups in a `2000`-entry map keyed by node ID, `content_hash`, content length, `lens`, `type`, and `created_by`:

1. **Tag directives first:** Scans outside fenced code blocks (`extractActionTagFromContent`) for `@feynman`, `@study`, `@research`, `@diverge`, `@synthesize`, `@redteam`, `@edgecase`, `@triage`, or `@custom`.
2. **Metadata and type fallbacks:** Falls back to non-`manual` `metadata.lens`, then semantic `node.type` (`loophole`, `synthesis`, `branch`, `probe`), then `"Note"` for `created_by === "user"` or `"AI"` otherwise.
3. **DOM and Canvas2D parity:** `NodeCard` applies `.node-card--tone-<key>` (top gradient wash and tinted border) and `.badge--tone-<key>` (`src/styles/theme.css`). In Bird's-Eye LOD (`< 0.45x`), `getSemanticBarColor` in `src/canvas/renderer2d.ts` uses the tone palette for the `4` px left bar (or severity colors for active loopholes and muted borders for resolved or dismissed loopholes).

## Decoupled camera loop

Mutable graph collections (`nodesMap`, `edgesMap`, `cardDomRefs`, and `dragOffsets`) in `src/store/graphStore.ts` live outside `@preact/signals`. `CanvasCameraController` in `src/canvas/camera.ts` batches redraws with `requestAnimationFrame` (`markDirty` / `flushFrame`):

- On pan, zoom, or cubic ease-out `animateTo` frames, `flushFrame` repaints Canvas2D and updates `cardLayerEl.style.transform` directly through a DOM ref without updating Preact signals or re-rendering `NodeCard` components.
- `CanvasCameraController` debounces `onSaveCamera` for `1000` ms after pan, zoom, or animated transitions settle, persisting camera coordinates with `save_camera` when running inside Tauri.

## Cursor-anchored zoom and Bird's-Eye LOD cutoff

`src/canvas/camera.ts` enforces zoom bounds `[MIN_ZOOM, MAX_ZOOM]` (`0.12` to `2.5`) and exports pure coordinate helpers (`worldToScreen`, `screenToWorld`, `zoomAtCursor`, `computeFitTransform`, `clampZoom`):

- **Cursor-anchored zoom:** `zoomAtCursor` converts the cursor's screen position `(mx, my)` into world coordinates before applying `clampZoom(nextZoom)`, then adjusts `(cam.x, cam.y)` so the same world point remains directly beneath the cursor.
- **Bird's-Eye LOD cutoff (`0.45x`):** `LOD_THRESHOLD` is `0.45`. Whenever `cam.zoom < 0.45`, `isBirdsEye` switches to `true`, `onViewportCull` clears `visibleNodeIds` to `[]`, and `CardLayer` returns `null` so zero `.node-card` elements remain in the DOM. At the same time, `renderCanvas2d` draws simplified Bird's-Eye cards directly onto Canvas2D (rounded background, `4` px semantic left bar, focus or selection border, pin indicator dot, unresolved loophole severity dot, and a single-line truncated title when `cam.zoom >= 0.20`).

## Viewport culling with rbush

`ViewportSpatialIndex` in `src/canvas/spatialIndex.ts` wraps `RBush<SpatialItem>` to index each node's world bounding box using `getEffectiveNodeHeight` (`44` px when `collapsed` is true, or `node.layout.height` otherwise).

- `queryViewport(bounds, 200)` expands the current world viewport bounds by a `200` px margin on every side so cards entering the screen are mounted ahead of edges.
- To avoid unnecessary Preact updates during smooth panning, `CanvasCameraController.flushFrame` invokes `refreshCull()` only when camera translation exceeds `CULL_MOVE_THRESHOLD_PX` (`80` px), relative zoom changes by more than `12%`, or zoom crosses `LOD_THRESHOLD` (`0.45x`).

## Pointer controls, resizing, and omnidirectional ports

`attachCanvasPointer` in `src/canvas/pointer.ts` handles canvas pointer and wheel interactions while ignoring events inside interactive controls (except `[data-resize-handle]`):

| Gesture | Behavior |
| --- | --- |
| Middle-mouse drag, `Space` + left-drag, or wheel scroll | Pans the canvas (`camera.panBy`) |
| `Ctrl+Wheel` or `Meta+Wheel` | Zooms anchored at the cursor (`camera.zoomAt`) |
| Click card | Single-selects the card (`selectSingle`) |
| `Shift+Click` card | Toggles the card in multi-selection (`toggleSelect`) |
| Drag card past `4` px (`DRAG_THRESHOLD_PX`) | Multi-drags all selected cards, snaps the primary card delta to a `12` px grid (`GRID_SNAP_PX`, hold `Alt` to bypass), updates `dragOffsets` and direct DOM `style.transform` at 60 FPS, commits one undoable `move_nodes` batch, and runs `resolveAndAnimateOverlaps` |
| Hover or drag spatial group header (`hitTestGroupHeader`) | Shows `grab` cursor on hover; clicking selects all live group members and sets `selectedGroupId`, and dragging past `4` px moves all member cards at 60–120 FPS via `dragOffsets` and direct DOM transforms without Preact re-renders, committing one `"Move group"` undoable `move_nodes` batch |
| Drag `[data-resize-handle]` (`e`, `s`, or `se`) | Resizes card width (`220`–`960` px) and height (`112`–`1200` px) with `12` px grid snapping (`Alt` bypasses), updates `resizeSizes` and DOM styles directly without Preact re-renders, commits `resize_nodes` with `buildResizeNodesWithInverse`, and runs `resolveAndAnimateOverlaps` |
| Drag empty canvas past `4` px | Draws a marquee selection box (`overlay.marqueeWorld`) and selects intersecting cards using `viewportSpatialIndex.queryRect` on release |
| Click empty canvas | Clears selection (unless `Shift` is held) |
| `Alt+Drag` from card | Draws a live dashed Bezier preview (`overlay.edgePreviewWorld`) and opens the **References** / **Resolves** / **Derives** edge popover when released over another node |
| Double-click card | Single-selects the card and smoothly center-zooms onto it (`Math.max(cam.zoom, 1.15)` over `220` ms); enters Edit Mode only when `node.metadata.created_by` equals `"user"` and keeps AI-created (`"ai"`) cards in Navigate Mode for inspection |
| Right-click card | Opens `.node-context-menu` (`src/overlays/NodeContextMenu.tsx`) at cursor coordinates clamped inside viewport bounds |

Right-clicking any card in Navigate Mode opens `.node-context-menu` with keyboard navigation (`ArrowUp`, `ArrowDown`, `Home`, `End`, `Escape`) and groups actions into four categories:

- **Card edits:** **Edit**, **Copy Text**, **Duplicate** (creates a user-owned copy nearby and resolves overlaps), **Add Child**, **Add Study Card**, and **Study Deck** (`Shift+Q`).
- **Node mode toggles:** **Pin Global** / **Unpin Global**, **Exclude from AI** / **Include in AI**, **Fold** / **Unfold**, **Lock** / **Unlock**, **Tidy Subtree**, plus **Resolve Loophole** / **Reopen Loophole** and **Dismiss Loophole** / **Restore Loophole** on loophole cards.
- **Action tags:** All nine `@tag` actions (`@custom`, `@feynman`, `@redteam`, `@edgecase`, `@diverge`, `@synthesize`, `@research`, `@study`, `@triage`).
- **Removal:** **Delete** (`Del`).

When a card is hovered or single-focused in Navigate Mode, `NodeCard` renders four cardinal `+` port buttons (`.node-port--top`, `.node-port--right`, `.node-port--bottom`, `.node-port--left`) alongside `.hover-pill`, spawning a connected child in the selected `SpawnDirection` and opening Edit Mode.

After pointer drags, manual resizes, `queueNodeResize` card growth, and finalized AI lens nodes, `resolveAndAnimateOverlaps` in `src/store/graphStore.ts` queries `resolve_overlaps` (or `resolveOverlapsLocally` outside Tauri) with the moved or grown cards pinned and animates displaced neighbors smoothly over `180` ms (`applyTidyPositions`).

## Workspaces and flows sidebar

`WorkspaceSidebar` (`src/overlays/WorkspaceSidebar.tsx`) renders a collapsible `268` px left drawer (`#workspace-sidebar`) paired with a top-left toggle pill (`.sidebar-toggle-bar`) displaying the active `<Workspace> / <Flow>` label:

- **Toggle and focus safety:** Press `Ctrl+B` (`Cmd+B` on macOS), select **> Toggle Sidebar** in the Command Palette, or click `.sidebar-toggle-bar` to open or close the drawer. The sidebar stops `pointerdown` and `wheel` propagation so canvas pan and zoom stay unaffected, and sets `inert` and `aria-hidden="true"` when closed.
- **Top actions and bottom settings:** The top stack provides **New Flow** (toggling the inline flow creator with **Design**, **Study**, **Research**, and **Blank** template radio pills on the active workspace), **Search & Actions** (opening `CommandPalette`), and **Shortcuts** (opening `ShortcutsModal`). A pinned footer holds **Settings** (opening `SettingsModal`).
- **Workspace filtering and nested flow rows:** The **Workspaces** section header provides a filter input toggle (`Filter workspaces or flows`), an inline workspace creator (`FolderPlus`), and a close button. Each collapsible workspace group lists nested flows with template-colored dots, relative timestamps from `formatRelativeAge` (`now`, `5m`, `2h`, `3d`, `mo`), and hover/`:focus-within` `...` action menus for inline rename and two-step delete confirmation without `window.prompt` or `window.confirm` dialogs.

## Static Markdown, math, and sanitization cache

In Navigate Mode, `NodeCard` renders static HTML through `src/cards/markdownCache.ts`. When `node.status` equals `"draft"`, `NodeCard` bypasses the 600-entry `content_hash` LRU cache and calls `renderMarkdownToSanitizedHtml(node.content)` directly so progressive streaming deltas never pollute the cache with partial hashes while still passing through DOMPurify. For all non-draft nodes, `NodeCard` calls `getRenderedMarkdown(node.content_hash, node.content)`:

1. **Math and interactive visual preprocessing:** `preprocessMathOutsideCode` scans the Markdown string while ignoring regular fenced code blocks (```` ``` ```` or `~~~`), inline code spans, and escaped `\$` sequences. Closed ```` ```axiom-sim ```` / ```` ```sim ```` blocks parse through `parseVisualSimSpec` (`src/cards/visualSimEngine.ts`) into validated `<div class="axiom-sim-mount" data-sim="...">` mounts (rendering an `.axiom-sim-streaming` notice while unclosed during streaming), and display math (`$$...$$`) and inline math (`$...$`) render with KaTeX (`throwOnError: false`) into temporary placeholders.
2. **Markdown and syntax highlighting:** `markdown-it` (`html: true`, `linkify: true`, `breaks: true`) renders the text and highlights fenced code blocks using a lightweight `highlight.js/lib/core` bundle registered with 14 languages (`typescript`, `javascript`, `rust`, `python`, `sql`, `bash`, `json`, `css`, `xml`/`html`, `c`, `cpp`, `go`, `yaml`, `markdown`).
3. **HTML sanitization and lazy hydration:** After restoring KaTeX and simulation placeholders, the full HTML output passes through `DOMPurify.sanitize` with `DOMPURIFY_CONFIG` (allowing MathML elements plus `class`, `style`, and `data-sim` attributes) to strip `<script>`, inline event handlers, and `javascript:` URLs before `NodeCard` injects it. `useSimHydration` (`src/cards/simMountHost.ts`) then mounts interactive `VisualSimBlock` SVGs (`RF`, `Controls`, `Embedded`, `Physics`, `Math`) onto `.axiom-sim-mount` containers inside expanded `NodeCard` bodies and revealed `StudyDeckModal` flashcards, cleaning them up on collapse or Bird's-Eye `< 0.45x` LOD unmount and stopping pointer/wheel propagation via `.axiom-sim` in `isInteractiveTarget`.
4. **Content-hash LRU cache:** `getRenderedMarkdown` caches sanitized HTML keyed by `content_hash` in an LRU `Map` capped at `MAX_CACHE_ENTRIES` (`600` entries).

`NodeCard` attaches a `ResizeObserver` (`90` ms debounce, keyed on `[node.id, node.layout.collapsed]`) to expanded cards while not actively dragging or resizing. When rendered `offsetHeight` exceeds `node.layout.height + 2` (ignoring absolute-positioned ports, handles, and pills), it calls `queueNodeResize` in `src/store/graphStore.ts`, which ignores jitter within `4` px, batches `resize_nodes` updates after `160` ms, and runs `resolveAndAnimateOverlaps` if the card grew.

## One Live Editor architecture

Axiom enforces the invariant that zero CodeMirror instances exist in the DOM outside Edit Mode:

- In Navigate Mode (`modalState === "navigate"`), `LiveEditorOverlay` returns `null`, leaving `0` `.cm-editor` elements in the DOM.
- When you trigger `enterEditMode(node)` on a `locked` node, `src/store/selection.ts` aborts editing and triggers a `240` ms `lockedShakeId` animation.
- On an unlocked node, `enterEditMode` sets `modalState` to `"edit"` and `LiveEditorOverlay` mounts one `LiveEditorInstance` (`role="dialog"`, `aria-label="Edit node"`) positioned through `computeOverlayRect`, synchronized on camera frames through `subscribeFrame`, with a title `<input>` and a CodeMirror 6 `EditorView` (`@codemirror/lang-markdown`, `@codemirror/commands` default and history keymaps, line wrapping, and monochrome theme). Initial focus defers to `requestAnimationFrame`, selecting the title `<input>` for empty starter titles (`"New Concept"` or `"New Node"`) or focusing the CodeMirror body otherwise.
- Typing `@` before the cursor inside the CodeMirror body opens `.editor-tag-menu` (`role="listbox"`) powered by `filterActionTags`. Use `ArrowUp`, `ArrowDown`, `Enter`, `Tab`, or click an item to insert the tag. Whenever `extractActionTagFromContent` detects an `@tag` line outside fenced code blocks, the footer displays a **Run `@tag`** button.
- Pressing `Escape` inside Edit Mode saves changed text through `mutateGraphUndoable` (pre-warming `getRenderedMarkdown`), calls `exitEditMode()`, and destroys the `EditorView` (`view.destroy()`), returning the `.cm-editor` count to zero. Pressing `Ctrl/Cmd+Enter` commits edits, exits Edit Mode, preserves selection on the edited node, and runs any detected `@tag` directive (or opens `chord_a` when no `@tag` is present).

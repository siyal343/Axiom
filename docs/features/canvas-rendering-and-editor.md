# Canvas rendering and editor

Axiom renders the infinite workspace using a three-layer pipeline designed to keep pan, zoom, and node-dragging loops decoupled from Preact component reconciliation while maintaining a single live CodeMirror 6 editor instance.

## Three-layer rendering pipeline

`src/App.tsx` mounts three stacked layers inside `.axiom-canvas-shell`:

1. **Layer 1 — Full-viewport Canvas2D (`.canvas-layer`):** Drawn by `renderCanvas2d` in `src/canvas/renderer2d.ts` with device-pixel-ratio scaling. Renders the background fill, procedural dot grid (base `24` px world step that doubles when screen spacing drops under `10` px and fades out under `0.50x` zoom), directed cubic Bezier edges with per-type colors and dash patterns, `Hold V` X-Ray halos, Bird's-Eye level-of-detail (LOD) cards under `0.45x` zoom, marquee box-select rectangles, and live `Alt+Drag` edge previews.
2. **Layer 2 — GPU-transformed static cards (`CardLayer` in `src/cards/CardLayer.tsx`):** Positions `.card-layer` with `transform: translate3d(x, y, 0) scale(zoom)` (`transform-origin: 0 0`) and renders only the viewport-culled `NodeCard` elements listed in `visibleNodeIds`.
3. **Layer 3 — Single live editor and ephemeral pills:** `LiveEditorOverlay` (`src/cards/LiveEditorOverlay.tsx`) mounts when `modalState` equals `"edit"`, accompanied by floating `.multi-select-pill` and `.edge-popover` controls in `src/App.tsx`.

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

## Pointer controls and direct-DOM dragging

`attachCanvasPointer` in `src/canvas/pointer.ts` handles canvas pointer and wheel interactions while ignoring events that originate inside interactive controls (`.cm-editor`, `.live-editor-overlay`, `.hover-pill`, `.edge-popover`, `.multi-select-pill`, inputs, and buttons):

| Gesture | Behavior |
| --- | --- |
| Middle-mouse drag, `Space` + left-drag, or wheel scroll | Pans the canvas (`camera.panBy`) |
| `Ctrl+Wheel` or `Meta+Wheel` | Zooms anchored at the cursor (`camera.zoomAt`) |
| Click card | Single-selects the card (`selectSingle`) |
| `Shift+Click` card | Toggles the card in multi-selection (`toggleSelect`) |
| Drag card past `4` px (`DRAG_THRESHOLD_PX`) | Multi-drags all selected cards, snaps the primary card delta to a `12` px grid (`GRID_SNAP_PX`, hold `Alt` to bypass), updates `dragOffsets` and direct DOM `style.transform` at 60 FPS, and commits one `move_nodes` batch on pointer release |
| Drag empty canvas past `4` px | Draws a marquee selection box (`overlay.marqueeWorld`) and selects intersecting cards using `viewportSpatialIndex.queryRect` on release |
| Click empty canvas | Clears selection (unless `Shift` is held) |
| `Alt+Drag` from card | Draws a live dashed Bezier preview (`overlay.edgePreviewWorld`) and opens the **References** / **Resolves** / **Derives** edge popover when released over another node |
| Double-click card | Enters Edit Mode on unlocked nodes (`enterEditMode`); see [Keyboard navigation and overlays](keyboard-navigation-and-overlays.md) for `Enter` and keyboard bindings |

## Static Markdown, math, and sanitization cache

In Navigate Mode, `NodeCard` renders static HTML through `src/cards/markdownCache.ts`. When `node.status` equals `"draft"`, `NodeCard` bypasses the 600-entry `content_hash` LRU cache and calls `renderMarkdownToSanitizedHtml(node.content)` directly so progressive streaming deltas never pollute the cache with partial hashes while still passing through DOMPurify. For all non-draft nodes, `NodeCard` calls `getRenderedMarkdown(node.content_hash, node.content)`:

1. **Math preprocessing:** `preprocessMathOutsideCode` scans the Markdown string while skipping fenced code blocks (```` ``` ```` or `~~~`), inline code spans, and escaped `\$` sequences. It renders display math (`$$...$$`) and inline math (`$...$`) with KaTeX (`throwOnError: false`) into temporary placeholders.
2. **Markdown and syntax highlighting:** `markdown-it` (`html: true`, `linkify: true`, `breaks: true`) renders the text and highlights fenced code blocks using a lightweight `highlight.js/lib/core` bundle registered with 14 languages (`typescript`, `javascript`, `rust`, `python`, `sql`, `bash`, `json`, `css`, `xml`/`html`, `c`, `cpp`, `go`, `yaml`, `markdown`).
3. **HTML sanitization:** After restoring KaTeX placeholders, the full HTML output passes through `DOMPurify.sanitize` with `DOMPURIFY_CONFIG` (allowing MathML elements plus `class` and `style` attributes) to strip `<script>`, inline event handlers, and `javascript:` URLs before `NodeCard` injects it.
4. **Content-hash LRU cache:** `getRenderedMarkdown` caches sanitized HTML keyed by `content_hash` in an LRU `Map` capped at `MAX_CACHE_ENTRIES` (`600` entries).

`NodeCard` attaches a `ResizeObserver` (`90` ms debounce) to expanded cards and calls `queueNodeResize` in `src/store/graphStore.ts`, which ignores jitter within `4` px and batches `resize_nodes` updates after `160` ms so edge endpoints and spatial indexes track rendered card heights.

## One Live Editor architecture

Axiom enforces the invariant that zero CodeMirror instances exist in the DOM outside Edit Mode:

- In Navigate Mode (`modalState === "navigate"`), `LiveEditorOverlay` returns `null`, leaving `0` `.cm-editor` elements in the DOM.
- When you trigger `enterEditMode(node)` on a `locked` node, `src/store/selection.ts` aborts editing and triggers a `240` ms `lockedShakeId` animation.
- On an unlocked node, `enterEditMode` sets `modalState` to `"edit"` and `LiveEditorOverlay` mounts one `LiveEditorInstance` clamped inside the viewport bounds with a title `<input>` and a CodeMirror 6 `EditorView` (`@codemirror/lang-markdown`, `@codemirror/commands` default and history keymaps, line wrapping, and monochrome theme).
- Pressing `Escape` inside Edit Mode saves changed text through `mutateGraphUndoable` (pre-warming `getRenderedMarkdown`), calls `exitEditMode()`, and destroys the `EditorView` (`view.destroy()`), returning the `.cm-editor` count to zero. Pressing `Ctrl/Cmd+Enter` commits edits the same way and transitions directly into `chord_a` mode on the saved node (`commitAndExit(true)`).

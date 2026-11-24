
## File: `docs/05-VV-AND-SLICES.md`

```markdown
# Vertical Slice Build Plan & Verification Matrix (V&V)
**Project:** Axiom — Infinite Canvas AI Companion
**Version:** 1.0 (MVP Baseline)
**Scope:** Strictly Sequenced Build Slices, Exit Gates, Automated Test Suites, Stress Benchmark, Requirements Traceability Matrix (RTM)

---

## 1. Vertical Slice Execution Plan

Antigravity 2.0 MUST complete and verify each slice in strict sequence. Do not start Slice N+1 until every verification check in Slice N passes with zero warnings/errors.

### Slice 0: Project Scaffold & Persistent Shell
**Deliverables:**
- Initialize Vite + Preact + TypeScript frontend and Tauri v2 Rust backend matching `docs/02-DATA-AND-ICD.md` Section 5.
- Configure locked `tauri.conf.json` CSP, `Cargo.toml`, and `package.json`.
- Implement `src-tauri/src/db/migrations.rs` (WAL pragmas, tables, indexes, column-scoped FTS5 triggers) and `error.rs`.
- Wire `open_workspace` command to create/open a default workspace (`~/.axiom/default.sqlite`) and return `WorkspaceSnapshot`.

**Exit Gate 0:**
- `cargo check` and `npm run build` succeed with zero TypeScript errors.
- Launching `tauri dev` opens a blank dark monochrome canvas window in less than 800 ms and creates a valid `.sqlite` file with `PRAGMA journal_mode` returning `wal`.

---

### Slice 1: Headless Rust Graph Engine & Context Compiler
**Deliverables:**
- Implement `graph/models.rs`, `graph/mod.rs` (HashMap + dual adjacency maps), `graph/spatial.rs` (`rstar` R-tree collision avoidance + `tidy_subtree`), and `graph/compiler.rs` (exact algorithm from `docs/03-ALGORITHMS-AND-AI.md` Section 1).
- Implement `db/queries.rs` (`apply_ops` atomic transactions, `spawn_connected_node`, `search_nodes` FTS5 + structured filters, `save_camera`).
- Implement `ai/parser.rs` (fence-aware `@@NODE` / `@@END` streaming parser).
- Implement full Rust unit test suite (`cargo test`).

**Exit Gate 1:**
- All Rust unit tests in Section 2.1 pass (`cargo test` green, 100% deterministic, zero network/GUI dependency).
- Benchmark unit test verifies `compile_context` completes in less than 5 ms and `search_nodes` in less than 15 ms on a 500-node synthetic SQLite graph.

---

### Slice 2: 3-Layer Lightweight Canvas Renderer & Single Live Editor
**Deliverables:**
- Implement `src/ipc/types.ts`, `src/ipc/client.ts`, `src/store/graphStore.ts`, `src/store/selection.ts`.
- Implement `src/canvas/camera.ts` (rAF loop, cursor-anchored zoom, Smart Fit), `src/canvas/spatialIndex.ts` (`rbush`), `src/canvas/renderer2d.ts` (procedural dot grid, Bezier edges, Bird's-Eye LOD below `0.45x`), and `src/canvas/pointer.ts` (pan, multi-drag, marquee select, `Alt+Drag` edge connect).
- Implement `src/cards/markdownCache.ts` (`markdown-it` + KaTeX + `highlight.js` + DOMPurify), `src/cards/CardLayer.tsx`, `src/cards/NodeCard.tsx`, and `src/cards/LiveEditorOverlay.tsx` (single CodeMirror 6 instance).
- Implement `src/styles/theme.css` (dark + light theme tokens).

**Exit Gate 2:**
- Vitest camera/math tests pass.
- Manual/automated verification confirms:
  - In Navigate Mode, `document.querySelectorAll('.cm-editor').length === 0`.
  - In Edit Mode (`Enter`), `document.querySelectorAll('.cm-editor').length === 1`; `Esc` returns count to `0` and persists edits across app restart.
  - Zooming below `0.45x` hides DOM cards and renders Bird's-Eye cards on `<canvas>` with zero flicker.
  - Dragging a node does NOT fire SQLite `nodes_au` FTS5 trigger.

---

### Slice 3: Modal Keyboard Engine, Context X-Ray, Undo/Redo & Command Palette
**Deliverables:**
- Implement `src/input/keymap.ts`, `src/input/topologyNav.ts` (`H/J/K/L`, `Shift+J/K`, `Tab`, `Shift+Enter`, `N`, `E`, `P`, `X`, `R`, `C`, `Shift+C`, `T`, `F`/`F F`, `Hold V`, `Esc`).
- Implement `src/store/history.ts` (100-entry invertible Undo/Redo ring buffer).
- Implement `src/overlays/XrayHud.tsx`, `src/overlays/CommandPalette.tsx` (`Cmd/Ctrl+K` with structured filters + BM25 search), and `src/overlays/ToastStack.tsx`.

**Exit Gate 3:**
- Full keyboard-only session succeeds without touching a mouse: create root -> `Tab` child -> `Shift+Enter` branch -> `P` pin root -> `X` mute intermediate node -> `Hold V` verifies green/blue/purple glows and live token counter -> `Cmd/Ctrl+K` `status:active` jumps camera -> `Cmd/Ctrl+Z` cleanly undoes delete including restored edges.

---

### Slice 4: Multi-Provider Streaming AI Runtime & Background Summarizer
**Deliverables:**
- Implement `src-tauri/src/settings.rs` (OS Keychain via `keyring` + `settings.json`).
- Implement `src-tauri/src/ai/prompts.rs` (verbatim prompts), `provider.rs` (OpenAI-compat SSE, Anthropic SSE, Ollama NDJSON), `runner.rs` (cancellable `Channel<LensStreamEvent>` streaming), and `summarizer.rs` (1,500 ms debounced utility worker with <= 160-char fast path).
- Implement `src/overlays/CustomPromptBar.tsx` (`A Space`) and `src/overlays/SettingsModal.tsx` (dual-tier config + `test_provider_connection`).
- Wire `A`-chord lenses (`A R`, `A E`, `A D`, `A F`, `A S`, `A Space`), Loophole Triage Loop, and `Esc` mid-stream cancellation.

**Exit Gate 4:**
- Mock HTTP SSE server integration tests verify OpenAI-compat, Anthropic, and Ollama stream parsing, multi-card `Diverge 3x` non-overlapping placement, `Esc` mid-stream cancellation persisting partial tokens, and `axiom://summary-updated` event delivery.
- Live test with configured provider confirms end-to-end streaming into pulsing skeleton cards without locking canvas pan/zoom.

---

### Slice 5: Hardening, Portability & 500-Node Performance Sign-Off
**Deliverables:**
- Implement `src-tauri/src/db/json_io.rs` (`export_json` / `import_json` deterministic sorted JSON) + file dialog wiring (`tauri-plugin-dialog`) in Command Palette (`> Export JSON`, `> Import JSON`, `> Open Workspace`, `> New Workspace`, `> Toggle Theme`).
- Add a dev-only synthetic graph generator (`--seed-stress-500` or Command Palette dev command) creating 500 nodes + 700 edges (mixed types, diamond merges, active loopholes, KaTeX + code blocks).
- Run full V&V RTM checklist and resolve any performance or accessibility regressions.

**Exit Gate 5:**
- Sustained >= 60 FPS pan/zoom/drag on the 500-node stress workspace (verified via `performance.now()` frame-time overlay: p95 frame time <= 16.6 ms).
- Idle RSS memory < 120 MB on the 500-node workspace in Navigate Mode.
- Exported JSON re-imported into a fresh `.sqlite` workspace yields byte-identical re-export (idempotent round-trip).
- Release build (`tauri build`) completes cleanly with binary footprint < 25 MB.

---

## 2. Mandatory Automated Test Specifications

### 2.1 Rust Unit & Integration Tests (`cargo test`)
Antigravity 2.0 MUST implement and pass every test case below:

| Test ID | Target Module | Scenario & Assertion |
| :--- | :--- | :--- |
| `UT-RS-01` | `db::migrations` | Opening DB enables `WAL`, `foreign_keys = ON`, and creates `nodes_fts`. Deleting a node cascades all incident edges and removes FTS5 row. |
| `UT-RS-02` | `db::queries` | `MoveNodes` updating `(x, y)` does NOT increment FTS5 shadow table writes or alter `content_hash` / `updated_at` semantics improperly; `CreateEdge(Resolves)` auto-flips target loophole `status` to `Resolved`. |
| `UT-RS-03` | `db::queries` | `search_nodes` correctly combines `status:active type:loophole` with free-text BM25 ranking and rejects/sanitizes malformed FTS5 punctuation (`"foo:(bar"`). |
| `UT-RS-04` | `graph::compiler` | **Sibling Isolation:** Two branches `B1` and `B2` under parent `P`; compiling from `B1` includes `P` and `B1`, strictly excludes `B2`. |
| `UT-RS-05` | `graph::compiler` | **Diamond DAG Deduplication:** `Root -> A -> Merge`, `Root -> B -> Merge`; compiling from `Merge` emits `Root` exactly once BEFORE `A` and `B`. |
| `UT-RS-06` | `graph::compiler` | **Cycle Safety:** Manually wired cycle `A -> B -> C -> A` terminates in < 1 ms and emits all nodes deterministically without panic or infinite loop. |
| `UT-RS-07` | `graph::compiler` | **Exclude Pass-Through:** `Root -> Mid(exclude=true) -> Leaf`; compiling from `Leaf` includes `Root` and omits `Mid` from prompt text. |
| `UT-RS-08` | `graph::compiler` | **Distance Decay Budget:** 5-level chain with `token_budget` tight enough for depth 0-2 full only; verifies depth 0-1 full, depth 2 full, depth 3-4 degraded to `summary` and tagged `InclusionMode::Summary` in `xray`. |
| `UT-RS-09` | `graph::compiler` | **Loophole Propagation & Global Pin:** Active `challenges` on ancestor appears in `[UNRESOLVED LOOPHOLES]`; `resolved` or `dismissed` loophole is omitted; `pin_global` node hoisted into `[GLOBAL CONSTRAINTS]` even if disconnected. |
| `UT-RS-10` | `graph::compiler` | **One-Hop Reference:** Focus `references` node `R` which has parent `R_parent`; `R` summary is included, `R_parent` is NOT traversed. |
| `UT-RS-11` | `graph::spatial` | **R-Tree Non-Overlap:** Spawning 10 sequential children and 3 `Diverge` siblings + 4 `Red-Team` loopholes yields zero pairwise AABB intersections. |
| `UT-RS-12` | `graph::spatial` | **Tidy Subtree:** `tidy_subtree` leaves `root_id` stationary, aligns descendants left-to-right, puts `Probe` above and `Loophole` below, and avoids overlapping an external neighboring node. |
| `UT-RS-13` | `ai::parser` | **Multi-Card & Chunk Splitting:** Feeding 3 `@@NODE` blocks split across arbitrary 3-byte chunk boundaries spawns 3 exact nodes with escaped quotes in `title`. |
| `UT-RS-14` | `ai::parser` | **Fence Immunity:** A literal `@@NODE type=core title="fake"` inside a triple-backtick code fence does NOT split the active card. |
| `UT-RS-15` | `ai::parser` | **Protocol Violation Fallback:** Plain prose with zero `@@NODE` headers auto-spawns 1 fallback card using `LensDefaults` and preserves 100% of text. |
| `UT-RS-16` | `db::json_io` | **Deterministic Round-Trip:** `export_json` -> `import_json` -> `export_json` produces identical output (excluding `exported_at` timestamp). |

### 2.2 Frontend Vitest Suite (`npm test`)

| Test ID | Target Module | Scenario & Assertion |
| :--- | :--- | :--- |
| `UT-TS-01` | `canvas/camera` | `screenToWorld(worldToScreen(p))` round-trips within `1e-6`; cursor-anchored zoom preserves world point under mouse coordinates. |
| `UT-TS-02` | `cards/markdownCache` | Renders KaTeX math and code blocks; DOMPurify strips `<script>`, `onerror=`, and `javascript:` XSS vectors completely. |
| `UT-TS-03` | `store/history` | Push -> Undo -> Redo across `CreateNode`, `UpdateNodeText`, `MoveNodes`, and `DeleteNodes` (with restored edges); enforces capacity 100 ring eviction. |
| `UT-TS-04` | `input/keymap` | Modal isolation: typing `h`, `j`, `a`, `d` in `Edit` mode triggers zero graph actions; `A` followed by `R` within 1500 ms dispatches `RedTeam`; `A` timeout resets cleanly to `Navigate`. |
| `UT-TS-05` | `input/topologyNav` | `H/J/K/L` navigates parent, child, and `y`-sorted siblings deterministically; `H` on a `loophole` returns to its challenged target. |

---

## 3. Requirements Traceability Matrix (RTM)

| Req ID | Summary | Implementing Module(s) | Verification |
| :--- | :--- | :--- | :--- |
| `FR-GRAPH-01..04` | 5 node types, statuses, severity accents, lock guard | `graph/models.rs`, `db/queries.rs`, `NodeCard.tsx` | `UT-RS-01`, Slice 2/3 Gate |
| `FR-GRAPH-05..07` | 6 edge types, uniqueness, cascade delete | `db/migrations.rs`, `db/queries.rs` | `UT-RS-01`, `UT-RS-02` |
| `FR-GRAPH-08` | Auto 2-sentence summary + BLAKE3 hash tracking | `ai/summarizer.rs`, `db/queries.rs` | Slice 4 Gate |
| `FR-GRAPH-09` | 100-level Undo/Redo ring buffer | `store/history.ts`, `ipc/commands.rs` | `UT-TS-03`, Slice 3 Gate |
| `FR-NAV-01..02` | Infinite canvas, dot grid, Semantic Zoom (`0.45x`) | `canvas/camera.ts`, `renderer2d.ts`, `CardLayer.tsx` | `UT-TS-01`, Slice 2 Gate |
| `FR-NAV-03..05` | 3-state modal UX, `H/J/K/L`, `Tab`, `Shift+Enter`, `N` | `input/keymap.ts`, `topologyNav.ts` | `UT-TS-04`, `UT-TS-05` |
| `FR-NAV-06..09` | R-tree placement, Smart Fit (`F`), Tidy (`T`), Collapse (`C`) | `graph/spatial.rs`, `camera.ts` | `UT-RS-11`, `UT-RS-12` |
| `FR-NAV-10` | `Cmd/Ctrl+K` FTS5 + structured filter jumper | `db/queries.rs`, `CommandPalette.tsx` | `UT-RS-03`, Slice 3 Gate |
| `FR-CTX-01..08` | DAG compiler, diamond dedup, cycles, decay, loopholes, refs | `graph/compiler.rs` | `UT-RS-04` through `UT-RS-10` |
| `FR-CTX-09` | `Hold V` X-Ray canvas glow + live token HUD | `compiler.rs`, `renderer2d.ts`, `XrayHud.tsx` | Slice 3 Gate |
| `FR-AI-01..02` | OpenAI/Anthropic/Ollama SSE + Dual-tier model config | `ai/provider.rs`, `settings.rs`, `SettingsModal.tsx` | Slice 4 Gate |
| `FR-AI-03..05` | 5 `A`-chord lenses + Custom, `@@NODE` streaming, `Esc` cancel | `ai/prompts.rs`, `parser.rs`, `runner.rs` | `UT-RS-13..15`, Slice 4 Gate |
| `FR-AI-06` | Debounced background summarizer | `ai/summarizer.rs` | Slice 4 Gate |
| `FR-PERSIST-01..03` | SQLite WAL, camera restore, deterministic JSON I/O | `db/mod.rs`, `db/json_io.rs` | `UT-RS-01`, `UT-RS-16` |
| `NFR-PERF-01..04` | >= 60 FPS (500 nodes), < 5ms compile, < 15ms search, < 800ms boot | `renderer2d.ts`, `compiler.rs`, `db/migrations.rs` | Slice 1 & Slice 5 Gates |
| `NFR-FOOT-01..02` | < 25 MB release bundle, < 120 MB RSS at 500 nodes | Tauri v2 + Preact + One Live Editor | Slice 5 Gate |
| `NFR-UX-01` | >= 95% canvas viewport at rest, zero persistent sidebars | `App.tsx`, `theme.css` | Slice 2 & Slice 5 Gates |
| `NFR-REL-01` | WAL crash durability after committed `apply_ops` | `db/mod.rs`, `db/queries.rs` | `UT-RS-01`, Slice 5 Gate |
| `NFR-SEC-01..02` | OS Keychain secrets, DOMPurify sanitization, locked CSP | `settings.rs`, `markdownCache.ts`, `tauri.conf.json` | `UT-TS-02`, Slice 4 Gate |

```

---
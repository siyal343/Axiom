# Axiom

Axiom is a local-first desktop application that pairs an infinite spatial canvas with a deterministic context compiler for system design and engineering. You organize ideas, branches, failure modes, and syntheses as a directed graph on disk, and Axiom compiles focused graph subgraphs into structured context within a token budget.

## Architecture overview

Axiom separates persistent graph truth, layout math, and rendering across a Rust back end and a TypeScript front end connected through Tauri v2 IPC.

### Rust back end

The Rust crate under `src-tauri/src/` owns persistence, spatial layout, context compilation, AI streaming, settings, and background summarization:

- **Storage and migrations (`src-tauri/src/db/`):** Opens local SQLite databases in write-ahead logging (WAL) mode with foreign-key enforcement and an external-content FTS5 full-text search index, executes atomic `apply_ops` transactions, updates stale summaries, persists camera coordinates, and runs deterministic JSON export and import.
- **Graph engine and context compiler (`src-tauri/src/graph/`):** Maintains the in-memory `GraphEngine`, enforces node and edge invariants, computes collision-free placements and `tidy_subtree` layouts with an `rstar` 2D R-tree, and executes `compile_context` for deterministic prompt and X-Ray assembly.
- **AI streaming and summarization (`src-tauri/src/ai/`):** Embeds lens and utility prompts (`prompts.rs`), streams `OpenaiCompat`, `Anthropic`, and `Ollama` responses (`provider.rs`), parses `@@NODE` and `@@END` frames (`parser.rs`), executes cancellable lens runs (`runner.rs`), and runs the debounced background summarizer (`summarizer.rs`).
- **Settings and OS keychain (`src-tauri/src/settings.rs`):** Persists non-secret workspace and tier settings in `settings.json` while storing API keys in the OS keychain (`"dev.axiom.canvas"`).
- **IPC boundary (`src-tauri/src/ipc/`):** Exposes typed Tauri commands (`open_workspace`, `apply_ops`, `spawn_connected_node`, `compile_xray`, `search_nodes`, `tidy_subtree`, `save_camera`, `export_json`, `import_json`, `run_lens`, `cancel_run`, `get_settings`, `save_settings`, `test_provider_connection`) backed by `AppState` and structured `IpcError` codes.

### TypeScript front end

The front end under `src/` separates a 60–120 FPS canvas loop from Preact UI state:

- **Camera and Canvas2D renderer (`src/canvas/`):** Runs a `requestAnimationFrame` camera loop (`CanvasCameraController`) that draws the dot grid, directed cubic Bezier edges, X-Ray halos, marquee selection boxes, edge previews, and Bird's-Eye level-of-detail (LOD) cards under `0.45x` zoom directly onto a single `<canvas>` element.
- **Viewport culling and pointer gestures (`src/canvas/spatialIndex.ts`, `src/canvas/pointer.ts`):** Uses `rbush` to cull off-screen DOM cards, supports grid-snapped multi-node dragging without Preact re-renders, and handles marquee selection and `Alt+Drag` edge creation.
- **Static cards and single live editor (`src/cards/`):** Renders visible cards with a `content_hash`-keyed LRU cache (bypassing the cache for streaming `draft` cards) backed by `markdown-it`, KaTeX, `highlight.js`, and DOMPurify, while mounting at most one CodeMirror 6 `LiveEditorOverlay` instance during editing.
- **Modal keyboard router and overlays (`src/input/`, `src/overlays/`):** Enforces strict modal isolation (`navigate`, `edit`, `command`, `chord_a`, `connect_edge`), topological `H/J/K/L` navigation, `Hold V` X-Ray HUD, `Cmd/Ctrl+K` Command Palette, `CustomPromptBar`, `SettingsModal`, and ephemeral toast notifications.
- **Client state and AI runner (`src/store/`):** Stores `nodesMap`, `edgesMap`, `cardDomRefs`, and `dragOffsets` outside `@preact/signals` so pan, zoom, and drag loops never trigger framework re-renders, alongside the 100-entry `UndoRedoHistory` ring buffer and frame-coalesced `aiRunner.ts` stream handlers.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src-tauri/src/` | Rust back end: SQLite persistence (`db/`, including `stress.rs`), graph engine, `rstar` spatial math, context compiler, AI streaming runtime (`ai/`), settings (`settings.rs`), and Tauri commands (`ipc/`) |
| `src-tauri/tests/` | Rust integration and benchmark test suites (`slice1_suite.rs`, `slice4_suite.rs`, `slice5_suite.rs`) |
| `src/canvas/` | Camera math, `requestAnimationFrame` controller, Canvas2D renderer, pointer gestures, `rbush` spatial index, and frame-time telemetry (`perfMetrics.ts`) |
| `src/cards/` | `CardLayer`, `NodeCard`, `LiveEditorOverlay` (CodeMirror 6), and sanitized Markdown/KaTeX cache |
| `src/input/` | Modal keyboard router (`keymap.ts`) and deterministic topological navigation helpers (`topologyNav.ts`) |
| `src/ipc/` | Typed Tauri IPC client wrappers, native dialog workspace actions (`workspaceActions.ts`), channel listeners, and shared TypeScript DTO definitions |
| `src/overlays/` | `XrayHud`, `PerfHud`, `CommandPalette`, `CustomPromptBar`, `SettingsModal`, and `ToastStack` overlays |
| `src/store/` | Non-reactive graph maps, Preact signals for selection and UI state, 100-entry undo/redo history, AI stream coordinator (`aiRunner.ts`), and local fallback mutations |
| `src/styles/` | Dark and light CSS custom properties and component layout styles (`theme.css`) |
| `docs/features/` | Feature-level technical documentation for implemented subsystems |

## Set up prerequisites

To develop and build Axiom locally, you must install the following tools:

- Node.js 22 and npm (aligned with `.github/workflows/ci.yml`).
- Rust stable toolchain with `cargo` and `clippy`.
- Tauri v2 system prerequisites for Windows (Microsoft Edge WebView2 runtime and the Microsoft C++ Build Tools).

## Build and test commands

Run front-end commands from the repository root and Rust commands against `src-tauri/Cargo.toml`:

1. Install front-end dependencies:

   ```bash
   npm ci
   ```

2. Run the Vite development server or full Tauri desktop window:

   ```bash
   npm run dev
   npx tauri dev
   ```

3. Typecheck and build the front-end bundle into `dist/`:

   ```bash
   npm run build
   ```

4. Run front-end unit and invariant tests with Vitest:

   ```bash
   npm test
   ```

5. Run Rust compilation checks, lints, and unit tests:

   ```bash
   cargo check --manifest-path src-tauri/Cargo.toml
   cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
   cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture
   ```

6. Build the release desktop bundle:

   ```bash
   npx tauri build
   ```

## Continuous integration workflow

The GitHub Actions workflow in `.github/workflows/ci.yml` runs on `windows-latest` for every `push`, `pull_request`, and manual `workflow_dispatch` trigger, canceling superseded runs on the same ref:

1. **`windows-check-and-test`:** Installs Node.js 22 and npm packages, runs `npm run build` and `npm test -- --passWithNoTests`, configures stable Rust with `clippy`, restores `src-tauri` Cargo caches, and runs `cargo check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test -- --nocapture`.
2. **`windows-tauri-build`:** Runs after `windows-check-and-test` passes, builds the release installer with `npx tauri build`, prints the `axiom-canvas.exe` binary size, and uploads both `src-tauri/target/release/bundle/**` as the `axiom-bundle-windows-latest` artifact and `src-tauri/target/release/axiom-canvas.exe` as the `axiom-portable-windows-latest` artifact.

## Feature guides

Read the following guides for implementation details on each subsystem:

- [Workspace persistence](docs/features/workspace-persistence.md): SQLite WAL schema, FTS5 indexing triggers, atomic `apply_ops` batches, camera persistence, and deterministic JSON export and import.
- [Graph engine and context compiler](docs/features/graph-engine-and-context-compiler.md): Node and edge semantics, `rstar` R-tree layout and `tidy_subtree`, deterministic `compile_context`, structured FTS5 search, and the fence-aware stream parser.
- [Canvas rendering and editor](docs/features/canvas-rendering-and-editor.md): Three-layer rendering architecture, `requestAnimationFrame` camera loop, `0.45x` Bird's-Eye LOD cutoff, `rbush` culling, pointer interactions, and the single CodeMirror 6 editor overlay.
- [Keyboard navigation and overlays](docs/features/keyboard-navigation-and-overlays.md): Modal keyboard router, topological navigation, `Hold V` X-Ray HUD, 100-entry undo/redo history, Command Palette, and toast stack.
- [AI streaming and settings](docs/features/ai-streaming-and-settings.md): OS keychain credentials, multi-tier settings, multi-provider streaming adapters, AI lens execution, and debounced background summarization.
- [Portability and stress testing](docs/features/portability-and-stress-testing.md): Pre-import JSON validation, native file dialogs, Command Palette `>` actions, dev-only 500-node stress generator, and `PerfHud` telemetry.
- [Verification and RTM sign-off](docs/VV-SIGNOFF.md): Windows CI baseline, performance and footprint summary, architectural invariants audit, test coverage, and full Requirements Traceability Matrix.

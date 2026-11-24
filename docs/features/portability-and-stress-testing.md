# Portability and stress testing

Axiom supports validated JSON workspace import and export through native OS file dialogs, a Command Palette action mode, a dev-only 500-node and 700-edge benchmark generator, and a non-reactive frame-time telemetry overlay.

## Pre-import validation and database safety

`src-tauri/src/db/json_io.rs` guards workspace imports by running `validate_workspace_json` on the parsed `AxiomWorkspaceJson` payload before deleting or replacing any destination `.sqlite`, `-wal`, or `-shm` files on disk.

`validate_workspace_json` rejects malformed imports with structured `IpcError` codes:

- **Format and version check:** Requires `format` equal to `"axiom-workspace"` and `version` equal to `1` (`VALIDATION_ERROR`).
- **Node identity uniqueness:** Rejects empty or duplicate `node.id` values (`VALIDATION_ERROR`).
- **Edge integrity:** Rejects empty or duplicate `edge.id` values, self-loops (`source_id == target_id`), and edges whose `source_id` or `target_id` is missing from `doc.nodes` (`VALIDATION_ERROR`).
- **Duplicate triple guard:** Rejects duplicate `(source_id, target_id, edge_type)` triples (`DUPLICATE_EDGE`).

If any check fails, `import_json` returns the error immediately and leaves the target SQLite database intact.

## Native file dialogs and workspace actions

`src/ipc/workspaceActions.ts` pairs `@tauri-apps/plugin-dialog` (`open` and `save` APIs authorized by `"dialog:default"` in `src-tauri/capabilities/default.json`) with Command Palette `>` actions in `src/overlays/CommandPalette.tsx`.

| Command label | Category | Behavior |
| --- | --- | --- |
| **> Export JSON** | Workspace | Opens a native save dialog (`*.json`) and runs `exportJson` |
| **> Import JSON** | Workspace | Opens a JSON file picker, prompts for a destination `.sqlite` path, runs `importJson`, and loads the returned snapshot |
| **> Open Workspace** | Workspace | Opens a saved `.sqlite` or `.db` file through `openWorkspace` and loads it |
| **> New Workspace** | Workspace | Prompts for a destination `.sqlite` file path and initializes a seeded workspace through `openWorkspace` |
| **> Toggle Theme** | Appearance | Switches `theme` between `"dark"` and `"light"` and persists the selection through `getSettings` and `saveSettings` in the desktop runtime |
| **> Settings** | Preferences | Opens **Settings** (`openSettingsModal`) |
| **> Toggle Perf HUD** | Diagnostics | Toggles `perfHudOpen` to show or hide the performance overlay |
| **> Seed Stress 500** | Dev | Available only when `import.meta.env.DEV` is true; seeds the 500-node benchmark graph and opens the performance overlay |

Canceling any native open or save dialog returns control cleanly with no error toast. Invoking file-system actions outside the Tauri desktop runtime displays a warning toast.

## Dev-only 500-node and 700-edge stress generator

`src-tauri/src/db/stress.rs` generates a deterministic `500`-node, `700`-edge graph (`generate_stress_graph_500`) to benchmark spatial culling, Canvas2D rendering, context compilation, and FTS5 search without shipping test fixtures in release builds.

### Generated graph anatomy

- **Grid layout and mixed node states:** Places `500` nodes in 20-row columns (`420.0` px column step, `240.0` px row step) across all five `NodeType` variants (`core`, `branch`, `loophole`, `probe`, `synthesis`), mixed `NodeStatus` states (`active`, `resolved`, `dismissed`, `locked`, `draft`), `Severity` tags, `pin_global` pins, `exclude_from_ai` flags, `collapsed` cards, inline and display KaTeX math, and fenced Rust, TypeScript, and SQL code blocks.
- **Typed edge topology:** Builds `700` unique edges combining a 499-edge directed acyclic graph (DAG) backbone, diamond multi-parent `synthesizes` merges, `resolves` edges targeting loopholes, and cross-track `references` links.

### Development triggers and release guard

- **CLI flag:** Passing `--seed-stress-500` at startup sets `AppState.seed_stress_on_open` when `cfg!(debug_assertions)` is true (`src-tauri/src/lib.rs`), replacing the opened workspace with the seeded graph inside `open_workspace`.
- **IPC command:** `seed_stress_500` in `src-tauri/src/ipc/commands.rs` replaces the active workspace in an atomic immediate transaction (`seed_stress_500_into_workspace`), guarded by `cfg!(debug_assertions) || cfg!(test)` so release builds return `VALIDATION_ERROR`. In browser dev mode without Tauri, `runSeedStress500Action` uses `buildLocalStress500Snapshot`.

## Non-reactive frame-time telemetry and Perf HUD

`FrameTimeTracker` in `src/canvas/perfMetrics.ts` records frame draw timings without introducing Preact signal allocations into the render loop.

- **Ring-buffer tracking:** `globalFrameTracker` stores `120` samples (`DEFAULT_RING_CAPACITY = 120`) in pre-allocated `Float64Array` buffers (`drawSamples` and `intervalSamples`) and computes `fps`, `avgDrawMs`, `p95DrawMs`, and `p95IntervalMs` on demand.
- **Zero-signal camera hook:** In `src/App.tsx`, `CanvasCameraController` invokes `onFrameSample(drawMs, intervalMs)` at the end of `flushFrame()` (`src/canvas/camera.ts`), calling `globalFrameTracker.record(drawMs, intervalMs)` without writing to any Preact signal.
- **Polled overlay:** `PerfHud` (`src/overlays/PerfHud.tsx`) mounts only when `perfHudOpen` is true and polls `globalFrameTracker.getStats()` every `250` ms (`POLL_INTERVAL_MS`) to display **FPS**, **p95 draw**, **Graph** node and edge counts, **DOM cards** (`visibleNodeIds.value.length`), and **LOD** mode (**Normal** or **Bird's-Eye**).

## Verification suites

Automated tests validate portability, 500-node scaling, and Command Palette actions across both runtimes:

- **`src-tauri/tests/slice5_suite.rs`:** Verifies that `generate_stress_graph_500` produces `500` nodes and `700` edges, tests `compile_context` (`< 5` ms budget) and `search_nodes` (`< 15` ms budget), verifies `validate_workspace_json` rejection without modifying target SQLite files, and checks round-trip JSON determinism.
- **`src/canvas/__tests__/stress500.test.ts`:** Verifies `rbush` viewport culling, renders `120` pan and zoom frames across `1.0x` and `0.30x` zoom within a `16.6` ms p95 budget, and confirms zero `.node-card` DOM elements under `0.45x` Bird's-Eye LOD.
- **`src/overlays/__tests__/commandPalette.test.tsx`:** Verifies `>` action filtering, keyboard navigation, **> Toggle Theme**, **> Toggle Perf HUD**, and **> Settings**.

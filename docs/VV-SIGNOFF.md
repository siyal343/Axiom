# Verification and requirements traceability sign-off

This record summarizes the automated verification baseline and Requirements Traceability Matrix (RTM) for Axiom across Slices 0 through 5. Every automated measurement in this document comes from headless Windows continuous integration (CI) execution, and all interactive WebView2 and live cloud-provider checks are separated into a pending desktop verification checklist.

## Continuous integration baseline

- **Repository commit:** `985db543685159733ec62f026059f511b03b6f7e`
- **GitHub Actions workflow run:** [`45418137294`](https://github.com/siyal343/Axiom/actions/runs/45418137294) on `windows-latest`
- **`windows-check-and-test` (`2m49s`):**
  - `npm run build`: Completed in `3.36` s (`dist/assets/index-IAkvtANk.js` at `1,094.67` kB / `374.51` kB gzip; `dist/assets/index-BvRZPypo.css` at `48.68` kB / `12.09` kB gzip).
  - `vitest run --passWithNoTests`: `9` test files, `22` tests passed, `0` failed.
  - `cargo clippy --all-targets -- -D warnings`: Completed in `5.79` s with `0` warnings.
  - `cargo test -- --nocapture`: `29` tests passed, `0` failed.
- **`windows-tauri-build` (`4m12s`):**
  - `Axiom_0.1.0_x64_en-US.msi`: `6.46` MiB.
  - `Axiom_0.1.0_x64-setup.exe`: `4.93` MiB.
  - `axiom-canvas.exe`: `16,327,680` bytes (approximately `15.57` MiB).
  - Uploaded workflow artifact `axiom-bundle-windows-latest` (`Artifact ID 14931219424`, `11,713,973` bytes).

## Performance and footprint summary

Headless benchmarks use synthetic 500-node and 700-edge graphs in Rust (`slice1_suite.rs`, `slice5_suite.rs`) and jsdom with a mock Canvas2D context (`stress500.test.ts`). Interactive desktop GPU, memory, and layout measurements require manual verification on a Windows desktop session.

| Metric | Target budget | Observed value | Verification status |
| --- | --- | --- | --- |
| Context compilation (`500` nodes, `700` edges) | `< 5` ms | `258.1` µs (`slice1_suite.rs`); `1.240` ms (`slice5_suite.rs`) | Measured (Windows CI) |
| Hybrid FTS5 node search (`500` nodes) | `< 15` ms | `1.4813` ms (`slice1_suite.rs`); `3.033` ms (`slice5_suite.rs`) | Measured (Windows CI) |
| Workspace cold open (`500` nodes, `700` edges) | `< 800` ms | `13.72` ms (`slice5_suite.rs`) | Measured (Windows CI) |
| Canvas2D frame draw (`500` nodes, `120` frames) | `<= 16.6` ms p95 (`60` FPS) | `1.719` ms p95 draw, `1.235` ms avg draw (mock Canvas2D + jsdom) | Measured (Windows CI) |
| Release binary size (`axiom-canvas.exe`) | `< 25` MB | `16,327,680` bytes (~`15.57` MiB) | Measured (Windows CI) |
| Interactive WebView2 pan/zoom/drag frame rate | `>= 60` FPS (`<= 16.6` ms p95) in **Perf HUD** | Not measured in headless CI | Pending Live Desktop QA |
| Idle WebView2 RSS memory (`500` nodes) | `< 120` MB | Not measured in headless CI | Pending Live Desktop QA |
| Viewport chrome footprint at rest | `< 5%` chrome (`>= 95%` canvas) | Not measured in headless CI | Pending Live Desktop QA |
| Live cloud LLM SSE streaming (`OpenaiCompat`, `Anthropic`, `Ollama`) | End-to-end streaming without UI stall | Verified against local `TcpListener` mocks in `slice4_suite.rs` | Pending Live Desktop QA |

## Architectural invariants audit

| Invariant | Implementation evidence | Automated verification |
| --- | --- | --- |
| One live editor rule | `LiveEditorOverlay` returns `null` outside `"edit"` mode; `enterEditMode` rejects `locked` nodes and mounts one CodeMirror 6 `EditorView` | `src/cards/__tests__/invariants.test.tsx`, `src/input/__tests__/keymap.test.ts` |
| Decoupled `60–120` FPS camera loop | `nodesMap`, `edgesMap`, `cardDomRefs`, and `dragOffsets` live outside `@preact/signals`; `CanvasCameraController.flushFrame` updates `<canvas>` and DOM transforms directly | `src/canvas/camera.ts`, `src/canvas/pointer.ts`, `src/canvas/perfMetrics.ts` |
| Bird's-Eye LOD cutoff (`0.45x`) | When `cam.zoom < 0.45`, `visibleNodeIds` clears to `[]`, `CardLayer` returns `null`, and `renderCanvas2d` draws Bird's-Eye cards | `src/cards/__tests__/invariants.test.tsx`, `src/canvas/__tests__/stress500.test.ts` |
| Single-source context compiler | Both `compile_xray` and `execute_lens_run` (`prepare_lens_context`) call `graph::compiler::compile_context` | `src-tauri/tests/slice1_suite.rs` (`ut_rs_04` through `ut_rs_10`) |
| Streaming framing immunity | `NodeStreamParser` parses line-delimited `@@NODE` / `@@END` frames, ignores headers inside code fences, and falls back after `120` bytes or two newlines | `src-tauri/tests/slice1_suite.rs` (`ut_rs_13`, `ut_rs_14`, `ut_rs_15`) |
| Atomic local persistence and FTS5 immunity | `apply_ops` runs inside `TransactionBehavior::Immediate` before updating `GraphEngine`; `nodes_au` scopes to `title, content, summary` | `src-tauri/src/db/mod.rs`, `src-tauri/tests/slice1_suite.rs` (`ut_rs_01`, `ut_rs_02`) |

## Automated test coverage

### Rust unit and integration suite

All `29` Rust tests passed in CI run `45418137294`:

| Suite file | Test count | Covered scenarios |
| --- | --- | --- |
| `src-tauri/src/db/mod.rs` (invoked from `src-tauri/src/lib.rs`) | `2` | `open_enables_wal_fk_fts5_and_seeds_starter_node`, `move_node_coordinates_does_not_fire_fts_update_trigger` |
| `src-tauri/tests/slice1_suite.rs` | `17` | `ut_rs_01` through `ut_rs_16` (migrations, cascade deletes, `MoveNodes` FTS5 immunity, `resolves` auto-flip, lock guard, BM25 + query sanitization, compiler sibling/diamond/cycle/exclude/decay/loophole/reference rules, `rstar` non-overlap, `tidy_subtree`, `NodeStreamParser` chunk splitting/fences/fallback, JSON round-trip) and `bench_500_node_compile_and_search` |
| `src-tauri/tests/slice4_suite.rs` | `7` | `openai_sse_diverge_3x_spawns_non_overlapping_branches_and_persists`, `anthropic_sse_red_team_checks_headers_and_challenges_direction`, `ollama_ndjson_feynman_places_probe_above_and_derives_from_focus`, `mid_stream_cancellation_persists_partial_text_and_emits_cancelled`, `http_error_status_maps_to_structured_ipc_errors`, `summarizer_fast_path_llm_path_and_stale_hash_abort`, `settings_store_never_writes_api_keys_to_json` |
| `src-tauri/tests/slice5_suite.rs` | `3` | `stress_500_generator_produces_exact_500_nodes_700_edges_and_passes_budgets`, `stress_500_json_export_import_round_trip_is_byte_identical`, `import_json_rejects_invalid_payload_without_clobbering_existing_db` |

### TypeScript Vitest suite

All `22` tests across `9` Vitest files passed in CI run `45418137294`:

| Test file | Test count | Duration | Covered ID and scope |
| --- | --- | --- | --- |
| `src/canvas/__tests__/camera.test.ts` | `4` | `5` ms | `UT-TS-01`: `worldToScreen` / `screenToWorld` round-trip, `zoomAtCursor`, `clampZoom`, `computeFitTransform` |
| `src/cards/__tests__/markdownCache.test.ts` | `3` | `576` ms | `UT-TS-02`: KaTeX math, `highlight.js` blocks, DOMPurify XSS stripping, 600-entry LRU cache |
| `src/cards/__tests__/invariants.test.tsx` | `1` | `397` ms | One Live Editor (`0` -> `1` -> `0` `.cm-editor` instances), `locked` guard, `0` `.node-card` elements in Bird's-Eye LOD |
| `src/store/__tests__/history.test.ts` | `2` | `9` ms | `UT-TS-03`: 100-entry ring capacity, undo/redo across create/edit/move/delete including restored edges |
| `src/input/__tests__/keymap.test.ts` | `3` | `12` ms | `UT-TS-04`: `edit` mode isolation, `A -> R` chord dispatch, `1500` ms chord timeout |
| `src/input/__tests__/topologyNav.test.ts` | `3` | `6` ms | `UT-TS-05`: `H/J/K/L` parent, child, and `y`-sorted sibling traversal, `loophole` parent jump |
| `src/store/__tests__/aiRunner.test.ts` | `4` | `11` ms | Grouped AI run undo/redo, `red_team` triage focus and banner, `PROVIDER_AUTH` **Open Settings** toast, silent `applySummaryUpdate` |
| `src/canvas/__tests__/stress500.test.ts` | `1` | `171` ms | `500`-node / `700`-edge `rbush` culling, `120`-frame `FrameTimeTracker` p95 draw check, Bird's-Eye LOD check |
| `src/overlays/__tests__/commandPalette.test.tsx` | `1` | `806` ms | `>` Action Mode filtering, keyboard wrapping, **> Toggle Theme**, **> Toggle Perf HUD**, **> Settings** |

## Requirements traceability matrix

| Req ID | Summary | Implementing modules | Verification evidence |
| --- | --- | --- | --- |
| `FR-GRAPH-01..04` | Five node types, statuses, severity accents, lock guard | `src-tauri/src/graph/models.rs`, `src-tauri/src/db/queries.rs`, `src/cards/NodeCard.tsx` | `ut_rs_01`, `ut_rs_02`, `invariants.test.tsx` |
| `FR-GRAPH-05..07` | Six edge types, uniqueness, cascade delete, `resolves` auto-flip | `src-tauri/src/db/migrations.rs`, `src-tauri/src/db/queries.rs` | `ut_rs_01`, `ut_rs_02` |
| `FR-GRAPH-08` | Auto two-sentence summary and BLAKE3 hash tracking | `src-tauri/src/ai/summarizer.rs`, `src-tauri/src/db/queries.rs` | `summarizer_fast_path_llm_path_and_stale_hash_abort`, `aiRunner.test.ts` |
| `FR-GRAPH-09` | 100-level undo and redo ring buffer | `src/store/history.ts`, `src/store/graphStore.ts` | `history.test.ts` (`UT-TS-03`), `aiRunner.test.ts` |
| `FR-NAV-01..02` | Infinite canvas, dot grid, Semantic Zoom (`0.45x` LOD) | `src/canvas/camera.ts`, `src/canvas/renderer2d.ts`, `src/cards/CardLayer.tsx` | `camera.test.ts` (`UT-TS-01`), `invariants.test.tsx`, `stress500.test.ts` |
| `FR-NAV-03..05` | Five-state modal router (`navigate`, `edit`, `command`, `chord_a`, `connect_edge`), `H/J/K/L`, `Tab`, `Shift+Enter`, `N` | `src/input/keymap.ts`, `src/input/topologyNav.ts`, `src/store/selection.ts` | `keymap.test.ts` (`UT-TS-04`), `topologyNav.test.ts` (`UT-TS-05`) |
| `FR-NAV-06..09` | `rstar` placement, Smart Fit (`F`), Tidy (`T`), Collapse (`C`) | `src-tauri/src/graph/spatial.rs`, `src/canvas/camera.ts` | `ut_rs_11`, `ut_rs_12`, `camera.test.ts` |
| `FR-NAV-10` | `Cmd/Ctrl+K` FTS5 and structured filter jumper | `src-tauri/src/db/queries.rs`, `src/overlays/CommandPalette.tsx` | `ut_rs_03`, `commandPalette.test.tsx` |
| `FR-CTX-01..08` | DAG compiler, diamond dedup, cycle safety, decay budget, loopholes, one-hop refs | `src-tauri/src/graph/compiler.rs` | `ut_rs_04` through `ut_rs_10` |
| `FR-CTX-09` | `Hold V` X-Ray canvas glow and live token HUD | `src-tauri/src/graph/compiler.rs`, `src/canvas/renderer2d.ts`, `src/overlays/XrayHud.tsx` | `ut_rs_04`..`ut_rs_10`, `src/input/keymap.ts` |
| `FR-AI-01..02` | OpenAI-compatible, Anthropic, and Ollama streaming plus dual-tier model config | `src-tauri/src/ai/provider.rs`, `src-tauri/src/settings.rs`, `src/overlays/SettingsModal.tsx` | `slice4_suite.rs` |
| `FR-AI-03..05` | `A`-chord lenses and custom prompt, `@@NODE` streaming, `Esc` cancel | `src-tauri/src/ai/prompts.rs`, `src-tauri/src/ai/parser.rs`, `src-tauri/src/ai/runner.rs` | `ut_rs_13`..`ut_rs_15`, `slice4_suite.rs` |
| `FR-AI-06` | Debounced background summarizer (`1500` ms) | `src-tauri/src/ai/summarizer.rs` | `summarizer_fast_path_llm_path_and_stale_hash_abort` |
| `FR-PERSIST-01..03` | SQLite WAL, camera restore, deterministic JSON export and import | `src-tauri/src/db/mod.rs`, `src-tauri/src/db/json_io.rs`, `src/ipc/workspaceActions.ts` | `ut_rs_01`, `ut_rs_16`, `slice5_suite.rs` |
| `NFR-PERF-01..04` | `>= 60` FPS (`500` nodes), `< 5` ms compile, `< 15` ms search, `< 800` ms boot | `src/canvas/renderer2d.ts`, `src-tauri/src/graph/compiler.rs`, `src-tauri/src/db/migrations.rs` | `bench_500_node_compile_and_search`, `slice5_suite.rs`, `stress500.test.ts` (live GPU FPS pending desktop QA) |
| `NFR-FOOT-01..02` | `< 25` MB release bundle, `< 120` MB RSS at `500` nodes | Tauri v2, Preact, `LiveEditorOverlay` | `windows-tauri-build` (`axiom-canvas.exe` ~`15.57` MiB; live RSS pending desktop QA) |
| `NFR-UX-01` | `>= 95%` canvas viewport at rest, zero persistent sidebars | `src/App.tsx`, `src/styles/theme.css` | Visual layout inspection (live pixel check pending desktop QA) |
| `NFR-REL-01` | WAL crash durability after committed `apply_ops` | `src-tauri/src/db/mod.rs`, `src-tauri/src/db/queries.rs` | `ut_rs_01`, `import_json_rejects_invalid_payload_without_clobbering_existing_db` |
| `NFR-SEC-01..02` | OS keychain secrets, DOMPurify sanitization, locked CSP | `src-tauri/src/settings.rs`, `src/cards/markdownCache.ts`, `src-tauri/tauri.conf.json` | `settings_store_never_writes_api_keys_to_json`, `markdownCache.test.ts` (`UT-TS-02`) |

## Pending live desktop verification

Run the built Windows installer (`Axiom_0.1.0_x64_en-US.msi` or `Axiom_0.1.0_x64-setup.exe`) or launch `npx tauri dev -- --seed-stress-500` to verify the remaining interactive desktop criteria:

1. Open the `500`-node stress workspace, toggle **> Toggle Perf HUD** in **Command Palette**, and confirm sustained `>= 60` FPS (`p95 draw <= 16.6` ms) during pan, zoom across `0.45x` LOD, and multi-node drag.
2. Confirm WebView2 idle RSS memory remains under `120` MB in Navigate Mode and UI chrome stays under `5%` of the viewport area.
3. Configure a live provider key in **Settings**, click **Test Connection**, stream a multi-card lens (`A D` or `A R`), verify smooth canvas panning during streaming, and test `Esc` mid-stream cancellation.

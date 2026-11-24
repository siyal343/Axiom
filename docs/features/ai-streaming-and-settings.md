# AI streaming and settings

Axiom integrates multi-provider streaming AI lenses, OS keychain credential storage, per-tier model configuration, and a debounced background summarizer across the Rust back end and Preact front end.

## OS keychain credentials and tier settings

`SettingsStore` in `src-tauri/src/settings.rs` separates non-secret workspace preferences from API keys so secrets never appear in `settings.json`, SQLite files, JSON exports, or logs.

### Configuration file and defaults

Non-secret configuration persists in `{config_dir}/axiom-canvas/settings.json` (falling back to `dirs::home_dir()`). `SettingsStore::save` writes pretty-printed JSON to a temporary sibling file (`ulid`-suffixed), flushes with `sync_all()`, and atomically renames it over `settings.json`.

| Setting | Default value | Validation rule on save |
| --- | --- | --- |
| `reasoning` tier | `openai_compat`, `https://api.openai.com/v1`, `gpt-4o`, `temperature: 0.4`, `max_tokens: 2048` | Non-empty `base_url` and `model`; finite `temperature` in `0.0..=2.0`; `max_tokens >= 64` |
| `utility` tier | `openai_compat`, `https://api.openai.com/v1`, `gpt-4o-mini`, `temperature: 0.2`, `max_tokens: 256` | Non-empty `base_url` and `model`; finite `temperature` in `0.0..=2.0`; `max_tokens >= 64` |
| `default_token_budget` | `6000` | Must be `>= 512` (also updates active `ActiveWorkspace.token_budget`) |
| `auto_summarize` | `true` | Boolean |
| `theme` | `"dark"` | Must be `"dark"` or `"light"` |

### Keychain credential management and diagnostics

API keys are stored through `keyring::Entry::new("dev.axiom.canvas", KEY_NAME)` for `"reasoning_api_key"` and `"utility_api_key"`.

- **Update semantics:** Passing `None` preserves the stored credential; passing an empty or whitespace-only string deletes the credential (ignoring `keyring::Error::NoEntry`); passing a non-empty string trims and writes it to the OS keychain.
- **Safe presence check:** `has_api_key` returns `false` when no entry exists or if the keychain returns an error, so missing credentials never block loading settings.
- **Live connection probe:** In **Settings** (`src/overlays/SettingsModal.tsx`), clicking **Test Connection** saves the current form values first and invokes `test_provider_connection`. On the back end, `test_provider_connection` runs a `15`-second timeout stream probe (`max_tokens = 16`), cancels immediately on the first non-empty chunk, and returns `TestConnectionResult { ok, latency_ms, message }`.

## Multi-provider streaming wire adapters

`stream_completion` in `src-tauri/src/ai/provider.rs` normalizes HTTP streaming across three `ProviderKind` protocols using a shared `reqwest::Client`.

| Provider (`ProviderKind`) | Endpoint path | Request auth and format | Stream framing |
| --- | --- | --- | --- |
| `openai_compat` | `POST {BASE_URL}/chat/completions` | Optional `Authorization: Bearer <KEY>` | SSE `data:` JSON lines (`/choices/0/delta/content`) until `data: [DONE]` |
| `anthropic` | `POST {BASE_URL}/messages` | `x-api-key` and `anthropic-version: 2023-06-01` | SSE `data:` JSON lines (`content_block_delta` with `delta.type == "text_delta"`) until `message_stop` |
| `ollama` | `POST {BASE_URL}/api/chat` | No auth header; `options: { temperature, num_predict }` | NDJSON lines (`/message/content`) until `done == true` |

### Line framing, cancellation, and error mapping

- **UTF-8-safe byte splitting:** Incoming chunks append into a `Vec<u8>` buffer and split on newline (`0x0A`) boundaries before decoding with `String::from_utf8_lossy`, preventing multi-byte UTF-8 characters split across TCP packets from corrupting text.
- **Immediate cancellation:** Request dispatch, error-body reads, and byte-stream iteration run inside `tokio::select!` against a `CancellationToken`.
- **Structured error codes:** Non-2xx HTTP responses cap error snippets at `240` characters and map `401` and `403` to `PROVIDER_AUTH`, `429` and `500..=599` to `PROVIDER_NETWORK`, and other status codes to `VALIDATION_ERROR`. Anthropic `error` SSE frames map `authentication_error` to `PROVIDER_AUTH` and other errors to `PROVIDER_NETWORK`. Transport failures map to `PROVIDER_NETWORK` using `err.without_url()`.

## Lens prompts and streaming runner

`src-tauri/src/ai/prompts.rs` defines `BASE_SYSTEM_PROMPT`, six specialized lens prompts (`LENS_RED_TEAM`, `LENS_EDGE_CASE`, `LENS_DIVERGE`, `LENS_FEYNMAN`, `LENS_SYNTHESIZE`, and `LENS_CUSTOM`), and `UTILITY_SUMMARY_PROMPT`, along with `lens_prompt`, `lens_defaults`, and `lens_to_origin`.

### Execution lifecycle

When you invoke `run_lens` from `triggerLens` (`src/store/aiRunner.ts`), the back end and front end coordinate over a Tauri `Channel<LensStreamEvent>`:

1. **Lock-free context preparation:** `prepare_lens_context` in `src-tauri/src/ai/runner.rs` validates inputs (`synthesize` requires at least two focus nodes; `custom` requires a non-empty instruction), acquires the `workspace` read lock to run `compile_context`, and releases the lock before starting any HTTP request.
2. **Skeleton spawning (`skeleton_spawned`):** When `NodeStreamParser` emits `ParsedEvent::SpawnNode`, `execute_lens_run` acquires `workspace` and `db` locks, picks collision-free coordinates with `spatial::find_free_position`, creates a `draft` node (`created_by: ai`), wires canonical edges (`challenges` and `resolves` from `node_id -> focus_ids[0]`; `synthesizes` from every `focus_id -> node_id`; `derives`, `branches`, and `references` from `focus_ids[0] -> node_id`), commits with `apply_ops`, and emits `SkeletonSpawned`.
3. **Frame-coalesced token deltas (`token_delta`):** `aiRunner.ts` buffers incoming `chunk` strings per node ID in `pendingDeltas` and flushes once per animation frame (`requestAnimationFrame`, or `16` ms timer fallback) so high-throughput streams never saturate Preact updates.
4. **Node finalization (`node_finalized`):** When a card finishes (`@@END` or next `@@NODE`), `execute_lens_run` commits `UpdateNodeText` and sets `status` to `active` (`UpdateNodeMeta`), emits `NodeFinalized`, and queues the node ID on `summary_tx`.
5. **Cancellation (`Esc` / `cancel_run`):** Pressing `Escape` calls `cancelActiveRun()` in `aiRunner.ts`, which invokes `cancel_run` to trigger the run's `CancellationToken`. `execute_lens_run` flushes `parser.finish()` so any active `draft` node commits its partial text and transitions to `active`, then emits `RunCompleted { cancelled: true }`.
6. **Grouped undo and `red_team` triage:** On `run_completed`, `aiRunner.ts` flushes pending deltas and pushes one `HistoryEntry` onto `graphHistory` covering all spawned nodes and edges. If the completed lens is `red_team`, at least one loophole spawned, and `focusId` has not moved away from the starting node, `aiRunner.ts` focuses `spawned_ids[0]`, pans it inside an `80` px margin, and displays the `8000` ms triage hint pill (`Triage: J/K step · R resolve · Tab fix · Backspace dismiss`).
7. **Auth failure recovery:** If `run_lens` or a `run_error` event returns `PROVIDER_AUTH`, `aiRunner.ts` displays an error toast with an **Open Settings** action button that opens **Settings**.

## Debounced background summarizer

`spawn_summarizer_worker` in `src-tauri/src/ai/summarizer.rs` runs on `tauri::Builder::setup` (`src-tauri/src/lib.rs`) to keep node summaries up to date for ancestor context compression.

- **Debounce window:** Receiving a node ID from `summary_tx` (`apply_ops`, `spawn_connected_node`, or finalized AI lens cards) resets that node's `tokio::time::sleep_until` deadline to `1500` ms (`Duration::from_millis(1500)`).
- **Eligibility checks:** Before summarizing, the worker checks that `auto_summarize` is enabled and skips nodes marked `exclude_from_ai`, in `draft` status, with empty content, or where `content_hash == summary_hash`.
- **Zero-cost fast path:** If trimmed node content is `160` characters or fewer, the worker stores the trimmed text directly as `summary` without calling the utility LLM.
- **Utility LLM compression:** For longer notes, the worker calls `stream_completion` on the `utility` tier with `UTILITY_SUMMARY_PROMPT` under a `20`-second timeout.
- **Staleness guard and silent update:** `update_node_summary` in `src-tauri/src/db/queries.rs` verifies `content_hash == expected_content_hash` in memory and executes `UPDATE nodes SET summary = ?1, summary_hash = ?2, updated_at = ?3 WHERE id = ?4 AND content_hash = ?5` inside an immediate transaction (firing `nodes_au` to update `nodes_fts`). If the row updated, the backend emits `"axiom://summary-updated"` (`SummaryUpdatedEvent`), and `applySummaryUpdate` in `aiRunner.ts` updates `nodesMap` silently without bumping `graphVersion` or triggering card layout changes.

## Custom prompt bar

Pressing `A` then `Space` in Navigate Mode (or calling `triggerLens("custom")` without a prompt string) opens **Custom AI Prompt** (`src/overlays/CustomPromptBar.tsx`) in `"command"` modal state. The bar anchors beneath the focused card (clamped inside viewport bounds, or centered at `50%` width and `65%` height when no card is focused). Entering an instruction and pressing `Enter` or clicking **Run** closes the bar and launches `triggerLens("custom", trimmed)`; pressing `Escape` cancels back to `"navigate"`.

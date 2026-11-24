# Workspace persistence

Axiom stores each workspace in a local SQLite database file and keeps an in-memory `GraphEngine` synchronized with committed database state. Every mutation executes inside an immediate SQLite transaction before updating memory, so failed validations never leave disk and memory out of sync.

## Default workspace and seeding

When the application opens an empty path (`""`), `default_workspace_path` in `src-tauri/src/db/mod.rs` resolves to `<HOME>/.axiom/default.sqlite` and creates parent directories if needed.

On opening any workspace file, `hydrate_or_seed_workspace` reads all rows from `nodes`, `edges`, and `workspace_meta`. If the `nodes` table is empty, Axiom seeds one starter `core` node titled `System Architecture` at world coordinates `(0.0, 0.0)` with dimensions `320.0` by `180.0`, sets `last_focus_id` in `workspace_meta` to that starter node ID, and commits both records inside an immediate transaction.

## SQLite WAL and FTS5 schema

`run_migrations` in `src-tauri/src/db/migrations.rs` configures connection pragmas and initializes the schema on every `open_connection` call.

### Connection pragmas

| Pragma | Value | Purpose |
| --- | --- | --- |
| `journal_mode` | `WAL` | Enables write-ahead logging for concurrent reads and crash-safe local writes |
| `synchronous` | `NORMAL` | Pairs with WAL mode to reduce fsync overhead while preserving database consistency |
| `foreign_keys` | `ON` | Enforces `ON DELETE CASCADE` on `edges` when deleting nodes |
| `busy_timeout` | `5000` | Waits up to `5000` ms before returning a lock error |
| `temp_store` | `MEMORY` | Stores temporary tables and indices in RAM |

### Tables and indexes

The schema defines three core tables and one virtual search table:

- **`workspace_meta`:** Key-value table storing `schema_version` (`'1'`), `camera_x` (`'0.0'`), `camera_y` (`'0.0'`), `camera_zoom` (`'1.0'`), `last_focus_id` (`''`), and `token_budget` (`'6000'`).
- **`nodes`:** Stores node identity, `type`, `status`, `title`, `content`, `summary`, BLAKE3 `content_hash`, `summary_hash`, `severity`, `lens`, `created_by`, `model`, `token_count`, `pin_global`, `exclude_from_ai`, layout geometry (`x`, `y`, `width`, `height`, `collapsed`), and epoch millisecond timestamps (`created_at`, `updated_at`).
- **`edges`:** Stores directed relationships (`id`, `source_id`, `target_id`, `type`, `weight`, `created_at`) with `ON DELETE CASCADE` foreign keys to `nodes(id)`, a `UNIQUE (source_id, target_id, type)` constraint, and a `CHECK (source_id != target_id)` guard against self-loops.
- **`nodes_fts`:** An external-content `fts5` virtual table indexing `title`, `content`, and `summary` from `nodes` (`content='nodes'`, `content_rowid='rowid'`, `tokenize='porter unicode61'`).

Supporting indexes include `idx_edges_source`, `idx_edges_target`, `idx_nodes_status`, partial index `idx_nodes_pinned` (where `pin_global = 1`), and partial index `idx_nodes_stale_summary` (where `content_hash != summary_hash AND exclude_from_ai = 0`).

## Atomic batch transactions

All graph edits flow through `apply_ops` in `src-tauri/src/db/queries.rs`. At the Tauri IPC layer (`src-tauri/src/ipc/commands.rs`), handlers acquire the `AppState.workspace` write lock before the `AppState.db` mutex to maintain a canonical lock order.

`apply_ops` opens a SQLite transaction with `TransactionBehavior::Immediate`, stages per-node overrides in memory across all operations in the batch, and executes the following operations:

| Operation | SQLite effect | Derived fields and guards |
| --- | --- | --- |
| `create_node` | Inserts row into `nodes` and fires `nodes_ai` | Rejects duplicate IDs (`VALIDATION_ERROR`); computes BLAKE3 `content_hash` and `token_count`; queues ID for summary if `content_hash != summary_hash` and `exclude_from_ai` is false |
| `update_node_text` | Updates `title`, `content`, `content_hash`, `token_count`, `updated_at` and fires `nodes_au` | Rejects `locked` nodes with `NODE_LOCKED`; recomputes `content_hash` and `token_count`; queues ID for summary if stale |
| `update_node_meta` | Updates `type`, `status`, `severity`, `pin_global`, `exclude_from_ai`, `collapsed`, `updated_at` | Preserves prior values for omitted optional fields |
| `move_nodes` | Updates only `x` and `y` in `nodes` | Leaves `content_hash`, `updated_at`, and `nodes_fts` untouched |
| `resize_nodes` | Updates only `width` and `height` in `nodes` | Leaves `content_hash`, `updated_at`, and `nodes_fts` untouched |
| `delete_nodes` | Deletes node rows, cascading to incident `edges` and firing `nodes_ad` | Collects incident edge IDs before deletion and returns them in `deleted_edge_ids` |
| `create_edge` | Inserts row into `edges` | Rejects self-loops (`VALIDATION_ERROR`), missing endpoints, and duplicate `(source_id, target_id, type)` triples (`DUPLICATE_EDGE`); flips target `loophole` status to `resolved` when `type` is `resolves` |
| `update_edge_weight` | Updates `weight` (`full` or `summary`) in `edges` | Returns `VALIDATION_ERROR` if edge ID does not exist |
| `delete_edge` | Deletes row from `edges` | Records removed edge ID in `deleted_edge_ids` |

Only after `tx.commit()` succeeds does `apply_ops` replay the staged `EngineMutation` list against `GraphEngine` and its `rstar` spatial index. If any validation or SQLite constraint fails, the transaction rolls back automatically and `GraphEngine` remains unmodified.

## FTS5 immunity during layout moves

Three SQLite triggers synchronize `nodes_fts` with `nodes`:

- `nodes_ai` (`AFTER INSERT ON nodes`) inserts the added row into `nodes_fts`.
- `nodes_ad` (`AFTER DELETE ON nodes`) removes the deleted row from `nodes_fts`.
- `nodes_au` (`AFTER UPDATE OF title, content, summary ON nodes`) deletes the old FTS5 entry and inserts the updated text columns.

Because `nodes_au` scopes specifically to `title`, `content`, and `summary`, coordinate updates issued by `MoveNodes` (`UPDATE nodes SET x = ?1, y = ?2 WHERE id = ?3`) and `ResizeNodes` (`UPDATE nodes SET width = ?1, height = ?2 WHERE id = ?3`) never trigger FTS5 re-indexing or alter `nodes_fts_data` blocks. Dragging cards across the canvas writes only float coordinates and avoids text-index churn.

## Camera state persistence

The `save_camera` IPC command calls `db::queries::save_camera`, which writes `camera_x`, `camera_y`, `camera_zoom`, and `last_focus_id` into `workspace_meta` inside an immediate transaction.

On the front end, `CanvasCameraController` in `src/canvas/camera.ts` schedules `onSaveCamera` with a `1000` ms debounce timer after `panBy`, `zoomAt`, or `animateTo` finishes, preventing SQLite writes on every animation frame while preserving viewport position across restarts.

## Deterministic JSON export and import

`src-tauri/src/db/json_io.rs` provides portable, diff-friendly workspace serialization through `export_json` and `import_json`.

### Export format

`export_json` queries `workspace_meta`, reads all `nodes` sorted by `id ASC`, and reads all `edges` sorted by `id ASC`. It serializes pretty-printed JSON with the following top-level structure:

- `format`: `"axiom-workspace"`
- `version`: `1`
- `exported_at`: Export timestamp in epoch milliseconds
- `meta`: Object containing `camera` (`x`, `y`, `zoom`, `last_focus_id`) and `token_budget`
- `nodes`: Array of `NodeDto` objects ordered by `id ASC`
- `edges`: Array of `EdgeDto` objects ordered by `id ASC`

To prevent partial output on crashes, `export_json` creates parent directories, writes the serialized payload to a hidden temporary sibling file named `.<FILENAME>.<ULID>.tmp`, flushes it to disk with `sync_all()`, and atomically renames it to `dest_path`.

### Import workflow

`import_json` performs a clean workspace replacement:

1. Reads and parses the JSON file, verifying that `format` equals `"axiom-workspace"` and `version` equals `1`.
2. In `ipc::commands::import_json`, drops any open `db` connection and `workspace` state before touching files on disk.
3. Removes any prior database, `-wal`, and `-shm` files at the destination SQLite path.
4. Opens a fresh SQLite connection with `open_connection`, inserts `workspace_meta`, `nodes`, and `edges` inside one immediate transaction, and returns a `WorkspaceSnapshot` used to rebuild `ActiveWorkspace`.

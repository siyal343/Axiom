# System Requirements Specification (SRS)
**Project:** Axiom — Infinite Canvas AI Companion
**Version:** 1.0 (MVP Baseline)

---

## 1. Product Overview & Scope
Axiom is a local-first desktop engineering workbench that replaces linear AI chat threads with a spatial directed acyclic graph (DAG). Users structure system requirements, explore isolated architectural branches, run adversarial red-team/edge-case passes, study underlying mechanisms from first principles, and synthesize decisions—while maintaining complete visibility and control over the exact graph context sent to the LLM.

### 1.1 Primary User Workflows
1. **Spec & Branch:** Capture a core system design node, spawn child derivations (`Tab`) or isolated alternative branches (`Shift+Enter`), and iterate spatially without context bleed between siblings.
2. **Adversarial Stress-Testing:** Run one-chord `Red-Team` (`A R`) or `Edge-Case Matrix` (`A E`) passes that spawn checkable amber/red `loophole` nodes wired via `challenges` edges, then triage them rapidly (`J/K`, `Backspace` dismiss, `R` resolve, `Tab` spawn fix).
3. **First-Principles Learning:** Spawn off-axis `probe` nodes (`A F`) to deconstruct dense mechanisms, equations, or prerequisites without breaking the main architectural spine.
4. **Decision Synthesis:** Multi-select competing branches (`Shift+Click` or `Shift+J/K`) and invoke `Synthesize` (`A S`) to produce a unified `synthesis` node addressing active loopholes.
5. **Context Inspection:** Hold `V` at any time to visually illuminate the exact nodes and token budget feeding the next AI prompt.

---

## 2. Functional Requirements

### 2.1 Graph & Node Management (`FR-GRAPH`)
- **FR-GRAPH-01:** The system shall support exactly five node types: `core`, `branch`, `loophole`, `probe`, and `synthesis`.
- **FR-GRAPH-02:** Every node shall maintain a lifecycle `status` from `{draft, active, resolved, dismissed, locked}`.
- **FR-GRAPH-03:** Nodes of type `loophole` shall carry a `severity` attribute from `{low, medium, high, critical}` and render a semantic visual accent (amber for `low`/`medium`, red for `high`/`critical`) while `status == active`.
- **FR-GRAPH-04:** Setting a node's status to `locked` shall block AI overwrites and require explicit unlock before editing content.
- **FR-GRAPH-05:** The system shall support six directed edge types (`source -> target`): `derives`, `branches`, `challenges`, `resolves`, `synthesizes`, and `references`.
- **FR-GRAPH-06:** Duplicate edges sharing the same `(source_id, target_id, type)` tuple shall be rejected.
- **FR-GRAPH-07:** Deleting a node shall cascade-delete all incident edges within the same atomic transaction.
- **FR-GRAPH-08:** Every node shall store an auto-maintained 2-sentence `summary` (<= 45 words) paired with a `summary_hash` matching its BLAKE3 `content_hash` when fresh.
- **FR-GRAPH-09:** The system shall support multi-level Undo/Redo (`Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`) for all graph mutations (create, edit, move, delete, meta toggle, edge ops, tidy layout) using an invertible command ring buffer (capacity >= 100 operations).

### 2.2 Spatial Canvas, Rendering & Ergonomics (`FR-NAV`)
- **FR-NAV-01:** The workspace shall provide an unbounded 2D infinite canvas with a procedurally rendered dot grid, smooth panning (`Space + Drag` or middle-mouse drag), and cursor-anchored zooming (`Cmd/Ctrl + Scroll` or `+`/`-`).
- **FR-NAV-02:** The canvas shall implement two-tier Semantic Zoom (LOD):
  - **Detail Mode (`zoom >= 0.45`):** Renders full pre-cached Markdown (tables, fenced syntax-highlighted code, inline/display KaTeX math) for viewport-visible nodes.
  - **Bird's-Eye Mode (`zoom < 0.45`):** Renders simplified Canvas2D cards showing only title, semantic type bar, global pin badge, and active unresolved loophole count.
- **FR-NAV-03:** The interaction layer shall enforce a strict three-state modal model: `Navigate` (default), `Edit` (`Enter`/double-click), and `Command/Lens` (`Cmd/Ctrl+K` or `A` chord).
- **FR-NAV-04:** In Navigate Mode, `H/J/K/L` (and arrow keys) shall perform topological navigation (parent, sibling next/prev, first child) with smooth camera auto-pan if the newly focused node lies outside the viewport inner margin.
- **FR-NAV-05:** `Tab` shall spawn a `derives` child to the right of the focused node and enter Edit Mode; `Shift+Enter` shall spawn a `branches` sibling from the focused node's parent; `N` shall spawn a detached `core` node at viewport center.
- **FR-NAV-06:** All auto-spawned nodes (manual or AI-generated) shall be placed via R-tree collision avoidance so no newly created card overlaps an existing card's bounding box.
- **FR-NAV-07:** Pressing `F` shall smoothly fit the focused node's subtree into the viewport; pressing `F` twice within 500 ms shall fit the entire workspace graph.
- **FR-NAV-08:** Pressing `T` shall execute `tidy_subtree` on the focused node's descendants, arranging them in a clean left-to-right tree (with `loophole`/`probe` cards positioned cleanly above/below their anchor) without disturbing unrelated nodes.
- **FR-NAV-09:** Pressing `C` shall collapse/expand the focused node into a single-line title pill; `Shift+C` shall fold/unfold its entire descendant subtree.
- **FR-NAV-10:** Pressing `Cmd/Ctrl+K` shall open an ephemeral Command Palette supporting instant FTS5 full-text search and structured filters (`status:active`, `type:loophole`, `pinned:true`), gliding the camera to the selected hit on `Enter`.

### 2.3 Context Compilation & X-Ray Control (`FR-CTX`)
- **FR-CTX-01:** Context compilation from one or more focus nodes shall walk backwards strictly along `{derives, branches, synthesizes}` edges, guaranteeing zero sibling branch bleed.
- **FR-CTX-02:** Shared ancestors in diamond DAGs shall be deduplicated via topological sort and emitted exactly once in root-to-focus order.
- **FR-CTX-03:** If a user manually introduces a cycle, the compiler shall remain cycle-safe (terminate deterministically via Kahn's algorithm fallback without infinite recursion).
- **FR-CTX-04:** Any node with `pin_global == true` (`P`) and `exclude_from_ai == false` shall be hoisted into `[GLOBAL CONSTRAINTS]` for every prompt on the canvas.
- **FR-CTX-05:** Any node with `exclude_from_ai == true` (`X`) shall be omitted from prompt text while still acting as a transparent pass-through during ancestor traversal so lineage is not severed.
- **FR-CTX-06:** Distance-decay token budgeting (default soft budget: 6,000 tokens, configurable) shall always preserve full `content` for Global Pins, Focus Nodes, Direct Parents (depth 1), and Active Loopholes; ancestors at depth >= 2 shall receive full `content` closest-first until budget exhaustion, then automatically degrade to `summary`.
- **FR-CTX-07:** Incoming `challenges` edges targeting any included ancestor or focus node shall inject their source node into `[UNRESOLVED LOOPHOLES]` if and only if `source.status == active` and `exclude_from_ai == false`.
- **FR-CTX-08:** Outgoing `references` edges from focus nodes shall inject one-hop summaries (`weight == summary`) or full content (`weight == full`) without recursively traversing the referenced node's ancestors.
- **FR-CTX-09:** Holding `V` in Navigate Mode shall query `compile_xray` and visually illuminate included nodes by mode (purple/white = Global Pin, cyan = Focus, green = Full Ancestor, blue = Summary Ancestor, amber = Active Loophole, slate = Reference) along with a floating live token counter HUD.

### 2.4 AI Lenses & Streaming Runtime (`FR-AI`)
- **FR-AI-01:** The backend shall support a provider-agnostic streaming adapter covering:
  1. OpenAI-compatible Chat Completions SSE (`/v1/chat/completions`, covers OpenAI, OpenRouter, DeepSeek, Groq, vLLM, LM Studio)
  2. Anthropic Messages SSE (`/v1/messages`)
  3. Local Ollama (`/api/chat` NDJSON streaming)
- **FR-AI-02:** The system shall support dual-tier model configuration: a **Reasoning Model** (for user-triggered lenses) and a **Utility Model** (for background 2-sentence node summaries).
- **FR-AI-03:** Five built-in lenses shall be invokable via `A`-chord shortcuts and the floating hover pill:
  - `A R`: Red-Team / Find Loopholes (spawns 2–4 `loophole` nodes via `challenges` edges)
  - `A E`: Edge-Case Matrix (spawns 1 `loophole` table node via `challenges` edge)
  - `A D`: Diverge 3x (spawns 3 orthogonal `branch` nodes via `branches` edges)
  - `A F`: Feynman Probe (spawns 1 `probe` node via `derives` edge)
  - `A S`: Synthesize (requires >= 2 selected nodes; spawns 1 `synthesis` node via `synthesizes` edges)
  - `A Space`: Custom Prompt (spawns 1 contextual child node based on user inline instruction)
- **FR-AI-04:** Streaming responses shall spawn skeleton nodes immediately upon receiving each `@@NODE` header and stream tokens token-by-token into the respective card without locking camera navigation.
- **FR-AI-05:** Pressing `Esc` during an active run shall cancel the backend HTTP stream via `CancellationToken`, persist all tokens received so far, and clear pulsing states cleanly.
- **FR-AI-06:** Exiting Edit Mode (`Esc`) on a modified node (or finalizing an AI-generated node) shall enqueue a debounced (1,500 ms) background summary refresh if `content_hash != summary_hash`.

### 2.5 Persistence & Portability (`FR-PERSIST`)
- **FR-PERSIST-01:** Each workspace shall persist in a single self-contained `.sqlite` file configured with `WAL` journal mode and `FOREIGN KEYS = ON`.
- **FR-PERSIST-02:** Camera viewport state (`x`, `y`, `zoom`) and last focused node ID shall be saved to `workspace_meta` and restored on reopen.
- **FR-PERSIST-03:** The system shall support deterministic, sorted-key JSON export and import (`export_json` / `import_json`) for clean Git diffing and archival.

---

## 3. Non-Functional Requirements (`NFR`)

| ID | Category | Target Metric / Constraint |
| :--- | :--- | :--- |
| **NFR-PERF-01** | Frame Rate | Sustained >= 60 FPS pan/zoom/drag on a 500-node, 700-edge workspace. |
| **NFR-PERF-02** | Context Compile | `compile_context` completes in < 5 ms for a 500-node graph. |
| **NFR-PERF-03** | Search Latency | FTS5 `search_nodes` query completes in < 15 ms across 1,000 nodes. |
| **NFR-PERF-04** | Cold Start | Application window interactive in < 800 ms from launch. |
| **NFR-FOOT-01** | Binary Size | Release bundle < 25 MB (no bundled Chromium / Electron). |
| **NFR-FOOT-02** | Idle Memory | < 120 MB RSS on a 500-node workspace in Navigate Mode. |
| **NFR-UX-01** | Chrome Minimalism | Canvas occupies >= 95% of window viewport at rest; zero persistent sidebars or toolbars. |
| **NFR-REL-01** | Crash Recovery | Zero data loss on abrupt process kill after any committed `apply_ops` call (SQLite WAL durability). |
| **NFR-SEC-01** | Secret Hygiene | API keys stored solely in OS Keychain (never in workspace `.sqlite` or exported JSON). |
| **NFR-SEC-02** | XSS Prevention | All rendered Markdown/HTML sanitized via DOMPurify before DOM insertion; Tauri CSP locked down. |

---

## 4. Explicit MVP Out-of-Scope Boundaries
To prevent scope creep, Antigravity 2.0 MUST NOT build the following during the MVP slices:
- Real-time multiplayer / CRDT sync / cloud accounts.
- Freehand drawing, image attachments, PDF ingestion, or audio/voice input.
- WYSIWYG rich-text toolbar buttons (nodes are pure Markdown + KaTeX + fenced code).
- Embedded terminal, live code execution, or tool-calling/MCP agents inside nodes.
- Custom plugin marketplace or multi-tab workspace docking.
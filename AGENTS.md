# AGENTS.md — Antigravity 2.0 Execution Contract
**Project Working Title:** Axiom (Infinite Canvas AI Companion for System Design & Engineering)
**Architecture:** Local-first desktop application (Rust + Tauri v2 backend, Vite + TypeScript + Preact frontend)

---

## 1. Mission & Product Philosophy
Build a minimalistic, lightweight, keyboard-first infinite canvas where the spatial graph acts as a **deterministic context compiler** for an AI engineering partner.
- The canvas is a directed thinking graph for generating ideas, branching trade-offs, exposing loopholes/edge cases, learning from first principles, and synthesizing decisions.
- **Anti-patterns strictly forbidden:**
  1. Never add a permanent docked chat sidebar.
  2. Never mount multiple live rich-text/code editors on the canvas simultaneously.
  3. Never store layout drag updates through reactive framework state or trigger SQLite FTS5 re-indexing on `(x, y)` moves.
  4. Never duplicate graph traversal, context compilation, or collision math in TypeScript—Rust is the single source of truth.

---

## 2. Locked Technology Stack
Do NOT substitute dependencies without explicit user approval.

### Backend (`src-tauri/`)
- **Runtime:** Rust (Edition 2021, stable) + **Tauri v2**
- **Database:** `rusqlite` with features `["bundled", "modern_sqlite"]` (includes FTS5)
- **Spatial Index:** `rstar` (2D AABB R-tree for collision avoidance and `tidy_subtree`)
- **Async & HTTP/SSE:** `tokio` (full), `tokio-util` (`CancellationToken`), `reqwest` (`stream`, `json`, `rustls-tls`)
- **Identifiers & Hashing:** `ulid`, `blake3`, `serde`, `serde_json`, `thiserror`
- **Secret Storage:** OS keychain via `keyring` crate (fallback to local encrypted/untracked `.env` in dev)

### Frontend (`src/`)
- **Build Tool:** Vite + TypeScript (`strict: true`)
- **UI Layer:** **Preact** + `@preact/signals` (used strictly for visible culled cards, Command Palette, ephemeral overlays, and settings)
- **Active Editor:** **CodeMirror 6** (`@codemirror/view`, `@codemirror/state`, `@codemirror/lang-markdown`, `@codemirror/commands`)
- **Static Node Rendering:** `markdown-it` + `katex` (math) + `shiki` (or `highlight.js` light bundle for minimal bundle size) + `dompurify`
- **Viewport Spatial Index:** `rbush` (client-side viewport culling only)
- **Styling:** Plain CSS with CSS custom properties (`src/styles/theme.css`). Do NOT install Tailwind, MUI, Chakra, or heavy canvas frameworks (no ReactFlow, Konva, Fabric.js, or PixiJS).

---

## 3. Non-Negotiable Architectural Invariants
Every PR / slice implementation MUST preserve these six invariants:

1. **One Live Editor Rule:** In Navigate Mode, `0` CodeMirror instances exist in the DOM. Pressing `Enter` mounts exactly `1` `LiveEditorOverlay` positioned over the focused node. Pressing `Esc` commits text, updates the static HTML cache, and unmounts the editor.
2. **Decoupled 60-120 FPS Camera Loop:** Panning and zooming run inside a raw TypeScript `requestAnimationFrame` loop (`src/canvas/camera.ts`) that redraws the single `<canvas>` and mutates the card container's `transform: translate3d(...) scale(...)` directly via DOM ref. Zero Preact component re-renders may fire during pan/zoom/drag.
3. **Zoom LOD Cutoff (`0.45x`):** When `camera.zoom < 0.45`, the DOM card layer is hidden (`display: none` / unmounted) and all visible nodes draw directly onto Canvas2D as simplified Bird's-Eye cards (title, semantic left bar, unresolved loophole badge).
4. **Single-Source-of-Truth Context Compiler:** Both the `Hold V` Context X-Ray preview (`compile_xray`) and live AI execution (`run_lens`) MUST call the exact same Rust function `graph::compiler::compile_context()`.
5. **Streaming Framing Immunity:** Multi-node AI lenses (`Red-Team`, `Diverge`) use the line-delimited `@@NODE` / `@@END` framing protocol parsed in Rust, never giant JSON arrays. The parser MUST ignore `@@NODE` inside fenced Markdown code blocks and fall back gracefully if a model omits headers.
6. **Atomic Local Persistence:** Every graph mutation batches into a single SQLite WAL transaction via `apply_ops`. Workspace files remain 100% usable offline (excluding live cloud API calls; local Ollama works fully offline).

---

## 4. Mandatory Build Order & Verification Gates
Implement the application strictly in **six vertical slices** defined in `docs/05-VV-AND-SLICES.md`. Do NOT jump ahead to Slice N+1 until every verification gate in Slice N passes cleanly:

- **Slice 0:** Repo scaffold, Tauri v2 boot, SQLite WAL + FTS5 migration, typed IPC skeleton.
- **Slice 1:** Headless Rust Graph Engine (`models`, `db`, `spatial`, `compiler`) + full `cargo test` suite passing.
- **Slice 2:** 3-Layer Canvas Renderer (`camera`, `renderer2d`, `rbush` culling, LOD < 0.45x, static Markdown/KaTeX cards, single CodeMirror 6 overlay).
- **Slice 3:** Modal Keyboard Engine (`Navigate / Edit / Command`), `H/J/K/L` topological navigation, `Tab` / `Shift+Enter` spawning, `Hold V` X-Ray overlay, Undo/Redo ring buffer, `Cmd/Ctrl+K` FTS5 Command Palette.
- **Slice 4:** Provider-Agnostic SSE Client (OpenAI-compatible, Anthropic, Ollama), `@@NODE` fence-aware parser, all 5 AI Lenses + Custom Prompt, `Esc` stream cancellation, and debounced background `summary` worker.
- **Slice 5:** Polish & Hardening — `tidy_subtree`, JSON Git export/import, Loophole Triage Loop, Settings modal (API key + model tier routing), 500-node stress test & full RTM sign-off.

---

## 5. Coding & Quality Standards
- **Rust:** Zero `unwrap()` / `expect()` in production paths (use `thiserror` and return `Result<T, String>` at the Tauri boundary). All Rust unit tests must pass via `cargo test` without requiring a display server or network access.
- **TypeScript:** Zero `any` types. Keep canvas math pure and unit-testable with Vitest.
- **Sanitization:** All rendered Markdown HTML MUST pass through `DOMPurify` before injection into static `NodeCard` elements.
- **Token & Key Safety:** Never log user API keys or write them into `.sqlite` workspace files.
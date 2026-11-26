# Axiom v0.7 — Interactive Visual Teaching Engine

This document records the architecture and verification of the interactive engineering visual teaching engine embedded inside Axiom node cards and revealed flashcards.

## Goal & Constraints

Undergraduate students mastering **RF**, **Controls**, **Embedded Systems**, and **Physics** benefit most when governing equations are paired directly with linked interactive cause-and-effect visuals inside the reasoning flow—without introducing extra docked sidebars or heavy charting dependencies.

All implementation strictly preserves Axiom's six architectural invariants:
- `0` live CodeMirror instances in Navigate Mode.
- Zero reactive Preact updates during canvas pan, zoom, or drag.
- Complete unmounting of DOM cards and visual sims below the `0.45x` Bird's-Eye LOD threshold.
- Single-source-of-truth Rust context compiler (`compile_context`) and framing parser (`NodeStreamParser`).
- Full `DOMPurify` sanitization with zero `eval`, `new Function`, or inline `<script>` tags.

## Declarative Visual Lab (`axiom-sim` / `sim`)

Fenced ` ```axiom-sim ` (or ` ```sim `) Markdown JSON blocks compile cleanly through `src/cards/markdownCache.ts` into validated `<div class="axiom-sim-mount" data-sim="...">` elements (`data-sim` explicitly allowlisted in `DOMPURIFY_CONFIG.ADD_ATTR`) and hydrate lazily via `useSimHydration` (`src/cards/simMountHost.ts`) in both `.node-card__body` (`src/cards/NodeCard.tsx`) and revealed answers in `StudyDeckModal` (`src/overlays/StudyDeckModal.tsx`).

### Supported Domains & Presets (`src/cards/visualSimEngine.ts`)

| Domain | Presets (`preset`) | Interactive Outputs & Live Metrics |
| --- | --- | --- |
| Controls | `second_order_step`, `pid_step`, `splane`, `rc_step` | Analytical / RK2 step curves, $\pm 2\%$ settling band, LHP/RHP pole loci, `%OS`, `Ts (2%)`, `Tp`, `|e_ss|`, damping cone |
| RF | `smith`, `rf_s11`, `standing_wave` | Normalized Smith unit-circle grid ($r = 0.5, 1, 2$; $x = \pm 0.5, \pm 1, \pm 2$), SWR circle, `|Γ|∠°`, `VSWR`, `RL (dB)`, `P_load` |
| Embedded | `spi_timing`, `pwm_rc`, `rc_step` | `CS_n` / `SCK` / `MOSI` Mode `0..3` sample-edge arrows (`CPOL`/`CPHA`), steady-state PWM+RC ripple `ΔV_pp`, `V_avg` |
| Physics & Math | `damped_wave`, `standing_wave`, `custom_expr` | Exponential decay envelope, Q-factor, standing-wave ratio, or safe recursive-descent formula `expr(x, params)` plot (`sin`, `cos`, `exp`, `sqrt`, `ln`, `log10`, `pow`, `pi`, `e`) |

### Pointer & Camera Isolation

- `.axiom-sim` is registered inside `isInteractiveTarget` (`src/canvas/pointer.ts`) and stops `pointerdown`, `mousedown`, `dblclick`, and `wheel` propagation in `src/cards/VisualSimBlock.tsx`, ensuring dragging parameter sliders never drags or pans the canvas.
- Streaming incomplete fences render a calm `.axiom-sim-streaming` placeholder until closed, and `extractHintFromAnswer` (`src/store/studyStore.ts`) strips `axiom-sim` blocks so flashcard `Hint (H)` clues never expose raw JSON.

## AI Prompts & Provider-Agnostic Streaming Resilience

- `LENS_FEYNMAN` and `LENS_STUDY` (`src-tauri/src/ai/prompts.rs`) instruct any provider's model to emit at most one concise ` ```axiom-sim ` fence alongside KaTeX derivations, validity limits, worked sanity checks, and `**Active-Recall Quiz:**` items while preserving strict `@@NODE ... @@END` framing.
- `build_anthropic_body` and `build_openai_compat_body` (`src-tauri/src/ai/provider.rs`) stay strictly provider-agnostic with zero hardcoded vendor or domain overrides. To support modern thinking/reasoning models on any Anthropic-, OpenAI-, or Ollama-compatible endpoint:
  - Default reasoning `max_tokens` is `4096` (`StoredSettings::default` in `src-tauri/src/settings.rs` and `DEFAULT_SETTINGS` in `src/overlays/SettingsModal.tsx`), and `test_connection` probes with `max_tokens: 64`.
  - `finish_stream_check` inspects protocol-level reasoning and length signals (`thinking_delta` / `reasoning_content` + `stop_reason: "max_tokens"` or `finish_reason: "length"`). If a stream terminates at the token ceiling before emitting visible answer text, Axiom returns an actionable `PROVIDER_NETWORK` error advising the user to raise **Max Tokens** in **Settings** (`8192+`) rather than silently creating a blank card.
- Range sliders inside `.axiom-sim` are excluded from text-input shortcut suppression in [keymap.ts](file:///f:/Datapack/Personal/Programa/Lattice/src/input/keymap.ts) and [StudyDeckModal.tsx](file:///f:/Datapack/Personal/Programa/Lattice/src/overlays/StudyDeckModal.tsx), preserving Arrow-key slider adjustment while keeping `Shift+Q`, SM-2 `1`–`4` grading, `J`, `E`, and `Escape` active immediately after dragging a parameter.

## Verification

- TypeScript strict check (`npx.cmd tsc --noEmit`), Vitest (`src/cards/__tests__/visualSim.test.ts` + full suite), Rust tests (`src-tauri/tests/slice4_suite.rs` + full suite), and `impeccable detect --json src/`.
- Live SSE verification against `https://api.deepseek.com/anthropic/messages` (`deepseek-flash`) across all four engineering domains (`RF`, `Controls`, `Embedded`, `Physics`), confirming valid `@@NODE ... @@END`, structured KaTeX/Recall content, and valid `axiom-sim` specs.

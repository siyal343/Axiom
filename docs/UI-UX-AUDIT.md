# Axiom UI/UX & Design-Engineering Audit (`v0.1.0`)

**Method:** `dual-agent` (Assessment A: `d26fd89e-a7d0-4515-8b6b-30ce45369284` · Assessment B: `822da724-93ad-4c5e-9caa-6c11deacf9d9` · Interactive Browser Auditor: `f2d62fa0-5762-4d66-a3c3-f23c60828c1f`)  
**Target:** Axiom front end (`src/`) via live Vite browser session (`http://localhost:1420`) and static/source inspection  
**Host-Verified Visual Evidence:** `http://localhost:1420` (`Dark` and `Light` themes, `1280x800` pane & `800x600` minimum viewport), screenshot `final_step_68.png` (`C:/Users/mushii/.gemini/antigravity/brain/24ff5af7-7396-49ac-b440-d37200828c1f/browser_evidence/f2d62fa0-5762-4d66-a3c3-f23c60828c1f/final_step_68.png`)

> **Scope Boundary:** Interactive verification ran in Chromium against `vite` (`http://localhost:1420`) rather than inside the compiled Windows Tauri WebView2 shell (`axiom-canvas.exe`). Rust-backed operations (`open_workspace`, `spawn_connected_node` R-tree collision placement, `compile_xray`, and `test_provider_connection`) are verified through source inspection and CI suites (`45439550607`) rather than live WebView2 screenshots.

---

## 1. Executive Health Scores

### Audit Health Score (`/20` — Technical Quality)

| # | Dimension | Score | Key Finding |
| --- | --- | --- | --- |
| 1 | Accessibility | **1 / 4** | Muted text (`#667085`) and Light theme accents fail WCAG AA contrast; zero `:focus-visible` outlines; zero `prefers-reduced-motion` support; `keymap.ts` intercepts `Tab` and `Enter` on `.hover-pill` and `.edge-popover` buttons. |
| 2 | Performance | **3 / 4** | Decoupled `requestAnimationFrame` camera loop, `rbush` culling, and `< 0.45x` Canvas2D Bird's-Eye LOD achieve `15` DOM cards and `9.40 ms` p95 draw at `500N / 700E` (`final_step_68.png`), offset by `margin-left` shake layout thrash, `width` transition on X-Ray bar, always-on `will-change: transform`, and idle `FPS: 0` telemetry bug. |
| 3 | Theming | **2 / 4** | Dark palette is cohesive, but `[data-theme="light"]` omits semantic `--accent-*` and `--xray-*` tokens (causing near-invisible Light Bird's-Eye cards), zero `.hljs-*` CSS rules exist (monochrome code blocks), and missing `color-scheme` / scrollbar styles leave white native scrollbars in dark cards and dialogs. |
| 4 | Responsive Design | **1 / 4** | Overlapping bottom hints/toasts at `735px` pane width, `.toast-stack` covering `SettingsModal`, `.hover-pill` overhanging `320px` cards, unclamped `.edge-popover`/`.multi-select-pill`, `< 24px` compact buttons, and un-gated pointer hover rules. |
| 5 | Implementation Integrity | **2 / 4** | `Tab`/`Shift+Enter` desynchronizes `LiveEditorOverlay` from its card during camera pans; `.hover-pill` clips behind adjacent cards; non-Tauri `Shift+Enter` spawns overlapping siblings; `tidy_subtree` snaps instead of animating `180ms`. |
| **Total** | | **9 / 20** | **Poor** — strong spatial core held back by overlay containment, theming gaps, and accessibility barriers. |

### Design Health Score — Nielsen's 10 Heuristics (`/40` — Operate Mode)

| # | Heuristic | Score | Key Issue |
| --- | --- | --- | --- |
| 1 | Visibility of System Status | **2 / 4** | No rest-state mode or zoom badge; `PerfHud` shows `FPS: 0` when idle; `XrayHud` shows `0 / 6,000` in browser mode with no runtime explanation. |
| 2 | Match System / Real World | **2 / 4** | Unexplained jargon (`Red-Team`, `Feynman`, `Diverge`, `Reasoning/Utility Tier`, `LOD`) and raw filter syntax (`status:active`); `Pin`/`Collapse` labels never flip to `Unpin`/`Expand`. |
| 3 | User Control and Freedom | **2 / 4** | Missing keyboard zoom (`Ctrl+-`, `Ctrl+=`, `Ctrl+0`) and on-screen zoom controls; modal dialogs lack focus traps; `Delete` in `.hover-pill` lacks undo notice. |
| 4 | Consistency and Standards | **2 / 4** | `LiveEditorOverlay` drifts away from focused card on `Tab`; `.hover-pill` slices behind neighbor cards; `ToastStack` renders atop `SettingsModal`; white native scrollbars and monochrome syntax blocks. |
| 5 | Error Prevention | **2 / 4** | `1.5s` `chord_a` timeout expires mid-read; `N` leaks `'n'` into CodeMirror; browser `Shift+Enter` places overlapping siblings; `SettingsModal` blanks snap `temperature` to `0`. |
| 6 | Recognition Rather Than Recall | **1 / 4** | Empty or rest canvas displays zero cues for `N`, `Enter`, `E`, `V`, `F`, `Ctrl+K`, or `Ctrl+,`; workspace commands remain hidden behind typing `>` in `CommandPalette`. |
| 7 | Flexibility and Efficiency | **3 / 4** | Rich Vim-style `H/J/K/L` topology traversal, `A`-chords, `Hold V` X-Ray, and `Alt+Drag` edges, undermined by missing zoom shortcuts and `Tab`/`Enter` blocking card buttons. |
| 8 | Aesthetic and Minimalist Design | **2 / 4** | Focused monochrome cards are undermined by glaring native Windows scrollbars, monochrome code spans, overhanging hover pills, and low-contrast Light Bird's-Eye cards. |
| 9 | Error Recovery | **2 / 4** | Clear `PROVIDER_AUTH` toast recovery button (`Open Settings`) and desktop-runtime probe guard, but `2.8s` toasts dismiss too fast and browser settings silently ignore entered API keys. |
| 10 | Help and Documentation | **1 / 4** | No empty-state instructions, no `?` shortcut cheatsheet, no legend hints for `X-Ray` or `⚠` badges, and redundant `E` connect prompts colliding at the bottom edge. |
| **Total** | | **19 / 40** | **Poor / Borderline Acceptable (47.5%)** |

---

## 2. Design Specificity & Implementation Integrity Verdict

### Design Specificity Verdict
**Purpose-built structural core, unfinished product craft.**

Axiom's monochrome obsidian canvas (`#0e1013` / `#15181e`), role-encoded left accents, directed semantic edge styles, zero-editor-at-rest static KaTeX cards, and `Hold V` context budget overlay are genuinely tailored to engineering graph reasoning rather than generic dashboard templates. However, shipped UI surfaces fall back to unfinished defaults in four critical areas: monochrome code blocks inside dark cards (`hljs` CSS omitted), bright native Windows scrollbars (`color-scheme` omitted), washed-out Light Theme Bird's-Eye rendering (`1.07:1` card/canvas contrast), and uncontained overlay stacking (`LiveEditorOverlay`, `.hover-pill`, and `.toast-stack`).

### Deterministic CLI Scan (`impeccable detect --json src/`) vs. Visual Review
- **Detector outcome:** Exited with code `2` and reported **`7` warnings** across `1` file ([theme.css](../src/styles/theme.css#L143-L183)), all under rule `side-tab` (`"Side-tab accent border"`):
  - `.node-card--branch` (`border-left: 3px solid var(--accent-branch)`, line `144`)
  - `.node-card--probe` (`border-left: 3px solid var(--accent-probe)`, line `148`)
  - `.node-card--loophole.node-card--severity-low` (line `164`)
  - `.node-card--loophole.node-card--severity-medium` (line `168`)
  - `.node-card--loophole.node-card--severity-high` (line `172`)
  - `.node-card--loophole.node-card--severity-critical` (line `176`)
  - `.node-card--loophole.node-card--status-resolved, .node-card--status-dismissed` (`border-left: 3px solid var(--border-strong)`, line `182`)
- **Verification & false-positive analysis (`0 / 7` real slop, `7 / 7` intentional design-system tokens):** Removing `border-left` would break Axiom's explicit monochrome-plus-semantic-stripe contract (`docs/04-UI-UX-AND-RENDERING.md`) and diverge from Canvas2D Bird's-Eye cards (`renderer2d.ts:512-514`), which draw a matching `4px` semantic left bar from the exact same tokens. Unlike `loophole` nodes, `branch` and `probe` nodes have no type pill in the header, making the left stripe their primary role marker.
- **What the live browser + Design Critic caught beyond static rules:** Static detection missed the `LiveEditorOverlay` camera-pan desync (`Tab`), `.hover-pill` stacking-context slice by neighbor cards (`final_step_68.png`), missing `.hljs-*` CSS rules, bright native Windows scrollbars, idle `FPS: 0` telemetry, Light Bird's-Eye `1.07:1` contrast collapse, and `Tab`/`Enter` button keyboard traps.

---

## 3. Interactive Findings Verified Against Source Code

| # | Observed Behavior (`http://localhost:1420`) | Verdict | Exact Source & Root-Cause Evidence |
| --- | --- | --- | --- |
| 1 | `.cm-editor` count: `0` Navigate -> `1` on `Tab` -> `0` on `Esc`; zero console errors | **Confirmed** | `LiveEditorOverlay` returns `null` unless `modalState === "edit"` (`src/cards/LiveEditorOverlay.tsx:37-47`) and destroys CodeMirror on unmount (`lines 140-144`). |
| 2 | Initial Vite load starts empty (`data-workspace-ready="false"`, `0` nodes); **Test Connection** shows desktop-runtime message | **Confirmed** *(Runtime boundary)* | `openWorkspace("")` in `src/App.tsx:140-174` requires `isTauriRuntime()`; `SettingsModal.handleTest` explicitly handles `!isTauriRuntime()` (`src/overlays/SettingsModal.tsx:295-305`). Missing empty-canvas prompt. |
| 3 | `Tab` causes `.live-editor-overlay` to appear offset right (`+191.5px`) from focused card | **Confirmed** *(Real bug)* | `src/input/keymap.ts:442-443` triggers `ensureNodeVisible` (`200ms` async `rAF` pan in `src/canvas/camera.ts:188-215`) right before `enterEditMode`. `LiveEditorOverlay` computes `left`/`top` only during Preact render (`src/cards/LiveEditorOverlay.tsx:147-160`), never subscribing to camera frame updates. |
| 4 | Plain wheel / `Ctrl+-` failed to zoom out | **Confirmed** (`Ctrl+-` & plain wheel) / **Partial** (`Ctrl+wheel`) | `src/input/keymap.ts:351-386` binds no zoom keys and ignores `mod` keys at line `384`. `src/canvas/pointer.ts:410-416` pans on plain wheel and zooms only on `e.ctrlKey || e.metaKey`, leaving mouse-only and keyboard-only users without zoom shortcuts or buttons. |
| 5 | `Shift+Enter` overlaps sibling over rendered card height (`289.3px`) | **Confirmed** *(Real bug)* | Browser fallback `spawnChild` (`src/store/graphStore.ts:439-440`) hardcodes fixed coordinates with zero collision checks; additionally, a `90ms + 160ms` height-update debounce leaves newly typed card heights stale at `180px` momentarily. |
| 6 | Pressing `N` leaks `'n'` into new CodeMirror editor | **Confirmed** *(Timing bug)* | `src/input/keymap.ts:465-507` omits `e.stopPropagation()` and enters Edit mode asynchronously after `mutateUndoable` (`line 503`), where `view.focus()` (`LiveEditorOverlay.tsx:124`) focuses the body editor directly instead of targeting title input after frame flush. |
| 7 | Pressing `E` overlaps `.chord-hint-pill` and `.toast-stack` on `735px` pane; `ToastStack` covers `SettingsModal` | **Confirmed** *(Real bugs)* | `src/input/keymap.ts:515-516` triggers both `.chord-hint-pill` (`theme.css:578-595`, `z-index: 60`, `left: 50%`, `bottom: 20px`) and `pushToast` (`theme.css:801-810`, `z-index: 80`, `right: 16px`, `bottom: 16px`). `.toast-stack` (`z-index: 80`) also outranks `.settings-modal-backdrop` (`z-index: 75`, `theme.css:921`). |
| 8 | Fenced code blocks render completely monochrome | **Confirmed** *(Screenshot `final_step_68.png`)* | `markdownCache.ts` emits `<span class="hljs-*">`, but `src/styles/theme.css:347-359` only styles `<pre class="hljs">` container colors and defines zero `.hljs-*` token rules. |
| 9 | Light Theme `< 0.45x` Bird's-Eye LOD has faint contrast | **Confirmed** *(Real defect)* | `[data-theme="light"]` (`src/styles/theme.css:57-73`) leaves dark-theme `--accent-*` untouched; `renderer2d.ts:500-515` draws `#ffffff` cards over `#f6f7f9` (`1.07:1`) with `#dde2ea` borders (`1.25:1`). |
| 10 | Bright white native scrollbars inside dark cards, palette, and settings | **Confirmed** *(Screenshot `final_step_68.png`)* | `src/styles/theme.css:1-73` omits `color-scheme: dark` / `light` and custom scrollbar rules, producing high-glare native horizontal scrollbars on every code block in `final_step_68.png`. |
| 11 | `.hover-pill` overhangs `320px` card right edge and clips behind upper card | **Confirmed** *(Screenshot `final_step_68.png`)* | `.hover-pill` (`theme.css:387-403`) uses `white-space: nowrap` and `left: 0` with 5 verbose buttons inside a `320px` card (`NodeCard.tsx:165-203`). Card `transform: translate3d(...)` traps `z-index: 20`, letting `Stress Node #486` bisect `#487`'s toolbar text in `final_step_68.png`. |
| 12 | `CustomPromptBar` edge clamping mismatch | **Partial** | `src/overlays/CustomPromptBar.tsx:44-47` clamps with `barW = 420` while `theme.css:880` sets `width: min(440px, 92vw)` (`20px` mismatch). Meanwhile `.multi-select-pill` (`theme.css:460`) and `.edge-popover` lack viewport clamping altogether. |
| 13 | `PerfHud` reports `FPS: 0–1` when idle; `XrayHud` shows `0` tokens in browser | **Confirmed** | `CanvasCameraController.flushFrame()` (`src/canvas/camera.ts:245-248`) logs idle multi-second gaps between dirty frames into `intervalMs`, driving `FPS` to `0` (`final_step_68.png`). Non-Tauri X-Ray uses a `total_tokens: 0` stub (`keymap.ts:770-784`) with no UI note. |

---

## 4. `/emil-design-eng` Design Engineering Review

| Before | After | Why |
| --- | --- | --- |
| `transition: opacity 120ms ease, box-shadow 120ms ease;` (`src/styles/theme.css:136`) | `transition: opacity 150ms var(--ease-out), box-shadow 150ms var(--ease-out);` using `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` | Built-in `ease` lacks immediate snap; custom `ease-out` gives crisp visual feedback. |
| `animation: locked-shake 180ms ease-in-out;` mutating `margin-left` (`src/styles/theme.css:220-222, 550-564`) | Animate standalone CSS `translate: -6px 0 / 6px 0 / -4px 0` on an inner wrapper with `var(--ease-out)` | Animating `margin-left` causes layout + paint thrash on every frame; CSS `translate` runs on the compositor independently of card `transform`. |
| `animation: pulse-border 1.4s ease-in-out infinite;` mutating `box-shadow` (`src/styles/theme.css:216-218, 540-548`) | Static focus/draft border plus a subtle `6px` status dot pulsing via `opacity` (`1500ms`), disabled cleanly under `prefers-reduced-motion` | `1.4s` exceeds the `300ms` UI animation ceiling and continuously repaints whole-card `box-shadow`. |
| `animation: pill-fade-in 120ms ease-out;` on `.hover-pill` even on keyboard `isFocused` (`src/styles/theme.css:402, 566-575`) | Disable animation on keyboard focus (`H/J/K/L`); for pointer hover use CSS transitions + `@starting-style { opacity: 0; transform: translateY(3px) scale(0.97); }`, `transform-origin: bottom left`, `125ms var(--ease-out)` | Never animate frequent keyboard navigation (`100+` times/day); CSS transitions retarget cleanly unlike `@keyframes`. |
| `.hover-pill__menu` snaps open abruptly with default center origin (`src/styles/theme.css:423-436`) | `transform-origin: top right; transition: opacity 150ms var(--ease-out), transform 150ms var(--ease-out);` with `@starting-style { opacity: 0; transform: scale(0.95); }` | Popovers should scale from their trigger (`More (...)` at `top right`), starting at `scale >= 0.95`. |
| `.multi-select-pill` and `.edge-popover` mount with instant appear (`src/styles/theme.css:460-474`) | Add `transform-origin: bottom center; transition: opacity 150ms var(--ease-out), transform 150ms var(--ease-out);` starting from `scale(0.96)` (when pointer-triggered) | Popovers above targets need origin-aware gentle scale entry (`>= 0.95`). |
| `.xray-hud__fill { transition: width 120ms ease; }` (`src/styles/theme.css:646`) | `transform-origin: left; transform: scaleX(var(--xray-ratio)); transition: transform 150ms var(--ease-out);` | Animating `width` triggers layout; `scaleX()` is GPU-composited. |
| `.toast` mounts instantaneously (`src/styles/theme.css:812-824`) | `transition: transform 200ms var(--ease-out), opacity 180ms var(--ease-out);` with `@starting-style { opacity: 0; transform: translateY(100%); }` | Smooth, interruptible spatial entry from the bottom stack edge. |
| `.settings-modal` & `.settings-modal-backdrop` snap in/out (`src/styles/theme.css:918-939`) | Backdrop `opacity` (`180ms var(--ease-out)`) + modal `transform-origin: center` entering from `scale(0.96); opacity: 0` (`200ms var(--ease-out)`) | Occasional dialogs keep `transform-origin: center` and avoid jarring pop-in. |
| Zero `:active` press feedback on buttons across `src/styles/theme.css:405-493, 838-855, 901-916, 1056-1082, 1152-1165` | Add `transition: transform 120ms var(--ease-out), ...;` and `:active:not(:disabled) { transform: scale(0.97); }` | Buttons feel alive and confirm clicks immediately. |
| Un-gated `:hover` rules on `.hover-pill__btn`, `.hover-pill__menu-item`, `.edge-popover__btn`, `.command-palette__item`, `.toast__action`, `.perf-hud__close` (`src/styles/theme.css:418-1165`) | Wrap pointer `:hover` rules inside `@media (hover: hover) and (pointer: fine)` (keeping `.command-palette__item--active` outside) | Prevents sticky hover artifacts on touchscreens and 2-in-1 Windows laptops. |
| `.card-layer { will-change: transform; }` always active at rest (`src/styles/theme.css:121`) | Remove baseline `will-change: transform;` (enable only during active drag/pan bursts if needed) | Avoids persistent compositor layer memory and scaled-text rasterization blur at zoom. |
| `applyTidyPositions` snaps nodes instantaneously (`src/store/graphStore.ts`) vs `180ms` spec | Interpolate node `(x, y)` over `180ms` cubic-out in `rAF` (snapping under reduced motion), interruptible by drag | Preserves spatial continuity during `T` tidy reflow. |
| Zero `@media (prefers-reduced-motion: reduce)` across `src/styles/theme.css` and `CanvasCameraController.animateTo` (`src/canvas/camera.ts:188-215`) | Add `@media (prefers-reduced-motion: reduce)` keeping gentle opacity fades while disabling transform motion, and skip `animateTo` duration (`0ms`) when reduced motion is enabled | Protects motion-sensitive users from `220ms` full-viewport sweeps and infinite border pulsing. |

---

## 5. Cognitive Load & Persona Red Flags

### Cognitive Load Checklist (`6 / 8` Failed — High Extraneous Load)
- **Fails:** Single focus (`E` dual banners; `ToastStack` atop `SettingsModal`), Chunking (5 inline hover buttons; 6 `A`-chord items; 6 X-Ray legend chips; 6 palette chips), Visual hierarchy (Light Bird's-Eye `1.07:1`; white scrollbars in dark cards), Minimal choices (15+ upfront settings controls; `1.5s` 6-choice `A`-chord), Working memory (`~18` single-letter hotkeys with no legend), and Progressive disclosure (`>` hides core app actions while exposing `Temperature`/`Max Tokens` upfront).
- **Passes:** Grouping (`.settings-section` blocks; card header/body separation) and One thing at a time (strict mutually exclusive `modalState`).

### Persona Red Flags
- **Alex (Power User):** No keyboard zoom (`Ctrl+-`/`=`/`0`); `Tab` offsets `LiveEditorOverlay` from its card; `N` leaks `'n'` into CodeMirror body; `T` tidy snaps without continuity; `PerfHud` reports `FPS: 0` when idle.
- **Jordan (First-Timer):** Silent blank canvas when empty; workspace commands (`Settings`, `Theme`, `Export`) invisible without typing `>`; `1.5s` `A`-chord auto-cancels mid-read; `E` triggers overlapping bottom banners; `2.8s` error toasts vanish too fast; `Pin (P)` / `Collapse (C)` labels never reflect toggled state.
- **Sam (Accessibility-Dependent User):** `Tab` and `Enter` in `keymap.ts` hijack keyboard access to `.hover-pill` and `.edge-popover` buttons; `--text-muted`, `CRITICAL` badge (`3.84:1`), and Light theme tokens violate WCAG AA contrast; zero `:focus-visible` rings; dialogs omit `aria-modal="true"` focus traps; sub-24px button targets violate WCAG 2.5.8; zero `prefers-reduced-motion` support.

---

## 6. Priority Issues (`P0`–`P2`) & Recommended Action Plan

### What's Working
1. **Fast Decoupled Canvas Engine:** `CanvasCameraController`, `rbush` culling, and `< 0.45x` Canvas2D Bird's-Eye cards sustain `15` DOM nodes and `9.40 ms` p95 draw at `500N / 700E` (`final_step_68.png`) with `0` CodeMirror instances in Navigate mode.
2. **Cohesive Engineering Visual Grammar:** High-clarity KaTeX math, distinct semantic edge strokes, and monochrome-plus-semantic-bar role coding remain scannable on dense graphs.
3. **Keyboard-First Authoring Model:** Vim-style parent/child/sibling traversal, single-entry undo for multi-node AI generations, and modal isolation provide a strong power-user foundation.

### Priority Fixes

1. **[P0] Fix `LiveEditorOverlay` Camera Sync, `'n'` Key Leak & Keyboard Button Traps**
   - **Location:** `src/cards/LiveEditorOverlay.tsx:124, 147-169`; `src/input/keymap.ts:317-328, 431-507`
   - **Standard:** Implementation Integrity & WCAG 2.1.1 (Keyboard)
   - **Fix:** Subscribe `LiveEditorOverlay` directly to `CanvasCameraController` frame updates so its position tracks `200ms` pans lock-step; call `e.stopPropagation()` on `N` and defer initial `.focus()` by one animation frame (focusing title for empty new nodes); let `Tab`/`Enter` activate focused `.hover-pill`, `.multi-select-pill`, and `.edge-popover` buttons instead of hijacking globally.
   - **Command:** `/impeccable harden`

2. **[P0] Add Keyboard/UI Zoom (`Ctrl+-`/`=`/`0`), Empty-Canvas Guidance & Browser Sibling Collision Avoidance**
   - **Location:** `src/input/keymap.ts:351-386`; `src/canvas/pointer.ts:410-416`; `src/store/graphStore.ts:436-440`; `src/App.tsx:140-174`
   - **Standard:** WCAG 2.1.1 & First-Run Usability
   - **Fix:** Bind `mod+=`/`mod+-`/`mod+0` and add a subtle bottom-left `- 100% + · ?` zoom/help pill; query `viewportSpatialIndex` inside local `spawnChild` so siblings never stack; add a quiet centered empty-state prompt when `nodesMap.size === 0` (`Press N to create a node · Cmd/Ctrl+K for commands`).
   - **Command:** `/impeccable onboard`

3. **[P1] Fix `.hover-pill` Card Overhang/Clipping & Z-Index/Viewport Overlay Collisions**
   - **Location:** `src/styles/theme.css:124-137, 387-403, 578-595, 801-810, 880, 921`; `src/cards/NodeCard.tsx:165-203`; `src/overlays/CustomPromptBar.tsx:44-47`
   - **Standard:** WCAG 1.4.10 / 2.5.8 (`>= 24px` target height)
   - **Fix:** Raise active/hovered `.node-card` above sibling stacking contexts (`z-index: 25`), trim hover pill labels (`+ Child`, `Lens`, `Pin`/`Unpin`, `Fold`/`Unfold`, `···`) to fit within `320px` cards with `>= 24px` target heights, suppress duplicate `pushToast` when `E` displays `.chord-hint-pill`, elevate `.settings-modal-backdrop` above `.toast-stack`, align `barW = 440` in `CustomPromptBar.tsx`, and clamp `.edge-popover`/`.multi-select-pill`.
   - **Command:** `/impeccable layout`

4. **[P1] Fix Contrast Failures, Light Bird's-Eye LOD, White Scrollbars & Monochrome Code Blocks**
   - **Location:** `src/styles/theme.css:23, 57-73, 347-359, 520, 708, 898, 1040`; `src/canvas/renderer2d.ts:500-515`
   - **Standard:** WCAG 1.4.3 (`>= 4.5:1`), 1.4.11 (`>= 3:1`), 2.4.7 (`:focus-visible`)
   - **Fix:** Brighten `--text-muted` and `CRITICAL` badge contrast, define `[data-theme="light"]` overrides for `--accent-*`/`--xray-*` plus darker Bird's-Eye card borders/canvas contrast, add `color-scheme: dark`/`light` and styled scrollbars, add `.hljs-*` syntax colors, and add `:focus-visible` outlines plus `aria-modal="true"` focus traps.
   - **Command:** `/impeccable colorize`

5. **[P2] Fix Motion Hygiene (`prefers-reduced-motion`, GPU Shake, Keyboard Pill) & Idle `PerfHud` FPS**
   - **Location:** `src/styles/theme.css:121, 136, 217, 402, 540-575, 646, 812, 929`; `src/canvas/camera.ts:188-215, 246-248`; `src/store/graphStore.ts`
   - **Standard:** Performance & WCAG 2.3.3 (Reduced Motion)
   - **Fix:** Replace `margin-left` shake with compositor `translate`, stop animating `.hover-pill` on keyboard focus, respect `prefers-reduced-motion` across CSS and `camera.ts`, filter multi-second idle gaps out of `FrameTimeTracker` `FPS` averaging, and add `180ms` node interpolation for `tidy_subtree`.
   - **Command:** `/impeccable animate`

### Suggested Sequence
1. `/impeccable harden` (Editor sync, `'n'` bleed, keyboard button access, `1.5s` chord timer)
2. `/impeccable onboard` (Empty canvas prompt, `?` shortcut help, visible `Cmd/Ctrl+K` actions, keyboard/UI zoom)
3. `/impeccable layout` (`.hover-pill` clipping/width, overlay clamping, toast/modal `z-index`, `>= 24px` targets)
4. `/impeccable colorize` (Contrast AA, Light Bird's-Eye tokens, `.hljs-*` theme, `color-scheme`/scrollbars, `:focus-visible`)
5. `/impeccable animate` (Emil Kowalski easing/press table, GPU `translate`/`scaleX`, reduced motion, idle FPS telemetry)
6. `/impeccable polish` (Final multi-theme verification pass in Chromium + native Tauri desktop window)

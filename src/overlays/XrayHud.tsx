import { useEffect, useRef, useState } from "preact/hooks";
import { compileXray, isTauriRuntime } from "../ipc/client";
import type { CompiledXray, InclusionMode } from "../ipc/types";
import { graphVersion, tokenBudget } from "../store/graphStore";
import { focusId, selectedIds, xrayPinned, xrayState } from "../store/selection";
import { notifyIpcError, pushToast } from "./ToastStack";

const LEGEND_ITEMS: Array<{ key: InclusionMode; label: string; colorVar: string }> = [
  { key: "pin", label: "Pin", colorVar: "var(--xray-pin)" },
  { key: "focus", label: "Focus", colorVar: "var(--xray-focus)" },
  { key: "full", label: "Full", colorVar: "var(--xray-full)" },
  { key: "summary", label: "Summary", colorVar: "var(--xray-summary)" },
  { key: "loophole", label: "Loophole", colorVar: "var(--xray-loophole)" },
  { key: "reference", label: "Reference", colorVar: "var(--xray-reference)" },
];

export function buildBrowserFallbackXray(targets: string[], budget: number): CompiledXray {
  const nodeModes: CompiledXray["node_modes"] = {};
  for (const id of targets) {
    nodeModes[id] = "focus";
  }
  return {
    total_tokens: 0,
    budget_tokens: budget,
    node_modes: nodeModes,
    active_edges: [],
  };
}

function getCurrentTargetIds(): string[] {
  const selected = selectedIds.value;
  if (selected.size > 0) {
    return Array.from(selected);
  }
  return focusId.value !== null ? [focusId.value] : [];
}

export function XrayHud() {
  const xray = xrayState.value;
  const pinned = xrayPinned.value;
  const version = graphVersion.value;
  const fid = focusId.value;
  const sel = selectedIds.value;
  const budgetSetting = tokenBudget.value;
  const selKey = Array.from(sel).join(",");

  const [promptOpen, setPromptOpen] = useState(false);
  const initialMountRef = useRef(true);

  useEffect(() => {
    if (!xray) {
      setPromptOpen(false);
    }
  }, [Boolean(xray)]);

  useEffect(() => {
    if (!pinned) {
      initialMountRef.current = true;
      return;
    }

    let cancelled = false;
    const targets = sel.size > 0 ? Array.from(sel) : fid !== null ? [fid] : [];

    const runRefresh = (forceLocalUpdate: boolean): void => {
      if (isTauriRuntime()) {
        void compileXray(targets, budgetSetting)
          .then((next) => {
            if (!cancelled && xrayPinned.value) {
              xrayState.value = next;
            }
          })
          .catch(notifyIpcError);
      } else if (forceLocalUpdate || xrayState.value === null) {
        xrayState.value = buildBrowserFallbackXray(targets, budgetSetting);
      }
    };

    const isFirstPinnedMount = initialMountRef.current;
    initialMountRef.current = false;
    runRefresh(!isFirstPinnedMount);

    const onRefreshEvent = (): void => {
      const latestTargets = getCurrentTargetIds();
      if (isTauriRuntime()) {
        void compileXray(latestTargets, tokenBudget.value)
          .then((next) => {
            if (!cancelled && xrayPinned.value) {
              xrayState.value = next;
            }
          })
          .catch(notifyIpcError);
      } else {
        xrayState.value = buildBrowserFallbackXray(latestTargets, tokenBudget.value);
      }
    };

    window.addEventListener("axiom:xray-refresh", onRefreshEvent);
    return () => {
      cancelled = true;
      window.removeEventListener("axiom:xray-refresh", onRefreshEvent);
    };
  }, [pinned, version, fid, selKey, budgetSetting]);

  if (!xray) {
    return null;
  }

  const budget = Math.max(1, xray.budget_tokens);
  const ratio = xray.total_tokens / budget;
  const clampedScale = Math.min(1, Math.max(0, ratio));
  const pct = Math.min(100, Math.round(ratio * 100));
  const desktopOnly = !isTauriRuntime();
  const isOverBudget = Boolean(xray.overflow) || xray.total_tokens > xray.budget_tokens;
  const fillClass = isOverBudget
    ? "xray-hud__fill xray-hud__fill--over"
    : ratio > 0.85
      ? "xray-hud__fill xray-hud__fill--warn"
      : "xray-hud__fill";

  const modeCounts: Record<InclusionMode, number> = {
    pin: 0,
    focus: 0,
    full: 0,
    summary: 0,
    loophole: 0,
    reference: 0,
  };
  for (const mode of Object.values(xray.node_modes)) {
    modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;
  }

  const handleTogglePin = (): void => {
    const nextPinned = !xrayPinned.value;
    xrayPinned.value = nextPinned;
    if (!nextPinned) {
      xrayState.value = null;
    } else {
      window.dispatchEvent(new Event("axiom:xray-refresh"));
    }
  };

  const handleClose = (): void => {
    xrayPinned.value = false;
    xrayState.value = null;
  };

  const handleCopyPrompt = (): void => {
    const text = xray.prompt_preview ?? "";
    if (!navigator.clipboard?.writeText) {
      pushToast("Clipboard API unavailable in this environment", "warning");
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        pushToast("Copied compiled prompt", "info");
      })
      .catch(() => {
        pushToast("Could not copy compiled prompt", "warning");
      });
  };

  return (
    <aside
      class={`xray-hud ${pinned ? "xray-hud--pinned" : ""}`}
      aria-label="Context X-Ray"
      onPointerDown={(e) => {
        if (pinned) {
          e.stopPropagation();
        }
      }}
      onWheel={(e) => {
        if (pinned) {
          e.stopPropagation();
        }
      }}
    >
      <div class="xray-hud__top">
        <div class="xray-hud__title-group">
          <span class="xray-hud__title">Context X-Ray</span>
          {isOverBudget && <span class="xray-hud__over-pill">OVER BUDGET</span>}
        </div>
        <div class="xray-hud__actions">
          <span class="xray-hud__tokens">
            {xray.total_tokens.toLocaleString()} / {xray.budget_tokens.toLocaleString()} tokens ({pct}
            %)
            {desktopOnly && <span class="xray-hud__runtime-note"> (desktop only)</span>}
          </span>
          <button
            type="button"
            class={`xray-hud__btn ${pinned ? "xray-hud__btn--active" : ""}`}
            aria-pressed={pinned}
            title={pinned ? "Unpin Context X-Ray (Shift+V)" : "Pin Context X-Ray (Shift+V)"}
            onClick={handleTogglePin}
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
          {pinned && (
            <button
              type="button"
              class="xray-hud__btn"
              aria-label="Close Context X-Ray"
              title="Close (Esc)"
              onClick={handleClose}
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div class="xray-hud__bar">
        <div class={fillClass} style={{ transform: `scaleX(${clampedScale})` }} />
      </div>

      <div class="xray-hud__legend">
        {LEGEND_ITEMS.map((item) => {
          const count = modeCounts[item.key];
          const tokens = xray.mode_tokens?.[item.key];
          return (
            <span key={item.key} class="xray-hud__legend-item xray-hud__chip">
              <span class="xray-hud__dot" style={{ backgroundColor: item.colorVar }} />
              <span>{item.label}</span>
              <span class="xray-hud__chip-meta">
                {count}
                {tokens !== undefined ? ` · ${tokens.toLocaleString()}t` : ""}
              </span>
            </span>
          );
        })}
      </div>

      {(pinned || xray.prompt_preview !== undefined) && (
        <div class="xray-hud__footer">
          <button
            type="button"
            class={`xray-hud__btn ${promptOpen ? "xray-hud__btn--active" : ""}`}
            aria-expanded={promptOpen}
            onClick={() => setPromptOpen((v) => !v)}
          >
            Inspect Prompt
          </button>
          {promptOpen && (
            <button type="button" class="xray-hud__btn" onClick={handleCopyPrompt}>
              Copy Prompt
            </button>
          )}
        </div>
      )}

      {promptOpen && (
        <pre class="xray-hud__prompt">{xray.prompt_preview ?? ""}</pre>
      )}
    </aside>
  );
}

import { xrayState } from "../store/selection";

const LEGEND_ITEMS: Array<{ key: string; label: string; colorVar: string }> = [
  { key: "pin", label: "Pin", colorVar: "var(--xray-pin)" },
  { key: "focus", label: "Focus", colorVar: "var(--xray-focus)" },
  { key: "full", label: "Full", colorVar: "var(--xray-full)" },
  { key: "summary", label: "Summary", colorVar: "var(--xray-summary)" },
  { key: "loophole", label: "Loophole", colorVar: "var(--xray-loophole)" },
  { key: "reference", label: "Reference", colorVar: "var(--xray-reference)" },
];

export function XrayHud() {
  const xray = xrayState.value;
  if (!xray) {
    return null;
  }

  const budget = Math.max(1, xray.budget_tokens);
  const ratio = xray.total_tokens / budget;
  const pct = Math.min(100, Math.round(ratio * 100));
  const fillClass =
    ratio > 1
      ? "xray-hud__fill xray-hud__fill--over"
      : ratio > 0.85
        ? "xray-hud__fill xray-hud__fill--warn"
        : "xray-hud__fill";

  return (
    <aside class="xray-hud" aria-label="Context X-Ray">
      <div class="xray-hud__top">
        <span class="xray-hud__title">Context X-Ray</span>
        <span class="xray-hud__tokens">
          {xray.total_tokens.toLocaleString()} / {xray.budget_tokens.toLocaleString()} tokens ({pct}%)
        </span>
      </div>
      <div class="xray-hud__bar">
        <div class={fillClass} style={{ width: `${pct}%` }} />
      </div>
      <div class="xray-hud__legend">
        {LEGEND_ITEMS.map((item) => (
          <span key={item.key} class="xray-hud__legend-item">
            <span class="xray-hud__dot" style={{ backgroundColor: item.colorVar }} />
            {item.label}
          </span>
        ))}
      </div>
    </aside>
  );
}

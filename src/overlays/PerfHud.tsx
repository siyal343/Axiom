import { useEffect, useState } from "preact/hooks";
import { type FrameStats, globalFrameTracker, perfHudOpen } from "../canvas/perfMetrics";
import { edgesMap, isBirdsEye, nodesMap, visibleNodeIds } from "../store/graphStore";

const POLL_INTERVAL_MS = 250;

export function PerfHud() {
  const isOpen = perfHudOpen.value;
  const [stats, setStats] = useState<FrameStats>(() => globalFrameTracker.getStats());

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setStats(globalFrameTracker.getStats());
    const timer = setInterval(() => {
      setStats(globalFrameTracker.getStats());
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const lodLabel = isBirdsEye.value ? "Bird's-Eye" : "Normal";
  const fpsDisplay = stats.sampleCount > 0 && stats.fps > 0 ? stats.fps.toFixed(0) : "—";

  return (
    <aside
      class="perf-hud"
      role="status"
      aria-label="Performance HUD"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div class="perf-hud__header">
        <span class="perf-hud__title">PERF</span>
        <button
          type="button"
          class="perf-hud__close"
          aria-label="Close Performance HUD"
          onClick={() => {
            perfHudOpen.value = false;
          }}
        >
          ×
        </button>
      </div>
      <div class="perf-hud__grid">
        <span class="perf-hud__label">FPS</span>
        <span class="perf-hud__value">{fpsDisplay}</span>
        <span class="perf-hud__label">p95 draw</span>
        <span class="perf-hud__value">{stats.p95DrawMs.toFixed(2)} ms</span>
        <span class="perf-hud__label">Graph</span>
        <span class="perf-hud__value">
          {nodesMap.size}N / {edgesMap.size}E
        </span>
        <span class="perf-hud__label">DOM cards</span>
        <span class="perf-hud__value">{visibleNodeIds.value.length}</span>
        <span class="perf-hud__label">LOD</span>
        <span class="perf-hud__value">{lodLabel}</span>
      </div>
    </aside>
  );
}

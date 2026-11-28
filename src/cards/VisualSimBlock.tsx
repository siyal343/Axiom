import type { ComponentChildren } from "preact";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import {
  evaluateVisualSim,
  type EvaluatedVisualSim,
  type SimPoint,
  type SimSeriesColor,
  type VisualSimSpec,
} from "./visualSimEngine";

interface VisualSimBlockProps {
  spec: VisualSimSpec;
}

const DOMAIN_BADGE_LABELS: Record<VisualSimSpec["domain"], string> = {
  controls: "Controls",
  rf: "RF",
  embedded: "Embedded",
  physics: "Physics",
  circuits: "Circuits",
  signals: "Signals",
  thermo: "Thermo",
  mechanics: "Mechanics",
  math: "Lab",
};

const SVG_W = 360;
const SVG_H = 156;
const PAD_L = 38;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 26;
const PLOT_W = SVG_W - PAD_L - PAD_R;
const PLOT_H = SVG_H - PAD_T - PAD_B;

function mapX(x: number, xMin: number, xMax: number, xScale: "linear" | "log" = "linear"): number {
  if (xScale === "log" && x > 0 && xMin > 0 && xMax > xMin) {
    const lx = Math.log10(x);
    const lMin = Math.log10(xMin);
    const lMax = Math.log10(xMax);
    const span = lMax - lMin || 1;
    return PAD_L + ((lx - lMin) / span) * PLOT_W;
  }
  const span = xMax - xMin || 1;
  return PAD_L + ((x - xMin) / span) * PLOT_W;
}

function mapY(y: number, yMin: number, yMax: number): number {
  const span = yMax - yMin || 1;
  return PAD_T + PLOT_H - ((y - yMin) / span) * PLOT_H;
}

function toPolylinePoints(
  pts: SimPoint[],
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
  xScale: "linear" | "log" = "linear",
): string {
  return pts
    .map((p) => {
      const px = clampRange(mapX(p.x, xMin, xMax, xScale), PAD_L - 4, PAD_L + PLOT_W + 4).toFixed(1);
      const py = clampRange(mapY(p.y, yMin, yMax), PAD_T - 6, PAD_T + PLOT_H + 6).toFixed(1);
      return `${px},${py}`;
    })
    .join(" ");
}

function stopCanvasPointer(e: Event): void {
  e.stopPropagation();
}

function formatParamValue(value: number, unit?: string): string {
  const abs = Math.abs(value);
  const rounded =
    abs >= 100
      ? value.toFixed(0)
      : Number.isInteger(value)
        ? String(value)
        : abs < 0.1
          ? value.toFixed(3)
          : value.toFixed(2);
  return unit ? `${rounded} ${unit}` : rounded;
}

function formatAxisTick(tick: number): string {
  const abs = Math.abs(tick);
  if (abs === 0) return "0";
  if (abs >= 1_000_000) return `${+(tick / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${+(tick / 1_000).toFixed(1)}k`;
  if (abs >= 100) return tick.toFixed(0);
  if (abs < 0.05) return tick.toExponential(0);
  if (abs < 1) return tick.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return tick.toFixed(1).replace(/\.0$/, "");
}

function computeXTicks(xMin: number, xMax: number, xScale: "linear" | "log"): number[] {
  if (xScale !== "log" || xMin <= 0 || xMax <= xMin) {
    return [xMin, xMin + (xMax - xMin) * 0.5, xMax];
  }
  const minExp = Math.ceil(Math.log10(xMin) - 1e-6);
  const maxExp = Math.floor(Math.log10(xMax) + 1e-6);
  const ticks: number[] = [];
  for (let exp = minExp; exp <= maxExp; exp += 1) {
    ticks.push(Math.pow(10, exp));
  }
  if (ticks.length < 2) {
    return [xMin, Math.sqrt(xMin * xMax), xMax];
  }
  return ticks.slice(0, 6);
}

function clampRange(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function curveClassName(color: SimSeriesColor, dashed?: boolean): string {
  return `axiom-sim__curve axiom-sim__curve--${color}${dashed ? " axiom-sim__curve--dashed" : ""}`;
}

function renderCartesianOrParametricPlot(sim: EvaluatedVisualSim): ComponentChildren {
  const { xMin, xMax, yMin, yMax } = sim;
  const xScale = sim.xScale ?? "linear";
  const xTicks = computeXTicks(xMin, xMax, xScale);
  const yTicks = [yMin, yMin + (yMax - yMin) * 0.5, yMax];

  const targetY =
    typeof sim.targetLine === "number" && sim.targetLine >= yMin && sim.targetLine <= yMax
      ? mapY(sim.targetLine, yMin, yMax)
      : null;

  const bandTop = sim.band ? mapY(sim.band.high, yMin, yMax) : null;
  const bandBot = sim.band ? mapY(sim.band.low, yMin, yMax) : null;

  const zeroX = sim.kind === "parametric" && xMin < 0 && xMax > 0 ? mapX(0, xMin, xMax) : null;
  const zeroY = sim.kind === "parametric" && yMin < 0 && yMax > 0 ? mapY(0, yMin, yMax) : null;

  return (
    <svg
      class="axiom-sim__svg"
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      role="img"
      aria-label={`${sim.yLabel} versus ${sim.xLabel}`}
    >
      {bandTop !== null && bandBot !== null && (
        <rect
          x={PAD_L}
          y={Math.min(bandTop, bandBot)}
          width={PLOT_W}
          height={Math.max(1, Math.abs(bandBot - bandTop))}
          class="axiom-sim__band"
        />
      )}

      {yTicks.map((tick, idx) => {
        const py = mapY(tick, yMin, yMax);
        return (
          <g key={`yt-${idx}`}>
            <line x1={PAD_L} y1={py} x2={PAD_L + PLOT_W} y2={py} class="axiom-sim__grid" />
            <text x={PAD_L - 5} y={py + 3} text-anchor="end" class="axiom-sim__axis-label">
              {formatAxisTick(tick)}
            </text>
          </g>
        );
      })}

      {xTicks.map((tick, idx) => {
        const px = mapX(tick, xMin, xMax, xScale);
        return (
          <g key={`xt-${idx}`}>
            <line x1={px} y1={PAD_T} x2={px} y2={PAD_T + PLOT_H} class="axiom-sim__grid" />
            <text x={px} y={PAD_T + PLOT_H + 12} text-anchor="middle" class="axiom-sim__axis-label">
              {formatAxisTick(tick)}
            </text>
          </g>
        );
      })}

      {zeroX !== null && (
        <line x1={zeroX} y1={PAD_T} x2={zeroX} y2={PAD_T + PLOT_H} class="axiom-sim__axis" />
      )}
      {zeroY !== null && (
        <line x1={PAD_L} y1={zeroY} x2={PAD_L + PLOT_W} y2={zeroY} class="axiom-sim__axis" />
      )}

      {targetY !== null && (
        <line x1={PAD_L} y1={targetY} x2={PAD_L + PLOT_W} y2={targetY} class="axiom-sim__target-line" />
      )}

      {(sim.hLines ?? []).map((hl, idx) => {
        if (hl.y < yMin || hl.y > yMax) return null;
        const py = mapY(hl.y, yMin, yMax);
        return (
          <g key={`hl-${idx}`}>
            <line x1={PAD_L} y1={py} x2={PAD_L + PLOT_W} y2={py} class="axiom-sim__ref-line" />
            {hl.label && (
              <text x={PAD_L + PLOT_W - 2} y={Math.max(PAD_T + 8, py - 3)} text-anchor="end" class="axiom-sim__axis-label">
                {hl.label}
              </text>
            )}
          </g>
        );
      })}

      {(sim.vLines ?? []).map((vl, idx) => {
        if (vl.x < xMin || vl.x > xMax) return null;
        const px = mapX(vl.x, xMin, xMax, xScale);
        return (
          <g key={`vl-${idx}`}>
            <line x1={px} y1={PAD_T} x2={px} y2={PAD_T + PLOT_H} class="axiom-sim__ref-line" />
            {vl.label && (
              <text x={Math.min(PAD_L + PLOT_W - 4, px + 3)} y={PAD_T + 9} class="axiom-sim__axis-label">
                {vl.label}
              </text>
            )}
          </g>
        );
      })}

      {sim.envelopeUpper && sim.envelopeUpper.length > 1 && (
        <polyline
          fill="none"
          points={toPolylinePoints(sim.envelopeUpper, xMin, xMax, yMin, yMax)}
          class="axiom-sim__curve-env"
        />
      )}
      {sim.envelopeLower && sim.envelopeLower.length > 1 && (
        <polyline
          fill="none"
          points={toPolylinePoints(sim.envelopeLower, xMin, xMax, yMin, yMax)}
          class="axiom-sim__curve-env"
        />
      )}

      {sim.series && sim.series.length > 0 ? (
        sim.series.map((s, sIdx) =>
          s.segments.map((seg, segIdx) =>
            seg.length > 1 ? (
              <polyline
                key={`s-${sIdx}-${segIdx}`}
                fill="none"
                points={toPolylinePoints(seg, xMin, xMax, yMin, yMax, xScale)}
                class={curveClassName(s.color, s.dashed)}
              />
            ) : null,
          ),
        )
      ) : (
        <>
          {sim.secondary.length > 1 && (
            <polyline
              fill="none"
              points={toPolylinePoints(sim.secondary, xMin, xMax, yMin, yMax, xScale)}
              class="axiom-sim__curve-secondary"
            />
          )}
          {sim.primary.length > 1 && (
            <polyline
              fill="none"
              points={toPolylinePoints(sim.primary, xMin, xMax, yMin, yMax, xScale)}
              class="axiom-sim__curve-primary"
            />
          )}
        </>
      )}

      {(sim.markers ?? []).map((m, idx) => {
        const px = clampRange(mapX(m.x, xMin, xMax, xScale), PAD_L, PAD_L + PLOT_W);
        const py = clampRange(mapY(m.y, yMin, yMax), PAD_T, PAD_T + PLOT_H);
        return (
          <g key={`mk-${idx}`}>
            <circle cx={px} cy={py} r={3.8} class={`axiom-sim__marker-dot axiom-sim__marker-dot--${m.tone}`} />
            <text x={Math.min(PAD_L + PLOT_W - 6, px + 6)} y={Math.max(PAD_T + 9, py - 5)} class="axiom-sim__axis-label">
              {m.label}
            </text>
          </g>
        );
      })}

      <text x={PAD_L + PLOT_W / 2} y={SVG_H - 3} text-anchor="middle" class="axiom-sim__axis-title">
        {sim.xLabel}
      </text>
    </svg>
  );
}

function renderPolarPlot(sim: EvaluatedVisualSim): ComponentChildren {
  const polar = sim.polar;
  if (!polar) return null;
  const cx = SVG_W * 0.5;
  const cy = SVG_H * 0.51;
  const R = 58;
  const maxR = polar.maxR || 1;

  return (
    <svg
      class="axiom-sim__svg"
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      role="img"
      aria-label="Polar Magnitude Plot"
    >
      {[0.25, 0.5, 0.75, 1.0].map((frac) => (
        <circle key={`pr-${frac}`} cx={cx} cy={cy} r={R * frac} class="axiom-sim__polar-ring" />
      ))}
      <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} class="axiom-sim__grid" />
      <line x1={cx} y1={cy - R} x2={cx} y2={cy + R} class="axiom-sim__grid" />

      {polar.series.map((s, idx) => {
        const pts = s.points
          .map((p) => {
            const rad = (clampRange(p.r, 0, maxR) / maxR) * R;
            const px = cx + rad * Math.cos(p.theta);
            const py = cy - rad * Math.sin(p.theta);
            return `${px.toFixed(1)},${py.toFixed(1)}`;
          })
          .join(" ");
        return <polygon key={`ps-${idx}`} points={pts} fill="none" class={curveClassName(s.color, s.dashed)} />;
      })}

      <text x={cx + R + 6} y={cy + 3} class="axiom-sim__axis-label">0°</text>
      <text x={cx} y={cy - R - 4} text-anchor="middle" class="axiom-sim__axis-label">90°</text>
      <text x={cx - R - 6} y={cy + 3} text-anchor="end" class="axiom-sim__axis-label">180°</text>
      <text x={cx} y={cy + R + 10} text-anchor="middle" class="axiom-sim__axis-label">270°</text>
    </svg>
  );
}

function renderSPlanePlot(sim: EvaluatedVisualSim): ComponentChildren {
  const { xMin, xMax, yMin, yMax } = sim;
  const zeroX = mapX(0, xMin, xMax);
  const zeroY = mapY(0, yMin, yMax);

  return (
    <svg
      class="axiom-sim__svg"
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      role="img"
      aria-label="s-Plane Pole Locations"
    >
      <rect
        x={zeroX}
        y={PAD_T}
        width={Math.max(0, PAD_L + PLOT_W - zeroX)}
        height={PLOT_H}
        class="axiom-sim__rhp-zone"
      />
      <line x1={PAD_L} y1={zeroY} x2={PAD_L + PLOT_W} y2={zeroY} class="axiom-sim__axis" />
      <line x1={zeroX} y1={PAD_T} x2={zeroX} y2={PAD_T + PLOT_H} class="axiom-sim__axis" />

      {typeof sim.dampingLineSlope === "number" && (
        <>
          <line
            x1={zeroX}
            y1={zeroY}
            x2={PAD_L}
            y2={Math.max(PAD_T, zeroY - (zeroX - PAD_L) * sim.dampingLineSlope * 0.45)}
            class="axiom-sim__grid-dashed"
          />
          <line
            x1={zeroX}
            y1={zeroY}
            x2={PAD_L}
            y2={Math.min(PAD_T + PLOT_H, zeroY + (zeroX - PAD_L) * sim.dampingLineSlope * 0.45)}
            class="axiom-sim__grid-dashed"
          />
        </>
      )}

      {(sim.poles ?? []).map((pole, idx) => {
        const px = clampRange(mapX(pole.re, xMin, xMax), PAD_L + 4, PAD_L + PLOT_W - 4);
        const py = clampRange(mapY(pole.im, yMin, yMax), PAD_T + 4, PAD_T + PLOT_H - 4);
        const isUnstable = pole.re > 0;
        return (
          <g key={`pole-${idx}`} class={isUnstable ? "axiom-sim__pole--crit" : "axiom-sim__pole"}>
            <line x1={px - 5} y1={py - 5} x2={px + 5} y2={py + 5} stroke-width="2" />
            <line x1={px - 5} y1={py + 5} x2={px + 5} y2={py - 5} stroke-width="2" />
            <text x={px + 8} y={py - 4} class="axiom-sim__axis-label">
              {pole.label}
            </text>
          </g>
        );
      })}

      <text x={zeroX + 6} y={PAD_T + 11} class="axiom-sim__axis-label">
        RHP (Unstable)
      </text>
      <text x={PAD_L + 6} y={PAD_T + 11} class="axiom-sim__axis-label">
        LHP (Stable)
      </text>
    </svg>
  );
}

function renderSmithChart(sim: EvaluatedVisualSim): ComponentChildren {
  const cx = SVG_W * 0.45;
  const cy = SVG_H * 0.5;
  const R = 62;
  const sm = sim.smith;
  const gx = sm ? cx + sm.gammaRe * R : cx;
  const gy = sm ? cy - sm.gammaIm * R : cy;
  const swrR = sm ? sm.gammaMag * R : 0;

  return (
    <svg
      class="axiom-sim__svg"
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      role="img"
      aria-label="Normalized RF Smith Chart"
    >
      <defs>
        <clipPath id="axiom-smith-clip">
          <circle cx={cx} cy={cy} r={R} />
        </clipPath>
      </defs>

      <circle cx={cx} cy={cy} r={R} class="axiom-sim__smith-outer" />
      <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} class="axiom-sim__grid" />

      <g clip-path="url(#axiom-smith-clip)">
        {[0.5, 1, 2].map((rVal) => {
          const rad = R / (1 + rVal);
          const centerX = cx + (rVal / (1 + rVal)) * R;
          return (
            <circle
              key={`smith-r-${rVal}`}
              cx={centerX}
              cy={cy}
              r={rad}
              class={rVal === 1 ? "axiom-sim__smith-match-circle" : "axiom-sim__grid"}
              fill="none"
            />
          );
        })}
        {[0.5, -0.5, 1, -1, 2, -2].map((xVal) => {
          const rad = R / Math.abs(xVal);
          const arcCy = cy - R / xVal;
          return (
            <circle
              key={`smith-x-${xVal}`}
              cx={cx + R}
              cy={arcCy}
              r={rad}
              class="axiom-sim__grid"
              fill="none"
            />
          );
        })}
      </g>

      {swrR > 1 && <circle cx={cx} cy={cy} r={swrR} class="axiom-sim__target-line" fill="none" />}

      <line x1={cx} y1={cy} x2={gx} y2={gy} class="axiom-sim__curve-secondary" />
      <circle cx={cx} cy={cy} r={2.5} class="axiom-sim__axis-dot" />
      <circle cx={gx} cy={gy} r={4.5} class="axiom-sim__smith-dot" />

      <text x={cx + R + 12} y={cy - 18} class="axiom-sim__axis-label">
        z = {sm ? `${sm.r.toFixed(2)} ${sm.x >= 0 ? "+" : "−"} j${Math.abs(sm.x).toFixed(2)}` : "1.0"}
      </text>
      <text x={cx + R + 12} y={cy} class="axiom-sim__axis-label">
        Center = Z₀ Match
      </text>
      <text x={cx + R + 12} y={cy + 16} class="axiom-sim__axis-label">
        Dashed = SWR circle
      </text>
      <text x={cx} y={cy - R - 4} text-anchor="middle" class="axiom-sim__axis-label">
        +jX Inductive
      </text>
      <text x={cx} y={cy + R + 11} text-anchor="middle" class="axiom-sim__axis-label">
        −jX Capacitive
      </text>
      <text x={cx - R - 4} y={cy + 3} text-anchor="end" class="axiom-sim__axis-label">
        0
      </text>
    </svg>
  );
}

function renderTimingDiagram(sim: EvaluatedVisualSim): ComponentChildren {
  const timing = sim.timing;
  if (!timing) return null;
  const rows = timing.channels;
  const rowH = (SVG_H - PAD_T - 14) / Math.max(1, rows.length);
  const labelW = 50;
  const w = SVG_W - labelW - 12;

  const mapTx = (t: number) => labelW + ((t - sim.xMin) / (sim.xMax - sim.xMin || 1)) * w;

  return (
    <svg
      class="axiom-sim__svg"
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      role="img"
      aria-label="Digital Bus Timing Diagram"
    >
      {rows.map((ch, idx) => {
        const yTop = PAD_T + idx * rowH + 5;
        const yBot = PAD_T + (idx + 1) * rowH - 7;
        const points: string[] = [];
        for (let i = 0; i < ch.samples.length; i += 1) {
          const cur = ch.samples[i];
          if (!cur) continue;
          const next = ch.samples[i + 1];
          const x0 = mapTx(cur.t);
          const y0 = cur.level > 0.5 ? yTop : yBot;
          points.push(`${x0.toFixed(1)},${y0.toFixed(1)}`);
          if (next) {
            const x1 = mapTx(next.t);
            points.push(`${x1.toFixed(1)},${y0.toFixed(1)}`);
          }
        }
        return (
          <g key={ch.name}>
            <text x={labelW - 6} y={(yTop + yBot) / 2 + 3} text-anchor="end" class="axiom-sim__axis-label">
              {ch.name}
            </text>
            <polyline
              fill="none"
              points={points.join(" ")}
              class={`axiom-sim__timing-line axiom-sim__timing-line--${ch.color}`}
            />
            {(ch.sampleEdges ?? []).map((edgeT, edgeIdx) => {
              const ex = mapTx(edgeT);
              return (
                <g key={`se-${edgeIdx}`}>
                  <line x1={ex} y1={yTop - 3} x2={ex} y2={SVG_H - 12} class="axiom-sim__sample-edge" />
                  <circle cx={ex} cy={(yTop + yBot) / 2} r={2.4} class="axiom-sim__smith-dot" />
                </g>
              );
            })}
          </g>
        );
      })}
      <text x={labelW} y={SVG_H - 2} class="axiom-sim__axis-title">
        {timing.edgeLabel} · {timing.durationLabel}
      </text>
    </svg>
  );
}

export function VisualSimBlock({ spec }: VisualSimBlockProps) {
  const uid = useId();
  const [playing, setPlaying] = useState(false);
  const [animTime, setAnimTime] = useState(0);
  const [values, setValues] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const p of spec.params) {
      init[p.id] = p.value;
    }
    return init;
  });

  const specSig = useMemo(
    () =>
      JSON.stringify({
        kind: spec.kind,
        preset: spec.preset,
        xScale: spec.xScale ?? "linear",
        expr: spec.expr ?? "",
        series: spec.series ?? [],
        channels: spec.channels ?? [],
        metrics: spec.metrics ?? [],
        params: spec.params,
      }),
    [spec],
  );
  const prevSpecSigRef = useRef<string>(specSig);

  useEffect(() => {
    if (prevSpecSigRef.current === specSig) {
      return;
    }
    prevSpecSigRef.current = specSig;
    const next: Record<string, number> = {};
    for (const p of spec.params) {
      next[p.id] = p.value;
    }
    setValues(next);
    setPlaying(false);
    setAnimTime(0);
  }, [specSig, spec.params]);

  useEffect(() => {
    if (!playing || !spec.animate) {
      return;
    }
    let rafId = 0;
    let lastTs = performance.now();

    const stepFrame = (now: number): void => {
      if (typeof document !== "undefined" && document.hidden) {
        lastTs = now;
        rafId = requestAnimationFrame(stepFrame);
        return;
      }
      const dt = Math.min(0.05, Math.max(0, (now - lastTs) / 1000));
      lastTs = now;
      setAnimTime((prev) => (prev + dt) % 60);
      rafId = requestAnimationFrame(stepFrame);
    };

    rafId = requestAnimationFrame(stepFrame);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [playing, spec.animate]);

  const sim = useMemo(() => evaluateVisualSim(spec, values, animTime), [spec, values, animTime]);

  const isModified =
    animTime > 0 ||
    playing ||
    spec.params.some((p) => Math.abs((values[p.id] ?? p.value) - p.value) > 1e-6);

  const handleReset = () => {
    const resetMap: Record<string, number> = {};
    for (const p of spec.params) {
      resetMap[p.id] = p.value;
    }
    setValues(resetMap);
    setPlaying(false);
    setAnimTime(0);
  };

  const legendItems =
    sim.polar && sim.polar.series.length >= 2
      ? sim.polar.series.map((s) => ({ label: s.label, color: s.color, dashed: s.dashed }))
      : sim.series && sim.series.length >= 2
        ? sim.series.map((s) => ({ label: s.label, color: s.color, dashed: s.dashed }))
        : [];

  return (
    <div
      class={`axiom-sim axiom-sim--${spec.domain}`}
      data-sim-preset={spec.preset}
      data-sim-kind={spec.kind}
      onPointerDown={stopCanvasPointer}
      onMouseDown={stopCanvasPointer}
      onDblClick={stopCanvasPointer}
      onWheel={stopCanvasPointer}
    >
      <div class="axiom-sim__header">
        <div class="axiom-sim__title-wrap">
          <span class={`axiom-sim__domain-pill axiom-sim__domain-pill--${spec.domain}`}>
            {DOMAIN_BADGE_LABELS[spec.domain]}
          </span>
          <span class="axiom-sim__title">{spec.title}</span>
        </div>
        <div class="axiom-sim__header-actions">
          {spec.animate && (
            <button
              type="button"
              class={`axiom-sim__play-btn${playing ? " axiom-sim__play-btn--active" : ""}`}
              aria-pressed={playing}
              title={playing ? "Pause time evolution" : "Play time evolution"}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? "Pause" : "Play"}
            </button>
          )}
          {isModified && (
            <button
              type="button"
              class="axiom-sim__reset-btn"
              title="Reset parameters to defaults"
              aria-label="Reset simulation parameters"
              onClick={handleReset}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      <div class="axiom-sim__viewport">
        {sim.error ? (
          <div class="axiom-sim__error">{sim.error}</div>
        ) : sim.kind === "smith" ? (
          renderSmithChart(sim)
        ) : sim.kind === "splane" ? (
          renderSPlanePlot(sim)
        ) : sim.kind === "polar" ? (
          renderPolarPlot(sim)
        ) : sim.kind === "timing" ? (
          renderTimingDiagram(sim)
        ) : (
          renderCartesianOrParametricPlot(sim)
        )}
      </div>

      {legendItems.length > 0 && (
        <div class="axiom-sim__legend" aria-label="Curve legend">
          {legendItems.map((item) => (
            <span key={item.label} class="axiom-sim__legend-item">
              <span
                class={`axiom-sim__legend-swatch axiom-sim__legend-swatch--${item.color}${
                  item.dashed ? " axiom-sim__legend-swatch--dashed" : ""
                }`}
              />
              <span>{item.label}</span>
            </span>
          ))}
        </div>
      )}

      {sim.metrics.length > 0 && (
        <div class="axiom-sim__metrics">
          {sim.metrics.map((m) => (
            <div key={m.label} class={`axiom-sim__metric axiom-sim__metric--${m.tone ?? "neutral"}`}>
              <span class="axiom-sim__metric-label">{m.label}</span>
              <span class="axiom-sim__metric-value">{m.value}</span>
            </div>
          ))}
        </div>
      )}

      {spec.params.length > 0 && (
        <div class="axiom-sim__controls">
          {spec.params.map((param) => {
            const val = values[param.id] ?? param.value;
            const pct =
              param.max > param.min ? ((val - param.min) / (param.max - param.min)) * 100 : 0;
            const inputId = `${uid}-${param.id}`;
            const formatted = formatParamValue(val, param.unit);
            return (
              <div key={param.id} class="axiom-sim__control">
                <div class="axiom-sim__control-top">
                  <label for={inputId} class="axiom-sim__control-label">
                    {param.label}
                  </label>
                  <span class="axiom-sim__control-readout">{formatted}</span>
                </div>
                <input
                  id={inputId}
                  type="range"
                  class="axiom-sim__slider"
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  value={val}
                  aria-label={param.label}
                  aria-valuetext={formatted}
                  style={{ "--slider-progress": `${pct.toFixed(1)}%` } as Record<string, string>}
                  onInput={(e) => {
                    const nextVal = Number.parseFloat(e.currentTarget.value);
                    if (Number.isFinite(nextVal)) {
                      setValues((prev) => ({ ...prev, [param.id]: nextVal }));
                    }
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      {spec.caption && <div class="axiom-sim__caption">{spec.caption}</div>}
    </div>
  );
}

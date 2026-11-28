export type VisualSimDomain =
  | "controls"
  | "rf"
  | "embedded"
  | "physics"
  | "circuits"
  | "signals"
  | "thermo"
  | "mechanics"
  | "math";

export type VisualSimKind =
  | "response"
  | "splane"
  | "smith"
  | "timing"
  | "wave"
  | "plot"
  | "bode"
  | "parametric"
  | "polar";

export type VisualSimPreset =
  | "second_order_step"
  | "pid_step"
  | "rc_step"
  | "splane"
  | "smith"
  | "rf_s11"
  | "spi_timing"
  | "pwm_rc"
  | "damped_wave"
  | "standing_wave"
  | "custom_expr";

export type SimSeriesColor = "accent" | "secondary" | "good" | "warn" | "crit";

export interface VisualSimParam {
  id: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

export interface VisualSimSeriesDef {
  label: string;
  expr?: string;
  xExpr?: string;
  yExpr?: string;
  color?: SimSeriesColor;
  dashed?: boolean;
}

export interface VisualSimRefLine {
  x?: number;
  y?: number;
  label?: string;
}

export interface VisualSimMarkerDef {
  label: string;
  xExpr: string;
  yExpr: string;
  tone?: "accent" | "good" | "warn" | "crit";
}

export interface VisualSimMetricDef {
  label: string;
  expr: string;
  unit?: string;
  precision?: number;
  tone?: "good" | "warn" | "crit" | "accent" | "neutral";
}

export interface VisualSimChannelDef {
  name: string;
  expr?: string;
  levels?: Array<[number, number]>;
  color?: "accent" | "good" | "warn";
}

export interface VisualSimSpec {
  version: 1;
  title: string;
  domain: VisualSimDomain;
  kind: VisualSimKind;
  preset: VisualSimPreset;
  caption?: string;
  xLabel: string;
  yLabel: string;
  xMin: number;
  xMax: number;
  yMin?: number;
  yMax?: number;
  xScale?: "linear" | "log";
  sMin?: number;
  sMax?: number;
  animate?: boolean;
  expr?: string;
  exprSecondary?: string;
  target?: number;
  series?: VisualSimSeriesDef[];
  hLines?: VisualSimRefLine[];
  vLines?: VisualSimRefLine[];
  markers?: VisualSimMarkerDef[];
  metrics?: VisualSimMetricDef[];
  channels?: VisualSimChannelDef[];
  params: VisualSimParam[];
}

export interface SimPoint {
  x: number;
  y: number;
}

export interface SimEvaluatedSeries {
  label: string;
  color: SimSeriesColor;
  dashed?: boolean;
  segments: SimPoint[][];
}

export interface SimEvaluatedMarker {
  label: string;
  x: number;
  y: number;
  tone: "accent" | "good" | "warn" | "crit";
}

export interface SimMetric {
  label: string;
  value: string;
  tone?: "good" | "warn" | "crit" | "accent" | "neutral";
}

export interface SimPole {
  re: number;
  im: number;
  label: string;
}

export interface SimTimingChannel {
  name: string;
  color: "accent" | "good" | "warn";
  samples: Array<{ t: number; level: number }>;
  sampleEdges?: number[];
}

export interface EvaluatedVisualSim {
  kind: VisualSimKind;
  preset: VisualSimPreset;
  domain: VisualSimDomain;
  xLabel: string;
  yLabel: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  xScale?: "linear" | "log";
  primary: SimPoint[];
  secondary: SimPoint[];
  series?: SimEvaluatedSeries[];
  hLines?: Array<{ y: number; label?: string }>;
  vLines?: Array<{ x: number; label?: string }>;
  markers?: SimEvaluatedMarker[];
  envelopeUpper?: SimPoint[];
  envelopeLower?: SimPoint[];
  targetLine?: number;
  band?: { low: number; high: number };
  poles?: SimPole[];
  dampingLineSlope?: number;
  smith?: {
    r: number;
    x: number;
    gammaRe: number;
    gammaIm: number;
    gammaMag: number;
    gammaDeg: number;
    vswr: number;
    returnLossDb: number;
    powerDeliveredPct: number;
  };
  polar?: {
    maxR: number;
    series: Array<{
      label: string;
      color: SimSeriesColor;
      dashed?: boolean;
      points: Array<{ theta: number; r: number }>;
    }>;
  };
  timing?: {
    channels: SimTimingChannel[];
    edgeLabel: string;
    durationLabel: string;
  };
  metrics: SimMetric[];
  regimeLabel?: string;
  regimeTone?: "good" | "warn" | "crit";
  error?: string;
}

const VALID_DOMAINS = new Set<VisualSimDomain>([
  "controls",
  "rf",
  "embedded",
  "physics",
  "circuits",
  "signals",
  "thermo",
  "mechanics",
  "math",
]);

const VALID_KINDS = new Set<VisualSimKind>([
  "response",
  "splane",
  "smith",
  "timing",
  "wave",
  "plot",
  "bode",
  "parametric",
  "polar",
]);

const VALID_SERIES_COLORS = new Set<SimSeriesColor>(["accent", "secondary", "good", "warn", "crit"]);
const VALID_METRIC_TONES = new Set<NonNullable<SimMetric["tone"]>>([
  "good",
  "warn",
  "crit",
  "accent",
  "neutral",
]);

const DEFAULT_PARAMS_BY_PRESET: Record<VisualSimPreset, VisualSimParam[]> = {
  second_order_step: [
    { id: "zeta", label: "Damping ζ", unit: "", min: 0.05, max: 1.8, step: 0.05, value: 0.35 },
    { id: "wn", label: "Natural ωn", unit: "rad/s", min: 0.8, max: 10, step: 0.2, value: 4.0 },
  ],
  pid_step: [
    { id: "kp", label: "Kp", unit: "", min: 0.2, max: 10, step: 0.2, value: 3.0 },
    { id: "ki", label: "Ki", unit: "", min: 0, max: 6, step: 0.2, value: 1.2 },
    { id: "kd", label: "Kd", unit: "", min: 0, max: 5, step: 0.1, value: 0.8 },
  ],
  rc_step: [
    { id: "tau", label: "Time const τ", unit: "ms", min: 0.2, max: 8, step: 0.2, value: 1.5 },
    { id: "vin", label: "Step Vin", unit: "V", min: 1, max: 12, step: 0.5, value: 5.0 },
  ],
  splane: [
    { id: "zeta", label: "Damping ζ", unit: "", min: -0.2, max: 1.5, step: 0.05, value: 0.4 },
    { id: "wn", label: "Radius ωn", unit: "rad/s", min: 0.5, max: 5, step: 0.25, value: 3.0 },
  ],
  smith: [
    { id: "rl", label: "Load RL", unit: "Ω", min: 5, max: 200, step: 5, value: 75 },
    { id: "xl", label: "Reactance XL", unit: "Ω", min: -120, max: 120, step: 5, value: 35 },
    { id: "z0", label: "Line Z0", unit: "Ω", min: 25, max: 100, step: 5, value: 50 },
  ],
  rf_s11: [
    { id: "f0", label: "Resonance f0", unit: "GHz", min: 1.0, max: 5.0, step: 0.1, value: 2.4 },
    { id: "q", label: "Loaded Q", unit: "", min: 2, max: 40, step: 1, value: 12 },
    { id: "match", label: "Coupling β", unit: "", min: 0.2, max: 2.0, step: 0.05, value: 0.9 },
  ],
  spi_timing: [
    { id: "cpol", label: "CPOL", unit: "", min: 0, max: 1, step: 1, value: 0 },
    { id: "cpha", label: "CPHA", unit: "", min: 0, max: 1, step: 1, value: 0 },
  ],
  pwm_rc: [
    { id: "duty", label: "Duty D", unit: "%", min: 5, max: 95, step: 5, value: 45 },
    { id: "freq_khz", label: "PWM f", unit: "kHz", min: 2, max: 50, step: 2, value: 10 },
    { id: "rc_ms", label: "RC τ", unit: "ms", min: 0.05, max: 2.0, step: 0.05, value: 0.35 },
  ],
  damped_wave: [
    { id: "amp", label: "Amplitude A", unit: "", min: 0.2, max: 2.0, step: 0.1, value: 1.0 },
    { id: "gamma", label: "Damping γ", unit: "1/s", min: 0, max: 1.5, step: 0.05, value: 0.25 },
    { id: "omega", label: "Angular ω", unit: "rad/s", min: 1, max: 12, step: 0.5, value: 5.0 },
  ],
  standing_wave: [
    { id: "amp1", label: "Forward E+", unit: "", min: 0.2, max: 1.5, step: 0.1, value: 1.0 },
    { id: "gamma", label: "Reflection |Γ|", unit: "", min: 0, max: 1.0, step: 0.05, value: 0.5 },
    { id: "k", label: "Wavenumber k", unit: "rad/m", min: 1, max: 6, step: 0.25, value: 2.5 },
  ],
  custom_expr: [
    { id: "a", label: "Gain a", unit: "", min: 0.2, max: 3.0, step: 0.1, value: 1.0 },
    { id: "b", label: "Rate b", unit: "", min: 0.2, max: 6.0, step: 0.2, value: 2.0 },
  ],
};

function hasDeclarativeBody(raw: Record<string, unknown>, kind: VisualSimKind): boolean {
  if (kind === "bode" || kind === "parametric" || kind === "polar" || kind === "plot") {
    return true;
  }
  if (typeof raw.expr === "string" && raw.expr.trim().length > 0) {
    return true;
  }
  if (Array.isArray(raw.series) && raw.series.length > 0) {
    return true;
  }
  if (Array.isArray(raw.channels) && raw.channels.length > 0) {
    return true;
  }
  return false;
}

function inferPreset(raw: Record<string, unknown>, kind: VisualSimKind): VisualSimPreset {
  const presetRaw =
    typeof raw.preset === "string"
      ? raw.preset
      : typeof raw.model === "string"
        ? raw.model
        : "";
  const norm = presetRaw.trim().toLowerCase().replace(/[\s-]+/g, "_");

  if (norm === "second_order_step" || norm === "2nd_order" || norm === "second_order" || norm === "step") {
    return "second_order_step";
  }
  if (norm === "pid_step" || norm === "pid" || norm === "pid_loop") {
    return "pid_step";
  }
  if (norm === "rc_step" || norm === "first_order" || norm === "1st_order" || norm === "rc") {
    return "rc_step";
  }
  if (norm === "splane" || norm === "s_plane" || norm === "poles") {
    return "splane";
  }
  if (norm === "smith" || norm === "smith_chart" || norm === "impedance") {
    return "smith";
  }
  if (norm === "rf_s11" || norm === "s11" || norm === "notch" || norm === "rlc_bandpass" || norm === "resonance") {
    return "rf_s11";
  }
  if (norm === "spi" || norm === "spi_timing") {
    return "spi_timing";
  }
  if (norm === "pwm" || norm === "pwm_rc" || norm === "pwm_dac") {
    return "pwm_rc";
  }
  if (norm === "damped_wave" || norm === "oscillator" || norm === "harmonic") {
    return "damped_wave";
  }
  if (norm === "standing_wave" || norm === "vswr" || norm === "interference") {
    return "standing_wave";
  }
  if (norm === "custom_expr" || norm === "custom" || hasDeclarativeBody(raw, kind)) {
    return "custom_expr";
  }

  switch (kind) {
    case "splane":
      return "splane";
    case "smith":
      return "smith";
    case "timing":
      return "spi_timing";
    case "wave":
      return "damped_wave";
    case "response":
    default:
      return "second_order_step";
  }
}

function inferDomain(rawDomain: unknown, preset: VisualSimPreset, kind: VisualSimKind): VisualSimDomain {
  if (typeof rawDomain === "string") {
    const d = rawDomain.trim().toLowerCase();
    if (d === "electronics" || d === "analog" || d === "power") return "circuits";
    if (d === "optics" || d === "em" || d === "electromagnetics" || d === "fluids") return "physics";
    if (d === "dsp" || d === "comm" || d === "communications") return "signals";
    if (d === "thermodynamics" || d === "heat") return "thermo";
    if (d === "statics" || d === "dynamics") return "mechanics";
    if (VALID_DOMAINS.has(d as VisualSimDomain)) return d as VisualSimDomain;
  }
  if (kind === "bode") return "controls";
  if (kind === "polar") return "rf";
  switch (preset) {
    case "second_order_step":
    case "pid_step":
    case "splane":
      return "controls";
    case "smith":
    case "rf_s11":
    case "standing_wave":
      return "rf";
    case "rc_step":
    case "spi_timing":
    case "pwm_rc":
      return "embedded";
    case "damped_wave":
      return "physics";
    default:
      return "math";
  }
}

function inferKind(rawKind: unknown, preset: VisualSimPreset): VisualSimKind {
  if (typeof rawKind === "string") {
    const k = rawKind.trim().toLowerCase() as VisualSimKind;
    if (VALID_KINDS.has(k)) return k;
  }
  switch (preset) {
    case "splane":
      return "splane";
    case "smith":
      return "smith";
    case "spi_timing":
    case "pwm_rc":
      return "timing";
    case "damped_wave":
    case "standing_wave":
      return "wave";
    case "custom_expr":
      return "plot";
    default:
      return "response";
  }
}

function finiteOr(val: unknown, fallback: number): number {
  return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function normalizeParam(raw: unknown): VisualSimParam | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim().slice(0, 32) : "";
  if (!id || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) return null;
  const label = typeof rec.label === "string" && rec.label.trim() ? rec.label.trim().slice(0, 40) : id;
  const unit = typeof rec.unit === "string" ? rec.unit.trim().slice(0, 16) : "";
  const min = finiteOr(rec.min, 0);
  const rawMax = finiteOr(rec.max, 10);
  const max = rawMax > min ? rawMax : min + 1;
  const rawStep = finiteOr(rec.step, (max - min) / 40);
  const step = rawStep > 0 ? rawStep : 0.1;
  const value = clamp(finiteOr(rec.value, (min + max) / 2), min, max);
  return { id, label, unit, min, max, step, value };
}

function normalizeSeries(raw: unknown): VisualSimSeriesDef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: VisualSimSeriesDef[] = [];
  for (let i = 0; i < raw.length && out.length < 4; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const expr = typeof rec.expr === "string" && rec.expr.trim() ? rec.expr.trim().slice(0, 240) : undefined;
    const xExpr =
      typeof rec.xExpr === "string" && rec.xExpr.trim() ? rec.xExpr.trim().slice(0, 240) : undefined;
    const yExpr =
      typeof rec.yExpr === "string" && rec.yExpr.trim() ? rec.yExpr.trim().slice(0, 240) : undefined;
    if (!expr && !(xExpr && yExpr)) continue;
    const defaultColors: SimSeriesColor[] = ["accent", "good", "warn", "secondary"];
    const color =
      typeof rec.color === "string" && VALID_SERIES_COLORS.has(rec.color as SimSeriesColor)
        ? (rec.color as SimSeriesColor)
        : (defaultColors[out.length] ?? "accent");
    const label =
      typeof rec.label === "string" && rec.label.trim()
        ? rec.label.trim().slice(0, 32)
        : `Curve ${out.length + 1}`;
    out.push({
      label,
      expr,
      xExpr,
      yExpr,
      color,
      dashed: rec.dashed === true,
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeRefLines(raw: unknown, axis: "x" | "y"): VisualSimRefLine[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: VisualSimRefLine[] = [];
  for (let i = 0; i < raw.length && out.length < 4; i += 1) {
    const item = raw[i];
    if (typeof item === "number" && Number.isFinite(item)) {
      out.push(axis === "x" ? { x: item } : { y: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const val = axis === "x" ? rec.x ?? rec.value : rec.y ?? rec.value;
    if (typeof val !== "number" || !Number.isFinite(val)) continue;
    const label = typeof rec.label === "string" && rec.label.trim() ? rec.label.trim().slice(0, 24) : undefined;
    out.push(axis === "x" ? { x: val, label } : { y: val, label });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeMarkers(raw: unknown): VisualSimMarkerDef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: VisualSimMarkerDef[] = [];
  for (let i = 0; i < raw.length && out.length < 6; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const xExprRaw = typeof rec.xExpr === "string" ? rec.xExpr : typeof rec.x === "string" || typeof rec.x === "number" ? String(rec.x) : "";
    const yExprRaw = typeof rec.yExpr === "string" ? rec.yExpr : typeof rec.y === "string" || typeof rec.y === "number" ? String(rec.y) : "";
    if (!xExprRaw.trim() || !yExprRaw.trim()) continue;
    const label = typeof rec.label === "string" && rec.label.trim() ? rec.label.trim().slice(0, 24) : `M${out.length + 1}`;
    const toneRaw = typeof rec.tone === "string" ? rec.tone : "accent";
    const tone =
      toneRaw === "good" || toneRaw === "warn" || toneRaw === "crit" ? toneRaw : "accent";
    out.push({
      label,
      xExpr: xExprRaw.trim().slice(0, 160),
      yExpr: yExprRaw.trim().slice(0, 160),
      tone,
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeMetrics(raw: unknown): VisualSimMetricDef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: VisualSimMetricDef[] = [];
  for (let i = 0; i < raw.length && out.length < 6; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const expr = typeof rec.expr === "string" ? rec.expr.trim().slice(0, 200) : "";
    if (!expr) continue;
    const label = typeof rec.label === "string" && rec.label.trim() ? rec.label.trim().slice(0, 24) : `Metric ${out.length + 1}`;
    const unit = typeof rec.unit === "string" ? rec.unit.trim().slice(0, 16) : undefined;
    const precision =
      typeof rec.precision === "number" && Number.isInteger(rec.precision) && rec.precision >= 0 && rec.precision <= 4
        ? rec.precision
        : 2;
    const tone =
      typeof rec.tone === "string" && VALID_METRIC_TONES.has(rec.tone as NonNullable<SimMetric["tone"]>)
        ? (rec.tone as SimMetric["tone"])
        : "accent";
    out.push({ label, expr, unit, precision, tone });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeChannels(raw: unknown): VisualSimChannelDef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: VisualSimChannelDef[] = [];
  for (let i = 0; i < raw.length && out.length < 6; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim().slice(0, 14) : `CH${out.length}`;
    const expr = typeof rec.expr === "string" && rec.expr.trim() ? rec.expr.trim().slice(0, 240) : undefined;
    let levels: Array<[number, number]> | undefined;
    if (Array.isArray(rec.levels)) {
      levels = [];
      for (const pair of rec.levels) {
        if (
          Array.isArray(pair) &&
          pair.length >= 2 &&
          typeof pair[0] === "number" &&
          typeof pair[1] === "number" &&
          Number.isFinite(pair[0]) &&
          Number.isFinite(pair[1])
        ) {
          levels.push([pair[0], pair[1] > 0.5 ? 1 : 0]);
        }
      }
      if (levels.length === 0) levels = undefined;
    }
    if (!expr && !levels) continue;
    const color = rec.color === "good" || rec.color === "warn" ? rec.color : "accent";
    out.push({ name, expr, levels, color });
  }
  return out.length > 0 ? out : undefined;
}

function expressionUsesTime(raw: Record<string, unknown>, series?: VisualSimSeriesDef[], channels?: VisualSimChannelDef[], markers?: VisualSimMarkerDef[], metrics?: VisualSimMetricDef[]): boolean {
  const texts: string[] = [];
  if (typeof raw.expr === "string") texts.push(raw.expr);
  if (typeof raw.exprSecondary === "string") texts.push(raw.exprSecondary);
  for (const s of series ?? []) {
    if (s.expr) texts.push(s.expr);
    if (s.xExpr) texts.push(s.xExpr);
    if (s.yExpr) texts.push(s.yExpr);
  }
  for (const c of channels ?? []) {
    if (c.expr) texts.push(c.expr);
  }
  for (const m of markers ?? []) {
    texts.push(m.xExpr, m.yExpr);
  }
  for (const met of metrics ?? []) {
    texts.push(met.expr);
  }
  return texts.some((txt) => /\btime\b/.test(txt));
}

export function normalizeVisualSimSpec(input: unknown): VisualSimSpec | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const raw = input as Record<string, unknown>;
  const initialKind =
    typeof raw.kind === "string" ? (raw.kind.trim().toLowerCase() as VisualSimKind) : "response";
  const safeInitialKind = VALID_KINDS.has(initialKind) ? initialKind : "response";
  const preset = inferPreset(raw, safeInitialKind);
  const kind = inferKind(raw.kind, preset);
  const domain = inferDomain(raw.domain, preset, kind);

  const defaultParams = DEFAULT_PARAMS_BY_PRESET[preset].map((p) => {
    let overrideVal: unknown = raw[p.id];
    if (overrideVal === undefined && preset === "smith") {
      const loadObj =
        raw.load_ohm && typeof raw.load_ohm === "object"
          ? (raw.load_ohm as Record<string, unknown>)
          : null;
      if (p.id === "rl") overrideVal = raw.rl ?? raw.r ?? loadObj?.r;
      if (p.id === "xl") overrideVal = raw.xl ?? raw.x ?? loadObj?.x;
      if (p.id === "z0") overrideVal = raw.z0 ?? raw.z0_ohm;
    }
    if (typeof overrideVal === "number" && Number.isFinite(overrideVal)) {
      return { ...p, value: clamp(overrideVal, p.min, p.max) };
    }
    return { ...p };
  });
  let params: VisualSimParam[] = defaultParams;
  if (Array.isArray(raw.params)) {
    const parsed = raw.params.map(normalizeParam).filter((p): p is VisualSimParam => p !== null);
    if (parsed.length > 0) {
      params = parsed.slice(0, 5);
    } else if (preset === "custom_expr" && raw.params.length === 0) {
      params = [];
    }
  }

  const series = normalizeSeries(raw.series);
  const hLines = normalizeRefLines(raw.hLines, "y");
  const vLines = normalizeRefLines(raw.vLines, "x");
  const markers = normalizeMarkers(raw.markers);
  const metrics = normalizeMetrics(raw.metrics);
  const channels = normalizeChannels(raw.channels);

  const defaultTitleMap: Record<VisualSimPreset, string> = {
    second_order_step: "2nd-Order Closed-Loop Step Response",
    pid_step: "PID Step Response Lab",
    rc_step: "1st-Order RC Charging Transient",
    splane: "s-Plane Pole Loci & Damping Cone",
    smith: "Normalized Smith Chart & Match",
    rf_s11: "RF Resonator S11 Return Loss",
    spi_timing: "SPI Bus Mode Timing (CPOL / CPHA)",
    pwm_rc: "PWM + RC Low-Pass Filter Ripple",
    damped_wave: "Damped Harmonic Oscillator",
    standing_wave: "Transmission Line Standing Wave",
    custom_expr:
      kind === "bode"
        ? "Bode Frequency Response"
        : kind === "parametric"
          ? "2D Parametric Phase / Trajectory"
          : kind === "polar"
            ? "Polar Radiation / Gain Pattern"
            : kind === "timing"
              ? "Digital Timing Diagram"
              : "Parametric Curve Explorer",
  };

  const title =
    typeof raw.title === "string" && raw.title.trim()
      ? raw.title.trim().slice(0, 80)
      : defaultTitleMap[preset];

  const caption =
    typeof raw.caption === "string" && raw.caption.trim()
      ? raw.caption.trim().slice(0, 180)
      : undefined;

  const defaultXRange: Record<VisualSimPreset, [number, number, string, string]> = {
    second_order_step: [0, 8, "Time t (s)", "Amplitude y(t)"],
    pid_step: [0, 10, "Time t (s)", "Output y(t)"],
    rc_step: [0, 10, "Time t (ms)", "Voltage Vc (V)"],
    splane: [-6, 2, "Real σ (1/s)", "Imag jω (rad/s)"],
    smith: [-1.15, 1.15, "Re(Γ)", "Im(Γ)"],
    rf_s11: [1.0, 4.0, "Frequency f (GHz)", "|S11| (dB)"],
    spi_timing: [0, 8, "Clock Cycles", "Logic Level"],
    pwm_rc: [0, 0.5, "Time t (ms)", "Voltage (V)"],
    damped_wave: [0, 6, "Time t (s)", "Displacement y(t)"],
    standing_wave: [0, 6, "Position z (m)", "|V(z)| Envelope"],
    custom_expr:
      kind === "bode"
        ? [1, 100000, "Frequency (Hz)", "Magnitude (dB)"]
        : kind === "parametric"
          ? [-5, 5, "x(s)", "y(s)"]
          : kind === "timing"
            ? [0, 10, "Cycles / Time", "Logic"]
            : [0, 6.28, "x", "f(x)"],
  };

  const [dxMin, dxMax, dxLabel, dyLabel] = defaultXRange[preset];
  const xScale: "linear" | "log" =
    raw.xScale === "log" || (kind === "bode" && raw.xScale !== "linear") ? "log" : "linear";
  let xMin = finiteOr(raw.xMin, dxMin);
  if (xScale === "log") {
    xMin = Math.max(1e-4, xMin);
  }
  const rawXMax = finiteOr(raw.xMax, dxMax);
  const xMax = rawXMax > xMin ? rawXMax : xScale === "log" ? xMin * 100 : xMin + 1;

  const sMin = finiteOr(raw.sMin, 0);
  const rawSMax = finiteOr(raw.sMax, 2 * Math.PI);
  const sMax = rawSMax > sMin ? rawSMax : sMin + 1;

  const animate =
    raw.animate === true || expressionUsesTime(raw, series, channels, markers, metrics);

  return {
    version: 1,
    title,
    domain,
    kind,
    preset,
    caption,
    xLabel: typeof raw.xLabel === "string" && raw.xLabel.trim() ? raw.xLabel.trim().slice(0, 32) : dxLabel,
    yLabel: typeof raw.yLabel === "string" && raw.yLabel.trim() ? raw.yLabel.trim().slice(0, 32) : dyLabel,
    xMin,
    xMax,
    yMin: typeof raw.yMin === "number" && Number.isFinite(raw.yMin) ? raw.yMin : undefined,
    yMax: typeof raw.yMax === "number" && Number.isFinite(raw.yMax) ? raw.yMax : undefined,
    xScale,
    sMin,
    sMax,
    animate,
    expr: typeof raw.expr === "string" ? raw.expr.trim().slice(0, 240) : undefined,
    exprSecondary:
      typeof raw.exprSecondary === "string" ? raw.exprSecondary.trim().slice(0, 240) : undefined,
    target: typeof raw.target === "number" && Number.isFinite(raw.target) ? raw.target : undefined,
    series,
    hLines,
    vLines,
    markers,
    metrics,
    channels,
    params,
  };
}

export function parseVisualSimSpec(rawText: string): VisualSimSpec | null {
  const trimmed = rawText.trim();
  if (!trimmed || trimmed.length > 16000) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return normalizeVisualSimSpec(parsed);
  } catch {
    return null;
  }
}

// ---------- Safe Recursive-Descent Math Expression Evaluator (No eval / Function) ----------

type MathToken =
  | { type: "num"; value: number }
  | { type: "ident"; value: string }
  | { type: "op"; value: string }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "comma" };

const MATH_FUNCS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  sqrt: Math.sqrt,
  abs: Math.abs,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  clamp: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
  step: (x: number) => (x >= 0 ? 1 : 0),
  rect: (x: number) => (Math.abs(x) <= 0.5 ? 1 : 0),
  sinc: (x: number) => (Math.abs(x) < 1e-8 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)),
  mod: (a: number, b: number) => (b === 0 ? Number.NaN : ((a % b) + b) % b),
  ifelse: (cond: number, a: number, b: number) => (cond > 0 ? a : b),
};

function tokenizeMath(expr: string): MathToken[] {
  const tokens: MathToken[] = [];
  let i = 0;
  while (i < expr.length) {
    if (tokens.length > 220) {
      throw new Error("Expression exceeds token limit");
    }
    const ch = expr[i] ?? "";
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if ((ch >= "0" && ch <= "9") || (ch === "." && i + 1 < expr.length && /\d/.test(expr[i + 1] ?? ""))) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j] ?? "")) j += 1;
      if (j < expr.length && (expr[j] === "e" || expr[j] === "E")) {
        j += 1;
        if (expr[j] === "+" || expr[j] === "-") j += 1;
        while (j < expr.length && /\d/.test(expr[j] ?? "")) j += 1;
      }
      const num = Number.parseFloat(expr.slice(i, j));
      if (!Number.isFinite(num)) throw new Error("Invalid number");
      tokens.push({ type: "num", value: num });
      i = j;
      continue;
    }
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      let j = i;
      while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j] ?? "")) j += 1;
      tokens.push({ type: "ident", value: expr.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma" });
      i += 1;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "^") {
      tokens.push({ type: "op", value: ch });
      i += 1;
      continue;
    }
    throw new Error(`Unsupported token '${ch}'`);
  }
  return tokens;
}

export function evaluateSafeMathExpression(
  expr: string,
  vars: Record<string, number>,
): number {
  const tokens = tokenizeMath(expr);
  let pos = 0;

  const peek = (): MathToken | undefined => tokens[pos];
  const consume = (): MathToken | undefined => {
    const t = tokens[pos];
    pos += 1;
    return t;
  };

  const parseExpr = (depth: number): number => {
    if (depth > 28) throw new Error("Expression too deeply nested");
    let left = parseTerm(depth + 1);
    while (true) {
      const t = peek();
      if (t?.type === "op" && (t.value === "+" || t.value === "-")) {
        consume();
        const right = parseTerm(depth + 1);
        left = t.value === "+" ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  };

  const parseTerm = (depth: number): number => {
    let left = parsePower(depth + 1);
    while (true) {
      const t = peek();
      if (t?.type === "op" && (t.value === "*" || t.value === "/")) {
        consume();
        const right = parsePower(depth + 1);
        left = t.value === "*" ? left * right : right === 0 ? Number.NaN : left / right;
      } else {
        break;
      }
    }
    return left;
  };

  const parsePower = (depth: number): number => {
    const base = parseUnary(depth + 1);
    const t = peek();
    if (t?.type === "op" && t.value === "^") {
      consume();
      const exp = parsePower(depth + 1);
      return Math.pow(base, exp);
    }
    return base;
  };

  const parseUnary = (depth: number): number => {
    const t = peek();
    if (t?.type === "op" && (t.value === "+" || t.value === "-")) {
      consume();
      const val = parseUnary(depth + 1);
      return t.value === "-" ? -val : val;
    }
    return parsePrimary(depth + 1);
  };

  const parsePrimary = (depth: number): number => {
    const t = consume();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.type === "num") return t.value;
    if (t.type === "lparen") {
      const val = parseExpr(depth + 1);
      const close = consume();
      if (close?.type !== "rparen") throw new Error("Missing ')'");
      return val;
    }
    if (t.type === "ident") {
      const lower = t.value.toLowerCase();
      if (peek()?.type === "lparen") {
        const fn = MATH_FUNCS[lower];
        if (!fn) throw new Error(`Unsupported function '${t.value}'`);
        consume();
        const args: number[] = [];
        if (peek()?.type !== "rparen") {
          args.push(parseExpr(depth + 1));
          while (peek()?.type === "comma") {
            consume();
            args.push(parseExpr(depth + 1));
          }
        }
        const close = consume();
        if (close?.type !== "rparen") throw new Error("Missing ')' after function");
        return fn(...args);
      }
      if (lower === "pi") return Math.PI;
      if (lower === "e") return Math.E;
      if (Object.prototype.hasOwnProperty.call(vars, t.value)) {
        return vars[t.value] ?? 0;
      }
      if (Object.prototype.hasOwnProperty.call(vars, lower)) {
        return vars[lower] ?? 0;
      }
      return 0;
    }
    throw new Error("Unexpected token");
  };

  const result = parseExpr(0);
  if (pos < tokens.length) throw new Error("Trailing tokens in expression");
  return result;
}

// ---------- Declarative Helpers (Metrics, Markers, RefLines, Segment Splitting) ----------

function buildVarScope(spec: VisualSimSpec, values: Record<string, number>, animTime: number): Record<string, number> {
  const vars: Record<string, number> = { time: animTime };
  for (const p of spec.params) {
    vars[p.id] = Number.isFinite(values[p.id]) ? (values[p.id] as number) : p.value;
  }
  for (const [k, v] of Object.entries(values)) {
    if (Number.isFinite(v)) vars[k] = v;
  }
  return vars;
}

function evaluateDeclarativeMetrics(
  defs: VisualSimMetricDef[] | undefined,
  vars: Record<string, number>,
): SimMetric[] {
  if (!defs || defs.length === 0) return [];
  const metrics: SimMetric[] = [];
  for (const def of defs) {
    try {
      const val = evaluateSafeMathExpression(def.expr, vars);
      const formatted = Number.isFinite(val)
        ? def.unit
          ? `${val.toFixed(def.precision ?? 2)} ${def.unit}`
          : val.toFixed(def.precision ?? 2)
        : "—";
      metrics.push({ label: def.label, value: formatted, tone: def.tone ?? "accent" });
    } catch {
      metrics.push({ label: def.label, value: "Err", tone: "crit" });
    }
  }
  return metrics;
}

function evaluateDeclarativeMarkers(
  defs: VisualSimMarkerDef[] | undefined,
  vars: Record<string, number>,
): SimEvaluatedMarker[] | undefined {
  if (!defs || defs.length === 0) return undefined;
  const markers: SimEvaluatedMarker[] = [];
  for (const def of defs) {
    try {
      const x = evaluateSafeMathExpression(def.xExpr, vars);
      const y = evaluateSafeMathExpression(def.yExpr, vars);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        markers.push({
          label: def.label,
          x,
          y,
          tone: def.tone ?? "accent",
        });
      }
    } catch {
      // Skip invalid marker expression without failing entire plot.
    }
  }
  return markers.length > 0 ? markers : undefined;
}

function splitDiscontinuousSegments(
  rawPoints: Array<SimPoint | null>,
  ySpanHint: number,
): SimPoint[][] {
  const segments: SimPoint[][] = [];
  let current: SimPoint[] = [];
  // Over 180 samples, a continuous curve changes by far less than 65% of total Y span in one step;
  // larger single-step jumps indicate vertical asymptotes (e.g. tan, 1/(x-a)) or step discontinuities.
  const jumpThreshold = Math.max(8, ySpanHint * 0.65);

  for (const pt of rawPoints) {
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    const prev = current[current.length - 1];
    if (prev && Math.abs(pt.y - prev.y) > jumpThreshold && ySpanHint > 0) {
      segments.push(current);
      current = [pt];
    } else {
      current.push(pt);
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

// ---------- Domain Physics / Controls / RF / Embedded Evaluators ----------

function getParamVal(spec: VisualSimSpec, values: Record<string, number>, id: string, fallback: number): number {
  if (Number.isFinite(values[id])) return values[id] ?? fallback;
  const found = spec.params.find((p) => p.id.toLowerCase() === id.toLowerCase());
  return found ? found.value : fallback;
}

function evalSecondOrderStep(spec: VisualSimSpec, values: Record<string, number>): EvaluatedVisualSim {
  const zeta = clamp(getParamVal(spec, values, "zeta", 0.35), 0.01, 4.0);
  const wn = clamp(getParamVal(spec, values, "wn", 4.0), 0.2, 30.0);
  const target = spec.target ?? 1.0;
  const xMin = spec.xMin;
  const xMax = spec.xMax;
  const pts: SimPoint[] = [];
  const N = 180;

  let peak = 0;
  let tp = 0;
  for (let i = 0; i <= N; i += 1) {
    const t = xMin + ((xMax - xMin) * i) / N;
    let y = 0;
    if (t > 0) {
      if (zeta < 0.999) {
        const wd = wn * Math.sqrt(1 - zeta * zeta);
        const factor = zeta / Math.sqrt(1 - zeta * zeta);
        y = target * (1 - Math.exp(-zeta * wn * t) * (Math.cos(wd * t) + factor * Math.sin(wd * t)));
      } else if (Math.abs(zeta - 1) <= 0.001) {
        y = target * (1 - Math.exp(-wn * t) * (1 + wn * t));
      } else {
        const sRoot = Math.sqrt(zeta * zeta - 1);
        const p1 = wn * (zeta - sRoot);
        const p2 = wn * (zeta + sRoot);
        y = target * (1 - (p2 * Math.exp(-p1 * t) - p1 * Math.exp(-p2 * t)) / (p2 - p1));
      }
    }
    if (y > peak) {
      peak = y;
      tp = t;
    }
    pts.push({ x: t, y });
  }

  const osPct = zeta < 1 ? Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) * 100 : 0;
  const ts = 4 / (zeta * wn);
  const regimeLabel =
    zeta < 0.99 ? "Underdamped" : Math.abs(zeta - 1) <= 0.03 ? "Critically Damped" : "Overdamped";
  const regimeTone = zeta < 0.25 ? "warn" : "good";

  return {
    kind: "response",
    preset: spec.preset,
    domain: spec.domain,
    xLabel: spec.xLabel,
    yLabel: spec.yLabel,
    xMin,
    xMax,
    yMin: spec.yMin ?? 0,
    yMax: spec.yMax ?? Math.max(1.4, peak * 1.12),
    primary: pts,
    secondary: [],
    targetLine: target,
    band: { low: target * 0.98, high: target * 1.02 },
    regimeLabel,
    regimeTone,
    metrics: [
      { label: "%OS", value: `${osPct.toFixed(1)}%`, tone: osPct > 25 ? "warn" : "good" },
      { label: "Ts (2%)", value: `${ts.toFixed(2)} s`, tone: ts > xMax ? "warn" : "accent" },
      {
        label: "Tp",
        value: zeta < 1 ? `${tp.toFixed(2)} s` : "None",
        tone: "neutral",
      },
      { label: "Regime", value: regimeLabel, tone: regimeTone },
    ],
  };
}

function evalPidStep(spec: VisualSimSpec, values: Record<string, number>): EvaluatedVisualSim {
  const kp = getParamVal(spec, values, "kp", 3.0);
  const ki = getParamVal(spec, values, "ki", 1.2);
  const kd = getParamVal(spec, values, "kd", 0.8);
  const target = spec.target ?? 1.0;
  const xMin = 0;
  const xMax = Math.max(4, spec.xMax);
  const dt = 0.02;
  const steps = Math.round(xMax / dt);

  let y = 0;
  let dy = 0;
  let integral = 0;
  let prevErr = target;
  let peak = 0;
  let lastOutsideIdx = 0;
  const pts: SimPoint[] = [];
  const stride = Math.max(1, Math.floor(steps / 180));

  for (let i = 0; i <= steps; i += 1) {
    const t = i * dt;
    const err = target - y;
    const dErr = i === 0 ? 0 : (err - prevErr) / dt;
    integral = clamp(integral + err * dt, -20, 20);
    const u = kp * err + ki * integral + kd * dErr;
    const ddy = clamp(u - 1.2 * dy - y, -80, 80);
    dy += ddy * dt;
    y += dy * dt;
    prevErr = err;

    if (y > peak) peak = y;
    if (Math.abs(y - target) > 0.02 * target) lastOutsideIdx = i;
    if (i % stride === 0 || i === steps) {
      pts.push({ x: t, y });
    }
  }

  const finalY = pts[pts.length - 1]?.y ?? 0;
  const essPct = Math.abs(target - finalY) * 100;
  const osPct = Math.max(0, ((peak - target) / target) * 100);
  const ts = lastOutsideIdx * dt;
  const unstable = peak > 4 || !Number.isFinite(finalY);

  return {
    kind: "response",
    preset: "pid_step",
    domain: "controls",
    xLabel: spec.xLabel,
    yLabel: spec.yLabel,
    xMin,
    xMax,
    yMin: spec.yMin ?? Math.min(0, ...pts.map((p) => p.y)),
    yMax: spec.yMax ?? Math.min(3.5, Math.max(1.4, peak * 1.12)),
    primary: pts,
    secondary: [],
    targetLine: target,
    band: { low: target * 0.98, high: target * 1.02 },
    regimeLabel: unstable ? "Oscillatory / Unstable" : essPct < 2 ? "Converged" : "Steady Offset",
    regimeTone: unstable ? "crit" : essPct < 2 ? "good" : "warn",
    metrics: [
      { label: "%OS", value: `${osPct.toFixed(1)}%`, tone: osPct > 25 ? "warn" : "good" },
      { label: "|e_ss|", value: `${essPct.toFixed(1)}%`, tone: essPct < 2 ? "good" : "warn" },
      { label: "Ts (2%)", value: lastOutsideIdx >= steps - 2 ? `>${xMax.toFixed(0)}s` : `${ts.toFixed(2)} s`, tone: "accent" },
    ],
  };
}

function evalRcStep(spec: VisualSimSpec, values: Record<string, number>): EvaluatedVisualSim {
  const tau = clamp(getParamVal(spec, values, "tau", 1.5), 0.05, 50);
  const vin = clamp(getParamVal(spec, values, "vin", 5.0), 0.5, 50);
  const xMin = 0;
  const xMax = Math.max(spec.xMax, tau * 6);
  const pts: SimPoint[] = [];
  for (let i = 0; i <= 180; i += 1) {
    const t = xMin + ((xMax - xMin) * i) / 180;
    pts.push({ x: t, y: vin * (1 - Math.exp(-t / tau)) });
  }
  const fcHz = 1000 / (2 * Math.PI * tau);
  return {
    kind: "response",
    preset: "rc_step",
    domain: spec.domain,
    xLabel: spec.xLabel,
    yLabel: spec.yLabel,
    xMin,
    xMax,
    yMin: 0,
    yMax: vin * 1.15,
    primary: pts,
    secondary: [],
    targetLine: vin,
    metrics: [
      { label: "1τ (63.2%)", value: `${(0.632 * vin).toFixed(2)} V`, tone: "accent" },
      { label: "5τ Settle", value: `${(5 * tau).toFixed(2)} ms`, tone: "good" },
      { label: "fc (-3dB)", value: fcHz >= 1000 ? `${(fcHz / 1000).toFixed(2)} kHz` : `${fcHz.toFixed(0)} Hz`, tone: "neutral" },
    ],
  };
}

function evalSplane(spec: VisualSimSpec, values: Record<string, number>): EvaluatedVisualSim {
  const zeta = clamp(getParamVal(spec, values, "zeta", 0.4), -0.5, 2.0);
  const wn = clamp(getParamVal(spec, values, "wn", 3.0), 0.3, 6.0);
  const poles: SimPole[] = [];
  const sigma = -zeta * wn;
  let wd = 0;

  if (Math.abs(zeta) < 1) {
    wd = wn * Math.sqrt(1 - zeta * zeta);
    poles.push({ re: sigma, im: wd, label: "s₁" });
    poles.push({ re: sigma, im: -wd, label: "s₂" });
  } else {
    const sRoot = wn * Math.sqrt(zeta * zeta - 1);
    poles.push({ re: sigma + sRoot, im: 0, label: "p₁" });
    poles.push({ re: sigma - sRoot, im: 0, label: "p₂" });
  }

  const unstable = zeta <= 0;
  const osPct = zeta > 0 && zeta < 1 ? Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) * 100 : 0;
  const ts = zeta > 0 ? 4 / (zeta * wn) : Number.POSITIVE_INFINITY;

  return {
    kind: "splane",
    preset: "splane",
    domain: "controls",
    xLabel: spec.xLabel,
    yLabel: spec.yLabel,
    xMin: -6,
    xMax: 2,
    yMin: -6,
    yMax: 6,
    primary: [],
    secondary: [],
    poles,
    dampingLineSlope: zeta > 0 && zeta < 1 ? Math.sqrt(1 - zeta * zeta) / zeta : undefined,
    regimeLabel: zeta < 0 ? "Unstable (RHP)" : zeta === 0 ? "Marginal (jω)" : zeta < 1 ? "Underdamped (LHP)" : "Overdamped (Real)",
    regimeTone: zeta < 0 ? "crit" : zeta === 0 ? "warn" : "good",
    metrics: [
      { label: "σ = Re(s)", value: sigma.toFixed(2), tone: sigma > 0 ? "crit" : "good" },
      { label: "ωd = Im(s)", value: wd > 0 ? `±${wd.toFixed(2)}` : "0", tone: "accent" },
      { label: "%OS", value: unstable ? "∞" : `${osPct.toFixed(1)}%`, tone: osPct > 25 || unstable ? "warn" : "good" },
      { label: "Ts", value: Number.isFinite(ts) ? `${ts.toFixed(2)}s` : "∞", tone: "neutral" },
    ],
  };
}

function evalSmith(spec: VisualSimSpec, values: Record<string, number>): EvaluatedVisualSim {
  const rl = clamp(getParamVal(spec, values, "rl", 75), 0.1, 1000);
  const xl = clamp(getParamVal(spec, values, "xl", 35), -500, 500);
  const z0 = clamp(getParamVal(spec, values, "z0", 50), 5, 200);

  const r = rl / z0;
  const x = xl / z0;
  const denom = (r + 1) * (r + 1) + x * x;
  const gammaRe = ((r - 1) * (r + 1) + x * x) / denom;
  const gammaIm = (2 * x) / denom;
  const gammaMag = clamp(Math.hypot(gammaRe, gammaIm), 0, 0.9999);
  const gammaDeg = (Math.atan2(gammaIm, gammaRe) * 180) / Math.PI;
  const vswr = gammaMag >= 0.995 ? 99.9 : (1 + gammaMag) / (1 - gammaMag);
  const returnLossDb = gammaMag <= 1e-4 ? 80 : -20 * Math.log10(gammaMag);
  const powerDeliveredPct = (1 - gammaMag * gammaMag) * 100;

  return {
    kind: "smith",
    preset: "smith",
    domain: "rf",
    xLabel: "Re(Γ)",
    yLabel: "Im(Γ)",
    xMin: -1.15,
    xMax: 1.15,
    yMin: -1.15,
    yMax: 1.15,
    primary: [],
    secondary: [],
    smith: { r, x, gammaRe, gammaIm, gammaMag, gammaDeg, vswr, returnLossDb, powerDeliveredPct },
    regimeLabel: vswr <= 1.5 ? "Good Match" : vswr <= 2.5 ? "Moderate Mismatch" : "High Reflection",
    regimeTone: vswr <= 1.5 ? "good" : vswr <= 2.5 ? "warn" : "crit",
    metrics: [
      { label: "|Γ|", value: `${gammaMag.toFixed(3)} ∠${gammaDeg.toFixed(0)}°`, tone: "accent" },
      { label: "VSWR", value: `${vswr.toFixed(2)}:1`, tone: vswr <= 1.5 ? "good" : vswr <= 2.5 ? "warn" : "crit" },
      { label: "RL", value: `${returnLossDb.toFixed(1)} dB`, tone: returnLossDb >= 14 ? "good" : "warn" },
      { label: "P_load", value: `${powerDeliveredPct.toFixed(1)}%`, tone: "neutral" },
    ],
  };
}

function evalRfS11(spec: VisualSimSpec, values: Record<string, number>): EvaluatedVisualSim {
  const f0 = clamp(getParamVal(spec, values, "f0", 2.4), 0.3, 10);
  const q = clamp(getParamVal(spec, values, "q", 12), 1, 100);
  const beta = clamp(getParamVal(spec, values, "match", 0.9), 0.05, 3.0);
  const span = Math.max(0.4, f0 * 0.65);
  const xMin = Math.max(0.05, f0 - span);
  const xMax = f0 + span;

  const pts: SimPoint[] = [];
  let minDb = 0;
  for (let i = 0; i <= 180; i += 1) {
    const f = xMin + ((xMax - xMin) * i) / 180;
    const delta = q * (f / f0 - f0 / f);
    const num = Math.hypot(beta - 1, -delta);
    const den = Math.hypot(beta + 1, delta);
    const mag = clamp(num / den, 1e-4, 0.9999);
    const s11Db = 20 * Math.log10(mag);
    if (s11Db < minDb) minDb = s11Db;
    pts.push({ x: f, y: s11Db });
  }

  const bwGhz = f0 / q;
  return {
    kind: "response",
    preset: "rf_s11",
    domain: "rf",
    xLabel: spec.xLabel,
    yLabel: spec.yLabel,
    xMin,
    xMax,
    yMin: Math.min(-35, minDb * 1.1),
    yMax: 1,
    primary: pts,
    secondary: [],
    targetLine: -10,
    regimeLabel: minDb <= -14 ? "Well Matched" : "Detuned / Mismatched",
    regimeTone: minDb <= -14 ? "good" : "warn",
    metrics: [
      { label: "Min S11", value: `${minDb.toFixed(1)} dB`, tone: minDb <= -14 ? "good" : "warn" },
      { label: "-3dB BW", value: `${(bwGhz * 1000).toFixed(0)} MHz`, tone: "accent" },
      { label: "Q0 / QL", value: `${q.toFixed(0)}`, tone: "neutral" },
    ],
  };
}

function evalSpiTiming(spec: VisualSimSpec, values: Record<string, number>): EvaluatedVisualSim {
  const cpol = Math.round(clamp(getParamVal(spec, values, "cpol", 0), 0, 1));
  const cpha = Math.round(clamp(getParamVal(spec, values, "cpha", 0), 0, 1));
  const mode = cpol * 2 + cpha;
  const bits = [1, 0, 1, 1, 0, 0, 1, 0];

  const csSamples: Array<{ t: number; level: number }> = [
    { t: 0, level: 1 },
    { t: 0.4, level: 0 },
    { t: 8.6, level: 0 },
    { t: 9, level: 1 },
  ];

  const sckSamples: Array<{ t: number; level: number }> = [{ t: 0, level: cpol }];
  const sampleEdges: number[] = [];
  for (let b = 0; b < 8; b += 1) {
    const start = 0.6 + b;
    const mid = start + 0.5;
    sckSamples.push({ t: start, level: cpol === 0 ? 1 : 0 });
    sckSamples.push({ t: mid, level: cpol });
    sampleEdges.push(cpha === 0 ? start : mid);
  }
  sckSamples.push({ t: 9, level: cpol });

  const mosiSamples: Array<{ t: number; level: number }> = [{ t: 0, level: 0 }];
  for (let b = 0; b < 8; b += 1) {
    const tChange = cpha === 0 ? 0.6 + b - 0.18 : 0.6 + b;
    mosiSamples.push({ t: tChange, level: bits[b] ?? 0 });
  }
  mosiSamples.push({ t: 9, level: 0 });

  const sampleEdgeType = (cpol ^ cpha) === 0 ? "Rising (↑)" : "Falling (↓)";
  const shiftEdgeType = (cpol ^ cpha) === 0 ? "Falling (↓)" : "Rising (↑)";

  return {
    kind: "timing",
    preset: "spi_timing",
    domain: "embedded",
    xLabel: "Bit Window",
    yLabel: "Channel",
    xMin: 0,
    xMax: 9,
    yMin: 0,
    yMax: 1,
    primary: [],
    secondary: [],
    timing: {
      channels: [
        { name: "CS_n", color: "warn", samples: csSamples },
        { name: "SCK", color: "accent", samples: sckSamples, sampleEdges },
        { name: "MOSI", color: "good", samples: mosiSamples },
      ],
      edgeLabel: sampleEdgeType,
      durationLabel: "0xB2 (8 bits)",
    },
    regimeLabel: `SPI Mode ${mode}`,
    regimeTone: "good",
    metrics: [
      { label: "Mode", value: `${mode} (${cpol},${cpha})`, tone: "accent" },
      { label: "Sample", value: sampleEdgeType, tone: "good" },
      { label: "Shift", value: shiftEdgeType, tone: "neutral" },
      { label: "Idle SCK", value: cpol === 0 ? "LOW (0)" : "HIGH (1)", tone: "neutral" },
    ],
  };
}

function evalPwmRc(spec: VisualSimSpec, values: Record<string, number>): EvaluatedVisualSim {
  const dutyPct = clamp(getParamVal(spec, values, "duty", 45), 5, 95);
  const freqKhz = clamp(getParamVal(spec, values, "freq_khz", 10), 0.5, 200);
  const rcMs = clamp(getParamVal(spec, values, "rc_ms", 0.35), 0.02, 10);
  const vcc = clamp(getParamVal(spec, values, "vcc", 3.3), 1.2, 12);

  const d = dutyPct / 100;
  const periodMs = 1 / freqKhz;
  const totalMs = periodMs * 4;
  const onMs = d * periodMs;
  const offMs = (1 - d) * periodMs;

  const eOn = Math.exp(-onMs / rcMs);
  const eOff = Math.exp(-offMs / rcMs);
  const vMinSS = (vcc * (1 - eOn) * eOff) / Math.max(1e-6, 1 - eOn * eOff);
  const vMaxSS = vcc * (1 - eOn) + vMinSS * eOn;
  const vRipple = vMaxSS - vMinSS;
  const vAvg = vcc * d;

  const pwmPts: SimPoint[] = [];
  const rcPts: SimPoint[] = [];
  const N = 200;
  for (let i = 0; i <= N; i += 1) {
    const t = (totalMs * i) / N;
    const phase = (t % periodMs) / periodMs;
    const dtCycle = phase * periodMs;
    const isHigh = phase < d;
    pwmPts.push({ x: t, y: isHigh ? vcc : 0 });
    const vOut = isHigh
      ? vcc - (vcc - vMinSS) * Math.exp(-dtCycle / rcMs)
      : vMaxSS * Math.exp(-(dtCycle - onMs) / rcMs);
    rcPts.push({ x: t, y: vOut });
  }

  return {
    kind: "response",
    preset: "pwm_rc",
    domain: "embedded",
    xLabel: "Time t (ms)",
    yLabel: "Voltage (V)",
    xMin: 0,
    xMax: totalMs,
    yMin: -0.15,
    yMax: vcc * 1.15,
    primary: rcPts,
    secondary: pwmPts,
    targetLine: vAvg,
    regimeLabel: vRipple < 0.1 * vcc ? "Smooth DAC" : "High Ripple",
    regimeTone: vRipple < 0.05 * vcc ? "good" : vRipple < 0.15 * vcc ? "warn" : "crit",
    metrics: [
      { label: "V_avg", value: `${vAvg.toFixed(2)} V`, tone: "good" },
      { label: "ΔV_pp", value: `${(vRipple * 1000).toFixed(0)} mV`, tone: vRipple > 0.2 ? "warn" : "good" },
      { label: "τ·f Ratio", value: `${(rcMs * freqKhz).toFixed(1)}×`, tone: "accent" },
    ],
  };
}

function evalDampedWave(spec: VisualSimSpec, values: Record<string, number>, animTime: number): EvaluatedVisualSim {
  const amp = clamp(getParamVal(spec, values, "amp", 1.0), 0.1, 10);
  const gamma = clamp(getParamVal(spec, values, "gamma", 0.25), 0, 5);
  const omega = clamp(getParamVal(spec, values, "omega", 5.0), 0.5, 25);
  const xMin = spec.xMin;
  const xMax = spec.xMax;
  const pts: SimPoint[] = [];
  const envUp: SimPoint[] = [];
  const envLo: SimPoint[] = [];

  for (let i = 0; i <= 180; i += 1) {
    const t = xMin + ((xMax - xMin) * i) / 180;
    const env = amp * Math.exp(-gamma * Math.max(0, t));
    const y = env * Math.cos(omega * (t - animTime));
    pts.push({ x: t, y });
    envUp.push({ x: t, y: env });
    envLo.push({ x: t, y: -env });
  }

  const period = (2 * Math.PI) / omega;
  const qFactor = gamma > 0.001 ? omega / (2 * gamma) : Number.POSITIVE_INFINITY;
  return {
    kind: "wave",
    preset: "damped_wave",
    domain: "physics",
    xLabel: spec.xLabel,
    yLabel: spec.yLabel,
    xMin,
    xMax,
    yMin: spec.yMin ?? -amp * 1.15,
    yMax: spec.yMax ?? amp * 1.15,
    primary: pts,
    secondary: [],
    envelopeUpper: envUp,
    envelopeLower: envLo,
    targetLine: 0,
    metrics: [
      { label: "Period T", value: `${period.toFixed(2)} s`, tone: "accent" },
      { label: "Freq f", value: `${(1 / period).toFixed(2)} Hz`, tone: "neutral" },
      { label: "Q-Factor", value: Number.isFinite(qFactor) ? qFactor.toFixed(1) : "∞", tone: qFactor > 10 ? "good" : "warn" },
    ],
  };
}

function evalStandingWave(spec: VisualSimSpec, values: Record<string, number>, animTime: number): EvaluatedVisualSim {
  const amp1 = clamp(getParamVal(spec, values, "amp1", 1.0), 0.1, 5);
  const gamma = clamp(getParamVal(spec, values, "gamma", 0.5), 0, 1);
  const k = clamp(getParamVal(spec, values, "k", 2.5), 0.5, 12);
  const xMin = spec.xMin;
  const xMax = spec.xMax;
  const pts: SimPoint[] = [];
  const envUp: SimPoint[] = [];
  const wPhase = animTime * 4;

  for (let i = 0; i <= 180; i += 1) {
    const z = xMin + ((xMax - xMin) * i) / 180;
    const envMag = amp1 * Math.sqrt(1 + gamma * gamma + 2 * gamma * Math.cos(2 * k * z));
    const inst = amp1 * (Math.cos(wPhase - k * z) + gamma * Math.cos(wPhase + k * z));
    pts.push({ x: z, y: inst });
    envUp.push({ x: z, y: envMag });
  }

  const vMax = amp1 * (1 + gamma);
  const vMin = amp1 * (1 - gamma);
  const swr = gamma >= 0.995 ? 99.9 : (1 + gamma) / (1 - gamma);
  return {
    kind: "wave",
    preset: "standing_wave",
    domain: spec.domain,
    xLabel: spec.xLabel,
    yLabel: spec.yLabel,
    xMin,
    xMax,
    yMin: spec.yMin ?? -vMax * 1.12,
    yMax: spec.yMax ?? vMax * 1.12,
    primary: envUp,
    secondary: pts,
    targetLine: 0,
    metrics: [
      { label: "SWR", value: `${swr.toFixed(2)}:1`, tone: swr <= 1.5 ? "good" : swr <= 3 ? "warn" : "crit" },
      { label: "|V|max", value: vMax.toFixed(2), tone: "accent" },
      { label: "|V|min", value: vMin.toFixed(2), tone: "neutral" },
    ],
  };
}

// ---------- General Declarative STEM Evaluators ----------

function resolveCartesianSeriesDefs(spec: VisualSimSpec): VisualSimSeriesDef[] {
  if (spec.series && spec.series.length > 0) {
    return spec.series;
  }
  const primaryExpr = spec.expr && spec.expr.trim().length > 0 ? spec.expr.trim() : "a * sin(b * x)";
  const defs: VisualSimSeriesDef[] = [{ label: spec.yLabel || "Primary", expr: primaryExpr, color: "accent" }];
  if (spec.exprSecondary && spec.exprSecondary.trim().length > 0) {
    defs.push({ label: "Secondary", expr: spec.exprSecondary.trim(), color: "secondary", dashed: true });
  }
  return defs;
}

function evalDeclarativeCartesian(
  spec: VisualSimSpec,
  values: Record<string, number>,
  animTime: number,
): EvaluatedVisualSim {
  const vars = buildVarScope(spec, values, animTime);
  const xMin = spec.xMin;
  const xMax = spec.xMax;
  const isLog = spec.xScale === "log" && xMin > 0 && xMax > xMin;
  const defs = resolveCartesianSeriesDefs(spec);
  const N = 180;

  let yMinVal = Number.POSITIVE_INFINITY;
  let yMaxVal = Number.NEGATIVE_INFINITY;
  let sqSum = 0;
  let primaryFiniteCount = 0;

  const rawBySeries: Array<Array<SimPoint | null>> = defs.map(() => []);
  const logMin = isLog ? Math.log10(xMin) : 0;
  const logMax = isLog ? Math.log10(xMax) : 0;

  try {
    for (let i = 0; i <= N; i += 1) {
      const x = isLog ? Math.pow(10, logMin + ((logMax - logMin) * i) / N) : xMin + ((xMax - xMin) * i) / N;
      vars.x = x;
      vars.t = x;
      vars.f = x;
      vars.w = x;
      vars.z = x;
      vars.s = x;

      for (let sIdx = 0; sIdx < defs.length; sIdx += 1) {
        const sDef = defs[sIdx];
        if (!sDef?.expr) continue;
        const y = evaluateSafeMathExpression(sDef.expr, vars);
        if (Number.isFinite(y)) {
          if (y < yMinVal) yMinVal = y;
          if (y > yMaxVal) yMaxVal = y;
          if (sIdx === 0) {
            sqSum += y * y;
            primaryFiniteCount += 1;
          }
          rawBySeries[sIdx]?.push({ x, y });
        } else {
          rawBySeries[sIdx]?.push(null);
        }
      }
    }
  } catch (err) {
    return {
      kind: spec.kind,
      preset: "custom_expr",
      domain: spec.domain,
      xLabel: spec.xLabel,
      yLabel: spec.yLabel,
      xMin,
      xMax,
      yMin: -1,
      yMax: 1,
      xScale: isLog ? "log" : "linear",
      primary: [],
      secondary: [],
      metrics: [],
      error: err instanceof Error ? err.message : "Invalid math expression",
    };
  }

  if (!Number.isFinite(yMinVal) || !Number.isFinite(yMaxVal)) {
    yMinVal = -1;
    yMaxVal = 1;
  }
  const yMinBound = spec.yMin ?? yMinVal;
  const yMaxBound = spec.yMax ?? yMaxVal;
  const spanHint = Math.max(0.5, yMaxBound - yMinBound);

  const series: SimEvaluatedSeries[] = defs.map((def, idx) => ({
    label: def.label,
    color: def.color ?? "accent",
    dashed: def.dashed,
    segments: splitDiscontinuousSegments(rawBySeries[idx] ?? [], spanHint),
  }));

  const hLines = spec.hLines?.filter((l) => typeof l.y === "number").map((l) => ({ y: l.y as number, label: l.label }));
  const vLines = spec.vLines?.filter((l) => typeof l.x === "number").map((l) => ({ x: l.x as number, label: l.label }));
  for (const hl of hLines ?? []) {
    if (hl.y < yMinVal) yMinVal = hl.y;
    if (hl.y > yMaxVal) yMaxVal = hl.y;
  }
  const pad = Math.max(0.2, (yMaxVal - yMinVal) * 0.12);

  const evalMarkers = evaluateDeclarativeMarkers(spec.markers, buildVarScope(spec, values, animTime));
  const customMetrics = evaluateDeclarativeMetrics(spec.metrics, buildVarScope(spec, values, animTime));
  const rms = primaryFiniteCount > 0 ? Math.sqrt(sqSum / primaryFiniteCount) : 0;
  const metrics: SimMetric[] =
    customMetrics.length > 0
      ? customMetrics
      : [
          { label: "Max", value: yMaxVal.toFixed(2), tone: "accent" },
          { label: "Min", value: yMinVal.toFixed(2), tone: "neutral" },
          { label: "RMS", value: rms.toFixed(2), tone: "good" },
        ];

  return {
    kind: spec.kind,
    preset: "custom_expr",
    domain: spec.domain,
    xLabel: spec.xLabel,
    yLabel: spec.yLabel,
    xMin,
    xMax,
    yMin: spec.yMin ?? yMinVal - pad,
    yMax: spec.yMax ?? yMaxVal + pad,
    xScale: isLog ? "log" : "linear",
    primary: series[0]?.segments.flat() ?? [],
    secondary: series[1]?.segments.flat() ?? [],
    series,
    hLines,
    vLines,
    markers: evalMarkers,
    targetLine: spec.target ?? (spec.hLines ? undefined : 0),
    metrics,
  };
}

function evalDeclarativeParametric(
  spec: VisualSimSpec,
  values: Record<string, number>,
  animTime: number,
): EvaluatedVisualSim {
  const vars = buildVarScope(spec, values, animTime);
  const defs: VisualSimSeriesDef[] =
    spec.series && spec.series.length > 0
      ? spec.series.filter((s) => Boolean(s.xExpr && s.yExpr))
      : [{ label: "Trajectory", xExpr: "a * cos(s)", yExpr: "b * sin(s)", color: "accent" }];

  const sMin = spec.sMin ?? 0;
  const sMax = spec.sMax ?? 2 * Math.PI;
  const N = 200;
  const rawBySeries: Array<Array<SimPoint | null>> = defs.map(() => []);

  let xMinVal = Number.POSITIVE_INFINITY;
  let xMaxVal = Number.NEGATIVE_INFINITY;
  let yMinVal = Number.POSITIVE_INFINITY;
  let yMaxVal = Number.NEGATIVE_INFINITY;

  try {
    for (let i = 0; i <= N; i += 1) {
      const s = sMin + ((sMax - sMin) * i) / N;
      vars.s = s;
      vars.t = s;
      vars.theta = s;
      vars.x = s;
      for (let idx = 0; idx < defs.length; idx += 1) {
        const d = defs[idx];
        if (!d?.xExpr || !d?.yExpr) continue;
        const px = evaluateSafeMathExpression(d.xExpr, vars);
        const py = evaluateSafeMathExpression(d.yExpr, vars);
        if (Number.isFinite(px) && Number.isFinite(py)) {
          if (px < xMinVal) xMinVal = px;
          if (px > xMaxVal) xMaxVal = px;
          if (py < yMinVal) yMinVal = py;
          if (py > yMaxVal) yMaxVal = py;
          rawBySeries[idx]?.push({ x: px, y: py });
        } else {
          rawBySeries[idx]?.push(null);
        }
      }
    }
  } catch (err) {
    return {
      kind: "parametric",
      preset: "custom_expr",
      domain: spec.domain,
      xLabel: spec.xLabel,
      yLabel: spec.yLabel,
      xMin: -1,
      xMax: 1,
      yMin: -1,
      yMax: 1,
      primary: [],
      secondary: [],
      metrics: [],
      error: err instanceof Error ? err.message : "Invalid parametric expression",
    };
  }

  if (!Number.isFinite(xMinVal)) {
    xMinVal = -1;
    xMaxVal = 1;
  }
  if (!Number.isFinite(yMinVal)) {
    yMinVal = -1;
    yMaxVal = 1;
  }

  const evalMarkers = evaluateDeclarativeMarkers(spec.markers, buildVarScope(spec, values, animTime));
  for (const m of evalMarkers ?? []) {
    if (m.x < xMinVal) xMinVal = m.x;
    if (m.x > xMaxVal) xMaxVal = m.x;
    if (m.y < yMinVal) yMinVal = m.y;
    if (m.y > yMaxVal) yMaxVal = m.y;
  }

  const xPad = Math.max(0.25, (xMaxVal - xMinVal) * 0.14);
  const yPad = Math.max(0.25, (yMaxVal - yMinVal) * 0.14);
  const ySpanHint = Math.max(1, yMaxVal - yMinVal);
  const series: SimEvaluatedSeries[] = defs.map((def, idx) => ({
    label: def.label,
    color: def.color ?? "accent",
    dashed: def.dashed,
    segments: splitDiscontinuousSegments(rawBySeries[idx] ?? [], ySpanHint),
  }));

  const customMetrics = evaluateDeclarativeMetrics(spec.metrics, buildVarScope(spec, values, animTime));
  const metrics: SimMetric[] =
    customMetrics.length > 0
      ? customMetrics
      : [
          { label: "X Span", value: `[${xMinVal.toFixed(1)}, ${xMaxVal.toFixed(1)}]`, tone: "neutral" },
          { label: "Y Peak", value: yMaxVal.toFixed(2), tone: "accent" },
        ];

  return {
    kind: "parametric",
    preset: "custom_expr",
    domain: spec.domain,
    xLabel: spec.xLabel,
    yLabel: spec.yLabel,
    xMin: spec.yMin !== undefined || spec.xLabel !== "x(s)" ? xMinVal - xPad : Math.min(xMinVal - xPad, spec.xMin),
    xMax: xMaxVal + xPad,
    yMin: spec.yMin ?? yMinVal - yPad,
    yMax: spec.yMax ?? yMaxVal + yPad,
    primary: series[0]?.segments.flat() ?? [],
    secondary: series[1]?.segments.flat() ?? [],
    series,
    hLines: spec.hLines?.filter((l) => typeof l.y === "number").map((l) => ({ y: l.y as number, label: l.label })),
    vLines: spec.vLines?.filter((l) => typeof l.x === "number").map((l) => ({ x: l.x as number, label: l.label })),
    markers: evalMarkers,
    metrics,
  };
}

function evalDeclarativePolar(
  spec: VisualSimSpec,
  values: Record<string, number>,
  animTime: number,
): EvaluatedVisualSim {
  const vars = buildVarScope(spec, values, animTime);
  const defs = resolveCartesianSeriesDefs(spec);
  const sMin = spec.sMin ?? 0;
  const sMax = spec.sMax ?? 2 * Math.PI;
  const N = 200;

  let maxR = 0.001;
  const evaluatedSeries: Array<{
    label: string;
    color: SimSeriesColor;
    dashed?: boolean;
    points: Array<{ theta: number; r: number }>;
  }> = defs.map((d) => ({
    label: d.label,
    color: d.color ?? "accent",
    dashed: d.dashed,
    points: [],
  }));

  try {
    for (let i = 0; i <= N; i += 1) {
      const theta = sMin + ((sMax - sMin) * i) / N;
      vars.theta = theta;
      vars.x = theta;
      vars.s = theta;
      vars.t = theta;
      for (let idx = 0; idx < defs.length; idx += 1) {
        const def = defs[idx];
        if (!def?.expr) continue;
        const rawR = evaluateSafeMathExpression(def.expr, vars);
        const r = Number.isFinite(rawR) ? Math.max(0, rawR) : 0;
        if (r > maxR) maxR = r;
        evaluatedSeries[idx]?.points.push({ theta, r });
      }
    }
  } catch (err) {
    return {
      kind: "polar",
      preset: "custom_expr",
      domain: spec.domain,
      xLabel: spec.xLabel,
      yLabel: spec.yLabel,
      xMin: -1,
      xMax: 1,
      yMin: -1,
      yMax: 1,
      primary: [],
      secondary: [],
      metrics: [],
      error: err instanceof Error ? err.message : "Invalid polar expression",
    };
  }

  const customMetrics = evaluateDeclarativeMetrics(spec.metrics, buildVarScope(spec, values, animTime));
  const metrics: SimMetric[] =
    customMetrics.length > 0
      ? customMetrics
      : [{ label: "Max Gain", value: maxR.toFixed(2), tone: "accent" }];

  return {
    kind: "polar",
    preset: "custom_expr",
    domain: spec.domain,
    xLabel: "Angle θ",
    yLabel: "Magnitude",
    xMin: -maxR,
    xMax: maxR,
    yMin: -maxR,
    yMax: maxR,
    primary: [],
    secondary: [],
    polar: {
      maxR: spec.yMax ?? maxR,
      series: evaluatedSeries,
    },
    metrics,
  };
}

function evalDeclarativeTiming(
  spec: VisualSimSpec,
  values: Record<string, number>,
  animTime: number,
): EvaluatedVisualSim {
  const vars = buildVarScope(spec, values, animTime);
  const channels = spec.channels ?? [];
  const xMin = spec.xMin;
  const xMax = spec.xMax;
  const N = 160;
  const built: SimTimingChannel[] = [];

  try {
    for (const ch of channels) {
      if (ch.levels && ch.levels.length > 0) {
        built.push({ name: ch.name, color: ch.color ?? "accent", samples: ch.levels.map(([t, level]) => ({ t, level })) });
        continue;
      }
      if (!ch.expr) continue;
      const samples: Array<{ t: number; level: number }> = [];
      let prevLevel = -1;
      for (let i = 0; i <= N; i += 1) {
        const t = xMin + ((xMax - xMin) * i) / N;
        vars.t = t;
        vars.x = t;
        const val = evaluateSafeMathExpression(ch.expr, vars);
        const level = Number.isFinite(val) && val > 0.5 ? 1 : 0;
        if (level !== prevLevel || i === N) {
          samples.push({ t, level });
          prevLevel = level;
        }
      }
      built.push({ name: ch.name, color: ch.color ?? "accent", samples });
    }
  } catch (err) {
    return {
      kind: "timing",
      preset: "custom_expr",
      domain: spec.domain,
      xLabel: spec.xLabel,
      yLabel: spec.yLabel,
      xMin,
      xMax,
      yMin: 0,
      yMax: 1,
      primary: [],
      secondary: [],
      metrics: [],
      error: err instanceof Error ? err.message : "Invalid timing channel expression",
    };
  }

  const customMetrics = evaluateDeclarativeMetrics(spec.metrics, buildVarScope(spec, values, animTime));
  const metrics: SimMetric[] =
    customMetrics.length > 0
      ? customMetrics
      : [{ label: "Channels", value: String(built.length), tone: "accent" }];

  return {
    kind: "timing",
    preset: "custom_expr",
    domain: spec.domain,
    xLabel: spec.xLabel,
    yLabel: spec.yLabel,
    xMin,
    xMax,
    yMin: 0,
    yMax: 1,
    primary: [],
    secondary: [],
    timing: {
      channels: built,
      edgeLabel: spec.xLabel || "Window",
      durationLabel: `${(xMax - xMin).toFixed(1)} units`,
    },
    metrics,
  };
}

export function evaluateVisualSim(
  spec: VisualSimSpec,
  paramValues: Record<string, number>,
  animTime = 0,
): EvaluatedVisualSim {
  if (spec.preset === "custom_expr") {
    let result: EvaluatedVisualSim;
    switch (spec.kind) {
      case "parametric":
        result = evalDeclarativeParametric(spec, paramValues, animTime);
        break;
      case "polar":
        result = evalDeclarativePolar(spec, paramValues, animTime);
        break;
      case "timing":
        result = spec.channels && spec.channels.length > 0
          ? evalDeclarativeTiming(spec, paramValues, animTime)
          : evalSpiTiming(spec, paramValues);
        break;
      case "bode":
      case "plot":
      case "response":
      case "wave":
      default:
        result = evalDeclarativeCartesian(spec, paramValues, animTime);
        break;
    }
    return result;
  }

  let base: EvaluatedVisualSim;
  switch (spec.preset) {
    case "second_order_step":
      base = evalSecondOrderStep(spec, paramValues);
      break;
    case "pid_step":
      base = evalPidStep(spec, paramValues);
      break;
    case "rc_step":
      base = evalRcStep(spec, paramValues);
      break;
    case "splane":
      base = evalSplane(spec, paramValues);
      break;
    case "smith":
      base = evalSmith(spec, paramValues);
      break;
    case "rf_s11":
      base = evalRfS11(spec, paramValues);
      break;
    case "spi_timing":
      base = evalSpiTiming(spec, paramValues);
      break;
    case "pwm_rc":
      base = evalPwmRc(spec, paramValues);
      break;
    case "damped_wave":
      base = evalDampedWave(spec, paramValues, animTime);
      break;
    case "standing_wave":
      base = evalStandingWave(spec, paramValues, animTime);
      break;
    default:
      base = evalDeclarativeCartesian(spec, paramValues, animTime);
      break;
  }

  if (spec.metrics && spec.metrics.length > 0) {
    const customMetrics = evaluateDeclarativeMetrics(
      spec.metrics,
      buildVarScope(spec, paramValues, animTime),
    );
    if (customMetrics.length > 0) {
      base = { ...base, metrics: customMetrics };
    }
  }
  return base;
}

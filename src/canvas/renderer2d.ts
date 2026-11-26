import type {
  CameraState,
  CanvasGroupDto,
  CompiledXray,
  EdgeDto,
  GroupColorKey,
  InclusionMode,
  NodeDto,
  Severity,
  SpawnDirection,
} from "../ipc/types";
import type { LoopholeSummary } from "../store/graphStore";
import { resolveNodeTone } from "../cards/nodeAccent";
import { LOD_THRESHOLD, screenToWorld } from "./camera";
import { getEffectiveNodeHeight } from "./spatialIndex";

export interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EdgePreview {
  sourceId: string;
  sourceDir?: SpawnDirection;
  targetX: number;
  targetY: number;
}

export interface RenderSceneInput {
  cam: CameraState;
  width: number;
  height: number;
  nodes: Map<string, NodeDto>;
  edges: Map<string, EdgeDto>;
  dragOffsets: Map<string, { x: number; y: number }>;
  resizeSizes?: Map<string, { width: number; height: number }>;
  selectedIds: ReadonlySet<string>;
  focusId: string | null;
  hoveredId?: string | null;
  selectedEdgeId?: string | null;
  hoveredEdgeId?: string | null;
  connectSourceId?: string | null;
  xrayState: CompiledXray | null;
  unresolvedLoopholes: Map<string, LoopholeSummary>;
  staleNodeIds?: ReadonlySet<string>;
  spotlightIds?: ReadonlySet<string> | null;
  outOfSyncRefIds?: ReadonlySet<string>;
  marqueeWorld: MarqueeRect | null;
  edgePreviewWorld: EdgePreview | null;
  groups?: ReadonlyMap<string, CanvasGroupDto> | ReadonlyArray<CanvasGroupDto>;
  selectedGroupId?: string | null;
  themeKey: "dark" | "light";
  animTimeMs?: number;
  animateEdges?: boolean;
}

export type RenderFrameInput = RenderSceneInput;

export interface ThemePalette {
  bgCanvas: string;
  bgDot: string;
  bgCard: string;
  borderSubtle: string;
  borderStrong: string;
  textPrimary: string;
  edgeDefault: string;
  edgeBranch: string;
  edgeSynthesis: string;
  edgeChallenge: string;
  edgeResolve: string;
  edgeReference: string;
  accentCore: string;
  accentBranch: string;
  accentProbe: string;
  accentSynthesis: string;
  loopholeLow: string;
  loopholeMed: string;
  loopholeHigh: string;
  loopholeCrit: string;
  ringFocus: string;
  ringMulti: string;
  xrayPin: string;
  xrayFocus: string;
  xrayFull: string;
  xraySummary: string;
  xrayLoophole: string;
  xrayReference: string;
  groupCobalt: string;
  groupEmerald: string;
  groupAmber: string;
  groupRose: string;
  groupViolet: string;
  groupSlate: string;
}

let cachedPaletteKey: string | null = null;
let cachedPalette: ThemePalette | null = null;

function readCssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const val = style.getPropertyValue(name).trim();
  return val.length > 0 ? val : fallback;
}

export function getPalette(themeKey: "dark" | "light"): ThemePalette {
  const domTheme =
    typeof document !== "undefined" ? document.documentElement.getAttribute("data-theme") : null;
  const themeMismatch = typeof document !== "undefined" && domTheme !== themeKey;
  if (themeMismatch) {
    document.documentElement.setAttribute("data-theme", themeKey);
  }
  if (cachedPalette && cachedPaletteKey === themeKey && !themeMismatch) {
    return cachedPalette;
  }
  const isLight = themeKey === "light";
  const style = getComputedStyle(document.documentElement);
  const palette: ThemePalette = {
    bgCanvas: readCssVar(style, "--bg-canvas", isLight ? "#eef1f5" : "#0e1013"),
    bgDot: readCssVar(style, "--bg-dot", isLight ? "#c5cedb" : "#232730"),
    bgCard: readCssVar(style, "--bg-card", isLight ? "#ffffff" : "#15181e"),
    borderSubtle: readCssVar(style, "--border-subtle", isLight ? "#c5cedb" : "#262b36"),
    borderStrong: readCssVar(style, "--border-strong", isLight ? "#94a3b8" : "#3a4252"),
    textPrimary: readCssVar(style, "--text-primary", isLight ? "#111827" : "#e6eaf0"),
    edgeDefault: readCssVar(style, "--edge-default", isLight ? "#0284c7" : "#7dd3fc"),
    edgeBranch: readCssVar(style, "--edge-branch", isLight ? "#2563eb" : "#60a5fa"),
    edgeSynthesis: readCssVar(style, "--edge-synthesis", isLight ? "#059669" : "#34d399"),
    edgeChallenge: readCssVar(style, "--edge-challenge", isLight ? "#d97706" : "#f59e0b"),
    edgeResolve: readCssVar(style, "--edge-resolve", isLight ? "#16a34a" : "#4ade80"),
    edgeReference: readCssVar(style, "--edge-reference", isLight ? "#7c3aed" : "#a78bfa"),
    accentCore: readCssVar(style, "--accent-core", isLight ? "#475569" : "#cbd5e1"),
    accentBranch: readCssVar(style, "--accent-branch", isLight ? "#2563eb" : "#60a5fa"),
    accentProbe: readCssVar(style, "--accent-probe", isLight ? "#0284c7" : "#38bdf8"),
    accentSynthesis: readCssVar(style, "--accent-synthesis", isLight ? "#059669" : "#34d399"),
    loopholeLow: readCssVar(style, "--accent-loophole-low", isLight ? "#ca8a04" : "#eab308"),
    loopholeMed: readCssVar(style, "--accent-loophole-med", isLight ? "#d97706" : "#f59e0b"),
    loopholeHigh: readCssVar(style, "--accent-loophole-high", isLight ? "#dc2626" : "#ef4444"),
    loopholeCrit: readCssVar(style, "--accent-loophole-crit", isLight ? "#b91c1c" : "#dc2626"),
    ringFocus: readCssVar(style, "--ring-focus", isLight ? "#111827" : "#e2e8f0"),
    ringMulti: readCssVar(style, "--ring-multi", isLight ? "#475569" : "#94a3b8"),
    xrayPin: readCssVar(style, "--xray-pin", isLight ? "#9333ea" : "#c084fc"),
    xrayFocus: readCssVar(style, "--xray-focus", isLight ? "#0891b2" : "#22d3ee"),
    xrayFull: readCssVar(style, "--xray-full", isLight ? "#16a34a" : "#4ade80"),
    xraySummary: readCssVar(style, "--xray-summary", isLight ? "#2563eb" : "#60a5fa"),
    xrayLoophole: readCssVar(style, "--xray-loophole", isLight ? "#d97706" : "#f59e0b"),
    xrayReference: readCssVar(style, "--xray-reference", isLight ? "#475569" : "#94a3b8"),
    groupCobalt: readCssVar(style, "--group-cobalt", isLight ? "#2563eb" : "#60a5fa"),
    groupEmerald: readCssVar(style, "--group-emerald", isLight ? "#059669" : "#34d399"),
    groupAmber: readCssVar(style, "--group-amber", isLight ? "#d97706" : "#fbbf24"),
    groupRose: readCssVar(style, "--group-rose", isLight ? "#dc2626" : "#fb7185"),
    groupViolet: readCssVar(style, "--group-violet", isLight ? "#7c3aed" : "#a78bfa"),
    groupSlate: readCssVar(style, "--group-slate", isLight ? "#475569" : "#94a3b8"),
  };
  cachedPaletteKey = themeKey;
  cachedPalette = palette;
  return palette;
}

export interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function getNodeRect(
  node: NodeDto,
  dragOffsets: ReadonlyMap<string, { x: number; y: number }>,
  resizeSizes?: ReadonlyMap<string, { width: number; height: number }>,
): NodeRect {
  const offset = dragOffsets.get(node.id);
  const resized = resizeSizes?.get(node.id);
  const w = resized ? resized.width : node.layout.width;
  const h = node.layout.collapsed
    ? getEffectiveNodeHeight(node)
    : resized
      ? resized.height
      : node.layout.height;
  return {
    x: node.layout.x + (offset?.x ?? 0),
    y: node.layout.y + (offset?.y ?? 0),
    w,
    h,
  };
}

export function buildSceneRects(
  nodes: ReadonlyMap<string, NodeDto>,
  dragOffsets: ReadonlyMap<string, { x: number; y: number }>,
  resizeSizes?: ReadonlyMap<string, { width: number; height: number }>,
): Map<string, NodeRect> {
  const rects = new Map<string, NodeRect>();
  for (const node of nodes.values()) {
    rects.set(node.id, getNodeRect(node, dragOffsets, resizeSizes));
  }
  return rects;
}

export const GROUP_PADDING = 26;
export const GROUP_TOP_HEADER = 38;

export interface GroupBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  headerX: number;
  headerY: number;
  headerW: number;
  headerH: number;
  memberCount: number;
}

export function computeGroupBounds(
  group: CanvasGroupDto,
  sceneRects: ReadonlyMap<string, NodeRect>,
): GroupBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let memberCount = 0;

  for (const id of group.member_ids) {
    const r = sceneRects.get(id);
    if (!r) {
      continue;
    }
    memberCount += 1;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }

  if (memberCount === 0 || !Number.isFinite(minX)) {
    return null;
  }

  const x = minX - GROUP_PADDING;
  const y = minY - GROUP_PADDING - GROUP_TOP_HEADER;
  const w = maxX - minX + GROUP_PADDING * 2;
  const h = maxY - minY + GROUP_PADDING * 2 + GROUP_TOP_HEADER;
  const headerH = 26;
  const headerX = x + 10;
  const headerY = y + 6;
  const headerW = Math.min(Math.max(80, w - 20), Math.max(120, group.title.length * 7.2 + 52));

  return { x, y, w, h, headerX, headerY, headerW, headerH, memberCount };
}

interface PlacedChipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectsOverlap(a: PlacedChipRect, b: PlacedChipRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function resolveGroupChipRect(
  group: CanvasGroupDto,
  bounds: GroupBounds,
  placedChips: PlacedChipRect[],
  measureTextWidth?: (label: string) => number,
): { chipLabel: string; chipPadX: number; rect: PlacedChipRect } {
  const chipLabel = `${group.title} · ${bounds.memberCount}`;
  const chipPadX = 10;
  const maxChipW = Math.max(60, bounds.w - 20);
  const measuredW = measureTextWidth ? measureTextWidth(chipLabel) : chipLabel.length * 6.5;
  const chipW = Math.min(maxChipW, measuredW + chipPadX * 2);
  const chipH = bounds.headerH;
  let chipX = bounds.headerX;
  let chipY = bounds.headerY;
  const maxRightX = bounds.x + bounds.w - 10;

  let guard = 0;
  while (guard < placedChips.length + 2) {
    guard += 1;
    const candidate: PlacedChipRect = { x: chipX, y: chipY, w: chipW, h: chipH };
    const hit = placedChips.find((prev) => rectsOverlap(candidate, prev));
    if (!hit) {
      break;
    }
    const shiftedX = hit.x + hit.w + 8;
    if (shiftedX + chipW <= maxRightX) {
      chipX = shiftedX;
    } else {
      chipX = bounds.headerX;
      chipY = hit.y - chipH - 4;
    }
  }

  const rect: PlacedChipRect = { x: chipX, y: chipY, w: chipW, h: chipH };
  placedChips.push(rect);
  return { chipLabel, chipPadX, rect };
}

export function hitTestGroupHeader(
  scenePoint: { x: number; y: number },
  groups: ReadonlyMap<string, CanvasGroupDto> | ReadonlyArray<CanvasGroupDto>,
  sceneRects: ReadonlyMap<string, NodeRect>,
  zoom: number,
): CanvasGroupDto | null {
  const count = "size" in groups ? groups.size : groups.length;
  if (count === 0) {
    return null;
  }
  const list = "size" in groups ? Array.from(groups.values()) : groups;
  const padX = Math.min(8, 3 / Math.max(0.25, zoom));
  const padY = Math.min(10, 4 / Math.max(0.25, zoom));
  const placedChips: PlacedChipRect[] = [];
  const entries: Array<{ group: CanvasGroupDto; bounds: GroupBounds; chip: PlacedChipRect }> = [];

  for (const group of list) {
    if (!group) continue;
    const bounds = computeGroupBounds(group, sceneRects);
    if (!bounds) continue;
    const { rect } = resolveGroupChipRect(group, bounds, placedChips);
    entries.push({ group, bounds, chip: rect });
  }

  // Prefer hitting the exact cascaded chip pill first so overlapping group headers remain clickable.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    const { chip } = entry;
    if (
      scenePoint.x >= chip.x - padX &&
      scenePoint.x <= chip.x + chip.w + padX &&
      scenePoint.y >= chip.y - padY &&
      scenePoint.y <= chip.y + chip.h + padY
    ) {
      return entry.group;
    }
  }

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    const { bounds } = entry;
    if (
      scenePoint.x >= bounds.x &&
      scenePoint.x <= bounds.x + bounds.w &&
      scenePoint.y >= bounds.y - padY &&
      scenePoint.y <= bounds.y + GROUP_TOP_HEADER + padY * 0.5
    ) {
      return entry.group;
    }
  }
  return null;
}

function resolveGroupAccent(colorKey: string, p: ThemePalette): string {
  switch (colorKey as GroupColorKey) {
    case "emerald":
      return p.groupEmerald;
    case "amber":
      return p.groupAmber;
    case "rose":
      return p.groupRose;
    case "violet":
      return p.groupViolet;
    case "slate":
      return p.groupSlate;
    case "cobalt":
    default:
      return p.groupCobalt;
  }
}

function colorWithAlpha(color: string, alpha: number): string {
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 6) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    } else if (hex.length === 3) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
  }
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(trimmed);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  }
  return trimmed;
}

export interface PortPoint {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

function cardinalPorts(rect: NodeRect): PortPoint[] {
  return [
    { x: rect.x + rect.w / 2, y: rect.y, nx: 0, ny: -1 },
    { x: rect.x + rect.w / 2, y: rect.y + rect.h, nx: 0, ny: 1 },
    { x: rect.x, y: rect.y + rect.h / 2, nx: -1, ny: 0 },
    { x: rect.x + rect.w, y: rect.y + rect.h / 2, nx: 1, ny: 0 },
  ];
}

export function nearestPortPair(
  src: NodeRect,
  dst: NodeRect,
): { from: PortPoint; to: PortPoint } {
  const sp = cardinalPorts(src);
  const dp = cardinalPorts(dst);
  let bestFrom = sp[0];
  let bestTo = dp[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const a of sp) {
    for (const b of dp) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      let score = dist;
      if (dist > 1e-4) {
        const ux = dx / dist;
        const uy = dy / dist;
        const dotA = ux * a.nx + uy * a.ny;
        const dotB = -ux * b.nx + -uy * b.ny;
        const penaltyA = dotA < 0.15 ? (0.15 - dotA) * 280 : 0;
        const penaltyB = dotB < 0.15 ? (0.15 - dotB) * 280 : 0;
        score = dist + penaltyA + penaltyB - (dotA + dotB) * 12;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFrom = a;
        bestTo = b;
      }
    }
  }
  return { from: bestFrom, to: bestTo };
}

export interface DynamicEdgeCurve {
  x1: number;
  y1: number;
  cx1: number;
  cy1: number;
  cx2: number;
  cy2: number;
  x2: number;
  y2: number;
}

export function computeDynamicEdgeCurve(
  srcRect: NodeRect,
  dstRect: NodeRect,
  srcId: string,
  dstId: string,
  obstacles: ReadonlyArray<{ id: string; rect: NodeRect }>,
): DynamicEdgeCurve {
  const { from, to } = nearestPortPair(srcRect, dstRect);
  const x1 = from.x;
  const y1 = from.y;
  const x2 = to.x;
  const y2 = to.y;
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const offset = Math.max(42, dist * 0.35);
  let cx1 = x1 + from.nx * offset;
  let cy1 = y1 + from.ny * offset;
  let cx2 = x2 + to.nx * offset;
  let cy2 = y2 + to.ny * offset;

  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const pad = 12;
  const clearance = 28;

  for (const obs of obstacles) {
    if (obs.id === srcId || obs.id === dstId) {
      continue;
    }
    const r = obs.rect;
    if (mx >= r.x - pad && mx <= r.x + r.w + pad && my >= r.y - pad && my <= r.y + r.h + pad) {
      const shiftLeft = r.x - clearance - mx;
      const shiftRight = r.x + r.w + clearance - mx;
      const shiftUp = r.y - clearance - my;
      const shiftDown = r.y + r.h + clearance - my;

      const bestX = Math.abs(shiftLeft) <= Math.abs(shiftRight) ? shiftLeft : shiftRight;
      const bestY = Math.abs(shiftUp) <= Math.abs(shiftDown) ? shiftUp : shiftDown;

      if (Math.abs(bestX) < Math.abs(bestY)) {
        const dxShift = bestX * 1.35;
        cx1 += dxShift;
        cx2 += dxShift;
      } else {
        const dyShift = bestY * 1.35;
        cy1 += dyShift;
        cy2 += dyShift;
      }
      break;
    }
  }

  return { x1, y1, cx1, cy1, cx2, cy2, x2, y2 };
}

function portForDirection(rect: NodeRect, dir: SpawnDirection): PortPoint {
  const ports = cardinalPorts(rect);
  switch (dir) {
    case "top":
      return ports[0];
    case "bottom":
      return ports[1];
    case "left":
      return ports[2];
    case "right":
      return ports[3];
  }
}

function nearestPortToPoint(src: NodeRect, tx: number, ty: number): PortPoint {
  const sp = cardinalPorts(src);
  let best = sp[3];
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (const p of sp) {
    const dx = tx - p.x;
    const dy = ty - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      best = p;
    }
  }
  return best;
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  fromX: number,
  fromY: number,
  size: number,
): void {
  const angle = Math.atan2(tipY - fromY, tipX - fromX);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - size * Math.cos(angle - Math.PI / 6),
    tipY - size * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    tipX - size * Math.cos(angle + Math.PI / 6),
    tipY - size * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function getSemanticBarColor(
  node: NodeDto,
  p: ThemePalette,
  themeKey: "dark" | "light",
): string {
  if (node.type === "loophole") {
    if (node.status === "resolved" || node.status === "dismissed") {
      return p.borderStrong;
    }
    return getSeverityColor(node.metadata.severity, p);
  }
  const tone = resolveNodeTone(node);
  return themeKey === "light" ? tone.colorLight : tone.colorDark;
}

function getSeverityColor(sev: Severity | null, p: ThemePalette): string {
  switch (sev) {
    case "low":
      return p.loopholeLow;
    case "high":
      return p.loopholeHigh;
    case "critical":
      return p.loopholeCrit;
    case "medium":
    case null:
      return p.loopholeMed;
  }
}

function getXrayColor(mode: InclusionMode, p: ThemePalette): string {
  switch (mode) {
    case "pin":
      return p.xrayPin;
    case "focus":
      return p.xrayFocus;
    case "full":
      return p.xrayFull;
    case "summary":
      return p.xraySummary;
    case "loophole":
      return p.xrayLoophole;
    case "reference":
      return p.xrayReference;
  }
}

function cubicBezierAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function pointToSegmentDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-8) {
    const ox = px - ax;
    const oy = py - ay;
    return ox * ox + oy * oy;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ox = px - cx;
  const oy = py - cy;
  return ox * ox + oy * oy;
}

export function getEdgeMidpointWorld(
  edge: EdgeDto,
  nodes: Map<string, NodeDto>,
  dragOffsets: Map<string, { x: number; y: number }>,
  resizeSizes: Map<string, { width: number; height: number }>,
): { x: number; y: number } | null {
  const srcNode = nodes.get(edge.source_id);
  const dstNode = nodes.get(edge.target_id);
  if (!srcNode || !dstNode) {
    return null;
  }
  const srcRect = getNodeRect(srcNode, dragOffsets, resizeSizes);
  const dstRect = getNodeRect(dstNode, dragOffsets, resizeSizes);
  const obstacles: Array<{ id: string; rect: NodeRect }> = [];
  for (const node of nodes.values()) {
    if (node.id === srcNode.id || node.id === dstNode.id) {
      continue;
    }
    obstacles.push({ id: node.id, rect: getNodeRect(node, dragOffsets, resizeSizes) });
  }
  const curve = computeDynamicEdgeCurve(srcRect, dstRect, srcNode.id, dstNode.id, obstacles);
  return {
    x: cubicBezierAt(curve.x1, curve.cx1, curve.cx2, curve.x2, 0.5),
    y: cubicBezierAt(curve.y1, curve.cy1, curve.cy2, curve.y2, 0.5),
  };
}

export function hitTestEdge(
  worldX: number,
  worldY: number,
  nodes: Map<string, NodeDto>,
  edges: Map<string, EdgeDto>,
  dragOffsets: Map<string, { x: number; y: number }>,
  resizeSizes: Map<string, { width: number; height: number }>,
  zoom: number,
): string | null {
  if (edges.size === 0) {
    return null;
  }
  const threshold = Math.max(8, 10 / Math.max(0.2, zoom));
  const thresholdSq = threshold * threshold;
  const cullPad = 650 + threshold;

  const rects = new Map<string, NodeRect>();
  const obstacles: Array<{ id: string; rect: NodeRect }> = [];
  for (const node of nodes.values()) {
    const rect = getNodeRect(node, dragOffsets, resizeSizes);
    rects.set(node.id, rect);
    obstacles.push({ id: node.id, rect });
  }

  let bestEdgeId: string | null = null;
  let bestDistSq = thresholdSq;

  for (const edge of edges.values()) {
    const srcRect = rects.get(edge.source_id);
    const dstRect = rects.get(edge.target_id);
    if (!srcRect || !dstRect) {
      continue;
    }

    const minX = Math.min(srcRect.x, dstRect.x) - cullPad;
    const minY = Math.min(srcRect.y, dstRect.y) - cullPad;
    const maxX = Math.max(srcRect.x + srcRect.w, dstRect.x + dstRect.w) + cullPad;
    const maxY = Math.max(srcRect.y + srcRect.h, dstRect.y + dstRect.h) + cullPad;
    if (worldX < minX || worldX > maxX || worldY < minY || worldY > maxY) {
      continue;
    }

    const curve = computeDynamicEdgeCurve(
      srcRect,
      dstRect,
      edge.source_id,
      edge.target_id,
      obstacles,
    );

    let prevX = curve.x1;
    let prevY = curve.y1;
    let edgeMinDistSq = Number.POSITIVE_INFINITY;
    for (let i = 1; i <= 16; i += 1) {
      const t = i / 16;
      const nx = cubicBezierAt(curve.x1, curve.cx1, curve.cx2, curve.x2, t);
      const ny = cubicBezierAt(curve.y1, curve.cy1, curve.cy2, curve.y2, t);
      const d2 = pointToSegmentDistSq(worldX, worldY, prevX, prevY, nx, ny);
      if (d2 < edgeMinDistSq) {
        edgeMinDistSq = d2;
      }
      prevX = nx;
      prevY = ny;
    }

    if (edgeMinDistSq <= bestDistSq) {
      bestDistSq = edgeMinDistSq;
      bestEdgeId = edge.id;
    }
  }

  return bestEdgeId;
}

function drawEdgeMidpointBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  accentStroke: string,
  p: ThemePalette,
  emphasized: boolean,
): void {
  ctx.save();
  ctx.font = "600 10.5px Inter, sans-serif";
  const textW =
    typeof ctx.measureText === "function" ? ctx.measureText(label).width : label.length * 6.2;
  const padX = 7;
  const badgeW = textW + padX * 2;
  const badgeH = 20;
  const bx = x - badgeW * 0.5;
  const by = y - badgeH * 0.5;

  drawRoundedRectPath(ctx, bx, by, badgeW, badgeH, 10);
  ctx.fillStyle = p.bgCard;
  ctx.fill();
  ctx.lineWidth = emphasized ? 1.5 : 1;
  ctx.strokeStyle = emphasized ? accentStroke : p.borderStrong;
  ctx.stroke();

  ctx.fillStyle = p.textPrimary;
  ctx.textBaseline = "middle";
  ctx.fillText(label, bx + padX, y + 0.5);
  ctx.restore();
}

export function renderCanvas2d(ctx: CanvasRenderingContext2D, scene: RenderSceneInput): void {
  const {
    cam,
    width,
    height,
    nodes,
    edges,
    dragOffsets,
    resizeSizes,
    selectedIds,
    focusId,
    hoveredId = null,
    selectedEdgeId = null,
    hoveredEdgeId = null,
    connectSourceId = null,
    xrayState,
    unresolvedLoopholes,
    staleNodeIds,
    spotlightIds = null,
    outOfSyncRefIds,
    marqueeWorld,
    edgePreviewWorld,
    groups,
    selectedGroupId = null,
    themeKey,
    animTimeMs = 0,
    animateEdges = false,
  } = scene;
  const p = getPalette(themeKey);
  const isBirdsEyeLod = cam.zoom < LOD_THRESHOLD;
  const hasSpotlight =
    spotlightIds !== null && spotlightIds !== undefined && spotlightIds.size > 0 && xrayState === null;

  // 1. Background fill
  ctx.fillStyle = p.bgCanvas;
  ctx.fillRect(0, 0, width, height);

  // 2. Procedural Dot Grid
  let worldStep = 24;
  while (worldStep * cam.zoom < 10) {
    worldStep *= 2;
  }
  const gridAlpha = Math.max(0, Math.min(1, (cam.zoom - 0.25) / 0.25));
  if (gridAlpha > 0.02) {
    const topLeft = screenToWorld(0, 0, cam);
    const bottomRight = screenToWorld(width, height, cam);
    const startX = Math.floor(topLeft.x / worldStep) * worldStep;
    const endX = Math.ceil(bottomRight.x / worldStep) * worldStep;
    const startY = Math.floor(topLeft.y / worldStep) * worldStep;
    const endY = Math.ceil(bottomRight.y / worldStep) * worldStep;

    ctx.save();
    ctx.globalAlpha = gridAlpha;
    ctx.fillStyle = p.bgDot;
    for (let wx = startX; wx <= endX; wx += worldStep) {
      const sx = wx * cam.zoom + cam.x;
      for (let wy = startY; wy <= endY; wy += worldStep) {
        const sy = wy * cam.zoom + cam.y;
        ctx.fillRect(sx - 0.75, sy - 0.75, 1.5, 1.5);
      }
    }
    ctx.restore();
  }

  // World-space transform for edges, X-Ray halos, Bird's-Eye cards, marquee, and edge preview
  ctx.save();
  ctx.translate(cam.x, cam.y);
  ctx.scale(cam.zoom, cam.zoom);

  const activeEdgeSet = xrayState ? new Set(xrayState.active_edges) : null;
  const viewTL = screenToWorld(0, 0, cam);
  const viewBR = screenToWorld(width, height, cam);
  const edgePad = 240;
  const minEdgeVx = viewTL.x - edgePad;
  const minEdgeVy = viewTL.y - edgePad;
  const maxEdgeVx = viewBR.x + edgePad;
  const maxEdgeVy = viewBR.y + edgePad;

  const sceneRects = new Map<string, NodeRect>();
  const visibleObstacles: Array<{ id: string; rect: NodeRect }> = [];
  for (const node of nodes.values()) {
    const rect = getNodeRect(node, dragOffsets, resizeSizes);
    sceneRects.set(node.id, rect);
    if (
      !isBirdsEyeLod &&
      rect.x + rect.w >= minEdgeVx &&
      rect.x <= maxEdgeVx &&
      rect.y + rect.h >= minEdgeVy &&
      rect.y <= maxEdgeVy
    ) {
      visibleObstacles.push({ id: node.id, rect });
    }
  }

  // 2.5 Spatial Canvas Groups (O(1) skip when empty)
  const groupCount = groups ? ("size" in groups ? groups.size : groups.length) : 0;
  if (groups && groupCount > 0) {
    const groupIter = "size" in groups ? groups.values() : groups;
    const isLightTheme = themeKey === "light";
    const placedChips: PlacedChipRect[] = [];
    for (const group of groupIter) {
      const bounds = computeGroupBounds(group, sceneRects);
      if (!bounds) {
        continue;
      }
      if (
        bounds.x + bounds.w < minEdgeVx ||
        bounds.x > maxEdgeVx ||
        bounds.y + bounds.h < minEdgeVy ||
        bounds.y > maxEdgeVy
      ) {
        continue;
      }

      const accent = resolveGroupAccent(group.color_key, p);
      const isSelectedGroup = selectedGroupId === group.id;
      const fillAlpha = isSelectedGroup ? (isLightTheme ? 0.14 : 0.13) : (isLightTheme ? 0.08 : 0.07);
      const strokeAlpha = isSelectedGroup ? 0.92 : 0.48;

      ctx.save();
      drawRoundedRectPath(ctx, bounds.x, bounds.y, bounds.w, bounds.h, 12);
      ctx.fillStyle = colorWithAlpha(accent, fillAlpha);
      ctx.fill();

      ctx.lineWidth = isSelectedGroup
        ? isBirdsEyeLod
          ? 2.2 / cam.zoom
          : 2.0
        : isBirdsEyeLod
          ? 1.4 / cam.zoom
          : 1.25;
      ctx.strokeStyle = colorWithAlpha(accent, strokeAlpha);
      ctx.setLineDash(isSelectedGroup ? [] : [6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (cam.zoom >= 0.2) {
        ctx.font = "600 11.5px Inter, sans-serif";
        const { chipLabel, chipPadX, rect: chipRect } = resolveGroupChipRect(
          group,
          bounds,
          placedChips,
          typeof ctx.measureText === "function" ? (lbl) => ctx.measureText(lbl).width : undefined,
        );
        const { x: chipX, y: chipY, w: chipW, h: chipH } = chipRect;

        drawRoundedRectPath(ctx, chipX, chipY, chipW, chipH, 13);
        ctx.fillStyle = isSelectedGroup
          ? colorWithAlpha(accent, isLightTheme ? 0.22 : 0.24)
          : p.bgCard;
        ctx.fill();
        ctx.lineWidth = isSelectedGroup ? 1.5 : 1;
        ctx.strokeStyle = colorWithAlpha(accent, isSelectedGroup ? 0.95 : 0.6);
        ctx.stroke();

        ctx.save();
        drawRoundedRectPath(ctx, chipX + 4, chipY, Math.max(10, chipW - 8), chipH, 10);
        ctx.clip();
        ctx.fillStyle = p.textPrimary;
        ctx.textBaseline = "middle";
        ctx.fillText(chipLabel, chipX + chipPadX, chipY + chipH * 0.5 + 0.5);
        ctx.restore();
      }
      ctx.restore();
    }
  }

  // 3. Directed Cubic Bezier Edges (dynamic 4-side routing + obstacle deflection)
  for (const edge of edges.values()) {
    const srcNode = nodes.get(edge.source_id);
    const dstNode = nodes.get(edge.target_id);
    const srcRect = sceneRects.get(edge.source_id);
    const dstRect = sceneRects.get(edge.target_id);
    if (!srcNode || !dstNode || !srcRect || !dstRect) {
      continue;
    }

    const edgeMinX = Math.min(srcRect.x, dstRect.x);
    const edgeMinY = Math.min(srcRect.y, dstRect.y);
    const edgeMaxX = Math.max(srcRect.x + srcRect.w, dstRect.x + dstRect.w);
    const edgeMaxY = Math.max(srcRect.y + srcRect.h, dstRect.y + dstRect.h);
    if (
      edgeMaxX < minEdgeVx ||
      edgeMinX > maxEdgeVx ||
      edgeMaxY < minEdgeVy ||
      edgeMinY > maxEdgeVy
    ) {
      continue;
    }

    const { x1, y1, cx1, cy1, cx2, cy2, x2, y2 } = computeDynamicEdgeCurve(
      srcRect,
      dstRect,
      srcNode.id,
      dstNode.id,
      visibleObstacles,
    );

    let stroke = p.edgeDefault;
    let lineWidth = 2.0;
    let dash: number[] = [];
    let alpha = 1.0;

    switch (edge.type) {
      case "derives":
        stroke = p.edgeDefault;
        lineWidth = 2.0;
        break;
      case "synthesizes":
        stroke = p.edgeSynthesis;
        lineWidth = 2.0;
        break;
      case "branches":
        stroke = p.edgeBranch;
        lineWidth = 2.0;
        dash = [6, 4];
        break;
      case "challenges":
        stroke = p.edgeChallenge;
        lineWidth = 2.25;
        if (srcNode.status === "resolved" || srcNode.status === "dismissed") {
          alpha = 0.3;
        }
        break;
      case "resolves":
        stroke = p.edgeResolve;
        lineWidth = 2.0;
        dash = [2, 4];
        break;
      case "references":
        stroke = p.edgeReference;
        lineWidth = 1.75;
        dash = [4, 5];
        break;
    }

    const isSelectedEdge = selectedEdgeId === edge.id;
    const isHoveredEdge = hoveredEdgeId === edge.id;
    const isIncidentEmphasized =
      srcNode.id === focusId ||
      dstNode.id === focusId ||
      srcNode.id === hoveredId ||
      dstNode.id === hoveredId ||
      dragOffsets.has(srcNode.id) ||
      dragOffsets.has(dstNode.id) ||
      Boolean(resizeSizes?.has(srcNode.id)) ||
      Boolean(resizeSizes?.has(dstNode.id));

    const isSpotlightDimmedEdge =
      hasSpotlight && !(spotlightIds.has(srcNode.id) && spotlightIds.has(dstNode.id));

    if (activeEdgeSet) {
      if (activeEdgeSet.has(edge.id)) {
        lineWidth = 2.75;
        alpha = 1.0;
      } else {
        alpha = 0.12;
      }
    } else if (isSpotlightDimmedEdge) {
      alpha *= 0.18;
    } else if (isIncidentEmphasized) {
      lineWidth = 2.75;
    }

    if (isSelectedEdge) {
      lineWidth = Math.max(lineWidth, 3.75);
      alpha = 1.0;
    } else if (isHoveredEdge) {
      lineWidth = Math.max(lineWidth, 3.0);
      alpha = Math.max(alpha, 0.9);
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke;
    ctx.fillStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    if (
      isSelectedEdge ||
      isHoveredEdge ||
      (isIncidentEmphasized &&
        !isSpotlightDimmedEdge &&
        (!activeEdgeSet || activeEdgeSet.has(edge.id)))
    ) {
      ctx.shadowColor = stroke;
      ctx.shadowBlur = isSelectedEdge ? 10 : isHoveredEdge ? 7 : 8;
    }
    ctx.setLineDash(dash);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2);
    ctx.stroke();

    ctx.setLineDash([]);
    drawArrowhead(ctx, x2, y2, cx2, cy2, isSelectedEdge ? 9.5 : 8.5);
    ctx.restore();

    if ((isSelectedEdge || isHoveredEdge) && !isBirdsEyeLod) {
      const mx = cubicBezierAt(x1, cx1, cx2, x2, 0.5);
      const my = cubicBezierAt(y1, cy1, cy2, y2, 0.5);
      drawEdgeMidpointBadge(
        ctx,
        mx,
        my,
        `${edge.type} · ${edge.weight}`,
        stroke,
        p,
        isSelectedEdge,
      );
    }

    const isDimmedByXray = Boolean(activeEdgeSet && !activeEdgeSet.has(edge.id));
    if (animateEdges && !isBirdsEyeLod && !isDimmedByXray && alpha > 0.35) {
      const flowPhase = (animTimeMs * 0.028) % 24;
      ctx.save();
      ctx.globalAlpha = isIncidentEmphasized ? 0.44 : 0.24;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = isIncidentEmphasized ? 1.8 : 1.35;
      ctx.lineCap = "round";
      ctx.setLineDash([5, 19]);
      ctx.lineDashOffset = -flowPhase;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2);
      ctx.stroke();

      if (isIncidentEmphasized) {
        const t = ((animTimeMs * 0.00055) % 1 + 1) % 1;
        const orbX = cubicBezierAt(x1, cx1, cx2, x2, t);
        const orbY = cubicBezierAt(y1, cy1, cy2, y2, t);
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.96;
        ctx.fillStyle = stroke;
        ctx.shadowColor = stroke;
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(orbX, orbY, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // 4. Hold-V X-Ray Halos
  if (xrayState) {
    for (const [nodeId, mode] of Object.entries(xrayState.node_modes)) {
      const rect = sceneRects.get(nodeId);
      if (!rect) {
        continue;
      }
      const color = getXrayColor(mode, p);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      drawRoundedRectPath(ctx, rect.x - 4, rect.y - 4, rect.w + 8, rect.h + 8, 11);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 5. Bird's-Eye LOD Cards (zoom < 0.45)
  if (isBirdsEyeLod) {
    const pad = 120;
    const minVx = viewTL.x - pad;
    const minVy = viewTL.y - pad;
    const maxVx = viewBR.x + pad;
    const maxVy = viewBR.y + pad;

    for (const node of nodes.values()) {
      const rect = sceneRects.get(node.id);
      if (!rect) continue;
      if (
        rect.x + rect.w < minVx ||
        rect.x > maxVx ||
        rect.y + rect.h < minVy ||
        rect.y > maxVy
      ) {
        continue;
      }

      const isFocused = focusId === node.id;
      const isSelected = selectedIds.has(node.id);
      const isMutedLoophole =
        node.type === "loophole" && (node.status === "resolved" || node.status === "dismissed");

      ctx.save();
      if (hasSpotlight && !spotlightIds.has(node.id)) {
        ctx.globalAlpha = 0.22;
      } else if (isMutedLoophole) {
        ctx.globalAlpha = 0.48;
      } else if (node.context_controls.exclude_from_ai) {
        ctx.globalAlpha = 0.65;
      }

      drawRoundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 6);
      ctx.fillStyle = p.bgCard;
      ctx.fill();

      ctx.lineWidth = isFocused || isSelected ? 2 / cam.zoom : 1 / cam.zoom;
      ctx.strokeStyle = isFocused
        ? p.ringFocus
        : isSelected
          ? p.ringMulti
          : p.borderSubtle;
      ctx.stroke();

      // 4px semantic left accent bar
      ctx.fillStyle = getSemanticBarColor(node, p, themeKey);
      ctx.fillRect(rect.x + 1, rect.y + 4, 4, Math.max(4, rect.h - 8));

      // Pin indicator dot
      if (node.context_controls.pin_global) {
        ctx.fillStyle = p.xrayPin;
        ctx.beginPath();
        ctx.arc(rect.x + rect.w - 28, rect.y + 14, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Stale AI node indicator dot
      if (staleNodeIds?.has(node.id)) {
        ctx.fillStyle = "#f59e0b";
        ctx.beginPath();
        ctx.arc(rect.x + rect.w - 42, rect.y + 14, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Out-of-sync external ref indicator dot
      if (outOfSyncRefIds?.has(node.id)) {
        ctx.fillStyle = "#06b6d4";
        ctx.beginPath();
        ctx.arc(rect.x + rect.w - 56, rect.y + 14, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Unresolved loophole dot
      const lh = unresolvedLoopholes.get(node.id);
      if (lh && lh.count > 0) {
        ctx.fillStyle = getSeverityColor(lh.maxSeverity, p);
        ctx.beginPath();
        ctx.arc(rect.x + rect.w - 14, rect.y + 14, 5.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Single-line truncated title (hidden below zoom 0.20)
      if (cam.zoom >= 0.2 && node.title.length > 0) {
        ctx.save();
        drawRoundedRectPath(ctx, rect.x + 10, rect.y + 6, Math.max(10, rect.w - 34), rect.h - 12, 4);
        ctx.clip();
        ctx.fillStyle = p.textPrimary;
        ctx.font = `600 ${Math.round(14 / Math.max(0.28, cam.zoom) * 0.45 + 10)}px Inter, sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillText(node.title, rect.x + 12, rect.y + 10, Math.max(20, rect.w - 40));
        ctx.restore();
      }

      ctx.restore();
    }
  }

  // 5.5 Connect-Edge Source Highlight Ring (Normal & Bird's-Eye LOD)
  if (connectSourceId) {
    const srcRect = sceneRects.get(connectSourceId);
    if (srcRect) {
      ctx.save();
      ctx.strokeStyle = p.accentBranch;
      ctx.lineWidth = isBirdsEyeLod ? 2.5 / cam.zoom : 2.5;
      const dashScale = isBirdsEyeLod ? 1 / cam.zoom : 1;
      ctx.setLineDash([6 * dashScale, 4 * dashScale]);
      const pad = isBirdsEyeLod ? 5 / cam.zoom : 5;
      drawRoundedRectPath(
        ctx,
        srcRect.x - pad,
        srcRect.y - pad,
        srcRect.w + pad * 2,
        srcRect.h + pad * 2,
        10,
      );
      ctx.stroke();
      ctx.restore();
    }
  }

  // 6. Marquee Box-Select Rectangle
  if (marqueeWorld && marqueeWorld.width > 0 && marqueeWorld.height > 0) {
    ctx.save();
    ctx.fillStyle = "rgba(96, 165, 250, 0.12)";
    ctx.strokeStyle = p.accentBranch;
    ctx.lineWidth = 1.5 / Math.max(0.2, cam.zoom);
    ctx.fillRect(marqueeWorld.x, marqueeWorld.y, marqueeWorld.width, marqueeWorld.height);
    ctx.strokeRect(marqueeWorld.x, marqueeWorld.y, marqueeWorld.width, marqueeWorld.height);
    ctx.restore();
  }

  // 7. Live Alt+Drag / Port-Drag Edge Preview
  if (edgePreviewWorld) {
    const srcRect = sceneRects.get(edgePreviewWorld.sourceId);
    if (srcRect) {
      const from = edgePreviewWorld.sourceDir
        ? portForDirection(srcRect, edgePreviewWorld.sourceDir)
        : nearestPortToPoint(srcRect, edgePreviewWorld.targetX, edgePreviewWorld.targetY);
      const dist = Math.hypot(edgePreviewWorld.targetX - from.x, edgePreviewWorld.targetY - from.y);
      const offset = Math.max(36, dist * 0.35);
      const cx1 = from.x + from.nx * offset;
      const cy1 = from.y + from.ny * offset;

      ctx.save();
      ctx.strokeStyle = p.accentBranch;
      ctx.fillStyle = p.accentBranch;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.bezierCurveTo(
        cx1,
        cy1,
        edgePreviewWorld.targetX,
        edgePreviewWorld.targetY,
        edgePreviewWorld.targetX,
        edgePreviewWorld.targetY,
      );
      ctx.stroke();
      ctx.setLineDash([]);
      drawArrowhead(
        ctx,
        edgePreviewWorld.targetX,
        edgePreviewWorld.targetY,
        cx1,
        cy1,
        8,
      );
      ctx.restore();
    }
  }

  ctx.restore();
}

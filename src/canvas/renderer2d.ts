import type {
  CameraState,
  CompiledXray,
  EdgeDto,
  InclusionMode,
  NodeDto,
  Severity,
} from "../ipc/types";
import type { LoopholeSummary } from "../store/graphStore";
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
  xrayState: CompiledXray | null;
  unresolvedLoopholes: Map<string, LoopholeSummary>;
  marqueeWorld: MarqueeRect | null;
  edgePreviewWorld: EdgePreview | null;
  themeKey: "dark" | "light";
  animTimeMs?: number;
  animateEdges?: boolean;
}

interface ThemePalette {
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
}

let cachedPaletteKey: string | null = null;
let cachedPalette: ThemePalette | null = null;

function readCssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const val = style.getPropertyValue(name).trim();
  return val.length > 0 ? val : fallback;
}

function getPalette(themeKey: "dark" | "light"): ThemePalette {
  if (cachedPalette && cachedPaletteKey === themeKey) {
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
  dragOffsets: Map<string, { x: number; y: number }>,
  resizeSizes?: Map<string, { width: number; height: number }>,
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

function getSemanticBarColor(node: NodeDto, p: ThemePalette): string {
  switch (node.type) {
    case "core":
      return p.accentCore;
    case "branch":
      return p.accentBranch;
    case "probe":
      return p.accentProbe;
    case "synthesis":
      return p.accentSynthesis;
    case "loophole":
      if (node.status === "resolved" || node.status === "dismissed") {
        return p.borderStrong;
      }
      return getSeverityColor(node.metadata.severity, p);
  }
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
    xrayState,
    unresolvedLoopholes,
    marqueeWorld,
    edgePreviewWorld,
    themeKey,
    animTimeMs = 0,
    animateEdges = false,
  } = scene;
  const p = getPalette(themeKey);
  const isBirdsEyeLod = cam.zoom < LOD_THRESHOLD;

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
  const isBirdsEyeLod = cam.zoom < LOD_THRESHOLD;

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

    const isIncidentEmphasized =
      srcNode.id === focusId ||
      dstNode.id === focusId ||
      srcNode.id === hoveredId ||
      dstNode.id === hoveredId ||
      dragOffsets.has(srcNode.id) ||
      dragOffsets.has(dstNode.id) ||
      Boolean(resizeSizes?.has(srcNode.id)) ||
      Boolean(resizeSizes?.has(dstNode.id));

    if (activeEdgeSet) {
      if (activeEdgeSet.has(edge.id)) {
        lineWidth = 2.75;
        alpha = 1.0;
      } else {
        alpha = 0.12;
      }
    } else if (isIncidentEmphasized) {
      lineWidth = 2.75;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke;
    ctx.fillStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    if (isIncidentEmphasized && (!activeEdgeSet || activeEdgeSet.has(edge.id))) {
      ctx.shadowColor = stroke;
      ctx.shadowBlur = 8;
    }
    ctx.setLineDash(dash);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2);
    ctx.stroke();

    ctx.setLineDash([]);
    drawArrowhead(ctx, x2, y2, cx2, cy2, 8.5);
    ctx.restore();

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
      if (isMutedLoophole) {
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
      ctx.fillStyle = getSemanticBarColor(node, p);
      ctx.fillRect(rect.x + 1, rect.y + 4, 4, Math.max(4, rect.h - 8));

      // Pin indicator dot
      if (node.context_controls.pin_global) {
        ctx.fillStyle = p.xrayPin;
        ctx.beginPath();
        ctx.arc(rect.x + rect.w - 28, rect.y + 14, 4.5, 0, Math.PI * 2);
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

  // 7. Live Alt+Drag Edge Preview
  if (edgePreviewWorld) {
    const srcRect = sceneRects.get(edgePreviewWorld.sourceId);
    if (srcRect) {
      const from = nearestPortToPoint(
        srcRect,
        edgePreviewWorld.targetX,
        edgePreviewWorld.targetY,
      );
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

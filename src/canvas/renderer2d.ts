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
  selectedIds: ReadonlySet<string>;
  focusId: string | null;
  xrayState: CompiledXray | null;
  unresolvedLoopholes: Map<string, LoopholeSummary>;
  marqueeWorld: MarqueeRect | null;
  edgePreviewWorld: EdgePreview | null;
  themeKey: "dark" | "light";
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
  const style = getComputedStyle(document.documentElement);
  const palette: ThemePalette = {
    bgCanvas: readCssVar(style, "--bg-canvas", themeKey === "light" ? "#f6f7f9" : "#0e1013"),
    bgDot: readCssVar(style, "--bg-dot", themeKey === "light" ? "#d5dae2" : "#232730"),
    bgCard: readCssVar(style, "--bg-card", themeKey === "light" ? "#ffffff" : "#15181e"),
    borderSubtle: readCssVar(style, "--border-subtle", "#262b36"),
    borderStrong: readCssVar(style, "--border-strong", "#3a4252"),
    textPrimary: readCssVar(style, "--text-primary", themeKey === "light" ? "#111827" : "#e6eaf0"),
    edgeDefault: readCssVar(style, "--edge-default", "#3f4756"),
    edgeBranch: readCssVar(style, "--edge-branch", "#5b7fa6"),
    edgeChallenge: readCssVar(style, "--edge-challenge", "#d97706"),
    edgeResolve: readCssVar(style, "--edge-resolve", "#2f855a"),
    edgeReference: readCssVar(style, "--edge-reference", "#4b5563"),
    accentCore: readCssVar(style, "--accent-core", "#cbd5e1"),
    accentBranch: readCssVar(style, "--accent-branch", "#60a5fa"),
    accentProbe: readCssVar(style, "--accent-probe", "#38bdf8"),
    accentSynthesis: readCssVar(style, "--accent-synthesis", "#34d399"),
    loopholeLow: readCssVar(style, "--accent-loophole-low", "#eab308"),
    loopholeMed: readCssVar(style, "--accent-loophole-med", "#f59e0b"),
    loopholeHigh: readCssVar(style, "--accent-loophole-high", "#ef4444"),
    loopholeCrit: readCssVar(style, "--accent-loophole-crit", "#dc2626"),
    ringFocus: readCssVar(style, "--ring-focus", "#e2e8f0"),
    ringMulti: readCssVar(style, "--ring-multi", "#94a3b8"),
    xrayPin: readCssVar(style, "--xray-pin", "#c084fc"),
    xrayFocus: readCssVar(style, "--xray-focus", "#22d3ee"),
    xrayFull: readCssVar(style, "--xray-full", "#4ade80"),
    xraySummary: readCssVar(style, "--xray-summary", "#60a5fa"),
    xrayLoophole: readCssVar(style, "--xray-loophole", "#f59e0b"),
    xrayReference: readCssVar(style, "--xray-reference", "#94a3b8"),
  };
  cachedPaletteKey = themeKey;
  cachedPalette = palette;
  return palette;
}

interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function getNodeRect(
  node: NodeDto,
  dragOffsets: Map<string, { x: number; y: number }>,
): NodeRect {
  const offset = dragOffsets.get(node.id);
  return {
    x: node.layout.x + (offset?.x ?? 0),
    y: node.layout.y + (offset?.y ?? 0),
    w: node.layout.width,
    h: getEffectiveNodeHeight(node),
  };
}

interface PortPoint {
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

function nearestPortPair(src: NodeRect, dst: NodeRect): { from: PortPoint; to: PortPoint } {
  const sp = cardinalPorts(src);
  const dp = cardinalPorts(dst);
  let bestFrom = sp[0];
  let bestTo = dp[0];
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (const a of sp) {
    for (const b of dp) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestFrom = a;
        bestTo = b;
      }
    }
  }
  return { from: bestFrom, to: bestTo };
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

export function renderCanvas2d(ctx: CanvasRenderingContext2D, scene: RenderSceneInput): void {
  const {
    cam,
    width,
    height,
    nodes,
    edges,
    dragOffsets,
    selectedIds,
    focusId,
    xrayState,
    unresolvedLoopholes,
    marqueeWorld,
    edgePreviewWorld,
    themeKey,
  } = scene;
  const p = getPalette(themeKey);

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

  // 3. Directed Cubic Bezier Edges
  for (const edge of edges.values()) {
    const srcNode = nodes.get(edge.source_id);
    const dstNode = nodes.get(edge.target_id);
    if (!srcNode || !dstNode) {
      continue;
    }

    const srcRect = getNodeRect(srcNode, dragOffsets);
    const dstRect = getNodeRect(dstNode, dragOffsets);

    let x1: number;
    let y1: number;
    let cx1: number;
    let cy1: number;
    let cx2: number;
    let cy2: number;
    let x2: number;
    let y2: number;

    if (edge.type === "derives" || edge.type === "branches" || edge.type === "synthesizes") {
      x1 = srcRect.x + srcRect.w;
      y1 = srcRect.y + srcRect.h / 2;
      x2 = dstRect.x;
      y2 = dstRect.y + dstRect.h / 2;
      const dx = Math.max(48, Math.abs(x2 - x1) * 0.45);
      cx1 = x1 + dx;
      cy1 = y1;
      cx2 = x2 - dx;
      cy2 = y2;
    } else {
      const { from, to } = nearestPortPair(srcRect, dstRect);
      x1 = from.x;
      y1 = from.y;
      x2 = to.x;
      y2 = to.y;
      const dist = Math.hypot(x2 - x1, y2 - y1);
      const offset = Math.max(36, dist * 0.35);
      cx1 = x1 + from.nx * offset;
      cy1 = y1 + from.ny * offset;
      cx2 = x2 + to.nx * offset;
      cy2 = y2 + to.ny * offset;
    }

    let stroke = p.edgeDefault;
    let lineWidth = 1.5;
    let dash: number[] = [];
    let alpha = 1.0;

    switch (edge.type) {
      case "derives":
      case "synthesizes":
        stroke = p.edgeDefault;
        lineWidth = 1.5;
        break;
      case "branches":
        stroke = p.edgeBranch;
        lineWidth = 1.5;
        dash = [6, 4];
        break;
      case "challenges":
        stroke = p.edgeChallenge;
        lineWidth = 1.75;
        if (srcNode.status === "resolved" || srcNode.status === "dismissed") {
          alpha = 0.3;
        }
        break;
      case "resolves":
        stroke = p.edgeResolve;
        lineWidth = 1.5;
        dash = [2, 4];
        break;
      case "references":
        stroke = p.edgeReference;
        lineWidth = 1.25;
        dash = [3, 5];
        break;
    }

    if (activeEdgeSet) {
      if (activeEdgeSet.has(edge.id)) {
        lineWidth = 2.5;
        alpha = 1.0;
      } else {
        alpha = 0.12;
      }
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke;
    ctx.fillStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2);
    ctx.stroke();

    ctx.setLineDash([]);
    drawArrowhead(ctx, x2, y2, cx2, cy2, 7);
    ctx.restore();
  }

  // 4. Hold-V X-Ray Halos
  if (xrayState) {
    for (const [nodeId, mode] of Object.entries(xrayState.node_modes)) {
      const node = nodes.get(nodeId);
      if (!node) {
        continue;
      }
      const rect = getNodeRect(node, dragOffsets);
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
  if (cam.zoom < LOD_THRESHOLD) {
    const viewTL = screenToWorld(0, 0, cam);
    const viewBR = screenToWorld(width, height, cam);
    const pad = 120;
    const minVx = viewTL.x - pad;
    const minVy = viewTL.y - pad;
    const maxVx = viewBR.x + pad;
    const maxVy = viewBR.y + pad;

    for (const node of nodes.values()) {
      const rect = getNodeRect(node, dragOffsets);
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
    const srcNode = nodes.get(edgePreviewWorld.sourceId);
    if (srcNode) {
      const srcRect = getNodeRect(srcNode, dragOffsets);
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

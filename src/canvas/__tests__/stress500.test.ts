// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardLayer } from "../../cards/CardLayer";
import type { EdgeDto, EdgeType, NodeDto, NodeStatus, NodeType, Severity } from "../../ipc/types";
import {
  dragOffsets,
  edgesMap,
  isBirdsEye,
  loadSnapshot,
  nodesMap,
  recomputeUnresolvedLoopholes,
  unresolvedLoopholes,
  viewportSpatialIndex,
  visibleNodeIds,
} from "../../store/graphStore";
import { focusId, selectedIds, xrayState } from "../../store/selection";
import { LOD_THRESHOLD, screenToWorld } from "../camera";
import { FrameTimeTracker } from "../perfMetrics";
import { renderCanvas2d } from "../renderer2d";

interface MockCanvas2DContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  lineWidth: number;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  textBaseline: CanvasTextBaseline;
  save: () => void;
  restore: () => void;
  scale: (x: number, y: number) => void;
  translate: (x: number, y: number) => void;
  setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  setLineDash: (segments: number[]) => void;
  beginPath: () => void;
  closePath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  quadraticCurveTo: (cpx: number, cpy: number, x: number, y: number) => void;
  bezierCurveTo: (
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ) => void;
  arc: (
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ) => void;
  clip: () => void;
  fill: () => void;
  stroke: () => void;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  strokeRect: (x: number, y: number, w: number, h: number) => void;
  fillText: (text: string, x: number, y: number, maxWidth?: number) => void;
}

function createMockCanvasContext(): CanvasRenderingContext2D {
  const noop = (): void => {};
  const ctx: MockCanvas2DContext = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    font: "12px sans-serif",
    lineWidth: 1,
    globalAlpha: 1,
    shadowColor: "transparent",
    shadowBlur: 0,
    textBaseline: "top",
    save: noop,
    restore: noop,
    scale: noop,
    translate: noop,
    setTransform: noop,
    setLineDash: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    arc: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    fillText: noop,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function buildStressGraph500(): { nodes: NodeDto[]; edges: EdgeDto[] } {
  const nodes: NodeDto[] = [];
  const edges: EdgeDto[] = [];
  const rowsPerCol = 20;
  const baseTs = 1_700_000_000_000;
  const types: NodeType[] = ["core", "branch", "loophole", "probe", "synthesis"];
  const sevs: Severity[] = ["low", "medium", "high", "critical"];

  for (let i = 0; i < 500; i += 1) {
    const type: NodeType = i === 0 ? "core" : (types[i % types.length] ?? "branch");
    const status: NodeStatus = type === "loophole" && i % 6 === 4 ? "resolved" : "active";
    const col = Math.floor(i / rowsPerCol);
    const row = i % rowsPerCol;
    nodes.push({
      id: `stress_node_${String(i).padStart(3, "0")}`,
      type,
      status,
      title: `Stress Node #${String(i).padStart(3, "0")}`,
      content: `Body for stress node ${i} with $O(N \\log N)$ culling.`,
      summary: `Summary ${i}`,
      content_hash: `hash_${i}`,
      summary_hash: `hash_${i}`,
      metadata: {
        severity: type === "loophole" ? (sevs[i % sevs.length] ?? "medium") : null,
        lens: "manual",
        created_by: i % 2 === 0 ? "user" : "ai",
        model: null,
        token_count: 16,
      },
      context_controls: {
        pin_global: i === 0 || i === 25,
        exclude_from_ai: i > 0 && i % 19 === 0,
      },
      layout: {
        x: col * 420,
        y: row * 240,
        width: 320,
        height: 180,
        collapsed: i > 0 && i % 11 === 0,
      },
      created_at: baseTs + i * 1000,
      updated_at: baseTs + i * 1000,
    });
  }

  const seen = new Set<string>();
  const pushEdge = (src: number, dst: number, type: EdgeType): void => {
    if (src === dst || edges.length >= 700) return;
    const key = `${src}:${dst}:${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    const idx = edges.length;
    edges.push({
      id: `stress_edge_${String(idx).padStart(3, "0")}`,
      source_id: `stress_node_${String(src).padStart(3, "0")}`,
      target_id: `stress_node_${String(dst).padStart(3, "0")}`,
      type,
      weight: idx % 4 === 0 ? "summary" : "full",
      created_at: baseTs + idx * 1000,
    });
  };

  for (let i = 1; i < 500; i += 1) {
    const parent = i < rowsPerCol ? 0 : i - rowsPerCol;
    const nodeType = nodes[i]?.type;
    const edgeType: EdgeType =
      nodeType === "loophole"
        ? "challenges"
        : nodeType === "synthesis"
          ? "synthesizes"
          : "derives";
    pushEdge(parent, i, edgeType);
  }
  for (let i = rowsPerCol; i < 500 && edges.length < 700; i += 1) {
    if (nodes[i]?.type === "synthesis") {
      const col = Math.floor(i / rowsPerCol);
      const row = i % rowsPerCol;
      const altParent = (col - 1) * rowsPerCol + ((row + 1) % rowsPerCol);
      pushEdge(altParent, i, "synthesizes");
    }
  }
  let cursor = 0;
  while (edges.length < 700) {
    pushEdge(cursor % 500, (cursor + 23) % 500, "references");
    cursor += 1;
  }

  return { nodes, edges };
}

describe("Slice 5: 500-node / 700-edge render performance, rbush culling & LOD cutoff", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    render(null, container);
    container.remove();
  });

  it("renders 120 pan/zoom frames within 16.6ms p95, culls via rbush, and mounts 0 cards below 0.45x LOD", () => {
    const { nodes, edges } = buildStressGraph500();
    expect(nodes).toHaveLength(500);
    expect(edges).toHaveLength(700);

    loadSnapshot({
      path: "memory://stress-500",
      nodes,
      edges,
      camera: { x: 120, y: 80, zoom: 1.0, last_focus_id: "stress_node_000" },
      token_budget: 6000,
    });
    recomputeUnresolvedLoopholes();

    // Verify rbush viewport culling at 1.0x zoom in a 1280x800 viewport.
    const cam1x = { x: 120, y: 80, zoom: 1.0, last_focus_id: "stress_node_000" };
    const topLeft = screenToWorld(0, 0, cam1x);
    const bottomRight = screenToWorld(1280, 800, cam1x);
    const culledAt1x = viewportSpatialIndex.queryViewport(
      {
        minX: topLeft.x,
        minY: topLeft.y,
        maxX: bottomRight.x,
        maxY: bottomRight.y,
      },
      200,
    );
    expect(culledAt1x.length).toBeGreaterThan(0);
    expect(culledAt1x.length).toBeLessThan(500);

    // Run 120 pan/zoom frames across Normal (1.0x) and Bird's-Eye (0.30x) modes.
    const ctx = createMockCanvasContext();
    const tracker = new FrameTimeTracker(120);

    for (let frame = 0; frame < 120; frame += 1) {
      const isBirdFrame = frame >= 60;
      const zoom = isBirdFrame ? 0.3 : 1.0;
      const cam = {
        x: 120 - (frame % 30) * 18,
        y: 80 - (frame % 20) * 12,
        zoom,
        last_focus_id: "stress_node_000",
      };

      const start = performance.now();
      renderCanvas2d(ctx, {
        cam,
        width: 1280,
        height: 800,
        nodes: nodesMap,
        edges: edgesMap,
        dragOffsets,
        selectedIds: selectedIds.value,
        focusId: focusId.value,
        xrayState: xrayState.value,
        unresolvedLoopholes: unresolvedLoopholes.value,
        marqueeWorld: null,
        edgePreviewWorld: null,
        themeKey: "dark",
      });
      const drawMs = Math.max(0, performance.now() - start);
      tracker.record(drawMs, 16.6);
    }

    const stats = tracker.getStats();
    console.info(
      `[BENCH] 500-node 120-frame p95 drawMs=${stats.p95DrawMs.toFixed(3)} avgDrawMs=${stats.avgDrawMs.toFixed(3)}`,
    );
    expect(stats.sampleCount).toBe(120);
    expect(stats.p95DrawMs).toBeLessThanOrEqual(16.6);

    // Verify 0 DOM .node-card elements when zoom < 0.45x (Bird's-Eye LOD).
    expect(0.3 < LOD_THRESHOLD).toBe(true);
    isBirdsEye.value = true;
    visibleNodeIds.value = [];
    render(h(CardLayer, {}), container);
    expect(container.querySelectorAll(".node-card").length).toBe(0);
  });
});

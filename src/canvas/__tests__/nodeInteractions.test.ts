// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeDto, EdgeType, NodeDto } from "../../ipc/types";
import {
  dragOffsets,
  edgesMap,
  loadSnapshot,
  nodesMap,
  unresolvedLoopholes,
} from "../../store/graphStore";
import {
  closeNodeContextMenu,
  focusId,
  modalState,
  nodeContextMenu,
  selectedIds,
  selectSingle,
  xrayState,
} from "../../store/selection";
import { CanvasCameraController } from "../camera";
import { attachCanvasPointer } from "../pointer";
import { renderCanvas2d } from "../renderer2d";

interface MockCanvas2DContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineDashOffset: number;
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

function createMockCanvasContext(): {
  ctx: CanvasRenderingContext2D;
  arcCalls: Array<{ x: number; y: number; r: number }>;
} {
  const noop = (): void => {};
  const arcCalls: Array<{ x: number; y: number; r: number }> = [];
  const mock: MockCanvas2DContext = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    font: "12px sans-serif",
    lineWidth: 1,
    lineCap: "butt",
    lineDashOffset: 0,
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
    arc: (x, y, r) => {
      arcCalls.push({ x, y, r });
    },
    clip: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    fillText: noop,
  };
  return {
    ctx: mock as unknown as CanvasRenderingContext2D,
    arcCalls,
  };
}

function makeNode(id: string, createdBy: "user" | "ai", x: number, y: number): NodeDto {
  return {
    id,
    type: createdBy === "user" ? "core" : "probe",
    status: "active",
    title: createdBy === "user" ? "User Node" : "AI Node",
    content: "Body text",
    summary: "",
    content_hash: `${id}_hash`,
    summary_hash: "",
    metadata: {
      severity: null,
      lens: createdBy === "user" ? "manual" : "feynman",
      created_by: createdBy,
      model: createdBy === "ai" ? "gpt-test" : null,
      token_count: 10,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: { x, y, width: 320, height: 180, collapsed: false },
    created_at: 1000,
    updated_at: 1000,
  };
}

function makeEdge(id: string, sourceId: string, targetId: string, type: EdgeType): EdgeDto {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    type,
    weight: "summary",
    created_at: 1000,
  };
}

describe("Node double-click center-zoom, right-click context menu & animated edges", () => {
  let shellEl: HTMLDivElement;
  let canvasEl: HTMLCanvasElement;
  let camera: CanvasCameraController;
  let detachPointer: () => void;

  beforeEach(() => {
    modalState.value = "navigate";
    closeNodeContextMenu();
    selectSingle(null);

    shellEl = document.createElement("div");
    canvasEl = document.createElement("canvas");
    shellEl.appendChild(canvasEl);
    document.body.appendChild(shellEl);

    const userNode = makeNode("node_user", "user", 100, 100);
    const aiNode = makeNode("node_ai", "ai", 600, 100);
    loadSnapshot({
      path: "memory://interactions",
      nodes: [userNode, aiNode],
      edges: [makeEdge("edge_1", "node_user", "node_ai", "derives")],
      camera: { x: 0, y: 0, zoom: 0.8, last_focus_id: "node_user" },
      token_budget: 6000,
    });

    camera = new CanvasCameraController({
      canvas: canvasEl,
      cardLayerEl: null,
      renderFrame: () => {},
      onViewportCull: () => {},
      initialCamera: { x: 0, y: 0, zoom: 0.8, last_focus_id: "node_user" },
    });
    camera.setSize(1280, 800);

    detachPointer = attachCanvasPointer(shellEl, camera, {
      marqueeWorld: null,
      edgePreviewWorld: null,
    });
  });

  afterEach(() => {
    detachPointer();
    camera.dispose();
    closeNodeContextMenu();
    modalState.value = "navigate";
    shellEl.remove();
    vi.restoreAllMocks();
  });

  it("double-clicking user node zooms in & enters edit mode, while AI node zooms in without editing", () => {
    const animateSpy = vi.spyOn(camera, "animateTo");

    const userCard = document.createElement("article");
    userCard.dataset.nodeId = "node_user";
    shellEl.appendChild(userCard);

    const aiCard = document.createElement("article");
    aiCard.dataset.nodeId = "node_ai";
    shellEl.appendChild(aiCard);

    userCard.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(animateSpy).toHaveBeenCalledTimes(1);
    const userTargetCam = animateSpy.mock.calls[0]?.[0];
    expect(userTargetCam?.zoom).toBeGreaterThanOrEqual(1.15);
    expect(focusId.value).toBe("node_user");
    expect(modalState.value).toBe("edit");

    modalState.value = "navigate";
    aiCard.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(animateSpy).toHaveBeenCalledTimes(2);
    const aiTargetCam = animateSpy.mock.calls[1]?.[0];
    expect(aiTargetCam?.zoom).toBeGreaterThanOrEqual(1.15);
    expect(focusId.value).toBe("node_ai");
    expect(modalState.value).toBe("navigate");
  });

  it("right-clicking a node card opens nodeContextMenu at cursor coordinates and prevents default", () => {
    const aiCard = document.createElement("article");
    aiCard.dataset.nodeId = "node_ai";
    shellEl.appendChild(aiCard);

    const evt = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 245,
      clientY: 190,
    });
    aiCard.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
    expect(nodeContextMenu.value).toEqual({
      nodeId: "node_ai",
      x: 245,
      y: 190,
    });
    expect(focusId.value).toBe("node_ai");
  });

  it("renders animated directional edges and traveling orb across all edge types without throwing", () => {
    const n1 = makeNode("n1", "user", 0, 0);
    const n2 = makeNode("n2", "ai", 420, -180);
    const n3 = makeNode("n3", "ai", 420, 40);
    const n4 = makeNode("n4", "ai", 420, 260);
    const edgeTypes: EdgeType[] = [
      "derives",
      "branches",
      "challenges",
      "resolves",
      "synthesizes",
      "references",
    ];
    const edges: EdgeDto[] = edgeTypes.map((type, idx) =>
      makeEdge(`e_${type}`, "n1", idx % 3 === 0 ? "n2" : idx % 3 === 1 ? "n3" : "n4", type),
    );

    loadSnapshot({
      path: "memory://anim-edges",
      nodes: [n1, n2, n3, n4],
      edges,
      camera: { x: 200, y: 300, zoom: 1.0, last_focus_id: "n1" },
      token_budget: 6000,
    });

    const { ctx, arcCalls } = createMockCanvasContext();
    expect(() =>
      renderCanvas2d(ctx, {
        cam: { x: 200, y: 300, zoom: 1.0, last_focus_id: "n1" },
        width: 1280,
        height: 800,
        nodes: nodesMap,
        edges: edgesMap,
        dragOffsets,
        selectedIds: selectedIds.value,
        focusId: "n1",
        hoveredId: null,
        xrayState: xrayState.value,
        unresolvedLoopholes: unresolvedLoopholes.value,
        marqueeWorld: null,
        edgePreviewWorld: null,
        themeKey: "dark",
        animTimeMs: 420,
        animateEdges: true,
      }),
    ).not.toThrow();

    // Directional orb (r = 3.2) drawn on emphasized incident edges of n1.
    expect(arcCalls.some((c) => Math.abs(c.r - 3.2) < 0.01)).toBe(true);
  });
});

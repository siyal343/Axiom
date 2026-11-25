// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeDto, EdgeType, NodeDto } from "../../ipc/types";
import {
  dragOffsets,
  edgesMap,
  isBirdsEye,
  loadSnapshot,
  nodesMap,
  resizeSizes,
  unresolvedLoopholes,
} from "../../store/graphStore";
import {
  closeNodeContextMenu,
  connectSourceId,
  edgePopover,
  focusId,
  modalState,
  nodeContextMenu,
  selectedEdgeId,
  selectedIds,
  selectEdge,
  selectSingle,
  xrayState,
} from "../../store/selection";
import { CanvasCameraController } from "../camera";
import { attachCanvasPointer, type PointerOverlayState } from "../pointer";
import { getEdgeMidpointWorld, hitTestEdge, renderCanvas2d } from "../renderer2d";

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

function createMockCanvasContext(): {
  ctx: CanvasRenderingContext2D;
  strokeRectCalls: Array<{ x: number; y: number; w: number; h: number }>;
  fillTextCalls: string[];
} {
  const noop = (): void => {};
  const strokeRectCalls: Array<{ x: number; y: number; w: number; h: number }> = [];
  const fillTextCalls: string[] = [];
  const mock = {
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
    arc: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: (x: number, y: number, w: number, h: number) => {
      strokeRectCalls.push({ x, y, w, h });
    },
    fillText: (text: string) => {
      fillTextCalls.push(text);
    },
  };
  return {
    ctx: mock as unknown as CanvasRenderingContext2D,
    strokeRectCalls,
    fillTextCalls,
  };
}

describe("Edge hit-testing, selection, Bird's-Eye LOD parity & connect_edge click completion", () => {
  let shellEl: HTMLDivElement;
  let canvasEl: HTMLCanvasElement;
  let camera: CanvasCameraController;
  let overlay: PointerOverlayState;
  let detachPointer: () => void;

  beforeEach(() => {
    modalState.value = "navigate";
    connectSourceId.value = null;
    edgePopover.value = null;
    closeNodeContextMenu();
    selectSingle(null);
    selectEdge(null);
    isBirdsEye.value = false;

    shellEl = document.createElement("div");
    canvasEl = document.createElement("canvas");
    canvasEl.className = "canvas-layer";
    shellEl.appendChild(canvasEl);
    document.body.appendChild(shellEl);

    const n1 = makeNode("node_a", "user", 100, 100);
    const n2 = makeNode("node_b", "ai", 620, 100);
    loadSnapshot({
      path: "memory://edge-and-birdseye",
      nodes: [n1, n2],
      edges: [makeEdge("edge_ab", "node_a", "node_b", "derives")],
      camera: { x: 0, y: 0, zoom: 1.0, last_focus_id: "node_a" },
      token_budget: 6000,
    });

    camera = new CanvasCameraController({
      canvas: canvasEl,
      cardLayerEl: null,
      renderFrame: () => {},
      onViewportCull: () => {},
      initialCamera: { x: 0, y: 0, zoom: 1.0, last_focus_id: "node_a" },
    });
    camera.setSize(1280, 800);

    overlay = {
      marqueeWorld: null,
      edgePreviewWorld: null,
      hoveredEdgeId: null,
    };
    detachPointer = attachCanvasPointer(shellEl, camera, overlay);
  });

  afterEach(() => {
    detachPointer();
    camera.dispose();
    connectSourceId.value = null;
    edgePopover.value = null;
    closeNodeContextMenu();
    selectEdge(null);
    modalState.value = "navigate";
    isBirdsEye.value = false;
    shellEl.remove();
    vi.restoreAllMocks();
  });

  it("hitTestEdge hits near the Bezier midpoint and returns null when far away", () => {
    const edge = edgesMap.get("edge_ab");
    expect(edge).toBeDefined();
    if (!edge) return;

    const mid = getEdgeMidpointWorld(edge, nodesMap, dragOffsets, resizeSizes);
    expect(mid).not.toBeNull();
    if (!mid) return;

    // Straight horizontal edge between (420, 190) and (620, 190) -> midpoint (520, 190)
    expect(mid.x).toBeCloseTo(520, 1);
    expect(mid.y).toBeCloseTo(190, 1);

    expect(hitTestEdge(mid.x, mid.y, nodesMap, edgesMap, dragOffsets, resizeSizes, 1.0)).toBe(
      "edge_ab",
    );
    expect(
      hitTestEdge(mid.x, mid.y + 8, nodesMap, edgesMap, dragOffsets, resizeSizes, 1.0),
    ).toBe("edge_ab");
    expect(
      hitTestEdge(mid.x, mid.y + 40, nodesMap, edgesMap, dragOffsets, resizeSizes, 1.0),
    ).toBeNull();

    // Zoomed out to 0.25 -> threshold = max(8, 10 / 0.25) = 40px
    expect(
      hitTestEdge(mid.x, mid.y + 32, nodesMap, edgesMap, dragOffsets, resizeSizes, 0.25),
    ).toBe("edge_ab");
  });

  it("clicking an edge selects it and clicking empty canvas clears selectedEdgeId", () => {
    const edge = edgesMap.get("edge_ab");
    expect(edge).toBeDefined();
    if (!edge) return;
    const mid = getEdgeMidpointWorld(edge, nodesMap, dragOffsets, resizeSizes);
    expect(mid).not.toBeNull();
    if (!mid) return;

    // Click edge midpoint at zoom=1.0, cam=(0,0)
    canvasEl.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: mid.x,
        clientY: mid.y,
      }),
    );
    expect(selectedEdgeId.value).toBe("edge_ab");
    expect(selectedIds.value.size).toBe(0);
    expect(focusId.value).toBeNull();

    // Click empty canvas far from nodes and edge
    canvasEl.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 15,
        clientY: 15,
      }),
    );
    expect(selectedEdgeId.value).toBeNull();
  });

  it("renders selected edge midpoint badge and connectSourceId ring in normal & Bird's-Eye LOD", () => {
    const { ctx, fillTextCalls } = createMockCanvasContext();
    renderCanvas2d(ctx, {
      cam: { x: 0, y: 0, zoom: 1.0, last_focus_id: "node_a" },
      width: 1280,
      height: 800,
      nodes: nodesMap,
      edges: edgesMap,
      dragOffsets,
      resizeSizes,
      selectedIds: selectedIds.value,
      focusId: focusId.value,
      selectedEdgeId: "edge_ab",
      connectSourceId: "node_a",
      xrayState: xrayState.value,
      unresolvedLoopholes: unresolvedLoopholes.value,
      marqueeWorld: null,
      edgePreviewWorld: null,
      themeKey: "dark",
    });

    expect(fillTextCalls).toContain("derives · summary");
  });

  it("supports Bird's-Eye LOD (zoom = 0.30) pointerdown, dblclick, and contextmenu via spatial index", () => {
    camera.setCamera({ x: 0, y: 0, zoom: 0.3, last_focus_id: null });
    expect(isBirdsEye.value).toBe(true);

    const animateSpy = vi.spyOn(camera, "animateTo");
    selectSingle(null);

    // node_a occupies world (100..420, 100..280); at zoom=0.30, center (260, 190) -> screen (78, 57)
    canvasEl.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 78,
        clientY: 57,
      }),
    );
    expect(focusId.value).toBe("node_a");
    expect(selectedIds.value.has("node_a")).toBe(true);

    // contextmenu at node_b center (780, 190) -> screen (234, 57)
    const ctxEvt = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 234,
      clientY: 57,
    });
    canvasEl.dispatchEvent(ctxEvt);
    expect(ctxEvt.defaultPrevented).toBe(true);
    expect(nodeContextMenu.value).toEqual({
      nodeId: "node_b",
      x: 234,
      y: 57,
    });

    // dblclick on node_a at zoom=0.30 zooms in and enters edit mode for user node
    canvasEl.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        cancelable: true,
        clientX: 78,
        clientY: 57,
      }),
    );
    expect(animateSpy).toHaveBeenCalledTimes(1);
    expect(animateSpy.mock.calls[0]?.[0]?.zoom).toBeGreaterThanOrEqual(1.15);
    expect(focusId.value).toBe("node_a");
    expect(modalState.value).toBe("edit");
  });

  it("completes connect_edge mode on clicking a different target node without dragging", () => {
    const cardB = document.createElement("article");
    cardB.dataset.nodeId = "node_b";
    shellEl.appendChild(cardB);

    modalState.value = "connect_edge";
    connectSourceId.value = "node_a";

    cardB.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 700,
        clientY: 160,
      }),
    );

    expect(connectSourceId.value).toBeNull();
    expect(edgePopover.value).toEqual({
      sourceId: "node_a",
      targetId: "node_b",
      x: 700,
      y: 160,
    });
  });

  it("supports port-drag >= 6px to open edgePopover and suppresses trailing click", () => {
    const cardA = document.createElement("article");
    cardA.dataset.nodeId = "node_a";
    const portBtn = document.createElement("button");
    portBtn.className = "node-port node-port--right";
    portBtn.dataset.portDir = "right";
    portBtn.dataset.portNodeId = "node_a";
    const clickSpy = vi.fn();
    portBtn.addEventListener("click", clickSpy);
    cardA.appendChild(portBtn);
    shellEl.appendChild(cardA);

    // 1. Short click (< 6px): click listener fires normally
    portBtn.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 420,
        clientY: 190,
      }),
    );
    shellEl.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 422,
        clientY: 191,
      }),
    );
    portBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(edgePopover.value).toBeNull();

    // 2. Drag >= 6px onto node_b (620..940, 100..280): opens edgePopover and suppresses trailing click
    portBtn.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 420,
        clientY: 190,
      }),
    );
    shellEl.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: 450,
        clientY: 190,
      }),
    );
    expect(overlay.edgePreviewWorld).toEqual({
      sourceId: "node_a",
      sourceDir: "right",
      targetX: 450,
      targetY: 190,
    });

    shellEl.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 700,
        clientY: 180,
      }),
    );
    portBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(overlay.edgePreviewWorld).toBeNull();
    expect(edgePopover.value).toEqual({
      sourceId: "node_a",
      targetId: "node_b",
      x: 700,
      y: 180,
    });
  });
});

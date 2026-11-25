// @vitest-environment jsdom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCanvas2d } from "../../canvas/renderer2d";
import { NodeCard } from "../../cards/NodeCard";
import { collectSpotlightIds, computeAlignmentMoves } from "../../input/topologyNav";
import type {
  CheckpointDiff,
  CheckpointSummary,
  EdgeDto,
  ExternalRefInfo,
  NodeDto,
  WorkspaceSnapshot,
} from "../../ipc/types";
import {
  cameraControllerRef,
  edgesMap,
  loadSnapshot,
  nodesMap,
  unresolvedLoopholes,
} from "../../store/graphStore";
import { canUndoSignal, graphHistory, syncHistorySignals } from "../../store/history";
import {
  checkpointsModalOpen,
  clearSelection,
  clearSpotlight,
  closeCheckpointsModal,
  externalRefsMap,
  focusId,
  modalState,
  openCheckpointsModal,
  spotlightRootId,
  staleNodesMap,
  xrayState,
} from "../../store/selection";
import { CheckpointsModal } from "../CheckpointsModal";
import { toastsSignal } from "../ToastStack";

function makeNode(
  id: string,
  opts: Partial<{
    type: NodeDto["type"];
    status: NodeDto["status"];
    title: string;
    x: number;
    y: number;
    width: number;
    height: number;
    collapsed: boolean;
  }> = {},
): NodeDto {
  const title = opts.title ?? id;
  return {
    id,
    type: opts.type ?? "core",
    status: opts.status ?? "active",
    title,
    content: `Body for ${title}`,
    summary: "",
    content_hash: `hash_${id}`,
    summary_hash: "",
    metadata: {
      severity: opts.type === "loophole" ? "high" : null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: 10,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: {
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      width: opts.width ?? 320,
      height: opts.height ?? 180,
      collapsed: opts.collapsed ?? false,
    },
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };
}

function makeEdge(
  id: string,
  source_id: string,
  target_id: string,
  type: EdgeDto["type"],
): EdgeDto {
  return {
    id,
    source_id,
    target_id,
    type,
    weight: "summary",
    created_at: 1_700_000_000_000,
  };
}

async function flushUi(ms = 40): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
  await Promise.resolve();
}

describe("v0.5 Spotlight Lineage, Alignment Moves, External Ref Badges & CheckpointsModal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    nodesMap.clear();
    edgesMap.clear();
    externalRefsMap.value = new Map();
    staleNodesMap.value = new Map();
    xrayState.value = null;
    clearSpotlight();
    closeCheckpointsModal();
    clearSelection();
    modalState.value = "navigate";
    toastsSignal.value = [];
    cameraControllerRef.current = null;
    graphHistory.clear();
    syncHistorySignals();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    render(null, container);
    container.remove();
    nodesMap.clear();
    edgesMap.clear();
    externalRefsMap.value = new Map();
    staleNodesMap.value = new Map();
    xrayState.value = null;
    clearSpotlight();
    closeCheckpointsModal();
    clearSelection();
    toastsSignal.value = [];
    cameraControllerRef.current = null;
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("collectSpotlightIds gathers spine ancestors, descendants, 1-hop challenges/resolves/references, and handles cycles", () => {
    const nodes = new Map<string, NodeDto>([
      ["anc", makeNode("anc")],
      ["root", makeNode("root")],
      ["child", makeNode("child")],
      ["lh", makeNode("lh", { type: "loophole" })],
      ["res", makeNode("res")],
      ["ref_1hop", makeNode("ref_1hop")],
      ["ref_2hop", makeNode("ref_2hop")],
      ["unrelated", makeNode("unrelated")],
    ]);
    const edges = new Map<string, EdgeDto>([
      ["e1", makeEdge("e1", "anc", "root", "derives")],
      ["e2", makeEdge("e2", "root", "child", "branches")],
      ["e_cycle", makeEdge("e_cycle", "child", "anc", "synthesizes")],
      ["e_ch", makeEdge("e_ch", "lh", "child", "challenges")],
      ["e_res", makeEdge("e_res", "res", "anc", "resolves")],
      ["e_ref1", makeEdge("e_ref1", "root", "ref_1hop", "references")],
      ["e_ref2", makeEdge("e_ref2", "ref_1hop", "ref_2hop", "references")],
    ]);

    expect(collectSpotlightIds(null, nodes, edges).size).toBe(0);
    expect(collectSpotlightIds("missing", nodes, edges).size).toBe(0);

    const spotlight = collectSpotlightIds("root", nodes, edges);
    expect(spotlight).toEqual(new Set(["anc", "root", "child", "lh", "res", "ref_1hop"]));
    expect(spotlight.has("ref_2hop")).toBe(false);
    expect(spotlight.has("unrelated")).toBe(false);
  });

  it("computeAlignmentMoves computes left, top, distribute_h, and distribute_v moves accurately", () => {
    const n1 = makeNode("n1", { x: 100, y: 200, width: 100, height: 80 });
    const n2 = makeNode("n2", { x: 140, y: 260, width: 100, height: 100, collapsed: true }); // effective height = 44
    const n3 = makeNode("n3", { x: 500, y: 500, width: 100, height: 80 });
    const nodes = new Map<string, NodeDto>([
      [n1.id, n1],
      [n2.id, n2],
      [n3.id, n3],
    ]);

    const leftMoves = computeAlignmentMoves(["n1", "n2", "n3"], nodes, "left");
    expect(leftMoves.prev).toEqual([
      { id: "n2", x: 140, y: 260 },
      { id: "n3", x: 500, y: 500 },
    ]);
    expect(leftMoves.next).toEqual([
      { id: "n2", x: 100, y: 260 },
      { id: "n3", x: 100, y: 500 },
    ]);

    const topMoves = computeAlignmentMoves(["n1", "n2", "n3"], nodes, "top");
    expect(topMoves.prev).toEqual([
      { id: "n2", x: 140, y: 260 },
      { id: "n3", x: 500, y: 500 },
    ]);
    expect(topMoves.next).toEqual([
      { id: "n2", x: 140, y: 200 },
      { id: "n3", x: 500, y: 200 },
    ]);

    // distribute_h: totalSpan = (500 + 100) - 100 = 500; widths = 300; gap = 200 / 2 = 100
    // n1 stays 100, n2 moves to 100 + 100 + 100 = 300, n3 stays 500
    expect(computeAlignmentMoves(["n1", "n2"], nodes, "distribute_h").next).toEqual([]);
    const distH = computeAlignmentMoves(["n3", "n1", "n2"], nodes, "distribute_h");
    expect(distH.prev).toEqual([{ id: "n2", x: 140, y: 260 }]);
    expect(distH.next).toEqual([{ id: "n2", x: 300, y: 260 }]);

    // distribute_v: n1(y=200, h=80), n2(y=260, effective h=44), n3(y=500, h=80)
    // totalGapSpace = (500 - 200) - (80 + 44) = 176 -> gap = 88
    // n2 moves to 200 + 80 + 88 = 368
    const distV = computeAlignmentMoves(["n1", "n2", "n3"], nodes, "distribute_v");
    expect(distV.prev).toEqual([{ id: "n2", x: 140, y: 260 }]);
    expect(distV.next).toEqual([{ id: "n2", x: 140, y: 368 }]);

    // Overlap fallback: widths exceed span -> equal left-edge spacing (100 -> 200 -> 300)
    const tightNodes = new Map<string, NodeDto>([
      ["a", makeNode("a", { x: 100, y: 0, width: 320 })],
      ["b", makeNode("b", { x: 120, y: 0, width: 320 })],
      ["c", makeNode("c", { x: 300, y: 0, width: 320 })],
    ]);
    const tightDistH = computeAlignmentMoves(["a", "b", "c"], tightNodes, "distribute_h");
    expect(tightDistH.next).toEqual([{ id: "b", x: 200, y: 0 }]);
  });

  it("renders OUT OF SYNC badge, toggles .extref-popover events, applies .node-card--spotlight-dim, and draws renderer2d spotlight/cyan dot", async () => {
    const nRoot = makeNode("n_root", { title: "Gateway" });
    const nChild = makeNode("n_child", { title: "Token Cache", x: 400 });
    const nOther = makeNode("n_other", { title: "Unrelated Note", x: 900 });

    loadSnapshot({
      path: "",
      nodes: [nRoot, nChild, nOther],
      edges: [makeEdge("e1", "n_root", "n_child", "derives")],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_root" },
      token_budget: 6000,
    });

    const extRef: ExternalRefInfo = {
      local_node_id: "n_child",
      source_workspace_id: "ws_1",
      source_flow_id: "flow_auth",
      source_flow_name: "Auth Architecture",
      source_node_id: "src_token",
      synced_hash: "abc",
      synced_at: 1_700_000_000_000,
      status: "out_of_sync",
      source_title: "JWT Rotation Spec",
    };
    externalRefsMap.value = new Map([["n_child", extRef]]);
    spotlightRootId.value = "n_root";

    render(
      <>
        <NodeCard node={nChild} />
        <NodeCard node={nOther} />
      </>,
      container,
    );
    await flushUi();

    const childCard = container.querySelector<HTMLElement>('[data-node-id="n_child"]');
    const otherCard = container.querySelector<HTMLElement>('[data-node-id="n_other"]');
    expect(childCard?.classList.contains("node-card--spotlight-dim")).toBe(false);
    expect(otherCard?.classList.contains("node-card--spotlight-dim")).toBe(true);

    const badge = childCard?.querySelector<HTMLButtonElement>(".node-badge--extref-drift");
    expect(badge).not.toBeNull();
    expect(badge?.textContent?.trim()).toBe("OUT OF SYNC");
    expect(container.querySelector(".extref-popover")).toBeNull();

    badge?.click();
    await flushUi();

    const popover = container.querySelector<HTMLElement>(".extref-popover");
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain("Linked from Auth Architecture");
    expect(popover?.textContent).toContain("JWT Rotation Spec");

    const syncEvents: Array<{ nodeId: string }> = [];
    const openEvents: Array<{
      nodeId: string;
      sourceWorkspaceId: string;
      sourceFlowId: string;
      sourceNodeId: string;
    }> = [];
    const detachEvents: Array<{ nodeId: string }> = [];
    const onSync = (e: Event): void => {
      syncEvents.push((e as CustomEvent<{ nodeId: string }>).detail);
    };
    const onOpen = (e: Event): void => {
      openEvents.push(
        (
          e as CustomEvent<{
            nodeId: string;
            sourceWorkspaceId: string;
            sourceFlowId: string;
            sourceNodeId: string;
          }>
        ).detail,
      );
    };
    const onDetach = (e: Event): void => {
      detachEvents.push((e as CustomEvent<{ nodeId: string }>).detail);
    };
    window.addEventListener("axiom:sync-extref", onSync);
    window.addEventListener("axiom:open-extref", onOpen);
    window.addEventListener("axiom:detach-extref", onDetach);

    try {
      const findBtn = (label: string): HTMLButtonElement | undefined =>
        Array.from(container.querySelectorAll<HTMLButtonElement>(".extref-popover button")).find(
          (b) => b.textContent?.trim() === label,
        );

      findBtn("Pull Latest")?.click();
      await flushUi();
      expect(syncEvents).toEqual([{ nodeId: "n_child" }]);
      expect(container.querySelector(".extref-popover")).toBeNull();

      badge?.click();
      await flushUi();
      findBtn("Open Source")?.click();
      await flushUi();
      expect(openEvents).toEqual([
        {
          nodeId: "n_child",
          sourceWorkspaceId: "ws_1",
          sourceFlowId: "flow_auth",
          sourceNodeId: "src_token",
        },
      ]);

      badge?.click();
      await flushUi();
      findBtn("Detach")?.click();
      await flushUi();
      expect(detachEvents).toEqual([{ nodeId: "n_child" }]);
    } finally {
      window.removeEventListener("axiom:sync-extref", onSync);
      window.removeEventListener("axiom:open-extref", onOpen);
      window.removeEventListener("axiom:detach-extref", onDetach);
    }

    // Verify Bird's-Eye renderer2d spotlight dimming (alpha 0.22) and #06b6d4 cyan indicator dot
    const fillStyles: string[] = [];
    const alphas: number[] = [];
    const mockCtx = {
      fillStyle: "#000",
      strokeStyle: "#000",
      font: "12px sans-serif",
      lineWidth: 1,
      globalAlpha: 1,
      shadowColor: "transparent",
      shadowBlur: 0,
      textBaseline: "top",
      lineCap: "round",
      save: () => {},
      restore: () => {},
      scale: () => {},
      translate: () => {},
      setTransform: () => {},
      setLineDash: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      bezierCurveTo: () => {},
      arc: () => {},
      clip: () => {},
      fill: () => {
        fillStyles.push(String(mockCtx.fillStyle));
        alphas.push(mockCtx.globalAlpha);
      },
      stroke: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      fillText: () => {},
    } as unknown as CanvasRenderingContext2D;

    renderCanvas2d(mockCtx, {
      cam: { x: 0, y: 0, zoom: 0.3, last_focus_id: "n_root" },
      width: 1280,
      height: 800,
      nodes: nodesMap,
      edges: edgesMap,
      dragOffsets: new Map(),
      selectedIds: new Set(),
      focusId: "n_root",
      xrayState: null,
      unresolvedLoopholes: unresolvedLoopholes.value,
      spotlightIds: new Set(["n_root", "n_child"]),
      outOfSyncRefIds: new Set(["n_child"]),
      marqueeWorld: null,
      edgePreviewWorld: null,
      themeKey: "dark",
    });

    expect(fillStyles).toContain("#06b6d4");
    expect(alphas).toContain(0.22);
  });

  it("CheckpointsModal supports browser preview banner and mocked Tauri create, list, diff, jump, restore, and delete", async () => {
    const n1 = makeNode("n1", { title: "Gateway", x: 100, y: 120 });
    const n2 = makeNode("n2", { title: "Rate Limiter", x: 480, y: 160 });
    loadSnapshot({
      path: "flow.sqlite",
      nodes: [n1, n2],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n1" },
      token_budget: 6000,
    });

    // 1. Browser preview mode
    render(<CheckpointsModal />, container);
    openCheckpointsModal();
    await flushUi();
    expect(container.textContent).toContain("Browser preview mode");
    closeCheckpointsModal();
    await flushUi();

    // 2. Mocked Tauri runtime
    const animateTo = vi.fn();
    cameraControllerRef.current = {
      setCardLayerEl: () => {},
      markDirty: () => {},
      refreshCull: () => {},
      setCamera: () => {},
      getCamera: () => ({ x: 0, y: 0, zoom: 1, last_focus_id: "n1" }),
      getViewportSize: () => ({ width: 1200, height: 800 }),
      animateTo,
    };

    const existingCp: CheckpointSummary = {
      id: "cp_1",
      name: "Initial Baseline",
      note: "Before sharding",
      node_count: 2,
      edge_count: 1,
      created_at: 1_700_000_000_000,
    };
    const createdCp: CheckpointSummary = {
      id: "cp_2",
      name: "Post Sharding",
      note: "Added rate limiter",
      node_count: 2,
      edge_count: 0,
      created_at: 1_700_000_100_000,
    };
    const diffPayload: CheckpointDiff = {
      checkpoint_id: "cp_1",
      checkpoint_name: "Initial Baseline",
      added_nodes: [{ node_id: "n2", title: "Rate Limiter", type: "branch", changes: [] }],
      removed_nodes: [{ node_id: "n_old", title: "Legacy Proxy", type: "core", changes: [] }],
      modified_nodes: [
        { node_id: "n1", title: "Gateway", type: "core", changes: ["title", "content"] },
      ],
      added_edges_count: 2,
      removed_edges_count: 1,
    };
    const restoredSnapshot: WorkspaceSnapshot = {
      path: "flow.sqlite",
      nodes: [n1],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n1" },
      token_budget: 6000,
    };

    const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "list_checkpoints":
          return [existingCp];
        case "create_checkpoint":
          expect(args).toEqual({ name: "Post Sharding", note: "Added rate limiter" });
          return createdCp;
        case "diff_checkpoint":
          expect(args).toEqual({ checkpointId: "cp_1" });
          return diffPayload;
        case "restore_checkpoint":
          expect(args).toEqual({ checkpointId: "cp_1" });
          return restoredSnapshot;
        case "delete_checkpoint":
          return null;
        case "get_stale_nodes":
          return [];
        case "get_external_ref_statuses":
          return [];
        default:
          throw new Error(`Unexpected IPC command: ${cmd}`);
      }
    });

    (
      window as {
        __TAURI_INTERNALS__?: {
          invoke: typeof invokeMock;
          transformCallback: () => number;
        };
      }
    ).__TAURI_INTERNALS__ = {
      invoke: invokeMock,
      transformCallback: vi.fn(() => 1),
    };

    openCheckpointsModal();
    await flushUi();

    expect(container.textContent).toContain("Initial Baseline");
    expect(container.textContent).toContain("2 nodes · 1 edges");

    // Create new checkpoint
    const nameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder*="Milestone name"]',
    );
    const noteInput = container.querySelector<HTMLInputElement>('input[placeholder="Optional note"]');
    expect(nameInput).not.toBeNull();
    expect(noteInput).not.toBeNull();
    if (nameInput && noteInput) {
      nameInput.value = "Post Sharding";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      noteInput.value = "Added rate limiter";
      noteInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await flushUi();

    const saveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Save Checkpoint",
    );
    saveBtn?.click();
    await flushUi();
    expect(container.textContent).toContain("Post Sharding");

    // Diff cp_1
    const diffButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
      (b) => b.textContent?.trim() === "Diff",
    );
    expect(diffButtons.length).toBe(2);
    diffButtons[1]?.click();
    await flushUi();

    expect(container.textContent).toContain("+1 added");
    expect(container.textContent).toContain("-1 removed");
    expect(container.textContent).toContain("~1 modified");
    expect(container.textContent).toContain("Edges +2 / -1");
    expect(container.textContent).toContain("title");
    expect(container.textContent).toContain("content");

    // Jump to added node n2
    const jumpBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Jump",
    );
    jumpBtn?.click();
    await flushUi();

    expect(focusId.value).toBe("n2");
    expect(animateTo).toHaveBeenCalledTimes(1);
    expect(checkpointsModalOpen.value).toBe(false);

    // Reopen, push fake undo history, then Restore cp_1
    openCheckpointsModal();
    await flushUi();
    graphHistory.push({
      label: "Temp move",
      forward: [{ op: "move_nodes", moves: [{ id: "n1", x: 200, y: 200 }] }],
      inverse: [{ op: "move_nodes", moves: [{ id: "n1", x: 100, y: 120 }] }],
    });
    syncHistorySignals();
    expect(canUndoSignal.value).toBe(true);

    const restoreBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Restore",
    );
    restoreBtn?.click();
    await flushUi();

    expect(nodesMap.size).toBe(1);
    expect(nodesMap.has("n2")).toBe(false);
    expect(graphHistory.size()).toBe(0);
    expect(canUndoSignal.value).toBe(false);
    expect(checkpointsModalOpen.value).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("get_stale_nodes", {}, undefined);
    expect(invokeMock).toHaveBeenCalledWith("get_external_ref_statuses", {}, undefined);
    expect(toastsSignal.value.some((t) => t.message.includes('Restored checkpoint "Initial Baseline"'))).toBe(
      true,
    );
  });
});

// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApplyResult,
  EdgeDto,
  EdgeType,
  LensKind,
  NodeDto,
  NodeLensOrigin,
  NodeType,
  RelatedNodeHit,
  StaleNodeInfo,
} from "../../ipc/types";
import { RelatedNodesPopover } from "../../overlays/RelatedNodesPopover";
import {
  computeSpineBreadcrumb,
  SpineBreadcrumb,
} from "../../overlays/SpineBreadcrumb";
import { toastsSignal } from "../../overlays/ToastStack";
import {
  cameraControllerRef,
  edgesMap,
  graphVersion,
  loadSnapshot,
  nodesMap,
} from "../../store/graphStore";
import {
  clearSelection,
  modalState,
  relatedPopoverNodeId,
  selectSingle,
  staleNodesMap,
} from "../../store/selection";
import { sidebarOpen } from "../../store/workspaceCatalogStore";
import { resolveNodeTone } from "../nodeAccent";
import { NodeCard } from "../NodeCard";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel {},
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

function makeNode(overrides: {
  id: string;
  title?: string;
  content?: string;
  type?: NodeType;
  lens?: NodeLensOrigin;
  createdBy?: "user" | "ai";
  createdAt?: number;
  x?: number;
  y?: number;
}): NodeDto {
  const ts = overrides.createdAt ?? 1_700_000_000_000;
  const title = overrides.title ?? `Node ${overrides.id}`;
  const content = overrides.content ?? "";
  return {
    id: overrides.id,
    type: overrides.type ?? "core",
    status: "active",
    title,
    content,
    summary: "",
    content_hash: `hash_${overrides.id}_${title.length}_${content.length}`,
    summary_hash: "",
    metadata: {
      severity: overrides.type === "loophole" ? "medium" : null,
      lens: overrides.lens ?? "manual",
      created_by: overrides.createdBy ?? "user",
      model: overrides.createdBy === "ai" ? "gpt-test" : null,
      token_count: 10,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: {
      x: overrides.x ?? 0,
      y: overrides.y ?? 0,
      width: 320,
      height: 180,
      collapsed: false,
    },
    created_at: ts,
    updated_at: ts,
  };
}

function makeEdge(
  id: string,
  sourceId: string,
  targetId: string,
  type: EdgeType = "derives",
  createdAt = 1_700_000_000_000,
): EdgeDto {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    type,
    weight: "full",
    created_at: createdAt,
  };
}

async function flushDom(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 20));
    } else {
      setTimeout(resolve, 40);
    }
  });
}

describe("v0.3 NodeCard stale badges, research/study tones, SpineBreadcrumb & RelatedNodesPopover", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    nodesMap.clear();
    edgesMap.clear();
    staleNodesMap.value = new Map();
    relatedPopoverNodeId.value = null;
    sidebarOpen.value = false;
    modalState.value = "navigate";
    toastsSignal.value = [];
    cameraControllerRef.current = null;
    clearSelection();
    vi.mocked(invoke).mockReset();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    render(null, container);
    container.remove();
    staleNodesMap.value = new Map();
    relatedPopoverNodeId.value = null;
    sidebarOpen.value = false;
    modalState.value = "navigate";
    toastsSignal.value = [];
    cameraControllerRef.current = null;
    clearSelection();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("maps native metadata.lens 'research' and 'study' directly before @tag text fallback", () => {
    const researchNode = makeNode({
      id: "res_1",
      lens: "research",
      createdBy: "ai",
      content: "@feynman this tag should not override native research lens",
    });
    const studyNode = makeNode({
      id: "stu_1",
      lens: "study",
      createdBy: "ai",
      content: "@redteam this tag should not override native study lens",
    });

    const researchTone = resolveNodeTone(researchNode);
    const studyTone = resolveNodeTone(studyNode);

    expect(researchTone.key).toBe("research");
    expect(researchTone.label).toBe("@Research");
    expect(studyTone.key).toBe("study");
    expect(studyTone.label).toBe("@Study");
  });

  it("renders STALE badge on NodeCard, toggles .stale-popover, and dispatches ack/rerun events", async () => {
    const node = makeNode({
      id: "ai_node_1",
      title: "Synthesized Design",
      lens: "synthesize",
      createdBy: "ai",
    });
    loadSnapshot({
      path: "",
      nodes: [node],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: node.id },
      token_budget: 6000,
    });

    const staleInfo: StaleNodeInfo = {
      node_id: node.id,
      run_id: "run_1",
      lens: "synthesize",
      model: "gpt-test",
      created_at: 1_700_000_001_000,
      changed_inputs: [
        { node_id: "src_1", title: "Storage Layer", reason: "modified" },
        { node_id: "src_2", title: "Legacy Queue", reason: "deleted" },
      ],
    };
    staleNodesMap.value = new Map([[node.id, staleInfo]]);

    render(<NodeCard node={node} />, container);
    await flushDom();

    const cardEl = container.querySelector<HTMLElement>(".node-card");
    expect(cardEl?.classList.contains("node-card--stale")).toBe(true);

    const staleBtn = container.querySelector<HTMLButtonElement>(".node-badge--stale");
    expect(staleBtn).not.toBeNull();
    expect(staleBtn?.textContent?.trim()).toBe("STALE");
    expect(staleBtn?.getAttribute("title")).toContain("Modified: Storage Layer");
    expect(staleBtn?.getAttribute("title")).toContain("Deleted: Legacy Queue");
    expect(container.querySelector(".stale-popover")).toBeNull();

    staleBtn?.click();
    await flushDom();

    const popover = container.querySelector<HTMLElement>(".stale-popover");
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain("Modified: Storage Layer");
    expect(popover?.textContent).toContain("Deleted: Legacy Queue");

    const ackEvents: Array<{ nodeId: string }> = [];
    const rerunEvents: Array<{ nodeId: string; lens: LensKind }> = [];
    const onAck = (e: Event): void => {
      ackEvents.push((e as CustomEvent<{ nodeId: string }>).detail);
    };
    const onRerun = (e: Event): void => {
      rerunEvents.push((e as CustomEvent<{ nodeId: string; lens: LensKind }>).detail);
    };
    window.addEventListener("axiom:ack-stale", onAck);
    window.addEventListener("axiom:rerun-stale", onRerun);

    try {
      const buttons = Array.from(popover?.querySelectorAll("button") ?? []);
      const rerunBtn = buttons.find((b) => b.textContent?.trim() === "Re-run");
      const ackBtn = buttons.find((b) => b.textContent?.trim() === "Mark Fresh");
      expect(rerunBtn).toBeDefined();
      expect(ackBtn).toBeDefined();

      rerunBtn?.click();
      await flushDom();
      expect(rerunEvents).toEqual([{ nodeId: node.id, lens: "synthesize" }]);
      expect(container.querySelector(".stale-popover")).toBeNull();

      staleBtn?.click();
      await flushDom();
      const ackBtnAfterReopen = Array.from(
        container.querySelectorAll<HTMLButtonElement>(".stale-popover button"),
      ).find((b) => b.textContent?.trim() === "Mark Fresh");
      ackBtnAfterReopen?.click();
      await flushDom();

      expect(ackEvents).toEqual([{ nodeId: node.id }]);
      expect(container.querySelector(".stale-popover")).toBeNull();
    } finally {
      window.removeEventListener("axiom:ack-stale", onAck);
      window.removeEventListener("axiom:rerun-stale", onRerun);
    }
  });

  it("computes deterministic SpineBreadcrumb with cycle safety/truncation and animates camera on ancestor click", async () => {
    // Chain: n0 -> n1 -> n2 -> n3 -> n4 -> n5 -> n6 (7 nodes), with n1 also having an alternate later parent
    const nodes = new Map<string, NodeDto>();
    const edges = new Map<string, EdgeDto>();

    for (let i = 0; i <= 6; i += 1) {
      nodes.set(
        `n${i}`,
        makeNode({
          id: `n${i}`,
          title: `Step ${i}`,
          createdAt: 1000 + i * 100,
          x: i * 400,
          y: 120,
        }),
      );
    }
    // Tie-break parent for n1: alt_b (same created_at as n0, higher id) vs n0 (lower id)
    nodes.set(
      "n_alt",
      makeNode({ id: "n_alt", title: "Later Tie Parent", createdAt: 1000, x: -300, y: 0 }),
    );
    nodes.set(
      "n_late",
      makeNode({ id: "n_late", title: "Later Timestamp Parent", createdAt: 1050, x: -300, y: 200 }),
    );

    edges.set("e_alt", makeEdge("e_alt", "n_alt", "n1", "derives"));
    edges.set("e_late", makeEdge("e_late", "n_late", "n1", "branches"));
    edges.set("e0", makeEdge("e0", "n0", "n1", "derives"));
    edges.set("e1", makeEdge("e1", "n1", "n2", "branches"));
    edges.set("e2", makeEdge("e2", "n2", "n3", "synthesizes"));
    edges.set("e3", makeEdge("e3", "n3", "n4", "derives"));
    edges.set("e4", makeEdge("e4", "n4", "n5", "derives"));
    edges.set("e5", makeEdge("e5", "n5", "n6", "derives"));
    // Non-spine edge should be ignored, and cycle n6 -> n0 should not loop
    edges.set("e_ref", makeEdge("e_ref", "n_late", "n6", "references"));
    edges.set("e_cycle", makeEdge("e_cycle", "n6", "n0", "derives"));

    // Cycle safety check when walking from n0 (n6 -> n0 cycle stops without infinite loop)
    const cycleRes = computeSpineBreadcrumb("n0", nodes, edges);
    expect(cycleRes.truncated).toBe(true);
    expect(cycleRes.items.map((n) => n.id)).toEqual(["n1", "n3", "n4", "n5", "n6", "n0"]);
    expect(new Set(cycleRes.items.map((n) => n.id)).size).toBe(cycleRes.items.length);

    // Truncated chain from n6 (maxItems=6): root n0 + last 5 (n2..n6), deterministic n0 over n_alt/n_late
    const truncatedRes = computeSpineBreadcrumb("n6", nodes, edges, 6);
    expect(truncatedRes.truncated).toBe(true);
    expect(truncatedRes.items.map((n) => n.id)).toEqual(["n0", "n2", "n3", "n4", "n5", "n6"]);

    // Remove cycle back-edge before testing short acyclic chain from n2 (depth 3, not truncated)
    edges.delete("e_cycle");
    const shortRes = computeSpineBreadcrumb("n2", nodes, edges, 6);
    expect(shortRes.truncated).toBe(false);
    expect(shortRes.items.map((n) => n.id)).toEqual(["n0", "n1", "n2"]);

    // Render SpineBreadcrumb component
    loadSnapshot({
      path: "",
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n2" },
      token_budget: 6000,
    });
    const animateTo = vi.fn();
    cameraControllerRef.current = {
      setCardLayerEl: () => {},
      markDirty: () => {},
      refreshCull: () => {},
      setCamera: () => {},
      getCamera: () => ({ x: 0, y: 0, zoom: 1, last_focus_id: "n2" }),
      getViewportSize: () => ({ width: 1200, height: 800 }),
      animateTo,
    };
    sidebarOpen.value = true;
    selectSingle("n2");
    graphVersion.value += 1;

    render(<SpineBreadcrumb />, container);
    await flushDom();

    const nav = container.querySelector<HTMLElement>("nav.spine-breadcrumb");
    expect(nav).not.toBeNull();
    expect(nav?.classList.contains("spine-breadcrumb--shifted")).toBe(true);

    const crumbs = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".spine-breadcrumb__crumb"),
    );
    expect(crumbs.map((b) => b.textContent?.trim())).toEqual(["Step 0", "Step 1", "Step 2"]);

    // Clicking ancestor "Step 1" selects n1 and animates camera to center n1 (x:400, y:120, w:320, h:180 => cx=560, cy=210)
    crumbs[1]?.click();
    await flushDom();

    expect(animateTo).toHaveBeenCalledTimes(1);
    expect(animateTo).toHaveBeenCalledWith(
      {
        x: 1200 / 2 - 560 * 1,
        y: 800 / 2 - 210 * 1,
        zoom: 1,
      },
      220,
    );

    const updatedCrumbs = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".spine-breadcrumb__crumb"),
    );
    expect(updatedCrumbs.map((b) => b.textContent?.trim())).toEqual(["Step 0", "Step 1"]);

    // Entering edit mode hides SpineBreadcrumb
    modalState.value = "edit";
    await flushDom();
    expect(container.querySelector("nav.spine-breadcrumb")).toBeNull();

    // Returning to navigate mode on root n0 hides SpineBreadcrumb (chain length < 2)
    modalState.value = "navigate";
    selectSingle("n0");
    await flushDom();
    expect(container.querySelector("nav.spine-breadcrumb")).toBeNull();
  });

  it("renders browser fallback in RelatedNodesPopover and supports Tauri find_related_nodes + Link Ref", async () => {
    const srcNode = makeNode({ id: "src_rel", title: "Consensus", x: 100, y: 100 });
    const hitNode = makeNode({ id: "hit_1", title: "Raft Leader Election", x: 900, y: 400 });
    loadSnapshot({
      path: "",
      nodes: [srcNode, hitNode],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: srcNode.id },
      token_budget: 6000,
    });

    // 1. Non-Tauri browser preview fallback
    relatedPopoverNodeId.value = srcNode.id;
    render(<RelatedNodesPopover />, container);
    await flushDom();

    expect(container.querySelector(".related-popover")?.textContent).toContain(
      "Tauri desktop runtime",
    );
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();

    // Close via Escape
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushDom();
    expect(relatedPopoverNodeId.value).toBeNull();
    expect(container.querySelector(".related-popover")).toBeNull();

    // 2. Mocked Tauri runtime
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const mockHits: RelatedNodeHit[] = [
      {
        id: hitNode.id,
        title: "Raft Leader Election",
        type: "branch",
        status: "active",
        snippet: "Randomized election timeouts prevent split votes.",
        score: -1.42,
        x: 900,
        y: 400,
      },
      {
        id: "hit_2",
        title: "Paxos Synod",
        type: "core",
        status: "active",
        snippet: "Two-phase prepare and accept quorum.",
        score: -0.95,
        x: 1300,
        y: 200,
      },
    ];

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "find_related_nodes") {
        return mockHits;
      }
      if (cmd === "apply_ops") {
        const result: ApplyResult = {
          updated_nodes: [],
          deleted_node_ids: [],
          deleted_edge_ids: [],
        };
        return result;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const animateTo = vi.fn();
    cameraControllerRef.current = {
      setCardLayerEl: () => {},
      markDirty: () => {},
      refreshCull: () => {},
      setCamera: () => {},
      getCamera: () => ({ x: 0, y: 0, zoom: 1, last_focus_id: srcNode.id }),
      getViewportSize: () => ({ width: 1200, height: 800 }),
      animateTo,
    };

    relatedPopoverNodeId.value = srcNode.id;
    await flushDom();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("find_related_nodes", {
      nodeId: srcNode.id,
      limit: 8,
    });

    const items = container.querySelectorAll(".related-popover__item");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Raft Leader Election");
    expect(items[0]?.textContent).toContain("branch");
    expect(items[0]?.textContent).toContain("Randomized election timeouts");

    // Click Link Ref on first hit -> creates references edge, removes hit, pushes toast
    const firstLinkBtn = Array.from(items[0]?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent?.trim() === "Link Ref",
    );
    expect(firstLinkBtn).toBeDefined();
    firstLinkBtn?.click();
    await flushDom();

    const createdEdges = Array.from(edgesMap.values());
    expect(createdEdges).toHaveLength(1);
    expect(createdEdges[0]).toMatchObject({
      source_id: srcNode.id,
      target_id: hitNode.id,
      type: "references",
      weight: "summary",
    });
    expect(container.querySelectorAll(".related-popover__item")).toHaveLength(1);
    expect(toastsSignal.value.some((t) => t.message.includes("Raft Leader Election"))).toBe(true);

    // Click Jump on remaining hit -> animates camera and closes popover
    const remainingJumpBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".related-popover__item button"),
    ).find((b) => b.textContent?.trim() === "Jump");
    remainingJumpBtn?.click();
    await flushDom();

    expect(animateTo).toHaveBeenCalledTimes(1);
    expect(relatedPopoverNodeId.value).toBeNull();
  });
});

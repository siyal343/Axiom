// @vitest-environment jsdom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeymapHandler } from "../../input/keymap";
import type {
  ArtifactFormat,
  ArtifactScope,
  CompiledArtifact,
  CompiledXray,
  EdgeDto,
  EdgeType,
  GraphOp,
  NodeDto,
  Severity,
} from "../../ipc/types";
import {
  edgesMap,
  loadSnapshot,
  mutateGraph,
  nodesMap,
} from "../../store/graphStore";
import {
  artifactExportFormat,
  artifactExportOpen,
  artifactExportScope,
  closeArtifactExport,
  closeNodeContextMenu,
  edgePopover,
  focusId,
  modalState,
  nodeContextMenu,
  openArtifactExport,
  selectedEdgeId,
  selectedIds,
  selectSingle,
  setSelection,
  xrayPinned,
  xrayState,
  type ModalState,
} from "../../store/selection";
import { ArtifactExportModal } from "../ArtifactExportModal";
import { NodeContextMenu } from "../NodeContextMenu";
import { XrayHud } from "../XrayHud";

function makeNode(
  id: string,
  opts: Partial<{
    type: NodeDto["type"];
    status: NodeDto["status"];
    severity: Severity | null;
    title: string;
    x: number;
    y: number;
    collapsed: boolean;
  }> = {},
): NodeDto {
  return {
    id,
    type: opts.type ?? "core",
    status: opts.status ?? "active",
    title: opts.title ?? id,
    content: `Content for ${id}`,
    summary: `Summary for ${id}`,
    content_hash: `h_${id}`,
    summary_hash: `s_${id}`,
    metadata: {
      severity: opts.severity ?? null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: 10,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: {
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      width: 320,
      height: 180,
      collapsed: opts.collapsed ?? false,
    },
    created_at: 1,
    updated_at: 1,
  };
}

function makeEdge(id: string, sourceId: string, targetId: string, type: EdgeType): EdgeDto {
  return {
    id,
    source_id: sourceId,
    target_id: targetId,
    type,
    weight: "summary",
    created_at: 1,
  };
}

async function flushUi(): Promise<void> {
  await Promise.resolve();
  if (typeof requestAnimationFrame === "function") {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 40);
  });
  await Promise.resolve();
}

describe("v0.2 Workbench UI, Sticky X-Ray, Bulk Actions, Keymap & Artifact Export", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    xrayPinned.value = false;
    xrayState.value = null;
    edgePopover.value = null;
    selectedEdgeId.value = null;
    closeNodeContextMenu();
    closeArtifactExport();
    modalState.value = "navigate";
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    closeNodeContextMenu();
    closeArtifactExport();
    xrayPinned.value = false;
    xrayState.value = null;
    edgePopover.value = null;
    selectedEdgeId.value = null;
    render(null, container);
    container.remove();
    vi.restoreAllMocks();
  });

  it("supports sticky X-Ray (Shift+V), OVER BUDGET pill, per-mode tokens, and Inspect Prompt toggle", async () => {
    const sampleXray: CompiledXray = {
      total_tokens: 7200,
      budget_tokens: 6000,
      overflow: true,
      node_modes: { n1: "focus", n2: "full", n3: "loophole" },
      active_edges: ["e1"],
      mode_tokens: { focus: 3000, full: 2800, loophole: 1400 },
      prompt_preview: "## System\nFocus: n1\nFull: n2",
    };

    loadSnapshot({
      path: "memory://xray-test",
      nodes: [makeNode("n1"), makeNode("n2"), makeNode("n3", { type: "loophole", severity: "high" })],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n1" },
      token_budget: 6000,
    });

    let pinned = false;
    let currentXray: CompiledXray | null = null;
    const handler = createKeymapHandler({
      getModalState: () => modalState.value,
      setModalState: (m) => {
        modalState.value = m;
      },
      getFocusId: () => focusId.value,
      getSelectedIds: () => selectedIds.value,
      getNodes: () => nodesMap,
      getEdges: () => edgesMap,
      selectSingle,
      setSelection,
      enterEditMode: () => true,
      triggerLockedShake: () => {},
      isXrayPinned: () => pinned,
      setXrayPinned: (p) => {
        pinned = p;
        xrayPinned.value = p;
      },
      setXray: (x) => {
        currentXray = x;
        xrayState.value = x;
      },
      compileXray: async () => sampleXray,
      mutateUndoable: async () => ({
        updated_nodes: [],
        deleted_node_ids: [],
        deleted_edge_ids: [],
      }),
      spawnChild: async () => ({
        node: makeNode("c"),
        edge: makeEdge("e", "n1", "c", "derives"),
      }),
      undo: async () => null,
      redo: async () => null,
      tidySubtree: async () => [],
      openCommandPalette: () => {},
      closeOverlays: () => {
        pinned = false;
        xrayPinned.value = false;
        xrayState.value = null;
      },
      openEdgePopoverFor: () => {},
      onTriggerLens: () => {},
      pushToast: () => {},
      getCamera: () => ({ x: 0, y: 0, zoom: 1, last_focus_id: "n1" }),
      getViewportSize: () => ({ width: 1280, height: 800 }),
      animateTo: () => {},
    });

    handler.handleKeyDown(
      new KeyboardEvent("keydown", { key: "V", shiftKey: true, bubbles: true, cancelable: true }),
    );
    await flushUi();

    expect(pinned).toBe(true);
    expect(currentXray).not.toBeNull();

    // Keyup on V must NOT clear sticky X-Ray when pinned.
    handler.handleKeyUp(new KeyboardEvent("keyup", { key: "v", bubbles: true }));
    expect(xrayState.value).not.toBeNull();

    render(<XrayHud />, container);
    await flushUi();

    const aside = container.querySelector(".xray-hud");
    expect(aside?.classList.contains("xray-hud--pinned")).toBe(true);
    expect(aside?.textContent).toContain("OVER BUDGET");
    expect(aside?.textContent).toContain("3,000t");
    expect(aside?.textContent).toContain("2,800t");

    // Prompt preview starts collapsed; clicking Inspect Prompt reveals <pre> + Copy Prompt.
    expect(container.querySelector(".xray-hud__prompt")).toBeNull();
    const inspectBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Inspect Prompt"),
    );
    expect(inspectBtn).toBeDefined();
    inspectBtn?.click();
    await flushUi();

    const pre = container.querySelector<HTMLPreElement>(".xray-hud__prompt");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("Focus: n1");
    expect(
      Array.from(container.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("Copy Prompt"),
      ),
    ).toBe(true);

    // Second Shift+V unpins and clears X-Ray.
    handler.handleKeyDown(
      new KeyboardEvent("keydown", { key: "V", shiftKey: true, bubbles: true, cancelable: true }),
    );
    await flushUi();
    expect(pinned).toBe(false);
    expect(xrayState.value).toBeNull();
    handler.dispose();
  });

  it("supports multi-select bulk actions in NodeContextMenu and Type/Severity switching", async () => {
    loadSnapshot({
      path: "memory://bulk-test",
      nodes: [
        makeNode("n1", { title: "Alpha" }),
        makeNode("n2", { title: "Beta" }),
        makeNode("lh1", { type: "loophole", severity: "medium", title: "Risk" }),
      ],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n1" },
      token_budget: 6000,
    });

    setSelection(["n1", "n2"], "n1");
    nodeContextMenu.value = { nodeId: "n1", x: 100, y: 100 };

    render(<NodeContextMenu />, container);
    await flushUi();

    const menuText = container.querySelector(".node-context-menu")?.textContent ?? "";
    expect(menuText).toContain("Pin 2 nodes");
    expect(menuText).toContain("Exclude 2 nodes");
    expect(menuText).toContain("Fold 2 nodes");
    expect(menuText).toContain("Delete 2 nodes");
    expect(menuText).toContain("Export Subgraph…");

    // Click "Pin 2 nodes" -> pins both n1 and n2 in one undoable batch.
    const pinBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Pin 2 nodes"),
    );
    pinBtn?.click();
    await flushUi();

    expect(nodesMap.get("n1")?.context_controls.pin_global).toBe(true);
    expect(nodesMap.get("n2")?.context_controls.pin_global).toBe(true);

    // Switch single loophole severity to Critical.
    selectSingle("lh1");
    nodeContextMenu.value = { nodeId: "lh1", x: 120, y: 120 };
    await flushUi();

    const critBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".node-context-menu__chip"),
    ).find((b) => b.textContent === "Critical");
    expect(critBtn).toBeDefined();
    critBtn?.click();
    await flushUi();

    expect(nodesMap.get("lh1")?.metadata.severity).toBe("critical");

    // Export Subgraph… opens ArtifactExportModal.
    nodeContextMenu.value = { nodeId: "lh1", x: 120, y: 120 };
    await flushUi();
    const exportBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Export Subgraph…"),
    );
    exportBtn?.click();
    await flushUi();
    expect(artifactExportOpen.value).toBe(true);
    expect(artifactExportScope.value).toBe("subgraph");
  });

  it("handles edgePopover 1-6 edge types, Ctrl+A, C bulk fold, and [ / ] loophole cycling", async () => {
    const n1 = makeNode("a_root", { x: 0, y: 0 });
    const n2 = makeNode("b_child", { x: 400, y: 0 });
    const lLow = makeNode("lh_low", { type: "loophole", severity: "low", x: 100, y: 200 });
    const lCrit = makeNode("lh_crit", { type: "loophole", severity: "critical", x: 500, y: 200 });
    loadSnapshot({
      path: "memory://keymap-v02",
      nodes: [n1, n2, lLow, lCrit],
      edges: [makeEdge("e_old", "a_root", "b_child", "derives")],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "a_root" },
      token_budget: 6000,
    });

    const recordedOps: GraphOp[][] = [];
    const animatedTo: Array<{ x: number; y: number; zoom: number }> = [];
    let modal: ModalState = "navigate";

    const handler = createKeymapHandler({
      getModalState: () => modal,
      setModalState: (m) => {
        modal = m;
      },
      getFocusId: () => focusId.value,
      getSelectedIds: () => selectedIds.value,
      getNodes: () => nodesMap,
      getEdges: () => edgesMap,
      selectSingle,
      setSelection,
      enterEditMode: () => true,
      triggerLockedShake: () => {},
      setXray: () => {},
      compileXray: async () => ({
        total_tokens: 0,
        budget_tokens: 6000,
        node_modes: {},
        active_edges: [],
      }),
      mutateUndoable: async (_label, forward) => {
        recordedOps.push(forward);
        return mutateGraph(forward);
      },
      spawnChild: async () => ({
        node: makeNode("x"),
        edge: makeEdge("ex", "a_root", "x", "derives"),
      }),
      undo: async () => null,
      redo: async () => null,
      tidySubtree: async () => [],
      openCommandPalette: () => {},
      closeOverlays: () => {
        edgePopover.value = null;
        modal = "navigate";
      },
      openEdgePopoverFor: () => {},
      getEdgePopover: () => edgePopover.value,
      clearEdgePopover: () => {
        edgePopover.value = null;
      },
      getSelectedEdgeId: () => selectedEdgeId.value,
      clearSelectedEdge: () => {
        selectedEdgeId.value = null;
      },
      onTriggerLens: () => {},
      pushToast: () => {},
      getCamera: () => ({ x: 0, y: 0, zoom: 1, last_focus_id: focusId.value }),
      getViewportSize: () => ({ width: 1280, height: 800 }),
      animateTo: (cam) => {
        animatedTo.push(cam);
      },
    });

    // Edge popover keys 1..6 create all 6 EdgeTypes immediately.
    const expectedTypes: Array<[string, EdgeType]> = [
      ["1", "derives"],
      ["2", "branches"],
      ["3", "challenges"],
      ["4", "resolves"],
      ["5", "synthesizes"],
      ["6", "references"],
    ];
    for (const [key, expectedType] of expectedTypes) {
      edgePopover.value = { sourceId: "a_root", targetId: "b_child", x: 300, y: 100 };
      modal = "connect_edge";
      handler.handleKeyDown(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
      await flushUi();
      const lastBatch = recordedOps[recordedOps.length - 1];
      expect(lastBatch?.[0]).toMatchObject({
        op: "create_edge",
        edge: { source_id: "a_root", target_id: "b_child", type: expectedType },
      });
      expect(edgePopover.value).toBeNull();
      expect(modal).toBe("navigate");
    }

    // Ctrl+A selects all 4 nodes; C toggles collapsed on all 4 in one batch.
    handler.handleKeyDown(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(selectedIds.value.size).toBe(4);

    handler.handleKeyDown(
      new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }),
    );
    await flushUi();
    expect(nodesMap.get("a_root")?.layout.collapsed).toBe(true);
    expect(nodesMap.get("b_child")?.layout.collapsed).toBe(true);

    // ] cycles active loopholes sorted by severity (critical first, then low) and animates camera.
    selectSingle("a_root");
    handler.handleKeyDown(
      new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }),
    );
    expect(focusId.value).toBe("lh_crit");
    expect(animatedTo.length).toBeGreaterThan(0);

    handler.handleKeyDown(
      new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }),
    );
    expect(focusId.value).toBe("lh_low");

    // Backspace deletes selectedEdgeId when an edge is selected.
    selectedEdgeId.value = "e_old";
    handler.handleKeyDown(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
    );
    await flushUi();
    expect(selectedEdgeId.value).toBeNull();
    expect(edgesMap.has("e_old")).toBe(false);

    handler.dispose();
  });

  it("renders ArtifactExportModal, switches format tabs & scope, and closes on Esc", async () => {
    loadSnapshot({
      path: "memory://artifact-test",
      nodes: [makeNode("root", { title: "Consensus Protocol" })],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "root" },
      token_budget: 6000,
    });

    // Browser preview mode shows clear note.
    openArtifactExport("adr", "subgraph");
    render(<ArtifactExportModal />, container);
    await flushUi();

    expect(container.querySelector(".artifact-modal")?.textContent).toContain(
      "Browser preview mode",
    );

    // Simulate Tauri desktop runtime with mocked invoke IPC.
    const tauriInvoke = vi.fn(
      async (cmd: string, args: { format: ArtifactFormat; scope: ArtifactScope }) => {
        expect(cmd).toBe("export_markdown_artifact");
        const artifact: CompiledArtifact = {
          format: args.format,
          scope: args.scope,
          title: "Consensus Protocol",
          markdown: `# ${args.format.toUpperCase()} (${args.scope})\n\nBody`,
          node_count: 3,
          edge_count: 2,
          unresolved_loophole_count: 1,
        };
        return artifact;
      },
    );
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: tauriInvoke,
      transformCallback: () => 0,
    };

    // Trigger re-fetch by switching to Research Brief tab and Entire Flow scope.
    const briefTab = Array.from(container.querySelectorAll('[role="tab"]')).find((b) =>
      b.textContent?.includes("Research Brief"),
    ) as HTMLButtonElement | undefined;
    briefTab?.click();
    await flushUi();

    expect(artifactExportFormat.value).toBe("brief");
    expect(container.querySelector(".artifact-modal__stats")?.textContent).toContain(
      "3 nodes · 2 edges · 1 open risks",
    );
    expect(container.querySelector(".artifact-modal__preview")?.textContent).toContain(
      "# BRIEF (subgraph)",
    );

    const workspaceRadio = Array.from(container.querySelectorAll('[role="radio"]')).find((b) =>
      b.textContent?.includes("Entire Flow"),
    ) as HTMLButtonElement | undefined;
    workspaceRadio?.click();
    await flushUi();

    expect(artifactExportScope.value).toBe("workspace");
    expect(container.querySelector(".artifact-modal__preview")?.textContent).toContain(
      "# BRIEF (workspace)",
    );

    // Esc closes the modal.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushUi();
    expect(artifactExportOpen.value).toBe(false);
    expect(container.querySelector(".artifact-modal")).toBeNull();
  });
});

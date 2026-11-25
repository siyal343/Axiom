// @vitest-environment jsdom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachKeymap } from "../../input/keymap";
import type {
  ExternalRefInfo,
  NodeDto,
  PullExternalRefResult,
  WorkspaceSearchHit,
} from "../../ipc/types";
import {
  cameraControllerRef,
  edgesMap,
  loadSnapshot,
  nodesMap,
  performUndo,
  theme,
} from "../../store/graphStore";
import {
  checkpointsModalOpen,
  clearSelection,
  clearSpotlight,
  closeCheckpointsModal,
  closeCommandPalette,
  closeNodeContextMenu,
  commandPaletteOpen,
  externalRefsMap,
  focusId,
  modalState,
  nodeContextMenu,
  openCommandPalette,
  selectSingle,
  spotlightRootId,
} from "../../store/selection";
import { workspaceCatalog } from "../../store/workspaceCatalogStore";
import { CommandPalette } from "../CommandPalette";
import { NodeContextMenu } from "../NodeContextMenu";
import { dismissToast, toastsSignal, ToastStack } from "../ToastStack";

function makeNode(id: string, title: string, x = 100, y = 100): NodeDto {
  return {
    id,
    type: "core",
    status: "active",
    title,
    content: `Body for ${title}`,
    summary: `Summary for ${title}`,
    content_hash: `h_${id}`,
    summary_hash: `s_${id}`,
    metadata: {
      severity: null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: 10,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: { x, y, width: 320, height: 180, collapsed: false },
    created_at: 1,
    updated_at: 1,
  };
}

function makeExtRef(localId: string): ExternalRefInfo {
  return {
    local_node_id: localId,
    source_workspace_id: "ws1",
    source_flow_id: "flow_src",
    source_flow_name: "Architecture Flow",
    source_node_id: "n_src_1",
    synced_hash: "hash_v1",
    synced_at: 1000,
    status: "out_of_sync",
    source_title: "Source Consensus Spec",
  };
}

function resetToasts(): void {
  for (const t of toastsSignal.value) {
    dismissToast(t.id);
  }
}

async function flushUi(ms = 120): Promise<void> {
  await Promise.resolve();
  if (typeof requestAnimationFrame === "function") {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
  await Promise.resolve();
}

describe("v0.5 Cross-Flow Linking, Keymap (Shift+F/Shift+S/Esc) & NodeContextMenu", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    theme.value = "dark";
    workspaceCatalog.value = {
      active_workspace_id: "ws1",
      active_flow_id: "flow_cur",
      workspaces: [
        {
          id: "ws1",
          name: "Engineering",
          created_at: 1,
          flows: [
            {
              id: "flow_cur",
              workspace_id: "ws1",
              name: "Current Flow",
              template: "engineering",
              db_path: "cur.sqlite",
              updated_at: 1,
            },
            {
              id: "flow_src",
              workspace_id: "ws1",
              name: "Architecture Flow",
              template: "engineering",
              db_path: "src.sqlite",
              updated_at: 2,
            },
          ],
        },
      ],
    };
    cameraControllerRef.current = null;
    closeCommandPalette();
    closeNodeContextMenu();
    closeCheckpointsModal();
    clearSpotlight();
    clearSelection();
    resetToasts();
    modalState.value = "navigate";
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    cameraControllerRef.current = null;
    closeCommandPalette();
    closeNodeContextMenu();
    closeCheckpointsModal();
    clearSpotlight();
    clearSelection();
    resetToasts();
    modalState.value = "navigate";
    render(null, container);
    container.remove();
    vi.restoreAllMocks();
  });

  it("CommandPalette All Flows + Link pulls external card via mocked pull_external_reference and > Checkpoints & Graph Diff opens modal", async () => {
    const localRoot = makeNode("n_local", "Local Root", 0, 0);
    loadSnapshot({
      path: "cur.sqlite",
      nodes: [localRoot],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_local" },
      token_budget: 6000,
    });
    selectSingle("n_local");

    const animateTo = vi.fn();
    cameraControllerRef.current = {
      setCardLayerEl: () => {},
      markDirty: () => {},
      refreshCull: () => {},
      setCamera: () => {},
      getCamera: () => ({ x: 0, y: 0, zoom: 1, last_focus_id: "n_local" }),
      getViewportSize: () => ({ width: 1200, height: 800 }),
      animateTo,
    };

    const wsHits: WorkspaceSearchHit[] = [
      {
        workspace_id: "ws1",
        flow_id: "flow_cur",
        flow_name: "Current Flow",
        hit: {
          id: "n_local",
          title: "Local Root",
          type: "core",
          status: "active",
          severity: null,
          snippet: "Same flow should not show + Link",
          x: 0,
          y: 0,
        },
      },
      {
        workspace_id: "ws1",
        flow_id: "flow_src",
        flow_name: "Architecture Flow",
        hit: {
          id: "n_src_1",
          title: "Source Consensus Spec",
          type: "core",
          status: "active",
          severity: null,
          snippet: "Raft quorum invariants",
          x: 400,
          y: 120,
        },
      },
    ];

    const pulledNode = makeNode("n_pulled_1", "Source Consensus Spec", 420, 0);
    const pullResult: PullExternalRefResult = {
      node: pulledNode,
      edge: {
        id: "e_ref_1",
        source_id: "n_local",
        target_id: "n_pulled_1",
        type: "references",
        weight: "summary",
        created_at: 100,
      },
      external_ref: makeExtRef("n_pulled_1"),
    };

    const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "search_workspace_flows") {
        return wsHits;
      }
      if (cmd === "pull_external_reference") {
        expect(args).toEqual({
          sourceWorkspaceId: "ws1",
          sourceFlowId: "flow_src",
          sourceNodeId: "n_src_1",
          attachToNodeId: "n_local",
        });
        return pullResult;
      }
      if (cmd === "search_nodes") {
        return [];
      }
      if (cmd === "apply_ops") {
        return { updated_nodes: [], deleted_node_ids: ["n_pulled_1"], deleted_edge_ids: ["e_ref_1"] };
      }
      return [];
    });
    (window as { __TAURI_INTERNALS__?: { invoke: typeof invokeMock } }).__TAURI_INTERNALS__ = {
      invoke: invokeMock,
    };

    render(
      <>
        <CommandPalette />
        <ToastStack />
      </>,
      container,
    );

    openCommandPalette();
    await flushUi();

    const input = container.querySelector<HTMLInputElement>(".command-palette__input");
    expect(input).not.toBeNull();
    if (!input) return;

    input.value = "all:quorum";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi(180);

    const linkButtons = container.querySelectorAll<HTMLButtonElement>(".palette-link-btn");
    expect(linkButtons).toHaveLength(1);
    expect(linkButtons[0]?.textContent?.trim()).toBe("+ Link");

    linkButtons[0]?.click();
    await flushUi();

    expect(commandPaletteOpen.value).toBe(false);
    expect(nodesMap.has("n_pulled_1")).toBe(true);
    expect(edgesMap.has("e_ref_1")).toBe(true);
    expect(externalRefsMap.value.get("n_pulled_1")?.source_flow_id).toBe("flow_src");
    expect(focusId.value).toBe("n_pulled_1");
    expect(animateTo).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Linked card from Architecture Flow");

    // Undo removes the pulled cross-flow card cleanly.
    await performUndo();
    expect(nodesMap.has("n_pulled_1")).toBe(false);

    // > Checkpoints & Graph Diff opens CheckpointsModal.
    openCommandPalette();
    await flushUi();
    const input2 = container.querySelector<HTMLInputElement>(".command-palette__input");
    if (!input2) return;
    input2.value = "> Checkpoints";
    input2.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const cpCmd = container.querySelector<HTMLButtonElement>(".command-palette__item--cmd");
    expect(cpCmd?.textContent).toContain("> Checkpoints & Graph Diff (Shift+S)");
    cpCmd?.click();
    await flushUi();

    expect(checkpointsModalOpen.value).toBe(true);
    expect(commandPaletteOpen.value).toBe(false);
  });

  it("keymap handles Shift+F spotlight toggle, Shift+S checkpoints toggle, and Esc cleanup", () => {
    loadSnapshot({
      path: "cur.sqlite",
      nodes: [makeNode("n1", "Node One")],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n1" },
      token_budget: 6000,
    });
    selectSingle("n1");

    const detach = attachKeymap();
    try {
      // Shift+F activates spotlight on focus node
      const sf1 = new KeyboardEvent("keydown", {
        key: "F",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(sf1);
      expect(sf1.defaultPrevented).toBe(true);
      expect(spotlightRootId.value).toBe("n1");

      // Shift+F again toggles spotlight off
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F", shiftKey: true, bubbles: true, cancelable: true }),
      );
      expect(spotlightRootId.value).toBeNull();

      // Activate spotlight again + open Checkpoints with Shift+S
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F", shiftKey: true, bubbles: true, cancelable: true }),
      );
      expect(spotlightRootId.value).toBe("n1");

      const ss1 = new KeyboardEvent("keydown", {
        key: "S",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(ss1);
      expect(ss1.defaultPrevented).toBe(true);
      expect(checkpointsModalOpen.value).toBe(true);

      // Esc closes CheckpointsModal and clears Spotlight
      const escEv = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(escEv);
      expect(escEv.defaultPrevented).toBe(true);
      expect(checkpointsModalOpen.value).toBe(false);
      expect(spotlightRootId.value).toBeNull();
    } finally {
      detach();
    }
  });

  it("NodeContextMenu renders Focus Spotlight and external-ref actions that dispatch expected events", async () => {
    const extNode = makeNode("n_ext", "Linked Card");
    loadSnapshot({
      path: "cur.sqlite",
      nodes: [extNode],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_ext" },
      token_budget: 6000,
    });
    externalRefsMap.value = new Map([["n_ext", makeExtRef("n_ext")]]);

    const syncEvents: string[] = [];
    const openEvents: Array<{
      nodeId: string;
      sourceWorkspaceId: string;
      sourceFlowId: string;
      sourceNodeId: string;
    }> = [];
    const detachEvents: string[] = [];

    const onSync = (e: Event): void => {
      syncEvents.push((e as CustomEvent<{ nodeId: string }>).detail.nodeId);
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
      detachEvents.push((e as CustomEvent<{ nodeId: string }>).detail.nodeId);
    };

    window.addEventListener("axiom:sync-extref", onSync);
    window.addEventListener("axiom:open-extref", onOpen);
    window.addEventListener("axiom:detach-extref", onDetach);

    try {
      render(<NodeContextMenu />, container);
      const findItem = (label: string): HTMLButtonElement | undefined =>
        Array.from(container.querySelectorAll<HTMLButtonElement>(".node-context-menu__item")).find(
          (b) => b.textContent?.includes(label),
        );

      // 1. Focus Spotlight
      nodeContextMenu.value = { nodeId: "n_ext", x: 100, y: 100 };
      await flushUi();
      const spotBtn = findItem("Focus Spotlight");
      expect(spotBtn).toBeDefined();
      spotBtn?.click();
      await flushUi();
      expect(spotlightRootId.value).toBe("n_ext");
      expect(nodeContextMenu.value).toBeNull();

      // 2. Pull Latest from Source
      nodeContextMenu.value = { nodeId: "n_ext", x: 100, y: 100 };
      await flushUi();
      const syncBtn = findItem("Pull Latest from Source");
      expect(syncBtn).toBeDefined();
      syncBtn?.click();
      await flushUi();
      expect(syncEvents).toEqual(["n_ext"]);

      // 3. Open Source Flow
      nodeContextMenu.value = { nodeId: "n_ext", x: 100, y: 100 };
      await flushUi();
      const openBtn = findItem("Open Source Flow");
      expect(openBtn).toBeDefined();
      openBtn?.click();
      await flushUi();
      expect(openEvents).toEqual([
        {
          nodeId: "n_ext",
          sourceWorkspaceId: "ws1",
          sourceFlowId: "flow_src",
          sourceNodeId: "n_src_1",
        },
      ]);

      // 4. Detach External Link
      nodeContextMenu.value = { nodeId: "n_ext", x: 100, y: 100 };
      await flushUi();
      const detachBtn = findItem("Detach External Link");
      expect(detachBtn).toBeDefined();
      detachBtn?.click();
      await flushUi();
      expect(detachEvents).toEqual(["n_ext"]);
    } finally {
      window.removeEventListener("axiom:sync-extref", onSync);
      window.removeEventListener("axiom:open-extref", onOpen);
      window.removeEventListener("axiom:detach-extref", onDetach);
    }
  });
});

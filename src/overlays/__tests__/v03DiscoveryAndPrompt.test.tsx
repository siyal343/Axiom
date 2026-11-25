// @vitest-environment jsdom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettingsDto,
  NodeDto,
  OpenFlowResult,
  StaleNodeInfo,
  WorkspaceSearchHit,
} from "../../ipc/types";
import {
  closeSettingsModal,
  openSettingsModal,
  settingsModalOpen,
} from "../../store/aiRunner";
import {
  cameraControllerRef,
  flowSystemPrompt,
  loadSnapshot,
  theme,
} from "../../store/graphStore";
import {
  closeCommandPalette,
  closeNodeContextMenu,
  commandPaletteOpen,
  focusId,
  modalState,
  nodeContextMenu,
  openCommandPalette,
  relatedPopoverNodeId,
  selectSingle,
  staleNodesMap,
} from "../../store/selection";
import { workspaceCatalog } from "../../store/workspaceCatalogStore";
import { CommandPalette } from "../CommandPalette";
import { NodeContextMenu } from "../NodeContextMenu";
import { SettingsModal } from "../SettingsModal";

function makeNode(
  id: string,
  title: string,
  opts: Partial<{ x: number; y: number; content: string }> = {},
): NodeDto {
  return {
    id,
    type: "core",
    status: "active",
    title,
    content: opts.content ?? `Body for ${title}`,
    summary: `Summary for ${title}`,
    content_hash: `h_${id}`,
    summary_hash: `s_${id}`,
    metadata: {
      severity: null,
      lens: "red_team",
      created_by: "ai",
      model: "gpt-4o",
      token_count: 16,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: {
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      width: 320,
      height: 180,
      collapsed: false,
    },
    created_at: 1,
    updated_at: 1,
  };
}

function makeStaleInfo(nodeId: string): StaleNodeInfo {
  return {
    node_id: nodeId,
    run_id: "run_1",
    lens: "red_team",
    model: "gpt-4o",
    created_at: 100,
    changed_inputs: [{ node_id: "root", title: "Root", reason: "modified" }],
  };
}

function makeDefaultSettings(): AppSettingsDto {
  return {
    reasoning: {
      provider: "openai_compat",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4o",
      has_api_key: true,
      temperature: 0.4,
      max_tokens: 2048,
    },
    utility: {
      provider: "openai_compat",
      base_url: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      has_api_key: true,
      temperature: 0.2,
      max_tokens: 256,
    },
    default_token_budget: 6000,
    auto_summarize: true,
    theme: "dark",
  };
}

async function flushUi(ms = 90): Promise<void> {
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

describe("v0.3 Discovery, Workspace Search, Stale Actions & Flow System Prompt", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    theme.value = "dark";
    flowSystemPrompt.value = "";
    staleNodesMap.value = new Map();
    relatedPopoverNodeId.value = null;
    workspaceCatalog.value = null;
    cameraControllerRef.current = null;
    closeCommandPalette();
    closeNodeContextMenu();
    closeSettingsModal();
    modalState.value = "navigate";
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    cameraControllerRef.current = null;
    closeCommandPalette();
    closeNodeContextMenu();
    closeSettingsModal();
    staleNodesMap.value = new Map();
    relatedPopoverNodeId.value = null;
    render(null, container);
    container.remove();
    vi.restoreAllMocks();
  });

  it("supports stale:true local filtering, All Flows browser hint, and > Filter Stale AI Nodes", async () => {
    const staleNode = makeNode("n_stale", "Stale Red-Team Node", { x: 100, y: 100 });
    const freshNode = makeNode("n_fresh", "Fresh Architecture Node", { x: 500, y: 100 });
    loadSnapshot({
      path: "memory://flow1",
      nodes: [staleNode, freshNode],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_fresh" },
      token_budget: 6000,
    });
    staleNodesMap.value = new Map([["n_stale", makeStaleInfo("n_stale")]]);

    render(<CommandPalette />, container);
    openCommandPalette();
    await flushUi();

    const input = container.querySelector<HTMLInputElement>(".command-palette__input");
    expect(input).not.toBeNull();
    if (!input) return;

    // Click stale:true chip -> shows only n_stale.
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>(".command-palette__chip"));
    const staleChip = chips.find((btn) => btn.textContent?.trim() === "stale:true");
    expect(staleChip).toBeDefined();
    staleChip?.click();
    await flushUi();

    const hitTitles = Array.from(
      container.querySelectorAll<HTMLElement>(".command-palette__item-title"),
    ).map((el) => el.textContent);
    expect(hitTitles).toEqual(["Stale Red-Team Node"]);

    // Use > Filter Stale AI Nodes command from > mode -> stays open with stale:true.
    input.value = "> Filter Stale";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const cmdBtn = container.querySelector<HTMLButtonElement>(".command-palette__item--cmd");
    expect(cmdBtn?.textContent).toContain("> Filter Stale AI Nodes");
    cmdBtn?.click();
    await flushUi();

    expect(commandPaletteOpen.value).toBe(true);
    expect(input.value).toBe("stale:true");
    const filteredTitles = Array.from(
      container.querySelectorAll<HTMLElement>(".command-palette__item-title"),
    ).map((el) => el.textContent);
    expect(filteredTitles).toEqual(["Stale Red-Team Node"]);

    // Switch to All Flows in browser mode -> shows concise desktop runtime hint.
    const allFlowsBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".palette-scope-toggle__btn"),
    ).find((b) => b.textContent?.trim() === "All Flows");
    expect(allFlowsBtn).toBeDefined();
    allFlowsBtn?.click();
    await flushUi();

    const emptyMsg = container.querySelector(".command-palette__empty")?.textContent ?? "";
    expect(emptyMsg).toContain("desktop runtime");
  });

  it("searches across All Flows via Tauri IPC (and all: prefix), opens flow, focuses node, and runs > commands", async () => {
    const localNode = makeNode("n_local", "Local Root", { x: 0, y: 0 });
    const remoteNode = makeNode("n_remote", "Raft Consensus Spec", { x: 420, y: 240 });

    loadSnapshot({
      path: "local://ws1/flow1",
      nodes: [localNode],
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
        flow_id: "flow2",
        flow_name: "Distributed Systems",
        hit: {
          id: "n_remote",
          title: "Raft Consensus Spec",
          type: "core",
          status: "active",
          severity: null,
          snippet: "Leader election and log replication",
          x: 420,
          y: 240,
        },
      },
    ];

    const openFlowResult: OpenFlowResult = {
      catalog: {
        active_workspace_id: "ws1",
        active_flow_id: "flow2",
        workspaces: [
          {
            id: "ws1",
            name: "Engineering",
            created_at: 1,
            flows: [
              {
                id: "flow1",
                workspace_id: "ws1",
                name: "Current Flow",
                template: "engineering",
                db_path: "flow1.sqlite",
                updated_at: 1,
              },
              {
                id: "flow2",
                workspace_id: "ws1",
                name: "Distributed Systems",
                template: "engineering",
                db_path: "flow2.sqlite",
                updated_at: 2,
              },
            ],
          },
        ],
      },
      snapshot: {
        path: "flow2.sqlite",
        nodes: [remoteNode],
        edges: [],
        camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_remote" },
        token_budget: 6000,
        system_prompt: "Keep answers crisp.",
      },
    };

    const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "search_workspace_flows") {
        return wsHits;
      }
      if (cmd === "open_flow") {
        return openFlowResult;
      }
      if (cmd === "get_stale_nodes") {
        return [];
      }
      if (cmd === "search_nodes") {
        return [];
      }
      throw new Error(`Unexpected IPC command: ${cmd} (${JSON.stringify(args)})`);
    });

    (window as { __TAURI_INTERNALS__?: { invoke: typeof invokeMock } }).__TAURI_INTERNALS__ = {
      invoke: invokeMock,
    };

    render(<CommandPalette />, container);
    openCommandPalette();
    await flushUi();

    const input = container.querySelector<HTMLInputElement>(".command-palette__input");
    expect(input).not.toBeNull();
    if (!input) return;

    // Typing "all:consensus" automatically triggers All Flows search with stripped prefix.
    input.value = "all:consensus";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi(100);

    expect(invokeMock).toHaveBeenCalledWith(
      "search_workspace_flows",
      {
        query: "consensus",
        limit: 30,
      },
      undefined,
    );

    const flowBadge = container.querySelector(".badge--flow");
    expect(flowBadge?.textContent).toBe("Distributed Systems");

    const hitBtn = container.querySelector<HTMLButtonElement>(".command-palette__item");
    hitBtn?.click();
    await flushUi();

    expect(invokeMock).toHaveBeenCalledWith(
      "open_flow",
      {
        workspaceId: "ws1",
        flowId: "flow2",
      },
      undefined,
    );
    expect(focusId.value).toBe("n_remote");
    expect(flowSystemPrompt.value).toBe("Keep answers crisp.");
    expect(animateTo).toHaveBeenCalledTimes(1);
    expect(commandPaletteOpen.value).toBe(false);

    // Test > Find Related Nodes & > Edit Flow System Prompt commands.
    openCommandPalette();
    await flushUi();
    const input2 = container.querySelector<HTMLInputElement>(".command-palette__input");
    if (!input2) return;
    input2.value = "> Find Related Nodes";
    input2.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    container.querySelector<HTMLButtonElement>(".command-palette__item--cmd")?.click();
    await flushUi();
    expect(relatedPopoverNodeId.value).toBe("n_remote");

    openCommandPalette();
    await flushUi();
    const input3 = container.querySelector<HTMLInputElement>(".command-palette__input");
    if (!input3) return;
    input3.value = "> Edit Flow System Prompt";
    input3.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    container.querySelector<HTMLButtonElement>(".command-palette__item--cmd")?.click();
    await flushUi();
    expect(settingsModalOpen.value).toBe(true);
  });

  it("initializes and saves Flow System Instructions in SettingsModal", async () => {
    const settingsDto = makeDefaultSettings();
    loadSnapshot({
      path: "flow.sqlite",
      nodes: [],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: null },
      token_budget: 6000,
      system_prompt: "Initial flow prompt",
    });
    expect(flowSystemPrompt.value).toBe("Initial flow prompt");

    const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_settings") {
        return settingsDto;
      }
      if (cmd === "save_settings") {
        return settingsDto;
      }
      if (cmd === "save_flow_system_prompt") {
        expect(args).toEqual({ prompt: "Always verify invariants first." });
        return null;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
    });
    (window as { __TAURI_INTERNALS__?: { invoke: typeof invokeMock } }).__TAURI_INTERNALS__ = {
      invoke: invokeMock,
    };

    render(<SettingsModal />, container);
    openSettingsModal();
    await flushUi();

    const textarea = container.querySelector<HTMLTextAreaElement>(".settings-textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("Initial flow prompt");
    if (!textarea) return;

    textarea.value = "Always verify invariants first.";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const saveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".settings-btn")).find(
      (b) => b.textContent?.includes("Save Settings"),
    );
    expect(saveBtn).toBeDefined();
    saveBtn?.click();
    await flushUi();

    expect(invokeMock).toHaveBeenCalledWith(
      "save_flow_system_prompt",
      {
        prompt: "Always verify invariants first.",
      },
      undefined,
    );
    expect(flowSystemPrompt.value).toBe("Always verify invariants first.");
    expect(settingsModalOpen.value).toBe(false);
  });

  it("exposes Find Related Nodes, Mark Fresh, and Re-run Stale Lens in NodeContextMenu", async () => {
    const staleNode = makeNode("n_stale", "Stale Critique");
    loadSnapshot({
      path: "flow.sqlite",
      nodes: [staleNode],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_stale" },
      token_budget: 6000,
    });
    staleNodesMap.value = new Map([["n_stale", makeStaleInfo("n_stale")]]);

    const invokeMock = vi.fn(async (cmd: string) => {
      if (cmd === "acknowledge_stale_node") {
        return null;
      }
      return null;
    });
    (window as { __TAURI_INTERNALS__?: { invoke: typeof invokeMock } }).__TAURI_INTERNALS__ = {
      invoke: invokeMock,
    };

    const rerunEvents: Array<{ nodeId: string; lens: string }> = [];
    const onRerun = (e: Event): void => {
      rerunEvents.push((e as CustomEvent<{ nodeId: string; lens: string }>).detail);
    };
    window.addEventListener("axiom:rerun-stale", onRerun);

    try {
      render(<NodeContextMenu />, container);
      nodeContextMenu.value = { nodeId: "n_stale", x: 100, y: 100 };
      await flushUi();

      const findItem = (label: string): HTMLButtonElement | undefined =>
        Array.from(container.querySelectorAll<HTMLButtonElement>(".node-context-menu__item")).find(
          (b) => b.textContent?.includes(label),
        );

      // 1. Find Related Nodes
      const relatedBtn = findItem("Find Related Nodes");
      expect(relatedBtn).toBeDefined();
      relatedBtn?.click();
      await flushUi();
      expect(relatedPopoverNodeId.value).toBe("n_stale");
      expect(nodeContextMenu.value).toBeNull();

      // 2. Re-run Stale Lens
      nodeContextMenu.value = { nodeId: "n_stale", x: 100, y: 100 };
      await flushUi();
      const rerunBtn = findItem("Re-run Stale Lens");
      expect(rerunBtn).toBeDefined();
      rerunBtn?.click();
      await flushUi();
      expect(rerunEvents).toEqual([{ nodeId: "n_stale", lens: "red_team" }]);

      // 3. Mark Fresh
      nodeContextMenu.value = { nodeId: "n_stale", x: 100, y: 100 };
      await flushUi();
      const freshBtn = findItem("Mark Fresh");
      expect(freshBtn).toBeDefined();
      freshBtn?.click();
      await flushUi();

      expect(invokeMock).toHaveBeenCalledWith(
        "acknowledge_stale_node",
        {
          nodeId: "n_stale",
        },
        undefined,
      );
      expect(staleNodesMap.value.has("n_stale")).toBe(false);
    } finally {
      window.removeEventListener("axiom:rerun-stale", onRerun);
    }
  });
});

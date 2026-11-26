// @vitest-environment jsdom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_LENS_PRESETS,
  customLensesSignal,
  extractActionTagFromContent,
  filterActionTags,
  getAllActionTags,
  parseActionTagInvocation,
  setCustomLenses,
} from "../../input/actionTags";
import type {
  AppSettingsDto,
  CustomLensDef,
  EdgeDto,
  GraphDiagnostics,
  ImportOutlineResult,
  NodeDto,
} from "../../ipc/types";
import {
  activeRunId,
  activeRunLabel,
  activeRunLens,
  activeRunStatus,
  closeSettingsModal,
  executeActionTag,
  handleLensStreamEvent,
  openSettingsModal,
  resetRunTracker,
  settingsModalOpen,
} from "../../store/aiRunner";
import {
  cameraControllerRef,
  edgesMap,
  flowSystemPrompt,
  loadSnapshot,
  nodesMap,
  performRedo,
  performUndo,
  theme,
} from "../../store/graphStore";
import { canUndoSignal, graphHistory } from "../../store/history";
import {
  closeDiagnosticsModal,
  closeOutlineImportModal,
  diagnosticsModalOpen,
  focusId,
  modalState,
  openDiagnosticsModal,
  openOutlineImportModal,
  outlineImportModalOpen,
  selectSingle,
  staleNodesMap,
} from "../../store/selection";
import { DiagnosticsModal } from "../DiagnosticsModal";
import { OutlineImportModal } from "../OutlineImportModal";
import { SettingsModal } from "../SettingsModal";
import { toastsSignal } from "../ToastStack";

function makeNode(
  id: string,
  title: string,
  opts: Partial<{
    type: NodeDto["type"];
    status: NodeDto["status"];
    severity: NodeDto["metadata"]["severity"];
    x: number;
    y: number;
    token_count: number;
  }> = {},
): NodeDto {
  return {
    id,
    type: opts.type ?? "core",
    status: opts.status ?? "active",
    title,
    content: `Body for ${title}`,
    summary: "",
    content_hash: `h_${id}`,
    summary_hash: "",
    metadata: {
      severity: opts.severity ?? null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: opts.token_count ?? 20,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: {
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      width: 320,
      height: 180,
      collapsed: false,
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

function makeDefaultSettings(customLenses: CustomLensDef[] = []): AppSettingsDto {
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
    custom_lenses: customLenses,
  };
}

async function flushUi(ms = 60): Promise<void> {
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

describe("v0.4 Custom Lenses, Runner Integration, DiagnosticsModal & OutlineImportModal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    setCustomLenses([]);
    theme.value = "dark";
    flowSystemPrompt.value = "";
    staleNodesMap.value = new Map();
    toastsSignal.value = [];
    cameraControllerRef.current = null;
    activeRunId.value = null;
    activeRunLens.value = null;
    activeRunStatus.value = "idle";
    resetRunTracker();
    closeSettingsModal();
    closeDiagnosticsModal();
    closeOutlineImportModal();
    modalState.value = "navigate";
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    setCustomLenses([]);
    cameraControllerRef.current = null;
    activeRunId.value = null;
    activeRunLens.value = null;
    activeRunStatus.value = "idle";
    resetRunTracker();
    closeSettingsModal();
    closeDiagnosticsModal();
    closeOutlineImportModal();
    render(null, container);
    container.remove();
    vi.restoreAllMocks();
  });

  it("registers @threat custom lens, resolves @tag helpers, and passes customLensId to run_lens", async () => {
    const threatPreset = BUILTIN_LENS_PRESETS.find((p) => p.tag === "threat");
    expect(threatPreset).toBeDefined();
    if (!threatPreset) return;

    const threatLens: CustomLensDef = {
      ...threatPreset,
      id: "lens_threat_1",
    };
    setCustomLenses([threatLens]);

    expect(customLensesSignal.value).toHaveLength(1);
    const allTags = getAllActionTags();
    const customTagDef = allTags.find((t) => t.tag === "@threat");
    expect(customTagDef).toBeDefined();
    expect(customTagDef?.kind).toBe("lens");
    if (customTagDef?.kind === "lens") {
      expect(customTagDef.lens).toBe("custom");
      expect(customTagDef.customLens?.id).toBe("lens_threat_1");
    }

    const filtered = filterActionTags("thr");
    expect(filtered.map((t) => t.tag)).toContain("@threat");

    const parsed = parseActionTagInvocation("@threat check OAuth token flow");
    expect(parsed).not.toBeNull();
    expect(parsed?.action.tag).toBe("@threat");
    expect(parsed?.argument).toBe("check OAuth token flow");

    const extracted = extractActionTagFromContent(
      "```\n@threat inside code fence\n```\n\n@threat analyze payment webhook",
    );
    expect(extracted).not.toBeNull();
    expect(extracted?.action.tag).toBe("@threat");
    expect(extracted?.argument).toBe("analyze payment webhook");

    // Set up Tauri invoke mock & focus node to verify executeActionTag -> run_lens
    loadSnapshot({
      path: "flow.sqlite",
      nodes: [makeNode("node_auth", "Auth Gateway")],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "node_auth" },
      token_budget: 6000,
    });
    selectSingle("node_auth");

    const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "run_lens") {
        expect(args?.lens).toBe("custom");
        expect(args?.focusIds).toEqual(["node_auth"]);
        expect(args?.customLensId).toBe("lens_threat_1");
        expect(args?.customPrompt).toBeUndefined();
        return "run_custom_1";
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
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

    if (!customTagDef) return;
    await executeActionTag(customTagDef, "");

    expect(invokeMock).toHaveBeenCalledWith(
      "run_lens",
      expect.objectContaining({
        lens: "custom",
        focusIds: ["node_auth"],
        customLensId: "lens_threat_1",
      }),
      undefined,
    );
    expect(activeRunId.value).toBe("run_custom_1");
    expect(activeRunLabel.value).toBe("STRIDE Threat Model");

    handleLensStreamEvent({
      kind: "run_completed",
      run_id: "run_custom_1",
      spawned_ids: [],
      cancelled: false,
    });
    expect(activeRunLabel.value).toBeNull();
  });

  it("installs starter preset @threat, edits, deletes, validates, and saves custom lenses in SettingsModal", async () => {
    let savedCustomLenses: CustomLensDef[] = [];
    const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_settings") {
        return makeDefaultSettings([]);
      }
      if (cmd === "save_settings") {
        const input = args?.input as { custom_lenses?: CustomLensDef[] } | undefined;
        savedCustomLenses = input?.custom_lenses ?? [];
        return makeDefaultSettings(savedCustomLenses);
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
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

    render(<SettingsModal />, container);
    openSettingsModal();
    await flushUi();

    const promptTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (b) => b.textContent?.includes("Prompt & Lenses"),
    );
    expect(promptTab).toBeDefined();
    promptTab?.click();
    await flushUi();

    // 1. Install @threat starter preset
    const threatBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "+ @threat",
    );
    expect(threatBtn).toBeDefined();
    expect(threatBtn?.disabled).toBe(false);
    threatBtn?.click();
    await flushUi();

    expect(threatBtn?.disabled).toBe(true);
    expect(container.textContent).toContain("STRIDE Threat Model");

    // 2. Also install + @rollout then delete it
    const rolloutBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "+ @rollout",
    );
    rolloutBtn?.click();
    await flushUi();
    expect(container.textContent).toContain("Zero-Downtime Rollout");

    const deleteButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
      (b) => b.textContent?.trim() === "Delete",
    );
    expect(deleteButtons).toHaveLength(2);
    deleteButtons[1]?.click();
    await flushUi();
    expect(container.textContent).not.toContain("Zero-Downtime Rollout");

    // 3. Edit @threat lens name and save form
    const editBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Edit",
    );
    editBtn?.click();
    await flushUi();

    const nameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="STRIDE Threat Model"]',
    );
    expect(nameInput).not.toBeNull();
    if (nameInput) {
      nameInput.value = "STRIDE Security Audit";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await flushUi();

    const updateLensBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Update Lens",
    );
    updateLensBtn?.click();
    await flushUi();
    expect(container.textContent).toContain("STRIDE Security Audit");

    // 4. Save Settings -> sends custom_lenses to save_settings and syncs customLensesSignal
    const saveSettingsBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".settings-btn"),
    ).find((b) => b.textContent?.includes("Save Settings"));
    saveSettingsBtn?.click();
    await flushUi();

    expect(savedCustomLenses).toHaveLength(1);
    expect(savedCustomLenses[0]?.tag).toBe("threat");
    expect(savedCustomLenses[0]?.name).toBe("STRIDE Security Audit");
    expect(customLensesSignal.value.map((l) => l.tag)).toEqual(["threat"]);
    expect(settingsModalOpen.value).toBe(false);
  });

  it("renders Graph Health Diagnostics, jumps to nodes, marks stale fresh, and queues summaries", async () => {
    const nRoot = makeNode("n_root", "Core Gateway", { x: 100, y: 120 });
    const nLoop = makeNode("n_loop", "Token Replay Risk", {
      type: "loophole",
      severity: "critical",
      x: 500,
      y: 220,
    });
    const nOrphan = makeNode("n_orphan", "Stray Note", { x: 800, y: 400 });
    const nHeavy = makeNode("n_heavy", "Long Spec", { x: 300, y: 500, token_count: 950 });

    loadSnapshot({
      path: "flow.sqlite",
      nodes: [nRoot, nLoop, nOrphan, nHeavy],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_root" },
      token_budget: 6000,
    });

    const animateTo = vi.fn();
    cameraControllerRef.current = {
      setCardLayerEl: () => {},
      markDirty: () => {},
      refreshCull: () => {},
      setCamera: () => {},
      getCamera: () => ({ x: 0, y: 0, zoom: 1, last_focus_id: "n_root" }),
      getViewportSize: () => ({ width: 1200, height: 800 }),
      animateTo,
    };

    const diagPayload: GraphDiagnostics = {
      health_score: 74,
      node_count: 4,
      edge_count: 3,
      total_tokens: 1420,
      pin_count: 1,
      excluded_count: 0,
      unresolved_loopholes: [
        {
          node_id: "n_loop",
          title: "Token Replay Risk",
          type: "loophole",
          severity: "critical",
          detail: "Missing nonce validation",
          token_count: 45,
        },
      ],
      stale_ai_nodes: [
        {
          node_id: "n_root",
          title: "Core Gateway",
          type: "core",
          severity: null,
          detail: "Parent modified",
          token_count: 120,
        },
      ],
      cycles: [{ node_ids: ["n_root", "n_loop"], titles: ["Core Gateway", "Token Replay Risk"] }],
      orphan_nodes: [
        {
          node_id: "n_orphan",
          title: "Stray Note",
          type: "core",
          severity: null,
          detail: "No incident edges",
          token_count: 20,
        },
      ],
      unsummarized_heavy_nodes: [
        {
          node_id: "n_heavy",
          title: "Long Spec",
          type: "core",
          severity: null,
          detail: "Needs summary",
          token_count: 950,
        },
      ],
    };

    const invokeMock = vi.fn(async (cmd: string) => {
      if (cmd === "get_graph_diagnostics") {
        return diagPayload;
      }
      if (cmd === "acknowledge_stale_node") {
        return null;
      }
      if (cmd === "enqueue_stale_summaries") {
        return 1;
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
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

    render(<DiagnosticsModal />, container);
    openDiagnosticsModal();
    await flushUi();

    expect(container.textContent).toContain("Health Score: 74 / 100");
    expect(container.textContent).toContain("Token Replay Risk");
    expect(container.textContent).toContain("Core Gateway → Token Replay Risk");
    expect(container.textContent).toContain("Stray Note");
    expect(container.textContent).toContain("950 tokens");

    // Click Mark Fresh on stale AI node
    const markFreshBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Mark Fresh",
    );
    expect(markFreshBtn).toBeDefined();
    markFreshBtn?.click();
    await flushUi();
    expect(invokeMock).toHaveBeenCalledWith(
      "acknowledge_stale_node",
      { nodeId: "n_root" },
      undefined,
    );

    // Click Queue Summaries
    const queueBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Queue Summaries",
    );
    expect(queueBtn).toBeDefined();
    queueBtn?.click();
    await flushUi();
    expect(invokeMock).toHaveBeenCalledWith("enqueue_stale_summaries", { limit: 64 }, undefined);

    // Click Jump on the first item (n_loop)
    const jumpBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Jump",
    );
    expect(jumpBtn).toBeDefined();
    jumpBtn?.click();
    await flushUi();

    expect(focusId.value).toBe("n_loop");
    expect(animateTo).toHaveBeenCalledTimes(1);
    expect(diagnosticsModalOpen.value).toBe(false);
  });

  it("imports Markdown outline, hydrates graph, pushes 1 undoable entry, and fits camera", async () => {
    const existingRoot = makeNode("n_existing", "Existing Root", { x: 0, y: 0 });
    loadSnapshot({
      path: "flow.sqlite",
      nodes: [existingRoot],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_existing" },
      token_budget: 6000,
    });
    selectSingle("n_existing");

    const animateTo = vi.fn();
    cameraControllerRef.current = {
      setCardLayerEl: () => {},
      markDirty: () => {},
      refreshCull: () => {},
      setCamera: () => {},
      getCamera: () => ({ x: 0, y: 0, zoom: 1, last_focus_id: "n_existing" }),
      getViewportSize: () => ({ width: 1200, height: 800 }),
      animateTo,
    };

    const createdRoot = makeNode("imp_root", "API Design", { x: 420, y: 0 });
    const createdRisk = makeNode("imp_risk", "Rate Limit Bypass", {
      type: "loophole",
      severity: "high",
      x: 840,
      y: 120,
    });
    const createdEdge1 = makeEdge("imp_e1", "n_existing", "imp_root", "derives");
    const createdEdge2 = makeEdge("imp_e2", "imp_risk", "imp_root", "challenges");

    const importResult: ImportOutlineResult = {
      root_id: "imp_root",
      created_nodes: [createdRoot, createdRisk],
      created_edges: [createdEdge1, createdEdge2],
    };

    const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "import_markdown_outline") {
        expect(args?.parentId).toBe("n_existing");
        return importResult;
      }
      if (cmd === "apply_ops") {
        const ops = (args?.ops ?? []) as Array<{ op: string; ids?: string[]; node?: NodeDto; edge?: EdgeDto }>;
        const deletedIds: string[] = [];
        const updatedNodes: NodeDto[] = [];
        for (const op of ops) {
          if (op.op === "delete_nodes" && op.ids) {
            deletedIds.push(...op.ids);
          } else if (op.op === "create_node" && op.node) {
            updatedNodes.push(op.node);
          }
        }
        return {
          updated_nodes: updatedNodes,
          deleted_node_ids: deletedIds,
          deleted_edge_ids: ["imp_e1", "imp_e2"],
        };
      }
      throw new Error(`Unexpected IPC command: ${cmd}`);
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

    render(<OutlineImportModal />, container);
    openOutlineImportModal();
    await flushUi();

    const textarea = container.querySelector<HTMLTextAreaElement>(".settings-textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) return;

    textarea.value = "# API Design\n## Gateway\nRisk: Rate Limit Bypass";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    expect(container.textContent).toContain("2 headings detected");

    const buildBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Build Graph",
    );
    expect(buildBtn).toBeDefined();
    buildBtn?.click();
    await flushUi();

    expect(nodesMap.has("imp_root")).toBe(true);
    expect(nodesMap.has("imp_risk")).toBe(true);
    expect(edgesMap.has("imp_e1")).toBe(true);
    expect(edgesMap.has("imp_e2")).toBe(true);
    expect(focusId.value).toBe("imp_root");
    expect(graphHistory.size()).toBe(1);
    expect(canUndoSignal.value).toBe(true);
    expect(animateTo).toHaveBeenCalledTimes(1);
    expect(outlineImportModalOpen.value).toBe(false);
    expect(toastsSignal.value.some((t) => t.message === "Imported 2 cards")).toBe(true);

    // Single Undo removes both imported nodes & edges
    await performUndo();
    expect(nodesMap.has("imp_root")).toBe(false);
    expect(nodesMap.has("imp_risk")).toBe(false);

    // Single Redo restores them
    await performRedo();
    expect(nodesMap.has("imp_root")).toBe(true);
    expect(nodesMap.has("imp_risk")).toBe(true);
  });
});

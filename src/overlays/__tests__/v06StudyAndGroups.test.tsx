// @vitest-environment jsdom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSceneRects,
  computeGroupBounds,
  getPalette,
  GROUP_PADDING,
  GROUP_TOP_HEADER,
  hitTestGroupHeader,
  renderCanvas2d,
} from "../../canvas/renderer2d";
import type { EdgeDto, NodeDto, StudyCardDto } from "../../ipc/types";
import {
  cameraControllerRef,
  createCanvasGroup,
  deleteCanvasGroup,
  dragOffsets,
  edgesMap,
  groupsMap,
  loadSnapshot,
  mutateGraphUndoable,
  nodesMap,
  performUndo,
  resizeSizes,
  selectedGroupId,
  setTheme,
  theme,
  unresolvedLoopholes,
  updateCanvasGroup,
} from "../../store/graphStore";
import { buildDeleteWithInverse, graphHistory, syncHistorySignals } from "../../store/history";
import {
  clearSelection,
  closeCheckpointsModal,
  closeDiagnosticsModal,
  focusId,
  minimapOpen,
  modalState,
  openCheckpointsModal,
  openDiagnosticsModal,
  selectedIds,
  xrayState,
} from "../../store/selection";
import { closeSettingsModal, openSettingsModal } from "../../store/aiRunner";
import {
  applySm2ReviewLocal,
  closeStudyModal,
  dueStudyCount,
  extractHintFromAnswer,
  interleaveStudyCards,
  openStudyModal,
  studyCards,
  studyCreateFormOpen,
  studyScope,
  syncStudyDeckAction,
  updateStudyCardAction,
} from "../../store/studyStore";
import { createFlowAction, createWorkspaceAction, workspaceCatalog } from "../../store/workspaceCatalogStore";
import { CheckpointsModal } from "../CheckpointsModal";
import { DiagnosticsModal } from "../DiagnosticsModal";
import { SettingsModal } from "../SettingsModal";
import { StudyDeckModal } from "../StudyDeckModal";
import { pushToast, ToastStack, toastsSignal } from "../ToastStack";

function makeNode(
  id: string,
  opts: Partial<{
    type: NodeDto["type"];
    status: NodeDto["status"];
    title: string;
    content: string;
    lens: NodeDto["metadata"]["lens"];
    severity: NodeDto["metadata"]["severity"];
    x: number;
    y: number;
    width: number;
    height: number;
  }> = {},
): NodeDto {
  const title = opts.title ?? id;
  const content = opts.content ?? `Body for ${title}`;
  return {
    id,
    type: opts.type ?? "core",
    status: opts.status ?? "active",
    title,
    content,
    summary: "",
    content_hash: `hash_${id}`,
    summary_hash: "",
    metadata: {
      severity: opts.severity ?? (opts.type === "loophole" ? "high" : null),
      lens: opts.lens ?? "manual",
      created_by: "user",
      model: null,
      token_count: 12,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: {
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      width: opts.width ?? 320,
      height: opts.height ?? 180,
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

function makeStudyCard(overrides: Partial<StudyCardDto> = {}): StudyCardDto {
  return {
    id: "card_1",
    node_id: "n1",
    prompt: "What is quorum intersection?",
    answer: "Any two majorities share at least one node ($W + R > N$).",
    card_kind: "qa",
    repetitions: 0,
    interval_days: 0,
    ease_factor: 2.5,
    lapses: 0,
    due_at: 1_000,
    last_reviewed_at: null,
    created_at: 1_000,
    updated_at: 1_000,
    ...overrides,
  };
}

function createMockCanvasContext(): {
  ctx: CanvasRenderingContext2D;
  fillTextCalls: string[];
  fillTextPositions: Array<{ text: string; x: number; y: number }>;
} {
  const noop = (): void => {};
  const fillTextCalls: string[] = [];
  const fillTextPositions: Array<{ text: string; x: number; y: number }> = [];
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
    strokeRect: noop,
    fillText: (text: string, x: number, y: number) => {
      fillTextCalls.push(text);
      fillTextPositions.push({ text, x, y });
    },
  };
  return {
    ctx: mock as unknown as CanvasRenderingContext2D,
    fillTextCalls,
    fillTextPositions,
  };
}

async function flushUi(ms = 60): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
  await Promise.resolve();
}

describe("v0.6 SM-2 Study Studio, Spatial Canvas Groups & Theme Sync", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage?.clear();
    nodesMap.clear();
    edgesMap.clear();
    groupsMap.value = new Map();
    selectedGroupId.value = null;
    studyCards.value = [];
    studyScope.value = "due";
    studyCreateFormOpen.value = false;
    minimapOpen.value = false;
    closeStudyModal();
    closeSettingsModal();
    closeDiagnosticsModal();
    closeCheckpointsModal();
    clearSelection();
    xrayState.value = null;
    modalState.value = "navigate";
    toastsSignal.value = [];
    cameraControllerRef.current = null;
    graphHistory.clear();
    syncHistorySignals();
    theme.value = "dark";
    document.documentElement.setAttribute("data-theme", "dark");
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    minimapOpen.value = false;
    studyCreateFormOpen.value = false;
    closeStudyModal();
    closeSettingsModal();
    closeDiagnosticsModal();
    closeCheckpointsModal();
    render(null, container);
    container.remove();
    nodesMap.clear();
    edgesMap.clear();
    groupsMap.value = new Map();
    selectedGroupId.value = null;
    studyCards.value = [];
    workspaceCatalog.value = null;
    clearSelection();
    cameraControllerRef.current = null;
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("applySm2ReviewLocal computes exact Again / Hard / Good / Easy intervals and ease bounds", () => {
    const now = 1_700_000_000_000;
    const base = makeStudyCard();

    const again = applySm2ReviewLocal(base, "again", now);
    expect(again.repetitions).toBe(0);
    expect(again.interval_days).toBe(0);
    expect(again.lapses).toBe(1);
    expect(again.ease_factor).toBeCloseTo(2.3, 5);
    expect(again.due_at).toBe(now + 60_000);

    const hard0 = applySm2ReviewLocal(base, "hard", now);
    expect(hard0.repetitions).toBe(1);
    expect(hard0.interval_days).toBe(1);
    expect(hard0.ease_factor).toBeCloseTo(2.35, 5);
    expect(hard0.due_at).toBe(now + 86_400_000);

    const hard1 = applySm2ReviewLocal(hard0, "hard", now);
    expect(hard1.repetitions).toBe(2);
    expect(hard1.interval_days).toBe(3);

    const good0 = applySm2ReviewLocal(base, "good", now);
    expect(good0.repetitions).toBe(1);
    expect(good0.interval_days).toBe(1);

    const good1 = applySm2ReviewLocal(good0, "good", now);
    expect(good1.repetitions).toBe(2);
    expect(good1.interval_days).toBe(6);

    const good2 = applySm2ReviewLocal(good1, "good", now);
    expect(good2.repetitions).toBe(3);
    expect(good2.interval_days).toBe(15);

    const easy0 = applySm2ReviewLocal(base, "easy", now);
    expect(easy0.repetitions).toBe(1);
    expect(easy0.interval_days).toBe(4);
    expect(easy0.ease_factor).toBeCloseTo(2.65, 5);
  });

  it("syncStudyDeckAction extracts @study Q:/A:, @feynman, and active loophole cards and prunes resolved loopholes", async () => {
    loadSnapshot({
      path: "memory://study-sync",
      nodes: [
        makeNode("n_study", {
          title: "Raft Leader Election",
          lens: "study",
          content: "Q: Why use randomized election timeouts?\nA: To prevent split votes from repeating.",
        }),
        makeNode("n_feynman", {
          title: "Consistent Hashing",
          lens: "feynman",
          content: "@feynman Maps keys and nodes onto a hash ring to bound key movement.",
        }),
        makeNode("n_core", {
          title: "Write-Ahead Log",
          content: "Append-only durability log.",
        }),
        makeNode("n_lh", {
          type: "loophole",
          status: "active",
          title: "Unbounded WAL growth",
          content: "Missing compaction checkpoints fills disk.",
          severity: "critical",
        }),
      ],
      edges: [makeEdge("e_ch", "n_lh", "n_core", "challenges")],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_core" },
      token_budget: 6000,
    });

    const synced = await syncStudyDeckAction();
    expect(synced.added_count).toBe(3);
    expect(studyCards.value.map((c) => c.card_kind).sort()).toEqual(["feynman", "loophole", "qa"]);
    expect(dueStudyCount.value).toBe(3);

    const qaCard = studyCards.value.find((c) => c.card_kind === "qa");
    expect(qaCard?.prompt).toBe("Why use randomized election timeouts?");
    expect(qaCard?.answer).toBe("To prevent split votes from repeating.");

    const lhNode = nodesMap.get("n_lh");
    if (lhNode) {
      nodesMap.set("n_lh", { ...lhNode, status: "resolved" });
    }
    const resynced = await syncStudyDeckAction();
    expect(resynced.cards.some((c) => c.card_kind === "loophole")).toBe(false);
    expect(resynced.cards).toHaveLength(2);
  });

  it("StudyDeckModal renders accessible native <dialog>, reveals Markdown/KaTeX answer, grades Good, and jumps to source node", async () => {
    const animateTo = vi.fn();
    cameraControllerRef.current = {
      setCardLayerEl: vi.fn(),
      markDirty: vi.fn(),
      refreshCull: vi.fn(),
      setCamera: vi.fn(),
      getCamera: () => ({ x: 0, y: 0, zoom: 1, last_focus_id: "n_study" }),
      getViewportSize: () => ({ width: 1280, height: 800 }),
      animateTo,
    };

    loadSnapshot({
      path: "memory://study-modal",
      nodes: [
        makeNode("n_study", {
          title: "Quorum Math",
          lens: "study",
          content: "Q: What condition guarantees quorum overlap?\nA: Ensure $W + R > N$.",
          x: 400,
          y: 250,
        }),
      ],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: null },
      token_budget: 6000,
    });

    render(<StudyDeckModal />, container);
    await openStudyModal("due", "n_study");
    await flushUi();

    const dialog = container.querySelector<HTMLDialogElement>("dialog.study-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBeNull();
    expect(dialog?.getAttribute("closedby")).toBe("any");
    expect(dialog?.getAttribute("aria-labelledby")).toBe("study-dialog-title");
    expect(container.querySelector("h1#study-dialog-title")?.textContent).toContain(
      "Study & Recall Studio",
    );

    const revealBtn = container.querySelector<HTMLButtonElement>('[data-study-action="reveal"]');
    expect(revealBtn).not.toBeNull();
    revealBtn?.click();
    await flushUi();

    const answerFace = container.querySelector(".study-card-face__answer");
    expect(answerFace?.innerHTML).toContain("katex");

    const goodBtn = container.querySelector<HTMLButtonElement>(".study-grade-btn--good");
    expect(goodBtn).not.toBeNull();
    goodBtn?.click();
    await flushUi();

    expect(studyCards.value[0]?.repetitions).toBe(1);
    expect(studyCards.value[0]?.interval_days).toBe(1);
    expect(dueStudyCount.value).toBe(0);

    const flowTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".study-dialog__tab")).find(
      (btn) => btn.textContent?.includes("Current Flow"),
    );
    flowTab?.click();
    await flushUi();

    const jumpBtn = container.querySelector<HTMLButtonElement>(".study-jump-btn");
    expect(jumpBtn).not.toBeNull();
    jumpBtn?.click();
    await flushUi();

    expect(focusId.value).toBe("n_study");
    expect(animateTo).toHaveBeenCalledTimes(1);
  });

  it("computeGroupBounds, hitTestGroupHeader, createCanvasGroup, node-deletion pruning, and undo work cleanly", async () => {
    loadSnapshot({
      path: "memory://groups",
      nodes: [
        makeNode("n1", { title: "Node 1", x: 100, y: 100, width: 320, height: 180 }),
        makeNode("n2", { title: "Node 2", x: 500, y: 200, width: 320, height: 180 }),
      ],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n1" },
      token_budget: 6000,
    });

    const created = await createCanvasGroup(["n1", "n2"], "Consensus", "emerald");
    expect(created).not.toBeNull();
    if (!created) return;
    expect(groupsMap.value.size).toBe(1);
    expect(selectedGroupId.value).toBe(created.id);

    const rects = buildSceneRects(nodesMap, dragOffsets, resizeSizes);
    const bounds = computeGroupBounds(created, rects);
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBe(100 - GROUP_PADDING);
    expect(bounds?.y).toBe(100 - GROUP_PADDING - GROUP_TOP_HEADER);
    expect(bounds?.w).toBe(720 + GROUP_PADDING * 2);
    expect(bounds?.h).toBe(280 + GROUP_PADDING * 2 + GROUP_TOP_HEADER);
    expect(bounds?.memberCount).toBe(2);

    const hit = hitTestGroupHeader({ x: 120, y: 48 }, groupsMap.value, rects, 1.0);
    expect(hit?.id).toBe(created.id);
    const miss = hitTestGroupHeader({ x: 120, y: 150 }, groupsMap.value, rects, 1.0);
    expect(miss).toBeNull();

    await updateCanvasGroup(created.id, { title: "Quorum Group", color_key: "violet" });
    expect(groupsMap.value.get(created.id)?.title).toBe("Quorum Group");
    expect(groupsMap.value.get(created.id)?.color_key).toBe("violet");

    const delEntry = buildDeleteWithInverse(["n2"], nodesMap, edgesMap, groupsMap.value);
    await mutateGraphUndoable("Delete n2", delEntry.forward, delEntry.inverse);
    expect(nodesMap.has("n2")).toBe(false);
    expect(groupsMap.value.get(created.id)?.member_ids).toEqual(["n1"]);

    await performUndo();
    expect(nodesMap.has("n2")).toBe(true);
    expect(groupsMap.value.get(created.id)?.member_ids).toEqual(["n1", "n2"]);

    await deleteCanvasGroup(created.id);
    expect(groupsMap.value.size).toBe(0);
    expect(selectedGroupId.value).toBeNull();
    expect(nodesMap.has("n1")).toBe(true);
    expect(nodesMap.has("n2")).toBe(true);
  });

  it("synchronizes data-theme attribute before reading Canvas2D palette and renders groups", async () => {
    const markDirty = vi.fn();
    cameraControllerRef.current = {
      setCardLayerEl: vi.fn(),
      markDirty,
      refreshCull: vi.fn(),
      setCamera: vi.fn(),
      getCamera: () => ({ x: 0, y: 0, zoom: 1, last_focus_id: null }),
      getViewportSize: () => ({ width: 1280, height: 800 }),
      animateTo: vi.fn(),
    };

    document.documentElement.setAttribute("data-theme", "dark");
    const lightPalette = getPalette("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(lightPalette.bgCanvas).toBe("#eef1f5");

    setTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(markDirty).toHaveBeenCalledTimes(1);

    loadSnapshot({
      path: "memory://render-groups",
      nodes: [
        makeNode("n1", { title: "Alpha", x: 50, y: 60 }),
        makeNode("n2", { title: "Beta", x: 420, y: 60 }),
      ],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n1" },
      token_budget: 6000,
    });
    await createCanvasGroup(["n1", "n2"], "Replication", "cobalt");

    const { ctx, fillTextCalls } = createMockCanvasContext();
    renderCanvas2d(ctx, {
      cam: { x: 0, y: 0, zoom: 1, last_focus_id: "n1" },
      width: 1280,
      height: 800,
      nodes: nodesMap,
      edges: edgesMap,
      dragOffsets,
      resizeSizes,
      selectedIds: selectedIds.value,
      focusId: focusId.value,
      xrayState: null,
      unresolvedLoopholes: unresolvedLoopholes.value,
      marqueeWorld: null,
      edgePreviewWorld: null,
      groups: groupsMap.value,
      selectedGroupId: selectedGroupId.value,
      themeKey: "dark",
    });

    expect(fillTextCalls.some((label) => label.includes("Replication · 2"))).toBe(true);
  });

  it("offsets overlapping Canvas2D group chips horizontally and hitTestGroupHeader picks the cascaded chip", async () => {
    loadSnapshot({
      path: "memory://overlapping-groups",
      nodes: [
        makeNode("n1", { title: "Alpha", x: 100, y: 100 }),
        makeNode("n2", { title: "Beta", x: 460, y: 100 }),
      ],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n1" },
      token_budget: 6000,
    });

    const g1 = await createCanvasGroup(["n1", "n2"], "Consensus", "emerald");
    const g2 = await createCanvasGroup(["n1", "n2"], "Quorum", "cobalt");
    expect(g1).not.toBeNull();
    expect(g2).not.toBeNull();
    if (!g1 || !g2) return;

    const { ctx, fillTextPositions } = createMockCanvasContext();
    renderCanvas2d(ctx, {
      cam: { x: 0, y: 0, zoom: 1, last_focus_id: "n1" },
      width: 1280,
      height: 800,
      nodes: nodesMap,
      edges: edgesMap,
      dragOffsets,
      resizeSizes,
      selectedIds: selectedIds.value,
      focusId: focusId.value,
      xrayState: null,
      unresolvedLoopholes: unresolvedLoopholes.value,
      marqueeWorld: null,
      edgePreviewWorld: null,
      groups: groupsMap.value,
      selectedGroupId: selectedGroupId.value,
      themeKey: "dark",
    });

    const firstChip = fillTextPositions.find((p) => p.text === "Consensus · 2");
    const secondChip = fillTextPositions.find((p) => p.text === "Quorum · 2");
    expect(firstChip).toBeDefined();
    expect(secondChip).toBeDefined();
    if (!firstChip || !secondChip) return;

    expect(secondChip.x).toBeGreaterThan(firstChip.x + 40);

    const rects = buildSceneRects(nodesMap, dragOffsets, resizeSizes);
    const hitFirst = hitTestGroupHeader({ x: firstChip.x + 8, y: firstChip.y }, groupsMap.value, rects, 1.0);
    const hitSecond = hitTestGroupHeader({ x: secondChip.x + 8, y: secondChip.y }, groupsMap.value, rects, 1.0);
    expect(hitFirst?.id).toBe(g1.id);
    expect(hitSecond?.id).toBe(g2.id);
  });

  it("supports 3-tab switching in SettingsModal across General, Providers & Models, and Prompt & Lenses", async () => {
    render(<SettingsModal />, container);
    openSettingsModal();
    await flushUi();

    const getTabs = (): HTMLButtonElement[] =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-modal__tabs [role="tab"]'));

    expect(getTabs().map((t) => t.textContent?.trim())).toEqual([
      "General",
      "Providers & Models",
      "Prompt & Lenses",
    ]);
    expect(getTabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("autosaves 1.5s after edits");
    expect(container.textContent).toContain("Animate connection flow along edges");
    expect(container.querySelector(".settings-textarea")).toBeNull();

    getTabs()[1]?.click();
    await flushUi();
    expect(getTabs()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Reasoning Tier (AI Lenses)");
    expect(container.textContent).toContain("Utility Tier (Background Summaries)");

    getTabs()[2]?.click();
    await flushUi();
    expect(getTabs()[2]?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".settings-textarea")).not.toBeNull();
    expect(container.textContent).toContain("Custom Lenses (@tags)");
  });

  it("traps Tab and Shift+Tab inside DiagnosticsModal and CheckpointsModal without leaking to canvas controls", async () => {
    const outsideBtn = document.createElement("button");
    outsideBtn.className = "canvas-controls__btn";
    outsideBtn.textContent = "Zoom";
    document.body.appendChild(outsideBtn);

    try {
      render(
        <>
          <DiagnosticsModal />
          <CheckpointsModal />
        </>,
        container,
      );

      outsideBtn.focus();
      openDiagnosticsModal();
      await flushUi();

      const diagDialog = container.querySelector<HTMLElement>('[aria-label="Graph Health Diagnostics"]');
      expect(diagDialog).not.toBeNull();
      expect(diagDialog?.contains(document.activeElement)).toBe(true);

      const diagButtons = Array.from(
        diagDialog?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
      );
      expect(diagButtons.length).toBeGreaterThanOrEqual(2);
      const diagFirst = diagButtons[0]!;
      const diagLast = diagButtons[diagButtons.length - 1]!;

      diagLast.focus();
      const wrapForward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      window.dispatchEvent(wrapForward);
      expect(wrapForward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(diagFirst);

      const wrapBackward = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(wrapBackward);
      expect(wrapBackward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(diagLast);

      closeDiagnosticsModal();
      await flushUi();
      expect(document.activeElement).toBe(outsideBtn);

      openCheckpointsModal();
      await flushUi();
      const cpDialog = container.querySelector<HTMLElement>('[aria-label="Checkpoints & Graph Diff"]');
      expect(cpDialog).not.toBeNull();
      expect(cpDialog?.contains(document.activeElement)).toBe(true);

      const cpFocusables = Array.from(
        cpDialog?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? [],
      );
      expect(cpFocusables.length).toBeGreaterThanOrEqual(1);
      cpFocusables[cpFocusables.length - 1]?.focus();
      const cpWrap = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      window.dispatchEvent(cpWrap);
      expect(cpWrap.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(cpFocusables[0]);
    } finally {
      outsideBtn.remove();
    }
  });

  it("lifts ToastStack above minimap with toast-stack--above-minimap when minimapOpen is true", async () => {
    render(<ToastStack />, container);
    pushToast("Saved workspace", "info");
    await flushUi();

    const stack = container.querySelector<HTMLElement>(".toast-stack");
    expect(stack).not.toBeNull();
    expect(stack?.classList.contains("toast-stack--above-minimap")).toBe(false);

    minimapOpen.value = true;
    await flushUi();
    expect(stack?.classList.contains("toast-stack--above-minimap")).toBe(true);

    minimapOpen.value = false;
    await flushUi();
    expect(stack?.classList.contains("toast-stack--above-minimap")).toBe(false);
  });

  it("omits duplicate + New Card button in StudyDeckModal empty state and closes form then dialog on Esc", async () => {
    render(<StudyDeckModal />, container);
    await openStudyModal("due", null);
    await flushUi();

    expect(container.querySelector(".study-dialog__header-actions")?.textContent).not.toContain(
      "+ New Card",
    );
    const createCta = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes("+ Create Flashcard"),
    );
    expect(createCta).toBeDefined();
    createCta?.click();
    await flushUi();

    expect(studyCreateFormOpen.value).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await flushUi();
    expect(studyCreateFormOpen.value).toBe(false);
    expect(container.querySelector("dialog.study-dialog[open]")).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await flushUi();
    expect(container.querySelector("dialog.study-dialog[open]")).toBeNull();
  });

  it("extractHintFromAnswer and interleaveStudyCards are pure, non-spoiling, and deterministic", () => {
    expect(extractHintFromAnswer("")).toBe("");
    expect(extractHintFromAnswer("Yes")).toBe("");

    const katexShort = extractHintFromAnswer("Ensure $W + R > N$.");
    expect(katexShort).toBe("Ensure...");
    expect((katexShort.match(/\$/g) ?? []).length % 2).toBe(0);

    const multiItem = extractHintFromAnswer(
      "1. Confirm laminar Re < 2300 before Hagen-Poiseuille.\n2. Integrate shell momentum balance.\n3. Check wall shear units.",
    );
    expect(multiItem.startsWith("1/3:")).toBe(true);
    expect(multiItem).not.toContain("Integrate shell momentum");

    const feynmanHint = extractHintFromAnswer(
      "**Causal Mechanism:** Viscous shear dissipates kinetic energy along the boundary layer.\n\n**Governing Rule:** $\\Delta P = f \\frac{L}{D} \\frac{\\rho v^2}{2}$",
    );
    expect(feynmanHint).toContain("Causal Mechanism:");
    expect(feynmanHint).not.toContain("\\Delta P");

    const deck: StudyCardDto[] = [
      makeStudyCard({ id: "c1", node_id: "n1", card_kind: "qa" }),
      makeStudyCard({ id: "c2", node_id: "n1", card_kind: "feynman" }),
      makeStudyCard({ id: "c3", node_id: "n2", card_kind: "qa" }),
      makeStudyCard({ id: "c4", node_id: "n2", card_kind: "loophole" }),
      makeStudyCard({ id: "c5", node_id: "n3", card_kind: "manual" }),
    ];

    const runA1 = interleaveStudyCards(deck, 42);
    const runA2 = interleaveStudyCards(deck, 42);
    expect(runA1.map((c) => c.id)).toEqual(runA2.map((c) => c.id));
    expect(runA1.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    for (let i = 1; i < runA1.length; i += 1) {
      expect(runA1[i]?.node_id).not.toBe(runA1[i - 1]?.node_id);
    }
  });

  it("updateStudyCardAction edits prompt/answer while preserving SM-2 state and rejecting blanks", async () => {
    loadSnapshot({
      path: "memory://study-edit",
      nodes: [
        makeNode("n_study", {
          title: "Reynolds Number",
          lens: "study",
          content: "Q: When does pipe flow stay laminar?\nA: For $Re < 2300$.",
        }),
      ],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_study" },
      token_budget: 6000,
    });

    await syncStudyDeckAction();
    const original = studyCards.value[0]!;
    const reviewed = applySm2ReviewLocal(
      applySm2ReviewLocal(original, "good", 1_700_000_000_000),
      "good",
      1_700_086_400_000,
    );
    window.localStorage?.setItem(
      `axiom_study_cards_v1_${workspaceCatalog.value?.active_flow_id || "memory://study-edit"}`,
      JSON.stringify([reviewed]),
    );
    studyCards.value = [reviewed];

    const updated = await updateStudyCardAction(
      reviewed.id,
      "  When does Newtonian pipe flow stay laminar?  ",
      "  When dimensionless $Re = \\rho v D / \\mu < 2300$.  ",
    );

    expect(updated.prompt).toBe("When does Newtonian pipe flow stay laminar?");
    expect(updated.answer).toBe("When dimensionless $Re = \\rho v D / \\mu < 2300$.");
    expect(updated.repetitions).toBe(2);
    expect(updated.interval_days).toBe(6);
    expect(updated.due_at).toBe(reviewed.due_at);
    expect(updated.ease_factor).toBeCloseTo(reviewed.ease_factor, 5);
    expect(updated.node_id).toBe("n_study");

    await expect(updateStudyCardAction(reviewed.id, "   ", "Valid")).rejects.toThrow(
      "Study card prompt cannot be empty",
    );
    await expect(updateStudyCardAction(reviewed.id, "Valid", "  ")).rejects.toThrow(
      "Study card answer cannot be empty",
    );
  });

  it("StudyDeckModal supports live tab counts, Hint (H), Write attempt (A) comparison, Interleave, inline Edit, and session summary", async () => {
    loadSnapshot({
      path: "memory://study-studio-polish",
      nodes: [
        makeNode("n1", {
          title: "Hagen-Poiseuille",
          lens: "study",
          content:
            "Q: What flow regime is required for Hagen-Poiseuille?\nA: Steady, incompressible, fully developed laminar Newtonian flow ($Re < 2300$).",
        }),
        makeNode("n2", {
          title: "Fourier Conduction",
          lens: "feynman",
          content:
            "@feynman Heat flux is proportional to the negative temperature gradient along the thermal path.",
        }),
      ],
      edges: [makeEdge("e1", "n1", "n2", "derives")],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n1" },
      token_budget: 6000,
    });

    render(<StudyDeckModal />, container);
    await openStudyModal("due", "n1");
    await flushUi();

    const tabTexts = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".study-dialog__tab"),
    ).map((b) => b.textContent?.trim());
    expect(tabTexts).toEqual(["Due Now (2)", "Current Flow (2)", "Focused Subtree (2)"]);

    const interleaveBtn = container.querySelector<HTMLButtonElement>(".study-interleave-btn");
    expect(interleaveBtn?.getAttribute("aria-pressed")).toBe("false");
    interleaveBtn?.click();
    await flushUi();
    expect(interleaveBtn?.getAttribute("aria-pressed")).toBe("true");

    const hintBtn = Array.from(container.querySelectorAll<HTMLButtonElement>(".study-secondary-btn")).find(
      (b) => b.textContent?.includes("Hint"),
    );
    expect(hintBtn).toBeDefined();
    hintBtn?.click();
    await flushUi();
    expect(container.querySelector(".study-hint-box")).not.toBeNull();
    expect(dueStudyCount.value).toBe(2);

    // Edit inline and verify form saves cleanly while preserving SM-2 state.
    const editBtn = container.querySelector<HTMLButtonElement>(".study-edit-btn");
    expect(editBtn).not.toBeNull();
    editBtn?.click();
    await flushUi();

    const promptInput = container.querySelector<HTMLInputElement>("#study-form-prompt");
    expect(promptInput).not.toBeNull();
    if (promptInput) {
      promptInput.value = `${promptInput.value} [Edited]`;
      promptInput.dispatchEvent(new Event("input", { bubbles: true }));
      await flushUi();
    }
    const form = container.querySelector<HTMLFormElement>(".study-create-form");
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushUi();
    expect(container.textContent).toContain("[Edited]");

    const attemptBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".study-secondary-btn"),
    ).find((b) => b.textContent?.includes("Write attempt"));
    expect(attemptBtn).toBeDefined();
    attemptBtn?.click();
    await flushUi();

    const attemptTextarea = container.querySelector<HTMLTextAreaElement>("#study-attempt-textarea");
    expect(attemptTextarea).not.toBeNull();
    if (attemptTextarea) {
      attemptTextarea.value = "My closed-book derivation note";
      attemptTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await flushUi();

    const revealBtn = container.querySelector<HTMLButtonElement>('[data-study-action="reveal"]');
    revealBtn?.click();
    await flushUi();

    expect(container.querySelector(".study-card-face--attempt")?.textContent).toContain(
      "My closed-book derivation note",
    );

    const goodBtn = container.querySelector<HTMLButtonElement>(".study-grade-btn--good");
    goodBtn?.click();
    await flushUi();

    expect(container.querySelector(".study-session-summary")?.textContent).toContain(
      "Session: 1 reviewed · 1 strong",
    );
    expect(container.querySelector("#study-attempt-textarea")).toBeNull();
  });

  it("study flow template seeds actionable @feynman & @study nodes that extract 2 starter flashcards", async () => {
    workspaceCatalog.value = null;
    const ws = await createWorkspaceAction("Engineering Study");
    expect(ws).not.toBeNull();
    if (!ws) return;

    const flowRes = await createFlowAction(ws.id, "Fluid Mechanics", "study");
    expect(flowRes).not.toBeNull();
    expect(nodesMap.size).toBe(3);
    expect(edgesMap.size).toBe(2);

    const synced = await syncStudyDeckAction();
    expect(synced.added_count).toBe(2);
    expect(synced.cards).toHaveLength(2);
    expect(synced.cards.map((c) => c.card_kind).sort()).toEqual(["feynman", "qa"]);

    const feynmanCard = synced.cards.find((c) => c.card_kind === "feynman");
    expect(feynmanCard).toBeDefined();
    if (feynmanCard) {
      const hint = extractHintFromAnswer(feynmanCard.answer);
      expect(hint).not.toContain("@feynman");
      expect(hint.startsWith("First principles")).toBe(true);

      await updateStudyCardAction(
        feynmanCard.id,
        "First-Principles Breakdown (Exam Check)",
        feynmanCard.answer,
      );
      const resynced = await syncStudyDeckAction();
      expect(resynced.cards.find((c) => c.id === feynmanCard.id)?.prompt).toBe(
        "First-Principles Breakdown (Exam Check)",
      );
    }
  });

  it("StudyDeckModal supports Again in-session re-queue, non-destructive step nav, Ctrl+Enter reveal, inline validation, and two-step delete", async () => {
    loadSnapshot({
      path: "memory://study-ux-polish",
      nodes: [
        makeNode("n_a", {
          title: "Card Alpha",
          lens: "study",
          content: "Q: Define VSWR.\nA: $SWR = (1+|\\Gamma|)/(1-|\\Gamma|)$.",
        }),
        makeNode("n_b", {
          title: "Card Beta",
          lens: "study",
          content: "Q: What causes ringing in a step response?\nA: Underdamped poles ($0 < \\zeta < 1$).",
        }),
      ],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_a" },
      token_budget: 6000,
    });

    render(<StudyDeckModal />, container);
    await openStudyModal("due", "n_a");
    await flushUi();

    expect(container.querySelector('.study-progress[role="progressbar"]')).not.toBeNull();
    const firstCounter = container.querySelector(".study-counter")?.textContent?.trim();
    expect(firstCounter).toBe("1 of 2");

    // Non-destructive browse via Next button & '[' / ']' keys
    const nextBtn = container.querySelector<HTMLButtonElement>('.study-step-btn[aria-label="Next card"]');
    expect(nextBtn).not.toBeNull();
    nextBtn?.click();
    await flushUi();
    expect(container.querySelector(".study-counter")?.textContent?.trim()).toBe("2 of 2");

    const dialog = container.querySelector<HTMLDialogElement>("dialog.study-dialog");
    dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "[", bubbles: true, cancelable: true }));
    await flushUi();
    expect(container.querySelector(".study-counter")?.textContent?.trim()).toBe("1 of 2");

    // Ctrl+Enter inside attempt scratchpad reveals answer + shows plain-language SM-2 status
    dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    await flushUi();
    const attemptBox = container.querySelector<HTMLTextAreaElement>("#study-attempt-textarea");
    expect(attemptBox).not.toBeNull();
    if (attemptBox) {
      attemptBox.value = "Ratio of Vmax to Vmin";
      attemptBox.dispatchEvent(new Event("input", { bubbles: true }));
      attemptBox.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    }
    await flushUi();
    expect(container.querySelector(".study-card-face--attempt")?.textContent).toContain(
      "Ratio of Vmax to Vmin",
    );
    expect(container.querySelector(".study-sm2-stats")?.textContent).toContain(
      "New card · First review",
    );

    // Grading Again keeps missed card at the back of Due Now with Re-learn badge
    container.querySelector<HTMLButtonElement>(".study-grade-btn--again")?.click();
    await flushUi();
    expect(container.querySelector(".study-session-summary")?.textContent).toContain("1 again");
    expect(container.querySelector(".study-dialog__tab")?.textContent?.trim()).toBe("Due Now (2)");

    // Grade second card Good -> leaves only the Re-learn card
    container.querySelector<HTMLButtonElement>('[data-study-action="reveal"]')?.click();
    await flushUi();
    container.querySelector<HTMLButtonElement>(".study-grade-btn--good")?.click();
    await flushUi();
    expect(container.querySelector(".study-relearn-badge")?.textContent).toBe("Re-learn");
    expect(container.querySelector(".study-dialog__tab")?.textContent?.trim()).toBe("Due Now (1)");

    // Complete Re-learn card -> removes it from relearnIds cleanly
    container.querySelector<HTMLButtonElement>('[data-study-action="reveal"]')?.click();
    await flushUi();
    container.querySelector<HTMLButtonElement>(".study-grade-btn--good")?.click();
    await flushUi();
    expect(container.querySelector(".study-empty__title")?.textContent).toContain("All due cards reviewed");

    // Switch to Current Flow, test Create Card blank validation + direct click submit + two-step delete
    const flowTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".study-dialog__tab")).find(
      (b) => b.textContent?.includes("Current Flow"),
    );
    flowTab?.click();
    await flushUi();

    const newCardBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("+ New Card"),
    );
    newCardBtn?.click();
    await flushUi();

    const submitBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Create Card",
    );
    submitBtn?.click();
    await flushUi();
    expect(container.querySelector('.study-form-error[role="alert"]')?.textContent).toContain(
      "Enter a question or prompt",
    );

    const pInput = container.querySelector<HTMLInputElement>("#study-form-prompt")!;
    const aInput = container.querySelector<HTMLTextAreaElement>("#study-form-answer")!;
    pInput.value = "Manual Z0 Check";
    pInput.dispatchEvent(new Event("input", { bubbles: true }));
    aInput.value = "$Z_0 = 50\\,\\Omega$.";
    aInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    submitBtn?.click();
    await flushUi();
    expect(studyCreateFormOpen.value).toBe(false);
    expect(container.textContent).toContain("Manual Z0 Check");

    // Two-step delete: first click arms Delete?, Escape disarms without closing dialog, two clicks deletes
    const delBtn = container.querySelector<HTMLButtonElement>(".study-delete-btn");
    delBtn?.click();
    await flushUi();
    expect(delBtn?.textContent).toBe("Delete?");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await flushUi();
    expect(container.querySelector("dialog.study-dialog[open]")).not.toBeNull();
    expect(container.querySelector(".study-delete-btn")?.textContent).toBe("🗑");

    container.querySelector<HTMLButtonElement>(".study-delete-btn")?.click();
    await flushUi();
    container.querySelector<HTMLButtonElement>(".study-delete-btn")?.click();
    await flushUi();
    expect(container.textContent).not.toContain("Manual Z0 Check");
  });
});

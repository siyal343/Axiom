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
  openStudyModal,
  studyCards,
  studyCreateFormOpen,
  studyScope,
  syncStudyDeckAction,
} from "../../store/studyStore";
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
});

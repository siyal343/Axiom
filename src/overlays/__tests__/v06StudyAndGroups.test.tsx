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
import { clearSelection, focusId, modalState, selectedIds, xrayState } from "../../store/selection";
import {
  applySm2ReviewLocal,
  closeStudyModal,
  dueStudyCount,
  openStudyModal,
  studyCards,
  studyScope,
  syncStudyDeckAction,
} from "../../store/studyStore";
import { StudyDeckModal } from "../StudyDeckModal";
import { toastsSignal } from "../ToastStack";

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
} {
  const noop = (): void => {};
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
    strokeRect: noop,
    fillText: (text: string) => {
      fillTextCalls.push(text);
    },
  };
  return {
    ctx: mock as unknown as CanvasRenderingContext2D,
    fillTextCalls,
  };
}

async function flushUi(ms = 30): Promise<void> {
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
    closeStudyModal();
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
    closeStudyModal();
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
});

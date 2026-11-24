import { signal } from "@preact/signals";
import { worldToScreen } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import {
  cancelRun as cancelRunIpc,
  isTauriRuntime,
  parseIpcError,
  runLens as runLensIpc,
} from "../ipc/client";
import type {
  EdgeDto,
  GraphOp,
  LensKind,
  LensStreamEvent,
  NodeDto,
  SummaryUpdatedEvent,
} from "../ipc/types";
import { pushToast } from "../overlays/ToastStack";
import {
  cameraControllerRef,
  edgesMap,
  graphVersion,
  nodesMap,
  recomputeUnresolvedLoopholes,
  viewportSpatialIndex,
} from "./graphStore";
import { graphHistory, syncHistorySignals } from "./history";
import {
  commandPaletteOpen,
  edgePopover,
  focusId,
  hoveredId,
  modalState,
  selectedIds,
  selectSingle,
  shortcutsHelpOpen,
} from "./selection";

export const activeRunId = signal<string | null>(null);
export const activeRunLens = signal<LensKind | null>(null);
export const customPromptOpen = signal<boolean>(false);
export const settingsModalOpen = signal<boolean>(false);
export const triageBanner = signal<string | null>(null);

interface ActiveRunTracker {
  lens: LensKind | null;
  startFocusId: string | null;
  spawnedNodes: Map<string, NodeDto>;
  spawnedEdges: EdgeDto[];
  pendingDeltas: Map<string, string>;
  flushScheduled: boolean;
}

const tracker: ActiveRunTracker = {
  lens: null,
  startFocusId: null,
  spawnedNodes: new Map(),
  spawnedEdges: [],
  pendingDeltas: new Map(),
  flushScheduled: false,
};

let triageTimer: ReturnType<typeof setTimeout> | null = null;

function clearTriageTimer(): void {
  if (triageTimer !== null) {
    clearTimeout(triageTimer);
    triageTimer = null;
  }
}

export function dismissTriageBanner(): void {
  clearTriageTimer();
  triageBanner.value = null;
}

function showTriageBanner(): void {
  clearTriageTimer();
  triageBanner.value = "Triage: J/K step · R resolve · Tab fix · Backspace dismiss";
  triageTimer = setTimeout(() => {
    triageBanner.value = null;
    triageTimer = null;
  }, 8000);
}

function ensureNodeInView(nodeId: string): void {
  const ctrl = cameraControllerRef.current;
  const node = nodesMap.get(nodeId);
  if (!ctrl || !node) {
    return;
  }
  const cam = ctrl.getCamera();
  const { width, height } = ctrl.getViewportSize();
  const tl = worldToScreen(node.layout.x, node.layout.y, cam);
  const br = worldToScreen(
    node.layout.x + node.layout.width,
    node.layout.y + getEffectiveNodeHeight(node),
    cam,
  );
  const margin = 80;
  if (tl.x < margin || tl.y < margin || br.x > width - margin || br.y > height - margin) {
    const cx = node.layout.x + node.layout.width / 2;
    const cy = node.layout.y + getEffectiveNodeHeight(node) / 2;
    ctrl.animateTo(
      {
        x: width / 2 - cx * cam.zoom,
        y: height / 2 - cy * cam.zoom,
        zoom: cam.zoom,
      },
      220,
    );
  }
}

export function flushPendingTokenDeltas(): void {
  tracker.flushScheduled = false;
  if (tracker.pendingDeltas.size === 0) {
    return;
  }
  let changed = false;
  for (const [nodeId, delta] of tracker.pendingDeltas.entries()) {
    const existing = nodesMap.get(nodeId);
    if (existing) {
      const updated: NodeDto = {
        ...existing,
        content: existing.content + delta,
      };
      nodesMap.set(nodeId, updated);
      if (tracker.spawnedNodes.has(nodeId)) {
        tracker.spawnedNodes.set(nodeId, updated);
      }
      changed = true;
    }
  }
  tracker.pendingDeltas.clear();
  if (changed) {
    graphVersion.value += 1;
    cameraControllerRef.current?.markDirty();
  }
}

function scheduleDeltaFlush(): void {
  if (tracker.flushScheduled) {
    return;
  }
  tracker.flushScheduled = true;
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => flushPendingTokenDeltas());
  } else {
    setTimeout(() => flushPendingTokenDeltas(), 16);
  }
}

export function resetRunTracker(lens: LensKind | null = null, startFocus: string | null = null): void {
  tracker.lens = lens;
  tracker.startFocusId = startFocus;
  tracker.spawnedNodes.clear();
  tracker.spawnedEdges = [];
  tracker.pendingDeltas.clear();
  tracker.flushScheduled = false;
}

export function handleLensStreamEvent(evt: LensStreamEvent): void {
  switch (evt.kind) {
    case "skeleton_spawned": {
      nodesMap.set(evt.node.id, evt.node);
      for (const edge of evt.edges) {
        edgesMap.set(edge.id, edge);
      }
      viewportSpatialIndex.upsert(evt.node);
      tracker.spawnedNodes.set(evt.node.id, evt.node);
      tracker.spawnedEdges.push(...evt.edges);
      recomputeUnresolvedLoopholes();
      graphVersion.value += 1;
      cameraControllerRef.current?.refreshCull();
      cameraControllerRef.current?.markDirty();
      break;
    }
    case "token_delta": {
      const prev = tracker.pendingDeltas.get(evt.node_id) ?? "";
      tracker.pendingDeltas.set(evt.node_id, prev + evt.chunk);
      scheduleDeltaFlush();
      break;
    }
    case "node_finalized": {
      tracker.pendingDeltas.delete(evt.node.id);
      nodesMap.set(evt.node.id, evt.node);
      viewportSpatialIndex.upsert(evt.node);
      tracker.spawnedNodes.set(evt.node.id, evt.node);
      recomputeUnresolvedLoopholes();
      graphVersion.value += 1;
      cameraControllerRef.current?.refreshCull();
      cameraControllerRef.current?.markDirty();
      break;
    }
    case "run_completed": {
      flushPendingTokenDeltas();
      const completedLens = tracker.lens;
      const startFocus = tracker.startFocusId;
      const spawnedNodes = Array.from(tracker.spawnedNodes.values());
      const spawnedEdges = [...tracker.spawnedEdges];

      activeRunId.value = null;
      activeRunLens.value = null;
      resetRunTracker();

      if (spawnedNodes.length > 0) {
        const forward: GraphOp[] = [
          ...spawnedNodes.map((node): GraphOp => ({ op: "create_node", node })),
          ...spawnedEdges.map((edge): GraphOp => ({ op: "create_edge", edge })),
        ];
        const inverse: GraphOp[] = [{ op: "delete_nodes", ids: evt.spawned_ids }];
        graphHistory.push({
          label: `AI ${completedLens ?? "lens"}`,
          forward,
          inverse,
        });
        syncHistorySignals();
      }

      if (
        completedLens === "red_team" &&
        evt.spawned_ids.length > 0 &&
        focusId.value === startFocus
      ) {
        const firstId = evt.spawned_ids[0];
        if (firstId) {
          selectSingle(firstId);
          ensureNodeInView(firstId);
          showTriageBanner();
        }
      }
      break;
    }
    case "run_error": {
      flushPendingTokenDeltas();
      activeRunId.value = null;
      activeRunLens.value = null;
      resetRunTracker();

      if (evt.code === "PROVIDER_AUTH") {
        pushToast(evt.message, "error", {
          label: "Open Settings",
          onClick: openSettingsModal,
        });
      } else {
        pushToast(evt.message, "error");
      }
      break;
    }
  }
}

export function openCustomPromptBar(): void {
  edgePopover.value = null;
  hoveredId.value = null;
  commandPaletteOpen.value = false;
  settingsModalOpen.value = false;
  customPromptOpen.value = true;
  modalState.value = "command";
}

export function closeCustomPromptBar(): void {
  customPromptOpen.value = false;
  if (modalState.value === "command" && !commandPaletteOpen.value && !settingsModalOpen.value) {
    modalState.value = "navigate";
  }
}

export function openSettingsModal(): void {
  edgePopover.value = null;
  hoveredId.value = null;
  shortcutsHelpOpen.value = false;
  commandPaletteOpen.value = false;
  customPromptOpen.value = false;
  settingsModalOpen.value = true;
  modalState.value = "command";
}

export function closeSettingsModal(): void {
  settingsModalOpen.value = false;
  if (modalState.value === "command" && !commandPaletteOpen.value && !customPromptOpen.value) {
    modalState.value = "navigate";
  }
}

export async function triggerLens(lens: LensKind, customPrompt?: string): Promise<void> {
  if (activeRunId.value !== null) {
    pushToast("An AI lens run is already streaming (press Esc to cancel)", "warning");
    return;
  }

  const targetIds =
    selectedIds.value.size > 0
      ? Array.from(selectedIds.value)
      : focusId.value !== null
        ? [focusId.value]
        : [];

  if (targetIds.length === 0) {
    pushToast("Select a focus node first", "warning");
    return;
  }
  if (lens === "synthesize" && targetIds.length < 2) {
    pushToast("Select 2 or more nodes to synthesize (Shift+J/K)", "warning");
    return;
  }
  if (lens === "custom" && customPrompt === undefined) {
    openCustomPromptBar();
    return;
  }

  if (!isTauriRuntime()) {
    pushToast("AI Lens streaming requires the Axiom desktop runtime", "info");
    return;
  }

  resetRunTracker(lens, focusId.value);
  activeRunLens.value = lens;

  try {
    const runId = await runLensIpc(lens, targetIds, handleLensStreamEvent, customPrompt);
    activeRunId.value = runId;
  } catch (err) {
    activeRunId.value = null;
    activeRunLens.value = null;
    resetRunTracker();
    const parsed = parseIpcError(err);
    if (parsed.code === "PROVIDER_AUTH") {
      pushToast(parsed.message, "error", {
        label: "Open Settings",
        onClick: openSettingsModal,
      });
    } else {
      pushToast(parsed.message, "error");
    }
  }
}

export function cancelActiveRun(): boolean {
  const runId = activeRunId.value;
  if (!runId) {
    return false;
  }
  if (isTauriRuntime()) {
    void cancelRunIpc(runId).catch((err) => {
      const parsed = parseIpcError(err);
      if (parsed.code !== "RUN_NOT_FOUND") {
        pushToast(parsed.message, "warning");
      }
    });
  } else {
    activeRunId.value = null;
    activeRunLens.value = null;
    resetRunTracker();
  }
  return true;
}

export function applySummaryUpdate(evt: SummaryUpdatedEvent): void {
  const existing = nodesMap.get(evt.node_id);
  if (!existing) {
    return;
  }
  // Silent update: never bump graphVersion or trigger card re-layout
  nodesMap.set(evt.node_id, {
    ...existing,
    summary: evt.summary,
    summary_hash: evt.summary_hash,
  });
}

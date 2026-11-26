import { signal } from "@preact/signals";
import { worldToScreen } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import { deriveTitleFromTagPrompt, isPlaceholderTitle } from "../cards/nodeAccent";
import { extractActionTagFromContent, type ActionTagDef } from "../input/actionTags";
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
  Severity,
  SummaryUpdatedEvent,
} from "../ipc/types";
import { pushToast } from "../overlays/ToastStack";
import {
  cameraControllerRef,
  edgesMap,
  graphVersion,
  mutateGraph,
  nodesMap,
  recomputeUnresolvedLoopholes,
  resolveAndAnimateOverlaps,
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
  triggerLockedShake,
} from "./selection";

export const LENS_LABELS: Record<LensKind, string> = {
  red_team: "Red-Team",
  edge_case: "Edge Cases",
  diverge: "Diverge",
  feynman: "Feynman",
  synthesize: "Synthesize",
  custom: "Custom Prompt",
  research: "Research Map",
  study: "Study & Recall",
};

export const activeRunId = signal<string | null>(null);
export const activeRunLens = signal<LensKind | null>(null);
export const activeRunLabel = signal<string | null>(null);
export const activeRunStatus = signal<"idle" | "thinking" | "streaming">("idle");
export const activeRunFocusIds = signal<string[]>([]);
export const activeRunSpawnedCount = signal<number>(0);
export type SettingsTab = "general" | "providers" | "prompt_lenses";

export const customPromptOpen = signal<boolean>(false);
export const settingsModalOpen = signal<boolean>(false);
export const settingsActiveTab = signal<SettingsTab>("general");
export const triageBanner = signal<string | null>(null);

export interface TriggerLensOptions {
  inPlace?: boolean;
  customLensId?: string | null;
  customLensLabel?: string | null;
}

export interface InPlaceSnapshot {
  nodeId: string;
  prevTitle: string;
  prevContent: string;
}

const LENS_TO_TAG: Record<LensKind, string> = {
  custom: "@custom",
  feynman: "@feynman",
  red_team: "@redteam",
  edge_case: "@edgecase",
  diverge: "@diverge",
  synthesize: "@synthesize",
  research: "@research",
  study: "@study",
};

interface ActiveRunTracker {
  lens: LensKind | null;
  startFocusId: string | null;
  inPlaceSnapshot: InPlaceSnapshot | null;
  spawnedNodes: Map<string, NodeDto>;
  spawnedEdges: EdgeDto[];
  pendingDeltas: Map<string, string>;
  flushScheduled: boolean;
}

const tracker: ActiveRunTracker = {
  lens: null,
  startFocusId: null,
  inPlaceSnapshot: null,
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

export function resetRunTracker(
  lens: LensKind | null = null,
  startFocus: string | null = null,
  inPlaceSnapshot: InPlaceSnapshot | null = null,
): void {
  tracker.lens = lens;
  tracker.startFocusId = startFocus;
  tracker.inPlaceSnapshot = inPlaceSnapshot;
  tracker.spawnedNodes.clear();
  tracker.spawnedEdges = [];
  tracker.pendingDeltas.clear();
  tracker.flushScheduled = false;
  activeRunLabel.value = null;
}

export function handleLensStreamEvent(evt: LensStreamEvent): void {
  switch (evt.kind) {
    case "skeleton_spawned": {
      const isInPlaceSpawn = tracker.inPlaceSnapshot?.nodeId === evt.node.id;
      nodesMap.set(evt.node.id, evt.node);
      if (!isInPlaceSpawn) {
        for (const edge of evt.edges) {
          edgesMap.set(edge.id, edge);
        }
        tracker.spawnedEdges.push(...evt.edges);
      }
      viewportSpatialIndex.upsert(evt.node);
      tracker.spawnedNodes.set(evt.node.id, evt.node);
      activeRunStatus.value = "streaming";
      activeRunSpawnedCount.value = tracker.spawnedNodes.size;
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
      void resolveAndAnimateOverlaps(
        tracker.startFocusId ? [tracker.startFocusId, evt.node.id] : [evt.node.id],
      );
      break;
    }
    case "run_completed": {
      flushPendingTokenDeltas();
      const completedLens = tracker.lens;
      const startFocus = tracker.startFocusId;
      const inPlaceSnap = tracker.inPlaceSnapshot;
      const spawnedNodes = Array.from(tracker.spawnedNodes.values());
      const spawnedEdges = [...tracker.spawnedEdges];

      activeRunId.value = null;
      activeRunLens.value = null;
      activeRunLabel.value = null;
      activeRunStatus.value = "idle";
      activeRunFocusIds.value = [];
      activeRunSpawnedCount.value = 0;
      resetRunTracker();

      if (inPlaceSnap) {
        const finalNode = nodesMap.get(inPlaceSnap.nodeId);
        if (
          finalNode &&
          (finalNode.title !== inPlaceSnap.prevTitle ||
            finalNode.content !== inPlaceSnap.prevContent)
        ) {
          graphHistory.push({
            label: `AI ${completedLens ?? "lens"}`,
            forward: [
              {
                op: "update_node_text",
                id: inPlaceSnap.nodeId,
                title: finalNode.title,
                content: finalNode.content,
              },
            ],
            inverse: [
              {
                op: "update_node_text",
                id: inPlaceSnap.nodeId,
                title: inPlaceSnap.prevTitle,
                content: inPlaceSnap.prevContent,
              },
            ],
          });
          syncHistorySignals();
        }
      } else if (spawnedNodes.length > 0) {
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
        !inPlaceSnap &&
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
      activeRunLabel.value = null;
      activeRunStatus.value = "idle";
      activeRunFocusIds.value = [];
      activeRunSpawnedCount.value = 0;
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

export function openSettingsModal(tab?: SettingsTab | Event): void {
  settingsActiveTab.value =
    tab === "general" || tab === "providers" || tab === "prompt_lenses" ? tab : "general";
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

export async function triggerLens(
  lens: LensKind,
  customPrompt?: string,
  options?: TriggerLensOptions,
): Promise<void> {
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
  const customLensId = options?.customLensId?.trim() ? options.customLensId : null;
  if (lens === "custom" && customPrompt === undefined && !customLensId) {
    openCustomPromptBar();
    return;
  }

  const useInPlace = Boolean(options?.inPlace) && lens !== "synthesize";
  let effectiveTargetIds = targetIds;
  let inPlaceSnap: InPlaceSnapshot | null = null;

  if (useInPlace) {
    const inPlaceTargetId =
      focusId.value && targetIds.includes(focusId.value) ? focusId.value : targetIds[0];
    const targetNode = inPlaceTargetId ? nodesMap.get(inPlaceTargetId) : undefined;
    if (!targetNode) {
      pushToast("Select a focus node first", "warning");
      return;
    }
    if (targetNode.status === "locked") {
      triggerLockedShake(targetNode.id);
      pushToast("Node is locked — unlock before running in-place AI", "warning");
      return;
    }
    effectiveTargetIds = [targetNode.id];
    inPlaceSnap = {
      nodeId: targetNode.id,
      prevTitle: targetNode.title,
      prevContent: targetNode.content,
    };
  }

  if (!isTauriRuntime()) {
    pushToast("AI Lens streaming requires the Axiom desktop runtime", "info");
    return;
  }

  if (useInPlace && inPlaceSnap) {
    const targetNode = nodesMap.get(inPlaceSnap.nodeId);
    const trimmedPrompt = customPrompt?.trim() ?? "";
    if (targetNode && trimmedPrompt.length > 0) {
      const tagForLens = LENS_TO_TAG[lens];
      const existingTag = targetNode.content.includes("@")
        ? extractActionTagFromContent(targetNode.content)
        : null;
      const alreadyHasPrompt =
        targetNode.content.trimEnd().endsWith(trimmedPrompt) ||
        (existingTag !== null && existingTag.argument === trimmedPrompt);
      const promptLine = trimmedPrompt.startsWith("@")
        ? trimmedPrompt
        : `${tagForLens} ${trimmedPrompt}`;
      const nextContent = alreadyHasPrompt
        ? targetNode.content
        : targetNode.content.trim().length > 0
          ? `${targetNode.content.trimEnd()}\n\n${promptLine}`
          : promptLine;
      const nextTitle = isPlaceholderTitle(targetNode.title)
        ? deriveTitleFromTagPrompt(tagForLens, trimmedPrompt, targetNode.title)
        : targetNode.title;

      if (nextTitle !== targetNode.title || nextContent !== targetNode.content) {
        nodesMap.set(targetNode.id, {
          ...targetNode,
          title: nextTitle,
          content: nextContent,
        });
        graphVersion.value += 1;
        await mutateGraph([
          {
            op: "update_node_text",
            id: targetNode.id,
            title: nextTitle,
            content: nextContent,
          },
        ]);
      }
    }
  }

  resetRunTracker(lens, focusId.value, inPlaceSnap);
  activeRunStatus.value = "thinking";
  activeRunLens.value = lens;
  activeRunLabel.value = options?.customLensLabel ?? null;
  activeRunFocusIds.value = effectiveTargetIds;
  activeRunSpawnedCount.value = 0;

  try {
    const runId = await runLensIpc(
      lens,
      effectiveTargetIds,
      handleLensStreamEvent,
      customPrompt,
      useInPlace,
      customLensId,
    );
    activeRunId.value = runId;
  } catch (err) {
    activeRunId.value = null;
    activeRunLens.value = null;
    activeRunLabel.value = null;
    activeRunStatus.value = "idle";
    activeRunFocusIds.value = [];
    activeRunSpawnedCount.value = 0;
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
  if (!runId && activeRunStatus.value === "idle") {
    return false;
  }
  if (isTauriRuntime() && runId) {
    void cancelRunIpc(runId).catch((err) => {
      const parsed = parseIpcError(err);
      if (parsed.code !== "RUN_NOT_FOUND") {
        pushToast(parsed.message, "warning");
      }
    });
  } else {
    activeRunId.value = null;
    activeRunLens.value = null;
    activeRunLabel.value = null;
    activeRunStatus.value = "idle";
    activeRunFocusIds.value = [];
    activeRunSpawnedCount.value = 0;
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

function severityRank(severity: Severity | null): number {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

export function startLoopholeTriage(): boolean {
  const currentFocus = focusId.value;
  const linkedLoopholes: NodeDto[] = [];
  const allLoopholes: NodeDto[] = [];

  const linkedIds = new Set<string>();
  if (currentFocus !== null) {
    for (const edge of edgesMap.values()) {
      if (edge.target_id === currentFocus || edge.source_id === currentFocus) {
        linkedIds.add(edge.source_id);
        linkedIds.add(edge.target_id);
      }
    }
    linkedIds.add(currentFocus);
  }

  for (const node of nodesMap.values()) {
    if (node.type === "loophole" && node.status === "active") {
      allLoopholes.push(node);
      if (currentFocus !== null && linkedIds.has(node.id)) {
        linkedLoopholes.push(node);
      }
    }
  }

  const candidates = linkedLoopholes.length > 0 ? linkedLoopholes : allLoopholes;
  if (candidates.length === 0) {
    pushToast("No unresolved loopholes to triage", "info");
    return false;
  }

  candidates.sort((a, b) => {
    const sevDiff = severityRank(b.metadata.severity) - severityRank(a.metadata.severity);
    if (sevDiff !== 0) {
      return sevDiff;
    }
    return a.created_at - b.created_at;
  });

  const target = candidates[0];
  if (!target) {
    return false;
  }

  selectSingle(target.id);
  ensureNodeInView(target.id);
  showTriageBanner();
  return true;
}

export function shouldRunTagInPlace(
  action: ActionTagDef,
  argument: string | undefined,
  targetNode: NodeDto | undefined,
): boolean {
  if (action.kind !== "lens" || action.lens === "synthesize") {
    return false;
  }
  const hasArg = Boolean(argument && argument.trim().length > 0);
  const hasNodeTag = Boolean(
    targetNode &&
      targetNode.content.includes("@") &&
      extractActionTagFromContent(targetNode.content),
  );
  return hasArg || hasNodeTag;
}

export async function executeActionTag(
  action: ActionTagDef,
  argument?: string,
  options?: TriggerLensOptions,
): Promise<void> {
  if (action.kind === "triage") {
    startLoopholeTriage();
    return;
  }

  const trimmed = argument?.trim() ?? "";
  if (action.kind === "lens" && action.customLens) {
    await triggerLens("custom", trimmed || undefined, {
      inPlace: options?.inPlace,
      customLensId: action.customLens.id,
      customLensLabel: action.customLens.name,
    });
    return;
  }
  if (action.lens === "custom" && trimmed.length === 0) {
    await triggerLens("custom", undefined, options);
    return;
  }
  await triggerLens(action.lens, trimmed.length > 0 ? trimmed : undefined, options);
}

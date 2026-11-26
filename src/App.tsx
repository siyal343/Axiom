import { useEffect, useRef, useState } from "preact/hooks";
import type { BBox } from "rbush";
import {
  CanvasCameraController,
  clampZoom,
  computeFitTransform,
  screenToWorld,
  worldToScreen,
  type CameraTransform,
} from "./canvas/camera";
import { globalFrameTracker } from "./canvas/perfMetrics";
import { attachCanvasPointer, type PointerOverlayState } from "./canvas/pointer";
import { renderCanvas2d } from "./canvas/renderer2d";
import { getEffectiveNodeHeight } from "./canvas/spatialIndex";
import { CardLayer } from "./cards/CardLayer";
import { LiveEditorOverlay } from "./cards/LiveEditorOverlay";
import { attachKeymap } from "./input/keymap";
import { setCustomLenses } from "./input/actionTags";
import {
  collectSpotlightIds,
  computeAlignmentMoves,
  findParentTarget,
  type AlignMode,
} from "./input/topologyNav";
import {
  getSettings,
  isTauriRuntime,
  listenSummaryUpdated,
  saveCamera,
} from "./ipc/client";
import type { EdgeType, GraphOp, LensKind, NodeDto } from "./ipc/types";
import { ArtifactExportModal } from "./overlays/ArtifactExportModal";
import { CheckpointsModal } from "./overlays/CheckpointsModal";
import { CommandPalette } from "./overlays/CommandPalette";
import { CustomPromptBar } from "./overlays/CustomPromptBar";
import { DiagnosticsModal } from "./overlays/DiagnosticsModal";
import { EdgeInspectorPill } from "./overlays/EdgeInspectorPill";
import { MinimapOverlay } from "./overlays/MinimapOverlay";
import { NodeContextMenu } from "./overlays/NodeContextMenu";
import { OutlineImportModal } from "./overlays/OutlineImportModal";
import { PerfHud } from "./overlays/PerfHud";
import { RelatedNodesPopover } from "./overlays/RelatedNodesPopover";
import { SettingsModal } from "./overlays/SettingsModal";
import { ShortcutsModal } from "./overlays/ShortcutsModal";
import { SpineBreadcrumb } from "./overlays/SpineBreadcrumb";
import { StudyDeckModal } from "./overlays/StudyDeckModal";
import { notifyIpcError, pushToast, ToastStack } from "./overlays/ToastStack";
import { WorkspaceSidebar } from "./overlays/WorkspaceSidebar";
import { XrayHud } from "./overlays/XrayHud";
import {
  activeRunLabel,
  activeRunLens,
  activeRunSpawnedCount,
  activeRunStatus,
  applySummaryUpdate,
  cancelActiveRun,
  LENS_LABELS,
  startLoopholeTriage,
  triageBanner,
  triggerLens,
} from "./store/aiRunner";
import {
  acknowledgeAndRefreshStaleNode,
  cameraControllerRef,
  connectNodesWithEdge,
  createCanvasGroup,
  deleteCanvasGroup,
  detachExternalRefNode,
  dragOffsets,
  edgeFlowEnabled,
  edgesMap,
  GROUP_COLOR_KEYS,
  graphVersion,
  groupsMap,
  isBirdsEye,
  mutateGraphUndoable,
  nodesMap,
  refreshExternalRefs,
  refreshStaleNodes,
  resizeSizes,
  selectedGroupId,
  setTheme,
  syncExternalRefNode,
  theme,
  tokenBudget,
  unresolvedLoopholes,
  updateCanvasGroup,
  viewportSpatialIndex,
  visibleNodeIds,
} from "./store/graphStore";
import {
  buildCreateNodeWithInverse,
  buildDeleteWithInverse,
  buildMoveNodesWithInverse,
  buildUpdateMetaWithInverse,
} from "./store/history";
import {
  checkpointsModalOpen,
  clearSpotlight,
  connectSourceId,
  diagnosticsModalOpen,
  edgePopover,
  enterEditMode,
  externalRefsMap,
  focusId,
  hoveredId,
  isInteracting,
  minimapOpen,
  modalState,
  openCheckpointsModal,
  openDiagnosticsModal,
  selectedEdgeId,
  selectedIds,
  selectSingle,
  setSelection,
  shortcutsHelpOpen,
  spotlightRootId,
  staleNodesMap,
  xrayState,
} from "./store/selection";
import {
  initWorkspaceCatalog,
  openFlowAndFocusNode,
  sidebarOpen,
} from "./store/workspaceCatalogStore";
import {
  dueStudyCount,
  openStudyModal,
  studyModalOpen,
  syncStudyDeckAction,
} from "./store/studyStore";

const EDGE_POPOVER_OPTIONS: ReadonlyArray<{
  keyHint: string;
  type: EdgeType;
  label: string;
  colorVar: string;
}> = [
  { keyHint: "1", type: "derives", label: "Derives", colorVar: "var(--edge-default)" },
  { keyHint: "2", type: "branches", label: "Branches", colorVar: "var(--edge-branch)" },
  { keyHint: "3", type: "challenges", label: "Challenges", colorVar: "var(--edge-challenge)" },
  { keyHint: "4", type: "resolves", label: "Resolves", colorVar: "var(--edge-resolve)" },
  { keyHint: "5", type: "synthesizes", label: "Synthesizes", colorVar: "var(--edge-synthesis)" },
  { keyHint: "6", type: "references", label: "References", colorVar: "var(--edge-reference)" },
];

function clampOverlayPoint(
  rawX: number,
  rawY: number,
  viewportWidth: number,
  viewportHeight: number,
  el?: HTMLElement | null,
  fallbackHalfWidth = 280,
  fallbackHeight = 40,
): { x: number; y: number } {
  const measuredW = el?.offsetWidth ?? 0;
  const measuredH = el?.offsetHeight ?? 0;
  const halfW = measuredW > 0 ? measuredW * 0.5 : Math.min(fallbackHalfWidth, viewportWidth * 0.45);
  const pillH = measuredH > 0 ? measuredH : fallbackHeight;
  const minX = halfW + 16;
  const maxX = viewportWidth - halfW - 16;
  const x =
    minX >= maxX
      ? Math.round(viewportWidth * 0.5)
      : Math.round(Math.max(minX, Math.min(maxX, rawX)));
  const minY = 60 + pillH;
  const maxY = Math.max(minY, viewportHeight - 78);
  return {
    x,
    y: Math.round(Math.max(minY, Math.min(maxY, rawY))),
  };
}

function computeMultiPillWorldAnchor(selected: ReadonlySet<string>): { x: number; y: number } | null {
  if (selected.size < 2) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const id of selected) {
    const node = nodesMap.get(id);
    if (!node) continue;
    const offset = dragOffsets.get(id);
    const resized = resizeSizes.get(id);
    const nx = node.layout.x + (offset?.x ?? 0);
    const ny = node.layout.y + (offset?.y ?? 0);
    const nw = resized ? resized.width : node.layout.width;
    minX = Math.min(minX, nx);
    minY = Math.min(minY, ny);
    maxX = Math.max(maxX, nx + nw);
    void getEffectiveNodeHeight(node);
  }
  if (!Number.isFinite(minX)) {
    return null;
  }
  return { x: (minX + maxX) / 2, y: minY };
}

export function App() {
  const shellRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoomLabelRef = useRef<HTMLButtonElement | null>(null);
  const multiPillRef = useRef<HTMLDivElement | null>(null);
  const edgePopoverRef = useRef<HTMLDivElement | null>(null);
  const edgePopoverWorldRef = useRef<{ x: number; y: number } | null>(null);
  const overlayStateRef = useRef<PointerOverlayState>({
    marqueeWorld: null,
    edgePreviewWorld: null,
    hoveredEdgeId: null,
  });

  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );

  const version = graphVersion.value;
  const currentSelected = selectedIds.value;
  const activePopover = edgePopover.value;
  const birdsEye = isBirdsEye.value;
  const flowEnabled = edgeFlowEnabled.value;
  const interacting = isInteracting.value;
  const currentModal = modalState.value;
  const activeTriage = triageBanner.value;
  const runStatus = activeRunStatus.value;
  const runLens = activeRunLens.value;
  const runLabel = activeRunLabel.value;
  const runSpawnedCount = activeRunSpawnedCount.value;
  const isSidebarOpen = sidebarOpen.value;
  const isMinimapOpen = minimapOpen.value;
  const isDiagnosticsOpen = diagnosticsModalOpen.value;
  const isCheckpointsOpen = checkpointsModalOpen.value;
  const isStudyOpen = studyModalOpen.value;
  const dueStudy = dueStudyCount.value;
  const currentGroups = groupsMap.value;
  const activeGroupId = selectedGroupId.value;
  const activeGroup = activeGroupId ? (currentGroups.get(activeGroupId) ?? null) : null;
  const [groupTitleDraft, setGroupTitleDraft] = useState("");
  const activeSpotlightRoot = spotlightRootId.value;
  const externalRefs = externalRefsMap.value;
  const hasXray = xrayState.value !== null;
  const staleNodes = staleNodesMap.value;
  const staleCount = staleNodes.size;

  const shouldAnimateEdges =
    flowEnabled && !birdsEye && edgesMap.size > 0 && !prefersReducedMotion;
  const shouldAnimateEdgesRef = useRef(shouldAnimateEdges);
  shouldAnimateEdgesRef.current = shouldAnimateEdges;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (evt: MediaQueryListEvent): void => {
      setPrefersReducedMotion(evt.matches);
    };
    mq.addEventListener("change", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
    };
  }, []);

  useEffect(() => {
    setGroupTitleDraft(activeGroup?.title ?? "");
  }, [activeGroup?.id, activeGroup?.title]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme.value);
    cameraControllerRef.current?.markDirty();
  }, [theme.value]);

  useEffect(() => {
    cameraControllerRef.current?.setContinuousAnimation?.(shouldAnimateEdges);
    cameraControllerRef.current?.markDirty();
  }, [shouldAnimateEdges]);

  useEffect(() => {
    if (!activePopover) {
      edgePopoverWorldRef.current = null;
      return;
    }
    const ctrl = cameraControllerRef.current;
    const cam = ctrl?.getCamera() ?? { x: 0, y: 0, zoom: 1, last_focus_id: null };
    edgePopoverWorldRef.current = screenToWorld(activePopover.x, activePopover.y, cam);
  }, [activePopover]);

  useEffect(() => {
    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!shell || !canvas) {
      return;
    }

    const overlay = overlayStateRef.current;
    overlay.marqueeWorld = null;
    overlay.edgePreviewWorld = null;
    overlay.hoveredEdgeId = null;

    const syncFloatingOverlayTransforms = (cam: CameraTransform, vw: number, vh: number): void => {
      const multiEl = multiPillRef.current;
      if (multiEl) {
        const anchor = computeMultiPillWorldAnchor(selectedIds.value);
        if (anchor) {
          const pt = worldToScreen(anchor.x, anchor.y, cam);
          const clamped = clampOverlayPoint(pt.x, pt.y - 12, vw, vh, multiEl, 280, 40);
          multiEl.style.transform = `translate3d(${clamped.x}px, ${clamped.y}px, 0) translate(-50%, -100%)`;
        }
      }

      const popEl = edgePopoverRef.current;
      const pop = edgePopover.value;
      if (popEl && pop) {
        const worldAnchor = edgePopoverWorldRef.current ?? screenToWorld(pop.x, pop.y, cam);
        const pt = worldToScreen(worldAnchor.x, worldAnchor.y, cam);
        const clamped = clampOverlayPoint(pt.x, pt.y, vw, vh, popEl, 250, 38);
        popEl.style.transform = `translate3d(${clamped.x}px, ${clamped.y}px, 0) translate(-50%, -100%)`;
      }
    };

    const controller = new CanvasCameraController({
      canvas,
      cardLayerEl: null,
      renderFrame: (ctx, cam, width, height) => {
        const spotRoot = spotlightRootId.value;
        const spotlightIds =
          spotRoot !== null ? collectSpotlightIds(spotRoot, nodesMap, edgesMap) : null;
        const outOfSyncRefIds = new Set<string>();
        for (const [id, info] of externalRefsMap.value.entries()) {
          if (info.status !== "synced") {
            outOfSyncRefIds.add(id);
          }
        }
        renderCanvas2d(ctx, {
          cam,
          width,
          height,
          nodes: nodesMap,
          edges: edgesMap,
          dragOffsets,
          resizeSizes,
          selectedIds: selectedIds.value,
          focusId: focusId.value,
          hoveredId: hoveredId.value,
          selectedEdgeId: selectedEdgeId.value,
          hoveredEdgeId: overlay.hoveredEdgeId ?? null,
          connectSourceId: connectSourceId.value,
          xrayState: xrayState.value,
          unresolvedLoopholes: unresolvedLoopholes.value,
          staleNodeIds: new Set(staleNodesMap.value.keys()),
          spotlightIds,
          outOfSyncRefIds,
          marqueeWorld: overlay.marqueeWorld,
          edgePreviewWorld: overlay.edgePreviewWorld,
          groups: groupsMap.value,
          selectedGroupId: selectedGroupId.value,
          themeKey: theme.value,
          animTimeMs: typeof performance !== "undefined" ? performance.now() : 0,
          animateEdges: shouldAnimateEdgesRef.current,
        });
      },
      onViewportCull: (bounds, _zoom, nextBirdsEye) => {
        if (nextBirdsEye) {
          visibleNodeIds.value = [];
        } else {
          visibleNodeIds.value = viewportSpatialIndex.queryViewport(bounds, 200);
        }
      },
      onSaveCamera: (cam) => {
        if (isTauriRuntime()) {
          void saveCamera(cam);
        }
      },
      onFrameSample: (drawMs, intervalMs) => {
        globalFrameTracker.record(drawMs, intervalMs);
      },
    });

    cameraControllerRef.current = controller;

    const syncZoomLabel = (zoom: number): void => {
      const labelEl = zoomLabelRef.current;
      if (labelEl) {
        labelEl.textContent = `${Math.round(zoom * 100)}%`;
      }
    };
    syncZoomLabel(controller.getCamera().zoom);
    const unsubscribeZoom = controller.subscribeFrame((cam) => {
      syncZoomLabel(cam.zoom);
      const vp = controller.getViewportSize();
      syncFloatingOverlayTransforms(cam, vp.width, vp.height);
    });

    const rect = shell.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      controller.setSize(rect.width, rect.height);
    }

    let resizeObs: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObs = new ResizeObserver((entries) => {
        for (const entry of entries) {
          controller.setSize(entry.contentRect.width, entry.contentRect.height);
        }
      });
      resizeObs.observe(shell);
    }

    const detachPointer = attachCanvasPointer(shell, controller, overlay);
    const detachKeymap = attachKeymap();

    let active = true;
    let unlistenSummary: (() => void) | null = null;

    if (isTauriRuntime()) {
      void getSettings()
        .then((s) => {
          if (!active) return;
          setTheme(s.theme);
          tokenBudget.value = s.default_token_budget;
          setCustomLenses(s.custom_lenses ?? []);
        })
        .catch(() => {
          // Non-fatal: defaults remain active
        });

      void listenSummaryUpdated(applySummaryUpdate).then((unlisten) => {
        if (active) {
          unlistenSummary = unlisten;
        } else {
          unlisten();
        }
      });
    }

    initWorkspaceCatalog()
      .then((catalog) => {
        if (!active) {
          return;
        }
        if (catalog) {
          setWorkspaceReady(true);
        } else {
          setLoadError("Failed to initialize workspace catalog");
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        console.error("Failed to initialize workspace catalog:", err);
        if (active) {
          setLoadError(message);
        }
      });

    return () => {
      active = false;
      unlistenSummary?.();
      unsubscribeZoom();
      detachKeymap();
      detachPointer();
      resizeObs?.disconnect();
      controller.dispose();
      if (cameraControllerRef.current === controller) {
        cameraControllerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    cameraControllerRef.current?.markDirty();
  }, [
    version,
    currentSelected,
    focusId.value,
    hoveredId.value,
    selectedEdgeId.value,
    connectSourceId.value,
    xrayState.value,
    staleNodes,
    activeSpotlightRoot,
    externalRefs,
    currentGroups,
    activeGroupId,
  ]);

  useEffect(() => {
    if (!workspaceReady) {
      return;
    }
    const studyTimer = setTimeout(() => {
      void syncStudyDeckAction().catch(() => {
        // Non-fatal background sync for due counter
      });
    }, 180);
    if (!isTauriRuntime()) {
      return () => {
        clearTimeout(studyTimer);
      };
    }
    const timer = setTimeout(() => {
      void refreshStaleNodes();
      void refreshExternalRefs();
    }, 250);
    return () => {
      clearTimeout(studyTimer);
      clearTimeout(timer);
    };
  }, [workspaceReady, version]);

  useEffect(() => {
    const handleAckStale = (e: Event): void => {
      const detail = (e as CustomEvent<{ nodeId?: string } | string>).detail;
      const nodeId = typeof detail === "string" ? detail : detail?.nodeId;
      if (!nodeId) {
        return;
      }
      void acknowledgeAndRefreshStaleNode(nodeId).catch(notifyIpcError);
    };

    const handleRerunStale = (e: Event): void => {
      const detail = (e as CustomEvent<{ nodeId?: string; lens?: LensKind }>).detail;
      const nodeId = detail?.nodeId;
      if (!nodeId) {
        return;
      }
      const staleInfo = staleNodesMap.value.get(nodeId);
      const node = nodesMap.get(nodeId);
      const metaLens = node?.metadata.lens;
      const lens: LensKind =
        detail?.lens ??
        staleInfo?.lens ??
        (metaLens && metaLens !== "manual" ? metaLens : "red_team");

      if (lens === "synthesize") {
        const sources: string[] = [];
        for (const edge of edgesMap.values()) {
          if (
            edge.target_id === nodeId &&
            edge.type === "synthesizes" &&
            nodesMap.has(edge.source_id)
          ) {
            sources.push(edge.source_id);
          }
        }
        if (sources.length >= 2) {
          setSelection(sources, sources[0]);
          void triggerLens(lens);
          return;
        }
      }

      const parentId = findParentTarget(nodeId, nodesMap, edgesMap);
      const targetId =
        parentId ??
        (focusId.value && focusId.value !== nodeId ? focusId.value : null) ??
        nodeId;
      selectSingle(targetId);
      void triggerLens(lens);
    };

    const handleSyncExtRef = (e: Event): void => {
      const detail = (e as CustomEvent<{ nodeId?: string; localNodeId?: string } | string>).detail;
      const nodeId = typeof detail === "string" ? detail : (detail?.nodeId ?? detail?.localNodeId);
      if (!nodeId) {
        return;
      }
      void syncExternalRefNode(nodeId)
        .then(() => {
          pushToast("Synced linked card from source", "info");
        })
        .catch(notifyIpcError);
    };

    const handleOpenExtRef = (e: Event): void => {
      const detail = (
        e as CustomEvent<
          | {
              nodeId?: string;
              localNodeId?: string;
              sourceWorkspaceId?: string;
              sourceFlowId?: string;
              sourceNodeId?: string;
              source_workspace_id?: string;
              source_flow_id?: string;
              source_node_id?: string;
            }
          | string
        >
      ).detail;
      const nodeId = typeof detail === "string" ? detail : (detail?.nodeId ?? detail?.localNodeId);
      const refInfo = nodeId ? externalRefsMap.value.get(nodeId) : undefined;
      const wsId =
        typeof detail === "object" && detail !== null
          ? (detail.sourceWorkspaceId ?? detail.source_workspace_id ?? refInfo?.source_workspace_id)
          : refInfo?.source_workspace_id;
      const flowId =
        typeof detail === "object" && detail !== null
          ? (detail.sourceFlowId ?? detail.source_flow_id ?? refInfo?.source_flow_id)
          : refInfo?.source_flow_id;
      const srcNodeId =
        typeof detail === "object" && detail !== null
          ? (detail.sourceNodeId ?? detail.source_node_id ?? refInfo?.source_node_id)
          : refInfo?.source_node_id;
      if (!wsId || !flowId || !srcNodeId) {
        return;
      }
      void openFlowAndFocusNode(wsId, flowId, srcNodeId).catch(notifyIpcError);
    };

    const handleDetachExtRef = (e: Event): void => {
      const detail = (e as CustomEvent<{ nodeId?: string; localNodeId?: string } | string>).detail;
      const nodeId = typeof detail === "string" ? detail : (detail?.nodeId ?? detail?.localNodeId);
      if (!nodeId) {
        return;
      }
      void detachExternalRefNode(nodeId)
        .then(() => {
          pushToast("Detached external link", "info");
        })
        .catch(notifyIpcError);
    };

    window.addEventListener("axiom:ack-stale", handleAckStale);
    window.addEventListener("axiom:rerun-stale", handleRerunStale);
    window.addEventListener("axiom:sync-extref", handleSyncExtRef);
    window.addEventListener("axiom:open-extref", handleOpenExtRef);
    window.addEventListener("axiom:detach-extref", handleDetachExtRef);
    return () => {
      window.removeEventListener("axiom:ack-stale", handleAckStale);
      window.removeEventListener("axiom:rerun-stale", handleRerunStale);
      window.removeEventListener("axiom:sync-extref", handleSyncExtRef);
      window.removeEventListener("axiom:open-extref", handleOpenExtRef);
      window.removeEventListener("axiom:detach-extref", handleDetachExtRef);
    };
  }, []);

  const viewportSize = cameraControllerRef.current?.getViewportSize() ?? {
    width: typeof window !== "undefined" ? window.innerWidth : 1280,
    height: typeof window !== "undefined" ? window.innerHeight : 800,
  };

  let multiPillPos: { x: number; y: number } | null = null;
  if (
    currentSelected.size >= 2 &&
    !birdsEye &&
    !interacting &&
    currentModal === "navigate" &&
    cameraControllerRef.current
  ) {
    const anchor = computeMultiPillWorldAnchor(currentSelected);
    if (anchor) {
      const screenPt = worldToScreen(
        anchor.x,
        anchor.y,
        cameraControllerRef.current.getCamera(),
      );
      multiPillPos = clampOverlayPoint(
        screenPt.x,
        screenPt.y - 12,
        viewportSize.width,
        viewportSize.height,
        multiPillRef.current,
        280,
        40,
      );
    }
  }

  const clampedPopoverPos = activePopover
    ? clampOverlayPoint(
        activePopover.x,
        activePopover.y,
        viewportSize.width,
        viewportSize.height,
        edgePopoverRef.current,
        250,
        38,
      )
    : null;

  let activeLoopholeCount = 0;
  for (const node of nodesMap.values()) {
    if (node.type === "loophole" && node.status === "active") {
      activeLoopholeCount += 1;
    }
  }

  const fitNodeIds = (ids: Iterable<string>): void => {
    const ctrl = cameraControllerRef.current;
    if (!ctrl) {
      return;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const id of ids) {
      const node = nodesMap.get(id);
      if (!node) continue;
      minX = Math.min(minX, node.layout.x);
      minY = Math.min(minY, node.layout.y);
      maxX = Math.max(maxX, node.layout.x + node.layout.width);
      maxY = Math.max(maxY, node.layout.y + getEffectiveNodeHeight(node));
    }
    if (!Number.isFinite(minX)) {
      return;
    }
    const vp = ctrl.getViewportSize();
    const bounds: BBox = { minX, minY, maxX, maxY };
    ctrl.animateTo(computeFitTransform(bounds, vp.width, vp.height, 80), 220);
  };

  const handleBulkMetaToggle = (kind: "pin" | "exclude" | "fold"): void => {
    const selectedNodes = Array.from(currentSelected)
      .map((id) => nodesMap.get(id))
      .filter((n): n is NodeDto => n !== undefined);
    if (selectedNodes.length === 0) {
      return;
    }
    const forward: GraphOp[] = [];
    const inverse: GraphOp[] = [];

    if (kind === "pin") {
      const targetVal = !selectedNodes.every((n) => n.context_controls.pin_global);
      for (const n of selectedNodes) {
        if (n.context_controls.pin_global === targetVal) continue;
        const entry = buildUpdateMetaWithInverse(n, { pin_global: targetVal });
        forward.push(...entry.forward);
        inverse.push(...entry.inverse);
      }
      if (forward.length > 0) {
        void mutateGraphUndoable("Toggle pin selection", forward, inverse).catch(notifyIpcError);
      }
      return;
    }

    if (kind === "exclude") {
      const targetVal = !selectedNodes.every((n) => n.context_controls.exclude_from_ai);
      for (const n of selectedNodes) {
        if (n.context_controls.exclude_from_ai === targetVal) continue;
        const entry = buildUpdateMetaWithInverse(n, { exclude_from_ai: targetVal });
        forward.push(...entry.forward);
        inverse.push(...entry.inverse);
      }
      if (forward.length > 0) {
        void mutateGraphUndoable("Toggle AI exclusion", forward, inverse).catch(notifyIpcError);
      }
      return;
    }

    const targetVal = selectedNodes.some((n) => !n.layout.collapsed);
    for (const n of selectedNodes) {
      if (n.layout.collapsed === targetVal) continue;
      const entry = buildUpdateMetaWithInverse(n, { collapsed: targetVal });
      forward.push(...entry.forward);
      inverse.push(...entry.inverse);
    }
    if (forward.length > 0) {
      void mutateGraphUndoable("Collapse selection", forward, inverse).catch(notifyIpcError);
    }
  };

  const handleBulkDelete = (): void => {
    const ids = Array.from(currentSelected);
    if (ids.length === 0) {
      return;
    }
    const { forward, inverse } = buildDeleteWithInverse(
      ids,
      nodesMap,
      edgesMap,
      groupsMap.value,
    );
    if (forward.length > 0) {
      void mutateGraphUndoable(`Delete ${ids.length} nodes`, forward, inverse).catch(
        notifyIpcError,
      );
    }
  };

  const handleAlign = (mode: AlignMode): void => {
    const { prev, next } = computeAlignmentMoves(currentSelected, nodesMap, mode);
    if (next.length === 0) {
      return;
    }
    const { forward, inverse } = buildMoveNodesWithInverse(prev, next);
    const labelByMode: Record<AlignMode, string> = {
      left: "Align left",
      top: "Align top",
      distribute_h: "Distribute horizontally",
      distribute_v: "Distribute vertically",
    };
    void mutateGraphUndoable(labelByMode[mode], forward, inverse).catch(notifyIpcError);
  };

  const handleCreateFirstNode = (): void => {
    const ctrl = cameraControllerRef.current;
    const cam = ctrl?.getCamera() ?? { x: 0, y: 0, zoom: 1, last_focus_id: null };
    const center = screenToWorld(viewportSize.width / 2, viewportSize.height / 2, cam);
    const now = Date.now();
    const node: NodeDto = {
      id: `node_${now}_${Math.random().toString(36).slice(2, 7)}`,
      type: "core",
      status: "active",
      title: "New Concept",
      content: "",
      summary: "",
      content_hash: "",
      summary_hash: "",
      metadata: {
        severity: null,
        lens: "manual",
        created_by: "user",
        model: null,
        token_count: 3,
      },
      context_controls: { pin_global: false, exclude_from_ai: false },
      layout: {
        x: center.x - 160,
        y: center.y - 90,
        width: 320,
        height: 180,
        collapsed: false,
      },
      created_at: now,
      updated_at: now,
    };
    const { forward, inverse } = buildCreateNodeWithInverse(node);
    void mutateGraphUndoable("New free node", forward, inverse)
      .then((res) => {
        const created = res.updated_nodes.find((n) => n.id === node.id) ?? node;
        selectSingle(created.id);
        enterEditMode(created);
      })
      .catch(notifyIpcError);
  };

  const handleConnectEdge = (edgeType: EdgeType): void => {
    if (!activePopover) {
      return;
    }
    const { sourceId, targetId } = activePopover;
    edgePopover.value = null;
    modalState.value = "navigate";
    void connectNodesWithEdge(sourceId, targetId, edgeType).catch(notifyIpcError);
  };

  const handleJumpToFirstStale = (): void => {
    const firstId = staleNodesMap.value.keys().next().value;
    if (!firstId) {
      return;
    }
    selectSingle(firstId);
    const node = nodesMap.get(firstId);
    const ctrl = cameraControllerRef.current;
    if (!node || !ctrl) {
      return;
    }
    const w = node.layout.width ?? 320;
    const h = getEffectiveNodeHeight(node);
    const cx = node.layout.x + w / 2;
    const cy = node.layout.y + h / 2;
    const cam = ctrl.getCamera();
    const vp = ctrl.getViewportSize();
    const targetZoom = clampZoom(Math.max(cam.zoom, 0.85));
    ctrl.animateTo(
      {
        x: vp.width / 2 - cx * targetZoom,
        y: vp.height / 2 - cy * targetZoom,
        zoom: targetZoom,
      },
      220,
    );
  };

  return (
    <main
      ref={shellRef}
      class="axiom-canvas-shell"
      data-workspace-ready={workspaceReady ? "true" : "false"}
      data-node-count={String(nodesMap.size)}
      data-load-error={loadError ?? ""}
      data-graph-version={version}
    >
      <canvas ref={canvasRef} class="canvas-layer" />
      <CardLayer />
      <LiveEditorOverlay />

      {multiPillPos && (
        <div
          ref={multiPillRef}
          class="multi-select-pill"
          style={{
            transform: `translate3d(${multiPillPos.x}px, ${multiPillPos.y}px, 0) translate(-50%, -100%)`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span class="multi-select-pill__count">{currentSelected.size} selected</span>
          <button
            type="button"
            class="multi-select-pill__btn"
            title="Synthesize selected nodes (A S)"
            aria-label="Synthesize selected nodes"
            onClick={() => {
              void triggerLens("synthesize");
            }}
          >
            Synthesize
          </button>
          <button
            type="button"
            class="multi-select-pill__btn"
            title="Group selected nodes (G)"
            aria-label="Group selected nodes"
            onClick={() => {
              void createCanvasGroup().catch(notifyIpcError);
            }}
          >
            Group (G)
          </button>
          <button
            type="button"
            class="multi-select-pill__btn"
            title="Pin selected nodes to global AI context (P)"
            aria-label="Pin selected nodes"
            onClick={() => handleBulkMetaToggle("pin")}
          >
            Pin
          </button>
          <button
            type="button"
            class="multi-select-pill__btn"
            title="Exclude selected nodes from AI context (X)"
            aria-label="Exclude selected nodes"
            onClick={() => handleBulkMetaToggle("exclude")}
          >
            Exclude
          </button>
          <button
            type="button"
            class="multi-select-pill__btn"
            title="Fold or unfold selected nodes (C)"
            aria-label="Fold selected nodes"
            onClick={() => handleBulkMetaToggle("fold")}
          >
            Fold
          </button>
          <button
            type="button"
            class="multi-select-pill__btn"
            title="Zoom to fit selected nodes (F)"
            aria-label="Fit selected nodes"
            onClick={() => fitNodeIds(currentSelected)}
          >
            Fit
          </button>
          <button
            type="button"
            class="multi-select-pill__btn"
            title="Align left edges"
            aria-label="Align left"
            onClick={() => handleAlign("left")}
          >
            ⫢
          </button>
          <button
            type="button"
            class="multi-select-pill__btn"
            title="Align top edges"
            aria-label="Align top"
            onClick={() => handleAlign("top")}
          >
            ⊤
          </button>
          {currentSelected.size >= 3 && (
            <>
              <button
                type="button"
                class="multi-select-pill__btn"
                title="Distribute horizontally"
                aria-label="Distribute horizontally"
                onClick={() => handleAlign("distribute_h")}
              >
                ⫦
              </button>
              <button
                type="button"
                class="multi-select-pill__btn"
                title="Distribute vertically"
                aria-label="Distribute vertically"
                onClick={() => handleAlign("distribute_v")}
              >
                ⫧
              </button>
            </>
          )}
          <button
            type="button"
            class="multi-select-pill__btn multi-select-pill__btn--danger"
            title="Delete selected nodes (Del)"
            aria-label="Delete selected nodes"
            onClick={handleBulkDelete}
          >
            Delete
          </button>
        </div>
      )}

      {activeGroup && !interacting && currentModal === "navigate" && !birdsEye && (() => {
        const memberSet = new Set(activeGroup.member_ids);
        const selectionDiffers =
          currentSelected.size > 0 &&
          (currentSelected.size !== memberSet.size ||
            Array.from(currentSelected).some((id) => !memberSet.has(id)));
        const commitGroupTitle = (): void => {
          const nextTitle = groupTitleDraft.trim() || "Group";
          if (nextTitle !== activeGroup.title) {
            void updateCanvasGroup(activeGroup.id, { title: nextTitle }).catch(notifyIpcError);
          } else {
            setGroupTitleDraft(activeGroup.title);
          }
        };
        return (
          <div
            class="group-inspector-pill"
            role="region"
            aria-label="Group inspector"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <input
              type="text"
              class="group-inspector-pill__input"
              aria-label="Group title"
              value={groupTitleDraft}
              onInput={(e) => setGroupTitleDraft((e.target as HTMLInputElement).value)}
              onBlur={commitGroupTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitGroupTitle();
                  (e.currentTarget as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setGroupTitleDraft(activeGroup.title);
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
            />
            <div class="group-inspector-pill__swatches" role="group" aria-label="Group color">
              {GROUP_COLOR_KEYS.map((colorKey) => (
                <button
                  key={colorKey}
                  type="button"
                  class={`group-inspector-pill__swatch group-inspector-pill__swatch--${colorKey} ${
                    activeGroup.color_key === colorKey ? "group-inspector-pill__swatch--active" : ""
                  }`}
                  aria-label={`Group color ${colorKey}`}
                  aria-pressed={activeGroup.color_key === colorKey}
                  title={colorKey}
                  onClick={() => {
                    void updateCanvasGroup(activeGroup.id, { color_key: colorKey }).catch(
                      notifyIpcError,
                    );
                  }}
                />
              ))}
            </div>
            {selectionDiffers && (
              <button
                type="button"
                class="multi-select-pill__btn"
                onClick={() => {
                  void updateCanvasGroup(activeGroup.id, {
                    member_ids: Array.from(currentSelected),
                  }).catch(notifyIpcError);
                }}
              >
                Add / Sync Selection
              </button>
            )}
            <button
              type="button"
              class="multi-select-pill__btn multi-select-pill__btn--danger"
              onClick={() => {
                void deleteCanvasGroup(activeGroup.id).catch(notifyIpcError);
              }}
            >
              Ungroup
            </button>
          </div>
        );
      })()}

      {activePopover && clampedPopoverPos && (
        <div
          ref={edgePopoverRef}
          class="edge-popover"
          style={{
            transform: `translate3d(${clampedPopoverPos.x}px, ${clampedPopoverPos.y}px, 0) translate(-50%, -100%)`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {EDGE_POPOVER_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              type="button"
              class="edge-popover__btn"
              onClick={() => handleConnectEdge(opt.type)}
            >
              <span class="edge-popover__kbd">{opt.keyHint}</span>
              <span
                class="edge-popover__dot"
                style={{ backgroundColor: opt.colorVar }}
                aria-hidden="true"
              />
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      )}

      {currentModal === "chord_a" && (
        <div class="chord-hint-pill" role="status">
          R Red-Team · E Edge Cases · D Diverge 3x · F Feynman · Q Study · L Research · T Triage · S Synthesize · Space Prompt
        </div>
      )}

      {currentModal === "connect_edge" && activePopover === null && (
        <div class="chord-hint-pill" role="status">
          Connect mode: navigate with H/J/K/L and press Enter on target · Esc cancel
        </div>
      )}

      {currentModal === "navigate" && activeTriage !== null && (
        <div class="triage-hint-pill" role="status">
          {activeTriage}
        </div>
      )}

      {activeSpotlightRoot !== null && (
        <button
          type="button"
          class="spotlight-pill"
          title="Exit Focus Spotlight (Esc)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            clearSpotlight();
          }}
        >
          Focus Spotlight · Exit (Esc)
        </button>
      )}

      <div class="top-hud-stack">
        <XrayHud />
        {runStatus !== "idle" && (
          <div
            class={`ai-thinking-pill ${hasXray ? "ai-thinking-pill--below-xray" : ""}`}
            role="status"
            aria-live="polite"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span class="ai-thinking-pill__spinner" aria-hidden="true">
              <span class="ai-thinking-pill__dot" />
              <span class="ai-thinking-pill__dot" />
              <span class="ai-thinking-pill__dot" />
            </span>
            <span class="ai-thinking-pill__text">
              {runStatus === "thinking"
                ? `Thinking — ${runLabel ?? (runLens ? LENS_LABELS[runLens] : "AI")}…`
                : `Streaming — ${runSpawnedCount} card${runSpawnedCount === 1 ? "" : "s"}…`}
            </span>
            <button
              type="button"
              class="ai-thinking-pill__cancel"
              onClick={() => {
                cancelActiveRun();
              }}
            >
              Cancel (Esc)
            </button>
          </div>
        )}
      </div>

      {nodesMap.size === 0 && currentModal === "navigate" && (
        <div class="empty-canvas-prompt" onPointerDown={(e) => e.stopPropagation()}>
          <p class="empty-canvas-prompt__text">
            Press <kbd class="shortcuts-kbd">N</kbd> to create a node ·{" "}
            <kbd class="shortcuts-kbd">Ctrl+K</kbd> for commands ·{" "}
            <kbd class="shortcuts-kbd">?</kbd> for shortcuts
          </p>
          <button
            type="button"
            class="empty-canvas-prompt__btn"
            onClick={handleCreateFirstNode}
          >
            + New Node
          </button>
        </div>
      )}

      <div
        class={`canvas-controls ${isSidebarOpen ? "canvas-controls--shifted" : ""}`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          class="canvas-controls__btn"
          title="Zoom out (Ctrl/Cmd+-)"
          aria-label="Zoom out"
          onClick={() => cameraControllerRef.current?.zoomByStep?.(1 / 1.15)}
        >
          −
        </button>
        <button
          ref={zoomLabelRef}
          type="button"
          class="canvas-controls__btn canvas-controls__zoom"
          title="Reset zoom to 100% (Ctrl/Cmd+0)"
          aria-label="Reset zoom to 100%"
          onClick={() => cameraControllerRef.current?.resetZoom?.()}
        >
          100%
        </button>
        <button
          type="button"
          class="canvas-controls__btn"
          title="Zoom in (Ctrl/Cmd+=)"
          aria-label="Zoom in"
          onClick={() => cameraControllerRef.current?.zoomByStep?.(1.15)}
        >
          +
        </button>
        <span class="canvas-controls__sep" aria-hidden="true" />
        <button
          type="button"
          class="canvas-controls__btn"
          title="Fit entire graph (F F)"
          aria-label="Fit graph"
          onClick={() => fitNodeIds(nodesMap.keys())}
        >
          Fit
        </button>
        <button
          type="button"
          class={`canvas-controls__btn ${isMinimapOpen ? "canvas-controls__btn--active" : ""}`}
          title="Toggle Minimap (M)"
          aria-label="Toggle Minimap"
          aria-pressed={isMinimapOpen}
          onClick={() => {
            minimapOpen.value = !minimapOpen.value;
          }}
        >
          Map
        </button>
        <button
          type="button"
          class="canvas-controls__btn"
          title={flowEnabled ? "Pause connection flow" : "Play connection flow"}
          aria-label={flowEnabled ? "Pause connection flow" : "Play connection flow"}
          onClick={() => {
            edgeFlowEnabled.value = !edgeFlowEnabled.value;
          }}
        >
          {flowEnabled ? "⏸" : "▶"}
        </button>
        {activeLoopholeCount > 0 && (
          <>
            <span class="canvas-controls__sep" aria-hidden="true" />
            <button
              type="button"
              class="loophole-alert-pill"
              title="Jump to highest-severity active loophole (A T / [ ])"
              onClick={() => {
                startLoopholeTriage();
              }}
            >
              ⚠ {activeLoopholeCount}
            </button>
          </>
        )}
        {staleCount > 0 && (
          <>
            <span class="canvas-controls__sep" aria-hidden="true" />
            <button
              type="button"
              class="stale-alert-pill"
              title="Jump to first stale AI node"
              onClick={handleJumpToFirstStale}
            >
              ⟳ {staleCount} stale
            </button>
          </>
        )}
        <span class="canvas-controls__sep" aria-hidden="true" />
        <button
          type="button"
          class={`canvas-controls__btn ${isDiagnosticsOpen ? "canvas-controls__btn--active" : ""}`}
          title="Graph Health & Diagnostics (Shift+H)"
          aria-label="Graph Health & Diagnostics"
          aria-pressed={isDiagnosticsOpen}
          onClick={() => {
            openDiagnosticsModal();
          }}
        >
          ♥ Health
        </button>
        <button
          type="button"
          class={`canvas-controls__btn ${isCheckpointsOpen ? "canvas-controls__btn--active" : ""}`}
          title="Checkpoints & Graph Diff (Shift+S)"
          aria-label="Checkpoints & Graph Diff"
          aria-pressed={isCheckpointsOpen}
          onClick={() => {
            openCheckpointsModal();
          }}
        >
          ⚑
        </button>
        <button
          type="button"
          class={`canvas-controls__btn ${isStudyOpen ? "canvas-controls__btn--active" : ""}`}
          title="Study & Recall Studio (Shift+Q)"
          aria-label="Study & Recall Studio"
          aria-pressed={isStudyOpen}
          onClick={() => {
            void openStudyModal().catch(notifyIpcError);
          }}
        >
          <span>Study</span>
          {dueStudy > 0 && <span class="study-due-pill">{dueStudy}</span>}
        </button>
        <button
          type="button"
          class="canvas-controls__btn"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          onClick={() => {
            shortcutsHelpOpen.value = !shortcutsHelpOpen.value;
          }}
        >
          ?
        </button>
      </div>

      <WorkspaceSidebar />
      <SpineBreadcrumb />
      <RelatedNodesPopover />
      <EdgeInspectorPill />
      <MinimapOverlay />
      <NodeContextMenu />
      <PerfHud />
      <CommandPalette />
      <CustomPromptBar />
      <ArtifactExportModal />
      <DiagnosticsModal />
      <CheckpointsModal />
      <StudyDeckModal />
      <OutlineImportModal />
      <SettingsModal />
      <ShortcutsModal />
      <ToastStack />
    </main>
  );
}

import { useEffect, useRef, useState } from "preact/hooks";
import { CanvasCameraController, screenToWorld, worldToScreen } from "./canvas/camera";
import { globalFrameTracker } from "./canvas/perfMetrics";
import { attachCanvasPointer, type PointerOverlayState } from "./canvas/pointer";
import { renderCanvas2d } from "./canvas/renderer2d";
import { getEffectiveNodeHeight } from "./canvas/spatialIndex";
import { CardLayer } from "./cards/CardLayer";
import { LiveEditorOverlay } from "./cards/LiveEditorOverlay";
import { attachKeymap } from "./input/keymap";
import {
  getSettings,
  isTauriRuntime,
  listenSummaryUpdated,
  saveCamera,
} from "./ipc/client";
import type { EdgeDto, EdgeType, GraphOp, NodeDto } from "./ipc/types";
import { CommandPalette } from "./overlays/CommandPalette";
import { CustomPromptBar } from "./overlays/CustomPromptBar";
import { NodeContextMenu } from "./overlays/NodeContextMenu";
import { PerfHud } from "./overlays/PerfHud";
import { SettingsModal } from "./overlays/SettingsModal";
import { ShortcutsModal } from "./overlays/ShortcutsModal";
import { notifyIpcError, ToastStack } from "./overlays/ToastStack";
import { WorkspaceSidebar } from "./overlays/WorkspaceSidebar";
import { XrayHud } from "./overlays/XrayHud";
import {
  activeRunLens,
  activeRunSpawnedCount,
  activeRunStatus,
  applySummaryUpdate,
  cancelActiveRun,
  LENS_LABELS,
  triageBanner,
  triggerLens,
} from "./store/aiRunner";
import {
  cameraControllerRef,
  dragOffsets,
  edgeFlowEnabled,
  edgesMap,
  graphVersion,
  isBirdsEye,
  mutateGraphUndoable,
  nodesMap,
  resizeSizes,
  theme,
  tokenBudget,
  unresolvedLoopholes,
  viewportSpatialIndex,
  visibleNodeIds,
} from "./store/graphStore";
import { buildCreateNodeWithInverse } from "./store/history";
import {
  edgePopover,
  enterEditMode,
  focusId,
  hoveredId,
  isInteracting,
  modalState,
  selectedIds,
  selectSingle,
  shortcutsHelpOpen,
  xrayState,
} from "./store/selection";
import { initWorkspaceCatalog } from "./store/workspaceCatalogStore";

export function App() {
  const shellRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const zoomLabelRef = useRef<HTMLButtonElement | null>(null);
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
  const runSpawnedCount = activeRunSpawnedCount.value;

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
    document.documentElement.setAttribute("data-theme", theme.value);
    cameraControllerRef.current?.markDirty();
  }, [theme.value]);

  useEffect(() => {
    cameraControllerRef.current?.setContinuousAnimation?.(shouldAnimateEdges);
    cameraControllerRef.current?.markDirty();
  }, [shouldAnimateEdges]);

  useEffect(() => {
    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!shell || !canvas) {
      return;
    }

    const overlay: PointerOverlayState = {
      marqueeWorld: null,
      edgePreviewWorld: null,
    };

    const controller = new CanvasCameraController({
      canvas,
      cardLayerEl: null,
      renderFrame: (ctx, cam, width, height) => {
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
          xrayState: xrayState.value,
          unresolvedLoopholes: unresolvedLoopholes.value,
          marqueeWorld: overlay.marqueeWorld,
          edgePreviewWorld: overlay.edgePreviewWorld,
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
          theme.value = s.theme;
          tokenBudget.value = s.default_token_budget;
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
  }, [version, currentSelected, focusId.value, hoveredId.value, xrayState.value]);

  const viewportSize = cameraControllerRef.current?.getViewportSize() ?? {
    width: typeof window !== "undefined" ? window.innerWidth : 1280,
    height: typeof window !== "undefined" ? window.innerHeight : 800,
  };
  const clampOverlayPoint = (rawX: number, rawY: number): { x: number; y: number } => {
    const maxX = Math.max(64, viewportSize.width - 64);
    const maxY = Math.max(48, viewportSize.height - 64);
    return {
      x: Math.max(64, Math.min(maxX, rawX)),
      y: Math.max(48, Math.min(maxY, rawY)),
    };
  };

  let multiPillPos: { x: number; y: number } | null = null;
  if (
    currentSelected.size >= 2 &&
    !birdsEye &&
    !interacting &&
    currentModal === "navigate" &&
    cameraControllerRef.current
  ) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    for (const id of currentSelected) {
      const node = nodesMap.get(id);
      if (!node) continue;
      minX = Math.min(minX, node.layout.x);
      minY = Math.min(minY, node.layout.y);
      maxX = Math.max(maxX, node.layout.x + node.layout.width);
      void getEffectiveNodeHeight(node);
    }
    if (Number.isFinite(minX)) {
      const screenPt = worldToScreen(
        (minX + maxX) / 2,
        minY,
        cameraControllerRef.current.getCamera(),
      );
      multiPillPos = clampOverlayPoint(screenPt.x, screenPt.y - 12);
    }
  }

  const clampedPopoverPos = activePopover
    ? clampOverlayPoint(activePopover.x, activePopover.y)
    : null;

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
    const edge: EdgeDto = {
      id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      source_id: activePopover.sourceId,
      target_id: activePopover.targetId,
      type: edgeType,
      weight: "summary",
      created_at: Date.now(),
    };
    const inverse: GraphOp[] = [{ op: "delete_edge", id: edge.id }];
    if (edgeType === "resolves") {
      const target = nodesMap.get(activePopover.targetId);
      if (target && target.type === "loophole" && target.status !== "resolved") {
        inverse.push({ op: "update_node_meta", id: target.id, status: target.status });
      }
    }
    edgePopover.value = null;
    modalState.value = "navigate";
    void mutateGraphUndoable("Create edge", [{ op: "create_edge", edge }], inverse).catch(
      notifyIpcError,
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
          class="multi-select-pill"
          style={{ left: `${multiPillPos.x}px`, top: `${multiPillPos.y}px` }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            class="multi-select-pill__btn"
            onClick={() => {
              void triggerLens("synthesize");
            }}
          >
            Synthesize (A S)
          </button>
        </div>
      )}

      {activePopover && clampedPopoverPos && (
        <div
          class="edge-popover"
          style={{ left: `${clampedPopoverPos.x}px`, top: `${clampedPopoverPos.y}px` }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            class="edge-popover__btn"
            onClick={() => handleConnectEdge("references")}
          >
            References
          </button>
          <button
            type="button"
            class="edge-popover__btn"
            onClick={() => handleConnectEdge("resolves")}
          >
            Resolves
          </button>
          <button
            type="button"
            class="edge-popover__btn"
            onClick={() => handleConnectEdge("derives")}
          >
            Derives
          </button>
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

      {runStatus !== "idle" && (
        <div
          class="ai-thinking-pill"
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
              ? `Thinking — ${runLens ? LENS_LABELS[runLens] : "AI"}…`
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

      <div class="canvas-controls" onPointerDown={(e) => e.stopPropagation()}>
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
          title={flowEnabled ? "Pause connection flow" : "Play connection flow"}
          aria-label={flowEnabled ? "Pause connection flow" : "Play connection flow"}
          onClick={() => {
            edgeFlowEnabled.value = !edgeFlowEnabled.value;
          }}
        >
          {flowEnabled ? "⏸" : "▶"}
        </button>
        <span class="canvas-controls__sep" aria-hidden="true" />
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
      <NodeContextMenu />
      <XrayHud />
      <PerfHud />
      <CommandPalette />
      <CustomPromptBar />
      <SettingsModal />
      <ShortcutsModal />
      <ToastStack />
    </main>
  );
}

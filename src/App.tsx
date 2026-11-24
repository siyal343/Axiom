import { useEffect, useRef, useState } from "preact/hooks";
import { CanvasCameraController, worldToScreen } from "./canvas/camera";
import { attachCanvasPointer, type PointerOverlayState } from "./canvas/pointer";
import { renderCanvas2d } from "./canvas/renderer2d";
import { getEffectiveNodeHeight } from "./canvas/spatialIndex";
import { CardLayer } from "./cards/CardLayer";
import { LiveEditorOverlay } from "./cards/LiveEditorOverlay";
import { isTauriRuntime, openWorkspace, saveCamera } from "./ipc/client";
import type { EdgeDto, EdgeType } from "./ipc/types";
import {
  cameraControllerRef,
  dragOffsets,
  graphVersion,
  isBirdsEye,
  loadSnapshot,
  mutateGraph,
  nodesMap,
  theme,
  unresolvedLoopholes,
  viewportSpatialIndex,
  visibleNodeIds,
  edgesMap,
} from "./store/graphStore";
import {
  edgePopover,
  focusId,
  isInteracting,
  modalState,
  selectedIds,
  xrayState,
} from "./store/selection";

export function App() {
  const shellRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Subscribe to signals needed for Layer 3 floating pills and data attributes
  const version = graphVersion.value;
  const currentSelected = selectedIds.value;
  const activePopover = edgePopover.value;
  const birdsEye = isBirdsEye.value;
  const interacting = isInteracting.value;
  const currentModal = modalState.value;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme.value);
    cameraControllerRef.current?.markDirty();
  }, [theme.value]);

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
          selectedIds: selectedIds.value,
          focusId: focusId.value,
          xrayState: xrayState.value,
          unresolvedLoopholes: unresolvedLoopholes.value,
          marqueeWorld: overlay.marqueeWorld,
          edgePreviewWorld: overlay.edgePreviewWorld,
          themeKey: theme.value,
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
    });

    cameraControllerRef.current = controller;

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

    let active = true;
    if (isTauriRuntime()) {
      openWorkspace("")
        .then((ws) => {
          if (!active) {
            return;
          }
          loadSnapshot(ws);
          setWorkspaceReady(true);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : JSON.stringify(err);
          console.error("Failed to open default workspace:", err);
          if (active) {
            setLoadError(message);
          }
        });
    }

    return () => {
      active = false;
      detachPointer();
      resizeObs?.disconnect();
      controller.dispose();
      if (cameraControllerRef.current === controller) {
        cameraControllerRef.current = null;
      }
    };
  }, []);

  // Re-paint canvas when reactive selection/xray/graph signals change
  useEffect(() => {
    cameraControllerRef.current?.markDirty();
  }, [version, currentSelected, focusId.value, xrayState.value]);

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
      // Include effective height read for consistency if needed later
      void getEffectiveNodeHeight(node);
    }
    if (Number.isFinite(minX)) {
      const screenPt = worldToScreen(
        (minX + maxX) / 2,
        minY,
        cameraControllerRef.current.getCamera(),
      );
      multiPillPos = { x: screenPt.x, y: screenPt.y - 12 };
    }
  }

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
    edgePopover.value = null;
    modalState.value = "navigate";
    void mutateGraph([{ op: "create_edge", edge }]);
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
              modalState.value = "chord_a";
            }}
          >
            Synthesize (A S)
          </button>
        </div>
      )}

      {activePopover && (
        <div
          class="edge-popover"
          style={{ left: `${activePopover.x}px`, top: `${activePopover.y}px` }}
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
    </main>
  );
}

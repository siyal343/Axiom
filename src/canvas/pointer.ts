import type { BBox } from "rbush";
import type { NodePositionUpdate, NodeSizeUpdate, SpawnDirection } from "../ipc/types";
import {
  cardDomRefs,
  dragOffsets,
  edgesMap,
  groupsMap,
  isBirdsEye,
  MAX_NODE_HEIGHT,
  MAX_NODE_WIDTH,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  mutateGraph,
  mutateGraphUndoable,
  nodesMap,
  resizeSizes,
  resolveAndAnimateOverlaps,
  selectedGroupId,
  viewportSpatialIndex,
} from "../store/graphStore";
import {
  buildMoveNodesWithInverse,
  buildResizeNodesWithInverse,
  graphHistory,
  syncHistorySignals,
} from "../store/history";
import {
  clearSelection,
  connectSourceId,
  edgePopover,
  enterEditMode,
  focusId,
  isInteracting,
  modalState,
  nodeContextMenu,
  selectedEdgeId,
  selectedIds,
  selectEdge,
  selectSingle,
  setSelection,
  toggleSelect,
} from "../store/selection";
import { clampZoom, LOD_THRESHOLD, screenToWorld, type CanvasCameraController } from "./camera";
import { buildSceneRects, hitTestEdge, hitTestGroupHeader, type EdgePreview, type MarqueeRect } from "./renderer2d";
import { getEffectiveNodeHeight } from "./spatialIndex";

const GRID_SNAP_PX = 12;
const DRAG_THRESHOLD_PX = 4;
const PORT_DRAG_THRESHOLD_PX = 6;

export interface PointerOverlayState {
  marqueeWorld: MarqueeRect | null;
  edgePreviewWorld: EdgePreview | null;
  hoveredEdgeId?: string | null;
}

type ActiveGesture =
  | {
      kind: "pan";
      lastClientX: number;
      lastClientY: number;
    }
  | {
      kind: "node_drag";
      primaryId: string;
      dragIds: string[];
      startClientX: number;
      startClientY: number;
      moved: boolean;
      groupId?: string;
    }
  | {
      kind: "node_resize";
      nodeId: string;
      handle: "e" | "s" | "se";
      startClientX: number;
      startClientY: number;
      startWidth: number;
      startHeight: number;
      moved: boolean;
    }
  | {
      kind: "marquee";
      startWorldX: number;
      startWorldY: number;
      startClientX: number;
      startClientY: number;
      moved: boolean;
    }
  | {
      kind: "port_pending";
      sourceId: string;
      portDir: SpawnDirection;
      startClientX: number;
      startClientY: number;
    }
  | {
      kind: "edge_connect";
      sourceId: string;
      fromPort?: boolean;
    };

function hitTestNodeAtWorld(worldPt: { x: number; y: number }): string | null {
  const hits = viewportSpatialIndex.queryRect({
    minX: worldPt.x,
    minY: worldPt.y,
    maxX: worldPt.x,
    maxY: worldPt.y,
  });
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const id = hits[i];
    if (!id) continue;
    const node = nodesMap.get(id);
    if (!node) continue;
    const offset = dragOffsets.get(id);
    const resized = resizeSizes.get(id);
    const x = node.layout.x + (offset?.x ?? 0);
    const y = node.layout.y + (offset?.y ?? 0);
    const w = resized ? resized.width : node.layout.width;
    const h = node.layout.collapsed
      ? getEffectiveNodeHeight(node)
      : resized
        ? resized.height
        : node.layout.height;
    if (worldPt.x >= x && worldPt.x <= x + w && worldPt.y >= y && worldPt.y <= y + h) {
      return id;
    }
  }
  return null;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.closest("[data-resize-handle]")) {
    return false;
  }
  return Boolean(
    target.closest(
      "button, input, textarea, select, a, .cm-editor, .live-editor-overlay, .hover-pill, .edge-popover, .edge-inspector-pill, .minimap-card, .multi-select-pill, .group-inspector-pill, .node-context-menu, .workspace-sidebar, .sidebar-toggle-bar, .editor-tag-menu, .axiom-sim",
    ),
  );
}

function snapDelta(val: number): number {
  return Math.round(val / GRID_SNAP_PX) * GRID_SNAP_PX;
}

export function attachCanvasPointer(
  shellEl: HTMLElement,
  camera: CanvasCameraController,
  overlay: PointerOverlayState,
): () => void {
  let gesture: ActiveGesture | null = null;
  let spaceHeld = false;
  let hoveredGroupId: string | null = null;

  const toLocalCoords = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = shellEl.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const updateCursor = (): void => {
    if (gesture?.kind === "pan") {
      shellEl.style.cursor = "grabbing";
    } else if (gesture?.kind === "node_resize") {
      shellEl.style.cursor =
        gesture.handle === "e"
          ? "ew-resize"
          : gesture.handle === "s"
            ? "ns-resize"
            : "nwse-resize";
    } else if (spaceHeld) {
      shellEl.style.cursor = "grab";
    } else if (gesture?.kind === "edge_connect") {
      shellEl.style.cursor = "crosshair";
    } else if (hoveredGroupId) {
      shellEl.style.cursor = "grab";
    } else if (overlay.hoveredEdgeId) {
      shellEl.style.cursor = "pointer";
    } else {
      shellEl.style.cursor = "default";
    }
  };

  const applyDragDomTransforms = (): void => {
    for (const [id, offset] of dragOffsets.entries()) {
      const el = cardDomRefs.get(id);
      const node = nodesMap.get(id);
      if (el && node) {
        el.style.transform = `translate3d(${node.layout.x + offset.x}px, ${node.layout.y + offset.y}px, 0)`;
      }
    }
  };

  const onPointerDown = (e: PointerEvent): void => {
    const downTarget = e.target instanceof Element ? e.target : null;
    if (!downTarget?.closest(".node-context-menu")) {
      nodeContextMenu.value = null;
    }
    if (modalState.value === "edit" || modalState.value === "command") {
      return;
    }

    // Middle-mouse drag OR Space + Left-Drag pans canvas
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      if (isInteractiveTarget(e.target)) {
        return;
      }
      e.preventDefault();
      edgePopover.value = null;
      if (overlay.hoveredEdgeId) {
        overlay.hoveredEdgeId = null;
      }
      isInteracting.value = true;
      gesture = {
        kind: "pan",
        lastClientX: e.clientX,
        lastClientY: e.clientY,
      };
      shellEl.setPointerCapture(e.pointerId);
      updateCursor();
      return;
    }

    if (e.button !== 0) {
      return;
    }

    // Direct port-drag edge wiring (movement < 6px leaves click intact to spawn child)
    const portEl = downTarget?.closest<HTMLElement>("[data-port-dir]");
    if (portEl && modalState.value === "navigate") {
      const portDir = portEl.dataset.portDir;
      const portNodeId =
        portEl.dataset.portNodeId ??
        portEl.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId ??
        null;
      if (
        portNodeId &&
        nodesMap.has(portNodeId) &&
        (portDir === "top" || portDir === "right" || portDir === "bottom" || portDir === "left")
      ) {
        gesture = {
          kind: "port_pending",
          sourceId: portNodeId,
          portDir,
          startClientX: e.clientX,
          startClientY: e.clientY,
        };
        return;
      }
    }

    if (isInteractiveTarget(e.target)) {
      return;
    }

    const targetEl = downTarget;
    const resizeEl = targetEl?.closest<HTMLElement>("[data-resize-handle]");
    const resizeCardEl = resizeEl?.closest<HTMLElement>("[data-node-id]");
    const resizeNodeId = resizeCardEl?.dataset.nodeId ?? null;
    const handleKind = resizeEl?.dataset.resizeHandle;
    if (
      resizeEl &&
      (handleKind === "e" || handleKind === "s" || handleKind === "se") &&
      resizeNodeId !== null
    ) {
      const resizeNode = nodesMap.get(resizeNodeId);
      if (resizeNode && !resizeNode.layout.collapsed) {
        e.preventDefault();
        edgePopover.value = null;
        selectSingle(resizeNodeId);
        isInteracting.value = true;
        gesture = {
          kind: "node_resize",
          nodeId: resizeNodeId,
          handle: handleKind,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startWidth: resizeNode.layout.width,
          startHeight: resizeNode.layout.height,
          moved: false,
        };
        shellEl.setPointerCapture(e.pointerId);
        updateCursor();
        return;
      }
    }

    const cardEl = targetEl?.closest<HTMLElement>("[data-node-id]");
    let nodeId = cardEl?.dataset.nodeId ?? null;
    if (
      !nodeId &&
      (isBirdsEye.value || targetEl === shellEl || targetEl?.classList.contains("canvas-layer"))
    ) {
      const local = toLocalCoords(e.clientX, e.clientY);
      const worldPt = screenToWorld(local.x, local.y, camera.getCamera());
      nodeId = hitTestNodeAtWorld(worldPt);
    }

    if (nodeId !== null && nodesMap.has(nodeId)) {
      if (overlay.hoveredEdgeId) {
        overlay.hoveredEdgeId = null;
      }
      if (modalState.value === "connect_edge" && connectSourceId.value) {
        const sourceId = connectSourceId.value;
        if (sourceId !== nodeId) {
          e.preventDefault();
          connectSourceId.value = null;
          edgePopover.value = {
            sourceId,
            targetId: nodeId,
            x: e.clientX,
            y: e.clientY,
          };
          camera.markDirty();
          updateCursor();
        }
        return;
      }

      edgePopover.value = null;
      if (e.shiftKey) {
        e.preventDefault();
        const local = toLocalCoords(e.clientX, e.clientY);
        const worldPt = screenToWorld(local.x, local.y, camera.getCamera());
        if (e.altKey) {
          isInteracting.value = true;
          gesture = { kind: "edge_connect", sourceId: nodeId };
          overlay.edgePreviewWorld = {
            sourceId: nodeId,
            targetX: worldPt.x,
            targetY: worldPt.y,
          };
          shellEl.setPointerCapture(e.pointerId);
          camera.markDirty();
          updateCursor();
          return;
        }
        toggleSelect(nodeId);
      } else {
        if (e.altKey) {
          e.preventDefault();
          const local = toLocalCoords(e.clientX, e.clientY);
          const worldPt = screenToWorld(local.x, local.y, camera.getCamera());
          isInteracting.value = true;
          gesture = { kind: "edge_connect", sourceId: nodeId };
          overlay.edgePreviewWorld = {
            sourceId: nodeId,
            targetX: worldPt.x,
            targetY: worldPt.y,
          };
          shellEl.setPointerCapture(e.pointerId);
          camera.markDirty();
          updateCursor();
          return;
        }
        if (!selectedIds.value.has(nodeId)) {
          selectSingle(nodeId);
        } else {
          focusId.value = nodeId;
          selectedEdgeId.value = null;
        }
      }
      if (selectedGroupId.value !== null) {
        selectedGroupId.value = null;
      }

      const dragIds = selectedIds.value.has(nodeId)
        ? Array.from(selectedIds.value)
        : [nodeId];

      gesture = {
        kind: "node_drag",
        primaryId: nodeId,
        dragIds,
        startClientX: e.clientX,
        startClientY: e.clientY,
        moved: false,
      };
      return;
    }

    // Empty canvas click / group header / edge hit / marquee box-select
    edgePopover.value = null;
    if (modalState.value === "connect_edge") {
      modalState.value = "navigate";
      connectSourceId.value = null;
    }
    const local = toLocalCoords(e.clientX, e.clientY);
    const cam = camera.getCamera();
    const worldStart = screenToWorld(local.x, local.y, cam);

    if (!e.shiftKey && groupsMap.value.size > 0) {
      const sceneRects = buildSceneRects(nodesMap, dragOffsets, resizeSizes);
      const hitGroup = hitTestGroupHeader(worldStart, groupsMap.value, sceneRects, cam.zoom);
      if (hitGroup) {
        e.preventDefault();
        const memberIds = hitGroup.member_ids.filter((id) => nodesMap.has(id));
        setSelection(memberIds, memberIds[0] ?? null);
        selectedGroupId.value = hitGroup.id;
        if (memberIds.length > 0) {
          gesture = {
            kind: "node_drag",
            primaryId: memberIds[0],
            dragIds: memberIds,
            startClientX: e.clientX,
            startClientY: e.clientY,
            moved: false,
            groupId: hitGroup.id,
          };
        }
        camera.markDirty();
        updateCursor();
        return;
      }
    }

    if (!e.shiftKey) {
      if (selectedGroupId.value !== null) {
        selectedGroupId.value = null;
      }
      const hitEdgeId = hitTestEdge(
        worldStart.x,
        worldStart.y,
        nodesMap,
        edgesMap,
        dragOffsets,
        resizeSizes,
        cam.zoom,
      );
      if (hitEdgeId) {
        selectEdge(hitEdgeId);
        camera.markDirty();
        return;
      }
    }

    if (selectedEdgeId.value !== null) {
      selectedEdgeId.value = null;
      camera.markDirty();
    }

    gesture = {
      kind: "marquee",
      startWorldX: worldStart.x,
      startWorldY: worldStart.y,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
    };
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!gesture) {
      if (modalState.value !== "navigate") {
        return;
      }
      const moveTarget = e.target instanceof Element ? e.target : null;
      if (moveTarget?.closest("[data-node-id]") || isInteractiveTarget(e.target)) {
        if ((overlay.hoveredEdgeId ?? null) !== null || hoveredGroupId !== null) {
          overlay.hoveredEdgeId = null;
          hoveredGroupId = null;
          updateCursor();
          camera.markDirty();
        }
        return;
      }
      const local = toLocalCoords(e.clientX, e.clientY);
      const cam = camera.getCamera();
      const worldPt = screenToWorld(local.x, local.y, cam);
      const overBirdsEyeNode = cam.zoom < LOD_THRESHOLD && hitTestNodeAtWorld(worldPt) !== null;
      let nextHoveredGroup: string | null = null;
      if (!overBirdsEyeNode && groupsMap.value.size > 0) {
        const sceneRects = buildSceneRects(nodesMap, dragOffsets, resizeSizes);
        nextHoveredGroup = hitTestGroupHeader(worldPt, groupsMap.value, sceneRects, cam.zoom)?.id ?? null;
      }
      const nextHoveredEdge =
        overBirdsEyeNode || nextHoveredGroup !== null
          ? null
          : hitTestEdge(
              worldPt.x,
              worldPt.y,
              nodesMap,
              edgesMap,
              dragOffsets,
              resizeSizes,
              cam.zoom,
            );
      if ((overlay.hoveredEdgeId ?? null) !== nextHoveredEdge || hoveredGroupId !== nextHoveredGroup) {
        overlay.hoveredEdgeId = nextHoveredEdge;
        hoveredGroupId = nextHoveredGroup;
        updateCursor();
        camera.markDirty();
      }
      return;
    }

    if (gesture.kind === "port_pending") {
      if (Math.hypot(e.clientX - gesture.startClientX, e.clientY - gesture.startClientY) < PORT_DRAG_THRESHOLD_PX) {
        return;
      }
      const sourceId = gesture.sourceId;
      const portDir = gesture.portDir;
      const local = toLocalCoords(e.clientX, e.clientY);
      const worldPt = screenToWorld(local.x, local.y, camera.getCamera());
      gesture = { kind: "edge_connect", sourceId, fromPort: true };
      isInteracting.value = true;
      overlay.hoveredEdgeId = null;
      overlay.edgePreviewWorld = {
        sourceId,
        sourceDir: portDir,
        targetX: worldPt.x,
        targetY: worldPt.y,
      };
      try {
        shellEl.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events may lack an active pointerId.
      }
      camera.markDirty();
      updateCursor();
      return;
    }

    if (gesture.kind === "pan") {
      const dx = e.clientX - gesture.lastClientX;
      const dy = e.clientY - gesture.lastClientY;
      gesture.lastClientX = e.clientX;
      gesture.lastClientY = e.clientY;
      camera.panBy(dx, dy);
      return;
    }

    if (gesture.kind === "edge_connect") {
      const local = toLocalCoords(e.clientX, e.clientY);
      const worldPt = screenToWorld(local.x, local.y, camera.getCamera());
      overlay.edgePreviewWorld = {
        sourceId: gesture.sourceId,
        sourceDir: overlay.edgePreviewWorld?.sourceDir,
        targetX: worldPt.x,
        targetY: worldPt.y,
      };
      camera.markDirty();
      return;
    }

    if (gesture.kind === "node_resize") {
      const screenDx = e.clientX - gesture.startClientX;
      const screenDy = e.clientY - gesture.startClientY;
      if (!gesture.moved && Math.hypot(screenDx, screenDy) >= DRAG_THRESHOLD_PX) {
        gesture.moved = true;
      }
      const zoom = camera.getCamera().zoom;
      const worldDx = screenDx / zoom;
      const worldDy = screenDy / zoom;

      let nextW = gesture.startWidth;
      let nextH = gesture.startHeight;
      if (gesture.handle === "e" || gesture.handle === "se") {
        const rawW = gesture.startWidth + worldDx;
        const snappedW = e.altKey ? rawW : snapDelta(rawW);
        nextW = Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, Math.round(snappedW)));
      }
      if (gesture.handle === "s" || gesture.handle === "se") {
        const rawH = gesture.startHeight + worldDy;
        const snappedH = e.altKey ? rawH : snapDelta(rawH);
        nextH = Math.max(MIN_NODE_HEIGHT, Math.min(MAX_NODE_HEIGHT, Math.round(snappedH)));
      }

      resizeSizes.set(gesture.nodeId, { width: nextW, height: nextH });
      const el = cardDomRefs.get(gesture.nodeId);
      if (el) {
        el.style.width = `${nextW}px`;
        el.style.minHeight = `${nextH}px`;
      }
      camera.markDirty();
      return;
    }

    if (gesture.kind === "node_drag") {
      const screenDx = e.clientX - gesture.startClientX;
      const screenDy = e.clientY - gesture.startClientY;
      if (!gesture.moved && Math.hypot(screenDx, screenDy) < DRAG_THRESHOLD_PX) {
        return;
      }
      if (!gesture.moved) {
        gesture.moved = true;
        isInteracting.value = true;
        try {
          shellEl.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic events may lack an active pointerId.
        }
      }
      const zoom = camera.getCamera().zoom;
      let worldDx = screenDx / zoom;
      let worldDy = screenDy / zoom;

      if (!e.altKey) {
        const primary = nodesMap.get(gesture.primaryId);
        if (primary) {
          const snappedX = snapDelta(primary.layout.x + worldDx);
          const snappedY = snapDelta(primary.layout.y + worldDy);
          worldDx = snappedX - primary.layout.x;
          worldDy = snappedY - primary.layout.y;
        }
      }

      for (const id of gesture.dragIds) {
        dragOffsets.set(id, { x: worldDx, y: worldDy });
      }
      applyDragDomTransforms();
      camera.markDirty();
      return;
    }

    if (gesture.kind === "marquee") {
      const dist = Math.hypot(
        e.clientX - gesture.startClientX,
        e.clientY - gesture.startClientY,
      );
      if (!gesture.moved && dist < DRAG_THRESHOLD_PX) {
        return;
      }
      if (!gesture.moved) {
        gesture.moved = true;
        isInteracting.value = true;
        try {
          shellEl.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic events may lack an active pointerId.
        }
      }
      const local = toLocalCoords(e.clientX, e.clientY);
      const worldNow = screenToWorld(local.x, local.y, camera.getCamera());
      const minX = Math.min(gesture.startWorldX, worldNow.x);
      const minY = Math.min(gesture.startWorldY, worldNow.y);
      const maxX = Math.max(gesture.startWorldX, worldNow.x);
      const maxY = Math.max(gesture.startWorldY, worldNow.y);
      overlay.marqueeWorld = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
      camera.markDirty();
    }
  };

  const finishGesture = (e: PointerEvent): void => {
    if (!gesture) {
      return;
    }
    const active = gesture;
    gesture = null;
    if (shellEl.hasPointerCapture?.(e.pointerId)) {
      shellEl.releasePointerCapture(e.pointerId);
    }

    if (active.kind === "port_pending") {
      return;
    }

    if (active.kind === "pan") {
      isInteracting.value = false;
      updateCursor();
      return;
    }

    if (active.kind === "edge_connect") {
      const local = toLocalCoords(e.clientX, e.clientY);
      const worldPt = screenToWorld(local.x, local.y, camera.getCamera());
      overlay.edgePreviewWorld = null;
      isInteracting.value = false;
      camera.markDirty();
      updateCursor();

      if (active.fromPort) {
        const suppressClick = (clickEvt: MouseEvent): void => {
          clickEvt.preventDefault();
          clickEvt.stopPropagation();
          window.removeEventListener("click", suppressClick, true);
        };
        window.addEventListener("click", suppressClick, true);
        setTimeout(() => {
          window.removeEventListener("click", suppressClick, true);
        }, 0);
      }

      const eventDomCard =
        e.target instanceof Element ? e.target.closest<HTMLElement>("[data-node-id]") : null;
      const pointDomCard =
        typeof document.elementFromPoint === "function"
          ? document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-node-id]") ??
            null
          : null;
      let targetId = eventDomCard?.dataset.nodeId ?? pointDomCard?.dataset.nodeId ?? null;
      if (!targetId || targetId === active.sourceId) {
        const worldHit = hitTestNodeAtWorld(worldPt);
        targetId = worldHit && worldHit !== active.sourceId ? worldHit : null;
      }

      if (targetId && targetId !== active.sourceId && nodesMap.has(targetId)) {
        edgePopover.value = {
          sourceId: active.sourceId,
          targetId,
          x: local.x,
          y: local.y,
        };
        modalState.value = "connect_edge";
      }
      return;
    }

    if (active.kind === "node_resize") {
      const resized = resizeSizes.get(active.nodeId);
      const node = nodesMap.get(active.nodeId);
      isInteracting.value = false;
      updateCursor();

      if (
        active.moved &&
        resized &&
        node &&
        (resized.width !== node.layout.width || resized.height !== node.layout.height)
      ) {
        const prevSizes: NodeSizeUpdate[] = [
          { id: node.id, width: node.layout.width, height: node.layout.height },
        ];
        const nextSizes: NodeSizeUpdate[] = [
          { id: node.id, width: resized.width, height: resized.height },
        ];
        const { forward, inverse } = buildResizeNodesWithInverse(prevSizes, nextSizes);
        void mutateGraphUndoable("Resize node", forward, inverse).finally(() => {
          resizeSizes.delete(active.nodeId);
          camera.markDirty();
          void resolveAndAnimateOverlaps([active.nodeId]);
        });
      } else {
        resizeSizes.delete(active.nodeId);
        if (node) {
          const el = cardDomRefs.get(active.nodeId);
          if (el) {
            el.style.width = `${node.layout.width}px`;
            el.style.minHeight = node.layout.collapsed ? "" : `${node.layout.height}px`;
          }
        }
        camera.markDirty();
      }
      return;
    }

    if (active.kind === "node_drag") {
      if (active.moved) {
        const prevMoves: NodePositionUpdate[] = [];
        const nextMoves: NodePositionUpdate[] = [];
        for (const id of active.dragIds) {
          const node = nodesMap.get(id);
          const offset = dragOffsets.get(id);
          if (node && offset) {
            prevMoves.push({ id, x: node.layout.x, y: node.layout.y });
            nextMoves.push({
              id,
              x: node.layout.x + offset.x,
              y: node.layout.y + offset.y,
            });
          }
        }
        if (nextMoves.length > 0) {
          const dragSet = new Set(active.dragIds);
          const preNeighborMap = new Map<string, NodePositionUpdate>();
          for (const [id, n] of nodesMap.entries()) {
            if (!dragSet.has(id)) {
              preNeighborMap.set(id, { id, x: n.layout.x, y: n.layout.y });
            }
          }
          const { forward, inverse } = buildMoveNodesWithInverse(prevMoves, nextMoves);
          void (async () => {
            let committed = false;
            try {
              await mutateGraph(forward);
              committed = true;
            } finally {
              for (const id of active.dragIds) {
                dragOffsets.delete(id);
              }
              isInteracting.value = false;
              camera.markDirty();
            }
            if (!committed) {
              return;
            }
            const pushed = await resolveAndAnimateOverlaps(active.dragIds);
            const dragLabel = active.groupId ? "Move group" : "Move node(s)";
            if (pushed.length === 0) {
              graphHistory.push({ label: dragLabel, forward, inverse });
              syncHistorySignals();
              return;
            }
            const allPrev = [...prevMoves];
            const allNext = [...nextMoves];
            for (const u of pushed) {
              const prev = preNeighborMap.get(u.id);
              if (prev) {
                allPrev.push(prev);
                allNext.push(u);
              }
            }
            const merged = buildMoveNodesWithInverse(allPrev, allNext);
            graphHistory.push({
              label: dragLabel,
              forward: merged.forward,
              inverse: merged.inverse,
            });
            syncHistorySignals();
          })();
        } else {
          for (const id of active.dragIds) {
            dragOffsets.delete(id);
          }
          isInteracting.value = false;
          camera.markDirty();
        }
      }
      return;
    }

    if (active.kind === "marquee") {
      const rect = overlay.marqueeWorld;
      overlay.marqueeWorld = null;
      isInteracting.value = false;
      camera.markDirty();

      if (active.moved && rect) {
        const bbox: BBox = {
          minX: rect.x,
          minY: rect.y,
          maxX: rect.x + rect.width,
          maxY: rect.y + rect.height,
        };
        const hits = viewportSpatialIndex.queryRect(bbox);
        setSelection(hits);
      } else if (!e.shiftKey) {
        clearSelection();
        selectedGroupId.value = null;
      }
    }
  };

  const onDblClick = (e: MouseEvent): void => {
    const rawTarget = e.target;
    const targetEl =
      rawTarget instanceof Element
        ? rawTarget
        : rawTarget instanceof Node
          ? rawTarget.parentElement
          : null;
    if (modalState.value !== "navigate" || isInteractiveTarget(targetEl)) {
      return;
    }
    const cardEl = targetEl?.closest<HTMLElement>("[data-node-id]");
    let nodeId = cardEl?.dataset.nodeId ?? null;
    if (!nodeId && (!targetEl || shellEl.contains(targetEl))) {
      const local = toLocalCoords(e.clientX, e.clientY);
      const worldPt = screenToWorld(local.x, local.y, camera.getCamera());
      nodeId = hitTestNodeAtWorld(worldPt);
    }
    if (!nodeId) {
      return;
    }
    const node = nodesMap.get(nodeId);
    if (!node) {
      return;
    }
    e.preventDefault();
    if (typeof window !== "undefined") {
      window.getSelection?.()?.removeAllRanges();
    }
    nodeContextMenu.value = null;
    selectSingle(node.id);

    const cam = camera.getCamera();
    const viewport = camera.getViewportSize();
    const targetZoom = clampZoom(Math.max(cam.zoom, 1.15));
    const nodeH = getEffectiveNodeHeight(node);
    const centerX = node.layout.x + node.layout.width * 0.5;
    const centerY = node.layout.y + nodeH * 0.5;
    camera.animateTo(
      {
        x: viewport.width * 0.5 - centerX * targetZoom,
        y: viewport.height * 0.5 - centerY * targetZoom,
        zoom: targetZoom,
      },
      220,
    );

    if (node.metadata.created_by === "user") {
      enterEditMode(node);
    }
  };

  const onContextMenu = (e: MouseEvent): void => {
    if (modalState.value !== "navigate") {
      return;
    }
    const targetEl = e.target instanceof Element ? e.target : null;
    if (targetEl?.closest(".workspace-sidebar, .sidebar-toggle-bar, .node-context-menu")) {
      return;
    }
    const cardEl = targetEl?.closest<HTMLElement>("[data-node-id]");
    let nodeId = cardEl?.dataset.nodeId ?? null;
    if (
      !nodeId &&
      (isBirdsEye.value || targetEl === shellEl || targetEl?.classList.contains("canvas-layer"))
    ) {
      const local = toLocalCoords(e.clientX, e.clientY);
      const worldPt = screenToWorld(local.x, local.y, camera.getCamera());
      nodeId = hitTestNodeAtWorld(worldPt);
    }
    if (!nodeId || !nodesMap.has(nodeId)) {
      nodeContextMenu.value = null;
      return;
    }
    e.preventDefault();
    edgePopover.value = null;
    if (!selectedIds.value.has(nodeId)) {
      selectSingle(nodeId);
    } else {
      focusId.value = nodeId;
    }
    nodeContextMenu.value = {
      nodeId,
      x: e.clientX,
      y: e.clientY,
    };
  };

  const onWheel = (e: WheelEvent): void => {
    if (modalState.value === "edit" || modalState.value === "command") {
      return;
    }
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const local = toLocalCoords(e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * 0.002);
      camera.zoomAt(local.x, local.y, camera.getCamera().zoom * factor);
    } else {
      camera.panBy(-e.deltaX, -e.deltaY);
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (modalState.value === "edit") {
      return;
    }
    if (e.code === "Space" && modalState.value === "navigate" && !isInteractiveTarget(e.target)) {
      e.preventDefault();
      if (!spaceHeld) {
        spaceHeld = true;
        updateCursor();
      }
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Space" && spaceHeld) {
      spaceHeld = false;
      updateCursor();
    }
  };

  const onWindowBlur = (): void => {
    spaceHeld = false;
    updateCursor();
  };

  shellEl.addEventListener("pointerdown", onPointerDown);
  shellEl.addEventListener("pointermove", onPointerMove);
  shellEl.addEventListener("pointerup", finishGesture);
  shellEl.addEventListener("pointercancel", finishGesture);
  shellEl.addEventListener("dblclick", onDblClick);
  shellEl.addEventListener("contextmenu", onContextMenu);
  shellEl.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onWindowBlur);

  return () => {
    shellEl.removeEventListener("pointerdown", onPointerDown);
    shellEl.removeEventListener("pointermove", onPointerMove);
    shellEl.removeEventListener("pointerup", finishGesture);
    shellEl.removeEventListener("pointercancel", finishGesture);
    shellEl.removeEventListener("dblclick", onDblClick);
    shellEl.removeEventListener("contextmenu", onContextMenu);
    shellEl.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onWindowBlur);
  };
}

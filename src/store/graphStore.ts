import { signal } from "@preact/signals";
import type { CameraTransform } from "../canvas/camera";
import { ViewportSpatialIndex } from "../canvas/spatialIndex";
import { applyOps, isTauriRuntime, resolveOverlaps, spawnConnectedNode } from "../ipc/client";
import type {
  ApplyResult,
  CameraState,
  EdgeDto,
  EdgeType,
  GraphOp,
  NodeDto,
  NodePositionUpdate,
  NodeSizeUpdate,
  NodeType,
  Severity,
  SpawnDirection,
  WorkspaceSnapshot,
} from "../ipc/types";
import {
  buildCreateNodeWithInverse,
  graphHistory,
  syncHistorySignals,
} from "./history";
import { focusId, selectSingle } from "./selection";

export interface LoopholeSummary {
  count: number;
  maxSeverity: Severity | null;
}

export interface CameraControllerHandle {
  setCardLayerEl: (el: HTMLElement | null) => void;
  markDirty: () => void;
  refreshCull: () => void;
  setCamera: (cam: CameraState) => void;
  getCamera: () => CameraState;
  getViewportSize: () => { width: number; height: number };
  animateTo: (targetCam: CameraTransform, durationMs?: number) => void;
  subscribeFrame?: (listener: (cam: CameraTransform) => void) => () => void;
  zoomByStep?: (factor: number) => void;
  resetZoom?: () => void;
}

export const MIN_NODE_WIDTH = 220;
export const MAX_NODE_WIDTH = 960;
export const MIN_NODE_HEIGHT = 112;
export const MAX_NODE_HEIGHT = 1200;

// Non-reactive stores kept OUTSIDE signals so rAF rendering & drags never trigger Preact re-renders.
export const nodesMap = new Map<string, NodeDto>();
export const edgesMap = new Map<string, EdgeDto>();
export const cardDomRefs = new Map<string, HTMLElement>();
export const dragOffsets = new Map<string, { x: number; y: number }>();
export const resizeSizes = new Map<string, { width: number; height: number }>();
export const viewportSpatialIndex = new ViewportSpatialIndex();

export const graphVersion = signal<number>(0);
export const visibleNodeIds = signal<string[]>([]);
export const isBirdsEye = signal<boolean>(false);
export const workspacePath = signal<string>("");
export const tokenBudget = signal<number>(6000);
export const theme = signal<"dark" | "light">("dark");
export const unresolvedLoopholes = signal<Map<string, LoopholeSummary>>(new Map());

export const cameraControllerRef: { current: CameraControllerHandle | null } = {
  current: null,
};

const SEVERITY_PRIORITY: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function higherSeverity(a: Severity | null, b: Severity | null): Severity | null {
  if (!a) return b;
  if (!b) return a;
  return SEVERITY_PRIORITY[a] >= SEVERITY_PRIORITY[b] ? a : b;
}

export function recomputeUnresolvedLoopholes(): void {
  const next = new Map<string, LoopholeSummary>();
  for (const edge of edgesMap.values()) {
    if (edge.type !== "challenges") {
      continue;
    }
    const src = nodesMap.get(edge.source_id);
    if (!src || src.status !== "active") {
      continue;
    }
    const existing = next.get(edge.target_id);
    const sev = src.metadata.severity ?? "medium";
    if (existing) {
      existing.count += 1;
      existing.maxSeverity = higherSeverity(existing.maxSeverity, sev);
    } else {
      next.set(edge.target_id, { count: 1, maxSeverity: sev });
    }
  }
  unresolvedLoopholes.value = next;
}

function estimateTokensLocal(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function applyOpsLocally(ops: GraphOp[]): ApplyResult {
  const updatedNodes: NodeDto[] = [];
  const deletedNodeIds: string[] = [];
  const deletedEdgeIds: string[] = [];
  const now = Date.now();

  for (const op of ops) {
    switch (op.op) {
      case "create_node": {
        const created: NodeDto = {
          ...op.node,
          metadata: {
            ...op.node.metadata,
            token_count: estimateTokensLocal(`${op.node.title}\n${op.node.content}`),
          },
          updated_at: now,
        };
        nodesMap.set(created.id, created);
        viewportSpatialIndex.upsert(created);
        updatedNodes.push(created);
        break;
      }
      case "update_node_text": {
        const existing = nodesMap.get(op.id);
        if (existing && existing.status !== "locked") {
          const updated: NodeDto = {
            ...existing,
            title: op.title,
            content: op.content,
            content_hash: `${op.title.length}:${op.content.length}:${now}`,
            metadata: {
              ...existing.metadata,
              token_count: estimateTokensLocal(`${op.title}\n${op.content}`),
            },
            updated_at: now,
          };
          nodesMap.set(updated.id, updated);
          viewportSpatialIndex.upsert(updated);
          updatedNodes.push(updated);
        }
        break;
      }
      case "update_node_meta": {
        const existing = nodesMap.get(op.id);
        if (existing) {
          const updated: NodeDto = {
            ...existing,
            type: op.node_type ?? existing.type,
            status: op.status ?? existing.status,
            metadata: {
              ...existing.metadata,
              severity: op.severity !== undefined ? op.severity : existing.metadata.severity,
            },
            context_controls: {
              pin_global: op.pin_global ?? existing.context_controls.pin_global,
              exclude_from_ai: op.exclude_from_ai ?? existing.context_controls.exclude_from_ai,
            },
            layout: {
              ...existing.layout,
              collapsed: op.collapsed ?? existing.layout.collapsed,
            },
            updated_at: now,
          };
          nodesMap.set(updated.id, updated);
          viewportSpatialIndex.upsert(updated);
          updatedNodes.push(updated);
        }
        break;
      }
      case "move_nodes": {
        for (const m of op.moves) {
          dragOffsets.delete(m.id);
          const existing = nodesMap.get(m.id);
          if (existing) {
            const moved: NodeDto = {
              ...existing,
              layout: { ...existing.layout, x: m.x, y: m.y },
            };
            nodesMap.set(moved.id, moved);
            viewportSpatialIndex.upsert(moved);
          }
        }
        break;
      }
      case "resize_nodes": {
        for (const s of op.sizes) {
          resizeSizes.delete(s.id);
          const existing = nodesMap.get(s.id);
          if (existing) {
            const resized: NodeDto = {
              ...existing,
              layout: { ...existing.layout, width: s.width, height: s.height },
            };
            nodesMap.set(resized.id, resized);
            viewportSpatialIndex.upsert(resized);
          }
        }
        break;
      }
      case "delete_nodes": {
        const deleteSet = new Set(op.ids);
        for (const edge of Array.from(edgesMap.values())) {
          if (deleteSet.has(edge.source_id) || deleteSet.has(edge.target_id)) {
            edgesMap.delete(edge.id);
            deletedEdgeIds.push(edge.id);
          }
        }
        for (const id of op.ids) {
          if (nodesMap.delete(id)) {
            viewportSpatialIndex.remove(id);
            cardDomRefs.delete(id);
            dragOffsets.delete(id);
            resizeSizes.delete(id);
            deletedNodeIds.push(id);
          }
        }
        break;
      }
      case "create_edge": {
        edgesMap.set(op.edge.id, op.edge);
        if (op.edge.type === "resolves") {
          const target = nodesMap.get(op.edge.target_id);
          if (target && target.type === "loophole") {
            const resolved: NodeDto = { ...target, status: "resolved", updated_at: now };
            nodesMap.set(resolved.id, resolved);
            updatedNodes.push(resolved);
          }
        }
        break;
      }
      case "update_edge_weight": {
        const edge = edgesMap.get(op.id);
        if (edge) {
          edgesMap.set(op.id, { ...edge, weight: op.weight });
        }
        break;
      }
      case "delete_edge": {
        if (edgesMap.delete(op.id)) {
          deletedEdgeIds.push(op.id);
        }
        break;
      }
    }
  }

  return {
    updated_nodes: updatedNodes,
    deleted_node_ids: deletedNodeIds,
    deleted_edge_ids: deletedEdgeIds,
  };
}

function syncStoreAfterIpc(ops: GraphOp[], result: ApplyResult): void {
  for (const op of ops) {
    switch (op.op) {
      case "move_nodes":
        for (const m of op.moves) {
          dragOffsets.delete(m.id);
          const existing = nodesMap.get(m.id);
          if (existing) {
            const moved: NodeDto = {
              ...existing,
              layout: { ...existing.layout, x: m.x, y: m.y },
            };
            nodesMap.set(moved.id, moved);
            viewportSpatialIndex.upsert(moved);
          }
        }
        break;
      case "resize_nodes":
        for (const s of op.sizes) {
          resizeSizes.delete(s.id);
          const existing = nodesMap.get(s.id);
          if (existing) {
            const resized: NodeDto = {
              ...existing,
              layout: { ...existing.layout, width: s.width, height: s.height },
            };
            nodesMap.set(resized.id, resized);
            viewportSpatialIndex.upsert(resized);
          }
        }
        break;
      case "create_edge":
        edgesMap.set(op.edge.id, op.edge);
        break;
      case "update_edge_weight": {
        const edge = edgesMap.get(op.id);
        if (edge) {
          edgesMap.set(op.id, { ...edge, weight: op.weight });
        }
        break;
      }
      case "delete_edge":
        edgesMap.delete(op.id);
        break;
      default:
        break;
    }
  }

  for (const node of result.updated_nodes) {
    nodesMap.set(node.id, node);
    viewportSpatialIndex.upsert(node);
  }
  for (const id of result.deleted_node_ids) {
    nodesMap.delete(id);
    viewportSpatialIndex.remove(id);
    cardDomRefs.delete(id);
  }
  for (const eid of result.deleted_edge_ids) {
    edgesMap.delete(eid);
  }
}

export function loadSnapshot(snapshot: WorkspaceSnapshot): void {
  cancelTidyAnimation();
  nodesMap.clear();
  edgesMap.clear();
  cardDomRefs.clear();
  dragOffsets.clear();
  resizeSizes.clear();

  for (const node of snapshot.nodes) {
    nodesMap.set(node.id, node);
  }
  for (const edge of snapshot.edges) {
    edgesMap.set(edge.id, edge);
  }

  viewportSpatialIndex.bulkLoad(snapshot.nodes);
  workspacePath.value = snapshot.path;
  tokenBudget.value = snapshot.token_budget;
  graphHistory.clear();
  syncHistorySignals();
  recomputeUnresolvedLoopholes();

  const initialFocus =
    snapshot.camera.last_focus_id && nodesMap.has(snapshot.camera.last_focus_id)
      ? snapshot.camera.last_focus_id
      : (snapshot.nodes[0]?.id ?? null);
  selectSingle(initialFocus);

  cameraControllerRef.current?.setCamera(snapshot.camera);
  cameraControllerRef.current?.refreshCull();
  cameraControllerRef.current?.markDirty();
  graphVersion.value += 1;
}

export async function mutateGraph(ops: GraphOp[]): Promise<ApplyResult> {
  if (ops.length === 0) {
    return { updated_nodes: [], deleted_node_ids: [], deleted_edge_ids: [] };
  }
  cancelTidyAnimation();

  let result: ApplyResult;
  if (isTauriRuntime()) {
    result = await applyOps(ops);
    syncStoreAfterIpc(ops, result);
  } else {
    result = applyOpsLocally(ops);
  }

  recomputeUnresolvedLoopholes();
  if (focusId.value !== null && !nodesMap.has(focusId.value)) {
    selectSingle(null);
  }

  graphVersion.value += 1;
  cameraControllerRef.current?.refreshCull();
  cameraControllerRef.current?.markDirty();
  return result;
}

export async function mutateGraphUndoable(
  label: string,
  forward: GraphOp[],
  inverse: GraphOp[],
): Promise<ApplyResult> {
  const result = await mutateGraph(forward);
  if (forward.length > 0) {
    graphHistory.push({ label, forward, inverse });
    syncHistorySignals();
  }
  return result;
}

export async function performUndo(): Promise<ApplyResult | null> {
  const entry = graphHistory.undo();
  if (!entry) {
    return null;
  }
  syncHistorySignals();
  try {
    return await mutateGraph(entry.inverse);
  } catch (err) {
    graphHistory.push(entry);
    syncHistorySignals();
    throw err;
  }
}

export async function performRedo(): Promise<ApplyResult | null> {
  const entry = graphHistory.redo();
  if (!entry) {
    return null;
  }
  syncHistorySignals();
  return mutateGraph(entry.forward);
}

let tidyAnimRafId: number | null = null;
let tidyAnimatedIds: string[] = [];

function cancelTidyAnimation(): void {
  if (tidyAnimRafId !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(tidyAnimRafId);
  }
  tidyAnimRafId = null;
  for (const id of tidyAnimatedIds) {
    dragOffsets.delete(id);
    const node = nodesMap.get(id);
    const el = cardDomRefs.get(id);
    if (node && el) {
      el.style.transform = `translate3d(${node.layout.x}px, ${node.layout.y}px, 0)`;
    }
  }
  tidyAnimatedIds = [];
}

export function applyTidyPositions(updates: NodePositionUpdate[]): void {
  if (updates.length === 0) {
    return;
  }
  cancelTidyAnimation();

  const deltas: Array<{ id: string; finalX: number; finalY: number; dx: number; dy: number }> = [];
  for (const u of updates) {
    const existing = nodesMap.get(u.id);
    if (existing) {
      const dx = existing.layout.x - u.x;
      const dy = existing.layout.y - u.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        deltas.push({ id: u.id, finalX: u.x, finalY: u.y, dx, dy });
      }
      const moved: NodeDto = {
        ...existing,
        layout: { ...existing.layout, x: u.x, y: u.y },
      };
      nodesMap.set(moved.id, moved);
      viewportSpatialIndex.upsert(moved);
    }
  }

  const prefersReducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (deltas.length > 0 && !prefersReducedMotion && typeof requestAnimationFrame === "function") {
    tidyAnimatedIds = deltas.map((d) => d.id);
    for (const d of deltas) {
      dragOffsets.set(d.id, { x: d.dx, y: d.dy });
      const el = cardDomRefs.get(d.id);
      if (el) {
        el.style.transform = `translate3d(${d.finalX + d.dx}px, ${d.finalY + d.dy}px, 0)`;
      }
    }
    graphVersion.value += 1;
    cameraControllerRef.current?.refreshCull();
    cameraControllerRef.current?.markDirty();

    const durationMs = 180;
    const startTime = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - startTime) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const remaining = 1 - eased;

      for (const d of deltas) {
        if (t < 1) {
          const ox = d.dx * remaining;
          const oy = d.dy * remaining;
          dragOffsets.set(d.id, { x: ox, y: oy });
          const el = cardDomRefs.get(d.id);
          if (el) {
            el.style.transform = `translate3d(${d.finalX + ox}px, ${d.finalY + oy}px, 0)`;
          }
        } else {
          dragOffsets.delete(d.id);
          const el = cardDomRefs.get(d.id);
          if (el) {
            el.style.transform = `translate3d(${d.finalX}px, ${d.finalY}px, 0)`;
          }
        }
      }

      cameraControllerRef.current?.markDirty();

      if (t < 1) {
        tidyAnimRafId = requestAnimationFrame(step);
      } else {
        tidyAnimRafId = null;
        tidyAnimatedIds = [];
      }
    };

    tidyAnimRafId = requestAnimationFrame(step);
    return;
  }

  graphVersion.value += 1;
  cameraControllerRef.current?.refreshCull();
  cameraControllerRef.current?.markDirty();
}

export async function spawnChild(
  parentId: string,
  edgeType: EdgeType,
  nodeType: NodeType,
  title?: string,
  recordHistory = true,
  direction?: SpawnDirection,
): Promise<{ node: NodeDto; edge: EdgeDto }> {
  const parentBefore = nodesMap.get(parentId);
  const prevParentStatus = parentBefore?.status;

  let spawned: { node: NodeDto; edge: EdgeDto };
  if (isTauriRuntime()) {
    spawned = await spawnConnectedNode(parentId, edgeType, nodeType, title, direction);
  } else {
    const now = Date.now();
    const id = `node_local_${now}_${Math.random().toString(36).slice(2, 7)}`;
    const nodeW = 320;
    const nodeH = 180;
    const gap = 20;
    const hGap = 100;
    const sideGap = 48;
    const parentX = parentBefore?.layout.x ?? 0;
    const parentY = parentBefore?.layout.y ?? 0;
    const parentW = parentBefore?.layout.width ?? 320;
    const parentH = parentBefore ? (parentBefore.layout.collapsed ? 44 : parentBefore.layout.height) : 180;

    const slotFor = (dir: SpawnDirection): { x: number; y: number } => {
      switch (dir) {
        case "right":
          return { x: parentX + parentW + hGap, y: parentY };
        case "left":
          return { x: parentX - nodeW - hGap, y: parentY };
        case "bottom":
          return { x: parentX, y: parentY + parentH + sideGap };
        case "top":
          return { x: parentX, y: parentY - nodeH - sideGap };
      }
    };

    const hasCollision = (x: number, y: number): boolean => {
      const candidates = viewportSpatialIndex.queryViewport(
        { minX: x, minY: y, maxX: x + nodeW, maxY: y + nodeH },
        24,
      );
      for (const existingId of candidates) {
        const existing = nodesMap.get(existingId);
        if (!existing) continue;
        const eh = existing.layout.collapsed ? 44 : existing.layout.height;
        if (
          x < existing.layout.x + existing.layout.width + gap &&
          x + nodeW + gap > existing.layout.x &&
          y < existing.layout.y + eh + gap &&
          y + nodeH + gap > existing.layout.y
        ) {
          return true;
        }
      }
      return false;
    };

    const cardinalOrder: SpawnDirection[] = ["right", "bottom", "left", "top"];
    const chosenDir: SpawnDirection =
      direction ??
      cardinalOrder.find((d) => {
        const s = slotFor(d);
        return !hasCollision(s.x, s.y);
      }) ??
      "right";

    const initialSlot = slotFor(chosenDir);
    let px = initialSlot.x;
    let py = initialSlot.y;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!hasCollision(px, py)) {
        break;
      }
      if (chosenDir === "top") {
        py -= 40;
      } else {
        py += 40;
      }
    }
    const nodeTitle = title && title.trim().length > 0 ? title : "New Node";
    const node: NodeDto = {
      id,
      type: nodeType,
      status: "active",
      title: nodeTitle,
      content: "",
      summary: "",
      content_hash: `${nodeTitle.length}:0:${now}`,
      summary_hash: "",
      metadata: {
        severity: nodeType === "loophole" ? "medium" : null,
        lens: "manual",
        created_by: "user",
        model: null,
        token_count: estimateTokensLocal(nodeTitle),
      },
      context_controls: { pin_global: false, exclude_from_ai: false },
      layout: { x: px, y: py, width: 320, height: 180, collapsed: false },
      created_at: now,
      updated_at: now,
    };
    const isIncomingToParent = edgeType === "challenges" || edgeType === "resolves";
    const edge: EdgeDto = {
      id: `edge_local_${now}_${Math.random().toString(36).slice(2, 7)}`,
      source_id: isIncomingToParent ? id : parentId,
      target_id: isIncomingToParent ? parentId : id,
      type: edgeType,
      weight: "summary",
      created_at: now,
    };
    spawned = { node, edge };
  }

  nodesMap.set(spawned.node.id, spawned.node);
  edgesMap.set(spawned.edge.id, spawned.edge);
  viewportSpatialIndex.upsert(spawned.node);

  const flippedLoophole =
    edgeType === "resolves" &&
    parentBefore !== undefined &&
    parentBefore.type === "loophole" &&
    prevParentStatus !== undefined &&
    prevParentStatus !== "resolved";

  if (flippedLoophole && parentBefore) {
    const resolvedParent: NodeDto = {
      ...parentBefore,
      status: "resolved",
      updated_at: Date.now(),
    };
    nodesMap.set(parentId, resolvedParent);
  }

  if (recordHistory) {
    const entry = buildCreateNodeWithInverse(spawned.node, [spawned.edge]);
    if (flippedLoophole && prevParentStatus !== undefined) {
      entry.forward.push({
        op: "update_node_meta",
        id: parentId,
        status: "resolved",
      });
      entry.inverse.push({
        op: "update_node_meta",
        id: parentId,
        status: prevParentStatus,
      });
    }
    graphHistory.push({
      label: `Spawn ${nodeType}`,
      forward: entry.forward,
      inverse: entry.inverse,
    });
    syncHistorySignals();
  }

  recomputeUnresolvedLoopholes();
  graphVersion.value += 1;
  cameraControllerRef.current?.refreshCull();
  cameraControllerRef.current?.markDirty();
  return spawned;
}

const pendingResizes = new Map<string, NodeSizeUpdate>();
let resizeFlushTimer: ReturnType<typeof setTimeout> | null = null;
let resolvingOverlaps = false;

export function resolveOverlapsLocally(pinnedIds: string[]): NodePositionUpdate[] {
  if (nodesMap.size < 2) {
    return [];
  }
  const pinnedSet = new Set(pinnedIds);
  const ids = Array.from(nodesMap.keys()).sort();
  const initial = new Map<string, { x: number; y: number }>();
  const rects = new Map<string, { x: number; y: number; w: number; h: number }>();

  for (const id of ids) {
    const n = nodesMap.get(id);
    if (!n) continue;
    const h = n.layout.collapsed ? 44 : n.layout.height;
    initial.set(id, { x: n.layout.x, y: n.layout.y });
    rects.set(id, { x: n.layout.x, y: n.layout.y, w: n.layout.width, h });
  }

  const margin = 20;
  const extraClearance = 4;
  for (let iter = 0; iter < 24; iter += 1) {
    let movedAny = false;
    for (let i = 0; i < ids.length; i += 1) {
      const aId = ids[i];
      if (!aId) continue;
      for (let j = i + 1; j < ids.length; j += 1) {
        const bId = ids[j];
        if (!bId) continue;
        const a = rects.get(aId);
        const b = rects.get(bId);
        if (!a || !b) continue;

        const dx = b.x + b.w / 2 - (a.x + a.w / 2);
        const dy = b.y + b.h / 2 - (a.y + a.h / 2);
        const overlapX = (a.w + b.w) / 2 + margin - Math.abs(dx);
        const overlapY = (a.h + b.h) / 2 + margin - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }

        const aPinned = pinnedSet.has(aId);
        const bPinned = pinnedSet.has(bId);
        if (aPinned && bPinned) {
          continue;
        }

        if (overlapX < overlapY) {
          const sep = overlapX + extraClearance;
          const signX = dx >= 0 ? 1 : -1;
          if (aPinned) {
            b.x += signX * sep;
          } else if (bPinned) {
            a.x -= signX * sep;
          } else {
            a.x -= signX * sep * 0.5;
            b.x += signX * sep * 0.5;
          }
        } else {
          const sep = overlapY + extraClearance;
          const signY = dy >= 0 ? 1 : -1;
          if (aPinned) {
            b.y += signY * sep;
          } else if (bPinned) {
            a.y -= signY * sep;
          } else {
            a.y -= signY * sep * 0.5;
            b.y += signY * sep * 0.5;
          }
        }
        movedAny = true;
      }
    }
    if (!movedAny) {
      break;
    }
  }

  const updates: NodePositionUpdate[] = [];
  for (const id of ids) {
    const orig = initial.get(id);
    const cur = rects.get(id);
    if (orig && cur && (Math.abs(cur.x - orig.x) > 1e-6 || Math.abs(cur.y - orig.y) > 1e-6)) {
      updates.push({ id, x: cur.x, y: cur.y });
    }
  }
  return updates;
}

export async function resolveAndAnimateOverlaps(pinnedIds: string[]): Promise<void> {
  if (resolvingOverlaps || nodesMap.size < 2) {
    return;
  }
  resolvingOverlaps = true;
  try {
    const updates = isTauriRuntime()
      ? await resolveOverlaps(pinnedIds)
      : resolveOverlapsLocally(pinnedIds);
    if (updates.length > 0) {
      applyTidyPositions(updates);
    }
  } catch {
    // Non-fatal: layout remains usable if overlap resolution is skipped
  } finally {
    resolvingOverlaps = false;
  }
}

export function queueNodeResize(id: string, width: number, height: number): void {
  const node = nodesMap.get(id);
  if (!node || node.layout.collapsed) {
    return;
  }
  const roundedW = Math.round(width);
  const roundedH = Math.round(height);
  if (
    Math.abs(roundedH - node.layout.height) <= 4 &&
    Math.abs(roundedW - node.layout.width) <= 4
  ) {
    return;
  }

  const grew = roundedW > node.layout.width || roundedH > node.layout.height;
  const updated: NodeDto = {
    ...node,
    layout: { ...node.layout, width: roundedW, height: roundedH },
  };
  nodesMap.set(id, updated);
  viewportSpatialIndex.upsert(updated);
  cameraControllerRef.current?.markDirty();

  pendingResizes.set(id, { id, width: roundedW, height: roundedH });
  if (resizeFlushTimer !== null) {
    clearTimeout(resizeFlushTimer);
  }
  resizeFlushTimer = setTimeout(() => {
    resizeFlushTimer = null;
    if (pendingResizes.size === 0) {
      return;
    }
    const sizes = Array.from(pendingResizes.values());
    pendingResizes.clear();
    void mutateGraph([{ op: "resize_nodes", sizes }]).then(() => {
      if (grew) {
        return resolveAndAnimateOverlaps(sizes.map((s) => s.id));
      }
      return undefined;
    });
  }, 160);
}

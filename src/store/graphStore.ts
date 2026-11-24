import { signal } from "@preact/signals";
import type { CameraTransform } from "../canvas/camera";
import { ViewportSpatialIndex } from "../canvas/spatialIndex";
import { applyOps, isTauriRuntime, spawnConnectedNode } from "../ipc/client";
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
}

// Non-reactive stores kept OUTSIDE signals so rAF rendering & drags never trigger Preact re-renders.
export const nodesMap = new Map<string, NodeDto>();
export const edgesMap = new Map<string, EdgeDto>();
export const cardDomRefs = new Map<string, HTMLElement>();
export const dragOffsets = new Map<string, { x: number; y: number }>();
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
  nodesMap.clear();
  edgesMap.clear();
  cardDomRefs.clear();
  dragOffsets.clear();

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

export function applyTidyPositions(updates: NodePositionUpdate[]): void {
  if (updates.length === 0) {
    return;
  }
  for (const u of updates) {
    const existing = nodesMap.get(u.id);
    if (existing) {
      const moved: NodeDto = {
        ...existing,
        layout: { ...existing.layout, x: u.x, y: u.y },
      };
      nodesMap.set(moved.id, moved);
      viewportSpatialIndex.upsert(moved);
    }
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
): Promise<{ node: NodeDto; edge: EdgeDto }> {
  const parentBefore = nodesMap.get(parentId);
  const prevParentStatus = parentBefore?.status;

  let spawned: { node: NodeDto; edge: EdgeDto };
  if (isTauriRuntime()) {
    spawned = await spawnConnectedNode(parentId, edgeType, nodeType, title);
  } else {
    const now = Date.now();
    const id = `node_local_${now}_${Math.random().toString(36).slice(2, 7)}`;
    const px = (parentBefore?.layout.x ?? 0) + (parentBefore?.layout.width ?? 320) + 100;
    const py = parentBefore?.layout.y ?? 0;
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
    void mutateGraph([{ op: "resize_nodes", sizes }]);
  }, 160);
}

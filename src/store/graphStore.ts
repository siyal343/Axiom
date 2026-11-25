import { signal } from "@preact/signals";
import { clampZoom, type CameraTransform } from "../canvas/camera";
import { getEffectiveNodeHeight, ViewportSpatialIndex } from "../canvas/spatialIndex";
import {
  acknowledgeStaleNode,
  applyOps,
  detachExternalRef,
  getExternalRefStatuses,
  getStaleNodes,
  isTauriRuntime,
  pullExternalReference,
  resolveOverlaps,
  spawnConnectedNode,
  syncExternalRef,
} from "../ipc/client";
import type {
  ApplyResult,
  CameraState,
  CanvasGroupDto,
  EdgeDto,
  EdgeType,
  ExternalRefInfo,
  GraphOp,
  GroupColorKey,
  NodeDto,
  NodePositionUpdate,
  NodeSizeUpdate,
  NodeType,
  Severity,
  SpawnDirection,
  StaleNodeInfo,
  WorkspaceSnapshot,
} from "../ipc/types";
import {
  buildCreateGroupWithInverse,
  buildCreateNodeWithInverse,
  buildDeleteGroupWithInverse,
  buildUpdateGroupWithInverse,
  graphHistory,
  syncHistorySignals,
  type GroupPatch,
} from "./history";
import {
  externalRefsMap,
  focusId,
  selectedIds,
  selectSingle,
  spotlightRootId,
  staleNodesMap,
} from "./selection";
import { scheduleSaveCurrentLocalFlowSnapshot } from "./workspaceCatalogStore";

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
  setContinuousAnimation?: (enabled: boolean) => void;
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

export const GROUP_COLOR_KEYS: readonly GroupColorKey[] = [
  "cobalt",
  "emerald",
  "amber",
  "rose",
  "violet",
  "slate",
];

export const graphVersion = signal<number>(0);
export const visibleNodeIds = signal<string[]>([]);
export const isBirdsEye = signal<boolean>(false);
export const workspacePath = signal<string>("");
export const tokenBudget = signal<number>(6000);
export const flowSystemPrompt = signal<string>("");
export const theme = signal<"dark" | "light">("dark");
export const edgeFlowEnabled = signal<boolean>(true);
export const unresolvedLoopholes = signal<Map<string, LoopholeSummary>>(new Map());
export const groupsMap = signal<Map<string, CanvasGroupDto>>(new Map());
export const selectedGroupId = signal<string | null>(null);

export function setTheme(nextTheme: "dark" | "light"): void {
  theme.value = nextTheme;
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", nextTheme);
  }
  cameraControllerRef.current?.markDirty();
}

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

function dedupMemberIds(ids: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function pruneDeletedNodesFromGroups(deleteSet: ReadonlySet<string>, now: number): void {
  if (deleteSet.size === 0 || groupsMap.value.size === 0) {
    return;
  }
  let changed = false;
  const next = new Map<string, CanvasGroupDto>();
  for (const [gid, grp] of groupsMap.value.entries()) {
    const filtered = grp.member_ids.filter((mid) => !deleteSet.has(mid));
    if (filtered.length !== grp.member_ids.length) {
      changed = true;
      next.set(gid, { ...grp, member_ids: filtered, updated_at: now });
    } else {
      next.set(gid, grp);
    }
  }
  if (changed) {
    groupsMap.value = next;
  }
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
        pruneDeletedNodesFromGroups(deleteSet, now);
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
      case "create_group": {
        const trimmedId = op.id.trim();
        if (!trimmedId || groupsMap.value.has(trimmedId)) {
          break;
        }
        const group: CanvasGroupDto = {
          id: trimmedId,
          title: op.title.trim() || "Group",
          color_key: op.color_key.trim() || "cobalt",
          member_ids: dedupMemberIds(op.member_ids),
          collapsed: false,
          created_at: now,
          updated_at: now,
        };
        const nextGroups = new Map(groupsMap.value);
        nextGroups.set(group.id, group);
        groupsMap.value = nextGroups;
        break;
      }
      case "update_group": {
        const existing = groupsMap.value.get(op.id);
        if (!existing) {
          break;
        }
        const updated: CanvasGroupDto = {
          ...existing,
          title:
            op.title !== undefined && op.title !== null
              ? op.title.trim() || "Group"
              : existing.title,
          color_key:
            op.color_key !== undefined && op.color_key !== null
              ? op.color_key.trim() || "cobalt"
              : existing.color_key,
          member_ids:
            op.member_ids !== undefined && op.member_ids !== null
              ? dedupMemberIds(op.member_ids)
              : existing.member_ids,
          collapsed:
            op.collapsed !== undefined && op.collapsed !== null
              ? op.collapsed
              : existing.collapsed,
          updated_at: now,
        };
        const nextGroups = new Map(groupsMap.value);
        nextGroups.set(updated.id, updated);
        groupsMap.value = nextGroups;
        break;
      }
      case "delete_group": {
        if (groupsMap.value.has(op.id)) {
          const nextGroups = new Map(groupsMap.value);
          nextGroups.delete(op.id);
          groupsMap.value = nextGroups;
          if (selectedGroupId.value === op.id) {
            selectedGroupId.value = null;
          }
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
  const now = Date.now();
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
      case "create_group": {
        const trimmedId = op.id.trim();
        if (trimmedId) {
          const nextGroups = new Map(groupsMap.value);
          nextGroups.set(trimmedId, {
            id: trimmedId,
            title: op.title.trim() || "Group",
            color_key: op.color_key.trim() || "cobalt",
            member_ids: dedupMemberIds(op.member_ids),
            collapsed: false,
            created_at: now,
            updated_at: now,
          });
          groupsMap.value = nextGroups;
        }
        break;
      }
      case "update_group": {
        const existing = groupsMap.value.get(op.id);
        if (existing) {
          const nextGroups = new Map(groupsMap.value);
          nextGroups.set(op.id, {
            ...existing,
            title:
              op.title !== undefined && op.title !== null
                ? op.title.trim() || "Group"
                : existing.title,
            color_key:
              op.color_key !== undefined && op.color_key !== null
                ? op.color_key.trim() || "cobalt"
                : existing.color_key,
            member_ids:
              op.member_ids !== undefined && op.member_ids !== null
                ? dedupMemberIds(op.member_ids)
                : existing.member_ids,
            collapsed:
              op.collapsed !== undefined && op.collapsed !== null
                ? op.collapsed
                : existing.collapsed,
            updated_at: now,
          });
          groupsMap.value = nextGroups;
        }
        break;
      }
      case "delete_group": {
        if (groupsMap.value.has(op.id)) {
          const nextGroups = new Map(groupsMap.value);
          nextGroups.delete(op.id);
          groupsMap.value = nextGroups;
          if (selectedGroupId.value === op.id) {
            selectedGroupId.value = null;
          }
        }
        break;
      }
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
  if (result.deleted_node_ids.length > 0) {
    pruneDeletedNodesFromGroups(new Set(result.deleted_node_ids), now);
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

  const nextGroups = new Map<string, CanvasGroupDto>();
  for (const grp of snapshot.groups ?? []) {
    nextGroups.set(grp.id, { ...grp, member_ids: [...grp.member_ids] });
  }
  groupsMap.value = nextGroups;
  selectedGroupId.value = null;

  viewportSpatialIndex.bulkLoad(snapshot.nodes);
  workspacePath.value = snapshot.path;
  tokenBudget.value = snapshot.token_budget;
  flowSystemPrompt.value = snapshot.system_prompt ?? "";
  staleNodesMap.value = new Map();
  externalRefsMap.value = new Map();
  spotlightRootId.value = null;
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

export async function refreshStaleNodes(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  try {
    const items = await getStaleNodes();
    const next = new Map<string, StaleNodeInfo>();
    for (const item of items) {
      next.set(item.node_id, item);
    }
    staleNodesMap.value = next;
  } catch {
    // Non-fatal: stale badges remain unchanged until the next refresh.
  }
}

export async function acknowledgeAndRefreshStaleNode(nodeId: string): Promise<void> {
  if (isTauriRuntime()) {
    await acknowledgeStaleNode(nodeId);
  }
  if (staleNodesMap.value.has(nodeId)) {
    const next = new Map(staleNodesMap.value);
    next.delete(nodeId);
    staleNodesMap.value = next;
  }
}

export async function refreshExternalRefs(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  try {
    const items = await getExternalRefStatuses();
    const next = new Map<string, ExternalRefInfo>();
    for (const item of items) {
      next.set(item.local_node_id, item);
    }
    externalRefsMap.value = next;
  } catch {
    // Non-fatal: external ref badges remain unchanged until the next refresh.
  }
}

export async function syncExternalRefNode(localNodeId: string): Promise<void> {
  const updated = await syncExternalRef(localNodeId);
  nodesMap.set(updated.id, updated);
  viewportSpatialIndex.upsert(updated);
  recomputeUnresolvedLoopholes();
  graphVersion.value += 1;
  cameraControllerRef.current?.refreshCull();
  cameraControllerRef.current?.markDirty();
  await Promise.all([refreshExternalRefs(), refreshStaleNodes()]);
}

export async function detachExternalRefNode(localNodeId: string): Promise<void> {
  if (isTauriRuntime()) {
    await detachExternalRef(localNodeId);
  }
  if (externalRefsMap.value.has(localNodeId)) {
    const next = new Map(externalRefsMap.value);
    next.delete(localNodeId);
    externalRefsMap.value = next;
  }
}

export async function pullExternalRefIntoCanvas(
  sourceWorkspaceId: string,
  sourceFlowId: string,
  sourceNodeId: string,
  attachToNodeId?: string | null,
): Promise<NodeDto | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  const pulled = await pullExternalReference(
    sourceWorkspaceId,
    sourceFlowId,
    sourceNodeId,
    attachToNodeId ?? null,
  );
  nodesMap.set(pulled.node.id, pulled.node);
  viewportSpatialIndex.upsert(pulled.node);
  const createdEdges: EdgeDto[] = [];
  if (pulled.edge) {
    edgesMap.set(pulled.edge.id, pulled.edge);
    createdEdges.push(pulled.edge);
  }

  const nextRefs = new Map(externalRefsMap.value);
  nextRefs.set(pulled.external_ref.local_node_id, pulled.external_ref);
  externalRefsMap.value = nextRefs;

  recomputeUnresolvedLoopholes();

  const { forward, inverse } = buildCreateNodeWithInverse(pulled.node, createdEdges);
  graphHistory.push({ label: "Link cross-flow card", forward, inverse });
  syncHistorySignals();

  selectSingle(pulled.node.id);
  graphVersion.value += 1;
  cameraControllerRef.current?.refreshCull();
  cameraControllerRef.current?.markDirty();

  const controller = cameraControllerRef.current;
  if (controller) {
    const w = pulled.node.layout.width ?? 320;
    const h = getEffectiveNodeHeight(pulled.node);
    const cx = pulled.node.layout.x + w / 2;
    const cy = pulled.node.layout.y + h / 2;
    const cam = controller.getCamera();
    const { width, height } = controller.getViewportSize();
    const targetZoom = clampZoom(Math.max(cam.zoom, 0.85));
    controller.animateTo(
      {
        x: width / 2 - cx * targetZoom,
        y: height / 2 - cy * targetZoom,
        zoom: targetZoom,
      },
      220,
    );
  }

  return pulled.node;
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
    scheduleSaveCurrentLocalFlowSnapshot();
  }

  recomputeUnresolvedLoopholes();
  if (focusId.value !== null && !nodesMap.has(focusId.value)) {
    selectSingle(null);
  }
  if (selectedGroupId.value !== null && !groupsMap.value.has(selectedGroupId.value)) {
    selectedGroupId.value = null;
  }

  graphVersion.value += 1;
  cameraControllerRef.current?.refreshCull();
  cameraControllerRef.current?.markDirty();
  return result;
}

export async function createCanvasGroup(
  memberIds?: string[],
  title?: string,
  colorKey?: string,
): Promise<CanvasGroupDto | null> {
  const sourceIds =
    memberIds !== undefined
      ? memberIds
      : selectedIds.value.size > 0
        ? Array.from(selectedIds.value)
        : focusId.value !== null
          ? [focusId.value]
          : [];
  const validMembers = dedupMemberIds(sourceIds).filter((id) => nodesMap.has(id));
  if (validMembers.length === 0) {
    return null;
  }
  const id = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const finalTitle = title && title.trim().length > 0 ? title.trim() : `Group ${groupsMap.value.size + 1}`;
  const finalColor =
    colorKey && colorKey.trim().length > 0
      ? colorKey.trim()
      : (GROUP_COLOR_KEYS[groupsMap.value.size % GROUP_COLOR_KEYS.length] ?? "cobalt");
  const { forward, inverse } = buildCreateGroupWithInverse({
    id,
    title: finalTitle,
    color_key: finalColor,
    member_ids: validMembers,
  });
  await mutateGraphUndoable("Create group", forward, inverse);
  selectedGroupId.value = id;
  return groupsMap.value.get(id) ?? null;
}

export async function updateCanvasGroup(
  id: string,
  patch: GroupPatch,
): Promise<CanvasGroupDto | null> {
  const prev = groupsMap.value.get(id);
  if (!prev) {
    return null;
  }
  const { forward, inverse } = buildUpdateGroupWithInverse(prev, patch);
  await mutateGraphUndoable("Update group", forward, inverse);
  return groupsMap.value.get(id) ?? null;
}

export async function deleteCanvasGroup(id: string): Promise<void> {
  const prev = groupsMap.value.get(id);
  if (!prev) {
    return;
  }
  const { forward, inverse } = buildDeleteGroupWithInverse(prev);
  if (selectedGroupId.value === id) {
    selectedGroupId.value = null;
  }
  await mutateGraphUndoable("Delete group", forward, inverse);
}

export async function connectNodesWithEdge(
  sourceId: string,
  targetId: string,
  edgeType: EdgeType,
): Promise<ApplyResult> {
  const edge: EdgeDto = {
    id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    source_id: sourceId,
    target_id: targetId,
    type: edgeType,
    weight: "summary",
    created_at: Date.now(),
  };
  const inverse: GraphOp[] = [{ op: "delete_edge", id: edge.id }];
  if (edgeType === "resolves") {
    const target = nodesMap.get(targetId);
    if (target && target.type === "loophole" && target.status !== "resolved") {
      inverse.push({ op: "update_node_meta", id: target.id, status: target.status });
    }
  }
  return mutateGraphUndoable("Create edge", [{ op: "create_edge", edge }], inverse);
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
  if (!isTauriRuntime()) {
    scheduleSaveCurrentLocalFlowSnapshot();
  }
  graphVersion.value += 1;
  cameraControllerRef.current?.refreshCull();
  cameraControllerRef.current?.markDirty();
  return spawned;
}

export async function duplicateNode(nodeId: string): Promise<NodeDto | null> {
  const source = nodesMap.get(nodeId);
  if (!source) {
    return null;
  }

  const now = Date.now();
  const id = `node_dup_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const copyTitle = `${source.title} (Copy)`;
  const duplicated: NodeDto = {
    id,
    type: source.type,
    status: source.status === "locked" ? "active" : source.status,
    title: copyTitle,
    content: source.content,
    summary: source.summary,
    content_hash: `${copyTitle.length}:${source.content.length}:${now}`,
    summary_hash: source.summary_hash,
    metadata: {
      severity: source.metadata.severity,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: source.metadata.token_count,
    },
    context_controls: {
      pin_global: source.context_controls.pin_global,
      exclude_from_ai: source.context_controls.exclude_from_ai,
    },
    layout: {
      x: source.layout.x + 36,
      y: source.layout.y + 36,
      width: source.layout.width,
      height: source.layout.height,
      collapsed: source.layout.collapsed,
    },
    created_at: now,
    updated_at: now,
  };

  const { forward, inverse } = buildCreateNodeWithInverse(duplicated);
  await mutateGraphUndoable("Duplicate node", forward, inverse);
  selectSingle(duplicated.id);
  await resolveAndAnimateOverlaps([duplicated.id]);
  return nodesMap.get(duplicated.id) ?? duplicated;
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

export async function resolveAndAnimateOverlaps(
  pinnedIds: string[],
): Promise<NodePositionUpdate[]> {
  if (resolvingOverlaps || nodesMap.size < 2) {
    return [];
  }
  resolvingOverlaps = true;
  try {
    const updates = isTauriRuntime()
      ? await resolveOverlaps(pinnedIds)
      : resolveOverlapsLocally(pinnedIds);
    if (updates.length > 0) {
      applyTidyPositions(updates);
      if (!isTauriRuntime()) {
        scheduleSaveCurrentLocalFlowSnapshot();
      }
    }
    return updates;
  } catch {
    // Non-fatal: layout remains usable if overlap resolution is skipped
    return [];
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

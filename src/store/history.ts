import { signal } from "@preact/signals";
import type {
  EdgeDto,
  GraphOp,
  NodeDto,
  NodeLayout,
  NodeMetadata,
  NodePositionUpdate,
  NodeSizeUpdate,
  NodeStatus,
  NodeType,
  Severity,
} from "../ipc/types";

export const HISTORY_CAPACITY = 100;

export interface HistoryEntry {
  label: string;
  forward: GraphOp[];
  inverse: GraphOp[];
}

export class UndoRedoHistory {
  private entries: HistoryEntry[] = [];
  private cursor = 0;

  push(entry: HistoryEntry): void {
    if (this.cursor < this.entries.length) {
      this.entries.length = this.cursor;
    }
    this.entries.push(entry);
    if (this.entries.length > HISTORY_CAPACITY) {
      this.entries.shift();
    }
    this.cursor = this.entries.length;
  }

  undo(): HistoryEntry | null {
    if (this.cursor === 0) {
      return null;
    }
    this.cursor -= 1;
    return this.entries[this.cursor] ?? null;
  }

  redo(): HistoryEntry | null {
    if (this.cursor >= this.entries.length) {
      return null;
    }
    const entry = this.entries[this.cursor] ?? null;
    this.cursor += 1;
    return entry;
  }

  canUndo(): boolean {
    return this.cursor > 0;
  }

  canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.cursor = 0;
  }
}

export const graphHistory = new UndoRedoHistory();
export const canUndoSignal = signal<boolean>(false);
export const canRedoSignal = signal<boolean>(false);

export function syncHistorySignals(): void {
  canUndoSignal.value = graphHistory.canUndo();
  canRedoSignal.value = graphHistory.canRedo();
}

export function buildCreateNodeWithInverse(
  node: NodeDto,
  edges: EdgeDto[] = [],
): { forward: GraphOp[]; inverse: GraphOp[] } {
  return {
    forward: [
      { op: "create_node", node },
      ...edges.map((edge): GraphOp => ({ op: "create_edge", edge })),
    ],
    inverse: [{ op: "delete_nodes", ids: [node.id] }],
  };
}

export function buildUpdateTextWithInverse(
  prev: NodeDto,
  nextTitle: string,
  nextContent: string,
): { forward: GraphOp[]; inverse: GraphOp[] } {
  return {
    forward: [
      {
        op: "update_node_text",
        id: prev.id,
        title: nextTitle,
        content: nextContent,
      },
    ],
    inverse: [
      {
        op: "update_node_text",
        id: prev.id,
        title: prev.title,
        content: prev.content,
      },
    ],
  };
}

export interface NodeMetaPatch {
  node_type?: NodeType;
  status?: NodeStatus;
  severity?: Severity | null;
  pin_global?: boolean;
  exclude_from_ai?: boolean;
  collapsed?: boolean;
}

export function buildUpdateMetaWithInverse(
  prev: NodeDto,
  patch: NodeMetaPatch,
): { forward: GraphOp[]; inverse: GraphOp[] } {
  const forwardOp: Extract<GraphOp, { op: "update_node_meta" }> = {
    op: "update_node_meta",
    id: prev.id,
    ...patch,
  };
  const inverseOp: Extract<GraphOp, { op: "update_node_meta" }> = {
    op: "update_node_meta",
    id: prev.id,
  };
  if (patch.node_type !== undefined) {
    inverseOp.node_type = prev.type;
  }
  if (patch.status !== undefined) {
    inverseOp.status = prev.status;
  }
  if (patch.severity !== undefined) {
    const prevSev: NodeMetadata["severity"] = prev.metadata.severity;
    inverseOp.severity = prevSev;
  }
  if (patch.pin_global !== undefined) {
    inverseOp.pin_global = prev.context_controls.pin_global;
  }
  if (patch.exclude_from_ai !== undefined) {
    inverseOp.exclude_from_ai = prev.context_controls.exclude_from_ai;
  }
  if (patch.collapsed !== undefined) {
    const prevCollapsed: NodeLayout["collapsed"] = prev.layout.collapsed;
    inverseOp.collapsed = prevCollapsed;
  }

  return {
    forward: [forwardOp],
    inverse: [inverseOp],
  };
}

export function buildMoveNodesWithInverse(
  prevPositions: NodePositionUpdate[],
  nextPositions: NodePositionUpdate[],
): { forward: GraphOp[]; inverse: GraphOp[] } {
  return {
    forward: [{ op: "move_nodes", moves: nextPositions }],
    inverse: [{ op: "move_nodes", moves: prevPositions }],
  };
}

export function buildResizeNodesWithInverse(
  prevSizes: NodeSizeUpdate[],
  nextSizes: NodeSizeUpdate[],
): { forward: GraphOp[]; inverse: GraphOp[] } {
  return {
    forward: [{ op: "resize_nodes", sizes: nextSizes }],
    inverse: [{ op: "resize_nodes", sizes: prevSizes }],
  };
}

export function buildDeleteWithInverse(
  ids: string[],
  nodes: Map<string, NodeDto>,
  edges: Map<string, EdgeDto>,
): { forward: GraphOp[]; inverse: GraphOp[] } {
  const uniqueIds: string[] = [];
  const deleteSet = new Set<string>();
  const capturedNodes: NodeDto[] = [];

  for (const id of ids) {
    if (deleteSet.has(id)) {
      continue;
    }
    const node = nodes.get(id);
    if (node) {
      deleteSet.add(id);
      uniqueIds.push(id);
      capturedNodes.push({
        ...node,
        metadata: { ...node.metadata },
        context_controls: { ...node.context_controls },
        layout: { ...node.layout },
      });
    }
  }

  const capturedEdges: EdgeDto[] = [];
  for (const edge of edges.values()) {
    if (deleteSet.has(edge.source_id) || deleteSet.has(edge.target_id)) {
      capturedEdges.push({ ...edge });
    }
  }

  return {
    forward: [{ op: "delete_nodes", ids: uniqueIds }],
    inverse: [
      ...capturedNodes.map((node): GraphOp => ({ op: "create_node", node })),
      ...capturedEdges.map((edge): GraphOp => ({ op: "create_edge", edge })),
    ],
  };
}

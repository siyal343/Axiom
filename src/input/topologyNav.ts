import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import type { EdgeDto, NodeDto, NodePositionUpdate } from "../ipc/types";

function compareNodesYX(a: NodeDto, b: NodeDto): number {
  return a.layout.y - b.layout.y || a.layout.x - b.layout.x || a.id.localeCompare(b.id);
}

function isSpineEdge(edge: EdgeDto): boolean {
  return edge.type === "derives" || edge.type === "branches" || edge.type === "synthesizes";
}

function dedupAndSortNodes(candidates: NodeDto[]): NodeDto[] {
  const seen = new Set<string>();
  const unique: NodeDto[] = [];
  for (const node of candidates) {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      unique.push(node);
    }
  }
  unique.sort(compareNodesYX);
  return unique;
}

export function findParentTarget(
  focusId: string,
  nodes: Map<string, NodeDto>,
  edges: Map<string, EdgeDto>,
): string | null {
  const focused = nodes.get(focusId);
  if (!focused) {
    return null;
  }

  if (focused.type === "loophole") {
    const challengedTargets: NodeDto[] = [];
    for (const edge of edges.values()) {
      if (edge.source_id === focusId && edge.type === "challenges") {
        const target = nodes.get(edge.target_id);
        if (target) {
          challengedTargets.push(target);
        }
      }
    }
    const sortedTargets = dedupAndSortNodes(challengedTargets);
    if (sortedTargets.length > 0) {
      return sortedTargets[0].id;
    }
  }

  const spineParents: NodeDto[] = [];
  for (const edge of edges.values()) {
    if (edge.target_id === focusId && isSpineEdge(edge)) {
      const src = nodes.get(edge.source_id);
      if (src) {
        spineParents.push(src);
      }
    }
  }
  const sortedParents = dedupAndSortNodes(spineParents);
  return sortedParents[0]?.id ?? null;
}

export function findFirstChildTarget(
  focusId: string,
  nodes: Map<string, NodeDto>,
  edges: Map<string, EdgeDto>,
): string | null {
  if (!nodes.has(focusId)) {
    return null;
  }

  const spineChildren: NodeDto[] = [];
  const satelliteChildren: NodeDto[] = [];

  for (const edge of edges.values()) {
    if (edge.source_id === focusId && isSpineEdge(edge)) {
      const target = nodes.get(edge.target_id);
      if (!target) {
        continue;
      }
      if (target.type === "probe" || target.type === "loophole") {
        satelliteChildren.push(target);
      } else {
        spineChildren.push(target);
      }
    } else if (edge.target_id === focusId && edge.type === "challenges") {
      const src = nodes.get(edge.source_id);
      if (src) {
        satelliteChildren.push(src);
      }
    }
  }

  const sortedSpine = dedupAndSortNodes(spineChildren);
  if (sortedSpine.length > 0) {
    return sortedSpine[0].id;
  }
  const sortedSatellites = dedupAndSortNodes(satelliteChildren);
  return sortedSatellites[0]?.id ?? null;
}

export function getOrderedSiblings(
  focusId: string,
  nodes: Map<string, NodeDto>,
  edges: Map<string, EdgeDto>,
): NodeDto[] {
  const focused = nodes.get(focusId);
  if (!focused) {
    return [];
  }

  if (focused.type === "loophole") {
    const primaryTargetId = findParentTarget(focusId, nodes, edges);
    if (primaryTargetId !== null) {
      const loopholes: NodeDto[] = [];
      for (const edge of edges.values()) {
        if (edge.target_id === primaryTargetId && edge.type === "challenges") {
          const src = nodes.get(edge.source_id);
          if (src && src.type === "loophole") {
            loopholes.push(src);
          }
        }
      }
      return dedupAndSortNodes(loopholes);
    }
    const detachedLoopholes: NodeDto[] = [];
    for (const node of nodes.values()) {
      if (node.type === "loophole" && findParentTarget(node.id, nodes, edges) === null) {
        detachedLoopholes.push(node);
      }
    }
    return dedupAndSortNodes(detachedLoopholes);
  }

  const parentId = findParentTarget(focusId, nodes, edges);
  if (parentId !== null) {
    const siblings: NodeDto[] = [];
    for (const edge of edges.values()) {
      if (edge.source_id === parentId && isSpineEdge(edge)) {
        const target = nodes.get(edge.target_id);
        if (!target) {
          continue;
        }
        if (focused.type === "probe") {
          if (target.type === "probe") {
            siblings.push(target);
          }
        } else if (target.type !== "probe" && target.type !== "loophole") {
          siblings.push(target);
        }
      }
    }
    return dedupAndSortNodes(siblings);
  }

  // Detached top-level roots
  const hasSpineParent = new Set<string>();
  for (const edge of edges.values()) {
    if (isSpineEdge(edge)) {
      hasSpineParent.add(edge.target_id);
    }
  }
  const roots: NodeDto[] = [];
  for (const node of nodes.values()) {
    if (node.type !== "loophole" && !hasSpineParent.has(node.id)) {
      roots.push(node);
    }
  }
  return dedupAndSortNodes(roots);
}

export function findSiblingTarget(
  focusId: string,
  direction: 1 | -1,
  nodes: Map<string, NodeDto>,
  edges: Map<string, EdgeDto>,
): string | null {
  const siblings = getOrderedSiblings(focusId, nodes, edges);
  if (siblings.length <= 1) {
    return null;
  }
  const currentIdx = siblings.findIndex((n) => n.id === focusId);
  if (currentIdx === -1) {
    return siblings[0]?.id ?? null;
  }
  const nextIdx = (currentIdx + direction + siblings.length) % siblings.length;
  return siblings[nextIdx]?.id ?? null;
}

export function collectSubtreeIds(
  rootId: string,
  nodes: Map<string, NodeDto>,
  edges: Map<string, EdgeDto>,
): string[] {
  if (!nodes.has(rootId)) {
    return [];
  }
  const visited = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  const result: string[] = [];

  while (queue.length > 0) {
    const curr = queue.shift();
    if (curr === undefined) {
      break;
    }
    result.push(curr);

    for (const edge of edges.values()) {
      if (edge.source_id === curr && isSpineEdge(edge)) {
        if (nodes.has(edge.target_id) && !visited.has(edge.target_id)) {
          visited.add(edge.target_id);
          queue.push(edge.target_id);
        }
      } else if (edge.target_id === curr && edge.type === "challenges") {
        if (nodes.has(edge.source_id) && !visited.has(edge.source_id)) {
          visited.add(edge.source_id);
          queue.push(edge.source_id);
        }
      }
    }
  }

  return result;
}

export function collectSpotlightIds(
  rootId: string | null,
  nodes: Map<string, NodeDto>,
  edges: Map<string, EdgeDto>,
): Set<string> {
  if (rootId === null || !nodes.has(rootId)) {
    return new Set();
  }

  // Backward BFS across spine edges (derives, branches, synthesizes)
  const lineage = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const curr = queue.shift();
    if (curr === undefined) {
      break;
    }
    for (const edge of edges.values()) {
      if (edge.target_id === curr && isSpineEdge(edge)) {
        if (nodes.has(edge.source_id) && !lineage.has(edge.source_id)) {
          lineage.add(edge.source_id);
          queue.push(edge.source_id);
        }
      }
    }
  }

  // Union with forward subtree (including challenged loopholes)
  for (const id of collectSubtreeIds(rootId, nodes, edges)) {
    lineage.add(id);
  }

  // Include 1-hop challenges, resolves, and references neighbors of any node in the lineage
  const spotlight = new Set<string>(lineage);
  for (const edge of edges.values()) {
    if (
      edge.type !== "challenges" &&
      edge.type !== "resolves" &&
      edge.type !== "references"
    ) {
      continue;
    }
    if (lineage.has(edge.source_id) && nodes.has(edge.target_id)) {
      spotlight.add(edge.target_id);
    }
    if (lineage.has(edge.target_id) && nodes.has(edge.source_id)) {
      spotlight.add(edge.source_id);
    }
  }

  return spotlight;
}

export type AlignMode = "left" | "top" | "distribute_h" | "distribute_v";

export function computeAlignmentMoves(
  nodeIds: Iterable<string>,
  nodes: Map<string, NodeDto>,
  mode: AlignMode,
): { prev: NodePositionUpdate[]; next: NodePositionUpdate[] } {
  const seen = new Set<string>();
  const items: NodeDto[] = [];
  for (const id of nodeIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const node = nodes.get(id);
    if (node) {
      items.push(node);
    }
  }

  if (items.length < 2) {
    return { prev: [], next: [] };
  }

  const targets = new Map<string, { x: number; y: number }>();

  if (mode === "left") {
    let minX = Number.POSITIVE_INFINITY;
    for (const node of items) {
      if (node.layout.x < minX) {
        minX = node.layout.x;
      }
    }
    for (const node of items) {
      targets.set(node.id, { x: minX, y: node.layout.y });
    }
  } else if (mode === "top") {
    let minY = Number.POSITIVE_INFINITY;
    for (const node of items) {
      if (node.layout.y < minY) {
        minY = node.layout.y;
      }
    }
    for (const node of items) {
      targets.set(node.id, { x: node.layout.x, y: minY });
    }
  } else if (mode === "distribute_h") {
    if (items.length < 3) {
      return { prev: [], next: [] };
    }
    items.sort((a, b) => a.layout.x - b.layout.x || a.id.localeCompare(b.id));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      return { prev: [], next: [] };
    }
    let widthSum = 0;
    for (let i = 0; i < items.length - 1; i += 1) {
      const item = items[i];
      if (item) {
        widthSum += item.layout.width;
      }
    }
    const totalGapSpace = last.layout.x - first.layout.x - widthSum;
    if (totalGapSpace >= 0) {
      const gap = totalGapSpace / (items.length - 1);
      let cursor = first.layout.x + first.layout.width + gap;
      for (let i = 1; i < items.length - 1; i += 1) {
        const item = items[i];
        if (!item) continue;
        targets.set(item.id, { x: cursor, y: item.layout.y });
        cursor += item.layout.width + gap;
      }
    } else {
      const step = (last.layout.x - first.layout.x) / (items.length - 1);
      for (let i = 1; i < items.length - 1; i += 1) {
        const item = items[i];
        if (!item) continue;
        targets.set(item.id, { x: first.layout.x + step * i, y: item.layout.y });
      }
    }
  } else {
    if (items.length < 3) {
      return { prev: [], next: [] };
    }
    items.sort((a, b) => a.layout.y - b.layout.y || a.id.localeCompare(b.id));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      return { prev: [], next: [] };
    }
    let heightSum = 0;
    for (let i = 0; i < items.length - 1; i += 1) {
      const item = items[i];
      if (item) {
        heightSum += getEffectiveNodeHeight(item);
      }
    }
    const totalGapSpace = last.layout.y - first.layout.y - heightSum;
    if (totalGapSpace >= 0) {
      const gap = totalGapSpace / (items.length - 1);
      let cursor = first.layout.y + getEffectiveNodeHeight(first) + gap;
      for (let i = 1; i < items.length - 1; i += 1) {
        const item = items[i];
        if (!item) continue;
        targets.set(item.id, { x: item.layout.x, y: cursor });
        cursor += getEffectiveNodeHeight(item) + gap;
      }
    } else {
      const step = (last.layout.y - first.layout.y) / (items.length - 1);
      for (let i = 1; i < items.length - 1; i += 1) {
        const item = items[i];
        if (!item) continue;
        targets.set(item.id, { x: item.layout.x, y: first.layout.y + step * i });
      }
    }
  }

  const prev: NodePositionUpdate[] = [];
  const next: NodePositionUpdate[] = [];
  for (const node of items) {
    const target = targets.get(node.id);
    if (!target) {
      continue;
    }
    if (
      Math.abs(target.x - node.layout.x) > 0.5 ||
      Math.abs(target.y - node.layout.y) > 0.5
    ) {
      prev.push({ id: node.id, x: node.layout.x, y: node.layout.y });
      next.push({ id: node.id, x: target.x, y: target.y });
    }
  }

  return { prev, next };
}

import type { EdgeDto, NodeDto } from "../ipc/types";

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

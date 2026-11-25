import { clampZoom } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import type { EdgeDto, EdgeType, NodeDto } from "../ipc/types";
import { cameraControllerRef, edgesMap, graphVersion, nodesMap } from "../store/graphStore";
import { focusId, modalState, selectSingle } from "../store/selection";
import { sidebarOpen } from "../store/workspaceCatalogStore";

const SPINE_EDGE_TYPES: ReadonlySet<EdgeType> = new Set([
  "derives",
  "branches",
  "synthesizes",
]);

function isEarlierParent(candidate: NodeDto, current: NodeDto): boolean {
  if (candidate.created_at !== current.created_at) {
    return candidate.created_at < current.created_at;
  }
  return candidate.id < current.id;
}

export function computeSpineBreadcrumb(
  focusNodeId: string | null,
  nodes: Map<string, NodeDto>,
  edges: Map<string, EdgeDto>,
  maxItems = 6,
): { items: NodeDto[]; truncated: boolean } {
  if (!focusNodeId) {
    return { items: [], truncated: false };
  }
  const focusNode = nodes.get(focusNodeId);
  if (!focusNode) {
    return { items: [], truncated: false };
  }

  const bestParentByTarget = new Map<string, NodeDto>();
  for (const edge of edges.values()) {
    if (!SPINE_EDGE_TYPES.has(edge.type) || edge.source_id === edge.target_id) {
      continue;
    }
    const parent = nodes.get(edge.source_id);
    if (!parent) {
      continue;
    }
    const existing = bestParentByTarget.get(edge.target_id);
    if (!existing || isEarlierParent(parent, existing)) {
      bestParentByTarget.set(edge.target_id, parent);
    }
  }

  const visited = new Set<string>([focusNode.id]);
  const reversed: NodeDto[] = [focusNode];
  let currentId = focusNode.id;

  while (true) {
    const parent = bestParentByTarget.get(currentId);
    if (!parent || visited.has(parent.id)) {
      break;
    }
    visited.add(parent.id);
    reversed.push(parent);
    currentId = parent.id;
  }

  const chain = reversed.reverse();
  if (chain.length > maxItems) {
    const safeMax = Math.max(1, maxItems);
    const tailCount = safeMax - 1;
    const items =
      tailCount > 0 ? [chain[0]!, ...chain.slice(-tailCount)] : [chain[0]!];
    return { items, truncated: true };
  }

  return { items: chain, truncated: false };
}

function centerCameraOnNode(node: NodeDto): void {
  const ctrl = cameraControllerRef.current;
  if (!ctrl) {
    return;
  }
  const w = node.layout.width;
  const h = getEffectiveNodeHeight(node);
  const cx = node.layout.x + w / 2;
  const cy = node.layout.y + h / 2;
  const cam = ctrl.getCamera();
  const { width, height } = ctrl.getViewportSize();
  const targetZoom = clampZoom(Math.max(cam.zoom, 0.85));
  ctrl.animateTo(
    {
      x: width / 2 - cx * targetZoom,
      y: height / 2 - cy * targetZoom,
      zoom: targetZoom,
    },
    220,
  );
}

export function SpineBreadcrumb() {
  const focused = focusId.value;
  const version = graphVersion.value;
  const isSidebarOpen = sidebarOpen.value;
  const mode = modalState.value;
  void version;

  const { items, truncated } = computeSpineBreadcrumb(focused, nodesMap, edgesMap);
  if (items.length < 2 || mode !== "navigate") {
    return null;
  }

  const navClass = isSidebarOpen
    ? "spine-breadcrumb spine-breadcrumb--shifted"
    : "spine-breadcrumb";

  return (
    <nav class={navClass} aria-label="Focused lineage">
      {items.map((crumb, idx) => {
        const isCurrent = idx === items.length - 1;
        const label = crumb.title || "Untitled";
        return (
          <span key={crumb.id} class="spine-breadcrumb__segment">
            {idx > 0 && (
              <span class="spine-breadcrumb__sep" aria-hidden="true">
                {truncated && idx === 1 ? "› … ›" : "›"}
              </span>
            )}
            <button
              type="button"
              class={
                isCurrent
                  ? "spine-breadcrumb__crumb spine-breadcrumb__crumb--current"
                  : "spine-breadcrumb__crumb"
              }
              aria-current={isCurrent ? "location" : undefined}
              title={label}
              onClick={() => {
                selectSingle(crumb.id);
                centerCameraOnNode(crumb);
              }}
            >
              {label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

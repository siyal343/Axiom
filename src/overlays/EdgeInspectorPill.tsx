import { useEffect, useRef } from "preact/hooks";
import { type CameraTransform, worldToScreen } from "../canvas/camera";
import { getEdgeMidpointWorld } from "../canvas/renderer2d";
import type { EdgeDto, EdgeType, EdgeWeight, GraphOp } from "../ipc/types";
import { notifyIpcError } from "./ToastStack";
import {
  cameraControllerRef,
  dragOffsets,
  edgesMap,
  graphVersion,
  isBirdsEye,
  mutateGraphUndoable,
  nodesMap,
  resizeSizes,
} from "../store/graphStore";
import { isInteracting, modalState, selectedEdgeId, selectEdge } from "../store/selection";

const EDGE_TYPES: ReadonlyArray<{ value: EdgeType; label: string }> = [
  { value: "derives", label: "Derives" },
  { value: "branches", label: "Branches" },
  { value: "challenges", label: "Challenges" },
  { value: "resolves", label: "Resolves" },
  { value: "synthesizes", label: "Synthesizes" },
  { value: "references", label: "References" },
];

function computePillTransform(
  edge: EdgeDto,
  cam: CameraTransform,
  pillEl?: HTMLElement | null,
): string {
  const mid = getEdgeMidpointWorld(edge, nodesMap, dragOffsets, resizeSizes);
  if (!mid) {
    return "translate3d(-9999px, -9999px, 0)";
  }
  const screen = worldToScreen(mid.x, mid.y, cam);
  const vp = cameraControllerRef.current?.getViewportSize() ?? {
    width: typeof window !== "undefined" ? window.innerWidth : 1280,
    height: typeof window !== "undefined" ? window.innerHeight : 800,
  };
  const halfW = pillEl?.offsetWidth ? pillEl.offsetWidth * 0.5 : Math.min(170, vp.width * 0.45);
  const pillH = pillEl?.offsetHeight || 38;
  const minX = halfW + 16;
  const maxX = vp.width - halfW - 16;
  const x =
    minX >= maxX ? Math.round(vp.width * 0.5) : Math.round(Math.max(minX, Math.min(maxX, screen.x)));
  const minY = 60 + pillH;
  const maxY = Math.max(minY, vp.height - 78);
  const y = Math.round(Math.max(minY, Math.min(maxY, screen.y - 14)));
  return `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
}

export function EdgeInspectorPill() {
  const pillRef = useRef<HTMLDivElement | null>(null);

  const edgeId = selectedEdgeId.value;
  const mode = modalState.value;
  const interacting = isInteracting.value;
  const birdsEye = isBirdsEye.value;
  const version = graphVersion.value;

  const edge =
    edgeId !== null && mode === "navigate" && !interacting && !birdsEye
      ? edgesMap.get(edgeId) ?? null
      : null;

  useEffect(() => {
    const el = pillRef.current;
    const ctrl = cameraControllerRef.current;
    if (!el || !edge || !ctrl) {
      return;
    }

    el.style.transform = computePillTransform(edge, ctrl.getCamera(), el);
    if (!ctrl.subscribeFrame) {
      return;
    }
    return ctrl.subscribeFrame((cam) => {
      if (pillRef.current) {
        pillRef.current.style.transform = computePillTransform(edge, cam, pillRef.current);
      }
    });
  }, [edge?.id, edge?.source_id, edge?.target_id, edge?.type, edge?.weight, version]);

  if (!edge) {
    return null;
  }

  const cam = cameraControllerRef.current?.getCamera() ?? {
    x: 0,
    y: 0,
    zoom: 1,
    last_focus_id: null,
  };
  const initialTransform = computePillTransform(edge, cam, pillRef.current);

  const handleTypeChange = (nextType: EdgeType): void => {
    if (nextType === edge.type) {
      return;
    }
    const nextEdge: EdgeDto = { ...edge, type: nextType };
    const forward: GraphOp[] = [
      { op: "delete_edge", id: edge.id },
      { op: "create_edge", edge: nextEdge },
    ];
    const inverse: GraphOp[] = [
      { op: "delete_edge", id: edge.id },
      { op: "create_edge", edge: { ...edge } },
    ];
    if (nextType === "resolves") {
      const target = nodesMap.get(edge.target_id);
      if (target && target.type === "loophole" && target.status !== "resolved") {
        inverse.push({ op: "update_node_meta", id: target.id, status: target.status });
      }
    }
    void mutateGraphUndoable("Change edge type", forward, inverse).catch(notifyIpcError);
  };

  const handleToggleWeight = (): void => {
    const nextWeight: EdgeWeight = edge.weight === "full" ? "summary" : "full";
    const forward: GraphOp[] = [{ op: "update_edge_weight", id: edge.id, weight: nextWeight }];
    const inverse: GraphOp[] = [{ op: "update_edge_weight", id: edge.id, weight: edge.weight }];
    void mutateGraphUndoable("Toggle edge weight", forward, inverse)
      .then(() => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("axiom:xray-refresh"));
        }
      })
      .catch(notifyIpcError);
  };

  const handleReverse = (): void => {
    const reversedEdge: EdgeDto = {
      ...edge,
      source_id: edge.target_id,
      target_id: edge.source_id,
    };
    const forward: GraphOp[] = [
      { op: "delete_edge", id: edge.id },
      { op: "create_edge", edge: reversedEdge },
    ];
    const inverse: GraphOp[] = [
      { op: "delete_edge", id: edge.id },
      { op: "create_edge", edge: { ...edge } },
    ];
    if (edge.type === "resolves") {
      const nextTarget = nodesMap.get(reversedEdge.target_id);
      if (nextTarget && nextTarget.type === "loophole" && nextTarget.status !== "resolved") {
        inverse.push({ op: "update_node_meta", id: nextTarget.id, status: nextTarget.status });
      }
    }
    void mutateGraphUndoable("Reverse edge", forward, inverse).catch(notifyIpcError);
  };

  const handleDelete = (): void => {
    const forward: GraphOp[] = [{ op: "delete_edge", id: edge.id }];
    const inverse: GraphOp[] = [{ op: "create_edge", edge: { ...edge } }];
    selectEdge(null);
    void mutateGraphUndoable("Delete edge", forward, inverse).catch(notifyIpcError);
  };

  return (
    <div
      ref={pillRef}
      class="edge-inspector-pill"
      role="toolbar"
      aria-label="Edge inspector"
      style={{
        position: "absolute",
        left: "0",
        top: "0",
        zIndex: 42,
        transform: initialTransform,
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "4px 8px",
        borderRadius: "var(--radius-pill)",
        background: "var(--bg-pill)",
        border: "1px solid var(--border-strong)",
        boxShadow: "var(--shadow-card)",
        backdropFilter: "blur(8px)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <select
        class="edge-inspector-pill__select"
        aria-label="Edge type"
        value={edge.type}
        style={{
          background: "var(--bg-code)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-pill)",
          fontFamily: "var(--font-ui)",
          fontSize: "11.5px",
          fontWeight: 500,
          padding: "3px 8px",
          cursor: "pointer",
        }}
        onChange={(e) => handleTypeChange(e.currentTarget.value as EdgeType)}
      >
        {EDGE_TYPES.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        class="edge-inspector-pill__btn"
        aria-label="Toggle edge weight"
        title="Switch AI context depth between Summary (compact) and Full"
        style={{
          appearance: "none",
          border: "1px solid var(--border-subtle)",
          background: "var(--bg-code)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-ui)",
          fontSize: "11.5px",
          fontWeight: 500,
          minHeight: "24px",
          padding: "2px 8px",
          borderRadius: "var(--radius-pill)",
          cursor: "pointer",
        }}
        onClick={handleToggleWeight}
      >
        {edge.weight === "full" ? "Full" : "Summary"}
      </button>
      <button
        type="button"
        class="edge-inspector-pill__btn"
        aria-label="Reverse edge direction"
        title="Reverse direction"
        style={{
          appearance: "none",
          border: "none",
          background: "transparent",
          color: "var(--text-primary)",
          fontFamily: "var(--font-ui)",
          fontSize: "13px",
          fontWeight: 600,
          minHeight: "24px",
          minWidth: "24px",
          padding: "2px 6px",
          borderRadius: "var(--radius-pill)",
          cursor: "pointer",
        }}
        onClick={handleReverse}
      >
        ⇄
      </button>
      <button
        type="button"
        class="edge-inspector-pill__btn edge-inspector-pill__btn--danger"
        aria-label="Delete edge"
        title="Delete edge"
        style={{
          appearance: "none",
          border: "none",
          background: "transparent",
          color: "var(--accent-loophole-high)",
          fontFamily: "var(--font-ui)",
          fontSize: "14px",
          fontWeight: 600,
          minHeight: "24px",
          minWidth: "24px",
          padding: "2px 6px",
          borderRadius: "var(--radius-pill)",
          cursor: "pointer",
        }}
        onClick={handleDelete}
      >
        ×
      </button>
    </div>
  );
}

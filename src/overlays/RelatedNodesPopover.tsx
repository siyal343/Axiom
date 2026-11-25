import { useEffect, useState } from "preact/hooks";
import { clampZoom } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import { findRelatedNodes, isTauriRuntime, parseIpcError } from "../ipc/client";
import type { EdgeDto, GraphOp, RelatedNodeHit } from "../ipc/types";
import {
  cameraControllerRef,
  mutateGraphUndoable,
  nodesMap,
} from "../store/graphStore";
import { relatedPopoverNodeId, selectSingle } from "../store/selection";
import { notifyIpcError, pushToast } from "./ToastStack";

function centerCameraOnHit(hit: RelatedNodeHit): void {
  const ctrl = cameraControllerRef.current;
  if (!ctrl) {
    return;
  }
  const node = nodesMap.get(hit.id);
  const w = node?.layout.width ?? 320;
  const h = node ? getEffectiveNodeHeight(node) : 180;
  const cx = (node?.layout.x ?? hit.x) + w / 2;
  const cy = (node?.layout.y ?? hit.y) + h / 2;
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

export function RelatedNodesPopover() {
  const sourceId = relatedPopoverNodeId.value;
  const [hits, setHits] = useState<RelatedNodeHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const inTauri = isTauriRuntime();

  useEffect(() => {
    if (sourceId === null) {
      setHits([]);
      setLoading(false);
      setErrorMsg(null);
      setLinkingId(null);
      return;
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        relatedPopoverNodeId.value = null;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);

    if (!inTauri) {
      setHits([]);
      setLoading(false);
      setErrorMsg(null);
      return () => {
        window.removeEventListener("keydown", onKeyDown, true);
      };
    }

    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);

    void findRelatedNodes(sourceId, 8)
      .then((results) => {
        if (!cancelled) {
          setHits(results);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setHits([]);
          setErrorMsg(parseIpcError(err).message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [sourceId, inTauri]);

  if (sourceId === null) {
    return null;
  }

  const sourceNode = nodesMap.get(sourceId);
  const sourceTitle = sourceNode?.title || "Untitled";

  const handleClose = (): void => {
    relatedPopoverNodeId.value = null;
  };

  const handleJump = (hit: RelatedNodeHit): void => {
    selectSingle(hit.id);
    centerCameraOnHit(hit);
    relatedPopoverNodeId.value = null;
  };

  const handleLinkRef = async (hit: RelatedNodeHit): Promise<void> => {
    if (linkingId !== null) {
      return;
    }
    setLinkingId(hit.id);
    const edge: EdgeDto = {
      id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      source_id: sourceId,
      target_id: hit.id,
      type: "references",
      weight: "summary",
      created_at: Date.now(),
    };
    const forward: GraphOp[] = [{ op: "create_edge", edge }];
    const inverse: GraphOp[] = [{ op: "delete_edge", id: edge.id }];
    try {
      await mutateGraphUndoable("Link reference", forward, inverse);
      setHits((prev) => prev.filter((item) => item.id !== hit.id));
      pushToast(`Linked reference to "${hit.title || "Untitled"}"`, "info");
    } catch (err) {
      notifyIpcError(err);
    } finally {
      setLinkingId((curr) => (curr === hit.id ? null : curr));
    }
  };

  return (
    <div
      class="related-popover"
      role="dialog"
      aria-label={`Related nodes for ${sourceTitle}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header class="related-popover__header">
        <div class="related-popover__title-group">
          <span class="related-popover__eyebrow">Related Nodes</span>
          <strong class="related-popover__source" title={sourceTitle}>
            {sourceTitle}
          </strong>
        </div>
        <button
          type="button"
          class="related-popover__close"
          aria-label="Close related nodes"
          onClick={handleClose}
        >
          ×
        </button>
      </header>

      <div class="related-popover__body">
        {!inTauri ? (
          <p class="related-popover__empty">
            Local BM25 Related Nodes discovery runs in the Tauri desktop runtime.
          </p>
        ) : loading ? (
          <p class="related-popover__empty">Searching related nodes…</p>
        ) : errorMsg !== null ? (
          <p class="related-popover__error">{errorMsg}</p>
        ) : hits.length === 0 ? (
          <p class="related-popover__empty">No related nodes found in this flow.</p>
        ) : (
          <ul class="related-popover__list">
            {hits.map((hit) => (
              <li key={hit.id} class="related-popover__item">
                <div class="related-popover__item-top">
                  <span class="related-popover__item-title">
                    {hit.title || "Untitled"}
                  </span>
                  <span class="related-popover__type-pill">{hit.type}</span>
                </div>
                {hit.snippet && (
                  <p class="related-popover__snippet">{hit.snippet}</p>
                )}
                <div class="related-popover__actions">
                  <button
                    type="button"
                    class="related-popover__btn"
                    onClick={() => handleJump(hit)}
                  >
                    Jump
                  </button>
                  <button
                    type="button"
                    class="related-popover__btn related-popover__btn--primary"
                    disabled={linkingId === hit.id}
                    onClick={() => {
                      void handleLinkRef(hit);
                    }}
                  >
                    Link Ref
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

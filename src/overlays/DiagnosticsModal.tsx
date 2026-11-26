import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { clampZoom } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import {
  enqueueStaleSummaries,
  getGraphDiagnostics,
  isTauriRuntime,
  parseIpcError,
} from "../ipc/client";
import type { DiagnosticItem, GraphDiagnostics } from "../ipc/types";
import {
  acknowledgeAndRefreshStaleNode,
  cameraControllerRef,
  edgesMap,
  nodesMap,
} from "../store/graphStore";
import {
  closeDiagnosticsModal,
  diagnosticsModalOpen,
  selectSingle,
  staleNodesMap,
} from "../store/selection";
import { pushToast } from "./ToastStack";
import { useDialogFocusTrap } from "./useDialogFocusTrap";

function computeBrowserPreviewDiagnostics(): GraphDiagnostics {
  const degreeMap = new Map<string, number>();
  for (const id of nodesMap.keys()) {
    degreeMap.set(id, 0);
  }
  for (const edge of edgesMap.values()) {
    degreeMap.set(edge.source_id, (degreeMap.get(edge.source_id) ?? 0) + 1);
    degreeMap.set(edge.target_id, (degreeMap.get(edge.target_id) ?? 0) + 1);
  }

  let totalTokens = 0;
  let pinCount = 0;
  let excludedCount = 0;
  const unresolvedLoopholes: DiagnosticItem[] = [];
  const staleAiNodes: DiagnosticItem[] = [];
  const orphanNodes: DiagnosticItem[] = [];
  const unsummarizedHeavyNodes: DiagnosticItem[] = [];
  const staleMap = staleNodesMap.value;

  for (const node of nodesMap.values()) {
    totalTokens += node.metadata.token_count;
    if (node.context_controls.pin_global) {
      pinCount += 1;
    }
    if (node.context_controls.exclude_from_ai) {
      excludedCount += 1;
    }
    if (node.type === "loophole" && node.status === "active") {
      unresolvedLoopholes.push({
        node_id: node.id,
        title: node.title || "Untitled",
        type: node.type,
        severity: node.metadata.severity ?? "medium",
        detail: "Active unresolved loophole",
        token_count: node.metadata.token_count,
      });
    }
    const staleInfo = staleMap.get(node.id);
    if (staleInfo) {
      const reasons = staleInfo.changed_inputs.map((c) => `${c.title} (${c.reason})`).join(", ");
      staleAiNodes.push({
        node_id: node.id,
        title: node.title || "Untitled",
        type: node.type,
        severity: node.metadata.severity,
        detail: reasons || `${staleInfo.lens} inputs changed`,
        token_count: node.metadata.token_count,
      });
    }
    if (nodesMap.size > 1 && (degreeMap.get(node.id) ?? 0) === 0) {
      orphanNodes.push({
        node_id: node.id,
        title: node.title || "Untitled",
        type: node.type,
        severity: node.metadata.severity,
        detail: "No incoming or outgoing edges",
        token_count: node.metadata.token_count,
      });
    }
    if (node.metadata.token_count >= 300 && node.summary.trim().length === 0) {
      unsummarizedHeavyNodes.push({
        node_id: node.id,
        title: node.title || "Untitled",
        type: node.type,
        severity: node.metadata.severity,
        detail: "Missing background summary",
        token_count: node.metadata.token_count,
      });
    }
  }

  const penalty =
    unresolvedLoopholes.length * 8 +
    staleAiNodes.length * 5 +
    orphanNodes.length * 4 +
    unsummarizedHeavyNodes.length * 3;
  const healthScore = Math.max(0, Math.min(100, 100 - penalty));

  return {
    health_score: healthScore,
    node_count: nodesMap.size,
    edge_count: edgesMap.size,
    total_tokens: totalTokens,
    pin_count: pinCount,
    excluded_count: excludedCount,
    unresolved_loopholes: unresolvedLoopholes,
    stale_ai_nodes: staleAiNodes,
    cycles: [],
    orphan_nodes: orphanNodes,
    unsummarized_heavy_nodes: unsummarizedHeavyNodes,
  };
}

function jumpToNode(nodeId: string): void {
  selectSingle(nodeId);
  const ctrl = cameraControllerRef.current;
  const node = nodesMap.get(nodeId);
  if (ctrl && node) {
    const cx = node.layout.x + node.layout.width / 2;
    const cy = node.layout.y + getEffectiveNodeHeight(node) / 2;
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
  closeDiagnosticsModal();
}

export function DiagnosticsModal() {
  const isOpen = diagnosticsModalOpen.value;
  const desktopRuntime = isTauriRuntime();
  const modalRef = useRef<HTMLDivElement | null>(null);
  useDialogFocusTrap(isOpen, modalRef);

  const [diagnostics, setDiagnostics] = useState<GraphDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [queuingSummaries, setQueuingSummaries] = useState(false);
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);

  const loadDiagnostics = useCallback(async (): Promise<void> => {
    if (!isTauriRuntime()) {
      setDiagnostics(computeBrowserPreviewDiagnostics());
      setLoading(false);
      setErrorMsg(null);
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    try {
      const result = await getGraphDiagnostics();
      setDiagnostics(result);
    } catch (err) {
      setErrorMsg(parseIpcError(err).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeDiagnosticsModal();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    void loadDiagnostics();
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isOpen, loadDiagnostics]);

  if (!isOpen) {
    return null;
  }

  const handleMarkFresh = async (nodeId: string): Promise<void> => {
    setAcknowledgingId(nodeId);
    try {
      await acknowledgeAndRefreshStaleNode(nodeId);
      await loadDiagnostics();
    } catch (err) {
      pushToast(parseIpcError(err).message, "error");
    } finally {
      setAcknowledgingId((curr) => (curr === nodeId ? null : curr));
    }
  };

  const handleQueueSummaries = async (): Promise<void> => {
    if (!isTauriRuntime()) {
      pushToast("Background summary queue requires the Axiom desktop runtime", "info");
      return;
    }
    setQueuingSummaries(true);
    try {
      const queued = await enqueueStaleSummaries();
      pushToast(
        queued > 0
          ? `Queued ${queued} background summaries`
          : "All heavy nodes already have summaries queued",
        "info",
      );
      await loadDiagnostics();
    } catch (err) {
      pushToast(parseIpcError(err).message, "error");
    } finally {
      setQueuingSummaries(false);
    }
  };

  return (
    <div
      class="settings-modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          closeDiagnosticsModal();
        }
      }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        class="settings-modal artifact-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Graph Health Diagnostics"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <header class="settings-modal__header">
          <h2 class="settings-modal__title">Graph Health Diagnostics</h2>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              class="settings-btn settings-btn--secondary"
              disabled={loading}
              onClick={() => void loadDiagnostics()}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            <button
              type="button"
              class="settings-btn settings-btn--secondary settings-modal__close"
              onClick={() => closeDiagnosticsModal()}
            >
              Close (Esc)
            </button>
          </div>
        </header>

        <div class="settings-modal__body">
          {!desktopRuntime && (
            <p class="settings-preview-banner" role="note">
              Browser preview mode: counts are local estimates. Checks dependencies, cycles, and
              open risks in the Axiom desktop app.
            </p>
          )}

          {errorMsg && (
            <p class="settings-test-result settings-test-result--err" role="alert">
              {errorMsg}
            </p>
          )}

          {loading && !diagnostics ? (
            <p class="artifact-modal__status" role="status">
              Analyzing graph health...
            </p>
          ) : diagnostics ? (
            <>
              <section class="settings-section">
                <div class="settings-section__header">
                  <h3 class="settings-section__title">
                    Health Score: {diagnostics.health_score} / 100
                  </h3>
                </div>
                <div class="artifact-modal__stats">
                  <span>
                    Nodes: {diagnostics.node_count} · Edges: {diagnostics.edge_count} · Tokens:{" "}
                    {diagnostics.total_tokens} · Pins: {diagnostics.pin_count} · Excluded:{" "}
                    {diagnostics.excluded_count}
                  </span>
                </div>
              </section>

              <section class="settings-section">
                <div class="settings-section__header">
                  <h3 class="settings-section__title">
                    Unresolved Loopholes ({diagnostics.unresolved_loopholes.length})
                  </h3>
                </div>
                {diagnostics.unresolved_loopholes.length === 0 ? (
                  <p class="related-popover__empty">No unresolved loopholes.</p>
                ) : (
                  <ul class="related-popover__list">
                    {diagnostics.unresolved_loopholes.map((item) => {
                      const sev = item.severity ?? "medium";
                      return (
                        <li key={item.node_id} class="related-popover__item">
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: "8px",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <span class={`badge badge--sev-${sev}`}>{sev}</span>
                              <strong>{item.title || "Untitled"}</strong>
                            </div>
                            <button
                              type="button"
                              class="settings-btn settings-btn--secondary"
                              onClick={() => jumpToNode(item.node_id)}
                            >
                              Jump
                            </button>
                          </div>
                          {item.detail && <span class="settings-field__label">{item.detail}</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section class="settings-section">
                <div class="settings-section__header">
                  <h3 class="settings-section__title">
                    Stale AI Decisions ({diagnostics.stale_ai_nodes.length})
                  </h3>
                </div>
                {diagnostics.stale_ai_nodes.length === 0 ? (
                  <p class="related-popover__empty">All AI decisions are up to date.</p>
                ) : (
                  <ul class="related-popover__list">
                    {diagnostics.stale_ai_nodes.map((item) => (
                      <li key={item.node_id} class="related-popover__item">
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "8px",
                          }}
                        >
                          <strong>{item.title || "Untitled"}</strong>
                          <div style={{ display: "flex", gap: "6px" }}>
                            <button
                              type="button"
                              class="settings-btn settings-btn--secondary"
                              onClick={() => jumpToNode(item.node_id)}
                            >
                              Jump
                            </button>
                            <button
                              type="button"
                              class="settings-btn settings-btn--secondary"
                              disabled={acknowledgingId === item.node_id}
                              onClick={() => void handleMarkFresh(item.node_id)}
                            >
                              {acknowledgingId === item.node_id ? "Marking..." : "Mark Fresh"}
                            </button>
                          </div>
                        </div>
                        {item.detail && <span class="settings-field__label">{item.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section class="settings-section">
                <div class="settings-section__header">
                  <h3 class="settings-section__title">
                    Dependency Cycles ({diagnostics.cycles.length})
                  </h3>
                </div>
                {diagnostics.cycles.length === 0 ? (
                  <p class="related-popover__empty">
                    {desktopRuntime
                      ? "No dependency cycles detected."
                      : "Cycle detection requires the Axiom desktop runtime."}
                  </p>
                ) : (
                  <ul class="related-popover__list">
                    {diagnostics.cycles.map((cycle, idx) => {
                      const firstId = cycle.node_ids[0];
                      return (
                        <li key={`${cycle.node_ids.join("-")}-${idx}`} class="related-popover__item">
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: "8px",
                            }}
                          >
                            <span>{cycle.titles.join(" → ")}</span>
                            {firstId && (
                              <button
                                type="button"
                                class="settings-btn settings-btn--secondary"
                                onClick={() => jumpToNode(firstId)}
                              >
                                Jump
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section class="settings-section">
                <div class="settings-section__header">
                  <h3 class="settings-section__title">
                    Disconnected Orphans ({diagnostics.orphan_nodes.length})
                  </h3>
                </div>
                {diagnostics.orphan_nodes.length === 0 ? (
                  <p class="related-popover__empty">No disconnected orphan nodes.</p>
                ) : (
                  <ul class="related-popover__list">
                    {diagnostics.orphan_nodes.map((item) => (
                      <li key={item.node_id} class="related-popover__item">
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "8px",
                          }}
                        >
                          <div>
                            <strong>{item.title || "Untitled"}</strong>
                            {item.detail && (
                              <div class="settings-field__label">{item.detail}</div>
                            )}
                          </div>
                          <button
                            type="button"
                            class="settings-btn settings-btn--secondary"
                            onClick={() => jumpToNode(item.node_id)}
                          >
                            Jump
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section class="settings-section">
                <div class="settings-section__header">
                  <h3 class="settings-section__title">
                    Heavy Unsummarized Nodes ({diagnostics.unsummarized_heavy_nodes.length})
                  </h3>
                  <button
                    type="button"
                    class="settings-btn settings-btn--secondary"
                    disabled={
                      !desktopRuntime ||
                      queuingSummaries ||
                      diagnostics.unsummarized_heavy_nodes.length === 0
                    }
                    onClick={() => void handleQueueSummaries()}
                  >
                    {queuingSummaries ? "Queuing..." : "Queue Summaries"}
                  </button>
                </div>
                {diagnostics.unsummarized_heavy_nodes.length === 0 ? (
                  <p class="related-popover__empty">No heavy unsummarized nodes.</p>
                ) : (
                  <ul class="related-popover__list">
                    {diagnostics.unsummarized_heavy_nodes.map((item) => (
                      <li key={item.node_id} class="related-popover__item">
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "8px",
                          }}
                        >
                          <div>
                            <strong>{item.title || "Untitled"}</strong>
                            <div class="settings-field__label">{item.token_count} tokens</div>
                          </div>
                          <button
                            type="button"
                            class="settings-btn settings-btn--secondary"
                            onClick={() => jumpToNode(item.node_id)}
                          >
                            Jump
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

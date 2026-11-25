import { useCallback, useEffect, useState } from "preact/hooks";
import { clampZoom } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import {
  createCheckpoint,
  deleteCheckpoint,
  diffCheckpoint,
  getExternalRefStatuses,
  isTauriRuntime,
  listCheckpoints,
  parseIpcError,
  restoreCheckpoint,
} from "../ipc/client";
import type {
  CheckpointDiff,
  CheckpointNodeChange,
  CheckpointSummary,
  ExternalRefInfo,
} from "../ipc/types";
import {
  cameraControllerRef,
  loadSnapshot,
  nodesMap,
  refreshStaleNodes,
} from "../store/graphStore";
import { graphHistory, syncHistorySignals } from "../store/history";
import {
  checkpointsModalOpen,
  closeCheckpointsModal,
  externalRefsMap,
  selectSingle,
} from "../store/selection";
import { pushToast } from "./ToastStack";

function formatCheckpointDate(tsRaw: number): string {
  const tsMs = tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
  const diffSec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
  let relative = "just now";
  if (diffSec >= 86400) {
    const days = Math.floor(diffSec / 86400);
    relative = `${days}d ago`;
  } else if (diffSec >= 3600) {
    const hrs = Math.floor(diffSec / 3600);
    relative = `${hrs}h ago`;
  } else if (diffSec >= 60) {
    const mins = Math.floor(diffSec / 60);
    relative = `${mins}m ago`;
  }
  const local = new Date(tsMs).toLocaleString();
  return `${relative} · ${local}`;
}

async function refreshExternalRefsLocal(): Promise<void> {
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
  closeCheckpointsModal();
}

function renderDiffSection(
  heading: string,
  items: CheckpointNodeChange[],
  allowJump: boolean,
) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <h4 class="settings-section__title" style={{ margin: 0 }}>
        {heading} ({items.length})
      </h4>
      <ul class="related-popover__list">
        {items.map((item) => (
          <li key={item.node_id} class="related-popover__item">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <span class="badge">{item.type}</span>
                <strong>{item.title || "Untitled"}</strong>
                {item.changes.map((chip) => (
                  <span key={`${item.node_id}:${chip}`} class="badge">
                    {chip}
                  </span>
                ))}
              </div>
              {allowJump && (
                <button
                  type="button"
                  class="settings-btn settings-btn--secondary"
                  onClick={() => jumpToNode(item.node_id)}
                >
                  Jump
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CheckpointsModal() {
  const isOpen = checkpointsModalOpen.value;
  const desktopRuntime = isTauriRuntime();

  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activeDiff, setActiveDiff] = useState<CheckpointDiff | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadCheckpoints = useCallback(async (): Promise<void> => {
    if (!isTauriRuntime()) {
      setCheckpoints([]);
      setLoading(false);
      setErrorMsg(null);
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    try {
      const list = await listCheckpoints();
      setCheckpoints(list);
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
    setActiveDiff(null);
    setErrorMsg(null);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeCheckpointsModal();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    void loadCheckpoints();
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isOpen, loadCheckpoints]);

  if (!isOpen) {
    return null;
  }

  const handleSaveCheckpoint = async (e: Event): Promise<void> => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    if (!isTauriRuntime()) {
      pushToast("Checkpoints require the Axiom desktop runtime", "info");
      return;
    }
    setSaving(true);
    setErrorMsg(null);
    try {
      const created = await createCheckpoint(trimmedName, note.trim());
      setName("");
      setNote("");
      setCheckpoints((prev) => [created, ...prev.filter((c) => c.id !== created.id)]);
      pushToast(`Saved checkpoint "${created.name}"`, "info");
    } catch (err) {
      setErrorMsg(parseIpcError(err).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDiff = async (cp: CheckpointSummary): Promise<void> => {
    if (!isTauriRuntime()) {
      return;
    }
    setBusyId(cp.id);
    setErrorMsg(null);
    try {
      const diff = await diffCheckpoint(cp.id);
      setActiveDiff(diff);
    } catch (err) {
      setErrorMsg(parseIpcError(err).message);
    } finally {
      setBusyId((curr) => (curr === cp.id ? null : curr));
    }
  };

  const handleRestore = async (cp: CheckpointSummary): Promise<void> => {
    if (!isTauriRuntime()) {
      return;
    }
    setBusyId(cp.id);
    setErrorMsg(null);
    try {
      const restored = await restoreCheckpoint(cp.id);
      loadSnapshot(restored);
      graphHistory.clear();
      syncHistorySignals();
      await Promise.all([refreshStaleNodes(), refreshExternalRefsLocal()]);
      closeCheckpointsModal();
      pushToast(`Restored checkpoint "${cp.name}"`, "info");
    } catch (err) {
      setErrorMsg(parseIpcError(err).message);
    } finally {
      setBusyId((curr) => (curr === cp.id ? null : curr));
    }
  };

  const handleDelete = async (cp: CheckpointSummary): Promise<void> => {
    if (!isTauriRuntime()) {
      return;
    }
    setBusyId(cp.id);
    setErrorMsg(null);
    try {
      await deleteCheckpoint(cp.id);
      setCheckpoints((prev) => prev.filter((item) => item.id !== cp.id));
      setActiveDiff((curr) => (curr?.checkpoint_id === cp.id ? null : curr));
      pushToast(`Deleted checkpoint "${cp.name}"`, "info");
    } catch (err) {
      setErrorMsg(parseIpcError(err).message);
    } finally {
      setBusyId((curr) => (curr === cp.id ? null : curr));
    }
  };

  return (
    <div
      class="settings-modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          closeCheckpointsModal();
        }
      }}
    >
      <div
        class="settings-modal artifact-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Checkpoints & Graph Diff"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <header class="settings-modal__header">
          <h2 class="settings-modal__title">Checkpoints &amp; Graph Diff</h2>
          <button
            type="button"
            class="settings-btn settings-btn--secondary"
            onClick={() => closeCheckpointsModal()}
          >
            Close (Esc)
          </button>
        </header>

        <div class="settings-modal__body">
          {!desktopRuntime && (
            <p class="settings-preview-banner" role="note">
              Browser preview mode: graph checkpoints, structural diffs, and snapshot restore run in
              the Axiom desktop runtime.
            </p>
          )}

          {errorMsg && (
            <p class="settings-test-result settings-test-result--err" role="alert">
              {errorMsg}
            </p>
          )}

          <section class="settings-section">
            <div class="settings-section__header">
              <h3 class="settings-section__title">Save Milestone</h3>
            </div>
            <form
              onSubmit={(e) => void handleSaveCheckpoint(e)}
              style={{ display: "flex", flexDirection: "column", gap: "8px" }}
            >
              <label class="settings-field">
                <span class="settings-field__label">Name</span>
                <input
                  type="text"
                  class="settings-input"
                  placeholder="Milestone name (e.g. Before Raft refactor)"
                  value={name}
                  disabled={!desktopRuntime || saving}
                  onInput={(e) => setName(e.currentTarget.value)}
                />
              </label>
              <label class="settings-field">
                <span class="settings-field__label">Note</span>
                <input
                  type="text"
                  class="settings-input"
                  placeholder="Optional note"
                  value={note}
                  disabled={!desktopRuntime || saving}
                  onInput={(e) => setNote(e.currentTarget.value)}
                />
              </label>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="submit"
                  class="settings-btn settings-btn--primary"
                  disabled={!desktopRuntime || saving || name.trim().length === 0}
                >
                  {saving ? "Saving..." : "Save Checkpoint"}
                </button>
              </div>
            </form>
          </section>

          <section class="settings-section">
            <div class="settings-section__header">
              <h3 class="settings-section__title">Saved Checkpoints ({checkpoints.length})</h3>
            </div>
            {loading ? (
              <p class="artifact-modal__status" role="status">
                Loading checkpoints...
              </p>
            ) : checkpoints.length === 0 ? (
              <p class="related-popover__empty">
                {desktopRuntime
                  ? "No checkpoints saved yet."
                  : "Checkpoints are available in the Axiom desktop runtime."}
              </p>
            ) : (
              <ul class="related-popover__list">
                {checkpoints.map((cp) => {
                  const isBusy = busyId === cp.id;
                  return (
                    <li key={cp.id} class="related-popover__item">
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          flexWrap: "wrap",
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                          <strong>{cp.name}</strong>
                          {cp.note && <span class="settings-field__label">{cp.note}</span>}
                          <span class="artifact-modal__stats">
                            {cp.node_count} nodes · {cp.edge_count} edges ·{" "}
                            {formatCheckpointDate(cp.created_at)}
                          </span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <button
                            type="button"
                            class="settings-btn settings-btn--secondary"
                            disabled={isBusy}
                            onClick={() => void handleDiff(cp)}
                          >
                            Diff
                          </button>
                          <button
                            type="button"
                            class="settings-btn settings-btn--primary"
                            disabled={isBusy}
                            onClick={() => void handleRestore(cp)}
                          >
                            Restore
                          </button>
                          <button
                            type="button"
                            class="settings-btn settings-btn--secondary"
                            disabled={isBusy}
                            onClick={() => void handleDelete(cp)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {activeDiff && (
            <section class="settings-section" aria-label="Checkpoint Diff">
              <div class="settings-section__header">
                <h3 class="settings-section__title">
                  Diff vs. {activeDiff.checkpoint_name}
                </h3>
                <button
                  type="button"
                  class="settings-btn settings-btn--secondary"
                  onClick={() => setActiveDiff(null)}
                >
                  Clear Diff
                </button>
              </div>
              <div
                class="artifact-modal__stats"
                style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}
              >
                <span class="badge">+{activeDiff.added_nodes.length} added</span>
                <span class="badge">-{activeDiff.removed_nodes.length} removed</span>
                <span class="badge">~{activeDiff.modified_nodes.length} modified</span>
                <span class="badge">
                  Edges +{activeDiff.added_edges_count} / -{activeDiff.removed_edges_count}
                </span>
              </div>

              {activeDiff.added_nodes.length === 0 &&
              activeDiff.removed_nodes.length === 0 &&
              activeDiff.modified_nodes.length === 0 &&
              activeDiff.added_edges_count === 0 &&
              activeDiff.removed_edges_count === 0 ? (
                <p class="related-popover__empty">Current graph matches this checkpoint.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {renderDiffSection("Added Nodes", activeDiff.added_nodes, true)}
                  {renderDiffSection("Modified Nodes", activeDiff.modified_nodes, true)}
                  {renderDiffSection("Removed Nodes", activeDiff.removed_nodes, false)}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

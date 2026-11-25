import { useEffect, useMemo, useState } from "preact/hooks";
import type { BBox } from "rbush";
import { computeFitTransform } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import { importMarkdownOutline, isTauriRuntime, parseIpcError } from "../ipc/client";
import type { GraphOp } from "../ipc/types";
import {
  cameraControllerRef,
  edgesMap,
  graphVersion,
  nodesMap,
  recomputeUnresolvedLoopholes,
  viewportSpatialIndex,
} from "../store/graphStore";
import { graphHistory, syncHistorySignals } from "../store/history";
import {
  closeOutlineImportModal,
  focusId,
  outlineImportModalOpen,
  selectSingle,
} from "../store/selection";
import { pushToast } from "./ToastStack";

function countAtxHeadings(markdown: string): number {
  const lines = markdown.split(/\r?\n/);
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  let count = 0;

  for (const line of lines) {
    const trimmedStart = line.trimStart();
    const fenceMatch = trimmedStart.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      const rest = fenceMatch[2] ?? "";
      const ch = marker[0] === "~" ? "~" : "`";
      if (fenceChar === null) {
        if (!(ch === "`" && rest.includes("`"))) {
          fenceChar = ch;
          fenceLen = marker.length;
        }
        continue;
      }
      if (ch === fenceChar && marker.length >= fenceLen && rest.trim() === "") {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }

    if (fenceChar === null && /^#{1,6}\s+\S/.test(trimmedStart)) {
      count += 1;
    }
  }

  return count;
}

export function OutlineImportModal() {
  const isOpen = outlineImportModalOpen.value;
  const currentFocusId = focusId.value;
  const focusedNode = currentFocusId ? nodesMap.get(currentFocusId) : undefined;
  const desktopRuntime = isTauriRuntime();

  const [markdown, setMarkdown] = useState("");
  const [attachToFocus, setAttachToFocus] = useState<boolean>(Boolean(currentFocusId));
  const [importing, setImporting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const headingCount = useMemo(() => countAtxHeadings(markdown), [markdown]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setAttachToFocus(Boolean(focusId.value));
    setErrorMsg(null);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeOutlineImportModal();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const handleBuildGraph = async (): Promise<void> => {
    if (markdown.trim().length === 0) {
      setErrorMsg("Paste a Markdown outline before building the graph.");
      return;
    }
    if (!isTauriRuntime()) {
      pushToast("Markdown outline import requires the Axiom desktop runtime", "info");
      return;
    }

    setImporting(true);
    setErrorMsg(null);
    try {
      const parentId = attachToFocus && currentFocusId ? currentFocusId : null;
      const result = await importMarkdownOutline(markdown, parentId);

      for (const node of result.created_nodes) {
        nodesMap.set(node.id, node);
        viewportSpatialIndex.upsert(node);
      }
      for (const edge of result.created_edges) {
        edgesMap.set(edge.id, edge);
      }

      recomputeUnresolvedLoopholes();
      graphVersion.value += 1;
      cameraControllerRef.current?.refreshCull();
      cameraControllerRef.current?.markDirty();

      const createdIds = result.created_nodes.map((n) => n.id);
      if (createdIds.length > 0) {
        const forward: GraphOp[] = [
          ...result.created_nodes.map((node): GraphOp => ({ op: "create_node", node })),
          ...result.created_edges.map((edge): GraphOp => ({ op: "create_edge", edge })),
        ];
        const inverse: GraphOp[] = [{ op: "delete_nodes", ids: createdIds }];
        graphHistory.push({
          label: "Import Markdown outline",
          forward,
          inverse,
        });
        syncHistorySignals();
      }

      if (result.root_id && nodesMap.has(result.root_id)) {
        selectSingle(result.root_id);
      } else if (createdIds[0]) {
        selectSingle(createdIds[0]);
      }

      const ctrl = cameraControllerRef.current;
      if (ctrl && result.created_nodes.length > 0) {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const node of result.created_nodes) {
          minX = Math.min(minX, node.layout.x);
          minY = Math.min(minY, node.layout.y);
          maxX = Math.max(maxX, node.layout.x + node.layout.width);
          maxY = Math.max(maxY, node.layout.y + getEffectiveNodeHeight(node));
        }
        if (Number.isFinite(minX)) {
          const vp = ctrl.getViewportSize();
          const bounds: BBox = { minX, minY, maxX, maxY };
          ctrl.animateTo(computeFitTransform(bounds, vp.width, vp.height, 80), 220);
        }
      }

      closeOutlineImportModal();
      setMarkdown("");
      pushToast(`Imported ${result.created_nodes.length} cards`, "info");
    } catch (err) {
      setErrorMsg(parseIpcError(err).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div
      class="settings-modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          closeOutlineImportModal();
        }
      }}
    >
      <div
        class="settings-modal artifact-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Import Markdown Outline"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <header class="settings-modal__header">
          <h2 class="settings-modal__title">Import Markdown Outline</h2>
          <button
            type="button"
            class="settings-btn settings-btn--secondary"
            onClick={() => closeOutlineImportModal()}
          >
            Close (Esc)
          </button>
        </header>

        <div class="settings-modal__body">
          {!desktopRuntime && (
            <p class="settings-preview-banner" role="note">
              Browser preview mode: the Rust Markdown outline parser runs in the Axiom desktop
              runtime.
            </p>
          )}

          <label class="settings-field settings-field--wide">
            <span class="settings-field__label">
              Paste Markdown outline (#, ##, ###, Risk:, Option:, Question:, Decision:)
            </span>
            <textarea
              class="settings-textarea"
              rows={10}
              placeholder={
                "# System Architecture\n## API Gateway\nOption: Envoy edge proxy\nRisk: Single point of failure\n### Auth Service\nQuestion: Token revocation latency?\nDecision: Short-lived JWT + Redis blacklist"
              }
              value={markdown}
              onInput={(e) => {
                setMarkdown(e.currentTarget.value);
                if (errorMsg) {
                  setErrorMsg(null);
                }
              }}
            />
          </label>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <label class="settings-checkbox">
              <input
                type="checkbox"
                checked={attachToFocus && Boolean(currentFocusId)}
                disabled={!currentFocusId}
                onChange={(e) => setAttachToFocus(e.currentTarget.checked)}
              />
              <span>
                {currentFocusId
                  ? `Attach under focused node (${focusedNode?.title || "Untitled"})`
                  : "Attach under focused node (no node focused)"}
              </span>
            </label>
            <span class="artifact-modal__stats">
              {headingCount} {headingCount === 1 ? "heading" : "headings"} detected
            </span>
          </div>

          {errorMsg && (
            <p class="settings-test-result settings-test-result--err" role="alert">
              {errorMsg}
            </p>
          )}
        </div>

        <footer class="settings-modal__footer">
          <button
            type="button"
            class="settings-btn settings-btn--secondary"
            onClick={() => closeOutlineImportModal()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="settings-btn settings-btn--primary"
            disabled={!desktopRuntime || importing || markdown.trim().length === 0}
            onClick={() => void handleBuildGraph()}
          >
            {importing ? "Building..." : "Build Graph"}
          </button>
        </footer>
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  ACTION_TAGS,
  customLensesSignal,
  extractActionTagFromContent,
  getAllActionTags,
  type ActionTagDef,
} from "../input/actionTags";
import { isTauriRuntime, tidySubtree as tidySubtreeIpc } from "../ipc/client";
import type { GraphOp, NodeDto, NodePositionUpdate, NodeType, Severity } from "../ipc/types";
import { executeActionTag, shouldRunTagInPlace } from "../store/aiRunner";
import {
  acknowledgeAndRefreshStaleNode,
  applyTidyPositions,
  duplicateNode,
  edgesMap,
  graphVersion,
  mutateGraphUndoable,
  nodesMap,
  spawnChild,
} from "../store/graphStore";
import {
  buildDeleteWithInverse,
  buildMoveNodesWithInverse,
  buildUpdateMetaWithInverse,
  graphHistory,
  type NodeMetaPatch,
  syncHistorySignals,
} from "../store/history";
import {
  closeNodeContextMenu,
  enterEditMode,
  externalRefsMap,
  nodeContextMenu,
  openArtifactExport,
  openOutlineImportModal,
  relatedPopoverNodeId,
  selectedIds,
  selectSingle,
  spotlightRootId,
  staleNodesMap,
  toggleSpotlight,
} from "../store/selection";
import { notifyIpcError, pushToast } from "./ToastStack";

const VIEWPORT_PADDING_PX = 8;

const TYPE_OPTIONS: ReadonlyArray<{ value: NodeType; label: string }> = [
  { value: "core", label: "Core" },
  { value: "branch", label: "Branch" },
  { value: "loophole", label: "Loophole" },
  { value: "probe", label: "Probe" },
  { value: "synthesis", label: "Synthesis" },
];

const SEVERITY_OPTIONS: ReadonlyArray<{ value: Severity; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

function getMenuButtons(container: HTMLElement | null): HTMLButtonElement[] {
  if (!container) {
    return [];
  }
  const buttons = container.querySelectorAll<HTMLButtonElement>(
    'button[role="menuitem"]:not(:disabled)',
  );
  return Array.from(buttons);
}

export function NodeContextMenu() {
  const menuState = nodeContextMenu.value;
  // Subscribe to graphVersion & customLensesSignal so labels/custom tags stay live.
  void graphVersion.value;
  void customLensesSignal.value;

  const customTags = getAllActionTags().filter(
    (def) => def.kind === "lens" && def.customLens !== undefined,
  );

  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number }>({
    left: menuState?.x ?? 0,
    top: menuState?.y ?? 0,
  });

  const node: NodeDto | undefined = menuState ? nodesMap.get(menuState.nodeId) : undefined;

  useLayoutEffect(() => {
    if (!menuState || !node) {
      return;
    }
    const el = menuRef.current;
    if (!el) {
      setCoords({ left: menuState.x, top: menuState.y });
      return;
    }

    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(
      VIEWPORT_PADDING_PX,
      window.innerWidth - rect.width - VIEWPORT_PADDING_PX,
    );
    const maxTop = Math.max(
      VIEWPORT_PADDING_PX,
      window.innerHeight - rect.height - VIEWPORT_PADDING_PX,
    );
    const clampedLeft = Math.min(Math.max(VIEWPORT_PADDING_PX, menuState.x), maxLeft);
    const clampedTop = Math.min(Math.max(VIEWPORT_PADDING_PX, menuState.y), maxTop);
    setCoords({ left: clampedLeft, top: clampedTop });

    const items = getMenuButtons(el);
    items[0]?.focus();
  }, [menuState?.nodeId, menuState?.x, menuState?.y, Boolean(node)]);

  useEffect(() => {
    if (!menuState || !node) {
      return;
    }

    const handleOutsidePointerDown = (e: PointerEvent): void => {
      const el = menuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) {
        return;
      }
      closeNodeContextMenu();
    };

    const handleWindowKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeNodeContextMenu();
      }
    };

    window.addEventListener("pointerdown", handleOutsidePointerDown, { capture: true });
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handleOutsidePointerDown, { capture: true });
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [menuState, Boolean(node)]);

  if (!menuState || !node) {
    return null;
  }

  const handleMenuKeyDown = (e: KeyboardEvent): void => {
    const items = getMenuButtons(menuRef.current);
    if (items.length === 0) {
      return;
    }
    const active = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    const currentIndex = active ? items.indexOf(active) : -1;

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        e.stopPropagation();
        const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
        items[nextIndex]?.focus();
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        e.stopPropagation();
        const prevIndex =
          currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
        items[prevIndex]?.focus();
        break;
      }
      case "Home": {
        e.preventDefault();
        e.stopPropagation();
        items[0]?.focus();
        break;
      }
      case "End": {
        e.preventDefault();
        e.stopPropagation();
        items[items.length - 1]?.focus();
        break;
      }
      case "Escape": {
        e.preventDefault();
        e.stopPropagation();
        closeNodeContextMenu();
        break;
      }
    }
  };

  const selectedSet = selectedIds.value;
  const isBulk = selectedSet.size >= 2 && selectedSet.has(node.id);
  const targetNodes: NodeDto[] = isBulk
    ? Array.from(selectedSet)
        .map((id) => nodesMap.get(id))
        .filter((n): n is NodeDto => n !== undefined)
    : [node];
  const bulkCount = targetNodes.length;
  const isBulkActive = isBulk && bulkCount >= 2;
  const allPinned = targetNodes.every((n) => n.context_controls.pin_global);
  const allExcluded = targetNodes.every((n) => n.context_controls.exclude_from_ai);
  const allCollapsed = targetNodes.every((n) => n.layout.collapsed);

  const applyMeta = (label: string, patch: NodeMetaPatch, targets: NodeDto[] = [node]): void => {
    closeNodeContextMenu();
    const forward: GraphOp[] = [];
    const inverse: GraphOp[] = [];
    for (const target of targets) {
      const entry = buildUpdateMetaWithInverse(target, patch);
      forward.push(...entry.forward);
      inverse.push(...entry.inverse);
    }
    if (forward.length > 0) {
      void mutateGraphUndoable(label, forward, inverse).catch(notifyIpcError);
    }
  };

  const handleEdit = (): void => {
    closeNodeContextMenu();
    enterEditMode(node);
  };

  const handleCopyText = (): void => {
    closeNodeContextMenu();
    const text = node.content.trim().length > 0 ? `${node.title}\n\n${node.content}` : node.title;
    if (!navigator.clipboard?.writeText) {
      pushToast("Clipboard API unavailable in this environment", "warning");
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        pushToast("Copied node text", "info");
      })
      .catch(() => {
        pushToast("Could not copy node text to clipboard", "warning");
      });
  };

  const handleDuplicate = (): void => {
    closeNodeContextMenu();
    void duplicateNode(node.id).catch(notifyIpcError);
  };

  const handleAddChild = (): void => {
    closeNodeContextMenu();
    const edgeType = node.type === "loophole" ? "resolves" : "derives";
    void spawnChild(node.id, edgeType, "core", undefined, true)
      .then(({ node: created }) => {
        enterEditMode(created);
      })
      .catch(notifyIpcError);
  };

  const handleTidySubtree = (): void => {
    closeNodeContextMenu();
    if (!isTauriRuntime()) {
      pushToast("Tidy subtree runs via Rust R-tree in desktop runtime", "info");
      return;
    }
    const prevMap = new Map<string, NodePositionUpdate>();
    for (const [id, n] of nodesMap.entries()) {
      prevMap.set(id, { id, x: n.layout.x, y: n.layout.y });
    }
    void tidySubtreeIpc(node.id)
      .then((updates) => {
        if (updates.length === 0) {
          return;
        }
        const prevMoves: NodePositionUpdate[] = [];
        for (const u of updates) {
          const prev = prevMap.get(u.id);
          if (prev) {
            prevMoves.push(prev);
          }
        }
        applyTidyPositions(updates);
        const { forward, inverse } = buildMoveNodesWithInverse(prevMoves, updates);
        graphHistory.push({ label: "Tidy subtree", forward, inverse });
        syncHistorySignals();
      })
      .catch(notifyIpcError);
  };

  const handleActionTag = (def: ActionTagDef): void => {
    closeNodeContextMenu();
    const keepMultiSelection =
      def.kind === "lens" &&
      def.lens === "synthesize" &&
      selectedIds.value.size >= 2 &&
      selectedIds.value.has(node.id);
    if (!keepMultiSelection) {
      selectSingle(node.id);
    }
    const extracted =
      node.content.includes("@") ? extractActionTagFromContent(node.content) : null;
    const matchingArg =
      extracted && extracted.action.tag === def.tag ? extracted.argument : undefined;
    const inPlace = shouldRunTagInPlace(def, matchingArg, node);
    void executeActionTag(def, matchingArg, { inPlace });
  };

  const handleDelete = (): void => {
    closeNodeContextMenu();
    const deleteIds = targetNodes.map((n) => n.id);
    const { forward, inverse } = buildDeleteWithInverse(deleteIds, nodesMap, edgesMap);
    if (forward.length > 0) {
      void mutateGraphUndoable(
        isBulkActive ? `Delete ${bulkCount} nodes` : "Delete node",
        forward,
        inverse,
      ).catch(notifyIpcError);
    }
  };

  const handleExportSubgraph = (): void => {
    closeNodeContextMenu();
    openArtifactExport("adr", "subgraph");
  };

  const handleFindRelated = (): void => {
    closeNodeContextMenu();
    relatedPopoverNodeId.value = node.id;
  };

  const handleImportOutlineHere = (): void => {
    closeNodeContextMenu();
    selectSingle(node.id);
    openOutlineImportModal();
  };

  const staleInfo = staleNodesMap.value.get(node.id);
  const extRefInfo = externalRefsMap.value.get(node.id);
  const isSpotlightRoot = spotlightRootId.value === node.id;

  const handleToggleSpotlight = (): void => {
    closeNodeContextMenu();
    toggleSpotlight(node.id);
  };

  const handleSyncExtRef = (): void => {
    closeNodeContextMenu();
    window.dispatchEvent(
      new CustomEvent("axiom:sync-extref", {
        detail: { nodeId: node.id },
      }),
    );
  };

  const handleOpenSourceFlow = (): void => {
    closeNodeContextMenu();
    if (!extRefInfo) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent("axiom:open-extref", {
        detail: {
          nodeId: node.id,
          sourceWorkspaceId: extRefInfo.source_workspace_id,
          sourceFlowId: extRefInfo.source_flow_id,
          sourceNodeId: extRefInfo.source_node_id,
        },
      }),
    );
  };

  const handleDetachExtRef = (): void => {
    closeNodeContextMenu();
    window.dispatchEvent(
      new CustomEvent("axiom:detach-extref", {
        detail: { nodeId: node.id },
      }),
    );
  };

  const handleMarkFresh = (): void => {
    closeNodeContextMenu();
    void acknowledgeAndRefreshStaleNode(node.id).catch(notifyIpcError);
  };

  const handleRerunStale = (): void => {
    closeNodeContextMenu();
    if (!staleInfo) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent("axiom:rerun-stale", {
        detail: { nodeId: node.id, lens: staleInfo.lens },
      }),
    );
  };

  return (
    <div
      ref={menuRef}
      class="node-context-menu"
      role="menu"
      aria-label="Node actions"
      style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
      onKeyDown={handleMenuKeyDown}
    >
      <div class="node-context-menu__group">
        <button type="button" role="menuitem" class="node-context-menu__item" onClick={handleEdit}>
          <span>Edit</span>
          <kbd>Enter</kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={handleCopyText}
        >
          <span>Copy Text</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={handleDuplicate}
        >
          <span>Duplicate</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={handleAddChild}
        >
          <span>Add Child</span>
          <kbd>Tab</kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={handleExportSubgraph}
        >
          <span>Export Subgraph…</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={handleFindRelated}
        >
          <span>Find Related Nodes</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={handleImportOutlineHere}
        >
          <span>Import Outline Here…</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={handleToggleSpotlight}
        >
          <span>{isSpotlightRoot ? "Exit Focus Spotlight" : "Focus Spotlight"}</span>
          <kbd>Shift+F</kbd>
        </button>
        {extRefInfo && (
          <>
            <button
              type="button"
              role="menuitem"
              class="node-context-menu__item"
              onClick={handleSyncExtRef}
            >
              <span>Pull Latest from Source</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="node-context-menu__item"
              onClick={handleOpenSourceFlow}
            >
              <span>Open Source Flow</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="node-context-menu__item"
              onClick={handleDetachExtRef}
            >
              <span>Detach External Link</span>
            </button>
          </>
        )}
        {staleInfo && (
          <>
            <button
              type="button"
              role="menuitem"
              class="node-context-menu__item"
              onClick={handleMarkFresh}
            >
              <span>Mark Fresh</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="node-context-menu__item"
              onClick={handleRerunStale}
            >
              <span>Re-run Stale Lens</span>
            </button>
          </>
        )}
      </div>

      <div class="node-context-menu__divider" role="separator" />

      <div class="node-context-menu__section">
        <span class="node-context-menu__section-label">Type</span>
        <div class="node-context-menu__chips" role="group" aria-label="Node type">
          {TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitem"
              class={`node-context-menu__chip ${
                node.type === opt.value ? "node-context-menu__chip--active" : ""
              }`}
              onClick={() =>
                applyMeta(
                  "Change node type",
                  opt.value === "loophole" && node.metadata.severity === null
                    ? { node_type: opt.value, severity: "medium" }
                    : { node_type: opt.value },
                  targetNodes,
                )
              }
            >
              {opt.label}
            </button>
          ))}
        </div>

        {node.type === "loophole" && (
          <>
            <span class="node-context-menu__section-label">Severity</span>
            <div class="node-context-menu__chips" role="group" aria-label="Loophole severity">
              {SEVERITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitem"
                  class={`node-context-menu__chip ${
                    node.metadata.severity === opt.value ? "node-context-menu__chip--active" : ""
                  }`}
                  onClick={() =>
                    applyMeta("Change loophole severity", { severity: opt.value }, targetNodes)
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div class="node-context-menu__divider" role="separator" />

      <div class="node-context-menu__group">
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={() =>
            applyMeta("Toggle pin", { pin_global: !allPinned }, targetNodes)
          }
        >
          <span>
            {isBulkActive
              ? allPinned
                ? `Unpin ${bulkCount} nodes`
                : `Pin ${bulkCount} nodes`
              : node.context_controls.pin_global
                ? "Unpin Global"
                : "Pin Global"}
          </span>
          <kbd>P</kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={() =>
            applyMeta("Toggle AI exclusion", { exclude_from_ai: !allExcluded }, targetNodes)
          }
        >
          <span>
            {isBulkActive
              ? allExcluded
                ? `Include ${bulkCount} nodes`
                : `Exclude ${bulkCount} nodes`
              : node.context_controls.exclude_from_ai
                ? "Include in AI"
                : "Exclude from AI"}
          </span>
          <kbd>X</kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={() =>
            applyMeta("Collapse node", { collapsed: !allCollapsed }, targetNodes)
          }
        >
          <span>
            {isBulkActive
              ? allCollapsed
                ? `Unfold ${bulkCount} nodes`
                : `Fold ${bulkCount} nodes`
              : node.layout.collapsed
                ? "Unfold"
                : "Fold"}
          </span>
          <kbd>C</kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={() =>
            applyMeta(
              "Toggle lock",
              { status: node.status === "locked" ? "active" : "locked" },
              targetNodes,
            )
          }
        >
          <span>{node.status === "locked" ? "Unlock" : "Lock"}</span>
          <kbd>Shift+R</kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item"
          onClick={handleTidySubtree}
        >
          <span>Tidy Subtree</span>
          <kbd>T</kbd>
        </button>
        {node.type === "loophole" && (
          <>
            <button
              type="button"
              role="menuitem"
              class="node-context-menu__item"
              onClick={() =>
                applyMeta("Toggle loophole resolved", {
                  status: node.status === "resolved" ? "active" : "resolved",
                })
              }
            >
              <span>{node.status === "resolved" ? "Reopen Loophole" : "Resolve Loophole"}</span>
              <kbd>R</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              class="node-context-menu__item"
              onClick={() =>
                applyMeta("Dismiss loophole", {
                  status: node.status === "dismissed" ? "active" : "dismissed",
                })
              }
            >
              <span>{node.status === "dismissed" ? "Restore Loophole" : "Dismiss Loophole"}</span>
            </button>
          </>
        )}
      </div>

      <div class="node-context-menu__divider" role="separator" />

      <div class="node-context-menu__group">
        {ACTION_TAGS.map((def) => (
          <button
            key={def.tag}
            type="button"
            role="menuitem"
            class="node-context-menu__item"
            onClick={() => handleActionTag(def)}
          >
            <span>{def.label}</span>
            <kbd>{def.tag}</kbd>
          </button>
        ))}
      </div>

      {customTags.length > 0 && (
        <>
          <div class="node-context-menu__divider" role="separator" />
          <div class="node-context-menu__section">
            <span class="node-context-menu__section-label">Custom Lenses</span>
            <div class="node-context-menu__group">
              {customTags.map((def) => (
                <button
                  key={def.kind === "lens" && def.customLens ? def.customLens.id : def.tag}
                  type="button"
                  role="menuitem"
                  class="node-context-menu__item"
                  onClick={() => handleActionTag(def)}
                >
                  <span>{def.label}</span>
                  <kbd>{def.tag}</kbd>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <div class="node-context-menu__divider" role="separator" />

      <div class="node-context-menu__group">
        <button
          type="button"
          role="menuitem"
          class="node-context-menu__item node-context-menu__item--danger"
          onClick={handleDelete}
        >
          <span>{isBulkActive ? `Delete ${bulkCount} nodes` : "Delete"}</span>
          <kbd>Del</kbd>
        </button>
      </div>
    </div>
  );
}

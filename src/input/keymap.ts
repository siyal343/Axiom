import type { BBox } from "rbush";
import {
  computeFitTransform,
  screenToWorld,
  worldToScreen,
  type CameraTransform,
} from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import { compileXray as compileXrayIpc, isTauriRuntime, tidySubtree as tidySubtreeIpc } from "../ipc/client";
import type {
  ApplyResult,
  CameraState,
  CompiledXray,
  EdgeDto,
  EdgeType,
  GraphOp,
  LensKind,
  NodeDto,
  NodePositionUpdate,
  NodeType,
  Severity,
} from "../ipc/types";
import { notifyIpcError, pushToast, type ToastVariant } from "../overlays/ToastStack";
import { buildBrowserFallbackXray } from "../overlays/XrayHud";
import {
  cancelActiveRun,
  closeCustomPromptBar,
  closeSettingsModal,
  dismissTriageBanner,
  openSettingsModal,
  startLoopholeTriage,
  triggerLens,
} from "../store/aiRunner";
import {
  applyTidyPositions,
  cameraControllerRef,
  connectNodesWithEdge,
  edgesMap,
  mutateGraphUndoable,
  nodesMap,
  performRedo,
  performUndo,
  spawnChild,
  tokenBudget,
  viewportSpatialIndex,
} from "../store/graphStore";
import {
  buildCreateNodeWithInverse,
  buildDeleteWithInverse,
  buildMoveNodesWithInverse,
  buildUpdateMetaWithInverse,
  graphHistory,
  syncHistorySignals,
} from "../store/history";
import {
  closeArtifactExport,
  closeCommandPalette,
  closeDiagnosticsModal,
  closeNodeContextMenu,
  closeOutlineImportModal,
  connectSourceId,
  diagnosticsModalOpen,
  edgePopover,
  enterEditMode,
  focusId,
  minimapOpen,
  modalState,
  openCommandPalette,
  openDiagnosticsModal,
  relatedPopoverNodeId,
  selectedEdgeId,
  selectedIds,
  selectSingle,
  setSelection,
  shortcutsHelpOpen,
  triggerLockedShake,
  xrayPinned,
  xrayState,
  type EdgePopoverState,
  type ModalState,
} from "../store/selection";
import { closeSidebar, toggleSidebar } from "../store/workspaceCatalogStore";
import {
  collectSubtreeIds,
  findFirstChildTarget,
  findParentTarget,
  findSiblingTarget,
} from "./topologyNav";

export interface KeymapDeps {
  getModalState: () => ModalState;
  setModalState: (m: ModalState) => void;
  getFocusId: () => string | null;
  getSelectedIds: () => ReadonlySet<string>;
  getNodes: () => Map<string, NodeDto>;
  getEdges: () => Map<string, EdgeDto>;
  selectSingle: (id: string | null) => void;
  setSelection: (ids: Iterable<string>, primaryId?: string | null) => void;
  enterEditMode: (node: NodeDto) => boolean;
  triggerLockedShake: (id: string) => void;
  setXray: (xray: CompiledXray | null) => void;
  compileXray: (focusIds: string[], budget?: number) => Promise<CompiledXray>;
  mutateUndoable: (label: string, forward: GraphOp[], inverse: GraphOp[]) => Promise<ApplyResult>;
  spawnChild: (
    parentId: string,
    edgeType: EdgeType,
    nodeType: NodeType,
    title?: string,
  ) => Promise<{ node: NodeDto; edge: EdgeDto }>;
  undo: () => Promise<ApplyResult | null>;
  redo: () => Promise<ApplyResult | null>;
  tidySubtree: (rootId: string) => Promise<NodePositionUpdate[]>;
  applyTidy?: (prevMoves: NodePositionUpdate[], nextMoves: NodePositionUpdate[]) => void;
  openCommandPalette: () => void;
  openSettings?: () => void;
  toggleSidebar?: () => void;
  zoomIn?: () => void;
  zoomOut?: () => void;
  resetZoom?: () => void;
  toggleShortcutsHelp?: () => void;
  toggleDiagnosticsModal?: () => void;
  closeOverlays: () => void;
  setConnectSourceId?: (id: string | null) => void;
  openEdgePopoverFor: (sourceId: string, targetId: string) => void;
  getEdgePopover?: () => EdgePopoverState | null;
  clearEdgePopover?: () => void;
  onSelectEdgePopoverType?: (edgeType: EdgeType) => void;
  isXrayPinned?: () => boolean;
  setXrayPinned?: (pinned: boolean) => void;
  toggleMinimap?: () => void;
  getSelectedEdgeId?: () => string | null;
  clearSelectedEdge?: () => void;
  onTriggerLens: (lens: LensKind) => void;
  onStartTriage?: () => boolean;
  onCancelActiveRun?: () => boolean;
  pushToast: (message: string, variant?: ToastVariant) => void;
  getCamera: () => CameraState;
  getViewportSize: () => { width: number; height: number };
  animateTo: (cam: CameraTransform, durationMs?: number) => void;
  findFreeViewportNodePos?: (centerX: number, centerY: number) => { x: number; y: number };
  chordTimeoutMs?: number;
  doubleTapFMs?: number;
}

export interface KeymapController {
  handleKeyDown: (e: KeyboardEvent) => void;
  handleKeyUp: (e: KeyboardEvent) => void;
  handleBlur: () => void;
  dispose: () => void;
}

function isModifierOnlyKey(key: string): boolean {
  return key === "Shift" || key === "Control" || key === "Alt" || key === "Meta";
}

function isInputLikeElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], .cm-editor"));
}

function isInteractiveButtonTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "BUTTON" ||
      target.closest(
        ".hover-pill, .edge-popover, .multi-select-pill, .canvas-controls, .node-context-menu, .workspace-sidebar, .sidebar-toggle-bar, .editor-tag-menu",
      ) !== null)
  );
}

export function createKeymapHandler(deps: KeymapDeps): KeymapController {
  const chordTimeoutMs = deps.chordTimeoutMs ?? 1500;
  const doubleTapFMs = deps.doubleTapFMs ?? 500;

  let chordTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFTimestamp = 0;
  let vHeld = false;
  let localConnectSource: string | null = null;

  const clearChordTimer = (): void => {
    if (chordTimer !== null) {
      clearTimeout(chordTimer);
      chordTimer = null;
    }
  };

  const resetToNavigate = (): void => {
    clearChordTimer();
    localConnectSource = null;
    deps.setConnectSourceId?.(null);
    deps.setModalState("navigate");
  };

  const getTargetIds = (): string[] => {
    const selected = deps.getSelectedIds();
    if (selected.size > 0) {
      return Array.from(selected);
    }
    const fid = deps.getFocusId();
    return fid !== null ? [fid] : [];
  };

  const ensureNodeVisible = (nodeId: string): void => {
    const node = deps.getNodes().get(nodeId);
    if (!node) {
      return;
    }
    const cam = deps.getCamera();
    const { width, height } = deps.getViewportSize();
    const tl = worldToScreen(node.layout.x, node.layout.y, cam);
    const br = worldToScreen(
      node.layout.x + node.layout.width,
      node.layout.y + getEffectiveNodeHeight(node),
      cam,
    );
    const margin = 80;
    if (tl.x < margin || tl.y < margin || br.x > width - margin || br.y > height - margin) {
      const cx = node.layout.x + node.layout.width / 2;
      const cy = node.layout.y + getEffectiveNodeHeight(node) / 2;
      deps.animateTo(
        {
          x: width / 2 - cx * cam.zoom,
          y: height / 2 - cy * cam.zoom,
          zoom: cam.zoom,
        },
        200,
      );
    }
  };

  const centerNodeWithAnimation = (nodeId: string): void => {
    const node = deps.getNodes().get(nodeId);
    if (!node) {
      return;
    }
    const cam = deps.getCamera();
    const { width, height } = deps.getViewportSize();
    const cx = node.layout.x + node.layout.width / 2;
    const cy = node.layout.y + getEffectiveNodeHeight(node) / 2;
    deps.animateTo(
      {
        x: width / 2 - cx * cam.zoom,
        y: height / 2 - cy * cam.zoom,
        zoom: cam.zoom,
      },
      200,
    );
  };

  const smartFitIds = (ids: string[]): void => {
    const nodes = deps.getNodes();
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const id of ids) {
      const node = nodes.get(id);
      if (!node) continue;
      minX = Math.min(minX, node.layout.x);
      minY = Math.min(minY, node.layout.y);
      maxX = Math.max(maxX, node.layout.x + node.layout.width);
      maxY = Math.max(maxY, node.layout.y + getEffectiveNodeHeight(node));
    }

    if (!Number.isFinite(minX)) {
      return;
    }
    const { width, height } = deps.getViewportSize();
    const bounds: BBox = { minX, minY, maxX, maxY };
    deps.animateTo(computeFitTransform(bounds, width, height, 80), 220);
  };

  const handleDirectionalNav = (key: string, shift: boolean): boolean => {
    const fid = deps.getFocusId();
    const nodes = deps.getNodes();
    const edges = deps.getEdges();

    if (!fid) {
      const firstId = nodes.keys().next().value ?? null;
      if (firstId !== null) {
        deps.selectSingle(firstId);
        ensureNodeVisible(firstId);
      }
      return true;
    }

    let nextId: string | null = null;
    if (key === "h" || key === "arrowleft") {
      nextId = findParentTarget(fid, nodes, edges);
    } else if (key === "l" || key === "arrowright") {
      nextId = findFirstChildTarget(fid, nodes, edges);
    } else if (key === "j" || key === "arrowdown") {
      nextId = findSiblingTarget(fid, 1, nodes, edges);
    } else if (key === "k" || key === "arrowup") {
      nextId = findSiblingTarget(fid, -1, nodes, edges);
    } else {
      return false;
    }

    if (nextId !== null) {
      if (shift && (key === "j" || key === "arrowdown" || key === "k" || key === "arrowup")) {
        const nextSet = new Set(deps.getSelectedIds());
        nextSet.add(fid);
        nextSet.add(nextId);
        deps.setSelection(nextSet, nextId);
      } else {
        deps.selectSingle(nextId);
      }
      ensureNodeVisible(nextId);
    }
    return true;
  };

  const handleKeyDown = (e: KeyboardEvent): void => {
    const mode = deps.getModalState();

    // Strict Modal Isolation: never hijack keys in Edit Mode.
    if (mode === "edit") {
      return;
    }

    if (mode === "command") {
      if (e.key === "Escape") {
        e.preventDefault();
        deps.closeOverlays();
      }
      return;
    }

    const activeEdgePop = deps.getEdgePopover?.() ?? null;
    if (
      activeEdgePop !== null &&
      mode !== "chord_a" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !isInputLikeElement(e.target)
    ) {
      const edgeTypeByKey: Record<string, EdgeType> = {
        "1": "derives",
        "2": "branches",
        "3": "challenges",
        "4": "resolves",
        "5": "synthesizes",
        "6": "references",
      };
      const chosenType = edgeTypeByKey[e.key];
      if (chosenType) {
        e.preventDefault();
        if (deps.onSelectEdgePopoverType) {
          deps.onSelectEdgePopoverType(chosenType);
        } else {
          const edge: EdgeDto = {
            id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            source_id: activeEdgePop.sourceId,
            target_id: activeEdgePop.targetId,
            type: chosenType,
            weight: "summary",
            created_at: Date.now(),
          };
          const inverse: GraphOp[] = [{ op: "delete_edge", id: edge.id }];
          if (chosenType === "resolves") {
            const target = deps.getNodes().get(activeEdgePop.targetId);
            if (target && target.type === "loophole" && target.status !== "resolved") {
              inverse.push({ op: "update_node_meta", id: target.id, status: target.status });
            }
          }
          deps.clearEdgePopover?.();
          deps.setModalState("navigate");
          void deps
            .mutateUndoable("Create edge", [{ op: "create_edge", edge }], inverse)
            .catch(notifyIpcError);
        }
        return;
      }
    }

    if (mode === "chord_a") {
      if (isModifierOnlyKey(e.key)) {
        return;
      }
      e.preventDefault();
      const lower = e.key.toLowerCase();
      if (lower === "r") {
        resetToNavigate();
        deps.onTriggerLens("red_team");
      } else if (lower === "e") {
        resetToNavigate();
        deps.onTriggerLens("edge_case");
      } else if (lower === "d") {
        resetToNavigate();
        deps.onTriggerLens("diverge");
      } else if (lower === "f") {
        resetToNavigate();
        deps.onTriggerLens("feynman");
      } else if (lower === "q") {
        resetToNavigate();
        deps.onTriggerLens("study");
      } else if (lower === "l") {
        resetToNavigate();
        deps.onTriggerLens("research");
      } else if (lower === "t") {
        resetToNavigate();
        deps.onStartTriage?.();
      } else if (lower === "s") {
        const count = deps.getSelectedIds().size;
        resetToNavigate();
        if (count >= 2) {
          deps.onTriggerLens("synthesize");
        } else {
          deps.pushToast("Select 2 or more nodes to synthesize (Shift+J/K)", "warning");
        }
      } else if (e.key === " ") {
        resetToNavigate();
        deps.onTriggerLens("custom");
      } else {
        resetToNavigate();
      }
      return;
    }

    if (mode === "connect_edge") {
      if (isInputLikeElement(e.target)) {
        return;
      }
      const lower = e.key.toLowerCase();
      if (e.key === "Escape" || lower === "e") {
        e.preventDefault();
        resetToNavigate();
        return;
      }
      if (e.key === "Enter") {
        if (isInteractiveButtonTarget(e.target)) {
          return;
        }
        e.preventDefault();
        const targetId = deps.getFocusId();
        if (localConnectSource && targetId && localConnectSource !== targetId) {
          const src = localConnectSource;
          localConnectSource = null;
          deps.setConnectSourceId?.(null);
          deps.openEdgePopoverFor(src, targetId);
        } else {
          deps.pushToast("Select a different target node first", "warning");
        }
        return;
      }
      if (
        lower === "h" ||
        lower === "j" ||
        lower === "k" ||
        lower === "l" ||
        lower === "arrowleft" ||
        lower === "arrowdown" ||
        lower === "arrowup" ||
        lower === "arrowright"
      ) {
        e.preventDefault();
        handleDirectionalNav(lower, false);
      }
      return;
    }

    // Navigate mode
    if (isInputLikeElement(e.target)) {
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    const lower = e.key.toLowerCase();

    if (mod && lower === "k") {
      e.preventDefault();
      deps.openCommandPalette();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && lower === "a") {
      e.preventDefault();
      const allIds = Array.from(deps.getNodes().keys());
      if (allIds.length > 0) {
        const currentFocus = deps.getFocusId();
        const primary =
          currentFocus !== null && deps.getNodes().has(currentFocus) ? currentFocus : allIds[0];
        deps.setSelection(allIds, primary);
      }
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && lower === "b") {
      e.preventDefault();
      deps.toggleSidebar?.();
      return;
    }
    if (mod && e.key === ",") {
      e.preventDefault();
      if (deps.openSettings) {
        deps.openSettings();
      } else {
        deps.pushToast("Settings modal unavailable", "info");
      }
      return;
    }
    if (mod && e.shiftKey && lower === "z") {
      e.preventDefault();
      void deps.redo().catch(notifyIpcError);
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && lower === "y") {
      e.preventDefault();
      void deps.redo().catch(notifyIpcError);
      return;
    }
    if (mod && !e.shiftKey && lower === "z") {
      e.preventDefault();
      void deps.undo().catch(notifyIpcError);
      return;
    }
    if (mod && !e.altKey) {
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        deps.zoomIn?.();
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        deps.zoomOut?.();
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        deps.resetZoom?.();
        return;
      }
    }

    if (mod || e.altKey) {
      return;
    }

    if (e.key === "?") {
      e.preventDefault();
      deps.toggleShortcutsHelp?.();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (deps.onCancelActiveRun?.()) {
        return;
      }
      deps.closeOverlays();
      const fid = deps.getFocusId();
      if (deps.getSelectedIds().size > 1 && fid !== null) {
        deps.selectSingle(fid);
      }
      return;
    }

    if (lower === "h" && e.shiftKey) {
      e.preventDefault();
      if (deps.toggleDiagnosticsModal) {
        deps.toggleDiagnosticsModal();
      } else if (diagnosticsModalOpen.value) {
        closeDiagnosticsModal();
      } else {
        openDiagnosticsModal();
      }
      return;
    }

    if (
      lower === "h" ||
      lower === "j" ||
      lower === "k" ||
      lower === "l" ||
      lower === "arrowleft" ||
      lower === "arrowdown" ||
      lower === "arrowup" ||
      lower === "arrowright"
    ) {
      e.preventDefault();
      handleDirectionalNav(lower, e.shiftKey);
      return;
    }

    if ((e.key === "Tab" || e.key === "Enter") && isInteractiveButtonTarget(e.target)) {
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      const fid = deps.getFocusId();
      if (!fid) return;
      const node = deps.getNodes().get(fid);
      if (!node) return;
      e.preventDefault();
      if (node.status === "locked") {
        deps.triggerLockedShake(node.id);
        deps.pushToast("Node is locked — press Shift+R or unlock via pill", "warning");
      } else {
        deps.enterEditMode(node);
      }
      return;
    }

    if (e.key === "Tab") {
      const fid = deps.getFocusId();
      if (!fid) return;
      const parent = deps.getNodes().get(fid);
      if (!parent) return;
      e.preventDefault();
      const edgeType: EdgeType = parent.type === "loophole" ? "resolves" : "derives";
      void deps
        .spawnChild(fid, edgeType, "core")
        .then(({ node }) => {
          deps.selectSingle(node.id);
          ensureNodeVisible(node.id);
          deps.enterEditMode(node);
        })
        .catch(notifyIpcError);
      return;
    }

    if (e.key === "Enter" && e.shiftKey) {
      const fid = deps.getFocusId();
      if (!fid) return;
      e.preventDefault();
      const parentId = findParentTarget(fid, deps.getNodes(), deps.getEdges()) ?? fid;
      void deps
        .spawnChild(parentId, "branches", "branch")
        .then(({ node }) => {
          deps.selectSingle(node.id);
          ensureNodeVisible(node.id);
          deps.enterEditMode(node);
        })
        .catch(notifyIpcError);
      return;
    }

    if (lower === "n" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const cam = deps.getCamera();
      const { width, height } = deps.getViewportSize();
      const center = screenToWorld(width / 2, height / 2, cam);
      const rawX = center.x - 160;
      const rawY = center.y - 90;
      const pos = deps.findFreeViewportNodePos
        ? deps.findFreeViewportNodePos(rawX, rawY)
        : { x: rawX, y: rawY };
      const now = Date.now();
      const node: NodeDto = {
        id: `node_${now}_${Math.random().toString(36).slice(2, 7)}`,
        type: "core",
        status: "active",
        title: "New Concept",
        content: "",
        summary: "",
        content_hash: "",
        summary_hash: "",
        metadata: {
          severity: null,
          lens: "manual",
          created_by: "user",
          model: null,
          token_count: 3,
        },
        context_controls: { pin_global: false, exclude_from_ai: false },
        layout: { x: pos.x, y: pos.y, width: 320, height: 180, collapsed: false },
        created_at: now,
        updated_at: now,
      };
      const { forward, inverse } = buildCreateNodeWithInverse(node);
      void deps
        .mutateUndoable("New free node", forward, inverse)
        .then((res) => {
          const created = res.updated_nodes.find((n) => n.id === node.id) ?? node;
          deps.selectSingle(created.id);
          deps.enterEditMode(created);
        })
        .catch(notifyIpcError);
      return;
    }

    if (lower === "e" && !e.shiftKey) {
      const fid = deps.getFocusId();
      if (!fid) return;
      e.preventDefault();
      localConnectSource = fid;
      deps.setConnectSourceId?.(fid);
      deps.setModalState("connect_edge");
      return;
    }

    if (lower === "p" && !e.shiftKey) {
      const ids = getTargetIds();
      if (ids.length === 0) return;
      e.preventDefault();
      const nodes = deps.getNodes();
      const forward: GraphOp[] = [];
      const inverse: GraphOp[] = [];
      for (const id of ids) {
        const n = nodes.get(id);
        if (!n) continue;
        const entry = buildUpdateMetaWithInverse(n, {
          pin_global: !n.context_controls.pin_global,
        });
        forward.push(...entry.forward);
        inverse.push(...entry.inverse);
      }
      if (forward.length > 0) {
        void deps.mutateUndoable("Toggle pin", forward, inverse).catch(notifyIpcError);
      }
      return;
    }

    if (lower === "x" && !e.shiftKey) {
      const ids = getTargetIds();
      if (ids.length === 0) return;
      e.preventDefault();
      const nodes = deps.getNodes();
      const forward: GraphOp[] = [];
      const inverse: GraphOp[] = [];
      for (const id of ids) {
        const n = nodes.get(id);
        if (!n) continue;
        const entry = buildUpdateMetaWithInverse(n, {
          exclude_from_ai: !n.context_controls.exclude_from_ai,
        });
        forward.push(...entry.forward);
        inverse.push(...entry.inverse);
      }
      if (forward.length > 0) {
        void deps.mutateUndoable("Toggle AI exclusion", forward, inverse).catch(notifyIpcError);
      }
      return;
    }

    if (lower === "r") {
      const ids = getTargetIds();
      if (ids.length === 0) return;
      const nodes = deps.getNodes();
      e.preventDefault();
      if (e.shiftKey) {
        const forward: GraphOp[] = [];
        const inverse: GraphOp[] = [];
        for (const id of ids) {
          const n = nodes.get(id);
          if (!n) continue;
          const nextStatus = n.status === "locked" ? "active" : "locked";
          const entry = buildUpdateMetaWithInverse(n, { status: nextStatus });
          forward.push(...entry.forward);
          inverse.push(...entry.inverse);
        }
        if (forward.length > 0) {
          void deps.mutateUndoable("Toggle lock", forward, inverse).catch(notifyIpcError);
        }
      } else {
        const fid = deps.getFocusId();
        const focused = fid ? nodes.get(fid) : undefined;
        if (focused && focused.type === "loophole") {
          const nextStatus = focused.status === "resolved" ? "active" : "resolved";
          const entry = buildUpdateMetaWithInverse(focused, { status: nextStatus });
          void deps
            .mutateUndoable("Toggle loophole resolved", entry.forward, entry.inverse)
            .catch(notifyIpcError);
        }
      }
      return;
    }

    if (lower === "m" && !e.shiftKey) {
      e.preventDefault();
      deps.toggleMinimap?.();
      return;
    }

    if ((e.key === "[" || e.key === "]") && !e.shiftKey) {
      e.preventDefault();
      const severityWeight = (sev: Severity | null): number => {
        switch (sev) {
          case "critical":
            return 4;
          case "high":
            return 3;
          case "medium":
            return 2;
          case "low":
            return 1;
          default:
            return 0;
        }
      };
      const loopholes = Array.from(deps.getNodes().values())
        .filter((n) => n.type === "loophole" && n.status === "active")
        .sort((a, b) => {
          const diff = severityWeight(b.metadata.severity) - severityWeight(a.metadata.severity);
          if (diff !== 0) {
            return diff;
          }
          return a.id.localeCompare(b.id);
        });
      if (loopholes.length === 0) {
        deps.pushToast("No active loopholes", "info");
        return;
      }
      const curFocus = deps.getFocusId();
      const curIdx = curFocus ? loopholes.findIndex((n) => n.id === curFocus) : -1;
      const step = e.key === "]" ? 1 : -1;
      const nextIdx =
        curIdx === -1
          ? e.key === "]"
            ? 0
            : loopholes.length - 1
          : (curIdx + step + loopholes.length) % loopholes.length;
      const target = loopholes[nextIdx];
      if (target) {
        deps.selectSingle(target.id);
        centerNodeWithAnimation(target.id);
      }
      return;
    }

    if (lower === "c") {
      const nodes = deps.getNodes();
      const selected = deps.getSelectedIds();
      if (!e.shiftKey && selected.size >= 2) {
        const selectedNodes = Array.from(selected)
          .map((id) => nodes.get(id))
          .filter((n): n is NodeDto => n !== undefined);
        if (selectedNodes.length === 0) return;
        e.preventDefault();
        const targetCollapsed = selectedNodes.some((n) => !n.layout.collapsed);
        const forward: GraphOp[] = [];
        const inverse: GraphOp[] = [];
        for (const n of selectedNodes) {
          if (n.layout.collapsed === targetCollapsed) continue;
          const entry = buildUpdateMetaWithInverse(n, { collapsed: targetCollapsed });
          forward.push(...entry.forward);
          inverse.push(...entry.inverse);
        }
        if (forward.length > 0) {
          void deps.mutateUndoable("Collapse selection", forward, inverse).catch(notifyIpcError);
        }
        return;
      }

      const fid = deps.getFocusId();
      if (!fid) return;
      const focused = nodes.get(fid);
      if (!focused) return;
      e.preventDefault();
      if (e.shiftKey) {
        const subtreeIds = collectSubtreeIds(fid, nodes, deps.getEdges());
        const targetCollapsed = !focused.layout.collapsed;
        const forward: GraphOp[] = [];
        const inverse: GraphOp[] = [];
        for (const id of subtreeIds) {
          const n = nodes.get(id);
          if (!n || n.layout.collapsed === targetCollapsed) continue;
          const entry = buildUpdateMetaWithInverse(n, { collapsed: targetCollapsed });
          forward.push(...entry.forward);
          inverse.push(...entry.inverse);
        }
        if (forward.length > 0) {
          void deps.mutateUndoable("Fold subtree", forward, inverse).catch(notifyIpcError);
        }
      } else {
        const entry = buildUpdateMetaWithInverse(focused, {
          collapsed: !focused.layout.collapsed,
        });
        void deps.mutateUndoable("Collapse node", entry.forward, entry.inverse).catch(notifyIpcError);
      }
      return;
    }

    if (lower === "t" && !e.shiftKey) {
      const fid = deps.getFocusId();
      if (!fid) return;
      e.preventDefault();
      const nodes = deps.getNodes();
      const prevMap = new Map<string, NodePositionUpdate>();
      for (const [id, n] of nodes.entries()) {
        prevMap.set(id, { id, x: n.layout.x, y: n.layout.y });
      }
      void deps
        .tidySubtree(fid)
        .then((updates) => {
          if (updates.length === 0) return;
          const prevMoves: NodePositionUpdate[] = [];
          for (const u of updates) {
            const prev = prevMap.get(u.id);
            if (prev) prevMoves.push(prev);
          }
          deps.applyTidy?.(prevMoves, updates);
        })
        .catch(notifyIpcError);
      return;
    }

    if (lower === "f" && !e.shiftKey) {
      e.preventDefault();
      const now = Date.now();
      const isDoubleTap = now - lastFTimestamp <= doubleTapFMs;
      lastFTimestamp = now;
      if (isDoubleTap) {
        lastFTimestamp = 0;
        smartFitIds(Array.from(deps.getNodes().keys()));
      } else {
        const selected = deps.getSelectedIds();
        if (selected.size >= 2) {
          smartFitIds(Array.from(selected));
        } else {
          const fid = deps.getFocusId();
          if (fid) {
            smartFitIds(collectSubtreeIds(fid, deps.getNodes(), deps.getEdges()));
          } else {
            smartFitIds(Array.from(deps.getNodes().keys()));
          }
        }
      }
      return;
    }

    if (lower === "v") {
      if (e.shiftKey) {
        if (e.repeat) return;
        e.preventDefault();
        const nextPinned = !(deps.isXrayPinned?.() ?? false);
        vHeld = false;
        deps.setXrayPinned?.(nextPinned);
        if (!nextPinned) {
          deps.setXray(null);
          return;
        }
        const targets = getTargetIds();
        void deps
          .compileXray(targets)
          .then((xray) => {
            if (deps.isXrayPinned?.() ?? true) {
              deps.setXray(xray);
            }
          })
          .catch(notifyIpcError);
        return;
      }

      if (e.repeat || vHeld) return;
      const targets = getTargetIds();
      if (targets.length === 0) return;
      e.preventDefault();
      vHeld = true;
      void deps
        .compileXray(targets)
        .then((xray) => {
          if (vHeld || (deps.isXrayPinned?.() ?? false)) {
            deps.setXray(xray);
          }
        })
        .catch(notifyIpcError);
      return;
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      const selEdgeId = deps.getSelectedEdgeId?.() ?? null;
      if (selEdgeId !== null) {
        const edge = deps.getEdges().get(selEdgeId);
        e.preventDefault();
        deps.clearSelectedEdge?.();
        if (edge) {
          void deps
            .mutateUndoable(
              "Delete edge",
              [{ op: "delete_edge", id: edge.id }],
              [{ op: "create_edge", edge: { ...edge } }],
            )
            .catch(notifyIpcError);
        }
        return;
      }

      const targets = getTargetIds();
      if (targets.length === 0) return;
      e.preventDefault();
      const nodes = deps.getNodes();
      const edges = deps.getEdges();

      if (targets.length === 1) {
        const single = nodes.get(targets[0]);
        if (single && single.type === "loophole" && single.status === "active") {
          const entry = buildUpdateMetaWithInverse(single, { status: "dismissed" });
          void deps.mutateUndoable("Dismiss loophole", entry.forward, entry.inverse).catch(notifyIpcError);
          return;
        }
      }

      const { forward, inverse } = buildDeleteWithInverse(targets, nodes, edges);
      if (forward.length > 0) {
        void deps.mutateUndoable("Delete node(s)", forward, inverse).catch(notifyIpcError);
      }
      return;
    }

    if (lower === "a" && !e.shiftKey) {
      e.preventDefault();
      clearChordTimer();
      deps.setModalState("chord_a");
      chordTimer = setTimeout(() => {
        chordTimer = null;
        if (deps.getModalState() === "chord_a") {
          deps.setModalState("navigate");
        }
      }, chordTimeoutMs);
    }
  };

  const handleKeyUp = (e: KeyboardEvent): void => {
    if (e.key.toLowerCase() === "v" && vHeld) {
      vHeld = false;
      if (!(deps.isXrayPinned?.() ?? false)) {
        deps.setXray(null);
      }
    }
  };

  const handleBlur = (): void => {
    if (vHeld) {
      vHeld = false;
      if (!(deps.isXrayPinned?.() ?? false)) {
        deps.setXray(null);
      }
    }
    if (deps.getModalState() === "chord_a") {
      resetToNavigate();
    }
  };

  const dispose = (): void => {
    clearChordTimer();
    vHeld = false;
  };

  return { handleKeyDown, handleKeyUp, handleBlur, dispose };
}

export function attachKeymap(
  onTriggerLens: (lens: LensKind) => void = (lens) => {
    void triggerLens(lens);
  },
): () => void {
  const controller = createKeymapHandler({
    getModalState: () => modalState.value,
    setModalState: (m) => {
      modalState.value = m;
    },
    getFocusId: () => focusId.value,
    getSelectedIds: () => selectedIds.value,
    getNodes: () => nodesMap,
    getEdges: () => edgesMap,
    selectSingle,
    setSelection,
    enterEditMode,
    triggerLockedShake,
    setXray: (xray) => {
      xrayState.value = xray;
    },
    compileXray: async (targets, budget) => {
      if (isTauriRuntime()) {
        return compileXrayIpc(targets, budget ?? tokenBudget.value);
      }
      return buildBrowserFallbackXray(targets, budget ?? tokenBudget.value);
    },
    mutateUndoable: mutateGraphUndoable,
    spawnChild: (parentId, edgeType, nodeType, title) =>
      spawnChild(parentId, edgeType, nodeType, title, true),
    undo: performUndo,
    redo: performRedo,
    tidySubtree: async (rootId) => {
      if (!isTauriRuntime()) {
        pushToast("Tidy subtree runs via Rust R-tree in desktop runtime", "info");
        return [];
      }
      return tidySubtreeIpc(rootId);
    },
    applyTidy: (prevMoves, nextMoves) => {
      applyTidyPositions(nextMoves);
      const { forward, inverse } = buildMoveNodesWithInverse(prevMoves, nextMoves);
      graphHistory.push({ label: "Tidy subtree", forward, inverse });
      syncHistorySignals();
    },
    openCommandPalette,
    openSettings: openSettingsModal,
    toggleSidebar,
    zoomIn: () => {
      cameraControllerRef.current?.zoomByStep?.(1.15);
    },
    zoomOut: () => {
      cameraControllerRef.current?.zoomByStep?.(1 / 1.15);
    },
    resetZoom: () => {
      cameraControllerRef.current?.resetZoom?.();
    },
    toggleShortcutsHelp: () => {
      shortcutsHelpOpen.value = !shortcutsHelpOpen.value;
    },
    toggleDiagnosticsModal: () => {
      if (diagnosticsModalOpen.value) {
        closeDiagnosticsModal();
      } else {
        openDiagnosticsModal();
      }
    },
    closeOverlays: () => {
      edgePopover.value = null;
      closeNodeContextMenu();
      relatedPopoverNodeId.value = null;
      shortcutsHelpOpen.value = false;
      closeDiagnosticsModal();
      closeOutlineImportModal();
      closeCommandPalette();
      closeCustomPromptBar();
      closeSettingsModal();
      closeArtifactExport();
      xrayPinned.value = false;
      xrayState.value = null;
      selectedEdgeId.value = null;
      closeSidebar();
      dismissTriageBanner();
      if (modalState.value === "chord_a" || modalState.value === "connect_edge") {
        modalState.value = "navigate";
      }
    },
    isXrayPinned: () => xrayPinned.value,
    setXrayPinned: (pinned) => {
      xrayPinned.value = pinned;
    },
    toggleMinimap: () => {
      minimapOpen.value = !minimapOpen.value;
    },
    getSelectedEdgeId: () => selectedEdgeId.value,
    clearSelectedEdge: () => {
      selectedEdgeId.value = null;
    },
    getEdgePopover: () => edgePopover.value,
    clearEdgePopover: () => {
      edgePopover.value = null;
    },
    onSelectEdgePopoverType: (edgeType) => {
      const pop = edgePopover.value;
      if (!pop) {
        return;
      }
      edgePopover.value = null;
      modalState.value = "navigate";
      void connectNodesWithEdge(pop.sourceId, pop.targetId, edgeType).catch(notifyIpcError);
    },
    onStartTriage: startLoopholeTriage,
    onCancelActiveRun: cancelActiveRun,
    setConnectSourceId: (id) => {
      connectSourceId.value = id;
    },
    openEdgePopoverFor: (sourceId, targetId) => {
      const ctrl = cameraControllerRef.current;
      const targetNode = nodesMap.get(targetId);
      if (ctrl && targetNode) {
        const pt = worldToScreen(
          targetNode.layout.x + targetNode.layout.width / 2,
          targetNode.layout.y,
          ctrl.getCamera(),
        );
        edgePopover.value = { sourceId, targetId, x: pt.x, y: pt.y };
        modalState.value = "connect_edge";
      }
    },
    onTriggerLens,
    pushToast,
    getCamera: () =>
      cameraControllerRef.current?.getCamera() ?? {
        x: 0,
        y: 0,
        zoom: 1,
        last_focus_id: null,
      },
    getViewportSize: () =>
      cameraControllerRef.current?.getViewportSize() ?? {
        width: typeof window !== "undefined" ? window.innerWidth : 1280,
        height: typeof window !== "undefined" ? window.innerHeight : 800,
      },
    animateTo: (cam, durationMs) => {
      cameraControllerRef.current?.animateTo(cam, durationMs);
    },
    findFreeViewportNodePos: (x, y) => {
      let curY = y;
      for (let i = 0; i < 20; i += 1) {
        const hits = viewportSpatialIndex.queryRect({
          minX: x - 10,
          minY: curY - 10,
          maxX: x + 330,
          maxY: curY + 190,
        });
        if (hits.length === 0) {
          return { x, y: curY };
        }
        curY += 40;
      }
      return { x, y: curY };
    },
  });

  window.addEventListener("keydown", controller.handleKeyDown);
  window.addEventListener("keyup", controller.handleKeyUp);
  window.addEventListener("blur", controller.handleBlur);

  return () => {
    controller.dispose();
    window.removeEventListener("keydown", controller.handleKeyDown);
    window.removeEventListener("keyup", controller.handleKeyUp);
    window.removeEventListener("blur", controller.handleBlur);
  };
}

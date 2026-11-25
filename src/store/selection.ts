import { signal } from "@preact/signals";
import type {
  ArtifactFormat,
  ArtifactScope,
  CompiledXray,
  ExternalRefInfo,
  NodeDto,
  StaleNodeInfo,
} from "../ipc/types";

export type ModalState = "navigate" | "edit" | "command" | "chord_a" | "connect_edge";

export interface EdgePopoverState {
  sourceId: string;
  targetId: string;
  x: number;
  y: number;
}

export interface NodeContextMenuState {
  nodeId: string;
  x: number;
  y: number;
}

export const modalState = signal<ModalState>("navigate");
export const focusId = signal<string | null>(null);
export const selectedIds = signal<ReadonlySet<string>>(new Set());
export const selectedEdgeId = signal<string | null>(null);
export const hoveredId = signal<string | null>(null);
export const xrayState = signal<CompiledXray | null>(null);
export const xrayPinned = signal<boolean>(false);
export const minimapOpen = signal<boolean>(false);
export const artifactExportOpen = signal<boolean>(false);
export const artifactExportScope = signal<ArtifactScope>("subgraph");
export const artifactExportFormat = signal<ArtifactFormat>("adr");
export const lockedShakeId = signal<string | null>(null);
export const edgePopover = signal<EdgePopoverState | null>(null);
export const nodeContextMenu = signal<NodeContextMenuState | null>(null);
export const isInteracting = signal<boolean>(false);
export const commandPaletteOpen = signal<boolean>(false);
export const shortcutsHelpOpen = signal<boolean>(false);
export const connectSourceId = signal<string | null>(null);
export const staleNodesMap = signal<ReadonlyMap<string, StaleNodeInfo>>(new Map());
export const relatedPopoverNodeId = signal<string | null>(null);
export const diagnosticsModalOpen = signal<boolean>(false);
export const outlineImportModalOpen = signal<boolean>(false);
export const externalRefsMap = signal<ReadonlyMap<string, ExternalRefInfo>>(new Map());
export const checkpointsModalOpen = signal<boolean>(false);
export const spotlightRootId = signal<string | null>(null);

export function closeNodeContextMenu(): void {
  nodeContextMenu.value = null;
}

export function openCheckpointsModal(): void {
  edgePopover.value = null;
  nodeContextMenu.value = null;
  relatedPopoverNodeId.value = null;
  hoveredId.value = null;
  shortcutsHelpOpen.value = false;
  artifactExportOpen.value = false;
  diagnosticsModalOpen.value = false;
  outlineImportModalOpen.value = false;
  checkpointsModalOpen.value = true;
}

export function closeCheckpointsModal(): void {
  checkpointsModalOpen.value = false;
}

export function toggleSpotlight(nodeId?: string | null): void {
  const target = nodeId ?? focusId.value;
  if (spotlightRootId.value !== null && (target === null || target === spotlightRootId.value)) {
    spotlightRootId.value = null;
    return;
  }
  if (target !== null) {
    spotlightRootId.value = target;
  }
}

export function clearSpotlight(): void {
  spotlightRootId.value = null;
}

export function openDiagnosticsModal(): void {
  edgePopover.value = null;
  nodeContextMenu.value = null;
  relatedPopoverNodeId.value = null;
  hoveredId.value = null;
  shortcutsHelpOpen.value = false;
  artifactExportOpen.value = false;
  outlineImportModalOpen.value = false;
  checkpointsModalOpen.value = false;
  diagnosticsModalOpen.value = true;
}

export function closeDiagnosticsModal(): void {
  diagnosticsModalOpen.value = false;
}

export function openOutlineImportModal(): void {
  edgePopover.value = null;
  nodeContextMenu.value = null;
  relatedPopoverNodeId.value = null;
  hoveredId.value = null;
  shortcutsHelpOpen.value = false;
  artifactExportOpen.value = false;
  diagnosticsModalOpen.value = false;
  checkpointsModalOpen.value = false;
  outlineImportModalOpen.value = true;
}

export function closeOutlineImportModal(): void {
  outlineImportModalOpen.value = false;
}

export function openArtifactExport(
  format: ArtifactFormat = "adr",
  scope: ArtifactScope = "subgraph",
): void {
  edgePopover.value = null;
  nodeContextMenu.value = null;
  relatedPopoverNodeId.value = null;
  hoveredId.value = null;
  shortcutsHelpOpen.value = false;
  diagnosticsModalOpen.value = false;
  outlineImportModalOpen.value = false;
  checkpointsModalOpen.value = false;
  artifactExportFormat.value = format;
  artifactExportScope.value = scope;
  artifactExportOpen.value = true;
}

export function closeArtifactExport(): void {
  artifactExportOpen.value = false;
}

export function openCommandPalette(): void {
  edgePopover.value = null;
  nodeContextMenu.value = null;
  relatedPopoverNodeId.value = null;
  hoveredId.value = null;
  shortcutsHelpOpen.value = false;
  artifactExportOpen.value = false;
  diagnosticsModalOpen.value = false;
  outlineImportModalOpen.value = false;
  checkpointsModalOpen.value = false;
  selectedEdgeId.value = null;
  commandPaletteOpen.value = true;
  modalState.value = "command";
}

export function closeCommandPalette(): void {
  commandPaletteOpen.value = false;
  if (modalState.value === "command") {
    modalState.value = "navigate";
  }
}

let shakeTimer: ReturnType<typeof setTimeout> | null = null;

export function selectEdge(edgeId: string | null): void {
  selectedEdgeId.value = edgeId;
  if (edgeId !== null) {
    focusId.value = null;
    selectedIds.value = new Set();
    edgePopover.value = null;
    nodeContextMenu.value = null;
  }
}

export function selectSingle(id: string | null): void {
  selectedEdgeId.value = null;
  if (id === null) {
    focusId.value = null;
    selectedIds.value = new Set();
    return;
  }
  focusId.value = id;
  selectedIds.value = new Set([id]);
}

export function toggleSelect(id: string): void {
  selectedEdgeId.value = null;
  const next = new Set(selectedIds.value);
  if (next.has(id)) {
    next.delete(id);
    selectedIds.value = next;
    if (focusId.value === id) {
      const fallback = next.values().next().value;
      focusId.value = fallback ?? null;
    }
  } else {
    next.add(id);
    selectedIds.value = next;
    focusId.value = id;
  }
}

export function setSelection(ids: Iterable<string>, primaryId?: string | null): void {
  selectedEdgeId.value = null;
  const next = new Set(ids);
  selectedIds.value = next;
  if (primaryId !== undefined) {
    focusId.value = primaryId;
  } else {
    const first = next.values().next().value;
    focusId.value = first ?? null;
  }
}

export function clearSelection(): void {
  selectedEdgeId.value = null;
  selectedIds.value = new Set();
  focusId.value = null;
}

export function triggerLockedShake(id: string): void {
  if (shakeTimer !== null) {
    clearTimeout(shakeTimer);
    shakeTimer = null;
  }
  lockedShakeId.value = null;
  // Defer setting the id by one microtask/frame when re-triggering on the same node
  queueMicrotask(() => {
    lockedShakeId.value = id;
  });
  shakeTimer = setTimeout(() => {
    if (lockedShakeId.value === id) {
      lockedShakeId.value = null;
    }
    shakeTimer = null;
  }, 240);
}

export function enterEditMode(node: NodeDto): boolean {
  if (node.status === "locked") {
    triggerLockedShake(node.id);
    return false;
  }
  selectedEdgeId.value = null;
  focusId.value = node.id;
  selectedIds.value = new Set([node.id]);
  hoveredId.value = null;
  edgePopover.value = null;
  nodeContextMenu.value = null;
  relatedPopoverNodeId.value = null;
  diagnosticsModalOpen.value = false;
  outlineImportModalOpen.value = false;
  checkpointsModalOpen.value = false;
  modalState.value = "edit";
  return true;
}

export function exitEditMode(): void {
  if (modalState.value === "edit") {
    modalState.value = "navigate";
  }
}

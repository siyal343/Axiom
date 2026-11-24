import { signal } from "@preact/signals";
import type { CompiledXray, NodeDto } from "../ipc/types";

export type ModalState = "navigate" | "edit" | "command" | "chord_a" | "connect_edge";

export interface EdgePopoverState {
  sourceId: string;
  targetId: string;
  x: number;
  y: number;
}

export const modalState = signal<ModalState>("navigate");
export const focusId = signal<string | null>(null);
export const selectedIds = signal<ReadonlySet<string>>(new Set());
export const hoveredId = signal<string | null>(null);
export const xrayState = signal<CompiledXray | null>(null);
export const lockedShakeId = signal<string | null>(null);
export const edgePopover = signal<EdgePopoverState | null>(null);
export const isInteracting = signal<boolean>(false);
export const commandPaletteOpen = signal<boolean>(false);
export const shortcutsHelpOpen = signal<boolean>(false);
export const connectSourceId = signal<string | null>(null);

export function openCommandPalette(): void {
  edgePopover.value = null;
  hoveredId.value = null;
  shortcutsHelpOpen.value = false;
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

export function selectSingle(id: string | null): void {
  if (id === null) {
    focusId.value = null;
    selectedIds.value = new Set();
    return;
  }
  focusId.value = id;
  selectedIds.value = new Set([id]);
}

export function toggleSelect(id: string): void {
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
  focusId.value = node.id;
  selectedIds.value = new Set([node.id]);
  hoveredId.value = null;
  edgePopover.value = null;
  modalState.value = "edit";
  return true;
}

export function exitEditMode(): void {
  if (modalState.value === "edit") {
    modalState.value = "navigate";
  }
}

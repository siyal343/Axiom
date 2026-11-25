import { signal } from "@preact/signals";
import { clampZoom } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import {
  createFlow,
  createWorkspace,
  deleteFlow,
  deleteWorkspace,
  isTauriRuntime,
  listWorkspaceCatalog,
  openFlow,
  renameFlow,
  renameWorkspace,
} from "../ipc/client";
import type {
  EdgeDto,
  EdgeType,
  FlowEntryDto,
  FlowTemplate,
  NodeDto,
  NodeType,
  OpenFlowResult,
  WorkspaceCatalogDto,
  WorkspaceEntryDto,
  WorkspaceSnapshot,
} from "../ipc/types";
import { notifyIpcError, pushToast } from "../overlays/ToastStack";
import {
  cameraControllerRef,
  edgesMap,
  loadSnapshot,
  nodesMap,
  tokenBudget,
} from "./graphStore";
import { graphHistory, syncHistorySignals } from "./history";
import { focusId, selectSingle } from "./selection";

const CATALOG_STORAGE_KEY = "axiom_catalog_v1";
const FLOW_STORAGE_PREFIX = "axiom_flow_";
const memoryStorage = new Map<string, string>();

export const workspaceCatalog = signal<WorkspaceCatalogDto | null>(null);
export const sidebarOpen = signal<boolean>(false);

export function toggleSidebar(): void {
  sidebarOpen.value = !sidebarOpen.value;
}

export function openSidebar(): void {
  sidebarOpen.value = true;
}

export function closeSidebar(): void {
  sidebarOpen.value = false;
}

function readStorage(key: string): string | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const value = window.localStorage.getItem(key);
      if (value !== null) {
        return value;
      }
    }
  } catch {
    // Fall back to in-memory map when localStorage is unavailable or blocked.
  }
  return memoryStorage.get(key) ?? null;
}

function writeStorage(key: string, value: string): void {
  memoryStorage.set(key, value);
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Keep in-memory copy when localStorage is unavailable or full.
  }
}

function removeStorage(key: string): void {
  memoryStorage.delete(key);
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Non-fatal in environments without localStorage.
  }
}

function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function estimateLocalTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.35));
}

function makeTemplateNode(
  type: NodeType,
  title: string,
  content: string,
  x: number,
  y: number,
  now: number,
): NodeDto {
  return {
    id: nextId("node"),
    type,
    status: "active",
    title,
    content,
    summary: "",
    content_hash: `${title.length}:${content.length}:${now}`,
    summary_hash: "",
    metadata: {
      severity: null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: estimateLocalTokens(`${title}\n${content}`),
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: { x, y, width: 320, height: 180, collapsed: false },
    created_at: now,
    updated_at: now,
  };
}

function makeTemplateEdge(
  sourceId: string,
  targetId: string,
  type: EdgeType,
  now: number,
): EdgeDto {
  return {
    id: nextId("edge"),
    source_id: sourceId,
    target_id: targetId,
    type,
    weight: "summary",
    created_at: now,
  };
}

export function buildTemplateSnapshot(
  template: FlowTemplate,
  workspacePathLabel: string,
): WorkspaceSnapshot {
  const now = Date.now();
  let nodes: NodeDto[];
  let edges: EdgeDto[];

  switch (template) {
    case "blank": {
      nodes = [makeTemplateNode("core", "New Topic", "", 0, 0, now)];
      edges = [];
      break;
    }
    case "research": {
      const root = makeTemplateNode(
        "core",
        "Research Question",
        "Define the central hypothesis, measurable variables, and scope.",
        0,
        0,
        now,
      );
      const lit = makeTemplateNode(
        "probe",
        "Literature & Evidence",
        "Key prior studies, datasets, and baseline empirical bounds.",
        420,
        -110,
        now,
      );
      const gaps = makeTemplateNode(
        "branch",
        "Hypotheses & Gaps",
        "Competing mechanisms, confounders, and open experimental tests.",
        420,
        120,
        now,
      );
      nodes = [root, lit, gaps];
      edges = [
        makeTemplateEdge(root.id, lit.id, "derives", now),
        makeTemplateEdge(root.id, gaps.id, "branches", now),
      ];
      break;
    }
    case "study": {
      const root = makeTemplateNode(
        "core",
        "Topic to Master",
        "State the concept in one sentence and list what you want to predict or derive.",
        0,
        0,
        now,
      );
      const breakdown = makeTemplateNode(
        "probe",
        "First-Principles Breakdown",
        "Core laws, KaTeX definitions, and intuitive causal mechanisms.",
        420,
        -110,
        now,
      );
      const recall = makeTemplateNode(
        "probe",
        "Active Recall Questions",
        "Self-test prompts, worked derivations, and common edge-case traps.",
        420,
        120,
        now,
      );
      nodes = [root, breakdown, recall];
      edges = [
        makeTemplateEdge(root.id, breakdown.id, "derives", now),
        makeTemplateEdge(root.id, recall.id, "derives", now),
      ];
      break;
    }
    case "engineering":
    default: {
      nodes = [makeTemplateNode("core", "System Architecture", "", 0, 0, now)];
      edges = [];
      break;
    }
  }

  return {
    path: workspacePathLabel,
    nodes,
    edges,
    camera: {
      x: 0,
      y: 0,
      zoom: 1,
      last_focus_id: nodes[0]?.id ?? null,
    },
    token_budget: 6000,
  };
}

function buildCurrentSnapshot(dbPath: string): WorkspaceSnapshot {
  const cam = cameraControllerRef.current?.getCamera() ?? {
    x: 0,
    y: 0,
    zoom: 1,
    last_focus_id: focusId.value,
  };
  return {
    path: dbPath,
    nodes: Array.from(nodesMap.values()),
    edges: Array.from(edgesMap.values()),
    camera: {
      x: cam.x,
      y: cam.y,
      zoom: cam.zoom,
      last_focus_id: focusId.value,
    },
    token_budget: tokenBudget.value,
  };
}

function saveCatalogLocal(catalog: WorkspaceCatalogDto): void {
  writeStorage(CATALOG_STORAGE_KEY, JSON.stringify(catalog));
}

function saveFlowSnapshotLocal(flowId: string, snapshot: WorkspaceSnapshot): void {
  writeStorage(`${FLOW_STORAGE_PREFIX}${flowId}`, JSON.stringify(snapshot));
}

let localSaveTimer: ReturnType<typeof setTimeout> | null = null;
let beforeUnloadRegistered = false;

function ensureBeforeUnloadFlush(): void {
  if (beforeUnloadRegistered || typeof window === "undefined" || isTauriRuntime()) {
    return;
  }
  beforeUnloadRegistered = true;
  window.addEventListener("beforeunload", () => {
    if (localSaveTimer !== null) {
      clearTimeout(localSaveTimer);
      localSaveTimer = null;
    }
    if (!isTauriRuntime()) {
      saveCurrentLocalFlowSnapshot();
    }
  });
}

function saveCurrentLocalFlowSnapshot(): void {
  if (localSaveTimer !== null) {
    clearTimeout(localSaveTimer);
    localSaveTimer = null;
  }
  const currentCatalog = workspaceCatalog.value;
  if (!currentCatalog) {
    return;
  }
  const activeWs = currentCatalog.workspaces.find(
    (w) => w.id === currentCatalog.active_workspace_id,
  );
  const activeFlow = activeWs?.flows.find((f) => f.id === currentCatalog.active_flow_id);
  if (!activeFlow) {
    return;
  }
  saveFlowSnapshotLocal(activeFlow.id, buildCurrentSnapshot(activeFlow.db_path));
}

export function scheduleSaveCurrentLocalFlowSnapshot(): void {
  if (isTauriRuntime()) {
    return;
  }
  ensureBeforeUnloadFlush();
  if (localSaveTimer !== null) {
    clearTimeout(localSaveTimer);
  }
  localSaveTimer = setTimeout(() => {
    localSaveTimer = null;
    if (!isTauriRuntime()) {
      saveCurrentLocalFlowSnapshot();
    }
  }, 400);
}

function loadFlowSnapshotLocal(flow: FlowEntryDto): WorkspaceSnapshot {
  const raw = readStorage(`${FLOW_STORAGE_PREFIX}${flow.id}`);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<WorkspaceSnapshot>;
      if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges) && parsed.camera) {
        return {
          path: typeof parsed.path === "string" ? parsed.path : flow.db_path,
          nodes: parsed.nodes,
          edges: parsed.edges,
          camera: parsed.camera,
          token_budget: typeof parsed.token_budget === "number" ? parsed.token_budget : 6000,
        };
      }
    } catch {
      // Re-seed if stored snapshot JSON is corrupted.
    }
  }
  const seeded = buildTemplateSnapshot(flow.template, flow.db_path);
  saveFlowSnapshotLocal(flow.id, seeded);
  return seeded;
}

function loadOrInitLocalCatalog(): WorkspaceCatalogDto {
  const raw = readStorage(CATALOG_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<WorkspaceCatalogDto>;
      if (
        Array.isArray(parsed.workspaces) &&
        parsed.workspaces.length > 0 &&
        typeof parsed.active_workspace_id === "string" &&
        typeof parsed.active_flow_id === "string"
      ) {
        return {
          workspaces: parsed.workspaces,
          active_workspace_id: parsed.active_workspace_id,
          active_flow_id: parsed.active_flow_id,
        };
      }
    } catch {
      // Recreate default catalog if stored JSON is corrupted.
    }
  }

  const now = Date.now();
  const wsId = nextId("ws");
  const flowId = nextId("flow");
  const defaultFlow: FlowEntryDto = {
    id: flowId,
    workspace_id: wsId,
    name: "Main Flow",
    template: "engineering",
    db_path: `local://${wsId}/${flowId}`,
    updated_at: now,
  };
  const catalog: WorkspaceCatalogDto = {
    workspaces: [
      {
        id: wsId,
        name: "Personal",
        created_at: now,
        flows: [defaultFlow],
      },
    ],
    active_workspace_id: wsId,
    active_flow_id: flowId,
  };
  saveCatalogLocal(catalog);
  saveFlowSnapshotLocal(flowId, buildTemplateSnapshot("engineering", defaultFlow.db_path));
  return catalog;
}

function applyLoadedFlow(catalog: WorkspaceCatalogDto, snapshot: WorkspaceSnapshot): void {
  workspaceCatalog.value = catalog;
  loadSnapshot(snapshot);
  graphHistory.clear();
  syncHistorySignals();
}

function findFlowInCatalog(
  catalog: WorkspaceCatalogDto,
  workspaceId: string,
  flowId: string,
): { workspace: WorkspaceEntryDto; flow: FlowEntryDto } | null {
  const ws = catalog.workspaces.find((w) => w.id === workspaceId);
  if (!ws) {
    return null;
  }
  const flow = ws.flows.find((f) => f.id === flowId);
  if (!flow) {
    return null;
  }
  return { workspace: ws, flow };
}

export async function initWorkspaceCatalog(): Promise<WorkspaceCatalogDto | null> {
  try {
    if (isTauriRuntime()) {
      const catalog = await listWorkspaceCatalog();
      workspaceCatalog.value = catalog;
      const activeWs =
        catalog.workspaces.find((w) => w.id === catalog.active_workspace_id) ??
        catalog.workspaces[0];
      const activeFlow =
        activeWs?.flows.find((f) => f.id === catalog.active_flow_id) ?? activeWs?.flows[0];
      if (activeWs && activeFlow) {
        const opened = await openFlow(activeWs.id, activeFlow.id);
        applyLoadedFlow(opened.catalog, opened.snapshot);
        return opened.catalog;
      }
      return catalog;
    }

    ensureBeforeUnloadFlush();
    const catalog = loadOrInitLocalCatalog();
    const activePair =
      findFlowInCatalog(catalog, catalog.active_workspace_id, catalog.active_flow_id) ??
      (() => {
        const firstWs = catalog.workspaces[0];
        const firstFlow = firstWs?.flows[0];
        if (!firstWs || !firstFlow) {
          return null;
        }
        catalog.active_workspace_id = firstWs.id;
        catalog.active_flow_id = firstFlow.id;
        saveCatalogLocal(catalog);
        return { workspace: firstWs, flow: firstFlow };
      })();

    if (!activePair) {
      workspaceCatalog.value = catalog;
      return catalog;
    }

    const snapshot = loadFlowSnapshotLocal(activePair.flow);
    applyLoadedFlow(catalog, snapshot);
    return catalog;
  } catch (err) {
    notifyIpcError(err);
    return null;
  }
}

export async function openFlowAction(
  workspaceId: string,
  flowId: string,
): Promise<OpenFlowResult | null> {
  try {
    if (isTauriRuntime()) {
      const result = await openFlow(workspaceId, flowId);
      applyLoadedFlow(result.catalog, result.snapshot);
      return result;
    }

    const current = workspaceCatalog.value ?? loadOrInitLocalCatalog();
    const pair = findFlowInCatalog(current, workspaceId, flowId);
    if (!pair) {
      pushToast("Flow not found", "warning");
      return null;
    }

    saveCurrentLocalFlowSnapshot();
    const updated: WorkspaceCatalogDto = {
      ...current,
      active_workspace_id: pair.workspace.id,
      active_flow_id: pair.flow.id,
    };
    saveCatalogLocal(updated);
    const snapshot = loadFlowSnapshotLocal(pair.flow);
    applyLoadedFlow(updated, snapshot);
    return { catalog: updated, snapshot };
  } catch (err) {
    notifyIpcError(err);
    return null;
  }
}

export async function createWorkspaceAction(name: string): Promise<WorkspaceEntryDto | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    pushToast("Workspace name cannot be empty", "warning");
    return null;
  }

  try {
    if (isTauriRuntime()) {
      const created = await createWorkspace(trimmed);
      const firstFlow = created.flows[0];
      if (firstFlow) {
        const opened = await openFlow(created.id, firstFlow.id);
        applyLoadedFlow(opened.catalog, opened.snapshot);
      } else {
        workspaceCatalog.value = await listWorkspaceCatalog();
      }
      return created;
    }

    saveCurrentLocalFlowSnapshot();
    const current = workspaceCatalog.value ?? loadOrInitLocalCatalog();
    const now = Date.now();
    const wsId = nextId("ws");
    const flowId = nextId("flow");
    const defaultFlow: FlowEntryDto = {
      id: flowId,
      workspace_id: wsId,
      name: "Main Flow",
      template: "engineering",
      db_path: `local://${wsId}/${flowId}`,
      updated_at: now,
    };
    const ws: WorkspaceEntryDto = {
      id: wsId,
      name: trimmed,
      created_at: now,
      flows: [defaultFlow],
    };
    const nextCatalog: WorkspaceCatalogDto = {
      workspaces: [...current.workspaces, ws],
      active_workspace_id: wsId,
      active_flow_id: flowId,
    };
    saveCatalogLocal(nextCatalog);
    const seeded = buildTemplateSnapshot("engineering", defaultFlow.db_path);
    saveFlowSnapshotLocal(flowId, seeded);
    applyLoadedFlow(nextCatalog, seeded);
    return ws;
  } catch (err) {
    notifyIpcError(err);
    return null;
  }
}

export async function renameWorkspaceAction(
  workspaceId: string,
  name: string,
): Promise<WorkspaceCatalogDto | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    pushToast("Workspace name cannot be empty", "warning");
    return null;
  }

  try {
    if (isTauriRuntime()) {
      const next = await renameWorkspace(workspaceId, trimmed);
      workspaceCatalog.value = next;
      return next;
    }

    const current = workspaceCatalog.value ?? loadOrInitLocalCatalog();
    let found = false;
    const workspaces = current.workspaces.map((ws) => {
      if (ws.id !== workspaceId) {
        return ws;
      }
      found = true;
      return { ...ws, name: trimmed };
    });
    if (!found) {
      pushToast("Workspace not found", "warning");
      return null;
    }
    const nextCatalog: WorkspaceCatalogDto = { ...current, workspaces };
    saveCatalogLocal(nextCatalog);
    workspaceCatalog.value = nextCatalog;
    return nextCatalog;
  } catch (err) {
    notifyIpcError(err);
    return null;
  }
}

export async function deleteWorkspaceAction(
  workspaceId: string,
): Promise<WorkspaceCatalogDto | null> {
  try {
    if (isTauriRuntime()) {
      const prevActiveFlowId = workspaceCatalog.value?.active_flow_id ?? null;
      const next = await deleteWorkspace(workspaceId);
      workspaceCatalog.value = next;
      if (next.active_flow_id && next.active_flow_id !== prevActiveFlowId) {
        const opened = await openFlow(next.active_workspace_id, next.active_flow_id);
        applyLoadedFlow(opened.catalog, opened.snapshot);
        return opened.catalog;
      }
      return next;
    }

    const current = workspaceCatalog.value ?? loadOrInitLocalCatalog();
    if (current.workspaces.length <= 1) {
      pushToast("Cannot delete the last remaining workspace", "warning");
      return null;
    }
    const targetWs = current.workspaces.find((w) => w.id === workspaceId);
    if (!targetWs) {
      pushToast("Workspace not found", "warning");
      return null;
    }

    const deletingActive = current.active_workspace_id === workspaceId;
    if (!deletingActive) {
      saveCurrentLocalFlowSnapshot();
    }

    for (const flow of targetWs.flows) {
      removeStorage(`${FLOW_STORAGE_PREFIX}${flow.id}`);
    }

    const remaining = current.workspaces.filter((w) => w.id !== workspaceId);
    let nextActiveWsId = current.active_workspace_id;
    let nextActiveFlowId = current.active_flow_id;
    if (deletingActive) {
      const fallbackWs = remaining[0];
      const fallbackFlow = fallbackWs?.flows[0];
      if (!fallbackWs || !fallbackFlow) {
        return null;
      }
      nextActiveWsId = fallbackWs.id;
      nextActiveFlowId = fallbackFlow.id;
    }

    const nextCatalog: WorkspaceCatalogDto = {
      workspaces: remaining,
      active_workspace_id: nextActiveWsId,
      active_flow_id: nextActiveFlowId,
    };
    saveCatalogLocal(nextCatalog);

    if (deletingActive) {
      const pair = findFlowInCatalog(nextCatalog, nextActiveWsId, nextActiveFlowId);
      if (pair) {
        const snapshot = loadFlowSnapshotLocal(pair.flow);
        applyLoadedFlow(nextCatalog, snapshot);
        return nextCatalog;
      }
    }

    workspaceCatalog.value = nextCatalog;
    return nextCatalog;
  } catch (err) {
    notifyIpcError(err);
    return null;
  }
}

export async function createFlowAction(
  workspaceId: string,
  name: string,
  template: FlowTemplate,
): Promise<OpenFlowResult | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    pushToast("Flow name cannot be empty", "warning");
    return null;
  }

  try {
    if (isTauriRuntime()) {
      const result = await createFlow(workspaceId, trimmed, template);
      applyLoadedFlow(result.catalog, result.snapshot);
      return result;
    }

    saveCurrentLocalFlowSnapshot();
    const current = workspaceCatalog.value ?? loadOrInitLocalCatalog();
    const targetWs = current.workspaces.find((w) => w.id === workspaceId);
    if (!targetWs) {
      pushToast("Workspace not found", "warning");
      return null;
    }

    const now = Date.now();
    const flowId = nextId("flow");
    const newFlow: FlowEntryDto = {
      id: flowId,
      workspace_id: workspaceId,
      name: trimmed,
      template,
      db_path: `local://${workspaceId}/${flowId}`,
      updated_at: now,
    };
    const workspaces = current.workspaces.map((ws) =>
      ws.id === workspaceId ? { ...ws, flows: [...ws.flows, newFlow] } : ws,
    );
    const nextCatalog: WorkspaceCatalogDto = {
      workspaces,
      active_workspace_id: workspaceId,
      active_flow_id: flowId,
    };
    saveCatalogLocal(nextCatalog);
    const snapshot = buildTemplateSnapshot(template, newFlow.db_path);
    saveFlowSnapshotLocal(flowId, snapshot);
    applyLoadedFlow(nextCatalog, snapshot);
    return { catalog: nextCatalog, snapshot };
  } catch (err) {
    notifyIpcError(err);
    return null;
  }
}

export async function renameFlowAction(
  workspaceId: string,
  flowId: string,
  name: string,
): Promise<WorkspaceCatalogDto | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    pushToast("Flow name cannot be empty", "warning");
    return null;
  }

  try {
    if (isTauriRuntime()) {
      const next = await renameFlow(workspaceId, flowId, trimmed);
      workspaceCatalog.value = next;
      return next;
    }

    const current = workspaceCatalog.value ?? loadOrInitLocalCatalog();
    const now = Date.now();
    let found = false;
    const workspaces = current.workspaces.map((ws) => {
      if (ws.id !== workspaceId) {
        return ws;
      }
      return {
        ...ws,
        flows: ws.flows.map((f) => {
          if (f.id !== flowId) {
            return f;
          }
          found = true;
          return { ...f, name: trimmed, updated_at: now };
        }),
      };
    });
    if (!found) {
      pushToast("Flow not found", "warning");
      return null;
    }
    const nextCatalog: WorkspaceCatalogDto = { ...current, workspaces };
    saveCatalogLocal(nextCatalog);
    workspaceCatalog.value = nextCatalog;
    return nextCatalog;
  } catch (err) {
    notifyIpcError(err);
    return null;
  }
}

export async function deleteFlowAction(
  workspaceId: string,
  flowId: string,
): Promise<WorkspaceCatalogDto | null> {
  try {
    if (isTauriRuntime()) {
      const prevActiveFlowId = workspaceCatalog.value?.active_flow_id ?? null;
      const next = await deleteFlow(workspaceId, flowId);
      workspaceCatalog.value = next;
      if (next.active_flow_id && next.active_flow_id !== prevActiveFlowId) {
        const opened = await openFlow(next.active_workspace_id, next.active_flow_id);
        applyLoadedFlow(opened.catalog, opened.snapshot);
        return opened.catalog;
      }
      return next;
    }

    const current = workspaceCatalog.value ?? loadOrInitLocalCatalog();
    const targetWs = current.workspaces.find((w) => w.id === workspaceId);
    if (!targetWs) {
      pushToast("Workspace not found", "warning");
      return null;
    }
    if (targetWs.flows.length <= 1) {
      pushToast("Cannot delete the last flow in a workspace", "warning");
      return null;
    }
    const exists = targetWs.flows.some((f) => f.id === flowId);
    if (!exists) {
      pushToast("Flow not found", "warning");
      return null;
    }

    const deletingActive =
      current.active_workspace_id === workspaceId && current.active_flow_id === flowId;
    if (!deletingActive) {
      saveCurrentLocalFlowSnapshot();
    }
    removeStorage(`${FLOW_STORAGE_PREFIX}${flowId}`);

    const remainingFlows = targetWs.flows.filter((f) => f.id !== flowId);
    const workspaces = current.workspaces.map((ws) =>
      ws.id === workspaceId ? { ...ws, flows: remainingFlows } : ws,
    );
    const nextActiveFlowId = deletingActive
      ? (remainingFlows[0]?.id ?? current.active_flow_id)
      : current.active_flow_id;

    const nextCatalog: WorkspaceCatalogDto = {
      workspaces,
      active_workspace_id: current.active_workspace_id,
      active_flow_id: nextActiveFlowId,
    };
    saveCatalogLocal(nextCatalog);

    if (deletingActive) {
      const pair = findFlowInCatalog(nextCatalog, workspaceId, nextActiveFlowId);
      if (pair) {
        const snapshot = loadFlowSnapshotLocal(pair.flow);
        applyLoadedFlow(nextCatalog, snapshot);
        return nextCatalog;
      }
    }

    workspaceCatalog.value = nextCatalog;
    return nextCatalog;
  } catch (err) {
    notifyIpcError(err);
    return null;
  }
}

export async function openFlowAndFocusNode(
  workspaceId: string,
  flowId: string,
  nodeId: string,
): Promise<void> {
  const current = workspaceCatalog.value;
  const alreadyActive =
    current !== null &&
    current.active_workspace_id === workspaceId &&
    current.active_flow_id === flowId;

  if (!alreadyActive) {
    const opened = await openFlowAction(workspaceId, flowId);
    if (!opened) {
      return;
    }
  }

  selectSingle(nodeId);
  const node = nodesMap.get(nodeId);
  const controller = cameraControllerRef.current;
  if (!node || !controller) {
    return;
  }

  const w = node.layout.width ?? 320;
  const h = getEffectiveNodeHeight(node);
  const cx = node.layout.x + w / 2;
  const cy = node.layout.y + h / 2;
  const cam = controller.getCamera();
  const { width, height } = controller.getViewportSize();
  const targetZoom = clampZoom(Math.max(cam.zoom, 0.85));
  controller.animateTo(
    {
      x: width / 2 - cx * targetZoom,
      y: height / 2 - cy * targetZoom,
      zoom: targetZoom,
    },
    220,
  );
}

import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyResult,
  CameraState,
  CompiledXray,
  EdgeDto,
  EdgeType,
  GraphOp,
  IpcError,
  NodeDto,
  NodePositionUpdate,
  NodeType,
  SearchHit,
  WorkspaceSnapshot,
} from "./types";

const IPC_ERROR_CODES: ReadonlySet<IpcError["code"]> = new Set([
  "WORKSPACE_NOT_OPEN",
  "DB_ERROR",
  "VALIDATION_ERROR",
  "NODE_LOCKED",
  "DUPLICATE_EDGE",
  "PROVIDER_AUTH",
  "PROVIDER_NETWORK",
  "RUN_NOT_FOUND",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIpcErrorCode(value: unknown): value is IpcError["code"] {
  return typeof value === "string" && IPC_ERROR_CODES.has(value as IpcError["code"]);
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function parseIpcError(err: unknown): IpcError {
  if (isRecord(err) && isIpcErrorCode(err.code) && typeof err.message === "string") {
    return { code: err.code, message: err.message };
  }
  if (typeof err === "string") {
    try {
      const parsed: unknown = JSON.parse(err);
      if (isRecord(parsed) && isIpcErrorCode(parsed.code) && typeof parsed.message === "string") {
        return { code: parsed.code, message: parsed.message };
      }
    } catch {
      return { code: "DB_ERROR", message: err };
    }
    return { code: "DB_ERROR", message: err };
  }
  if (err instanceof Error) {
    return { code: "DB_ERROR", message: err.message };
  }
  return { code: "DB_ERROR", message: "Unknown IPC error" };
}

export async function openWorkspace(path: string): Promise<WorkspaceSnapshot> {
  return invoke<WorkspaceSnapshot>("open_workspace", { path });
}

export async function applyOps(ops: GraphOp[]): Promise<ApplyResult> {
  return invoke<ApplyResult>("apply_ops", { ops });
}

export async function spawnConnectedNode(
  parentId: string,
  edgeType: EdgeType,
  nodeType: NodeType,
  title?: string,
): Promise<{ node: NodeDto; edge: EdgeDto }> {
  return invoke<{ node: NodeDto; edge: EdgeDto }>("spawn_connected_node", {
    parentId,
    edgeType,
    nodeType,
    title,
  });
}

export async function compileXray(
  focusIds: string[],
  tokenBudget?: number,
): Promise<CompiledXray> {
  return invoke<CompiledXray>("compile_xray", { focusIds, tokenBudget });
}

export async function searchNodes(query: string, limit?: number): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("search_nodes", { query, limit });
}

export async function tidySubtree(rootId: string): Promise<NodePositionUpdate[]> {
  return invoke<NodePositionUpdate[]>("tidy_subtree", { rootId });
}

export async function saveCamera(camera: CameraState): Promise<void> {
  return invoke<void>("save_camera", { camera });
}

export async function exportJson(destPath: string): Promise<void> {
  return invoke<void>("export_json", { destPath });
}

export async function importJson(
  srcPath: string,
  destSqlitePath: string,
): Promise<WorkspaceSnapshot> {
  return invoke<WorkspaceSnapshot>("import_json", { srcPath, destSqlitePath });
}

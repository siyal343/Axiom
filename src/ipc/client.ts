import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSettingsDto,
  ApplyResult,
  ArtifactFormat,
  ArtifactScope,
  CameraState,
  CheckpointDiff,
  CheckpointSummary,
  CompiledArtifact,
  CompiledXray,
  EdgeDto,
  EdgeType,
  ExternalRefInfo,
  FlowTemplate,
  GraphDiagnostics,
  GraphOp,
  ImportOutlineResult,
  IpcError,
  LensKind,
  LensStreamEvent,
  NodeDto,
  NodePositionUpdate,
  NodeType,
  OpenFlowResult,
  PullExternalRefResult,
  RelatedNodeHit,
  SaveSettingsInput,
  SearchHit,
  SpawnDirection,
  StaleNodeInfo,
  StudyCardDto,
  StudyCardKind,
  StudyRating,
  StudySyncResult,
  SummaryUpdatedEvent,
  TestConnectionResult,
  WorkspaceCatalogDto,
  WorkspaceEntryDto,
  WorkspaceSearchHit,
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
  direction?: SpawnDirection,
): Promise<{ node: NodeDto; edge: EdgeDto }> {
  return invoke<{ node: NodeDto; edge: EdgeDto }>("spawn_connected_node", {
    parentId,
    edgeType,
    nodeType,
    title,
    direction,
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

export async function resolveOverlaps(pinnedIds: string[]): Promise<NodePositionUpdate[]> {
  return invoke<NodePositionUpdate[]>("resolve_overlaps", { pinnedIds });
}

export async function saveCamera(camera: CameraState): Promise<void> {
  return invoke<void>("save_camera", { camera });
}

export async function exportJson(destPath: string): Promise<void> {
  return invoke<void>("export_json", { destPath });
}

export async function exportMarkdownArtifact(
  focusIds: string[],
  scope: ArtifactScope,
  format: ArtifactFormat,
  destPath?: string | null,
): Promise<CompiledArtifact> {
  return invoke<CompiledArtifact>("export_markdown_artifact", {
    focusIds,
    scope,
    format,
    destPath: destPath ?? null,
  });
}

export async function importJson(
  srcPath: string,
  destSqlitePath: string,
): Promise<WorkspaceSnapshot> {
  return invoke<WorkspaceSnapshot>("import_json", { srcPath, destSqlitePath });
}

export async function runLens(
  lens: LensKind,
  focusIds: string[],
  onEvent: (event: LensStreamEvent) => void,
  customPrompt?: string,
  inPlace?: boolean,
  customLensId?: string | null,
): Promise<string> {
  const channel = new Channel<LensStreamEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("run_lens", {
    lens,
    focusIds,
    customPrompt,
    inPlace: inPlace ?? false,
    customLensId: customLensId ?? null,
    onEvent: channel,
  });
}

export async function cancelRun(runId: string): Promise<void> {
  return invoke<void>("cancel_run", { runId });
}

export async function getSettings(): Promise<AppSettingsDto> {
  return invoke<AppSettingsDto>("get_settings", {});
}

export async function saveSettings(input: SaveSettingsInput): Promise<AppSettingsDto> {
  return invoke<AppSettingsDto>("save_settings", { input });
}

export async function testProviderConnection(
  tier: "reasoning" | "utility",
): Promise<TestConnectionResult> {
  return invoke<TestConnectionResult>("test_provider_connection", { tier });
}

export async function seedStress500(): Promise<WorkspaceSnapshot> {
  return invoke<WorkspaceSnapshot>("seed_stress_500", {});
}

export async function listenSummaryUpdated(
  handler: (event: SummaryUpdatedEvent) => void,
): Promise<UnlistenFn> {
  return listen<SummaryUpdatedEvent>("axiom://summary-updated", (evt) => {
    handler(evt.payload);
  });
}

export async function listWorkspaceCatalog(): Promise<WorkspaceCatalogDto> {
  return invoke<WorkspaceCatalogDto>("list_workspace_catalog", {});
}

export async function createWorkspace(name: string): Promise<WorkspaceEntryDto> {
  return invoke<WorkspaceEntryDto>("create_workspace", { name });
}

export async function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<WorkspaceCatalogDto> {
  return invoke<WorkspaceCatalogDto>("rename_workspace", { workspaceId, name });
}

export async function deleteWorkspace(workspaceId: string): Promise<WorkspaceCatalogDto> {
  return invoke<WorkspaceCatalogDto>("delete_workspace", { workspaceId });
}

export async function createFlow(
  workspaceId: string,
  name: string,
  template: FlowTemplate,
): Promise<OpenFlowResult> {
  return invoke<OpenFlowResult>("create_flow", { workspaceId, name, template });
}

export async function openFlow(
  workspaceId: string,
  flowId: string,
): Promise<OpenFlowResult> {
  return invoke<OpenFlowResult>("open_flow", { workspaceId, flowId });
}

export async function renameFlow(
  workspaceId: string,
  flowId: string,
  name: string,
): Promise<WorkspaceCatalogDto> {
  return invoke<WorkspaceCatalogDto>("rename_flow", { workspaceId, flowId, name });
}

export async function deleteFlow(
  workspaceId: string,
  flowId: string,
): Promise<WorkspaceCatalogDto> {
  return invoke<WorkspaceCatalogDto>("delete_flow", { workspaceId, flowId });
}

export async function getStaleNodes(): Promise<StaleNodeInfo[]> {
  return invoke<StaleNodeInfo[]>("get_stale_nodes", {});
}

export async function acknowledgeStaleNode(nodeId: string): Promise<void> {
  return invoke<void>("acknowledge_stale_node", { nodeId });
}

export async function findRelatedNodes(
  nodeId: string,
  limit?: number,
): Promise<RelatedNodeHit[]> {
  return invoke<RelatedNodeHit[]>("find_related_nodes", { nodeId, limit });
}

export async function searchWorkspaceFlows(
  query: string,
  limit?: number,
): Promise<WorkspaceSearchHit[]> {
  return invoke<WorkspaceSearchHit[]>("search_workspace_flows", { query, limit });
}

export async function saveFlowSystemPrompt(prompt: string): Promise<void> {
  return invoke<void>("save_flow_system_prompt", { prompt });
}

export async function getGraphDiagnostics(): Promise<GraphDiagnostics> {
  return invoke<GraphDiagnostics>("get_graph_diagnostics", {});
}

export async function enqueueStaleSummaries(limit?: number): Promise<number> {
  return invoke<number>("enqueue_stale_summaries", { limit: limit ?? 64 });
}

export async function importMarkdownOutline(
  markdown: string,
  parentId?: string | null,
): Promise<ImportOutlineResult> {
  return invoke<ImportOutlineResult>("import_markdown_outline", {
    markdown,
    parentId: parentId ?? null,
  });
}

export async function pullExternalReference(
  sourceWorkspaceId: string,
  sourceFlowId: string,
  sourceNodeId: string,
  attachToNodeId?: string | null,
): Promise<PullExternalRefResult> {
  return invoke<PullExternalRefResult>("pull_external_reference", {
    sourceWorkspaceId,
    sourceFlowId,
    sourceNodeId,
    attachToNodeId: attachToNodeId ?? null,
  });
}

export async function getExternalRefStatuses(): Promise<ExternalRefInfo[]> {
  return invoke<ExternalRefInfo[]>("get_external_ref_statuses", {});
}

export async function syncExternalRef(localNodeId: string): Promise<NodeDto> {
  return invoke<NodeDto>("sync_external_ref", { localNodeId });
}

export async function detachExternalRef(localNodeId: string): Promise<void> {
  return invoke<void>("detach_external_ref", { localNodeId });
}

export async function listCheckpoints(): Promise<CheckpointSummary[]> {
  return invoke<CheckpointSummary[]>("list_checkpoints", {});
}

export async function createCheckpoint(
  name: string,
  note?: string,
): Promise<CheckpointSummary> {
  return invoke<CheckpointSummary>("create_checkpoint", {
    name,
    note: note ?? "",
  });
}

export async function diffCheckpoint(checkpointId: string): Promise<CheckpointDiff> {
  return invoke<CheckpointDiff>("diff_checkpoint", { checkpointId });
}

export async function restoreCheckpoint(checkpointId: string): Promise<WorkspaceSnapshot> {
  return invoke<WorkspaceSnapshot>("restore_checkpoint", { checkpointId });
}

export async function deleteCheckpoint(checkpointId: string): Promise<void> {
  return invoke<void>("delete_checkpoint", { checkpointId });
}

export async function syncStudyDeck(): Promise<StudySyncResult> {
  return invoke<StudySyncResult>("sync_study_deck", {});
}

export async function listStudyCards(dueOnly?: boolean): Promise<StudyCardDto[]> {
  return invoke<StudyCardDto[]>("list_study_cards", { dueOnly: dueOnly ?? false });
}

export async function createStudyCard(params: {
  nodeId?: string | null;
  prompt: string;
  answer: string;
  cardKind?: StudyCardKind;
}): Promise<StudyCardDto> {
  return invoke<StudyCardDto>("create_study_card", {
    nodeId: params.nodeId ?? null,
    prompt: params.prompt,
    answer: params.answer,
    cardKind: params.cardKind ?? "manual",
  });
}

export async function reviewStudyCard(
  cardId: string,
  rating: StudyRating,
): Promise<StudyCardDto> {
  return invoke<StudyCardDto>("review_study_card", { cardId, rating });
}

export async function deleteStudyCard(cardId: string): Promise<void> {
  return invoke<void>("delete_study_card", { cardId });
}

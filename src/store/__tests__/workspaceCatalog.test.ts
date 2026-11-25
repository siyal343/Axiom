// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { edgesMap, mutateGraphUndoable, nodesMap } from "../graphStore";
import { buildCreateNodeWithInverse, graphHistory } from "../history";
import { closeNodeContextMenu, selectSingle } from "../selection";
import {
  closeSidebar,
  createFlowAction,
  createWorkspaceAction,
  deleteFlowAction,
  deleteWorkspaceAction,
  initWorkspaceCatalog,
  openFlowAction,
  renameFlowAction,
  renameWorkspaceAction,
  sidebarOpen,
  workspaceCatalog,
} from "../workspaceCatalogStore";
import type { NodeDto } from "../../ipc/types";

function clearStoreState(): void {
  localStorage.clear();
  workspaceCatalog.value = null;
  closeSidebar();
  closeNodeContextMenu();
  nodesMap.clear();
  edgesMap.clear();
  graphHistory.clear();
  selectSingle(null);
}

describe("workspaceCatalogStore (browser fallback, templates & flow isolation)", () => {
  beforeEach(() => {
    clearStoreState();
  });

  afterEach(() => {
    clearStoreState();
  });

  it("initializes default workspace, supports workspaces/flows CRUD, and isolates graphs per flow", async () => {
    const initial = await initWorkspaceCatalog();
    expect(initial).not.toBeNull();
    expect(initial?.workspaces).toHaveLength(1);
    expect(initial?.workspaces[0]?.name).toBe("Personal");
    expect(initial?.workspaces[0]?.flows[0]?.name).toBe("Main Flow");
    expect(nodesMap.size).toBe(1);
    expect(sidebarOpen.value).toBe(false);

    // Create a second workspace and verify it becomes active.
    const labWs = await createWorkspaceAction("Research Lab");
    expect(labWs).not.toBeNull();
    if (!labWs) return;
    expect(workspaceCatalog.value?.active_workspace_id).toBe(labWs.id);
    expect(workspaceCatalog.value?.workspaces).toHaveLength(2);

    // Create blank, research, and study flows inside Research Lab.
    const blankRes = await createFlowAction(labWs.id, "Scratch", "blank");
    expect(blankRes).not.toBeNull();
    expect(nodesMap.size).toBe(1);
    expect(edgesMap.size).toBe(0);
    expect(Array.from(nodesMap.values())[0]?.title).toBe("New Topic");

    const researchRes = await createFlowAction(labWs.id, "Raft Lit", "research");
    expect(researchRes).not.toBeNull();
    expect(nodesMap.size).toBe(3);
    expect(edgesMap.size).toBe(2);
    expect(Array.from(nodesMap.values()).map((n) => n.title)).toContain("Research Question");

    const studyRes = await createFlowAction(labWs.id, "Distributed Quiz", "study");
    expect(studyRes).not.toBeNull();
    expect(nodesMap.size).toBe(3);
    expect(edgesMap.size).toBe(2);
    expect(Array.from(nodesMap.values()).map((n) => n.title)).toContain("Topic to Master");

    // Mutate the study flow by adding a custom node, then switch to blank and back.
    const studyFlowId = workspaceCatalog.value?.active_flow_id;
    expect(studyFlowId).toBeTruthy();
    if (!studyFlowId) return;

    const now = Date.now();
    const addedNode: NodeDto = {
      id: "node_study_custom_1",
      type: "core",
      status: "active",
      title: "Quorum Proof Note",
      content: "Intersection guarantees at most one leader per term.",
      summary: "",
      content_hash: "h1",
      summary_hash: "",
      metadata: {
        severity: null,
        lens: "manual",
        created_by: "user",
        model: null,
        token_count: 10,
      },
      context_controls: { pin_global: false, exclude_from_ai: false },
      layout: { x: 100, y: 260, width: 320, height: 180, collapsed: false },
      created_at: now,
      updated_at: now,
    };
    const { forward, inverse } = buildCreateNodeWithInverse(addedNode);
    await mutateGraphUndoable("Add study note", forward, inverse);
    expect(nodesMap.has("node_study_custom_1")).toBe(true);

    const blankFlowId = blankRes?.catalog.active_flow_id;
    expect(blankFlowId).toBeTruthy();
    if (!blankFlowId) return;

    await openFlowAction(labWs.id, blankFlowId);
    expect(nodesMap.has("node_study_custom_1")).toBe(false);
    expect(nodesMap.size).toBe(1);

    await openFlowAction(labWs.id, studyFlowId);
    expect(nodesMap.has("node_study_custom_1")).toBe(true);
    expect(nodesMap.get("node_study_custom_1")?.title).toBe("Quorum Proof Note");

    // Rename workspace & flow.
    const renamedWsCat = await renameWorkspaceAction(labWs.id, "Systems Lab");
    expect(renamedWsCat?.workspaces.find((w) => w.id === labWs.id)?.name).toBe("Systems Lab");

    const renamedFlowCat = await renameFlowAction(labWs.id, studyFlowId, "Raft Mastery");
    const updatedFlow = renamedFlowCat?.workspaces
      .find((w) => w.id === labWs.id)
      ?.flows.find((f) => f.id === studyFlowId);
    expect(updatedFlow?.name).toBe("Raft Mastery");

    // Delete active flow and verify active_flow_id remains valid.
    const afterDeleteFlow = await deleteFlowAction(labWs.id, studyFlowId);
    expect(afterDeleteFlow).not.toBeNull();
    if (afterDeleteFlow) {
      const activeWs = afterDeleteFlow.workspaces.find(
        (w) => w.id === afterDeleteFlow.active_workspace_id,
      );
      expect(activeWs?.flows.some((f) => f.id === afterDeleteFlow.active_flow_id)).toBe(true);
      expect(activeWs?.flows.some((f) => f.id === studyFlowId)).toBe(false);
    }

    // Delete active workspace and verify fallback to Personal without dangling IDs.
    const afterDeleteWs = await deleteWorkspaceAction(labWs.id);
    expect(afterDeleteWs).not.toBeNull();
    expect(afterDeleteWs?.workspaces).toHaveLength(1);
    expect(afterDeleteWs?.active_workspace_id).toBe(afterDeleteWs?.workspaces[0]?.id);
    expect(afterDeleteWs?.active_flow_id).toBe(afterDeleteWs?.workspaces[0]?.flows[0]?.id);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { EdgeDto, NodeDto } from "../../ipc/types";
import { toastsSignal } from "../../overlays/ToastStack";
import {
  applySummaryUpdate,
  dismissTriageBanner,
  handleLensStreamEvent,
  resetRunTracker,
  settingsModalOpen,
  triageBanner,
} from "../aiRunner";
import {
  edgesMap,
  graphVersion,
  loadSnapshot,
  nodesMap,
  performRedo,
  performUndo,
} from "../graphStore";
import { canUndoSignal, graphHistory } from "../history";
import { focusId, selectSingle } from "../selection";

function makeNode(
  id: string,
  type: NodeDto["type"],
  status: NodeDto["status"],
  title: string,
): NodeDto {
  return {
    id,
    type,
    status,
    title,
    content: "",
    summary: "",
    content_hash: `hash_${id}`,
    summary_hash: "",
    metadata: {
      severity: type === "loophole" ? "high" : null,
      lens: type === "core" ? "manual" : "red_team",
      created_by: type === "core" ? "user" : "ai",
      model: type === "core" ? null : "gpt-4o",
      token_count: 10,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: { x: 0, y: 0, width: 320, height: 180, collapsed: false },
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };
}

function makeEdge(id: string, source_id: string, target_id: string, type: EdgeDto["type"]): EdgeDto {
  return {
    id,
    source_id,
    target_id,
    type,
    weight: "summary",
    created_at: 1_700_000_000_000,
  };
}

describe("Slice 4 aiRunner: grouped Undo/Redo, Red-Team triage, PROVIDER_AUTH toast & silent summaries", () => {
  beforeEach(() => {
    loadSnapshot({
      path: "",
      nodes: [
        makeNode("node_root", "core", "active", "Root Spec"),
        makeNode("node_other", "core", "active", "Other Spec"),
      ],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "node_root" },
      token_budget: 6000,
    });
    toastsSignal.value = [];
    settingsModalOpen.value = false;
    dismissTriageBanner();
    resetRunTracker();
  });

  it("groups multi-card AI run into 1 undoable history entry and activates Red-Team triage when focus unchanged", async () => {
    selectSingle("node_root");
    resetRunTracker("red_team", "node_root");

    const lh1 = makeNode("lh_1", "loophole", "draft", "Race Condition");
    const lh2 = makeNode("lh_2", "loophole", "draft", "Memory Leak");
    const e1 = makeEdge("e_1", "lh_1", "node_root", "challenges");
    const e2 = makeEdge("e_2", "lh_2", "node_root", "challenges");

    handleLensStreamEvent({ kind: "skeleton_spawned", node: lh1, edges: [e1] });
    handleLensStreamEvent({ kind: "token_delta", node_id: "lh_1", chunk: "Details..." });
    handleLensStreamEvent({
      kind: "node_finalized",
      node: { ...lh1, status: "active", content: "Details..." },
    });
    handleLensStreamEvent({ kind: "skeleton_spawned", node: lh2, edges: [e2] });
    handleLensStreamEvent({
      kind: "node_finalized",
      node: { ...lh2, status: "active", content: "Leak details" },
    });
    handleLensStreamEvent({
      kind: "run_completed",
      run_id: "run_1",
      spawned_ids: ["lh_1", "lh_2"],
      cancelled: false,
    });

    expect(nodesMap.has("lh_1")).toBe(true);
    expect(nodesMap.has("lh_2")).toBe(true);
    expect(edgesMap.has("e_1")).toBe(true);
    expect(edgesMap.has("e_2")).toBe(true);
    expect(graphHistory.size()).toBe(1);
    expect(canUndoSignal.value).toBe(true);

    // Red-Team triage automatically focused first loophole & showed triage banner
    expect(focusId.value).toBe("lh_1");
    expect(triageBanner.value).toContain("Triage:");

    // Single Undo rolls back all nodes & edges from the AI run
    await performUndo();
    expect(nodesMap.has("lh_1")).toBe(false);
    expect(nodesMap.has("lh_2")).toBe(false);
    expect(edgesMap.has("e_1")).toBe(false);
    expect(edgesMap.has("e_2")).toBe(false);

    // Single Redo restores both spawned nodes & edges
    await performRedo();
    expect(nodesMap.has("lh_1")).toBe(true);
    expect(nodesMap.has("lh_2")).toBe(true);
    expect(edgesMap.has("e_1")).toBe(true);
    expect(edgesMap.has("e_2")).toBe(true);
  });

  it("does not steal focus or show triage banner if user manually moved focus during Red-Team run", () => {
    selectSingle("node_root");
    resetRunTracker("red_team", "node_root");

    const lh1 = makeNode("lh_1", "loophole", "draft", "Finding");
    handleLensStreamEvent({
      kind: "skeleton_spawned",
      node: lh1,
      edges: [makeEdge("e_1", "lh_1", "node_root", "challenges")],
    });

    // User manually navigates away mid-stream
    selectSingle("node_other");

    handleLensStreamEvent({
      kind: "node_finalized",
      node: { ...lh1, status: "active", content: "Text" },
    });
    handleLensStreamEvent({
      kind: "run_completed",
      run_id: "run_2",
      spawned_ids: ["lh_1"],
      cancelled: false,
    });

    expect(focusId.value).toBe("node_other");
    expect(triageBanner.value).toBeNull();
  });

  it("offers Open Settings action toast on PROVIDER_AUTH run_error", () => {
    resetRunTracker("diverge", "node_root");
    handleLensStreamEvent({
      kind: "run_error",
      run_id: "run_auth",
      code: "PROVIDER_AUTH",
      message: "Invalid API key",
    });

    expect(toastsSignal.value.length).toBe(1);
    const toast = toastsSignal.value[0]!;
    expect(toast.action?.label).toBe("Open Settings");
    toast.action?.onClick();
    expect(settingsModalOpen.value).toBe(true);
  });

  it("applies background summary updates silently without bumping graphVersion", () => {
    const versionBefore = graphVersion.value;
    applySummaryUpdate({
      node_id: "node_root",
      summary: "Concise two-sentence summary.",
      summary_hash: "hash_node_root",
    });

    expect(graphVersion.value).toBe(versionBefore);
    expect(nodesMap.get("node_root")?.summary).toBe("Concise two-sentence summary.");
    expect(nodesMap.get("node_root")?.summary_hash).toBe("hash_node_root");
  });
});

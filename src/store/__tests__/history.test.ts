import { beforeEach, describe, expect, it } from "vitest";
import type { EdgeDto, NodeDto } from "../../ipc/types";
import {
  edgesMap,
  loadSnapshot,
  mutateGraphUndoable,
  nodesMap,
  performRedo,
  performUndo,
} from "../graphStore";
import {
  buildCreateNodeWithInverse,
  buildDeleteWithInverse,
  buildMoveNodesWithInverse,
  buildUpdateTextWithInverse,
  canRedoSignal,
  canUndoSignal,
  graphHistory,
  HISTORY_CAPACITY,
  UndoRedoHistory,
} from "../history";

function makeNode(id: string, title: string, x = 0, y = 0): NodeDto {
  return {
    id,
    type: "core",
    status: "active",
    title,
    content: "Initial content",
    summary: "",
    content_hash: `hash_${id}`,
    summary_hash: "",
    metadata: {
      severity: null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: 5,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: { x, y, width: 320, height: 180, collapsed: false },
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };
}

function makeEdge(id: string, source_id: string, target_id: string): EdgeDto {
  return {
    id,
    source_id,
    target_id,
    type: "derives",
    weight: "summary",
    created_at: 1_700_000_000_000,
  };
}

describe("UT-TS-03: UndoRedoHistory ring buffer & invertible GraphOp sequences", () => {
  beforeEach(() => {
    loadSnapshot({
      path: "",
      nodes: [makeNode("root", "Root", 0, 0)],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "root" },
      token_budget: 6000,
    });
  });

  it("undoes and redoes CreateNode, UpdateNodeText, MoveNodes, and DeleteNodes with restored edges", async () => {
    const child = makeNode("child", "Child Node", 420, 0);
    const edge = makeEdge("e_root_child", "root", "child");

    // 1. CreateNode + Edge
    const createOps = buildCreateNodeWithInverse(child, [edge]);
    await mutateGraphUndoable("Create child", createOps.forward, createOps.inverse);
    expect(nodesMap.has("child")).toBe(true);
    expect(edgesMap.has("e_root_child")).toBe(true);
    expect(canUndoSignal.value).toBe(true);

    // 2. UpdateNodeText
    const beforeText = nodesMap.get("child")!;
    const textOps = buildUpdateTextWithInverse(beforeText, "Updated Title", "Updated Body");
    await mutateGraphUndoable("Update text", textOps.forward, textOps.inverse);
    expect(nodesMap.get("child")?.title).toBe("Updated Title");
    expect(nodesMap.get("child")?.content).toBe("Updated Body");

    // 3. MoveNodes
    const moveOps = buildMoveNodesWithInverse(
      [{ id: "child", x: 420, y: 0 }],
      [{ id: "child", x: 640, y: 120 }],
    );
    await mutateGraphUndoable("Move child", moveOps.forward, moveOps.inverse);
    expect(nodesMap.get("child")?.layout.x).toBe(640);
    expect(nodesMap.get("child")?.layout.y).toBe(120);

    // 4. DeleteNodes (captures node + incident edge)
    const delOps = buildDeleteWithInverse(["child"], nodesMap, edgesMap);
    await mutateGraphUndoable("Delete child", delOps.forward, delOps.inverse);
    expect(nodesMap.has("child")).toBe(false);
    expect(edgesMap.has("e_root_child")).toBe(false);

    // Undo Delete -> restores child AND edge
    await performUndo();
    expect(nodesMap.has("child")).toBe(true);
    expect(edgesMap.has("e_root_child")).toBe(true);
    expect(nodesMap.get("child")?.title).toBe("Updated Title");
    expect(canRedoSignal.value).toBe(true);

    // Undo Move -> back to (420, 0)
    await performUndo();
    expect(nodesMap.get("child")?.layout.x).toBe(420);
    expect(nodesMap.get("child")?.layout.y).toBe(0);

    // Undo UpdateText -> back to original title/content
    await performUndo();
    expect(nodesMap.get("child")?.title).toBe("Child Node");
    expect(nodesMap.get("child")?.content).toBe("Initial content");

    // Undo Create -> removed
    await performUndo();
    expect(nodesMap.has("child")).toBe(false);
    expect(edgesMap.has("e_root_child")).toBe(false);
    expect(canUndoSignal.value).toBe(false);

    // Redo Create -> restored
    await performRedo();
    expect(nodesMap.has("child")).toBe(true);
    expect(edgesMap.has("e_root_child")).toBe(true);

    // Redo UpdateText & Move & Delete
    await performRedo();
    expect(nodesMap.get("child")?.title).toBe("Updated Title");
    await performRedo();
    expect(nodesMap.get("child")?.layout.x).toBe(640);
    await performRedo();
    expect(nodesMap.has("child")).toBe(false);
    expect(edgesMap.has("e_root_child")).toBe(false);
    expect(canRedoSignal.value).toBe(false);
    expect(graphHistory.size()).toBe(4);
  });

  it("enforces capacity 100 ring buffer eviction", () => {
    const ring = new UndoRedoHistory();
    expect(HISTORY_CAPACITY).toBe(100);

    for (let i = 1; i <= 105; i += 1) {
      ring.push({
        label: `op_${i}`,
        forward: [{ op: "move_nodes", moves: [{ id: "root", x: i, y: 0 }] }],
        inverse: [{ op: "move_nodes", moves: [{ id: "root", x: i - 1, y: 0 }] }],
      });
    }

    expect(ring.size()).toBe(100);
    let poppedCount = 0;
    let oldestRemaining = "";
    while (ring.canUndo()) {
      const entry = ring.undo();
      if (entry) {
        oldestRemaining = entry.label;
        poppedCount += 1;
      }
    }
    expect(poppedCount).toBe(100);
    expect(oldestRemaining).toBe("op_6");
  });
});

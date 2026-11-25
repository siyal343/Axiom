// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { NodeDto } from "../../ipc/types";
import {
  loadSnapshot,
  mutateGraphUndoable,
  nodesMap,
  performRedo,
  performUndo,
  resolveAndAnimateOverlaps,
  spawnChild,
} from "../graphStore";
import { buildResizeNodesWithInverse } from "../history";

function makeNode(id: string, x = 0, y = 0, width = 320, height = 180): NodeDto {
  return {
    id,
    type: "core",
    status: "active",
    title: `Node ${id}`,
    content: "",
    summary: "",
    content_hash: `h_${id}`,
    summary_hash: "",
    metadata: {
      severity: null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: 2,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: { x, y, width, height, collapsed: false },
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };
}

function rectsOverlap(a: NodeDto, b: NodeDto): boolean {
  const ah = a.layout.collapsed ? 44 : a.layout.height;
  const bh = b.layout.collapsed ? 44 : b.layout.height;
  return (
    a.layout.x < b.layout.x + b.layout.width &&
    a.layout.x + a.layout.width > b.layout.x &&
    a.layout.y < b.layout.y + bh &&
    a.layout.y + ah > b.layout.y
  );
}

describe("Browser graphStore: directional spawnChild, resize undo/redo, and overlap resolution", () => {
  beforeEach(() => {
    loadSnapshot({
      path: "",
      nodes: [makeNode("root", 0, 0)],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1.0, last_focus_id: "root" },
      token_budget: 6000,
    });
  });

  it("places Shift+Enter siblings and directional spawns without overlapping", async () => {
    const first = await spawnChild("root", "branches", "branch", "Sibling 1");
    const second = await spawnChild("root", "branches", "branch", "Sibling 2");
    const leftChild = await spawnChild("root", "derives", "core", "Left", true, "left");

    const n1 = nodesMap.get(first.node.id);
    const n2 = nodesMap.get(second.node.id);
    const nLeft = nodesMap.get(leftChild.node.id);
    expect(n1).toBeDefined();
    expect(n2).toBeDefined();
    expect(nLeft).toBeDefined();
    if (!n1 || !n2 || !nLeft) return;

    expect(nLeft.layout.x).toBeLessThan(0);
    expect(rectsOverlap(n1, n2)).toBe(false);
    expect(rectsOverlap(n1, nLeft)).toBe(false);
    expect(rectsOverlap(n2, nLeft)).toBe(false);
  });

  it("supports undo and redo for ResizeNodes mutations", async () => {
    const { forward, inverse } = buildResizeNodesWithInverse(
      [{ id: "root", width: 320, height: 180 }],
      [{ id: "root", width: 512, height: 340 }],
    );
    await mutateGraphUndoable("Resize node", forward, inverse);
    expect(nodesMap.get("root")?.layout.width).toBe(512);
    expect(nodesMap.get("root")?.layout.height).toBe(340);

    await performUndo();
    expect(nodesMap.get("root")?.layout.width).toBe(320);
    expect(nodesMap.get("root")?.layout.height).toBe(180);

    await performRedo();
    expect(nodesMap.get("root")?.layout.width).toBe(512);
    expect(nodesMap.get("root")?.layout.height).toBe(340);
  });

  it("separates overlapping neighbors via resolveAndAnimateOverlaps while keeping pinned node fixed", async () => {
    loadSnapshot({
      path: "",
      nodes: [
        makeNode("pinned", 100, 100, 320, 180),
        makeNode("neighbor", 160, 120, 320, 180),
      ],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1.0, last_focus_id: "pinned" },
      token_budget: 6000,
    });

    await resolveAndAnimateOverlaps(["pinned"]);

    const pinnedAfter = nodesMap.get("pinned");
    const neighborAfter = nodesMap.get("neighbor");
    expect(pinnedAfter).toBeDefined();
    expect(neighborAfter).toBeDefined();
    if (!pinnedAfter || !neighborAfter) return;

    expect(pinnedAfter.layout.x).toBe(100);
    expect(pinnedAfter.layout.y).toBe(100);
    expect(rectsOverlap(pinnedAfter, neighborAfter)).toBe(false);
  });
});

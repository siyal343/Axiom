// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { NodeDto } from "../../ipc/types";
import { loadSnapshot, nodesMap, spawnChild } from "../graphStore";

function makeRootNode(id: string): NodeDto {
  return {
    id,
    type: "core",
    status: "active",
    title: "Parent Core",
    content: "",
    summary: "",
    content_hash: "h_root",
    summary_hash: "",
    metadata: {
      severity: null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: 2,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: { x: 0, y: 0, width: 320, height: 180, collapsed: false },
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

describe("Browser fallback spawnChild collision avoidance", () => {
  beforeEach(() => {
    loadSnapshot({
      path: "",
      nodes: [makeRootNode("root")],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1.0, last_focus_id: "root" },
      token_budget: 6000,
    });
  });

  it("nudges consecutive Shift+Enter siblings so they never overlap", async () => {
    const first = await spawnChild("root", "branches", "branch", "Sibling 1");
    const second = await spawnChild("root", "branches", "branch", "Sibling 2");

    const n1 = nodesMap.get(first.node.id);
    const n2 = nodesMap.get(second.node.id);
    expect(n1).toBeDefined();
    expect(n2).toBeDefined();
    if (!n1 || !n2) return;

    expect(n2.layout.y).toBeGreaterThan(n1.layout.y);
    expect(rectsOverlap(n1, n2)).toBe(false);
  });
});

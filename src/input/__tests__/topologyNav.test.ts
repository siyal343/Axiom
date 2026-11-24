import { describe, expect, it } from "vitest";
import type { EdgeDto, NodeDto } from "../../ipc/types";
import {
  collectSubtreeIds,
  findFirstChildTarget,
  findParentTarget,
  findSiblingTarget,
} from "../topologyNav";

function makeNode(
  id: string,
  type: NodeDto["type"],
  x: number,
  y: number,
): NodeDto {
  return {
    id,
    type,
    status: "active",
    title: id,
    content: "",
    summary: "",
    content_hash: id,
    summary_hash: "",
    metadata: {
      severity: type === "loophole" ? "high" : null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: 1,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: { x, y, width: 320, height: 180, collapsed: false },
    created_at: 1,
    updated_at: 1,
  };
}

function makeEdge(
  id: string,
  source_id: string,
  target_id: string,
  type: EdgeDto["type"],
): EdgeDto {
  return {
    id,
    source_id,
    target_id,
    type,
    weight: "summary",
    created_at: 1,
  };
}

describe("UT-TS-05: H/J/K/L deterministic topology navigation", () => {
  const root = makeNode("root", "core", 0, 100);
  const childTop = makeNode("c_top", "branch", 420, -100);
  const childMid = makeNode("c_mid", "branch", 420, 100);
  const childBot = makeNode("c_bot", "branch", 420, 300);
  const lh1 = makeNode("lh_1", "loophole", 420, 520);
  const lh2 = makeNode("lh_2", "loophole", 760, 520);

  const nodes = new Map<string, NodeDto>([
    [root.id, root],
    [childBot.id, childBot],
    [childTop.id, childTop],
    [childMid.id, childMid],
    [lh2.id, lh2],
    [lh1.id, lh1],
  ]);

  const edges = new Map<string, EdgeDto>([
    ["e1", makeEdge("e1", "root", "c_bot", "branches")],
    ["e2", makeEdge("e2", "root", "c_top", "branches")],
    ["e3", makeEdge("e3", "root", "c_mid", "branches")],
    ["e4", makeEdge("e4", "lh_1", "c_bot", "challenges")],
    ["e5", makeEdge("e5", "lh_2", "c_bot", "challenges")],
  ]);

  it("navigates parent (H), y-sorted first child (L), and y-sorted siblings (J/K)", () => {
    // L from root chooses top-most y child
    expect(findFirstChildTarget("root", nodes, edges)).toBe("c_top");

    // H from child returns to root
    expect(findParentTarget("c_mid", nodes, edges)).toBe("root");

    // J cycles y-sorted siblings: c_top -> c_mid -> c_bot -> c_top
    expect(findSiblingTarget("c_top", 1, nodes, edges)).toBe("c_mid");
    expect(findSiblingTarget("c_mid", 1, nodes, edges)).toBe("c_bot");
    expect(findSiblingTarget("c_bot", 1, nodes, edges)).toBe("c_top");

    // K cycles backwards: c_top -> c_bot -> c_mid
    expect(findSiblingTarget("c_top", -1, nodes, edges)).toBe("c_bot");
    expect(findSiblingTarget("c_bot", -1, nodes, edges)).toBe("c_mid");
  });

  it("returns from a loophole to its challenged target on H and cycles sibling loopholes on J/K", () => {
    expect(findParentTarget("lh_1", nodes, edges)).toBe("c_bot");
    expect(findSiblingTarget("lh_1", 1, nodes, edges)).toBe("lh_2");
    expect(findSiblingTarget("lh_2", -1, nodes, edges)).toBe("lh_1");
  });

  it("collects full subtree including challenged loopholes for Smart Fit & Fold", () => {
    const sub = collectSubtreeIds("root", nodes, edges);
    expect(new Set(sub)).toEqual(new Set(["root", "c_top", "c_mid", "c_bot", "lh_1", "lh_2"]));
  });
});

import { describe, expect, it } from "vitest";
import { computeDynamicEdgeCurve, nearestPortPair, type NodeRect } from "../renderer2d";

describe("Dynamic 4-side port routing and obstacle bow deflection", () => {
  const src: NodeRect = { x: 0, y: 0, w: 320, h: 180 };

  it("selects opposing cardinal faces across all 360° quadrants", () => {
    // Target to the Right
    const rightPair = nearestPortPair(src, { x: 460, y: 0, w: 320, h: 180 });
    expect({ nx: rightPair.from.nx, ny: rightPair.from.ny }).toEqual({ nx: 1, ny: 0 });
    expect({ nx: rightPair.to.nx, ny: rightPair.to.ny }).toEqual({ nx: -1, ny: 0 });

    // Target to the Left
    const leftPair = nearestPortPair(src, { x: -460, y: 0, w: 320, h: 180 });
    expect({ nx: leftPair.from.nx, ny: leftPair.from.ny }).toEqual({ nx: -1, ny: 0 });
    expect({ nx: leftPair.to.nx, ny: leftPair.to.ny }).toEqual({ nx: 1, ny: 0 });

    // Target Below
    const bottomPair = nearestPortPair(src, { x: 0, y: 280, w: 320, h: 180 });
    expect({ nx: bottomPair.from.nx, ny: bottomPair.from.ny }).toEqual({ nx: 0, ny: 1 });
    expect({ nx: bottomPair.to.nx, ny: bottomPair.to.ny }).toEqual({ nx: 0, ny: -1 });

    // Target Above
    const topPair = nearestPortPair(src, { x: 0, y: -280, w: 320, h: 180 });
    expect({ nx: topPair.from.nx, ny: topPair.from.ny }).toEqual({ nx: 0, ny: -1 });
    expect({ nx: topPair.to.nx, ny: topPair.to.ny }).toEqual({ nx: 0, ny: 1 });
  });

  it("deflects Bezier control points when midpoint crosses a third node", () => {
    const dst: NodeRect = { x: 900, y: 0, w: 320, h: 180 };
    const blocker: NodeRect = { x: 450, y: 0, w: 320, h: 180 };

    const clearCurve = computeDynamicEdgeCurve(src, dst, "src", "dst", [
      { id: "src", rect: src },
      { id: "dst", rect: dst },
    ]);
    const bowedCurve = computeDynamicEdgeCurve(src, dst, "src", "dst", [
      { id: "src", rect: src },
      { id: "dst", rect: dst },
      { id: "blocker", rect: blocker },
    ]);

    expect(Math.abs(bowedCurve.cy1 - clearCurve.cy1)).toBeGreaterThan(80);
    expect(Math.abs(bowedCurve.cy2 - clearCurve.cy2)).toBeGreaterThan(80);
  });
});

import { describe, expect, it } from "vitest";
import {
  clampZoom,
  computeFitTransform,
  MAX_ZOOM,
  MIN_ZOOM,
  screenToWorld,
  worldToScreen,
  zoomAtCursor,
  type CameraTransform,
} from "../camera";

describe("UT-TS-01: camera coordinate math and cursor-anchored zoom", () => {
  it("round-trips screenToWorld(worldToScreen(p)) within 1e-6", () => {
    const cams: CameraTransform[] = [
      { x: 0, y: 0, zoom: 1.0 },
      { x: -342.5, y: 189.25, zoom: 0.45 },
      { x: 1024.75, y: -512.125, zoom: 2.15 },
    ];
    const points = [
      { x: 0, y: 0 },
      { x: 320, y: -180 },
      { x: -1280.5, y: 940.75 },
    ];

    for (const cam of cams) {
      for (const pt of points) {
        const screen = worldToScreen(pt.x, pt.y, cam);
        const back = screenToWorld(screen.x, screen.y, cam);
        expect(Math.abs(back.x - pt.x)).toBeLessThan(1e-6);
        expect(Math.abs(back.y - pt.y)).toBeLessThan(1e-6);
      }
    }
  });

  it("preserves world point under cursor across zoomAtCursor", () => {
    const cam: CameraTransform = { x: 140, y: -85, zoom: 0.9 };
    const mx = 640;
    const my = 410;
    const worldBefore = screenToWorld(mx, my, cam);

    const zoomedIn = zoomAtCursor(cam, mx, my, 1.75);
    const worldAfterIn = screenToWorld(mx, my, zoomedIn);
    expect(Math.abs(worldAfterIn.x - worldBefore.x)).toBeLessThan(1e-6);
    expect(Math.abs(worldAfterIn.y - worldBefore.y)).toBeLessThan(1e-6);

    const zoomedOut = zoomAtCursor(zoomedIn, mx, my, 0.35);
    const worldAfterOut = screenToWorld(mx, my, zoomedOut);
    expect(Math.abs(worldAfterOut.x - worldBefore.x)).toBeLessThan(1e-6);
    expect(Math.abs(worldAfterOut.y - worldBefore.y)).toBeLessThan(1e-6);
  });

  it("clamps zoom within [MIN_ZOOM, MAX_ZOOM]", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(10.0)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1.0);
  });

  it("computes padded fit transform centering target bounds", () => {
    const fit = computeFitTransform(
      { minX: 0, minY: 0, maxX: 640, maxY: 360 },
      1280,
      800,
      80,
    );
    const tl = worldToScreen(0, 0, fit);
    const br = worldToScreen(640, 360, fit);
    expect(tl.x).toBeGreaterThanOrEqual(80 - 1e-6);
    expect(tl.y).toBeGreaterThanOrEqual(80 - 1e-6);
    expect(br.x).toBeLessThanOrEqual(1280 - 80 + 1e-6);
    expect(br.y).toBeLessThanOrEqual(800 - 80 + 1e-6);
    // Center of bounds aligns with center of viewport
    const center = worldToScreen(320, 180, fit);
    expect(Math.abs(center.x - 640)).toBeLessThan(1e-6);
    expect(Math.abs(center.y - 400)).toBeLessThan(1e-6);
  });
});

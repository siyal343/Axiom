// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasCameraController } from "../camera";
import { FrameTimeTracker } from "../perfMetrics";

describe("CanvasCameraController frame telemetry, subscribeFrame & zoom helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("filters multi-second idle gaps out of FPS so FrameTimeTracker does not collapse to 0", () => {
    let nowMs = 1000;
    let drawCounter = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      // Advance 1.5ms during each flushFrame draw measurement.
      drawCounter += 1;
      return drawCounter % 2 === 0 ? nowMs + 1.5 : nowMs;
    });

    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (): void => {});

    const canvas = document.createElement("canvas");
    const tracker = new FrameTimeTracker(120);
    const frameEvents: number[] = [];

    const controller = new CanvasCameraController({
      canvas,
      cardLayerEl: null,
      renderFrame: () => {},
      onViewportCull: () => {},
      onFrameSample: (drawMs, intervalMs) => {
        tracker.record(drawMs, intervalMs);
      },
    });
    const unsub = controller.subscribeFrame((cam) => {
      frameEvents.push(cam.zoom);
    });

    const flushAt = (ts: number): void => {
      nowMs = ts;
      drawCounter = 0;
      controller.markDirty();
      const cb = rafQueue.shift();
      if (cb) cb(ts);
    };

    // Active 60 FPS burst: 16.6ms intervals
    flushAt(1000);
    flushAt(1016.6);
    flushAt(1033.2);
    // Multi-second idle gap (3500ms > 250ms cutoff)
    flushAt(4533.2);
    // Resumed frame at 16.6ms
    flushAt(4549.8);

    const stats = tracker.getStats();
    expect(stats.sampleCount).toBe(5);
    expect(stats.fps).toBeGreaterThan(50);
    expect(stats.fps).toBeLessThanOrEqual(65);
    expect(frameEvents.length).toBe(5);

    controller.zoomByStep(1.15);
    expect(controller.getCamera().zoom).toBeCloseTo(1.15, 3);
    controller.resetZoom();
    expect(controller.getCamera().zoom).toBeCloseTo(1.0, 5);

    unsub();
    controller.dispose();
  });
});

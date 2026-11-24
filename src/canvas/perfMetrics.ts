import { signal } from "@preact/signals";

export interface FrameStats {
  fps: number;
  avgDrawMs: number;
  p95DrawMs: number;
  p95IntervalMs: number;
  sampleCount: number;
}

const DEFAULT_RING_CAPACITY = 120;

function percentile95(sorted: number[]): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx] ?? 0;
}

export class FrameTimeTracker {
  private readonly capacity: number;
  private readonly drawSamples: Float64Array;
  private readonly intervalSamples: Float64Array;
  private writeIdx = 0;
  private count = 0;

  constructor(capacity = DEFAULT_RING_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.drawSamples = new Float64Array(this.capacity);
    this.intervalSamples = new Float64Array(this.capacity);
  }

  record(drawMs: number, intervalMs: number): void {
    const safeDraw = Number.isFinite(drawMs) && drawMs >= 0 ? drawMs : 0;
    const safeInterval = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : 0;
    this.drawSamples[this.writeIdx] = safeDraw;
    this.intervalSamples[this.writeIdx] = safeInterval;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count += 1;
    }
  }

  getStats(): FrameStats {
    if (this.count === 0) {
      return {
        fps: 0,
        avgDrawMs: 0,
        p95DrawMs: 0,
        p95IntervalMs: 0,
        sampleCount: 0,
      };
    }

    const draws: number[] = [];
    const intervals: number[] = [];
    let drawSum = 0;
    let intervalSum = 0;
    let positiveIntervals = 0;

    for (let i = 0; i < this.count; i += 1) {
      const d = this.drawSamples[i] ?? 0;
      const iv = this.intervalSamples[i] ?? 0;
      draws.push(d);
      drawSum += d;
      if (iv > 0) {
        intervals.push(iv);
        intervalSum += iv;
        positiveIntervals += 1;
      }
    }

    draws.sort((a, b) => a - b);
    intervals.sort((a, b) => a - b);

    const avgDrawMs = drawSum / this.count;
    const avgIntervalMs = positiveIntervals > 0 ? intervalSum / positiveIntervals : 0;
    const fps = avgIntervalMs > 0 ? 1000 / avgIntervalMs : 0;

    return {
      fps,
      avgDrawMs,
      p95DrawMs: percentile95(draws),
      p95IntervalMs: percentile95(intervals),
      sampleCount: this.count,
    };
  }

  reset(): void {
    this.writeIdx = 0;
    this.count = 0;
    this.drawSamples.fill(0);
    this.intervalSamples.fill(0);
  }
}

export const globalFrameTracker = new FrameTimeTracker(DEFAULT_RING_CAPACITY);
export const perfHudOpen = signal<boolean>(false);

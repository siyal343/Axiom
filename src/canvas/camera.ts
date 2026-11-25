import type { BBox } from "rbush";
import type { CameraState } from "../ipc/types";
import { isBirdsEye, type CameraControllerHandle } from "../store/graphStore";

export const MIN_ZOOM = 0.12;
export const MAX_ZOOM = 2.5;
export const LOD_THRESHOLD = 0.45;
export const CULL_MOVE_THRESHOLD_PX = 80;

export interface Point {
  x: number;
  y: number;
}

export interface CameraTransform {
  x: number;
  y: number;
  zoom: number;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) {
    return 1.0;
  }
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function worldToScreen(wx: number, wy: number, cam: CameraTransform): Point {
  return {
    x: wx * cam.zoom + cam.x,
    y: wy * cam.zoom + cam.y,
  };
}

export function screenToWorld(sx: number, sy: number, cam: CameraTransform): Point {
  return {
    x: (sx - cam.x) / cam.zoom,
    y: (sy - cam.y) / cam.zoom,
  };
}

export function zoomAtCursor(
  cam: CameraTransform,
  mx: number,
  my: number,
  nextZoom: number,
): CameraTransform {
  const clamped = clampZoom(nextZoom);
  const wx = (mx - cam.x) / cam.zoom;
  const wy = (my - cam.y) / cam.zoom;
  return {
    x: mx - wx * clamped,
    y: my - wy * clamped,
    zoom: clamped,
  };
}

export function computeFitTransform(
  bounds: BBox,
  viewportWidth: number,
  viewportHeight: number,
  padding = 80,
): CameraTransform {
  const boxW = Math.max(1, bounds.maxX - bounds.minX);
  const boxH = Math.max(1, bounds.maxY - bounds.minY);
  const availW = Math.max(1, viewportWidth - padding * 2);
  const availH = Math.max(1, viewportHeight - padding * 2);
  const zoom = clampZoom(Math.min(availW / boxW, availH / boxH));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    x: viewportWidth / 2 - cx * zoom,
    y: viewportHeight / 2 - cy * zoom,
    zoom,
  };
}

export interface CameraControllerOptions {
  canvas: HTMLCanvasElement;
  cardLayerEl: HTMLElement | null;
  renderFrame: (
    ctx: CanvasRenderingContext2D,
    cam: CameraState,
    width: number,
    height: number,
  ) => void;
  onViewportCull: (bounds: BBox, zoom: number, birdsEye: boolean) => void;
  onSaveCamera?: (cam: CameraState) => void;
  onFrameSample?: (drawMs: number, intervalMs: number) => void;
  initialCamera?: CameraState;
}

export class CanvasCameraController implements CameraControllerHandle {
  private readonly canvas: HTMLCanvasElement;
  private cardLayerEl: HTMLElement | null;
  private readonly renderFrame: CameraControllerOptions["renderFrame"];
  private readonly onViewportCull: CameraControllerOptions["onViewportCull"];
  private readonly onSaveCamera?: CameraControllerOptions["onSaveCamera"];
  private readonly onFrameSample?: CameraControllerOptions["onFrameSample"];
  private readonly frameListeners = new Set<(cam: CameraTransform) => void>();
  private lastFrameStartAt: number | null = null;

  private cam: CameraState;
  private width = 1280;
  private height = 800;
  private rafId: number | null = null;
  private animRafId: number | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private continuousAnimation = false;
  private disposed = false;

  private lastCullX = Number.NaN;
  private lastCullY = Number.NaN;
  private lastCullZoom = Number.NaN;

  private readonly onVisibilityChange = (): void => {
    if (
      this.continuousAnimation &&
      !this.disposed &&
      typeof document !== "undefined" &&
      !document.hidden
    ) {
      this.markDirty();
    }
  };

  constructor(options: CameraControllerOptions) {
    this.canvas = options.canvas;
    this.cardLayerEl = options.cardLayerEl;
    this.renderFrame = options.renderFrame;
    this.onViewportCull = options.onViewportCull;
    this.onSaveCamera = options.onSaveCamera;
    this.onFrameSample = options.onFrameSample;
    this.cam = options.initialCamera
      ? {
          ...options.initialCamera,
          zoom: clampZoom(options.initialCamera.zoom),
        }
      : { x: 0, y: 0, zoom: 1.0, last_focus_id: null };
    isBirdsEye.value = this.cam.zoom < LOD_THRESHOLD;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  setContinuousAnimation(enabled: boolean): void {
    if (this.continuousAnimation === enabled) {
      return;
    }
    this.continuousAnimation = enabled;
    if (enabled && !this.disposed && (typeof document === "undefined" || !document.hidden)) {
      this.markDirty();
    }
  }

  setCardLayerEl(el: HTMLElement | null): void {
    this.cardLayerEl = el;
    if (el) {
      el.style.transform = `translate3d(${this.cam.x}px, ${this.cam.y}px, 0) scale(${this.cam.zoom})`;
    }
  }

  setSize(width: number, height: number): void {
    const nextW = Math.max(1, Math.floor(width));
    const nextH = Math.max(1, Math.floor(height));
    if (nextW === this.width && nextH === this.height) {
      return;
    }
    this.width = nextW;
    this.height = nextH;
    this.refreshCull();
    this.markDirty();
  }

  getCamera(): CameraState {
    return { ...this.cam };
  }

  getViewportSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  subscribeFrame(listener: (cam: CameraTransform) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  zoomByStep(factor: number): void {
    this.zoomAt(this.width / 2, this.height / 2, this.cam.zoom * factor);
  }

  resetZoom(): void {
    this.zoomAt(this.width / 2, this.height / 2, 1.0);
  }

  setCamera(cam: CameraState): void {
    this.cancelAnimation();
    this.cam = {
      ...cam,
      zoom: clampZoom(cam.zoom),
    };
    isBirdsEye.value = this.cam.zoom < LOD_THRESHOLD;
    this.lastCullX = Number.NaN;
    this.lastCullY = Number.NaN;
    this.lastCullZoom = Number.NaN;
    this.markDirty();
  }

  panBy(dx: number, dy: number): void {
    this.cancelAnimation();
    this.cam.x += dx;
    this.cam.y += dy;
    this.markDirty();
    this.scheduleSaveCamera();
  }

  zoomAt(mx: number, my: number, nextZoom: number): void {
    this.cancelAnimation();
    const next = zoomAtCursor(this.cam, mx, my, nextZoom);
    this.cam.x = next.x;
    this.cam.y = next.y;
    this.cam.zoom = next.zoom;
    isBirdsEye.value = this.cam.zoom < LOD_THRESHOLD;
    this.markDirty();
    this.scheduleSaveCamera();
  }

  animateTo(targetCam: CameraTransform, durationMs = 220): void {
    this.cancelAnimation();
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      this.cam.x = targetCam.x;
      this.cam.y = targetCam.y;
      this.cam.zoom = clampZoom(targetCam.zoom);
      isBirdsEye.value = this.cam.zoom < LOD_THRESHOLD;
      this.markDirty();
      this.refreshCull();
      this.scheduleSaveCamera();
      return;
    }

    const startX = this.cam.x;
    const startY = this.cam.y;
    const startZoom = this.cam.zoom;
    const endZoom = clampZoom(targetCam.zoom);
    const startTime = performance.now();

    const step = (now: number): void => {
      const t = Math.min(1, (now - startTime) / Math.max(1, durationMs));
      const eased = 1 - Math.pow(1 - t, 3);
      this.cam.x = startX + (targetCam.x - startX) * eased;
      this.cam.y = startY + (targetCam.y - startY) * eased;
      this.cam.zoom = startZoom + (endZoom - startZoom) * eased;
      isBirdsEye.value = this.cam.zoom < LOD_THRESHOLD;
      this.markDirty();

      if (t < 1) {
        this.animRafId = requestAnimationFrame(step);
      } else {
        this.animRafId = null;
        this.refreshCull();
        this.scheduleSaveCamera();
      }
    };

    this.animRafId = requestAnimationFrame(step);
  }

  refreshCull(): void {
    const topLeft = screenToWorld(0, 0, this.cam);
    const bottomRight = screenToWorld(this.width, this.height, this.cam);
    const bounds: BBox = {
      minX: topLeft.x,
      minY: topLeft.y,
      maxX: bottomRight.x,
      maxY: bottomRight.y,
    };
    const birdsEye = this.cam.zoom < LOD_THRESHOLD;
    isBirdsEye.value = birdsEye;
    this.lastCullX = this.cam.x;
    this.lastCullY = this.cam.y;
    this.lastCullZoom = this.cam.zoom;
    this.onViewportCull(bounds, this.cam.zoom, birdsEye);
  }

  markDirty(): void {
    if (this.rafId !== null) {
      return;
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.flushFrame();
    });
  }

  private flushFrame(): void {
    const frameStart = performance.now();
    const intervalMs =
      this.lastFrameStartAt === null ? 0 : Math.max(0, frameStart - this.lastFrameStartAt);
    this.lastFrameStartAt = frameStart;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const targetW = Math.max(1, Math.round(this.width * dpr));
    const targetH = Math.max(1, Math.round(this.height * dpr));
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.renderFrame(ctx, this.cam, this.width, this.height);
    }

    if (this.cardLayerEl) {
      this.cardLayerEl.style.transform = `translate3d(${this.cam.x}px, ${this.cam.y}px, 0) scale(${this.cam.zoom})`;
    }

    if (this.frameListeners.size > 0) {
      const snap: CameraTransform = { x: this.cam.x, y: this.cam.y, zoom: this.cam.zoom };
      for (const listener of this.frameListeners) {
        listener(snap);
      }
    }

    const movedEnough =
      Number.isNaN(this.lastCullX) ||
      Math.hypot(this.cam.x - this.lastCullX, this.cam.y - this.lastCullY) >
        CULL_MOVE_THRESHOLD_PX;
    const crossedLod =
      Number.isNaN(this.lastCullZoom) ||
      (this.cam.zoom < LOD_THRESHOLD) !== (this.lastCullZoom < LOD_THRESHOLD);
    const zoomedEnough =
      Number.isNaN(this.lastCullZoom) ||
      Math.abs(this.cam.zoom - this.lastCullZoom) / this.lastCullZoom > 0.12;

    if (movedEnough || crossedLod || zoomedEnough) {
      this.refreshCull();
    }

    if (this.onFrameSample) {
      const drawMs = Math.max(0, performance.now() - frameStart);
      const activeIntervalMs = intervalMs > 0 && intervalMs <= 250 ? intervalMs : 0;
      this.onFrameSample(drawMs, activeIntervalMs);
    }

    if (
      this.continuousAnimation &&
      !this.disposed &&
      (typeof document === "undefined" || !document.hidden)
    ) {
      this.markDirty();
    }
  }

  private scheduleSaveCamera(): void {
    if (!this.onSaveCamera) {
      return;
    }
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.onSaveCamera?.(this.getCamera());
    }, 1000);
  }

  private cancelAnimation(): void {
    if (this.animRafId !== null) {
      cancelAnimationFrame(this.animRafId);
      this.animRafId = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.continuousAnimation = false;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.frameListeners.clear();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.cancelAnimation();
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }
}

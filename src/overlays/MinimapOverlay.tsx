import { useEffect, useRef } from "preact/hooks";
import { screenToWorld, type CameraTransform } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import { resolveNodeTone } from "../cards/nodeAccent";
import {
  cameraControllerRef,
  dragOffsets,
  graphVersion,
  nodesMap,
  resizeSizes,
  theme,
  unresolvedLoopholes,
} from "../store/graphStore";
import { focusId, minimapOpen, selectedIds } from "../store/selection";

const MINIMAP_W = 184;
const MINIMAP_H = 112;
const MINIMAP_PAD = 8;

interface MinimapTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

function computeMinimapTransform(): MinimapTransform | null {
  if (nodesMap.size === 0) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodesMap.values()) {
    const offset = dragOffsets.get(node.id);
    const resized = resizeSizes.get(node.id);
    const x = node.layout.x + (offset?.x ?? 0);
    const y = node.layout.y + (offset?.y ?? 0);
    const w = resized ? resized.width : node.layout.width;
    const h = node.layout.collapsed
      ? getEffectiveNodeHeight(node)
      : resized
        ? resized.height
        : node.layout.height;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  if (!Number.isFinite(minX)) {
    return null;
  }

  const worldPad = 48;
  minX -= worldPad;
  minY -= worldPad;
  maxX += worldPad;
  maxY += worldPad;

  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxY - minY);
  const availW = MINIMAP_W - MINIMAP_PAD * 2;
  const availH = MINIMAP_H - MINIMAP_PAD * 2;
  const scale = Math.min(availW / worldW, availH / worldH);
  const offsetX = (MINIMAP_W - worldW * scale) * 0.5 - minX * scale;
  const offsetY = (MINIMAP_H - worldH * scale) * 0.5 - minY * scale;

  return { scale, offsetX, offsetY };
}

function drawMinimap(canvas: HTMLCanvasElement, cam: CameraTransform): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const targetW = Math.round(MINIMAP_W * dpr);
  const targetH = Math.round(MINIMAP_H * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const isLight = theme.value === "light";
  ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
  ctx.fillStyle = isLight ? "rgba(255, 255, 255, 0.86)" : "rgba(18, 21, 27, 0.88)";
  ctx.fillRect(0, 0, MINIMAP_W, MINIMAP_H);

  const xform = computeMinimapTransform();
  if (!xform) {
    return;
  }

  const activeSelected = selectedIds.value;
  const activeFocus = focusId.value;
  const loopholes = unresolvedLoopholes.value;

  for (const node of nodesMap.values()) {
    const offset = dragOffsets.get(node.id);
    const resized = resizeSizes.get(node.id);
    const nx = node.layout.x + (offset?.x ?? 0);
    const ny = node.layout.y + (offset?.y ?? 0);
    const nw = resized ? resized.width : node.layout.width;
    const nh = node.layout.collapsed
      ? getEffectiveNodeHeight(node)
      : resized
        ? resized.height
        : node.layout.height;

    const rx = nx * xform.scale + xform.offsetX;
    const ry = ny * xform.scale + xform.offsetY;
    const rw = Math.max(3, nw * xform.scale);
    const rh = Math.max(2, nh * xform.scale);

    const tone = resolveNodeTone(node);
    const fill = isLight ? tone.colorLight : tone.colorDark;
    const isSelected = activeSelected.has(node.id);
    const isFocused = activeFocus === node.id;

    ctx.save();
    ctx.globalAlpha =
      node.type === "loophole" && (node.status === "resolved" || node.status === "dismissed")
        ? 0.35
        : isFocused || isSelected
          ? 0.95
          : 0.72;
    ctx.fillStyle = fill;
    ctx.fillRect(rx, ry, rw, rh);

    if (isFocused || isSelected) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = isFocused
        ? isLight
          ? "#111827"
          : "#f8fafc"
        : isLight
          ? "#334155"
          : "#cbd5e1";
      ctx.lineWidth = isFocused ? 1.5 : 1;
      ctx.strokeRect(rx, ry, rw, rh);
    }

    const lh = loopholes.get(node.id);
    if (lh && lh.count > 0) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = isLight ? "#dc2626" : "#ef4444";
      ctx.beginPath();
      ctx.arc(rx + rw, ry, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Live viewport rectangle
  const vp = cameraControllerRef.current?.getViewportSize() ?? {
    width: typeof window !== "undefined" ? window.innerWidth : 1280,
    height: typeof window !== "undefined" ? window.innerHeight : 800,
  };
  const tl = screenToWorld(0, 0, cam);
  const br = screenToWorld(vp.width, vp.height, cam);
  const vx = tl.x * xform.scale + xform.offsetX;
  const vy = tl.y * xform.scale + xform.offsetY;
  const vw = Math.max(4, (br.x - tl.x) * xform.scale);
  const vh = Math.max(4, (br.y - tl.y) * xform.scale);

  ctx.save();
  ctx.fillStyle = isLight ? "rgba(37, 99, 235, 0.08)" : "rgba(96, 165, 250, 0.12)";
  ctx.strokeStyle = isLight ? "#2563eb" : "#60a5fa";
  ctx.lineWidth = 1.25;
  ctx.fillRect(vx, vy, vw, vh);
  ctx.strokeRect(vx, vy, vw, vh);
  ctx.restore();
}

export function MinimapOverlay() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);

  const open = minimapOpen.value;
  const version = graphVersion.value;
  const selected = selectedIds.value;
  const focused = focusId.value;
  const loopholes = unresolvedLoopholes.value;
  const currentTheme = theme.value;

  const visible = open && nodesMap.size > 0;

  useEffect(() => {
    if (!visible) {
      return;
    }
    const canvas = canvasRef.current;
    const ctrl = cameraControllerRef.current;
    if (!canvas) {
      return;
    }
    const initialCam = ctrl?.getCamera() ?? { x: 0, y: 0, zoom: 1, last_focus_id: null };
    drawMinimap(canvas, initialCam);

    if (!ctrl?.subscribeFrame) {
      return;
    }
    return ctrl.subscribeFrame((cam) => {
      if (canvasRef.current) {
        drawMinimap(canvasRef.current, cam);
      }
    });
  }, [visible, version, selected, focused, loopholes, currentTheme]);

  if (!visible) {
    return null;
  }

  const panToPointer = (clientX: number, clientY: number): void => {
    const canvas = canvasRef.current;
    const ctrl = cameraControllerRef.current;
    if (!canvas || !ctrl) {
      return;
    }
    const xform = computeMinimapTransform();
    if (!xform) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const wx = (mx - xform.offsetX) / xform.scale;
    const wy = (my - xform.offsetY) / xform.scale;
    const cam = ctrl.getCamera();
    const vp = ctrl.getViewportSize();
    ctrl.setCamera({
      ...cam,
      x: vp.width * 0.5 - wx * cam.zoom,
      y: vp.height * 0.5 - wy * cam.zoom,
    });
  };

  return (
    <aside
      class="minimap-card"
      aria-label="Graph minimap"
      style={{
        position: "fixed",
        right: "14px",
        bottom: "56px",
        width: `${MINIMAP_W}px`,
        height: `${MINIMAP_H}px`,
        borderRadius: "var(--radius-card)",
        border: "1px solid var(--border-strong)",
        background: "var(--bg-pill)",
        boxShadow: "var(--shadow-card)",
        backdropFilter: "blur(8px)",
        overflow: "hidden",
        zIndex: 35,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <canvas
        ref={canvasRef}
        class="minimap-card__canvas"
        width={MINIMAP_W}
        height={MINIMAP_H}
        style={{
          display: "block",
          width: `${MINIMAP_W}px`,
          height: `${MINIMAP_H}px`,
          cursor: "crosshair",
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          draggingRef.current = true;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Synthetic events may lack pointer capture support
          }
          panToPointer(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) {
            return;
          }
          panToPointer(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          if (!draggingRef.current) {
            return;
          }
          draggingRef.current = false;
          if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
      />
    </aside>
  );
}

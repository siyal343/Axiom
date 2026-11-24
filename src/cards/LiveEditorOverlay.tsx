import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef, useState } from "preact/hooks";
import { type CameraTransform, worldToScreen } from "../canvas/camera";
import { cameraControllerRef, mutateGraphUndoable, nodesMap } from "../store/graphStore";
import { buildUpdateTextWithInverse } from "../store/history";
import { exitEditMode, focusId, modalState } from "../store/selection";
import { getRenderedMarkdown } from "./markdownCache";

const monochromeEditorTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--text-primary)",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
  },
  ".cm-content": {
    padding: "8px 0",
    caretColor: "var(--ring-edit)",
  },
  ".cm-line": {
    lineHeight: "1.5",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(96, 165, 250, 0.28)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--ring-edit)",
  },
});

interface OverlayRect {
  left: number;
  top: number;
  width: number;
  minHeight: number;
}

function computeOverlayRect(
  worldX: number,
  worldY: number,
  worldW: number,
  worldH: number,
  cam: CameraTransform,
): OverlayRect {
  const screenPos = worldToScreen(worldX, worldY, cam);
  const width = Math.max(320, Math.min(560, Math.round(worldW * Math.max(0.85, cam.zoom))));
  const minHeight = Math.max(180, Math.round(worldH * Math.max(0.85, cam.zoom)));
  const maxLeft =
    typeof window !== "undefined" ? Math.max(16, window.innerWidth - width - 16) : 900;
  const maxTop =
    typeof window !== "undefined" ? Math.max(16, window.innerHeight - minHeight - 16) : 600;
  return {
    left: Math.max(16, Math.min(maxLeft, screenPos.x)),
    top: Math.max(16, Math.min(maxTop, screenPos.y)),
    width,
    minHeight,
  };
}

export function LiveEditorOverlay() {
  const mode = modalState.value;
  const activeId = focusId.value;
  const node = mode === "edit" && activeId ? nodesMap.get(activeId) : undefined;

  if (!node) {
    return null;
  }

  return (
    <LiveEditorInstance
      key={node.id}
      nodeId={node.id}
      initialTitle={node.title}
      initialContent={node.content}
      worldX={node.layout.x}
      worldY={node.layout.y}
      worldW={node.layout.width}
      worldH={node.layout.height}
    />
  );
}

interface LiveEditorInstanceProps {
  nodeId: string;
  initialTitle: string;
  initialContent: string;
  worldX: number;
  worldY: number;
  worldW: number;
  worldH: number;
}

function LiveEditorInstance({
  nodeId,
  initialTitle,
  initialContent,
  worldX,
  worldY,
  worldW,
  worldH,
}: LiveEditorInstanceProps) {
  const [title, setTitle] = useState(initialTitle);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const cmHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const titleValRef = useRef(initialTitle);
  const committedRef = useRef(false);

  titleValRef.current = title;

  const commitAndExit = (openChordAfter = false): void => {
    if (committedRef.current) {
      return;
    }
    committedRef.current = true;
    const nextTitle = titleValRef.current;
    const nextContent = viewRef.current ? viewRef.current.state.doc.toString() : initialContent;

    if (nextTitle !== initialTitle || nextContent !== initialContent) {
      // Pre-warm static markdown cache and persist atomically.
      const current = nodesMap.get(nodeId);
      if (current) {
        getRenderedMarkdown(current.content_hash, nextContent);
        const { forward, inverse } = buildUpdateTextWithInverse(current, nextTitle, nextContent);
        void mutateGraphUndoable("Edit node text", forward, inverse);
      }
    }

    exitEditMode();
    if (openChordAfter) {
      focusId.value = nodeId;
      modalState.value = "chord_a";
    }
  };

  useEffect(() => {
    const host = cmHostRef.current;
    if (!host) {
      return;
    }

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        history(),
        markdown(),
        EditorView.lineWrapping,
        monochromeEditorTheme,
        keymap.of([...defaultKeymap, ...historyKeymap]),
      ],
    });

    const view = new EditorView({
      state,
      parent: host,
    });
    viewRef.current = view;

    const focusInitialTarget = (): void => {
      if (
        initialContent.trim() === "" &&
        (initialTitle === "New Concept" || initialTitle === "New Node")
      ) {
        titleRef.current?.focus();
        titleRef.current?.select();
      } else {
        view.focus();
      }
    };

    let focusRafId: number | null = null;
    if (typeof requestAnimationFrame === "function") {
      focusRafId = requestAnimationFrame(() => {
        focusRafId = null;
        focusInitialTarget();
      });
    } else {
      focusInitialTarget();
    }

    const onWindowKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        commitAndExit(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        commitAndExit(true);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      if (focusRafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(focusRafId);
      }
      window.removeEventListener("keydown", onWindowKeyDown, true);
      view.destroy();
      viewRef.current = null;
    };
  }, [nodeId]);

  useEffect(() => {
    const ctrl = cameraControllerRef.current;
    if (!ctrl?.subscribeFrame) {
      return;
    }
    return ctrl.subscribeFrame((nextCam) => {
      const el = overlayRef.current;
      if (!el) {
        return;
      }
      const rect = computeOverlayRect(worldX, worldY, worldW, worldH, nextCam);
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.width = `${rect.width}px`;
      el.style.minHeight = `${rect.minHeight}px`;
    });
  }, [nodeId, worldX, worldY, worldW, worldH]);

  const cam = cameraControllerRef.current?.getCamera() ?? {
    x: 0,
    y: 0,
    zoom: 1,
    last_focus_id: null,
  };
  const initialRect = computeOverlayRect(worldX, worldY, worldW, worldH, cam);

  return (
    <div
      ref={overlayRef}
      class="live-editor-overlay"
      role="dialog"
      aria-label="Edit node"
      style={{
        left: `${initialRect.left}px`,
        top: `${initialRect.top}px`,
        width: `${initialRect.width}px`,
        minHeight: `${initialRect.minHeight}px`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={titleRef}
        type="text"
        class="live-editor-overlay__title"
        aria-label="Node title"
        value={title}
        placeholder="Node title..."
        onInput={(e) => setTitle(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Tab" || e.key === "ArrowDown") {
            e.preventDefault();
            viewRef.current?.focus();
          }
        }}
      />
      <div ref={cmHostRef} class="live-editor-overlay__body" />
      <div class="live-editor-overlay__hint">Esc save &amp; exit · Ctrl/Cmd+Enter commit</div>
    </div>
  );
}

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef, useState } from "preact/hooks";
import { worldToScreen } from "../canvas/camera";
import { cameraControllerRef, mutateGraph, nodesMap } from "../store/graphStore";
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

export function LiveEditorOverlay() {
  const mode = modalState.value;
  const activeId = focusId.value;
  const node = mode === "edit" && activeId ? nodesMap.get(activeId) : undefined;

  if (!node) {
    return null;
  }

  return <LiveEditorInstance key={node.id} nodeId={node.id} initialTitle={node.title} initialContent={node.content} worldX={node.layout.x} worldY={node.layout.y} worldW={node.layout.width} worldH={node.layout.height} />;
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
  const titleRef = useRef<HTMLInputElement | null>(null);
  const cmHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const titleValRef = useRef(initialTitle);
  const committedRef = useRef(false);

  titleValRef.current = title;

  const commitAndClose = (): void => {
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
      }
      void mutateGraph([
        {
          op: "update_node_text",
          id: nodeId,
          title: nextTitle,
          content: nextContent,
        },
      ]);
    }

    exitEditMode();
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
    view.focus();

    const onWindowKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        commitAndClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        commitAndClose();
      }
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
      view.destroy();
      viewRef.current = null;
    };
  }, [nodeId]);

  const cam = cameraControllerRef.current?.getCamera() ?? {
    x: 0,
    y: 0,
    zoom: 1,
    last_focus_id: null,
  };
  const screenPos = worldToScreen(worldX, worldY, cam);
  const widthPx = Math.max(320, Math.min(560, Math.round(worldW * Math.max(0.85, cam.zoom))));
  const minHeightPx = Math.max(180, Math.round(worldH * Math.max(0.85, cam.zoom)));
  const maxLeft = typeof window !== "undefined" ? Math.max(16, window.innerWidth - widthPx - 16) : 900;
  const maxTop = typeof window !== "undefined" ? Math.max(16, window.innerHeight - minHeightPx - 16) : 600;
  const left = Math.max(16, Math.min(maxLeft, screenPos.x));
  const top = Math.max(16, Math.min(maxTop, screenPos.y));

  return (
    <div
      class="live-editor-overlay"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${widthPx}px`,
        minHeight: `${minHeightPx}px`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={titleRef}
        type="text"
        class="live-editor-overlay__title"
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

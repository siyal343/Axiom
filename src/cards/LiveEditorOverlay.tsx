import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef, useState } from "preact/hooks";
import { type CameraTransform, worldToScreen } from "../canvas/camera";
import {
  extractActionTagFromContent,
  filterActionTags,
  type ActionTagDef,
  type ExtractedActionTag,
} from "../input/actionTags";
import { executeActionTag } from "../store/aiRunner";
import { cameraControllerRef, mutateGraphUndoable, nodesMap } from "../store/graphStore";
import { buildUpdateTextWithInverse } from "../store/history";
import { exitEditMode, focusId, modalState, selectSingle } from "../store/selection";
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

interface TagAutocompleteState {
  from: number;
  to: number;
  items: ActionTagDef[];
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
  const [tagMenu, setTagMenu] = useState<TagAutocompleteState | null>(null);
  const [tagActiveIndex, setTagActiveIndex] = useState(0);
  const [detectedTag, setDetectedTag] = useState<ExtractedActionTag | null>(() =>
    extractActionTagFromContent(initialContent),
  );
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const cmHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const titleValRef = useRef(initialTitle);
  const committedRef = useRef(false);
  const tagMenuRef = useRef<TagAutocompleteState | null>(null);
  const tagActiveIndexRef = useRef(0);

  titleValRef.current = title;
  tagMenuRef.current = tagMenu;
  tagActiveIndexRef.current = tagActiveIndex;

  const insertTag = (def: ActionTagDef): void => {
    const view = viewRef.current;
    const menu = tagMenuRef.current;
    if (!view || !menu) {
      return;
    }
    const insertion = `${def.tag} `;
    view.dispatch({
      changes: { from: menu.from, to: menu.to, insert: insertion },
      selection: { anchor: menu.from + insertion.length },
    });
    view.focus();
    setTagMenu(null);
    setTagActiveIndex(0);
  };

  const commitAndExit = (afterAction: "none" | "run_or_chord" = "none"): void => {
    if (committedRef.current) {
      return;
    }
    committedRef.current = true;
    const nextTitle = titleValRef.current;
    const nextContent = viewRef.current ? viewRef.current.state.doc.toString() : initialContent;

    let savePromise: Promise<unknown> = Promise.resolve();
    if (nextTitle !== initialTitle || nextContent !== initialContent) {
      // Pre-warm static markdown cache and persist atomically.
      const current = nodesMap.get(nodeId);
      if (current) {
        getRenderedMarkdown(current.content_hash, nextContent);
        const { forward, inverse } = buildUpdateTextWithInverse(current, nextTitle, nextContent);
        savePromise = mutateGraphUndoable("Edit node text", forward, inverse);
      }
    }

    exitEditMode();
    if (afterAction === "run_or_chord") {
      selectSingle(nodeId);
      const latestDetected = extractActionTagFromContent(nextContent);
      if (latestDetected) {
        void savePromise.then(() =>
          executeActionTag(latestDetected.action, latestDetected.argument),
        );
      } else {
        modalState.value = "chord_a";
      }
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
        EditorView.updateListener.of((update) => {
          if (!update.docChanged && !update.selectionSet) {
            return;
          }
          if (update.docChanged) {
            setDetectedTag(extractActionTagFromContent(update.state.doc.toString()));
          }

          const sel = update.state.selection.main;
          if (!sel.empty) {
            if (tagMenuRef.current !== null) {
              setTagMenu(null);
              setTagActiveIndex(0);
            }
            return;
          }

          const line = update.state.doc.lineAt(sel.head);
          const beforeCursor = line.text.slice(0, sel.head - line.from);
          const match = beforeCursor.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
          if (!match) {
            if (tagMenuRef.current !== null) {
              setTagMenu(null);
              setTagActiveIndex(0);
            }
            return;
          }

          const tokenQuery = match[1] ?? "";
          const filtered = filterActionTags(tokenQuery);
          if (filtered.length === 0) {
            if (tagMenuRef.current !== null) {
              setTagMenu(null);
              setTagActiveIndex(0);
            }
            return;
          }

          const tokenFrom = sel.head - tokenQuery.length - 1;
          setTagMenu({ from: tokenFrom, to: sel.head, items: filtered });
          setTagActiveIndex(0);
        }),
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
        commitAndExit("none");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        commitAndExit("run_or_chord");
        return;
      }

      const activeMenu = tagMenuRef.current;
      if (
        activeMenu &&
        activeMenu.items.length > 0 &&
        document.activeElement !== titleRef.current
      ) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          setTagActiveIndex((prev) => (prev + 1) % activeMenu.items.length);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          setTagActiveIndex(
            (prev) => (prev - 1 + activeMenu.items.length) % activeMenu.items.length,
          );
        } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          const chosen = activeMenu.items[tagActiveIndexRef.current] ?? activeMenu.items[0];
          if (chosen) {
            insertTag(chosen);
          }
        }
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
      {tagMenu && tagMenu.items.length > 0 && (
        <div class="editor-tag-menu" role="listbox" aria-label="Action tags">
          {tagMenu.items.map((def, idx) => (
            <button
              key={def.tag}
              type="button"
              role="option"
              aria-selected={idx === tagActiveIndex}
              class={`editor-tag-menu__item ${
                idx === tagActiveIndex ? "editor-tag-menu__item--active" : ""
              }`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setTagActiveIndex(idx)}
              onClick={() => insertTag(def)}
            >
              <span class="editor-tag-menu__tag">{def.tag}</span>
              <span class="editor-tag-menu__desc">{def.description}</span>
            </button>
          ))}
        </div>
      )}
      <div class="live-editor-overlay__hint">
        <span>
          Esc save &amp; exit · Ctrl/Cmd+Enter{" "}
          {detectedTag ? `run ${detectedTag.action.tag}` : "AI lens"}
        </span>
        {detectedTag && (
          <button
            type="button"
            class="live-editor-overlay__run-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commitAndExit("run_or_chord")}
          >
            Run {detectedTag.action.tag}
          </button>
        )}
      </div>
    </div>
  );
}

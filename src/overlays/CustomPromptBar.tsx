import { useEffect, useRef, useState } from "preact/hooks";
import { worldToScreen } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import { parseActionTagInvocation } from "../input/actionTags";
import {
  closeCustomPromptBar,
  customPromptOpen,
  executeActionTag,
  triggerLens,
} from "../store/aiRunner";
import { cameraControllerRef, nodesMap } from "../store/graphStore";
import { focusId, modalState } from "../store/selection";

export function CustomPromptBar() {
  const isOpen = modalState.value === "command" && customPromptOpen.value;
  const [prompt, setPrompt] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setPrompt("");
    queueMicrotask(() => {
      inputRef.current?.focus();
    });
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  let stylePos: { left: string; top: string; transform?: string } = {
    left: "50%",
    top: "65%",
    transform: "translateX(-50%)",
  };

  const fid = focusId.value;
  const node = fid ? nodesMap.get(fid) : undefined;
  const ctrl = cameraControllerRef.current;
  if (node && ctrl) {
    const cam = ctrl.getCamera();
    const { width, height } = ctrl.getViewportSize();
    const screenPos = worldToScreen(
      node.layout.x,
      node.layout.y + getEffectiveNodeHeight(node),
      cam,
    );
    const barW = 440;
    const left = Math.max(16, Math.min(width - barW - 16, screenPos.x));
    const top = Math.max(16, Math.min(height - 72, screenPos.y + 10));
    stylePos = { left: `${left}px`, top: `${top}px` };
  }

  const submit = (): void => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }
    closeCustomPromptBar();
    const parsed = parseActionTagInvocation(trimmed);
    if (parsed) {
      void executeActionTag(parsed.action, parsed.argument);
      return;
    }
    void triggerLens("custom", trimmed);
  };

  return (
    <div
      class="custom-prompt-bar"
      style={stylePos}
      role="dialog"
      aria-modal="true"
      aria-label="Custom AI Prompt"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        class="custom-prompt-bar__input"
        value={prompt}
        placeholder="Ask AI or type @Feynman, @Study, @Research, @RedTeam, @Triage..."
        onInput={(e) => setPrompt(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeCustomPromptBar();
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            submit();
          }
        }}
      />
      <button type="button" class="custom-prompt-bar__btn" onClick={submit}>
        Run
      </button>
    </div>
  );
}

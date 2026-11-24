import { useEffect, useRef, useState } from "preact/hooks";
import type { NodeDto } from "../ipc/types";
import {
  cardDomRefs,
  dragOffsets,
  edgesMap,
  mutateGraphUndoable,
  nodesMap,
  queueNodeResize,
  spawnChild,
  unresolvedLoopholes,
} from "../store/graphStore";
import {
  buildDeleteWithInverse,
  buildUpdateMetaWithInverse,
  type NodeMetaPatch,
} from "../store/history";
import {
  enterEditMode,
  focusId,
  hoveredId,
  isInteracting,
  lockedShakeId,
  modalState,
  selectedIds,
  xrayState,
} from "../store/selection";
import { getRenderedMarkdown, renderMarkdownToSanitizedHtml } from "./markdownCache";

interface NodeCardProps {
  node: NodeDto;
}

export function NodeCard({ node }: NodeCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const isFocused = focusId.value === node.id;
  const isSelected = selectedIds.value.has(node.id);
  const isShaking = lockedShakeId.value === node.id;
  const isHovered = hoveredId.value === node.id;
  const interacting = isInteracting.value;
  const xray = xrayState.value;
  const loopholeInfo = unresolvedLoopholes.value.get(node.id);

  const xrayMode = xray ? xray.node_modes[node.id] : undefined;
  const isXrayDimmed = xray !== null && xrayMode === undefined;
  const showHoverPill =
    !interacting &&
    modalState.value === "navigate" &&
    selectedIds.value.size < 2 &&
    (isHovered || isFocused);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) {
      return;
    }
    cardDomRefs.set(node.id, el);

    if (typeof ResizeObserver === "undefined") {
      return () => {
        cardDomRefs.delete(node.id);
      };
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (node.layout.collapsed) {
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        const currentEl = cardRef.current;
        if (!currentEl) {
          return;
        }
        const h = currentEl.offsetHeight;
        const w = currentEl.offsetWidth || node.layout.width;
        if (h > 0) {
          queueNodeResize(node.id, w, h);
        }
      }, 90);
    });
    observer.observe(el);

    return () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      observer.disconnect();
      cardDomRefs.delete(node.id);
    };
  }, [node.id, node.layout.collapsed, node.layout.width]);

  useEffect(() => {
    if (!showHoverPill && moreOpen) {
      setMoreOpen(false);
    }
  }, [showHoverPill, moreOpen]);

  const offset = dragOffsets.get(node.id);
  const tx = node.layout.x + (offset?.x ?? 0);
  const ty = node.layout.y + (offset?.y ?? 0);

  const classes = [
    "node-card",
    `node-card--${node.type}`,
    `node-card--status-${node.status}`,
  ];
  if (node.type === "loophole" && node.metadata.severity) {
    classes.push(`node-card--severity-${node.metadata.severity}`);
  }
  if (node.context_controls.pin_global) classes.push("node-card--pinned");
  if (node.context_controls.exclude_from_ai) classes.push("node-card--excluded");
  if (node.layout.collapsed) classes.push("node-card--collapsed");
  if (isFocused) classes.push("node-card--focused");
  if (isSelected) classes.push("node-card--selected");
  if (isHovered || isFocused || moreOpen) classes.push("node-card--elevated");
  if (isShaking) classes.push("node-card--shaking");
  if (isXrayDimmed) classes.push("node-card--xray-dim");

  const renderedHtml = node.layout.collapsed
    ? ""
    : node.status === "draft"
      ? renderMarkdownToSanitizedHtml(node.content)
      : getRenderedMarkdown(node.content_hash, node.content);

  const applyMetaPatch = (label: string, patch: NodeMetaPatch): void => {
    const { forward, inverse } = buildUpdateMetaWithInverse(node, patch);
    void mutateGraphUndoable(label, forward, inverse);
  };

  const handleSpawnChild = (e: MouseEvent): void => {
    e.stopPropagation();
    const edgeType = node.type === "loophole" ? "resolves" : "derives";
    void spawnChild(node.id, edgeType, "core").then(({ node: created }) => {
      enterEditMode(created);
    });
  };

  const handleOpenLens = (e: MouseEvent): void => {
    e.stopPropagation();
    focusId.value = node.id;
    modalState.value = "chord_a";
  };

  const handleTogglePin = (e: MouseEvent): void => {
    e.stopPropagation();
    applyMetaPatch("Toggle pin", { pin_global: !node.context_controls.pin_global });
  };

  const handleToggleCollapse = (e: MouseEvent): void => {
    e.stopPropagation();
    applyMetaPatch("Collapse node", { collapsed: !node.layout.collapsed });
  };

  return (
    <article
      ref={cardRef}
      class={classes.join(" ")}
      data-node-id={node.id}
      style={{
        transform: `translate3d(${tx}px, ${ty}px, 0)`,
        width: `${node.layout.width}px`,
      }}
      onPointerEnter={() => {
        hoveredId.value = node.id;
      }}
      onPointerLeave={() => {
        if (hoveredId.value === node.id) {
          hoveredId.value = null;
        }
      }}
    >
      {showHoverPill && (
        <div
          class="hover-pill"
          data-source={isHovered ? "pointer" : "keyboard"}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            class="hover-pill__btn"
            title="Add child node (Tab)"
            onClick={handleSpawnChild}
          >
            + Child
          </button>
          <button
            type="button"
            class="hover-pill__btn"
            title="Open AI Lens menu (A)"
            onClick={handleOpenLens}
          >
            Lens
          </button>
          <button
            type="button"
            class="hover-pill__btn"
            title={
              node.context_controls.pin_global
                ? "Unpin from global AI context (P)"
                : "Pin to global AI context (P)"
            }
            onClick={handleTogglePin}
          >
            {node.context_controls.pin_global ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            class="hover-pill__btn"
            title={node.layout.collapsed ? "Unfold card body (C)" : "Fold card body (C)"}
            onClick={handleToggleCollapse}
          >
            {node.layout.collapsed ? "Unfold" : "Fold"}
          </button>
          <button
            type="button"
            class="hover-pill__btn"
            title="More node actions"
            aria-label="More node actions"
            aria-expanded={moreOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMoreOpen((v) => !v);
            }}
          >
            ···
          </button>
          {moreOpen && (
            <div class="hover-pill__menu">
              <button
                type="button"
                class="hover-pill__menu-item"
                onClick={(e) => {
                  e.stopPropagation();
                  setMoreOpen(false);
                  applyMetaPatch("Toggle AI exclusion", {
                    exclude_from_ai: !node.context_controls.exclude_from_ai,
                  });
                }}
              >
                {node.context_controls.exclude_from_ai ? "Include in AI" : "Exclude from AI"}
              </button>
              <button
                type="button"
                class="hover-pill__menu-item"
                onClick={(e) => {
                  e.stopPropagation();
                  setMoreOpen(false);
                  applyMetaPatch("Toggle lock", {
                    status: node.status === "locked" ? "active" : "locked",
                  });
                }}
              >
                {node.status === "locked" ? "Unlock" : "Lock"}
              </button>
              {node.type === "loophole" && (
                <button
                  type="button"
                  class="hover-pill__menu-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoreOpen(false);
                    applyMetaPatch("Toggle loophole resolved", {
                      status: node.status === "resolved" ? "active" : "resolved",
                    });
                  }}
                >
                  {node.status === "resolved" ? "Reopen Loophole" : "Mark Resolved"}
                </button>
              )}
              <button
                type="button"
                class="hover-pill__menu-item hover-pill__menu-item--danger"
                onClick={(e) => {
                  e.stopPropagation();
                  setMoreOpen(false);
                  const { forward, inverse } = buildDeleteWithInverse(
                    [node.id],
                    nodesMap,
                    edgesMap,
                  );
                  if (forward.length > 0) {
                    void mutateGraphUndoable("Delete node", forward, inverse);
                  }
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      )}

      <header class="node-card__header">
        <span class="node-card__title">{node.title || "Untitled"}</span>
        <div class="node-card__badges">
          {node.type === "loophole" && node.metadata.severity && (
            <span class={`badge badge--sev-${node.metadata.severity}`}>
              {node.metadata.severity.toUpperCase()}
            </span>
          )}
          {node.context_controls.pin_global && (
            <span class="badge badge--pin" title="Pinned to global AI context">
              PIN
            </span>
          )}
          {node.context_controls.exclude_from_ai && (
            <span class="badge badge--no-ai" title="Excluded from AI context">
              NO AI
            </span>
          )}
          {node.status === "locked" && (
            <span class="badge badge--locked" title="Node is locked against edits">
              LOCKED
            </span>
          )}
          {loopholeInfo && loopholeInfo.count > 0 && (
            <span
              class={`badge badge--loophole-count badge--sev-${loopholeInfo.maxSeverity ?? "medium"}`}
              title={`${loopholeInfo.count} unresolved loophole${loopholeInfo.count === 1 ? "" : "s"}`}
            >
              ⚠ {loopholeInfo.count}
            </span>
          )}
        </div>
      </header>

      {!node.layout.collapsed && (
        <div
          class="node-card__body markdown-body"
          // Sanitized exclusively by DOMPurify in markdownCache.ts
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      )}

      {node.status === "draft" && !node.layout.collapsed && (
        <footer class="node-card__footer">
          <span class="node-card__streaming-dot" aria-hidden="true" />
          <span class="node-card__streaming-hint">Esc to stop</span>
        </footer>
      )}
    </article>
  );
}

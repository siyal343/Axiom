import { useEffect, useRef, useState } from "preact/hooks";
import { clampZoom } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import { isTauriRuntime, searchNodes } from "../ipc/client";
import type { NodeStatus, NodeType, SearchHit, Severity } from "../ipc/types";
import { cameraControllerRef, nodesMap } from "../store/graphStore";
import {
  closeCommandPalette,
  commandPaletteOpen,
  modalState,
  selectSingle,
} from "../store/selection";

const FILTER_CHIPS = [
  "status:active",
  "type:loophole",
  "severity:critical",
  "pinned:true",
  "excluded:true",
];

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function searchNodesLocally(query: string, limit: number): SearchHit[] {
  let statusFilter: NodeStatus | null = null;
  let typeFilter: NodeType | null = null;
  let severityFilter: Severity | null = null;
  let pinnedFilter: boolean | null = null;
  let excludedFilter: boolean | null = null;
  const textTerms: string[] = [];

  for (const raw of query.trim().split(/\s+/)) {
    if (!raw) continue;
    if (raw.startsWith("status:")) {
      const val = raw.slice(7).toLowerCase();
      if (
        val === "draft" ||
        val === "active" ||
        val === "resolved" ||
        val === "dismissed" ||
        val === "locked"
      ) {
        statusFilter = val;
        continue;
      }
    } else if (raw.startsWith("type:")) {
      const val = raw.slice(5).toLowerCase();
      if (
        val === "core" ||
        val === "branch" ||
        val === "loophole" ||
        val === "probe" ||
        val === "synthesis"
      ) {
        typeFilter = val;
        continue;
      }
    } else if (raw.startsWith("severity:")) {
      const val = raw.slice(9).toLowerCase();
      if (val === "low" || val === "medium" || val === "high" || val === "critical") {
        severityFilter = val;
        continue;
      }
    } else if (raw.startsWith("pinned:")) {
      const val = raw.slice(7).toLowerCase();
      if (val === "true" || val === "1") {
        pinnedFilter = true;
        continue;
      }
      if (val === "false" || val === "0") {
        pinnedFilter = false;
        continue;
      }
    } else if (raw.startsWith("excluded:")) {
      const val = raw.slice(9).toLowerCase();
      if (val === "true" || val === "1") {
        excludedFilter = true;
        continue;
      }
      if (val === "false" || val === "0") {
        excludedFilter = false;
        continue;
      }
    }
    textTerms.push(raw.toLowerCase());
  }

  const matched = Array.from(nodesMap.values()).filter((node) => {
    if (statusFilter !== null && node.status !== statusFilter) return false;
    if (typeFilter !== null && node.type !== typeFilter) return false;
    if (severityFilter !== null && node.metadata.severity !== severityFilter) return false;
    if (pinnedFilter !== null && node.context_controls.pin_global !== pinnedFilter) return false;
    if (excludedFilter !== null && node.context_controls.exclude_from_ai !== excludedFilter)
      return false;

    if (textTerms.length > 0) {
      const hay = `${node.title}\n${node.content}\n${node.summary}`.toLowerCase();
      for (const term of textTerms) {
        if (!hay.includes(term)) {
          return false;
        }
      }
    }
    return true;
  });

  matched.sort((a, b) => {
    const sa = a.metadata.severity ? SEVERITY_RANK[a.metadata.severity] : 0;
    const sb = b.metadata.severity ? SEVERITY_RANK[b.metadata.severity] : 0;
    return sb - sa || b.updated_at - a.updated_at;
  });

  return matched.slice(0, limit).map((node) => ({
    id: node.id,
    title: node.title,
    type: node.type,
    status: node.status,
    severity: node.metadata.severity,
    snippet: (node.summary || node.content).slice(0, 120),
    x: node.layout.x,
    y: node.layout.y,
  }));
}

export function CommandPalette() {
  const isOpen = modalState.value === "command" && commandPaletteOpen.value;
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setQuery("");
    setActiveIndex(0);
    queueMicrotask(() => {
      inputRef.current?.focus();
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (isTauriRuntime()) {
        void searchNodes(query, 30)
          .then((res) => {
            if (!cancelled) {
              setHits(res);
              setActiveIndex(0);
            }
          })
          .catch(() => {
            if (!cancelled) {
              setHits(searchNodesLocally(query, 30));
              setActiveIndex(0);
            }
          });
      } else {
        setHits(searchNodesLocally(query, 30));
        setActiveIndex(0);
      }
    }, 60);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, query]);

  if (!isOpen) {
    return null;
  }

  const jumpToHit = (hit: SearchHit): void => {
    closeCommandPalette();
    selectSingle(hit.id);

    const controller = cameraControllerRef.current;
    if (!controller) {
      return;
    }
    const node = nodesMap.get(hit.id);
    const w = node?.layout.width ?? 320;
    const h = node ? getEffectiveNodeHeight(node) : 180;
    const cx = (node?.layout.x ?? hit.x) + w / 2;
    const cy = (node?.layout.y ?? hit.y) + h / 2;
    const cam = controller.getCamera();
    const { width, height } = controller.getViewportSize();
    const targetZoom = clampZoom(Math.max(cam.zoom, 0.85));
    controller.animateTo(
      {
        x: width / 2 - cx * targetZoom,
        y: height / 2 - cy * targetZoom,
        zoom: targetZoom,
      },
      220,
    );
  };

  const toggleChip = (chip: string): void => {
    const tokens = query.trim().split(/\s+/).filter(Boolean);
    const exists = tokens.includes(chip);
    const next = exists ? tokens.filter((t) => t !== chip) : [chip, ...tokens];
    setQuery(next.length > 0 ? `${next.join(" ")} ` : "");
    inputRef.current?.focus();
  };

  return (
    <div
      class="command-palette-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          closeCommandPalette();
        }
      }}
    >
      <div
        class="command-palette"
        role="dialog"
        aria-label="Command Palette"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeCommandPalette();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((idx) => (hits.length === 0 ? 0 : (idx + 1) % hits.length));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((idx) =>
              hits.length === 0 ? 0 : (idx - 1 + hits.length) % hits.length,
            );
          } else if (e.key === "Enter") {
            e.preventDefault();
            const chosen = hits[activeIndex];
            if (chosen) {
              jumpToHit(chosen);
            }
          }
        }}
      >
        <input
          ref={inputRef}
          type="text"
          class="command-palette__input"
          placeholder="Search nodes or filter (status:active type:loophole severity:critical)..."
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <div class="command-palette__chips">
          {FILTER_CHIPS.map((chip) => {
            const active = query.split(/\s+/).includes(chip);
            return (
              <button
                key={chip}
                type="button"
                class={`command-palette__chip ${active ? "command-palette__chip--active" : ""}`}
                onClick={() => toggleChip(chip)}
              >
                {chip}
              </button>
            );
          })}
        </div>
        <div class="command-palette__results">
          {hits.length === 0 ? (
            <div class="command-palette__empty">No matching nodes</div>
          ) : (
            hits.map((hit, idx) => (
              <button
                key={hit.id}
                type="button"
                class={`command-palette__item ${
                  idx === activeIndex ? "command-palette__item--active" : ""
                }`}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => jumpToHit(hit)}
              >
                <div class="command-palette__item-top">
                  <span class="command-palette__item-title">{hit.title || "Untitled"}</span>
                  <div class="command-palette__item-badges">
                    <span class="badge">{hit.type}</span>
                    {hit.severity && (
                      <span class={`badge badge--sev-${hit.severity}`}>
                        {hit.severity.toUpperCase()}
                      </span>
                    )}
                    <span class="badge">{hit.status}</span>
                  </div>
                </div>
                {hit.snippet && (
                  <div class="command-palette__item-snippet">{hit.snippet}</div>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

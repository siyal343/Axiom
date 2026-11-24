import { useEffect, useRef, useState } from "preact/hooks";
import { clampZoom } from "../canvas/camera";
import { perfHudOpen } from "../canvas/perfMetrics";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import { isTauriRuntime, searchNodes } from "../ipc/client";
import type { NodeStatus, NodeType, SearchHit, Severity } from "../ipc/types";
import {
  runExportJsonAction,
  runImportJsonAction,
  runNewWorkspaceAction,
  runOpenWorkspaceAction,
  runSeedStress500Action,
  runToggleThemeAction,
} from "../ipc/workspaceActions";
import { openSettingsModal } from "../store/aiRunner";
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

const QUICK_ACTION_IDS: ReadonlySet<string> = new Set([
  "settings",
  "toggle-theme",
  "new-workspace",
  "open-workspace",
  "toggle-perf-hud",
]);

interface PaletteCommand {
  id: string;
  label: string;
  description: string;
  keywords: string;
  badge: string;
  run: () => void;
}

function buildPaletteCommands(): PaletteCommand[] {
  const base: PaletteCommand[] = [
    {
      id: "export-json",
      label: "> Export JSON",
      description: "Export current workspace snapshot to portable JSON",
      keywords: "export save backup portable json",
      badge: "Workspace",
      run: () => {
        void runExportJsonAction();
      },
    },
    {
      id: "import-json",
      label: "> Import JSON",
      description: "Import a JSON snapshot into a SQLite workspace",
      keywords: "import load restore portable json",
      badge: "Workspace",
      run: () => {
        void runImportJsonAction();
      },
    },
    {
      id: "open-workspace",
      label: "> Open Workspace",
      description: "Open an existing .sqlite workspace file",
      keywords: "open load sqlite file workspace",
      badge: "Workspace",
      run: () => {
        void runOpenWorkspaceAction();
      },
    },
    {
      id: "new-workspace",
      label: "> New Workspace",
      description: "Create and open a fresh .sqlite workspace",
      keywords: "new create sqlite file workspace",
      badge: "Workspace",
      run: () => {
        void runNewWorkspaceAction();
      },
    },
    {
      id: "toggle-theme",
      label: "> Toggle Theme",
      description: "Switch between dark and light canvas themes",
      keywords: "theme dark light appearance color",
      badge: "Appearance",
      run: () => {
        void runToggleThemeAction();
      },
    },
    {
      id: "settings",
      label: "> Settings",
      description: "Configure AI providers, API keys, and token budget",
      keywords: "settings config api key model provider budget",
      badge: "Preferences",
      run: () => {
        openSettingsModal();
      },
    },
    {
      id: "toggle-perf-hud",
      label: "> Toggle Perf HUD",
      description: "Show or hide live FPS, p95 draw time, and LOD metrics",
      keywords: "perf hud fps benchmark telemetry metrics",
      badge: "Diagnostics",
      run: () => {
        perfHudOpen.value = !perfHudOpen.value;
      },
    },
  ];

  if (import.meta.env.DEV) {
    base.push({
      id: "seed-stress-500",
      label: "> Seed Stress 500",
      description: "Replace current graph with deterministic 500-node / 700-edge benchmark",
      keywords: "seed stress 500 benchmark graph dev",
      badge: "Dev",
      run: () => {
        void runSeedStress500Action();
      },
    });
  }

  return base;
}

function matchesFuzzySubsequence(text: string, needle: string): boolean {
  let ni = 0;
  for (let ti = 0; ti < text.length && ni < needle.length; ti += 1) {
    if (text[ti] === needle[ni]) {
      ni += 1;
    }
  }
  return ni === needle.length;
}

function filterPaletteCommands(commands: PaletteCommand[], rawQuery: string): PaletteCommand[] {
  const afterPrefix = rawQuery.trimStart().slice(1).trim().toLowerCase();
  if (!afterPrefix) {
    return commands;
  }
  const cleanTarget = (label: string): string => label.replace(/^>\s*/, "").toLowerCase();
  return commands.filter((cmd) => {
    const labelText = cleanTarget(cmd.label);
    const haystack = `${labelText} ${cmd.keywords} ${cmd.description}`.toLowerCase();
    if (haystack.includes(afterPrefix)) {
      return true;
    }
    return matchesFuzzySubsequence(labelText.replace(/\s+/g, ""), afterPrefix.replace(/\s+/g, ""));
  });
}

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

  const isCommandMode = query.trimStart().startsWith(">");
  const allCommands = buildPaletteCommands();
  const visibleCommands = isCommandMode ? filterPaletteCommands(allCommands, query) : [];
  const showQuickActions = !isCommandMode && query.trim() === "" && hits.length === 0;
  const quickActions = showQuickActions
    ? allCommands.filter((cmd) => QUICK_ACTION_IDS.has(cmd.id))
    : [];
  const itemCount = isCommandMode
    ? visibleCommands.length
    : showQuickActions
      ? quickActions.length
      : hits.length;

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setHits([]);
      setActiveIndex(0);
      return;
    }
    queueMicrotask(() => {
      inputRef.current?.focus();
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (isCommandMode) {
      setActiveIndex(0);
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
  }, [isOpen, isCommandMode, query]);

  if (!isOpen) {
    return null;
  }

  const jumpToHit = (hit: SearchHit): void => {
    setQuery("");
    setActiveIndex(0);
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

  const executeCommand = (cmd: PaletteCommand): void => {
    setQuery("");
    setActiveIndex(0);
    closeCommandPalette();
    cmd.run();
  };

  const toggleCommandsMode = (): void => {
    if (isCommandMode) {
      setQuery("");
    } else {
      setQuery("> ");
    }
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const toggleChip = (chip: string): void => {
    const baseQuery = isCommandMode ? "" : query;
    const tokens = baseQuery.trim().split(/\s+/).filter(Boolean);
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
        aria-modal="true"
        aria-label="Command Palette"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeCommandPalette();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((idx) => (itemCount === 0 ? 0 : (idx + 1) % itemCount));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((idx) =>
              itemCount === 0 ? 0 : (idx - 1 + itemCount) % itemCount,
            );
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (isCommandMode) {
              const chosen = visibleCommands[activeIndex] ?? visibleCommands[0];
              if (chosen) {
                executeCommand(chosen);
              }
            } else if (showQuickActions) {
              const chosen = quickActions[activeIndex] ?? quickActions[0];
              if (chosen) {
                executeCommand(chosen);
              }
            } else {
              const chosen = hits[activeIndex];
              if (chosen) {
                jumpToHit(chosen);
              }
            }
          }
        }}
      >
        <input
          ref={inputRef}
          type="text"
          class="command-palette__input"
          placeholder="Search nodes or type > for workspace actions..."
          value={query}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setActiveIndex(0);
          }}
        />
        <div class="command-palette__chips">
          <button
            type="button"
            class={`command-palette__chip ${isCommandMode ? "command-palette__chip--active" : ""}`}
            onClick={toggleCommandsMode}
          >
            &gt; Commands
          </button>
          {!isCommandMode &&
            FILTER_CHIPS.map((chip) => {
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
          {isCommandMode ? (
            visibleCommands.length === 0 ? (
              <div class="command-palette__empty">No matching commands</div>
            ) : (
              visibleCommands.map((cmd, idx) => (
                <button
                  key={cmd.id}
                  type="button"
                  class={`command-palette__item command-palette__item--cmd ${
                    idx === activeIndex ? "command-palette__item--active" : ""
                  }`}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => executeCommand(cmd)}
                >
                  <div class="command-palette__item-top">
                    <span class="command-palette__item-title">{cmd.label}</span>
                    <div class="command-palette__item-badges">
                      <span class="badge">{cmd.badge}</span>
                    </div>
                  </div>
                  <div class="command-palette__item-snippet">{cmd.description}</div>
                </button>
              ))
            )
          ) : showQuickActions ? (
            <>
              <div class="command-palette__section-label">Quick Actions</div>
              {quickActions.map((cmd, idx) => (
                <button
                  key={cmd.id}
                  type="button"
                  class={`command-palette__item command-palette__item--cmd ${
                    idx === activeIndex ? "command-palette__item--active" : ""
                  }`}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => executeCommand(cmd)}
                >
                  <div class="command-palette__item-top">
                    <span class="command-palette__item-title">{cmd.label}</span>
                    <div class="command-palette__item-badges">
                      <span class="badge">{cmd.badge}</span>
                    </div>
                  </div>
                  <div class="command-palette__item-snippet">{cmd.description}</div>
                </button>
              ))}
            </>
          ) : hits.length === 0 ? (
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

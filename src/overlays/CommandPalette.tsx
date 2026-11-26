import { useEffect, useRef, useState } from "preact/hooks";
import { clampZoom } from "../canvas/camera";
import { perfHudOpen } from "../canvas/perfMetrics";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import {
  customLensesSignal,
  filterActionTags,
  parseActionTagInvocation,
  type ActionTagDef,
} from "../input/actionTags";
import { compileXray, isTauriRuntime, searchNodes, searchWorkspaceFlows } from "../ipc/client";
import type {
  NodeStatus,
  NodeType,
  SearchHit,
  Severity,
  WorkspaceSearchHit,
} from "../ipc/types";
import {
  runExportJsonAction,
  runImportJsonAction,
  runNewWorkspaceAction,
  runOpenWorkspaceAction,
  runSeedStress500Action,
  runToggleThemeAction,
} from "../ipc/workspaceActions";
import { executeActionTag, openSettingsModal, shouldRunTagInPlace } from "../store/aiRunner";
import {
  cameraControllerRef,
  createCanvasGroup,
  nodesMap,
  pullExternalRefIntoCanvas,
  tokenBudget,
} from "../store/graphStore";
import { openStudyModal } from "../store/studyStore";
import {
  closeCommandPalette,
  commandPaletteOpen,
  focusId,
  minimapOpen,
  modalState,
  openArtifactExport,
  openCheckpointsModal,
  openDiagnosticsModal,
  openOutlineImportModal,
  relatedPopoverNodeId,
  selectedIds,
  selectSingle,
  spotlightRootId,
  staleNodesMap,
  toggleSpotlight,
  xrayPinned,
  xrayState,
} from "../store/selection";
import {
  openFlowAndFocusNode,
  toggleSidebar,
  workspaceCatalog,
} from "../store/workspaceCatalogStore";
import { notifyIpcError, pushToast } from "./ToastStack";
import { buildBrowserFallbackXray } from "./XrayHud";

const FILTER_CHIPS = [
  "status:active",
  "type:loophole",
  "severity:critical",
  "pinned:true",
  "excluded:true",
  "stale:true",
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
  keepOpen?: boolean;
  run: () => void;
}

function buildPaletteCommands(onFilterStale: () => void): PaletteCommand[] {
  const base: PaletteCommand[] = [
    {
      id: "export-adr",
      label: "> Export ADR / RFC Markdown",
      description: "Compile focused subgraph or flow into an ADR / RFC Markdown spec",
      keywords: "export adr rfc markdown artifact spec",
      badge: "Artifact",
      run: () => {
        openArtifactExport("adr", "subgraph");
      },
    },
    {
      id: "export-brief",
      label: "> Export Research / Study Brief",
      description: "Compile focused subgraph or flow into a Research / Study Brief",
      keywords: "export research study brief markdown artifact",
      badge: "Artifact",
      run: () => {
        openArtifactExport("brief", "subgraph");
      },
    },
    {
      id: "export-mermaid",
      label: "> Export Mermaid Diagram",
      description: "Generate a Mermaid flowchart from the current flow or subgraph",
      keywords: "export mermaid diagram flowchart graph markdown",
      badge: "Artifact",
      run: () => {
        openArtifactExport("mermaid", "workspace");
      },
    },
    {
      id: "toggle-minimap",
      label: "> Toggle Minimap (M)",
      description: "Show or hide the bird's-eye canvas minimap",
      keywords: "minimap overview map navigation canvas",
      badge: "Canvas",
      run: () => {
        minimapOpen.value = !minimapOpen.value;
      },
    },
    {
      id: "toggle-xray",
      label: "> Toggle Context X-Ray (Shift+V)",
      description: "Pin or unpin the interactive Context X-Ray inspector",
      keywords: "xray context tokens prompt inspect pin",
      badge: "Context",
      run: () => {
        const nextPinned = !xrayPinned.value;
        xrayPinned.value = nextPinned;
        if (!nextPinned) {
          xrayState.value = null;
          return;
        }
        const targets =
          selectedIds.value.size > 0
            ? Array.from(selectedIds.value)
            : focusId.value !== null
              ? [focusId.value]
              : [];
        if (isTauriRuntime()) {
          void compileXray(targets, tokenBudget.value)
            .then((xray) => {
              if (xrayPinned.value) {
                xrayState.value = xray;
              }
            })
            .catch(notifyIpcError);
        } else {
          xrayState.value = buildBrowserFallbackXray(targets, tokenBudget.value);
        }
      },
    },
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
      id: "toggle-sidebar",
      label: "> Toggle Sidebar",
      description: "Show or hide the workspaces and flows sidebar (Ctrl/Cmd+B)",
      keywords: "sidebar workspaces flows drawer navigation",
      badge: "Workspace",
      run: () => {
        toggleSidebar();
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
    {
      id: "find-related-nodes",
      label: "> Find Related Nodes",
      description: "Find semantically related nodes for the focused node",
      keywords: "related similar fts5 semantic neighbors graph",
      badge: "Graph",
      run: () => {
        const fid = focusId.value;
        if (!fid) {
          pushToast("Select a focus node first", "warning");
          return;
        }
        relatedPopoverNodeId.value = fid;
      },
    },
    {
      id: "filter-stale-ai-nodes",
      label: "> Filter Stale AI Nodes",
      description: "Filter current flow for AI-generated nodes whose inputs changed",
      keywords: "stale outdated ai refresh modified inputs",
      badge: "AI",
      keepOpen: true,
      run: onFilterStale,
    },
    {
      id: "edit-flow-system-prompt",
      label: "> Edit Flow System Prompt",
      description: "Edit flow-specific system instructions for AI lenses",
      keywords: "system prompt instructions flow ai settings",
      badge: "AI",
      run: () => {
        openSettingsModal("prompt_lenses");
      },
    },
    {
      id: "graph-health-diagnostics",
      label: "> Graph Health & Diagnostics (Shift+H)",
      description: "Audit graph health score, loopholes, stale AI nodes, cycles, and orphans",
      keywords: "health diagnostics audit score loopholes stale cycles orphans",
      badge: "Diagnostics",
      run: () => {
        openDiagnosticsModal();
      },
    },
    {
      id: "import-markdown-outline",
      label: "> Import Markdown Outline",
      description: "Parse a Markdown heading outline into connected canvas nodes",
      keywords: "import markdown outline headings hierarchy tree",
      badge: "Workspace",
      run: () => {
        openOutlineImportModal();
      },
    },
    {
      id: "manage-custom-lenses",
      label: "> Manage Custom Lenses (@tags)",
      description: "Create, edit, or delete reusable custom @tag AI lenses",
      keywords: "custom lenses tags prompt template settings @tag",
      badge: "AI",
      run: () => {
        openSettingsModal("prompt_lenses");
      },
    },
    {
      id: "checkpoints-diff",
      label: "> Checkpoints & Graph Diff (Shift+S)",
      description: "Save named checkpoints, inspect graph diffs, or restore an earlier state",
      keywords: "checkpoints snapshot restore diff history version",
      badge: "Workspace",
      run: () => {
        openCheckpointsModal();
      },
    },
    {
      id: "toggle-spotlight",
      label: "> Toggle Focus Spotlight (Shift+F)",
      description: "Dim unrelated branches and focus on the active node's lineage",
      keywords: "spotlight focus dim lineage isolate branch",
      badge: "Canvas",
      run: () => {
        if (spotlightRootId.value === null && focusId.value === null) {
          pushToast("Select a focus node first", "warning");
          return;
        }
        toggleSpotlight(focusId.value);
      },
    },
    {
      id: "study-recall-drill",
      label: "> Study & Recall Drill (Shift+Q)",
      description: "Open spaced-repetition flashcard drill for due cards in this flow",
      keywords: "study recall drill flashcard sm2 spaced repetition review quiz",
      badge: "Study",
      run: () => {
        void openStudyModal().catch(notifyIpcError);
      },
    },
    {
      id: "group-selected-nodes",
      label: "> Group Selected Nodes (G)",
      description: "Wrap 2+ selected nodes into a named color-coded spatial group",
      keywords: "group frame cluster region wrap organize selected nodes",
      badge: "Canvas",
      run: () => {
        if (selectedIds.value.size < 2) {
          pushToast("Select 2 or more nodes to group (G)", "warning");
          return;
        }
        void createCanvasGroup().catch(notifyIpcError);
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

  const seen = new Set<string>();
  return base.filter((cmd) => {
    if (seen.has(cmd.id)) return false;
    seen.add(cmd.id);
    return true;
  });
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
  let staleFilter: boolean | null = null;
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
    } else if (raw.startsWith("stale:")) {
      const val = raw.slice(6).toLowerCase();
      if (val === "true" || val === "1") {
        staleFilter = true;
        continue;
      }
      if (val === "false" || val === "0") {
        staleFilter = false;
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
    if (staleFilter !== null && staleNodesMap.value.has(node.id) !== staleFilter) return false;

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
  // Subscribe to customLensesSignal so @tag autocomplete reflects newly added/edited custom lenses.
  void customLensesSignal.value;
  const [query, setQuery] = useState("");
  const [searchScope, setSearchScope] = useState<"flow" | "all">("flow");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [workspaceHits, setWorkspaceHits] = useState<WorkspaceSearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const trimmedStart = query.trimStart();
  const isCommandMode = trimmedStart.startsWith(">");
  const isTagMode = trimmedStart.startsWith("@");
  const hasAllPrefix = !isCommandMode && !isTagMode && /^all:/i.test(trimmedStart);
  const effectiveScope: "flow" | "all" = hasAllPrefix ? "all" : searchScope;
  const effectiveQuery = hasAllPrefix ? trimmedStart.slice(4).trimStart() : query;

  const allCommands = buildPaletteCommands(() => {
    setSearchScope("flow");
    setQuery("stale:true");
    setActiveIndex(0);
    queueMicrotask(() => {
      inputRef.current?.focus();
    });
  });
  const visibleCommands = isCommandMode ? filterPaletteCommands(allCommands, query) : [];

  const parsedTagInvocation = isTagMode ? parseActionTagInvocation(trimmedStart) : null;
  const afterAt = isTagMode ? trimmedStart.slice(1) : "";
  const atSpaceIdx = afterAt.search(/\s/);
  const tagTokenQuery = atSpaceIdx === -1 ? afterAt : afterAt.slice(0, atSpaceIdx);
  const inlineTagArg = atSpaceIdx === -1 ? "" : afterAt.slice(atSpaceIdx).trim();
  const visibleTags: ActionTagDef[] = isTagMode
    ? parsedTagInvocation
      ? [parsedTagInvocation.action]
      : filterActionTags(tagTokenQuery)
    : [];

  const showQuickActions =
    !isCommandMode &&
    !isTagMode &&
    effectiveScope === "flow" &&
    query.trim() === "" &&
    hits.length === 0;
  const quickActions = showQuickActions
    ? allCommands.filter((cmd) => QUICK_ACTION_IDS.has(cmd.id))
    : [];
  const itemCount = isCommandMode
    ? visibleCommands.length
    : isTagMode
      ? visibleTags.length
      : effectiveScope === "all"
        ? isTauriRuntime()
          ? workspaceHits.length
          : 0
        : showQuickActions
          ? quickActions.length
          : hits.length;

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setSearchScope("flow");
      setHits([]);
      setWorkspaceHits([]);
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
    if (isCommandMode || isTagMode) {
      setActiveIndex(0);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (effectiveScope === "all") {
        setHits([]);
        if (!isTauriRuntime()) {
          setWorkspaceHits([]);
          setActiveIndex(0);
          return;
        }
        void searchWorkspaceFlows(effectiveQuery, 30)
          .then((res) => {
            if (!cancelled) {
              setWorkspaceHits(Array.isArray(res) ? res : []);
              setActiveIndex(0);
            }
          })
          .catch(() => {
            if (!cancelled) {
              setWorkspaceHits([]);
              setActiveIndex(0);
            }
          });
        return;
      }

      setWorkspaceHits([]);
      const usesClientStaleFilter = /\bstale:(true|false|1|0)\b/i.test(effectiveQuery);
      if (isTauriRuntime() && !usesClientStaleFilter) {
        void searchNodes(effectiveQuery, 30)
          .then((res) => {
            if (!cancelled) {
              setHits(Array.isArray(res) ? res : []);
              setActiveIndex(0);
            }
          })
          .catch(() => {
            if (!cancelled) {
              setHits(searchNodesLocally(effectiveQuery, 30));
              setActiveIndex(0);
            }
          });
      } else {
        setHits(searchNodesLocally(effectiveQuery, 30));
        setActiveIndex(0);
      }
    }, 60);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, isCommandMode, isTagMode, effectiveScope, effectiveQuery]);

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

  const jumpToWorkspaceHit = (wsHit: WorkspaceSearchHit): void => {
    setQuery("");
    setWorkspaceHits([]);
    setActiveIndex(0);
    closeCommandPalette();
    void openFlowAndFocusNode(wsHit.workspace_id, wsHit.flow_id, wsHit.hit.id);
  };

  const linkWorkspaceHit = (wsHit: WorkspaceSearchHit): void => {
    const attachTo = focusId.value;
    setQuery("");
    setWorkspaceHits([]);
    setActiveIndex(0);
    closeCommandPalette();
    void pullExternalRefIntoCanvas(
      wsHit.workspace_id,
      wsHit.flow_id,
      wsHit.hit.id,
      attachTo,
    )
      .then((node) => {
        if (node) {
          pushToast(`Linked card from ${wsHit.flow_name}`, "info");
        }
      })
      .catch(notifyIpcError);
  };

  const activeFlowId = workspaceCatalog.value?.active_flow_id ?? null;

  const executeCommand = (cmd: PaletteCommand): void => {
    if (cmd.keepOpen) {
      cmd.run();
      return;
    }
    setQuery("");
    setActiveIndex(0);
    closeCommandPalette();
    cmd.run();
  };

  const executeTag = (action: ActionTagDef): void => {
    const arg =
      parsedTagInvocation && parsedTagInvocation.action.tag === action.tag
        ? parsedTagInvocation.argument
        : inlineTagArg;
    const fid = focusId.value;
    const focusedNode = fid ? nodesMap.get(fid) : undefined;
    const inPlace = shouldRunTagInPlace(action, arg, focusedNode);
    setQuery("");
    setActiveIndex(0);
    closeCommandPalette();
    void executeActionTag(action, arg.length > 0 ? arg : undefined, { inPlace });
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

  const toggleTagMode = (): void => {
    if (isTagMode) {
      setQuery("");
    } else {
      setQuery("@");
    }
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const toggleChip = (chip: string): void => {
    const baseQuery = isCommandMode || isTagMode ? "" : query;
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
            } else if (isTagMode) {
              const chosen = visibleTags[activeIndex] ?? visibleTags[0];
              if (chosen) {
                executeTag(chosen);
              }
            } else if (effectiveScope === "all") {
              const chosen = workspaceHits[activeIndex];
              if (chosen) {
                jumpToWorkspaceHit(chosen);
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
          aria-label="Search nodes, commands, or actions"
          placeholder="Search nodes, type > for commands, or @ for AI/Study actions..."
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
          <button
            type="button"
            class={`command-palette__chip ${isTagMode ? "command-palette__chip--active" : ""}`}
            onClick={toggleTagMode}
          >
            @ Actions
          </button>
          {!isCommandMode && !isTagMode && (
            <>
              <div class="palette-scope-toggle" role="group" aria-label="Search scope">
                <button
                  type="button"
                  class={`palette-scope-toggle__btn ${
                    effectiveScope === "flow" ? "palette-scope-toggle__btn--active" : ""
                  }`}
                  aria-pressed={effectiveScope === "flow"}
                  onClick={() => {
                    if (hasAllPrefix) {
                      setQuery(effectiveQuery);
                    }
                    setSearchScope("flow");
                    setActiveIndex(0);
                    inputRef.current?.focus();
                  }}
                >
                  This Flow
                </button>
                <button
                  type="button"
                  class={`palette-scope-toggle__btn ${
                    effectiveScope === "all" ? "palette-scope-toggle__btn--active" : ""
                  }`}
                  aria-pressed={effectiveScope === "all"}
                  onClick={() => {
                    setSearchScope("all");
                    setActiveIndex(0);
                    inputRef.current?.focus();
                  }}
                >
                  All Flows
                </button>
              </div>
              {effectiveScope === "flow" &&
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
            </>
          )}
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
          ) : isTagMode ? (
            visibleTags.length === 0 ? (
              <div class="command-palette__empty">No matching @actions</div>
            ) : (
              visibleTags.map((action, idx) => {
                const activeArg =
                  parsedTagInvocation && parsedTagInvocation.action.tag === action.tag
                    ? parsedTagInvocation.argument
                    : inlineTagArg;
                return (
                  <button
                    key={action.tag}
                    type="button"
                    class={`command-palette__item command-palette__item--cmd ${
                      idx === activeIndex ? "command-palette__item--active" : ""
                    }`}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => executeTag(action)}
                  >
                    <div class="command-palette__item-top">
                      <span class="command-palette__item-title">
                        {action.tag} · {action.label}
                      </span>
                      <div class="command-palette__item-badges">
                        <span class="badge">
                          {action.kind === "triage" ? "Triage" : "AI Action"}
                        </span>
                      </div>
                    </div>
                    <div class="command-palette__item-snippet">
                      {activeArg ? `Prompt: "${activeArg}"` : action.description}
                    </div>
                  </button>
                );
              })
            )
          ) : effectiveScope === "all" ? (
            !isTauriRuntime() ? (
              <div class="command-palette__empty">
                Multi-flow FTS5 search runs in the Axiom desktop runtime.
              </div>
            ) : workspaceHits.length === 0 ? (
              <div class="command-palette__empty">No matching nodes across flows</div>
            ) : (
              workspaceHits.map((wsHit, idx) => (
                <div
                  key={`${wsHit.workspace_id}:${wsHit.flow_id}:${wsHit.hit.id}`}
                  role="button"
                  tabIndex={0}
                  class={`command-palette__item ${
                    idx === activeIndex ? "command-palette__item--active" : ""
                  }`}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => jumpToWorkspaceHit(wsHit)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      jumpToWorkspaceHit(wsHit);
                    }
                  }}
                >
                  <div class="command-palette__item-top">
                    <span class="command-palette__item-title">
                      {wsHit.hit.title || "Untitled"}
                    </span>
                    <div class="command-palette__item-badges">
                      <span class="badge badge--flow">{wsHit.flow_name}</span>
                      <span class="badge">{wsHit.hit.type}</span>
                      {wsHit.hit.severity && (
                        <span class={`badge badge--sev-${wsHit.hit.severity}`}>
                          {wsHit.hit.severity.toUpperCase()}
                        </span>
                      )}
                      <span class="badge">{wsHit.hit.status}</span>
                      {wsHit.flow_id !== activeFlowId && (
                        <button
                          type="button"
                          class="palette-link-btn"
                          title={`Pull linked reference from ${wsHit.flow_name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            linkWorkspaceHit(wsHit);
                          }}
                        >
                          + Link
                        </button>
                      )}
                    </div>
                  </div>
                  {wsHit.hit.snippet && (
                    <div class="command-palette__item-snippet">{wsHit.hit.snippet}</div>
                  )}
                </div>
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

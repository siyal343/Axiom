// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeymapHandler, type KeymapDeps } from "../keymap";
import type { EdgeDto, LensKind, NodeDto } from "../../ipc/types";
import type { ModalState } from "../../store/selection";

function makeNode(id: string): NodeDto {
  return {
    id,
    type: "core",
    status: "active",
    title: "Root",
    content: "",
    summary: "",
    content_hash: "h",
    summary_hash: "",
    metadata: {
      severity: null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: 1,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: { x: 0, y: 0, width: 320, height: 180, collapsed: false },
    created_at: 1,
    updated_at: 1,
  };
}

describe("UT-TS-04: modal keymap isolation & A-chord state machine", () => {
  let modal: ModalState;
  let focusId: string | null;
  let selected: Set<string>;
  let triggeredLenses: LensKind[];
  let actionsCount: number;
  let nodes: Map<string, NodeDto>;
  let edges: Map<string, EdgeDto>;

  const buildDeps = (): KeymapDeps => ({
    getModalState: () => modal,
    setModalState: (m) => {
      modal = m;
    },
    getFocusId: () => focusId,
    getSelectedIds: () => selected,
    getNodes: () => nodes,
    getEdges: () => edges,
    selectSingle: (id) => {
      actionsCount += 1;
      focusId = id;
      selected = id ? new Set([id]) : new Set();
    },
    setSelection: (ids, primary) => {
      actionsCount += 1;
      selected = new Set(ids);
      focusId = primary ?? null;
    },
    enterEditMode: () => {
      actionsCount += 1;
      modal = "edit";
      return true;
    },
    triggerLockedShake: () => {
      actionsCount += 1;
    },
    setXray: () => {
      actionsCount += 1;
    },
    compileXray: async () => ({
      total_tokens: 0,
      budget_tokens: 6000,
      node_modes: {},
      active_edges: [],
    }),
    mutateUndoable: async () => {
      actionsCount += 1;
      return { updated_nodes: [], deleted_node_ids: [], deleted_edge_ids: [] };
    },
    spawnChild: async () => {
      actionsCount += 1;
      return {
        node: makeNode("child"),
        edge: {
          id: "e",
          source_id: "root",
          target_id: "child",
          type: "derives",
          weight: "summary",
          created_at: 1,
        },
      };
    },
    undo: async () => {
      actionsCount += 1;
      return null;
    },
    redo: async () => {
      actionsCount += 1;
      return null;
    },
    tidySubtree: async () => {
      actionsCount += 1;
      return [];
    },
    openCommandPalette: () => {
      actionsCount += 1;
      modal = "command";
    },
    closeOverlays: () => {
      modal = "navigate";
    },
    openEdgePopoverFor: () => {
      actionsCount += 1;
    },
    onTriggerLens: (lens) => {
      triggeredLenses.push(lens);
    },
    pushToast: () => {},
    getCamera: () => ({ x: 0, y: 0, zoom: 1, last_focus_id: focusId }),
    getViewportSize: () => ({ width: 1280, height: 800 }),
    animateTo: () => {},
  });

  beforeEach(() => {
    vi.useFakeTimers();
    modal = "navigate";
    focusId = "root";
    selected = new Set(["root"]);
    triggeredLenses = [];
    actionsCount = 0;
    nodes = new Map([["root", makeNode("root")]]);
    edges = new Map();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("isolates Edit Mode so h, j, a, d trigger zero graph actions", () => {
    modal = "edit";
    const handler = createKeymapHandler(buildDeps());

    for (const key of ["h", "j", "a", "d"]) {
      const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      handler.handleKeyDown(ev);
      expect(ev.defaultPrevented).toBe(false);
    }

    expect(modal).toBe("edit");
    expect(actionsCount).toBe(0);
    expect(triggeredLenses).toEqual([]);
    handler.dispose();
  });

  it("dispatches RedTeam on A -> R within 1500ms", () => {
    const handler = createKeymapHandler(buildDeps());

    handler.handleKeyDown(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    expect(modal).toBe("chord_a");

    vi.advanceTimersByTime(400);
    handler.handleKeyDown(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
    expect(triggeredLenses).toEqual(["red_team"]);
    expect(modal).toBe("navigate");
    handler.dispose();
  });

  it("resets A-chord cleanly to navigate after 1500ms timeout", () => {
    const handler = createKeymapHandler(buildDeps());

    handler.handleKeyDown(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    expect(modal).toBe("chord_a");

    vi.advanceTimersByTime(1500);
    expect(modal).toBe("navigate");
    expect(triggeredLenses).toEqual([]);
    handler.dispose();
  });

  it("handles Ctrl+=, Ctrl+-, Ctrl+0, ? and does not intercept Tab/Enter on interactive buttons", () => {
    let zoomInCount = 0;
    let zoomOutCount = 0;
    let resetZoomCount = 0;
    let helpToggleCount = 0;
    let spawnCount = 0;
    let enterEditCount = 0;

    const handler = createKeymapHandler({
      ...buildDeps(),
      enterEditMode: () => {
        enterEditCount += 1;
        return true;
      },
      spawnChild: async () => {
        spawnCount += 1;
        return {
          node: makeNode("child"),
          edge: {
            id: "e1",
            source_id: "root",
            target_id: "child",
            type: "derives",
            weight: "summary",
            created_at: 1,
          },
        };
      },
      zoomIn: () => {
        zoomInCount += 1;
      },
      zoomOut: () => {
        zoomOutCount += 1;
      },
      resetZoom: () => {
        resetZoomCount += 1;
      },
      toggleShortcutsHelp: () => {
        helpToggleCount += 1;
      },
    });

    const zoomInEv = new KeyboardEvent("keydown", {
      key: "=",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    handler.handleKeyDown(zoomInEv);
    expect(zoomInEv.defaultPrevented).toBe(true);
    expect(zoomInCount).toBe(1);

    const zoomOutEv = new KeyboardEvent("keydown", {
      key: "-",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    handler.handleKeyDown(zoomOutEv);
    expect(zoomOutEv.defaultPrevented).toBe(true);
    expect(zoomOutCount).toBe(1);

    const resetEv = new KeyboardEvent("keydown", {
      key: "0",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    handler.handleKeyDown(resetEv);
    expect(resetEv.defaultPrevented).toBe(true);
    expect(resetZoomCount).toBe(1);

    const helpEv = new KeyboardEvent("keydown", {
      key: "?",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    handler.handleKeyDown(helpEv);
    expect(helpEv.defaultPrevented).toBe(true);
    expect(helpToggleCount).toBe(1);

    // Tab and Enter on buttons inside .hover-pill or .edge-popover must NOT be hijacked.
    const host = document.createElement("div");
    const hoverPill = document.createElement("div");
    hoverPill.className = "hover-pill";
    const pillBtn = document.createElement("button");
    hoverPill.appendChild(pillBtn);
    const edgePopover = document.createElement("div");
    edgePopover.className = "edge-popover";
    const popBtn = document.createElement("button");
    edgePopover.appendChild(popBtn);
    host.appendChild(hoverPill);
    host.appendChild(edgePopover);
    document.body.appendChild(host);
    host.addEventListener("keydown", handler.handleKeyDown);

    const tabOnPill = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    pillBtn.dispatchEvent(tabOnPill);
    expect(tabOnPill.defaultPrevented).toBe(false);
    expect(spawnCount).toBe(0);

    const enterOnPill = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    pillBtn.dispatchEvent(enterOnPill);
    expect(enterOnPill.defaultPrevented).toBe(false);
    expect(enterEditCount).toBe(0);

    modal = "connect_edge";
    const enterOnPopover = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    popBtn.dispatchEvent(enterOnPopover);
    expect(enterOnPopover.defaultPrevented).toBe(false);
    expect(actionsCount).toBe(0);

    host.removeEventListener("keydown", handler.handleKeyDown);
    host.remove();
    handler.dispose();
  });
});

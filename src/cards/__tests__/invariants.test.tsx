// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeDto } from "../../ipc/types";
import { isBirdsEye, loadSnapshot } from "../../store/graphStore";
import { enterEditMode, exitEditMode, modalState } from "../../store/selection";
import { CardLayer } from "../CardLayer";
import { LiveEditorOverlay } from "../LiveEditorOverlay";

function makeTestNode(id: string, status: NodeDto["status"], title: string): NodeDto {
  return {
    id,
    type: "core",
    status,
    title,
    content: "Body content",
    summary: "",
    content_hash: `hash_${id}`,
    summary_hash: "",
    metadata: {
      severity: null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: 4,
    },
    context_controls: {
      pin_global: false,
      exclude_from_ai: false,
    },
    layout: {
      x: 40,
      y: 40,
      width: 320,
      height: 180,
      collapsed: false,
    },
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };
}

async function flushDom(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 40);
  });
}

describe("Slice 2 architectural invariants: One Live Editor & LOD cutoff", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    exitEditMode();
    isBirdsEye.value = false;
  });

  afterEach(() => {
    render(null, container);
    container.remove();
    exitEditMode();
    isBirdsEye.value = false;
  });

  it("mounts 0 .cm-editor in Navigate Mode, 1 in Edit Mode, back to 0 on Esc, and 0 .node-card in Bird's-Eye LOD", async () => {
    const activeNode = makeTestNode("node_active", "active", "Unlocked Node");
    const lockedNode = makeTestNode("node_locked", "locked", "Locked Node");

    loadSnapshot({
      path: "",
      nodes: [activeNode, lockedNode],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1.0, last_focus_id: "node_active" },
      token_budget: 6000,
    });
    // Ensure visibleNodeIds contains loaded nodes in unit test without full Canvas ResizeObserver
    const { visibleNodeIds } = await import("../../store/graphStore");
    visibleNodeIds.value = ["node_active", "node_locked"];

    render(
      <>
        <CardLayer />
        <LiveEditorOverlay />
      </>,
      container,
    );
    await flushDom();

    expect(modalState.value).toBe("navigate");
    expect(container.querySelectorAll(".cm-editor").length).toBe(0);
    expect(container.querySelectorAll(".node-card").length).toBe(2);

    // Attempting Edit Mode on locked node is rejected cleanly
    expect(enterEditMode(lockedNode)).toBe(false);
    await flushDom();
    expect(modalState.value).toBe("navigate");
    expect(container.querySelectorAll(".cm-editor").length).toBe(0);

    // Entering Edit Mode on unlocked node mounts strictly 1 CodeMirror editor
    expect(enterEditMode(activeNode)).toBe(true);
    await flushDom();
    expect(modalState.value).toBe("edit");
    expect(container.querySelectorAll(".cm-editor").length).toBe(1);

    // Pressing Escape commits and unmounts CodeMirror back to 0 instances
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await flushDom();
    expect(modalState.value).toBe("navigate");
    expect(container.querySelectorAll(".cm-editor").length).toBe(0);

    // Zooming below 0.45x (Bird's-Eye LOD) unmounts DOM NodeCards completely
    isBirdsEye.value = true;
    await flushDom();
    expect(container.querySelectorAll(".node-card").length).toBe(0);
  });
});

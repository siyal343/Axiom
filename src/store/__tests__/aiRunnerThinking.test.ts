import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LensStreamEvent, NodeDto } from "../../ipc/types";

let capturedCallback: ((evt: LensStreamEvent) => void) | null = null;
let resolveRunLens: ((runId: string) => void) | null = null;

vi.mock("../../ipc/client", async () => {
  const actual = await vi.importActual<typeof import("../../ipc/client")>("../../ipc/client");
  return {
    ...actual,
    isTauriRuntime: () => true,
    runLens: vi.fn(
      (
        _lens: string,
        _focusIds: string[],
        onEvent: (evt: LensStreamEvent) => void,
      ): Promise<string> => {
        capturedCallback = onEvent;
        return new Promise<string>((resolve) => {
          resolveRunLens = resolve;
        });
      },
    ),
    cancelRun: vi.fn(async () => {}),
    applyOps: vi.fn(async () => ({
      updated_nodes: [],
      deleted_node_ids: [],
      deleted_edge_ids: [],
    })),
    resolveOverlaps: vi.fn(async () => []),
  };
});

import {
  activeRunFocusIds,
  activeRunSpawnedCount,
  activeRunStatus,
  resetRunTracker,
  triggerLens,
} from "../aiRunner";
import { loadSnapshot } from "../graphStore";
import { selectSingle } from "../selection";

function makeRootNode(): NodeDto {
  return {
    id: "node_root",
    type: "core",
    status: "active",
    title: "Root",
    content: "Spec body",
    summary: "",
    content_hash: "h_root",
    summary_hash: "",
    metadata: {
      severity: null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: 4,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: { x: 0, y: 0, width: 320, height: 180, collapsed: false },
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };
}

describe("aiRunner thinking -> streaming -> idle lifecycle", () => {
  beforeEach(() => {
    capturedCallback = null;
    resolveRunLens = null;
    activeRunStatus.value = "idle";
    activeRunFocusIds.value = [];
    activeRunSpawnedCount.value = 0;
    resetRunTracker();
    loadSnapshot({
      path: "",
      nodes: [makeRootNode()],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "node_root" },
      token_budget: 6000,
    });
    selectSingle("node_root");
  });

  it("transitions activeRunStatus from thinking to streaming to idle across lens events", async () => {
    expect(activeRunStatus.value).toBe("idle");

    const triggerPromise = triggerLens("red_team");
    expect(activeRunStatus.value).toBe("thinking");
    expect(activeRunFocusIds.value).toEqual(["node_root"]);
    expect(activeRunSpawnedCount.value).toBe(0);

    resolveRunLens?.("run_abc");
    await triggerPromise;
    expect(capturedCallback).not.toBeNull();

    const spawned: NodeDto = {
      ...makeRootNode(),
      id: "lh_spawned",
      type: "loophole",
      status: "draft",
      title: "Edge failure",
      layout: { x: 420, y: 0, width: 320, height: 180, collapsed: false },
    };

    capturedCallback?.({
      kind: "skeleton_spawned",
      node: spawned,
      edges: [
        {
          id: "e_spawned",
          source_id: "lh_spawned",
          target_id: "node_root",
          type: "challenges",
          weight: "summary",
          created_at: 1_700_000_000_001,
        },
      ],
    });
    expect(activeRunStatus.value).toBe("streaming");
    expect(activeRunSpawnedCount.value).toBe(1);

    capturedCallback?.({
      kind: "run_completed",
      run_id: "run_abc",
      spawned_ids: ["lh_spawned"],
      cancelled: false,
    });
    expect(activeRunStatus.value).toBe("idle");
    expect(activeRunFocusIds.value).toEqual([]);
    expect(activeRunSpawnedCount.value).toBe(0);
  });
});

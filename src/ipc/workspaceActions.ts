import { open, save } from "@tauri-apps/plugin-dialog";
import { perfHudOpen } from "../canvas/perfMetrics";
import { notifyIpcError, pushToast } from "../overlays/ToastStack";
import { loadSnapshot, setTheme, theme } from "../store/graphStore";
import {
  exportJson,
  exportMarkdownArtifact,
  getSettings,
  importJson,
  isTauriRuntime,
  openWorkspace,
  saveSettings,
  seedStress500,
} from "./client";
import type {
  ArtifactFormat,
  ArtifactScope,
  CompiledArtifact,
  EdgeDto,
  EdgeType,
  EdgeWeight,
  NodeDto,
  NodeLensOrigin,
  NodeStatus,
  NodeType,
  Severity,
  WorkspaceSnapshot,
} from "./types";

const JSON_FILTERS = [{ name: "Axiom JSON", extensions: ["json"] }];
const SQLITE_FILTERS = [{ name: "Axiom SQLite", extensions: ["sqlite", "db"] }];
const MARKDOWN_FILTERS = [{ name: "Markdown", extensions: ["md"] }];

function buildLocalStress500Snapshot(): WorkspaceSnapshot {
  const nodeCount = 500;
  const edgeCount = 700;
  const rowsPerCol = 20;
  const baseTs = 1_700_000_000_000;
  const nodes: NodeDto[] = [];

  for (let i = 0; i < nodeCount; i += 1) {
    let type: NodeType;
    if (i === 0 || i % 25 === 0) {
      type = "core";
    } else if (i % 5 === 1) {
      type = "branch";
    } else if (i % 5 === 2) {
      type = "loophole";
    } else if (i % 5 === 3) {
      type = "probe";
    } else if (i % 5 === 4) {
      type = "synthesis";
    } else {
      type = i % 2 === 0 ? "branch" : "probe";
    }

    let status: NodeStatus = "active";
    if (type === "loophole") {
      if (i % 6 === 4) status = "resolved";
      else if (i % 6 === 0) status = "dismissed";
    } else if (i % 17 === 0 && i > 0) {
      status = "locked";
    } else if (i % 13 === 0 && i > 0) {
      status = "draft";
    }

    const severities: Severity[] = ["low", "medium", "high", "critical"];
    const severity: Severity | null =
      type === "loophole" ? (severities[i % severities.length] ?? "medium") : null;
    const lens: NodeLensOrigin =
      type === "loophole"
        ? "red_team"
        : type === "probe"
          ? "feynman"
          : type === "synthesis"
            ? "synthesize"
            : type === "branch"
              ? "diverge"
              : "manual";

    const col = Math.floor(i / rowsPerCol);
    const row = i % rowsPerCol;
    const title =
      i === 0 ? "Core Stress Root: Distributed Axiom Architecture" : `Stress Node #${String(i).padStart(3, "0")}`;
    const content =
      `Track ${col} node ${i} with $O(N \\log N)$ culling.\n\n` +
      `$$\\text{Latency}_{p95} \\le \\frac{16.6}{${row + 1}}$$\n\n` +
      "```rust\npub fn quorum(acks: usize, replicas: usize) -> bool { acks * 2 > replicas }\n```";

    nodes.push({
      id: `stress_node_${String(i).padStart(3, "0")}`,
      type,
      status,
      title,
      content,
      summary: `Summary for node ${i}: bounded invariant.`,
      content_hash: `hash_${i}`,
      summary_hash: `hash_${i}`,
      metadata: {
        severity,
        lens,
        created_by: i % 3 === 0 ? "user" : "ai",
        model: i % 3 === 0 ? null : "stress-synth-v1",
        token_count: Math.ceil(content.length / 4),
      },
      context_controls: {
        pin_global: i === 0 || i === 25 || i === 50,
        exclude_from_ai: i > 0 && i % 19 === 0,
      },
      layout: {
        x: col * 420,
        y: row * 240,
        width: 320,
        height: 180,
        collapsed: i > 0 && i % 11 === 0,
      },
      created_at: baseTs + i * 1000,
      updated_at: baseTs + i * 1000,
    });
  }

  const edges: EdgeDto[] = [];
  const seen = new Set<string>();
  const pushEdge = (src: number, dst: number, type: EdgeType, weight: EdgeWeight): void => {
    if (src === dst || edges.length >= edgeCount) return;
    const key = `${src}:${dst}:${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    const idx = edges.length;
    edges.push({
      id: `stress_edge_${String(idx).padStart(3, "0")}`,
      source_id: `stress_node_${String(src).padStart(3, "0")}`,
      target_id: `stress_node_${String(dst).padStart(3, "0")}`,
      type,
      weight,
      created_at: baseTs + idx * 1000,
    });
  };

  for (let i = 1; i < nodeCount; i += 1) {
    const parent = i < rowsPerCol ? 0 : i - rowsPerCol;
    const targetNode = nodes[i];
    const type: EdgeType =
      targetNode?.type === "loophole"
        ? "challenges"
        : targetNode?.type === "synthesis"
          ? "synthesizes"
          : i % 3 === 0
            ? "branches"
            : "derives";
    pushEdge(parent, i, type, i % 4 === 0 ? "summary" : "full");
  }

  for (let i = rowsPerCol; i < nodeCount && edges.length < edgeCount; i += 1) {
    if (nodes[i]?.type === "synthesis") {
      const col = Math.floor(i / rowsPerCol);
      const row = i % rowsPerCol;
      const altParent = (col - 1) * rowsPerCol + ((row + 1) % rowsPerCol);
      pushEdge(altParent, i, "synthesizes", "summary");
    }
  }

  for (let i = 5; i < nodeCount && edges.length < edgeCount; i += 1) {
    if (nodes[i]?.type === "loophole") {
      pushEdge((i + 1) % nodeCount, i, "resolves", "summary");
    }
  }

  let cursor = 0;
  while (edges.length < edgeCount && cursor < nodeCount * 4) {
    const src = cursor % nodeCount;
    const stride = 23 + Math.floor(cursor / nodeCount) * 7;
    pushEdge(src, (src + stride) % nodeCount, "references", "summary");
    cursor += 1;
  }

  return {
    path: "memory://stress-500",
    nodes,
    edges,
    camera: {
      x: 120,
      y: 80,
      zoom: 1.0,
      last_focus_id: "stress_node_000",
    },
    token_budget: 6000,
  };
}

export async function runExportJsonAction(): Promise<void> {
  if (!isTauriRuntime()) {
    pushToast("Desktop runtime required to export JSON", "warning");
    return;
  }
  try {
    const destPath = await save({
      title: "Export Axiom Workspace JSON",
      defaultPath: "axiom-workspace.json",
      filters: JSON_FILTERS,
    });
    if (destPath === null) {
      return;
    }
    await exportJson(destPath);
    pushToast("Exported workspace JSON", "info");
  } catch (err) {
    notifyIpcError(err);
  }
}

export async function saveMarkdownArtifactToDisk(
  focusIds: string[],
  scope: ArtifactScope,
  format: ArtifactFormat,
  suggestedName = "axiom-artifact.md",
): Promise<CompiledArtifact | null> {
  if (!isTauriRuntime()) {
    pushToast("Desktop runtime required to save Markdown artifact", "warning");
    return null;
  }
  try {
    const destPath = await save({
      title: "Save Markdown Artifact",
      defaultPath: suggestedName,
      filters: MARKDOWN_FILTERS,
    });
    if (destPath === null) {
      return null;
    }
    const compiled = await exportMarkdownArtifact(focusIds, scope, format, destPath);
    pushToast("Saved Markdown artifact", "info");
    return compiled;
  } catch (err) {
    notifyIpcError(err);
    return null;
  }
}

export async function runImportJsonAction(): Promise<void> {
  if (!isTauriRuntime()) {
    pushToast("Desktop runtime required to import JSON", "warning");
    return;
  }
  try {
    const srcPath = await open({
      title: "Select Axiom JSON Export",
      multiple: false,
      filters: JSON_FILTERS,
    });
    if (typeof srcPath !== "string") {
      return;
    }
    const destSqlitePath = await save({
      title: "Save Imported SQLite Workspace",
      defaultPath: "imported-workspace.sqlite",
      filters: SQLITE_FILTERS,
    });
    if (destSqlitePath === null) {
      return;
    }
    const snapshot = await importJson(srcPath, destSqlitePath);
    loadSnapshot(snapshot);
    pushToast(`Imported ${snapshot.nodes.length} nodes`, "info");
  } catch (err) {
    notifyIpcError(err);
  }
}

export async function runOpenWorkspaceAction(): Promise<void> {
  if (!isTauriRuntime()) {
    pushToast("Desktop runtime required to open workspace files", "warning");
    return;
  }
  try {
    const selected = await open({
      title: "Open Axiom Workspace",
      multiple: false,
      filters: SQLITE_FILTERS,
    });
    if (typeof selected !== "string") {
      return;
    }
    const snapshot = await openWorkspace(selected);
    loadSnapshot(snapshot);
    pushToast("Workspace opened", "info");
  } catch (err) {
    notifyIpcError(err);
  }
}

export async function runNewWorkspaceAction(): Promise<void> {
  if (!isTauriRuntime()) {
    pushToast("Desktop runtime required to create workspace files", "warning");
    return;
  }
  try {
    const destPath = await save({
      title: "New Axiom Workspace",
      defaultPath: "new-workspace.sqlite",
      filters: SQLITE_FILTERS,
    });
    if (destPath === null) {
      return;
    }
    const snapshot = await openWorkspace(destPath);
    loadSnapshot(snapshot);
    pushToast("Created new workspace", "info");
  } catch (err) {
    notifyIpcError(err);
  }
}

export async function runToggleThemeAction(): Promise<void> {
  const nextTheme: "dark" | "light" = theme.value === "dark" ? "light" : "dark";
  setTheme(nextTheme);
  if (isTauriRuntime()) {
    try {
      const current = await getSettings();
      await saveSettings({
        reasoning: current.reasoning,
        utility: current.utility,
        default_token_budget: current.default_token_budget,
        auto_summarize: current.auto_summarize,
        theme: nextTheme,
      });
    } catch (err) {
      notifyIpcError(err);
    }
  }
  pushToast(`Theme set to ${nextTheme}`, "info");
}

export async function runSeedStress500Action(): Promise<void> {
  if (!import.meta.env.DEV) {
    return;
  }
  try {
    const snapshot = isTauriRuntime() ? await seedStress500() : buildLocalStress500Snapshot();
    loadSnapshot(snapshot);
    perfHudOpen.value = true;
    pushToast(
      `Seeded ${snapshot.nodes.length} nodes / ${snapshot.edges.length} edges`,
      "info",
    );
  } catch (err) {
    notifyIpcError(err);
  }
}

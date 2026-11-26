// @vitest-environment jsdom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCustomLenses } from "../../input/actionTags";
import { attachKeymap } from "../../input/keymap";
import type { CustomLensDef, NodeDto } from "../../ipc/types";
import {
  activeRunId,
  activeRunLabel,
  activeRunLens,
  activeRunStatus,
  closeSettingsModal,
  settingsActiveTab,
  settingsModalOpen,
} from "../../store/aiRunner";
import { loadSnapshot, theme } from "../../store/graphStore";
import {
  clearSelection,
  closeCommandPalette,
  closeDiagnosticsModal,
  closeNodeContextMenu,
  closeOutlineImportModal,
  commandPaletteOpen,
  diagnosticsModalOpen,
  focusId,
  modalState,
  nodeContextMenu,
  openCommandPalette,
  openDiagnosticsModal,
  openOutlineImportModal,
  outlineImportModalOpen,
  selectedIds,
  selectSingle,
} from "../../store/selection";
import { CommandPalette } from "../CommandPalette";
import { NodeContextMenu } from "../NodeContextMenu";

function makeNode(id: string, title: string): NodeDto {
  return {
    id,
    type: "core",
    status: "active",
    title,
    content: `Body for ${title}`,
    summary: `Summary for ${title}`,
    content_hash: `h_${id}`,
    summary_hash: `s_${id}`,
    metadata: {
      severity: null,
      lens: "manual",
      created_by: "user",
      model: null,
      token_count: 10,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: {
      x: 100,
      y: 120,
      width: 320,
      height: 180,
      collapsed: false,
    },
    created_at: 1,
    updated_at: 1,
  };
}

function makeCustomLens(overrides: Partial<CustomLensDef> = {}): CustomLensDef {
  return {
    id: "lens_threat",
    name: "STRIDE Threat Model",
    tag: "threat",
    description: "Analyze STRIDE security risks",
    prompt_template: "Apply STRIDE threat modeling.",
    default_node_type: "loophole",
    default_edge_type: "challenges",
    default_severity: "high",
    ...overrides,
  };
}

async function flushUi(ms = 75): Promise<void> {
  await Promise.resolve();
  if (typeof requestAnimationFrame === "function") {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
  await Promise.resolve();
}

describe("v0.4 Workbench Integration: CommandPalette, Keymap, NodeContextMenu", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    theme.value = "dark";
    setCustomLenses([]);
    closeCommandPalette();
    closeNodeContextMenu();
    closeDiagnosticsModal();
    closeOutlineImportModal();
    closeSettingsModal();
    clearSelection();
    modalState.value = "navigate";
    activeRunId.value = null;
    activeRunLens.value = null;
    activeRunLabel.value = null;
    activeRunStatus.value = "idle";
    loadSnapshot({
      path: "memory://v04",
      nodes: [makeNode("n_root", "Root Node"), makeNode("n_other", "Other Node")],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1, last_focus_id: "n_root" },
      token_budget: 6000,
    });
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    setCustomLenses([]);
    closeCommandPalette();
    closeNodeContextMenu();
    closeDiagnosticsModal();
    closeOutlineImportModal();
    closeSettingsModal();
    clearSelection();
    modalState.value = "navigate";
    activeRunId.value = null;
    activeRunLens.value = null;
    activeRunLabel.value = null;
    activeRunStatus.value = "idle";
    render(null, container);
    container.remove();
    vi.restoreAllMocks();
  });

  it("CommandPalette executes > Graph Health & Diagnostics, > Import Markdown Outline, and @ custom lenses", async () => {
    render(<CommandPalette />, container);

    openCommandPalette();
    await flushUi();

    const input = container.querySelector<HTMLInputElement>(".command-palette__input");
    expect(input).not.toBeNull();
    if (!input) return;

    // 1. > Graph Health & Diagnostics opens DiagnosticsModal
    input.value = "> Graph Health & Diagnostics";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const diagCmd = container.querySelector<HTMLButtonElement>(".command-palette__item--cmd");
    expect(diagCmd?.textContent).toContain("> Graph Health & Diagnostics (Shift+H)");
    diagCmd?.click();
    await flushUi();

    expect(diagnosticsModalOpen.value).toBe(true);
    expect(commandPaletteOpen.value).toBe(false);

    // 2. > Import Markdown Outline opens OutlineImportModal
    openCommandPalette();
    await flushUi();
    const input2 = container.querySelector<HTMLInputElement>(".command-palette__input");
    if (!input2) return;
    input2.value = "> Import Markdown Outline";
    input2.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const outlineCmd = container.querySelector<HTMLButtonElement>(".command-palette__item--cmd");
    expect(outlineCmd?.textContent).toContain("> Import Markdown Outline");
    outlineCmd?.click();
    await flushUi();

    expect(outlineImportModalOpen.value).toBe(true);
    expect(diagnosticsModalOpen.value).toBe(false);
    expect(commandPaletteOpen.value).toBe(false);

    // 3. > Manage Custom Lenses (@tags) opens SettingsModal
    openCommandPalette();
    await flushUi();
    const input3 = container.querySelector<HTMLInputElement>(".command-palette__input");
    if (!input3) return;
    input3.value = "> Manage Custom Lenses";
    input3.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const manageCmd = container.querySelector<HTMLButtonElement>(".command-palette__item--cmd");
    expect(manageCmd?.textContent).toContain("> Manage Custom Lenses (@tags)");
    manageCmd?.click();
    await flushUi();

    expect(settingsModalOpen.value).toBe(true);
    expect(settingsActiveTab.value).toBe("prompt_lenses");
    closeSettingsModal();

    // 4. @ mode dynamically updates when customLensesSignal changes
    openCommandPalette();
    await flushUi();
    const input4 = container.querySelector<HTMLInputElement>(".command-palette__input");
    if (!input4) return;

    input4.value = "@";
    input4.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    expect(container.textContent).not.toContain("@threat");

    setCustomLenses([makeCustomLens()]);
    await flushUi();

    input4.value = "@threat";
    input4.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const customTagItems = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".command-palette__item--cmd"),
    );
    expect(customTagItems).toHaveLength(1);
    expect(customTagItems[0]?.textContent).toContain("@threat");
    expect(customTagItems[0]?.textContent).toContain("STRIDE Threat Model");
  });

  it("keymap Shift+H toggles diagnosticsModalOpen and Esc closes diagnosticsModalOpen and outlineImportModalOpen", () => {
    const detach = attachKeymap();
    try {
      expect(diagnosticsModalOpen.value).toBe(false);

      // Shift+H opens DiagnosticsModal
      const openEv = new KeyboardEvent("keydown", {
        key: "H",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(openEv);
      expect(openEv.defaultPrevented).toBe(true);
      expect(diagnosticsModalOpen.value).toBe(true);

      // Esc closes DiagnosticsModal
      const escDiagEv = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(escDiagEv);
      expect(escDiagEv.defaultPrevented).toBe(true);
      expect(diagnosticsModalOpen.value).toBe(false);

      // Shift+H again opens, then Shift+H toggles it closed
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "H", shiftKey: true, bubbles: true, cancelable: true }),
      );
      expect(diagnosticsModalOpen.value).toBe(true);
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "H", shiftKey: true, bubbles: true, cancelable: true }),
      );
      expect(diagnosticsModalOpen.value).toBe(false);

      // Esc closes OutlineImportModal
      openOutlineImportModal();
      expect(outlineImportModalOpen.value).toBe(true);
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(outlineImportModalOpen.value).toBe(false);
    } finally {
      detach();
    }
  });

  it("NodeContextMenu renders Custom Lenses group, runs custom lens, and exposes Import Outline Here…", async () => {
    const invokeMock = vi.fn(async (cmd: string) => {
      if (cmd === "run_lens") {
        return "run_custom_1";
      }
      return null;
    });
    (
      window as {
        __TAURI_INTERNALS__?: {
          invoke: typeof invokeMock;
          transformCallback: () => number;
        };
      }
    ).__TAURI_INTERNALS__ = {
      invoke: invokeMock,
      transformCallback: () => 0,
    };

    selectSingle("n_other");
    setCustomLenses([makeCustomLens()]);

    render(<NodeContextMenu />, container);
    nodeContextMenu.value = { nodeId: "n_root", x: 120, y: 120 };
    await flushUi();

    expect(container.textContent).toContain("Custom Lenses");
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".node-context-menu__item"),
    );

    const customBtn = items.find((btn) => btn.textContent?.includes("STRIDE Threat Model"));
    expect(customBtn).toBeDefined();
    expect(customBtn?.textContent).toContain("@threat");

    customBtn?.click();
    await flushUi();

    expect(nodeContextMenu.value).toBeNull();
    expect(focusId.value).toBe("n_root");
    expect(invokeMock).toHaveBeenCalledWith(
      "run_lens",
      expect.objectContaining({
        lens: "custom",
        focusIds: ["n_root"],
        customLensId: "lens_threat",
      }),
      undefined,
    );

    // Clear active run before testing Import Outline Here…
    activeRunId.value = null;
    activeRunStatus.value = "idle";
    selectSingle("n_other");

    nodeContextMenu.value = { nodeId: "n_root", x: 120, y: 120 };
    await flushUi();

    const importBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".node-context-menu__item"),
    ).find((btn) => btn.textContent?.includes("Import Outline Here…"));
    expect(importBtn).toBeDefined();
    importBtn?.click();
    await flushUi();

    expect(nodeContextMenu.value).toBeNull();
    expect(focusId.value).toBe("n_root");
    expect(Array.from(selectedIds.value)).toEqual(["n_root"]);
    expect(outlineImportModalOpen.value).toBe(true);
    expect(diagnosticsModalOpen.value).toBe(false);
    expect(openDiagnosticsModal).toBeTypeOf("function");
  });
});

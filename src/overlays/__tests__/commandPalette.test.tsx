// @vitest-environment jsdom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globalFrameTracker, perfHudOpen } from "../../canvas/perfMetrics";
import { settingsModalOpen } from "../../store/aiRunner";
import { loadSnapshot, theme } from "../../store/graphStore";
import {
  closeCommandPalette,
  commandPaletteOpen,
  modalState,
  openCommandPalette,
} from "../../store/selection";
import { CommandPalette } from "../CommandPalette";
import { PerfHud } from "../PerfHud";

async function flushUi(): Promise<void> {
  await Promise.resolve();
  if (typeof requestAnimationFrame === "function") {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 40);
  });
  await Promise.resolve();
}

describe("CommandPalette > Action Mode & PerfHud", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    theme.value = "dark";
    perfHudOpen.value = false;
    settingsModalOpen.value = false;
    globalFrameTracker.reset();
    loadSnapshot({
      path: "memory://test",
      nodes: [],
      edges: [],
      camera: { x: 0, y: 0, zoom: 1.0, last_focus_id: null },
      token_budget: 6000,
    });
    closeCommandPalette();
  });

  afterEach(() => {
    closeCommandPalette();
    render(null, container);
    container.remove();
  });

  it("filters > commands, toggles theme via click/filter, toggles Perf HUD via Enter, and opens Settings", async () => {
    render(
      <>
        <CommandPalette />
        <PerfHud />
      </>,
      container,
    );

    openCommandPalette();
    await flushUi();

    const input = container.querySelector<HTMLInputElement>(".command-palette__input");
    expect(input).not.toBeNull();
    if (!input) return;

    // Enter '>' Action Mode and verify workspace/dev commands appear.
    input.value = ">";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const allCmdItems = Array.from(container.querySelectorAll(".command-palette__item--cmd")).map(
      (el) => el.textContent ?? "",
    );
    expect(allCmdItems.some((t) => t.includes("> Export JSON"))).toBe(true);
    expect(allCmdItems.some((t) => t.includes("> Import JSON"))).toBe(true);
    expect(allCmdItems.some((t) => t.includes("> Open Workspace"))).toBe(true);
    expect(allCmdItems.some((t) => t.includes("> New Workspace"))).toBe(true);
    expect(allCmdItems.some((t) => t.includes("> Toggle Theme"))).toBe(true);
    expect(allCmdItems.some((t) => t.includes("> Settings"))).toBe(true);
    expect(allCmdItems.some((t) => t.includes("> Toggle Perf HUD"))).toBe(true);
    expect(allCmdItems.some((t) => t.includes("> Seed Stress 500"))).toBe(true);

    // ArrowUp from index 0 wraps to last command, ArrowDown wraps back to index 0.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await flushUi();
    const cmdElsAfterUp = Array.from(container.querySelectorAll(".command-palette__item--cmd"));
    expect(cmdElsAfterUp[cmdElsAfterUp.length - 1]?.classList.contains("command-palette__item--active")).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flushUi();
    const cmdElsAfterDown = Array.from(container.querySelectorAll(".command-palette__item--cmd"));
    expect(cmdElsAfterDown[0]?.classList.contains("command-palette__item--active")).toBe(true);

    // Filter for Toggle Theme and execute with Enter.
    input.value = "> theme";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    const themeButtons = container.querySelectorAll<HTMLButtonElement>(
      ".command-palette__item--cmd",
    );
    expect(themeButtons.length).toBeGreaterThanOrEqual(1);
    expect(themeButtons[0]?.textContent).toContain("> Toggle Theme");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushUi();

    expect(theme.value).toBe("light");
    expect(commandPaletteOpen.value).toBe(false);

    // Reopen CommandPalette, filter for Perf HUD, press Enter -> mounts PerfHud.
    expect(container.querySelector(".perf-hud")).toBeNull();
    openCommandPalette();
    await flushUi();

    const input2 = container.querySelector<HTMLInputElement>(".command-palette__input");
    expect(input2).not.toBeNull();
    if (!input2) return;

    input2.value = "> perf hud";
    input2.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();

    input2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushUi();

    expect(perfHudOpen.value).toBe(true);
    expect(commandPaletteOpen.value).toBe(false);
    expect(container.querySelector(".perf-hud")).not.toBeNull();

    // Reopen CommandPalette, filter for Settings, press Enter -> opens Settings modal.
    openCommandPalette();
    await flushUi();
    const input3 = container.querySelector<HTMLInputElement>(".command-palette__input");
    expect(input3).not.toBeNull();
    if (!input3) return;

    input3.value = "> settings";
    input3.dispatchEvent(new Event("input", { bubbles: true }));
    await flushUi();
    input3.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushUi();

    expect(settingsModalOpen.value).toBe(true);
    expect(modalState.value).toBe("command");
  });
});

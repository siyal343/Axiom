import { useEffect } from "preact/hooks";
import { shortcutsHelpOpen } from "../store/selection";

interface ShortcutRow {
  keys: string;
  action: string;
}

const NAV_EDIT_ROWS: ShortcutRow[] = [
  { keys: "H / J / K / L or Arrows", action: "Traverse parent, sibling, or child" },
  { keys: "Shift + J / K", action: "Multi-select siblings" },
  { keys: "Ctrl/Cmd + A", action: "Select all nodes in flow" },
  { keys: "Enter", action: "Edit focused node" },
  { keys: "Ctrl + Enter", action: "Save & run @tag or open A-chord in editor" },
  { keys: "Double-click", action: "Center zoom; edit user nodes" },
  { keys: "Right-click", action: "Open node context menu" },
  { keys: "Tab", action: "Create child node and edit" },
  { keys: "Shift + Enter", action: "Create sibling branch and edit" },
  { keys: "N", action: "Create free core node" },
  { keys: "Esc", action: "Save & exit editor or close overlay" },
];

const GRAPH_CONTEXT_ROWS: ShortcutRow[] = [
  { keys: "E or Port-drag / Alt+Drag", action: "Connect nodes with typed edge" },
  { keys: "1 – 6", action: "Pick edge type in connect popover" },
  { keys: "P / X", action: "Pin globally or exclude from AI" },
  { keys: "C / Shift + C", action: "Fold selection or fold entire subtree" },
  { keys: "T", action: "Tidy subtree layout" },
  { keys: "Hold V / Shift + V", action: "Peek or pin interactive Context X-Ray" },
  { keys: "Ctrl/Cmd + Z / Shift+Z", action: "Undo / Redo" },
  { keys: "Del / Backspace", action: "Dismiss active loophole or delete selection/edge" },
];

const AI_LENS_ROWS: ShortcutRow[] = [
  { keys: "A → R / E / D / F", action: "Red-Team, Edge Case, Diverge, Feynman" },
  { keys: "A → Q / L / T", action: "Study & Recall, Research Map, or Triage" },
  { keys: "A → S", action: "Synthesize 2+ selected nodes" },
  { keys: "A → Space", action: "Custom AI prompt on focused node" },
  { keys: "@tag in Editor / Ctrl+K", action: "Run @Feynman, @Study, @Research, @RedTeam, @Triage" },
  { keys: "R / Shift + R", action: "Resolve loophole or lock/unlock node(s)" },
  { keys: "[ / ]", action: "Cycle active loopholes by severity" },
];

const WORKSPACE_ROWS: ShortcutRow[] = [
  { keys: "Ctrl/Cmd + K", action: "Search nodes, > commands, or @ actions" },
  { keys: "Ctrl/Cmd + B", action: "Toggle Workspaces & Flows sidebar" },
  { keys: "Ctrl/Cmd + ,", action: "Open AI & Workspace Settings" },
  { keys: "Ctrl/Cmd + = / - / 0", action: "Zoom in, zoom out, reset 100%" },
  { keys: "F / F F", action: "Fit selection/subtree or fit entire graph" },
  { keys: "M", action: "Toggle canvas minimap" },
  { keys: "?", action: "Toggle this shortcuts reference" },
];

function ShortcutSection({ title, rows }: { title: string; rows: ShortcutRow[] }) {
  return (
    <section class="shortcuts-section">
      <h3 class="shortcuts-section__title">{title}</h3>
      <table class="shortcuts-table">
        <tbody>
          {rows.map((row) => (
            <tr key={row.keys}>
              <th scope="row" class="shortcuts-table__keys">
                <kbd class="shortcuts-kbd">{row.keys}</kbd>
              </th>
              <td class="shortcuts-table__action">{row.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ShortcutsModal() {
  const isOpen = shortcutsHelpOpen.value;

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        shortcutsHelpOpen.value = false;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      class="settings-modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          shortcutsHelpOpen.value = false;
        }
      }}
    >
      <div
        class="settings-modal shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard Shortcuts"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header class="settings-modal__header">
          <h2 class="settings-modal__title">Keyboard Shortcuts</h2>
          <button
            type="button"
            class="settings-btn settings-btn--secondary"
            onClick={() => {
              shortcutsHelpOpen.value = false;
            }}
          >
            Close (Esc)
          </button>
        </header>
        <div class="settings-modal__body shortcuts-modal__grid">
          <ShortcutSection title="Navigation & Editing" rows={NAV_EDIT_ROWS} />
          <ShortcutSection title="Graph & Context" rows={GRAPH_CONTEXT_ROWS} />
          <ShortcutSection title="AI Lenses & Triage" rows={AI_LENS_ROWS} />
          <ShortcutSection title="Canvas & Workspace" rows={WORKSPACE_ROWS} />
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "preact/hooks";
import type { FlowTemplate } from "../ipc/types";
import { openSettingsModal } from "../store/aiRunner";
import { openCommandPalette, shortcutsHelpOpen } from "../store/selection";
import {
  closeSidebar,
  createFlowAction,
  createWorkspaceAction,
  deleteFlowAction,
  deleteWorkspaceAction,
  openFlowAction,
  renameFlowAction,
  renameWorkspaceAction,
  sidebarOpen,
  toggleSidebar,
  workspaceCatalog,
} from "../store/workspaceCatalogStore";

const TEMPLATE_OPTIONS: ReadonlyArray<{ value: FlowTemplate; label: string }> = [
  { value: "engineering", label: "Design" },
  { value: "study", label: "Study" },
  { value: "research", label: "Research" },
  { value: "blank", label: "Blank" },
];

export function formatRelativeAge(updatedAtMs: number): string {
  const diffMs = Math.max(0, Date.now() - updatedAtMs);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 13.75 13.75" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1.75" />
      <path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M11.5 6.75h.01M5 9.5h6" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2.5 4h11M4.75 8h6.5M6.75 12h2.5" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.35 1.5h5.15A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
      <path d="M8 7.25v3.5M6.25 9h3.5" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.35 1.5h5.15A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="3.5" cy="8" r="0.85" fill="currentColor" />
      <circle cx="8" cy="8" r="0.85" fill="currentColor" />
      <circle cx="12.5" cy="8" r="0.85" fill="currentColor" />
    </svg>
  );
}

function SettingsGearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 2.25v1.3M8 12.45v1.3M3.93 3.93l.92.92M11.15 11.15l.92.92M2.25 8h1.3M12.45 8h1.3M3.93 12.07l.92-.92M11.15 4.85l.92-.92" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

type EditingTarget =
  | { kind: "workspace"; workspaceId: string; value: string }
  | { kind: "flow"; workspaceId: string; flowId: string; value: string };

type DeleteConfirmTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "flow"; workspaceId: string; flowId: string };

type RowMenuTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "flow"; workspaceId: string; flowId: string };

export function WorkspaceSidebar() {
  const catalog = workspaceCatalog.value;
  const open = sidebarOpen.value;

  const asideRef = useRef<HTMLElement | null>(null);
  const [collapsedWsIds, setCollapsedWsIds] = useState<Record<string, boolean>>({});

  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");

  const [newWsOpen, setNewWsOpen] = useState(false);
  const [newWsName, setNewWsName] = useState("");

  const [newFlowWsId, setNewFlowWsId] = useState<string | null>(null);
  const [newFlowName, setNewFlowName] = useState("");
  const [newFlowTemplate, setNewFlowTemplate] = useState<FlowTemplate>("engineering");

  const [rowMenu, setRowMenu] = useState<RowMenuTarget | null>(null);
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DeleteConfirmTarget | null>(null);

  useEffect(() => {
    const el = asideRef.current;
    if (el) {
      el.inert = !open;
    }
  }, [open]);

  const activeWs =
    catalog?.workspaces.find((w) => w.id === catalog.active_workspace_id) ??
    catalog?.workspaces[0];
  const activeFlow =
    activeWs?.flows.find((f) => f.id === catalog?.active_flow_id) ?? activeWs?.flows[0];

  const normalizedFilter = filterQuery.trim().toLowerCase();

  const toggleWorkspaceCollapsed = (wsId: string): void => {
    setCollapsedWsIds((prev) => ({ ...prev, [wsId]: !prev[wsId] }));
  };

  const handleCreateWorkspace = async (e: Event): Promise<void> => {
    e.preventDefault();
    const created = await createWorkspaceAction(newWsName);
    if (created) {
      setNewWsName("");
      setNewWsOpen(false);
    }
  };

  const handleCreateFlow = async (e: Event, wsId: string): Promise<void> => {
    e.preventDefault();
    const result = await createFlowAction(wsId, newFlowName, newFlowTemplate);
    if (result) {
      setNewFlowName("");
      setNewFlowTemplate("engineering");
      setNewFlowWsId(null);
    }
  };

  const handleCommitRename = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!editing) {
      return;
    }
    if (editing.kind === "workspace") {
      const updated = await renameWorkspaceAction(editing.workspaceId, editing.value);
      if (updated) {
        setEditing(null);
      }
      return;
    }
    const updated = await renameFlowAction(editing.workspaceId, editing.flowId, editing.value);
    if (updated) {
      setEditing(null);
    }
  };

  const handleConfirmDelete = async (): Promise<void> => {
    if (!confirmDelete) {
      return;
    }
    if (confirmDelete.kind === "workspace") {
      await deleteWorkspaceAction(confirmDelete.workspaceId);
    } else {
      await deleteFlowAction(confirmDelete.workspaceId, confirmDelete.flowId);
    }
    setConfirmDelete(null);
    setRowMenu(null);
  };

  const openPrimaryNewFlow = (): void => {
    if (!activeWs) {
      return;
    }
    const closing = newFlowWsId === activeWs.id;
    setNewFlowWsId(closing ? null : activeWs.id);
    setNewFlowName("");
    setNewFlowTemplate("engineering");
    setCollapsedWsIds((prev) => ({ ...prev, [activeWs.id]: false }));
    setConfirmDelete(null);
    setRowMenu(null);
  };

  return (
    <>
      <div
        class={`sidebar-toggle-bar ${open ? "sidebar-toggle-bar--shifted sidebar-toggle-bar--hidden" : ""}`}
        aria-hidden={open}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          class="sidebar-toggle-bar__btn"
          tabIndex={open ? -1 : undefined}
          aria-expanded={open}
          aria-controls="workspace-sidebar"
          aria-label="Open workspaces and flows sidebar"
          title="Open Workspaces & Flows (Ctrl/Cmd+B)"
          onClick={() => toggleSidebar()}
        >
          <span class="sidebar-toggle-bar__icon" aria-hidden="true">
            ☰
          </span>
          <span class="sidebar-toggle-bar__ws">{activeWs?.name ?? "Workspace"}</span>
          <span class="sidebar-toggle-bar__sep" aria-hidden="true">
            /
          </span>
          <span class="sidebar-toggle-bar__flow">{activeFlow?.name ?? "Flow"}</span>
        </button>
      </div>

      <aside
        ref={asideRef}
        id="workspace-sidebar"
        class={`workspace-sidebar ${open ? "workspace-sidebar--open" : ""}`}
        aria-label="Workspaces and flows"
        aria-hidden={!open}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div class="workspace-sidebar__top-stack">
          <button
            type="button"
            class="workspace-sidebar__primary-action"
            title="Create a new flow in active workspace"
            aria-label="New Flow"
            onClick={openPrimaryNewFlow}
          >
            <PlusIcon />
            <span>New Flow</span>
          </button>

          <button
            type="button"
            class="workspace-sidebar__nav-row"
            title="Search & Actions (Ctrl/Cmd+K)"
            aria-label="Search & Actions"
            onClick={() => {
              closeSidebar();
              openCommandPalette();
            }}
          >
            <SearchIcon />
            <span>Search &amp; Actions</span>
          </button>

          <button
            type="button"
            class="workspace-sidebar__nav-row"
            title="Keyboard Shortcuts (?)"
            aria-label="Shortcuts"
            onClick={() => {
              closeSidebar();
              shortcutsHelpOpen.value = true;
            }}
          >
            <KeyboardIcon />
            <span>Shortcuts</span>
          </button>
        </div>

        <div class="workspace-sidebar__section-header">
          <span class="workspace-sidebar__section-label">Workspaces</span>
          <div class="workspace-sidebar__section-actions">
            <button
              type="button"
              class={`workspace-sidebar__icon-btn ${filterOpen ? "workspace-sidebar__icon-btn--active" : ""}`}
              aria-label="Filter workspaces and flows"
              title="Filter workspaces and flows"
              onClick={() => {
                setFilterOpen((v) => {
                  if (v) setFilterQuery("");
                  return !v;
                });
              }}
            >
              <FilterIcon />
            </button>
            <button
              type="button"
              class={`workspace-sidebar__icon-btn ${newWsOpen ? "workspace-sidebar__icon-btn--active" : ""}`}
              aria-label="New workspace"
              title="New workspace"
              onClick={() => {
                setNewWsOpen((v) => !v);
                setNewWsName("");
                setConfirmDelete(null);
                setRowMenu(null);
              }}
            >
              <FolderPlusIcon />
            </button>
            <button
              type="button"
              class="workspace-sidebar__icon-btn"
              aria-label="Close sidebar"
              title="Close sidebar (Ctrl/Cmd+B)"
              onClick={() => closeSidebar()}
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {filterOpen && (
          <div class="workspace-sidebar__filter-box">
            <input
              type="text"
              class="workspace-sidebar__input"
              placeholder="Filter workspaces or flows..."
              aria-label="Filter workspaces or flows"
              value={filterQuery}
              autoFocus
              onInput={(e) => setFilterQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setFilterQuery("");
                  setFilterOpen(false);
                }
              }}
            />
          </div>
        )}

        {newWsOpen && (
          <form
            class="workspace-sidebar__inline-form"
            onSubmit={(e) => {
              void handleCreateWorkspace(e);
            }}
          >
            <input
              type="text"
              class="workspace-sidebar__input"
              placeholder="Workspace name..."
              value={newWsName}
              autoFocus
              onInput={(e) => setNewWsName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setNewWsOpen(false);
                }
              }}
            />
            <div class="workspace-sidebar__form-actions">
              <button type="submit" class="workspace-sidebar__btn workspace-sidebar__btn--primary">
                Create
              </button>
              <button
                type="button"
                class="workspace-sidebar__btn"
                onClick={() => setNewWsOpen(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        <div class="workspace-sidebar__list">
          {catalog?.workspaces.map((ws) => {
            const wsMatchesFilter =
              !normalizedFilter || ws.name.toLowerCase().includes(normalizedFilter);
            const filteredFlows = normalizedFilter
              ? wsMatchesFilter
                ? ws.flows
                : ws.flows.filter((f) => f.name.toLowerCase().includes(normalizedFilter))
              : ws.flows;

            if (normalizedFilter && !wsMatchesFilter && filteredFlows.length === 0) {
              return null;
            }

            const isCollapsed = normalizedFilter ? false : Boolean(collapsedWsIds[ws.id]);
            const isEditingWs = editing?.kind === "workspace" && editing.workspaceId === ws.id;
            const isDeletingWs =
              confirmDelete?.kind === "workspace" && confirmDelete.workspaceId === ws.id;
            const isWsMenuOpen = rowMenu?.kind === "workspace" && rowMenu.workspaceId === ws.id;
            const canDeleteWs = catalog.workspaces.length > 1;

            return (
              <section key={ws.id} class="workspace-group">
                <div class="workspace-group__header">
                  {isEditingWs ? (
                    <form
                      class="workspace-sidebar__rename-form"
                      onSubmit={(e) => {
                        void handleCommitRename(e);
                      }}
                    >
                      <input
                        type="text"
                        class="workspace-sidebar__input"
                        value={editing.value}
                        autoFocus
                        onInput={(e) =>
                          setEditing({
                            kind: "workspace",
                            workspaceId: ws.id,
                            value: e.currentTarget.value,
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            setEditing(null);
                          }
                        }}
                      />
                      <button
                        type="submit"
                        class="workspace-sidebar__mini-btn workspace-sidebar__mini-btn--primary"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        class="workspace-sidebar__mini-btn"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        class="workspace-group__toggle"
                        aria-expanded={!isCollapsed}
                        aria-label={`Toggle ${ws.name} workspace`}
                        title={`Toggle ${ws.name}`}
                        onClick={() => toggleWorkspaceCollapsed(ws.id)}
                      >
                        <span class="workspace-group__folder" aria-hidden="true">
                          <FolderIcon />
                        </span>
                        <span class="workspace-group__name">{ws.name}</span>
                      </button>
                      <div
                        class={`workspace-group__actions ${
                          isWsMenuOpen || newFlowWsId === ws.id || isDeletingWs
                            ? "workspace-row-actions--visible"
                            : ""
                        }`}
                      >
                        <button
                          type="button"
                          class="workspace-sidebar__icon-btn"
                          title={`Add flow to ${ws.name}`}
                          aria-label={`Add flow to ${ws.name}`}
                          onClick={() => {
                            setNewFlowWsId(newFlowWsId === ws.id ? null : ws.id);
                            setNewFlowName("");
                            setNewFlowTemplate("engineering");
                            setCollapsedWsIds((prev) => ({ ...prev, [ws.id]: false }));
                            setConfirmDelete(null);
                            setRowMenu(null);
                          }}
                        >
                          <PlusIcon />
                        </button>
                        <button
                          type="button"
                          class="workspace-sidebar__icon-btn"
                          title={`Workspace actions for ${ws.name}`}
                          aria-label={`Workspace actions for ${ws.name}`}
                          aria-expanded={isWsMenuOpen}
                          onClick={() => {
                            setRowMenu(
                              isWsMenuOpen ? null : { kind: "workspace", workspaceId: ws.id },
                            );
                            setConfirmDelete(null);
                          }}
                        >
                          <DotsIcon />
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {isWsMenuOpen && !isEditingWs && (
                  <div class="workspace-row-popover">
                    <button
                      type="button"
                      class="workspace-sidebar__mini-btn"
                      onClick={() => {
                        setEditing({ kind: "workspace", workspaceId: ws.id, value: ws.name });
                        setRowMenu(null);
                        setConfirmDelete(null);
                      }}
                    >
                      Rename
                    </button>
                    {canDeleteWs &&
                      (isDeletingWs ? (
                        <>
                          <button
                            type="button"
                            class="workspace-sidebar__mini-btn workspace-sidebar__mini-btn--danger"
                            onClick={() => {
                              void handleConfirmDelete();
                            }}
                          >
                            Confirm Delete
                          </button>
                          <button
                            type="button"
                            class="workspace-sidebar__mini-btn"
                            onClick={() => setConfirmDelete(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          class="workspace-sidebar__mini-btn workspace-sidebar__mini-btn--danger"
                          onClick={() => {
                            setConfirmDelete({ kind: "workspace", workspaceId: ws.id });
                          }}
                        >
                          Delete
                        </button>
                      ))}
                  </div>
                )}

                {newFlowWsId === ws.id && (
                  <form
                    class="workspace-sidebar__inline-form"
                    onSubmit={(e) => {
                      void handleCreateFlow(e, ws.id);
                    }}
                  >
                    <input
                      type="text"
                      class="workspace-sidebar__input"
                      placeholder="Flow name..."
                      value={newFlowName}
                      autoFocus
                      onInput={(e) => setNewFlowName(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setNewFlowWsId(null);
                        }
                      }}
                    />
                    <div
                      class="workspace-template-pills"
                      role="radiogroup"
                      aria-label="Flow template"
                    >
                      {TEMPLATE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          role="radio"
                          aria-checked={newFlowTemplate === opt.value}
                          class={`workspace-template-pill ${
                            newFlowTemplate === opt.value ? "workspace-template-pill--active" : ""
                          }`}
                          onClick={() => setNewFlowTemplate(opt.value)}
                        >
                          <span
                            class={`workspace-flow-dot workspace-flow-dot--${opt.value}`}
                            aria-hidden="true"
                          />
                          <span>{opt.label}</span>
                        </button>
                      ))}
                    </div>
                    <div class="workspace-sidebar__form-actions">
                      <button
                        type="submit"
                        class="workspace-sidebar__btn workspace-sidebar__btn--primary"
                      >
                        Create Flow
                      </button>
                      <button
                        type="button"
                        class="workspace-sidebar__btn"
                        onClick={() => setNewFlowWsId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {!isCollapsed && (
                  <ul class="workspace-flow-list">
                    {filteredFlows.map((flow) => {
                      const isActive =
                        catalog.active_workspace_id === ws.id &&
                        catalog.active_flow_id === flow.id;
                      const isEditingFlow =
                        editing?.kind === "flow" &&
                        editing.workspaceId === ws.id &&
                        editing.flowId === flow.id;
                      const isDeletingFlow =
                        confirmDelete?.kind === "flow" &&
                        confirmDelete.workspaceId === ws.id &&
                        confirmDelete.flowId === flow.id;
                      const isFlowMenuOpen =
                        rowMenu?.kind === "flow" &&
                        rowMenu.workspaceId === ws.id &&
                        rowMenu.flowId === flow.id;
                      const canDeleteFlow = ws.flows.length > 1;

                      return (
                        <li
                          key={flow.id}
                          class={`workspace-flow-item ${
                            isActive ? "workspace-flow-item--active" : ""
                          }`}
                        >
                          {isEditingFlow ? (
                            <form
                              class="workspace-sidebar__rename-form"
                              onSubmit={(e) => {
                                void handleCommitRename(e);
                              }}
                            >
                              <input
                                type="text"
                                class="workspace-sidebar__input"
                                value={editing.value}
                                autoFocus
                                onInput={(e) =>
                                  setEditing({
                                    kind: "flow",
                                    workspaceId: ws.id,
                                    flowId: flow.id,
                                    value: e.currentTarget.value,
                                  })
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") {
                                    e.stopPropagation();
                                    setEditing(null);
                                  }
                                }}
                              />
                              <button
                                type="submit"
                                class="workspace-sidebar__mini-btn workspace-sidebar__mini-btn--primary"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                class="workspace-sidebar__mini-btn"
                                onClick={() => setEditing(null)}
                              >
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <>
                              <div class="workspace-flow-item__row">
                                <button
                                  type="button"
                                  class="workspace-flow-item__main"
                                  aria-current={isActive ? "page" : undefined}
                                  aria-label={`Open flow ${flow.name}`}
                                  title={`Open ${flow.name}`}
                                  onClick={() => {
                                    setRowMenu(null);
                                    void openFlowAction(ws.id, flow.id);
                                  }}
                                >
                                  <span
                                    class={`workspace-flow-dot workspace-flow-dot--${flow.template}`}
                                    aria-hidden="true"
                                  />
                                  <span class="workspace-flow-item__name">{flow.name}</span>
                                  <span class="workspace-flow-item__age">
                                    {formatRelativeAge(flow.updated_at)}
                                  </span>
                                </button>
                                <div
                                  class={`workspace-flow-item__actions ${
                                    isFlowMenuOpen || isDeletingFlow
                                      ? "workspace-row-actions--visible"
                                      : ""
                                  }`}
                                >
                                  <button
                                    type="button"
                                    class="workspace-sidebar__icon-btn"
                                    title={`Flow actions for ${flow.name}`}
                                    aria-label={`Flow actions for ${flow.name}`}
                                    aria-expanded={isFlowMenuOpen}
                                    onClick={() => {
                                      setRowMenu(
                                        isFlowMenuOpen
                                          ? null
                                          : { kind: "flow", workspaceId: ws.id, flowId: flow.id },
                                      );
                                      setConfirmDelete(null);
                                    }}
                                  >
                                    <DotsIcon />
                                  </button>
                                </div>
                              </div>

                              {isFlowMenuOpen && (
                                <div class="workspace-row-popover">
                                  <button
                                    type="button"
                                    class="workspace-sidebar__mini-btn"
                                    onClick={() => {
                                      setEditing({
                                        kind: "flow",
                                        workspaceId: ws.id,
                                        flowId: flow.id,
                                        value: flow.name,
                                      });
                                      setRowMenu(null);
                                      setConfirmDelete(null);
                                    }}
                                  >
                                    Rename
                                  </button>
                                  {canDeleteFlow &&
                                    (isDeletingFlow ? (
                                      <>
                                        <button
                                          type="button"
                                          class="workspace-sidebar__mini-btn workspace-sidebar__mini-btn--danger"
                                          onClick={() => {
                                            void handleConfirmDelete();
                                          }}
                                        >
                                          Confirm Delete
                                        </button>
                                        <button
                                          type="button"
                                          class="workspace-sidebar__mini-btn"
                                          onClick={() => setConfirmDelete(null)}
                                        >
                                          Cancel
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        class="workspace-sidebar__mini-btn workspace-sidebar__mini-btn--danger"
                                        onClick={() => {
                                          setConfirmDelete({
                                            kind: "flow",
                                            workspaceId: ws.id,
                                            flowId: flow.id,
                                          });
                                        }}
                                      >
                                        Delete
                                      </button>
                                    ))}
                                </div>
                              )}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>

        <footer class="workspace-sidebar__footer">
          <button
            type="button"
            class="workspace-sidebar__nav-row workspace-sidebar__footer-btn"
            aria-label="Settings"
            title="AI & Workspace Settings (Ctrl/Cmd+,)"
            onClick={() => {
              closeSidebar();
              openSettingsModal();
            }}
          >
            <SettingsGearIcon />
            <span>Settings</span>
          </button>
        </footer>
      </aside>
    </>
  );
}

import { useEffect, useRef, useState } from "preact/hooks";
import type { FlowTemplate } from "../ipc/types";
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

const TEMPLATE_LABELS: Record<FlowTemplate, string> = {
  engineering: "Design",
  research: "Research",
  study: "Study",
  blank: "Blank",
};

type EditingTarget =
  | { kind: "workspace"; workspaceId: string; value: string }
  | { kind: "flow"; workspaceId: string; flowId: string; value: string };

type DeleteConfirmTarget =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "flow"; workspaceId: string; flowId: string };

export function WorkspaceSidebar() {
  const catalog = workspaceCatalog.value;
  const open = sidebarOpen.value;

  const asideRef = useRef<HTMLElement | null>(null);
  const [collapsedWsIds, setCollapsedWsIds] = useState<Record<string, boolean>>({});

  const [newWsOpen, setNewWsOpen] = useState(false);
  const [newWsName, setNewWsName] = useState("");

  const [newFlowWsId, setNewFlowWsId] = useState<string | null>(null);
  const [newFlowName, setNewFlowName] = useState("");
  const [newFlowTemplate, setNewFlowTemplate] = useState<FlowTemplate>("engineering");

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
  };

  return (
    <>
      <div
        class={`sidebar-toggle-bar ${open ? "sidebar-toggle-bar--shifted" : ""}`}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          class="sidebar-toggle-bar__btn"
          aria-expanded={open}
          aria-controls="workspace-sidebar"
          title="Toggle Workspaces & Flows (Ctrl/Cmd+B)"
          onClick={() => toggleSidebar()}
        >
          <span class="sidebar-toggle-bar__icon" aria-hidden="true">
            {open ? "✕" : "☰"}
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
        <header class="workspace-sidebar__header">
          <div class="workspace-sidebar__heading">
            <h2 class="workspace-sidebar__title">Workspaces</h2>
            <span class="workspace-sidebar__count">{catalog?.workspaces.length ?? 0}</span>
          </div>
          <div class="workspace-sidebar__header-actions">
            <button
              type="button"
              class="workspace-sidebar__add-btn"
              onClick={() => {
                setNewWsOpen((v) => !v);
                setNewWsName("");
                setConfirmDelete(null);
              }}
            >
              + Workspace
            </button>
            <button
              type="button"
              class="workspace-sidebar__close-btn"
              aria-label="Close sidebar"
              onClick={() => closeSidebar()}
            >
              ✕
            </button>
          </div>
        </header>

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
            const isCollapsed = Boolean(collapsedWsIds[ws.id]);
            const isEditingWs = editing?.kind === "workspace" && editing.workspaceId === ws.id;
            const isDeletingWs =
              confirmDelete?.kind === "workspace" && confirmDelete.workspaceId === ws.id;
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
                        onClick={() => toggleWorkspaceCollapsed(ws.id)}
                      >
                        <span class="workspace-group__caret" aria-hidden="true">
                          {isCollapsed ? "▸" : "▾"}
                        </span>
                        <span class="workspace-group__name">{ws.name}</span>
                      </button>
                      <div class="workspace-group__actions">
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
                          }}
                        >
                          + Flow
                        </button>
                        <button
                          type="button"
                          class="workspace-sidebar__icon-btn"
                          title={`Rename ${ws.name}`}
                          aria-label={`Rename ${ws.name}`}
                          onClick={() => {
                            setEditing({ kind: "workspace", workspaceId: ws.id, value: ws.name });
                            setConfirmDelete(null);
                          }}
                        >
                          Edit
                        </button>
                        {canDeleteWs &&
                          (isDeletingWs ? (
                            <span class="workspace-sidebar__confirm-inline">
                              <button
                                type="button"
                                class="workspace-sidebar__mini-btn workspace-sidebar__mini-btn--danger"
                                onClick={() => {
                                  void handleConfirmDelete();
                                }}
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                class="workspace-sidebar__mini-btn"
                                onClick={() => setConfirmDelete(null)}
                              >
                                Keep
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              class="workspace-sidebar__icon-btn workspace-sidebar__icon-btn--danger"
                              title={`Delete ${ws.name}`}
                              aria-label={`Delete ${ws.name}`}
                              onClick={() => {
                                setConfirmDelete({ kind: "workspace", workspaceId: ws.id });
                                setEditing(null);
                              }}
                            >
                              Del
                            </button>
                          ))}
                      </div>
                    </>
                  )}
                </div>

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
                    <select
                      class="workspace-sidebar__select"
                      aria-label="Flow template"
                      value={newFlowTemplate}
                      onChange={(e) => setNewFlowTemplate(e.currentTarget.value as FlowTemplate)}
                    >
                      <option value="engineering">Design</option>
                      <option value="research">Research</option>
                      <option value="study">Study</option>
                      <option value="blank">Blank</option>
                    </select>
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
                    {ws.flows.map((flow) => {
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
                              <button
                                type="button"
                                class="workspace-flow-item__main"
                                aria-current={isActive ? "page" : undefined}
                                onClick={() => {
                                  void openFlowAction(ws.id, flow.id);
                                }}
                              >
                                <span class="workspace-flow-item__name">{flow.name}</span>
                                <span class="workspace-flow-item__badge">
                                  {TEMPLATE_LABELS[flow.template]}
                                </span>
                              </button>
                              <div class="workspace-flow-item__actions">
                                <button
                                  type="button"
                                  class="workspace-sidebar__icon-btn"
                                  title={`Rename ${flow.name}`}
                                  aria-label={`Rename ${flow.name}`}
                                  onClick={() => {
                                    setEditing({
                                      kind: "flow",
                                      workspaceId: ws.id,
                                      flowId: flow.id,
                                      value: flow.name,
                                    });
                                    setConfirmDelete(null);
                                  }}
                                >
                                  Edit
                                </button>
                                {canDeleteFlow &&
                                  (isDeletingFlow ? (
                                    <span class="workspace-sidebar__confirm-inline">
                                      <button
                                        type="button"
                                        class="workspace-sidebar__mini-btn workspace-sidebar__mini-btn--danger"
                                        onClick={() => {
                                          void handleConfirmDelete();
                                        }}
                                      >
                                        Delete
                                      </button>
                                      <button
                                        type="button"
                                        class="workspace-sidebar__mini-btn"
                                        onClick={() => setConfirmDelete(null)}
                                      >
                                        Keep
                                      </button>
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      class="workspace-sidebar__icon-btn workspace-sidebar__icon-btn--danger"
                                      title={`Delete ${flow.name}`}
                                      aria-label={`Delete ${flow.name}`}
                                      onClick={() => {
                                        setConfirmDelete({
                                          kind: "flow",
                                          workspaceId: ws.id,
                                          flowId: flow.id,
                                        });
                                        setEditing(null);
                                      }}
                                    >
                                      Del
                                    </button>
                                  ))}
                              </div>
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
      </aside>
    </>
  );
}

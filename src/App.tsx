import { useEffect, useState } from "preact/hooks";
import { isTauriRuntime, openWorkspace } from "./ipc/client";
import type { WorkspaceSnapshot } from "./ipc/types";

export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    let active = true;
    openWorkspace("")
      .then((ws) => {
        if (active) {
          setSnapshot(ws);
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        console.error("Failed to open default workspace:", err);
        if (active) {
          setLoadError(message);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main
      class="axiom-canvas-shell"
      data-workspace-ready={snapshot !== null ? "true" : "false"}
      data-node-count={snapshot ? String(snapshot.nodes.length) : "0"}
      data-load-error={loadError ?? ""}
    />
  );
}

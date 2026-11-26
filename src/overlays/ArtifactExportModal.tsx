import { useEffect, useRef, useState } from "preact/hooks";
import { exportMarkdownArtifact, isTauriRuntime, parseIpcError } from "../ipc/client";
import type { ArtifactFormat, ArtifactScope, CompiledArtifact } from "../ipc/types";
import { saveMarkdownArtifactToDisk } from "../ipc/workspaceActions";
import { graphVersion } from "../store/graphStore";
import {
  artifactExportFormat,
  artifactExportOpen,
  artifactExportScope,
  closeArtifactExport,
  focusId,
  selectedIds,
} from "../store/selection";
import { pushToast } from "./ToastStack";
import { useDialogFocusTrap } from "./useDialogFocusTrap";

const FORMAT_TABS: ReadonlyArray<{ value: ArtifactFormat; label: string }> = [
  { value: "adr", label: "ADR / RFC" },
  { value: "brief", label: "Research Brief" },
  { value: "mermaid", label: "Mermaid Graph" },
];

const SCOPE_OPTIONS: ReadonlyArray<{ value: ArtifactScope; label: string }> = [
  { value: "subgraph", label: "Focused Subgraph" },
  { value: "workspace", label: "Entire Flow" },
];

function slugifyFileName(title: string, format: ArtifactFormat): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || `axiom-${format}`}.md`;
}

export function ArtifactExportModal() {
  const isOpen = artifactExportOpen.value;
  const format = artifactExportFormat.value;
  const scope = artifactExportScope.value;
  const version = graphVersion.value;
  const fid = focusId.value;
  const sel = selectedIds.value;
  const selKey = Array.from(sel).join(",");
  const modalRef = useRef<HTMLDivElement | null>(null);
  useDialogFocusTrap(isOpen, modalRef);

  const [compiled, setCompiled] = useState<CompiledArtifact | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const focusIds = sel.size > 0 ? Array.from(sel) : fid !== null ? [fid] : [];
  const desktopRuntime = isTauriRuntime();

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeArtifactExport();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (!desktopRuntime) {
      setCompiled(null);
      setLoading(false);
      setErrorMsg(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);

    void exportMarkdownArtifact(focusIds, scope, format, null)
      .then((res) => {
        if (!cancelled) {
          setCompiled(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setCompiled(null);
          setLoading(false);
          setErrorMsg(parseIpcError(err).message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, desktopRuntime, format, scope, version, fid, selKey]);

  if (!isOpen) {
    return null;
  }

  const handleCopyMarkdown = (): void => {
    if (!compiled) {
      return;
    }
    if (!navigator.clipboard?.writeText) {
      pushToast("Clipboard API unavailable in this environment", "warning");
      return;
    }
    void navigator.clipboard
      .writeText(compiled.markdown)
      .then(() => {
        pushToast("Copied Markdown to clipboard", "info");
      })
      .catch(() => {
        pushToast("Could not copy Markdown to clipboard", "warning");
      });
  };

  const handleSaveDisk = async (): Promise<void> => {
    setSaving(true);
    try {
      const suggested = compiled
        ? slugifyFileName(compiled.title, format)
        : `axiom-${format}.md`;
      await saveMarkdownArtifactToDisk(focusIds, scope, format, suggested);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      class="settings-modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          closeArtifactExport();
        }
      }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        class="settings-modal artifact-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Export Markdown Artifact"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <header class="settings-modal__header">
          <h2 class="settings-modal__title">Export Markdown Artifact</h2>
          <button
            type="button"
            class="settings-btn settings-btn--secondary settings-modal__close"
            onClick={() => closeArtifactExport()}
          >
            Close (Esc)
          </button>
        </header>

        <div class="artifact-modal__controls">
          <div class="artifact-modal__tabs" role="tablist" aria-label="Artifact format">
            {FORMAT_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={format === tab.value}
                class={`artifact-modal__tab ${
                  format === tab.value ? "artifact-modal__tab--active" : ""
                }`}
                onClick={() => {
                  artifactExportFormat.value = tab.value;
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div class="artifact-modal__scope" role="radiogroup" aria-label="Export scope">
            {SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={scope === opt.value}
                class={`artifact-modal__scope-btn ${
                  scope === opt.value ? "artifact-modal__scope-btn--active" : ""
                }`}
                onClick={() => {
                  artifactExportScope.value = opt.value;
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div class="settings-modal__body artifact-modal__body">
          {!desktopRuntime ? (
            <p class="settings-preview-banner" role="note">
              Browser preview mode: the Rust Markdown artifact compiler runs in the Axiom Tauri
              desktop runtime.
            </p>
          ) : loading ? (
            <p class="artifact-modal__status" role="status">
              Compiling Markdown artifact…
            </p>
          ) : errorMsg ? (
            <p class="settings-test-result settings-test-result--err" role="alert">
              {errorMsg}
            </p>
          ) : compiled ? (
            <>
              <div class="artifact-modal__stats">
                <span>
                  {compiled.node_count} nodes · {compiled.edge_count} edges ·{" "}
                  {compiled.unresolved_loophole_count} open risks
                </span>
              </div>
              <pre class="artifact-modal__preview">{compiled.markdown}</pre>
            </>
          ) : null}
        </div>

        <footer class="settings-modal__footer">
          <button
            type="button"
            class="settings-btn settings-btn--secondary"
            disabled={!compiled || loading}
            onClick={handleCopyMarkdown}
          >
            Copy Markdown
          </button>
          <button
            type="button"
            class="settings-btn settings-btn--primary"
            disabled={!desktopRuntime || !compiled || loading || saving}
            onClick={() => void handleSaveDisk()}
          >
            {saving ? "Saving…" : "Save .md"}
          </button>
        </footer>
      </div>
    </div>
  );
}

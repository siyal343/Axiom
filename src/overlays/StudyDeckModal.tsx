import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { clampZoom } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import { renderMarkdownToSanitizedHtml } from "../cards/markdownCache";
import { parseIpcError } from "../ipc/client";
import type { StudyCardDto, StudyCardKind, StudyRating } from "../ipc/types";
import { cameraControllerRef, edgesMap, nodesMap } from "../store/graphStore";
import { focusId, selectSingle } from "../store/selection";
import {
  closeStudyModal,
  createStudyCardAction,
  deleteStudyCardAction,
  formatIntervalPreview,
  getScopedStudyCards,
  reviewStudyCardAction,
  studyCards,
  studyCreateFormOpen,
  studyFocusNodeId,
  studyLoading,
  studyModalOpen,
  studyScope,
  syncStudyDeckAction,
  type StudyScope,
} from "../store/studyStore";
import { pushToast } from "./ToastStack";

const KIND_LABELS: Record<StudyCardKind, string> = {
  qa: "Q&A",
  feynman: "Feynman",
  loophole: "Loophole",
  manual: "Manual",
};

const SCOPE_OPTIONS: ReadonlyArray<{ id: StudyScope; label: string }> = [
  { id: "due", label: "Due Now" },
  { id: "flow", label: "Current Flow" },
  { id: "subtree", label: "Focused Subtree" },
];

const RATING_OPTIONS: ReadonlyArray<{
  rating: StudyRating;
  keyHint: string;
  label: string;
  toneClass: string;
}> = [
  { rating: "again", keyHint: "1", label: "Again", toneClass: "study-grade-btn--again" },
  { rating: "hard", keyHint: "2", label: "Hard", toneClass: "study-grade-btn--hard" },
  { rating: "good", keyHint: "3", label: "Good", toneClass: "study-grade-btn--good" },
  { rating: "easy", keyHint: "4", label: "Easy", toneClass: "study-grade-btn--easy" },
];

function isOutsideRect(rect: DOMRect, clientX: number, clientY: number): boolean {
  return (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  );
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function jumpToSourceNode(nodeId: string): void {
  selectSingle(nodeId);
  const ctrl = cameraControllerRef.current;
  const node = nodesMap.get(nodeId);
  if (ctrl && node) {
    const cx = node.layout.x + node.layout.width / 2;
    const cy = node.layout.y + getEffectiveNodeHeight(node) / 2;
    const cam = ctrl.getCamera();
    const { width, height } = ctrl.getViewportSize();
    const targetZoom = clampZoom(Math.max(cam.zoom, 0.85));
    ctrl.animateTo(
      {
        x: width / 2 - cx * targetZoom,
        y: height / 2 - cy * targetZoom,
        zoom: targetZoom,
      },
      220,
    );
  }
  closeStudyModal();
}

export function StudyDeckModal() {
  const isOpen = studyModalOpen.value;
  const allCards = studyCards.value;
  const scope = studyScope.value;
  const loading = studyLoading.value;
  const focusedTargetId = studyFocusNodeId.value ?? focusId.value;
  const createFormOpen = studyCreateFormOpen.value;

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [cardIndex, setCardIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [answerDraft, setAnswerDraft] = useState("");

  const nowMs = Date.now();
  const scopedCards = useMemo(
    () => getScopedStudyCards(allCards, scope, focusedTargetId, nodesMap, edgesMap, nowMs),
    [allCards, scope, focusedTargetId],
  );
  const dueInScopeCount = useMemo(
    () => scopedCards.filter((c) => c.due_at <= nowMs).length,
    [scopedCards],
  );

  const safeIndex =
    scopedCards.length === 0 ? 0 : Math.min(Math.max(0, cardIndex), scopedCards.length - 1);
  const activeCard: StudyCardDto | null = scopedCards[safeIndex] ?? null;

  const promptHtml = useMemo(
    () => (activeCard ? renderMarkdownToSanitizedHtml(activeCard.prompt) : ""),
    [activeCard?.id, activeCard?.prompt],
  );
  const answerHtml = useMemo(
    () => (activeCard && revealed ? renderMarkdownToSanitizedHtml(activeCard.answer) : ""),
    [activeCard?.id, activeCard?.answer, revealed],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (isOpen) {
      setRevealed(false);
      setCardIndex(0);
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") {
          try {
            dialog.showModal();
          } catch {
            dialog.setAttribute("open", "");
          }
        } else {
          dialog.setAttribute("open", "");
        }
      }
    } else if (dialog.open) {
      if (typeof dialog.close === "function") {
        try {
          dialog.close();
        } catch {
          dialog.removeAttribute("open");
        }
      } else {
        dialog.removeAttribute("open");
      }
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onWindowKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (studyCreateFormOpen.value) {
        studyCreateFormOpen.value = false;
      } else {
        closeStudyModal();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [isOpen]);

  // Fallback light-dismiss when native `closedBy` is unsupported on HTMLDialogElement.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !isOpen) {
      return;
    }
    if ("closedBy" in HTMLDialogElement.prototype) {
      return;
    }

    let downOutside = false;
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target !== dialog) {
        downOutside = false;
        return;
      }
      downOutside = isOutsideRect(dialog.getBoundingClientRect(), e.clientX, e.clientY);
    };
    const onPointerUp = (e: PointerEvent): void => {
      if (
        downOutside &&
        e.target === dialog &&
        isOutsideRect(dialog.getBoundingClientRect(), e.clientX, e.clientY)
      ) {
        closeStudyModal();
      }
      downOutside = false;
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointerup", onPointerUp);
    return () => {
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointerup", onPointerUp);
    };
  }, [isOpen]);

  const handleGrade = async (rating: StudyRating): Promise<void> => {
    if (!activeCard || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await reviewStudyCardAction(activeCard.id, rating);
      setRevealed(false);
      if (scope !== "due" && scopedCards.length > 1) {
        setCardIndex((idx) => (idx + 1) % scopedCards.length);
      } else {
        setCardIndex((idx) => Math.min(idx, Math.max(0, scopedCards.length - 2)));
      }
    } catch (err) {
      pushToast(parseIpcError(err).message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteCard = async (cardId: string): Promise<void> => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await deleteStudyCardAction(cardId);
      setRevealed(false);
      setCardIndex((idx) => Math.min(idx, Math.max(0, scopedCards.length - 2)));
      pushToast("Deleted study card", "info");
    } catch (err) {
      pushToast(parseIpcError(err).message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const targetNodeId =
        focusedTargetId && nodesMap.has(focusedTargetId) ? focusedTargetId : null;
      await createStudyCardAction({
        nodeId: targetNodeId,
        prompt: promptDraft,
        answer: answerDraft,
        cardKind: "manual",
      });
      setPromptDraft("");
      setAnswerDraft("");
      studyCreateFormOpen.value = false;
      setRevealed(false);
      setCardIndex(0);
      pushToast("Added study card", "info");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : parseIpcError(err).message, "warning");
    } finally {
      setSubmitting(false);
    }
  };

  const linkedTargetNode =
    focusedTargetId && nodesMap.has(focusedTargetId) ? nodesMap.get(focusedTargetId) : null;
  const activeSourceNode =
    activeCard?.node_id && nodesMap.has(activeCard.node_id)
      ? nodesMap.get(activeCard.node_id)
      : null;

  const handleDialogKeyDown = (e: KeyboardEvent): void => {
    if (!isOpen) {
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (studyCreateFormOpen.value) {
        studyCreateFormOpen.value = false;
      } else {
        closeStudyModal();
      }
      return;
    }
    if (isEditableElement(e.target) || createFormOpen || !activeCard) {
      return;
    }

    if ((e.key === " " || e.key === "Enter") && !revealed) {
      if (e.target instanceof HTMLButtonElement && e.target.dataset.studyAction !== "reveal") {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setRevealed(true);
      return;
    }

    if (revealed) {
      const ratingByKey: Record<string, StudyRating> = {
        "1": "again",
        "2": "hard",
        "3": "good",
        "4": "easy",
      };
      const chosen = ratingByKey[e.key];
      if (chosen) {
        e.preventDefault();
        e.stopPropagation();
        void handleGrade(chosen);
        return;
      }
    }

    if (e.key.toLowerCase() === "j" && activeCard.node_id && nodesMap.has(activeCard.node_id)) {
      e.preventDefault();
      e.stopPropagation();
      jumpToSourceNode(activeCard.node_id);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby="study-dialog-title"
      class="study-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (studyCreateFormOpen.value) {
          studyCreateFormOpen.value = false;
        } else {
          closeStudyModal();
        }
      }}
      onClose={() => {
        if (studyModalOpen.value) {
          closeStudyModal();
        }
      }}
      onKeyDown={handleDialogKeyDown}
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header class="study-dialog__header">
        <div class="study-dialog__title-row">
          <h1 id="study-dialog-title" class="study-dialog__title">
            Study &amp; Recall Studio
          </h1>
          <div class="study-dialog__tabs" role="tablist" aria-label="Study deck scope">
            {SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={scope === opt.id}
                class={`study-dialog__tab ${scope === opt.id ? "study-dialog__tab--active" : ""}`}
                onClick={() => {
                  studyScope.value = opt.id;
                  studyCreateFormOpen.value = false;
                  setRevealed(false);
                  setCardIndex(0);
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div class="study-dialog__header-actions">
          {!createFormOpen && (activeCard !== null || loading) && (
            <button
              type="button"
              class="settings-btn settings-btn--secondary"
              aria-expanded={createFormOpen}
              onClick={() => {
                studyCreateFormOpen.value = true;
              }}
            >
              + New Card
            </button>
          )}
          <button
            type="button"
            class="study-dialog__close"
            aria-label="Close study dialog"
            onClick={() => closeStudyModal()}
          >
            ×
          </button>
        </div>
      </header>

      <div class="study-dialog__body">
        {createFormOpen ? (
          <form class="study-create-form" onSubmit={(e) => void handleCreateSubmit(e)}>
            <div class="study-create-form__meta">
              <span class="settings-section__title">Create Flashcard</span>
              {linkedTargetNode ? (
                <span class="badge">Linked: {linkedTargetNode.title || "Untitled"}</span>
              ) : (
                <span class="badge">Standalone card</span>
              )}
            </div>
            <label class="settings-field">
              <span class="settings-field__label">Prompt / Question</span>
              <input
                type="text"
                class="settings-input"
                placeholder="What invariant prevents split-brain writes?"
                value={promptDraft}
                onInput={(e) => setPromptDraft((e.target as HTMLInputElement).value)}
                required
              />
            </label>
            <label class="settings-field">
              <span class="settings-field__label">Answer (Markdown &amp; KaTeX supported)</span>
              <textarea
                class="settings-textarea"
                placeholder="Majority quorum intersection ($W + R > N$)."
                value={answerDraft}
                onInput={(e) => setAnswerDraft((e.target as HTMLTextAreaElement).value)}
                required
              />
            </label>
            <div class="study-create-form__actions">
              <button
                type="button"
                class="settings-btn settings-btn--secondary"
                onClick={() => {
                  studyCreateFormOpen.value = false;
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="settings-btn settings-btn--primary"
                disabled={submitting}
              >
                {submitting ? "Saving..." : "Create Card"}
              </button>
            </div>
          </form>
        ) : loading && allCards.length === 0 ? (
          <div class="study-empty" role="status">
            <p class="study-empty__text">Syncing study deck from canvas...</p>
          </div>
        ) : !activeCard ? (
          <div class="study-empty">
            <p class="study-empty__title">
              {scope === "due" && allCards.length > 0
                ? "All due cards reviewed!"
                : "No study cards in this scope"}
            </p>
            <p class="study-empty__text">
              Add <code>@study</code> or <code>@feynman</code> cards on your canvas, create active
              loophole probes, or create a manual card above.
            </p>
            <div class="study-empty__actions">
              {scope === "due" && allCards.length > 0 && (
                <button
                  type="button"
                  class="settings-btn settings-btn--primary"
                  onClick={() => {
                    studyScope.value = "flow";
                    setCardIndex(0);
                    setRevealed(false);
                  }}
                >
                  Review All in Flow ({allCards.length})
                </button>
              )}
              <button
                type="button"
                class="settings-btn settings-btn--secondary"
                onClick={() => {
                  void syncStudyDeckAction();
                }}
              >
                Sync Deck
              </button>
              <button
                type="button"
                class={`settings-btn ${
                  scope === "due" && allCards.length > 0
                    ? "settings-btn--secondary"
                    : "settings-btn--primary"
                }`}
                onClick={() => {
                  studyCreateFormOpen.value = true;
                }}
              >
                + Create Flashcard
              </button>
            </div>
          </div>
        ) : (
          <div class="study-stage">
            <div class="study-stage__meta">
              <div class="study-stage__meta-left">
                <span class="study-counter">
                  {safeIndex + 1} of {scopedCards.length}
                </span>
                <span class="study-queue-breakdown">
                  {dueInScopeCount} due · {allCards.length} in flow
                </span>
                <span class={`badge study-kind-badge study-kind-badge--${activeCard.card_kind}`}>
                  {KIND_LABELS[activeCard.card_kind]}
                </span>
              </div>
              <div class="study-stage__meta-right">
                {activeCard.node_id && activeSourceNode && (
                  <button
                    type="button"
                    class="study-jump-btn"
                    title="Jump to source node on canvas (J)"
                    onClick={() => {
                      if (activeCard.node_id) {
                        jumpToSourceNode(activeCard.node_id);
                      }
                    }}
                  >
                    J · Jump to {activeSourceNode.title || "node"}
                  </button>
                )}
                <button
                  type="button"
                  class="study-delete-btn"
                  title="Delete study card"
                  aria-label="Delete study card"
                  disabled={submitting}
                  onClick={() => void handleDeleteCard(activeCard.id)}
                >
                  🗑
                </button>
              </div>
            </div>

            <article class="study-card-face">
              <div class="study-card-face__label">Prompt</div>
              <div
                class="study-card-face__prompt markdown-body"
                // Sanitized by DOMPurify inside renderMarkdownToSanitizedHtml.
                dangerouslySetInnerHTML={{ __html: promptHtml }}
              />
            </article>

            {!revealed ? (
              <div class="study-reveal-row">
                <button
                  type="button"
                  data-study-action="reveal"
                  class="study-reveal-btn"
                  onClick={() => setRevealed(true)}
                >
                  Reveal Answer <kbd class="shortcuts-kbd">Space / Enter</kbd>
                </button>
              </div>
            ) : (
              <div class="study-answer-section">
                <article class="study-card-face study-card-face--answer">
                  <div class="study-card-face__label">Answer</div>
                  <div
                    class="study-card-face__answer markdown-body"
                    // Sanitized by DOMPurify inside renderMarkdownToSanitizedHtml.
                    dangerouslySetInnerHTML={{ __html: answerHtml }}
                  />
                </article>

                <div class="study-sm2-stats">
                  <span>Rep {activeCard.repetitions}</span>
                  <span>·</span>
                  <span>Ease {activeCard.ease_factor.toFixed(2)}</span>
                  <span>·</span>
                  <span>Interval {activeCard.interval_days}d</span>
                  {activeCard.lapses > 0 && (
                    <>
                      <span>·</span>
                      <span>Lapses {activeCard.lapses}</span>
                    </>
                  )}
                </div>

                <div class="study-grade-row" role="group" aria-label="Rate recall">
                  {RATING_OPTIONS.map((opt) => (
                    <button
                      key={opt.rating}
                      type="button"
                      class={`study-grade-btn ${opt.toneClass}`}
                      disabled={submitting}
                      onClick={() => void handleGrade(opt.rating)}
                    >
                      <span class="study-grade-btn__top">
                        <kbd class="shortcuts-kbd">{opt.keyHint}</kbd>
                        <span>{opt.label}</span>
                      </span>
                      <span class="study-grade-btn__interval">
                        {formatIntervalPreview(activeCard, opt.rating)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </dialog>
  );
}

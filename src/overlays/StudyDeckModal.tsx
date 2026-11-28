import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { clampZoom } from "../canvas/camera";
import { getEffectiveNodeHeight } from "../canvas/spatialIndex";
import { renderMarkdownToSanitizedHtml } from "../cards/markdownCache";
import { useSimHydration } from "../cards/simMountHost";
import { parseIpcError } from "../ipc/client";
import type { StudyCardDto, StudyCardKind, StudyRating } from "../ipc/types";
import { cameraControllerRef, edgesMap, nodesMap } from "../store/graphStore";
import { focusId, selectSingle } from "../store/selection";
import {
  closeStudyModal,
  createStudyCardAction,
  deleteStudyCardAction,
  extractHintFromAnswer,
  formatIntervalPreview,
  getScopedStudyCards,
  interleaveStudyCards,
  reviewStudyCardAction,
  studyCards,
  studyCreateFormOpen,
  studyFocusNodeId,
  studyLoading,
  studyModalOpen,
  studyScope,
  syncStudyDeckAction,
  updateStudyCardAction,
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
  return Boolean(
    target.closest("input:not([type='range']), textarea, select, [contenteditable='true']"),
  );
}

function isRangeSlider(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.type === "range";
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
  const attemptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formPromptInputRef = useRef<HTMLInputElement | null>(null);
  const [cardIndex, setCardIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [answerDraft, setAnswerDraft] = useState("");
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [hintOpen, setHintOpen] = useState(false);
  const [attemptOpen, setAttemptOpen] = useState(false);
  const [attemptText, setAttemptText] = useState("");
  const [interleaved, setInterleaved] = useState(false);
  const [interleaveSeed, setInterleaveSeed] = useState(1);
  const [sessionStats, setSessionStats] = useState({ reviewed: 0, strong: 0, again: 0 });
  const [relearnIds, setRelearnIds] = useState<string[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const nowMs = useMemo(() => Date.now(), [isOpen, allCards, scope, focusedTargetId]);
  const dueCards = useMemo(() => {
    const baseDue = getScopedStudyCards(allCards, "due", focusedTargetId, nodesMap, edgesMap, nowMs);
    if (relearnIds.length === 0) {
      return baseDue;
    }
    const baseIds = new Set(baseDue.map((c) => c.id));
    const byId = new Map(allCards.map((c) => [c.id, c]));
    const queued: StudyCardDto[] = [];
    for (const id of relearnIds) {
      if (baseIds.has(id)) {
        continue;
      }
      const card = byId.get(id);
      if (card) {
        queued.push(card);
      }
    }
    return [...baseDue, ...queued];
  }, [allCards, focusedTargetId, nowMs, relearnIds]);
  const flowCards = useMemo(
    () => getScopedStudyCards(allCards, "flow", focusedTargetId, nodesMap, edgesMap, nowMs),
    [allCards, focusedTargetId, nowMs],
  );
  const subtreeCards = useMemo(
    () => getScopedStudyCards(allCards, "subtree", focusedTargetId, nodesMap, edgesMap, nowMs),
    [allCards, focusedTargetId, nowMs],
  );
  const scopeCounts: Record<StudyScope, number> = {
    due: dueCards.length,
    flow: flowCards.length,
    subtree: subtreeCards.length,
  };
  const scopedCards = scope === "due" ? dueCards : scope === "subtree" ? subtreeCards : flowCards;
  const displayCards = useMemo(
    () => (interleaved ? interleaveStudyCards(scopedCards, interleaveSeed) : scopedCards),
    [scopedCards, interleaved, interleaveSeed],
  );
  const dueInScopeCount = useMemo(() => {
    const relearnSet = new Set(relearnIds);
    return displayCards.filter((c) => c.due_at <= nowMs || relearnSet.has(c.id)).length;
  }, [displayCards, nowMs, relearnIds]);

  const safeIndex =
    displayCards.length === 0 ? 0 : Math.min(Math.max(0, cardIndex), displayCards.length - 1);
  const activeCard: StudyCardDto | null = displayCards[safeIndex] ?? null;

  const hintText = useMemo(
    () => (activeCard ? extractHintFromAnswer(activeCard.answer) : ""),
    [activeCard?.id, activeCard?.answer],
  );
  const promptHtml = useMemo(
    () => (activeCard ? renderMarkdownToSanitizedHtml(activeCard.prompt) : ""),
    [activeCard?.id, activeCard?.prompt],
  );
  const answerHtml = useMemo(
    () => (activeCard && revealed ? renderMarkdownToSanitizedHtml(activeCard.answer) : ""),
    [activeCard?.id, activeCard?.answer, revealed],
  );
  const answerBodyRef = useRef<HTMLDivElement | null>(null);
  useSimHydration(answerBodyRef, answerHtml, isOpen && revealed);

  useEffect(() => {
    if (!isOpen || !revealed) {
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || !dialog.contains(active)) {
      const raf = requestAnimationFrame(() => {
        dialogRef.current?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [isOpen, revealed]);

  useEffect(() => {
    setHintOpen(false);
    setAttemptOpen(false);
    setAttemptText("");
    setConfirmDeleteId(null);
  }, [activeCard?.id, scope]);

  useEffect(() => {
    if (attemptOpen && !revealed) {
      attemptTextareaRef.current?.focus();
    }
  }, [attemptOpen, revealed]);

  useEffect(() => {
    if (createFormOpen) {
      formPromptInputRef.current?.focus();
    }
  }, [createFormOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (isOpen) {
      setRevealed(false);
      setCardIndex(0);
      setHintOpen(false);
      setAttemptOpen(false);
      setAttemptText("");
      setEditingCardId(null);
      setSessionStats({ reviewed: 0, strong: 0, again: 0 });
      setRelearnIds([]);
      setConfirmDeleteId(null);
      setFormError(null);
      if (!studyCreateFormOpen.value) {
        setPromptDraft("");
        setAnswerDraft("");
      }
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
    } else {
      if (typeof dialog.close === "function" && dialog.open) {
        try {
          dialog.close();
        } catch {
          // Fallback to attribute removal below in constrained runtimes.
        }
      }
      dialog.removeAttribute("open");
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
        setEditingCardId(null);
        setFormError(null);
        studyCreateFormOpen.value = false;
      } else if (confirmDeleteId !== null) {
        setConfirmDeleteId(null);
      } else {
        closeStudyModal();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [isOpen, confirmDeleteId]);

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

  const openCreateForm = (): void => {
    setEditingCardId(null);
    setPromptDraft("");
    setAnswerDraft("");
    setFormError(null);
    setConfirmDeleteId(null);
    studyCreateFormOpen.value = true;
  };

  const openEditForm = (card: StudyCardDto): void => {
    setEditingCardId(card.id);
    setPromptDraft(card.prompt);
    setAnswerDraft(card.answer);
    setFormError(null);
    setConfirmDeleteId(null);
    studyCreateFormOpen.value = true;
  };

  const stepCard = (delta: -1 | 1): void => {
    if (displayCards.length <= 1) {
      return;
    }
    setRevealed(false);
    setHintOpen(false);
    setAttemptOpen(false);
    setAttemptText("");
    setConfirmDeleteId(null);
    setCardIndex((idx) => (idx + delta + displayCards.length) % displayCards.length);
  };

  const handleGrade = async (rating: StudyRating): Promise<void> => {
    if (!activeCard || submitting) {
      return;
    }
    const gradedId = activeCard.id;
    setSubmitting(true);
    try {
      await reviewStudyCardAction(gradedId, rating);
      setSessionStats((prev) => ({
        reviewed: prev.reviewed + 1,
        strong: prev.strong + (rating === "again" ? 0 : 1),
        again: prev.again + (rating === "again" ? 1 : 0),
      }));
      setRelearnIds((prev) => {
        const without = prev.filter((id) => id !== gradedId);
        return rating === "again" ? [...without, gradedId] : without;
      });
      setRevealed(false);
      setHintOpen(false);
      setAttemptOpen(false);
      setAttemptText("");
      setConfirmDeleteId(null);
      if (scope !== "due" && displayCards.length > 1) {
        setCardIndex((idx) => (idx + 1) % displayCards.length);
      } else {
        const remainingCount =
          rating === "again" ? displayCards.length : Math.max(0, displayCards.length - 1);
        setCardIndex((idx) => Math.min(idx, Math.max(0, remainingCount - 1)));
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
    if (confirmDeleteId !== cardId) {
      setConfirmDeleteId(cardId);
      return;
    }
    setSubmitting(true);
    try {
      await deleteStudyCardAction(cardId);
      setRelearnIds((prev) => prev.filter((id) => id !== cardId));
      setConfirmDeleteId(null);
      setRevealed(false);
      setHintOpen(false);
      setAttemptOpen(false);
      setAttemptText("");
      setCardIndex((idx) => Math.min(idx, Math.max(0, displayCards.length - 2)));
      pushToast("Deleted study card", "info");
    } catch (err) {
      pushToast(parseIpcError(err).message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleFormSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (submitting) {
      return;
    }
    if (promptDraft.trim().length === 0) {
      setFormError("Enter a question or prompt before saving.");
      formPromptInputRef.current?.focus();
      return;
    }
    if (answerDraft.trim().length === 0) {
      setFormError("Enter an answer before saving.");
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      if (editingCardId) {
        await updateStudyCardAction(editingCardId, promptDraft, answerDraft);
        setEditingCardId(null);
        setPromptDraft("");
        setAnswerDraft("");
        studyCreateFormOpen.value = false;
        pushToast("Updated study card", "info");
      } else {
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
        setHintOpen(false);
        setAttemptOpen(false);
        setAttemptText("");
        setCardIndex(0);
        pushToast("Added study card", "info");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : parseIpcError(err).message;
      setFormError(msg);
      pushToast(msg, "warning");
    } finally {
      setSubmitting(false);
    }
  };

  const linkedTargetNode =
    focusedTargetId && nodesMap.has(focusedTargetId) ? nodesMap.get(focusedTargetId) : null;
  const editingCard = editingCardId ? allCards.find((c) => c.id === editingCardId) ?? null : null;
  const editingSourceNode =
    editingCard?.node_id && nodesMap.has(editingCard.node_id)
      ? nodesMap.get(editingCard.node_id)
      : null;
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
        setEditingCardId(null);
        studyCreateFormOpen.value = false;
      } else {
        closeStudyModal();
      }
      return;
    }
    if (isEditableElement(e.target) || createFormOpen || !activeCard) {
      return;
    }
    if (
      isRangeSlider(e.target) &&
      (e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "Home" ||
        e.key === "End")
    ) {
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

    const noModifier = !e.ctrlKey && !e.metaKey && !e.altKey;
    const lowerKey = e.key.toLowerCase();

    if (noModifier && !revealed && lowerKey === "h" && hintText.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      setHintOpen((v) => !v);
      return;
    }

    if (noModifier && !revealed && lowerKey === "a") {
      e.preventDefault();
      e.stopPropagation();
      setAttemptOpen((v) => !v);
      return;
    }

    if (noModifier && lowerKey === "e") {
      e.preventDefault();
      e.stopPropagation();
      openEditForm(activeCard);
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

    if (noModifier && (e.key === "[" || e.key === "ArrowLeft")) {
      e.preventDefault();
      e.stopPropagation();
      stepCard(-1);
      return;
    }

    if (noModifier && (e.key === "]" || e.key === "ArrowRight")) {
      e.preventDefault();
      e.stopPropagation();
      stepCard(1);
      return;
    }

    if (noModifier && lowerKey === "j" && activeCard.node_id && nodesMap.has(activeCard.node_id)) {
      e.preventDefault();
      e.stopPropagation();
      jumpToSourceNode(activeCard.node_id);
    }
  };

  const progressTotal =
    scope === "due" ? sessionStats.strong + dueInScopeCount : displayCards.length;
  const progressDone = scope === "due" ? sessionStats.strong : displayCards.length > 0 ? safeIndex + 1 : 0;
  const progressPct = progressTotal > 0 ? Math.round((progressDone / progressTotal) * 100) : 0;

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      closedby="any"
      aria-labelledby="study-dialog-title"
      class="study-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (studyCreateFormOpen.value) {
          setEditingCardId(null);
          setFormError(null);
          studyCreateFormOpen.value = false;
        } else if (confirmDeleteId !== null) {
          setConfirmDeleteId(null);
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
                  setEditingCardId(null);
                  setRevealed(false);
                  setHintOpen(false);
                  setAttemptOpen(false);
                  setAttemptText("");
                  setCardIndex(0);
                }}
              >
                {opt.label} ({scopeCounts[opt.id]})
              </button>
            ))}
          </div>
          <button
            type="button"
            class={`study-interleave-btn ${interleaved ? "study-interleave-btn--active" : ""}`}
            aria-pressed={interleaved}
            title="Interleave topics and card types for mixed exam drill"
            onClick={() => {
              setInterleaved((prev) => {
                const next = !prev;
                if (next) {
                  setInterleaveSeed((s) => s + 1);
                }
                return next;
              });
              setCardIndex(0);
              setRevealed(false);
              setHintOpen(false);
              setAttemptOpen(false);
              setAttemptText("");
            }}
          >
            Interleave
          </button>
        </div>
        <div class="study-dialog__header-actions">
          {!createFormOpen && (activeCard !== null || loading) && (
            <button
              type="button"
              class="settings-btn settings-btn--secondary"
              aria-expanded={createFormOpen}
              onClick={openCreateForm}
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
          <form class="study-create-form" noValidate onSubmit={(e) => void handleFormSubmit(e)}>
            <div class="study-create-form__meta">
              <span class="settings-section__title">
                {editingCardId ? "Edit Flashcard" : "Create Flashcard"}
              </span>
              {editingCardId ? (
                <span class="badge">
                  {editingSourceNode
                    ? `${editingSourceNode.title || "Untitled"} · Keeps schedule`
                    : "Keeps review schedule"}
                </span>
              ) : linkedTargetNode ? (
                <span class="badge">Linked: {linkedTargetNode.title || "Untitled"}</span>
              ) : (
                <span class="badge">Standalone card</span>
              )}
            </div>
            <div class="settings-field">
              <label for="study-form-prompt" class="settings-field__label">
                Prompt / Question
              </label>
              <input
                id="study-form-prompt"
                ref={formPromptInputRef}
                type="text"
                class="settings-input"
                placeholder="What invariant prevents split-brain writes?"
                value={promptDraft}
                onInput={(e) => {
                  setPromptDraft((e.target as HTMLInputElement).value);
                  if (formError) setFormError(null);
                }}
                onChange={(e) => {
                  setPromptDraft((e.target as HTMLInputElement).value);
                  if (formError) setFormError(null);
                }}
                required
              />
            </div>
            <div class="settings-field">
              <label for="study-form-answer" class="settings-field__label">
                Answer (Markdown, KaTeX &amp; ```axiom-sim supported)
              </label>
              <textarea
                id="study-form-answer"
                class="settings-textarea"
                placeholder="Majority quorum intersection ($W + R > N$)."
                value={answerDraft}
                onInput={(e) => {
                  setAnswerDraft((e.target as HTMLTextAreaElement).value);
                  if (formError) setFormError(null);
                }}
                onChange={(e) => {
                  setAnswerDraft((e.target as HTMLTextAreaElement).value);
                  if (formError) setFormError(null);
                }}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                required
              />
            </div>
            {formError && (
              <p class="study-form-error" role="alert">
                {formError}
              </p>
            )}
            <div class="study-create-form__actions">
              <button
                type="button"
                class="settings-btn settings-btn--secondary"
                onClick={() => {
                  setEditingCardId(null);
                  setFormError(null);
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
                {submitting ? "Saving..." : editingCardId ? "Save Changes" : "Create Card"}
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
            {sessionStats.reviewed > 0 && (
              <p class="study-session-summary">
                Session: {sessionStats.reviewed} reviewed · {sessionStats.strong} strong
                {sessionStats.again > 0 ? ` · ${sessionStats.again} again` : ""}
              </p>
            )}
            <p class="study-empty__text">
              Add <code>@study</code> or <code>@feynman</code> cards on your canvas, create active
              loophole probes, or create a manual card below.
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
                    setHintOpen(false);
                    setAttemptOpen(false);
                    setAttemptText("");
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
                onClick={openCreateForm}
              >
                + Create Flashcard
              </button>
            </div>
          </div>
        ) : (
          <div class="study-stage">
            <div
              class="study-progress"
              role="progressbar"
              aria-label="Study session progress"
              aria-valuemin={0}
              aria-valuemax={progressTotal}
              aria-valuenow={progressDone}
            >
              <div class="study-progress__fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div class="study-stage__meta">
              <div class="study-stage__meta-left">
                <div class="study-nav-group">
                  {displayCards.length > 1 && (
                    <button
                      type="button"
                      class="study-step-btn"
                      aria-label="Previous card"
                      title="Previous card ([ or ←)"
                      onClick={() => stepCard(-1)}
                    >
                      ‹
                    </button>
                  )}
                  <span class="study-counter">
                    {safeIndex + 1} of {displayCards.length}
                  </span>
                  {displayCards.length > 1 && (
                    <button
                      type="button"
                      class="study-step-btn"
                      aria-label="Next card"
                      title="Next card (] or →)"
                      onClick={() => stepCard(1)}
                    >
                      ›
                    </button>
                  )}
                </div>
                <span class="study-queue-breakdown">
                  {dueInScopeCount} due · {allCards.length} in flow
                </span>
                {sessionStats.reviewed > 0 && (
                  <span class="study-session-summary">
                    Session: {sessionStats.reviewed} reviewed · {sessionStats.strong} strong
                    {sessionStats.again > 0 ? ` · ${sessionStats.again} again` : ""}
                  </span>
                )}
                <span class={`badge study-kind-badge study-kind-badge--${activeCard.card_kind}`}>
                  {KIND_LABELS[activeCard.card_kind]}
                </span>
                {relearnIds.includes(activeCard.id) && (
                  <span class="badge study-relearn-badge">Re-learn</span>
                )}
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
                  class="study-edit-btn"
                  title="Edit card prompt & answer (E)"
                  disabled={submitting}
                  onClick={() => openEditForm(activeCard)}
                >
                  Edit <kbd class="shortcuts-kbd">E</kbd>
                </button>
                <button
                  type="button"
                  class={`study-delete-btn ${confirmDeleteId === activeCard.id ? "study-delete-btn--armed" : ""}`}
                  title={
                    confirmDeleteId === activeCard.id
                      ? "Click again to permanently delete card (Esc cancels)"
                      : "Delete study card"
                  }
                  aria-label={
                    confirmDeleteId === activeCard.id
                      ? "Confirm delete study card"
                      : "Delete study card"
                  }
                  disabled={submitting}
                  onClick={() => void handleDeleteCard(activeCard.id)}
                >
                  {confirmDeleteId === activeCard.id ? "Delete?" : "🗑"}
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
              <>
                {hintOpen && hintText.length > 0 && (
                  <div class="study-hint-box" role="note">
                    <span class="study-hint-box__label">Hint</span>
                    <span class="study-hint-box__text">{hintText}</span>
                  </div>
                )}
                {attemptOpen && (
                  <div class="study-attempt-box">
                    <div class="study-attempt-header">
                      <label for="study-attempt-textarea" class="study-attempt-label">
                        Closed-Book Attempt
                      </label>
                      <span class="study-attempt-hint">Ctrl+Enter to compare</span>
                    </div>
                    <textarea
                      id="study-attempt-textarea"
                      ref={attemptTextareaRef}
                      class="study-attempt-input"
                      rows={3}
                      placeholder="Draft formula, units, boundary check, or derivation steps before revealing..."
                      value={attemptText}
                      onInput={(e) => setAttemptText((e.target as HTMLTextAreaElement).value)}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                          e.preventDefault();
                          e.stopPropagation();
                          setRevealed(true);
                        }
                      }}
                    />
                  </div>
                )}
                <div class="study-reveal-row">
                  {hintText.length > 0 && (
                    <button
                      type="button"
                      class="study-secondary-btn"
                      aria-expanded={hintOpen}
                      onClick={() => setHintOpen((v) => !v)}
                    >
                      Hint <kbd class="shortcuts-kbd">H</kbd>
                    </button>
                  )}
                  <button
                    type="button"
                    class="study-secondary-btn"
                    aria-expanded={attemptOpen}
                    onClick={() => setAttemptOpen((v) => !v)}
                  >
                    Write attempt <kbd class="shortcuts-kbd">A</kbd>
                  </button>
                  <button
                    type="button"
                    data-study-action="reveal"
                    class="study-reveal-btn"
                    onClick={() => setRevealed(true)}
                  >
                    Reveal Answer <kbd class="shortcuts-kbd">Space / Enter</kbd>
                  </button>
                </div>
              </>
            ) : (
              <div class="study-answer-section">
                {attemptText.trim().length > 0 && (
                  <article class="study-card-face study-card-face--attempt">
                    <div class="study-card-face__label">Your Closed-Book Attempt</div>
                    <div class="study-attempt-compare__text">{attemptText.trim()}</div>
                  </article>
                )}
                <article class="study-card-face study-card-face--answer">
                  <div class="study-card-face__label">Answer</div>
                  <div
                    ref={answerBodyRef}
                    class="study-card-face__answer markdown-body"
                    // Sanitized by DOMPurify inside renderMarkdownToSanitizedHtml.
                    dangerouslySetInnerHTML={{ __html: answerHtml }}
                  />
                </article>

                <div class="study-sm2-stats">
                  {activeCard.repetitions === 0 && activeCard.lapses === 0 ? (
                    <span>New card · First review</span>
                  ) : (
                    <>
                      <span>Streak {activeCard.repetitions}</span>
                      <span>·</span>
                      <span>Current gap {activeCard.interval_days}d</span>
                      <span>·</span>
                      <span>Ease {activeCard.ease_factor.toFixed(2)}</span>
                      {activeCard.lapses > 0 && (
                        <>
                          <span>·</span>
                          <span>
                            {activeCard.lapses} {activeCard.lapses === 1 ? "miss" : "misses"}
                          </span>
                        </>
                      )}
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
            <footer class="study-shortcut-strip">
              Space reveal · H hint · A attempt · 1–4 rate · [ / ] browse · E edit · J source
            </footer>
          </div>
        )}
      </div>
    </dialog>
  );
}

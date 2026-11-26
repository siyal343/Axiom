import { computed, signal } from "@preact/signals";
import { collectSubtreeIds } from "../input/topologyNav";
import {
  createStudyCard,
  deleteStudyCard,
  isTauriRuntime,
  listStudyCards,
  reviewStudyCard,
  syncStudyDeck,
  updateStudyCard,
} from "../ipc/client";
import type {
  EdgeDto,
  NodeDto,
  Severity,
  StudyCardDto,
  StudyCardKind,
  StudyRating,
  StudySyncResult,
} from "../ipc/types";
import { edgesMap, nodesMap, workspacePath } from "./graphStore";
import { focusId } from "./selection";
import { workspaceCatalog } from "./workspaceCatalogStore";

export type StudyScope = "due" | "flow" | "subtree";

export interface StudyCandidateLocal {
  node_id: string;
  card_kind: StudyCardKind;
  prompt: string;
  answer: string;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const STUDY_STORAGE_PREFIX = "axiom_study_cards_v1_";
const memoryStudyStorage = new Map<string, string>();

export const studyCards = signal<StudyCardDto[]>([]);
export const studyModalOpen = signal<boolean>(false);
export const studyScope = signal<StudyScope>("due");
export const studyLoading = signal<boolean>(false);
export const studyFocusNodeId = signal<string | null>(null);
export const studyCreateFormOpen = signal<boolean>(false);

export const dueStudyCount = computed<number>(() => {
  const now = Date.now();
  return studyCards.value.filter((card) => card.due_at <= now).length;
});

function getLocalStorageKey(): string {
  const catalog = workspaceCatalog.value;
  const scopeId = catalog?.active_flow_id || workspacePath.value || "default";
  return `${STUDY_STORAGE_PREFIX}${scopeId}`;
}

function readLocalStudyCards(): StudyCardDto[] {
  const key = getLocalStorageKey();
  let raw: string | null = null;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      raw = window.localStorage.getItem(key);
    }
  } catch {
    raw = null;
  }
  if (raw === null) {
    raw = memoryStudyStorage.get(key) ?? null;
  }
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StudyCardDto[]) : [];
  } catch {
    return [];
  }
}

function writeLocalStudyCards(cards: StudyCardDto[]): void {
  const key = getLocalStorageKey();
  const serialized = JSON.stringify(cards);
  memoryStudyStorage.set(key, serialized);
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(key, serialized);
    }
  } catch {
    // Keep in-memory copy when localStorage is unavailable or full.
  }
}

function sortStudyCards(cards: StudyCardDto[]): StudyCardDto[] {
  return [...cards].sort((a, b) => a.due_at - b.due_at || a.created_at - b.created_at);
}

export function applySm2ReviewLocal(
  card: StudyCardDto,
  rating: StudyRating,
  nowMs = Date.now(),
): StudyCardDto {
  let repetitions = card.repetitions;
  let intervalDays = card.interval_days;
  let easeFactor = card.ease_factor;
  let lapses = card.lapses;
  let dueAt = card.due_at;

  switch (rating) {
    case "again": {
      repetitions = 0;
      intervalDays = 0;
      lapses += 1;
      easeFactor = Math.max(1.3, easeFactor - 0.2);
      dueAt = nowMs + MS_PER_MINUTE;
      break;
    }
    case "hard": {
      intervalDays =
        repetitions === 0
          ? 1
          : repetitions === 1
            ? 3
            : Math.max(1, Math.round(intervalDays * 1.2));
      repetitions += 1;
      easeFactor = Math.max(1.3, easeFactor - 0.15);
      dueAt = nowMs + intervalDays * MS_PER_DAY;
      break;
    }
    case "good": {
      intervalDays =
        repetitions === 0
          ? 1
          : repetitions === 1
            ? 6
            : Math.max(1, Math.round(intervalDays * easeFactor));
      repetitions += 1;
      dueAt = nowMs + intervalDays * MS_PER_DAY;
      break;
    }
    case "easy": {
      intervalDays =
        repetitions === 0
          ? 4
          : Math.max(1, Math.round(intervalDays * easeFactor * 1.3));
      repetitions += 1;
      easeFactor = Math.min(3.5, easeFactor + 0.15);
      dueAt = nowMs + intervalDays * MS_PER_DAY;
      break;
    }
  }

  return {
    ...card,
    repetitions,
    interval_days: intervalDays,
    ease_factor: easeFactor,
    lapses,
    due_at: dueAt,
    last_reviewed_at: nowMs,
    updated_at: card.updated_at,
  };
}

export function formatIntervalPreview(card: StudyCardDto, rating: StudyRating): string {
  if (rating === "again") {
    return "1m";
  }
  const next = applySm2ReviewLocal(card, rating, 0);
  const days = next.interval_days;
  if (days < 30) {
    return `${days}d`;
  }
  if (days < 365) {
    return `${Math.round(days / 30)}mo`;
  }
  return `${(days / 365).toFixed(1)}y`;
}

function hasTag(text: string, tag: string): boolean {
  if (!tag || text.length < tag.length) {
    return false;
  }
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`, "i");
  return pattern.test(text);
}

function hasContentTag(content: string, tag: string): boolean {
  if (!tag || content.length < tag.length) {
    return false;
  }
  const lowerTag = tag.toLowerCase();
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmedStart = rawLine.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmedStart);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      const rest = fenceMatch[2] ?? "";
      const ch = marker[0] === "~" ? "~" : "`";
      if (fenceChar === null) {
        if (!(ch === "`" && rest.includes("`"))) {
          fenceChar = ch;
          fenceLen = marker.length;
        }
        continue;
      }
      if (ch === fenceChar && marker.length >= fenceLen && rest.trim() === "") {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }

    if (fenceChar !== null) {
      continue;
    }

    const trimmed = rawLine.trim();
    if (trimmed.length < lowerTag.length) {
      continue;
    }
    if (!trimmed.slice(0, lowerTag.length).toLowerCase().startsWith(lowerTag)) {
      continue;
    }
    const nextChar = trimmed[lowerTag.length];
    if (nextChar === undefined || /\s/.test(nextChar) || nextChar === ":") {
      return true;
    }
  }

  return false;
}

function isPlaceholderContent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  return lower === "thinking..." || lower === "thinking…" || lower === "..." || lower === "todo";
}

function stripListPrefix(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("+ ")) {
    return trimmed.slice(2).trimStart();
  }
  const numMatch = /^\d+[.)]\s+(.*)$/.exec(trimmed);
  if (numMatch && numMatch[1] !== undefined) {
    return numMatch[1].trimStart();
  }
  return trimmed;
}

function stripCiPrefix(s: string, prefixes: readonly string[]): string | null {
  const lower = s.toLowerCase();
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      return s.slice(prefix.length);
    }
  }
  return null;
}

const QUESTION_PREFIXES = [
  "**question:**",
  "**question**:",
  "__question:__",
  "__question__:",
  "question:",
  "**q:**",
  "**q**:",
  "__q:__",
  "__q__:",
  "q:",
] as const;

const ANSWER_PREFIXES = [
  "**answer:**",
  "**answer**:",
  "__answer:__",
  "__answer__:",
  "answer:",
  "**a:**",
  "**a**:",
  "__a:__",
  "__a__:",
  "a:",
] as const;

const INLINE_ANSWER_MARKERS = [
  "**answer:**",
  "**answer**:",
  "__answer:__",
  "__answer__:",
  "**a:**",
  "**a**:",
  "__a:__",
  "__a__:",
  "answer:",
  "a:",
] as const;

function stripQaMarker(line: string, isQuestion: boolean): string | null {
  const clean = stripListPrefix(line);
  const rest = stripCiPrefix(clean, isQuestion ? QUESTION_PREFIXES : ANSWER_PREFIXES);
  if (rest === null) {
    return null;
  }
  return rest.replace(/^[*_]+/, "").trim();
}

function splitInlineAnswer(restOfQ: string): [string, string] | null {
  for (let i = 1; i < restOfQ.length; i += 1) {
    const prev = restOfQ[i - 1];
    if (!prev || (!/\s/.test(prev) && prev !== "—" && prev !== "–" && prev !== "-" && prev !== "|")) {
      continue;
    }
    const tail = restOfQ.slice(i);
    const after = stripCiPrefix(tail, INLINE_ANSWER_MARKERS);
    if (after !== null) {
      const afterClean = after.replace(/^[*_]+/, "").trim();
      if (afterClean.length === 0) {
        continue;
      }
      const qPart = restOfQ
        .slice(0, i)
        .trim()
        .replace(/[—–\-|\s]+$/, "")
        .trim();
      if (qPart.length > 0) {
        return [qPart, afterClean];
      }
    }
  }
  return null;
}

function parseQaBlocks(content: string): [string, string] | null {
  type ParseState = "idle" | "in_question" | "in_answer";
  const pairs: Array<[string, string]> = [];
  let state: ParseState = "idle";
  let currentQ = "";
  let currentA = "";

  const flushPair = (): void => {
    const q = currentQ.trim();
    const a = currentA.trim();
    if (q.length > 0 && a.length > 0) {
      pairs.push([q, a]);
    }
    currentQ = "";
    currentA = "";
    state = "idle";
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const qRest = stripQaMarker(trimmed, true);
    if (qRest !== null) {
      flushPair();
      const inline = splitInlineAnswer(qRest);
      if (inline) {
        pairs.push(inline);
        state = "idle";
      } else {
        currentQ = qRest;
        state = "in_question";
      }
      continue;
    }

    const aRest = stripQaMarker(trimmed, false);
    if (aRest !== null) {
      if (state === "in_question" || currentQ.trim().length > 0) {
        currentA = aRest;
        state = "in_answer";
      }
      continue;
    }

    if (state === "in_question") {
      if (trimmed === "---" || trimmed.startsWith("#")) {
        flushPair();
      } else if (trimmed.length > 0) {
        currentQ = currentQ.length > 0 ? `${currentQ}\n${trimmed}` : trimmed;
      }
    } else if (state === "in_answer") {
      if (trimmed === "---" || trimmed.startsWith("#")) {
        flushPair();
      } else if (trimmed.length === 0) {
        if (currentA.trim().length > 0) {
          currentA += "\n";
        }
      } else {
        if (currentA.length > 0 && !currentA.endsWith("\n")) {
          currentA += "\n";
        }
        currentA += trimmed;
      }
    }
  }

  flushPair();

  if (pairs.length === 0) {
    return null;
  }
  if (pairs.length === 1) {
    return pairs[0] ?? null;
  }
  const prompt = pairs.map(([q], i) => `${i + 1}. ${q}`).join("\n");
  const answer = pairs.map(([, a], i) => `${i + 1}. ${a}`).join("\n");
  return [prompt, answer];
}

function severityRank(sev: Severity | null): number {
  switch (sev) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function truncateChars(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const keep = Math.max(0, maxChars - 3);
  return `${trimmed.slice(0, keep).trimEnd()}...`;
}

function formatLoopholeAnswer(loopholes: NodeDto[]): string {
  const lines: string[] = [];
  for (const lh of loopholes.slice(0, 3)) {
    const rawBody = lh.summary.trim().length > 0 ? lh.summary.trim() : lh.content.trim();
    const excerpt = truncateChars(rawBody, 180);
    const lhTitle = lh.title.trim();
    let line = "";
    if (!lhTitle) {
      line = excerpt;
    } else if (!excerpt) {
      line = lhTitle;
    } else {
      line = `${lhTitle}: ${excerpt}`;
    }
    if (line.length > 0) {
      lines.push(line);
    }
  }
  if (lines.length <= 1) {
    return lines[0] ?? "";
  }
  return lines.map((l) => `- ${l}`).join("\n");
}

export function extractStudyCandidatesLocal(
  nodes: ReadonlyMap<string, NodeDto>,
  edges: ReadonlyMap<string, EdgeDto>,
): StudyCandidateLocal[] {
  const candidates: StudyCandidateLocal[] = [];
  const sortedNodes = Array.from(nodes.values()).sort((a, b) => a.id.localeCompare(b.id));

  for (const node of sortedNodes) {
    if (node.status === "dismissed") {
      continue;
    }

    const title = node.title.trim();
    const content = node.content.trim();

    const isStudyNode =
      hasTag(node.title, "@study") ||
      hasContentTag(node.content, "@study") ||
      node.metadata.lens === "study";
    if (isStudyNode && !isPlaceholderContent(content)) {
      const qa = parseQaBlocks(content);
      if (qa) {
        if (!isPlaceholderContent(qa[0]) && !isPlaceholderContent(qa[1])) {
          candidates.push({
            node_id: node.id,
            card_kind: "qa",
            prompt: qa[0],
            answer: qa[1],
          });
        }
      } else if (title.length > 0 && !isPlaceholderContent(title)) {
        candidates.push({
          node_id: node.id,
          card_kind: "qa",
          prompt: title,
          answer: content,
        });
      }
    }

    const isFeynmanNode =
      hasTag(node.title, "@feynman") ||
      hasContentTag(node.content, "@feynman") ||
      node.metadata.lens === "feynman";
    if (
      isFeynmanNode &&
      title.length > 0 &&
      !isPlaceholderContent(title) &&
      !isPlaceholderContent(content) &&
      content.length >= 15
    ) {
      candidates.push({
        node_id: node.id,
        card_kind: "feynman",
        prompt: `Explain from first principles: ${title}`,
        answer: content,
      });
    }

    if (title.length > 0) {
      const activeLoopholes: NodeDto[] = [];
      for (const edge of edges.values()) {
        if (edge.target_id !== node.id || edge.type !== "challenges") {
          continue;
        }
        const src = nodes.get(edge.source_id);
        if (
          src &&
          src.status === "active" &&
          (src.title.trim().length > 0 || src.content.trim().length > 0)
        ) {
          activeLoopholes.push(src);
        }
      }
      if (activeLoopholes.length > 0) {
        activeLoopholes.sort(
          (a, b) =>
            severityRank(b.metadata.severity) - severityRank(a.metadata.severity) ||
            a.id.localeCompare(b.id),
        );
        const answer = formatLoopholeAnswer(activeLoopholes);
        if (answer.length > 0) {
          candidates.push({
            node_id: node.id,
            card_kind: "loophole",
            prompt: `What failure mode or loophole threatens "${title}"?`,
            answer,
          });
        }
      }
    }
  }

  return candidates;
}

function syncStudyDeckLocal(nowMs = Date.now()): StudySyncResult {
  const candidates = extractStudyCandidatesLocal(nodesMap, edgesMap);
  const existing = readLocalStudyCards();
  const activeLoopholeNodeIds = new Set(
    candidates.filter((c) => c.card_kind === "loophole").map((c) => c.node_id),
  );

  const retained: StudyCardDto[] = [];
  const existingByKey = new Map<string, StudyCardDto>();

  for (const card of existing) {
    if (card.card_kind === "manual") {
      retained.push(card);
      continue;
    }
    if (!card.node_id || !nodesMap.has(card.node_id)) {
      continue;
    }
    if (card.card_kind === "loophole" && !activeLoopholeNodeIds.has(card.node_id)) {
      continue;
    }
    const key = `${card.node_id}:${card.card_kind}`;
    existingByKey.set(key, card);
    retained.push(card);
  }

  let addedCount = 0;
  for (const candidate of candidates) {
    const key = `${candidate.node_id}:${candidate.card_kind}`;
    const found = existingByKey.get(key);
    const nodeUpdatedAt = nodesMap.get(candidate.node_id)?.updated_at ?? nowMs;
    if (found) {
      const customizedAfterNode = found.updated_at > nodeUpdatedAt;
      if (!customizedAfterNode && (found.prompt !== candidate.prompt || found.answer !== candidate.answer)) {
        found.prompt = candidate.prompt;
        found.answer = candidate.answer;
        found.updated_at = nodeUpdatedAt;
      }
    } else {
      const created: StudyCardDto = {
        id: `card_${nowMs}_${Math.random().toString(36).slice(2, 8)}`,
        node_id: candidate.node_id,
        prompt: candidate.prompt,
        answer: candidate.answer,
        card_kind: candidate.card_kind,
        repetitions: 0,
        interval_days: 0,
        ease_factor: 2.5,
        lapses: 0,
        due_at: nowMs,
        last_reviewed_at: null,
        created_at: nowMs,
        updated_at: nodeUpdatedAt,
      };
      retained.push(created);
      existingByKey.set(key, created);
      addedCount += 1;
    }
  }

  const sorted = sortStudyCards(retained);
  writeLocalStudyCards(sorted);
  studyCards.value = sorted;
  return { cards: sorted, added_count: addedCount };
}

export async function syncStudyDeckAction(): Promise<StudySyncResult> {
  studyLoading.value = true;
  try {
    if (isTauriRuntime()) {
      const res = await syncStudyDeck();
      const sorted = sortStudyCards(res.cards);
      studyCards.value = sorted;
      return { cards: sorted, added_count: res.added_count };
    }
    return syncStudyDeckLocal();
  } finally {
    studyLoading.value = false;
  }
}

export async function listStudyCardsAction(dueOnly = false): Promise<StudyCardDto[]> {
  if (isTauriRuntime()) {
    const cards = await listStudyCards(dueOnly);
    if (!dueOnly) {
      studyCards.value = sortStudyCards(cards);
    }
    return cards;
  }
  const now = Date.now();
  const cards = sortStudyCards(readLocalStudyCards());
  studyCards.value = cards;
  return dueOnly ? cards.filter((c) => c.due_at <= now) : cards;
}

export async function createStudyCardAction(params: {
  nodeId?: string | null;
  prompt: string;
  answer: string;
  cardKind?: StudyCardKind;
}): Promise<StudyCardDto> {
  const prompt = params.prompt.trim();
  const answer = params.answer.trim();
  if (!prompt) {
    throw new Error("Study card prompt cannot be empty");
  }
  if (!answer) {
    throw new Error("Study card answer cannot be empty");
  }

  if (isTauriRuntime()) {
    const created = await createStudyCard({
      nodeId: params.nodeId ?? null,
      prompt,
      answer,
      cardKind: params.cardKind ?? "manual",
    });
    studyCards.value = sortStudyCards([...studyCards.value, created]);
    return created;
  }

  const now = Date.now();
  const created: StudyCardDto = {
    id: `card_${now}_${Math.random().toString(36).slice(2, 8)}`,
    node_id: params.nodeId && params.nodeId.trim().length > 0 ? params.nodeId.trim() : null,
    prompt,
    answer,
    card_kind: params.cardKind ?? "manual",
    repetitions: 0,
    interval_days: 0,
    ease_factor: 2.5,
    lapses: 0,
    due_at: now,
    last_reviewed_at: null,
    created_at: now,
    updated_at: now,
  };
  const next = sortStudyCards([...readLocalStudyCards(), created]);
  writeLocalStudyCards(next);
  studyCards.value = next;
  return created;
}

export async function reviewStudyCardAction(
  cardId: string,
  rating: StudyRating,
): Promise<StudyCardDto> {
  if (isTauriRuntime()) {
    const updated = await reviewStudyCard(cardId, rating);
    studyCards.value = sortStudyCards(
      studyCards.value.map((c) => (c.id === updated.id ? updated : c)),
    );
    return updated;
  }

  const existing = readLocalStudyCards();
  const target = existing.find((c) => c.id === cardId);
  if (!target) {
    throw new Error(`Study card '${cardId}' not found`);
  }
  const updated = applySm2ReviewLocal(target, rating, Date.now());
  const next = sortStudyCards(existing.map((c) => (c.id === updated.id ? updated : c)));
  writeLocalStudyCards(next);
  studyCards.value = next;
  return updated;
}

export async function updateStudyCardAction(
  cardId: string,
  prompt: string,
  answer: string,
): Promise<StudyCardDto> {
  const trimmedPrompt = prompt.trim();
  const trimmedAnswer = answer.trim();
  if (!trimmedPrompt) {
    throw new Error("Study card prompt cannot be empty");
  }
  if (!trimmedAnswer) {
    throw new Error("Study card answer cannot be empty");
  }

  if (isTauriRuntime()) {
    const updated = await updateStudyCard({
      cardId,
      prompt: trimmedPrompt,
      answer: trimmedAnswer,
    });
    studyCards.value = sortStudyCards(
      studyCards.value.map((c) => (c.id === updated.id ? updated : c)),
    );
    return updated;
  }

  const existing = readLocalStudyCards();
  const target = existing.find((c) => c.id === cardId);
  if (!target) {
    throw new Error(`Study card '${cardId}' not found`);
  }
  const updated: StudyCardDto = {
    ...target,
    prompt: trimmedPrompt,
    answer: trimmedAnswer,
    updated_at: Math.max(Date.now(), target.updated_at + 1),
  };
  const next = sortStudyCards(existing.map((c) => (c.id === updated.id ? updated : c)));
  writeLocalStudyCards(next);
  studyCards.value = next;
  return updated;
}

export async function deleteStudyCardAction(cardId: string): Promise<void> {
  if (isTauriRuntime()) {
    await deleteStudyCard(cardId);
    studyCards.value = studyCards.value.filter((c) => c.id !== cardId);
    return;
  }

  const next = readLocalStudyCards().filter((c) => c.id !== cardId);
  writeLocalStudyCards(next);
  studyCards.value = sortStudyCards(next);
}

function stripMarkdownCueMarkers(line: string): string {
  return line
    .replace(/^(?:@[a-z0-9_-]+\s*)+/i, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateClueSafe(text: string, maxChars: number): string {
  const clean = text.trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  let slice = clean.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= 12) {
    slice = slice.slice(0, lastSpace);
  }
  let dollarCount = 0;
  for (let i = 0; i < slice.length; i += 1) {
    if (slice[i] === "$" && slice[i - 1] !== "\\") {
      dollarCount += 1;
    }
  }
  if (dollarCount % 2 === 1) {
    const lastDollar = slice.lastIndexOf("$");
    if (lastDollar > 0) {
      slice = slice.slice(0, lastDollar).trimEnd();
    } else {
      return "";
    }
  }
  const trimmed = slice.replace(/[.,;:\-]+$/, "").trimEnd();
  return trimmed.length > 0 ? `${trimmed}...` : "";
}

export function extractHintFromAnswer(answer: string): string {
  const withoutSimBlocks = answer
    .replace(/```(?:axiom-sim|sim)\b[\s\S]*?(?:```|$)/gi, "")
    .trim();
  const normalized = withoutSimBlocks;
  if (!normalized) {
    return "";
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "---" && !/^(?:@[a-z0-9_-]+\s*)+$/i.test(line));
  if (lines.length === 0) {
    return "";
  }

  const numberedLines = lines.filter((line) => /^\d+[.)]\s+/.test(line));
  if (numberedLines.length >= 2) {
    const firstItem = stripListPrefix(numberedLines[0] ?? "");
    const strippedAnswerMarker = stripQaMarker(firstItem, false) ?? firstItem;
    const cleanFirst = stripMarkdownCueMarkers(strippedAnswerMarker);
    const clue = truncateClueSafe(cleanFirst, 52);
    if (!clue) {
      return `${numberedLines.length} parts — recall item 1 first`;
    }
    const cleanClue = clue.replace(/\.+$/, "");
    return `1/${numberedLines.length}: ${cleanClue}...`;
  }

  const firstRaw = lines[0] ?? "";
  const firstNoList = stripListPrefix(firstRaw);
  const firstNoQa = stripQaMarker(firstNoList, false) ?? firstNoList;
  const cleanLine = stripMarkdownCueMarkers(firstNoQa);
  if (!cleanLine) {
    return "";
  }

  if (lines.length === 1) {
    const words = cleanLine.split(/\s+/).filter(Boolean);
    if (words.length <= 1) {
      return "";
    }
    if (cleanLine.length <= 72) {
      const cap = Math.max(10, Math.floor(cleanLine.length * 0.45));
      const partial = truncateClueSafe(cleanLine, cap);
      if (partial) {
        return partial;
      }
      const firstWord = words[0] ?? "";
      return firstWord.includes("$") ? "" : `${firstWord}...`;
    }
  }

  const truncated = truncateClueSafe(cleanLine, 72);
  if (!truncated) {
    return "";
  }
  if (truncated.endsWith("...") || lines.length === 1) {
    return truncated;
  }
  return `${truncated.replace(/\.+$/, "")}...`;
}

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function interleaveStudyCards(
  cards: ReadonlyArray<StudyCardDto>,
  seed: number,
): StudyCardDto[] {
  if (cards.length <= 1) {
    return [...cards];
  }

  const rng = createSeededRng(seed);
  const pool = [...cards];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i];
    const swap = pool[j];
    if (tmp && swap) {
      pool[i] = swap;
      pool[j] = tmp;
    }
  }

  const result: StudyCardDto[] = [];
  const remaining = [...pool];
  while (remaining.length > 0) {
    const prev = result[result.length - 1];
    let pickIdx = 0;
    if (prev) {
      const diffNodeAndKind = remaining.findIndex(
        (c) => c.node_id !== prev.node_id && c.card_kind !== prev.card_kind,
      );
      if (diffNodeAndKind !== -1) {
        pickIdx = diffNodeAndKind;
      } else {
        const diffNodeOrKind = remaining.findIndex(
          (c) => c.node_id !== prev.node_id || c.card_kind !== prev.card_kind,
        );
        if (diffNodeOrKind !== -1) {
          pickIdx = diffNodeOrKind;
        }
      }
    }
    const [picked] = remaining.splice(pickIdx, 1);
    if (picked) {
      result.push(picked);
    }
  }

  return result;
}

export function getScopedStudyCards(
  cards: ReadonlyArray<StudyCardDto>,
  scope: StudyScope,
  scopedFocusNodeId: string | null,
  nodes: Map<string, NodeDto>,
  edges: Map<string, EdgeDto>,
  nowMs = Date.now(),
): StudyCardDto[] {
  if (scope === "due") {
    return cards.filter((c) => c.due_at <= nowMs);
  }
  if (scope === "subtree") {
    const targetId = scopedFocusNodeId ?? focusId.value;
    if (!targetId) {
      return [];
    }
    const subtreeSet = new Set(collectSubtreeIds(targetId, nodes, edges));
    return cards.filter((c) => c.node_id !== null && subtreeSet.has(c.node_id));
  }
  return [...cards];
}

export async function openStudyModal(
  scope?: StudyScope,
  focusNodeIdOverride?: string | null,
  opts?: { openCreateForm?: boolean },
): Promise<void> {
  if (scope) {
    studyScope.value = scope;
  }
  studyFocusNodeId.value =
    focusNodeIdOverride !== undefined ? focusNodeIdOverride : focusId.value;
  studyCreateFormOpen.value = Boolean(opts?.openCreateForm);
  studyModalOpen.value = true;
  await syncStudyDeckAction();
}

export function closeStudyModal(): void {
  studyModalOpen.value = false;
  studyCreateFormOpen.value = false;
}

import { extractActionTagFromContent } from "../input/actionTags";
import type { NodeDto } from "../ipc/types";

export type NodeToneKey =
  | "user"
  | "feynman"
  | "study"
  | "research"
  | "diverge"
  | "synthesize"
  | "red_team"
  | "edge_case"
  | "triage"
  | "custom"
  | "ai";

export interface NodeToneInfo {
  key: NodeToneKey;
  label: string;
  colorDark: string;
  colorLight: string;
}

const NODE_TONES: Record<NodeToneKey, NodeToneInfo> = {
  user: { key: "user", label: "Note", colorDark: "#60a5fa", colorLight: "#2563eb" },
  feynman: { key: "feynman", label: "@Feynman", colorDark: "#38bdf8", colorLight: "#0284c7" },
  study: { key: "study", label: "@Study", colorDark: "#a78bfa", colorLight: "#7c3aed" },
  research: { key: "research", label: "@Research", colorDark: "#2dd4bf", colorLight: "#0d9488" },
  diverge: { key: "diverge", label: "@Diverge", colorDark: "#818cf8", colorLight: "#4f46e5" },
  synthesize: {
    key: "synthesize",
    label: "@Synthesize",
    colorDark: "#34d399",
    colorLight: "#059669",
  },
  red_team: { key: "red_team", label: "@RedTeam", colorDark: "#f87171", colorLight: "#dc2626" },
  edge_case: { key: "edge_case", label: "@EdgeCase", colorDark: "#fbbf24", colorLight: "#d97706" },
  triage: { key: "triage", label: "@Triage", colorDark: "#fb923c", colorLight: "#ea580c" },
  custom: { key: "custom", label: "@Custom", colorDark: "#f472b6", colorLight: "#db2777" },
  ai: { key: "ai", label: "AI", colorDark: "#94a3b8", colorLight: "#475569" },
};

const TAG_TO_TONE_KEY: Record<string, NodeToneKey> = {
  "@feynman": "feynman",
  "@study": "study",
  "@research": "research",
  "@diverge": "diverge",
  "@synthesize": "synthesize",
  "@redteam": "red_team",
  "@edgecase": "edge_case",
  "@triage": "triage",
  "@custom": "custom",
};

const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set([
  "new concept",
  "new topic",
  "new node",
  "untitled",
  "system architecture",
  "topic to master",
  "research question",
]);

const toneCache = new Map<string, NodeToneInfo>();
const MAX_TONE_CACHE = 2000;

function computeNodeTone(node: NodeDto): NodeToneInfo {
  if (node.metadata.lens === "research") {
    return NODE_TONES.research;
  }
  if (node.metadata.lens === "study") {
    return NODE_TONES.study;
  }

  if (node.content.includes("@")) {
    const extracted = extractActionTagFromContent(node.content);
    if (extracted) {
      const tagKey = TAG_TO_TONE_KEY[extracted.action.tag];
      if (tagKey) {
        return NODE_TONES[tagKey];
      }
    }
  }

  if (node.metadata.lens !== "manual") {
    switch (node.metadata.lens) {
      case "feynman":
        return NODE_TONES.feynman;
      case "red_team":
        return NODE_TONES.red_team;
      case "edge_case":
        return NODE_TONES.edge_case;
      case "diverge":
        return NODE_TONES.diverge;
      case "synthesize":
        return NODE_TONES.synthesize;
      case "custom":
        return NODE_TONES.custom;
    }
  }

  switch (node.type) {
    case "loophole":
      return NODE_TONES.red_team;
    case "synthesis":
      return NODE_TONES.synthesize;
    case "branch":
      return NODE_TONES.diverge;
    case "probe":
      return NODE_TONES.feynman;
    case "core":
      break;
  }

  if (node.metadata.created_by === "user") {
    return NODE_TONES.user;
  }

  return NODE_TONES.ai;
}

export function resolveNodeTone(node: NodeDto): NodeToneInfo {
  const cacheKey = `${node.id}:${node.content_hash}:${node.content.length}:${node.metadata.lens}:${node.type}:${node.metadata.created_by}`;
  const cached = toneCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const resolved = computeNodeTone(node);
  if (toneCache.size >= MAX_TONE_CACHE) {
    toneCache.clear();
  }
  toneCache.set(cacheKey, resolved);
  return resolved;
}

export function isPlaceholderTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized.length === 0 || PLACEHOLDER_TITLES.has(normalized);
}

export function deriveTitleFromTagPrompt(
  tag: string,
  argument: string,
  fallback = tag.trim() || "AI Response",
): string {
  let text = argument.trim().replace(/^@[a-zA-Z0-9_-]+:?(?:\s+|$)/, "");
  text = text.replace(/^[\s?!.,:]+|[\s?!.,:]+$/g, "");
  if (!text) {
    return fallback;
  }

  const words = text.split(/\s+/).slice(0, 6);
  let phrase = "";
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (!word) continue;
    if (i === 0) {
      if (word.length > 48) {
        phrase = word.slice(0, 48);
        break;
      }
      phrase = word;
    } else if (phrase.length + 1 + word.length <= 48) {
      phrase += ` ${word}`;
    } else {
      break;
    }
  }

  phrase = phrase.replace(/[\s?!.,:]+$/g, "");
  if (!phrase) {
    return fallback;
  }
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

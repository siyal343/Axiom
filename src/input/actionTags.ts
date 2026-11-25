import type { LensKind } from "../ipc/types";

export interface BaseActionTagDef {
  tag: string;
  label: string;
  description: string;
  aliases: readonly string[];
}

export type ActionTagDef =
  | (BaseActionTagDef & {
      kind: "lens";
      lens: LensKind;
    })
  | (BaseActionTagDef & {
      kind: "triage";
    });

export interface ParsedActionTagInvocation {
  action: ActionTagDef;
  argument: string;
}

export interface ExtractedActionTag extends ParsedActionTagInvocation {
  lineIndex: number;
}

export const ACTION_TAGS: readonly ActionTagDef[] = [
  {
    tag: "@custom",
    label: "Custom Prompt",
    description: "Run an open-ended AI instruction on the focused context",
    aliases: ["prompt", "ask"],
    kind: "lens",
    lens: "custom",
  },
  {
    tag: "@feynman",
    label: "Feynman Probe",
    description: "Explain from first principles with intuition and checks",
    aliases: ["firstprinciples", "explain"],
    kind: "lens",
    lens: "feynman",
  },
  {
    tag: "@redteam",
    label: "Red-Team",
    description: "Challenge assumptions and surface failure modes",
    aliases: ["red-team", "critique", "challenge"],
    kind: "lens",
    lens: "red_team",
  },
  {
    tag: "@edgecase",
    label: "Edge Cases",
    description: "Identify boundary conditions and subtle corner cases",
    aliases: ["edge-case", "edgecases", "boundary"],
    kind: "lens",
    lens: "edge_case",
  },
  {
    tag: "@diverge",
    label: "Diverge",
    description: "Generate distinct architectural or strategic branches",
    aliases: ["branches", "options"],
    kind: "lens",
    lens: "diverge",
  },
  {
    tag: "@synthesize",
    label: "Synthesize",
    description: "Consolidate selected nodes into a coherent decision",
    aliases: ["synth", "decide"],
    kind: "lens",
    lens: "synthesize",
  },
  {
    tag: "@research",
    label: "Research Map",
    description: "Map claims, open questions, evidence, and citations",
    aliases: ["lit", "cite", "sources"],
    kind: "lens",
    lens: "research",
  },
  {
    tag: "@study",
    label: "Study & Recall",
    description: "Build active-recall prompts, mental models, and self-tests",
    aliases: ["quiz", "recall", "flashcards"],
    kind: "lens",
    lens: "study",
  },
  {
    tag: "@triage",
    label: "Triage Loopholes",
    description: "Jump to the highest-severity unresolved loophole",
    aliases: ["loopholes"],
    kind: "triage",
  },
];

function findActionTagByToken(token: string): ActionTagDef | null {
  const normalized = token.trim().toLowerCase().replace(/^@+/, "");
  if (!normalized) {
    return null;
  }
  for (const def of ACTION_TAGS) {
    if (def.tag.slice(1).toLowerCase() === normalized) {
      return def;
    }
    if (def.aliases.some((alias) => alias.toLowerCase() === normalized)) {
      return def;
    }
  }
  return null;
}

export function filterActionTags(queryAfterAt: string): ActionTagDef[] {
  const query = queryAfterAt.trim().toLowerCase().replace(/^@+/, "");
  if (!query) {
    return [...ACTION_TAGS];
  }

  const scored: Array<{ def: ActionTagDef; rank: number }> = [];
  for (const def of ACTION_TAGS) {
    const bareTag = def.tag.slice(1).toLowerCase();
    const labelLower = def.label.toLowerCase();
    const descLower = def.description.toLowerCase();

    if (bareTag.startsWith(query)) {
      scored.push({ def, rank: 0 });
    } else if (def.aliases.some((a) => a.toLowerCase().startsWith(query))) {
      scored.push({ def, rank: 1 });
    } else if (bareTag.includes(query) || def.aliases.some((a) => a.toLowerCase().includes(query))) {
      scored.push({ def, rank: 2 });
    } else if (labelLower.includes(query) || descLower.includes(query)) {
      scored.push({ def, rank: 3 });
    }
  }

  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((item) => item.def);
}

export function parseActionTagInvocation(input: string): ParsedActionTagInvocation | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("@")) {
    return null;
  }
  const match = trimmed.match(/^@([a-z0-9_-]+):?(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  const token = match[1];
  if (!token) {
    return null;
  }
  const action = findActionTagByToken(token);
  if (!action) {
    return null;
  }
  const argument = (match[2] ?? "").trim();
  return { action, argument };
}

export function extractActionTagFromContent(content: string): ExtractedActionTag | null {
  const lines = content.split(/\r?\n/);
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  let lastMatch: ExtractedActionTag | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmedStart = line.trimStart();
    const fenceMatch = trimmedStart.match(/^(`{3,}|~{3,})(.*)$/);
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

    const trimmed = line.trim();
    if (!trimmed.startsWith("@")) {
      continue;
    }
    const parsed = parseActionTagInvocation(trimmed);
    if (parsed) {
      lastMatch = {
        action: parsed.action,
        argument: parsed.argument,
        lineIndex: i,
      };
    }
  }

  return lastMatch;
}

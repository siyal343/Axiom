import { describe, expect, it } from "vitest";
import type { NodeDto, NodeLensOrigin, NodeType } from "../../ipc/types";
import {
  deriveTitleFromTagPrompt,
  isPlaceholderTitle,
  resolveNodeTone,
  type NodeToneKey,
} from "../nodeAccent";

function makeNode(overrides: {
  id?: string;
  type?: NodeType;
  title?: string;
  content?: string;
  lens?: NodeLensOrigin;
  createdBy?: "user" | "ai";
}): NodeDto {
  const id = overrides.id ?? "n1";
  const title = overrides.title ?? "Note";
  const content = overrides.content ?? "";
  return {
    id,
    type: overrides.type ?? "core",
    status: "active",
    title,
    content,
    summary: "",
    content_hash: `${id}_${title.length}_${content.length}`,
    summary_hash: "",
    metadata: {
      severity: overrides.type === "loophole" ? "medium" : null,
      lens: overrides.lens ?? "manual",
      created_by: overrides.createdBy ?? "user",
      model: overrides.createdBy === "ai" ? "gpt-test" : null,
      token_count: 10,
    },
    context_controls: { pin_global: false, exclude_from_ai: false },
    layout: { x: 0, y: 0, width: 320, height: 180, collapsed: false },
    created_at: 1000,
    updated_at: 1000,
  };
}

describe("nodeAccent (semantic color-coding & auto-title helpers)", () => {
  it("resolves user note tone when no @tag or AI origin is present", () => {
    const tone = resolveNodeTone(makeNode({ id: "u1", createdBy: "user", lens: "manual" }));
    expect(tone.key).toBe("user");
    expect(tone.label).toBe("Note");
    expect(tone.colorDark).toMatch(/^#/);
    expect(tone.colorLight).toMatch(/^#/);
  });

  it("prioritizes outside-fence @tag directives over user origin and ignores fenced @tags", () => {
    const cases: Array<{ tagLine: string; key: NodeToneKey; label: string }> = [
      { tagLine: "@custom compare Raft vs Paxos", key: "custom", label: "@Custom" },
      { tagLine: "@feynman explain entropy", key: "feynman", label: "@Feynman" },
      { tagLine: "@study quiz me", key: "study", label: "@Study" },
      { tagLine: "@research prior work", key: "research", label: "@Research" },
      { tagLine: "@diverge 3 architectures", key: "diverge", label: "@Diverge" },
      { tagLine: "@synthesize pick best option", key: "synthesize", label: "@Synthesize" },
      { tagLine: "@redteam challenge assumptions", key: "red_team", label: "@RedTeam" },
      { tagLine: "@edgecase empty array input", key: "edge_case", label: "@EdgeCase" },
      { tagLine: "@triage", key: "triage", label: "@Triage" },
    ];

    for (const [idx, c] of cases.entries()) {
      const tone = resolveNodeTone(
        makeNode({
          id: `tag_${idx}`,
          createdBy: "user",
          lens: "manual",
          content: `Notes above\n${c.tagLine}`,
        }),
      );
      expect(tone.key).toBe(c.key);
      expect(tone.label).toBe(c.label);
    }

    const fencedOnly = resolveNodeTone(
      makeNode({
        id: "fenced_only",
        createdBy: "user",
        lens: "manual",
        content: "```md\n@feynman inside code block\n```\n~~~\n@study also fenced\n~~~",
      }),
    );
    expect(fencedOnly.key).toBe("user");
    expect(fencedOnly.label).toBe("Note");
  });

  it("falls back cleanly to metadata.lens, node.type, and generic AI", () => {
    const lensCases: Array<{ lens: NodeLensOrigin; key: NodeToneKey; label: string }> = [
      { lens: "feynman", key: "feynman", label: "@Feynman" },
      { lens: "red_team", key: "red_team", label: "@RedTeam" },
      { lens: "edge_case", key: "edge_case", label: "@EdgeCase" },
      { lens: "diverge", key: "diverge", label: "@Diverge" },
      { lens: "synthesize", key: "synthesize", label: "@Synthesize" },
      { lens: "custom", key: "custom", label: "@Custom" },
    ];
    for (const c of lensCases) {
      const tone = resolveNodeTone(
        makeNode({ id: `lens_${c.lens}`, createdBy: "ai", lens: c.lens }),
      );
      expect(tone.key).toBe(c.key);
      expect(tone.label).toBe(c.label);
    }

    expect(
      resolveNodeTone(makeNode({ id: "t_lh", type: "loophole", createdBy: "ai", lens: "manual" })).key,
    ).toBe("red_team");
    expect(
      resolveNodeTone(makeNode({ id: "t_syn", type: "synthesis", createdBy: "ai", lens: "manual" })).key,
    ).toBe("synthesize");
    expect(
      resolveNodeTone(makeNode({ id: "t_br", type: "branch", createdBy: "ai", lens: "manual" })).key,
    ).toBe("diverge");
    expect(
      resolveNodeTone(makeNode({ id: "t_pr", type: "probe", createdBy: "ai", lens: "manual" })).key,
    ).toBe("feynman");

    const genericAi = resolveNodeTone(
      makeNode({ id: "t_ai", type: "core", createdBy: "ai", lens: "manual" }),
    );
    expect(genericAi.key).toBe("ai");
    expect(genericAi.label).toBe("AI");
  });

  it("identifies placeholder titles and derives concise titles from @tag prompts", () => {
    for (const placeholder of [
      "",
      "   ",
      "New Concept",
      "new topic",
      "New Node",
      "Untitled",
      "System Architecture",
      "Topic to Master",
      "Research Question",
    ]) {
      expect(isPlaceholderTitle(placeholder)).toBe(true);
    }
    expect(isPlaceholderTitle("Raft Consensus")).toBe(false);

    expect(
      deriveTitleFromTagPrompt("@feynman", "@feynman why does Raft need pre-vote?", "New Concept"),
    ).toBe("Why does Raft need pre-vote");

    expect(
      deriveTitleFromTagPrompt(
        "@custom",
        "compare leader election across Raft Paxos Zab Viewstamped Replication",
        "New Concept",
      ),
    ).toBe("Compare leader election across Raft Paxos");

    const longDerived = deriveTitleFromTagPrompt(
      "@study",
      "supercalifragilisticexpialidocious extraordinary mechanism explanation",
      "Fallback",
    );
    expect(longDerived.length).toBeLessThanOrEqual(48);

    expect(deriveTitleFromTagPrompt("@study", "   ?!.,:  ", "New Concept")).toBe("New Concept");
    expect(deriveTitleFromTagPrompt("@feynman", "", "Fallback Title")).toBe("Fallback Title");
  });
});

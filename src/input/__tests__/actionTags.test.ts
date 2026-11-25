import { describe, expect, it } from "vitest";
import {
  ACTION_TAGS,
  extractActionTagFromContent,
  filterActionTags,
  parseActionTagInvocation,
} from "../actionTags";

describe("Action Tags (@tag registry, parsing & fence-aware extraction)", () => {
  it("lists all 9 actions on empty query and filters by prefix, alias, or label", () => {
    const all = filterActionTags("");
    expect(all).toHaveLength(ACTION_TAGS.length);
    expect(all.map((a) => a.tag)).toEqual([
      "@custom",
      "@feynman",
      "@redteam",
      "@edgecase",
      "@diverge",
      "@synthesize",
      "@research",
      "@study",
      "@triage",
    ]);

    expect(filterActionTags("first").some((a) => a.tag === "@feynman")).toBe(true);
    expect(filterActionTags("quiz").some((a) => a.tag === "@study")).toBe(true);
    expect(filterActionTags("red-team").some((a) => a.tag === "@redteam")).toBe(true);
    expect(filterActionTags("cite").some((a) => a.tag === "@research")).toBe(true);
    expect(filterActionTags("loopholes").some((a) => a.tag === "@triage")).toBe(true);
    expect(filterActionTags("nonexistent-xyz")).toEqual([]);
  });

  it("parses @tag invocations with inline arguments, aliases, and case-insensitivity", () => {
    const feynman = parseActionTagInvocation("@Feynman entropy");
    expect(feynman).not.toBeNull();
    expect(feynman?.action.tag).toBe("@feynman");
    expect(feynman?.action.kind === "lens" && feynman.action.lens).toBe("feynman");
    expect(feynman?.argument).toBe("entropy");

    const custom = parseActionTagInvocation("  @custom compare Raft vs Paxos  ");
    expect(custom).not.toBeNull();
    expect(custom?.action.tag).toBe("@custom");
    expect(custom?.action.kind === "lens" && custom.action.lens).toBe("custom");
    expect(custom?.argument).toBe("compare Raft vs Paxos");

    const triage = parseActionTagInvocation("@triage");
    expect(triage).not.toBeNull();
    expect(triage?.action.kind).toBe("triage");
    expect(triage?.argument).toBe("");

    const aliasStudy = parseActionTagInvocation("@FLASHCARDS Bayesian priors");
    expect(aliasStudy).not.toBeNull();
    expect(aliasStudy?.action.tag).toBe("@study");
    expect(aliasStudy?.argument).toBe("Bayesian priors");

    expect(parseActionTagInvocation("plain text without leading tag")).toBeNull();
    expect(parseActionTagInvocation("mentioning @feynman inline")).toBeNull();
    expect(parseActionTagInvocation("@unknownTag foo")).toBeNull();
  });

  it("extracts the last outside-fence @tag directive and ignores fenced code blocks", () => {
    const content = [
      "# Consensus Notes",
      "",
      "```markdown",
      "@feynman inside backtick fence",
      "@custom ignored inside fence",
      "```",
      "",
      "~~~text",
      "@redteam inside tilde fence",
      "~~~",
      "",
      "@research consensus protocols",
      "Some intermediate notes.",
      "@study quiz me on quorum intersections",
    ].join("\n");

    const extracted = extractActionTagFromContent(content);
    expect(extracted).not.toBeNull();
    expect(extracted?.action.tag).toBe("@study");
    expect(extracted?.argument).toBe("quiz me on quorum intersections");
    expect(extracted?.lineIndex).toBe(13);

    const fencedOnly = [
      "```",
      "@feynman should not run",
      "```",
      "~~~",
      "@custom should not run either",
      "~~~",
    ].join("\n");
    expect(extractActionTagFromContent(fencedOnly)).toBeNull();
  });
});

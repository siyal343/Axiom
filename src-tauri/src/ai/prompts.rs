use crate::ai::parser::LensDefaults;
use crate::graph::models::{EdgeType, LensKind, NodeLensOrigin, NodeType, Severity};

pub const BASE_SYSTEM_PROMPT: &str = r#"You are a rigorous systems engineering, scientific research, and first-principles study thinking partner embedded inside a directed spatial canvas. Adapt your domain depth to the topic—whether software/hardware architecture, scientific inquiry, or deep conceptual mastery.

CONTEXT TAGS YOU WILL RECEIVE:
- [GLOBAL CONSTRAINTS]: Hard invariants pinned by the user. Never violate them without explicitly flagging a contradiction.
- [BACKGROUND ANCESTORS]: Prior lineage and established foundations (may be compressed to summaries).
- [DIRECT PARENTS & INPUTS]: Immediate upstream specifications, claims, or competing branches.
- [UNRESOLVED LOOPHOLES]: Known active flaws or open questions already flagged. Do NOT duplicate these.
- [REFERENCED CONTEXT]: Optional cross-linked summaries for awareness.
- [FOCUS NODE]: The target node(s) for this operation.

STRICT OUTPUT PROTOCOL:
1. Output ZERO conversational preamble, greetings, or closing remarks outside node blocks.
2. Every generated card MUST start on a new line at column 0 with:
   @@NODE type=<type> edge=<edge> [severity=<sev>] title="<concise 3-7 word title>"
   and close with:
   @@END
3. Write dense, concrete, scannable Markdown inside each card (target <= 150 words per card unless a table, derivation, or worked example requires more). Use LaTeX ($...$ / $$...$$) for math/equations and fenced blocks for code.
4. State explicit assumptions, concrete numbers, and verifiable mechanisms or evidence gaps—never generic advice or filler."#;

pub const LENS_RED_TEAM: &str = r#"LENS: RED-TEAM (ADVERSARIAL DESIGN REVIEW)
Act as a hostile principal engineer trying to break the [FOCUS NODE] under real-world operating conditions.

TASK:
Identify 2 to 4 distinct, non-obvious flaws, hidden assumptions, race conditions, state-machine deadlocks, resource exhaustion paths, or single points of failure.
- Ignore style nitpicks and do not repeat any flaw already listed in [UNRESOLVED LOOPHOLES].
- Rank from highest to lowest severity.

OUTPUT FORMAT:
Emit 2 to 4 separate blocks using:
@@NODE type=loophole edge=challenges severity=<low|medium|high|critical> title="<specific failure mode>"
**Mechanism:** <1-2 sentences explaining the exact chain of cause and effect>
- **Trigger:** <Specific input, load, or timing fault condition>
- **Impact:** <Concrete or quantified consequence>
- **Mitigation Direction:** <1-sentence concrete engineering fix>
@@END"#;

pub const LENS_EDGE_CASE: &str = r#"LENS: EDGE-CASE MATRIX (BOUNDARY & FAULT ANALYSIS)
Stress-test the [FOCUS NODE] across extreme inputs, physical limits, timing anomalies, and fault states.

TASK:
Produce ONE compact card containing a Markdown table of 6 to 8 high-value edge cases tailored specifically to the domain of the [FOCUS NODE]. Cover at least:
1. Zero / Empty / Null state
2. Max / Overflow / Saturation boundary
3. Malformed / Corrupt / Out-of-order input
4. Concurrency / Timing jitter / Timeout
5. Partial failure / Power or link loss mid-operation
6. Cold start / Re-entry / State recovery

OUTPUT FORMAT:
Emit exactly ONE block:
@@NODE type=loophole edge=challenges severity=medium title="Edge Cases: <short focus name>"
| Category | Concrete Scenario | Failure Risk | Required Guard / Expected Behavior |
| :--- | :--- | :--- | :--- |
| ... | ... | ... | ... |
@@END"#;

pub const LENS_DIVERGE: &str = r#"LENS: DIVERGE 3X (ORTHOGONAL ARCHITECTURAL OPTIONS)
Generate 3 genuinely distinct architectural alternatives to advance or implement the [FOCUS NODE].

TASK:
Force real engineering trade-offs—do NOT produce minor variations of the same design. Optimize the three branches along conflicting axes appropriate to the problem (for example:
- Branch 1: Minimal complexity / lowest resource footprint
- Branch 2: Peak throughput / lowest latency
- Branch 3: Maximum fault tolerance / isolation / extensibility)
Every branch must respect [GLOBAL CONSTRAINTS].

OUTPUT FORMAT:
Emit exactly 3 blocks:
@@NODE type=branch edge=branches title="<Option Name> (<Primary Axis>)"
**Core Mechanism:** <2-3 sentences describing the concrete architecture or algorithm>
- **Wins on:** <Primary improved metrics>
- **Pays for it with:** <Concrete latency, RAM, BOM, maintenance, or complexity cost>
- **Breaks when:** <Exact condition or scale where this becomes the wrong choice>
@@END"#;

pub const LENS_FEYNMAN: &str = r#"LENS: FEYNMAN PROBE (FIRST-PRINCIPLES DECONSTRUCTION)
Explain the core mechanism, mathematical principle, or non-obvious trade-off inside the [FOCUS NODE] so an engineer can reason from first principles and predict edge behavior.

TASK:
Avoid surface-level definitions and patronizing analogies. Build a tight causal mental model.

OUTPUT FORMAT:
Emit exactly ONE block:
@@NODE type=probe edge=derives title="First Principles: <core concept>"
**Causal Mechanism:** <Clear 3-4 sentence explanation starting from the underlying physical or computational constraint and WHY it works this way>

**Governing Rule / Relation:** <Key equation, invariant, or complexity bound—omit if purely structural>

**Concrete Walkthrough:** <Tiny numerical or state-transition worked example showing the mechanism in action>

**Common Trap:** <The #1 misconception engineers hit when applying this>
@@END"#;

pub const LENS_SYNTHESIZE: &str = r#"LENS: SYNTHESIZE (MULTI-BRANCH COMPARISON & DECISION LOCK)
You are given 2 or more competing nodes in [FOCUS NODE] (plus any active loopholes attached to them). Compare them objectively and produce a unified engineering decision.

TASK:
1. Contrast the options across the 3-4 criteria that actually matter under [GLOBAL CONSTRAINTS].
2. Select a winner OR design a hybrid that combines strengths while explicitly resolving their active loopholes.
3. Call out which risks remain open so the user knows what still needs verification.

OUTPUT FORMAT:
Emit exactly ONE block:
@@NODE type=synthesis edge=synthesizes title="Decision: <short unified architecture>"
| Criterion | <Option A> | <Option B> | ... |
| :--- | :--- | :--- | :--- |
| ... | ... | ... | ... |

**Unified Design:** <Concrete specification of the chosen or hybrid approach>
- **Why this wins:** <Key decisive trade-off>
- **Mitigated Flaws:** <Which loopholes from input branches this resolves>
- **Open Risks:** <Remaining assumptions to validate next>
@@END"#;

pub const LENS_RESEARCH: &str = r#"LENS: RESEARCH BRIEF (SCIENTIFIC & LITERATURE SYNTHESIS)
Analyze the [FOCUS NODE] as a senior research scientist: surface core findings/claims, methodological limits or evidence gaps, and testable follow-up research questions.

TASK:
Ground every point in explicit mechanisms, empirical bounds, or experimental assumptions rather than vague summaries.

OUTPUT FORMAT:
Emit 2 to 3 separate blocks using:
@@NODE type=probe edge=derives title="Core Findings & Claims"
- **Primary Claim / Result:** <Concrete finding, law, or observed relationship>
- **Supporting Mechanism:** <Why the effect holds and under what boundary conditions>
@@END
@@NODE type=branch edge=derives title="Methodology & Evidence Gaps"
- **Methodological Assumptions:** <Key sample, measurement, or model assumptions>
- **Evidence Gaps / Confounders:** <Missing controls, unverified regimes, or conflicting observations>
@@END
@@NODE type=probe edge=derives title="Open Research Questions"
1. **Question:** <Testable hypothesis or next experiment> — *Discriminating signal:* <what observation separates competing explanations>
2. **Question:** <Second high-leverage inquiry>
@@END"#;

pub const LENS_STUDY: &str = r#"LENS: STUDY & ACTIVE RECALL (DEEP MASTERY)
Transform the [FOCUS NODE] into a crystal-clear study guide with core intuition, formal equations/definitions in KaTeX, a concrete worked example, and active-recall quiz questions with concise answers.

TASK:
Build genuine predictive understanding so the learner can solve novel problems without rote memorization.

OUTPUT FORMAT:
Emit exactly ONE block:
@@NODE type=probe edge=derives title="Study & Recall: <core topic>"
**Core Intuition:** <2-3 sentence physical or conceptual picture explaining the key idea>

**Key Equations & Definitions:**
<Formal definitions and relations in KaTeX `$...$` / `$$...$$`>

**Worked Example:**
<Step-by-step numerical or concrete trace>

**Active-Recall Quiz:**
1. **Q:** <Diagnostic question> — **A:** <Concise 1-sentence answer>
2. **Q:** <Transfer/edge-case question> — **A:** <Concise 1-sentence answer>
3. **Q:** <Mechanism why-question> — **A:** <Concise 1-sentence answer>
@@END"#;

pub const LENS_CUSTOM: &str = r#"LENS: CUSTOM DIRECTED OPERATION
Fulfill the [USER INSTRUCTION] strictly within the context of [FOCUS NODE] and [GLOBAL CONSTRAINTS].

OUTPUT FORMAT:
Emit 1 block (or multiple blocks only if the user explicitly asks for multiple alternatives/items):
@@NODE type=<core|branch|loophole|probe|synthesis> edge=<derives|branches|challenges|synthesizes> title="<concise title>"
<Dense, concrete Markdown response>
@@END"#;

pub const UTILITY_SUMMARY_PROMPT: &str = r#"Compress the following engineering note into at most 2 dense sentences (<= 45 words).
Preserve hard numbers, constraints, interfaces, failure modes, and decisions. Drop narrative filler.
Output plain text only—no headers, no bullets, no surrounding quotes."#;

pub fn lens_prompt(lens: LensKind) -> &'static str {
    match lens {
        LensKind::RedTeam => LENS_RED_TEAM,
        LensKind::EdgeCase => LENS_EDGE_CASE,
        LensKind::Diverge => LENS_DIVERGE,
        LensKind::Feynman => LENS_FEYNMAN,
        LensKind::Synthesize => LENS_SYNTHESIZE,
        LensKind::Research => LENS_RESEARCH,
        LensKind::Study => LENS_STUDY,
        LensKind::Custom => LENS_CUSTOM,
    }
}

pub fn lens_defaults(lens: LensKind) -> LensDefaults {
    match lens {
        LensKind::RedTeam => LensDefaults {
            node_type: NodeType::Loophole,
            edge_type: EdgeType::Challenges,
            severity: Some(Severity::Medium),
            title: "Red-Team Finding".to_owned(),
        },
        LensKind::EdgeCase => LensDefaults {
            node_type: NodeType::Loophole,
            edge_type: EdgeType::Challenges,
            severity: Some(Severity::Medium),
            title: "Edge-Case Matrix".to_owned(),
        },
        LensKind::Diverge => LensDefaults {
            node_type: NodeType::Branch,
            edge_type: EdgeType::Branches,
            severity: None,
            title: "Alternative Branch".to_owned(),
        },
        LensKind::Feynman => LensDefaults {
            node_type: NodeType::Probe,
            edge_type: EdgeType::Derives,
            severity: None,
            title: "First Principles".to_owned(),
        },
        LensKind::Synthesize => LensDefaults {
            node_type: NodeType::Synthesis,
            edge_type: EdgeType::Synthesizes,
            severity: None,
            title: "Synthesis Decision".to_owned(),
        },
        LensKind::Research => LensDefaults {
            node_type: NodeType::Probe,
            edge_type: EdgeType::Derives,
            severity: None,
            title: "Research Brief".to_owned(),
        },
        LensKind::Study => LensDefaults {
            node_type: NodeType::Probe,
            edge_type: EdgeType::Derives,
            severity: None,
            title: "Study & Recall".to_owned(),
        },
        LensKind::Custom => LensDefaults {
            node_type: NodeType::Core,
            edge_type: EdgeType::Derives,
            severity: None,
            title: "AI Response".to_owned(),
        },
    }
}

pub fn lens_to_origin(lens: LensKind) -> NodeLensOrigin {
    match lens {
        LensKind::RedTeam => NodeLensOrigin::RedTeam,
        LensKind::EdgeCase => NodeLensOrigin::EdgeCase,
        LensKind::Diverge => NodeLensOrigin::Diverge,
        LensKind::Feynman => NodeLensOrigin::Feynman,
        LensKind::Synthesize => NodeLensOrigin::Synthesize,
        LensKind::Research => NodeLensOrigin::Research,
        LensKind::Study => NodeLensOrigin::Study,
        LensKind::Custom => NodeLensOrigin::Custom,
    }
}

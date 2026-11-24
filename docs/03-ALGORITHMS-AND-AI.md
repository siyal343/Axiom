# Part 3: Core Algorithms, Spatial Engine, Streaming Parser & AI Prompts

## File: `docs/03-ALGORITHMS-AND-AI.md`

```markdown
# Algorithms, Spatial Layout & AI Runtime Specification
**Project:** Axiom — Infinite Canvas AI Companion
**Version:** 1.0 (MVP Baseline)
**Scope:** Context Compiler, Cycle-Safe Topological Sort, R-Tree Collision & Tidy Layout, `@@NODE` Stream Parser, Multi-Provider SSE Adapter, Background Summarizer, Verbatim Lens Prompts

---

## 1. Context Compiler (`src-tauri/src/graph/compiler.rs`)

Both `compile_xray` (for `Hold V` visual inspection) and `run_lens` (for live LLM execution) MUST invoke the exact same `compile_context` function so the visual highlight never drifts from the actual prompt payload.

### 1.1 Deterministic Constants & Helpers
- **Token estimator:** `estimate_tokens(text: &str) -> u32 = if text.is_empty() { 0 } else { ((text.len() + 3) / 4) as u32 }` (fast, zero-dependency approximation; ~4 UTF-8 bytes/token).
- **Ancestor-traversable edge types:** `ANCESTOR_EDGES = { Derives, Branches, Synthesizes }`.
- **Content hashing:** `compute_content_hash(title, content) = blake3::hash(format!("{title}\n{content}").as_bytes()).to_hex().to_string()`.

### 1.2 Exact Compilation Algorithm (Rust Specification)

```rust
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::cmp::Reverse;
use crate::graph::models::*;

pub struct CompiledContext {
    pub prompt_text: String,
    pub xray: CompiledXray,
}

fn is_ancestor_edge(t: EdgeType) -> bool {
    matches!(t, EdgeType::Derives | EdgeType::Branches | EdgeType::Synthesizes)
}

pub fn compile_context(
    engine: &GraphEngine,
    focus_ids: &[String],
    token_budget: u32,
) -> CompiledContext {
    let mut node_modes: HashMap<String, InclusionMode> = HashMap::new();
    let mut active_edges: HashSet<String> = HashSet::new();
    let focus_set: HashSet<&str> = focus_ids.iter().map(String::as_str).collect();

    // -------------------------------------------------------------------------
    // STEP 1: Collect Global Pins (sorted by id ASC for deterministic prompt order)
    // -------------------------------------------------------------------------
    let mut global_pins: Vec<&NodeDto> = engine
        .nodes
        .values()
        .filter(|n| {
            n.context_controls.pin_global
                && !n.context_controls.exclude_from_ai
                && !focus_set.contains(n.id.as_str())
        })
        .collect();
    global_pins.sort_by(|a, b| a.id.cmp(&b.id));
    for pin in &global_pins {
        node_modes.insert(pin.id.clone(), InclusionMode::Pin);
    }

    // -------------------------------------------------------------------------
    // STEP 2: Backward BFS on Ancestor Edges (Shortest hop distance per node)
    // Note: Walks THROUGH exclude_from_ai nodes so muting a scratchpad node
    // never severs lineage to upstream specs.
    // -------------------------------------------------------------------------
    let mut depth_map: HashMap<String, u32> = HashMap::new();
    let mut queue: VecDeque<(String, u32)> = VecDeque::new();

    for fid in focus_ids {
        if engine.nodes.contains_key(fid) {
            depth_map.insert(fid.clone(), 0);
            queue.push_back((fid.clone(), 0));
        }
    }

    while let Some((curr_id, depth)) = queue.pop_front() {
        if let Some(in_edges) = engine.incoming.get(&curr_id) {
            for edge in in_edges {
                if !is_ancestor_edge(edge.edge_type) {
                    continue;
                }
                active_edges.insert(edge.id.clone());
                let next_depth = depth + 1;
                let should_visit = match depth_map.get(&edge.source_id) {
                    Some(&existing) => next_depth < existing,
                    None => true,
                };
                if should_visit {
                    depth_map.insert(edge.source_id.clone(), next_depth);
                    queue.push_back((edge.source_id.clone(), next_depth));
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // STEP 3: Cycle-Safe Topological Sort of Ancestor Subgraph (Kahn's Algorithm)
    // Deduplicates diamond DAGs and guarantees root-to-focus ordering.
    // -------------------------------------------------------------------------
    let ancestor_id_set: HashSet<String> = depth_map
        .keys()
        .filter(|id| !focus_set.contains(id.as_str()))
        .cloned()
        .collect();

    let topo_ids = kahn_topo_sort_cycle_safe(engine, &ancestor_id_set, &depth_map);

    let topo_ancestors: Vec<&NodeDto> = topo_ids
        .iter()
        .filter_map(|id| engine.nodes.get(id))
        .filter(|n| !n.context_controls.exclude_from_ai && !n.context_controls.pin_global)
        .collect();

    // -------------------------------------------------------------------------
    // STEP 4: Harvest Active Loopholes (`challenges` incoming to focus or ancestors)
    // -------------------------------------------------------------------------
    let mut relevant_targets: Vec<String> = focus_ids.to_vec();
    for anc in &topo_ancestors {
        relevant_targets.push(anc.id.clone());
    }

    // Map loophole_id -> sorted list of challenged target titles
    let mut loophole_targets: HashMap<String, Vec<String>> = HashMap::new();
    for target_id in &relevant_targets {
        if let Some(in_edges) = engine.incoming.get(target_id) {
            for edge in in_edges {
                if edge.edge_type != EdgeType::Challenges {
                    continue;
                }
                if let Some(src) = engine.nodes.get(&edge.source_id) {
                    if src.status == NodeStatus::Active && !src.context_controls.exclude_from_ai {
                        active_edges.insert(edge.id.clone());
                        if let Some(target_node) = engine.nodes.get(target_id) {
                            loophole_targets
                                .entry(src.id.clone())
                                .or_default()
                                .push(target_node.title.clone());
                        }
                    }
                }
            }
        }
    }

    // Sort active loopholes by severity DESC (Critical -> Low), then id ASC
    let mut active_loopholes: Vec<(&NodeDto, Vec<String>)> = loophole_targets
        .into_iter()
        .filter_map(|(id, mut targets)| {
            targets.sort();
            targets.dedup();
            engine.nodes.get(&id).map(|n| (n, targets))
        })
        .collect();
    active_loopholes.sort_by(|(a, _), (b, _)| {
        severity_rank(b.metadata.severity)
            .cmp(&severity_rank(a.metadata.severity))
            .then_with(|| a.id.cmp(&b.id))
    });

    // -------------------------------------------------------------------------
    // STEP 5: Harvest One-Hop References (`references` outgoing from focus nodes)
    // -------------------------------------------------------------------------
    let mut seen_refs: HashSet<&str> = relevant_targets.iter().map(String::as_str).collect();
    for p in &global_pins {
        seen_refs.insert(p.id.as_str());
    }
    for (lh, _) in &active_loopholes {
        seen_refs.insert(lh.id.as_str());
    }

    let mut references: Vec<(&NodeDto, EdgeWeight)> = Vec::new();
    for fid in focus_ids {
        if let Some(out_edges) = engine.outgoing.get(fid) {
            for edge in out_edges {
                if edge.edge_type != EdgeType::References {
                    continue;
                }
                if let Some(ref_node) = engine.nodes.get(&edge.target_id) {
                    if !ref_node.context_controls.exclude_from_ai
                        && !seen_refs.contains(ref_node.id.as_str())
                    {
                        seen_refs.insert(ref_node.id.as_str());
                        active_edges.insert(edge.id.clone());
                        references.push((ref_node, edge.weight));
                    }
                }
            }
        }
    }
    references.sort_by(|(a, _), (b, _)| a.id.cmp(&b.id));

    // -------------------------------------------------------------------------
    // STEP 6: Distance-Decay Token Budgeting
    // Priority:
    //   (a) Global Pins + Focus Nodes + Direct Parents (depth == 1) + Active Loopholes -> ALWAYS FULL
    //   (b) Older Ancestors (depth >= 2) -> Reserve summary first; upgrade closest-first to FULL
    //   (c) References -> Summary unless edge.weight == Full
    // -------------------------------------------------------------------------
    let mut used_tokens: u32 = 0;
    let mut anc_full_mode: HashMap<&str, bool> = HashMap::new();

    for p in &global_pins {
        used_tokens = used_tokens.saturating_add(p.metadata.token_count);
    }

    let focus_nodes: Vec<&NodeDto> = focus_ids
        .iter()
        .filter_map(|id| engine.nodes.get(id))
        .collect();
    for f in &focus_nodes {
        node_modes.insert(f.id.clone(), InclusionMode::Focus);
        used_tokens = used_tokens.saturating_add(f.metadata.token_count);
    }

    let mut direct_parents: Vec<&NodeDto> = Vec::new();
    let mut older_ancestors: Vec<&NodeDto> = Vec::new();
    for anc in &topo_ancestors {
        let d = *depth_map.get(&anc.id).unwrap_or(&99);
        if d == 1 {
            direct_parents.push(anc);
            anc_full_mode.insert(anc.id.as_str(), true);
            node_modes.insert(anc.id.clone(), InclusionMode::Full);
            used_tokens = used_tokens.saturating_add(anc.metadata.token_count);
        } else {
            older_ancestors.push(anc);
        }
    }

    for (lh, _) in &active_loopholes {
        node_modes.insert(lh.id.clone(), InclusionMode::Loophole);
        used_tokens = used_tokens.saturating_add(lh.metadata.token_count);
    }

    // Reserve baseline summary cost for every older ancestor first
    let summary_cost = |n: &NodeDto| -> u32 {
        let basis = if !n.summary.is_empty() { &n.summary } else { &n.title };
        estimate_tokens(basis)
    };
    for anc in &older_ancestors {
        anc_full_mode.insert(anc.id.as_str(), false);
        node_modes.insert(anc.id.clone(), InclusionMode::Summary);
        used_tokens = used_tokens.saturating_add(summary_cost(anc));
    }

    // Upgrade older ancestors from Summary -> Full sorted by depth ASC (closest first), then id ASC
    let mut by_proximity = older_ancestors.clone();
    by_proximity.sort_by(|a, b| {
        let da = *depth_map.get(&a.id).unwrap_or(&99);
        let db = *depth_map.get(&b.id).unwrap_or(&99);
        da.cmp(&db).then_with(|| a.id.cmp(&b.id))
    });

    for anc in by_proximity {
        let upgrade_delta = anc.metadata.token_count.saturating_sub(summary_cost(anc));
        if used_tokens.saturating_add(upgrade_delta) <= token_budget {
            anc_full_mode.insert(anc.id.as_str(), true);
            node_modes.insert(anc.id.clone(), InclusionMode::Full);
            used_tokens = used_tokens.saturating_add(upgrade_delta);
        }
    }

    for (ref_node, weight) in &references {
        node_modes.insert(ref_node.id.clone(), InclusionMode::Reference);
        let cost = match weight {
            EdgeWeight::Full => ref_node.metadata.token_count,
            EdgeWeight::Summary => summary_cost(ref_node),
        };
        used_tokens = used_tokens.saturating_add(cost);
    }

    // -------------------------------------------------------------------------
    // STEP 7: Deterministic Section Assembly
    // -------------------------------------------------------------------------
    let mut sections: Vec<String> = Vec::new();

    if !global_pins.is_empty() {
        let body = global_pins
            .iter()
            .map(|n| format!("### {}\n{}", n.title, n.content))
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("[GLOBAL CONSTRAINTS]\n{body}"));
    }

    if !older_ancestors.is_empty() {
        let body = older_ancestors
            .iter()
            .map(|n| {
                let is_full = *anc_full_mode.get(n.id.as_str()).unwrap_or(&false);
                if is_full || n.summary.is_empty() {
                    format!("### {}\n{}", n.title, n.content)
                } else {
                    format!("### {} (summary)\n{}", n.title, n.summary)
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("[BACKGROUND ANCESTORS]\n{body}"));
    }

    if !direct_parents.is_empty() {
        let body = direct_parents
            .iter()
            .map(|n| format!("### {} [{:?}]\n{}", n.title, n.node_type, n.content))
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("[DIRECT PARENTS & INPUTS]\n{body}"));
    }

    if !active_loopholes.is_empty() {
        let body = active_loopholes
            .iter()
            .map(|(lh, targets)| {
                let sev = format!("{:?}", lh.metadata.severity.unwrap_or(Severity::Medium)).to_uppercase();
                format!(
                    "### [{}] {} (challenges: {})\n{}",
                    sev,
                    lh.title,
                    targets.join(", "),
                    lh.content
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("[UNRESOLVED LOOPHOLES]\n{body}"));
    }

    if !references.is_empty() {
        let body = references
            .iter()
            .map(|(n, weight)| {
                let text = match weight {
                    EdgeWeight::Full => &n.content,
                    EdgeWeight::Summary if !n.summary.is_empty() => &n.summary,
                    EdgeWeight::Summary => &n.content,
                };
                format!("### {}\n{}", n.title, text)
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("[REFERENCED CONTEXT]\n{body}"));
    }

    let focus_body = focus_nodes
        .iter()
        .map(|n| format!("### {} [{:?}]\n{}", n.title, n.node_type, n.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    sections.push(format!("[FOCUS NODE]\n{focus_body}"));

    let mut active_edge_list: Vec<String> = active_edges.into_iter().collect();
    active_edge_list.sort();

    CompiledContext {
        prompt_text: sections.join("\n\n---\n\n"),
        xray: CompiledXray {
            total_tokens: used_tokens,
            budget_tokens: token_budget,
            node_modes,
            active_edges: active_edge_list,
        },
    }
}

/// Cycle-safe Kahn's topological sort with deterministic tie-breaking.
/// Nodes are ordered root-first (highest hop depth first, then lexicographical id).
fn kahn_topo_sort_cycle_safe(
    engine: &GraphEngine,
    subset: &HashSet<String>,
    depth_map: &HashMap<String, u32>,
) -> Vec<String> {
    let mut in_degree: HashMap<String, usize> = subset.iter().map(|id| (id.clone(), 0)).collect();
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();

    for id in subset {
        if let Some(out_edges) = engine.outgoing.get(id) {
            for edge in out_edges {
                if is_ancestor_edge(edge.edge_type) && subset.contains(&edge.target_id) {
                    adj.entry(id.clone()).or_default().push(edge.target_id.clone());
                    *in_degree.entry(edge.target_id.clone()).or_insert(0) += 1;
                }
            }
        }
    }

    // Max-heap by depth (roots have largest depth), tie-break by id ASC using Reverse(id)
    let mut ready: BinaryHeap<(u32, Reverse<String>)> = BinaryHeap::new();
    for (id, &deg) in &in_degree {
        if deg == 0 {
            let d = *depth_map.get(id).unwrap_or(&0);
            ready.push((d, Reverse(id.clone())));
        }
    }

    let mut result: Vec<String> = Vec::with_capacity(subset.len());
    while let Some((_, Reverse(u))) = ready.pop() {
        result.push(u.clone());
        if let Some(neighbors) = adj.get(&u) {
            for v in neighbors {
                if let Some(deg) = in_degree.get_mut(v) {
                    *deg -= 1;
                    if *deg == 0 {
                        let d = *depth_map.get(v).unwrap_or(&0);
                        ready.push((d, Reverse(v.clone())));
                    }
                }
            }
        }
    }

    // Cycle fallback: append any remaining cyclic nodes deterministically (deepest first, id ASC)
    if result.len() < subset.len() {
        let emitted: HashSet<&str> = result.iter().map(String::as_str).collect();
        let mut remaining: Vec<String> = subset
            .iter()
            .filter(|id| !emitted.contains(id.as_str()))
            .cloned()
            .collect();
        remaining.sort_by(|a, b| {
            let da = *depth_map.get(a).unwrap_or(&0);
            let db = *depth_map.get(b).unwrap_or(&0);
            db.cmp(&da).then_with(|| a.cmp(b))
        });
        result.extend(remaining);
    }

    result
}

fn severity_rank(s: Option<Severity>) -> u8 {
    match s {
        Some(Severity::Critical) => 4,
        Some(Severity::High) => 3,
        Some(Severity::Medium) => 2,
        Some(Severity::Low) => 1,
        None => 0,
    }
}

```

---

## 2. Spatial Engine: R-Tree Collision & Tidy Subtree (`src-tauri/src/graph/spatial.rs`)

### 2.1 Layout Constants

* `DEFAULT_NODE_WIDTH = 320.0`
* `DEFAULT_NODE_HEIGHT = 180.0`
* `COLLAPSED_HEIGHT = 44.0`
* `H_GAP = 100.0` (horizontal spacing between parent right edge and child left edge)
* `V_GAP = 36.0` (vertical spacing between sibling cards)
* `SIDE_GAP = 48.0` (vertical gap for off-axis `loophole` below / `probe` above)
* `COLLISION_MARGIN = 20.0` (minimum clearance buffer enforced by R-tree AABB queries)

### 2.2 R-Tree Index Entry

Wrap every node in an `rstar::RTreeObject` struct `SpatialBox`:

* `min = [node.x - COLLISION_MARGIN / 2.0, node.y - COLLISION_MARGIN / 2.0]`
* `max = [node.x + node.width + COLLISION_MARGIN / 2.0, node.y + effective_height(node) + COLLISION_MARGIN / 2.0]`
* `effective_height(node) = if node.layout.collapsed { COLLAPSED_HEIGHT } else { node.layout.height }`

### 2.3 Role-Aware Candidate Slot & Collision Nudge (`find_free_position`)

Given an anchor node (or bounding centroid of multi-selected `focus_ids` for `Synthesize`), desired `node_type`, and sibling `batch_index` (0, 1, 2 for multi-card AI streams):

1. **Compute Initial Proposal `(px, py)`:**
* **Spine roles (`Core`, `Branch`, `Synthesis`):**
* `px = anchor_right + H_GAP`
* `py = anchor.y + (batch_index as f64) * (DEFAULT_NODE_HEIGHT + V_GAP)`
* For `Synthesize` with multiple anchors: `px = max(a.x + a.width) + H_GAP`, `py = mean(a.y)`.


* **Off-axis Loophole (`Loophole`):**
* Placed cleanly *below* the challenged target so the main left-to-right spine stays straight:
* `px = anchor.x + (batch_index as f64) * (DEFAULT_NODE_WIDTH + 24.0)` (up to 2 columns, then wrap down)
* `py = anchor.y + effective_height(anchor) + SIDE_GAP`


* **Off-axis Probe (`Probe`):**
* Placed cleanly *above* the focused node:
* `px = anchor.x`
* `py = anchor.y - DEFAULT_NODE_HEIGHT - SIDE_GAP`




2. **Collision Resolution Loop (Deterministic Vertical-First Nudge):**
* Query `rtree.locate_in_envelope_intersecting(&proposal_aabb)`.
* If empty, return `(px, py)`.
* Otherwise, compute `step = 40.0`:
* For `Probe`, probe upward (`py - k * step`).
* For `Loophole` and Spine roles, alternate downward/upward (`py + step`, `py + 2*step`, ..., prioritizing downward so trees expand naturally).
* After 30 vertical steps without clearance, shift `px += DEFAULT_NODE_WIDTH + H_GAP` and repeat.


* Immediately insert the reserved AABB into the in-memory `rstar` tree before processing the next `@@NODE` in the same stream so concurrent streamed cards (`Diverge 3x`, `Red-Team`) never collide with each other.



### 2.4 `tidy_subtree(root_id)` Algorithm

Rearranges ONLY the descendant subtree reachable from `root_id` via spine edges (`Derives`, `Branches`) plus their directly attached `Loophole` (below) and `Probe` (above) satellites:

1. Collect spine tree via BFS from `root_id` (break any cycles using a `visited` set; do NOT move `root_id` itself—it anchors the layout).
2. Bottom-up pass: compute each spine node's vertical span `subtree_height(u)` = `max(effective_height(u) + loophole_band + probe_band, sum(subtree_height(child) + V_GAP))`.
3. Top-down pass: assign spine child `x = parent.x + parent.width + H_GAP` and distribute child `y` coordinates centered vertically around `parent.y + effective_height(parent) / 2.0`.
4. Place attached `Probe` satellites directly above their parent (`y = parent.y - effective_height(probe) - SIDE_GAP`) and `Loophole` satellites directly below (`y = parent.y + effective_height(parent) + SIDE_GAP`).
5. **External Collision Check:** Temporarily remove moved nodes from a scratch R-tree; if any moved node overlaps an *external* unmoved node, shift that individual node down via `find_free_position` until clear.
6. Persist all changed coordinates in a single `MoveNodes` SQLite transaction and return `Vec<NodePositionUpdate>`.

---

## 3. Fence-Aware `@@NODE` Stream Parser (`src-tauri/src/ai/parser.rs`)

### 3.1 Wire Protocol Grammar

* Header line (at start of trimmed line, outside fenced code blocks):
`@@NODE type=<type> edge=<edge> [severity=<sev>] title="<title>"`
* Terminator line (optional; next `@@NODE` or EOF also terminates):
`@@END`
* Quoted `title` parsing supports escaped quotes (`\"`) and arbitrary key ordering. Unknown keys are ignored; missing/invalid `type` or `edge` fall back to the active lens's defaults (`LensDefaults`).

### 3.2 Parser State Machine Rules

* **States:** `Preamble` | `InNode { node_id, in_fence: Option<char> }` (tracks ``` or `~` fence delimiter so `@@NODE` inside Markdown code blocks never triggers a false card split).
* **Low-Latency Streaming Flush:**
* Incoming chunks append to `line_buf`.
* Complete lines (`\n`-terminated) are processed immediately through `process_line`.
* For trailing partial text without `\n`: if in `InNode` AND `!line_buf.trim_start().starts_with('@')` AND `!line_buf.trim_start().starts_with('`')`AND`!line_buf.trim_start().starts_with('~')`, immediately emit `ParsedEvent::TokenDelta(line_buf)`and clear`line_buf`. This delivers true token-by-token streaming with zero perceptible line buffering lag.


* **Protocol Violation Fallback:**
* If the model omits `@@NODE` entirely and emits raw prose in `Preamble`: buffer until `preamble_buf.len() >= 120` OR `preamble_buf.matches('\n').count() >= 2` (or `finish()` on EOF). Then auto-emit `ParsedEvent::SpawnNode(default_meta)` followed by `TokenDelta(preamble_buf)` and switch to `InNode`.


* **Leading/Trailing Whitespace Trim:** Trim leading blank lines immediately after `@@NODE` and trailing whitespace on `FinalizeNode`.

### 3.3 Mandatory Edge Direction Wiring on Spawn

When `runner.rs` receives `ParsedEvent::SpawnNode { meta }` from the parser, it MUST wire edges using the canonical direction table:

| Parsed `meta.edge` | Edge Direction Created | Notes |
| --- | --- | --- |
| `Challenges` | `new_node.id -> focus_ids[0]` | Used by `RedTeam` and `EdgeCase`. Marks target as challenged. |
| `Derives` | `focus_ids[0] -> new_node.id` | Used by `Feynman` and `Custom`. |
| `Branches` | `focus_ids[0] -> new_node.id` | Used by `Diverge`. Siblings share parent, stay isolated. |
| `Synthesizes` | For EVERY `fid` in `focus_ids`: `fid -> new_node.id` | Many-to-one fan-in for `Synthesize`. |
| `Resolves` | `new_node.id -> focus_ids[0]` | If custom prompt resolves a loophole. |

---

## 4. Provider-Agnostic Streaming Adapter (`src-tauri/src/ai/provider.rs`)

Define a single internal request struct and streaming entry point:

```rust
pub struct LlmStreamRequest {
    pub system_prompt: String,
    pub user_prompt: String,
    pub config: ModelTierConfig,
    pub api_key: Option<String>,
}

pub async fn stream_completion(
    client: &reqwest::Client,
    req: LlmStreamRequest,
    cancel: CancellationToken,
    mut on_chunk: impl FnMut(String) -> Result<(), IpcError>,
) -> Result<(), IpcError>

```

### 4.1 Provider Wire Protocols

1. **`ProviderKind::OpenaiCompat`** (OpenAI, OpenRouter, DeepSeek, Groq, vLLM, LM Studio)
* **URL:** `{base_url.trim_end_matches('/')}/chat/completions`
* **Headers:** `Content-Type: application/json`, optional `Authorization: Bearer {api_key}` (omit if key empty for local servers).
* **Body:**
```json
{
  "model": "<config.model>",
  "stream": true,
  "temperature": 0.4,
  "max_tokens": 2048,
  "messages": [
    { "role": "system", "content": "<system_prompt>" },
    { "role": "user", "content": "<user_prompt>" }
  ]
}

```


* **SSE Parsing:** Split byte stream on `\n`. Ignore blank lines and `:` comments. For lines starting with `data: `:
* If payload == `[DONE]`, terminate cleanly.
* Parse JSON and extract `choices[0].delta.content` (if non-empty string, invoke `on_chunk`).




2. **`ProviderKind::Anthropic`**
* **URL:** `{base_url.trim_end_matches('/')}/messages` (default base URL: `https://api.anthropic.com/v1`)
* **Headers:** `Content-Type: application/json`, `x-api-key: {api_key}`, `anthropic-version: 2023-06-01`.
* **Body:**
```json
{
  "model": "<config.model>",
  "stream": true,
  "temperature": 0.4,
  "max_tokens": 2048,
  "system": "<system_prompt>",
  "messages": [{ "role": "user", "content": "<user_prompt>" }]
}

```


* **SSE Parsing:** For `data: ` JSON lines where `type == "content_block_delta"` and `delta.type == "text_delta"`, extract `delta.text` and invoke `on_chunk`. Stop cleanly on `type == "message_stop"`.


3. **`ProviderKind::Ollama`**
* **URL:** `{base_url.trim_end_matches('/')}/api/chat` (default base URL: `http://127.0.0.1:11434`)
* **Headers:** `Content-Type: application/json`.
* **Body:**
```json
{
  "model": "<config.model>",
  "stream": true,
  "options": { "temperature": 0.4, "num_predict": 2048 },
  "messages": [
    { "role": "system", "content": "<system_prompt>" },
    { "role": "user", "content": "<user_prompt>" }
  ]
}

```


* **NDJSON Parsing:** Each `\n`-delimited line is raw JSON. Extract `message.content` if non-empty; stop cleanly when `done == true`.



### 4.2 Cancellation & Error Mapping

* Wrap every `stream.next()` await inside `tokio::select! { _ = cancel.cancelled() => break, item = stream.next() => ... }`.
* HTTP status mapping before reading body:
* `401 | 403` -> `IpcError { code: "PROVIDER_AUTH", message: ... }`
* `429 | 500..=599` or connect/timeout error -> `IpcError { code: "PROVIDER_NETWORK", message: ... }`
* `400 | 404` -> `IpcError { code: "VALIDATION_ERROR", message: body_snippet }`



---

## 5. Streaming Runner & Debounced Background Summarizer

### 5.1 Lens Runner Lifecycle (`src-tauri/src/ai/runner.rs`)

1. On `run_lens`:
* Validate `focus_ids` non-empty (and `focus_ids.len() >= 2` for `LensKind::Synthesize`).
* Acquire short `workspace.read()` lock -> call `compile_context(&engine, &focus_ids, token_budget)` -> release lock.
* Build `system_prompt = format!("{BASE_SYSTEM_PROMPT}\n\n{}", lens_prompt(lens))` and `user_prompt` (for `Custom`, append `\n\n---\n\n[USER INSTRUCTION]\n{custom_prompt}`).
* Spawn Tokio task storing `CancellationToken` in `active_runs`.


2. Inside the stream callback:
* **`ParsedEvent::SpawnNode { meta }`:**
* Acquire short `workspace.write()` + `db` locks.
* Compute collision-free `(x, y)` via `spatial::find_free_position`.
* Create `NodeDto` (`status: Draft`, `created_by: Ai`, `model: Some(cfg.model)`, `lens: lens_origin`, `title: meta.title`, `content: ""`) and canonical `EdgeDto`(s).
* Insert into SQLite transaction + `GraphEngine` + `rstar` R-tree; release locks.
* Send `LensStreamEvent::SkeletonSpawned { node, edges }` over `Channel`.


* **`ParsedEvent::TokenDelta { node_id, chunk }`:**
* Append `chunk` to in-memory local buffer map (NO DB write per token!).
* Send `LensStreamEvent::TokenDelta { node_id, chunk }` over `Channel`.


* **`ParsedEvent::FinalizeNode { node_id }`:**
* Acquire short `workspace.write()` + `db` locks.
* Persist final trimmed `content`, compute BLAKE3 `content_hash`, compute `token_count`, flip `status = Active`.
* Release locks.
* Send `LensStreamEvent::NodeFinalized { node }` over `Channel`.
* Push `node_id` to `summary_tx`.




3. On cancellation (`cancel.is_cancelled()`):
* Call `parser.finish()` so any partially streamed node finalizes cleanly and persists what was already generated.
* Emit `LensStreamEvent::RunCompleted { run_id, spawned_ids, cancelled: true }`.



### 5.2 Debounced Background Summarizer (`src-tauri/src/ai/summarizer.rs`)

A single long-lived Tokio task reads `node_id`s from `summary_rx`:

* Maintains `pending: HashMap<String, Instant>` with a **1,500 ms debounce window** per node.
* When a node's timer expires:
1. Check `settings.auto_summarize == true`.
2. Read current node from `workspace.read()`. Skip if deleted, `exclude_from_ai == true`, `content_hash == summary_hash`, or `content.trim().is_empty()`.
3. **Fast-Path Skip (Zero API Cost):** If `content.len() <= 160` characters (already ~2 sentences), copy `content.trim()` directly into `summary`, set `summary_hash = content_hash`, persist to SQLite, emit `axiom://summary-updated`, and skip calling the utility LLM.
4. Otherwise, call `provider::stream_completion` against the **Utility Model** tier (concatenating chunks, timeout 20 s).
5. Re-check under lock that `node.content_hash` has NOT changed while the request was in flight; if still matching, update `summary` & `summary_hash` in SQLite + `GraphEngine` and emit `axiom://summary-updated`. Failures are logged quietly and NEVER disrupt the user with error modals.



---

## 6. Verbatim System & Lens Prompts (`src-tauri/src/ai/prompts.rs`)

Embed these exact string constants in `prompts.rs`. Do not soften or paraphrase the structural framing instructions.

### 6.1 `BASE_SYSTEM_PROMPT`

```text
You are an adversarial-grade systems design and engineering thinking partner embedded inside a directed spatial canvas.

CONTEXT TAGS YOU WILL RECEIVE:
- [GLOBAL CONSTRAINTS]: Hard invariants pinned by the user. Never violate them without explicitly flagging a contradiction.
- [BACKGROUND ANCESTORS]: Prior design lineage (may be compressed to summaries).
- [DIRECT PARENTS & INPUTS]: Immediate upstream specifications or competing branches.
- [UNRESOLVED LOOPHOLES]: Known active flaws already flagged. Do NOT duplicate these.
- [REFERENCED CONTEXT]: Optional cross-linked summaries for awareness.
- [FOCUS NODE]: The target node(s) for this operation.

STRICT OUTPUT PROTOCOL:
1. Output ZERO conversational preamble, greetings, or closing remarks outside node blocks.
2. Every generated card MUST start on a new line at column 0 with:
   @@NODE type=<type> edge=<edge> [severity=<sev>] title="<concise 3-7 word title>"
   and close with:
   @@END
3. Write dense, concrete, scannable Markdown inside each card (target <= 150 words per card unless a table or derivation requires more). Use LaTeX ($...$ / $$...$$) for math and fenced blocks for code.
4. State explicit assumptions, concrete numbers, and failure mechanisms—never generic advice or filler.

```

### 6.2 `LENS_RED_TEAM` (`A R` | Defaults: `type=loophole`, `edge=challenges`, `severity=medium`)

```text
LENS: RED-TEAM (ADVERSARIAL DESIGN REVIEW)
Act as a hostile principal engineer trying to break the [FOCUS NODE] under real-world operating conditions.

TASK:
Identify 2 to 4 distinct, non-obvious flaws, hidden assumptions, race conditions, state-machine deadlocks, resource exhaustion paths, or single points of failure.
- Ignore style nitpicks and do not repeat any flaw already listed in [UNRESOLVED LOOPHOLES].
- Rank from highest to lowest severity.

OUTPUT FORMAT:
Emit 2 to 4 separate blocks using:
@@NODE type=loophole edge=challenges severity=<low|medium|high|critical> title="<specific failure mode>"
**Mechanism:** <1-2 sentences explaining the exact chain of cause and effect>
- **Trigger:** <Specific condition fault input, load, or timing,>
- **Impact:** <Quantified concrete consequence or>
- **Mitigation Direction:** <1-sentence concrete engineering fix>
@@END

```

### 6.3 `LENS_EDGE_CASE` (`A E` | Defaults: `type=loophole`, `edge=challenges`, `severity=medium`)

```text
LENS: EDGE-CASE MATRIX (BOUNDARY & FAULT ANALYSIS)
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
@@END

```

### 6.4 `LENS_DIVERGE` (`A D` | Defaults: `type=branch`, `edge=branches`)

```text
LENS: DIVERGE 3X (ORTHOGONAL ARCHITECTURAL OPTIONS)
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
- **Pays for it with:** <Concrete BOM, RAM, complexity, cost: latency, maintenance or>
- **Breaks when:** <Exact becomes choice condition option or scale the this where wrong>
@@END

```

### 6.5 `LENS_FEYNMAN` (`A F` | Defaults: `type=probe`, `edge=derives`)

```text
LENS: FEYNMAN PROBE (FIRST-PRINCIPLES DECONSTRUCTION)
Explain the core mechanism, mathematical principle, or non-obvious trade-off inside the [FOCUS NODE] so an engineer can reason from first principles and predict edge behavior.

TASK:
Avoid surface-level definitions and patronizing analogies. Build a tight causal mental model.

OUTPUT FORMAT:
Emit exactly ONE block:
@@NODE type=probe edge=derives title="First Principles: <core concept>"
**Causal Mechanism:** <Clear 3-4 WHY computational constraint explanation from it of or physical sentence starting the this underlying way, works>

**Governing Rule / Relation:** <Key bound—omit complexity equation, if invariant, or purely structural>

**Concrete Walkthrough:** <Tiny action example in mechanism numerical or showing state-transition the worked>

**Common Trap:** <The #1 applying engineers hit misconception this when>
@@END

```

### 6.6 `LENS_SYNTHESIZE` (`A S` | Defaults: `type=synthesis`, `edge=synthesizes`)

```text
LENS: SYNTHESIZE (MULTI-BRANCH COMPARISON & DECISION LOCK)
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

**Unified Design:** <Concrete approach chosen hybrid of or specification the>
- **Why this wins:** <Key decisive trade-off>
- **Mitigated Flaws:** <Which branches from input loopholes resolves the this>
- **Open Risks:** <Remaining assumptions next to validate>
@@END

```

### 6.7 `LENS_CUSTOM` (`A Space` | Defaults: `type=core`, `edge=derives`)

```text
LENS: CUSTOM DIRECTED OPERATION
Fulfill the [USER INSTRUCTION] strictly within the context of [FOCUS NODE] and [GLOBAL CONSTRAINTS].

OUTPUT FORMAT:
Emit 1 block (or multiple blocks only if the user explicitly asks for multiple alternatives/items):
@@NODE type=<core|branch|loophole|probe|synthesis> edge=<derives|branches|challenges|synthesizes> title="<concise title>"
<Dense, concrete Markdown response>
@@END

```

### 6.8 `UTILITY_SUMMARY_PROMPT` (Background Utility Model)

```text
Compress the following engineering note into at most 2 dense sentences (<= 45 words).
Preserve hard numbers, constraints, interfaces, failure modes, and decisions. Drop narrative filler.
Output plain text only—no headers, no bullets, no surrounding quotes.

```

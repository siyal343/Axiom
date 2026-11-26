use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, TransactionBehavior};

use crate::db::queries::{
    delete_study_card as db_delete_study_card, get_study_card as db_get_study_card,
    insert_study_card_tx, list_study_cards as db_list_study_cards, update_study_card_sm2_tx,
    update_study_card_text_tx,
};
use crate::error::IpcError;
pub use crate::graph::models::{StudyCardDto, StudyCardKind, StudyRating, StudySyncResult};
use crate::graph::models::{
    now_epoch_ms, EdgeType, NodeDto, NodeLensOrigin, NodeStatus, Severity,
};
use crate::graph::GraphEngine;

const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_DAY: i64 = 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StudyCandidate {
    pub node_id: String,
    pub card_kind: StudyCardKind,
    pub prompt: String,
    pub answer: String,
}

pub fn apply_sm2_review(card: &mut StudyCardDto, rating: StudyRating, now_ms: i64) {
    match rating {
        StudyRating::Again => {
            card.repetitions = 0;
            card.interval_days = 0;
            card.lapses = card.lapses.saturating_add(1);
            card.ease_factor = (card.ease_factor - 0.2).max(1.3);
            card.due_at = now_ms.saturating_add(MS_PER_MINUTE);
        }
        StudyRating::Hard => {
            card.interval_days = match card.repetitions {
                0 => 1,
                1 => 3,
                _ => (card.interval_days as f64 * 1.2).round().max(1.0) as i64,
            };
            card.repetitions = card.repetitions.saturating_add(1);
            card.ease_factor = (card.ease_factor - 0.15).max(1.3);
            card.due_at = now_ms.saturating_add(card.interval_days.saturating_mul(MS_PER_DAY));
        }
        StudyRating::Good => {
            card.interval_days = match card.repetitions {
                0 => 1,
                1 => 6,
                _ => (card.interval_days as f64 * card.ease_factor)
                    .round()
                    .max(1.0) as i64,
            };
            card.repetitions = card.repetitions.saturating_add(1);
            card.due_at = now_ms.saturating_add(card.interval_days.saturating_mul(MS_PER_DAY));
        }
        StudyRating::Easy => {
            card.interval_days = match card.repetitions {
                0 => 4,
                _ => (card.interval_days as f64 * card.ease_factor * 1.3)
                    .round()
                    .max(1.0) as i64,
            };
            card.repetitions = card.repetitions.saturating_add(1);
            card.ease_factor = (card.ease_factor + 0.15).min(3.5);
            card.due_at = now_ms.saturating_add(card.interval_days.saturating_mul(MS_PER_DAY));
        }
    }
    card.last_reviewed_at = Some(now_ms);
}

fn has_tag(text: &str, tag: &str) -> bool {
    if tag.is_empty() || text.len() < tag.len() {
        return false;
    }
    let tag_bytes = tag.as_bytes();
    for (idx, _) in text.char_indices() {
        let Some(slice) = text.as_bytes().get(idx..idx + tag_bytes.len()) else {
            break;
        };
        if !slice.eq_ignore_ascii_case(tag_bytes) {
            continue;
        }
        let prev_ok = text[..idx]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_' && c != '-');
        let next_ok = text[idx + tag_bytes.len()..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_' && c != '-');
        if prev_ok && next_ok {
            return true;
        }
    }
    false
}

/// Match `@tag` invocations in node content only on non-fenced lines starting with the tag,
/// so inline prose mentions like "run @feynman or @study" do not spawn spurious flashcards.
fn has_content_tag(content: &str, tag: &str) -> bool {
    if tag.is_empty() || content.len() < tag.len() {
        return false;
    }
    let tag_bytes = tag.as_bytes();
    let mut fence: Option<(char, usize)> = None;

    for raw_line in content.lines() {
        let trimmed_start = raw_line.trim_start();
        if let Some(fence_ch) = trimmed_start
            .chars()
            .next()
            .filter(|&c| c == '`' || c == '~')
        {
            let marker_len = trimmed_start.chars().take_while(|&c| c == fence_ch).count();
            if marker_len >= 3 {
                let rest = &trimmed_start[marker_len..];
                if let Some((active_ch, active_len)) = fence {
                    if fence_ch == active_ch && marker_len >= active_len && rest.trim().is_empty() {
                        fence = None;
                    }
                    continue;
                } else if !(fence_ch == '`' && rest.contains('`')) {
                    fence = Some((fence_ch, marker_len));
                    continue;
                }
            }
        }
        if fence.is_some() {
            continue;
        }

        let trimmed = raw_line.trim();
        let Some(head) = trimmed.as_bytes().get(..tag_bytes.len()) else {
            continue;
        };
        if !head.eq_ignore_ascii_case(tag_bytes) {
            continue;
        }
        let next_ok = trimmed[tag_bytes.len()..]
            .chars()
            .next()
            .is_none_or(|c| c.is_whitespace() || c == ':');
        if next_ok {
            return true;
        }
    }
    false
}

fn is_placeholder_content(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower == "thinking..." || lower == "thinking…" || lower == "..." || lower == "todo"
}

fn strip_list_prefix(line: &str) -> &str {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))
    {
        return rest.trim_start();
    }
    let mut digits_end = 0;
    for (idx, ch) in trimmed.char_indices() {
        if ch.is_ascii_digit() {
            digits_end = idx + ch.len_utf8();
        } else {
            break;
        }
    }
    if digits_end > 0 {
        let after_digits = &trimmed[digits_end..];
        if let Some(rest) = after_digits
            .strip_prefix(". ")
            .or_else(|| after_digits.strip_prefix(") "))
        {
            return rest.trim_start();
        }
    }
    trimmed
}

fn strip_ci_prefix<'a>(s: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    for prefix in prefixes {
        if s.len() >= prefix.len() {
            if let Some(head) = s.get(..prefix.len()) {
                if head.eq_ignore_ascii_case(prefix) {
                    return Some(&s[prefix.len()..]);
                }
            }
        }
    }
    None
}

fn strip_qa_marker(line: &str, is_question: bool) -> Option<&str> {
    let clean = strip_list_prefix(line);
    let prefixes: &[&str] = if is_question {
        &[
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
        ]
    } else {
        &[
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
        ]
    };
    let rest = strip_ci_prefix(clean, prefixes)?;
    let rest = rest.trim_start_matches('*').trim_start_matches('_').trim();
    Some(rest)
}

fn split_inline_answer(rest_of_q: &str) -> Option<(String, String)> {
    const MARKERS: &[&str] = &[
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
    ];

    for (idx, ch) in rest_of_q.char_indices() {
        if idx == 0 {
            continue;
        }
        let prev_char = rest_of_q[..idx].chars().next_back();
        if !prev_char.is_some_and(|c| c.is_whitespace() || matches!(c, '—' | '–' | '-' | '|')) {
            continue;
        }
        let tail = &rest_of_q[idx..];
        if let Some(after) = strip_ci_prefix(tail, MARKERS) {
            let after_clean = after.trim_start_matches('*').trim_start_matches('_').trim();
            if after_clean.is_empty() {
                continue;
            }
            let q_part = rest_of_q[..idx]
                .trim()
                .trim_end_matches(['—', '–', '-', '|', ' '])
                .trim();
            if !q_part.is_empty() {
                return Some((q_part.to_owned(), after_clean.to_owned()));
            }
        }
        let _ = ch;
    }
    None
}

fn parse_qa_blocks(content: &str) -> Option<(String, String)> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum ParseState {
        Idle,
        InQuestion,
        InAnswer,
    }

    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut state = ParseState::Idle;
    let mut current_q = String::new();
    let mut current_a = String::new();

    let flush_pair = |state: &mut ParseState,
                      q_buf: &mut String,
                      a_buf: &mut String,
                      pairs: &mut Vec<(String, String)>| {
        let q = q_buf.trim().to_owned();
        let a = a_buf.trim().to_owned();
        if !q.is_empty() && !a.is_empty() {
            pairs.push((q, a));
        }
        q_buf.clear();
        a_buf.clear();
        *state = ParseState::Idle;
    };

    for raw_line in content.lines() {
        let trimmed = raw_line.trim();

        if let Some(q_rest) = strip_qa_marker(trimmed, true) {
            flush_pair(&mut state, &mut current_q, &mut current_a, &mut pairs);
            if let Some((inline_q, inline_a)) = split_inline_answer(q_rest) {
                pairs.push((inline_q, inline_a));
                state = ParseState::Idle;
            } else {
                current_q.push_str(q_rest);
                state = ParseState::InQuestion;
            }
            continue;
        }

        if let Some(a_rest) = strip_qa_marker(trimmed, false) {
            if state == ParseState::InQuestion || !current_q.trim().is_empty() {
                current_a.clear();
                current_a.push_str(a_rest);
                state = ParseState::InAnswer;
            }
            continue;
        }

        match state {
            ParseState::Idle => {}
            ParseState::InQuestion => {
                if trimmed == "---" || trimmed.starts_with('#') {
                    flush_pair(&mut state, &mut current_q, &mut current_a, &mut pairs);
                } else if !trimmed.is_empty() {
                    if !current_q.is_empty() {
                        current_q.push('\n');
                    }
                    current_q.push_str(trimmed);
                }
            }
            ParseState::InAnswer => {
                if trimmed == "---" || trimmed.starts_with('#') {
                    flush_pair(&mut state, &mut current_q, &mut current_a, &mut pairs);
                } else if trimmed.is_empty() {
                    if !current_a.trim().is_empty() {
                        current_a.push('\n');
                    }
                } else {
                    if !current_a.is_empty() && !current_a.ends_with('\n') {
                        current_a.push('\n');
                    }
                    current_a.push_str(trimmed);
                }
            }
        }
    }

    flush_pair(&mut state, &mut current_q, &mut current_a, &mut pairs);

    if pairs.is_empty() {
        None
    } else if pairs.len() == 1 {
        pairs.into_iter().next()
    } else {
        let prompt = pairs
            .iter()
            .enumerate()
            .map(|(i, (q, _))| format!("{}. {}", i + 1, q))
            .collect::<Vec<_>>()
            .join("\n");
        let answer = pairs
            .iter()
            .enumerate()
            .map(|(i, (_, a))| format!("{}. {}", i + 1, a))
            .collect::<Vec<_>>()
            .join("\n");
        Some((prompt, answer))
    }
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

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_owned();
    }
    let keep = max_chars.saturating_sub(3);
    let mut out: String = trimmed.chars().take(keep).collect();
    while out.ends_with(char::is_whitespace) {
        out.pop();
    }
    out.push_str("...");
    out
}

fn format_loophole_answer(loopholes: &[&NodeDto]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for lh in loopholes.iter().take(3) {
        let raw_body = if !lh.summary.trim().is_empty() {
            lh.summary.trim()
        } else {
            lh.content.trim()
        };
        let excerpt = truncate_chars(raw_body, 180);
        let lh_title = lh.title.trim();
        let line = if lh_title.is_empty() {
            excerpt
        } else if excerpt.is_empty() {
            lh_title.to_owned()
        } else {
            format!("{lh_title}: {excerpt}")
        };
        if !line.is_empty() {
            lines.push(line);
        }
    }
    if lines.len() <= 1 {
        lines.into_iter().next().unwrap_or_default()
    } else {
        lines
            .into_iter()
            .map(|l| format!("- {l}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub fn extract_study_candidates(engine: &GraphEngine) -> Vec<StudyCandidate> {
    let mut candidates = Vec::new();

    for node in engine.all_nodes_sorted() {
        if node.status == NodeStatus::Dismissed {
            continue;
        }

        let title = node.title.trim();
        let content = node.content.trim();

        let is_study_node = has_tag(&node.title, "@study")
            || has_content_tag(&node.content, "@study")
            || node.metadata.lens == NodeLensOrigin::Study;
        if is_study_node && !is_placeholder_content(content) {
            if let Some((q, a)) = parse_qa_blocks(content) {
                if !is_placeholder_content(&q) && !is_placeholder_content(&a) {
                    candidates.push(StudyCandidate {
                        node_id: node.id.clone(),
                        card_kind: StudyCardKind::Qa,
                        prompt: q,
                        answer: a,
                    });
                }
            } else if !title.is_empty() && !is_placeholder_content(title) {
                candidates.push(StudyCandidate {
                    node_id: node.id.clone(),
                    card_kind: StudyCardKind::Qa,
                    prompt: title.to_owned(),
                    answer: content.to_owned(),
                });
            }
        }

        let is_feynman_node = has_tag(&node.title, "@feynman")
            || has_content_tag(&node.content, "@feynman")
            || node.metadata.lens == NodeLensOrigin::Feynman;
        if is_feynman_node
            && !title.is_empty()
            && !is_placeholder_content(title)
            && !is_placeholder_content(content)
            && content.chars().count() >= 15
        {
            candidates.push(StudyCandidate {
                node_id: node.id.clone(),
                card_kind: StudyCardKind::Feynman,
                prompt: format!("Explain from first principles: {title}"),
                answer: content.to_owned(),
            });
        }

        if !title.is_empty() {
            let mut active_loopholes: Vec<&NodeDto> = engine
                .incoming
                .get(&node.id)
                .into_iter()
                .flatten()
                .filter(|edge| edge.edge_type == EdgeType::Challenges)
                .filter_map(|edge| engine.nodes.get(&edge.source_id))
                .filter(|src| {
                    src.status == NodeStatus::Active
                        && !(src.title.trim().is_empty() && src.content.trim().is_empty())
                })
                .collect();

            if !active_loopholes.is_empty() {
                active_loopholes.sort_by(|a, b| {
                    severity_rank(b.metadata.severity)
                        .cmp(&severity_rank(a.metadata.severity))
                        .then_with(|| a.id.cmp(&b.id))
                });
                let answer = format_loophole_answer(&active_loopholes);
                if !answer.is_empty() {
                    candidates.push(StudyCandidate {
                        node_id: node.id.clone(),
                        card_kind: StudyCardKind::Loophole,
                        prompt: format!("What failure mode or loophole threatens \"{title}\"?"),
                        answer,
                    });
                }
            }
        }
    }

    candidates
}

pub fn sync_study_deck(
    conn: &mut Connection,
    engine: &GraphEngine,
) -> Result<StudySyncResult, IpcError> {
    let candidates = extract_study_candidates(engine);
    let now_ms = now_epoch_ms();
    let mut added_count: usize = 0;

    let active_loophole_node_ids: HashSet<&str> = candidates
        .iter()
        .filter(|c| c.card_kind == StudyCardKind::Loophole)
        .map(|c| c.node_id.as_str())
        .collect();

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let existing_cards = {
        let mut stmt = tx.prepare(
            "SELECT id, node_id, prompt, answer, card_kind, repetitions, interval_days,
                    ease_factor, lapses, due_at, last_reviewed_at, created_at, updated_at
             FROM study_cards
             WHERE node_id IS NOT NULL AND card_kind IN ('qa', 'feynman', 'loophole')",
        )?;
        let rows = stmt.query_map([], crate::db::queries::row_to_study_card_dto)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        out
    };

    let mut existing_by_key: HashMap<(String, StudyCardKind), StudyCardDto> = HashMap::new();
    for card in existing_cards {
        if let Some(ref nid) = card.node_id {
            if card.card_kind == StudyCardKind::Loophole
                && !active_loophole_node_ids.contains(nid.as_str())
            {
                tx.execute("DELETE FROM study_cards WHERE id = ?1", params![card.id])?;
                continue;
            }
            existing_by_key.insert((nid.clone(), card.card_kind), card);
        }
    }

    for candidate in &candidates {
        let key = (candidate.node_id.clone(), candidate.card_kind);
        let node_updated_at = engine
            .nodes
            .get(&candidate.node_id)
            .map_or(now_ms, |node| node.updated_at);
        if let Some(existing) = existing_by_key.get(&key) {
            let customized_after_node = existing.updated_at > node_updated_at;
            if !customized_after_node
                && (existing.prompt != candidate.prompt || existing.answer != candidate.answer)
            {
                tx.execute(
                    "UPDATE study_cards SET prompt = ?1, answer = ?2, updated_at = ?3 WHERE id = ?4",
                    params![candidate.prompt, candidate.answer, node_updated_at, existing.id],
                )?;
            }
        } else {
            let new_card = StudyCardDto {
                id: format!("card_{}", ulid::Ulid::new()),
                node_id: Some(candidate.node_id.clone()),
                prompt: candidate.prompt.clone(),
                answer: candidate.answer.clone(),
                card_kind: candidate.card_kind,
                repetitions: 0,
                interval_days: 0,
                ease_factor: 2.5,
                lapses: 0,
                due_at: now_ms,
                last_reviewed_at: None,
                created_at: now_ms,
                updated_at: node_updated_at,
            };
            insert_study_card_tx(&tx, &new_card)?;
            added_count += 1;
        }
    }

    tx.commit()?;

    let cards = db_list_study_cards(conn, None)?;
    Ok(StudySyncResult { cards, added_count })
}

pub fn list_study_cards(conn: &Connection, due_only: bool) -> Result<Vec<StudyCardDto>, IpcError> {
    let cutoff = if due_only {
        Some(now_epoch_ms())
    } else {
        None
    };
    db_list_study_cards(conn, cutoff)
}

pub fn create_study_card(
    conn: &mut Connection,
    node_id: Option<&str>,
    prompt: &str,
    answer: &str,
    card_kind: StudyCardKind,
) -> Result<StudyCardDto, IpcError> {
    let trimmed_prompt = prompt.trim();
    let trimmed_answer = answer.trim();
    if trimmed_prompt.is_empty() {
        return Err(IpcError::validation("Study card prompt cannot be empty"));
    }
    if trimmed_answer.is_empty() {
        return Err(IpcError::validation("Study card answer cannot be empty"));
    }

    let normalized_node_id = node_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    if let Some(ref nid) = normalized_node_id {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM nodes WHERE id = ?1)",
            params![nid],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(IpcError::validation(format!("Node {nid} not found")));
        }
    }

    let now_ms = now_epoch_ms();
    let card = StudyCardDto {
        id: format!("card_{}", ulid::Ulid::new()),
        node_id: normalized_node_id,
        prompt: trimmed_prompt.to_owned(),
        answer: trimmed_answer.to_owned(),
        card_kind,
        repetitions: 0,
        interval_days: 0,
        ease_factor: 2.5,
        lapses: 0,
        due_at: now_ms,
        last_reviewed_at: None,
        created_at: now_ms,
        updated_at: now_ms,
    };

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    insert_study_card_tx(&tx, &card)?;
    tx.commit()?;

    Ok(card)
}

pub fn review_study_card(
    conn: &mut Connection,
    card_id: &str,
    rating: StudyRating,
    now_ms: i64,
) -> Result<StudyCardDto, IpcError> {
    let mut card = db_get_study_card(conn, card_id)?
        .ok_or_else(|| IpcError::validation(format!("Study card '{card_id}' not found")))?;
    apply_sm2_review(&mut card, rating, now_ms);

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    update_study_card_sm2_tx(&tx, &card)?;
    tx.commit()?;

    Ok(card)
}

pub fn update_study_card(
    conn: &mut Connection,
    card_id: &str,
    prompt: &str,
    answer: &str,
) -> Result<StudyCardDto, IpcError> {
    let trimmed_id = card_id.trim();
    let trimmed_prompt = prompt.trim();
    let trimmed_answer = answer.trim();
    if trimmed_id.is_empty() {
        return Err(IpcError::validation("Study card ID cannot be empty"));
    }
    if trimmed_prompt.is_empty() {
        return Err(IpcError::validation("Study card prompt cannot be empty"));
    }
    if trimmed_answer.is_empty() {
        return Err(IpcError::validation("Study card answer cannot be empty"));
    }

    let mut card = db_get_study_card(conn, trimmed_id)?
        .ok_or_else(|| IpcError::validation(format!("Study card '{trimmed_id}' not found")))?;

    let now_ms = now_epoch_ms();
    card.prompt = trimmed_prompt.to_owned();
    card.answer = trimmed_answer.to_owned();
    card.updated_at = now_ms.max(card.updated_at.saturating_add(1));

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    update_study_card_text_tx(&tx, &card.id, &card.prompt, &card.answer, card.updated_at)?;
    tx.commit()?;

    Ok(card)
}

pub fn delete_study_card(conn: &mut Connection, card_id: &str) -> Result<(), IpcError> {
    db_delete_study_card(conn, card_id)
}

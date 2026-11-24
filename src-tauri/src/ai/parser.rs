use crate::graph::models::{EdgeType, NodeType, Severity};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedNodeMeta {
    pub node_type: NodeType,
    pub edge_type: EdgeType,
    pub severity: Option<Severity>,
    pub title: String,
}

#[derive(Debug, Clone)]
pub struct LensDefaults {
    pub node_type: NodeType,
    pub edge_type: EdgeType,
    pub severity: Option<Severity>,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedEvent {
    SpawnNode { meta: ParsedNodeMeta },
    TokenDelta(String),
    FinalizeNode,
}

enum ParserState {
    Preamble,
    InNode {
        in_fence: Option<(char, usize)>,
        has_emitted_content: bool,
        pending_ws: String,
    },
}

pub struct NodeStreamParser {
    defaults: LensDefaults,
    state: ParserState,
    line_buf: String,
    preamble_buf: String,
}

impl NodeStreamParser {
    pub fn new(defaults: LensDefaults) -> Self {
        Self {
            defaults,
            state: ParserState::Preamble,
            line_buf: String::new(),
            preamble_buf: String::new(),
        }
    }

    pub fn feed(&mut self, chunk: &str) -> Vec<ParsedEvent> {
        let mut events = Vec::new();
        self.line_buf.push_str(chunk);

        while let Some(nl_idx) = self.line_buf.find('\n') {
            let line_with_nl: String = self.line_buf.drain(..=nl_idx).collect();
            self.process_line(&line_with_nl, &mut events);
        }

        match &mut self.state {
            ParserState::Preamble => {
                let total_len = self.preamble_buf.len() + self.line_buf.len();
                let nl_count =
                    self.preamble_buf.matches('\n').count() + self.line_buf.matches('\n').count();
                if (total_len >= 120 || nl_count >= 2)
                    && !self.line_buf.trim_start().starts_with('@')
                {
                    let mut combined = std::mem::take(&mut self.preamble_buf);
                    combined.push_str(&self.line_buf);
                    self.line_buf.clear();
                    self.trigger_fallback_with_text(&combined, &mut events);
                }
            }
            ParserState::InNode {
                has_emitted_content,
                pending_ws,
                ..
            } => {
                let trimmed = self.line_buf.trim_start();
                if !self.line_buf.is_empty()
                    && !self.line_buf.trim().is_empty()
                    && !trimmed.starts_with('@')
                    && !trimmed.starts_with('`')
                    && !trimmed.starts_with('~')
                {
                    let partial = std::mem::take(&mut self.line_buf);
                    emit_in_node_text(
                        &mut events,
                        has_emitted_content,
                        pending_ws,
                        &partial,
                    );
                }
            }
        }

        events
    }

    pub fn finish(&mut self) -> Vec<ParsedEvent> {
        let mut events = Vec::new();
        if !self.line_buf.is_empty() {
            let remaining = std::mem::take(&mut self.line_buf);
            self.process_line(&remaining, &mut events);
        }

        match &mut self.state {
            ParserState::Preamble => {
                if !self.preamble_buf.trim().is_empty() {
                    let prose = std::mem::take(&mut self.preamble_buf);
                    self.trigger_fallback_with_text(&prose, &mut events);
                    if matches!(self.state, ParserState::InNode { .. }) {
                        events.push(ParsedEvent::FinalizeNode);
                        self.state = ParserState::Preamble;
                    }
                } else {
                    self.preamble_buf.clear();
                }
            }
            ParserState::InNode { pending_ws, .. } => {
                pending_ws.clear();
                events.push(ParsedEvent::FinalizeNode);
                self.state = ParserState::Preamble;
            }
        }

        events
    }

    fn default_meta(&self) -> ParsedNodeMeta {
        ParsedNodeMeta {
            node_type: self.defaults.node_type,
            edge_type: self.defaults.edge_type,
            severity: self.defaults.severity,
            title: self.defaults.title.clone(),
        }
    }

    fn trigger_fallback_with_text(&mut self, text: &str, events: &mut Vec<ParsedEvent>) {
        events.push(ParsedEvent::SpawnNode {
            meta: self.default_meta(),
        });
        let mut has_emitted_content = false;
        let mut pending_ws = String::new();
        emit_in_node_text(events, &mut has_emitted_content, &mut pending_ws, text);
        self.state = ParserState::InNode {
            in_fence: None,
            has_emitted_content,
            pending_ws,
        };
    }

    fn process_line(&mut self, line: &str, events: &mut Vec<ParsedEvent>) {
        let stripped = line.trim_end_matches(['\r', '\n']);
        let trimmed = stripped.trim();

        let currently_in_fence = match &self.state {
            ParserState::InNode { in_fence, .. } => in_fence.is_some(),
            ParserState::Preamble => false,
        };

        if !currently_in_fence {
            if is_node_header_line(trimmed) {
                if matches!(self.state, ParserState::InNode { .. }) {
                    events.push(ParsedEvent::FinalizeNode);
                }
                self.preamble_buf.clear();
                let meta = parse_node_header(trimmed, &self.defaults);
                events.push(ParsedEvent::SpawnNode { meta });
                self.state = ParserState::InNode {
                    in_fence: None,
                    has_emitted_content: false,
                    pending_ws: String::new(),
                };
                return;
            }

            if trimmed == "@@END" {
                if matches!(self.state, ParserState::InNode { .. }) {
                    events.push(ParsedEvent::FinalizeNode);
                    self.state = ParserState::Preamble;
                }
                self.preamble_buf.clear();
                return;
            }
        }

        match &mut self.state {
            ParserState::Preamble => {
                self.preamble_buf.push_str(line);
                if self.preamble_buf.len() >= 120 || self.preamble_buf.matches('\n').count() >= 2 {
                    let prose = std::mem::take(&mut self.preamble_buf);
                    self.trigger_fallback_with_text(&prose, events);
                }
            }
            ParserState::InNode {
                in_fence,
                has_emitted_content,
                pending_ws,
            } => {
                update_fence_state(in_fence, stripped.trim_start());
                emit_in_node_text(events, has_emitted_content, pending_ws, line);
            }
        }
    }
}

fn is_node_header_line(trimmed: &str) -> bool {
    match trimmed.strip_prefix("@@NODE") {
        Some(rest) => rest.is_empty() || rest.starts_with(char::is_whitespace),
        None => false,
    }
}

fn update_fence_state(in_fence: &mut Option<(char, usize)>, trimmed_start: &str) {
    let Some(first) = trimmed_start.chars().next() else {
        return;
    };
    if first != '`' && first != '~' {
        return;
    }
    let count = trimmed_start.chars().take_while(|&c| c == first).count();
    if count < 3 {
        return;
    }
    let rest = &trimmed_start[count..];

    match *in_fence {
        None => {
            if first == '~' || !rest.contains('`') {
                *in_fence = Some((first, count));
            }
        }
        Some((fc, min_len)) => {
            if first == fc && count >= min_len && rest.trim().is_empty() {
                *in_fence = None;
            }
        }
    }
}

fn emit_in_node_text(
    events: &mut Vec<ParsedEvent>,
    has_emitted_content: &mut bool,
    pending_ws: &mut String,
    text: &str,
) {
    if text.is_empty() {
        return;
    }

    if !*has_emitted_content {
        if text.trim().is_empty() {
            return;
        }
        let trimmed_leading = text.trim_start_matches(['\r', '\n']);
        if trimmed_leading.trim().is_empty() {
            return;
        }
        *has_emitted_content = true;
        let core = trimmed_leading.trim_end();
        let ws_len = core.len();
        events.push(ParsedEvent::TokenDelta(core.to_owned()));
        pending_ws.push_str(&trimmed_leading[ws_len..]);
        return;
    }

    if text.trim().is_empty() {
        pending_ws.push_str(text);
        return;
    }

    let core = text.trim_end();
    let tail_ws = &text[core.len()..];
    let mut chunk = String::with_capacity(pending_ws.len() + core.len());
    chunk.push_str(pending_ws);
    chunk.push_str(core);
    pending_ws.clear();
    pending_ws.push_str(tail_ws);
    events.push(ParsedEvent::TokenDelta(chunk));
}

fn parse_node_header(line: &str, defaults: &LensDefaults) -> ParsedNodeMeta {
    let mut node_type = defaults.node_type;
    let mut edge_type = defaults.edge_type;
    let mut severity = defaults.severity;
    let mut title = defaults.title.clone();

    let body = line.strip_prefix("@@NODE").unwrap_or("").trim();
    let mut chars = body.chars().peekable();

    while let Some(&ch) = chars.peek() {
        if ch.is_whitespace() {
            chars.next();
            continue;
        }

        let mut key = String::new();
        while let Some(&c) = chars.peek() {
            if c == '=' || c.is_whitespace() {
                break;
            }
            key.push(c);
            chars.next();
        }

        if chars.peek() != Some(&'=') {
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                chars.next();
            }
            continue;
        }
        chars.next(); // consume '='

        let val = if chars.peek() == Some(&'"') {
            chars.next(); // consume opening '"'
            let mut quoted = String::new();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    match chars.next() {
                        Some('n') => quoted.push('\n'),
                        Some('t') => quoted.push('\t'),
                        Some(escaped) => quoted.push(escaped),
                        None => break,
                    }
                } else if c == '"' {
                    break;
                } else {
                    quoted.push(c);
                }
            }
            quoted
        } else {
            let mut unquoted = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                unquoted.push(c);
                chars.next();
            }
            unquoted
        };

        if key.eq_ignore_ascii_case("type") {
            if let Ok(parsed) = NodeType::from_db_str(&val.to_lowercase()) {
                node_type = parsed;
            }
        } else if key.eq_ignore_ascii_case("edge") {
            if let Ok(parsed) = EdgeType::from_db_str(&val.to_lowercase()) {
                edge_type = parsed;
            }
        } else if key.eq_ignore_ascii_case("severity") {
            if let Ok(parsed) = Severity::from_db_str(&val.to_lowercase()) {
                severity = Some(parsed);
            }
        } else if key.eq_ignore_ascii_case("title") && !val.trim().is_empty() {
            title = val;
        }
    }

    ParsedNodeMeta {
        node_type,
        edge_type,
        severity,
        title,
    }
}

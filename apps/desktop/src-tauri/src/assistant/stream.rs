//! Incremental parsers for the two streaming formats.
//!
//! Network chunks split anywhere — mid-line, mid-UTF-8 sequence — so both
//! parsers buffer bytes and only hand out complete records.

/// One Server-Sent Event: its `event:` name (empty when absent) and its
/// `data:` lines joined with `\n`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// Server-Sent Events (Anthropic). Records end at a blank line; `\r\n` and
/// `\n` line ends are both accepted; `:` comment lines are ignored.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=nl).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line).into_owned();
            if line.is_empty() {
                if !self.data.is_empty() || !self.event.is_empty() {
                    out.push(SseEvent {
                        event: std::mem::take(&mut self.event),
                        data: std::mem::take(&mut self.data).join("\n"),
                    });
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line.as_str(), ""),
            };
            match field {
                "event" => self.event = value.to_string(),
                "data" => self.data.push(value.to_string()),
                _ => {}
            }
        }
        out
    }
}

/// Newline-delimited JSON (Ollama). Blank lines are skipped; a line that is
/// not JSON is reported as an error rather than dropped silently.
#[derive(Default)]
pub struct NdjsonParser {
    buf: Vec<u8>,
}

impl NdjsonParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Result<serde_json::Value, String>> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let text = String::from_utf8_lossy(&line);
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            out.push(
                serde_json::from_str(text)
                    .map_err(|_| "The model sent a line that is not JSON.".into()),
            );
        }
        out
    }

    /// Whatever is left once the stream ends: a last line with no newline.
    pub fn finish(&mut self) -> Option<Result<serde_json::Value, String>> {
        let rest = std::mem::take(&mut self.buf);
        let text = String::from_utf8_lossy(&rest);
        let text = text.trim();
        if text.is_empty() {
            None
        } else {
            Some(
                serde_json::from_str(text)
                    .map_err(|_| "The model sent a line that is not JSON.".into()),
            )
        }
    }
}

/// What a provider's stream says next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    Text(String),
    Done,
    Error(String),
}

/// Fixtures the provider tests share.
#[cfg(test)]
pub use tests::{ANTHROPIC_FIXTURE, OLLAMA_FIXTURE};

#[cfg(test)]
mod tests {
    use super::*;

    /// A real-shaped Anthropic stream (trimmed), from the Messages API docs.
    pub const ANTHROPIC_FIXTURE: &str = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-5-5\"}}\n\
\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\
\n\
event: ping\n\
data: {\"type\": \"ping\"}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\", wörld\"}}\n\
\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\n\
\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\
\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\
\n";

    #[test]
    fn sse_records_survive_any_chunking() {
        let whole = SseParser::default().push(ANTHROPIC_FIXTURE.as_bytes());
        assert_eq!(whole.len(), 8);
        assert_eq!(whole[3].event, "content_block_delta");
        // One byte at a time — splits every line and the two-byte ö.
        let mut p = SseParser::default();
        let mut bytewise = Vec::new();
        for b in ANTHROPIC_FIXTURE.as_bytes() {
            bytewise.extend(p.push(std::slice::from_ref(b)));
        }
        assert_eq!(whole, bytewise);
        assert!(bytewise[4].data.contains("wörld"));
    }

    #[test]
    fn sse_handles_crlf_comments_and_multiline_data() {
        let mut p = SseParser::default();
        let ev = p.push(b": keep-alive\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\ndata:c\n\n");
        assert_eq!(
            ev,
            vec![
                SseEvent {
                    event: "x".into(),
                    data: "a\nb".into()
                },
                SseEvent {
                    event: String::new(),
                    data: "c".into()
                },
            ]
        );
        // An incomplete record waits for its blank line.
        assert!(p.push(b"data: pending\n").is_empty());
        assert_eq!(p.push(b"\n")[0].data, "pending");
    }

    pub const OLLAMA_FIXTURE: &str = "{\"model\":\"llama3.2\",\"message\":{\"role\":\"assistant\",\"content\":\"SELECT\"},\"done\":false}\n\
{\"model\":\"llama3.2\",\"message\":{\"role\":\"assistant\",\"content\":\" 1;\"},\"done\":false}\n\
\n\
{\"model\":\"llama3.2\",\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"total_duration\":123}\n";

    #[test]
    fn ndjson_lines_survive_any_chunking() {
        let whole: Vec<_> = NdjsonParser::default().push(OLLAMA_FIXTURE.as_bytes());
        assert_eq!(whole.len(), 3);
        let mut p = NdjsonParser::default();
        let mut pieces = Vec::new();
        for chunk in OLLAMA_FIXTURE.as_bytes().chunks(7) {
            pieces.extend(p.push(chunk));
        }
        assert_eq!(whole, pieces);
        assert_eq!(pieces[1].as_ref().unwrap()["message"]["content"], " 1;");
        assert!(p.finish().is_none());
    }

    #[test]
    fn ndjson_reports_garbage_and_a_last_unterminated_line() {
        let mut p = NdjsonParser::default();
        let out = p.push(b"not json\n{\"done\":true}");
        assert!(out[0].is_err());
        assert_eq!(p.finish().unwrap().unwrap()["done"], true);
        let mut p = NdjsonParser::default();
        p.push(b"{oops");
        assert!(p.finish().unwrap().is_err());
    }
}

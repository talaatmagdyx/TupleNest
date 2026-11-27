//! Anthropic Messages API: request body, stream decoding, error wording.

use super::context::{Prompt, Role};
use super::stream::{Piece, SseEvent};

pub const BASE_URL: &str = "https://api.anthropic.com";
pub const API_VERSION: &str = "2023-06-01";
pub const DEFAULT_MODEL: &str = "claude-sonnet-5-5";
/// The models the picker offers, default first. Anything else is refused.
pub const MODELS: [(&str, &str); 3] = [
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
];
pub const MAX_TOKENS: u32 = 2_048;

pub fn is_known_model(model: &str) -> bool {
    MODELS.iter().any(|(id, _)| *id == model)
}

fn role(r: Role) -> &'static str {
    match r {
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

/// The JSON body for `POST /v1/messages`, streaming.
pub fn request_body(model: &str, prompt: &Prompt) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "stream": true,
        "system": prompt.system,
        "messages": prompt
            .messages
            .iter()
            .map(|(r, text)| serde_json::json!({ "role": role(*r), "content": text }))
            .collect::<Vec<_>>(),
    })
}

/// The smallest request that proves a key works: one token, not streamed.
pub fn test_body(model: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{ "role": "user", "content": "ping" }],
    })
}

/// What one SSE record means.
pub fn decode(ev: &SseEvent) -> Option<Piece> {
    let v: serde_json::Value = serde_json::from_str(&ev.data).ok()?;
    let kind = v["type"].as_str().unwrap_or(ev.event.as_str());
    match kind {
        "content_block_delta" if v["delta"]["type"] == "text_delta" => v["delta"]["text"]
            .as_str()
            .map(|t| Piece::Text(t.to_string())),
        "message_stop" => Some(Piece::Done),
        "error" => Some(Piece::Error(stream_error(&v))),
        _ => None,
    }
}

fn stream_error(v: &serde_json::Value) -> String {
    match v["error"]["type"].as_str() {
        Some("overloaded_error") => {
            "Anthropic's API is overloaded right now. Try again in a minute.".into()
        }
        Some("rate_limit_error") => {
            "Too many requests for this key. Wait a moment and try again.".into()
        }
        _ => format!(
            "The Anthropic API stopped with an error: {}",
            v["error"]["message"].as_str().unwrap_or("no message")
        ),
    }
}

/// Plain words for a non-2xx answer. `body` is the response text.
pub fn status_error(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string));
    match status {
        401 => {
            "The Anthropic API did not accept this key. Check it in Settings › Assistant.".into()
        }
        403 => "This key is not allowed to use that model.".into(),
        404 => "The Anthropic API does not know that model.".into(),
        429 => "Too many requests for this key. Wait a moment and try again.".into(),
        529 => "Anthropic's API is overloaded right now. Try again in a minute.".into(),
        s if s >= 500 => "Anthropic's API had a problem. Try again in a minute.".into(),
        s => match message {
            Some(m) => format!("The Anthropic API refused the request ({s}): {m}"),
            None => format!("The Anthropic API refused the request ({s})."),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::stream::{SseParser, ANTHROPIC_FIXTURE};

    #[test]
    fn the_body_has_the_model_stream_flag_and_roles() {
        let p = Prompt {
            system: "sys".into(),
            messages: vec![
                (Role::User, "a".into()),
                (Role::Assistant, "b".into()),
                (Role::User, "c".into()),
            ],
        };
        let b = request_body(DEFAULT_MODEL, &p);
        assert_eq!(b["model"], "claude-sonnet-5-5");
        assert_eq!(b["stream"], true);
        assert_eq!(b["system"], "sys");
        assert_eq!(b["messages"][1]["role"], "assistant");
        assert_eq!(b["messages"][2]["content"], "c");
        assert_eq!(b.as_object().unwrap().len(), 5, "no other fields: {b}");
    }

    #[test]
    fn the_test_body_asks_for_one_token() {
        let b = test_body(DEFAULT_MODEL);
        assert_eq!(b["max_tokens"], 1);
        assert!(b.get("stream").is_none());
    }

    #[test]
    fn the_fixture_decodes_to_text_then_done() {
        let pieces: Vec<Piece> = SseParser::default()
            .push(ANTHROPIC_FIXTURE.as_bytes())
            .iter()
            .filter_map(decode)
            .collect();
        assert_eq!(
            pieces,
            vec![
                Piece::Text("Hello".into()),
                Piece::Text(", wörld".into()),
                Piece::Done
            ]
        );
    }

    #[test]
    fn a_stream_error_is_put_in_plain_words() {
        let ev = SseEvent {
            event: "error".into(),
            data: r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
                .into(),
        };
        assert!(matches!(decode(&ev), Some(Piece::Error(m)) if m.contains("overloaded")));
        let ev = SseEvent {
            event: "error".into(),
            data: r#"{"type":"error","error":{"type":"api_error","message":"boom"}}"#.into(),
        };
        assert!(matches!(decode(&ev), Some(Piece::Error(m)) if m.contains("boom")));
    }

    #[test]
    fn statuses_read_as_sentences() {
        assert!(status_error(401, "").contains("did not accept this key"));
        assert!(status_error(429, "").contains("Too many"));
        assert!(status_error(529, "").contains("overloaded"));
        assert!(status_error(500, "").contains("had a problem"));
        assert!(status_error(404, "").contains("model"));
        assert!(status_error(403, "").contains("not allowed"));
        assert!(status_error(400, r#"{"error":{"message":"bad field"}}"#).contains("bad field"));
        assert!(status_error(400, "nope").ends_with("(400)."));
    }

    #[test]
    fn only_the_offered_models_are_known() {
        assert!(is_known_model("claude-opus-5-5"));
        assert!(!is_known_model("gpt-4"));
    }
}

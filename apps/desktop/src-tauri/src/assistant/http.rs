//! The two providers over HTTP, and the loop that turns a response body into
//! tokens for the WebView.
//!
//! One client for the app: no redirects (a loopback Ollama must not be able
//! to bounce the request to another host), a connect timeout so a dead
//! network fails in seconds, and a read timeout so a stalled stream ends.

use std::sync::OnceLock;
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use tokio::sync::Notify;
use tuplenest_credential_store::Secret;

use super::context::Prompt;
use super::stream::{NdjsonParser, Piece, SseParser};
use super::{anthropic, ollama};

pub fn client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    // reqwest is built without a crypto provider (as the updater uses it);
    // ring is the one already in the tree. Losing the race to another
    // installer is fine — there is a provider either way.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let c = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(90))
        .user_agent(concat!("TupleNest/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Could not start the HTTP client: {e}"))?;
    Ok(CLIENT.get_or_init(|| c).clone())
}

/// How the stream is framed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Sse,
    Ndjson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Finished,
    Cancelled,
}

/// Read a streamed body to its end, handing each text piece to `emit`.
///
/// `cancel` is a `Notify` the cancel command pokes with `notify_one`, which
/// stores a permit — a cancel that lands before this starts waiting still
/// counts.
pub async fn pump<S, B, E>(
    mut body: S,
    format: Format,
    cancel: &Notify,
    mut emit: impl FnMut(&str),
) -> Result<Outcome, String>
where
    S: Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    let mut sse = SseParser::default();
    let mut ndjson = NdjsonParser::default();
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.notified() => return Ok(Outcome::Cancelled),
            next = body.next() => next,
        };
        let pieces: Vec<Piece> = match next {
            Some(Ok(chunk)) => match format {
                Format::Sse => sse
                    .push(chunk.as_ref())
                    .iter()
                    .filter_map(anthropic::decode)
                    .collect(),
                Format::Ndjson => ndjson
                    .push(chunk.as_ref())
                    .into_iter()
                    .filter_map(|r| match r {
                        Ok(v) => ollama::decode(&v),
                        Err(e) => Some(Piece::Error(e)),
                    })
                    .collect(),
            },
            Some(Err(e)) => {
                return Err(format!(
                    "The connection dropped while the answer was coming in: {e}"
                ))
            }
            None => {
                // Ollama may end its last line without a newline.
                let tail = match format {
                    Format::Ndjson => ndjson.finish().map(|r| match r {
                        Ok(v) => ollama::decode(&v),
                        Err(e) => Some(Piece::Error(e)),
                    }),
                    Format::Sse => None,
                };
                match tail.flatten() {
                    Some(Piece::Done) => return Ok(Outcome::Finished),
                    Some(Piece::Text(t)) => emit(&t),
                    Some(Piece::Error(e)) => return Err(e),
                    None => {}
                }
                return Err("The answer was cut off before it finished.".into());
            }
        };
        for p in pieces {
            match p {
                Piece::Text(t) => emit(&t),
                Piece::Done => return Ok(Outcome::Finished),
                Piece::Error(e) => return Err(e),
            }
        }
    }
}

fn anthropic_net_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "The Anthropic API took too long to answer. Try again.".into()
    } else if e.is_connect() {
        "Could not reach api.anthropic.com. Check the network connection.".into()
    } else {
        format!("The request to the Anthropic API failed: {e}")
    }
}

fn ollama_net_error(e: &reqwest::Error, base: &str) -> String {
    if e.is_timeout() {
        format!("Ollama at {base} took too long to answer.")
    } else if e.is_connect() {
        format!("Ollama is not running at {base}. Start the Ollama app, or run `ollama serve`.")
    } else {
        format!("The request to Ollama failed: {e}")
    }
}

async fn post_anthropic(
    client: &reqwest::Client,
    base: &str,
    key: &Secret,
    body: &serde_json::Value,
) -> Result<reqwest::Response, String> {
    let resp = client
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key.expose())
        .header("anthropic-version", anthropic::API_VERSION)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| anthropic_net_error(&e))?;
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Err(anthropic::status_error(status, &text))
}

/// Stream an answer from the Anthropic Messages API.
pub async fn anthropic_ask(
    client: &reqwest::Client,
    base: &str,
    key: &Secret,
    model: &str,
    prompt: &Prompt,
    cancel: &Notify,
    emit: impl FnMut(&str),
) -> Result<Outcome, String> {
    let body = anthropic::request_body(model, prompt);
    let resp = tokio::select! {
        biased;
        _ = cancel.notified() => return Ok(Outcome::Cancelled),
        r = post_anthropic(client, base, key, &body) => r?,
    };
    pump(Box::pin(resp.bytes_stream()), Format::Sse, cancel, emit).await
}

/// One-token request: does this key work?
pub async fn anthropic_test(
    client: &reqwest::Client,
    base: &str,
    key: &Secret,
) -> Result<(), String> {
    post_anthropic(
        client,
        base,
        key,
        &anthropic::test_body(anthropic::DEFAULT_MODEL),
    )
    .await
    .map(|_| ())
}

/// Stream an answer from Ollama's `/api/chat`.
pub async fn ollama_ask(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    prompt: &Prompt,
    cancel: &Notify,
    emit: impl FnMut(&str),
) -> Result<Outcome, String> {
    let body = ollama::request_body(model, prompt);
    let send = async {
        let resp = client
            .post(format!("{base}/api/chat"))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| ollama_net_error(&e, base))?;
        if resp.status().is_success() {
            return Ok(resp);
        }
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        Err(ollama::status_error(status, &text, model))
    };
    let resp = tokio::select! {
        biased;
        _ = cancel.notified() => return Ok(Outcome::Cancelled),
        r = send => r?,
    };
    pump(Box::pin(resp.bytes_stream()), Format::Ndjson, cancel, emit).await
}

/// The models Ollama has pulled.
pub async fn ollama_tags(
    client: &reqwest::Client,
    base: &str,
) -> Result<Vec<ollama::OllamaModel>, String> {
    let resp = client
        .get(format!("{base}/api/tags"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| ollama_net_error(&e, base))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(ollama::status_error(status, &text, "that"));
    }
    ollama::parse_tags(&text)
}

/// Refuse to send to an Ollama cloud model unless the user opted in. Asks
/// `/api/tags` first, because a cloud model's name need not say so; without
/// the opt-in, a model that cannot be checked is not sent to.
pub async fn ollama_cloud_gate(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    allow_cloud: bool,
) -> Result<(), String> {
    if allow_cloud {
        return Ok(());
    }
    ollama::check_cloud(model, &[], false)?;
    let listed = ollama_tags(client, base).await?;
    ollama::check_cloud(model, &listed, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::context::{build_prompt, Action, AskInput};
    use crate::assistant::stream::{ANTHROPIC_FIXTURE, OLLAMA_FIXTURE};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A one-shot HTTP server on 127.0.0.1: answers the first request with
    /// `response` and hands back the raw request it read. Loopback only —
    /// the suite never makes a real network call.
    async fn mock(response: String) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req);
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if req.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            sock.write_all(response.as_bytes()).await.unwrap();
            sock.shutdown().await.ok();
            String::from_utf8_lossy(&req).into_owned()
        });
        (base, handle)
    }

    fn ok(content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn status(code: u16, body: &str) -> String {
        format!(
            "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn prompt() -> Prompt {
        build_prompt(
            &AskInput {
                action: Action::Explain,
                message: "why slow".into(),
                sql: Some("select 1".into()),
                error: None,
                turns: vec![],
            },
            "table public.orders(id bigint)\n",
        )
    }

    #[tokio::test]
    async fn anthropic_streams_tokens_with_the_right_headers() {
        let (base, req) = mock(ok("text/event-stream", ANTHROPIC_FIXTURE)).await;
        let mut got = String::new();
        let out = anthropic_ask(
            &client().unwrap(),
            &base,
            &Secret::new("sk-ant-mock"),
            "claude-sonnet-5-5",
            &prompt(),
            &Notify::new(),
            |t| got.push_str(t),
        )
        .await
        .unwrap();
        assert_eq!(out, Outcome::Finished);
        assert_eq!(got, "Hello, wörld");
        let req = req.await.unwrap();
        let lower = req.to_ascii_lowercase();
        assert!(req.starts_with("POST /v1/messages HTTP/1.1"));
        assert!(lower.contains("x-api-key: sk-ant-mock"));
        assert!(lower.contains("anthropic-version: 2023-06-01"));
        assert!(req.contains("\"stream\":true"));
        assert!(req.contains("public.orders"));
    }

    #[tokio::test]
    async fn a_rejected_key_reads_as_a_sentence() {
        let (base, _req) = mock(status(
            401,
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
        ))
        .await;
        let err = anthropic_test(&client().unwrap(), &base, &Secret::new("bad"))
            .await
            .unwrap_err();
        assert!(err.contains("did not accept this key"), "{err}");
    }

    #[tokio::test]
    async fn the_key_test_sends_one_token_and_passes_on_200() {
        let (base, req) = mock(ok("application/json", r#"{"id":"msg"}"#)).await;
        anthropic_test(&client().unwrap(), &base, &Secret::new("sk-good"))
            .await
            .unwrap();
        assert!(req.await.unwrap().contains("\"max_tokens\":1"));
    }

    #[tokio::test]
    async fn ollama_streams_ndjson() {
        let (base, req) = mock(ok("application/x-ndjson", OLLAMA_FIXTURE)).await;
        let mut got = String::new();
        let out = ollama_ask(
            &client().unwrap(),
            &base,
            "llama3.2",
            &prompt(),
            &Notify::new(),
            |t| got.push_str(t),
        )
        .await
        .unwrap();
        assert_eq!(out, Outcome::Finished);
        assert_eq!(got, "SELECT 1;");
        let req = req.await.unwrap();
        assert!(req.starts_with("POST /api/chat HTTP/1.1"));
        assert!(!req.to_ascii_lowercase().contains("x-api-key"));
    }

    #[tokio::test]
    async fn ollama_lists_models_and_names_a_missing_one() {
        let (base, _r) = mock(ok(
            "application/json",
            r#"{"models":[{"name":"llama3.2:latest"}]}"#,
        ))
        .await;
        let tags = ollama_tags(&client().unwrap(), &base).await.unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "llama3.2:latest");
        assert!(!tags[0].cloud);

        let (base, _r) = mock(status(404, r#"{"error":"model \"nope\" not found"}"#)).await;
        let err = ollama_ask(
            &client().unwrap(),
            &base,
            "nope",
            &prompt(),
            &Notify::new(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(err.contains("ollama pull nope"), "{err}");
    }

    #[tokio::test]
    async fn the_cloud_gate_checks_remote_host_before_anything_is_sent() {
        // A cloud model whose name does not say so: only `remote_host` tells.
        let tags = r#"{"models":[{"name":"kimi:latest","remote_host":"https://ollama.com:443"},{"name":"llama3.2:latest"}]}"#;
        let (base, req) = mock(ok("application/json", tags)).await;
        let err = ollama_cloud_gate(&client().unwrap(), &base, "kimi:latest", false)
            .await
            .unwrap_err();
        assert!(err.contains("ollama.com"), "{err}");
        // Only the listing was asked for; no chat request went out.
        assert!(req.await.unwrap().starts_with("GET /api/tags"));

        let (base, _r) = mock(ok("application/json", tags)).await;
        ollama_cloud_gate(&client().unwrap(), &base, "llama3.2:latest", false)
            .await
            .unwrap();

        // A `:cloud` name is refused without asking the server at all.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let base = format!("http://127.0.0.1:{port}");
        let err = ollama_cloud_gate(&client().unwrap(), &base, "glm-5.2:cloud", false)
            .await
            .unwrap_err();
        assert!(err.contains("Allow Ollama cloud models"), "{err}");
        // With the opt-in, nothing is checked.
        ollama_cloud_gate(&client().unwrap(), &base, "glm-5.2:cloud", true)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn ollama_not_running_says_so() {
        // Bind and drop: a loopback port with nothing listening.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let base = format!("http://127.0.0.1:{port}");
        let err = ollama_tags(&client().unwrap(), &base).await.unwrap_err();
        assert!(err.contains("not running"), "{err}");
    }

    #[tokio::test]
    async fn redirects_are_not_followed() {
        let (base, _r) = mock(
            "HTTP/1.1 302 Found\r\nlocation: http://example.invalid/api/tags\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                .to_string(),
        )
        .await;
        let err = ollama_tags(&client().unwrap(), &base).await.unwrap_err();
        assert!(err.contains("302"), "{err}");
    }

    fn chunks(parts: Vec<&'static str>) -> impl Stream<Item = Result<Vec<u8>, String>> + Unpin {
        futures_util::stream::iter(parts.into_iter().map(|p| Ok(p.as_bytes().to_vec())))
    }

    #[tokio::test]
    async fn a_cancel_stops_the_stream() {
        let cancel = Notify::new();
        cancel.notify_one();
        let pending = futures_util::stream::pending::<Result<Vec<u8>, String>>();
        let out = pump(pending, Format::Sse, &cancel, |_| {}).await.unwrap();
        assert_eq!(out, Outcome::Cancelled);
    }

    #[tokio::test]
    async fn a_stream_that_ends_early_is_an_error() {
        let body = chunks(vec![
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"half\"}}\n\n",
        ]);
        let mut got = String::new();
        let err = pump(body, Format::Sse, &Notify::new(), |t| got.push_str(t))
            .await
            .unwrap_err();
        assert_eq!(got, "half");
        assert!(err.contains("cut off"));
    }

    #[tokio::test]
    async fn ndjson_tail_without_newline_still_finishes() {
        let body = chunks(vec![
            "{\"message\":{\"content\":\"a\"},\"done\":false}\n{\"done\":true}",
        ]);
        let out = pump(body, Format::Ndjson, &Notify::new(), |_| {})
            .await
            .unwrap();
        assert_eq!(out, Outcome::Finished);
        let body = chunks(vec!["{\"message\":{\"content\":\"tail\"}}"]);
        let mut got = String::new();
        let err = pump(body, Format::Ndjson, &Notify::new(), |t| got.push_str(t))
            .await
            .unwrap_err();
        assert_eq!(got, "tail");
        assert!(err.contains("cut off"));
        let body = chunks(vec!["garbage"]);
        assert!(pump(body, Format::Ndjson, &Notify::new(), |_| {})
            .await
            .unwrap_err()
            .contains("not JSON"));
        let body = chunks(vec!["garbage\n"]);
        assert!(pump(body, Format::Ndjson, &Notify::new(), |_| {})
            .await
            .unwrap_err()
            .contains("not JSON"));
    }

    #[tokio::test]
    async fn a_transport_error_mid_stream_is_reported() {
        let body = futures_util::stream::iter(vec![Err::<Vec<u8>, String>("reset".into())]);
        let err = pump(body, Format::Sse, &Notify::new(), |_| {})
            .await
            .unwrap_err();
        assert!(err.contains("reset"));
    }

    #[tokio::test]
    async fn a_mid_stream_error_event_stops_it() {
        let body = chunks(vec![
            "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"x\"}}\n\n",
        ]);
        assert!(pump(body, Format::Sse, &Notify::new(), |_| {})
            .await
            .unwrap_err()
            .contains("overloaded"));
    }
}

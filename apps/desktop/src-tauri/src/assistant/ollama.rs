//! Ollama: base-URL policy, request body, stream decoding.

use super::context::{Prompt, Role};
use super::stream::Piece;

pub const DEFAULT_URL: &str = "http://localhost:11434";

/// Check and normalise an Ollama base URL.
///
/// Only `http`/`https`, no user or password in the URL, no query or
/// fragment, and — unless the user has turned on "allow a server on another
/// computer" — a loopback host: `localhost`, `127.0.0.0/8` or `::1`. The
/// point of a local model is that nothing leaves the machine; a URL typed by
/// mistake, or planted, must not quietly send the schema elsewhere.
pub fn validate_url(raw: &str, allow_remote: bool) -> Result<String, String> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|_| "That is not a URL. Use something like http://localhost:11434.".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("The Ollama URL must start with http:// or https://.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the user name and password out of the Ollama URL.".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("The Ollama URL cannot have a query or a fragment.".into());
    }
    let host = url.host_str().ok_or("The Ollama URL has no host.")?;
    if !allow_remote && !is_loopback(host) {
        return Err(format!(
            "{host} is not this computer. Turn on \"Allow a server on another computer\" to use \
             it — the schema and your questions would then be sent there."
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// `host` as the URL parser normalised it: lower-case, IPv6 in brackets.
fn is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback(),
        Ok(std::net::IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
        Err(_) => false,
    }
}

/// Model names: what `ollama list` prints. Refuses anything that could turn
/// the request into something else.
pub fn is_valid_model(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
}

fn role(r: Role) -> &'static str {
    match r {
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

/// The JSON body for `POST /api/chat`, streaming.
pub fn request_body(model: &str, prompt: &Prompt) -> serde_json::Value {
    let mut messages = vec![serde_json::json!({ "role": "system", "content": prompt.system })];
    messages.extend(
        prompt
            .messages
            .iter()
            .map(|(r, text)| serde_json::json!({ "role": role(*r), "content": text })),
    );
    serde_json::json!({ "model": model, "stream": true, "messages": messages })
}

/// What one NDJSON line means.
pub fn decode(v: &serde_json::Value) -> Option<Piece> {
    if let Some(e) = v["error"].as_str() {
        return Some(Piece::Error(format!("Ollama stopped with an error: {e}")));
    }
    if v["done"] == true {
        return Some(Piece::Done);
    }
    v["message"]["content"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(|t| Piece::Text(t.to_string()))
}

/// The model names in a `GET /api/tags` answer.
pub fn parse_tags(body: &str) -> Result<Vec<String>, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "That server did not answer like Ollama does.".to_string())?;
    let models = v["models"]
        .as_array()
        .ok_or("That server did not answer like Ollama does.")?;
    Ok(models
        .iter()
        .filter_map(|m| m["name"].as_str().or(m["model"].as_str()))
        .map(str::to_string)
        .collect())
}

/// Plain words for a non-2xx answer.
pub fn status_error(status: u16, body: &str, model: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string));
    match status {
        404 => format!("Ollama has no model called {model}. Pull it with `ollama pull {model}`."),
        s => match message {
            Some(m) => format!("Ollama refused the request ({s}): {m}"),
            None => format!("Ollama refused the request ({s})."),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::stream::{NdjsonParser, OLLAMA_FIXTURE};

    #[test]
    fn loopback_hosts_are_accepted_and_normalised() {
        for ok in [
            "http://localhost:11434",
            "http://LOCALHOST:11434/",
            "http://127.0.0.1:11434",
            "http://127.8.9.10:1",
            "http://[::1]:11434",
            "https://localhost",
            "http://[::ffff:127.0.0.1]:11434",
        ] {
            assert!(validate_url(ok, false).is_ok(), "{ok}");
        }
        assert_eq!(
            validate_url("http://localhost:11434/", false).unwrap(),
            "http://localhost:11434"
        );
    }

    #[test]
    fn other_hosts_are_refused_unless_allowed() {
        for bad in [
            "http://192.168.1.20:11434",
            "http://ollama.example.com",
            "http://localhost.example.com:11434",
            "http://10.0.0.1",
            "http://[2001:db8::1]:11434",
            "http://0.0.0.0:11434",
        ] {
            let err = validate_url(bad, false).unwrap_err();
            assert!(err.contains("not this computer"), "{bad}: {err}");
            assert!(validate_url(bad, true).is_ok(), "{bad} with allow_remote");
        }
    }

    #[test]
    fn malformed_urls_are_refused_even_when_remote_is_allowed() {
        assert!(validate_url("ftp://localhost", true).is_err());
        assert!(validate_url("not a url", true).is_err());
        assert!(validate_url("http://user:pw@localhost:11434", true).is_err());
        assert!(validate_url("http://localhost:11434/?x=1", true).is_err());
        assert!(validate_url("http://localhost:11434/#frag", true).is_err());
        assert!(validate_url("file:///etc/passwd", true).is_err());
    }

    #[test]
    fn model_names_are_checked() {
        assert!(is_valid_model("llama3.2:latest"));
        assert!(is_valid_model("library/qwen2.5-coder:7b"));
        assert!(!is_valid_model(""));
        assert!(!is_valid_model("a b"));
        assert!(!is_valid_model(&"x".repeat(200)));
    }

    #[test]
    fn the_body_puts_the_system_text_first() {
        let p = Prompt {
            system: "sys".into(),
            messages: vec![(Role::User, "hi".into())],
        };
        let b = request_body("llama3.2", &p);
        assert_eq!(b["stream"], true);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][1]["content"], "hi");
        assert_eq!(b.as_object().unwrap().len(), 3);
    }

    #[test]
    fn the_fixture_decodes_to_text_then_done() {
        let pieces: Vec<Piece> = NdjsonParser::default()
            .push(OLLAMA_FIXTURE.as_bytes())
            .into_iter()
            .filter_map(|r| decode(&r.unwrap()))
            .collect();
        assert_eq!(
            pieces,
            vec![
                Piece::Text("SELECT".into()),
                Piece::Text(" 1;".into()),
                Piece::Done
            ]
        );
        let err = decode(&serde_json::json!({"error": "model not loaded"}));
        assert!(matches!(err, Some(Piece::Error(m)) if m.contains("model not loaded")));
    }

    #[test]
    fn tags_list_the_model_names() {
        let body = r#"{"models":[{"name":"llama3.2:latest","size":1},{"model":"qwen:7b"}]}"#;
        assert_eq!(
            parse_tags(body).unwrap(),
            vec!["llama3.2:latest", "qwen:7b"]
        );
        assert!(parse_tags("<html>").is_err());
        assert!(parse_tags("{}").is_err());
    }

    #[test]
    fn statuses_read_as_sentences() {
        assert!(status_error(404, "", "llama3").contains("ollama pull llama3"));
        assert!(status_error(500, r#"{"error":"out of memory"}"#, "m").contains("out of memory"));
        assert!(status_error(400, "", "m").ends_with("(400)."));
    }
}

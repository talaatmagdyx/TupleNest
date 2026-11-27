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

/// One model from `GET /api/tags`.
///
/// Ollama can list "cloud" models next to pulled ones: their name ends in
/// `:cloud` (or `-cloud`, as in `gpt-oss:120b-cloud`) and/or the entry carries
/// a `remote_host` such as `https://ollama.com:443`. Ollama forwards those
/// requests to that host, so the prompt leaves this computer even though the
/// app only ever talks to localhost.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    pub name: String,
    /// Runs somewhere else: see the type's comment.
    pub cloud: bool,
    /// Where it runs, as Ollama reported it, when it said.
    pub remote_host: Option<String>,
}

/// Where Ollama's cloud models run.
pub const CLOUD_HOST: &str = "ollama.com";

impl OllamaModel {
    /// The host a cloud model's prompt goes to, for labels: `ollama.com`
    /// unless Ollama named another.
    pub fn cloud_host(&self) -> String {
        self.remote_host
            .as_deref()
            .and_then(|h| reqwest::Url::parse(h).ok())
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| CLOUD_HOST.to_string())
    }

    /// What the pickers show.
    pub fn label(&self) -> String {
        if self.cloud {
            format!("{} · cloud via {}", self.name, self.cloud_host())
        } else {
            format!("{} · Ollama", self.name)
        }
    }
}

/// A name that marks a cloud model on its own: tag `cloud`, or a tag ending
/// in `-cloud`.
pub fn is_cloud_name(name: &str) -> bool {
    let tag = name
        .rsplit_once(':')
        .map_or("", |(_, t)| t)
        .to_ascii_lowercase();
    tag == "cloud" || tag.ends_with("-cloud")
}

fn non_empty(v: &serde_json::Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The models in a `GET /api/tags` answer, cloud ones marked.
pub fn parse_tags(body: &str) -> Result<Vec<OllamaModel>, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "That server did not answer like Ollama does.".to_string())?;
    let models = v["models"]
        .as_array()
        .ok_or("That server did not answer like Ollama does.")?;
    Ok(models
        .iter()
        .filter_map(|m| {
            let name = m["name"].as_str().or(m["model"].as_str())?.to_string();
            let remote_host = non_empty(&m["remote_host"]);
            let remote_model = non_empty(&m["remote_model"]);
            let cloud = remote_host.is_some() || remote_model.is_some() || is_cloud_name(&name);
            Some(OllamaModel {
                name,
                cloud,
                remote_host,
            })
        })
        .collect())
}

/// Whether `model` may be sent to: a cloud model needs the opt-in. `listed`
/// is what `/api/tags` says right now, so a cloud model that does not say so
/// in its name is still caught by its `remote_host`.
pub fn check_cloud(model: &str, listed: &[OllamaModel], allow_cloud: bool) -> Result<(), String> {
    if allow_cloud {
        return Ok(());
    }
    let found = listed.iter().find(|m| m.name == model);
    if is_cloud_name(model) || found.is_some_and(|m| m.cloud) {
        let host = found.map_or_else(|| CLOUD_HOST.to_string(), OllamaModel::cloud_host);
        return Err(format!(
            "{model} is an Ollama cloud model: it runs on {host}, not on this computer. Nothing \
             was sent. To use it, turn on \"Allow Ollama cloud models\" in Settings › Assistant; \
             your question, the query and table names are then sent to {host}."
        ));
    }
    Ok(())
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
        let models = parse_tags(body).unwrap();
        let names: Vec<&str> = models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["llama3.2:latest", "qwen:7b"]);
        assert!(models.iter().all(|m| !m.cloud));
        assert!(parse_tags("<html>").is_err());
        assert!(parse_tags("{}").is_err());
    }

    /// Shaped like `/api/tags` from an Ollama signed in to ollama.com.
    const CLOUD_TAGS: &str = r#"{"models":[
        {"name":"glm-5.2:cloud","model":"glm-5.2:cloud","remote_model":"glm-5.2","remote_host":"https://ollama.com:443","size":0},
        {"name":"gpt-oss:120b-cloud","model":"gpt-oss:120b-cloud","size":0},
        {"name":"kimi:latest","model":"kimi:latest","remote_host":"https://ollama.com:443"},
        {"name":"llama3.2:latest","model":"llama3.2:latest","remote_host":"","size":2019393189}
    ]}"#;

    #[test]
    fn cloud_models_are_marked_by_suffix_or_remote_host() {
        let m = parse_tags(CLOUD_TAGS).unwrap();
        let cloud: Vec<(&str, bool)> = m.iter().map(|x| (x.name.as_str(), x.cloud)).collect();
        assert_eq!(
            cloud,
            vec![
                ("glm-5.2:cloud", true),
                ("gpt-oss:120b-cloud", true),
                ("kimi:latest", true),
                ("llama3.2:latest", false),
            ]
        );
        assert_eq!(m[0].label(), "glm-5.2:cloud · cloud via ollama.com");
        assert_eq!(m[1].label(), "gpt-oss:120b-cloud · cloud via ollama.com");
        assert_eq!(m[3].label(), "llama3.2:latest · Ollama");
        assert!(is_cloud_name("x:CLOUD"));
        assert!(!is_cloud_name("cloudy:latest"));
        assert!(!is_cloud_name("cloud"));
    }

    #[test]
    fn a_cloud_model_is_refused_without_the_opt_in() {
        let m = parse_tags(CLOUD_TAGS).unwrap();
        for name in ["glm-5.2:cloud", "kimi:latest", "unlisted:cloud"] {
            let err = check_cloud(name, &m, false).unwrap_err();
            assert!(err.contains("ollama.com"), "{err}");
            assert!(err.contains("Allow Ollama cloud models"), "{err}");
            assert!(!err.contains("  "), "{err}");
            assert!(check_cloud(name, &m, true).is_ok());
        }
        assert!(check_cloud("llama3.2:latest", &m, false).is_ok());
    }

    #[test]
    fn statuses_read_as_sentences() {
        assert!(status_error(404, "", "llama3").contains("ollama pull llama3"));
        assert!(status_error(500, r#"{"error":"out of memory"}"#, "m").contains("out of memory"));
        assert!(status_error(400, "", "m").ends_with("(400)."));
    }
}

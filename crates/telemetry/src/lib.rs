//! Structured logging with secret redaction (master spec §59.1).
//!
//! Rules: never log credentials, secret parameters, sensitive result values,
//! or query text by default.

use tracing_subscriber::{fmt, EnvFilter};

/// Initialize global structured logging.
///
/// `json` selects machine-readable output (used in production builds);
/// human-readable output is used for development.
pub fn init(json: bool) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    if json {
        let _ = fmt().json().with_env_filter(filter).try_init();
    } else {
        let _ = fmt().with_env_filter(filter).try_init();
    }
}

/// Marker inserted wherever a sensitive value was removed.
pub const REDACTED: &str = "<redacted>";

/// Redact obviously sensitive key/value pairs from a flat parameter list
/// before it is logged or attached to a crash report.
///
/// This is a defense-in-depth measure — the primary rule is that sensitive
/// values must never reach a log call site in the first place.
pub fn redact_pairs<'a>(
    pairs: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Vec<(String, String)> {
    pairs
        .into_iter()
        .map(|(k, v)| {
            let key_lower = k.to_ascii_lowercase();
            let sensitive = [
                "password",
                "passwd",
                "secret",
                "token",
                "api_key",
                "apikey",
                "private_key",
                "credential",
                "authorization",
            ]
            .iter()
            .any(|marker| key_lower.contains(marker));
            let value = if sensitive {
                REDACTED.to_string()
            } else {
                v.to_string()
            };
            (k.to_string(), value)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_sensitive_keys_case_insensitively() {
        let out = redact_pairs([
            ("host", "db.example.com"),
            ("Password", "hunter2"),
            ("SSH_PRIVATE_KEY", "-----BEGIN"),
            ("api_key", "abc"),
        ]);
        assert_eq!(out[0].1, "db.example.com");
        assert_eq!(out[1].1, REDACTED);
        assert_eq!(out[2].1, REDACTED);
        assert_eq!(out[3].1, REDACTED);
    }

    #[test]
    fn no_secret_survives_a_redacted_dump() {
        let secret = "s3cr3t-value";
        let out = redact_pairs([("connection_password", secret), ("db", "app")]);
        let dump = format!("{out:?}");
        assert!(!dump.contains(secret));
    }
}

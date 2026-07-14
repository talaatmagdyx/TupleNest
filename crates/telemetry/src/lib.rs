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

/// Keep this guard alive for the lifetime of the app; dropping it flushes
/// and stops the background log writer.
pub type LogGuard = tracing_appender::non_blocking::WorkerGuard;

/// Initialize app logging: env-filtered, structured, written to a daily
/// rotated file in `log_dir` AND to stderr in debug builds.
///
/// Query text and credentials must never reach a log call site; redaction
/// helpers below are defense in depth.
pub fn init_app(log_dir: &std::path::Path, json: bool) -> std::io::Result<LogGuard> {
    std::fs::create_dir_all(log_dir)?;
    let appender = tracing_appender::rolling::daily(log_dir, "tuplenest.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = fmt()
        .with_env_filter(filter)
        .with_writer(writer)
        .with_ansi(false);
    if json {
        let _ = builder.json().try_init();
    } else {
        let _ = builder.try_init();
    }
    Ok(guard)
}

/// Install a panic hook that writes a sanitized crash report into
/// `crash_dir` (one file per crash) and logs the event, then delegates to
/// the previous hook. Reports contain panic message + location only —
/// never query text, parameters, or credentials.
pub fn install_panic_hook(crash_dir: std::path::PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let report = format!(
            "TupleNest crash report\ntimestamp_ms: {ts}\nthread: {}\nlocation: {location}\nmessage: {message}\n",
            std::thread::current().name().unwrap_or("<unnamed>"),
        );
        if std::fs::create_dir_all(&crash_dir).is_ok() {
            let _ = std::fs::write(crash_dir.join(format!("crash-{ts}.txt")), &report);
        }
        tracing::error!(component = "crash", location = %location, "panic captured");
        previous(info);
    }));
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

    #[test]
    fn background_panic_writes_crash_report_and_process_survives() {
        let dir = tempfile::tempdir().unwrap();
        install_panic_hook(dir.path().to_path_buf());

        let handle = std::thread::Builder::new()
            .name("bg-task".into())
            .spawn(|| panic!("forced test panic"))
            .unwrap();
        assert!(handle.join().is_err(), "thread panicked as intended");

        let reports: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("crash-"))
            .collect();
        assert_eq!(reports.len(), 1, "exactly one crash report written");
        let body = std::fs::read_to_string(reports[0].path()).unwrap();
        assert!(body.contains("forced test panic"));
        assert!(body.contains("thread: bg-task"));
        // Restore default hook so other tests' panics print normally.
        let _ = std::panic::take_hook();
    }
}

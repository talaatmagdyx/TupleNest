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
/// Lock a directory to the owner (0700) on Unix; no-op elsewhere. A 0700
/// directory is the strongest single protection for everything inside it —
/// other local users cannot traverse into it regardless of the files' own
/// modes. (Security review FILE-02.)
pub fn secure_dir(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o700);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Lock a file to owner read/write (0600) on Unix; no-op elsewhere.
pub fn secure_file(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Query text and credentials must never reach a log call site; redaction
/// helpers below are defense in depth.
pub fn init_app(log_dir: &std::path::Path, json: bool) -> std::io::Result<LogGuard> {
    std::fs::create_dir_all(log_dir)?;
    // Lock the log directory to the owner. On Unix a 0700 directory keeps other
    // local users from reaching the log files at all, whatever their file mode —
    // the rolling appender creates them with the process umask. (FILE-02.)
    secure_dir(log_dir);
    let appender = tracing_appender::rolling::daily(log_dir, "tuplenest.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let mut filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // In release, cap chatty transport/crypto crates to `warn` regardless of
    // RUST_LOG. They run in-process and could otherwise write connection
    // parameters or wire detail to the persistent on-disk log at trace/debug —
    // TupleNest's own redaction net does not wrap dependency output. Debug
    // builds keep RUST_LOG fully honored for development. (Security review
    // LOG-01.)
    if !cfg!(debug_assertions) {
        for directive in [
            "russh=warn",
            "tokio_postgres=warn",
            "rustls=warn",
            "russh_keys=warn",
            "h2=warn",
        ] {
            if let Ok(d) = directive.parse() {
                filter = filter.add_directive(d);
            }
        }
    }
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

/// Scrub anything that looks like a secret out of free text.
///
/// `redact_pairs` only helps when the caller already knows which field is
/// which. A panic message is a sentence someone else wrote, so the only option
/// is to recognise the shapes: `password="hunter2"`, `token: abc…`, a URL with
/// credentials in it.
///
/// This is a net, not a wall. It exists because the alternative — writing the
/// message verbatim and hoping — is worse, not because it can be complete.
pub fn redact_text(s: &str) -> String {
    let mut out = s.to_string();

    // key=value / key: value, where the key names something sensitive.
    // Non-greedy up to whitespace, comma, or a closing quote/brace.
    for key in [
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "private_key",
        "credential",
        "authorization",
    ] {
        let mut result = String::with_capacity(out.len());
        let lower = out.to_lowercase();
        let mut i = 0;
        while let Some(found) = lower[i..].find(key) {
            let start = i + found;
            let after = start + key.len();
            // Must be followed by an assignment, or it is just the word.
            let rest = &out[after..];
            let sep = rest.find(|c: char| !c.is_whitespace());
            let is_assign = sep.is_some_and(|s| {
                let c = rest.as_bytes()[s];
                c == b'=' || c == b':'
            });
            if !is_assign {
                result.push_str(&out[i..after]);
                i = after;
                continue;
            }
            let val_start = after + sep.unwrap() + 1;
            let val = &out[val_start..];
            let skip = val.len() - val.trim_start().len();
            let body = &val[skip..];
            // A quoted value runs to its closing quote, not to the first space.
            // Stopping at whitespace would leave the tail of
            // `password="hunter2 and friends"` sitting in the report.
            let end = match body.chars().next() {
                Some(q @ ('"' | '\'')) => body[1..].find(q).map(|e| e + 2).unwrap_or(body.len()),
                _ => body
                    .find(|c: char| c.is_whitespace() || c == ',' || c == '}' || c == ')')
                    .unwrap_or(body.len()),
            };
            result.push_str(&out[i..val_start]);
            result.push_str(&val[..skip]);
            result.push_str(REDACTED);
            i = val_start + skip + end;
        }
        result.push_str(&out[i..]);
        out = result;
    }

    // postgres://user:password@host — the password is between the last colon
    // of the userinfo and the @.
    let mut cleaned = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(at) = rest.find('@') {
        match rest[..at].rfind("://") {
            Some(scheme_end) => {
                let userinfo = &rest[scheme_end + 3..at];
                match userinfo.find(':') {
                    Some(colon) => {
                        cleaned.push_str(&rest[..scheme_end + 3 + colon + 1]);
                        cleaned.push_str(REDACTED);
                        rest = &rest[at..];
                    }
                    None => {
                        cleaned.push_str(&rest[..=at]);
                        rest = &rest[at + 1..];
                    }
                }
            }
            None => {
                cleaned.push_str(&rest[..=at]);
                rest = &rest[at + 1..];
            }
        }
    }
    cleaned.push_str(rest);
    cleaned
}

/// Install a panic hook that writes a crash report into `crash_dir` (one file
/// per crash) and logs the event, then delegates to the previous hook.
///
/// The report is written to local disk and **never uploaded** — see PRIVACY.md.
/// It holds a timestamp, thread, source location and the panic message, with
/// `redact_text` run over the message first.
///
/// That last part was the gap: this doc used to claim reports were "sanitized"
/// while writing the payload verbatim. No panic in this codebase can carry a
/// secret — every panic site here is a fixed string, and `Secret` prints as
/// `Secret(<redacted>)` — but a panic from inside `keyring`, `russh` or
/// `tokio_postgres` is not ours to predict, and that is exactly the case the
/// claim was covering for.
pub fn install_panic_hook(crash_dir: std::path::PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let message = redact_text(&message);
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
            secure_dir(&crash_dir);
            let file = crash_dir.join(format!("crash-{ts}.txt"));
            let _ = std::fs::write(&file, &report);
            secure_file(&file);
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

#[cfg(test)]
mod redact_text_tests {
    use super::*;

    #[test]
    fn redacts_an_assigned_password() {
        assert_eq!(
            redact_text(r#"failed: password="hunter2" rejected"#),
            "failed: password=<redacted> rejected"
        );
    }

    #[test]
    fn a_quoted_value_is_redacted_past_its_spaces() {
        // Stopping at the first space would leave the rest of the passphrase
        // sitting in the report.
        let out = redact_text(r#"password="correct horse battery staple" host=db"#);
        assert!(!out.contains("horse"), "{out}");
        assert!(out.contains("host=db"), "{out}");
    }

    #[test]
    fn redacts_colon_form_and_several_keys() {
        let out = redact_text("token: abc123, api_key: def456");
        assert!(!out.contains("abc123"), "{out}");
        assert!(!out.contains("def456"), "{out}");
    }

    #[test]
    fn redacts_a_password_in_a_connection_url() {
        // The shape a driver is most likely to put in a panic message.
        assert_eq!(
            redact_text("postgres://app:s3cr3t@db.internal:5432/app"),
            "postgres://app:<redacted>@db.internal:5432/app"
        );
    }

    #[test]
    fn leaves_a_url_without_a_password_alone() {
        assert_eq!(
            redact_text("postgres://app@db.internal:5432/app"),
            "postgres://app@db.internal:5432/app"
        );
    }

    #[test]
    fn leaves_the_bare_word_alone() {
        // "password authentication failed for user X" is the single most useful
        // error PostgreSQL returns. Mangling it would make the report useless
        // to fix nothing.
        let msg = "password authentication failed for user appuser";
        assert_eq!(redact_text(msg), msg);
    }

    #[test]
    fn keeps_the_rest_of_the_message_readable() {
        let out = redact_text("connect failed: password=abc host=db.internal port=5432");
        assert!(out.contains("host=db.internal"), "{out}");
        assert!(out.contains("port=5432"), "{out}");
        assert!(!out.contains("abc"), "{out}");
    }

    #[test]
    fn is_case_insensitive_about_the_key() {
        assert!(!redact_text("PASSWORD=abc").contains("abc"));
    }

    #[test]
    fn handles_an_empty_message() {
        assert_eq!(redact_text(""), "");
    }
}

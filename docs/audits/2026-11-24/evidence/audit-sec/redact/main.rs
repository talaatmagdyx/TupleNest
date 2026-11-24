mod tuplenest_telemetry {
pub const REDACTED: &str = "<redacted>";
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
        // ASCII-only lowering keeps every byte offset identical to `out`'s.
        // `to_lowercase` does not (`İ` is 2 bytes, lowered 3), so offsets
        // found in it sliced `out` mid-character — a panic — or missed the
        // key altogether and left the secret in place.
        let lower = out.to_ascii_lowercase();
        let mut i = 0;
        while let Some(found) = lower[i..].find(key) {
            let start = i + found;
            let after = start + key.len();
            // Must be followed by an assignment, or it is just the word. A
            // quoted key — JSON's `"password": "x"` — has its closing quote
            // first; without allowing it, JSON-shaped secrets survived.
            let quote = usize::from(out[after..].starts_with(['"', '\'']));
            let after = after + quote;
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
}
fn opts_out_of_history(sql: &str) -> bool {
    sql.to_ascii_lowercase().contains("tuplenest:no-history")
}

/// Best-effort redaction of secret literals before SQL is written to disk.
///
/// `tuplenest_telemetry::redact_text` already handles `password=…` and
/// connection-string URLs, but SQL's own shapes use a keyword + whitespace +
/// quoted literal (`PASSWORD 'x'`, `IDENTIFIED BY 'x'`, `ENCRYPTED PASSWORD
/// 'x'`) that it doesn't match. This scrubs those, then defers to redact_text.
/// Documented as best-effort, not a guarantee — the honest position is that
/// truly sensitive statements should be run with history disabled.
fn redact_sql(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let lower = sql.to_ascii_lowercase();
    let mut i = 0;
    // Keywords after which a quoted literal is a secret.
    const MARKERS: [&str; 2] = ["password", "identified by"];
    while i < sql.len() {
        let mut matched = false;
        for m in MARKERS {
            if lower[i..].starts_with(m) {
                // Emit the keyword, then look for the next quoted literal and
                // replace its contents.
                let after = i + m.len();
                let rest = &sql[after..];
                let ws = rest.len() - rest.trim_start().len();
                let body = &rest[ws..];
                if let Some(q @ ('\'' | '"')) = body.chars().next() {
                    if let Some(close) = body[1..].find(q) {
                        out.push_str(&sql[i..after]); // keyword
                        out.push_str(&rest[..ws]); // whitespace
                        out.push(q);
                        out.push_str("[REDACTED]");
                        out.push(q);
                        i = after + ws + 1 + close + 1;
                        matched = true;
                        break;
                    }
                }
            }
        }
        if !matched {
            let ch = sql[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    tuplenest_telemetry::redact_text(&out)
}
fn main() {
    let cases = [
        "ALTER ROLE app PASSWORD 'plain-secret'",
        "ALTER ROLE app PASSWORD 'it''s-secret-tail'",
        "ALTER ROLE app PASSWORD $$dollar-secret$$",
        "ALTER ROLE app PASSWORD $pw$tagged-secret$pw$",
        "ALTER ROLE app PASSWORD E'escape-secret'",
        "ALTER ROLE app PASSWORD /* c */ 'comment-secret'",
        "SELECT crypt('hunter2', gen_salt('bf'))",
        "SELECT pgp_sym_decrypt(card, 'aes-key-123') FROM payments",
        "INSERT INTO customers(email, ssn) VALUES ('alice@example.com', '078-05-1120')",
        "SELECT dblink_connect('host=db user=u password=dblink-secret')",
        "UPDATE users SET password_hash = '$2b$12$abcdef' WHERE id = 1",
        "select 1 -- TupleNest:No-History",
    ];
    for c in cases {
        println!("IN : {c}\nOUT: {}\nopt-out={}\n", redact_sql(c), opts_out_of_history(c));
    }
}

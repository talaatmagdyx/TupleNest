//! What the assistant is allowed to send, and the one place it is assembled.
//!
//! The privacy rule (README "The assistant", PRIVACY.md) is enforced here, by
//! construction: a prompt is built from exactly these inputs and nothing else.
//!
//! - the message the user typed, and earlier turns of the same panel
//!   conversation;
//! - the editor's SQL, for the actions that use it;
//! - for Fix, the error's title, SQLSTATE and the server's message — with the
//!   `Detail:` and `Context:` lines removed, because those carry row values
//!   (`Key (email)=(alice@example.com) already exists`);
//! - schema names: schema, table and column names and column types of the
//!   connected database, read from the metadata cache and capped.
//!
//! There is no parameter through which a result cell, a history entry, a
//! connection's host, user or password, or another connection's schema could
//! arrive. The schema digest reads one cache key — the live session's — and
//! from each cached entry takes `name`, `kind` and `dbType` only: comments,
//! index definitions, size and row estimates stay behind.

use serde::{Deserialize, Serialize};
use tuplenest_metadata_cache::MetadataCache;

/// Most characters of the user's own message.
pub const MESSAGE_CAP: usize = 8_000;
/// Most characters of editor SQL.
pub const SQL_CAP: usize = 20_000;
/// Most characters of the (sanitized) error.
pub const ERROR_CAP: usize = 2_000;
/// Most characters of the schema digest.
pub const SCHEMA_CAP: usize = 12_000;
/// Earlier turns kept, and the most characters of each.
pub const TURNS_KEPT: usize = 6;
pub const TURN_CAP: usize = 4_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// Free-form question in the panel.
    Chat,
    /// What a query does and why it may be slow.
    Explain,
    /// Correct a statement that failed.
    Fix,
    /// SQL from a plain-English request.
    Write,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Turn {
    pub role: Role,
    pub text: String,
}

/// What the WebView asks for. Every field is text the user can see on screen
/// in the panel or the editor; nothing here is read from a result.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskInput {
    pub action: Action,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub sql: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub turns: Vec<Turn>,
}

/// A provider-neutral prompt: a system text and alternating messages that
/// start and end with the user.
#[derive(Debug, Clone, PartialEq)]
pub struct Prompt {
    pub system: String,
    pub messages: Vec<(Role, String)>,
}

/// Cut `s` to at most `cap` characters, on a character boundary, saying so.
pub fn cap_text(s: &str, cap: usize) -> String {
    match s.char_indices().nth(cap) {
        None => s.to_string(),
        Some((at, _)) => format!("{}\n…(cut to {cap} characters)", &s[..at]),
    }
}

/// The error text the Fix action may send.
///
/// `err_to_string` in pg.rs lays a database error out as a title line (with
/// `[SQLSTATE xxxxx]`), the server's message, then `Detail:`, `Hint:`,
/// `Context:`, `On:` and `Try:` lines. `Detail:` holds row values and
/// `Context:` can hold function arguments; both are dropped here. A line
/// that continues a dropped one (no recognised prefix after it) is dropped
/// with it.
pub fn sanitize_error(error: &str) -> String {
    const DROP: [&str; 4] = ["detail:", "context:", "where:", "query:"];
    const KEEP: [&str; 3] = ["hint:", "on:", "try:"];
    let mut out: Vec<&str> = Vec::new();
    let mut dropping = false;
    for (i, line) in error.lines().enumerate() {
        let lower = line.trim_start().to_ascii_lowercase();
        if DROP.iter().any(|p| lower.starts_with(p)) {
            dropping = true;
            continue;
        }
        if KEEP.iter().any(|p| lower.starts_with(p)) || i <= 1 {
            dropping = false;
        }
        if !dropping {
            out.push(line);
        }
    }
    cap_text(out.join("\n").trim(), ERROR_CAP)
}

/// One relation in the digest.
#[derive(Debug, Clone, PartialEq)]
pub struct SchemaObject {
    pub schema: String,
    pub name: String,
    pub kind: String,
    /// (name, type); empty when the columns were never loaded into the cache.
    pub columns: Vec<(String, String)>,
}

fn is_system_schema(s: &str) -> bool {
    s == "information_schema" || s.starts_with("pg_")
}

/// Read the shape of one database from the metadata cache.
///
/// Only `name`, `kind` and `dbType` are copied out of each cached payload.
pub fn read_schema(cache: &MetadataCache, key: &str) -> Vec<SchemaObject> {
    let schemas = cache.list(key, "schema", "").unwrap_or_default();
    let mut out = Vec::new();
    for s in schemas {
        let schema = s.name;
        if is_system_schema(&schema) {
            continue;
        }
        for o in cache.list(key, "object", &schema).unwrap_or_default() {
            let v: serde_json::Value = serde_json::from_str(&o.payload_json).unwrap_or_default();
            let kind = v["kind"].as_str().unwrap_or("table").to_string();
            let columns = cache
                .get(key, "columns", &schema, &o.name)
                .ok()
                .flatten()
                .and_then(|e| serde_json::from_str::<serde_json::Value>(&e.payload_json).ok())
                .and_then(|d| {
                    d["columns"].as_array().map(|cols| {
                        cols.iter()
                            .filter_map(|c| {
                                Some((
                                    c["name"].as_str()?.to_string(),
                                    c["dbType"].as_str().unwrap_or("").to_string(),
                                ))
                            })
                            .collect()
                    })
                })
                .unwrap_or_default();
            out.push(SchemaObject {
                schema: schema.clone(),
                name: o.name,
                kind,
                columns,
            });
        }
    }
    out
}

/// A compact text listing of the schema, at most `cap` characters.
///
/// Relations the SQL names come first, so the tables a question is about
/// survive the cap on a large database.
pub fn schema_digest(objects: &[SchemaObject], sql_hint: &str, cap: usize) -> String {
    let hint = sql_hint.to_ascii_lowercase();
    let mentioned = |o: &SchemaObject| hint.contains(&o.name.to_ascii_lowercase());
    let mut ordered: Vec<&SchemaObject> = objects.iter().collect();
    // Stable: mentioned first, otherwise cache order (schema, then name).
    ordered.sort_by_key(|o| !mentioned(o));
    let mut out = String::new();
    let mut omitted = 0usize;
    for o in ordered {
        let cols = o
            .columns
            .iter()
            .map(|(n, t)| {
                if t.is_empty() {
                    n.clone()
                } else {
                    format!("{n} {t}")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let line = if cols.is_empty() {
            format!("{} {}.{}\n", o.kind, o.schema, o.name)
        } else {
            format!("{} {}.{}({cols})\n", o.kind, o.schema, o.name)
        };
        if out.chars().count() + line.chars().count() > cap {
            omitted += 1;
            continue;
        }
        out.push_str(&line);
    }
    if omitted > 0 {
        out.push_str(&format!("…and {omitted} more not listed\n"));
    }
    out
}

const BASE_SYSTEM: &str = "You are the assistant inside TupleNest, a PostgreSQL client. \
You see the user's question, the SQL in their editor when it is relevant, and the names and \
types of the tables and columns in the connected database. You never see row data or results, \
and you cannot run anything. Write PostgreSQL. Put every SQL statement you suggest in its own \
```sql fenced block. Be brief and concrete. If the schema listing does not include a table you \
need, say so rather than guessing.";

fn action_instructions(action: Action) -> &'static str {
    match action {
        Action::Chat => "Answer the user's question about their query or schema.",
        Action::Explain => {
            "Explain what the query does, step by step, and what is likely to make it slow \
             on a large table (missing indexes, sequential scans, sorts, functions on indexed \
             columns). Suggest an index or a rewrite in a ```sql block only when it helps."
        }
        Action::Fix => {
            "The query failed with the error shown. Reply with the corrected statement, \
             complete, in exactly one ```sql block, then one or two sentences on what was wrong. \
             Change only what the error requires."
        }
        Action::Write => {
            "Write one SQL statement that does what the user asks, in exactly one ```sql \
             block, then one sentence on how it works. Prefer a read-only query unless the user \
             clearly asks to change data."
        }
    }
}

/// Assemble the prompt. `schema` is the digest of the live session's
/// database, or empty when not connected.
pub fn build_prompt(input: &AskInput, schema: &str) -> Prompt {
    let system = format!("{BASE_SYSTEM}\n\n{}", action_instructions(input.action));

    let mut body = String::new();
    if !schema.trim().is_empty() {
        body.push_str("<schema>\n");
        body.push_str(schema.trim_end());
        body.push_str("\n</schema>\n\n");
    }
    let uses_sql = matches!(input.action, Action::Chat | Action::Explain | Action::Fix);
    if uses_sql {
        if let Some(sql) = input.sql.as_deref().filter(|s| !s.trim().is_empty()) {
            body.push_str("<query>\n");
            body.push_str(&cap_text(sql.trim(), SQL_CAP));
            body.push_str("\n</query>\n\n");
        }
    }
    if input.action == Action::Fix {
        if let Some(err) = input.error.as_deref().filter(|s| !s.trim().is_empty()) {
            body.push_str("<error>\n");
            body.push_str(&sanitize_error(err));
            body.push_str("\n</error>\n\n");
        }
    }
    let message = input.message.trim();
    let message = if message.is_empty() {
        match input.action {
            Action::Explain => "Explain this query.",
            Action::Fix => "Fix this error.",
            _ => "",
        }
    } else {
        message
    };
    body.push_str(&cap_text(message, MESSAGE_CAP));

    // Earlier turns of this conversation: the user's own words and the
    // model's own replies, nothing else. Alternation is enforced: a run of
    // one role is joined, and the list starts with the user.
    let mut messages: Vec<(Role, String)> = Vec::new();
    let start = input.turns.len().saturating_sub(TURNS_KEPT);
    for t in &input.turns[start..] {
        let text = cap_text(t.text.trim(), TURN_CAP);
        if text.is_empty() {
            continue;
        }
        match messages.last_mut() {
            Some((role, prev)) if *role == t.role => {
                prev.push_str("\n\n");
                prev.push_str(&text);
            }
            None if t.role == Role::Assistant => {}
            _ => messages.push((t.role, text)),
        }
    }
    match messages.last_mut() {
        Some((Role::User, prev)) => {
            prev.push_str("\n\n");
            prev.push_str(&body);
        }
        _ => messages.push((Role::User, body)),
    }
    Prompt { system, messages }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(action: Action) -> AskInput {
        AskInput {
            action,
            message: "why is this slow?".into(),
            sql: Some("select * from orders where total > 10".into()),
            error: None,
            turns: vec![],
        }
    }

    fn cache_with_schema() -> MetadataCache {
        let mut c = MetadataCache::open_in_memory().unwrap();
        let key = "svc@prod.db:5432/app";
        c.replace_list(
            key,
            "schema",
            "",
            &[
                ("public".into(), "\"public\"".into()),
                ("pg_catalog".into(), "\"pg_catalog\"".into()),
            ],
        )
        .unwrap();
        c.replace_list(
            key,
            "object",
            "public",
            &[
                (
                    "orders".into(),
                    r#"{"name":"orders","kind":"table","comment":"SECRET-COMMENT"}"#.into(),
                ),
                (
                    "customers".into(),
                    r#"{"name":"customers","kind":"table","comment":null}"#.into(),
                ),
            ],
        )
        .unwrap();
        c.put(
            key,
            "columns",
            "public",
            "orders",
            r#"{"columns":[{"name":"id","dbType":"bigint","nullable":false,"primaryKey":true,
                "comment":"COLUMN-COMMENT","generated":false},
               {"name":"total","dbType":"numeric(10,2)","nullable":true,"primaryKey":false,
                "comment":null,"generated":false}],
               "indexes":[{"name":"orders_pkey","def":"CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id) WHERE secret_flag"}],
               "rowsEstimate":987654321,"totalSize":"42 GB","comment":"TABLE-COMMENT"}"#,
        )
        .unwrap();
        // Another connection's schema in the same cache.
        c.replace_list(
            "other@elsewhere:5432/hr",
            "schema",
            "",
            &[("payroll".into(), "\"payroll\"".into())],
        )
        .unwrap();
        c.replace_list(
            "other@elsewhere:5432/hr",
            "object",
            "payroll",
            &[(
                "salaries".into(),
                r#"{"name":"salaries","kind":"table"}"#.into(),
            )],
        )
        .unwrap();
        c
    }

    #[test]
    fn the_digest_holds_names_and_types_only() {
        let cache = cache_with_schema();
        let objects = read_schema(&cache, "svc@prod.db:5432/app");
        let digest = schema_digest(&objects, "", SCHEMA_CAP);
        assert!(digest.contains("table public.orders(id bigint, total numeric(10,2))"));
        assert!(digest.contains("table public.customers"));
        for leaked in [
            "SECRET-COMMENT",
            "COLUMN-COMMENT",
            "TABLE-COMMENT",
            "987654321",
            "42 GB",
            "secret_flag",
            "orders_pkey",
            "pg_catalog",
        ] {
            assert!(!digest.contains(leaked), "digest leaked {leaked}: {digest}");
        }
    }

    #[test]
    fn the_digest_never_reads_another_connection() {
        let cache = cache_with_schema();
        let digest = schema_digest(&read_schema(&cache, "svc@prod.db:5432/app"), "", SCHEMA_CAP);
        assert!(!digest.contains("payroll"));
        assert!(!digest.contains("salaries"));
        // And an unknown key reads nothing at all.
        assert!(read_schema(&cache, "nobody@nowhere:1/x").is_empty());
    }

    #[test]
    fn the_digest_is_capped_and_says_what_it_left_out() {
        let objects: Vec<SchemaObject> = (0..500)
            .map(|i| SchemaObject {
                schema: "public".into(),
                name: format!("table_number_{i}"),
                kind: "table".into(),
                columns: vec![
                    ("id".into(), "bigint".into()),
                    ("name".into(), "text".into()),
                ],
            })
            .collect();
        let digest = schema_digest(&objects, "", 2_000);
        assert!(digest.chars().count() <= 2_000 + 40);
        assert!(digest.contains("more not listed"));
    }

    #[test]
    fn tables_the_query_names_survive_the_cap() {
        let mut objects: Vec<SchemaObject> = (0..200)
            .map(|i| SchemaObject {
                schema: "public".into(),
                name: format!("filler_{i:03}"),
                kind: "table".into(),
                columns: vec![("id".into(), "bigint".into())],
            })
            .collect();
        objects.push(SchemaObject {
            schema: "public".into(),
            name: "invoices".into(),
            kind: "table".into(),
            columns: vec![("amount".into(), "numeric".into())],
        });
        let digest = schema_digest(&objects, "select amount from invoices", 300);
        assert!(digest.starts_with("table public.invoices(amount numeric)"));
    }

    #[test]
    fn detail_and_context_lines_never_leave() {
        let err = "Unique constraint violated [SQLSTATE 23505]\n\
                   duplicate key value violates unique constraint \"users_email_key\"\n\
                   Detail: Key (email)=(alice@example.com) already exists.\n\
                   Hint: use ON CONFLICT\n\
                   Context: SQL function \"f\" statement 1 with arg 'bob-secret'\n\
                   continued context line 'more-secret'\n\
                   On: table \"users\", constraint \"users_email_key\"\n\
                   Try: Check for an existing row first";
        let clean = sanitize_error(err);
        assert!(clean.contains("SQLSTATE 23505"));
        assert!(clean.contains("users_email_key"));
        assert!(clean.contains("Hint: use ON CONFLICT"));
        assert!(clean.contains("Try: Check"));
        assert!(!clean.contains("alice@example.com"));
        assert!(!clean.contains("bob-secret"));
        assert!(!clean.contains("more-secret"));
    }

    #[test]
    fn the_prompt_carries_only_the_allowed_parts() {
        let cache = cache_with_schema();
        let schema = schema_digest(&read_schema(&cache, "svc@prod.db:5432/app"), "", SCHEMA_CAP);
        let mut fix = input(Action::Fix);
        fix.error = Some(
            "Bad value [SQLSTATE 22P02]\ninvalid input\nDetail: row (42, 'carol@corp.test')".into(),
        );
        let p = build_prompt(&fix, &schema);
        let all = format!("{}{:?}", p.system, p.messages);
        assert!(all.contains("select * from orders"));
        assert!(all.contains("SQLSTATE 22P02"));
        assert!(all.contains("public.orders"));
        for leaked in ["carol@corp.test", "prod.db", "svc@", "5432", "payroll"] {
            assert!(!all.contains(leaked), "prompt leaked {leaked}");
        }
    }

    #[test]
    fn write_does_not_send_the_editor_and_only_fix_sends_the_error() {
        let mut w = input(Action::Write);
        w.error = Some("boom [SQLSTATE 42703]".into());
        let p = build_prompt(&w, "");
        let all = format!("{:?}", p.messages);
        assert!(!all.contains("select * from orders"));
        assert!(!all.contains("SQLSTATE"));

        let mut c = input(Action::Chat);
        c.error = Some("boom [SQLSTATE 42703]".into());
        let all = format!("{:?}", build_prompt(&c, "").messages);
        assert!(all.contains("select * from orders"));
        assert!(!all.contains("SQLSTATE"));
    }

    #[test]
    fn oversized_inputs_are_capped() {
        let mut big = input(Action::Explain);
        big.sql = Some("x".repeat(SQL_CAP * 3));
        big.message = "é".repeat(MESSAGE_CAP * 2);
        let p = build_prompt(&big, "");
        let text = &p.messages[0].1;
        assert!(text.chars().count() < SQL_CAP + MESSAGE_CAP + 200);
        assert!(text.contains("cut to"));
    }

    #[test]
    fn turns_alternate_and_start_with_the_user() {
        let mut c = input(Action::Chat);
        c.turns = vec![
            Turn {
                role: Role::Assistant,
                text: "orphan reply".into(),
            },
            Turn {
                role: Role::User,
                text: "first".into(),
            },
            Turn {
                role: Role::Assistant,
                text: "answer".into(),
            },
            Turn {
                role: Role::Assistant,
                text: "more answer".into(),
            },
        ];
        let p = build_prompt(&c, "");
        let roles: Vec<Role> = p.messages.iter().map(|m| m.0).collect();
        assert_eq!(roles, vec![Role::User, Role::Assistant, Role::User]);
        assert!(!format!("{:?}", p.messages).contains("orphan reply"));
        assert!(p.messages[1].1.contains("more answer"));

        // Only the last few turns are kept.
        c.turns = (0..20)
            .map(|i| Turn {
                role: if i % 2 == 0 {
                    Role::User
                } else {
                    Role::Assistant
                },
                text: format!("turn-{i}"),
            })
            .collect();
        let all = format!("{:?}", build_prompt(&c, "").messages);
        assert!(!all.contains("turn-0\""));
        assert!(all.contains("turn-19"));
    }

    #[test]
    fn a_trailing_user_turn_absorbs_the_new_message() {
        let mut c = input(Action::Chat);
        c.turns = vec![Turn {
            role: Role::User,
            text: "earlier".into(),
        }];
        let p = build_prompt(&c, "");
        assert_eq!(p.messages.len(), 1);
        assert!(p.messages[0].1.starts_with("earlier"));
    }

    #[test]
    fn empty_messages_get_a_default_for_explain_and_fix() {
        let mut e = input(Action::Explain);
        e.message = String::new();
        assert!(build_prompt(&e, "").messages[0]
            .1
            .ends_with("Explain this query."));
        let mut f = input(Action::Fix);
        f.message = "  ".into();
        assert!(build_prompt(&f, "").messages[0]
            .1
            .ends_with("Fix this error."));
    }

    #[test]
    fn cap_text_keeps_short_text_whole() {
        assert_eq!(cap_text("abc", 3), "abc");
        assert!(cap_text("abcd", 3).starts_with("abc\n"));
    }
}

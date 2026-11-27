//! The destructive-statement guard, in Rust.
//!
//! The app's guard lives in the WebView (`guardReason` in `src/lib/sql.tsx`,
//! masking in `maskLiterals` in `src/lib/complete.ts`): on a prod or staging
//! connection it stops a row-wide UPDATE/DELETE, DDL, DO/CALL/MERGE and
//! COPY … FROM and asks the user. The MCP server has no window and no user to
//! ask, so there the same rules refuse the statement instead — and they have
//! to run in Rust. This is a line-for-line port of those two functions; the
//! tests below are the TypeScript tests, case for case. Change one, change
//! both.
//!
//! Like the original it is best-effort, and errs towards stopping something
//! harmless rather than letting something destructive through. It is not a
//! parser.

/// Why a statement is stopped: the verb, and a sentence a person can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardReason {
    pub verb: String,
    pub why: String,
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// A `\w` character in a JavaScript regular expression.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Opening dollar-quote tag at `i` — `$$` or `$tag$` — or None.
fn dollar_tag_at(sql: &[char], i: usize) -> Option<Vec<char>> {
    if sql.get(i) != Some(&'$') {
        return None;
    }
    let mut j = i + 1;
    while j < sql.len() && is_word(sql[j]) {
        j += 1;
    }
    if sql.get(j) != Some(&'$') {
        return None;
    }
    // `$1$` is a parameter followed by junk: tags cannot start with a digit.
    if sql.get(i + 1).is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(sql[i..=j].to_vec())
}

fn find_seq(hay: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&k| &hay[k..k + needle.len()] == needle)
}

/// Blank out comments and string/identifier literals so keyword scanning
/// never trips over their contents. Length (in characters) is preserved, so
/// offsets stay valid. See `maskLiterals` for the cases it handles: dollar
/// quoting, nested block comments, E'' strings and doubled quotes.
pub fn mask_literals(sql: &str) -> String {
    mask_chars(&sql.chars().collect::<Vec<_>>())
        .into_iter()
        .collect()
}

fn mask_chars(sql: &[char]) -> Vec<char> {
    let mut out = sql.to_vec();
    let blank = |out: &mut Vec<char>, from: usize, to: usize| {
        for c in out.iter_mut().take(to.min(sql.len())).skip(from) {
            if *c != '\n' {
                *c = ' ';
            }
        }
    };
    let mut i = 0;
    while i < sql.len() {
        let two = (sql[i], sql.get(i + 1).copied().unwrap_or('\0'));
        if two == ('-', '-') {
            let j = (i..sql.len())
                .find(|&k| sql[k] == '\n')
                .unwrap_or(sql.len());
            blank(&mut out, i, j);
            i = j;
        } else if two == ('/', '*') {
            let mut depth = 1;
            let mut j = i + 2;
            while j < sql.len() && depth > 0 {
                let pair = (sql[j], sql.get(j + 1).copied().unwrap_or('\0'));
                if pair == ('/', '*') {
                    depth += 1;
                    j += 2;
                } else if pair == ('*', '/') {
                    depth -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            let j = j.min(sql.len());
            blank(&mut out, i, j);
            i = j;
        } else if let Some(tag) = dollar_tag_at(sql, i) {
            let close = find_seq(sql, &tag, i + tag.len());
            blank(&mut out, i + tag.len(), close.unwrap_or(sql.len()));
            i = close.map_or(sql.len(), |c| c + tag.len());
        } else if sql[i] == '\'' || sql[i] == '"' {
            let q = sql[i];
            let escaped = q == '\''
                && i > 0
                && matches!(sql[i - 1], 'E' | 'e')
                && !(i >= 2 && is_ident(sql[i - 2]));
            let mut j = i + 1;
            while j < sql.len() {
                // A backslash escape in E'…', or a doubled quote: skip both.
                let escape = escaped && sql[j] == '\\';
                let doubled = sql[j] == q && sql.get(j + 1) == Some(&q);
                if escape || doubled {
                    j += 2;
                } else if sql[j] == q {
                    j += 1;
                    break;
                } else {
                    j += 1;
                }
            }
            blank(&mut out, i + 1, j.saturating_sub(1));
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Blank the inside of SQLite's other identifier quotes, `[name]` and
/// `` `name` ``, in text `mask_chars` has already masked: `DELETE FROM
/// [where]` is an unbounded DELETE, not a bounded one. In PostgreSQL `[…]` is
/// an array subscript, and blanking one can only hide a WHERE, which errs
/// towards stopping. `maskBracketQuotes` in the WebView; change both.
fn mask_bracket_quotes(masked: &[char]) -> Vec<char> {
    let mut out = masked.to_vec();
    let mut i = 0;
    while i < out.len() {
        let close = match out[i] {
            '[' => ']',
            '`' => '`',
            _ => {
                i += 1;
                continue;
            }
        };
        let end = (i + 1..out.len())
            .find(|&k| out[k] == close)
            .unwrap_or(out.len());
        for c in out.iter_mut().take(end).skip(i + 1) {
            if *c != '\n' {
                *c = ' ';
            }
        }
        i = end + 1;
    }
    out
}

/// Position of the next whole word `word` (lowercase) in `hay` (already
/// lowercased) at or after `from`, with `\b` on both sides.
fn find_word(hay: &[char], word: &str, from: usize) -> Option<usize> {
    let w: Vec<char> = word.chars().collect();
    let mut k = from;
    while let Some(at) = find_seq(hay, &w, k) {
        let before_ok = at == 0 || !is_word(hay[at - 1]);
        let after_ok = hay.get(at + w.len()).is_none_or(|c| !is_word(*c));
        if before_ok && after_ok {
            return Some(at);
        }
        k = at + 1;
    }
    None
}

/// The first of `words` to appear as a whole word, and where.
fn first_of<'a>(hay: &[char], words: &[&'a str], from: usize) -> Option<(usize, &'a str)> {
    words
        .iter()
        .filter_map(|w| find_word(hay, w, from).map(|at| (at, *w)))
        .min_by_key(|(at, _)| *at)
}

fn lower(chars: &[char]) -> Vec<char> {
    chars.iter().map(|c| c.to_ascii_lowercase()).collect()
}

/// First real keyword of a statement, skipping comments and whitespace.
fn first_keyword(masked_lower: &[char]) -> Option<String> {
    let start = masked_lower
        .iter()
        .position(|c| c.is_ascii_alphabetic() || *c == '_')?;
    Some(
        masked_lower[start..]
            .iter()
            .take_while(|c| is_word(**c))
            .collect(),
    )
}

const DDL_VERBS: [&str; 9] = [
    "drop", "truncate", "alter", "create", "grant", "revoke", "reindex", "vacuum", "cluster",
];

/// Why this statement would be stopped on a guarded (prod or staging)
/// connection, or None. `guardReason(sql, "prod")` in the WebView.
pub fn guard_reason(sql: &str) -> Option<GuardReason> {
    reason_of(&sql.chars().collect::<Vec<_>>())
}

fn reason_of(sql: &[char]) -> Option<GuardReason> {
    let masked = lower(&mask_bracket_quotes(&mask_chars(sql)));
    let verb = first_keyword(&masked)?;

    // EXPLAIN ANALYZE runs what it explains: judge the statement inside it.
    if verb == "explain" {
        let (options, head_end) = explain_head(&masked)?;
        if !analyzes(&options) {
            return None;
        }
        let inner = reason_of(&sql[head_end..])?;
        return Some(GuardReason {
            verb: inner.verb,
            why: format!("EXPLAIN ANALYZE runs the statement. {}", inner.why),
        });
    }

    // A CTE can front a DELETE: look for the real verb after `with`.
    let effective = if verb == "with" {
        first_of(&masked, &["insert", "update", "delete", "merge"], 0)
            .map_or(verb.clone(), |(_, w)| w.to_string())
    } else {
        verb.clone()
    };

    if DDL_VERBS.contains(&effective.as_str()) {
        return Some(GuardReason {
            verb: effective.to_ascii_uppercase(),
            why: "This changes or removes database objects, not just rows.".into(),
        });
    }
    if matches!(effective.as_str(), "do" | "call" | "merge") {
        return Some(GuardReason {
            verb: effective.to_ascii_uppercase(),
            why: "What this changes cannot be seen from the statement itself.".into(),
        });
    }
    // Top level only: `COPY (SELECT … FROM t) TO STDOUT` reads.
    if effective == "copy" {
        let flat = strip_innermost_parens(&strip_innermost_parens(&masked));
        if find_word(&flat, "from", 0).is_some() {
            return Some(GuardReason {
                verb: "COPY".into(),
                why: "COPY … FROM writes rows straight into the table.".into(),
            });
        }
    }
    unbounded_dml(&masked).map(|(verb, trivial)| GuardReason {
        verb: verb.to_ascii_uppercase(),
        why: if trivial {
            "Its WHERE clause is always true, so it affects every row in the table.".into()
        } else {
            "It has no WHERE clause, so it affects every row in the table.".into()
        },
    })
}

/// `EXPLAIN (opts)` or `EXPLAIN ANALYZE VERBOSE …`: the option text and where
/// the explained statement starts. `masked` is lowercased.
fn explain_head(masked: &[char]) -> Option<(Vec<char>, usize)> {
    let mut i = masked.iter().position(|c| !c.is_whitespace())?;
    if masked.get(i..i + 7)? != ['e', 'x', 'p', 'l', 'a', 'i', 'n'] {
        return None;
    }
    i += 7;
    while masked.get(i).is_some_and(|c| c.is_whitespace()) {
        i += 1;
    }
    if masked.get(i) == Some(&'(') {
        if let Some(close) = (i + 1..masked.len()).find(|&k| masked[k] == ')') {
            return Some((masked[i + 1..close].to_vec(), close + 1));
        }
    }
    // Bare words: `ANALYZE`, `ANALYSE`, `VERBOSE`, as many as there are.
    let start = i;
    let mut end = i;
    loop {
        let mut k = end;
        while masked.get(k).is_some_and(|c| c.is_whitespace()) {
            k += 1;
        }
        let word: String = masked[k.min(masked.len())..]
            .iter()
            .take_while(|c| is_word(**c))
            .collect();
        if matches!(word.as_str(), "analyze" | "analyse" | "verbose") {
            end = k + word.len();
        } else {
            break;
        }
    }
    Some((masked[start..end].to_vec(), end))
}

/// `\banaly[sz]e\b(?!\s*(?:false|off|0)\b)` over the option text.
fn analyzes(options: &[char]) -> bool {
    for word in ["analyze", "analyse"] {
        let mut from = 0;
        while let Some(at) = find_word(options, word, from) {
            let mut k = at + word.len();
            while options.get(k).is_some_and(|c| c.is_whitespace()) {
                k += 1;
            }
            let next: String = options[k..].iter().take_while(|c| is_word(**c)).collect();
            if !matches!(next.as_str(), "false" | "off" | "0") {
                return true;
            }
            from = at + 1;
        }
    }
    false
}

/// One pass of `replace(/\([^()]*\)/g, " ")`.
fn strip_innermost_parens(text: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i] == '(' {
            if let Some(len) = text[i + 1..].iter().position(|c| *c == '(' || *c == ')') {
                if text[i + 1 + len] == ')' {
                    out.push(' ');
                    i += len + 2;
                    continue;
                }
            }
        }
        out.push(text[i]);
        i += 1;
    }
    out
}

/// The first UPDATE or DELETE that reaches every row — no WHERE of its own,
/// or a plainly always-true one — and whether it was the always-true kind.
/// `masked` is lowercased. Mirrors `unboundedDml`.
fn unbounded_dml(masked: &[char]) -> Option<(String, bool)> {
    let mut from = 0;
    while let Some((at, verb)) = first_of(masked, &["update", "delete"], from) {
        from = at + 1;
        let before: String = masked[..at].iter().collect();
        let before = before.trim_end();
        let tail: String = before
            .chars()
            .rev()
            .take_while(|c| is_word(*c))
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if matches!(tail.as_str(), "do" | "for" | "key") {
            continue;
        }
        let mut depth = 0usize;
        let mut own: Vec<char> = Vec::new();
        let mut pos: Vec<usize> = Vec::new();
        let mut end = masked.len();
        for (i, &c) in masked.iter().enumerate().skip(at) {
            if c == '(' {
                depth += 1;
            } else if c == ')' {
                if depth == 0 {
                    end = i;
                    break;
                }
                depth -= 1;
            } else if c == ';' && depth == 0 {
                end = i;
                break;
            }
            if depth == 0 {
                own.push(c);
                pos.push(i);
            }
        }
        let Some(w) = find_word(&own, "where", 0) else {
            return Some((verb.to_string(), false));
        };
        if always_true(&masked[pos[w] + 5..end]) {
            return Some((verb.to_string(), true));
        }
    }
    None
}

/// Is this WHERE condition (masked, lowercased) one of the plainly-always-true
/// ones? Mirrors `alwaysTrue`.
fn always_true(condition: &[char]) -> bool {
    let whole = match find_word(condition, "returning", 0) {
        Some(at) => &condition[..at],
        None => condition,
    };
    let mut parts: Vec<&[char]> = Vec::new();
    let mut start = 0;
    let mut from = 0;
    while let Some(at) = find_word(whole, "or", from) {
        parts.push(&whole[start..at]);
        start = at + 2;
        from = at + 2;
    }
    parts.push(&whole[start..]);
    parts.iter().any(|part| {
        let mut c: String = part.iter().collect::<String>().trim().to_string();
        while c.starts_with('(') && c.ends_with(')') && c.len() >= 2 {
            c = c[1..c.len() - 1].trim().to_string();
        }
        let c: String = c.chars().filter(|ch| !ch.is_whitespace()).collect();
        c == "true" || c == "notfalse" || c == "1" || same_number(&c) || empty_strings_equal(&c)
    })
}

/// `^(\d+)=\1$`
fn same_number(c: &str) -> bool {
    c.split_once('=')
        .is_some_and(|(a, b)| !a.is_empty() && a.chars().all(|ch| ch.is_ascii_digit()) && a == b)
}

/// `^('')?=('')?$` — two literals compared, their contents masked away.
fn empty_strings_equal(c: &str) -> bool {
    c.split_once('=')
        .is_some_and(|(a, b)| matches!(a, "" | "''") && matches!(b, "" | "''"))
}

#[cfg(test)]
mod tests {
    //! The cases of `sql.test.tsx` (`needsGuard`, `guardReason`,
    //! `dmlWithoutWhere`) and `complete.test.ts` (`maskLiterals`), with the
    //! environment fixed at prod: the MCP server applies the guard to every
    //! read-and-write connection.
    use super::*;

    fn guarded(sql: &str) -> bool {
        guard_reason(sql).is_some()
    }
    fn why(sql: &str) -> String {
        guard_reason(sql).map(|r| r.why).unwrap_or_default()
    }

    #[test]
    fn sqlite_identifier_quotes_never_look_like_a_where() {
        assert!(guarded("DELETE FROM [where]"));
        assert!(guarded("DELETE FROM `where`"));
        assert!(guarded("UPDATE [t] SET [where] = 1"));
        assert!(!guarded("DELETE FROM [orders] WHERE [id] = 1"));
        assert!(!guarded("UPDATE `t` SET x = 1 WHERE `id` = 2"));
        // SQLite spellings of the statements the guard stops.
        assert!(guarded("DROP TABLE IF EXISTS logs"));
        assert!(guarded("ALTER TABLE t DROP COLUMN x"));
        assert!(guarded("VACUUM"));
        assert!(guarded("UPDATE OR REPLACE t SET x = 1"));
        assert!(guarded("DELETE FROM main.t"));
        assert!(!guarded("INSERT OR REPLACE INTO t VALUES (1)"));
        // A PostgreSQL subscript is still read.
        assert!(!guarded("UPDATE t SET a[1] = 0 WHERE id = 1"));
    }

    #[test]
    fn a_where_in_a_cte_does_not_bound_the_delete_after_it() {
        assert!(guarded(
            "WITH d AS (DELETE FROM a WHERE false) DELETE FROM users"
        ));
        assert!(guarded("WITH d AS (DELETE FROM a) SELECT 1"));
    }

    #[test]
    fn a_where_inside_a_subquery_does_not_bound_the_outer_statement() {
        assert!(guarded("DELETE FROM t USING (SELECT id FROM x WHERE y) s"));
        assert!(guarded("UPDATE t SET a = (SELECT b FROM c WHERE d)"));
    }

    #[test]
    fn still_lets_a_bounded_statement_through() {
        assert!(!guarded(
            "DELETE FROM t WHERE id IN (SELECT id FROM x WHERE y)"
        ));
        assert!(!guarded(
            "WITH d AS (DELETE FROM a WHERE id = 1) DELETE FROM b WHERE id = 2"
        ));
    }

    #[test]
    fn stops_statements_whose_effect_is_not_in_the_text() {
        for sql in [
            "DO $$ BEGIN DELETE FROM t; END $$",
            "CALL purge()",
            "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE",
            "COPY t FROM '/tmp/x.csv'",
        ] {
            assert!(guarded(sql), "{sql}");
        }
    }

    #[test]
    fn does_not_cry_wolf_on_upserts_row_locks_and_copy_to() {
        for sql in [
            "INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 1",
            "SELECT * FROM t WHERE id = 1 FOR UPDATE",
            "SELECT * FROM t WHERE id = 1 FOR NO KEY UPDATE",
            "COPY (SELECT * FROM t) TO STDOUT",
            "COPY t TO STDOUT",
        ] {
            assert!(!guarded(sql), "{sql}");
        }
    }

    #[test]
    fn an_always_true_where_is_not_a_where() {
        for sql in [
            "DELETE FROM users WHERE true",
            "delete from users where TRUE;",
            "UPDATE users SET active = false WHERE 1=1",
            "UPDATE users SET active = false WHERE 1 = 1",
            "DELETE FROM users WHERE (1=1)",
            "DELETE FROM users WHERE ((true))",
            "DELETE FROM users WHERE 'a' = 'a'",
            "DELETE FROM users WHERE NOT false",
            "DELETE FROM users WHERE 1",
            "DELETE FROM users WHERE id = 5 OR 1=1",
            "DELETE FROM users WHERE true OR id = 5",
            "DELETE FROM users WHERE 1=1 RETURNING id",
            "WITH gone AS (DELETE FROM users WHERE true RETURNING id) SELECT count(*) FROM gone",
            "DELETE FROM users WHERE 42 = 42 -- just this once",
        ] {
            assert!(why(sql).contains("always true"), "{sql}: {:?}", why(sql));
        }
    }

    #[test]
    fn a_real_where_is_left_alone() {
        for sql in [
            "DELETE FROM users WHERE id = 5",
            "DELETE FROM users WHERE (id = 5)",
            "DELETE FROM users WHERE active = true",
            "DELETE FROM users WHERE true AND id = 5",
            "DELETE FROM users WHERE 1=1 AND id = 5",
            "DELETE FROM users WHERE 1 = 2",
            "DELETE FROM users WHERE name = 'true'",
            "DELETE FROM users WHERE name = 'x' OR name = 'y'",
            "DELETE FROM users WHERE id IN (SELECT id FROM old WHERE true)",
            "UPDATE users SET note = 'where 1=1' WHERE id = 7",
            "DELETE FROM users WHERE flag",
            "DELETE FROM users WHERE id = 11",
        ] {
            assert_eq!(guard_reason(sql), None, "{sql}");
        }
    }

    #[test]
    fn says_there_is_no_where_when_there_is_none() {
        assert!(why("DELETE FROM users").contains("no WHERE clause"));
        assert_eq!(
            unbounded_dml(&lower(&mask_chars(
                &"delete from users".chars().collect::<Vec<_>>()
            ))),
            Some(("delete".into(), false))
        );
    }

    #[test]
    fn explain_analyze_runs_the_statement() {
        for sql in [
            "EXPLAIN ANALYZE DELETE FROM users",
            "explain analyze delete from users",
            "EXPLAIN (ANALYZE) DELETE FROM users",
            "EXPLAIN (ANALYZE, BUFFERS) UPDATE users SET a = 1",
            "EXPLAIN (BUFFERS, ANALYZE true, FORMAT JSON) DELETE FROM users WHERE true",
            "EXPLAIN ANALYZE VERBOSE DROP TABLE users",
            "EXPLAIN ANALYSE DELETE FROM users",
            "/* plan */ EXPLAIN ANALYZE TRUNCATE users",
            "EXPLAIN ANALYZE WITH gone AS (DELETE FROM users RETURNING id) SELECT * FROM gone",
        ] {
            assert!(
                why(sql).starts_with("EXPLAIN ANALYZE runs the statement."),
                "{sql}: {:?}",
                why(sql)
            );
        }
        assert_eq!(
            guard_reason("EXPLAIN ANALYZE DELETE FROM users")
                .unwrap()
                .verb,
            "DELETE"
        );
        assert_eq!(
            guard_reason("EXPLAIN (ANALYZE) DROP TABLE users")
                .unwrap()
                .verb,
            "DROP"
        );
    }

    #[test]
    fn a_plain_explain_is_left_alone() {
        for sql in [
            "EXPLAIN DELETE FROM users",
            "EXPLAIN (BUFFERS false) DELETE FROM users",
            "EXPLAIN (ANALYZE false) DELETE FROM users",
            "EXPLAIN (ANALYZE off, VERBOSE) DELETE FROM users",
            "EXPLAIN VERBOSE DROP TABLE users",
            "EXPLAIN ANALYZE SELECT * FROM users",
            "EXPLAIN ANALYZE DELETE FROM users WHERE id = 1",
            "EXPLAIN (ANALYZE) UPDATE users SET a = 1 WHERE id = 1",
            "EXPLAIN SELECT 'analyze delete from users'",
        ] {
            assert_eq!(guard_reason(sql), None, "{sql}");
        }
    }

    #[test]
    fn needs_guard_basics() {
        assert!(guarded("update t set a=1"));
        assert!(guarded("delete from t"));
        assert!(!guarded("update t set a=1 where id=2"));
        assert!(guarded("   DELETE FROM t"));
        assert!(!guarded("select * from t"));
        assert!(!guarded(""));
        assert!(!guarded("-- only a comment"));
    }

    #[test]
    fn adversarial_corpus_each_of_these_once_slipped_through() {
        for sql in [
            "DELETE FROM users -- where",
            "DELETE FROM users /* where */",
            "UPDATE t SET a='where'",
            "UPDATE t SET a=$$where$$",
            "UPDATE t SET a=$x$where$x$",
            "-- audit\nDELETE FROM users",
            "/*x*/DELETE FROM users",
            "WITH x AS (SELECT 1) DELETE FROM users",
            "WITH x AS (SELECT 1) UPDATE users SET a=1",
            "TRUNCATE users",
            "DROP TABLE users",
            "ALTER TABLE users DROP COLUMN a",
            "GRANT ALL ON users TO public",
        ] {
            assert!(guarded(sql), "{sql}");
        }
        for sql in [
            "UPDATE t SET a=1 -- note\nWHERE id=1",
            "UPDATE t SET a='where' WHERE id=1",
            "DELETE FROM t /* note */ WHERE id=1",
            "SELECT * FROM t",
            "INSERT INTO t VALUES (1)",
            "WITH x AS (SELECT 1) SELECT * FROM x",
        ] {
            assert!(!guarded(sql), "{sql}");
        }
    }

    #[test]
    fn explains_itself() {
        let r = guard_reason("delete from t").unwrap();
        assert_eq!(r.verb, "DELETE");
        assert!(r.why.contains("every row"));
        let r = guard_reason("drop table t").unwrap();
        assert_eq!(r.verb, "DROP");
        assert!(r.why.contains("database objects"));
        assert_eq!(guard_reason("select 1"), None);
    }

    #[test]
    fn masking_keeps_length_and_blanks_what_is_not_code() {
        let sp = |n: usize| " ".repeat(n);
        let cases = [
            ("select 'a;b' from t", format!("select '{}' from t", sp(3))),
            ("select $$x;y$$", format!("select $${}$$", sp(3))),
            ("select $t$ 'q $t$", format!("select $t${}$t$", sp(4))),
            ("/* a /* b */ c */x", format!("{}x", sp(17))),
            ("e'it\\'s' x", format!("e'{}' x", sp(5))),
            ("'it''s' x", format!("'{}' x", sp(5))),
            ("\"Col\" -- c\ny", format!("\"{}\"{}\ny", sp(3), sp(5))),
            ("select $1, $2", "select $1, $2".to_string()),
            // As in TypeScript: an unterminated literal keeps its last char.
            ("'unterminated", format!("'{}d", sp(11))),
            ("/* open", sp(7)),
        ];
        for (sql, want) in cases {
            let got = mask_literals(sql);
            assert_eq!(got, want, "{sql:?}");
            assert_eq!(got.chars().count(), sql.chars().count());
        }
        // Non-ASCII text keeps its character count too.
        assert_eq!(mask_literals("'héllo' é").chars().count(), 9);
    }
}

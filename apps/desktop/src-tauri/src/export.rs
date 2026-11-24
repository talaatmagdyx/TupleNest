//! Result export formats: CSV, JSON and Markdown.
//!
//! The one copy of these rules. They used to live in the WebView, which
//! meant every exported row crossed the bridge as JSON, became JS objects and
//! was formatted there; now the backend formats straight from the stored
//! rows and writes into the file the user chose. The rules include the
//! spreadsheet formula neutralization from the security review (FILE-01),
//! which is exactly the kind of thing that must not exist in two copies.
//!
//! Output is byte-for-byte what the WebView produced: numbers are written the
//! way JavaScript writes them (`1`, not `1.0`), and JSON is laid out as
//! `JSON.stringify(row, null, 2)` was.
//!
//! Every row carries its *leading* separator, so pages concatenate without
//! remembering how the previous one ended; only `first` changes it.

use serde_json::Value;

#[derive(serde::Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Csv,
    Json,
    Md,
}

/// CSV safety: neutralize spreadsheet formulas, or keep the exact bytes.
#[derive(serde::Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    SpreadsheetSafe,
    Raw,
}

/// Everything before the first row: a header line, or an opening bracket.
pub fn prefix(kind: Kind, names: &[String], mode: Mode) -> String {
    match kind {
        Kind::Csv => names
            .iter()
            .map(|n| csv_field(n, mode))
            .collect::<Vec<_>>()
            .join(","),
        Kind::Json => "[".into(),
        // md_cell on the header too: PostgreSQL allows `SELECT 1 AS "a|b"`.
        Kind::Md => format!(
            "| {} |\n| {} |",
            names
                .iter()
                .map(|n| md_cell(n))
                .collect::<Vec<_>>()
                .join(" | "),
            names.iter().map(|_| "---").collect::<Vec<_>>().join(" | ")
        ),
    }
}

/// Append rows to `out`. `first` says whether these open the document.
pub fn rows<'a>(
    out: &mut String,
    kind: Kind,
    names: &[String],
    rows: impl IntoIterator<Item = &'a [Value]>,
    first: bool,
    mode: Mode,
) {
    // A join can return two columns named `id`; as object keys the second
    // silently replaced the first. Repeats get `_2`, `_3`, like CSV import.
    let keys = if kind == Kind::Json {
        unique_keys(names)
    } else {
        Vec::new()
    };
    for (i, row) in rows.into_iter().enumerate() {
        match kind {
            Kind::Csv => {
                out.push('\n');
                for (j, v) in row.iter().enumerate() {
                    if j > 0 {
                        out.push(',');
                    }
                    out.push_str(&csv_field(&cell_export(v), mode));
                }
            }
            Kind::Md => {
                out.push_str("\n| ");
                let cells: Vec<String> = row.iter().map(|v| md_cell(&cell_export(v))).collect();
                out.push_str(&cells.join(" | "));
                out.push_str(" |");
            }
            Kind::Json => {
                out.push_str(if first && i == 0 { "\n  " } else { ",\n  " });
                // `JSON.stringify(obj, null, 2)`, re-indented one level.
                out.push('{');
                for (j, k) in keys.iter().enumerate() {
                    out.push_str(if j == 0 { "\n    " } else { ",\n    " });
                    out.push_str(&serde_json::to_string(k).expect("a string serializes"));
                    out.push_str(": ");
                    js_json(out, row.get(j).unwrap_or(&Value::Null), Some(4));
                }
                out.push_str(if keys.is_empty() { "}" } else { "\n  }" });
            }
        }
    }
}

/// Everything after the last row. `wrote_any` tells `[]` from `[…]`.
pub fn suffix(kind: Kind, wrote_any: bool) -> &'static str {
    match (kind, wrote_any) {
        (Kind::Json, true) => "\n]",
        (Kind::Json, false) => "]",
        _ => "",
    }
}

/// Column names made unique as object keys: `id`, `id_2`, …
pub fn unique_keys(names: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    names
        .iter()
        .map(|n| {
            let mut k = n.clone();
            let mut i = 2;
            while seen.contains(&k) {
                k = format!("{n}_{i}");
                i += 1;
            }
            seen.insert(k.clone());
            k
        })
        .collect()
}

/// A cell as it is written to a file: NULL is an empty field, the convention
/// every spreadsheet expects; json is its compact text, as on screen.
pub fn cell_export(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => {
            let mut out = String::new();
            js_json(&mut out, other, None);
            out
        }
    }
}

/// RFC-4180 field, formula-neutralized first when asked.
///
/// Order matters: neutralize FIRST, then quote. Quoting first leaves the
/// leading `'` inside the quotes where a spreadsheet still sees `="..."`.
/// The quote trigger includes `\r`, so a CR-bearing value is always wrapped.
pub fn csv_field(raw: &str, mode: Mode) -> String {
    let s = match mode {
        Mode::SpreadsheetSafe => neutralize_formula(raw),
        Mode::Raw => raw.to_owned(),
    };
    if s.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

/// A value made safe against spreadsheet formula injection (CSV injection).
///
/// Excel, Sheets and LibreOffice treat a cell starting with `= + - @` (or a
/// TAB / CR) as a formula, and RFC-4180 quoting does not stop that. Row data
/// in a database client is often attacker-influenced, so the value gets
/// OWASP's single-quote prefix — except a plain number: `-5` is a number, and
/// prefixing it made every negative value text in Excel.
pub fn neutralize_formula(value: &str) -> String {
    if is_plain_number(value) {
        return value.to_owned();
    }
    match value.chars().next() {
        Some('=' | '+' | '-' | '@' | '\t' | '\r') => format!("'{value}"),
        _ => value.to_owned(),
    }
}

/// `^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$`
fn is_plain_number(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start
    };
    if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
        i += 1;
    }
    let int = digits(&mut i);
    let frac = if i < b.len() && b[i] == b'.' {
        i += 1;
        digits(&mut i)
    } else {
        0
    };
    if int == 0 && frac == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

/// A value made safe to sit inside one Markdown table cell: backslash first
/// (escaping `|` with an unescaped `\` is not escaping), then `|`, then
/// newlines, which no escape can save — `<br>` keeps them readable.
pub fn md_cell(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace('\r', "")
        .replace('\n', "<br>")
}

/// A number as JavaScript's `String(n)` writes it: `1` not `1.0`, and an
/// exponent past 1e21 or below 1e-6.
pub fn js_number(n: &serde_json::Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f == 0.0 {
        return "0".into();
    }
    let a = f.abs();
    if (1e-6..1e21).contains(&a) {
        return format!("{f}");
    }
    let e = format!("{f:e}");
    match e.split_once('e') {
        Some((m, x)) if !x.starts_with('-') => format!("{m}e+{x}"),
        _ => e,
    }
}

/// `JSON.stringify(v)` (compact) or `JSON.stringify(v, null, 2)` at an
/// indent of `pretty` spaces. Object keys are in the order they arrive.
pub fn js_json(out: &mut String, v: &Value, pretty: Option<usize>) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n)),
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("a string serializes")),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if let Some(d) = pretty {
                    out.push('\n');
                    out.push_str(&" ".repeat(d + 2));
                }
                js_json(out, item, pretty.map(|d| d + 2));
            }
            if let Some(d) = pretty {
                out.push('\n');
                out.push_str(&" ".repeat(d));
            }
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if let Some(d) = pretty {
                    out.push('\n');
                    out.push_str(&" ".repeat(d + 2));
                }
                out.push_str(&serde_json::to_string(k).expect("a string serializes"));
                out.push_str(if pretty.is_some() { ": " } else { ":" });
                js_json(out, item, pretty.map(|d| d + 2));
            }
            if let Some(d) = pretty {
                out.push('\n');
                out.push_str(&" ".repeat(d));
            }
            out.push('}');
        }
    }
}

/// The whole document at once: what the pages must add up to.
#[cfg(test)]
pub fn document(kind: Kind, names: &[String], all: &[Vec<Value>], mode: Mode) -> String {
    let mut out = prefix(kind, names, mode);
    rows(
        &mut out,
        kind,
        names,
        all.iter().map(Vec::as_slice),
        true,
        mode,
    );
    out.push_str(suffix(kind, !all.is_empty()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use Kind::*;
    use Mode::*;

    fn names(ns: &[&str]) -> Vec<String> {
        ns.iter().map(|s| s.to_string()).collect()
    }
    fn rs(v: Value) -> Vec<Vec<Value>> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_array().unwrap().clone())
            .collect()
    }
    fn csv(ns: &[&str], r: Value) -> String {
        document(Csv, &names(ns), &rs(r), SpreadsheetSafe)
    }
    fn line2(s: &str) -> &str {
        s.split('\n').nth(1).unwrap()
    }

    #[test]
    fn csv_header_rows_and_quoting() {
        assert_eq!(csv(&["id", "name"], json!([[1, "a"]])), "id,name\n1,a");
        assert!(csv(&["a"], json!([["x,y"]])).contains("\"x,y\""));
        assert!(csv(&["a"], json!([["say \"hi\""]])).contains("\"say \"\"hi\"\"\""));
        assert!(csv(&["a"], json!([["l1\nl2"]])).contains("\"l1\nl2\""));
        assert_eq!(csv(&["a,b"], json!([])), "\"a,b\"");
        assert_eq!(csv(&["id", "name"], json!([[null, null]])), "id,name\n,");
        assert_eq!(csv(&["j"], json!([[{"a": 1}]])), "j\n\"{\"\"a\"\":1}\"");
    }

    #[test]
    fn csv_neutralizes_every_formula_lead() {
        for p in [
            "=HYPERLINK(\"http://evil\",\"x\")",
            "=cmd|'/c calc'!A1",
            "+SUM(1)",
            "-2+3",
            "@SUM(A1)",
            "\ttabbed",
            "\rcarriage",
        ] {
            let out = csv(&["c"], json!([[p]]));
            let cell = &out["c\n".len()..];
            assert!(
                cell.starts_with('\'') || cell.starts_with("\"'"),
                "{p:?} → {cell:?}"
            );
        }
        assert_eq!(csv(&["=danger"], json!([])), "'=danger");
        assert_eq!(line2(&csv(&["c"], json!([["hello"]]))), "hello");
        assert_eq!(line2(&csv(&["c"], json!([[-5]]))), "-5");
        assert_eq!(line2(&csv(&["c"], json!([["-2+3"]]))), "'-2+3");
        assert_eq!(line2(&csv(&["c"], json!([["=A1,B1"]]))), "\"'=A1,B1\"");
        let raw = document(Csv, &names(&["c"]), &rs(json!([["=BAD()"]])), Raw);
        assert_eq!(line2(&raw), "=BAD()");
    }

    #[test]
    fn plain_numbers_are_not_formulas() {
        for n in ["-5", "-2.5e3", "+1", ".5", "5.", "1E-7"] {
            assert_eq!(neutralize_formula(n), n);
        }
        for f in ["-", "-e5", "-.", "-1e", "-1x", "=1"] {
            assert!(neutralize_formula(f).starts_with('\''), "{f}");
        }
    }

    #[test]
    fn json_maps_columns_onto_unique_keys() {
        let out = document(
            Json,
            &names(&["id", "name"]),
            &rs(json!([[1, "a"]])),
            SpreadsheetSafe,
        );
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed, json!([{"id": 1, "name": "a"}]));
        let short = document(
            Json,
            &names(&["id", "name"]),
            &rs(json!([[1]])),
            SpreadsheetSafe,
        );
        assert_eq!(
            serde_json::from_str::<Value>(&short).unwrap(),
            json!([{"id": 1, "name": null}])
        );
        assert_eq!(document(Json, &names(&["id"]), &[], SpreadsheetSafe), "[]");
        let dup = document(
            Json,
            &names(&["id", "id"]),
            &rs(json!([[1, 2]])),
            SpreadsheetSafe,
        );
        assert_eq!(
            serde_json::from_str::<Value>(&dup).unwrap(),
            json!([{"id": 1, "id_2": 2}])
        );
        assert_eq!(
            unique_keys(&names(&["a", "a", "a_2", "a"])),
            names(&["a", "a_2", "a_2_2", "a_3"])
        );
    }

    #[test]
    fn json_is_laid_out_as_json_stringify_with_two_spaces() {
        // What `JSON.stringify(row, null, 2).replace(/\n/g, "\n  ")` gave.
        let out = document(
            Json,
            &names(&["id", "doc"]),
            &rs(json!([[1.0, {"b": [1, {}], "a": []}]])),
            SpreadsheetSafe,
        );
        assert_eq!(
            out,
            "[\n  {\n    \"id\": 1,\n    \"doc\": {\n      \"a\": [],\n      \"b\": [\n        1,\n        {}\n      ]\n    }\n  }\n]"
        );
    }

    #[test]
    fn markdown_header_escaping() {
        assert_eq!(
            document(
                Md,
                &names(&["id", "name"]),
                &rs(json!([[1, "a"]])),
                SpreadsheetSafe
            ),
            "| id | name |\n| --- | --- |\n| 1 | a |"
        );
        assert!(
            document(Md, &names(&["a"]), &rs(json!([["x|y"]])), SpreadsheetSafe).contains("x\\|y")
        );
        assert_eq!(md_cell("a\\|b\r\nc"), "a\\\\\\|b<br>c");
    }

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        let n = |v: Value| js_number(v.as_number().unwrap());
        assert_eq!(n(json!(1.0)), "1");
        assert_eq!(n(json!(2.5)), "2.5");
        assert_eq!(n(json!(-0.0)), "0");
        assert_eq!(n(json!(0.1)), "0.1");
        assert_eq!(n(json!(1e21)), "1e+21");
        assert_eq!(n(json!(1e20)), "100000000000000000000");
        assert_eq!(n(json!(1.5e-7)), "1.5e-7");
        assert_eq!(n(json!(0.000001)), "0.000001");
        assert_eq!(n(json!(9007199254740991_i64)), "9007199254740991");
    }

    #[test]
    fn pages_concatenate_to_the_same_document() {
        let ns = names(&["id", "name"]);
        let all = rs(json!([[1, "ada"], [2, "a \"quoted\", comma"], [3, null]]));
        for kind in [Csv, Json, Md] {
            let whole = document(kind, &ns, &all, SpreadsheetSafe);
            for size in [1, 2, 99] {
                let mut out = prefix(kind, &ns, SpreadsheetSafe);
                for (k, chunk) in all.chunks(size).enumerate() {
                    rows(
                        &mut out,
                        kind,
                        &ns,
                        chunk.iter().map(Vec::as_slice),
                        k == 0,
                        SpreadsheetSafe,
                    );
                }
                out.push_str(suffix(kind, true));
                assert_eq!(out, whole, "{kind:?} in pages of {size}");
            }
        }
        assert_eq!(document(Csv, &ns, &[], SpreadsheetSafe), "id,name");
    }
}

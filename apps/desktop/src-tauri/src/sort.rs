//! Sorting the stored result, so the grid never has to hold it.
//!
//! Sorting used to pull every row (up to the row cap) into the WebView and sort
//! there: the whole result twice over, once here and once as JS objects. Now
//! the grid asks for a sorted page and this computes an order of row indexes
//! (4 bytes a row) that `pg_rows` reads through. The rules are the grid's old
//! ones: NULLs last in both directions, numeric columns compared exactly, the
//! rest as text.

use std::cmp::Ordering;

use serde_json::Value;

/// Whole type names only, as the grid's `isNumericType`: `interval` and
/// `int4range` are not numbers.
pub fn is_numeric_type(db_type: &str) -> bool {
    let t = db_type.trim().to_ascii_lowercase();
    let base = t.split('(').next().unwrap_or("").trim_end();
    matches!(
        base,
        "int2"
            | "int4"
            | "int8"
            | "smallint"
            | "integer"
            | "bigint"
            | "numeric"
            | "decimal"
            | "float4"
            | "float8"
            | "real"
            | "double precision"
            | "money"
            | "oid"
    )
}

/// One cell, prepared once so the sort compares without allocating.
pub enum Key {
    Null,
    Number(f64),
    /// Exact text: `numeric` always arrives as a string, int8 past 2^53 too.
    /// `sort` is its Unicode collation key, see [`collation_key`].
    /// Both boxed at their exact length: a key is 40 bytes, not 48, and
    /// carries no spare capacity. `sort` is empty for a numeric column, which
    /// never compares by collation.
    Text {
        sort: Box<[u8]>,
        raw: Box<str>,
    },
}

/// The string's sort key under the Unicode Collation Algorithm (root
/// locale, tertiary strength): what the WebView's `localeCompare` uses.
/// Letters order by base letter first, then accent, then case, in every
/// script ICU covers. Computed once per cell, so the sort itself compares
/// bytes; calling the collator for every comparison was several times slower.
fn collation_key(s: &str) -> Box<[u8]> {
    use icu_collator::{options::CollatorOptions, Collator, CollatorBorrowed};
    static COLLATOR: std::sync::OnceLock<CollatorBorrowed<'static>> = std::sync::OnceLock::new();
    let collator = COLLATOR.get_or_init(|| {
        Collator::try_new(Default::default(), CollatorOptions::default())
            .expect("the root collation is compiled in")
    });
    // Written into one reused buffer and copied out at its exact length: a
    // Vec sized by guess kept its spare capacity for the whole sort.
    thread_local! {
        static SCRATCH: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    SCRATCH.with(|scratch| {
        let mut key = scratch.borrow_mut();
        key.clear();
        let Ok(()) = collator.write_sort_key_to(s, &mut *key);
        let out: Box<[u8]> = key.as_slice().into();
        // One huge cell must not pin its buffer to the thread for good.
        if key.capacity() > 64 * 1024 {
            *key = Vec::new();
        }
        out
    })
}

fn text_key(raw: String, numeric: bool) -> Key {
    Key::Text {
        // A numeric column compares its text as a decimal; the collation key
        // would be computed and held for nothing.
        sort: if numeric {
            Box::default()
        } else {
            collation_key(&raw)
        },
        raw: raw.into_boxed_str(),
    }
}

impl Key {
    /// The key for a cell, given how its column is compared (the `numeric`
    /// later passed to [`compare`] and [`order`]).
    pub fn of_column(v: Value, numeric: bool) -> Key {
        match v {
            Value::Null => Key::Null,
            Value::Number(n) => n.as_f64().map(Key::Number).unwrap_or(Key::Null),
            Value::String(s) => text_key(s, numeric),
            other => text_key(other.to_string(), numeric),
        }
    }

    fn text(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Key::Text { raw, .. } => (&**raw).into(),
            Key::Number(n) => n.to_string().into(),
            Key::Null => "".into(),
        }
    }
}

/// NULLs last whatever the direction; everything else reversed by `desc`.
pub fn compare(x: &Key, y: &Key, numeric: bool, desc: bool) -> Ordering {
    let ord = match (x, y) {
        (Key::Null, Key::Null) => return Ordering::Equal,
        (Key::Null, _) => return Ordering::Greater,
        (_, Key::Null) => return Ordering::Less,
        (Key::Number(a), Key::Number(b)) => a.partial_cmp(b).unwrap_or(Ordering::Equal),
        _ if numeric => compare_decimal(&x.text(), &y.text()),
        // Equal keys (the collation ignores some characters) fall back to
        // the exact text, so the order never depends on input order alone.
        (Key::Text { sort: a, raw: ra }, Key::Text { sort: b, raw: rb }) => {
            a.cmp(b).then_with(|| ra.cmp(rb))
        }
        _ => x.text().cmp(&y.text()),
    };
    if desc {
        ord.reverse()
    } else {
        ord
    }
}

/// Two decimal strings, exactly: no rounding through f64. NaN sorts above
/// +Infinity, as PostgreSQL has it.
pub fn compare_decimal(a: &str, b: &str) -> Ordering {
    let rank = |s: &str| match s {
        "NaN" => 2,
        "Infinity" => 1,
        "-Infinity" => -1,
        _ => 0,
    };
    let (a, b) = (a.trim(), b.trim());
    let (ra, rb) = (rank(a), rank(b));
    if ra != 0 || rb != 0 {
        return ra.cmp(&rb);
    }
    struct Dec<'a> {
        neg: bool,
        int: &'a str,
        frac: &'a str,
    }
    fn parse(s: &str) -> Dec<'_> {
        let neg = s.starts_with('-');
        let body = s.trim_start_matches(['-', '+']);
        let (i, f) = body.split_once('.').unwrap_or((body, ""));
        Dec {
            neg,
            int: i.trim_start_matches('0'),
            frac: f.trim_end_matches('0'),
        }
    }
    let sign = |d: &Dec| {
        if d.int.is_empty() && d.frac.is_empty() {
            0
        } else if d.neg {
            -1
        } else {
            1
        }
    };
    let (p, q) = (parse(a), parse(b));
    let (sp, sq) = (sign(&p), sign(&q));
    if sp != sq || sp == 0 {
        return sp.cmp(&sq);
    }
    // Same sign: integer length, then digits, then the fraction. Comparing
    // the fractions as strings is the same as padding them with zeros.
    let mag = p
        .int
        .len()
        .cmp(&q.int.len())
        .then_with(|| p.int.cmp(q.int))
        .then_with(|| p.frac.cmp(q.frac));
    if sp < 0 {
        mag.reverse()
    } else {
        mag
    }
}

/// Cell `column` of one stored row (a JSON array), or NULL. Reads past the
/// other cells without building them: splitting every row into a Vec of
/// cells first cost most of a sort's time on wide results.
pub fn cell_at(row: &str, column: usize) -> Value {
    use serde::de::{Deserializer, IgnoredAny, SeqAccess, Visitor};
    struct Nth(usize);
    impl<'de> Visitor<'de> for Nth {
        type Value = Value;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a row array")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
            let mut found = Value::Null;
            let mut i = 0;
            loop {
                if i == self.0 {
                    match seq.next_element::<Value>()? {
                        Some(v) => found = v,
                        None => break,
                    }
                } else if seq.next_element::<IgnoredAny>()?.is_none() {
                    break;
                }
                i += 1;
            }
            Ok(found)
        }
    }
    serde_json::Deserializer::from_str(row)
        .deserialize_seq(Nth(column))
        .unwrap_or(Value::Null)
}

/// The order of `keys`, as row indexes. Stable, so equal rows keep the
/// order the server sent them in.
pub fn order(keys: &[Key], numeric: bool, desc: bool) -> Vec<u32> {
    let mut idx: Vec<u32> = (0..keys.len() as u32).collect();
    idx.sort_by(|&a, &b| compare(&keys[a as usize], &keys[b as usize], numeric, desc));
    idx
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sorted(xs: &[Value], numeric: bool, desc: bool) -> Vec<Value> {
        let keys: Vec<Key> = xs
            .iter()
            .cloned()
            .map(|v| Key::of_column(v, numeric))
            .collect();
        order(&keys, numeric, desc)
            .into_iter()
            .map(|i| xs[i as usize].clone())
            .collect()
    }

    #[test]
    fn decimals_sort_as_numbers_not_text() {
        let xs = [
            json!("100.00"),
            json!("20.00"),
            json!("9.50"),
            json!("-3"),
            json!("0"),
        ];
        assert_eq!(
            sorted(&xs, true, false),
            [
                json!("-3"),
                json!("0"),
                json!("9.50"),
                json!("20.00"),
                json!("100.00")
            ]
        );
    }

    #[test]
    fn decimal_edge_cases_match_the_grid() {
        use Ordering::*;
        assert_eq!(compare_decimal("1.50", "1.5"), Equal);
        assert_eq!(compare_decimal("-0", "0"), Equal);
        assert_eq!(compare_decimal("-2.5", "-2.25"), Less);
        assert_eq!(compare_decimal("1.25", "1.3"), Less);
        assert_eq!(compare_decimal("1.30", "1.3"), Equal);
        assert_eq!(compare_decimal("12", "9"), Greater);
        assert_eq!(compare_decimal("-12", "-9"), Less);
        assert_eq!(compare_decimal("0.5", "0.25"), Greater);
        let xs = [
            json!("NaN"),
            json!("Infinity"),
            json!("-Infinity"),
            json!("1"),
        ];
        assert_eq!(
            sorted(&xs, true, false),
            [
                json!("-Infinity"),
                json!("1"),
                json!("Infinity"),
                json!("NaN")
            ]
        );
    }

    #[test]
    fn bigints_past_2_pow_53_stay_exact() {
        let xs = [
            json!("9007199254740995"),
            json!("9007199254740993"),
            json!(5),
        ];
        assert_eq!(
            sorted(&xs, true, false),
            [
                json!(5),
                json!("9007199254740993"),
                json!("9007199254740995")
            ]
        );
    }

    #[test]
    fn nulls_are_last_in_both_directions() {
        let xs = [json!(null), json!(2), json!(1)];
        assert_eq!(sorted(&xs, true, false), [json!(1), json!(2), json!(null)]);
        assert_eq!(sorted(&xs, true, true), [json!(2), json!(1), json!(null)]);
    }

    #[test]
    fn text_ignores_case_first_and_is_stable() {
        let xs = [json!("b"), json!("B"), json!("a"), json!("A"), json!("a")];
        assert_eq!(
            sorted(&xs, false, false),
            [json!("a"), json!("a"), json!("A"), json!("b"), json!("B")]
        );
    }

    #[test]
    fn accents_sort_with_their_letter() {
        // Byte order put every accented letter after `z`.
        let xs = [
            json!("zoe"),
            json!("Émile"),
            json!("eve"),
            json!("émile"),
            json!("emile"),
        ];
        assert_eq!(
            sorted(&xs, false, false),
            [
                json!("emile"),
                json!("émile"),
                json!("Émile"),
                json!("eve"),
                json!("zoe")
            ]
        );
    }

    #[test]
    fn other_scripts_sort_by_the_unicode_collation() {
        // Greek: accented alpha sorts with alpha, before beta.
        let xs = [json!("βήτα"), json!("άλφα"), json!("αλφα")];
        assert_eq!(
            sorted(&xs, false, false),
            [json!("αλφα"), json!("άλφα"), json!("βήτα")]
        );
        // German ß sorts as ss, between s and t.
        let xs = [json!("tag"), json!("straße"), json!("strasse"), json!("sz")];
        assert_eq!(
            sorted(&xs, false, false),
            [json!("strasse"), json!("straße"), json!("sz"), json!("tag")]
        );
        // Latin before Greek before Cyrillic, as the UCA orders scripts.
        let xs = [json!("я"), json!("ω"), json!("z")];
        assert_eq!(
            sorted(&xs, false, false),
            [json!("z"), json!("ω"), json!("я")]
        );
    }

    #[test]
    fn json_cells_sort_by_their_text() {
        let xs = [json!({"b": 1}), json!({"a": 1})];
        assert_eq!(
            sorted(&xs, false, false),
            [json!({"a": 1}), json!({"b": 1})]
        );
    }

    #[test]
    fn a_key_holds_no_spare_capacity_and_no_unused_collation() {
        assert!(std::mem::size_of::<Key>() <= 40);
        let Key::Text { sort, .. } = Key::of_column(json!("12.50"), true) else {
            panic!("text key");
        };
        assert!(sort.is_empty(), "numeric columns never collate");
        let Key::Text { sort, .. } = Key::of_column(json!("abc"), false) else {
            panic!("text key");
        };
        assert!(!sort.is_empty());
    }

    #[test]
    fn cell_at_reads_one_cell() {
        let row = r#"[1,{"a":[2,3]},"x",null]"#;
        assert_eq!(cell_at(row, 0), json!(1));
        assert_eq!(cell_at(row, 1), json!({"a": [2, 3]}));
        assert_eq!(cell_at(row, 2), json!("x"));
        assert_eq!(cell_at(row, 3), json!(null));
        assert_eq!(cell_at(row, 9), json!(null), "past the end");
    }

    #[test]
    fn numeric_type_names_are_whole_words() {
        assert!(is_numeric_type("int8"));
        assert!(is_numeric_type("numeric(10,2)"));
        assert!(is_numeric_type("Double Precision"));
        assert!(!is_numeric_type("interval"));
        assert!(!is_numeric_type("int4range"));
        assert!(!is_numeric_type("point"));
    }
}

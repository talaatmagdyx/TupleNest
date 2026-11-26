//! Text for types the driver has no native mapping for, decoded from their
//! binary wire form.
//!
//! Results arrive in binary, and for a type without a mapping the cell used
//! to be the bytes in hex: correct, and useless for an `interval` or a range.
//! This renders the ones whose layout is fixed and whose text does not depend
//! on a server setting, the way the server's own output function writes them
//! (`intervalstyle = postgres`, ISO dates).
//!
//! `money` is the one exception that needs a server setting. Its wire value is
//! an int8 count of the smallest currency unit, scaled by the fractional digits
//! of the server's `lc_monetary` locale (2 for `en_US`, 0 for `ja_JP`, 3 for
//! `ar_BH`), and the wire value does not carry that scale. The caller asks the
//! server for it (see [`Money`]) and passes it in; without it money stays hex
//! rather than being guessed at two decimals.
//!
//! Every length read from the wire is checked against the bytes that are
//! there. Anything that does not fit returns `None`, and the caller shows hex.

use tokio_postgres::types::{FromSql, Kind, Type};

/// How to read a `money` value: the number of fractional digits the server's
/// `lc_monetary` gives it, or `None` when that is not known, in which case
/// money is not rendered at all (the caller shows hex).
///
/// The digits come from the server itself (`scale('0'::money::numeric)`,
/// which runs the server's own `cash_numeric` and so applies exactly the
/// locale and the out-of-range fallback that `cash_out` does), never assumed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Money(Option<u8>);

impl Money {
    /// Money is not known: it renders as hex.
    pub(crate) const UNKNOWN: Money = Money(None);

    /// The server's fractional digits for money. PostgreSQL uses 0..=10
    /// (anything else it replaces with 2 before it gets here); a count
    /// outside that is not believed.
    pub(crate) fn with_frac_digits(digits: u8) -> Money {
        Money((digits <= 10).then_some(digits))
    }

    /// The value as an exact decimal with the server's fractional digits —
    /// what `money::numeric` gives: `-1234.56`, `0.05`, `1000` (no digits).
    /// The currency symbol and digit grouping of the locale are not added:
    /// they are presentation, and a plain decimal stays a number in a
    /// spreadsheet.
    fn render(self, units: i64) -> Option<String> {
        let digits = u32::from(self.0?);
        let sign = if units < 0 { "-" } else { "" };
        let abs = units.unsigned_abs();
        if digits == 0 {
            return Some(format!("{sign}{abs}"));
        }
        let scale = 10u64.pow(digits);
        Some(format!(
            "{sign}{}.{:0width$}",
            abs / scale,
            abs % scale,
            width = digits as usize
        ))
    }
}

/// The value's text, or `None` when this module does not know the type or
/// the bytes are not a value of it.
#[cfg(test)]
pub(crate) fn render(ty: &Type, raw: &[u8]) -> Option<String> {
    render_with(ty, raw, Money::UNKNOWN)
}

/// [`render`], with what is known about how the server writes `money`.
pub(crate) fn render_with(ty: &Type, raw: &[u8], money: Money) -> Option<String> {
    match ty.kind() {
        Kind::Array(element) => array(element, raw, money),
        Kind::Range(subtype) => range(subtype, raw, money),
        Kind::Multirange(subtype) => multirange(subtype, raw, money),
        Kind::Domain(inner) => render_with(inner, raw, money),
        Kind::Enum(_) => std::str::from_utf8(raw).ok().map(str::to_owned),
        _ => scalar(ty, raw, money),
    }
}

/// Does a value of this type contain `money` anywhere the renderer reaches:
/// itself, an array of it, a domain over it?
pub(crate) fn mentions_money(ty: &Type) -> bool {
    match ty.kind() {
        Kind::Array(inner) | Kind::Domain(inner) | Kind::Range(inner) | Kind::Multirange(inner) => {
            mentions_money(inner)
        }
        _ => *ty == Type::MONEY,
    }
}

fn be<const N: usize>(raw: &[u8]) -> Option<[u8; N]> {
    raw.try_into().ok()
}

/// Reads a big-endian `i32` and advances.
fn take_i32(raw: &mut &[u8]) -> Option<i32> {
    let (head, rest) = raw.split_first_chunk::<4>()?;
    *raw = rest;
    Some(i32::from_be_bytes(*head))
}

/// Reads `len` bytes and advances.
fn take_bytes<'a>(raw: &mut &'a [u8], len: usize) -> Option<&'a [u8]> {
    if raw.len() < len {
        return None;
    }
    let (head, rest) = raw.split_at(len);
    *raw = rest;
    Some(head)
}

fn scalar(ty: &Type, raw: &[u8], money: Money) -> Option<String> {
    Some(match *ty {
        Type::MONEY => money.render(i64::from_be_bytes(be(raw)?))?,
        Type::BOOL => match raw {
            [0] => "f".into(),
            [1] => "t".into(),
            _ => return None,
        },
        Type::INT2 => i16::from_be_bytes(be(raw)?).to_string(),
        Type::INT4 => i32::from_be_bytes(be(raw)?).to_string(),
        Type::INT8 => i64::from_be_bytes(be(raw)?).to_string(),
        Type::OID => u32::from_be_bytes(be(raw)?).to_string(),
        Type::FLOAT4 => float(f64::from(f32::from_be_bytes(be(raw)?)), |f| {
            (f as f32).to_string()
        }),
        Type::FLOAT8 => float(f64::from_be_bytes(be(raw)?), |f| f.to_string()),
        Type::NUMERIC => crate::PgNumeric::from_sql(ty, raw).ok()?.0,
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::JSON => {
            std::str::from_utf8(raw).ok()?.to_owned()
        }
        Type::JSONB => match raw.split_first() {
            Some((1, text)) => std::str::from_utf8(text).ok()?.to_owned(),
            _ => return None,
        },
        Type::BYTEA => format!("\\x{}", hex::encode(raw)),
        Type::UUID => uuid::Uuid::from_bytes(be(raw)?).to_string(),
        Type::DATE => date(i32::from_be_bytes(be(raw)?))?,
        Type::TIMESTAMP => timestamp(i64::from_be_bytes(be(raw)?), false)?,
        Type::TIMESTAMPTZ => timestamp(i64::from_be_bytes(be(raw)?), true)?,
        Type::TIME => time(i64::from_be_bytes(be(raw)?))?,
        Type::TIMETZ => {
            let (micros, zone) = raw.split_first_chunk::<8>()?;
            format!(
                "{}{}",
                time(i64::from_be_bytes(*micros))?,
                zone_offset(i32::from_be_bytes(be(zone)?))
            )
        }
        Type::INTERVAL => {
            let (micros, rest) = raw.split_first_chunk::<8>()?;
            let (days, months) = rest.split_first_chunk::<4>()?;
            interval(
                i64::from_be_bytes(*micros),
                i32::from_be_bytes(*days),
                i32::from_be_bytes(be(months)?),
            )
        }
        _ => return None,
    })
}

/// PostgreSQL's spelling of the three values Rust spells differently.
fn float(f: f64, finite: impl Fn(f64) -> String) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else {
        finite(f)
    }
}

/// Days since 2000-01-01. The extremes are `infinity` and `-infinity`, which
/// no calendar type holds: that is why they used to fall through to hex.
fn date(days: i32) -> Option<String> {
    match days {
        i32::MAX => return Some("infinity".into()),
        i32::MIN => return Some("-infinity".into()),
        _ => {}
    }
    let epoch = chrono::NaiveDate::from_ymd_opt(2000, 1, 1)?;
    let d = epoch.checked_add_signed(chrono::Duration::days(i64::from(days)))?;
    Some(era(d, String::new()))
}

/// `YYYY-MM-DD<rest>`, or PostgreSQL's ` BC` form for years before 1.
fn era(d: chrono::NaiveDate, rest: String) -> String {
    use chrono::Datelike;
    if d.year() > 0 {
        format!("{:04}-{:02}-{:02}{rest}", d.year(), d.month(), d.day())
    } else {
        // Year 0 of the proleptic calendar is 1 BC.
        format!(
            "{:04}-{:02}-{:02}{rest} BC",
            1 - d.year(),
            d.month(),
            d.day()
        )
    }
}

/// Microseconds since 2000-01-01 00:00:00. A `timestamptz` is written in UTC
/// with a `Z`, as its cells are everywhere else in the app.
fn timestamp(micros: i64, utc: bool) -> Option<String> {
    match micros {
        i64::MAX => return Some("infinity".into()),
        i64::MIN => return Some("-infinity".into()),
        _ => {}
    }
    let day = micros.div_euclid(86_400_000_000);
    let of_day = micros.rem_euclid(86_400_000_000);
    let epoch = chrono::NaiveDate::from_ymd_opt(2000, 1, 1)?;
    let d = epoch.checked_add_signed(chrono::Duration::days(day))?;
    let clock = time(of_day)?;
    Some(if utc {
        era(d, format!("T{clock}Z"))
    } else {
        era(d, format!(" {clock}"))
    })
}

/// Microseconds since midnight as `HH:MM:SS[.ffffff]`. `24:00:00` is a valid
/// `time` and is written as that, not wrapped to `00:00:00`.
fn time(micros: i64) -> Option<String> {
    if !(0..=86_400_000_000).contains(&micros) {
        return None;
    }
    let secs = micros / 1_000_000;
    Some(format!(
        "{:02}:{:02}:{:02}{}",
        secs / 3600,
        secs / 60 % 60,
        secs % 60,
        fraction(micros % 1_000_000)
    ))
}

/// `.ffffff` with trailing zeros dropped, or nothing.
fn fraction(micros: i64) -> String {
    if micros == 0 {
        return String::new();
    }
    let digits = format!("{:06}", micros.abs());
    format!(".{}", digits.trim_end_matches('0'))
}

/// A `timetz` zone: seconds *west* of UTC on the wire, written east-positive.
fn zone_offset(west: i32) -> String {
    let east = -i64::from(west);
    let (sign, a) = (if east < 0 { '-' } else { '+' }, east.abs());
    let (h, m, s) = (a / 3600, a / 60 % 60, a % 60);
    match (m, s) {
        (0, 0) => format!("{sign}{h:02}"),
        (_, 0) => format!("{sign}{h:02}:{m:02}"),
        _ => format!("{sign}{h:02}:{m:02}:{s:02}"),
    }
}

/// `interval` as `intervalstyle = postgres` writes it: `1 year 2 mons -3 days
/// +04:05:06.5`. A field's `+` is shown only after a negative one.
fn interval(micros: i64, days: i32, months: i32) -> String {
    let mut out = String::new();
    let mut after_negative = false;
    let mut part = |value: i64, unit: &str| {
        if value == 0 {
            return;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        if after_negative && value > 0 {
            out.push('+');
        }
        out.push_str(&format!(
            "{value} {unit}{}",
            if value == 1 { "" } else { "s" }
        ));
        after_negative = value < 0;
    };
    part(i64::from(months / 12), "year");
    part(i64::from(months % 12), "mon");
    part(i64::from(days), "day");
    if out.is_empty() || micros != 0 {
        let sign = if micros < 0 {
            "-"
        } else if after_negative {
            "+"
        } else {
            ""
        };
        // i64::MIN has no absolute value as an i64.
        let a = micros.unsigned_abs();
        let secs = a / 1_000_000;
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&format!(
            "{sign}{:02}:{:02}:{:02}{}",
            secs / 3600,
            secs / 60 % 60,
            secs % 60,
            fraction((a % 1_000_000) as i64)
        ));
    }
    out
}

/// The most dimensions PostgreSQL allows (`MAXDIM`).
const MAX_DIMENSIONS: usize = 6;

/// An array of any shape: `{1,2}`, `{{1,2},{3,4}}`, `[0:1]={a,b}`.
fn array(element: &Type, mut raw: &[u8], money: Money) -> Option<String> {
    let dimensions = usize::try_from(take_i32(&mut raw)?).ok()?;
    let _has_nulls = take_i32(&mut raw)?;
    let _element_oid = take_i32(&mut raw)?;
    if dimensions == 0 {
        return Some("{}".into());
    }
    if dimensions > MAX_DIMENSIONS {
        return None;
    }
    let mut lengths = Vec::with_capacity(dimensions);
    let mut bounds = String::new();
    let mut default_bounds = true;
    let mut total: usize = 1;
    for _ in 0..dimensions {
        let len = usize::try_from(take_i32(&mut raw)?).ok()?;
        let lower = take_i32(&mut raw)?;
        default_bounds &= lower == 1;
        let upper = i64::from(lower) + len as i64 - 1;
        bounds.push_str(&format!("[{lower}:{upper}]"));
        total = total.checked_mul(len)?;
        lengths.push(len);
    }
    // Each element costs at least its four-byte length, so a count the bytes
    // cannot hold is a lie about the shape; refuse it before looping on it.
    if total == 0 || total > raw.len() / 4 {
        return None;
    }
    let mut out = if default_bounds {
        String::new()
    } else {
        format!("{bounds}=")
    };
    array_level(element, &lengths, &mut raw, &mut out, money)?;
    raw.is_empty().then_some(out)
}

fn array_level(
    element: &Type,
    lengths: &[usize],
    raw: &mut &[u8],
    out: &mut String,
    money: Money,
) -> Option<()> {
    let (&len, inner) = lengths.split_first()?;
    out.push('{');
    for k in 0..len {
        if k > 0 {
            out.push(',');
        }
        if inner.is_empty() {
            match take_i32(raw)? {
                -1 => out.push_str("NULL"),
                n => {
                    let bytes = take_bytes(raw, usize::try_from(n).ok()?)?;
                    crate::push_array_element(out, &render_with(element, bytes, money)?);
                }
            }
        } else {
            array_level(element, inner, raw, out, money)?;
        }
    }
    out.push('}');
    Some(())
}

const RANGE_EMPTY: u8 = 0x01;
const RANGE_LOWER_INCLUSIVE: u8 = 0x02;
const RANGE_UPPER_INCLUSIVE: u8 = 0x04;
const RANGE_LOWER_INFINITE: u8 = 0x08;
const RANGE_UPPER_INFINITE: u8 = 0x10;

/// A range: `[1,10)`, `(,5]`, `empty`.
fn range(subtype: &Type, raw: &[u8], money: Money) -> Option<String> {
    let mut raw = raw;
    let out = range_at(subtype, &mut raw, money)?;
    raw.is_empty().then_some(out)
}

fn range_at(subtype: &Type, raw: &mut &[u8], money: Money) -> Option<String> {
    let (&flags, rest) = raw.split_first()?;
    *raw = rest;
    if flags & RANGE_EMPTY != 0 {
        return Some("empty".into());
    }
    let mut bound = |infinite: u8| -> Option<String> {
        if flags & infinite != 0 {
            return Some(String::new());
        }
        let len = usize::try_from(take_i32(raw)?).ok()?;
        Some(range_bound(&render_with(
            subtype,
            take_bytes(raw, len)?,
            money,
        )?))
    };
    let lower = bound(RANGE_LOWER_INFINITE)?;
    let upper = bound(RANGE_UPPER_INFINITE)?;
    Some(format!(
        "{}{lower},{upper}{}",
        if flags & RANGE_LOWER_INCLUSIVE != 0 {
            '['
        } else {
            '('
        },
        if flags & RANGE_UPPER_INCLUSIVE != 0 {
            ']'
        } else {
            ')'
        },
    ))
}

/// A bound as `range_out` writes it: quoted when it is empty or holds a
/// character the range syntax uses, with `"` and `\` doubled inside.
fn range_bound(s: &str) -> String {
    let needs = s.is_empty()
        || s.chars()
            .any(|c| matches!(c, '"' | '\\' | '(' | ')' | '[' | ']' | ',') || c.is_whitespace());
    if !needs {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        if matches!(c, '"' | '\\') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// A multirange (PostgreSQL 14+): `{[1,3),[5,8)}`.
fn multirange(subtype: &Type, mut raw: &[u8], money: Money) -> Option<String> {
    let count = usize::try_from(take_i32(&mut raw)?).ok()?;
    if count > raw.len() / 4 {
        return None;
    }
    let mut out = String::from("{");
    for k in 0..count {
        if k > 0 {
            out.push(',');
        }
        let len = usize::try_from(take_i32(&mut raw)?).ok()?;
        out.push_str(&range(subtype, take_bytes(&mut raw, len)?, money)?);
    }
    out.push('}');
    raw.is_empty().then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_follows_the_servers_sign_rules() {
        let h = 3_600_000_000_i64;
        assert_eq!(interval(0, 0, 0), "00:00:00");
        assert_eq!(interval(0, 1, 0), "1 day");
        assert_eq!(interval(0, 2, 14), "1 year 2 mons 2 days");
        assert_eq!(
            interval(4 * h + 5 * 60_000_000 + 6_500_000, 3, 0),
            "3 days 04:05:06.5"
        );
        assert_eq!(interval(2 * h, -1, 0), "-1 days +02:00:00");
        assert_eq!(interval(-2 * h, 1, -1), "-1 mons +1 day -02:00:00");
        assert_eq!(interval(-1, 0, 0), "-00:00:00.000001");
        assert_eq!(interval(0, 0, -25), "-2 years -1 mons");
        assert_eq!(interval(100 * h, 0, 0), "100:00:00");
        // No panic at the edge of the type.
        assert!(interval(i64::MIN, i32::MIN, i32::MIN).starts_with("-178956970 years"));
    }

    #[test]
    fn time_keeps_midnight_at_the_end_of_the_day() {
        assert_eq!(time(86_400_000_000).unwrap(), "24:00:00");
        assert_eq!(time(0).unwrap(), "00:00:00");
        assert_eq!(time(37_800_123_400).unwrap(), "10:30:00.1234");
        assert_eq!(time(86_400_000_001), None);
        assert_eq!(time(-1), None);
    }

    #[test]
    fn zones_are_written_east_positive_and_as_short_as_they_can_be() {
        assert_eq!(zone_offset(0), "+00");
        assert_eq!(zone_offset(-7200), "+02");
        assert_eq!(zone_offset(18_000), "-05");
        assert_eq!(zone_offset(-19_800), "+05:30");
        assert_eq!(zone_offset(-1), "+00:00:01");
    }

    #[test]
    fn dates_and_timestamps_have_their_infinities_and_their_bc() {
        assert_eq!(date(i32::MAX).unwrap(), "infinity");
        assert_eq!(date(i32::MIN).unwrap(), "-infinity");
        assert_eq!(date(0).unwrap(), "2000-01-01");
        assert_eq!(date(-730_120).unwrap(), "0001-12-31 BC");
        assert_eq!(timestamp(i64::MAX, false).unwrap(), "infinity");
        assert_eq!(timestamp(i64::MIN, true).unwrap(), "-infinity");
        assert_eq!(timestamp(-1, false).unwrap(), "1999-12-31 23:59:59.999999");
        assert_eq!(
            timestamp(1_500_000, true).unwrap(),
            "2000-01-01T00:00:01.5Z"
        );
    }

    fn int4s(raw: &[u8]) -> Option<String> {
        array(&Type::INT4, raw, Money::UNKNOWN)
    }

    fn int4_array(dims: &[(i32, i32)], elements: &[Option<i32>]) -> Vec<u8> {
        let mut raw = Vec::new();
        raw.extend((dims.len() as i32).to_be_bytes());
        raw.extend(0_i32.to_be_bytes());
        raw.extend(23_i32.to_be_bytes());
        for (len, lower) in dims {
            raw.extend(len.to_be_bytes());
            raw.extend(lower.to_be_bytes());
        }
        for e in elements {
            match e {
                Some(v) => {
                    raw.extend(4_i32.to_be_bytes());
                    raw.extend(v.to_be_bytes());
                }
                None => raw.extend((-1_i32).to_be_bytes()),
            }
        }
        raw
    }

    #[test]
    fn arrays_of_every_shape() {
        let a = |dims: &[(i32, i32)], e: &[Option<i32>]| int4s(&int4_array(dims, e));
        assert_eq!(a(&[], &[]).unwrap(), "{}");
        assert_eq!(
            a(&[(3, 1)], &[Some(1), None, Some(3)]).unwrap(),
            "{1,NULL,3}"
        );
        assert_eq!(
            a(&[(2, 1), (2, 1)], &[Some(1), Some(2), Some(3), Some(4)]).unwrap(),
            "{{1,2},{3,4}}"
        );
        assert_eq!(a(&[(2, 0)], &[Some(7), Some(8)]).unwrap(), "[0:1]={7,8}");
    }

    #[test]
    fn a_shape_the_bytes_cannot_hold_is_refused_not_looped_over() {
        // Claims 2^31-1 by 2^31-1 elements in a few bytes.
        let raw = int4_array(&[(i32::MAX, 1), (i32::MAX, 1)], &[Some(1)]);
        assert_eq!(int4s(&raw), None);
        // Seven dimensions, one more than the server allows.
        assert_eq!(int4s(&int4_array(&[(1, 1); 7], &[Some(1)])), None);
        // Trailing bytes, a short element, a negative length.
        let mut extra = int4_array(&[(1, 1)], &[Some(1)]);
        extra.push(0);
        assert_eq!(int4s(&extra), None);
        let mut short = int4_array(&[(1, 1)], &[Some(1)]);
        short.truncate(short.len() - 1);
        assert_eq!(int4s(&short), None);
        assert_eq!(int4s(&int4_array(&[(-1, 1)], &[])), None);
    }

    #[test]
    fn random_bytes_never_panic() {
        // A small deterministic generator: no dependency, same bytes each run.
        let mut state = 0x9E37_79B9_7F4A_7C15_u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let range_ty = Type::INT4_RANGE;
        let array_ty = Type::INT4_ARRAY;
        let types = [
            &Type::INTERVAL,
            &Type::TIMETZ,
            &Type::TIME,
            &Type::DATE,
            &Type::TIMESTAMP,
            &Type::TIMESTAMPTZ,
            &Type::NUMERIC,
            &Type::JSONB,
            &Type::UUID,
            &range_ty,
            &array_ty,
            &Type::TSTZ_RANGE_ARRAY,
        ];
        for _ in 0..20_000 {
            let len = (next() % 48) as usize;
            let raw: Vec<u8> = (0..len).map(|_| (next() >> 32) as u8).collect();
            for ty in types {
                let _ = render(ty, &raw);
            }
        }
    }

    #[test]
    fn range_bounds_are_quoted_only_when_they_must_be() {
        assert_eq!(range_bound("10"), "10");
        assert_eq!(
            range_bound("2024-01-01 00:00:00"),
            "\"2024-01-01 00:00:00\""
        );
        assert_eq!(range_bound(""), "\"\"");
        assert_eq!(range_bound("a\"b\\c"), "\"a\"\"b\\\\c\"");
    }

    #[test]
    fn money_is_left_for_hex_while_the_servers_frac_digits_are_unknown() {
        assert_eq!(render(&Type::MONEY, &12_345_i64.to_be_bytes()), None);
    }

    #[test]
    fn money_is_an_exact_decimal_at_the_servers_scale() {
        let m = |digits: u8, units: i64| {
            render_with(
                &Type::MONEY,
                &units.to_be_bytes(),
                Money::with_frac_digits(digits),
            )
        };
        assert_eq!(m(2, 123_456).as_deref(), Some("1234.56"));
        assert_eq!(m(2, -123_456).as_deref(), Some("-1234.56"));
        assert_eq!(m(2, 5).as_deref(), Some("0.05"));
        assert_eq!(m(2, -5).as_deref(), Some("-0.05"));
        assert_eq!(m(2, 0).as_deref(), Some("0.00"));
        // ja_JP has no minor unit; ar_BH has three.
        assert_eq!(m(0, -1_234).as_deref(), Some("-1234"));
        assert_eq!(m(3, 1_234_567).as_deref(), Some("1234.567"));
        // The extremes, exactly: no float on the way.
        assert_eq!(m(2, i64::MAX).as_deref(), Some("92233720368547758.07"));
        assert_eq!(m(2, i64::MIN).as_deref(), Some("-92233720368547758.08"));
        assert_eq!(m(10, i64::MIN).as_deref(), Some("-922337203.6854775808"));
        // A scale PostgreSQL never uses is not believed.
        assert_eq!(m(11, 1), None);
        // Wrong width is not a money value.
        assert_eq!(
            render_with(&Type::MONEY, &[0; 4], Money::with_frac_digits(2)),
            None
        );
    }

    #[test]
    fn money_inside_arrays_uses_the_same_scale() {
        // money[] of {1.50, NULL, -2.00}.
        let mut raw = Vec::new();
        for v in [1i32, 1, Type::MONEY.oid() as i32, 3, 1] {
            raw.extend_from_slice(&v.to_be_bytes());
        }
        for e in [Some(150i64), None, Some(-200)] {
            match e {
                Some(v) => {
                    raw.extend_from_slice(&8i32.to_be_bytes());
                    raw.extend_from_slice(&v.to_be_bytes());
                }
                None => raw.extend_from_slice(&(-1i32).to_be_bytes()),
            }
        }
        assert_eq!(
            render_with(&Type::MONEY_ARRAY, &raw, Money::with_frac_digits(2)).as_deref(),
            Some("{1.50,NULL,-2.00}")
        );
        assert_eq!(render(&Type::MONEY_ARRAY, &raw), None);
        assert!(mentions_money(&Type::MONEY_ARRAY));
        assert!(!mentions_money(&Type::NUMERIC));
    }
}

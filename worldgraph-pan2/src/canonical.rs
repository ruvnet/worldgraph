//! Canonical JSON for Cognitum Spaces snapshot hashes (ADR-107 §4).
//!
//! The Spaces API hashes the `data` of a snapshot as: UTF-8 bytes of JSON with
//! object keys sorted by UTF-16 code unit, no whitespace, and scalars written the
//! way JavaScript's `JSON.stringify` writes them. This module reproduces that so a
//! client can recompute the hash it was given. `tests/fixtures/spaces-canonical.json`
//! holds a fixture produced by the TypeScript implementation; the test below must
//! match it byte for byte. If a number is formatted differently the hash will not
//! match and the snapshot is refused (fail closed).

use serde_json::{Number, Value};

use crate::media::sha256_hex;

/// `sha256:<hex>` of the canonical JSON of `value`.
pub fn snapshot_hash(value: &Value) -> String {
    format!("sha256:{}", sha256_hex(canonical_json(value).as_bytes()))
}

/// Canonical JSON text of `value`.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&js_number(number)),
        Value::String(text) => out.push_str(&serde_json::to_string(text).expect("string")),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            // UTF-16 code unit order, which differs from UTF-8 byte order above U+FFFF.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("key"));
                out.push(':');
                write(&map[key], out);
            }
            out.push('}');
        }
    }
}

/// ECMAScript `Number::toString` for a finite number.
fn js_number(number: &Number) -> String {
    if let Some(int) = number.as_i64() {
        return int.to_string();
    }
    if let Some(int) = number.as_u64() {
        return int.to_string();
    }
    let value = number.as_f64().unwrap_or(0.0);
    if value == 0.0 {
        return "0".into();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // `{:e}` gives the shortest round-trip digits as `d.ddde<exp>`.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("scientific form");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("exponent") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign_e = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign_e}{}", e.abs())
        } else {
            format!("{}.{}e{sign_e}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_the_typescript_fixture_byte_for_byte() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/spaces-canonical.json")).unwrap();
        assert_eq!(
            canonical_json(&fixture["fixture"]),
            fixture["canonical"].as_str().unwrap()
        );
        assert_eq!(
            snapshot_hash(&fixture["fixture"]),
            fixture["hash"].as_str().unwrap()
        );
    }

    #[test]
    fn numbers_follow_ecmascript_formatting() {
        let cases = [
            (json!(3.0), "3"),
            (json!(-0.0), "0"),
            (json!(0.5), "0.5"),
            (json!(-2.25), "-2.25"),
            (json!(0.000001), "0.000001"),
            (json!(1e-7), "1e-7"),
            (json!(1.5e-7), "1.5e-7"),
            (json!(123456789012345680000.0), "123456789012345680000"),
            (json!(1e21), "1e+21"),
            (json!(1.5e300), "1.5e+300"),
            (json!(100000), "100000"),
        ];
        for (value, want) in cases {
            assert_eq!(canonical_json(&value), want, "{value}");
        }
    }

    #[test]
    fn keys_sort_by_utf16_code_unit_not_utf8_bytes() {
        // U+FF5E sorts after U+1F600 in UTF-8 but before it in UTF-16 (surrogate 0xD83D < 0xFF5E).
        let value = json!({"\u{ff5e}": 1, "\u{1f600}": 2, "a": 3});
        let text = canonical_json(&value);
        let order: Vec<usize> = ["\"a\"", "\u{1f600}", "\u{ff5e}"]
            .iter()
            .map(|needle| text.find(needle).unwrap())
            .collect();
        assert!(order[0] < order[1] && order[1] < order[2], "{text}");
    }
}

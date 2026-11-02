// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/// ECMAScript WhiteSpace + LineTerminator: Rust's Unicode trim also removes NEL
/// but does not remove BOM. Environment parsing must preserve the TS boundary.
pub fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub fn trim(value: &str) -> &str {
    value.trim_matches(whitespace)
}
pub fn trim_start(value: &str) -> &str {
    value.trim_start_matches(whitespace)
}

/// Number.toFixed(3) rounds an exact binary half toward the larger decimal
/// integer. Rust's formatter uses ties-to-even. Scale the exact f64 rational,
/// avoiding a multiply-and-round double rounding at decimal boundaries.
pub fn fixed_3(value: f64) -> String {
    let magnitude = value.abs();
    if magnitude >= 1e21 {
        return serde_json::to_string(&value).expect("finite duration");
    }
    let bits = magnitude.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let (mantissa, power) = if exponent == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1_u64 << 52), exponent - 1023 - 52)
    };
    let numerator = u128::from(mantissa) * 1000;
    let scaled = if power >= 0 {
        numerator << (power as u32)
    } else {
        let shift = (-power) as u32;
        if shift >= 128 {
            0
        } else {
            let integral = numerator >> shift;
            let remainder = numerator & ((1_u128 << shift) - 1);
            integral + u128::from(remainder >= (1_u128 << (shift - 1)))
        }
    };
    format!(
        "{}{}.{:03}",
        if value < 0.0 { "-" } else { "" },
        scaled / 1000,
        scaled % 1000
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn fixed_decimals_follow_javascript_half_rounding() {
        assert_eq!(super::fixed_3(1.0625), "1.063");
        assert_eq!(super::fixed_3(1.9375), "1.938");
        assert_eq!(super::fixed_3(-1.0625), "-1.063");
        assert_eq!(super::fixed_3(-0.0), "0.000");
        assert_eq!(super::fixed_3(f64::from_bits(1)), "0.000");
    }
    #[test]
    fn javascript_whitespace_differs_from_rust_unicode_whitespace() {
        assert_eq!(super::trim("\u{feff}\u{a0}12\u{feff}"), "12");
        assert_eq!(super::trim("\u{85}12\u{85}"), "\u{85}12\u{85}");
    }
}

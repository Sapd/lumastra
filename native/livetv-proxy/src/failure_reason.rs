// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Typed reasons why a Live TV channel will not play. Port of
//! `src/shared/livetv-failure-reason.ts`; the conformance suite replays
//! `src/shared/livetv-failure-reasons.fixture.json` against both.
//!
//! The TS rules are regular expressions; this crate has no regex engine, so each
//! pattern is matched by hand below with the same semantics (JS `\s`, `\b`).
use serde::Deserialize;
use serde_json::{Value, json};

pub const REASONS: [&str; 9] = [
    "channel_offline",
    "provider_auth_failed",
    "provider_connection_limit",
    "provider_unreachable",
    "geo_blocked",
    "no_video",
    "encoder_failed",
    "all_feeds_failed",
    "upstream_stalled",
];

/// Reasons that end an attempt at once when they come from a provider answer before
/// any segment (`LIVETV_IMMEDIATE_FAILOVER_REASONS`).
pub const IMMEDIATE_FAILOVER_REASONS: [&str; 5] = [
    "channel_offline",
    "provider_auth_failed",
    "provider_connection_limit",
    "geo_blocked",
    "no_video",
];

/// Upstream bodies are matched on their first 512 characters only.
pub const BODY_SNIPPET_MAX: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    pub status: u16,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
}

pub fn policy(reason: &str) -> Policy {
    let (status, retryable, retry_after_ms) = match reason {
        "provider_connection_limit" => (503, true, Some(30_000)),
        "provider_unreachable" => (504, true, Some(10_000)),
        "encoder_failed" => (500, true, Some(5_000)),
        "upstream_stalled" => (502, true, Some(3_000)),
        _ => (502, false, None),
    };
    Policy {
        status,
        retryable,
        retry_after_ms,
    }
}

/// The canonical `&'static str` for a known reason.
pub fn known(reason: &str) -> Option<&'static str> {
    REASONS.iter().copied().find(|known| *known == reason)
}

fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// True when `text` contains `literal` followed by a non-word character or the end
/// (JS `literal\b` for a literal that ends in a word character).
fn contains_then_boundary(text: &str, literal: &str) -> bool {
    text.match_indices(literal).any(|(at, _)| {
        text.as_bytes()
            .get(at + literal.len())
            .is_none_or(|b| !word_byte(*b))
    })
}

/// JS `\bword\b` for a word made of word characters.
fn contains_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(at, _)| {
        let bytes = text.as_bytes();
        (at == 0 || !word_byte(bytes[at - 1]))
            && bytes.get(at + word.len()).is_none_or(|b| !word_byte(*b))
    })
}

/// One element of a hand-written sequence pattern.
enum Part<'a> {
    /// One of these literals (tried in order, with backtracking).
    Any(&'a [&'a str]),
    /// `[\s_-]*`
    Gap,
}

fn sequence_at(text: &str, parts: &[Part]) -> bool {
    match parts.split_first() {
        None => true,
        Some((Part::Gap, rest)) => {
            let skipped = text
                .char_indices()
                .find(|(_, c)| !(js_space(*c) || *c == '_' || *c == '-'))
                .map_or(text.len(), |(at, _)| at);
            // Every literal starts with a letter, so the greedy gap never needs to give back.
            sequence_at(&text[skipped..], rest)
        }
        Some((Part::Any(options), rest)) => options.iter().any(|option| {
            text.strip_prefix(option)
                .is_some_and(|after| sequence_at(after, rest))
        }),
    }
}

/// Unanchored search for a sequence pattern.
fn contains_sequence(text: &str, parts: &[Part]) -> bool {
    text.char_indices()
        .any(|(at, _)| sequence_at(&text[at..], parts))
}

fn geo_body(body: &str) -> bool {
    if contains_sequence(
        body,
        &[
            Part::Any(&["geo"]),
            Part::Any(&["-", "_", " ", ""]),
            Part::Any(&["block", "restrict", "locat"]),
        ],
    ) {
        return true;
    }
    for prefix in ["not available", "unavailable", "blocked", "restricted"] {
        for place in ["country", "region"] {
            if body.contains(&format!("{prefix} in your {place}")) {
                return true;
            }
        }
    }
    body.contains("country not allowed") || body.contains("region not supported")
}

fn limit_body(body: &str) -> bool {
    contains_sequence(
        body,
        &[
            Part::Any(&["maximum", "max"]),
            Part::Gap,
            Part::Any(&["connection", "stream"]),
        ],
    ) || contains_sequence(
        body,
        &[Part::Any(&["connection"]), Part::Gap, Part::Any(&["limit"])],
    ) || contains_sequence(
        body,
        &[
            Part::Any(&["too"]),
            Part::Gap,
            Part::Any(&["many"]),
            Part::Gap,
            Part::Any(&["connections", "users"]),
        ],
    )
}

fn first_chars(text: &str, limit: usize) -> &str {
    text.char_indices()
        .nth(limit)
        .map_or(text, |(at, _)| &text[..at])
}

/// A provider's HTTP answer (as seen by the upstream relay). None for an answer that is
/// not a failure (< 400).
pub fn classify_upstream(status: u16, body_snippet: &str) -> Option<&'static str> {
    if status < 400 {
        return None;
    }
    let body = first_chars(body_snippet, BODY_SNIPPET_MAX).to_lowercase();
    Some(match status {
        401 | 403 if geo_body(&body) => "geo_blocked",
        401 | 403 if limit_body(&body) => "provider_connection_limit",
        401 | 403 => "provider_auth_failed",
        404 | 410 => "channel_offline",
        451 => "geo_blocked",
        429 | 458 | 509 => "provider_connection_limit",
        503 if limit_body(&body) => "provider_connection_limit",
        408 => "provider_unreachable",
        status if status >= 500 => "provider_unreachable",
        _ => "channel_offline",
    })
}

/// The relay's own refusal: timeouts, failed connects, the private-URL policy, and
/// playlists it could not rewrite.
pub fn classify_guard(status: u16, diagnostic: &str) -> Option<&'static str> {
    if status < 400 {
        return None;
    }
    let diagnostic = diagnostic.to_lowercase();
    Some(
        if diagnostic.contains("playlist") || diagnostic.contains("uri attribute") {
            "channel_offline"
        } else {
            "provider_unreachable"
        },
    )
}

fn server_returned_5xx(line: &str) -> bool {
    line.match_indices("server returned 5")
        .any(|(at, literal)| {
            let rest = &line.as_bytes()[at + literal.len()..];
            let code = rest.len() >= 2
                && ((rest[0].is_ascii_digit() && rest[1].is_ascii_digit())
                    || (rest[0] == b'x' && rest[1] == b'x'));
            code && rest.get(2).is_none_or(|b| !word_byte(*b))
        })
}

fn stream_map_without_video(line: &str) -> bool {
    line.match_indices("stream map '").any(|(at, literal)| {
        let rest = &line[at + literal.len()..];
        rest.find('\'').is_some_and(|end| {
            !rest[..end].starts_with("0:v") && rest[end..].starts_with("' matches no streams")
        })
    })
}

fn decoder_not_found(line: &str) -> bool {
    line.match_indices("decoder (codec ").any(|(at, literal)| {
        let rest = &line[at + literal.len()..];
        rest.find(')')
            .is_some_and(|end| rest[end..].starts_with(") not found"))
    })
}

fn stderr_line_reason(line: &str) -> Option<&'static str> {
    if contains_then_boundary(line, "server returned 401")
        || contains_then_boundary(line, "server returned 403")
        || line.contains("401 unauthorized")
        || line.contains("403 forbidden")
    {
        return Some("provider_auth_failed");
    }
    if contains_then_boundary(line, "server returned 404")
        || line.contains("404 not found")
        || contains_then_boundary(line, "server returned 410")
    {
        return Some("channel_offline");
    }
    if server_returned_5xx(line) {
        return Some("provider_unreachable");
    }
    if [
        "connection refused",
        "failed to resolve hostname",
        "connection timed out",
        "network is unreachable",
        "no route to host",
        "connection reset by peer",
        "certificate",
    ]
    .iter()
    .any(|needle| line.contains(needle))
        || contains_word(line, "tls")
        || contains_word(line, "ssl")
    {
        return Some("provider_unreachable");
    }
    if line.contains("does not contain any stream")
        || stream_map_without_video(line)
        || decoder_not_found(line)
    {
        return Some("no_video");
    }
    None
}

fn ingest_encoder_line(text: &str) -> bool {
    [
        "vaapi",
        "qsv",
        "nvenc",
        "cuda",
        "error initializing output stream",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// The tail of an FFmpeg stderr after the process died or stalled; `source` is
/// `ingest`, `egress` or `adaptive-egress`. For ingest the LAST recognisable line
/// wins, and encoder lines count only when the attempt transcodes.
pub fn classify_stderr(
    tail: &str,
    source: &str,
    produced_segments: bool,
    transcoding: bool,
) -> Option<&'static str> {
    let text = tail.to_lowercase();
    if source != "ingest" {
        return (ingest_encoder_line(&text) || text.contains("conversion failed"))
            .then_some("encoder_failed");
    }
    for line in text.split('\n').rev() {
        if let Some(reason) = stderr_line_reason(line) {
            return Some(reason);
        }
        if transcoding && ingest_encoder_line(line) {
            return Some("encoder_failed");
        }
    }
    (!produced_segments && text.contains("invalid data found when processing input"))
        .then_some("channel_offline")
}

/// One failed attempt on one URL of a station.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedFailure {
    pub index: usize,
    #[serde(default)]
    pub feed_id: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub upstream_status: Option<u16>,
}

impl FeedFailure {
    /// The `LiveTvFeedFailure` wire object (absent fields omitted).
    pub fn to_json(&self) -> Value {
        let mut out = json!({"index": self.index});
        if let Some(feed) = &self.feed_id {
            out["feedId"] = json!(feed);
        }
        out["reason"] = json!(self.reason);
        if let Some(status) = self.upstream_status {
            out["upstreamStatus"] = json!(status);
        }
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Combined {
    pub reason: &'static str,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
}

impl Combined {
    pub fn from_policy(reason: &'static str) -> Self {
        let policy = policy(reason);
        Self {
            reason,
            retryable: policy.retryable,
            retry_after_ms: policy.retry_after_ms,
        }
    }
    pub fn to_json(&self) -> Value {
        let mut out = json!({"reason": self.reason, "retryable": self.retryable});
        if let Some(wait) = self.retry_after_ms {
            out["retryAfterMs"] = json!(wait);
        }
        out
    }
}

/// One reason for the whole station: a single tried URL keeps its own reason and
/// policy; several become `all_feeds_failed`, retryable when any feed's reason is,
/// after the shortest of those waits.
pub fn combine(feeds: &[FeedFailure]) -> Combined {
    let Some(last) = feeds.last() else {
        return Combined {
            reason: "all_feeds_failed",
            retryable: false,
            retry_after_ms: None,
        };
    };
    if feeds.iter().all(|feed| feed.index == last.index) {
        return Combined::from_policy(known(&last.reason).unwrap_or("channel_offline"));
    }
    let mut retryable = false;
    let mut retry_after_ms: Option<u64> = None;
    for feed in feeds {
        let policy = policy(&feed.reason);
        if !policy.retryable {
            continue;
        }
        retryable = true;
        if let Some(wait) = policy.retry_after_ms {
            retry_after_ms = Some(retry_after_ms.map_or(wait, |current| current.min(wait)));
        }
    }
    Combined {
        reason: "all_feeds_failed",
        retryable,
        retry_after_ms,
    }
}

/// `--evaluate` adapter: `{fn, input}` exactly as the fixture spells a case.
pub fn evaluate(function: &str, input: &Value) -> Result<Value, String> {
    let status = || -> Result<Option<u16>, String> {
        let value = input["status"].as_f64().ok_or("invalid_status")?;
        // Number.isInteger(status) && status >= 400; anything else is "not a failure".
        Ok(
            (value.fract() == 0.0 && (0.0..=f64::from(u16::MAX)).contains(&value))
                .then_some(value as u16),
        )
    };
    let reason = match function {
        "upstream" => status()?.and_then(|status| {
            classify_upstream(status, input["bodySnippet"].as_str().unwrap_or(""))
        }),
        "guard" => status()?
            .and_then(|status| classify_guard(status, input["diagnostic"].as_str().unwrap_or(""))),
        "stderr" => classify_stderr(
            input["tail"].as_str().ok_or("invalid_tail")?,
            input["source"].as_str().ok_or("invalid_source")?,
            input["producedSegments"].as_bool().unwrap_or(false),
            input["transcoding"].as_bool() == Some(true),
        ),
        "combine" => {
            let feeds: Vec<FeedFailure> =
                serde_json::from_value(input["feeds"].clone()).map_err(|_| "invalid_feeds")?;
            return Ok(combine(&feeds).to_json());
        }
        _ => return Err("unknown_failure_function".into()),
    };
    Ok(reason.map_or(Value::Null, |reason| json!({"reason": reason})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_cases_match() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../src/shared/livetv-failure-reasons.fixture.json"
        ))
        .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 80);
        for case in cases {
            let got = evaluate(case["fn"].as_str().unwrap(), &case["input"]).unwrap();
            assert_eq!(got, case["expected"], "{case}");
        }
    }

    #[test]
    fn hand_matchers_follow_js_semantics() {
        assert!(limit_body("max\u{a0}-_streams"));
        assert!(!limit_body("max\u{85}streams"));
        assert!(limit_body("maximumconnections"));
        assert!(geo_body("geolocation"));
        assert!(!geo_body("geo  block"));
        assert!(contains_word("x tls.", "tls"));
        assert!(!contains_word("httls", "tls"));
        assert!(!server_returned_5xx("server returned 5000"));
        assert!(server_returned_5xx("server returned 502:"));
    }
}

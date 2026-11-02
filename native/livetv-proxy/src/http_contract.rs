// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! HTTP policy boundary shared by the fixture shell and future supervised runtime.
//! It dispatches typed operations; lifecycle results are supplied by a backend.
use serde::Serialize;
use serde_json::{Value, json};

pub const MAX_BODY_SIZE: usize = 64 * 1024;
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Rejection {
    pub status: u16,
    pub body: Value,
}
impl Rejection {
    pub fn error(status: u16, error: &str) -> Self {
        Self {
            status,
            body: json!({"error":error}),
        }
    }
    fn validation(message: &str) -> Self {
        Self {
            status: 400,
            body: json!({"error":"validation_error","message":message}),
        }
    }
}
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "operation", rename_all = "camelCase")]
pub enum Route {
    Status,
    Join {
        channel: String,
    },
    Leave {
        channel: String,
    },
    Kill {
        channel: String,
    },
    Heartbeat {
        channel: String,
    },
    Master {
        channel: String,
    },
    Playlist {
        channel: String,
    },
    Feed {
        channel: String,
    },
    Init {
        channel: String,
    },
    Segment {
        channel: String,
        index: String,
    },
    RungPlaylist {
        channel: String,
        output: String,
    },
    RungSegment {
        channel: String,
        output: String,
        index: String,
    },
    AdaptiveMaster {
        channel: String,
    },
    AdaptivePlaylist {
        channel: String,
        output: String,
    },
    AdaptiveSegment {
        channel: String,
        output: String,
        index: String,
    },
    VariantMaster {
        channel: String,
        variant: String,
    },
    VariantPlaylist {
        channel: String,
        variant: String,
    },
    VariantInit {
        channel: String,
        variant: String,
        name: String,
    },
    VariantSegment {
        channel: String,
        variant: String,
        index: String,
    },
}
pub fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|c| c.is_ascii_digit())
}
fn segment<'a>(value: &'a str, extensions: &[&str]) -> Option<&'a str> {
    let tail = value.strip_prefix("segment-")?;
    let (index, extension) = tail.rsplit_once('.')?;
    (digits(index) && extensions.contains(&extension)).then_some(index)
}
/// Path has already been normalized with WHATWG-equivalent URL parsing. Percent
/// escapes remain encoded, matching the existing ID validation policy.
pub fn route(method: &str, path: &str, egress: bool, adaptive: bool) -> Result<Route, Rejection> {
    if method == "GET" && path == "/status" {
        return Ok(Route::Status);
    }
    let Some(rest) = path.strip_prefix("/streams/") else {
        return Err(Rejection::error(404, "not_found"));
    };
    let Some((channel, sub)) = rest.split_once('/') else {
        return Err(Rejection::error(404, "not_found"));
    };
    if channel.is_empty() {
        return Err(Rejection::error(404, "not_found"));
    }
    if !safe_id(channel) {
        return Err(Rejection::error(400, "invalid_channel_id"));
    }
    let channel = channel.to_owned();
    if method == "GET" {
        if let Some(tail) = sub.strip_prefix("a/") {
            if !adaptive {
                return Err(Rejection::error(404, "adaptive_not_found"));
            }
            if tail == "master.m3u8" {
                return Ok(Route::AdaptiveMaster { channel });
            }
            if let Some((output, file)) = tail.split_once('/')
                && safe_id(output)
            {
                if file == "playlist.m3u8" {
                    return Ok(Route::AdaptivePlaylist {
                        channel,
                        output: output.into(),
                    });
                }
                if let Some(index) = segment(file, &["ts"]) {
                    return Ok(Route::AdaptiveSegment {
                        channel,
                        output: output.into(),
                        index: index.into(),
                    });
                }
            }
            return Err(Rejection::error(400, "invalid_adaptive_path"));
        }
        if let Some(tail) = sub.strip_prefix("r/") {
            let (output, file) = tail.split_once('/').unwrap_or((tail, ""));
            if !safe_id(output) {
                return Err(Rejection::error(400, "invalid_rung_id"));
            }
            let index = segment(file, &["ts"]);
            if file != "playlist.m3u8" && index.is_none() {
                return Err(Rejection::error(400, "invalid_rung_path"));
            }
            if !egress {
                return Err(Rejection::error(404, "rung_not_found"));
            }
            return Ok(match index {
                Some(index) => Route::RungSegment {
                    channel,
                    output: output.into(),
                    index: index.into(),
                },
                None => Route::RungPlaylist {
                    channel,
                    output: output.into(),
                },
            });
        }
        if let Some(tail) = sub.strip_prefix("v/") {
            if let Some((variant, file)) = tail.split_once('/') {
                let init = file == "init.mp4"
                    || file
                        .strip_prefix("init-")
                        .and_then(|v| v.strip_suffix(".mp4"))
                        .is_some_and(digits);
                let index = segment(file, if variant == "fmp4" { &["m4s"] } else { &["ts"] });
                if matches!(variant, "fmp4" | "h264")
                    && (matches!(file, "master.m3u8" | "playlist.m3u8")
                        || (variant == "fmp4" && init)
                        || index.is_some())
                {
                    if !egress {
                        return Err(Rejection::error(404, "rung_not_found"));
                    }
                    let variant = variant.to_owned();
                    return Ok(if file == "master.m3u8" {
                        Route::VariantMaster { channel, variant }
                    } else if file == "playlist.m3u8" {
                        Route::VariantPlaylist { channel, variant }
                    } else if init {
                        Route::VariantInit {
                            channel,
                            variant,
                            name: file.into(),
                        }
                    } else {
                        Route::VariantSegment {
                            channel,
                            variant,
                            index: index.unwrap().into(),
                        }
                    });
                }
            }
            return Err(Rejection::error(400, "invalid_variant_path"));
        }
        return match sub {
            "master.m3u8" => Ok(Route::Master { channel }),
            "playlist.m3u8" => Ok(Route::Playlist { channel }),
            "feed.ts" => Ok(Route::Feed { channel }),
            "init.mp4" => Ok(Route::Init { channel }),
            _ if sub.starts_with("segment-") => segment(sub, &["ts", "m4s"])
                .map(|i| Route::Segment {
                    channel,
                    index: i.into(),
                })
                .ok_or_else(|| Rejection::error(400, "invalid_segment_path")),
            _ => Err(Rejection::error(404, "not_found")),
        };
    }
    match (method, sub) {
        ("POST", "join") => Ok(Route::Join { channel }),
        ("DELETE", "leave") => Ok(Route::Leave { channel }),
        ("DELETE", "kill") => Ok(Route::Kill { channel }),
        ("POST", "heartbeat") => Ok(Route::Heartbeat { channel }),
        _ => Err(Rejection::error(404, "not_found")),
    }
}
fn positive(value: &Value) -> bool {
    value.as_f64().is_some_and(|v| v.is_finite() && v > 0.0)
}
fn rung_error(rung: &Value) -> Option<&'static str> {
    if !rung.is_object() {
        return Some("cap.rung must be an object");
    }
    if !rung["id"].as_str().is_some_and(safe_id) {
        return Some("cap.rung.id must be a safe identifier");
    }
    if !rung["height"]
        .as_f64()
        .is_some_and(|v| v.fract() == 0.0 && v > 0.0 && v <= 4320.0)
    {
        return Some("cap.rung.height must be an integer between 1 and 4320");
    }
    if !positive(&rung["maxBitrate"]) {
        return Some("cap.rung.maxBitrate must be a positive finite number");
    }
    if rung["codec"] != "h264" {
        return Some("cap.rung.codec must be h264");
    }
    None
}
fn cap_error(cap: &Value) -> Option<&'static str> {
    if !cap.is_object() {
        return Some("cap must be an object");
    }
    if let Some(error) = rung_error(&cap["rung"]) {
        return Some(error);
    }
    if cap["rung"]["id"]
        .as_str()
        .is_some_and(|id| id.starts_with("v-"))
    {
        return Some("cap.rung.id must not use the reserved v- prefix");
    }
    if !positive(&cap["requestedMaxBitrate"]) {
        return Some("cap.requestedMaxBitrate must be a positive finite number");
    }
    if !cap["belowLadder"].is_boolean() {
        return Some("cap.belowLadder must be a boolean");
    }
    if !cap["pinned"].is_boolean() {
        return Some("cap.pinned must be a boolean");
    }
    if cap["fallback"] != "refuse" && cap["fallback"] != "source" {
        return Some("cap.fallback must be refuse or source");
    }
    None
}
pub fn validate_join(body: &Value) -> Result<(), Rejection> {
    let error = if !body.is_object() && !body.is_array() {
        Some("Request body must be a JSON object")
    } else if !body["viewerId"].as_str().is_some_and(|v| !v.is_empty()) {
        Some("viewerId is required")
    } else if !body["streamUrls"].as_array().is_some_and(|v| !v.is_empty()) {
        Some("streamUrls must be a non-empty array")
    } else if body
        .get("allowPrivateUrls")
        .is_some_and(|v| !v.is_boolean())
    {
        Some("allowPrivateUrls must be a boolean")
    } else if !body["sourceId"].as_str().is_some_and(|v| !v.is_empty()) {
        Some("sourceId is required")
    } else if !body["maxStreams"].as_f64().is_some_and(|v| v >= 1.0) {
        Some("maxStreams must be a positive number")
    } else if !body["channelName"].as_str().is_some_and(|v| !v.is_empty()) {
        Some("channelName is required")
    } else {
        None
    };
    if let Some(error) = error {
        return Err(Rejection::validation(error));
    }
    if let Some(cap) = body.get("cap")
        && let Some(error) = cap_error(cap)
    {
        return Err(Rejection::validation(error));
    }
    if let Some(adaptive) = body.get("adaptive") {
        if !adaptive.is_object() {
            return Err(Rejection::validation("adaptive must be an object"));
        }
        let Some(rungs) = adaptive["rungs"]
            .as_array()
            .filter(|v| (2..=8).contains(&v.len()))
        else {
            return Err(Rejection::validation(
                "adaptive.rungs must contain between 2 and 8 rungs",
            ));
        };
        for rung in rungs {
            if let Some(error) = rung_error(rung) {
                return Err(Rejection::validation(
                    &error.replace("cap.rung", "adaptive.rungs[]"),
                ));
            }
        }
        if !adaptive["includeOriginal"].is_boolean() {
            return Err(Rejection::validation(
                "adaptive.includeOriginal must be a boolean",
            ));
        }
        if adaptive["fallback"] != "refuse" && adaptive["fallback"] != "source" {
            return Err(Rejection::validation(
                "adaptive.fallback must be refuse or source",
            ));
        }
    }
    if body.get("cap").is_some() && body.get("adaptive").is_some() {
        return Err(Rejection::validation(
            "cap and adaptive are mutually exclusive",
        ));
    }
    if body.get("awaitReadyMs").is_some_and(|v| !v.is_number()) {
        return Err(Rejection::validation("awaitReadyMs must be a number"));
    }
    if body.get("feedIds").is_some_and(|v| {
        !v.as_array()
            .is_some_and(|ids| ids.iter().all(Value::is_string))
    }) {
        return Err(Rejection::validation("feedIds must be an array of strings"));
    }
    if let Some(client) = body.get("client")
        && (!client.is_object()
            || !matches!(client["hevc"].as_str(), Some("any" | "fmp4" | "none")))
    {
        return Err(Rejection::validation(
            "client.hevc must be any, fmp4 or none",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod reserved_rung_tests {
    use super::{cap_error, rung_error};
    use serde_json::json;

    #[test]
    fn fixed_rungs_reserve_compat_prefix_but_keep_adaptive_prefix_valid() {
        for id in ["v-fmp4", "v-h264", "v-custom", "a-custom", "original"] {
            let cap = json!({
                "rung": { "id": id, "height": 720, "maxBitrate": 4_000_000, "codec": "h264" },
                "requestedMaxBitrate": 4_000_000,
                "belowLadder": false,
                "pinned": false,
                "fallback": "refuse"
            });
            assert_eq!(cap_error(&cap).is_some(), id.starts_with("v-"));
            // Adaptive IDs have their own URL/output namespace.
            assert_eq!(rung_error(&cap["rung"]), None);
        }
    }
}

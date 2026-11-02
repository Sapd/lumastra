// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Ready-state serving policies. An empty/warming playlist returns Wait for the
//! runtime's cancellable deadline handling; this module never launches a process.
use crate::{
    http_contract::{Rejection, Route},
    masters,
    playlist::{self, PlaylistOptions, Segment},
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaSnapshot {
    pub ingest: BTreeMap<String, Source>,
    pub egress: BTreeMap<String, Source>,
    pub adaptive: BTreeMap<String, Source>,
    pub variants: BTreeMap<String, Value>,
    pub probes: BTreeMap<String, Value>,
    pub observed: BTreeMap<String, f64>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Source {
    pub segments: Option<Vec<StoredSegment>>,
    pub init: BTreeMap<String, Vec<u8>>,
    pub options: PlaylistOptions,
    pub failing_over: bool,
    /// Fixture host only: postpone playlist availability without changing data bytes.
    pub playlist_ready_after_ms: u64,
}
#[derive(Deserialize)]
pub struct StoredSegment {
    pub index: u64,
    pub duration: f64,
    pub data: Vec<u8>,
}
pub enum MediaResponse {
    Json(Rejection),
    Bytes {
        content_type: &'static str,
        cache_control: &'static str,
        body: Vec<u8>,
    },
    Wait,
}
fn error(code: &str) -> MediaResponse {
    MediaResponse::Json(Rejection::error(404, code))
}
fn bytes(body: Vec<u8>, content_type: &'static str, cache_control: &'static str) -> MediaResponse {
    MediaResponse::Bytes {
        body,
        content_type,
        cache_control,
    }
}
fn playlist(source: Option<&Source>, missing: &str) -> MediaResponse {
    let Some(source) = source else {
        return error(missing);
    };
    let Some(segments) = &source.segments else {
        return if source.failing_over {
            MediaResponse::Wait
        } else {
            error(missing)
        };
    };
    let entries: Vec<Segment> = segments
        .iter()
        .map(|s| Segment {
            index: s.index,
            duration: s.duration,
        })
        .collect();
    match playlist::render_playlist(&entries, &source.options) {
        Some(body) => bytes(
            body.into_bytes(),
            "application/vnd.apple.mpegurl",
            "no-cache",
        ),
        None => MediaResponse::Wait,
    }
}
fn segment(
    source: Option<&Source>,
    index: &str,
    missing: &str,
    content_type: &'static str,
    cache: &'static str,
) -> MediaResponse {
    let numeric = index.parse::<f64>().unwrap_or(f64::INFINITY);
    if !numeric.is_finite() || numeric.fract() != 0.0 || numeric < 0.0 {
        return MediaResponse::Json(Rejection::error(400, "invalid_segment_index"));
    }
    let Some(segments) = source.and_then(|s| s.segments.as_ref()) else {
        return error(missing);
    };
    let Some(segment) = segments.iter().find(|s| s.index as f64 == numeric) else {
        return error("segment_not_found");
    };
    bytes(segment.data.clone(), content_type, cache)
}
fn init(
    source: Option<&Source>,
    name: &str,
    require_channel: bool,
    cache: &'static str,
) -> MediaResponse {
    if require_channel && source.and_then(|s| s.segments.as_ref()).is_none() {
        return error("rung_not_found");
    }
    match source.and_then(|s| s.init.get(name)) {
        Some(data) => bytes(data.clone(), "video/mp4", cache),
        None => error("init_segment_not_ready"),
    }
}
fn rung_key(channel: &str, output: &str) -> String {
    format!("{channel}::{output}")
}
pub fn respond(snapshot: &MediaSnapshot, route: &Route) -> Option<MediaResponse> {
    Some(match route {
        Route::Master { channel } => {
            if snapshot
                .ingest
                .get(channel)
                .and_then(|s| s.segments.as_ref())
                .is_none()
            {
                error("channel_not_found")
            } else {
                bytes(
                    playlist::master_playlist().as_bytes().to_vec(),
                    "application/vnd.apple.mpegurl",
                    "no-cache",
                )
            }
        }
        Route::Playlist { channel } => playlist(snapshot.ingest.get(channel), "channel_not_found"),
        Route::Init { channel } => init(
            snapshot.ingest.get(channel),
            "init.mp4",
            false,
            "public, max-age=3600",
        ),
        Route::Segment { channel, index } => segment(
            snapshot.ingest.get(channel),
            index,
            "channel_not_found",
            "video/MP2T",
            "public, max-age=3600",
        ),
        Route::RungPlaylist { channel, output } => playlist(
            snapshot.egress.get(&rung_key(channel, output)),
            "rung_not_found",
        ),
        Route::RungSegment {
            channel,
            output,
            index,
        } => {
            let source = snapshot.egress.get(&rung_key(channel, output));
            segment(
                source,
                index,
                "rung_not_found",
                if source.is_some_and(|s| s.options.fmp4) {
                    "video/mp4"
                } else {
                    "video/MP2T"
                },
                "no-cache",
            )
        }
        Route::AdaptivePlaylist { channel, output } => playlist(
            snapshot.adaptive.get(&rung_key(channel, output)),
            "rung_not_found",
        ),
        Route::AdaptiveSegment {
            channel,
            output,
            index,
        } => segment(
            snapshot.adaptive.get(&rung_key(channel, output)),
            index,
            "rung_not_found",
            "video/MP2T",
            "no-cache",
        ),
        Route::AdaptiveMaster { channel } => match snapshot.variants.get(channel) {
            Some(variants) => match masters::adaptive(
                variants,
                snapshot.probes.get(channel).unwrap_or(&Value::Null),
                snapshot.observed.get(channel).copied(),
            ) {
                Ok(body) => bytes(
                    body.into_bytes(),
                    "application/vnd.apple.mpegurl",
                    "no-cache",
                ),
                Err(_) => error("adaptive_not_found"),
            },
            None => error("adaptive_not_found"),
        },
        Route::VariantPlaylist { channel, variant } => playlist(
            snapshot
                .egress
                .get(&rung_key(channel, &format!("v-{variant}"))),
            "rung_not_found",
        ),
        Route::VariantInit {
            channel,
            variant,
            name,
        } => init(
            snapshot
                .egress
                .get(&rung_key(channel, &format!("v-{variant}"))),
            name,
            true,
            "no-cache",
        ),
        Route::VariantSegment {
            channel,
            variant,
            index,
        } => segment(
            snapshot
                .egress
                .get(&rung_key(channel, &format!("v-{variant}"))),
            index,
            "rung_not_found",
            if variant == "fmp4" {
                "video/mp4"
            } else {
                "video/MP2T"
            },
            "no-cache",
        ),
        Route::VariantMaster { channel, variant } => {
            let source = snapshot
                .egress
                .get(&rung_key(channel, &format!("v-{variant}")));
            if source.and_then(|s| s.segments.as_ref()).is_none() {
                error("rung_not_found")
            } else {
                match masters::variant(
                    variant,
                    snapshot.probes.get(channel).unwrap_or(&Value::Null),
                    source
                        .and_then(|s| s.init.get("init.mp4"))
                        .map(Vec::as_slice),
                    snapshot.observed.get(channel).copied(),
                ) {
                    Ok(body) => bytes(
                        body.into_bytes(),
                        "application/vnd.apple.mpegurl",
                        "no-cache",
                    ),
                    Err(_) => error("rung_not_found"),
                }
            }
        }
        _ => return None,
    })
}

/// Fixture timing is deliberately outside the ready-state renderer. The actual
/// runtime supplies current source state instead of fabricating segment arrivals.
pub fn playlist_source<'a>(snapshot: &'a MediaSnapshot, route: &Route) -> Option<&'a Source> {
    match route {
        Route::Playlist { channel } => snapshot.ingest.get(channel),
        Route::RungPlaylist { channel, output } => snapshot.egress.get(&rung_key(channel, output)),
        Route::AdaptivePlaylist { channel, output } => {
            snapshot.adaptive.get(&rung_key(channel, output))
        }
        Route::VariantPlaylist { channel, variant } => snapshot
            .egress
            .get(&rung_key(channel, &format!("v-{variant}"))),
        _ => None,
    }
}
pub fn playlist_timeout_error(snapshot: &MediaSnapshot, route: &Route) -> &'static str {
    if playlist_source(snapshot, route).is_some_and(|s| s.segments.is_none()) {
        if matches!(route, Route::Playlist { .. }) {
            "channel_not_found"
        } else {
            "rung_not_found"
        }
    } else {
        "no_segments"
    }
}

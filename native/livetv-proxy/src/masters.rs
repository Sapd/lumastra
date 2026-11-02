// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use crate::codecs;
use serde_json::Value;

pub fn adaptive_width(source_width: f64, source_height: f64, target_height: f64) -> Option<f64> {
    if source_width <= 0.0 || source_height <= 0.0 || target_height <= 0.0 {
        return None;
    }
    Some(((source_width * target_height / source_height / 2.0).round() * 2.0).max(2.0))
}
fn positive_rate(observed: Option<f64>, fallback: f64) -> f64 {
    observed
        .filter(|v| *v > 0.0)
        .map(f64::round)
        .unwrap_or(fallback)
}
fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}
pub fn adaptive(variants: &Value, probe: &Value, observed: Option<f64>) -> Result<String, String> {
    let rungs = variants["rungs"].as_array().ok_or("invalid_variants")?;
    let video = probe.get("video").filter(|v| !v.is_null());
    let mut lines = vec![
        "#EXTM3U".into(),
        "#EXT-X-VERSION:3".into(),
        "#EXT-X-INDEPENDENT-SEGMENTS".into(),
    ];
    for rung in rungs {
        let height = number(&rung["height"]);
        let width =
            video.and_then(|v| adaptive_width(number(&v["width"]), number(&v["height"]), height));
        let resolution = width
            .map(|w| format!(",RESOLUTION={w}x{height}"))
            .unwrap_or_default();
        lines.push(format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={}{}",
            number(&rung["maxBitrate"]),
            resolution
        ));
        lines.push(format!(
            "{}/playlist.m3u8",
            rung["id"].as_str().ok_or("invalid_rung_id")?
        ));
    }
    if variants["includesOriginal"] == true {
        let resolution = video
            .map(|v| {
                format!(
                    ",RESOLUTION={}x{}",
                    number(&v["width"]),
                    number(&v["height"])
                )
            })
            .unwrap_or_default();
        lines.push(format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={}{}",
            positive_rate(observed, 12000000.0),
            resolution
        ));
        lines.push("original/playlist.m3u8".into());
    }
    lines.push(String::new());
    Ok(lines.join("\n"))
}
pub fn variant(
    variant: &str,
    probe: &Value,
    init: Option<&[u8]>,
    observed: Option<f64>,
) -> Result<String, String> {
    let video = (probe["success"] == true)
        .then(|| probe.get("video"))
        .flatten()
        .filter(|v| !v.is_null());
    let mut attrs = Vec::new();
    match variant {
        "fmp4" => {
            attrs.push(format!("BANDWIDTH={}", positive_rate(observed, 20000000.0)));
            let from_init = init.map(codecs::codecs_from_init);
            let video_codec = from_init
                .as_ref()
                .and_then(|v| v["video"].as_str())
                .map(String::from)
                .or_else(|| {
                    video.filter(|v| v["codec"] == "hevc").and_then(|v| {
                        codecs::hevc_from_probe(v["profile"].as_str(), v["level"].as_f64())
                    })
                });
            if let Some(video_codec) = video_codec {
                let audio_codec = if init.is_some() {
                    from_init.as_ref().and_then(|v| v["audio"].as_str())
                } else if probe["success"] == true && !probe["audio"].is_null() {
                    Some("mp4a.40.2")
                } else {
                    None
                };
                attrs.push(format!(
                    "CODECS=\"{}\"",
                    audio_codec
                        .map(|a| format!("{video_codec},{a}"))
                        .unwrap_or(video_codec)
                ));
            }
            if let Some(v) =
                video.filter(|v| number(&v["width"]) > 0.0 && number(&v["height"]) > 0.0)
            {
                attrs.push(format!(
                    "RESOLUTION={}x{}",
                    number(&v["width"]),
                    number(&v["height"])
                ));
            }
            if codecs::video_range(video.and_then(|v| v["colorTransfer"].as_str())) == "SDR" {
                attrs.push("VIDEO-RANGE=SDR".into());
            }
        }
        "h264" => {
            attrs.push("BANDWIDTH=8000000".into());
            if let Some(v) = video {
                let height = number(&v["height"]).min(1080.0);
                if let Some(width) =
                    adaptive_width(number(&v["width"]), number(&v["height"]), height)
                {
                    attrs.push(format!("RESOLUTION={width}x{height}"));
                }
            }
            attrs.push("VIDEO-RANGE=SDR".into());
        }
        _ => return Err("invalid_variant".into()),
    }
    Ok(format!(
        "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:{}\nplaylist.m3u8\n",
        attrs.join(",")
    ))
}

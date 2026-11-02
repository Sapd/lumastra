// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use crate::config::ProxyConfig;
use serde_json::{Value, json};

fn encoder(gpu: &str, target: &str) -> String {
    match gpu {
        "none" => {
            if target == "hevc" {
                "libx265".into()
            } else {
                "libx264".into()
            }
        }
        "nvenc" | "qsv" | "vaapi" | "amf" | "videotoolbox" => {
            format!("{}_{gpu}", if target == "hevc" { "hevc" } else { "h264" })
        }
        _ => unreachable!("configuration validates GPU"),
    }
}

pub fn transcode_decision(probe: &Value, config: &ProxyConfig) -> Value {
    let video = &probe["video"];
    let codec = video["codec"].as_str();
    let interlaced = video["interlaced"].as_bool().unwrap_or(false);
    let mut result = json!({
        "sourceCodec": codec,
        "sourceHdr": video["hdr"].as_bool().unwrap_or(false),
        "sourceInterlaced": interlaced,
    });
    let success = probe["success"].as_bool().unwrap_or(false) && !video.is_null();
    let safe = matches!(codec, Some("h264" | "hevc"));
    let (action, target, deint, reason) = if !success {
        (
            "transcode",
            config.target_codec.as_str(),
            config.deinterlace_filter != "none",
            format!(
                "Probe failed ({}) — falling back to always-transcode",
                probe["error"].as_str().unwrap_or("no video stream")
            ),
        )
    } else if config.transcode_mode == "always" {
        (
            "transcode",
            config.target_codec.as_str(),
            interlaced && config.deinterlace_filter != "none",
            "Config: transcodeMode=always — forcing transcode".into(),
        )
    } else if config.transcode_mode == "remux" {
        (
            "copy",
            config.target_codec.as_str(),
            false,
            "Config: transcodeMode=remux — forcing copy".into(),
        )
    } else if safe && !interlaced {
        if codec == Some("hevc") && !config.allow_hevc_passthrough {
            (
                "transcode",
                "h264",
                false,
                "HEVC passthrough disabled — transcoding hevc progressive to H.264".into(),
            )
        } else {
            (
                "copy",
                config.target_codec.as_str(),
                false,
                format!(
                    "Remux: {} progressive — zero CPU, HDR preserved",
                    codec.unwrap_or("unknown")
                ),
            )
        }
    } else if safe {
        (
            "transcode",
            config.target_codec.as_str(),
            config.deinterlace_filter != "none",
            format!(
                "Transcode: {} interlaced — deinterlace required for browser MSE",
                codec.unwrap_or("unknown")
            ),
        )
    } else {
        (
            "transcode",
            config.target_codec.as_str(),
            interlaced && config.deinterlace_filter != "none",
            format!(
                "Transcode: {} is not browser-safe — re-encoding to {}",
                codec.unwrap_or("unknown"),
                config.target_codec
            ),
        )
    };
    let audio_action =
        if success && config.audio_passthrough && probe["audio"]["codec"].as_str() == Some("aac") {
            "copy"
        } else {
            "transcode"
        };
    result["videoAction"] = json!(action);
    result["audioAction"] = json!(audio_action);
    result["videoEncoder"] = if action == "copy" {
        Value::Null
    } else {
        json!(encoder(&config.gpu, target))
    };
    result["deinterlace"] = json!(deint);
    result["deinterlaceFilterName"] = if deint {
        json!(config.deinterlace_filter)
    } else {
        Value::Null
    };
    result["reason"] = json!(reason);
    result
}

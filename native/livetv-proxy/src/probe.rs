// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use serde_json::{Value, json};

fn failure() -> Value {
    json!({"success":false,"error":"Failed to parse ffprobe output","video":null,"audio":null})
}
fn field(raw: &Value, name: &str, fallback: Value) -> Value {
    raw.get(name)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(fallback)
}
fn optional_text(raw: &Value, name: &str) -> Result<Option<String>, ()> {
    match raw.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(v)) => Ok(Some(v.clone())),
        _ => Err(()),
    }
}

/// Parse the ffprobe JSON boundary without performing I/O or spawning processes.
pub fn parse(stdout: &str) -> Value {
    let Ok(parsed) = serde_json::from_str::<Value>(stdout) else {
        return failure();
    };
    let Some(streams) = parsed.get("streams").and_then(Value::as_array) else {
        return json!({"success":true,"video":null,"audio":null});
    };
    // A null stream entry throws during TS Array.find; preserve that failure rather
    // than accepting a different stream and hiding malformed probe output.
    let mut video = None;
    for raw in streams {
        if raw.is_null() {
            return failure();
        }
        if raw["codec_type"] == "video" {
            video = Some(raw);
            break;
        }
    }
    let mut audio = None;
    for raw in streams {
        if raw.is_null() {
            return failure();
        }
        if raw["codec_type"] == "audio" {
            audio = Some(raw);
            break;
        }
    }
    let video = if let Some(raw) = video {
        let (Ok(field_order), Ok(transfer), Ok(pixel_format)) = (
            optional_text(raw, "field_order"),
            optional_text(raw, "color_transfer"),
            optional_text(raw, "pix_fmt"),
        ) else {
            return failure();
        };
        let interlaced = field_order
            .as_ref()
            .is_some_and(|v| ["tt", "bb", "tb", "bt"].contains(&v.to_lowercase().as_str()));
        let hdr = transfer.as_ref().is_some_and(|v| {
            ["smpte2084", "st2084", "arib-std-b67", "hlg"].contains(&v.to_lowercase().as_str())
        });
        let depth = pixel_format
            .as_ref()
            .map(|v| {
                if v.contains("10") {
                    10
                } else if v.contains("12") {
                    12
                } else {
                    8
                }
            })
            .unwrap_or(8);
        let level = raw
            .get("level")
            .filter(|v| v.as_f64().is_some_and(|v| v > 0.0))
            .cloned()
            .unwrap_or(Value::Null);
        json!({"codec":field(raw,"codec_name",json!("unknown")),"width":field(raw,"width",json!(0)),"height":field(raw,"height",json!(0)),"interlaced":interlaced,"hdr":hdr,"bitDepth":depth,"pixelFormat":pixel_format,"colorTransfer":transfer,"colorSpace":field(raw,"color_space",Value::Null),"profile":field(raw,"profile",Value::Null),"level":level,"fieldOrder":field_order})
    } else {
        Value::Null
    };
    let audio = audio.map(|raw| json!({"codec":field(raw,"codec_name",json!("unknown")),"channels":field(raw,"channels",json!(2))})).unwrap_or(Value::Null);
    json!({"success":true,"video":video,"audio":audio})
}

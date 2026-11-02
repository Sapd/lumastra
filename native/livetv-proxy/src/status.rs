// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
type EncoderRows = Vec<(String, Vec<Value>)>;

/// Read-only manager boundary. Supervisors will provide these values; fixtures
/// exercise exactly the same renderer without launching an ingest process.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusSnapshot {
    pub channels: Vec<(String, Value)>,
    pub mux: Value,
    pub egress: Option<EncoderRows>,
    pub adaptive: Option<EncoderRows>,
    pub capacity: Option<Value>,
    pub ffmpeg_available: bool,
}
fn encoders(source: &Option<EncoderRows>, id: &str) -> Vec<Value> {
    source
        .as_ref()
        .and_then(|s| s.iter().find(|(key, _)| key == id).map(|(_, value)| value))
        .cloned()
        .unwrap_or_default()
}
/// `started_at` is the process start (ISO-8601), used for a terminal row without one.
pub fn render(
    snapshot: &StatusSnapshot,
    detailed: bool,
    shutting_down: bool,
    uptime: u64,
    started_at: &str,
) -> Value {
    let include_encoders = detailed && (snapshot.egress.is_some() || snapshot.adaptive.is_some());
    let mux_channels = snapshot.mux["channels"].as_array();
    let mut channels = Vec::new();
    for (id, row) in &snapshot.channels {
        let Some(mut row) = row.as_object().cloned() else {
            continue;
        };
        if let Some(mux) = mux_channels.and_then(|rows| rows.iter().find(|v| v["channelId"] == *id))
        {
            for field in [
                "viewers",
                "channelName",
                "sourceId",
                "failoverCount",
                "streamUrlIndex",
            ] {
                if let Some(value) = mux.get(field) {
                    row.insert(field.into(), value.clone());
                } else {
                    row.remove(field);
                }
            }
            for field in ["lastFailureReason", "terminal"] {
                if let Some(value) = mux.get(field) {
                    row.insert(field.into(), value.clone());
                }
            }
            if mux["terminal"] == true {
                row.insert("failoverExhausted".into(), json!(true));
                for field in ["streamUrlIndex", "failoverCount"] {
                    match mux.get(field) {
                        Some(value) => row.insert(field.into(), value.clone()),
                        None => row.remove(field),
                    };
                }
            }
        }
        if !include_encoders {
            for field in [
                "outputDiagnostics",
                "activeStreamUrl",
                "ffmpegError",
                "probeResult",
                "encoders",
                "transcodeDecision",
            ] {
                row.remove(field);
            }
        } else {
            let health = match row.get("ffmpegHealth").and_then(Value::as_str) {
                Some("healthy") => "healthy",
                Some("degraded") => "degraded",
                _ => "failed",
            };
            let mut ingest = json!({"kind":"ingest","channelId":id,"outputs":["source"],"viewers":0,"health":health,"reservedOutputs":0});
            if let Some(started) = row.get("startedAt") {
                ingest["startedAt"] = started.clone();
            }
            let mut inventory = vec![ingest];
            inventory.extend(encoders(&snapshot.egress, id));
            inventory.extend(encoders(&snapshot.adaptive, id));
            row.insert("encoders".into(), json!(inventory));
        }
        channels.push(Value::Object(row));
    }
    // A terminal channel whose ingest was already stopped is no longer an ingest
    // channel, but it is still registered (HLS answers 410 until a new join): list it.
    for mux in mux_channels.into_iter().flatten() {
        let Some(id) = mux["channelId"].as_str() else {
            continue;
        };
        if mux["terminal"] != true || snapshot.channels.iter().any(|(key, _)| key == id) {
            continue;
        }
        let mut row = json!({"channelId":id,"channelName":mux["channelName"],"viewers":mux["viewers"],"sourceId":mux["sourceId"],"ffmpegHealthy":false,"ffmpegHealth":"error","startedAt":mux.get("startedAt").cloned().unwrap_or_else(|| json!(started_at)),"streamUrlIndex":mux["streamUrlIndex"],"failoverExhausted":true,"failoverCount":mux["failoverCount"],"segmentCount":0,"terminal":true});
        let object = row.as_object_mut().expect("object literal");
        object.retain(|_, value| !value.is_null());
        if let Some(reason) = mux.get("lastFailureReason") {
            object.insert("lastFailureReason".into(), reason.clone());
        }
        channels.push(row);
    }
    let mut status = json!({"healthy":!shutting_down,"uptime":uptime,"activeChannels":snapshot.channels.len(),"totalViewers":snapshot.mux.get("totalViewers").cloned().unwrap_or(json!(0)),"ffmpegAvailable":snapshot.ffmpeg_available,"channels":channels,"perSourceLimits":if detailed {snapshot.mux.get("perSourceLimits").cloned().unwrap_or(json!([]))} else {json!([])}});
    if detailed {
        if let Some(capacity) = &snapshot.capacity {
            status["egressCapacity"] =
                json!({"used":capacity["activeOutputs"],"limit":capacity["limit"]});
        }
        // Preserve TS inventory order and duplicate IDs across manager lists.
        let mut orphaned = Vec::new();
        for manager in [&snapshot.egress, &snapshot.adaptive].into_iter().flatten() {
            for (id, _) in manager
                .iter()
                .filter(|(id, _)| !snapshot.channels.iter().any(|(key, _)| key == id))
            {
                orphaned.extend(encoders(&snapshot.egress, id));
                orphaned.extend(encoders(&snapshot.adaptive, id));
            }
        }
        if !orphaned.is_empty() {
            status["orphanedEncoders"] = json!(orphaned);
        }
    }
    status
}

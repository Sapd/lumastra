// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

pub mod args;
pub mod auth;
pub mod codecs;
pub mod config;
pub mod contract_server;
pub mod decision;
pub mod failure_reason;
pub mod filter_probe;
pub mod hdr;
pub mod http_contract;
pub mod ingest_args;
pub mod js;
pub mod masters;
pub mod media;
pub mod mp4;
pub mod output_diagnostics;
pub mod playlist;
pub mod playlist_wait;
pub mod probe;
pub mod runtime_budget;
pub mod runtime_connections;
pub mod runtime_coordinator;
pub mod runtime_feed;
pub mod runtime_generations;
pub mod runtime_host;
pub mod runtime_ingest;
pub mod runtime_media;
pub mod runtime_operations;
pub mod runtime_outputs;
pub mod runtime_server;
pub mod status;
#[cfg(all(test, unix))]
pub(crate) mod test_support;
pub mod upstream;

use config::{Environment, ProxyConfig};
use serde_json::{Value, json};

/// Test-only pure-contract adapter. This is deliberately not a control/media server.
pub fn evaluate(input: &Value) -> Result<Value, String> {
    let env: Environment =
        serde_json::from_value(input.get("env").cloned().unwrap_or_else(|| json!({})))
            .map_err(|_| "invalid_environment")?;
    let config = ProxyConfig::from_env(&env);
    match input["op"].as_str() {
        Some("adaptiveMaster") => Ok(json!(masters::adaptive(
            &input["variants"],
            &input["probe"],
            input["observed"].as_f64()
        )?)),
        Some("variantMaster") => {
            let init: Option<Vec<u8>> =
                serde_json::from_value(input.get("init").cloned().unwrap_or(Value::Null))
                    .map_err(|_| "invalid_init")?;
            Ok(json!(masters::variant(
                input["variant"].as_str().ok_or("invalid_variant")?,
                &input["probe"],
                init.as_deref(),
                input["observed"].as_f64()
            )?))
        }
        Some("probeRaw") => Ok(probe::parse(
            input["stdout"].as_str().ok_or("invalid_stdout")?,
        )),
        Some("status") => {
            let snapshot = serde_json::from_value(input["snapshot"].clone())
                .map_err(|_| "invalid_status_snapshot")?;
            Ok(status::render(
                &snapshot,
                input["detailed"].as_bool().unwrap_or(false),
                input["shuttingDown"].as_bool().unwrap_or(false),
                input["uptime"].as_u64().unwrap_or(0),
                input["startedAt"].as_str().unwrap_or(""),
            ))
        }
        Some("failure_reason") => failure_reason::evaluate(
            input["fn"].as_str().ok_or("invalid_failure_function")?,
            &input["input"],
        ),
        Some("route") => {
            let route = http_contract::route(
                input["method"].as_str().unwrap_or("GET"),
                input["path"].as_str().unwrap_or("/"),
                input["egress"].as_bool().unwrap_or(false),
                input["adaptive"].as_bool().unwrap_or(false),
            );
            Ok(match route {
                Ok(route) => json!({"route":route}),
                Err(error) => json!({"rejection":error}),
            })
        }
        Some("joinValidation") => Ok(match http_contract::validate_join(&input["body"]) {
            Ok(()) => Value::Null,
            Err(error) => json!(error),
        }),
        Some("ingestArgs") => Ok(json!(ingest_args::build(
            input["url"].as_str().ok_or("invalid_url")?,
            input["directory"].as_str().ok_or("invalid_directory")?,
            &input["decision"],
            &config
        )?)),
        Some("filterPolicy") => {
            let policy = hdr::HdrPolicy::new(filter_probe::parse_filters(
                input["stdout"].as_str().ok_or("invalid_stdout")?.as_bytes(),
            ));
            Ok(json!(policy.resolve(
                input["gpu"].as_str().unwrap_or("none"),
                input["platform"].as_str().unwrap_or("linux"),
                0
            )))
        }
        Some("hdrTrace") => {
            let filters =
                serde_json::from_value(input["filters"].clone()).map_err(|_| "invalid_filters")?;
            let mut policy = hdr::HdrPolicy::new(filters);
            let mut results = Vec::new();
            for event in input["events"].as_array().ok_or("invalid_events")? {
                let now = event["now"].as_i64().ok_or("invalid_time")?;
                if event["action"] == "failure" {
                    policy.note_failure(
                        event["producedSegments"].as_bool().unwrap_or(false),
                        event["stderr"].as_str().unwrap_or(""),
                        event["channel"].as_str().unwrap_or("unknown"),
                        now,
                    );
                } else {
                    results.push(policy.resolve(
                        event["gpu"].as_str().unwrap_or("none"),
                        event["platform"].as_str().unwrap_or("linux"),
                        now,
                    ));
                }
            }
            Ok(json!(results))
        }
        Some("mp4") => {
            let chunks: Vec<Vec<u8>> =
                serde_json::from_value(input["chunks"].clone()).map_err(|_| "invalid_chunks")?;
            let reset_at: Vec<usize> =
                serde_json::from_value(input.get("resetAt").cloned().unwrap_or_else(|| json!([])))
                    .map_err(|_| "invalid_reset")?;
            let mut parser = mp4::Mp4Parser::default();
            let mut parsed = Vec::new();
            let mut segments = Vec::new();
            for (index, chunk) in chunks.iter().enumerate() {
                if reset_at.contains(&index) {
                    parser.reset();
                }
                let boxes = parser.push(chunk)?;
                parsed.extend(boxes.clone());
                segments.extend(parser.process(boxes)?);
            }
            Ok(json!({"boxes": parsed, "segments": segments, "init": parser.init_segment()}))
        }
        Some("egressArgs") => {
            let options: args::Egress = serde_json::from_value(input["options"].clone())
                .map_err(|_| "invalid_egress_options")?;
            Ok(json!(args::egress(&options)))
        }
        Some("remuxArgs") => {
            let options: args::Common = serde_json::from_value(input["options"].clone())
                .map_err(|_| "invalid_remux_options")?;
            Ok(json!(args::remux(&options, input["codec"].as_str())))
        }
        Some("adaptiveArgs") => {
            let options: args::Adaptive = serde_json::from_value(input["options"].clone())
                .map_err(|_| "invalid_adaptive_options")?;
            Ok(json!(args::adaptive(&options)?))
        }
        Some("hdrReserved") => Ok(json!(args::hdr_reserved_outputs(
            input["outputs"].as_u64().ok_or("invalid_outputs")?,
            input["hdr"].as_bool().ok_or("invalid_hdr")?,
            input["limit"].as_u64().ok_or("invalid_limit")?
        ))),
        Some("config") => serde_json::to_value(config).map_err(|e| e.to_string()),
        Some("upstreamEnv") => Ok(json!(config::upstream_environment(
            &env,
            input["proxy"].as_str().unwrap_or(""),
            input["localRelay"].as_bool().unwrap_or(false)
        ))),
        Some("protocols") => Ok(json!(config::protocol_whitelist_for(
            input["url"].as_str().unwrap_or("")
        ))),
        Some("auth") => Ok(json!(auth::validate_auth(
            env.get("STREAM_PROXY_SECRET").map(String::as_str),
            env.get("NODE_ENV").is_some_and(|v| v == "production"),
            input["provided"].as_str()
        ))),
        Some("decision") => Ok(decision::transcode_decision(&input["probe"], &config)),
        Some("playlist") => {
            let segments: Vec<playlist::Segment> =
                serde_json::from_value(input.get("segments").cloned().unwrap_or_else(|| json!([])))
                    .map_err(|_| "invalid_segments")?;
            let options: playlist::PlaylistOptions =
                serde_json::from_value(input.get("options").cloned().unwrap_or_else(|| json!({})))
                    .map_err(|_| "invalid_playlist_options")?;
            Ok(json!(playlist::render_playlist(&segments, &options)))
        }
        Some("master") => Ok(json!(playlist::master_playlist())),
        Some("segmentOrder") => {
            let files =
                serde_json::from_value(input["files"].clone()).map_err(|_| "invalid_files")?;
            Ok(json!(playlist::in_segment_order(files)))
        }
        Some("codecs") => {
            let bytes: Vec<u8> =
                serde_json::from_value(input["bytes"].clone()).map_err(|_| "invalid_bytes")?;
            Ok(codecs::codecs_from_init(&bytes))
        }
        Some("hevcProbe") => Ok(json!(codecs::hevc_from_probe(
            input["profile"].as_str(),
            input["level"].as_f64()
        ))),
        Some("videoRange") => Ok(json!(codecs::video_range(input["transfer"].as_str()))),
        _ => Err("unknown_operation".into()),
    }
}

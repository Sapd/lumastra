// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const GUARDED_INPUT_FORMATS: &str = "hls,mpegts,mov,matroska,avi,flv,mp3,aac,ogg,wav,flac";
pub const FFMPEG_PROTOCOL_WHITELIST: &str =
    "http,https,tcp,tls,crypto,rtp,udp,rtsp,rtmp,rtmpt,rtmpe,rtmps,rtmpte,rtmpts";
pub const LIVE_HLS_SEGMENT_DURATION_S: u64 = 3;
pub const LIVE_HLS_RING_CAPACITY: usize = 10;
pub const LIVE_HLS_FLAGS: &str = "delete_segments+append_list+independent_segments+temp_file";
pub type Environment = BTreeMap<String, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub transcode_mode: String,
    pub gpu: String,
    pub allow_hevc_passthrough: bool,
    pub target_codec: String,
    pub crf: i64,
    pub preset: String,
    pub deinterlace_filter: String,
    pub audio_passthrough: bool,
    pub ffprobe_path: String,
    pub ffmpeg_path: String,
    pub vaapi_device: String,
    pub nvenc_preset: String,
    pub nvenc_cq: i64,
    pub amf_quality: String,
    pub probe_timeout_ms: i64,
    pub upstream_proxy_url: String,
    pub max_egress_encoders: i64,
}

// JavaScript parseInt(value, 10) accepts leading whitespace, a sign and an integer
// prefix ("12ms" => 12, "1e3" => 1). Rust's strict parse must not change env policy.
pub fn parse_decimal_prefix(value: &str) -> Option<i64> {
    let text = crate::js::trim_start(value);
    let end = text
        .char_indices()
        .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '+' || *c == '-')))
        .map(|(i, c)| i + c.len_utf8())
        .last()?;
    text[..end].parse().ok().or_else(|| {
        let digits = text[..end].trim_start_matches(['+', '-']);
        if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
            Some(if text.starts_with('-') {
                i64::MIN
            } else {
                i64::MAX
            })
        } else {
            None
        }
    })
}

fn text(env: &Environment, key: &str, fallback: &str) -> String {
    env.get(key)
        .map(|v| crate::js::trim(v))
        .filter(|v| !v.is_empty())
        .unwrap_or(fallback)
        .to_string()
}
fn choice(env: &Environment, key: &str, fallback: &str, valid: &[&str]) -> String {
    let value = text(env, key, fallback).to_lowercase();
    if valid.contains(&value.as_str()) {
        value
    } else {
        fallback.into()
    }
}
fn boolean(env: &Environment, key: &str, fallback: bool) -> bool {
    match env
        .get(key)
        .map(|v| crate::js::trim(v).to_lowercase())
        .as_deref()
    {
        Some("true" | "1") => true,
        Some("false" | "0") => false,
        _ => fallback,
    }
}
fn integer(env: &Environment, key: &str, fallback: i64, min: i64, max: i64) -> i64 {
    env.get(key)
        .and_then(|v| parse_decimal_prefix(v))
        .unwrap_or(fallback)
        .clamp(min, max)
}

impl ProxyConfig {
    pub fn from_env(env: &Environment) -> Self {
        let gpu_options = ["none", "nvenc", "qsv", "vaapi", "amf", "videotoolbox"];
        let explicit = text(env, "LIVETV_PROXY_GPU", "inherit").to_lowercase();
        let gpu = if explicit == "inherit" {
            choice(env, "GPU_ACCELERATION", "none", &gpu_options)
        } else if gpu_options.contains(&explicit.as_str()) {
            explicit
        } else {
            "none".into()
        };
        Self {
            transcode_mode: choice(
                env,
                "LIVETV_PROXY_TRANSCODE_MODE",
                "auto",
                &["auto", "always", "remux"],
            ),
            gpu,
            allow_hevc_passthrough: boolean(env, "LIVETV_ALLOW_HEVC_PASSTHROUGH", true),
            target_codec: choice(env, "LIVETV_PROXY_TARGET_CODEC", "h264", &["h264", "hevc"]),
            crf: integer(env, "LIVETV_PROXY_CRF", 23, 0, 51),
            preset: choice(
                env,
                "LIVETV_PROXY_PRESET",
                "veryfast",
                &[
                    "ultrafast",
                    "superfast",
                    "veryfast",
                    "faster",
                    "fast",
                    "medium",
                    "slow",
                ],
            ),
            deinterlace_filter: choice(
                env,
                "LIVETV_DEINTERLACE_FILTER",
                "yadif",
                &["yadif", "bwdif", "none"],
            ),
            audio_passthrough: boolean(env, "LIVETV_AUDIO_PASSTHROUGH", false),
            ffprobe_path: text(env, "FFPROBE_PATH", "/usr/bin/ffprobe"),
            ffmpeg_path: text(env, "FFMPEG_PATH", "/usr/bin/ffmpeg"),
            vaapi_device: text(env, "VAAPI_DEVICE", "/dev/dri/renderD128"),
            nvenc_preset: text(env, "NVENC_PRESET", "p4"),
            nvenc_cq: integer(env, "NVENC_CQ", 23, 0, 51),
            amf_quality: choice(
                env,
                "AMF_QUALITY",
                "balanced",
                &["quality", "balanced", "speed"],
            ),
            probe_timeout_ms: integer(env, "LIVETV_PROBE_TIMEOUT_MS", 5000, 1000, 30000),
            upstream_proxy_url: text(env, "LIVETV_UPSTREAM_PROXY_URL", ""),
            max_egress_encoders: integer(env, "LIVETV_MAX_EGRESS_ENCODERS", 4, 0, 64),
        }
    }
}

fn scheme(url: &str) -> Option<String> {
    url.trim()
        .split_once(':')
        .map(|(scheme, _)| scheme.to_ascii_lowercase())
}

pub fn protocol_whitelist_for(url: &str) -> &'static str {
    match scheme(url).as_deref() {
        // TCP-interleaved RTSP only (see input_transport_args): no UDP sockets for a
        // hostile server to steer at another host.
        Some("rtsp") => "rtsp,tcp",
        Some("rtmp") => "rtmp,rtmpt,rtmpe,rtmps,rtmpte,rtmpts,tcp,tls,crypto",
        _ => "http,https,tcp,tls,crypto",
    }
}

/// RTMP's `timeout` enables listen mode; client I/O uses microsecond `rw_timeout`.
pub fn ingest_timeout_option(url: &str) -> &'static str {
    if scheme(url).as_deref() == Some("rtmp") {
        "-rw_timeout"
    } else {
        "-timeout"
    }
}

/// Input options that pin the transport of one live-TV input URL.
pub fn input_transport_args(url: &str) -> &'static [&'static str] {
    if scheme(url).as_deref() == Some("rtsp") {
        &["-rtsp_transport", "tcp"]
    } else {
        &[]
    }
}

// FFmpeg parses hostile provider input, so its children inherit only what they need
// to run (locale, temp space, library lookup, GPU runtime selection), never the
// proxy's credentials or service endpoints. LD_PRELOAD (jemalloc) is the proxy's own
// allocator choice and is not forwarded.
const CHILD_ENV_KEYS: [&str; 7] = [
    "PATH",
    "HOME",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TMPDIR",
    "LD_LIBRARY_PATH",
];
const CHILD_ENV_PREFIXES: [&str; 7] = [
    "LC_", "LIBVA_", "NVIDIA_", "CUDA_", "OCL_ICD_", "ONEVPL_", "INTEL_",
];
const SECRET_SUFFIXES: [&str; 5] = ["_SECRET", "_PASSWORD", "_TOKEN", "_KEY", "_URL"];
const PROXY_ENV_KEYS: [&str; 6] = [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "no_proxy",
    "NO_PROXY",
];

fn child_variable(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    !SECRET_SUFFIXES.iter().any(|suffix| upper.ends_with(suffix))
        && (CHILD_ENV_KEYS.contains(&key)
            || CHILD_ENV_PREFIXES
                .iter()
                .any(|prefix| key.starts_with(prefix)))
}

/// The allowlisted part of `env` that an FFmpeg/ffprobe child may see.
pub fn child_environment(env: &Environment) -> Environment {
    env.iter()
        .filter(|(key, _)| child_variable(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// child_environment of this process, for children spawned without a proxy policy.
pub fn process_child_environment() -> Environment {
    child_environment(
        &std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
            .collect(),
    )
}

pub fn upstream_environment(env: &Environment, proxy: &str, local_relay: bool) -> Environment {
    let mut result = child_environment(env);
    if local_relay {
        result.insert("no_proxy".into(), "*".into());
        result.insert("NO_PROXY".into(), "*".into());
    } else if !proxy.is_empty() {
        for key in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] {
            result.insert(key.into(), proxy.into());
        }
        result.insert("no_proxy".into(), String::new());
        result.insert("NO_PROXY".into(), String::new());
    } else {
        for key in PROXY_ENV_KEYS {
            if let Some(value) = env.get(key) {
                result.insert(key.into(), value.clone());
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_environment_is_the_allowlist_without_credentials() {
        let env: Environment = [
            ("PATH", "/usr/bin"),
            ("HOME", "/home/node"),
            ("LANG", "C.UTF-8"),
            ("LC_ALL", "C"),
            ("TZ", "UTC"),
            ("TMPDIR", "/tmp"),
            ("LD_LIBRARY_PATH", "/opt/lib"),
            ("LIBVA_DRIVER_NAME", "iHD"),
            ("NVIDIA_VISIBLE_DEVICES", "all"),
            ("CUDA_VISIBLE_DEVICES", "0"),
            ("STREAM_PROXY_SECRET", "shared"),
            ("CACHE_URL", "redis://:password@valkey:6379"),
            ("TASK_CACHE_URL", "redis://:password@valkey-tasks:6379/1"),
            ("DATABASE_URL", "postgres://user:password@db/lumastra"),
            ("LIBVA_API_KEY", "key"),
            ("NVIDIA_Token", "token"),
            ("LC_PASSWORD", "password"),
            ("LD_PRELOAD", "/usr/local/lib/libjemalloc.so.2"),
            ("MALLOC_CONF", "background_thread:true"),
            ("OPENAI_API_KEY", "key"),
            ("NODE_ENV", "production"),
            ("http_proxy", "http://proxy.invalid"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        let child = child_environment(&env);
        assert_eq!(
            child.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "CUDA_VISIBLE_DEVICES",
                "HOME",
                "LANG",
                "LC_ALL",
                "LD_LIBRARY_PATH",
                "LIBVA_DRIVER_NAME",
                "NVIDIA_VISIBLE_DEVICES",
                "PATH",
                "TMPDIR",
                "TZ",
            ]
        );
        let direct = upstream_environment(&env, "", false);
        assert_eq!(direct["http_proxy"], "http://proxy.invalid");
        assert!(!direct.contains_key("STREAM_PROXY_SECRET"));
        let relay = upstream_environment(&env, "", true);
        assert!(!relay.contains_key("http_proxy"));
        assert_eq!(relay["no_proxy"], "*");
        for proxied in [
            relay,
            upstream_environment(&env, "http://forward.invalid", false),
        ] {
            assert!(
                proxied
                    .keys()
                    .all(|key| child_variable(key) || PROXY_ENV_KEYS.contains(&key.as_str()))
            );
        }
    }

    #[test]
    fn rtsp_inputs_use_tcp_interleaved_transport_only() {
        assert_eq!(
            protocol_whitelist_for(" RTSP://camera.invalid/live"),
            "rtsp,tcp"
        );
        assert_eq!(
            input_transport_args("rtsp://camera.invalid/live"),
            ["-rtsp_transport", "tcp"]
        );
        assert!(input_transport_args("rtmp://camera.invalid/live").is_empty());
        assert!(input_transport_args("http://127.0.0.1/upstream.ts").is_empty());
    }
}

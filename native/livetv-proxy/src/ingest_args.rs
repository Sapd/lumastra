// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use crate::config::{
    LIVE_HLS_FLAGS, ProxyConfig, ingest_timeout_option, input_transport_args,
    protocol_whitelist_for,
};
use serde_json::Value;

fn add(args: &mut Vec<String>, values: &[&str]) {
    args.extend(values.iter().map(|s| (*s).to_string()));
}

pub fn build(
    url: &str,
    directory: &str,
    decision: &Value,
    config: &ProxyConfig,
) -> Result<Vec<String>, String> {
    let mut args = ["-hide_banner", "-loglevel", "warning"]
        .map(String::from)
        .to_vec();
    let transcode = decision["videoAction"].as_str() == Some("transcode");
    if transcode {
        match config.gpu.as_str() {
            "vaapi" => add(&mut args, &["-vaapi_device", &config.vaapi_device]),
            "qsv" => add(&mut args, &["-init_hw_device", "qsv=qsv:hw"]),
            "amf" => add(
                &mut args,
                &["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"],
            ),
            _ => {}
        }
    }
    add(
        &mut args,
        &[
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "5",
            "-stream_loop",
            "-1",
            "-readrate",
            "1",
            "-readrate_initial_burst",
            "12",
            ingest_timeout_option(url),
            "10000000",
            "-analyzeduration",
            "1000000",
            "-probesize",
            "1000000",
            "-fflags",
            "+genpts",
        ],
    );
    add(&mut args, input_transport_args(url));
    add(
        &mut args,
        &[
            "-protocol_whitelist",
            protocol_whitelist_for(url),
            "-i",
            url,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
        ],
    );
    if !transcode {
        add(&mut args, &["-c:v", "copy"]);
    } else {
        let mut filters = Vec::new();
        if decision["deinterlace"].as_bool() == Some(true)
            && let Some(filter) = decision["deinterlaceFilterName"]
                .as_str()
                .filter(|v| ["yadif", "bwdif", "w3fdif"].contains(v))
        {
            filters.push(format!("{filter}=mode=0:parity=-1:deint=1"));
        }
        if config.gpu == "vaapi" {
            filters.extend(["format=nv12".into(), "hwupload".into()]);
        }
        if !filters.is_empty() {
            add(&mut args, &["-vf", &filters.join(",")]);
        }
        let encoder = decision["videoEncoder"]
            .as_str()
            .ok_or("missing_video_encoder")?;
        add(&mut args, &["-c:v", encoder]);
        match config.gpu.as_str() {
            "none" => add(
                &mut args,
                &["-preset", &config.preset, "-crf", &config.crf.to_string()],
            ),
            "nvenc" => add(
                &mut args,
                &[
                    "-preset",
                    &config.nvenc_preset,
                    "-rc",
                    "constqp",
                    "-cq",
                    &config.nvenc_cq.to_string(),
                ],
            ),
            "vaapi" => add(&mut args, &["-qp", &config.crf.to_string()]),
            "qsv" => add(
                &mut args,
                &[
                    "-global_quality",
                    &config.crf.to_string(),
                    "-forced_idr",
                    "1",
                ],
            ),
            "amf" => {
                add(
                    &mut args,
                    &[
                        "-quality",
                        &config.amf_quality,
                        "-header_insertion_mode",
                        "gop",
                    ],
                );
                if encoder.starts_with("hevc") {
                    add(&mut args, &["-gops_per_idr", "1"]);
                }
                if config.amf_quality == "quality" || config.amf_quality == "balanced" {
                    add(&mut args, &["-vbaq", "1", "-preanalysis", "1"]);
                }
                add(
                    &mut args,
                    &[
                        "-rc",
                        "vbr_peak",
                        "-qp_i",
                        &config.crf.to_string(),
                        "-qp_p",
                        &config.crf.to_string(),
                        "-qp_b",
                        &config.crf.to_string(),
                    ],
                );
            }
            "videotoolbox" => add(
                &mut args,
                &["-q:v", &config.crf.to_string(), "-allow_sw", "1"],
            ),
            _ => {}
        }
        add(&mut args, &["-force_key_frames", "expr:gte(t,n_forced*3)"]);
    }
    if decision["audioAction"].as_str() == Some("copy") {
        add(&mut args, &["-c:a", "copy"]);
    } else {
        add(&mut args, &["-c:a", "aac", "-b:a", "192k", "-ac", "2"]);
    }
    // Ingest start index is patched by its lifecycle manager after the pure builder;
    // retain the same builder default here, and test that override in P03.
    let segment_path = crate::args::joined(directory, "segment-%d.ts");
    let playlist_path = crate::args::joined(directory, "playlist.m3u8");
    add(
        &mut args,
        &[
            "-max_muxing_queue_size",
            "2048",
            "-f",
            "hls",
            "-hls_time",
            "3",
            "-hls_list_size",
            "10",
            "-hls_flags",
            LIVE_HLS_FLAGS,
            "-hls_segment_type",
            "mpegts",
            "-hls_segment_filename",
            &segment_path,
            "-start_number",
            "0",
            &playlist_path,
        ],
    );
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn remux_args(url: &str) -> Vec<String> {
        build(
            url,
            "/tmp/ingest",
            &json!({"videoAction": "copy", "audioAction": "copy"}),
            &ProxyConfig::from_env(&Default::default()),
        )
        .unwrap()
    }

    #[test]
    fn rtmp_ingest_is_a_client_with_an_io_timeout() {
        for url in ["rtmp://8.8.8.8/live/key", "RTMP://8.8.8.8/live/key"] {
            let args = remux_args(url);
            let input = &args[..args.iter().position(|arg| arg == "-i").unwrap()];
            assert!(
                input
                    .windows(2)
                    .any(|pair| pair == ["-rw_timeout", "10000000"])
            );
            for option in ["-timeout", "-listen", "-rtmp_listen", "-listen_timeout"] {
                assert!(!input.iter().any(|arg| arg == option), "{option}");
            }
            assert!(args.windows(2).any(|pair| pair == ["-i", url]));
        }
    }

    #[test]
    fn http_and_rtsp_keep_their_existing_timeout_options() {
        for url in [
            "http://127.0.0.1/upstream.ts",
            "https://provider.example/live",
            "rtsp://camera.example/live",
        ] {
            let args = remux_args(url);
            let input = &args[..args.iter().position(|arg| arg == "-i").unwrap()];
            assert!(
                input
                    .windows(2)
                    .any(|pair| pair == ["-timeout", "10000000"])
            );
            assert!(!input.iter().any(|arg| arg == "-rw_timeout"));
            if url.starts_with("rtsp:") {
                assert!(
                    input
                        .windows(2)
                        .any(|pair| pair == ["-rtsp_transport", "tcp"])
                );
            }
        }
    }
}

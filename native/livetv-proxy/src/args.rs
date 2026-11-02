// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use crate::config::{FFMPEG_PROTOCOL_WHITELIST, LIVE_HLS_FLAGS};
use serde::Deserialize;

pub const SOFTWARE_TONEMAP_FILTER: &str =
    "tonemapx=tonemap=bt2390:desat=0:peak=100:p=bt709:t=bt709:m=bt709:r=tv:format=yuv420p";
pub const VAAPI_TONEMAP_FILTER: &str = "tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709";
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rung {
    pub id: String,
    pub height: f64,
    pub max_bitrate: f64,
    pub codec: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Common {
    /// Loopback feed URL; its random feed id is the child's only credential.
    pub input_url: String,
    pub seg_dir: String,
    pub segment_duration: f64,
    pub ring_capacity: f64,
    pub start_number: Option<f64>,
    pub init_filename: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Egress {
    #[serde(flatten)]
    pub common: Common,
    pub rung: Rung,
    pub gpu: String,
    pub vaapi_device: String,
    pub ingest_audio_is_aac: bool,
    #[serde(default)]
    pub compat: bool,
    pub hdr_tonemap: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adaptive {
    #[serde(flatten)]
    pub common: Common,
    pub rungs: Vec<Rung>,
    pub include_original: bool,
    pub hdr_tonemap: Option<String>,
    pub vaapi_device: Option<String>,
}
fn add(args: &mut Vec<String>, values: &[&str]) {
    args.extend(values.iter().map(|s| (*s).to_string()));
}
pub(crate) fn joined(base: &str, name: &str) -> String {
    let full = format!("{base}/{name}");
    let rooted = full.starts_with('/');
    let mut parts = Vec::new();
    for part in full.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if !rooted {
                    parts.push(part);
                }
            }
            _ => parts.push(part),
        }
    }
    format!("{}{}", if rooted { "/" } else { "" }, parts.join("/"))
}
pub fn vaapi_decode_args(device: &str) -> Vec<String> {
    [
        "-vaapi_device",
        device,
        "-hwaccel",
        "vaapi",
        "-hwaccel_output_format",
        "vaapi",
    ]
    .map(String::from)
    .to_vec()
}
pub fn egress_encoder(gpu: &str) -> &'static str {
    match gpu {
        "nvenc" => "h264_nvenc",
        "qsv" => "h264_qsv",
        "vaapi" => "h264_vaapi",
        _ => "libx264",
    }
}
pub fn hdr_reserved_outputs(outputs: u64, hdr: bool, limit: u64) -> u64 {
    if hdr {
        outputs.saturating_add(1).min(outputs.max(limit))
    } else {
        outputs
    }
}
fn input(args: &mut Vec<String>, common: &Common) {
    add(
        args,
        &[
            "-protocol_whitelist",
            FFMPEG_PROTOCOL_WHITELIST,
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "30",
            "-reconnect_on_http_error",
            "4xx,5xx",
        ],
    );
    add(args, &["-i", &common.input_url]);
}
fn hls(args: &mut Vec<String>, common: &Common, dir: &str, fmp4: bool, queue: bool, start: f64) {
    if queue {
        add(args, &["-max_muxing_queue_size", "2048"]);
    }
    add(
        args,
        &[
            "-f",
            "hls",
            "-hls_time",
            &common.segment_duration.to_string(),
            "-hls_list_size",
            &common.ring_capacity.to_string(),
            "-hls_flags",
            LIVE_HLS_FLAGS,
            "-hls_segment_type",
            if fmp4 { "fmp4" } else { "mpegts" },
        ],
    );
    if fmp4 {
        add(
            args,
            &[
                "-hls_fmp4_init_filename",
                common.init_filename.as_deref().unwrap_or("init.mp4"),
            ],
        );
    }
    add(
        args,
        &[
            "-hls_segment_filename",
            &joined(
                dir,
                if fmp4 {
                    "segment-%d.m4s"
                } else {
                    "segment-%d.ts"
                },
            ),
            "-start_number",
            &start.to_string(),
            &joined(dir, "playlist.m3u8"),
        ],
    );
}

pub fn egress(o: &Egress) -> Vec<String> {
    let gpu_tonemap = o.hdr_tonemap.as_deref() == Some("vaapi");
    let encoder = if gpu_tonemap {
        "h264_vaapi"
    } else {
        egress_encoder(&o.gpu)
    };
    let budget = (o.rung.max_bitrate - 192000.0).max(100000.0);
    let mut args = ["-hide_banner", "-loglevel", "warning", "-nostdin"]
        .map(String::from)
        .to_vec();
    if gpu_tonemap {
        args.extend(vaapi_decode_args(&o.vaapi_device));
    } else if encoder == "h264_vaapi" {
        add(&mut args, &["-vaapi_device", &o.vaapi_device]);
    }
    if encoder == "h264_qsv" {
        add(&mut args, &["-init_hw_device", "qsv=qsv:hw"]);
    }
    input(&mut args, &o.common);
    add(
        &mut args,
        &[
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
    let filter = if gpu_tonemap {
        format!(
            "{VAAPI_TONEMAP_FILTER},scale_vaapi=w=-2:h='min(ih,{})'",
            o.rung.height
        )
    } else {
        let mut filters = vec![format!("scale=-2:'min(ih,{})'", o.rung.height)];
        if o.hdr_tonemap.as_deref() == Some("software") {
            filters.push(SOFTWARE_TONEMAP_FILTER.into());
        } else if o.compat {
            filters.push("format=yuv420p".into());
        }
        if encoder == "h264_vaapi" {
            filters.extend(["format=nv12".into(), "hwupload".into()]);
        }
        filters.join(",")
    };
    add(&mut args, &["-vf", &filter, "-c:v", encoder]);
    if encoder == "h264_qsv" {
        add(
            &mut args,
            &[
                "-forced_idr",
                "1",
                "-b:v",
                &budget.to_string(),
                "-maxrate",
                &(budget + 1.0).to_string(),
                "-rc_init_occupancy",
                &(budget * 2.0).floor().to_string(),
                "-bufsize",
                &(budget * 4.0).floor().to_string(),
            ],
        );
    } else if encoder == "libx264" {
        add(
            &mut args,
            &[
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-maxrate",
                &budget.to_string(),
                "-bufsize",
                &(budget * 2.0).to_string(),
            ],
        );
    } else {
        add(
            &mut args,
            &[
                "-b:v",
                &budget.to_string(),
                "-maxrate",
                &budget.to_string(),
                "-bufsize",
                &(budget * 2.0).to_string(),
            ],
        );
    }
    add(
        &mut args,
        &[
            "-force_key_frames",
            &format!("expr:gte(t,n_forced*{})", o.common.segment_duration),
        ],
    );
    if o.ingest_audio_is_aac {
        add(&mut args, &["-c:a", "copy"]);
    } else {
        add(&mut args, &["-c:a", "aac", "-b:a", "128k", "-ac", "2"]);
    }
    hls(
        &mut args,
        &o.common,
        &o.common.seg_dir,
        false,
        true,
        o.common.start_number.unwrap_or(0.0),
    );
    args
}

pub fn remux(o: &Common, codec: Option<&str>) -> Vec<String> {
    let mut args = ["-hide_banner", "-loglevel", "warning", "-nostdin"]
        .map(String::from)
        .to_vec();
    input(&mut args, o);
    add(
        &mut args,
        &[
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
            "-c",
            "copy",
        ],
    );
    if codec == Some("hevc") {
        add(&mut args, &["-tag:v", "hvc1"]);
    }
    add(&mut args, &["-bsf:a", "aac_adtstoasc"]);
    hls(
        &mut args,
        o,
        &o.seg_dir,
        true,
        true,
        o.start_number.unwrap_or(0.0),
    );
    args
}

pub fn adaptive(o: &Adaptive) -> Result<Vec<String>, String> {
    let hardware = o.hdr_tonemap.as_deref() == Some("vaapi");
    let mut args = ["-hide_banner", "-loglevel", "warning", "-nostdin"]
        .map(String::from)
        .to_vec();
    if hardware {
        args.extend(vaapi_decode_args(
            o.vaapi_device
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or("hdrTonemap vaapi needs vaapiDevice")?,
        ));
    }
    input(&mut args, &o.common);
    if let Some(path) = &o.hdr_tonemap {
        let splits = (0..o.rungs.len())
            .map(|i| format!("[s{i}]"))
            .collect::<String>();
        let top = o
            .rungs
            .iter()
            .map(|r| r.height)
            .fold(f64::NEG_INFINITY, f64::max);
        let head = if path == "vaapi" {
            format!(
                "[0:v]{VAAPI_TONEMAP_FILTER},split={}{splits}",
                o.rungs.len()
            )
        } else {
            format!(
                "[0:v]scale=-2:'min(ih,{top})',{SOFTWARE_TONEMAP_FILTER},split={}{splits}",
                o.rungs.len()
            )
        };
        let mut graph = vec![head];
        graph.extend(o.rungs.iter().enumerate().map(|(i, r)| {
            if path == "vaapi" {
                format!("[s{i}]scale_vaapi=w=-2:h='min(ih,{})'[v{i}]", r.height)
            } else {
                format!("[s{i}]scale=-2:'min(ih,{})'[v{i}]", r.height)
            }
        }));
        add(&mut args, &["-filter_complex", &graph.join(";")]);
    }
    for (i, rung) in o.rungs.iter().enumerate() {
        let dir = joined(&o.common.seg_dir, &rung.id);
        let budget = (rung.max_bitrate - 192000.0).max(100000.0);
        add(
            &mut args,
            &[
                "-map",
                &if o.hdr_tonemap.is_some() {
                    format!("[v{i}]")
                } else {
                    "0:v:0".into()
                },
                "-map",
                "0:a:0?",
                "-sn",
                "-dn",
            ],
        );
        if o.hdr_tonemap.is_none() {
            add(
                &mut args,
                &["-vf", &format!("scale=-2:'min(ih,{})'", rung.height)],
            );
        }
        if hardware {
            add(
                &mut args,
                &[
                    "-c:v",
                    "h264_vaapi",
                    "-b:v",
                    &budget.to_string(),
                    "-maxrate",
                    &budget.to_string(),
                    "-bufsize",
                    &(budget * 2.0).to_string(),
                ],
            );
        } else {
            add(
                &mut args,
                &[
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-maxrate",
                    &budget.to_string(),
                    "-bufsize",
                    &(budget * 2.0).to_string(),
                ],
            );
        }
        add(
            &mut args,
            &[
                "-force_key_frames",
                &format!("expr:gte(t,n_forced*{})", o.common.segment_duration),
                "-c:a",
                "copy",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
            ],
        );
        hls(&mut args, &o.common, &dir, false, true, 0.0);
    }
    if o.include_original {
        add(
            &mut args,
            &[
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-sn",
                "-dn",
                "-c",
                "copy",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
            ],
        );
        hls(
            &mut args,
            &o.common,
            &joined(&o.common.seg_dir, "original"),
            false,
            false,
            0.0,
        );
    }
    Ok(args)
}

// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use serde::{Deserialize, Serialize};
use std::fmt::Write;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Segment {
    pub index: u64,
    pub duration: f64,
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistOptions {
    #[serde(default)]
    pub discontinuity_anchors: Vec<u64>,
    #[serde(default)]
    pub aged_out_discontinuities: u64,
    #[serde(default)]
    pub fmp4: bool,
    #[serde(default)]
    pub init_uris: Vec<InitUri>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitUri {
    pub from_index: u64,
    pub uri: String,
}

pub fn render_playlist(segments: &[Segment], options: &PlaylistOptions) -> Option<String> {
    let first = segments.first()?;
    let target = segments
        .iter()
        .map(|s| s.duration)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil();
    let mut body = format!(
        "#EXTM3U\n#EXT-X-VERSION:{}\n#EXT-X-TARGETDURATION:{}\n#EXT-X-MEDIA-SEQUENCE:{}\n",
        if options.fmp4 { 6 } else { 3 },
        if target == 0.0 { 1.0 } else { target },
        first.index
    );
    if !options.discontinuity_anchors.is_empty() || options.aged_out_discontinuities > 0 {
        let aged = options.aged_out_discontinuities
            + options
                .discontinuity_anchors
                .iter()
                .filter(|a| **a < first.index)
                .count() as u64;
        writeln!(body, "#EXT-X-DISCONTINUITY-SEQUENCE:{aged}").expect("string write");
    }
    if options.fmp4 {
        body.push_str("#EXT-X-INDEPENDENT-SEGMENTS\n");
    }
    let mut current_init = None;
    for segment in segments {
        if options.discontinuity_anchors.contains(&segment.index) {
            body.push_str("#EXT-X-DISCONTINUITY\n");
        }
        if options.fmp4 {
            let init = options
                .init_uris
                .iter()
                .rfind(|i| i.from_index <= segment.index)
                .map(|i| i.uri.as_str())
                .unwrap_or("init.mp4");
            if current_init != Some(init) {
                writeln!(body, "#EXT-X-MAP:URI=\"{init}\"").expect("string write");
                current_init = Some(init);
            }
        }
        writeln!(
            body,
            "#EXTINF:{},\nsegment-{}.{}",
            crate::js::fixed_3(segment.duration),
            segment.index,
            if options.fmp4 { "m4s" } else { "ts" }
        )
        .expect("string write");
    }
    Some(body)
}

pub fn master_playlist() -> &'static str {
    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nplaylist.m3u8\n"
}

pub fn in_segment_order(mut files: Vec<String>) -> Vec<String> {
    fn number(file: &str) -> u64 {
        let Some((stem, ext)) = file.rsplit_once('.') else {
            return 9_007_199_254_740_991;
        };
        if ext != "ts" && ext != "m4s" {
            return 9_007_199_254_740_991;
        }
        let digits: String = stem
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        digits.parse().unwrap_or(9_007_199_254_740_991)
    }
    files.sort_by_key(|f| number(f));
    files
}

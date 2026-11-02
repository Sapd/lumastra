// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Passive video PES timestamp observations, without decoding or modifying media.
#[derive(Clone, Default, Debug)]
pub struct OutputDiagnostics {
    pub timestamp_samples: u64,
    pub gap_count: u64,
    pub reset_count: u64,
    pub largest_gap_seconds: f64,
    pub last_gap_at_ms: Option<u64>,
    previous: Option<i64>,
    video_pid: Option<u16>,
}
impl OutputDiagnostics {
    pub fn observe(&mut self, data: &[u8], now: u64) {
        for p in data.as_chunks::<188>().0 {
            if p[0] != 0x47 || p[1] & 0x80 != 0 || p[3] & 0xc0 != 0 {
                continue;
            }
            let pid = (u16::from(p[1] & 0x1f) << 8) | u16::from(p[2]);
            let adaptation = (p[3] >> 4) & 3;
            if adaptation == 0 {
                continue;
            }
            let mut start = 4;
            if adaptation & 2 != 0 {
                start += 1 + usize::from(p[4]);
                if start > 188 {
                    continue;
                }
                if p[4] > 0 && p[5] & 0x80 != 0 && self.video_pid == Some(pid) {
                    self.previous = None;
                    self.reset_count += 1;
                }
            }
            if adaptation & 1 == 0 || p[1] & 0x40 == 0 || start + 14 > 188 {
                continue;
            }
            let pes = &p[start..];
            if pes[..3] != [0, 0, 1] || !(0xe0..=0xef).contains(&pes[3]) {
                continue;
            }
            if pes[6] & 0xc0 != 0x80 || 9 + usize::from(pes[8]) > pes.len() {
                continue;
            }
            let flags = pes[7] >> 6;
            let at = if flags == 3 { 14 } else { 9 };
            if !matches!(flags, 2 | 3)
                || pes[8] < if flags == 3 { 10 } else { 5 }
                || at + 5 > pes.len()
            {
                continue;
            }
            let t = &pes[at..at + 5];
            if t[0] >> 4 != if flags == 3 { 1 } else { 2 }
                || t[0] & 1 != 1
                || t[2] & 1 != 1
                || t[4] & 1 != 1
            {
                continue;
            }
            let stamp = i64::from(t[0] & 14) * 536870912
                + i64::from(t[1]) * 4194304
                + i64::from(t[2] >> 1) * 32768
                + i64::from(t[3]) * 128
                + i64::from(t[4] >> 1);
            if self.video_pid != Some(pid) {
                self.previous = None;
            }
            if let Some(previous) = self.previous {
                let delta =
                    ((stamp - previous + 12884901888) % 8589934592 - 4294967296) as f64 / 90000.0;
                if delta > 1.0 {
                    self.gap_count += 1;
                    self.largest_gap_seconds = self.largest_gap_seconds.max(delta);
                    self.last_gap_at_ms = Some(now);
                } else if delta < -1.0 {
                    self.reset_count += 1;
                }
            }
            self.previous = Some(stamp);
            self.video_pid = Some(pid);
            self.timestamp_samples += 1;
        }
    }
    pub fn snapshot(&self, buffered_seconds: f64) -> serde_json::Value {
        let mut value = serde_json::json!({
            "bufferedSeconds": buffered_seconds, "timestampSamples": self.timestamp_samples,
            "gapCount": self.gap_count, "resetCount": self.reset_count,
            "largestGapSeconds": self.largest_gap_seconds
        });
        if let Some(at) = self.last_gap_at_ms {
            value["lastGapAt"] = serde_json::json!(crate::runtime_operations::iso_timestamp(at));
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(stamp: i64, pid: u16, stream: u8) -> Vec<u8> {
        let mut p = vec![255; 188];
        p[..13].copy_from_slice(&[
            0x47,
            0x40 | (pid >> 8) as u8,
            pid as u8,
            0x10,
            0,
            0,
            1,
            stream,
            0,
            0,
            0x80,
            0x80,
            5,
        ]);
        p[13..18].copy_from_slice(&[
            0x21 | ((stamp / 536870912) as u8 & 14),
            (stamp / 4194304) as u8,
            ((stamp / 16384) as u8 & 254) | 1,
            (stamp / 128) as u8,
            ((stamp * 2) as u8 & 254) | 1,
        ]);
        p
    }
    #[test]
    fn gaps_wraps_and_resets() {
        let mut d = OutputDiagnostics::default();
        for (stamp, now) in [(8589934592 - 3600, 0), (0, 0), (720000, 1000), (0, 1000)] {
            d.observe(&packet(stamp, 256, 0xe0), now);
        }
        assert_eq!(d.timestamp_samples, 4);
        assert_eq!(d.gap_count, 1);
        assert_eq!(d.reset_count, 1);
        assert_eq!(d.largest_gap_seconds, 8.0);
        assert_eq!(d.last_gap_at_ms, Some(1000));
    }
    #[test]
    fn audio_corruption_and_pid_change_are_not_gaps() {
        let mut d = OutputDiagnostics::default();
        d.observe(&packet(0, 256, 0xe0), 0);
        d.observe(&packet(900000, 257, 0xc0), 0);
        let mut broken = packet(900000, 256, 0xe0);
        broken[15] &= 254;
        d.observe(&broken, 0);
        d.observe(&packet(900000, 258, 0xe0), 0);
        d.observe(&[255; 188], 0);
        assert_eq!(d.timestamp_samples, 2);
        assert_eq!(d.gap_count, 0);
    }
    #[test]
    fn signalled_discontinuity_resets_baseline() {
        let mut d = OutputDiagnostics::default();
        d.observe(&packet(0, 256, 0xe0), 0);
        let mut p = vec![255; 188];
        p[..6].copy_from_slice(&[0x47, 1, 0, 0x20, 183, 0x80]);
        d.observe(&p, 0);
        d.observe(&packet(900000, 256, 0xe0), 0);
        assert_eq!(d.reset_count, 1);
        assert_eq!(d.gap_count, 0);
    }
    #[test]
    fn real_ffmpeg_b_frames_and_removed_segments() {
        use std::{
            fs,
            process::Command,
            time::{SystemTime, UNIX_EPOCH},
        };
        let dir = std::env::temp_dir().join(format!(
            "native-output-timing-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(dir.clone());
        let result = Command::new(std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into()))
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x90:rate=25",
                "-t",
                "12",
                "-an",
                "-c:v",
                "libx264",
                "-g",
                "50",
                "-bf",
                "2",
                "-sc_threshold",
                "0",
                "-f",
                "hls",
                "-hls_time",
                "2",
                "-hls_list_size",
                "0",
                "-hls_segment_filename",
            ])
            .arg(dir.join("segment-%d.ts"))
            .arg(dir.join("playlist.m3u8"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let mut continuous = OutputDiagnostics::default();
        for i in 0..6 {
            continuous.observe(&fs::read(dir.join(format!("segment-{i}.ts"))).unwrap(), 0);
        }
        assert_eq!(continuous.timestamp_samples, 300);
        assert_eq!(continuous.gap_count, 0);
        assert_eq!(continuous.reset_count, 0);
        let mut truncated = OutputDiagnostics::default();
        for i in [0, 4] {
            truncated.observe(&fs::read(dir.join(format!("segment-{i}.ts"))).unwrap(), 0);
        }
        assert_eq!(truncated.gap_count, 1);
        assert!((truncated.largest_gap_seconds - 6.04).abs() < 0.001);
    }
}

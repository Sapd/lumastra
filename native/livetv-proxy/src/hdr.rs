// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub struct HdrPolicy {
    filters: BTreeSet<String>,
    hardware_failed_at: Option<i64>,
    recent_failures: BTreeMap<String, i64>,
}
impl HdrPolicy {
    pub fn new(filters: BTreeSet<String>) -> Self {
        Self {
            filters,
            ..Self::default()
        }
    }
    pub fn resolve(&self, gpu: &str, platform: &str, now: i64) -> Option<&'static str> {
        let broken = self
            .hardware_failed_at
            .is_some_and(|at| now.saturating_sub(at) < 30 * 60000);
        if matches!(gpu, "qsv" | "vaapi")
            && platform == "linux"
            && !broken
            && self.filters.contains("tonemap_vaapi")
            && self.filters.contains("scale_vaapi")
        {
            return Some("vaapi");
        }
        self.filters.contains("tonemapx").then_some("software")
    }
    pub fn note_failure(&mut self, produced_segments: bool, stderr: &str, channel: &str, now: i64) {
        let stderr = stderr.to_lowercase();
        let hardware_error = [
            "tonemap_vaapi",
            "scale_vaapi",
            "failed setup for format vaapi",
            "device creation failed",
            "no va display",
            "failed to initialise vaapi",
            "failed to initialize vaapi",
        ]
        .iter()
        .any(|needle| stderr.contains(needle));
        if produced_segments || !hardware_error {
            return;
        }
        self.recent_failures
            .retain(|_, at| now.saturating_sub(*at) < 10 * 60000);
        self.recent_failures.insert(channel.into(), now);
        if self.recent_failures.len() >= 2 {
            self.recent_failures.clear();
            self.hardware_failed_at = Some(now);
        }
    }
}

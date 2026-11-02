// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Immutable shared media and completed-file publication. Notifications carry no media.
use bytes::Bytes;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::mpsc;

pub const MAX_SEGMENT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_RING_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FailureEventInput {
    pub channel_id: String,
    pub source: String,
    pub outcome: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub rung_id: Option<String>,
    pub stderr_tail: String,
    pub probe: serde_json::Value,
    pub decision: serde_json::Value,
    /// Typed reason (`failure_reason::REASONS`), when the proxy could classify the failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Provider HTTP status behind the failure, when it came from an HTTP answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_status: Option<u16>,
    /// Index into the join's `streamUrls` of the URL that failed (ingest only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_url_index: Option<usize>,
    /// Feed (`livetv_channels.id`) of that URL, when the app sent `feedIds`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feed_id: Option<String>,
}
pub type FailureSink = Arc<dyn Fn(FailureEventInput) + Send + Sync>;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub struct Segment {
    pub index: u64,
    pub duration: f64,
    pub data: Bytes,
    pub created_at_ms: u64,
}

/// Below this the ring is too short for a stable bitrate measurement.
pub const MIN_SEGMENTS_FOR_BITRATE: usize = 4;

/// Bits per second of CONTENT duration (not arrival span), or None until the ring
/// holds MIN_SEGMENTS_FOR_BITRATE segments.
pub fn observed_bitrate(segments: &[Arc<Segment>]) -> Option<f64> {
    if segments.len() < MIN_SEGMENTS_FOR_BITRATE {
        return None;
    }
    let seconds: f64 = segments.iter().map(|s| s.duration).sum();
    let bits = segments
        .iter()
        .map(|s| s.data.len() as f64 * 8.0)
        .sum::<f64>();
    (seconds > 0.0).then(|| bits / seconds)
}

pub struct SegmentRing {
    segments: VecDeque<Arc<Segment>>,
    capacity: usize,
    bytes: usize,
    pub max_seen: Option<u64>,
    retired_through: Option<u64>,
}

impl SegmentRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            segments: VecDeque::new(),
            capacity: capacity.clamp(1, 100),
            bytes: 0,
            max_seen: None,
            retired_through: None,
        }
    }
    pub fn note_seen(&mut self, index: u64) {
        self.max_seen = Some(self.max_seen.map_or(index, |old| old.max(index)));
    }
    pub fn push(&mut self, segment: Segment) -> bool {
        self.note_seen(segment.index);
        if segment.data.is_empty()
            || segment.data.len() > MAX_SEGMENT_BYTES
            || !segment.duration.is_finite()
            || segment.duration <= 0.0
            || self.segments.iter().any(|s| s.index == segment.index)
        {
            return false;
        }
        self.bytes += segment.data.len();
        let at = self
            .segments
            .iter()
            .position(|s| s.index > segment.index)
            .unwrap_or(self.segments.len());
        self.segments.insert(at, Arc::new(segment));
        while self.segments.len() > self.capacity || self.bytes > MAX_RING_BYTES {
            if let Some(old) = self.segments.pop_front() {
                self.bytes -= old.data.len();
                self.retired_through =
                    Some(self.retired_through.map_or(old.index, |n| n.max(old.index)));
            }
        }
        true
    }
    pub fn snapshot(&self) -> Vec<Arc<Segment>> {
        self.segments.iter().cloned().collect()
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn published_or_retired(&self, index: u64) -> bool {
        self.retired_through.is_some_and(|n| index <= n)
            || self.segments.iter().any(|segment| segment.index == index)
    }
    fn evict_before(&mut self, index: u64) -> bool {
        if !self.segments.front().is_some_and(|old| old.index < index) {
            return false;
        }
        let old = self.segments.pop_front().unwrap();
        self.bytes -= old.data.len();
        self.retired_through = Some(self.retired_through.map_or(old.index, |n| n.max(old.index)));
        true
    }
}

/// Admission failure must be recoverable. Remove eligible owners from both ring
/// representations before trying again; a retained HTTP/carry Bytes still keeps
/// its charge and prevents admission until that external owner releases it.
pub async fn read_for_publication(
    path: &Path,
    index: u64,
    ring: &mut SegmentRing,
    budget: &crate::runtime_budget::MediaBudget,
    mut publish_eviction: impl FnMut(Vec<Arc<Segment>>),
) -> Result<Bytes, String> {
    loop {
        match budget.read_segment(path).await {
            Err(error) if error == "media_memory_capacity" => {
                if !ring.evict_before(index) {
                    return Err(error);
                }
                publish_eviction(ring.snapshot());
            }
            result => return result,
        }
    }
}

/// Cross-platform native filesystem notifications, coalesced into one pending wake.
/// Keep this object alive for as long as the publisher is active.
pub struct PublicationWatch {
    _watcher: Option<RecommendedWatcher>,
    receiver: mpsc::Receiver<()>,
}
impl PublicationWatch {
    pub fn new(directory: &Path) -> Self {
        Self::with_mode(directory, RecursiveMode::NonRecursive)
    }
    pub fn new_recursive(directory: &Path) -> Self {
        Self::with_mode(directory, RecursiveMode::Recursive)
    }
    fn with_mode(directory: &Path, mode: RecursiveMode) -> Self {
        let (sender, receiver) = mpsc::channel(1);
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            // Linux reports open/close-read access from our own playlist scans.
            // Waking on these creates a self-sustaining scan loop. Completed
            // playlists are published by rename, so mutation events suffice.
            if event.is_ok_and(|event| !matches!(event.kind, notify::EventKind::Access(_))) {
                let _ = sender.try_send(());
            }
        })
        .ok()
        .and_then(|mut watcher| {
            watcher.watch(directory, mode).ok()?;
            Some(watcher)
        });
        Self {
            _watcher: watcher,
            receiver,
        }
    }
    pub async fn changed(&mut self) {
        // A closed receiver must not spin if filesystem notification setup failed.
        if self.receiver.recv().await.is_none() {
            std::future::pending::<()>().await;
        }
    }
}

#[derive(Debug)]
pub struct CompletedSegment {
    pub index: u64,
    pub duration: f64,
    pub path: PathBuf,
}

/// FFmpeg's atomic playlist rename is the publication fence, including for fMP4:
/// a fragment's file can exist while the muxer is still writing it.
pub async fn completed_segments(directory: &Path, extension: &str) -> Vec<CompletedSegment> {
    let path = directory.join("playlist.m3u8");
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return Vec::new();
    };
    if metadata.len() > 256 * 1024 {
        return Vec::new();
    }
    let Ok(text) = tokio::fs::read_to_string(&path).await else {
        return Vec::new();
    };
    let mut duration = None;
    let mut result = Vec::new();
    for line in text.lines().map(str::trim).take(4096) {
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            duration = value
                .split(',')
                .next()
                .and_then(|n| n.parse::<f64>().ok())
                .filter(|n| n.is_finite() && *n > 0.0);
        } else if !line.is_empty() && !line.starts_with('#') {
            let Some(index) = line
                .strip_prefix("segment-")
                .and_then(|s| s.strip_suffix(&format!(".{extension}")))
                .and_then(|s| s.parse::<u64>().ok())
            else {
                duration = None;
                continue;
            };
            if let Some(duration) = duration.take() {
                result.push(CompletedSegment {
                    index,
                    duration,
                    path: directory.join(line),
                });
            }
        }
    }
    result.sort_by_key(|s| s.index);
    result
}

pub async fn read_segment(path: &Path) -> Result<Bytes, String> {
    crate::runtime_budget::read_segment(path).await
}

pub async fn highest_segment_index(directory: &Path, extension: &str) -> Option<u64> {
    let Ok(mut files) = tokio::fs::read_dir(directory).await else {
        return None;
    };
    let mut high = None;
    let suffix = format!(".{extension}");
    // FFmpeg's live directory is bounded by its ring; the cap also bounds accidental
    // leftovers while retaining a conservative index high-water mark.
    for _ in 0..10_000 {
        let Ok(Some(file)) = files.next_entry().await else {
            break;
        };
        let name = file.file_name();
        let Some(name) = name.to_str() else { continue };
        if let Some(index) = name
            .strip_prefix("segment-")
            .and_then(|s| s.strip_suffix(&suffix))
            .and_then(|s| s.parse::<u64>().ok())
        {
            high = Some(high.map_or(index, |old: u64| old.max(index)));
        }
    }
    high
}

/// Diagnostics are private, but must still never retain provider credentials.
pub fn sanitized_stderr(text: &str) -> String {
    let mut result = String::new();
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if ["authorization:", "proxy-secret", "cookie:", "password="]
            .iter()
            .any(|s| lower.contains(s))
        {
            result.push_str("[redacted diagnostic]\n");
            continue;
        }
        for word in line.split_whitespace() {
            if word.contains("://") {
                result.push_str("[redacted-url]");
            } else {
                result.push_str(word);
            }
            result.push(' ');
        }
        result.push('\n');
    }
    let start = result.len().saturating_sub(5000);
    let start = (start..=result.len())
        .find(|&n| result.is_char_boundary(n))
        .unwrap_or(result.len());
    result[start..].to_owned()
}

/// Buffer only a bounded incomplete line so credentials split across pipe reads
/// cannot bypass URL/header redaction. Oversized lines are discarded in full.
#[derive(Default)]
pub struct DiagnosticTail {
    tail: String,
    pending: Vec<u8>,
    discarding: bool,
}
impl DiagnosticTail {
    pub fn push(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if self.discarding {
                if byte == b'\n' {
                    self.discarding = false;
                }
                continue;
            }
            if byte == b'\n' {
                self.flush();
            } else if self.pending.len() >= 16 * 1024 {
                self.pending.clear();
                self.discarding = true;
                self.tail =
                    sanitized_stderr(&format!("{}\n[oversized diagnostic discarded]", self.tail));
            } else {
                self.pending.push(byte);
            }
        }
    }
    fn flush(&mut self) {
        self.tail = sanitized_stderr(&format!(
            "{}{}",
            self.tail,
            String::from_utf8_lossy(&self.pending)
        ));
        self.pending.clear();
    }
    pub fn finish(&mut self) {
        if !self.discarding && !self.pending.is_empty() {
            self.flush();
        }
    }
    pub fn tail(&self) -> &str {
        &self.tail
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observed_bitrate_needs_four_segments_of_content() {
        let segment = |index| {
            Arc::new(Segment {
                index,
                duration: 6.0,
                data: Bytes::from(vec![0u8; 750]),
                created_at_ms: 0,
            })
        };
        let three: Vec<_> = (0..3).map(segment).collect();
        assert_eq!(observed_bitrate(&three), None);
        let four: Vec<_> = (0..4).map(segment).collect();
        assert_eq!(observed_bitrate(&four), Some(1000.0));
        assert_eq!(observed_bitrate(&[]), None);
    }
    #[tokio::test]
    async fn publication_watch_ignores_own_reads_and_detects_playlist_renames() {
        let directory = std::env::temp_dir().join(format!(
            "proxy-publication-watch-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let playlist = directory.join("playlist.m3u8");
        std::fs::write(&playlist, b"initial").unwrap();
        let mut watch = PublicationWatch::new(&directory);
        assert!(watch._watcher.is_some());
        // Drain asynchronous setup notifications before testing access behavior.
        while tokio::time::timeout(std::time::Duration::from_millis(100), watch.changed())
            .await
            .is_ok()
        {}
        for _ in 0..10 {
            assert_eq!(std::fs::read(&playlist).unwrap(), b"initial");
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), watch.changed())
                .await
                .is_err()
        );
        std::fs::write(directory.join("playlist.tmp"), b"complete").unwrap();
        std::fs::rename(directory.join("playlist.tmp"), &playlist).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), watch.changed())
            .await
            .expect("atomic publication wakes immediately");
        drop(watch);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn bounded_ring_shares_bytes_and_preserves_high_water() {
        let mut ring = SegmentRing::new(2);
        for index in [2, 0, 1, 2] {
            ring.push(Segment {
                index,
                duration: 3.0,
                data: Bytes::from_static(b"segment"),
                created_at_ms: 0,
            });
        }
        assert_eq!(
            ring.snapshot().iter().map(|s| s.index).collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(ring.max_seen, Some(2));
        let a = ring.snapshot();
        let b = ring.snapshot();
        assert!(Arc::ptr_eq(&a[0], &b[0]));
    }
    #[test]
    fn diagnostics_do_not_retain_urls_or_headers() {
        let redacted = sanitized_stderr(
            "Failed https://name:password@host/a?token=secret\nAuthorization: secret\nordinary failure",
        );
        assert!(!redacted.contains("password"));
        assert!(!redacted.contains("secret"));
        assert!(redacted.contains("ordinary"));
    }
    #[test]
    fn pipe_read_boundaries_do_not_expose_split_credentials() {
        let mut diagnostics = DiagnosticTail::default();
        diagnostics.push(b"Failed https://name:pass");
        diagnostics.push(b"word@upstream/secret\nAuthorization:");
        diagnostics.push(b" token\n");
        assert!(!diagnostics.tail().contains("pass"));
        assert!(!diagnostics.tail().contains("token"));
        assert!(!diagnostics.tail().contains("upstream"));
        diagnostics.push(&vec![b'x'; 20_000]);
        diagnostics.push(b"\nnext diagnostic\n");
        assert!(diagnostics.tail().len() <= 5000);
        assert!(diagnostics.tail().contains("next diagnostic"));
    }
    #[tokio::test]
    async fn only_playlist_completed_segments_are_published_with_actual_duration() {
        let directory = std::env::temp_dir().join(format!(
            "native-publish-{}-{}",
            std::process::id(),
            now_ms()
        ));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        tokio::fs::write(directory.join("segment-7.m4s"), b"not complete yet")
            .await
            .unwrap();
        assert!(completed_segments(&directory, "m4s").await.is_empty());
        tokio::fs::write(
            directory.join("playlist.m3u8"),
            "#EXTM3U\n#EXTINF:4.125,\nsegment-6.m4s\n#EXTINF:2.5,\n../segment-7.m4s\n",
        )
        .await
        .unwrap();
        let completed = completed_segments(&directory, "m4s").await;
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].index, 6);
        assert_eq!(completed[0].duration, 4.125);
        assert_eq!(highest_segment_index(&directory, "m4s").await, Some(7));
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
    #[tokio::test]
    async fn pressure_evicts_both_ring_owners_but_retained_response_defers_admission() {
        let budget = crate::runtime_budget::MediaBudget::with_limit(16);
        let directory = std::env::temp_dir().join(format!(
            "native-pressure-{}-{}",
            std::process::id(),
            now_ms()
        ));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let old = directory.join("old");
        let next = directory.join("next");
        tokio::fs::write(&old, [1; 12]).await.unwrap();
        tokio::fs::write(&next, [2; 8]).await.unwrap();
        let mut ring = SegmentRing::new(10);
        ring.push(Segment {
            index: 0,
            duration: 3.0,
            data: budget.read_segment(&old).await.unwrap(),
            created_at_ms: 0,
        });
        let mut published = ring.snapshot();
        let response = published[0].data.clone();
        ring.note_seen(1);
        assert_eq!(
            read_for_publication(&next, 1, &mut ring, &budget, |segments| published =
                segments)
            .await
            .unwrap_err(),
            "media_memory_capacity"
        );
        assert!(published.is_empty());
        assert_eq!(ring.bytes(), 0);
        assert_eq!(budget.retained_bytes(), 12);
        assert!(!ring.published_or_retired(1));
        assert_eq!(ring.max_seen, Some(1));
        drop(response);
        let data = read_for_publication(&next, 1, &mut ring, &budget, |segments| {
            published = segments
        })
        .await
        .unwrap();
        assert_eq!(data.len(), 8);
        assert_eq!(budget.retained_bytes(), 8);
        drop(data);
        assert_eq!(budget.retained_bytes(), 0);
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}

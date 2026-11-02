// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use bytes::Bytes;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
pub(super) const MAX_AGE: Duration = Duration::from_secs(30);
pub(super) const REFRESH_DEADLINE: Duration = Duration::from_secs(2);
const MAX_BYTES: usize = 64 * 1024;
const MAX_ENTRIES: usize = 4;
struct Entry {
    key: String,
    body: Bytes,
    at: Instant,
    first: u64,
    end: u64,
    ticket: u64,
}
#[derive(Default)]
pub(super) struct LiveManifestCache {
    entries: VecDeque<Entry>,
    floor: u64,
    issued: u64,
}

fn media_sequence(body: &str) -> Option<(u64, u64)> {
    let lines: Vec<_> = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.first() != Some(&"#EXTM3U")
        || lines.iter().any(|line| {
            *line == "#EXT-X-ENDLIST"
                || line.starts_with("#EXT-X-STREAM-INF:")
                || line.starts_with("#EXT-X-I-FRAME-STREAM-INF:")
                || line.starts_with("#EXT-X-SKIP:")
                || *line == "#EXT-X-PLAYLIST-TYPE:VOD"
        })
    {
        return None;
    }
    let targets: Vec<_> = lines
        .iter()
        .filter_map(|line| line.strip_prefix("#EXT-X-TARGETDURATION:"))
        .collect();
    if targets.len() != 1
        || targets[0].is_empty()
        || !targets[0].bytes().all(|byte| byte.is_ascii_digit())
        || !targets[0]
            .parse::<u64>()
            .is_ok_and(|value| value > 0 && value <= 9007199254740991)
    {
        return None;
    }
    let sequences: Vec<_> = lines
        .iter()
        .filter_map(|line| line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:"))
        .collect();
    if sequences.len() > 1 {
        return None;
    }
    let sequence = sequences.first().copied().unwrap_or("0");
    if sequence.is_empty()
        || sequence.len() > 20
        || !sequence.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let first = sequence.parse::<u64>().ok()?;
    let mut pending = false;
    let mut count = 0;
    for line in lines {
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            let (value, _) = value.split_once(',')?;
            if pending
                || value.is_empty()
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'.')
                || !value
                    .parse::<f64>()
                    .is_ok_and(|duration| duration.is_finite() && duration > 0.0)
            {
                return None;
            }
            pending = true;
        } else if !line.starts_with('#') {
            if !pending {
                return None;
            }
            pending = false;
            count += 1;
        }
    }
    if pending || count == 0 {
        return None;
    }
    Some((first, first.checked_add(count)?))
}
impl LiveManifestCache {
    pub fn begin(&mut self, ticket: u64) {
        self.issued = self.issued.max(ticket);
    }
    pub fn get(&mut self, key: &str, now: Instant) -> Option<Bytes> {
        let before = self.entries.len();
        self.entries
            .retain(|entry| now.saturating_duration_since(entry.at) < MAX_AGE);
        if before != self.entries.len() {
            self.floor = self.floor.max(self.issued.saturating_add(1));
        }
        self.entries
            .iter()
            .find(|entry| entry.key == key)
            .map(|entry| entry.body.clone())
    }
    pub fn put(&mut self, key: &str, body: &str, ticket: u64, now: Instant) {
        self.get(key, now);
        // Existing keys have their own ordering; unrelated invalidation only fences absent keys.
        let stale = self
            .entries
            .iter()
            .find(|entry| entry.key == key)
            .map_or(ticket < self.floor, |entry| ticket < entry.ticket);
        if stale {
            return;
        }
        self.begin(ticket);
        let sequence = (key.len().saturating_add(body.len()) <= MAX_BYTES)
            .then(|| media_sequence(body))
            .flatten();
        let Some((first, end)) = sequence else {
            self.remove(key, ticket);
            return;
        };
        if self
            .entries
            .iter()
            .any(|entry| entry.key == key && (first < entry.first || end < entry.end))
        {
            self.remove(key, ticket);
            return;
        }
        self.entries.retain(|entry| entry.key != key);
        self.entries.push_back(Entry {
            key: key.into(),
            body: Bytes::copy_from_slice(body.as_bytes()),
            at: now,
            first,
            end,
            ticket,
        });
        while self.entries.len() > MAX_ENTRIES {
            self.entries.pop_front();
            self.floor = self.floor.max(self.issued.saturating_add(1));
        }
    }
    pub fn discard(&mut self, key: &str, ticket: u64) {
        if self.entries.iter().any(|entry| entry.key == key) {
            self.remove(key, ticket);
        }
    }
    pub fn remove(&mut self, key: &str, ticket: u64) {
        // Existing keys have their own ordering; unrelated invalidation only fences absent keys.
        let stale = self
            .entries
            .iter()
            .find(|entry| entry.key == key)
            .map_or(ticket < self.floor, |entry| ticket < entry.ticket);
        if stale {
            return;
        }
        self.begin(ticket);
        self.entries.retain(|entry| entry.key != key);
        self.floor = self.floor.max(ticket.saturating_add(1));
    }
    /// A destination renewal produced a playlist: drop the previous entry so the
    /// renewed manifest (possibly a new timeline) can replace it. Unlike `remove`, the
    /// fence stays at `ticket`, so this request's own `put` is admitted; older
    /// tickets are still fenced and a newer entry or invalidation is left alone.
    pub fn reset_for_renewal(&mut self, key: &str, ticket: u64) {
        if self
            .entries
            .iter()
            .any(|entry| entry.key == key && entry.ticket > ticket)
        {
            return;
        }
        self.begin(ticket);
        self.entries.retain(|entry| entry.key != key);
        self.floor = self.floor.max(ticket);
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.floor = self.floor.max(self.issued.saturating_add(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn media(sequence: u64) -> String {
        format!(
            "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:{sequence}\n#EXTINF:3,\nhttp://safe/segment.ts\n"
        )
    }
    #[test]
    fn fixed_age_capacity_byte_limits_and_disposal() {
        let now = Instant::now();
        let mut cache = LiveManifestCache::default();
        cache.put("url", &media(10), 1, now);
        assert!(
            cache
                .get("url", now + MAX_AGE - Duration::from_millis(1))
                .is_some()
        );
        assert!(cache.get("url", now + MAX_AGE).is_none());
        // Capacity uses a new request timeline; expired tickets cannot be reused.
        let mut cache = LiveManifestCache::default();
        for i in 0..5 {
            cache.put(&i.to_string(), &media(10), i, now);
        }
        assert!(cache.get("0", now).is_none());
        assert!(cache.get("1", now).is_some());
        cache.put("huge", &(media(10) + &"#".repeat(MAX_BYTES)), 10, now);
        assert!(cache.get("huge", now).is_none());
        let key = "x".repeat(MAX_BYTES);
        cache.put(&key, &media(10), 11, now);
        assert!(cache.get(&key, now).is_none());
        cache.clear();
        assert!(cache.entries.is_empty());
    }
    #[test]
    fn only_live_media_and_concurrent_newest_sequence_are_cached() {
        let now = Instant::now();
        let mut cache = LiveManifestCache::default();
        for body in [
            media(10) + "#EXT-X-ENDLIST\n",
            media(10) + "#EXT-X-PLAYLIST-TYPE:VOD\n",
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10\nvariant\n".into(),
            media(10).replace("10\n", "invalid\n"),
            media(u64::MAX),
            media(10).replace("#EXTINF:3,", "#EXTINF:NaN,"),
            media(10).replace("#EXTINF:3,", "#EXTINF:0,"),
            media(10).replace("#EXTINF:3,", "#EXTINF:Infinity,"),
            media(10) + "#EXT-X-MEDIA-SEQUENCE:11\n",
            media(10).replace("#EXT-X-TARGETDURATION:3\n", ""),
            media(10).replace("TARGETDURATION:3", "TARGETDURATION:0"),
            media(10).replace("TARGETDURATION:3", "TARGETDURATION:3.5"),
            media(10).replace(
                "#EXTINF:3,\nhttp://safe/segment.ts",
                "http://safe/segment.ts\n#EXTINF:3,",
            ),
            media(10).replace("#EXTINF:3,", "#EXTINF:3,\n#EXTINF:3,"),
            media(10) + "#EXT-X-SKIP:SKIPPED-SEGMENTS=2\n",
            "transport stream".into(),
        ] {
            cache.put("url", &body, 1, now);
            assert!(cache.get("url", now).is_none());
        }
        cache.put("url", &media(12), 2, now);
        cache.put("url", &media(11), 1, now + Duration::from_secs(1));
        cache.put("url", &media(12), 1, now + Duration::from_secs(2));
        assert_eq!(cache.get("url", now), Some(Bytes::from(media(12))));
        assert!(cache.get("url", now + MAX_AGE).is_none());
    }
    #[test]
    fn fencing_covers_invalidations_expiry_eviction_and_new_generations() {
        let now = Instant::now();
        let mut cache = LiveManifestCache::default();
        cache.put("url", &media(12), 2, now);
        cache.put("url", "invalid", 1, now);
        cache.remove("url", 1);
        assert_eq!(cache.get("url", now), Some(Bytes::from(media(12))));
        cache.begin(3);
        cache.remove("url", 4);
        cache.put("url", &media(13), 3, now);
        assert!(cache.get("url", now).is_none());
        cache.put("url", &media(20), 5, now);
        cache.put("url", &media(10), 6, now);
        cache.put("url", &media(21), 5, now);
        assert!(cache.get("url", now).is_none());
        cache.put("url", &media(11), 7, now);
        cache.begin(8);
        assert!(cache.get("url", now + MAX_AGE).is_none());
        cache.put("url", &media(12), 8, now + MAX_AGE);
        assert!(cache.get("url", now + MAX_AGE).is_none());
        for ticket in 9..=13 {
            cache.put(&ticket.to_string(), &media(10), ticket, now + MAX_AGE);
        }
        cache.put("url", &media(10), 12, now + MAX_AGE);
        assert!(cache.get("url", now + MAX_AGE).is_none());
        assert_eq!(cache.entries.len(), 4);
        cache.begin(14);
        cache.clear();
        cache.put("url", &media(10), 14, now + MAX_AGE);
        assert!(cache.get("url", now + MAX_AGE).is_none());
    }
    #[test]
    fn playable_provider_duration_drift_is_admitted() {
        let now = Instant::now();
        let body = media(10)
            .replace("TARGETDURATION:3", "TARGETDURATION:10")
            .replace("EXTINF:3,", "EXTINF:11.52,");
        let mut cache = LiveManifestCache::default();
        cache.put("url", &body, 1, now);
        assert_eq!(cache.get("url", now), Some(Bytes::from(body)));
    }

    #[test]
    fn unrelated_invalidation_cannot_fence_an_existing_entry() {
        let now = Instant::now();
        for kind in ["refusal", "invalid", "reset", "refresh"] {
            let mut cache = LiveManifestCache::default();
            cache.put("A", &media(10), 0, now);
            cache.put("B", &media(10), 1, now);
            cache.begin(2);
            cache.begin(3);
            cache.remove("B", 3);
            if kind == "refusal" {
                cache.remove("A", 2);
            } else {
                let body = if kind == "invalid" {
                    "invalid".into()
                } else {
                    media(if kind == "reset" { 9 } else { 11 })
                };
                cache.put("A", &body, 2, now);
            }
            assert_eq!(
                cache.get("A", now),
                if kind == "refresh" {
                    Some(Bytes::from(media(11)))
                } else {
                    None
                },
                "{kind}"
            );
            if kind != "refresh" {
                cache.put("A", &media(12), 2, now);
                assert!(cache.get("A", now).is_none());
            }
            cache.put("A", &media(13), 4, now);
            cache.remove("A", 2);
            assert_eq!(cache.get("A", now), Some(Bytes::from(media(13))));
        }
    }

    #[test]
    fn distinct_url_media_success_does_not_fence_a_manifest_refresh() {
        let now = Instant::now();
        let mut cache = LiveManifestCache::default();
        cache.put("manifest", &media(10), 1, now);
        cache.begin(2);
        cache.begin(3);
        cache.discard("segment.ts", 3);
        cache.put("manifest", &media(11), 2, now);
        assert_eq!(cache.get("manifest", now), Some(Bytes::from(media(11))));
    }
}

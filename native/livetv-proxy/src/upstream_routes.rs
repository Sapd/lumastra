// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
use std::collections::VecDeque;
use url::Url;

/// Bounded so a long-lived ingest cannot grow without limit; an evicted entry simply
/// resolves its redirect again on its next reload.
const MAX_ROUTES: usize = 64;

struct Route {
    key: String,
    target: Option<Url>,
    ticket: u64,
    /// Consecutive transport/5xx failures of `target` since it last answered.
    failures: u32,
}

/// Bounded, per-ingest playlist destinations. Tombstones fence late refreshes.
/// Ordered by last use: `get` and `set` move an entry to the back.
#[derive(Default)]
pub(super) struct PlaylistRoutes {
    entries: VecDeque<Route>,
    floor: u64,
    closed: bool,
}

impl PlaylistRoutes {
    /// The pinned destination, counted as a use.
    pub fn get(&mut self, key: &str) -> Option<Url> {
        let index = self.entries.iter().position(|r| r.key == key)?;
        let route = self.entries.remove(index)?;
        let target = route.target.clone();
        self.entries.push_back(route);
        target
    }
    /// The pinned destination without counting a use (HEAD).
    pub fn peek(&self, key: &str) -> Option<Url> {
        self.entries
            .iter()
            .find(|r| r.key == key)
            .and_then(|r| r.target.clone())
    }
    pub fn set(&mut self, key: &str, target: Option<Url>, ticket: u64) -> bool {
        if self.closed {
            return false;
        }
        if self
            .entries
            .iter()
            .find(|r| r.key == key)
            .map_or(ticket < self.floor, |r| ticket < r.ticket)
        {
            return false;
        }
        self.entries.retain(|r| r.key != key);
        self.entries.push_back(Route {
            key: key.into(),
            target,
            ticket,
            failures: 0,
        });
        while self.entries.len() > MAX_ROUTES {
            // Tombstones only fence late refreshes: they go before live routes.
            let index = self
                .entries
                .iter()
                .position(|r| r.key != key && r.target.is_none())
                .or_else(|| self.entries.iter().position(|r| r.key != key))
                .unwrap_or(0);
            if let Some(old) = self.entries.remove(index) {
                self.floor = self.floor.max(old.ticket.saturating_add(1));
            }
        }
        true
    }
    /// Counts one failure of `pinned`. At `limit` consecutive failures the route is
    /// tombstoned: `Some(true)` when that happened, `Some(false)` when a newer ticket
    /// fenced it, `None` while below the limit or when the pin is no longer `pinned`.
    pub fn fail(&mut self, key: &str, pinned: &Url, ticket: u64, limit: u32) -> Option<bool> {
        let route = self
            .entries
            .iter_mut()
            .find(|r| r.key == key && r.target.as_ref() == Some(pinned))?;
        route.failures = route.failures.saturating_add(1);
        (route.failures >= limit).then(|| self.set(key, None, ticket))
    }
    /// `pinned` answered (not a failure): the consecutive count starts again.
    pub fn reset(&mut self, key: &str, pinned: &Url) {
        if let Some(route) = self
            .entries
            .iter_mut()
            .find(|r| r.key == key && r.target.as_ref() == Some(pinned))
        {
            route.failures = 0;
        }
    }
    pub fn clear(&mut self) {
        self.closed = true;
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expiry_fences_late_refreshes_and_storage_is_bounded() {
        let mut r = PlaylistRoutes::default();
        let u = Url::parse("https://example.org/live").unwrap();
        assert!(r.set("entry", Some(u.clone()), 1));
        assert!(r.set("entry", None, 3));
        assert!(!r.set("entry", Some(u.clone()), 2));
        assert_eq!(r.get("entry"), None);
        for t in 4..80 {
            r.set(&t.to_string(), Some(u.clone()), t);
        }
        assert_eq!(r.entries.len(), 64);
        assert!(!r.set("entry", Some(u), 2));
        r.clear();
        assert!(r.entries.is_empty());
        assert!(!r.set(
            "entry",
            Some(Url::parse("https://example.org/live").unwrap()),
            100
        ));
    }

    #[test]
    fn an_actively_reloaded_key_survives_and_tombstones_go_first() {
        let u = Url::parse("https://example.org/live").unwrap();
        let mut r = PlaylistRoutes::default();
        assert!(r.set("busy", Some(u.clone()), 1));
        assert!(r.set("gone", None, 2));
        for t in 3..200u64 {
            assert!(r.get("busy").is_some(), "evicted at {t}");
            assert!(r.set(&format!("k{t}"), Some(u.clone()), t));
        }
        assert!(r.get("busy").is_some());
        assert_eq!(r.entries.len(), 64);
        assert!(r.entries.iter().all(|e| e.key != "gone"));
        // With room for 64, a tombstone is dropped before a live route that is older.
        let mut r = PlaylistRoutes::default();
        assert!(r.set("old-live", Some(u.clone()), 1));
        assert!(r.set("tomb", None, 2));
        for t in 3..65u64 {
            assert!(r.set(&format!("k{t}"), Some(u.clone()), t));
        }
        assert_eq!(r.entries.len(), 64);
        assert!(r.set("one-more", Some(u), 100));
        assert!(r.peek("old-live").is_some());
        assert!(r.entries.iter().all(|e| e.key != "tomb"));
    }
}

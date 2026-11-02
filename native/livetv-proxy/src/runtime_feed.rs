// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Continuous ingest delivery. Each response retains at most one queued media frame;
//! sessions retain cursors, never media, across HTTP reconnects.
use crate::{
    runtime_ingest::{IngestManager, IngestSnapshot},
    runtime_media::{Segment, now_ms},
};
use bytes::Bytes;
use futures_core::Stream;
use std::{
    collections::BTreeMap,
    io,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch};

pub const FEED_START_BACKLOG: usize = 3;
pub const FEED_START_WAIT_MS: u64 = 18_000;
pub const FEED_HOLE_GRACE_MS: u64 = 500;
pub const FEED_STALLED_READER_MS: u64 = 60_000;
const FEED_SESSION_TTL_MS: u64 = 120_000;
const MAX_FEED_SESSIONS: usize = 512;

pub fn valid_feed_id(feed_id: &str) -> bool {
    (16..=64).contains(&feed_id.len())
        && feed_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Feed credentials of the proxy's own encoders. A child is handed only its random
/// feed id, never the shared proxy secret; the id opens that one channel's feed while
/// the child is supervised (the grant drops when it is reaped).
#[derive(Clone, Default)]
pub struct FeedGrants(Arc<Mutex<BTreeMap<String, String>>>);
pub struct FeedGrant {
    grants: FeedGrants,
    id: String,
}
impl FeedGrants {
    pub fn grant(&self, channel: &str, feed_id: &str) -> FeedGrant {
        self.0
            .lock()
            .unwrap()
            .insert(feed_id.to_owned(), channel.to_owned());
        FeedGrant {
            grants: self.clone(),
            id: feed_id.to_owned(),
        }
    }
    pub fn allows(&self, channel: &str, feed_id: &str) -> bool {
        self.0
            .lock()
            .unwrap()
            .get(feed_id)
            .is_some_and(|granted| granted == channel)
    }
}
impl Drop for FeedGrant {
    fn drop(&mut self) {
        self.grants.0.lock().unwrap().remove(&self.id);
    }
}

#[derive(Clone, Default)]
pub struct FeedLifecycle {
    pub failing_over: bool,
    pub anchors: Vec<u64>,
    pub aged_out: u64,
}
pub type LifecycleResolver = Arc<dyn Fn(&str) -> FeedLifecycle + Send + Sync>;
#[derive(Debug, Clone)]
pub struct FeedError {
    pub status: u16,
    pub error: &'static str,
}
impl FeedError {
    fn new(status: u16, error: &'static str) -> Self {
        Self { status, error }
    }
}
struct Session {
    channel: String,
    next_index: Option<u64>,
    written: bool,
    generation: Option<u64>,
    respawns_behind: u64,
    ended: bool,
    closed_at_ms: u64,
    lease: u64,
    cancel: Option<watch::Sender<bool>>,
    stalled: Arc<AtomicBool>,
}
struct Inner {
    ingest: Arc<IngestManager>,
    lifecycle: LifecycleResolver,
    sessions: Mutex<BTreeMap<String, Session>>,
    stalled_reader_ms: u64,
}
#[derive(Clone)]
pub struct FeedManager {
    inner: Arc<Inner>,
}
struct Frame {
    data: Bytes,
    consumed: oneshot::Sender<()>,
}

/// Drop cancels the producer even if the client disconnects without polling again.
pub struct FeedStream {
    receiver: mpsc::Receiver<Frame>,
    cancel: watch::Sender<bool>,
    stalled: Arc<AtomicBool>,
    error_emitted: bool,
}
impl Stream for FeedStream {
    type Item = Result<Bytes, io::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if *self.cancel.borrow() {
            self.receiver.close();
            while self.receiver.try_recv().is_ok() {}
            if self.stalled.load(Ordering::Acquire) && !self.error_emitted {
                self.error_emitted = true;
                return Poll::Ready(Some(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "feed reader stalled",
                ))));
            }
            return Poll::Ready(None);
        }
        match self.receiver.poll_recv(cx) {
            Poll::Ready(Some(frame)) => {
                let _ = frame.consumed.send(());
                Poll::Ready(Some(Ok(frame.data)))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}
impl Drop for FeedStream {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}
struct Lease {
    inner: Arc<Inner>,
    id: String,
    lease: u64,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut sessions = self.inner.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&self.id).filter(|s| s.lease == self.lease) {
            session.cancel = None;
            session.closed_at_ms = now_ms();
            if !session.written {
                sessions.remove(&self.id);
            }
        }
    }
}
impl FeedManager {
    pub fn new(ingest: Arc<IngestManager>, lifecycle: LifecycleResolver) -> Self {
        Self::with_stall_timeout(ingest, lifecycle, FEED_STALLED_READER_MS)
    }
    pub fn with_stall_timeout(
        ingest: Arc<IngestManager>,
        lifecycle: LifecycleResolver,
        stalled_reader_ms: u64,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                ingest,
                lifecycle,
                sessions: Mutex::new(BTreeMap::new()),
                stalled_reader_ms,
            }),
        }
    }
    pub fn active_count(&self) -> usize {
        self.inner
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.cancel.is_some())
            .count()
    }
    pub fn session_count(&self) -> usize {
        self.inner.sessions.lock().unwrap().len()
    }
    pub fn close_all(&self) {
        let mut sessions = self.inner.sessions.lock().unwrap();
        for session in sessions.values() {
            if let Some(cancel) = &session.cancel {
                let _ = cancel.send(true);
            }
        }
        sessions.clear();
    }
    pub async fn open(&self, channel: &str, feed_id: &str) -> Result<FeedStream, FeedError> {
        if !valid_feed_id(feed_id) {
            return Err(FeedError::new(400, "invalid_feed_id"));
        }
        let (cancel, mut cancelled) = watch::channel(false);
        let stalled = Arc::new(AtomicBool::new(false));
        let lease = {
            let mut sessions = self.inner.sessions.lock().unwrap();
            let now = now_ms();
            sessions.retain(|_, s| {
                s.cancel.is_some() || now.saturating_sub(s.closed_at_ms) < FEED_SESSION_TTL_MS
            });
            if let Some(session) = sessions.get(feed_id) {
                if session.channel != channel {
                    return Err(FeedError::new(409, "feed_channel_mismatch"));
                }
                if session.ended {
                    return Err(FeedError::new(410, "feed_ended"));
                }
            } else if sessions.len() >= MAX_FEED_SESSIONS {
                return Err(FeedError::new(503, "too_many_feeds"));
            }
            let session = sessions
                .entry(feed_id.to_owned())
                .or_insert_with(|| Session {
                    channel: channel.to_owned(),
                    next_index: None,
                    written: false,
                    generation: None,
                    respawns_behind: 0,
                    ended: false,
                    closed_at_ms: 0,
                    lease: 0,
                    cancel: None,
                    stalled: stalled.clone(),
                });
            if let Some(previous) = session.cancel.take() {
                let _ = previous.send(true);
            }
            session.lease = session.lease.wrapping_add(1);
            session.cancel = Some(cancel.clone());
            session.stalled = stalled.clone();
            Lease {
                inner: self.inner.clone(),
                id: feed_id.to_owned(),
                lease: session.lease,
            }
        };
        let mut changes = self.inner.ingest.subscribe(channel);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(FEED_START_WAIT_MS);
        loop {
            let lifecycle = (self.inner.lifecycle)(channel);
            match self.inner.ingest.snapshot(channel) {
                Some(snapshot) if !snapshot.segments.is_empty() => break,
                None if !lifecycle.failing_over => {
                    return Err(FeedError::new(404, "channel_not_found"));
                }
                _ => {}
            }
            tokio::select! {
                _ = wait_cancelled(&mut cancelled) => return Err(FeedError::new(409, "feed_superseded")),
                _ = tokio::time::sleep_until(deadline) => return Err(FeedError::new(404, "no_segments")),
                _ = changes.changed() => {},
                _ = tokio::time::sleep(Duration::from_millis(250)) => {},
            }
        }
        let (sender, receiver) = mpsc::channel(1);
        let channel = channel.to_owned();
        tokio::spawn(async move {
            pump(lease, channel, sender, changes, cancelled).await;
        });
        Ok(FeedStream {
            receiver,
            cancel,
            stalled,
            error_emitted: false,
        })
    }
}
async fn wait_cancelled(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    loop {
        if cancel.changed().await.is_err() || *cancel.borrow() {
            return;
        }
    }
}
fn respawns_behind(state: &FeedLifecycle, next_index: u64) -> u64 {
    state.aged_out.saturating_add(
        state
            .anchors
            .iter()
            .filter(|&&index| index < next_index)
            .count() as u64,
    )
}
fn crossed(state: &FeedLifecycle, first: u64, last: u64) -> bool {
    state
        .anchors
        .iter()
        .any(|&index| index >= first && index <= last)
}
fn generation_changed(
    session: &Session,
    snapshot: &IngestSnapshot,
    lifecycle: &FeedLifecycle,
) -> bool {
    session.written
        && (session.generation != Some(snapshot.generation)
            || respawns_behind(lifecycle, session.next_index.unwrap_or(0))
                > session.respawns_behind)
}
fn end_session(lease: &Lease) {
    if let Some(session) = lease
        .inner
        .sessions
        .lock()
        .unwrap()
        .get_mut(&lease.id)
        .filter(|s| s.lease == lease.lease)
    {
        session.ended = true;
    }
}
fn abort_response(lease: &Lease) {
    if let Some(session) = lease
        .inner
        .sessions
        .lock()
        .unwrap()
        .get(&lease.id)
        .filter(|s| s.lease == lease.lease)
        && let Some(cancel) = &session.cancel
    {
        session.stalled.store(true, Ordering::Release);
        let _ = cancel.send(true);
    }
}
async fn pump(
    lease: Lease,
    channel: String,
    sender: mpsc::Sender<Frame>,
    mut changes: watch::Receiver<u64>,
    mut cancel: watch::Receiver<bool>,
) {
    let mut hole_since = None;
    loop {
        if *cancel.borrow() {
            return;
        }
        let Some(snapshot) = lease.inner.ingest.snapshot(&channel) else {
            end_session(&lease);
            return;
        };
        let lifecycle = (lease.inner.lifecycle)(&channel);
        let selected: Option<Arc<Segment>> = {
            let mut sessions = lease.inner.sessions.lock().unwrap();
            let Some(session) = sessions
                .get_mut(&lease.id)
                .filter(|s| s.lease == lease.lease)
            else {
                return;
            };
            if generation_changed(session, &snapshot, &lifecycle) {
                session.ended = true;
                return;
            }
            if session.next_index.is_none() && !snapshot.segments.is_empty() {
                let newest = snapshot.segments.last().unwrap().index;
                let backlog = snapshot.segments
                    [snapshot.segments.len().saturating_sub(FEED_START_BACKLOG)]
                .index;
                let anchor = lifecycle
                    .anchors
                    .iter()
                    .copied()
                    .filter(|&index| index <= newest)
                    .max()
                    .unwrap_or(0);
                let next = backlog.max(anchor);
                session.next_index = Some(next);
                session.respawns_behind = respawns_behind(&lifecycle, next);
                session.generation = Some(snapshot.generation);
            }
            let next = session.next_index.unwrap_or(0);
            if session.written
                && snapshot
                    .segments
                    .last()
                    .is_some_and(|s| s.index.saturating_add(1) < next)
            {
                session.ended = true;
                return;
            }
            let candidate = snapshot.segments.iter().find(|s| s.index >= next).cloned();
            if let Some(segment) = &candidate {
                if session.written && crossed(&lifecycle, next, segment.index) {
                    session.ended = true;
                    return;
                }
                if segment.index > next
                    && snapshot.segments.first().is_some_and(|s| next >= s.index)
                {
                    let since = hole_since.get_or_insert_with(tokio::time::Instant::now);
                    if since.elapsed() < Duration::from_millis(FEED_HOLE_GRACE_MS) {
                        None
                    } else {
                        candidate
                    }
                } else {
                    candidate
                }
            } else {
                None
            }
        };
        let Some(segment) = selected else {
            tokio::select! { _ = wait_cancelled(&mut cancel) => return, _ = changes.changed() => {}, _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
            continue;
        };
        hole_since = None;
        {
            let mut sessions = lease.inner.sessions.lock().unwrap();
            let Some(session) = sessions
                .get_mut(&lease.id)
                .filter(|s| s.lease == lease.lease)
            else {
                return;
            };
            session.next_index = Some(segment.index.saturating_add(1));
            session.written = true;
            session.respawns_behind = respawns_behind(&lifecycle, session.next_index.unwrap());
            session.generation = Some(snapshot.generation);
        }
        // A slow feed owns the selected segment only, never an obsolete whole ring.
        drop(snapshot);
        let deadline =
            tokio::time::Instant::now() + Duration::from_millis(lease.inner.stalled_reader_ms);
        // Copy small independent network frames: a stopped response must not retain
        // a slice backed by an entire retired multi-megabyte segment indefinitely.
        for chunk in segment.data.chunks(64 * 1024) {
            let (consumed, mut delivered) = oneshot::channel();
            tokio::select! {
                result = sender.send(Frame { data: Bytes::copy_from_slice(chunk), consumed }) => { if result.is_err() { return; } },
                _ = wait_cancelled(&mut cancel) => return,
                _ = tokio::time::sleep_until(deadline) => { abort_response(&lease); return; },
            }
            // While blocked, ring notifications must still stop a feed immediately at an
            // ingest replacement. Waiting only for body demand would pin old generations.
            loop {
                tokio::select! {
                    _ = &mut delivered => break,
                    _ = wait_cancelled(&mut cancel) => return,
                    _ = tokio::time::sleep_until(deadline) => { abort_response(&lease); return; },
                    _ = changes.changed() => {
                        let next = lease.inner.ingest.snapshot(&channel);
                        let lifecycle = (lease.inner.lifecycle)(&channel);
                        let ended = match next {
                            None => true,
                            Some(snapshot) => {
                                let sessions = lease.inner.sessions.lock().unwrap();
                                sessions.get(&lease.id).is_none_or(|session| generation_changed(session, &snapshot, &lifecycle) || snapshot.segments.last().is_some_and(|last| crossed(&lifecycle, session.next_index.unwrap_or(0), last.index)))
                            },
                        };
                        if ended { end_session(&lease); return; }
                    },
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Environment, ProxyConfig};
    async fn next(stream: &mut FeedStream) -> Option<Bytes> {
        std::future::poll_fn(|cx| Pin::new(&mut *stream).poll_next(cx))
            .await
            .map(Result::unwrap)
    }
    fn manager(stall_ms: u64) -> (Arc<IngestManager>, FeedManager) {
        let env = Environment::new();
        let ingest = Arc::new(IngestManager::new(
            ProxyConfig::from_env(&env),
            env,
            std::env::temp_dir().join("feed-test-unused"),
        ));
        let feed = FeedManager::with_stall_timeout(
            ingest.clone(),
            Arc::new(|_| FeedLifecycle::default()),
            stall_ms,
        );
        (ingest, feed)
    }
    #[tokio::test]
    async fn reconnect_resumes_without_replaying_and_newest_lease_wins() {
        let (ingest, manager) = manager(1000);
        ingest.publish_test("channel", 1, &[0, 1, 2, 3]);
        let mut old = manager
            .open("channel", "valid-feed-session-0002")
            .await
            .unwrap();
        assert_eq!(next(&mut old).await.unwrap(), Bytes::from_static(b"1"));
        let mut successor = manager
            .open("channel", "valid-feed-session-0002")
            .await
            .unwrap();
        assert!(next(&mut old).await.is_none());
        assert_eq!(
            next(&mut successor).await.unwrap(),
            Bytes::from_static(b"2")
        );
        drop(successor);
        tokio::task::yield_now().await;
        assert_eq!(manager.active_count(), 0);
    }
    #[tokio::test]
    async fn blocked_feed_ends_on_generation_change_and_healthy_reader_advances() {
        let (ingest, manager) = manager(1000);
        ingest.publish_test("channel", 1, &[0]);
        let mut blocked = manager
            .open("channel", "valid-feed-session-0003")
            .await
            .unwrap();
        let mut healthy = manager
            .open("channel", "valid-feed-session-0004")
            .await
            .unwrap();
        assert_eq!(next(&mut healthy).await.unwrap(), Bytes::from_static(b"0"));
        ingest.publish_test("channel", 1, &[0, 1]);
        assert_eq!(next(&mut healthy).await.unwrap(), Bytes::from_static(b"1"));
        ingest.publish_test("channel", 2, &[2]);
        tokio::time::timeout(Duration::from_secs(1), async {
            while manager.active_count() > 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // The one old-encode write may finish before the deliberate EOF.
        assert_eq!(next(&mut blocked).await.unwrap(), Bytes::from_static(b"0"));
        assert!(next(&mut blocked).await.is_none());
        assert_eq!(
            manager
                .open("channel", "valid-feed-session-0003")
                .await
                .err()
                .unwrap()
                .status,
            410
        );
    }
    #[tokio::test]
    async fn stalled_feed_is_bounded_and_does_not_block_another_reader() {
        let (ingest, manager) = manager(30);
        ingest.publish_test("channel", 1, &[0]);
        let mut blocked = manager
            .open("channel", "valid-feed-session-0005")
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while manager.active_count() > 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let stalled_result = std::future::poll_fn(|cx| Pin::new(&mut blocked).poll_next(cx)).await;
        assert_eq!(
            stalled_result.unwrap().unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert!(
            std::future::poll_fn(|cx| Pin::new(&mut blocked).poll_next(cx))
                .await
                .is_none()
        );
        ingest.publish_test("channel", 1, &[0, 1]);
        let mut resumed = manager
            .open("channel", "valid-feed-session-0005")
            .await
            .unwrap();
        assert_eq!(next(&mut resumed).await.unwrap(), Bytes::from_static(b"1"));
        let mut healthy = manager
            .open("channel", "valid-feed-session-0006")
            .await
            .unwrap();
        assert_eq!(next(&mut healthy).await.unwrap(), Bytes::from_static(b"0"));
    }
    #[tokio::test]
    async fn invalid_and_unknown_feeds_allocate_no_sessions() {
        let env = Environment::new();
        let ingest = Arc::new(IngestManager::new(
            ProxyConfig::from_env(&env),
            env,
            std::env::temp_dir().join("feed-unstarted"),
        ));
        let manager = FeedManager::new(ingest, Arc::new(|_| FeedLifecycle::default()));
        assert_eq!(
            manager.open("channel", "short").await.err().unwrap().error,
            "invalid_feed_id"
        );
        assert_eq!(
            manager
                .open("channel", "valid-feed-session-0001")
                .await
                .err()
                .unwrap()
                .error,
            "channel_not_found"
        );
        assert_eq!(manager.session_count(), 0);
    }
    #[test]
    fn feed_grants_are_per_channel_and_end_with_their_holder() {
        let grants = FeedGrants::default();
        let grant = grants.grant("channel", "valid-feed-session-0007");
        assert!(grants.allows("channel", "valid-feed-session-0007"));
        assert!(!grants.allows("other", "valid-feed-session-0007"));
        assert!(!grants.allows("channel", "valid-feed-session-0008"));
        drop(grant);
        assert!(!grants.allows("channel", "valid-feed-session-0007"));
    }
    #[test]
    fn aged_anchor_count_does_not_jump_when_an_anchor_is_pruned() {
        assert_eq!(
            respawns_behind(
                &FeedLifecycle {
                    anchors: vec![10, 20],
                    aged_out: 3,
                    ..Default::default()
                },
                15
            ),
            4
        );
        assert_eq!(
            respawns_behind(
                &FeedLifecycle {
                    anchors: vec![20],
                    aged_out: 4,
                    ..Default::default()
                },
                15
            ),
            4
        );
    }
}

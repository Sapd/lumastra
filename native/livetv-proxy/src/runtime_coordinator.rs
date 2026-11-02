// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Viewer and source ownership. No registry lock survives a probe or child wait.
use crate::{
    config::Environment,
    failure_reason::{self, Combined, FeedFailure},
    runtime_feed::FeedLifecycle,
    runtime_ingest::{AttemptLabel, IngestManager},
    runtime_media::{FailureEventInput, now_ms},
    runtime_outputs::OutputManager,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio::sync::Mutex as AsyncMutex;

/// Upper bound of JoinRequest.awaitReadyMs.
pub const MAX_AWAIT_READY_MS: u64 = 20_000;
/// How often a waiting join looks for the first segment or a terminal failure.
const AWAIT_READY_POLL_MS: u64 = 100;

#[derive(Clone, Default)]
struct Viewer {
    heartbeat: u64,
    rung: Option<String>,
    adaptive: bool,
    hevc: Option<String>,
    /// Identity of the admission that created this session (a waiting join checks it).
    admission: u64,
}
/// The channel's failed attempts and latest failure; `terminal` once every URL failed.
/// Shared with joins waiting on the channel, so they see its failure even after another
/// join tore the dead channel down to start over.
#[derive(Default)]
struct FailureBook {
    /// One entry per failed attempt, in order; bounded by streamUrls (index only grows).
    feeds: Vec<FeedFailure>,
    failure: Option<(Combined, bool)>,
}
impl FailureBook {
    fn terminal(&self) -> bool {
        self.failure.as_ref().is_some_and(|(_, terminal)| *terminal)
    }
    /// Body of a 502 join / heartbeat failure / HLS 410.
    fn body(&self, with_feeds: bool) -> Value {
        let combined = self
            .failure
            .as_ref()
            .map(|(combined, _)| combined.clone())
            .unwrap_or_else(|| failure_reason::combine(&self.feeds));
        let mut body = combined.to_json();
        body["error"] = json!("channel_failed");
        if with_feeds {
            body["feedsTried"] = self.feeds_tried();
        }
        body
    }
    fn feeds_tried(&self) -> Value {
        json!(
            self.feeds
                .iter()
                .map(FeedFailure::to_json)
                .collect::<Vec<_>>()
        )
    }
}
/// Clamp a join's awaitReadyMs into 0..MAX_AWAIT_READY_MS (anything else is 0).
pub fn clamp_await_ready_ms(value: &Value) -> u64 {
    match value.as_f64() {
        Some(ms) if ms.is_finite() && ms > 0.0 => (ms.floor() as u64).min(MAX_AWAIT_READY_MS),
        _ => 0,
    }
}
/// Why spawn() refused before FFmpeg ran: URL rejected, address refused, or our side.
fn classify_spawn_error(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if [
        "invalid_stream_url",
        "invalid stream url",
        "unsupported direct stream protocol",
        "unsupported upstream protocol",
        "invalid upstream target",
    ]
    .contains(&lower.as_str())
    {
        return "channel_offline";
    }
    if lower.contains("private")
        || lower.contains("dns")
        || lower.contains("resolve")
        || lower == "upstream connection failed"
    {
        return "provider_unreachable";
    }
    "encoder_failed"
}
fn feed_id(request: &Value, index: usize) -> Option<String> {
    request["feedIds"][index].as_str().map(str::to_owned)
}
/// A successful admission a join may still wait on (awaitReadyMs).
struct Admission {
    channel: String,
    viewer: String,
    instance: u64,
    admission: u64,
    failures: Arc<Mutex<FailureBook>>,
    wait_ms: u64,
}
/// Leaves the waiting viewer when nobody reads the join's answer any more.
struct WaitGuard {
    owner: Weak<Coordinator>,
    channel: String,
    viewer: String,
    instance: u64,
    admission: u64,
    armed: bool,
}
impl Drop for WaitGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let (Some(owner), Ok(runtime)) =
            (self.owner.upgrade(), tokio::runtime::Handle::try_current())
        else {
            return;
        };
        let (channel, viewer) = (self.channel.clone(), self.viewer.clone());
        let (instance, admission) = (self.instance, self.admission);
        runtime.spawn(async move {
            if owner.attached(&channel, &viewer, instance, admission) {
                owner.leave(&channel, &viewer).await;
            }
        });
    }
}
struct Channel {
    request: Value,
    viewers: BTreeMap<String, Viewer>,
    grace: Option<u64>,
    index: usize,
    failing: bool,
    exhausted: bool,
    failovers: u64,
    degraded: Option<u64>,
    healthy_since: Option<u64>,
    reset_restarted: bool,
    anchors: Vec<u64>,
    aged: u64,
    start: u64,
    failures: Arc<Mutex<FailureBook>>,
    /// Distinguishes this registration from a later one under the same id.
    instance: u64,
    started_ms: u64,
}
impl Channel {
    fn new(request: Value, grace: Option<u64>, instance: u64) -> Self {
        Self {
            request,
            viewers: BTreeMap::new(),
            grace,
            index: 0,
            failing: false,
            exhausted: false,
            failovers: 0,
            degraded: None,
            healthy_since: None,
            reset_restarted: false,
            anchors: vec![],
            aged: 0,
            start: 0,
            failures: Arc::default(),
            instance,
            started_ms: now_ms(),
        }
    }
    fn note_input_health(&mut self, healthy: bool, now: u64) {
        if healthy {
            let since = self.healthy_since.get_or_insert(now);
            if now.saturating_sub(*since) >= 30_000 {
                self.reset_restarted = false;
            }
        } else {
            self.healthy_since = None;
        }
    }
    fn retry_reset_on_same_feed(&mut self, timeline_reset: bool) -> bool {
        if !timeline_reset || self.reset_restarted {
            return false;
        }
        self.reset_restarted = true;
        self.healthy_since = None;
        true
    }
    fn terminal(&self) -> bool {
        self.failures.lock().unwrap().terminal()
    }
    /// False for a terminal channel whose ingest is already stopped: it holds no
    /// provider connection, so it must not refuse other channels of the source. It still
    /// counts while that ingest is being stopped (`failing`).
    fn holds_source_slot(&self) -> bool {
        !(self.terminal() && !self.failing)
    }
}
#[derive(Default)]
struct Registry {
    channels: BTreeMap<String, Channel>,
    epochs: BTreeMap<(String, String), u64>,
    viewer_locks: BTreeMap<String, Weak<AsyncMutex<()>>>,
    channel_locks: BTreeMap<String, Weak<AsyncMutex<()>>>,
    pending_viewers: BTreeMap<String, usize>,
    pending_pairs: BTreeMap<(String, String), usize>,
}
pub struct Coordinator {
    pub ingest: Arc<IngestManager>,
    pub outputs: Arc<OutputManager>,
    registry: Mutex<Registry>,
    stopping: AtomicBool,
    pending: Arc<tokio::sync::Semaphore>,
    kill_permits: Arc<tokio::sync::Semaphore>,
    grace_ms: u64,
    viewer_ms: u64,
    degraded_ms: u64,
    orphan_ms: u64,
    health_ms: u64,
    last_orphan: AtomicU64,
    last_health: AtomicU64,
    next_id: AtomicU64,
}
struct PendingJoinGuard {
    owner: Weak<Coordinator>,
    viewer: String,
    channel: String,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl Drop for PendingJoinGuard {
    fn drop(&mut self) {
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        let Ok(mut state) = owner.registry.lock() else {
            return;
        };
        if let Some(count) = state.pending_viewers.get_mut(&self.viewer) {
            *count -= 1;
            if *count == 0 {
                state.pending_viewers.remove(&self.viewer);
            }
        }
        let pair = (self.viewer.clone(), self.channel.clone());
        if let Some(count) = state.pending_pairs.get_mut(&pair) {
            *count -= 1;
            if *count == 0 {
                state.pending_pairs.remove(&pair);
                state.epochs.remove(&pair);
            }
        }
    }
}
fn seconds(env: &Environment, name: &str, default: u64) -> u64 {
    env.get(name)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
        .saturating_mul(1000)
}
fn refusal(reason: &str) -> (u16, Value) {
    (503, json!({"error":"cap_unavailable","refusal":reason}))
}
fn uncapped(channel: &str) -> Value {
    json!({"success":true,"channelId":channel,"rungId":null,"appliedMaxBitrate":null,"reason":null,"ready":false})
}
impl Coordinator {
    pub fn new(ingest: Arc<IngestManager>, outputs: Arc<OutputManager>, env: &Environment) -> Self {
        Self {
            ingest,
            outputs,
            registry: Mutex::new(Registry::default()),
            stopping: AtomicBool::new(false),
            pending: Arc::new(tokio::sync::Semaphore::new(128)),
            kill_permits: Arc::new(tokio::sync::Semaphore::new(32)),
            grace_ms: seconds(env, "LIVETV_GRACE_PERIOD_SECONDS", 30),
            viewer_ms: seconds(env, "LIVETV_VIEWER_TIMEOUT_SECONDS", 30),
            degraded_ms: seconds(env, "LIVETV_DEGRADED_FAILOVER_SECONDS", 60),
            orphan_ms: seconds(env, "LIVETV_ORPHAN_CHECK_INTERVAL_SECONDS", 10),
            health_ms: seconds(env, "LIVETV_HEALTH_CHECK_INTERVAL_SECONDS", 3),
            last_orphan: AtomicU64::new(now_ms()),
            last_health: AtomicU64::new(now_ms()),
            next_id: AtomicU64::new(1),
        }
    }
    fn fresh_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }
    /// True once the channel's ingest has published at least one segment.
    fn has_segment(&self, channel: &str) -> bool {
        self.ingest
            .snapshot(channel)
            .is_some_and(|s| !s.segments.is_empty())
    }
    /// The viewer's session from this admission is still on this registration.
    fn attached(&self, channel: &str, viewer: &str, instance: u64, admission: u64) -> bool {
        self.registry
            .lock()
            .unwrap()
            .channels
            .get(channel)
            .is_some_and(|row| {
                row.instance == instance
                    && row
                        .viewers
                        .get(viewer)
                        .is_some_and(|v| v.admission == admission)
            })
    }
    /// The HLS-route answer for a terminal channel (410), or None while it is not
    /// terminal. Never carries feedsTried: these bodies reach players.
    pub fn hls_failure(&self, channel: &str) -> Option<Value> {
        let failures = self
            .registry
            .lock()
            .unwrap()
            .channels
            .get(channel)?
            .failures
            .clone();
        let book = failures.lock().unwrap();
        book.terminal().then(|| book.body(false))
    }
    fn emit_failure(
        &self,
        channel: &str,
        outcome: &str,
        reason: &str,
        attempt: Option<(usize, Option<String>)>,
        upstream_status: Option<u16>,
    ) {
        let ingest = attempt.as_ref().and_then(|_| self.ingest.snapshot(channel));
        let (stream_url_index, feed_id) = attempt.unzip();
        self.ingest.report_failure(FailureEventInput {
            channel_id: channel.into(),
            source: "ingest".into(),
            outcome: outcome.into(),
            exit_code: None,
            signal: None,
            rung_id: None,
            stderr_tail: ingest
                .as_ref()
                .map(|s| s.stderr_tail.clone())
                .unwrap_or_default(),
            probe: ingest
                .as_ref()
                .map(|s| s.probe.clone())
                .unwrap_or(Value::Null),
            decision: ingest.map(|s| s.decision).unwrap_or(Value::Null),
            reason: Some(reason.into()),
            upstream_status,
            stream_url_index,
            feed_id: feed_id.flatten(),
        });
    }
    /// Remember one failed attempt and make it the channel's latest failure.
    fn record_feed_failure(
        row: &Channel,
        index: usize,
        reason: &'static str,
        upstream_status: Option<u16>,
    ) {
        let mut book = row.failures.lock().unwrap();
        book.feeds.push(FeedFailure {
            index,
            feed_id: feed_id(&row.request, index),
            reason: reason.into(),
            upstream_status,
        });
        book.failure = Some((Combined::from_policy(reason), false));
    }
    /// Classify the attempt being abandoned and record it, emitting a `stalled` event
    /// unless the ingest manager already recorded this attempt (a crash).
    fn record_attempt_failure(&self, channel: &str) {
        let verdict = self.ingest.attempt_failure(channel, true);
        let reason = verdict.as_ref().map(|v| v.reason).unwrap_or_else(|| {
            if self.has_segment(channel) {
                "upstream_stalled"
            } else {
                "channel_offline"
            }
        });
        let upstream_status = verdict.as_ref().and_then(|v| v.upstream_status);
        let attempt = {
            let state = self.registry.lock().unwrap();
            let Some(row) = state.channels.get(channel) else {
                return;
            };
            if row.request["streamUrls"][row.index].is_null() {
                return;
            }
            Self::record_feed_failure(row, row.index, reason, upstream_status);
            (row.index, feed_id(&row.request, row.index))
        };
        eprintln!(
            "[Multiplexer] {channel} URL index {} failed: {reason}{}",
            attempt.0,
            upstream_status.map_or(String::new(), |s| format!(" (HTTP {s})"))
        );
        if !verdict.is_some_and(|v| v.reported) {
            self.emit_failure(channel, "stalled", reason, Some(attempt), upstream_status);
        }
    }
    /// Every URL failed: the channel is terminal until a new join starts it over.
    fn mark_terminal(&self, channel: &str) {
        let reason = {
            let mut state = self.registry.lock().unwrap();
            let Some(row) = state.channels.get_mut(channel) else {
                return;
            };
            row.exhausted = true;
            let mut book = row.failures.lock().unwrap();
            let combined = failure_reason::combine(&book.feeds);
            let reason = combined.reason;
            book.failure = Some((combined, true));
            eprintln!(
                "[Multiplexer] {channel} failed on every URL ({} tried): {reason}",
                row.request["streamUrls"].as_array().map_or(0, Vec::len)
            );
            reason
        };
        self.emit_failure(channel, "exhausted", reason, None, None);
    }
    fn gate(&self, id: &str, viewer: bool) -> Arc<AsyncMutex<()>> {
        let mut state = self.registry.lock().unwrap();
        let map = if viewer {
            &mut state.viewer_locks
        } else {
            &mut state.channel_locks
        };
        map.retain(|_, weak| weak.strong_count() > 0);
        if let Some(gate) = map.get(id).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(AsyncMutex::new(()));
        map.insert(id.into(), Arc::downgrade(&gate));
        gate
    }
    fn cancelled(&self, viewer: &str, channel: &str, epoch: u64) -> bool {
        self.stopping.load(Ordering::Acquire)
            || self
                .registry
                .lock()
                .unwrap()
                .epochs
                .get(&(viewer.into(), channel.into()))
                .copied()
                .unwrap_or(0)
                != epoch
    }
    pub fn lifecycle(&self, channel: &str) -> FeedLifecycle {
        let first = self
            .ingest
            .snapshot(channel)
            .and_then(|s| s.segments.first().map(|s| s.index));
        let mut state = self.registry.lock().unwrap();
        let Some(row) = state.channels.get_mut(channel) else {
            return FeedLifecycle::default();
        };
        if let Some(first) = first {
            let count = row.anchors.iter().take_while(|n| **n < first).count();
            row.anchors.drain(..count);
            row.aged += count as u64;
        }
        FeedLifecycle {
            failing_over: row.failing,
            anchors: row.anchors.clone(),
            aged_out: row.aged,
        }
    }
    pub fn heartbeat(&self, channel: &str, viewer: &str) -> Value {
        let mut state = self.registry.lock().unwrap();
        let Some(row) = state.channels.get_mut(channel) else {
            return json!({"success":false,"message":"channel_not_found"});
        };
        let Some(session) = row.viewers.get_mut(viewer) else {
            return json!({"success":false,"message":"viewer_not_found"});
        };
        session.heartbeat = now_ms();
        let book = row.failures.lock().unwrap();
        if book.terminal() {
            let body = book.body(true);
            let mut failure = json!({"reason":body["reason"],"retryable":body["retryable"],"feedsTried":body["feedsTried"]});
            if let Some(wait) = body.get("retryAfterMs") {
                failure["retryAfterMs"] = wait.clone();
            }
            return json!({"success":false,"message":"channel_failed","failure":failure});
        }
        json!({"success":true})
    }
    pub async fn leave(&self, channel: &str, viewer: &str) -> Value {
        let session = {
            let mut state = self.registry.lock().unwrap();
            // Epoch belongs to queued/in-flight joins only, keeping this table bounded.
            let pair = (viewer.to_owned(), channel.to_owned());
            if state.pending_pairs.contains_key(&pair) {
                let epoch = state.epochs.entry(pair).or_default();
                *epoch = epoch.wrapping_add(1);
            }
            state.channels.get_mut(channel).and_then(|row| {
                let session = row.viewers.remove(viewer);
                if row.viewers.is_empty() && row.grace.is_none() {
                    row.grace = Some(now_ms());
                }
                session
            })
        };
        if let Some(session) = session {
            self.release(channel, viewer, &session, None, false).await;
        }
        json!({"success":true})
    }
    /// Revocation cannot retain a provider slot or encoder through a grace period.
    /// Serialize the idle check and stop with joins; never kill another viewer.
    pub async fn leave_immediately(&self, channel: &str, viewer: &str) -> Value {
        let gate = self.gate(channel, false);
        let _guard = gate.lock().await;
        let response = self.leave(channel, viewer).await;
        // Also detach older/side outputs not recorded as this viewer's current rung.
        self.outputs.detach_viewer(channel, viewer).await;
        self.outputs.stop_idle(channel).await;
        let idle = self
            .registry
            .lock()
            .unwrap()
            .channels
            .get(channel)
            .is_some_and(|row| row.viewers.is_empty());
        if idle {
            self.outputs.stop_channel(channel).await;
            let _ = self.ingest.stop(channel).await;
            self.registry.lock().unwrap().channels.remove(channel);
        }
        response
    }
    async fn release(
        &self,
        channel: &str,
        viewer: &str,
        previous: &Viewer,
        keep: Option<&str>,
        adaptive: bool,
    ) {
        if let Some(rung) = &previous.rung
            && Some(rung.as_str()) != keep
        {
            self.outputs.detach(channel, rung, viewer).await;
        }
        if previous.adaptive && !adaptive {
            self.outputs.detach_adaptive(channel, viewer).await;
        }
    }
    fn compat(&self, channel: &str, hevc: Option<&str>) -> Option<&'static str> {
        if !matches!(hevc, Some("fmp4" | "none")) {
            return None;
        }
        let state = self.ingest.snapshot(channel)?;
        let writes_hevc = if state.decision["videoAction"] == "copy" {
            state.probe["video"]["codec"] == "hevc"
        } else {
            state.decision["videoEncoder"]
                .as_str()
                .is_some_and(|s| s.starts_with("hevc"))
        };
        writes_hevc.then_some(if hevc == Some("fmp4") { "fmp4" } else { "h264" })
    }
    async fn apply(
        &self,
        channel: &str,
        request: &Value,
        previous: &Viewer,
        epoch: u64,
    ) -> Result<(Value, Viewer), (u16, Value)> {
        let viewer = request["viewerId"].as_str().unwrap_or_default();
        if self.cancelled(viewer, channel, epoch) {
            return Err(refusal("internal"));
        }
        let mut next = previous.clone();
        next.heartbeat = now_ms();
        if let Some(hevc) = request["client"]["hevc"].as_str() {
            next.hevc = Some(hevc.into());
        }
        let mut body = uncapped(channel);
        let mut variant = None;
        if let Some(adaptive) = request.get("adaptive") {
            let mut adaptive = adaptive.clone();
            if self.compat(channel, next.hevc.as_deref()).is_some() {
                adaptive["includeOriginal"] = json!(false);
            }
            let result = self
                .outputs
                .attach_adaptive(channel, &adaptive, viewer)
                .await;
            if result["ok"] != true {
                return Err(refusal(result["refusal"].as_str().unwrap_or("internal")));
            }
            next.rung = None;
            next.adaptive = true;
            body["adaptive"] =
                json!({"rungs":result["rungs"],"includesOriginal":result["includesOriginal"]});
        } else {
            let result = if let Some(cap) = request.get("cap") {
                self.outputs
                    .attach_fixed(channel, &cap["rung"], viewer, cap)
                    .await
            } else {
                json!({"ok":true,"capped":false,"reason":null})
            };
            if result["ok"] != true {
                return Err(refusal(result["refusal"].as_str().unwrap_or("internal")));
            }
            next.adaptive = false;
            if result["capped"] == true {
                next.rung = result["rungId"].as_str().map(str::to_owned);
                body["rungId"] = result["rungId"].clone();
                body["appliedMaxBitrate"] = result["appliedMaxBitrate"].clone();
                body["reason"] = result["reason"].clone();
            } else {
                body["reason"] = result["reason"].clone();
                variant = self.compat(channel, next.hevc.as_deref());
                if let Some(variant) = variant {
                    let attached = self.outputs.attach_variant(channel, variant, viewer).await;
                    if attached["ok"] != true {
                        return Err(refusal(attached["refusal"].as_str().unwrap_or("internal")));
                    }
                    next.rung = attached["rungId"].as_str().map(str::to_owned);
                    body["variant"] = json!(variant);
                } else {
                    next.rung = None;
                }
            }
        }
        if self.cancelled(viewer, channel, epoch) {
            self.release(channel, viewer, &next, None, false).await;
            return Err(refusal("internal"));
        }
        self.release(
            channel,
            viewer,
            previous,
            next.rung.as_deref(),
            next.adaptive,
        )
        .await;
        let _ = variant;
        Ok((body, next))
    }
    pub async fn join(self: &Arc<Self>, channel: &str, request: &Value) -> (u16, Value) {
        // Register the cancellation epoch before detaching; a subsequent leave
        // must see this join even before its owned task first gets scheduled.
        let Ok(permit) = self.pending.clone().try_acquire_owned() else {
            return refusal("internal");
        };
        let viewer = request["viewerId"].as_str().unwrap_or_default();
        let (gate, epoch) = {
            let mut state = self.registry.lock().unwrap();
            let count = state.pending_viewers.entry(viewer.into()).or_default();
            if *count >= 8 {
                return refusal("internal");
            }
            *count += 1;
            *state
                .pending_pairs
                .entry((viewer.into(), channel.into()))
                .or_default() += 1;
            state.viewer_locks.retain(|_, weak| weak.strong_count() > 0);
            let gate = state
                .viewer_locks
                .get(viewer)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| {
                    let gate = Arc::new(AsyncMutex::new(()));
                    state
                        .viewer_locks
                        .insert(viewer.into(), Arc::downgrade(&gate));
                    gate
                });
            let epoch = state
                .epochs
                .get(&(viewer.into(), channel.into()))
                .copied()
                .unwrap_or(0);
            (gate, epoch)
        };
        let cleanup = PendingJoinGuard {
            owner: Arc::downgrade(self),
            viewer: viewer.to_owned(),
            channel: channel.to_owned(),
            _permit: permit,
        };
        let owner = self.clone();
        let channel = channel.to_owned();
        let request = request.clone();
        let (status, body, admission) = tokio::spawn(async move {
            let _cleanup = cleanup;
            owner.join_owned(&channel, &request, epoch, gate).await
        })
        .await
        .unwrap_or_else(|_| {
            (
                500,
                json!({"error":"internal_error","message":"Join transaction failed"}),
                None,
            )
        });
        match admission {
            // Waits outside every gate: failover takes the channel gate.
            Some(admission) => self.await_ready(admission, body).await,
            None => (status, body),
        }
    }
    /// Hold a successful join until the channel can play (`awaitReadyMs`): the first
    /// segment exists (200 with `ready: true`), the channel turned terminal (502
    /// channel_failed, and this viewer leaves), or the deadline passed (200 with
    /// `ready: false`). A channel that already produces returns at once.
    ///
    /// While waiting the channel can change under this join: the request goes away
    /// (this future is dropped; the viewer leaves instead of holding the slot as a
    /// ghost), the channel turns terminal (also when another join already tore it down
    /// to start over), or this viewer was detached / the channel replaced without
    /// failing (503 cap_unavailable `internal`, like a join a leave cancelled).
    async fn await_ready(self: &Arc<Self>, admission: Admission, mut body: Value) -> (u16, Value) {
        let mut guard = WaitGuard {
            owner: Arc::downgrade(self),
            channel: admission.channel.clone(),
            viewer: admission.viewer.clone(),
            instance: admission.instance,
            admission: admission.admission,
            armed: true,
        };
        let mut waited = 0;
        loop {
            let attached = self.attached(
                &admission.channel,
                &admission.viewer,
                admission.instance,
                admission.admission,
            );
            let failed = {
                let book = admission.failures.lock().unwrap();
                book.terminal().then(|| book.body(true))
            };
            if let Some(failed) = failed {
                if !attached {
                    guard.armed = false;
                }
                // An attached viewer leaves through the guard's drop.
                return (502, failed);
            }
            guard.armed = false;
            if !attached {
                return refusal("internal");
            }
            let ready = self.has_segment(&admission.channel);
            if ready || waited >= admission.wait_ms {
                body["ready"] = json!(ready);
                return (200, body);
            }
            guard.armed = true;
            let step = AWAIT_READY_POLL_MS.min(admission.wait_ms - waited);
            tokio::time::sleep(std::time::Duration::from_millis(step)).await;
            waited += step;
        }
    }
    async fn join_owned(
        &self,
        channel: &str,
        request: &Value,
        epoch: u64,
        gate: Arc<AsyncMutex<()>>,
    ) -> (u16, Value, Option<Admission>) {
        let viewer = request["viewerId"].as_str().unwrap_or_default();
        let _viewer_guard = gate.lock().await;
        let other = {
            self.registry
                .lock()
                .unwrap()
                .channels
                .iter()
                .find(|(id, row)| id.as_str() != channel && row.viewers.contains_key(viewer))
                .map(|(id, _)| id.clone())
        };
        if let Some(other) = other {
            self.leave(&other, viewer).await;
        }
        let channel_gate = self.gate(channel, false);
        let _channel_guard = channel_gate.lock().await;
        self.perform_join(channel, request, epoch).await
    }
    async fn perform_join(
        &self,
        channel: &str,
        request: &Value,
        epoch: u64,
    ) -> (u16, Value, Option<Admission>) {
        let viewer = request["viewerId"].as_str().unwrap_or_default();
        if self.cancelled(viewer, channel, epoch) {
            let (status, body) = refusal("internal");
            return (status, body, None);
        }
        // Every URL failed earlier. A new join is a fresh attempt: tear the dead channel
        // down (egress, ingest, slot) and start over on the cold path. Its other viewers
        // are dropped with it: their next heartbeat answers viewer_not_found (404), which
        // the app treats as an expired session. This join holds the channel gate, so no
        // failover of it is in flight.
        let dead = self
            .registry
            .lock()
            .unwrap()
            .channels
            .get(channel)
            .is_some_and(Channel::terminal);
        if dead {
            eprintln!("[Multiplexer] Join to failed channel {channel}: starting over");
            self.outputs.stop_channel(channel).await;
            let _ = self.ingest.stop(channel).await;
            self.registry.lock().unwrap().channels.remove(channel);
        }
        let previous = self
            .registry
            .lock()
            .unwrap()
            .channels
            .get(channel)
            .and_then(|row| row.viewers.get(viewer))
            .cloned();
        // Reclaim the oldest abandoned source slot before taking a new reservation.
        // Hold no registry lock while another channel's children are reaped.
        let abandoned = {
            let state = self.registry.lock().unwrap();
            if state.channels.contains_key(channel) {
                Vec::new()
            } else {
                let count = state
                    .channels
                    .values()
                    .filter(|row| {
                        row.request["sourceId"] == request["sourceId"] && row.holds_source_slot()
                    })
                    .count();
                if count as f64 >= request["maxStreams"].as_f64().unwrap_or(1.0) {
                    let mut rows: Vec<_> = state
                        .channels
                        .iter()
                        .filter(|(_, row)| {
                            row.request["sourceId"] == request["sourceId"]
                                && row.viewers.is_empty()
                                && row.grace.is_some()
                        })
                        .map(|(id, row)| (row.grace.unwrap_or(0), id.clone()))
                        .collect();
                    rows.sort();
                    rows.into_iter().map(|(_, id)| id).collect()
                } else {
                    Vec::new()
                }
            }
        };
        for id in abandoned {
            self.reclaim(&id, &request["sourceId"]).await;
            let count = self
                .registry
                .lock()
                .unwrap()
                .channels
                .values()
                .filter(|row| {
                    row.request["sourceId"] == request["sourceId"] && row.holds_source_slot()
                })
                .count();
            if (count as f64) < request["maxStreams"].as_f64().unwrap_or(1.0) {
                break;
            }
        }
        let mut cold = false;
        let admission = {
            let mut state = self.registry.lock().unwrap();
            if !state.channels.contains_key(channel) {
                let source = &request["sourceId"];
                let holding = state
                    .channels
                    .values()
                    .filter(|row| &row.request["sourceId"] == source && row.holds_source_slot())
                    .count();
                if holding as f64 >= request["maxStreams"].as_f64().unwrap_or(1.0) {
                    // Lists every channel of the source, terminal ones included, like the TS proxy.
                    let active:Vec<Value> = state.channels.iter().filter(|(_,row)| &row.request["sourceId"]==source).map(|(id,row)|json!({"channelId":id,"channelName":row.request["channelName"],"viewers":row.viewers.len()})).collect();
                    Some((
                        503,
                        json!({"error":"stream_limit_reached","limit":request["maxStreams"],"active":active}),
                    ))
                } else {
                    state.channels.insert(
                        channel.into(),
                        Channel::new(request.clone(), None, self.fresh_id()),
                    );
                    cold = true;
                    None
                }
            } else {
                None
            }
        };
        if let Some((status, body)) = admission {
            return (status, body, None);
        }
        if cold {
            let url = request["streamUrls"][0].as_str().unwrap_or_default();
            let label = AttemptLabel {
                stream_url_index: 0,
                feed_id: feed_id(request, 0),
            };
            if let Err(message) = self
                .ingest
                .spawn_attempt(channel, url, 0, request["allowPrivateUrls"] == true, label)
                .await
            {
                let row = self.registry.lock().unwrap().channels.remove(channel);
                let reason = classify_spawn_error(&message);
                // The ingest manager reports an FFmpeg that could not be started itself.
                if message != "ffmpeg_spawn_failed" {
                    self.emit_failure(
                        channel,
                        "spawn_failed",
                        reason,
                        Some((0, feed_id(request, 0))),
                        None,
                    );
                }
                if reason != "encoder_failed"
                    && let Some(row) = row
                {
                    // The URL itself was refused (invalid, private-URL policy, DNS): a
                    // failed feed, answered like a channel that failed before its first
                    // segment.
                    Self::record_feed_failure(&row, 0, reason, None);
                    let body = row.failures.lock().unwrap().body(true);
                    return (502, body, None);
                }
                let policy = failure_reason::policy("encoder_failed");
                let mut body = json!({"error":"spawn_failed","message":message,"reason":"encoder_failed","retryable":policy.retryable});
                if let Some(wait) = policy.retry_after_ms {
                    body["retryAfterMs"] = json!(wait);
                }
                return (500, body, None);
            }
        }
        let old = previous.clone().unwrap_or_default();
        match self.apply(channel, request, &old, epoch).await {
            Ok((mut body, mut next)) => {
                if previous.is_none() {
                    next.admission = self.fresh_id();
                }
                let admitted = {
                    let mut state = self.registry.lock().unwrap();
                    if self.stopping.load(Ordering::Acquire)
                        || state
                            .epochs
                            .get(&(viewer.into(), channel.into()))
                            .copied()
                            .unwrap_or(0)
                            != epoch
                    {
                        None
                    } else if let Some(row) = state.channels.get_mut(channel) {
                        row.viewers.insert(viewer.into(), next.clone());
                        row.grace = None;
                        Some((row.instance, row.failures.clone()))
                    } else {
                        None
                    }
                };
                let Some((instance, failures)) = admitted else {
                    self.release(channel, viewer, &next, None, false).await;
                    let (status, body) = refusal("internal");
                    return (status, body, None);
                };
                if previous.is_some() {
                    // This join admitted nobody; it only reconciled an existing viewer's
                    // quality, so it answers at once.
                    body["existingViewer"] = json!(true);
                    body["ready"] = json!(self.has_segment(channel));
                    return (200, body, None);
                }
                let admission = Admission {
                    channel: channel.into(),
                    viewer: viewer.into(),
                    instance,
                    admission: next.admission,
                    failures,
                    wait_ms: clamp_await_ready_ms(&request["awaitReadyMs"]),
                };
                (200, body, Some(admission))
            }
            Err((status, body)) => {
                if cold && let Some(row) = self.registry.lock().unwrap().channels.get_mut(channel) {
                    row.grace = Some(now_ms());
                }
                (status, body, None)
            }
        }
    }
    async fn reclaim(&self, channel: &str, source: &Value) {
        let gate = self.gate(channel, false);
        // Another join/termination owns this channel; do not wait while holding the
        // joining channel's gate, and never reclaim from a stale candidate list.
        let Ok(_guard) = gate.try_lock() else { return };
        let reclaimable = self
            .registry
            .lock()
            .unwrap()
            .channels
            .get(channel)
            .is_some_and(|row| {
                &row.request["sourceId"] == source && row.viewers.is_empty() && row.grace.is_some()
            });
        // An encoder in its post-detach grace (no viewers) must not keep the source slot: a
        // capped viewer switching channel on a one-slot source would be refused for its 10 s.
        if !reclaimable || self.outputs.has_viewers(channel) {
            return;
        }
        self.outputs.stop_channel(channel).await;
        let _ = self.ingest.stop(channel).await;
        self.registry.lock().unwrap().channels.remove(channel);
    }
    pub async fn kill(self: &Arc<Self>, channel: &str) -> Value {
        // Waiting HTTP callers remain cancellable; at most 32 detached admin
        // transactions survive disconnection, independently from join capacity.
        let Ok(permit) = self.kill_permits.clone().acquire_owned().await else {
            return json!({"success":false,"viewersRemoved":0});
        };
        let owner = self.clone();
        let channel = channel.to_owned();
        tokio::spawn(async move {
            let _permit = permit;
            owner.kill_owned(&channel).await
        })
        .await
        .unwrap_or_else(|_| json!({"success":false,"viewersRemoved":0}))
    }
    async fn kill_owned(&self, channel: &str) -> Value {
        let gate = self.gate(channel, false);
        let _guard = gate.lock().await;
        let removed = self
            .registry
            .lock()
            .unwrap()
            .channels
            .get(channel)
            .map(|row| row.viewers.len())
            .unwrap_or(0);
        self.outputs.stop_channel(channel).await;
        let _ = self.ingest.stop(channel).await;
        self.registry.lock().unwrap().channels.remove(channel);
        json!({"success":true,"viewersRemoved":removed})
    }
    #[cfg(test)]
    pub(crate) fn seed_test_channel(&self, channel: &str, request: Value) {
        self.registry
            .lock()
            .unwrap()
            .channels
            .insert(channel.into(), Channel::new(request, Some(now_ms()), 0));
    }
    pub fn mux_status(&self) -> Value {
        let state = self.registry.lock().unwrap();
        let mut sources: BTreeMap<String, (usize, f64)> = BTreeMap::new();
        let mut viewers = 0;
        let channels:Vec<Value>=state.channels.iter().map(|(id,row)| {
            viewers+=row.viewers.len(); let source=row.request["sourceId"].as_str().unwrap_or_default().to_owned();
            let slot = usize::from(row.holds_source_slot());
            let entry=sources.entry(source).or_default(); entry.0+=slot; entry.1=entry.1.max(row.request["maxStreams"].as_f64().unwrap_or(1.0));
            let mut status = json!({"channelId":id,"channelName":row.request["channelName"],"sourceId":row.request["sourceId"],"viewers":row.viewers.len(),"activeStreamUrl":row.request["streamUrls"][row.index],"streamUrlIndex":row.index,"failoverCount":row.failovers,"failoverExhausted":row.exhausted,"startedAt":crate::runtime_operations::iso_timestamp(row.started_ms)});
            if let Some((combined, terminal)) = &row.failures.lock().unwrap().failure {
                status["lastFailureReason"] = json!(combined.reason);
                status["terminal"] = json!(terminal);
            }
            status
        }).collect();
        let sources:Vec<Value>=sources.into_iter().map(|(id,(active,max))|json!({"sourceId":id,"activeStreams":active,"maxStreams":max})).collect();
        json!({"channels":channels,"totalViewers":viewers,"perSourceLimits":sources})
    }
    pub async fn maintenance(self: &Arc<Self>) {
        if self.stopping.load(Ordering::Acquire) {
            return;
        }
        let now = now_ms();
        let orphan_due =
            now.saturating_sub(self.last_orphan.load(Ordering::Acquire)) >= self.orphan_ms;
        let health_due =
            now.saturating_sub(self.last_health.load(Ordering::Acquire)) >= self.health_ms;
        if orphan_due {
            self.last_orphan.store(now, Ordering::Release);
        }
        if health_due {
            self.last_health.store(now, Ordering::Release);
        }
        let stale: Vec<(String, String)> = if orphan_due {
            self.registry
                .lock()
                .unwrap()
                .channels
                .iter()
                .flat_map(|(id, row)| {
                    row.viewers
                        .iter()
                        .filter(|(_, v)| now.saturating_sub(v.heartbeat) > self.viewer_ms)
                        .map(|(viewer, _)| (id.clone(), viewer.clone()))
                })
                .collect()
        } else {
            Vec::new()
        };
        for (channel, viewer) in stale {
            self.leave(&channel, &viewer).await;
        }
        let ids: Vec<String> = self
            .registry
            .lock()
            .unwrap()
            .channels
            .keys()
            .cloned()
            .collect();
        for id in ids {
            let gate = self.gate(&id, false);
            let Ok(guard) = gate.try_lock_owned() else {
                continue;
            };
            let snapshot = self.ingest.snapshot(&id);
            let timeline_reset = snapshot.as_ref().is_some_and(|s| s.input_timeline_reset);
            let health = snapshot.map(|s| s.health).unwrap_or_else(|| "error".into());
            // A classified fatal answer (offline, auth, geo, provider limit, no video) or
            // an FFmpeg that ended on its own will not recover on this URL: move on now
            // instead of waiting out the degraded window.
            let failure = health_due
                .then(|| self.ingest.attempt_failure(&id, false))
                .flatten();
            let immediate = failure.as_ref().is_some_and(|failure| failure.immediate);
            // Permanent provider refusals keep their precedence over an earlier reset.
            let retry_reset = timeline_reset
                && failure
                    .as_ref()
                    .is_some_and(|failure| failure.reason == "upstream_stalled");
            let (expire, failover, restart_same) = {
                let mut state = self.registry.lock().unwrap();
                let Some(row) = state.channels.get_mut(&id) else {
                    continue;
                };
                let expire = row.viewers.is_empty()
                    && row
                        .grace
                        .is_some_and(|t| now.saturating_sub(t) >= self.grace_ms);
                if health_due {
                    row.note_input_health(health == "healthy", now);
                }
                if health_due && health == "healthy" {
                    row.degraded = None;
                } else if health_due && row.degraded.is_none() {
                    row.degraded = Some(now);
                }
                let failover = health_due
                    && !row.failing
                    && !row.exhausted
                    && (health == "error"
                        || immediate
                        || row
                            .degraded
                            .is_some_and(|t| now.saturating_sub(t) > self.degraded_ms));
                let restart_same = failover && row.retry_reset_on_same_feed(retry_reset);
                (expire, failover, restart_same)
            };
            if expire && !self.outputs.has_active(&id) {
                let owner = self.clone();
                tokio::spawn(async move {
                    let _guard = guard;
                    owner.outputs.stop_channel(&id).await;
                    let _ = owner.ingest.stop(&id).await;
                    owner.registry.lock().unwrap().channels.remove(&id);
                });
            } else if failover {
                let owner = self.clone();
                tokio::spawn(async move {
                    let _guard = guard;
                    if restart_same {
                        owner.recover_input(&id, true).await;
                    } else {
                        owner.failover(&id).await;
                    }
                });
            }
        }
    }
    async fn failover(&self, channel: &str) {
        self.recover_input(channel, false).await;
    }
    async fn recover_input(&self, channel: &str, retry_current: bool) {
        // Classified before anything stops: the verdict reads the dying attempt.
        if retry_current {
            let attempt = self
                .registry
                .lock()
                .unwrap()
                .channels
                .get(channel)
                .map(|row| (row.index, feed_id(&row.request, row.index)));
            self.emit_failure(channel, "stalled", "upstream_stalled", attempt, None);
        } else {
            self.record_attempt_failure(channel);
        }
        let original_index = self
            .registry
            .lock()
            .unwrap()
            .channels
            .get(channel)
            .map(|row| row.index);
        let next = {
            let mut state = self.registry.lock().unwrap();
            let Some(row) = state.channels.get_mut(channel) else {
                return;
            };
            if !retry_current {
                row.index += 1;
            }
            row.failing = true;
            row.request["streamUrls"][row.index].as_str().map(|url| {
                (
                    url.to_owned(),
                    row.request["allowPrivateUrls"] == true,
                    row.start,
                )
            })
        };
        let Some((url, allow, start)) = next else {
            eprintln!("[Multiplexer] All URLs exhausted for {channel}");
            // Terminal first, so HLS readers and heartbeats see it at once. A dead FFmpeg
            // already let go of the provider; one that is still running (degraded
            // deadline) keeps reconnecting, so stop it: a terminal channel holds no
            // provider connection. Its encoders read nothing any more and stop either
            // way. `failing` stays set until those stops are done.
            let health = self.ingest.snapshot(channel).map(|s| s.health);
            self.mark_terminal(channel);
            self.outputs.stop_channel(channel).await;
            if health
                .as_deref()
                .is_some_and(|h| h != "error" && h != "stopped")
            {
                let _ = self.ingest.stop(channel).await;
            }
            let mut state = self.registry.lock().unwrap();
            if let Some(row) = state.channels.get_mut(channel) {
                row.failing = false;
                if row.viewers.is_empty() {
                    row.grace = Some(now_ms());
                }
            }
            return;
        };
        let published = self
            .ingest
            .snapshot(channel)
            .and_then(|s| s.segments.last().map(|s| s.index + 1))
            .unwrap_or(0);
        let mut carry = self.outputs.snapshot_variants(channel);
        self.outputs.stop_channel(channel).await;
        let seen = self
            .ingest
            .stop(channel)
            .await
            .ok()
            .flatten()
            .and_then(|n| n.checked_add(1))
            .unwrap_or(0);
        let next = start.max(published).max(seen);
        let mut candidate = url;
        let success = loop {
            if self.stopping.load(Ordering::Acquire) {
                break false;
            }
            let label = {
                let state = self.registry.lock().unwrap();
                let Some(row) = state.channels.get(channel) else {
                    break false;
                };
                AttemptLabel {
                    stream_url_index: row.index,
                    feed_id: feed_id(&row.request, row.index),
                }
            };
            let attempt = self
                .ingest
                .spawn_attempt(channel, &candidate, next, allow, label.clone())
                .await;
            let Err(message) = attempt else {
                break true;
            };
            // A URL that cannot even be started (rejected URL, refused address) is a
            // failed feed like any other: record it and try the next one.
            let reason = classify_spawn_error(&message);
            if let Some(row) = self.registry.lock().unwrap().channels.get(channel) {
                Self::record_feed_failure(row, label.stream_url_index, reason, None);
            }
            if message != "ffmpeg_spawn_failed" {
                self.emit_failure(
                    channel,
                    "spawn_failed",
                    reason,
                    Some((label.stream_url_index, label.feed_id)),
                    None,
                );
            }
            let following = {
                let mut state = self.registry.lock().unwrap();
                state.channels.get_mut(channel).and_then(|row| {
                    row.request["streamUrls"][row.index + 1]
                        .as_str()
                        .map(str::to_owned)
                        .inspect(|_| row.index += 1)
                })
            };
            match following {
                Some(url) => candidate = url,
                None => break false,
            }
        };
        {
            let mut state = self.registry.lock().unwrap();
            if let Some(row) = state.channels.get_mut(channel) {
                row.degraded = None;
                if success {
                    row.start = next;
                    if Some(row.index) != original_index {
                        row.failovers += 1;
                    }
                    if row.anchors.last() != Some(&next) {
                        row.anchors.push(next);
                    }
                }
                retain_variant_viewers(&mut carry, &row.viewers);
            }
        }
        if success {
            self.outputs.resume_variants(channel, carry).await;
        } else if !self.stopping.load(Ordering::Acquire) {
            // The last URL could not be started either.
            self.mark_terminal(channel);
        }
        let mut state = self.registry.lock().unwrap();
        if let Some(row) = state.channels.get_mut(channel) {
            row.failing = false;
            if row.viewers.is_empty() {
                row.grace = Some(now_ms());
            }
        }
    }
    pub fn begin_shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
    }
    pub async fn stop_all(self: &Arc<Self>) {
        self.begin_shutdown();
        let ids: Vec<String> = self
            .registry
            .lock()
            .unwrap()
            .channels
            .keys()
            .cloned()
            .collect();
        let mut pending = tokio::task::JoinSet::new();
        for id in ids {
            let owner = self.clone();
            pending.spawn(async move {
                owner.kill_owned(&id).await;
            });
        }
        while pending.join_next().await.is_some() {}
        self.outputs.stop_all().await;
        self.ingest.stop_all().await;
    }
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Acquire)
    }
}

/// A carried variant resumes only for viewers still registered on it.
fn retain_variant_viewers(
    carry: &mut [crate::runtime_outputs::VariantCarryOver],
    viewers: &BTreeMap<String, Viewer>,
) {
    for variant in carry {
        let rung = format!("v-{}", variant.variant);
        variant.viewers.retain(|viewer| {
            viewers
                .get(viewer)
                .is_some_and(|v| v.rung.as_deref() == Some(rung.as_str()))
        });
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::config::ProxyConfig;
    use std::{path::PathBuf, time::Duration};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn request(viewer: &str) -> Value {
        json!({"viewerId":viewer,"sourceId":"source","maxStreams":1,"channelName":"Fixture","streamUrls":["http://127.0.0.1/fixture"],"allowPrivateUrls":true})
    }
    fn fixture() -> (PathBuf, Arc<Coordinator>) {
        let root = std::env::temp_dir().join(format!(
            "proxy-coordinator-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("encoder");
        std::fs::write(&executable,"#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = '-filters' ]; then echo ' ... scale V->V'; exit 0; fi; done\nexec /bin/sleep 30\n").unwrap();
        crate::test_support::seal_executable(&executable, 0o755);
        let env: Environment = std::env::vars().collect();
        let mut config = ProxyConfig::from_env(&env);
        config.ffmpeg_path = executable.to_string_lossy().into();
        config.max_egress_encoders = 1;
        let ingest = Arc::new(IngestManager::new(
            config.clone(),
            env.clone(),
            root.clone(),
        ));
        ingest.publish_test("channel", 1, &[0]);
        ingest.set_test_probe(
            "channel",
            json!({"success":true,"video":{"codec":"h264","height":1080,"hdr":false,"bitDepth":8}}),
            json!({"videoAction":"copy"}),
        );
        let outputs = Arc::new(OutputManager::new(
            ingest.clone(),
            config,
            env.clone(),
            root.clone(),
            65534,
            crate::runtime_feed::FeedGrants::default(),
        ));
        let coordinator = Arc::new(Coordinator::new(ingest, outputs, &env));
        coordinator.registry.lock().unwrap().channels.insert(
            "channel".into(),
            Channel::new(request("initial"), Some(now_ms()), 0),
        );
        (root, coordinator)
    }
    async fn until(mut ready: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !ready() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[test]
    fn sequence_reset_retries_same_feed_once_per_healthy_period() {
        let mut channel = Channel::new(request("viewer"), None, 0);
        assert!(!channel.retry_reset_on_same_feed(false));
        assert!(channel.retry_reset_on_same_feed(true));
        assert!(!channel.retry_reset_on_same_feed(true));
        channel.note_input_health(true, 100);
        channel.note_input_health(true, 30_099);
        assert!(!channel.retry_reset_on_same_feed(true));
        channel.note_input_health(false, 30_100);
        channel.note_input_health(true, 40_000);
        channel.note_input_health(true, 70_000);
        assert!(channel.retry_reset_on_same_feed(true));
        assert_eq!(channel.index, 0);
        assert_eq!(channel.failovers, 0);
    }

    #[tokio::test]
    async fn sequence_reset_recovers_a_single_feed_with_a_new_continuous_generation() {
        let root = std::env::temp_dir().join(format!(
            "proxy-reset-restart-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let probe = root.join("probe");
        std::fs::write(&probe, "#!/bin/sh\nprintf '%s' '{\"streams\":[{\"codec_type\":\"video\",\"codec_name\":\"h264\",\"height\":720}]}'\n").unwrap();
        let encoder = root.join("encoder");
        let script = r#"#!/bin/sh
start=0
previous=''
for arg in "$@"; do
    if [ "$previous" = '-start_number' ]; then start="$arg"; fi
    previous="$arg"
    playlist="$arg"
done
directory="${playlist%/*}"
printf 'transport' > "$directory/segment-$start.ts"
printf '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:%s\n#EXTINF:3,\nsegment-%s.ts\n' "$start" "$start" > "$playlist"
if [ ! -f "$directory/../reset-seen" ]; then
    touch "$directory/../reset-seen"
    printf '[hls @ 0x1] Media sequence changed unexpectedly: 1793544034 -> 1793544009\n' >&2
fi
read -r command
"#;
        std::fs::write(&encoder, script).unwrap();
        for path in [&probe, &encoder] {
            crate::test_support::seal_executable(path, 0o755);
        }
        let env = Environment::new();
        let mut config = ProxyConfig::from_env(&env);
        config.ffprobe_path = probe.to_string_lossy().into_owned();
        config.ffmpeg_path = encoder.to_string_lossy().into_owned();
        let ingest = Arc::new(IngestManager::new(
            config.clone(),
            env.clone(),
            root.clone(),
        ));
        let outputs = Arc::new(OutputManager::new(
            ingest.clone(),
            config,
            env.clone(),
            root.clone(),
            65534,
            crate::runtime_feed::FeedGrants::default(),
        ));
        let coordinator = Arc::new(Coordinator::new(ingest.clone(), outputs, &env));
        let mut input = request("viewer");
        input["streamUrls"] = json!(["rtsp://127.0.0.1/fixture"]);
        let mut row = Channel::new(input, None, 0);
        row.viewers.insert(
            "viewer".into(),
            Viewer {
                heartbeat: now_ms(),
                ..Default::default()
            },
        );
        coordinator
            .registry
            .lock()
            .unwrap()
            .channels
            .insert("channel".into(), row);
        ingest
            .spawn("channel", "rtsp://127.0.0.1/fixture", 0, true)
            .await
            .unwrap();
        until(|| {
            ingest
                .snapshot("channel")
                .is_some_and(|s| s.produced && s.input_timeline_reset)
        })
        .await;
        let generation = ingest.snapshot("channel").unwrap().generation;
        coordinator.last_health.store(0, Ordering::Release);
        coordinator.maintenance().await;
        until(|| {
            let ready = ingest.snapshot("channel").is_some_and(|s| {
                s.generation > generation && s.produced && !s.input_timeline_reset
            });
            ready && !coordinator.registry.lock().unwrap().channels["channel"].failing
        })
        .await;
        let snapshot = ingest.snapshot("channel").unwrap();
        assert_eq!(
            snapshot.segments[0].index, 1,
            "segment IDs must not rewind on the same feed"
        );
        {
            let state = coordinator.registry.lock().unwrap();
            let row = &state.channels["channel"];
            assert_eq!(row.index, 0, "there is no backup URL");
            assert_eq!(row.failovers, 0);
            assert_eq!(
                row.anchors,
                [1],
                "players need a discontinuity at the new generation"
            );
            assert!(row.viewers.contains_key("viewer"));
            assert!(!row.exhausted);
        }
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn disconnected_control_waiter_cannot_abandon_admission() {
        let (root, coordinator) = fixture();
        let gate = coordinator.gate("channel", false);
        let guard = gate.lock().await;
        let owner = coordinator.clone();
        let waiter = tokio::spawn(async move { owner.join("channel", &request("viewer")).await });
        until(|| {
            coordinator
                .registry
                .lock()
                .unwrap()
                .viewer_locks
                .contains_key("viewer")
        })
        .await;
        waiter.abort();
        let _ = waiter.await;
        drop(guard);
        until(|| coordinator.mux_status()["totalViewers"] == 1).await;
        assert_eq!(coordinator.heartbeat("channel", "viewer")["success"], true);
        coordinator.stop_all().await;
        assert_eq!(coordinator.mux_status()["totalViewers"], 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn leave_cancels_queued_join_only_for_its_channel() {
        let (root, coordinator) = fixture();
        let gate = coordinator.gate("viewer", true);
        let guard = gate.lock().await;
        let owner = coordinator.clone();
        let waiter = tokio::spawn(async move { owner.join("channel", &request("viewer")).await });
        until(|| Arc::strong_count(&gate) >= 2).await;
        coordinator.leave("channel", "viewer").await;
        drop(guard);
        assert_eq!(waiter.await.unwrap().0, 503);
        assert_eq!(coordinator.mux_status()["totalViewers"], 0);
        assert_eq!(coordinator.join("channel", &request("viewer")).await.0, 200);
        coordinator.leave("another-channel", "viewer").await;
        assert_eq!(coordinator.heartbeat("channel", "viewer")["success"], true);
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn refused_switch_retains_current_output_and_membership() {
        let (root, coordinator) = fixture();
        let mut first = request("viewer");
        first["cap"] = json!({"rung":{"id":"720p","height":720,"maxBitrate":2000000,"codec":"h264"},"requestedMaxBitrate":2000000,"belowLadder":false,"pinned":true,"fallback":"refuse"});
        assert_eq!(coordinator.join("channel", &first).await.0, 200);
        let mut second = first.clone();
        second["cap"]["rung"]["id"] = json!("480p");
        second["cap"]["rung"]["height"] = json!(480);
        let result = coordinator.join("channel", &second).await;
        assert_eq!(result.0, 503);
        assert_eq!(result.1["refusal"], "capacity");
        assert_eq!(coordinator.mux_status()["totalViewers"], 1);
        assert_eq!(
            coordinator.outputs.encoder_status("channel")[0]["viewers"],
            1
        );
        assert_eq!(
            coordinator.outputs.encoder_status("channel")[0]["rungId"],
            "720p"
        );
        coordinator.stop_all().await;
        assert_eq!(coordinator.outputs.capacity()["activeOutputs"], 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn switch_reclaims_a_left_channel_whose_encoder_is_in_grace() {
        // A capped (encoded) viewer leaves and joins another channel of a one-slot source.
        // The encoder output keeps a 10 s grace for nobody: it must not hold the slot.
        let (root, coordinator) = fixture();
        let mut first = request("viewer");
        first["cap"] = json!({"rung":{"id":"720p","height":720,"maxBitrate":2000000,"codec":"h264"},"requestedMaxBitrate":2000000,"belowLadder":false,"pinned":true,"fallback":"refuse"});
        assert_eq!(coordinator.join("channel", &first).await.0, 200);
        assert_eq!(coordinator.outputs.capacity()["activeOutputs"], 1);
        coordinator.leave("channel", "viewer").await;
        let switched = coordinator.join("other", &request("viewer")).await;
        assert_eq!(switched.0, 200, "{}", switched.1);
        assert!(coordinator.ingest.snapshot("channel").is_none());
        assert_eq!(coordinator.outputs.capacity()["activeOutputs"], 0);
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn reclaim_rechecks_membership_after_candidate_collection() {
        let (root, coordinator) = fixture();
        assert_eq!(coordinator.join("channel", &request("viewer")).await.0, 200);
        coordinator.reclaim("channel", &json!("source")).await;
        assert_eq!(coordinator.heartbeat("channel", "viewer")["success"], true);
        coordinator.leave("channel", "viewer").await;
        coordinator.reclaim("channel", &json!("source")).await;
        assert!(coordinator.ingest.snapshot("channel").is_none());
        assert_eq!(coordinator.mux_status()["channels"], json!([]));
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn leave_after_detach_but_before_transaction_poll_cancels_admission() {
        use std::{future::Future, task::Poll};
        let (root, coordinator) = fixture();
        let input = request("viewer");
        let mut call = Box::pin(coordinator.join("channel", &input));
        std::future::poll_fn(|cx| {
            assert!(call.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        coordinator.leave("channel", "viewer").await;
        drop(call);
        until(|| coordinator.pending.available_permits() == 128).await;
        assert_eq!(coordinator.mux_status()["totalViewers"], 0);
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn per_viewer_retry_queue_is_bounded_and_recovers() {
        let (root, coordinator) = fixture();
        let gate = coordinator.gate("viewer", true);
        let guard = gate.lock().await;
        let mut calls = Vec::new();
        for _ in 0..8 {
            let owner = coordinator.clone();
            calls.push(tokio::spawn(async move {
                owner.join("channel", &request("viewer")).await
            }));
        }
        until(|| {
            coordinator
                .registry
                .lock()
                .unwrap()
                .pending_viewers
                .get("viewer")
                == Some(&8)
        })
        .await;
        assert_eq!(coordinator.join("channel", &request("viewer")).await.0, 503);
        drop(guard);
        for call in calls {
            assert_eq!(call.await.unwrap().0, 200);
        }
        assert_eq!(coordinator.mux_status()["totalViewers"], 1);
        assert_eq!(coordinator.pending.available_permits(), 128);
        assert!(
            coordinator
                .registry
                .lock()
                .unwrap()
                .pending_viewers
                .is_empty()
        );
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn unrelated_leaves_cannot_grow_pending_cancellation_epochs() {
        let (root, coordinator) = fixture();
        let gate = coordinator.gate("viewer", true);
        let guard = gate.lock().await;
        let owner = coordinator.clone();
        let call = tokio::spawn(async move { owner.join("channel", &request("viewer")).await });
        until(|| coordinator.registry.lock().unwrap().pending_pairs.len() == 1).await;
        for index in 0..1000 {
            coordinator.leave(&format!("other-{index}"), "viewer").await;
        }
        assert!(coordinator.registry.lock().unwrap().epochs.is_empty());
        coordinator.leave("channel", "viewer").await;
        assert_eq!(coordinator.registry.lock().unwrap().epochs.len(), 1);
        drop(guard);
        assert_eq!(call.await.unwrap().0, 503);
        assert!(coordinator.registry.lock().unwrap().epochs.is_empty());
        assert!(
            coordinator
                .registry
                .lock()
                .unwrap()
                .pending_pairs
                .is_empty()
        );
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn leave_racing_a_rung_switch_refuses_it_and_detaches_the_old_rung() {
        let (root, coordinator) = fixture();
        let mut first = request("viewer");
        first["cap"] = json!({"rung":{"id":"720p","height":720,"maxBitrate":2000000,"codec":"h264"},"requestedMaxBitrate":2000000,"belowLadder":false,"pinned":true,"fallback":"refuse"});
        assert_eq!(coordinator.join("channel", &first).await.0, 200);
        let gate = coordinator.gate("viewer", true);
        let guard = gate.lock().await;
        let mut second = first.clone();
        second["cap"]["rung"]["id"] = json!("480p");
        second["cap"]["rung"]["height"] = json!(480);
        let owner = coordinator.clone();
        let switching = tokio::spawn(async move { owner.join("channel", &second).await });
        until(|| Arc::strong_count(&gate) >= 2).await;
        coordinator.leave("channel", "viewer").await;
        drop(guard);
        assert_eq!(switching.await.unwrap().0, 503);
        assert_eq!(coordinator.mux_status()["totalViewers"], 0);
        let encoders = coordinator.outputs.encoder_status("channel");
        assert!(
            encoders
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["rungId"] != "480p" && e["viewers"] == 0),
            "{encoders}"
        );
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    fn carried(variant: &str, viewers: &[&str]) -> crate::runtime_outputs::VariantCarryOver {
        crate::runtime_outputs::VariantCarryOver {
            variant: variant.into(),
            viewers: viewers.iter().map(|v| (*v).into()).collect(),
            next_index: 0,
            generation: 1,
            snapshot: Default::default(),
            source_codec: "hevc".into(),
            source_hdr: false,
        }
    }
    #[test]
    fn a_viewer_no_longer_on_the_variant_is_not_carried() {
        let on = |rung: Option<&str>| Viewer {
            rung: rung.map(str::to_owned),
            ..Default::default()
        };
        let viewers = BTreeMap::from([
            ("viewer-1".to_owned(), on(Some("v-fmp4"))),
            ("viewer-2".to_owned(), on(None)),
            ("viewer-3".to_owned(), on(Some("720p"))),
        ]);
        let mut carry = vec![
            carried("fmp4", &["viewer-1", "viewer-2", "viewer-3", "gone"]),
            carried("h264", &["viewer-1"]),
        ];
        retain_variant_viewers(&mut carry, &viewers);
        assert_eq!(carry[0].viewers, ["viewer-1"]);
        assert!(carry[1].viewers.is_empty());
    }
    #[tokio::test]
    async fn nothing_is_resumed_when_the_backup_ingest_fails_to_spawn() {
        let (root, coordinator) = fixture();
        assert_eq!(
            coordinator
                .outputs
                .attach_variant("channel", "fmp4", "viewer")
                .await["ok"],
            true
        );
        {
            let mut state = coordinator.registry.lock().unwrap();
            let row = state.channels.get_mut("channel").unwrap();
            row.request["streamUrls"] = json!(["http://127.0.0.1/fixture", "file:/missing"]);
            row.viewers.insert(
                "viewer".into(),
                Viewer {
                    rung: Some("v-fmp4".into()),
                    ..Default::default()
                },
            );
        }
        tokio::time::timeout(Duration::from_secs(10), coordinator.failover("channel"))
            .await
            .unwrap();
        assert!(coordinator.outputs.snapshot("channel", "v-fmp4").is_none());
        assert!(coordinator.outputs.channel_ids().is_empty());
        assert!(coordinator.registry.lock().unwrap().channels["channel"].exhausted);
        // The abandoned attempt had published, then the backup URL was refused outright.
        assert_eq!(
            coordinator.hls_failure("channel").unwrap(),
            json!({"error":"channel_failed","reason":"all_feeds_failed","retryable":true,"retryAfterMs":3000})
        );
        assert_eq!(
            coordinator.heartbeat("channel", "viewer")["failure"]["feedsTried"],
            json!([{"index":0,"reason":"upstream_stalled"},{"index":1,"reason":"channel_offline"}])
        );
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    fn fail_channel(coordinator: &Coordinator, reason: &'static str, status: Option<u16>) {
        {
            let state = coordinator.registry.lock().unwrap();
            let row = &state.channels["channel"];
            Coordinator::record_feed_failure(row, row.index, reason, status);
        }
        coordinator.mark_terminal("channel");
    }
    fn waiting(viewer: &str, ms: u64) -> Value {
        let mut input = request(viewer);
        input["awaitReadyMs"] = json!(ms);
        input["feedIds"] = json!(["feed-0"]);
        input
    }
    #[tokio::test]
    async fn terminal_channel_reports_its_failure_and_frees_the_source_slot() {
        let (root, coordinator) = fixture();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        coordinator
            .ingest
            .set_failure_sink(Some(Arc::new(move |event| {
                captured.lock().unwrap().push(event);
            })));
        let joined = coordinator.join("channel", &request("viewer")).await;
        assert_eq!((joined.0, &joined.1["ready"]), (200, &json!(true)));
        coordinator
            .registry
            .lock()
            .unwrap()
            .channels
            .get_mut("channel")
            .unwrap()
            .request["feedIds"] = json!(["feed-0"]);
        fail_channel(&coordinator, "provider_auth_failed", Some(401));
        assert_eq!(
            coordinator.heartbeat("channel", "viewer"),
            json!({"success":false,"message":"channel_failed","failure":{"reason":"provider_auth_failed","retryable":false,"feedsTried":[{"index":0,"feedId":"feed-0","reason":"provider_auth_failed","upstreamStatus":401}]}})
        );
        assert_eq!(
            coordinator.heartbeat("channel", "stranger")["message"],
            "viewer_not_found"
        );
        assert_eq!(
            coordinator.hls_failure("channel").unwrap(),
            json!({"error":"channel_failed","reason":"provider_auth_failed","retryable":false})
        );
        let status = coordinator.mux_status();
        assert_eq!(
            status["channels"][0]["lastFailureReason"],
            "provider_auth_failed"
        );
        assert_eq!(status["channels"][0]["terminal"], true);
        assert_eq!(status["perSourceLimits"][0]["activeStreams"], 0);
        {
            let events = events.lock().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(
                (events[0].outcome.as_str(), events[0].reason.as_deref()),
                ("exhausted", Some("provider_auth_failed"))
            );
        }
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn a_join_on_a_terminal_channel_starts_it_over() {
        let (root, coordinator) = fixture();
        assert_eq!(coordinator.join("channel", &request("viewer")).await.0, 200);
        fail_channel(&coordinator, "channel_offline", Some(404));
        let rejoined = coordinator.join("channel", &request("other")).await;
        assert_eq!(rejoined.0, 200, "{}", rejoined.1);
        assert_eq!(rejoined.1["ready"], false);
        assert!(coordinator.hls_failure("channel").is_none());
        assert_eq!(
            coordinator.heartbeat("channel", "viewer")["message"],
            "viewer_not_found"
        );
        assert_eq!(coordinator.heartbeat("channel", "other")["success"], true);
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn a_waiting_join_answers_ready_deadline_or_failure() {
        let (root, coordinator) = fixture();
        coordinator.ingest.publish_test("channel", 1, &[]);
        let deadline = coordinator.join("channel", &waiting("late", 150)).await;
        assert_eq!((deadline.0, &deadline.1["ready"]), (200, &json!(false)));
        let owner = coordinator.clone();
        let ready =
            tokio::spawn(async move { owner.join("channel", &waiting("ready", 5_000)).await });
        until(|| coordinator.mux_status()["totalViewers"] == 2).await;
        coordinator.ingest.publish_test("channel", 1, &[0]);
        let ready = ready.await.unwrap();
        assert_eq!((ready.0, &ready.1["ready"]), (200, &json!(true)));
        coordinator.ingest.publish_test("channel", 1, &[]);
        let owner = coordinator.clone();
        let failed =
            tokio::spawn(async move { owner.join("channel", &waiting("failed", 5_000)).await });
        until(|| coordinator.mux_status()["totalViewers"] == 3).await;
        fail_channel(&coordinator, "geo_blocked", Some(451));
        let failed = failed.await.unwrap();
        assert_eq!(failed.0, 502);
        assert_eq!(
            failed.1,
            json!({"error":"channel_failed","reason":"geo_blocked","retryable":false,"feedsTried":[{"index":0,"reason":"geo_blocked","upstreamStatus":451}]})
        );
        until(|| coordinator.heartbeat("channel", "failed")["message"] == "viewer_not_found").await;
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn an_abandoned_waiting_join_leaves_and_a_detached_one_is_refused() {
        let (root, coordinator) = fixture();
        coordinator.ingest.publish_test("channel", 1, &[]);
        let owner = coordinator.clone();
        let abandoned =
            tokio::spawn(async move { owner.join("channel", &waiting("gone", 5_000)).await });
        until(|| coordinator.mux_status()["totalViewers"] == 1).await;
        // Past the admission transaction, into the wait.
        tokio::time::sleep(Duration::from_millis(50)).await;
        abandoned.abort();
        let _ = abandoned.await;
        until(|| coordinator.mux_status()["totalViewers"] == 0).await;
        let owner = coordinator.clone();
        let detached =
            tokio::spawn(async move { owner.join("channel", &waiting("kicked", 5_000)).await });
        until(|| coordinator.mux_status()["totalViewers"] == 1).await;
        coordinator.leave("channel", "kicked").await;
        assert_eq!(
            detached.await.unwrap(),
            (503, json!({"error":"cap_unavailable","refusal":"internal"}))
        );
        coordinator.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}

// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! One owned supervisor per ingest, including its relay, probe and completed media.
use crate::{
    config::{self, Environment, ProxyConfig},
    decision, failure_reason, ingest_args, probe,
    runtime_media::{self, PublicationWatch, Segment, SegmentRing},
    upstream::{RelaySignalsHandle, UpstreamGuard, validate_direct_input},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::{oneshot, watch},
};

const MAX_CHANNELS: usize = 256;
const MAX_PROBE_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct IngestSnapshot {
    pub segments: Vec<Arc<Segment>>,
    pub probe: Value,
    pub decision: Value,
    pub health: String,
    pub stopping: bool,
    pub generation: u64,
    pub max_seen: Option<u64>,
    pub started_at_ms: u64,
    pub last_segment_at_ms: u64,
    pub output_diagnostics: crate::output_diagnostics::OutputDiagnostics,
    pub stderr_tail: String,
    /// Latched until a fresh ingest: later packets cannot repair a reset HLS timeline.
    pub input_timeline_reset: bool,
    /// This attempt published at least one segment.
    pub produced: bool,
    /// FFmpeg ended on its own (any exit code, not a SIGTERM), not through stop().
    pub exited: bool,
    /// Signal that ended FFmpeg on its own, if any.
    pub exit_signal: Option<String>,
    /// FFmpeg could not be started at all.
    pub spawn_failed: bool,
    /// A failure event was already recorded for this attempt.
    pub failure_reported: bool,
    /// Which station URL this attempt plays.
    pub label: AttemptLabel,
    /// What the attempt's upstream relay saw (HTTP inputs only).
    pub relay: Option<RelaySignalsHandle>,
}

/// Which station URL an attempt plays (index into the join's `streamUrls`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AttemptLabel {
    pub stream_url_index: usize,
    pub feed_id: Option<String>,
}

/// Why the current ingest attempt failed, classified (see failure_reason.rs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptFailure {
    pub reason: &'static str,
    pub upstream_status: Option<u16>,
    /// Fail over now instead of after the degraded window.
    pub immediate: bool,
    /// The ingest manager already recorded a failure event for this attempt.
    pub reported: bool,
}

/// Signals that end an ingest on our side (kernel OOM kill, a crash in a decoder,
/// encoder or GPU driver): with no provider, relay or stderr evidence the attempt
/// failed here.
const CRASH_SIGNALS: [&str; 3] = ["SIGKILL", "SIGSEGV", "SIGABRT"];

/// True when the ingest runs an encoder (anything but a plain copy of both streams).
fn transcoding(decision: &Value) -> bool {
    decision.is_object() && (decision["videoAction"] != "copy" || decision["audioAction"] != "copy")
}

impl IngestSnapshot {
    fn record_stderr(&mut self, text: &str) {
        self.stderr_tail = text.to_owned();
        self.input_timeline_reset |= text.contains("Media sequence changed unexpectedly:");
        if self.health != "error"
            && (self.input_timeline_reset
                || [
                    "Connection refused",
                    "No such file or directory",
                    "Server returned 4",
                    "Server returned 5",
                ]
                .iter()
                .any(|s| text.contains(s)))
        {
            self.health = "degraded".into();
        }
    }
}

/// Classify an attempt, or None while nothing points at a failure.
///
/// `ended_hint` asks for a verdict on an attempt the caller is about to give up on
/// (stall or degraded deadline); an attempt whose FFmpeg already exited is always
/// ended. Precedence: provider HTTP status > relay failure > stderr > killed by a crash
/// signal (encoder_failed) > "ended after segments" (upstream_stalled) > "no segment
/// ever" (channel_offline).
pub fn classify_attempt(state: &IngestSnapshot, ended_hint: bool) -> Option<AttemptFailure> {
    let ended = ended_hint || state.exited;
    let signals = state
        .relay
        .as_ref()
        .map(RelaySignalsHandle::read)
        .unwrap_or_default();
    let mut reason = state.spawn_failed.then_some("encoder_failed");
    let mut upstream_status = None;
    if reason.is_none()
        && let Some((status, body)) = &signals.upstream
    {
        reason = failure_reason::classify_upstream(*status, body);
        if reason.is_some() {
            upstream_status = Some(*status);
        }
    }
    if reason.is_none()
        && let Some(guard) = signals.guard
    {
        reason = failure_reason::classify_guard(guard.status, guard.diagnostic);
    }
    let from_http = reason.is_some() && !state.spawn_failed;
    if reason.is_none() && state.input_timeline_reset {
        reason = Some("upstream_stalled");
    }
    if reason.is_none() && ended {
        reason = Some(
            failure_reason::classify_stderr(
                &state.stderr_tail,
                "ingest",
                state.produced,
                transcoding(&state.decision),
            )
            .or_else(|| {
                state
                    .exit_signal
                    .as_deref()
                    .is_some_and(|signal| CRASH_SIGNALS.contains(&signal))
                    .then_some("encoder_failed")
            })
            .unwrap_or(if state.produced {
                "upstream_stalled"
            } else {
                "channel_offline"
            }),
        );
    }
    let reason = reason?;
    let immediate = state.exited
        || state.input_timeline_reset
        || (from_http
            && !state.produced
            && !signals.connected
            && failure_reason::IMMEDIATE_FAILOVER_REASONS.contains(&reason));
    Some(AttemptFailure {
        reason,
        upstream_status,
        immediate,
        reported: state.failure_reported,
    })
}

/// The failure event fields that describe the attempt (`reason` .. `feedId`).
fn label_event(event: &mut runtime_media::FailureEventInput, state: &IngestSnapshot) {
    if let Some(failure) = classify_attempt(state, true) {
        event.reason = Some(failure.reason.into());
        event.upstream_status = failure.upstream_status;
    }
    event.stream_url_index = Some(state.label.stream_url_index);
    event.feed_id = state.label.feed_id.clone();
}

/// Node's name for a signal number, as the TS proxy reports it.
#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGQUIT => "SIGQUIT".into(),
        libc::SIGILL => "SIGILL".into(),
        libc::SIGTRAP => "SIGTRAP".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGBUS => "SIGBUS".into(),
        libc::SIGFPE => "SIGFPE".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGUSR1 => "SIGUSR1".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGUSR2 => "SIGUSR2".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        libc::SIGALRM => "SIGALRM".into(),
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGXCPU => "SIGXCPU".into(),
        libc::SIGXFSZ => "SIGXFSZ".into(),
        other => format!("SIG{other}"),
    }
}
struct Channel {
    state: Mutex<IngestSnapshot>,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    changed: watch::Sender<u64>,
}
pub struct IngestManager {
    config: ProxyConfig,
    env: Environment,
    root: PathBuf,
    channels: Mutex<BTreeMap<String, Arc<Channel>>>,
    notifications: Mutex<BTreeMap<String, watch::Sender<u64>>>,
    generation: AtomicU64,
    failure_sink: Mutex<Option<runtime_media::FailureSink>>,
    media_budget: crate::runtime_budget::MediaBudget,
    shutting_down: AtomicBool,
    #[cfg(test)]
    admission_gate: Mutex<Option<Arc<AdmissionGate>>>,
}
#[cfg(test)]
struct AdmissionGate {
    entered: tokio::sync::Notify,
    resume: tokio::sync::Notify,
}
fn failed_probe() -> Value {
    json!({"success":false,"error":"Stream probe failed","video":null,"audio":null})
}
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
impl IngestManager {
    #[cfg(test)]
    pub(crate) fn set_test_probe(&self, channel: &str, probe: Value, decision: Value) {
        let entry = self.channels.lock().unwrap().get(channel).unwrap().clone();
        let mut state = entry.state.lock().unwrap();
        state.probe = probe;
        state.decision = decision;
    }
    #[cfg(test)]
    pub(crate) fn set_test_failure(&self, channel: &str, health: &str, stderr_tail: &str) {
        let entry = self.channels.lock().unwrap().get(channel).unwrap().clone();
        let mut state = entry.state.lock().unwrap();
        state.health = health.into();
        state.stderr_tail = stderr_tail.into();
    }
    #[cfg(test)]
    pub(crate) fn publish_test(&self, channel: &str, generation: u64, indices: &[u64]) {
        let mut channels = self.channels.lock().unwrap();
        let changed = self
            .notifications
            .lock()
            .unwrap()
            .entry(channel.to_owned())
            .or_insert_with(|| watch::channel(0).0)
            .clone();
        let entry = channels.entry(channel.to_owned()).or_insert_with(|| {
            Arc::new(Channel {
                state: Mutex::new(IngestSnapshot {
                    segments: Vec::new(),
                    probe: failed_probe(),
                    decision: Value::Null,
                    health: "healthy".into(),
                    stopping: false,
                    generation,
                    max_seen: None,
                    started_at_ms: 0,
                    last_segment_at_ms: 0,
                    output_diagnostics: Default::default(),
                    stderr_tail: String::new(),
                    input_timeline_reset: false,
                    produced: false,
                    exited: false,
                    exit_signal: None,
                    spawn_failed: false,
                    failure_reported: false,
                    label: AttemptLabel::default(),
                    relay: None,
                }),
                stop: watch::channel(false).0,
                done: watch::channel(true).1,
                changed,
            })
        });
        let mut state = entry.state.lock().unwrap();
        state.generation = generation;
        state.segments = indices
            .iter()
            .map(|&index| {
                Arc::new(Segment {
                    index,
                    duration: 3.0,
                    data: bytes::Bytes::from(index.to_string()),
                    created_at_ms: 0,
                })
            })
            .collect();
        state.max_seen = indices.last().copied();
        state.produced = !indices.is_empty();
        drop(state);
        entry.changed.send_modify(|n| *n = n.wrapping_add(1));
    }
    pub fn new(config: ProxyConfig, env: Environment, root: PathBuf) -> Self {
        Self::with_budget(
            config,
            env,
            root,
            crate::runtime_budget::MediaBudget::process(),
        )
    }
    fn with_budget(
        config: ProxyConfig,
        env: Environment,
        root: PathBuf,
        media_budget: crate::runtime_budget::MediaBudget,
    ) -> Self {
        Self {
            config,
            env,
            root,
            channels: Mutex::new(BTreeMap::new()),
            notifications: Mutex::new(BTreeMap::new()),
            generation: AtomicU64::new(0),
            failure_sink: Mutex::new(None),
            media_budget,
            shutting_down: AtomicBool::new(false),
            #[cfg(test)]
            admission_gate: Mutex::new(None),
        }
    }
    pub fn set_failure_sink(&self, sink: Option<runtime_media::FailureSink>) {
        *self.failure_sink.lock().unwrap() = sink;
    }
    /// Hand a failure event the coordinator classified to the shared sink.
    pub fn report_failure(&self, event: runtime_media::FailureEventInput) {
        let sink = self.failure_sink.lock().unwrap().clone();
        if let Some(sink) = sink {
            sink(event);
        }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn channel_ids(&self) -> Vec<String> {
        self.channels.lock().unwrap().keys().cloned().collect()
    }
    pub fn subscribe(&self, channel: &str) -> watch::Receiver<u64> {
        if let Some(entry) = self.channels.lock().unwrap().get(channel) {
            return entry.changed.subscribe();
        }
        let active = self.channel_ids();
        let mut notifications = self.notifications.lock().unwrap();
        // A caller owns at most one notification sender per live/waited channel.
        notifications.retain(|id, sender| sender.receiver_count() > 0 || active.contains(id));
        notifications
            .entry(channel.to_owned())
            .or_insert_with(|| watch::channel(0).0)
            .subscribe()
    }
    fn prune_notifications(&self) {
        let active = self.channel_ids();
        self.notifications
            .lock()
            .unwrap()
            .retain(|id, sender| sender.receiver_count() > 0 || active.contains(id));
    }
    pub fn cancel_all(&self) {
        let channels = self.channels.lock().unwrap();
        self.shutting_down.store(true, Ordering::Release);
        for entry in channels.values() {
            entry.state.lock().unwrap().stopping = true;
            let _ = entry.stop.send(true);
        }
    }
    pub fn snapshot(&self, channel: &str) -> Option<IngestSnapshot> {
        let entry = self.channels.lock().unwrap().get(channel)?.clone();
        let mut snapshot = entry.state.lock().unwrap().clone();
        if snapshot.health == "healthy"
            && runtime_media::now_ms().saturating_sub(snapshot.last_segment_at_ms) > 30_000
        {
            snapshot.health = "degraded".into();
        }
        Some(snapshot)
    }
    /// Typed verdict on the channel's current attempt (None while stopping).
    pub fn attempt_failure(&self, channel: &str, ended: bool) -> Option<AttemptFailure> {
        let entry = self.channels.lock().unwrap().get(channel)?.clone();
        let state = entry.state.lock().unwrap();
        if state.stopping {
            return None;
        }
        classify_attempt(&state, ended)
    }
    pub async fn spawn(
        &self,
        channel: &str,
        url: &str,
        start_index: u64,
        allow_private: bool,
    ) -> Result<(), String> {
        self.spawn_attempt(
            channel,
            url,
            start_index,
            allow_private,
            AttemptLabel::default(),
        )
        .await
    }
    /// Start an attempt on one station URL; failure events carry `label`.
    pub async fn spawn_attempt(
        &self,
        channel: &str,
        url: &str,
        start_index: u64,
        allow_private: bool,
        label: AttemptLabel,
    ) -> Result<(), String> {
        if !safe_id(channel) {
            return Err("invalid_channel_id".into());
        }
        let changed = {
            let mut notifications = self.notifications.lock().unwrap();
            notifications
                .entry(channel.to_owned())
                .or_insert_with(|| watch::channel(0).0)
                .clone()
        };
        let (stop, cancelled) = watch::channel(false);
        let (completed, done) = watch::channel(false);
        let entry = Arc::new(Channel {
            state: Mutex::new(IngestSnapshot {
                segments: Vec::new(),
                probe: failed_probe(),
                decision: Value::Null,
                health: "starting".into(),
                stopping: false,
                generation: self.generation.fetch_add(1, Ordering::Relaxed) + 1,
                max_seen: start_index.checked_sub(1),
                started_at_ms: runtime_media::now_ms(),
                last_segment_at_ms: 0,
                output_diagnostics: Default::default(),
                stderr_tail: String::new(),
                input_timeline_reset: false,
                produced: false,
                exited: false,
                exit_signal: None,
                spawn_failed: false,
                failure_reported: false,
                label,
                relay: None,
            }),
            stop,
            done,
            changed,
        });
        #[cfg(test)]
        {
            let gate = self.admission_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.entered.notify_one();
                gate.resume.notified().await;
            }
        }
        {
            let mut channels = self.channels.lock().unwrap();
            if self.shutting_down.load(Ordering::Acquire) {
                drop(channels);
                self.prune_notifications();
                return Err("ingest_shutting_down".into());
            }
            if channels.contains_key(channel) {
                return Err("channel_already_active".into());
            }
            if channels.len() >= MAX_CHANNELS {
                drop(channels);
                self.prune_notifications();
                return Err("channel_capacity".into());
            }
            channels.insert(channel.to_owned(), entry.clone());
        }
        let config = self.config.clone();
        let env = self.env.clone();
        let directory = self.root.join(channel);
        let url = url.to_owned();
        let owned = entry.clone();
        let failure_sink = self.failure_sink.lock().unwrap().clone();
        let channel_id = channel.to_owned();
        let (started, startup) = oneshot::channel();
        let media_budget = self.media_budget.clone();
        tokio::spawn(async move {
            let outcome = run_channel(
                owned.clone(),
                config,
                env,
                directory,
                url,
                start_index,
                allow_private,
                cancelled,
                started,
                channel_id,
                failure_sink,
                media_budget,
            )
            .await;
            if outcome.is_err() {
                owned.state.lock().unwrap().health = "error".into();
            }
            let _ = completed.send(true);
            owned.changed.send_modify(|n| *n = n.wrapping_add(1));
        });
        match startup
            .await
            .unwrap_or_else(|_| Err("ingest_startup_failed".into()))
        {
            Ok(()) => Ok(()),
            Err(error) => {
                let mut done = entry.done.clone();
                while !*done.borrow() {
                    if done.changed().await.is_err() {
                        break;
                    }
                }
                {
                    let mut channels = self.channels.lock().unwrap();
                    if channels
                        .get(channel)
                        .is_some_and(|current| Arc::ptr_eq(current, &entry))
                    {
                        channels.remove(channel);
                    }
                }
                self.prune_notifications();
                Err(error)
            }
        }
    }
    pub async fn stop(&self, channel: &str) -> Result<Option<u64>, String> {
        let Some(entry) = self.channels.lock().unwrap().get(channel).cloned() else {
            return Ok(None);
        };
        entry.state.lock().unwrap().stopping = true;
        let _ = entry.stop.send(true);
        let mut done = entry.done.clone();
        while !*done.borrow() {
            if done.changed().await.is_err() {
                break;
            }
        }
        let high_water = entry.state.lock().unwrap().max_seen;
        {
            let mut channels = self.channels.lock().unwrap();
            if channels
                .get(channel)
                .is_some_and(|current| Arc::ptr_eq(current, &entry))
            {
                channels.remove(channel);
            }
        }
        entry.changed.send_modify(|n| *n = n.wrapping_add(1));
        self.prune_notifications();
        tokio::fs::remove_dir_all(self.root.join(channel))
            .await
            .ok();
        Ok(high_water)
    }
    pub async fn stop_all(self: &Arc<Self>) {
        let mut pending = tokio::task::JoinSet::new();
        for channel in self.channel_ids() {
            let owner = self.clone();
            pending.spawn(async move {
                let _ = owner.stop(&channel).await;
            });
        }
        while pending.join_next().await.is_some() {}
    }
}

async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    if *receiver.borrow() {
        return;
    }
    loop {
        if receiver.changed().await.is_err() || *receiver.borrow() {
            return;
        }
    }
}

async fn stream_probe(
    config: &ProxyConfig,
    env: &Environment,
    url: &str,
    local_relay: bool,
    cancel: &mut watch::Receiver<bool>,
) -> Value {
    let mut command = Command::new(&config.ffprobe_path);
    command.args([
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-analyzeduration",
        "3000000",
        "-probesize",
        "3000000",
    ]);
    command.args(config::input_transport_args(url));
    command.args(["-protocol_whitelist", config::protocol_whitelist_for(url)]);
    if local_relay {
        command.args(["-format_whitelist", config::GUARDED_INPUT_FORMATS]);
    }
    command
        .args(["-i", url])
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let Ok(mut child) = command.spawn() else {
        return failed_probe();
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return failed_probe();
    };
    let mut reader = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let result = stdout
            .take(MAX_PROBE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .await;
        (result, bytes)
    });
    let status = tokio::select! {
        result = child.wait() => result.ok(),
        _ = tokio::time::sleep(Duration::from_millis(config.probe_timeout_ms as u64)) => None,
        _ = cancelled(cancel) => None,
    };
    if status.is_none() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let output = match tokio::time::timeout(Duration::from_millis(200), &mut reader).await {
        Ok(value) => value.ok(),
        Err(_) => {
            reader.abort();
            let _ = reader.await;
            None
        }
    };
    match (status, output) {
        (Some(status), Some((Ok(_), bytes)))
            if status.success() && bytes.len() <= MAX_PROBE_BYTES =>
        {
            probe::parse(&String::from_utf8_lossy(&bytes))
        }
        _ => failed_probe(),
    }
}

/// Signal, then explicitly wait/reap. Never release directories or reservations first.
pub async fn stop_child(child: &mut Child, graceful_stdin: bool) -> Result<(), String> {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return Ok(());
    }
    if graceful_stdin {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"q\n").await;
            let _ = stdin.shutdown().await;
        }
        if matches!(
            tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
            Ok(Ok(_))
        ) {
            return Ok(());
        }
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // Only signal the child PID owned by this Child handle, never a shared group.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.start_kill();
    }
    if matches!(
        tokio::time::timeout(Duration::from_secs(3), child.wait()).await,
        Ok(Ok(_))
    ) {
        return Ok(());
    }
    child.kill().await.map_err(|_| "child_kill_failed")?;
    child.wait().await.map_err(|_| "child_reap_failed")?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_channel(
    channel: Arc<Channel>,
    config: ProxyConfig,
    env: Environment,
    directory: PathBuf,
    url: String,
    start_index: u64,
    allow_private: bool,
    mut cancel: watch::Receiver<bool>,
    started: oneshot::Sender<Result<(), String>>,
    channel_id: String,
    failure_sink: Option<runtime_media::FailureSink>,
    media_budget: crate::runtime_budget::MediaBudget,
) -> Result<(), String> {
    let mut started = Some(started);
    let mut guard = None;
    let startup: Result<(Child, PublicationWatch), String> = async {
        if *cancel.borrow() {
            return Err("ingest_cancelled".into());
        }
        let scheme = url::Url::parse(&url)
            .map_err(|_| "invalid_stream_url")?
            .scheme()
            .to_owned();
        let input = if scheme == "http" || scheme == "https" {
            let new_guard = UpstreamGuard::start(allow_private, &config.upstream_proxy_url).await?;
            let input = new_guard.stream_url(&url)?;
            // Before the probe: it already goes through the relay, and its answers
            // count for this attempt.
            channel.state.lock().unwrap().relay = Some(new_guard.signals());
            guard = Some(new_guard);
            input
        } else {
            validate_direct_input(&url, allow_private).await?
        };
        let child_env =
            config::upstream_environment(&env, &config.upstream_proxy_url, guard.is_some());
        let probe = stream_probe(&config, &child_env, &input, guard.is_some(), &mut cancel).await;
        if *cancel.borrow() {
            return Err("ingest_cancelled".into());
        }
        let decision = decision::transcode_decision(&probe, &config);
        {
            let mut state = channel.state.lock().unwrap();
            state.probe = probe;
            state.decision = decision.clone();
        }
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|_| "ingest_directory_unavailable")?;
        let mut argv = ingest_args::build(
            &input,
            directory.to_str().ok_or("invalid_media_path")?,
            &decision,
            &config,
        )?;
        if let Some(at) = argv.iter().position(|s| s == "-start_number") {
            argv[at + 1] = start_index.to_string();
        }
        if guard.is_some() {
            let at = argv
                .iter()
                .position(|s| s == "-i")
                .ok_or("invalid_ingest_arguments")?;
            argv.splice(
                at..at,
                [
                    "-format_whitelist".into(),
                    config::GUARDED_INPUT_FORMATS.into(),
                ],
            );
        }
        if guard.as_ref().is_some_and(UpstreamGuard::observed_hls) {
            // Bounded provider history; FFmpeg clamps short playlists and ignores
            // the live index for ENDLIST/VOD. Never wait for history to accumulate.
            let at = argv
                .iter()
                .position(|s| s == "-i")
                .ok_or("invalid_ingest_arguments")?;
            argv.splice(at..at, ["-live_start_index".into(), "-6".into()]);
        }
        let watch = PublicationWatch::new(&directory);
        let child = Command::new(&config.ffmpeg_path)
            .args(&argv)
            .env_clear()
            .envs(&child_env)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "ffmpeg_spawn_failed")?;
        Ok((child, watch))
    }
    .await;
    let (mut child, mut publication) = match startup {
        Ok(value) => value,
        Err(error) => {
            if error == "ffmpeg_spawn_failed" {
                let mut state = channel.state.lock().unwrap();
                state.spawn_failed = true;
                state.failure_reported = true;
                if let Some(sink) = &failure_sink {
                    let mut event = runtime_media::FailureEventInput {
                        channel_id: channel_id.clone(),
                        source: "ingest".into(),
                        outcome: "spawn_failed".into(),
                        exit_code: None,
                        signal: None,
                        rung_id: None,
                        stderr_tail: state.stderr_tail.clone(),
                        probe: state.probe.clone(),
                        decision: state.decision.clone(),
                        ..Default::default()
                    };
                    label_event(&mut event, &state);
                    sink(event);
                }
            }
            if let Some(guard) = guard {
                guard.shutdown().await;
            }
            let _ = tokio::fs::remove_dir_all(&directory).await;
            if let Some(sender) = started.take() {
                let _ = sender.send(Err(error.clone()));
            }
            return Err(error);
        }
    };
    let stderr_channel = channel.clone();
    let stderr = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            let mut chunk = [0u8; 4096];
            let mut diagnostics = runtime_media::DiagnosticTail::default();
            while let Ok(length) = stderr.read(&mut chunk).await {
                if length == 0 {
                    break;
                }
                diagnostics.push(&chunk[..length]);
                let text = diagnostics.tail();
                let mut state = stderr_channel.state.lock().unwrap();
                state.record_stderr(text);
            }
            diagnostics.finish();
            stderr_channel
                .state
                .lock()
                .unwrap()
                .record_stderr(diagnostics.tail());
        })
    });
    if let Some(sender) = started.take() {
        let _ = sender.send(Ok(()));
    }
    let mut ring = SegmentRing::new(config::LIVE_HLS_RING_CAPACITY);
    ring.max_seen = start_index.checked_sub(1);
    let mut fallback = tokio::time::interval(Duration::from_secs(1));
    let mut stopped = false;
    // Tokio Child::wait closes Child::stdin before waiting. Keep our quit pipe
    // outside the handle until explicit teardown so health polling cannot close it.
    let stdin = child.stdin.take();
    // Settled only once stderr is drained (below), so a classification of the exit sees
    // FFmpeg's last lines, like the TS proxy's 'close' event.
    let mut exit = None;
    loop {
        tokio::select! {
            _ = cancelled(&mut cancel) => { stopped = true; break; },
            status = child.wait() => { exit = Some(status); break; },
            _ = publication.changed() => {},
            _ = fallback.tick() => {},
        }
        for completed in runtime_media::completed_segments(&directory, "ts").await {
            if ring.published_or_retired(completed.index) {
                continue;
            }
            ring.note_seen(completed.index);
            channel.state.lock().unwrap().max_seen = ring.max_seen;
            let data = match runtime_media::read_for_publication(
                &completed.path,
                completed.index,
                &mut ring,
                &media_budget,
                |segments| {
                    channel.state.lock().unwrap().segments = segments;
                    channel.changed.send_modify(|n| *n = n.wrapping_add(1));
                },
            )
            .await
            {
                Ok(data) => data,
                Err(error) if error == "media_memory_capacity" => break,
                Err(_) => continue,
            };
            let timing_data = data.clone();
            if ring.push(Segment {
                index: completed.index,
                duration: completed.duration,
                data,
                created_at_ms: runtime_media::now_ms(),
            }) {
                let mut state = channel.state.lock().unwrap();
                state.segments = ring.snapshot();
                state.max_seen = ring.max_seen;
                state.last_segment_at_ms = runtime_media::now_ms();
                let now = state.last_segment_at_ms;
                state.output_diagnostics.observe(&timing_data, now);
                state.produced = true;
                state.health = if state.input_timeline_reset
                    || guard.as_ref().is_some_and(UpstreamGuard::failed)
                {
                    "degraded"
                } else {
                    "healthy"
                }
                .into();
                drop(state);
                channel.changed.send_modify(|n| *n = n.wrapping_add(1));
            }
        }
        if guard.as_ref().is_some_and(UpstreamGuard::failed) {
            channel.state.lock().unwrap().health = "degraded".into();
        }
    }
    drop(publication);
    child.stdin = stdin;
    let reaped = stop_child(&mut child, stopped).await;
    if let Some(high) = runtime_media::highest_segment_index(&directory, "ts").await {
        let mut state = channel.state.lock().unwrap();
        state.max_seen = Some(state.max_seen.map_or(high, |old| old.max(high)));
    }
    if let Some(mut task) = stderr
        && tokio::time::timeout(Duration::from_secs(1), &mut task)
            .await
            .is_err()
    {
        task.abort();
        let _ = task.await;
    }
    if let Some(guard) = guard {
        guard.shutdown().await;
    }
    if let Some(status) = exit {
        #[cfg(unix)]
        let signal = status.as_ref().ok().and_then(|status| {
            use std::os::unix::process::ExitStatusExt;
            status.signal().map(signal_name)
        });
        #[cfg(not(unix))]
        let signal: Option<String> = None;
        let success = status.as_ref().is_ok_and(|s| s.success());
        let mut state = channel.state.lock().unwrap();
        // A SIGTERM from outside is the container shutting down, not the source
        // ending; it must not look like an attempt to classify and fail over.
        state.exited = signal.as_deref() != Some("SIGTERM");
        state.exit_signal = signal.clone();
        state.health = if success { "stopped" } else { "error" }.into();
        if let Ok(status) = &status
            && !success
            && signal.as_deref() != Some("SIGTERM")
        {
            state.failure_reported = true;
            if let Some(sink) = &failure_sink {
                let mut event = runtime_media::FailureEventInput {
                    channel_id: channel_id.clone(),
                    source: "ingest".into(),
                    outcome: "crashed".into(),
                    exit_code: status.code(),
                    signal,
                    rung_id: None,
                    stderr_tail: state.stderr_tail.clone(),
                    probe: state.probe.clone(),
                    decision: state.decision.clone(),
                    ..Default::default()
                };
                label_event(&mut event, &state);
                sink(event);
            }
        }
        drop(state);
        channel.changed.send_modify(|n| *n = n.wrapping_add(1));
    }
    // A crashed ingest retains its complete ring for status/failover. Only an explicit
    // stop owns directory deletion; output children must have been stopped beforehand.
    if stopped {
        let _ = tokio::fs::remove_dir_all(directory).await;
    }
    reaped
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn guarded_live_probe_drives_actual_runtime_input_options_only_for_hls() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (hls, probe_success) in [(true, true), (true, false), (false, true), (false, false)] {
            let root = std::env::temp_dir().join(format!(
                "native-input-options-{}-{}-{hls}-{probe_success}",
                std::process::id(),
                runtime_media::now_ms()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let url = format!("http://{}/extensionless", listener.local_addr().unwrap());
            let provider = tokio::spawn(async move {
                let mut tasks = tokio::task::JoinSet::new();
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    tasks.spawn(async move {
                    let mut request=Vec::new();let mut byte=[0];
                    while !request.ends_with(b"\r\n\r\n") {if socket.read(&mut byte).await.unwrap_or(0)==0{return;} request.push(byte[0]);}
                    let body=if hls {"#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:3,\nsegment.ts\n"} else {"raw transport stream bytes"};
                    let response=format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len());
                    socket.write_all(response.as_bytes()).await.unwrap();
                });
                }
            });
            let probe = root.join("probe");
            std::fs::write(&probe,"#!/usr/bin/python3\nimport sys,urllib.request\nwith urllib.request.urlopen(sys.argv[-1]) as response: response.read()\nprint('{\"streams\":[{\"codec_type\":\"video\",\"codec_name\":\"h264\",\"height\":720}]}')\n").unwrap();
            if !probe_success {
                std::fs::write(&probe, "#!/usr/bin/python3\nimport sys,urllib.request\nwith urllib.request.urlopen(sys.argv[-1]) as response: response.read()\nsys.exit(1)\n").unwrap();
            }
            let encoder = root.join("encoder");
            std::fs::write(
                &encoder,
                format!(
                    "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nread -r command\n",
                    root.join("argv").display()
                ),
            )
            .unwrap();
            for path in [&probe, &encoder] {
                crate::test_support::seal_executable(path, 0o755);
            }
            let env: Environment = std::env::vars().collect();
            let mut config = ProxyConfig::from_env(&env);
            config.ffprobe_path = probe.to_string_lossy().into_owned();
            config.ffmpeg_path = encoder.to_string_lossy().into_owned();
            let ingest = IngestManager::new(config, env, root.clone());
            ingest.spawn("channel", &url, 42, true).await.unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while !root.join("argv").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let args = std::fs::read_to_string(root.join("argv")).unwrap();
            let argv: Vec<_> = args.lines().collect();
            let input = argv.iter().position(|arg| *arg == "-i").unwrap();
            if hls {
                let at = argv
                    .iter()
                    .position(|arg| *arg == "-live_start_index")
                    .unwrap();
                assert!(at < input);
                assert_eq!(argv[at + 1], "-6");
            } else {
                assert!(!argv.contains(&"-live_start_index"));
            }
            assert_eq!(
                argv[argv.iter().position(|arg| *arg == "-readrate").unwrap() + 1],
                "1"
            );
            assert_eq!(
                argv[argv
                    .iter()
                    .position(|arg| *arg == "-readrate_initial_burst")
                    .unwrap()
                    + 1],
                "12"
            );
            assert_eq!(
                argv[argv.iter().position(|arg| *arg == "-start_number").unwrap() + 1],
                "42"
            );
            assert_eq!(
                ingest.snapshot("channel").unwrap().probe["success"]
                    .as_bool()
                    .unwrap(),
                probe_success
            );
            ingest.stop("channel").await.unwrap();
            provider.abort();
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn actual_ingest_publishes_completed_media_and_final_quit_highwater() {
        let root = std::env::temp_dir().join(format!(
            "native-ingest-{}-{}",
            std::process::id(),
            runtime_media::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let probe = root.join("probe");
        std::fs::write(&probe, "#!/bin/sh\nprintf '%s' '{\"streams\":[{\"codec_type\":\"video\",\"codec_name\":\"h264\",\"height\":720}]}'\n").unwrap();
        let encoder = root.join("encoder");
        std::fs::write(&encoder, "#!/bin/sh\nfor arg in \"$@\"; do playlist=\"$arg\"; done\ndirectory=\"${playlist%/*}\"\nprintf '%s' 'transport19' > \"$directory/segment-19.ts\"\nprintf '#EXTM3U\\n#EXTINF:3.125,\\nsegment-19.ts\\n' > \"$playlist\"\nread -r command\nprintf '%s' 'transport20' > \"$directory/segment-20.ts\"\nexit 0\n").unwrap();
        for path in [&probe, &encoder] {
            crate::test_support::seal_executable(path, 0o755);
        }
        let env: Environment = std::env::vars().collect();
        let mut config = ProxyConfig::from_env(&env);
        config.ffprobe_path = probe.to_string_lossy().into_owned();
        config.ffmpeg_path = encoder.to_string_lossy().into_owned();
        let ingest = IngestManager::new(config, env, root.clone());
        ingest
            .spawn("channel", "rtsp://127.0.0.1/live", 10, true)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while ingest.snapshot("channel").unwrap().segments.is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let snapshot = ingest.snapshot("channel").unwrap();
        assert_eq!(snapshot.segments[0].index, 19);
        assert_eq!(snapshot.segments[0].duration, 3.125);
        assert_eq!(snapshot.segments[0].data.as_ref(), b"transport19");
        assert_eq!(ingest.stop("channel").await.unwrap(), Some(20));
        assert!(ingest.snapshot("channel").is_none());
        assert!(!root.join("channel").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    fn attempt(stderr: &str, produced: bool) -> IngestSnapshot {
        IngestSnapshot {
            segments: Vec::new(),
            probe: failed_probe(),
            decision: json!({"videoAction":"copy","audioAction":"copy"}),
            health: "healthy".into(),
            stopping: false,
            generation: 1,
            max_seen: None,
            started_at_ms: 0,
            last_segment_at_ms: 0,
            output_diagnostics: Default::default(),
            stderr_tail: stderr.into(),
            input_timeline_reset: false,
            produced,
            exited: false,
            exit_signal: None,
            spawn_failed: false,
            failure_reported: false,
            label: AttemptLabel::default(),
            relay: None,
        }
    }
    #[test]
    fn a_live_sequence_reset_requires_recovery_before_the_stall_deadline() {
        let mut state = attempt("", true);
        state.record_stderr(
            "[hls @ 0x1] Media sequence changed unexpectedly: 1793544034 -> 1793544009",
        );
        state.record_stderr("[mpegts] Packet corrupt"); // tail rotation must not forget it
        let failure = classify_attempt(&state, false).unwrap();
        assert_eq!(
            (failure.reason, failure.immediate),
            ("upstream_stalled", true)
        );
        assert_eq!(state.health, "degraded");
        assert!(!state.exited, "do not wait for FFmpeg to exit");
        let state = attempt("[mpegts] Packet corrupt", true);
        assert_eq!(classify_attempt(&state, false), None);
        assert!(!classify_attempt(&state, true).unwrap().immediate);
    }

    #[test]
    fn attempt_classification_follows_the_precedence() {
        let reason =
            |state: &IngestSnapshot, ended| classify_attempt(state, ended).map(|f| f.reason);
        let quiet = attempt("", false);
        assert_eq!(classify_attempt(&quiet, false), None);
        assert_eq!(reason(&quiet, true), Some("channel_offline"));
        assert_eq!(reason(&attempt("", true), true), Some("upstream_stalled"));
        let mut crashed = attempt("", true);
        crashed.exited = true;
        crashed.exit_signal = Some("SIGSEGV".into());
        let failure = classify_attempt(&crashed, false).unwrap();
        assert_eq!(
            (failure.reason, failure.immediate),
            ("encoder_failed", true)
        );
        crashed.stderr_tail = "Server returned 403 Forbidden\n".into();
        assert_eq!(reason(&crashed, false), Some("provider_auth_failed"));
        // A copying ingest runs no encoder: its encoder lines are not ours to blame.
        let gpu = "[h264_vaapi @ 0x1] Failed to initialise VAAPI connection\n";
        assert_eq!(reason(&attempt(gpu, false), true), Some("channel_offline"));
        let mut transcoding = attempt(gpu, false);
        transcoding.decision = json!({"videoAction":"transcode","audioAction":"copy"});
        assert_eq!(reason(&transcoding, true), Some("encoder_failed"));
        let mut refused = attempt("", false);
        refused.spawn_failed = true;
        assert_eq!(reason(&refused, false), Some("encoder_failed"));
    }
    #[tokio::test]
    async fn a_failed_attempt_reports_its_reason_and_station_url() {
        let root = std::env::temp_dir().join(format!(
            "native-ingest-classified-{}-{}",
            std::process::id(),
            runtime_media::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let probe = root.join("probe");
        std::fs::write(&probe, "#!/bin/sh\nprintf '%s' '{\"streams\":[{\"codec_type\":\"video\",\"codec_name\":\"h264\",\"height\":720}]}'\n").unwrap();
        let encoder = root.join("encoder");
        std::fs::write(
            &encoder,
            "#!/bin/sh\necho 'Error opening input: Server returned 404 Not Found' >&2\nexit 1\n",
        )
        .unwrap();
        for path in [&probe, &encoder] {
            crate::test_support::seal_executable(path, 0o755);
        }
        let env: Environment = std::env::vars().collect();
        let mut config = ProxyConfig::from_env(&env);
        config.ffprobe_path = probe.to_string_lossy().into_owned();
        config.ffmpeg_path = encoder.to_string_lossy().into_owned();
        let ingest = IngestManager::new(config, env, root.clone());
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        ingest.set_failure_sink(Some(Arc::new(move |event| {
            captured.lock().unwrap().push(event);
        })));
        let label = AttemptLabel {
            stream_url_index: 1,
            feed_id: Some("feed-1".into()),
        };
        ingest
            .spawn_attempt("channel", "rtsp://127.0.0.1/live", 0, true, label)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while events.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let event = events.lock().unwrap()[0].clone();
        assert_eq!(event.outcome, "crashed");
        assert_eq!(event.exit_code, Some(1));
        assert_eq!(event.reason.as_deref(), Some("channel_offline"));
        assert_eq!(event.stream_url_index, Some(1));
        assert_eq!(event.feed_id.as_deref(), Some("feed-1"));
        let failure = ingest.attempt_failure("channel", false).unwrap();
        assert_eq!(
            failure,
            AttemptFailure {
                reason: "channel_offline",
                upstream_status: None,
                immediate: true,
                reported: true,
            }
        );
        ingest.stop("channel").await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn stop_signals_and_reaps_an_actual_owned_process() {
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        stop_child(&mut child, false).await.unwrap();
        assert!(child.try_wait().unwrap().is_some());
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, -1);
    }
    #[tokio::test]
    async fn failed_channel_attempts_prune_notification_registry_without_subscribers() {
        let env = Environment::new();
        let root =
            std::env::temp_dir().join(format!("native-ingest-failures-{}", std::process::id()));
        let ingest = IngestManager::new(ProxyConfig::from_env(&env), env, root);
        for index in 0..32 {
            assert!(
                ingest
                    .spawn(
                        &format!("channel{index}"),
                        "file:///not-an-allowed-input",
                        0,
                        false
                    )
                    .await
                    .is_err()
            );
            assert!(ingest.notifications.lock().unwrap().is_empty());
        }
        ingest.publish_test("stopped", 1, &[0]);
        ingest.stop("stopped").await.unwrap();
        assert!(ingest.notifications.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn cancel_all_interrupts_and_reaps_inflight_probe_before_timeout() {
        let root = std::env::temp_dir().join(format!(
            "native-ingest-cancel-{}-{}",
            std::process::id(),
            runtime_media::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let probe = root.join("probe");
        std::fs::write(
            &probe,
            "#!/bin/sh\necho $$ > \"$0.pid\"\nexec /bin/sleep 30\n",
        )
        .unwrap();
        crate::test_support::seal_executable(&probe, 0o755);
        let env: Environment = std::env::vars().collect();
        let mut config = ProxyConfig::from_env(&env);
        config.ffprobe_path = probe.to_string_lossy().into_owned();
        config.probe_timeout_ms = 30_000;
        let ingest = Arc::new(IngestManager::new(config, env, root.clone()));
        let owner = ingest.clone();
        let startup = tokio::spawn(async move {
            owner
                .spawn("channel", "rtsp://127.0.0.1/live", 0, true)
                .await
        });
        let pid_file = root.join("probe.pid");
        tokio::time::timeout(Duration::from_secs(1), async {
            while !pid_file.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let pid: libc::pid_t = std::fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        ingest.cancel_all();
        let result = tokio::time::timeout(Duration::from_secs(1), startup)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err(), "ingest_cancelled");
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert!(ingest.channel_ids().is_empty());
        assert!(ingest.notifications.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn shutdown_latch_fences_a_spawn_already_waiting_at_admission() {
        let env = Environment::new();
        let ingest = Arc::new(IngestManager::new(
            ProxyConfig::from_env(&env),
            env,
            std::env::temp_dir().join("native-shutdown-fence-unstarted"),
        ));
        let gate = Arc::new(AdmissionGate {
            entered: tokio::sync::Notify::new(),
            resume: tokio::sync::Notify::new(),
        });
        *ingest.admission_gate.lock().unwrap() = Some(gate.clone());
        let owner = ingest.clone();
        let attempted = tokio::spawn(async move {
            owner
                .spawn("channel", "rtsp://127.0.0.1/live", 0, true)
                .await
        });
        gate.entered.notified().await;
        ingest.cancel_all();
        gate.resume.notify_one();
        assert_eq!(
            attempted.await.unwrap().unwrap_err(),
            "ingest_shutting_down"
        );
        assert!(ingest.channel_ids().is_empty());
        assert!(ingest.notifications.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn ingest_publisher_retries_memory_blocked_index_after_response_releases() {
        let root = std::env::temp_dir().join(format!(
            "native-ingest-pressure-{}-{}",
            std::process::id(),
            runtime_media::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let probe = root.join("probe");
        let encoder = root.join("encoder");
        std::fs::write(&probe, "#!/bin/sh\nprintf '%s' '{\"streams\":[{\"codec_type\":\"video\",\"codec_name\":\"h264\",\"height\":720}]}'\n").unwrap();
        std::fs::write(&encoder, "#!/bin/sh\nfor arg in \"$@\"; do playlist=\"$arg\"; done\ndirectory=\"${playlist%/*}\"\nprintf 12345678 > \"$directory/segment-0.ts\"\nprintf '#EXTM3U\\n#EXTINF:3,\\nsegment-0.ts\\n' > \"$playlist.tmp\"\n/bin/mv \"$playlist.tmp\" \"$playlist\"\nwhile [ ! -f \"$directory/advance\" ]; do /bin/sleep .01; done\nprintf 1234567890abcdef > \"$directory/segment-1.ts\"\nprintf '#EXTM3U\\n#EXTINF:3,\\nsegment-0.ts\\n#EXTINF:3,\\nsegment-1.ts\\n' > \"$playlist.tmp\"\n/bin/mv \"$playlist.tmp\" \"$playlist\"\nread -r command\n").unwrap();
        for path in [&probe, &encoder] {
            crate::test_support::seal_executable(path, 0o755);
        }
        let env: Environment = std::env::vars().collect();
        let mut config = ProxyConfig::from_env(&env);
        config.ffprobe_path = probe.to_string_lossy().into_owned();
        config.ffmpeg_path = encoder.to_string_lossy().into_owned();
        let budget = crate::runtime_budget::MediaBudget::with_limit(16);
        let ingest = IngestManager::with_budget(config, env, root.clone(), budget.clone());
        ingest
            .spawn("channel", "rtsp://127.0.0.1/live", 0, true)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while ingest.snapshot("channel").unwrap().segments.is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let response = ingest.snapshot("channel").unwrap().segments[0].data.clone();
        tokio::fs::write(root.join("channel/advance"), b"go")
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let state = ingest.snapshot("channel").unwrap();
                if state.segments.is_empty() && state.max_seen == Some(1) {
                    break;
                }
                drop(state);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(budget.retained_bytes(), 8);
        drop(response);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if ingest
                    .snapshot("channel")
                    .unwrap()
                    .segments
                    .first()
                    .is_some_and(|s| s.index == 1)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(budget.retained_bytes(), 16);
        ingest.stop("channel").await.unwrap();
        assert_eq!(budget.retained_bytes(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}

// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Fixed, compatibility and synchronized adaptive outputs share one admission ledger.
use crate::{
    args::{self, Adaptive, Common, Egress, Rung},
    config::{Environment, LIVE_HLS_RING_CAPACITY, LIVE_HLS_SEGMENT_DURATION_S, ProxyConfig},
    filter_probe::HdrFilterProbe,
    hdr::HdrPolicy,
    runtime_feed::FeedGrants,
    runtime_ingest::{IngestManager, IngestSnapshot, stop_child},
    runtime_media::{self, PublicationWatch, Segment, SegmentRing},
};
use bytes::Bytes;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::{Mutex as AsyncMutex, watch},
};

#[derive(Clone, Default)]
pub struct OutputSnapshot {
    pub segments: Vec<Arc<Segment>>,
    pub fmp4: bool,
    pub init_segments: BTreeMap<String, Bytes>,
    pub discontinuity_anchors: Vec<u64>,
    pub aged_out_discontinuities: u64,
    pub init_uris: Value,
}
#[derive(Clone)]
pub struct VariantCarryOver {
    pub variant: String,
    pub viewers: Vec<String>,
    pub next_index: u64,
    pub generation: u64,
    pub snapshot: OutputSnapshot,
    pub source_codec: String,
    pub source_hdr: bool,
}
#[derive(Clone, PartialEq)]
enum Kind {
    Fixed,
    Fmp4,
    H264,
    Adaptive,
}
struct EntryState {
    outputs: BTreeMap<String, OutputSnapshot>,
    viewers: BTreeSet<String>,
    health: String,
    stopping: bool,
    stderr_tail: String,
    grace_deadline: Option<tokio::time::Instant>,
    max_seen: Option<u64>,
}
struct Entry {
    channel: String,
    id: String,
    kind: Kind,
    rung: Value,
    rungs: Value,
    includes_original: bool,
    reserved: u64,
    generation: u64,
    /// First segment index this process writes; lower ones were carried over.
    first_index: u64,
    started_at_ms: u64,
    hdr_tonemap: Option<String>,
    directory: PathBuf,
    state: Mutex<EntryState>,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}
struct Inner {
    ingest: Arc<IngestManager>,
    config: ProxyConfig,
    env: Environment,
    root: PathBuf,
    port: u16,
    grants: FeedGrants,
    entries: Mutex<BTreeMap<String, Arc<Entry>>>,
    admission: AsyncMutex<()>,
    stopping_channels: Mutex<BTreeSet<String>>,
    shutting_down: AtomicBool,
    used: AtomicU64,
    filters: HdrFilterProbe,
    hdr: Mutex<Option<(BTreeSet<String>, HdrPolicy)>>,
    failure_sink: Mutex<Option<runtime_media::FailureSink>>,
    stopped_highwater: Mutex<BTreeMap<String, (u64, u64)>>,
    media_budget: crate::runtime_budget::MediaBudget,
}
#[derive(Clone)]
pub struct OutputManager {
    inner: Arc<Inner>,
}
struct Reservation {
    inner: Arc<Inner>,
    outputs: u64,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.inner.used.fetch_sub(self.outputs, Ordering::AcqRel);
    }
}
fn refusal(reason: &str) -> Value {
    json!({"ok":false,"refusal":reason})
}
fn uncapped(reason: &str) -> Value {
    json!({"ok":true,"capped":false,"rungId":null,"appliedMaxBitrate":null,"reason":reason})
}
fn key(channel: &str, id: &str) -> String {
    format!("{channel}::{id}")
}
fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn sane_rung(value: &Value) -> bool {
    value["id"].as_str().is_some_and(safe_id)
        && value["height"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n > 0.0 && n <= 4320.0)
        && value["maxBitrate"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n > 0.0)
        && value["codec"] == "h264"
}
fn source_codec(snapshot: &IngestSnapshot) -> String {
    if snapshot.decision["videoAction"] == "copy" {
        snapshot.probe["video"]["codec"]
            .as_str()
            .unwrap_or("")
            .into()
    } else if snapshot.decision["videoEncoder"]
        .as_str()
        .is_some_and(|s| s.starts_with("hevc"))
    {
        "hevc".into()
    } else {
        "h264".into()
    }
}
fn can_copy_original(snapshot: &IngestSnapshot) -> bool {
    let probe = &snapshot.probe;
    let encoder = snapshot.decision["videoEncoder"]
        .as_str()
        .unwrap_or("")
        .to_ascii_lowercase();
    probe["success"] == true
        && probe["video"].is_object()
        && probe["video"]["hdr"] != true
        && probe["video"]["bitDepth"]
            .as_u64()
            .is_some_and(|depth| depth <= 8)
        && snapshot.decision["videoAction"] == "transcode"
        && (encoder == "libx264" || encoder.starts_with("h264_"))
}
fn variant_init(generation: u64) -> String {
    if generation == 0 {
        "init.mp4".into()
    } else {
        format!("init-{generation}.mp4")
    }
}
fn live_ingest(inner: &Inner, channel: &str) -> Option<IngestSnapshot> {
    inner
        .ingest
        .snapshot(channel)
        .filter(|s| !s.stopping && s.health != "error" && s.health != "stopped")
}
impl OutputManager {
    pub fn new(
        ingest: Arc<IngestManager>,
        config: ProxyConfig,
        env: Environment,
        root: PathBuf,
        port: u16,
        grants: FeedGrants,
    ) -> Self {
        Self::with_budget(
            ingest,
            config,
            env,
            root,
            port,
            grants,
            crate::runtime_budget::MediaBudget::process(),
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn with_budget(
        ingest: Arc<IngestManager>,
        config: ProxyConfig,
        env: Environment,
        root: PathBuf,
        port: u16,
        grants: FeedGrants,
        media_budget: crate::runtime_budget::MediaBudget,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                ingest,
                config,
                env,
                root,
                port,
                grants,
                entries: Mutex::new(BTreeMap::new()),
                admission: AsyncMutex::new(()),
                stopping_channels: Mutex::new(BTreeSet::new()),
                shutting_down: AtomicBool::new(false),
                used: AtomicU64::new(0),
                filters: HdrFilterProbe::default(),
                hdr: Mutex::new(None),
                failure_sink: Mutex::new(None),
                stopped_highwater: Mutex::new(BTreeMap::new()),
                media_budget,
            }),
        }
    }
    pub fn set_failure_sink(&self, sink: Option<runtime_media::FailureSink>) {
        *self.inner.failure_sink.lock().unwrap() = sink;
    }
    pub fn capacity(&self) -> Value {
        json!({"activeOutputs":self.inner.used.load(Ordering::Acquire),"limit":self.inner.config.max_egress_encoders})
    }
    pub fn channel_ids(&self) -> Vec<String> {
        self.inner
            .entries
            .lock()
            .unwrap()
            .values()
            .map(|e| e.channel.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    pub fn has_active(&self, channel: &str) -> bool {
        self.inner
            .entries
            .lock()
            .unwrap()
            .values()
            .any(|e| e.channel == channel && !e.state.lock().unwrap().stopping)
    }
    /// An output of `channel` still serving a viewer. One in its post-detach grace serves nobody.
    pub fn has_viewers(&self, channel: &str) -> bool {
        self.inner.entries.lock().unwrap().values().any(|e| {
            let state = e.state.lock().unwrap();
            e.channel == channel && !state.stopping && !state.viewers.is_empty()
        })
    }
    pub fn snapshot(&self, channel: &str, rung: &str) -> Option<OutputSnapshot> {
        let entries = self.inner.entries.lock().unwrap();
        let entry = entries.get(&key(channel, rung))?;
        let state = entry.state.lock().unwrap();
        if state.stopping {
            return None;
        }
        state.outputs.get(rung).cloned()
    }
    pub fn adaptive_snapshot(&self, channel: &str, output: &str) -> Option<OutputSnapshot> {
        let entries = self.inner.entries.lock().unwrap();
        let entry = entries.get(&key(channel, "@adaptive"))?;
        let state = entry.state.lock().unwrap();
        if state.stopping {
            return None;
        }
        state.outputs.get(output).cloned()
    }
    pub fn variants(&self, channel: &str) -> Value {
        let entries = self.inner.entries.lock().unwrap();
        entries
            .get(&key(channel, "@adaptive"))
            .filter(|e| !e.state.lock().unwrap().stopping)
            .map(|e| json!({"rungs":e.rungs,"includesOriginal":e.includes_original}))
            .unwrap_or(Value::Null)
    }
    pub fn encoder_status(&self, channel: &str) -> Value {
        let entries = self.inner.entries.lock().unwrap();
        Value::Array(entries.values().filter(|e| e.channel == channel).map(|e| {
            let state = e.state.lock().unwrap();
            let mut row = json!({"kind":if e.kind == Kind::Adaptive {"adaptive"} else {"rung"},"channelId":channel,"outputs":state.outputs.keys().collect::<Vec<_>>(),"viewers":state.viewers.len(),"health":state.health,"reservedOutputs":e.reserved,"startedAt":crate::runtime_operations::iso_timestamp(e.started_at_ms)});
            if e.kind != Kind::Adaptive { row["rungId"] = json!(e.id); }
            if state.stopping { row["stopping"] = json!(true); }
            row
        }).collect())
    }
    async fn hdr_path(&self, hdr: bool) -> Option<String> {
        let filters = self
            .inner
            .filters
            .filters(&self.inner.config.ffmpeg_path)
            .await;
        if !hdr {
            return None;
        }
        let mut policy = self.inner.hdr.lock().unwrap();
        if policy
            .as_ref()
            .is_none_or(|(old, _)| old != filters.as_ref())
        {
            *policy = Some((
                filters.as_ref().clone(),
                HdrPolicy::new(filters.as_ref().clone()),
            ));
        }
        policy
            .as_ref()
            .and_then(|(_, policy)| {
                policy.resolve(
                    &self.inner.config.gpu,
                    std::env::consts::OS,
                    runtime_media::now_ms() as i64,
                )
            })
            .map(str::to_owned)
    }
    fn stopped(&self, channel: &str) -> bool {
        self.inner.shutting_down.load(Ordering::Acquire)
            || self
                .inner
                .stopping_channels
                .lock()
                .unwrap()
                .contains(channel)
    }
    async fn wait_existing(&self, channel: &str, id: &str) {
        loop {
            let entry = self
                .inner
                .entries
                .lock()
                .unwrap()
                .get(&key(channel, id))
                .cloned();
            let Some(entry) = entry.filter(|e| e.state.lock().unwrap().stopping) else {
                return;
            };
            let mut done = entry.done.clone();
            while !*done.borrow() {
                if done.changed().await.is_err() {
                    break;
                }
            }
        }
    }
    pub async fn attach_fixed(
        &self,
        channel: &str,
        rung: &Value,
        viewer: &str,
        options: &Value,
    ) -> Value {
        if !safe_id(channel)
            || !sane_rung(rung)
            || rung["id"].as_str().is_some_and(|id| id.starts_with("v-"))
        {
            return refusal("invalid");
        }
        let id = rung["id"].as_str().unwrap();
        let ingest = self.inner.ingest.snapshot(channel);
        let hdr = ingest
            .as_ref()
            .is_some_and(|s| s.probe["video"]["hdr"] == true);
        let path = self.hdr_path(hdr).await;
        self.wait_existing(channel, id).await;
        let _admission = self.inner.admission.lock().await;
        if self.stopped(channel) {
            return refusal("internal");
        }
        let below = options["belowLadder"] == true;
        let pinned = options["pinned"] == true;
        let fallback = options["fallback"].as_str().unwrap_or("refuse");
        if let Some(existing) = self
            .inner
            .entries
            .lock()
            .unwrap()
            .get(&key(channel, id))
            .cloned()
        {
            if below && fallback == "refuse" && !pinned {
                return refusal("below_ladder");
            }
            let mut state = existing.state.lock().unwrap();
            if state.stopping {
                return refusal("internal");
            }
            state.viewers.insert(viewer.into());
            state.grace_deadline = None;
            return json!({"ok":true,"capped":true,"rungId":id,"appliedMaxBitrate":existing.rung["maxBitrate"],"reason":if below {json!("below_ladder")} else {Value::Null}});
        }
        let Some(ingest) = live_ingest(&self.inner, channel) else {
            return refusal("internal");
        };
        let unprobeable = ingest.probe["success"] != true || !ingest.probe["video"].is_object();
        let hdr = !unprobeable && ingest.probe["video"]["hdr"] == true;
        let hdr_unsupported = hdr && path.is_none();
        let needed =
            args::hdr_reserved_outputs(1, hdr, self.inner.config.max_egress_encoders as u64);
        let at_capacity = self.inner.used.load(Ordering::Acquire) + needed
            > self.inner.config.max_egress_encoders as u64;
        if pinned {
            if at_capacity {
                return refusal("capacity");
            }
            if hdr_unsupported {
                return refusal("hdr_source");
            }
        } else {
            if runtime_media::observed_bitrate(&ingest.segments).is_some_and(|rate| {
                rate <= options["requestedMaxBitrate"].as_f64().unwrap_or(0.0) * 0.9
            }) {
                return uncapped("source_within_cap");
            }
            if below && (unprobeable || hdr_unsupported || at_capacity || fallback == "refuse") {
                return refusal("below_ladder");
            }
            if unprobeable || hdr_unsupported {
                let reason = if unprobeable {
                    "unprobeable"
                } else {
                    "hdr_source"
                };
                return if fallback == "source" {
                    uncapped(reason)
                } else {
                    refusal(reason)
                };
            }
            if at_capacity {
                return if fallback == "source" {
                    uncapped("capacity")
                } else {
                    refusal("capacity")
                };
            }
        }
        let directory = self.inner.root.join(channel).join(format!("rung-{id}"));
        let common = self.common(channel, &directory, 0, None);
        let Ok(rung_args) = serde_json::from_value::<Rung>(rung.clone()) else {
            return refusal("invalid");
        };
        let argv = args::egress(&Egress {
            common,
            rung: rung_args,
            gpu: self.inner.config.gpu.clone(),
            vaapi_device: self.inner.config.vaapi_device.clone(),
            ingest_audio_is_aac: true,
            compat: false,
            hdr_tonemap: path.clone(),
        });
        match self.start(
            channel,
            id,
            Kind::Fixed,
            rung.clone(),
            Value::Null,
            false,
            needed,
            0,
            0,
            path,
            directory,
            argv,
            vec![viewer.to_owned()],
            None,
        ) {
            Ok(()) => {
                json!({"ok":true,"capped":true,"rungId":id,"appliedMaxBitrate":rung["maxBitrate"],"reason":if below {json!("below_ladder")} else {Value::Null}})
            }
            Err(_) => refusal("internal"),
        }
    }
    pub async fn attach_variant(&self, channel: &str, variant: &str, viewer: &str) -> Value {
        if !safe_id(channel) || !matches!(variant, "fmp4" | "h264") {
            return refusal("invalid");
        }
        let ingest = self.inner.ingest.snapshot(channel);
        let hdr = variant == "h264"
            && ingest
                .as_ref()
                .is_some_and(|s| s.probe["video"]["hdr"] == true);
        let path = self.hdr_path(hdr).await;
        let id = format!("v-{variant}");
        self.wait_existing(channel, &id).await;
        let _admission = self.inner.admission.lock().await;
        if self.stopped(channel) {
            return refusal("internal");
        }
        if let Some(entry) = self
            .inner
            .entries
            .lock()
            .unwrap()
            .get(&key(channel, &id))
            .cloned()
        {
            let mut state = entry.state.lock().unwrap();
            if state.stopping {
                return refusal("internal");
            }
            state.viewers.insert(viewer.into());
            state.grace_deadline = None;
            return json!({"ok":true,"rungId":id});
        }
        self.start_variant(channel, variant, vec![viewer.into()], None, path)
    }
    pub async fn attach_adaptive(&self, channel: &str, request: &Value, viewer: &str) -> Value {
        let requested = request["rungs"].as_array();
        if !safe_id(channel)
            || requested.is_none_or(|r| {
                r.len() < 2
                    || r.len() > 8
                    || !r.iter().all(sane_rung)
                    || r.iter()
                        .filter_map(|v| v["id"].as_str())
                        .collect::<BTreeSet<_>>()
                        .len()
                        != r.len()
            })
        {
            return refusal("invalid");
        }
        let ingest = self.inner.ingest.snapshot(channel);
        let hdr = ingest
            .as_ref()
            .is_some_and(|s| s.probe["video"]["hdr"] == true);
        let path = self.hdr_path(hdr).await;
        self.wait_existing(channel, "@adaptive").await;
        let _admission = self.inner.admission.lock().await;
        if self.stopped(channel) {
            return refusal("internal");
        }
        if let Some(entry) = self
            .inner
            .entries
            .lock()
            .unwrap()
            .get(&key(channel, "@adaptive"))
            .cloned()
        {
            let mut state = entry.state.lock().unwrap();
            if state.stopping {
                return refusal("internal");
            }
            state.viewers.insert(viewer.into());
            state.grace_deadline = None;
            return json!({"ok":true,"rungs":entry.rungs,"includesOriginal":entry.includes_original});
        }
        let Some(ingest) = live_ingest(&self.inner, channel) else {
            return refusal("internal");
        };
        if ingest.probe["success"] != true || !ingest.probe["video"].is_object() {
            return refusal("unprobeable");
        }
        let height = ingest.probe["video"]["height"].as_f64().unwrap_or(0.0);
        let rungs: Vec<Value> = requested
            .unwrap()
            .iter()
            .filter(|v| v["height"].as_f64().unwrap_or(f64::INFINITY) <= height)
            .cloned()
            .collect();
        if rungs.len() < 2 {
            return refusal("insufficient_ladder");
        }
        if hdr && path.is_none() {
            return refusal("hdr_source");
        }
        let include_original = request["includeOriginal"] == true && can_copy_original(&ingest);
        if include_original && rungs.iter().any(|rung| rung["id"] == "original") {
            return refusal("invalid");
        }
        let needed = args::hdr_reserved_outputs(
            rungs.len() as u64,
            hdr,
            self.inner.config.max_egress_encoders as u64,
        );
        if self.inner.used.load(Ordering::Acquire) + needed
            > self.inner.config.max_egress_encoders as u64
        {
            return refusal("capacity");
        }
        let directory = self.inner.root.join(channel).join("adaptive");
        let typed: Vec<Rung> = match serde_json::from_value(json!(rungs)) {
            Ok(r) => r,
            Err(_) => return refusal("invalid"),
        };
        let argv = match args::adaptive(&Adaptive {
            common: self.common(channel, &directory, 0, None),
            rungs: typed,
            include_original,
            hdr_tonemap: path.clone(),
            vaapi_device: Some(self.inner.config.vaapi_device.clone()),
        }) {
            Ok(argv) => argv,
            Err(_) => return refusal("invalid"),
        };
        match self.start(
            channel,
            "@adaptive",
            Kind::Adaptive,
            Value::Null,
            json!(rungs),
            include_original,
            needed,
            0,
            0,
            path,
            directory,
            argv,
            vec![viewer.into()],
            None,
        ) {
            Ok(()) => json!({"ok":true,"rungs":rungs,"includesOriginal":include_original}),
            Err(_) => refusal("internal"),
        }
    }
    fn common(
        &self,
        channel: &str,
        directory: &std::path::Path,
        start: u64,
        init: Option<String>,
    ) -> Common {
        let mut random = [0u8; 16];
        // A failed system RNG must fail admission; it must never mint predictable IDs.
        let random_ok = getrandom::fill(&mut random).is_ok();
        let feed: String = random.iter().map(|b| format!("{b:02x}")).collect();
        Common {
            input_url: if random_ok {
                format!(
                    "http://127.0.0.1:{}/streams/{channel}/feed.ts?feed={feed}",
                    self.inner.port
                )
            } else {
                String::new()
            },
            seg_dir: directory.to_string_lossy().into_owned(),
            segment_duration: LIVE_HLS_SEGMENT_DURATION_S as f64,
            ring_capacity: LIVE_HLS_RING_CAPACITY as f64,
            start_number: Some(start as f64),
            init_filename: init,
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn start(
        &self,
        channel: &str,
        id: &str,
        kind: Kind,
        rung: Value,
        rungs: Value,
        includes_original: bool,
        reserved: u64,
        generation: u64,
        first_index: u64,
        hdr_tonemap: Option<String>,
        directory: PathBuf,
        argv: Vec<String>,
        viewers: Vec<String>,
        carry: Option<OutputSnapshot>,
    ) -> Result<(), String> {
        let Some(feed) = argv
            .windows(2)
            .find(|a| a[0] == "-i")
            .and_then(|a| url::Url::parse(&a[1]).ok())
            .and_then(|url| {
                url.query_pairs()
                    .find(|(key, _)| key == "feed")
                    .map(|(_, id)| id.into_owned())
            })
        else {
            return Err("feed_random_unavailable".into());
        };
        let grant = self.inner.grants.grant(channel, &feed);
        let old_used = self.inner.used.fetch_add(reserved, Ordering::AcqRel);
        let reservation = Reservation {
            inner: self.inner.clone(),
            outputs: reserved,
        };
        if old_used + reserved > self.inner.config.max_egress_encoders as u64 {
            return Err("capacity".into());
        }
        let output_ids: Vec<String> = if kind == Kind::Adaptive {
            rungs
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|r| r["id"].as_str().map(str::to_owned))
                .chain(includes_original.then_some("original".into()))
                .collect()
        } else {
            vec![id.into()]
        };
        let mut outputs = BTreeMap::new();
        for output in &output_ids {
            let path = if kind == Kind::Adaptive {
                directory.join(output)
            } else {
                directory.clone()
            };
            std::fs::create_dir_all(path).map_err(|_| "output_directory_unavailable")?;
            let mut snapshot = carry.clone().unwrap_or_default();
            snapshot.fmp4 = kind == Kind::Fmp4;
            if snapshot.init_uris.is_null() {
                snapshot.init_uris = json!([{ "fromIndex":0,"uri":variant_init(generation) }]);
            }
            outputs.insert(output.clone(), snapshot);
        }
        let child = match Command::new(&self.inner.config.ffmpeg_path)
            .args(argv)
            .env_clear()
            .envs(crate::config::upstream_environment(
                &self.inner.env,
                "",
                true,
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(_) => {
                let _ = std::fs::remove_dir_all(&directory);
                report_failure(
                    &self.inner,
                    channel,
                    id,
                    &kind,
                    "spawn_failed",
                    None,
                    None,
                    String::new(),
                );
                return Err("output_spawn_failed".into());
            }
        };
        let (stop, cancelled) = watch::channel(false);
        let (completed, done) = watch::channel(false);
        let entry = Arc::new(Entry {
            channel: channel.into(),
            id: id.into(),
            kind,
            rung,
            rungs,
            includes_original,
            reserved,
            generation,
            first_index,
            started_at_ms: runtime_media::now_ms(),
            hdr_tonemap,
            directory,
            state: Mutex::new(EntryState {
                outputs,
                viewers: viewers.into_iter().collect(),
                health: "starting".into(),
                stopping: false,
                stderr_tail: String::new(),
                grace_deadline: None,
                max_seen: None,
            }),
            stop,
            done,
        });
        self.inner
            .entries
            .lock()
            .unwrap()
            .insert(key(channel, id), entry.clone());
        let inner = self.inner.clone();
        tokio::spawn(async move {
            supervise(inner, entry, child, cancelled, reservation).await;
            drop(grant);
            let _ = completed.send(true);
        });
        Ok(())
    }
    fn start_variant(
        &self,
        channel: &str,
        variant: &str,
        viewers: Vec<String>,
        mut carry: Option<VariantCarryOver>,
        path: Option<String>,
    ) -> Value {
        let Some(ingest) = live_ingest(&self.inner, channel) else {
            return refusal("internal");
        };
        let hdr = variant == "h264" && ingest.probe["video"]["hdr"] == true;
        if hdr && path.is_none() {
            return refusal("hdr_source");
        }
        let reserved = if variant == "h264" {
            args::hdr_reserved_outputs(1, hdr, self.inner.config.max_egress_encoders as u64)
        } else {
            0
        };
        if self.inner.used.load(Ordering::Acquire) + reserved
            > self.inner.config.max_egress_encoders as u64
        {
            return refusal("capacity");
        }
        let id = format!("v-{variant}");
        if let Some((generation, high)) = self
            .inner
            .stopped_highwater
            .lock()
            .unwrap()
            .remove(&key(channel, &id))
            && let Some(carry) = &mut carry
            && generation.saturating_add(1) == carry.generation
        {
            carry.next_index = carry.next_index.max(high.saturating_add(1));
        }
        let generation = carry.as_ref().map_or(0, |c| c.generation);
        let start = carry.as_ref().map_or(0, |c| c.next_index);
        let directory = self.inner.root.join(channel).join(format!("rung-{id}"));
        let common = self.common(channel, &directory, start, Some(variant_init(generation)));
        let rung = json!({"id":id,"height":if variant == "h264" {1080.0} else {ingest.probe["video"]["height"].as_f64().unwrap_or(0.0)},"maxBitrate":if variant == "h264" {8000000.0} else {0.0},"codec":"h264"});
        let argv = if variant == "fmp4" {
            args::remux(&common, Some(&source_codec(&ingest)))
        } else {
            args::egress(&Egress {
                common,
                rung: serde_json::from_value(rung.clone()).unwrap(),
                gpu: self.inner.config.gpu.clone(),
                vaapi_device: self.inner.config.vaapi_device.clone(),
                ingest_audio_is_aac: true,
                compat: true,
                hdr_tonemap: path.clone(),
            })
        };
        let snapshot = carry.map(|carry| {
            let mut snapshot = carry.snapshot;
            if snapshot.discontinuity_anchors.last() != Some(&start) {
                snapshot.discontinuity_anchors.push(start);
            }
            let mut starts = snapshot.init_uris.as_array().cloned().unwrap_or_default();
            starts.retain(|g| g["fromIndex"].as_u64() != Some(start));
            starts.push(json!({"fromIndex":start,"uri":variant_init(generation)}));
            snapshot.init_uris = json!(starts);
            snapshot
        });
        match self.start(
            channel,
            &id,
            if variant == "fmp4" {
                Kind::Fmp4
            } else {
                Kind::H264
            },
            rung,
            Value::Null,
            false,
            reserved,
            generation,
            start,
            path,
            directory,
            argv,
            viewers,
            snapshot,
        ) {
            Ok(()) => json!({"ok":true,"rungId":id}),
            Err(_) => refusal("internal"),
        }
    }
    pub async fn detach(&self, channel: &str, rung: &str, viewer: &str) {
        self.detach_key(&key(channel, rung), viewer);
    }
    pub async fn detach_adaptive(&self, channel: &str, viewer: &str) {
        self.detach_key(&key(channel, "@adaptive"), viewer);
    }
    fn detach_key(&self, key: &str, viewer: &str) {
        if let Some(entry) = self.inner.entries.lock().unwrap().get(key) {
            let mut state = entry.state.lock().unwrap();
            state.viewers.remove(viewer);
            if state.viewers.is_empty() && state.grace_deadline.is_none() {
                state.grace_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(10));
            }
        }
    }
    pub async fn detach_viewer(&self, channel: &str, viewer: &str) {
        let keys: Vec<String> = self
            .inner
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, e)| e.channel == channel)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            self.detach_key(&key, viewer);
        }
    }
    pub fn snapshot_variants(&self, channel: &str) -> Vec<VariantCarryOver> {
        let Some(ingest) = self.inner.ingest.snapshot(channel) else {
            return Vec::new();
        };
        self.inner
            .entries
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.channel == channel && matches!(e.kind, Kind::Fmp4 | Kind::H264))
            .filter_map(|e| {
                let state = e.state.lock().unwrap();
                if state.stopping || state.viewers.is_empty() {
                    return None;
                }
                let snapshot = state.outputs.get(&e.id)?.clone();
                let next_index = snapshot
                    .segments
                    .last()
                    .map(|s| s.index)
                    .into_iter()
                    .chain(state.max_seen)
                    .max()
                    .map_or(0, |n| n.saturating_add(1));
                Some(VariantCarryOver {
                    variant: if e.kind == Kind::Fmp4 { "fmp4" } else { "h264" }.into(),
                    viewers: state.viewers.iter().cloned().collect(),
                    next_index,
                    generation: e.generation + 1,
                    snapshot,
                    source_codec: source_codec(&ingest),
                    source_hdr: ingest.probe["video"]["hdr"] == true,
                })
            })
            .collect()
    }
    pub async fn resume_variants(&self, channel: &str, carried: Vec<VariantCarryOver>) {
        for carry in carried {
            if carry.viewers.is_empty() {
                continue;
            }
            let Some(ingest) = live_ingest(&self.inner, channel) else {
                continue;
            };
            if source_codec(&ingest) != carry.source_codec
                || (ingest.probe["video"]["hdr"] == true) != carry.source_hdr
            {
                continue;
            }
            let path = self
                .hdr_path(carry.variant == "h264" && carry.source_hdr)
                .await;
            let _admission = self.inner.admission.lock().await;
            if self.stopped(channel) {
                continue;
            }
            let id = format!("v-{}", carry.variant);
            if let Some(entry) = self
                .inner
                .entries
                .lock()
                .unwrap()
                .get(&key(channel, &id))
                .cloned()
            {
                entry.state.lock().unwrap().viewers.extend(carry.viewers);
                continue;
            }
            let variant = carry.variant.clone();
            let viewers = carry.viewers.clone();
            let _ = self.start_variant(channel, &variant, viewers, Some(carry), path);
        }
    }
    /// End unreferenced outputs immediately while preserving outputs still in use.
    pub async fn stop_idle(&self, channel: &str) {
        let entries: Vec<Arc<Entry>> = {
            let _admission = self.inner.admission.lock().await;
            let entries = self.inner.entries.lock().unwrap();
            entries
                .values()
                .filter(|entry| {
                    if entry.channel != channel {
                        return false;
                    }
                    let mut state = entry.state.lock().unwrap();
                    if !state.viewers.is_empty() {
                        return false;
                    }
                    state.stopping = true;
                    let _ = entry.stop.send(true);
                    true
                })
                .cloned()
                .collect()
        };
        for entry in entries {
            let mut done = entry.done.clone();
            while !*done.borrow() {
                if done.changed().await.is_err() {
                    break;
                }
            }
        }
    }
    pub async fn stop_channel(&self, channel: &str) {
        self.inner
            .stopping_channels
            .lock()
            .unwrap()
            .insert(channel.into());
        let entries: Vec<Arc<Entry>> = {
            let _admission = self.inner.admission.lock().await;
            self.inner
                .entries
                .lock()
                .unwrap()
                .values()
                .filter(|e| e.channel == channel)
                .cloned()
                .collect()
        };
        for entry in &entries {
            entry.state.lock().unwrap().stopping = true;
            let _ = entry.stop.send(true);
        }
        for entry in entries {
            let mut done = entry.done.clone();
            while !*done.borrow() {
                if done.changed().await.is_err() {
                    break;
                }
            }
        }
        self.inner.stopping_channels.lock().unwrap().remove(channel);
    }
    pub async fn stop_all(&self) {
        self.inner.shutting_down.store(true, Ordering::Release);
        let mut pending = tokio::task::JoinSet::new();
        for channel in self.channel_ids() {
            let owner = self.clone();
            pending.spawn(async move {
                owner.stop_channel(&channel).await;
            });
        }
        while pending.join_next().await.is_some() {}
        self.inner.filters.close().await;
    }
}

fn replace_segments(snapshot: &mut OutputSnapshot, segments: Vec<Arc<Segment>>, active_init: &str) {
    snapshot.segments = segments;
    if let Some(first) = snapshot.segments.first() {
        let starts = snapshot.init_uris.as_array().cloned().unwrap_or_default();
        let current = starts
            .iter()
            .rfind(|g| g["fromIndex"].as_u64().is_some_and(|n| n <= first.index))
            .and_then(|g| g["uri"].as_str())
            .map(str::to_owned);
        if let Some(current) = current {
            let retain: BTreeSet<String> = starts
                .iter()
                .filter(|g| g["fromIndex"].as_u64().is_some_and(|n| n > first.index))
                .filter_map(|g| g["uri"].as_str().map(str::to_owned))
                .chain(Some(current.clone()))
                .collect();
            snapshot
                .init_segments
                .retain(|name, _| retain.contains(name));
            // Keep one preceding generation start so the current window's
            // first segment always resolves to its exact init.
            snapshot.init_uris = json!(
                starts
                    .into_iter()
                    .filter(|g| g["uri"] == current
                        || g["fromIndex"].as_u64().is_some_and(|n| n > first.index))
                    .collect::<Vec<_>>()
            );
        }
        let pruned = snapshot
            .discontinuity_anchors
            .iter()
            .take_while(|&&n| n < first.index)
            .count();
        snapshot.discontinuity_anchors.drain(..pruned);
        snapshot.aged_out_discontinuities = snapshot
            .aged_out_discontinuities
            .saturating_add(pruned as u64);
    }
    if snapshot.segments.is_empty() {
        snapshot.init_segments.retain(|name, _| name == active_init);
        let starts = snapshot.init_uris.as_array().cloned().unwrap_or_default();
        snapshot.init_uris = json!(
            starts
                .into_iter()
                .filter(|start| start["uri"] == active_init)
                .collect::<Vec<_>>()
        );
    }
}

async fn supervise(
    inner: Arc<Inner>,
    entry: Arc<Entry>,
    mut child: Child,
    mut cancel: watch::Receiver<bool>,
    reservation: Reservation,
) {
    let mut publication = PublicationWatch::new_recursive(&entry.directory);
    let mut rings = BTreeMap::new();
    {
        let state = entry.state.lock().unwrap();
        for (id, snapshot) in &state.outputs {
            let mut ring = SegmentRing::new(LIVE_HLS_RING_CAPACITY);
            for segment in &snapshot.segments {
                ring.push((**segment).clone());
            }
            rings.insert(id.clone(), ring);
        }
    }
    let stderr_entry = entry.clone();
    let stderr = child.stderr.take().map(|mut reader| {
        tokio::spawn(async move {
            let mut buffer = [0; 4096];
            let mut diagnostics = runtime_media::DiagnosticTail::default();
            while let Ok(n) = reader.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
                diagnostics.push(&buffer[..n]);
                stderr_entry.state.lock().unwrap().stderr_tail = diagnostics.tail().to_owned();
            }
            diagnostics.finish();
            stderr_entry.state.lock().unwrap().stderr_tail = diagnostics.tail().to_owned();
        })
    });
    let mut fallback = tokio::time::interval(Duration::from_secs(1));
    let mut crashed = false;
    let mut exit_info = None;
    loop {
        if *cancel.borrow() {
            break;
        }
        if entry
            .state
            .lock()
            .unwrap()
            .grace_deadline
            .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
        {
            break;
        }
        tokio::select! {
            _ = cancel.changed() => break,
            status = child.wait() => { crashed = !status.as_ref().is_ok_and(|s| s.success()); exit_info = status.ok(); break; },
            _ = publication.changed() => {},
            _ = fallback.tick() => {},
        }
        for (id, ring) in &mut rings {
            let directory = if entry.kind == Kind::Adaptive {
                entry.directory.join(id)
            } else {
                entry.directory.clone()
            };
            let completed = runtime_media::completed_segments(
                &directory,
                if entry.kind == Kind::Fmp4 {
                    "m4s"
                } else {
                    "ts"
                },
            )
            .await;
            if completed.is_empty() {
                continue;
            }
            if entry.kind == Kind::Fmp4 {
                let name = variant_init(entry.generation);
                let already = entry.state.lock().unwrap().outputs[id]
                    .init_segments
                    .contains_key(&name);
                if !already {
                    let index = completed[0].index;
                    let bytes = match runtime_media::read_for_publication(
                        &directory.join(&name),
                        index,
                        ring,
                        &inner.media_budget,
                        |segments| {
                            let mut state = entry.state.lock().unwrap();
                            replace_segments(state.outputs.get_mut(id).unwrap(), segments, &name);
                        },
                    )
                    .await
                    {
                        Ok(bytes) => bytes,
                        Err(_) => continue,
                    };
                    entry
                        .state
                        .lock()
                        .unwrap()
                        .outputs
                        .get_mut(id)
                        .unwrap()
                        .init_segments
                        .insert(name, bytes);
                }
            }
            for completed in completed {
                if ring.published_or_retired(completed.index) {
                    continue;
                }
                ring.note_seen(completed.index);
                entry.state.lock().unwrap().max_seen = ring.max_seen;
                let data = match runtime_media::read_for_publication(
                    &completed.path,
                    completed.index,
                    ring,
                    &inner.media_budget,
                    |segments| {
                        let mut state = entry.state.lock().unwrap();
                        replace_segments(
                            state.outputs.get_mut(id).unwrap(),
                            segments,
                            &variant_init(entry.generation),
                        );
                    },
                )
                .await
                {
                    Ok(data) => data,
                    Err(error) if error == "media_memory_capacity" => break,
                    Err(_) => continue,
                };
                if !ring.push(Segment {
                    index: completed.index,
                    duration: completed.duration,
                    data,
                    created_at_ms: runtime_media::now_ms(),
                }) {
                    continue;
                }
                let mut state = entry.state.lock().unwrap();
                let snapshot = state.outputs.get_mut(id).unwrap();
                replace_segments(snapshot, ring.snapshot(), &variant_init(entry.generation));
                state.health = "healthy".into();
            }
        }
    }
    entry.state.lock().unwrap().stopping = true;
    drop(publication);
    let _ = stop_child(&mut child, false).await;
    if let Some(high) = runtime_media::highest_segment_index(
        &entry.directory,
        if entry.kind == Kind::Fmp4 {
            "m4s"
        } else {
            "ts"
        },
    )
    .await
    {
        let mut state = entry.state.lock().unwrap();
        state.max_seen = Some(state.max_seen.map_or(high, |old| old.max(high)));
    }
    if matches!(entry.kind, Kind::Fmp4 | Kind::H264)
        && let Some(high) = entry.state.lock().unwrap().max_seen
    {
        let mut stopped = inner.stopped_highwater.lock().unwrap();
        if stopped.len() >= 512 {
            stopped.pop_first();
        }
        stopped.insert(key(&entry.channel, &entry.id), (entry.generation, high));
    }
    if let Some(mut task) = stderr
        && tokio::time::timeout(Duration::from_secs(1), &mut task)
            .await
            .is_err()
    {
        task.abort();
        let _ = task.await;
    }
    if crashed {
        #[cfg(unix)]
        let signal = exit_info.as_ref().and_then(|status| {
            use std::os::unix::process::ExitStatusExt;
            status.signal().map(|s| {
                if s == libc::SIGKILL {
                    "SIGKILL".into()
                } else if s == libc::SIGTERM {
                    "SIGTERM".into()
                } else {
                    format!("SIG{s}")
                }
            })
        });
        #[cfg(not(unix))]
        let signal = None;
        if signal.as_deref() != Some("SIGTERM") {
            let tail = entry.state.lock().unwrap().stderr_tail.clone();
            report_failure(
                &inner,
                &entry.channel,
                &entry.id,
                &entry.kind,
                "crashed",
                exit_info.and_then(|s| s.code()),
                signal,
                tail,
            );
        }
    }
    if crashed && entry.hdr_tonemap.as_deref() == Some("vaapi") {
        let state = entry.state.lock().unwrap();
        let produced = produced_this_generation(state.max_seen, entry.first_index);
        if let Some((_, policy)) = inner.hdr.lock().unwrap().as_mut() {
            policy.note_failure(
                produced,
                &state.stderr_tail,
                &entry.channel,
                runtime_media::now_ms() as i64,
            );
        }
    }
    let _ = tokio::fs::remove_dir_all(&entry.directory).await;
    {
        let mut entries = inner.entries.lock().unwrap();
        let k = key(&entry.channel, &entry.id);
        if entries
            .get(&k)
            .is_some_and(|current| Arc::ptr_eq(current, &entry))
        {
            entries.remove(&k);
        }
    }
    drop(reservation);
}

/// Carried-over segments belong to the previous generation: only a segment at or
/// above this process's first index shows the hardware path produced output, so a
/// resumed variant that fails at once still counts as an early hardware failure.
fn produced_this_generation(max_seen: Option<u64>, first_index: u64) -> bool {
    max_seen.is_some_and(|seen| seen >= first_index)
}

#[allow(clippy::too_many_arguments)]
fn report_failure(
    inner: &Inner,
    channel: &str,
    id: &str,
    kind: &Kind,
    outcome: &str,
    code: Option<i32>,
    signal: Option<String>,
    stderr_tail: String,
) {
    let sink = inner.failure_sink.lock().unwrap().clone();
    if let Some(sink) = sink {
        let ingest = inner.ingest.snapshot(channel);
        sink(runtime_media::FailureEventInput {
            channel_id: channel.into(),
            source: if *kind == Kind::Adaptive {
                "adaptive-egress"
            } else {
                "egress"
            }
            .into(),
            outcome: outcome.into(),
            exit_code: code,
            signal,
            rung_id: (*kind != Kind::Adaptive).then(|| id.to_owned()),
            stderr_tail,
            probe: ingest
                .as_ref()
                .map(|s| s.probe.clone())
                .unwrap_or(Value::Null),
            decision: ingest.map(|s| s.decision).unwrap_or(Value::Null),
            // Our own encoder died or never started; never the provider's fault.
            reason: Some("encoder_failed".into()),
            ..Default::default()
        });
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    static NEXT_TEST: AtomicU64 = AtomicU64::new(0);
    fn fixture(limit: i64, hdr: bool) -> (PathBuf, OutputManager) {
        let root = std::env::temp_dir().join(format!(
            "native-outputs-{}-{}",
            std::process::id(),
            NEXT_TEST.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("encoder");
        std::fs::write(&executable, "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = '-filters' ]; then echo ' ... tonemapx V->V'; exit 0; fi; done\nexec /bin/sleep 30\n").unwrap();
        crate::test_support::seal_executable(&executable, 0o755);
        let env: Environment = std::env::vars().collect();
        let mut config = ProxyConfig::from_env(&env);
        config.ffmpeg_path = executable.to_string_lossy().into_owned();
        config.max_egress_encoders = limit;
        let ingest = Arc::new(IngestManager::new(
            config.clone(),
            env.clone(),
            root.clone(),
        ));
        ingest.publish_test("channel", 1, &[0]);
        ingest.set_test_probe(
            "channel",
            json!({"success":true,"video":{"codec":"h264","height":1080,"hdr":hdr,"bitDepth":8}}),
            json!({"videoAction":"transcode","videoEncoder":"libx264"}),
        );
        let outputs = OutputManager::new(
            ingest,
            config,
            env,
            root.clone(),
            65534,
            FeedGrants::default(),
        );
        (root, outputs)
    }
    fn rung(id: &str) -> Value {
        json!({"id":id,"height":720,"maxBitrate":2000000,"codec":"h264"})
    }
    fn options() -> Value {
        json!({"requestedMaxBitrate":2000000,"belowLadder":false,"pinned":false,"fallback":"refuse"})
    }
    #[tokio::test]
    async fn actual_children_share_capacity_and_reap_before_release() {
        let (root, outputs) = fixture(2, false);
        assert_eq!(
            outputs
                .attach_fixed("channel", &rung("720p"), "viewer1", &options())
                .await["ok"],
            true
        );
        assert_eq!(
            outputs
                .attach_fixed("channel", &rung("720p"), "viewer2", &options())
                .await["ok"],
            true
        );
        assert_eq!(outputs.capacity()["activeOutputs"], 1);
        assert_eq!(outputs.encoder_status("channel")[0]["viewers"], 2);
        let adaptive = json!({"rungs":[rung("720p"),rung("480p")],"includeOriginal":true});
        assert_eq!(
            outputs
                .attach_adaptive("channel", &adaptive, "viewer3")
                .await["refusal"],
            "capacity"
        );
        assert_eq!(outputs.capacity()["activeOutputs"], 1);
        outputs.stop_all().await;
        assert_eq!(outputs.capacity()["activeOutputs"], 0);
        assert!(!outputs.has_active("channel"));
        assert!(!root.join("channel/rung-720p").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn hdr_reservation_and_below_ladder_policy_match_reference() {
        let (root, outputs) = fixture(2, true);
        assert_eq!(
            outputs
                .attach_fixed("channel", &rung("720p"), "viewer1", &options())
                .await["ok"],
            true
        );
        assert_eq!(outputs.capacity()["activeOutputs"], 2);
        let mut below = options();
        below["belowLadder"] = json!(true);
        below["fallback"] = json!("source");
        assert_eq!(
            outputs
                .attach_fixed("channel", &rung("480p"), "viewer2", &below)
                .await["refusal"],
            "below_ladder"
        );
        let mut fallback = options();
        fallback["fallback"] = json!("source");
        assert_eq!(
            outputs
                .attach_fixed("channel", &rung("480p"), "viewer2", &fallback)
                .await["reason"],
            "capacity"
        );
        outputs.stop_all().await;
        assert_eq!(outputs.capacity()["activeOutputs"], 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn adaptive_is_one_process_with_atomic_output_reservation() {
        let (root, outputs) = fixture(2, false);
        let adaptive = json!({"rungs":[rung("720p"),rung("480p")],"includeOriginal":true});
        let result = outputs
            .attach_adaptive("channel", &adaptive, "viewer")
            .await;
        assert_eq!(result["ok"], true);
        assert_eq!(result["includesOriginal"], true);
        assert_eq!(outputs.capacity()["activeOutputs"], 2);
        assert_eq!(
            outputs.encoder_status("channel").as_array().unwrap().len(),
            1
        );
        assert!(outputs.adaptive_snapshot("channel", "original").is_some());
        outputs.stop_all().await;
        assert_eq!(outputs.capacity()["activeOutputs"], 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn spawn_failure_releases_reservation_and_emits_bounded_failure() {
        let (root, outputs) = fixture(2, false);
        // Discovery succeeds first; remove the owned executable before the encode.
        outputs.hdr_path(false).await;
        std::fs::remove_file(root.join("encoder")).unwrap();
        let failures = Arc::new(Mutex::new(Vec::new()));
        let captured = failures.clone();
        outputs.set_failure_sink(Some(Arc::new(move |event| {
            captured.lock().unwrap().push(event)
        })));
        assert_eq!(
            outputs
                .attach_fixed("channel", &rung("720p"), "viewer", &options())
                .await["refusal"],
            "internal"
        );
        assert_eq!(outputs.capacity()["activeOutputs"], 0);
        assert_eq!(failures.lock().unwrap()[0].outcome, "spawn_failed");
        outputs.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn seven_and_eight_rung_requests_reserve_complete_ladders() {
        for count in [7usize, 8] {
            let (root, outputs) = fixture(8, false);
            let rungs: Vec<Value> = (0..count).map(|n| rung(&format!("rung{n}"))).collect();
            let result = outputs
                .attach_adaptive(
                    "channel",
                    &json!({"rungs":rungs,"includeOriginal":false}),
                    "viewer",
                )
                .await;
            assert_eq!(result["ok"], true);
            assert_eq!(outputs.capacity()["activeOutputs"], count);
            outputs.stop_all().await;
            assert_eq!(outputs.capacity()["activeOutputs"], 0);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[tokio::test]
    async fn fixed_and_adaptive_namespaces_do_not_alias_valid_ids() {
        let (root, outputs) = fixture(4, false);
        assert_eq!(
            outputs
                .attach_fixed("channel", &rung("a-720p"), "fixed", &options())
                .await["ok"],
            true
        );
        assert!(outputs.snapshot("channel", "a-720p").is_some());
        assert!(outputs.adaptive_snapshot("channel", "720p").is_none());
        let request = json!({"rungs":[rung("720p"),rung("480p")],"includeOriginal":false});
        assert_eq!(
            outputs
                .attach_adaptive("channel", &request, "adaptive")
                .await["ok"],
            true
        );
        assert!(outputs.snapshot("channel", "a-720p").is_some());
        assert!(outputs.snapshot("channel", "720p").is_none());
        assert!(outputs.adaptive_snapshot("channel", "720p").is_some());
        outputs.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn reserved_original_and_compat_ids_never_share_or_collide() {
        let (root, outputs) = fixture(4, false);
        let request = json!({"rungs":[rung("original"),rung("480p")],"includeOriginal":true});
        assert_eq!(
            outputs
                .attach_adaptive("channel", &request, "adaptive")
                .await["refusal"],
            "invalid"
        );
        assert_eq!(outputs.capacity()["activeOutputs"], 0);
        assert_eq!(
            outputs.attach_variant("channel", "fmp4", "variant").await["ok"],
            true
        );
        assert_eq!(
            outputs
                .attach_fixed("channel", &rung("v-fmp4"), "fixed", &options())
                .await["refusal"],
            "invalid"
        );
        assert_eq!(
            outputs.encoder_status("channel").as_array().unwrap().len(),
            1
        );
        let safe_request = json!({"rungs":[rung("original"),rung("480p")],"includeOriginal":false});
        assert_eq!(
            outputs
                .attach_adaptive("channel", &safe_request, "adaptive")
                .await["ok"],
            true
        );
        let duplicate = json!({"rungs":[rung("same"),rung("same")],"includeOriginal":false});
        assert_eq!(
            outputs
                .attach_adaptive("channel", &duplicate, "duplicate")
                .await["refusal"],
            "invalid"
        );
        outputs.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn loopback_children_do_not_inherit_outbound_proxy_environment() {
        let (root, mut outputs) = fixture(2, false);
        {
            let inner = Arc::get_mut(&mut outputs.inner).unwrap();
            for key in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] {
                inner
                    .env
                    .insert(key.into(), "http://proxy.example:8000".into());
            }
        }
        std::fs::write(root.join("encoder"), "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = '-filters' ]; then exit 0; fi; playlist=\"$arg\"; done\n/usr/bin/env > \"${playlist%/*}/child-env.tmp\"\n/bin/mv \"${playlist%/*}/child-env.tmp\" \"${playlist%/*}/child-env\"\nexec /bin/sleep 30\n").unwrap();
        assert_eq!(
            outputs
                .attach_fixed("channel", &rung("720p"), "viewer", &options())
                .await["ok"],
            true
        );
        let path = root.join("channel/rung-720p/child-env");
        tokio::time::timeout(Duration::from_secs(1), async {
            while !path.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let environment = std::fs::read_to_string(path).unwrap();
        assert!(!environment.contains("proxy.example"));
        assert!(environment.contains("no_proxy=*"));
        assert!(environment.contains("NO_PROXY=*"));
        outputs.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn encoder_children_get_a_feed_grant_and_no_proxy_credentials() {
        let (root, mut outputs) = fixture(2, false);
        {
            let inner = Arc::get_mut(&mut outputs.inner).unwrap();
            for (key, value) in [
                ("STREAM_PROXY_SECRET", "shared-proxy-secret"),
                ("CACHE_URL", "redis://:valkey-password@cache:6379"),
                ("NVIDIA_API_KEY", "vendor-key"),
                ("LIBVA_DRIVER_NAME", "iHD"),
                ("LC_ALL", "C"),
            ] {
                inner.env.insert(key.into(), value.into());
            }
        }
        std::fs::write(root.join("encoder"), "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = '-filters' ]; then exit 0; fi; playlist=\"$arg\"; done\nprintf '%s\\n' \"$@\" > \"${playlist%/*}/child-argv\"\n/usr/bin/env > \"${playlist%/*}/child-env.tmp\"\n/bin/mv \"${playlist%/*}/child-env.tmp\" \"${playlist%/*}/child-env\"\nexec /bin/sleep 30\n").unwrap();
        assert_eq!(
            outputs
                .attach_fixed("channel", &rung("720p"), "viewer", &options())
                .await["ok"],
            true
        );
        let directory = root.join("channel/rung-720p");
        tokio::time::timeout(Duration::from_secs(1), async {
            while !directory.join("child-env").exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let environment = std::fs::read_to_string(directory.join("child-env")).unwrap();
        let argv = std::fs::read_to_string(directory.join("child-argv")).unwrap();
        for leaked in [
            "shared-proxy-secret",
            "valkey-password",
            "vendor-key",
            "CACHE_URL",
        ] {
            assert!(!environment.contains(leaked), "{leaked} in child env");
            assert!(!argv.contains(leaked), "{leaked} in child argv");
        }
        assert!(!argv.contains("-headers"));
        assert!(environment.contains("LIBVA_DRIVER_NAME=iHD"));
        assert!(environment.contains("LC_ALL=C"));
        let input =
            url::Url::parse(argv.lines().skip_while(|a| *a != "-i").nth(1).unwrap()).unwrap();
        assert_eq!(input.path(), "/streams/channel/feed.ts");
        let feed = input
            .query_pairs()
            .find(|(key, _)| key == "feed")
            .unwrap()
            .1
            .into_owned();
        assert_eq!(feed.len(), 32);
        assert!(outputs.inner.grants.allows("channel", &feed));
        assert!(!outputs.inner.grants.allows("other", &feed));
        outputs.stop_all().await;
        assert!(!outputs.inner.grants.allows("channel", &feed));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn carried_segments_do_not_count_as_hardware_output() {
        // Resumed at 10 with 0..=9 carried over: nothing new seen is an early failure.
        assert!(!produced_this_generation(Some(9), 10));
        assert!(!produced_this_generation(None, 10));
        assert!(produced_this_generation(Some(10), 10));
        assert!(produced_this_generation(Some(0), 0));
        assert!(!produced_this_generation(None, 0));
    }
    #[tokio::test]
    async fn compat_carryover_uses_final_reaped_index_and_generation_init_names() {
        let (root, outputs) = fixture(2, false);
        assert_eq!(
            outputs.attach_variant("channel", "fmp4", "viewer").await["ok"],
            true
        );
        // Simulate a fragment completed after the carry snapshot but before process reap.
        let carried = outputs.snapshot_variants("channel");
        tokio::fs::write(root.join("channel/rung-v-fmp4/segment-9.m4s"), b"complete")
            .await
            .unwrap();
        outputs.stop_channel("channel").await;
        outputs.resume_variants("channel", carried).await;
        let snapshot = outputs.snapshot("channel", "v-fmp4").unwrap();
        assert_eq!(
            snapshot.init_uris.as_array().unwrap().last().unwrap()["fromIndex"],
            10
        );
        assert_eq!(
            snapshot.init_uris.as_array().unwrap().last().unwrap()["uri"],
            "init-1.mp4"
        );
        assert_eq!(
            outputs.inner.entries.lock().unwrap()[&key("channel", "v-fmp4")].first_index,
            10
        );
        assert_eq!(outputs.capacity()["activeOutputs"], 0);
        outputs.stop_all().await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn compat_publisher_retries_after_retained_carry_releases_budget() {
        let (root, mut outputs) = fixture(2, false);
        let budget = crate::runtime_budget::MediaBudget::with_limit(20);
        Arc::get_mut(&mut outputs.inner).unwrap().media_budget = budget.clone();
        std::fs::write(root.join("encoder"), "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = '-filters' ]; then exit 0; fi; playlist=\"$arg\"; done\ndirectory=\"${playlist%/*}\"\nprintf init > \"$directory/init.mp4\"\nprintf 12345678 > \"$directory/segment-0.m4s\"\nprintf '#EXTM3U\\n#EXTINF:3,\\nsegment-0.m4s\\n' > \"$playlist.tmp\"\n/bin/mv \"$playlist.tmp\" \"$playlist\"\nwhile [ ! -f \"$directory/advance\" ]; do /bin/sleep .01; done\nprintf 1234567890abcdef > \"$directory/segment-1.m4s\"\nprintf '#EXTM3U\\n#EXTINF:3,\\nsegment-0.m4s\\n#EXTINF:3,\\nsegment-1.m4s\\n' > \"$playlist.tmp\"\n/bin/mv \"$playlist.tmp\" \"$playlist\"\nexec /bin/sleep 30\n").unwrap();
        assert_eq!(
            outputs.attach_variant("channel", "fmp4", "viewer").await["ok"],
            true
        );
        tokio::time::timeout(Duration::from_secs(3), async {
            while outputs
                .snapshot("channel", "v-fmp4")
                .unwrap()
                .segments
                .is_empty()
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let carry = outputs.snapshot_variants("channel");
        assert_eq!(budget.retained_bytes(), 12);
        tokio::fs::write(root.join("channel/rung-v-fmp4/advance"), b"go")
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let state = outputs.snapshot("channel", "v-fmp4").unwrap();
                let seen = outputs.inner.entries.lock().unwrap()[&key("channel", "v-fmp4")]
                    .state
                    .lock()
                    .unwrap()
                    .max_seen;
                if state.segments.is_empty() && seen == Some(1) {
                    break;
                }
                drop(state);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(budget.retained_bytes(), 12);
        drop(carry);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if outputs
                    .snapshot("channel", "v-fmp4")
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
        assert_eq!(budget.retained_bytes(), 20);
        outputs.stop_all().await;
        assert_eq!(budget.retained_bytes(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}

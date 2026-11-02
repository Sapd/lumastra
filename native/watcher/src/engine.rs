// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Incremental library index driven by nonrecursive native watches.
//!
//! Directory events mark a directory dirty; dirty directories are re-listed after a short
//! debounce and diffed against the index. Removals are inferred only from successful
//! listings. The main loop never calls into the filesystem itself: each root walks on its
//! own lane (`lanes`, one directory at a time in walk order, `lister` does the calls) and its
//! stability stats and watch preflights run on a second lane of that root. The main loop
//! applies the results, so a hung mount stalls only its own root.

use crate::lanes::{Done, Lane, Sink, Waker, Worker};
use crate::lister::{
    self, DirKey, DirState, Identity, InspectRequest, Inspected, ListContext, Listed, Listing,
    Target,
};
use crate::output::Output;
use crate::policy::{self, Containment, FileKind, Patterns, Rules};
use crate::probe::{self, FileId, Fingerprint, Probe, ProbeResult};
use crate::{Init, Message, PENDING_CAPACITY, Status};
use notify::event::{AccessKind, AccessMode, ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::cell::Cell;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet, VecDeque};
use std::fs;
use std::io;
use std::mem;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_millis(250);
const ROOT_CHECK_DELAY: Duration = Duration::from_millis(50);
const STAT_BATCH: usize = 256;
/// Stability stats in flight per root.
const STAT_QUEUE: usize = 256;
const RETRY_MIN: Duration = Duration::from_secs(5);
const RETRY_MAX: Duration = Duration::from_secs(300);
const WATCH_LIMIT_RETRY: Duration = Duration::from_secs(300);
const STATUS_INTERVAL: Duration = Duration::from_secs(5);
const MAX_DIRTY_NAMES: usize = 256;
const FAILED_SAMPLE: usize = 5;
/// A lane with work but no returned filesystem call for twice `aliveMs` (within these
/// bounds) is stalled: a hung mount.
const STALL_MIN: Duration = Duration::from_secs(1);
const STALL_MAX: Duration = Duration::from_secs(30);
/// A parent's lstat of a new directory is used for its watch registration only this soon.
const FRESH_FOR: Duration = Duration::from_secs(1);
/// A root that stalls again soon after recovering is not reported again within this time.
const STALL_REPORT_EVERY: Duration = Duration::from_secs(300);
/// How long the initial walk waits per round for lane results (it sends `alive` between).
const RESULT_POLL: Duration = Duration::from_millis(100);
const COALESCE_CAPACITY: usize = 4096;
const AUX_WATCH_MAX: usize = 4096;
const CONTAINMENT_REFRESH: Duration = Duration::from_secs(60);

/// What the main loop receives: filesystem events, and wake-ups when a lane finished work.
pub enum Raw {
    Fs(notify::Result<Event>),
    Wake,
}

#[derive(Debug)]
pub enum WatchError {
    /// ENOSPC / notify `MaxFilesWatch`: the inotify watch limit is exhausted.
    Limit,
    NotFound,
    Other(String),
}

pub trait WatchBackend {
    fn watch(&mut self, path: &Path) -> Result<(), WatchError>;
    fn unwatch(&mut self, path: &Path);
}

impl WatchBackend for RecommendedWatcher {
    fn watch(&mut self, path: &Path) -> Result<(), WatchError> {
        Watcher::watch(self, path, RecursiveMode::NonRecursive).map_err(|error| match &error.kind {
            notify::ErrorKind::MaxFilesWatch => WatchError::Limit,
            notify::ErrorKind::PathNotFound => WatchError::NotFound,
            notify::ErrorKind::Io(err) if err.raw_os_error() == Some(28) => WatchError::Limit,
            notify::ErrorKind::Io(err) if err.kind() == io::ErrorKind::NotFound => {
                WatchError::NotFound
            }
            _ => WatchError::Other(error.to_string()),
        })
    }

    fn unwatch(&mut self, path: &Path) {
        // Already removed by the backend itself (rename/delete) is the common case here.
        let _ = Watcher::unwatch(self, path);
    }
}

/// For `--snapshot`, which never observes changes.
pub struct NullBackend;

impl WatchBackend for NullBackend {
    fn watch(&mut self, _: &Path) -> Result<(), WatchError> {
        Ok(())
    }
    fn unwatch(&mut self, _: &Path) {}
}

/// Repeated data writes to one path while an earlier one is still queued carry no news:
/// the queued one already schedules a stability check, which samples the file later.
pub struct ModifyCoalescer {
    paths: Mutex<HashSet<PathBuf>>,
}

impl ModifyCoalescer {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            paths: Mutex::new(HashSet::new()),
        })
    }

    fn data_path(event: &Event) -> Option<&PathBuf> {
        match (event.kind, event.paths.as_slice()) {
            (EventKind::Modify(ModifyKind::Data(_)), [path]) => Some(path),
            _ => None,
        }
    }

    fn admit(&self, event: &Event) -> bool {
        let Some(path) = Self::data_path(event) else {
            return true;
        };
        let mut paths = self.paths.lock().unwrap_or_else(PoisonError::into_inner);
        if paths.contains(path) {
            return false;
        }
        if paths.len() < COALESCE_CAPACITY {
            paths.insert(path.clone());
        }
        true
    }

    /// Called by the consumer before handling an event (and when queueing failed).
    pub fn release(&self, raw: &Raw) {
        if let Raw::Fs(Ok(event)) = raw
            && let Some(path) = Self::data_path(event)
        {
            self.paths
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(path);
        }
    }
}

fn offer_raw(
    sender: &mpsc::SyncSender<Raw>,
    overflow: &AtomicBool,
    coalescer: &ModifyCoalescer,
    event: notify::Result<Event>,
) {
    if let Ok(event) = &event {
        // Opens and closes (including our own reads) would only crowd the bounded queue;
        // writes are already reported as data modifications.
        if matches!(event.kind, EventKind::Access(_)) || !coalescer.admit(event) {
            return;
        }
    }
    if let Err(error) = sender.try_send(Raw::Fs(event)) {
        let raw = match error {
            mpsc::TrySendError::Full(raw) | mpsc::TrySendError::Disconnected(raw) => raw,
        };
        coalescer.release(&raw);
        overflow.store(true, Ordering::Release);
    }
}

pub fn make_watcher(
    sender: mpsc::SyncSender<Raw>,
    overflow: Arc<AtomicBool>,
    coalescer: Arc<ModifyCoalescer>,
) -> notify::Result<RecommendedWatcher> {
    notify::recommended_watcher(move |event| {
        offer_raw(&sender, &overflow, &coalescer, event);
    })
}

/// Wakes the main loop through the raw queue. A full queue needs no wake: the loop is busy.
pub fn raw_waker(sender: mpsc::SyncSender<Raw>) -> Waker {
    Arc::new(move || sender.try_send(Raw::Wake).is_ok())
}

/// Size the budget for watches on symlink-target directories outside the library, so they
/// can never exhaust inotify: a tenth of `max_user_watches`, at most 4096.
fn aux_watch_cap() -> usize {
    fs::read_to_string("/proc/sys/fs/inotify/max_user_watches")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .map_or(AUX_WATCH_MAX, |max| (max / 10).clamp(16, AUX_WATCH_MAX))
}

type Id = (usize, PathBuf);

fn name_of(path: &Path) -> Option<&str> {
    path.file_name().and_then(|n| n.to_str())
}

struct DirNode {
    canonical: PathBuf,
    key: DirKey,
    symlink: bool,
    inherited: Patterns,
    patterns: Patterns,
    /// This directory's own ignore lines and empty-marker flag, None before the first read.
    local: Option<(Vec<String>, bool)>,
    /// An empty `.ignore` marker: watched (so its removal is seen) but without children.
    excluded: bool,
    files: HashSet<String>,
    subdirs: HashSet<String>,
    non_utf8: u64,
    refused: u64,
    /// Real paths of symlinked ignore files read by this directory.
    ignore_links: Vec<PathBuf>,
}

struct FileState {
    fingerprint: Fingerprint,
    target: Option<PathBuf>,
    /// `Engine::recorded` when this state was recorded.
    recorded: u64,
}

struct Pending {
    kind: FileKind,
    observed: Option<Fingerprint>,
    stable_since: Instant,
    ticket: u64,
    in_flight: bool,
}

/// What a dirty directory needs: `names` that changed, every entry (`all`), the whole
/// subtree (`recursive`), or only a root identity check (`list == false`).
#[derive(Clone, Default)]
struct Mark {
    recursive: bool,
    all: bool,
    list: bool,
    names: HashSet<String>,
}

impl Mark {
    fn verify() -> Self {
        Self::default()
    }
    fn list() -> Self {
        Self {
            list: true,
            ..Self::default()
        }
    }
    fn name(name: &str) -> Self {
        let mut mark = Self::list();
        mark.names.insert(name.to_string());
        mark
    }
    fn all() -> Self {
        Self {
            all: true,
            list: true,
            ..Self::default()
        }
    }
    fn full() -> Self {
        Self {
            recursive: true,
            all: true,
            list: true,
            names: HashSet::new(),
        }
    }
    fn merge(&mut self, other: Mark) {
        self.recursive |= other.recursive;
        self.all |= other.all;
        self.list |= other.list;
        if self.all || self.names.len() + other.names.len() > MAX_DIRTY_NAMES {
            self.all = true;
            self.names.clear();
        } else {
            self.names.extend(other.names);
        }
    }
}

/// A directory whose listing failed (unreadable, ignore file refused, empty mount point).
struct Failure {
    reason: String,
    permission: bool,
    backoff: Duration,
    next: Instant,
}

/// Entries of a listed directory that could not be inspected (dangling symlinks, stat
/// errors): their prior state is kept and only these names are re-checked.
struct NameRetry {
    names: HashSet<String>,
    backoff: Duration,
    next: Instant,
}

#[derive(Default)]
struct Refs {
    dirs: HashSet<Id>,
    /// Symlinked files/directories whose targets live directly in this directory.
    aux: HashSet<Id>,
    /// Roots whose nearest existing ancestor this is.
    roots: HashSet<usize>,
}

impl Refs {
    fn is_empty(&self) -> bool {
        self.dirs.is_empty() && self.aux.is_empty() && self.roots.is_empty()
    }
}

struct RootState {
    logical: PathBuf,
    canonical: Option<PathBuf>,
    extras: Arc<Vec<PathBuf>>,
    visited: HashMap<DirKey, PathBuf>,
    network: bool,
    next_network: Option<Instant>,
    sentinel: Option<PathBuf>,
    marker_warned: bool,
    non_utf8: u64,
    warned_non_utf8: u64,
    refused: u64,
    /// Until the first complete walk: files are recorded without events.
    initial: bool,
}

enum Work {
    Existing {
        id: Id,
        mark: Mark,
        inherited: Option<Patterns>,
        /// Registration of a missing watch was attempted after a fresh identity check.
        watch_checked: bool,
    },
    New {
        id: Id,
        canonical: PathBuf,
        key: DirKey,
        symlink: bool,
        inherited: Patterns,
        /// The directory that first claimed this identity was checked and lost it.
        owner_dead: bool,
        /// When the parent's listing lstat'ed it.
        seen: Instant,
    },
}

/// The lane job a root's walk is waiting for.
enum Step {
    Inspect {
        id: Id,
        mark: Mark,
        /// Identity only, then register the missing watch, then list.
        watch_first: bool,
    },
    Owner {
        work: Work,
        owner: Id,
    },
}

/// Per-root filesystem work. The walk runs one directory at a time on `walk` (pre-order,
/// like the scanner); stability stats, watch preflights and the root's containment real
/// path run on `stat`.
struct Shard {
    walk: Lane,
    stat: Lane,
    probes: usize,
    preflights: usize,
    /// Queued reconciliations, run one after another in arrival order.
    jobs: VecDeque<Id>,
    job_marks: HashMap<Id, Mark>,
    /// The running reconciliation's remaining directories.
    stack: Vec<Work>,
    flight: Option<Step>,
    /// `Engine::recorded` when the running inspection was sent.
    sent_at: u64,
    /// The first (initial) reconciliation has started.
    initial_started: bool,
    stalled: bool,
    probe_stalled: bool,
    /// The stall was reported in an `error` frame.
    reported: bool,
    last_report: Option<Instant>,
}

impl Shard {
    fn new(r: usize) -> Self {
        Self {
            walk: Lane::new(format!("watcher-walk-{r}")),
            stat: Lane::new(format!("watcher-stat-{r}")),
            probes: 0,
            preflights: 0,
            jobs: VecDeque::new(),
            job_marks: HashMap::new(),
            stack: Vec::new(),
            flight: None,
            sent_at: 0,
            initial_started: false,
            stalled: false,
            probe_stalled: false,
            reported: false,
            last_report: None,
        }
    }

    fn walking(&self) -> bool {
        self.flight.is_some() || !self.stack.is_empty() || !self.jobs.is_empty()
    }
}

/// Containment roots and sensitive prefixes with whatever real paths are resolved so far.
/// A library root's real path is resolved on that root's stat lane, everything else on a
/// shared lane (sensitive prefixes first).
struct Resolution {
    roots: Vec<PathBuf>,
    sensitive: Vec<PathBuf>,
    /// The library root a containment root is, if any.
    root_lane: Vec<Option<usize>>,
    real_roots: Vec<Option<Option<PathBuf>>>,
    real_sensitive: Vec<Option<Option<PathBuf>>>,
    /// Resolutions in flight per slot: a hung path is not asked again, the others are.
    busy_roots: Vec<bool>,
    busy_sensitive: Vec<bool>,
    lane: Lane,
    outstanding: usize,
    stalled: bool,
    reported: bool,
}

impl Resolution {
    fn containment(&self) -> Containment {
        fn forms(paths: &[PathBuf], real: &[Option<Option<PathBuf>>]) -> Vec<PathBuf> {
            let mut out = Vec::new();
            for (path, real) in paths.iter().zip(real) {
                if path.as_os_str().is_empty() {
                    continue;
                }
                let lexical = policy::normalize(path);
                if !out.contains(&lexical) {
                    out.push(lexical);
                }
                if let Some(Some(real)) = real
                    && !out.contains(real)
                {
                    out.push(real.clone());
                }
            }
            out
        }
        Containment::from_forms(
            forms(&self.roots, &self.real_roots),
            forms(&self.sensitive, &self.real_sensitive),
            self.real_sensitive.iter().any(Option::is_none),
        )
    }
}

#[derive(Clone, PartialEq, Eq)]
struct StatusSig {
    partial: bool,
    watch_limit: bool,
    failed: usize,
    sample: Vec<PathBuf>,
    unwatched: usize,
    stalled: bool,
    stalled_roots: Vec<usize>,
}

pub struct Engine<B: WatchBackend> {
    rules: Arc<Rules>,
    containment: Arc<Containment>,
    resolution: Resolution,
    containment_next: Instant,
    stability: Duration,
    poll: Duration,
    alive_every: Duration,
    stall_after: Duration,
    network_every: Option<Duration>,
    roots: Vec<RootState>,
    dirs: BTreeMap<Id, DirNode>,
    files: HashMap<FileId, FileState>,
    pending: HashMap<FileId, Pending>,
    pending_queue: BinaryHeap<Reverse<(Instant, u64, FileId)>>,
    next_ticket: u64,
    /// Counts recorded file states; a listing removes only files recorded before it was sent.
    recorded: u64,
    sink: Sink,
    results: mpsc::Receiver<Done>,
    shards: Vec<Shard>,
    dirty: HashMap<Id, (Instant, Mark)>,
    dirty_queue: BinaryHeap<Reverse<(Instant, Id)>>,
    failures: BTreeMap<Id, Failure>,
    name_retries: HashMap<Id, NameRetry>,
    retry_queue: BinaryHeap<Reverse<(Instant, Id)>>,
    newly_failed: Vec<Id>,
    failure_notice_due: Option<Instant>,
    failure_notice_backoff: Duration,
    last_failure_notice: Option<Instant>,
    stall_rescan: bool,
    stall_rescan_due: Option<Instant>,
    stall_rescan_backoff: Duration,
    last_stall_rescan: Option<Instant>,
    refs: HashMap<PathBuf, Refs>,
    watched: BTreeMap<PathBuf, DirKey>,
    by_identity: HashMap<DirKey, HashSet<PathBuf>>,
    watch_dirty: HashSet<PathBuf>,
    force_rewatch: HashSet<PathBuf>,
    /// Identities a lane observed since the last registration pass: only these paths are
    /// registered directly; every other registration is stat'ed on a lane first.
    fresh: HashMap<PathBuf, DirKey>,
    preflight: HashSet<PathBuf>,
    unwatched: HashSet<PathBuf>,
    unwatched_due: Option<Instant>,
    unwatched_backoff: Duration,
    aux_cap: usize,
    aux_watched: HashSet<PathBuf>,
    aux_capped: HashSet<PathBuf>,
    watch_limit: Option<Instant>,
    limit_notice: bool,
    limit_retrying: bool,
    file_routes: HashMap<PathBuf, HashSet<FileId>>,
    link_targets: HashMap<PathBuf, HashSet<Id>>,
    ignore_targets: HashMap<PathBuf, HashSet<Id>>,
    pub(crate) backend: B,
    output: Output,
    full_due: Option<Instant>,
    full_backoff: Duration,
    last_full: Option<Instant>,
    rewatch_on_full: bool,
    recover_due: Option<Instant>,
    recover_backoff: Duration,
    last_recover: Option<Instant>,
    status_sig: Option<StatusSig>,
    status_sent: Option<Instant>,
    status_pending: bool,
    alive_next: Cell<Instant>,
    alive_seq: Cell<u64>,
    shutdown: Option<Arc<AtomicBool>>,
    ready: bool,
    fatal: Option<String>,
}

fn root_extras(logical: &Path, canonical: Option<&Path>) -> Arc<Vec<PathBuf>> {
    let mut extras = vec![policy::normalize(logical)];
    if let Some(canonical) = canonical
        && !extras.iter().any(|e| e == canonical)
    {
        extras.push(canonical.to_path_buf());
    }
    Arc::new(extras)
}

/// Exponential backoff for storms: double while requests keep arriving within twice the
/// current interval, otherwise start again at the minimum.
fn next_backoff(last: Option<Instant>, backoff: &mut Duration, now: Instant) -> Instant {
    let mut due = now + DEBOUNCE;
    if let Some(last) = last {
        if now.duration_since(last) < *backoff * 2 {
            *backoff = (*backoff * 2).min(RETRY_MAX);
        } else {
            *backoff = RETRY_MIN;
        }
        due = due.max(last + *backoff);
    }
    due
}

impl<B: WatchBackend> Engine<B> {
    pub fn new(init: Init, backend: B, output: Output) -> io::Result<Self> {
        let rules = Arc::new(Rules::new(&init.policy));
        let containment_roots: Vec<PathBuf> = init
            .policy
            .containment_roots
            .iter()
            .chain(&init.paths)
            .cloned()
            .collect();
        let sensitive = init.policy.sensitive_prefixes.clone();
        let root_lane = containment_roots
            .iter()
            .map(|path| {
                let path = policy::normalize(path);
                init.paths
                    .iter()
                    .position(|root| policy::normalize(root) == path)
            })
            .collect();
        let resolution = Resolution {
            real_roots: vec![None; containment_roots.len()],
            real_sensitive: vec![None; sensitive.len()],
            busy_roots: vec![false; containment_roots.len()],
            busy_sensitive: vec![false; sensitive.len()],
            roots: containment_roots,
            sensitive,
            root_lane,
            lane: Lane::new("watcher-resolve".into()),
            outstanding: 0,
            stalled: false,
            reported: false,
        };
        let containment = Arc::new(resolution.containment());
        let (sink, results) = Sink::new();
        let now = Instant::now();
        let alive_every = Duration::from_millis(init.alive_ms);
        let network_every = (init.network_reconcile_secs > 0)
            .then(|| Duration::from_secs(init.network_reconcile_secs));
        let roots: Vec<RootState> = init
            .paths
            .iter()
            .map(|logical| {
                let network = init.network_paths.contains(logical);
                RootState {
                    logical: logical.clone(),
                    canonical: None,
                    // The real form joins once the root's lane resolved it.
                    extras: root_extras(logical, None),
                    visited: HashMap::new(),
                    network,
                    next_network: network_every.filter(|_| network).map(|every| now + every),
                    sentinel: None,
                    marker_warned: false,
                    non_utf8: 0,
                    warned_non_utf8: 0,
                    refused: 0,
                    initial: false,
                }
            })
            .collect();
        let shards = (0..roots.len()).map(Shard::new).collect();
        Ok(Self {
            rules,
            containment,
            resolution,
            containment_next: now + CONTAINMENT_REFRESH,
            stability: Duration::from_millis(init.stability_ms),
            poll: Duration::from_millis(init.poll_ms),
            alive_every,
            stall_after: (alive_every * 2).clamp(STALL_MIN, STALL_MAX),
            network_every,
            roots,
            dirs: BTreeMap::new(),
            files: HashMap::new(),
            pending: HashMap::new(),
            pending_queue: BinaryHeap::new(),
            next_ticket: 0,
            recorded: 0,
            sink,
            results,
            shards,
            dirty: HashMap::new(),
            dirty_queue: BinaryHeap::new(),
            failures: BTreeMap::new(),
            name_retries: HashMap::new(),
            retry_queue: BinaryHeap::new(),
            newly_failed: Vec::new(),
            failure_notice_due: None,
            failure_notice_backoff: RETRY_MIN,
            last_failure_notice: None,
            stall_rescan: false,
            stall_rescan_due: None,
            stall_rescan_backoff: RETRY_MIN,
            last_stall_rescan: None,
            refs: HashMap::new(),
            watched: BTreeMap::new(),
            by_identity: HashMap::new(),
            watch_dirty: HashSet::new(),
            force_rewatch: HashSet::new(),
            fresh: HashMap::new(),
            preflight: HashSet::new(),
            unwatched: HashSet::new(),
            unwatched_due: None,
            unwatched_backoff: RETRY_MIN,
            aux_cap: aux_watch_cap(),
            aux_watched: HashSet::new(),
            aux_capped: HashSet::new(),
            watch_limit: None,
            limit_notice: false,
            limit_retrying: false,
            file_routes: HashMap::new(),
            link_targets: HashMap::new(),
            ignore_targets: HashMap::new(),
            backend,
            output,
            full_due: None,
            full_backoff: RETRY_MIN,
            last_full: None,
            rewatch_on_full: false,
            recover_due: None,
            recover_backoff: RETRY_MIN,
            last_recover: None,
            status_sig: None,
            status_sent: None,
            status_pending: false,
            alive_next: Cell::new(now + alive_every),
            alive_seq: Cell::new(0),
            shutdown: None,
            ready: false,
            fatal: None,
        })
    }

    /// How lanes wake the main loop; set before the initial walk starts the lanes.
    pub fn set_waker(&mut self, waker: Waker) {
        self.sink.set_waker(waker);
    }

    /// Initial registration: records the current files without emitting events. Returns
    /// when every root finished its walk or is stalled; a stalled root finishes later, still
    /// without events.
    pub fn initial_walk(&mut self) {
        self.walk_initial(false);
    }

    /// For `--snapshot`: waits for every root, however long its filesystem takes.
    pub fn initial_walk_complete(&mut self) {
        self.walk_initial(true);
    }

    fn walk_initial(&mut self, complete: bool) {
        let start = Instant::now();
        self.request_containment();
        // Symlinks are judged against the real containment paths: give them a moment.
        while self.resolution.outstanding > 0 && !self.stopping() && self.fatal.is_none() {
            if !complete && start.elapsed() >= self.stall_after {
                break;
            }
            self.wait_results(RESULT_POLL);
            self.heartbeat();
        }
        for r in 0..self.roots.len() {
            self.roots[r].initial = true;
            let id = (r, self.roots[r].logical.clone());
            self.enqueue(id, Mark::full());
        }
        loop {
            if self.stopping() {
                self.sink.stop();
                break;
            }
            self.pump_all();
            self.sync_watches();
            if self.fatal.is_some() {
                break;
            }
            let mut walking = false;
            let mut waiting = false;
            // Ready means walked and registered: wait for the watch preflights too.
            for shard in &self.shards {
                if shard.walking() || shard.preflights > 0 {
                    walking = true;
                    waiting |= complete
                        || !(shard.walk.stalled(&self.sink, self.stall_after)
                            || shard.stat.stalled(&self.sink, self.stall_after));
                }
            }
            if !walking || !waiting {
                break;
            }
            self.wait_results(RESULT_POLL);
            self.heartbeat();
        }
        self.sync_watches();
        self.check_stall(Instant::now());
    }

    /// Called once `ready` is queued: start `alive`, report coverage and initial problems.
    pub fn after_ready(&mut self) {
        self.ready = true;
        let now = Instant::now();
        self.flush_notices(now, false);
        self.check_stall(now);
        self.status_pending = true;
        self.maybe_status(now);
    }

    /// Long walks stop early once the control thread asks for shutdown.
    pub fn set_shutdown(&mut self, shutdown: Arc<AtomicBool>) {
        self.shutdown = Some(shutdown);
    }

    fn stopping(&self) -> bool {
        self.shutdown
            .as_ref()
            .is_some_and(|s| s.load(Ordering::Acquire))
    }

    pub fn has_watches(&self) -> bool {
        !self.watched.is_empty()
    }

    /// No lane work outstanding and no walk queued (tests).
    #[cfg(test)]
    fn idle(&self) -> bool {
        self.resolution.outstanding == 0
            && self
                .shards
                .iter()
                .all(|s| !s.walking() && !s.walk.busy() && !s.stat.busy())
    }

    /// Roots whose filesystem calls have not returned within the stall deadline.
    pub fn stalled_roots(&self) -> usize {
        self.shards.iter().filter(|s| s.stalled).count()
    }

    /// The `watch_limit` error text when the kernel limit stopped registration.
    pub fn watch_limit_message(&self) -> Option<String> {
        self.watch_limit.map(|_| {
            let (watched, wanted) = self.watch_counts();
            format!("raise fs.inotify.max_user_watches; {watched}/{wanted} dirs watched")
        })
    }

    pub fn fatal(&self) -> Option<&str> {
        self.fatal.as_deref()
    }

    /// Every eligible path in the index, sorted (for `--snapshot`).
    pub fn snapshot(&self) -> Vec<String> {
        let mut ids: Vec<&FileId> = self.files.keys().collect();
        ids.sort();
        ids.into_iter()
            .filter_map(|(_, path)| path.to_str().map(str::to_string))
            .collect()
    }

    pub fn handle(&mut self, event: notify::Result<Event>) {
        match event {
            Ok(event) => self.event(event),
            Err(error) => self.backend_error(error),
        }
    }

    pub fn event(&mut self, event: Event) {
        if event.need_rescan() {
            // The kernel dropped events, possibly the rename/delete that removed a watch.
            self.request_full_rescan("kernel event queue overflow", true);
            return;
        }
        let kind = event.kind;
        if let EventKind::Access(access) = kind
            && !matches!(access, AccessKind::Close(AccessMode::Write))
        {
            return;
        }
        // notify's inotify backend drops the watch (and every watch below it) itself on
        // DELETE/DELETE_SELF and on MOVED_FROM, which is the only rename half with a tracker.
        let dropped = matches!(kind, EventKind::Remove(_))
            || (matches!(kind, EventKind::Modify(ModifyKind::Name(RenameMode::From)))
                && event.tracker().is_some());
        for path in &event.paths {
            let aliases = self.aliases(path);
            if dropped {
                self.backend_dropped(path);
            }
            self.route(path, kind);
            for alias in aliases {
                self.route(&alias, kind);
            }
        }
    }

    /// notify keeps one path per inotify wd: a directory watched under several paths (bind
    /// mounts) reports under one of them only. Fan the event out to the others.
    fn aliases(&self, path: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Some(key) = self.watched.get(path)
            && let Some(paths) = self.by_identity.get(key)
        {
            out.extend(paths.iter().filter(|p| p.as_path() != path).cloned());
        }
        if let (Some(parent), Some(name)) = (path.parent(), path.file_name())
            && let Some(key) = self.watched.get(parent)
            && let Some(paths) = self.by_identity.get(key)
        {
            out.extend(
                paths
                    .iter()
                    .filter(|p| p.as_path() != parent)
                    .map(|p| p.join(name)),
            );
        }
        out
    }

    pub fn backend_error(&mut self, error: notify::Error) {
        if matches!(error.kind, notify::ErrorKind::MaxFilesWatch) {
            self.enter_watch_limit();
            return;
        }
        if self.recover_due.is_some() {
            return;
        }
        let now = Instant::now();
        self.recover_due = Some(next_backoff(
            self.last_recover,
            &mut self.recover_backoff,
            now,
        ));
        if self.ready {
            self.output.send(Message::Error {
                message: format!("filesystem watch backend error: {error}"),
                fatal: false,
                code: Some("backend"),
            });
            self.output.send(Message::Rescan {
                reason: "filesystem watch backend error".into(),
            });
        }
    }

    /// Observation was lost (raw queue overflow, kernel rescan flag, pending overflow).
    /// `rewatch` also re-registers every watch: lost events may include the rename or delete
    /// that made the backend drop one, so `watched` can no longer be trusted.
    pub fn request_full_rescan(&mut self, reason: &str, rewatch: bool) {
        self.rewatch_on_full |= rewatch;
        if self.full_due.is_some() {
            return;
        }
        let now = Instant::now();
        self.full_due = Some(next_backoff(self.last_full, &mut self.full_backoff, now));
        if self.ready {
            self.output.send(Message::Rescan {
                reason: reason.into(),
            });
        }
    }

    pub fn tick(&mut self, now: Instant) {
        if self.stopping() {
            self.sink.stop();
        }
        self.drain_results(now);
        self.process_retries(now);
        self.process_network(now);
        self.process_full(now);
        self.process_recover(now);
        self.process_watch_limit(now);
        self.process_unwatched(now);
        self.refresh_containment(now);
        self.process_dirty(now);
        self.pump_all();
        self.sync_watches();
        if self.ready {
            self.flush_notices(now, true);
        }
        self.dispatch_probes(now);
        self.check_stall(now);
        self.heartbeat();
        self.maybe_status(now);
    }

    // ------------------------------------------------------------------ lane results

    fn drain_results(&mut self, now: Instant) {
        if self.sink.panicked() {
            self.fatal
                .get_or_insert_with(|| "a filesystem worker failed".into());
        }
        self.sink.rearm();
        while let Ok(done) = self.results.try_recv() {
            self.apply_done(done, now);
        }
    }

    /// Waits on the results directly. It does not re-arm the wake: nothing reads the raw
    /// queue here (the initial walk), so wakes would only crowd out filesystem events.
    fn wait_results(&mut self, timeout: Duration) {
        if self.sink.panicked() {
            self.fatal
                .get_or_insert_with(|| "a filesystem worker failed".into());
        }
        if let Ok(done) = self.results.recv_timeout(timeout) {
            let now = Instant::now();
            self.apply_done(done, now);
            while let Ok(done) = self.results.try_recv() {
                self.apply_done(done, now);
            }
        }
    }

    fn apply_done(&mut self, done: Done, now: Instant) {
        match done {
            Done::Inspect { root, inspected } => {
                self.shards[root].walk.done();
                if let Some(Step::Inspect {
                    id,
                    mark,
                    watch_first,
                }) = self.shards[root].flight.take()
                {
                    self.finish_inspect(id, mark, watch_first, inspected);
                }
            }
            Done::Owner { root, live } => {
                self.shards[root].walk.done();
                let Some(Step::Owner { work, owner }) = self.shards[root].flight.take() else {
                    return;
                };
                if live {
                    // The same directory through another path (symlink loop or alias).
                    return;
                }
                self.mark_up(&owner);
                if let Work::New {
                    id,
                    canonical,
                    key,
                    symlink,
                    inherited,
                    seen,
                    ..
                } = work
                {
                    self.start(Work::New {
                        id,
                        canonical,
                        key,
                        symlink,
                        inherited,
                        owner_dead: true,
                        seen,
                    });
                }
            }
            Done::Probe(result) => {
                let shard = &mut self.shards[result.id.0];
                shard.stat.done();
                shard.probes = shard.probes.saturating_sub(1);
                self.apply_probe(result, now);
            }
            Done::Preflight { root, path, key } => {
                self.shards[root].stat.done();
                self.shards[root].preflights = self.shards[root].preflights.saturating_sub(1);
                self.preflight.remove(&path);
                if self.wanted(&path) && !self.watched.contains_key(&path) {
                    match key {
                        Some(key) => self.try_watch(path, key),
                        None => {
                            self.unwatched.insert(path);
                        }
                    }
                }
            }
            Done::Resolved {
                lane,
                sensitive,
                index,
                real,
            } => {
                match lane {
                    Some(r) => self.shards[r].stat.done(),
                    None => self.resolution.lane.done(),
                }
                self.resolution.outstanding = self.resolution.outstanding.saturating_sub(1);
                let (slot, busy) = if sensitive {
                    (
                        &mut self.resolution.real_sensitive[index],
                        &mut self.resolution.busy_sensitive[index],
                    )
                } else {
                    (
                        &mut self.resolution.real_roots[index],
                        &mut self.resolution.busy_roots[index],
                    )
                };
                *busy = false;
                if slot.as_ref() != Some(&real) {
                    *slot = Some(real);
                    self.containment = Arc::new(self.resolution.containment());
                    self.recheck_refused();
                }
            }
        }
    }

    // ----------------------------------------------------------------- containment

    /// Re-resolve containment roots and sensitive prefixes (late mounts, new symlinks).
    fn refresh_containment(&mut self, now: Instant) {
        if now < self.containment_next {
            return;
        }
        self.containment_next = now + CONTAINMENT_REFRESH;
        self.request_containment();
    }

    /// One job per path; a resolution still running (a hung path) is not doubled.
    fn request_containment(&mut self) {
        for index in 0..self.resolution.sensitive.len() {
            if !self.resolution.busy_sensitive[index] {
                let path = self.resolution.sensitive[index].clone();
                self.submit_resolve(None, true, index, path);
            }
        }
        for index in 0..self.resolution.roots.len() {
            if !self.resolution.busy_roots[index] {
                let path = self.resolution.roots[index].clone();
                let lane = self.resolution.root_lane[index];
                self.submit_resolve(lane, false, index, path);
            }
        }
    }

    /// Containment changed after listings were judged by the old one: links refused then
    /// may be allowed now, so the roots that refused some are listed again.
    fn recheck_refused(&mut self) {
        for r in 0..self.roots.len() {
            if self.roots[r].refused > 0 {
                let id = (r, self.roots[r].logical.clone());
                self.mark_dirty(id, Mark::full(), DEBOUNCE);
            }
        }
    }

    fn submit_resolve(
        &mut self,
        lane: Option<usize>,
        sensitive: bool,
        index: usize,
        path: PathBuf,
    ) {
        let job = move |worker: &Worker| {
            worker.enter(&path);
            Done::Resolved {
                lane,
                sensitive,
                index,
                real: fs::canonicalize(&path).ok(),
            }
        };
        let submitted = match lane {
            Some(r) => self.shards[r].stat.submit(&self.sink, job),
            None => self.resolution.lane.submit(&self.sink, job),
        };
        match submitted {
            Ok(()) => {
                self.resolution.outstanding += 1;
                if sensitive {
                    self.resolution.busy_sensitive[index] = true;
                } else {
                    self.resolution.busy_roots[index] = true;
                }
            }
            Err(error) => self.lane_failed(&error),
        }
    }

    fn lane_failed(&mut self, error: &io::Error) {
        self.fatal
            .get_or_insert_with(|| format!("cannot run filesystem worker: {error}"));
    }

    // ----------------------------------------------------------------- event routing

    fn is_root(&self, id: &Id) -> bool {
        id.1 == self.roots[id.0].logical
    }

    fn route(&mut self, path: &Path, kind: EventKind) {
        if let Some(refs) = self.refs.get(path) {
            let dirs: Vec<Id> = refs.dirs.iter().cloned().collect();
            let roots: Vec<usize> = refs.roots.iter().copied().collect();
            for id in dirs {
                self.dir_self_event(&id, kind);
            }
            for r in roots {
                self.mark_root(r);
            }
        }
        if let Some(parent) = path.parent()
            && let Some(refs) = self.refs.get(parent)
        {
            let dirs: Vec<Id> = refs.dirs.iter().cloned().collect();
            let roots: Vec<usize> = refs.roots.iter().copied().collect();
            let name = name_of(path);
            for id in dirs {
                self.entry_event(&id, name, kind);
            }
            for r in roots {
                self.mark_root(r);
            }
        }
        if let Some(links) = self.file_routes.get(path) {
            for id in links.clone() {
                self.probe_file(id);
            }
        }
        if let Some(links) = self.link_targets.get(path) {
            for id in links.clone() {
                self.mark_up(&id);
            }
        }
        if let Some(dirs) = self.ignore_targets.get(path) {
            for id in dirs.clone() {
                self.mark_dirty(id, Mark::list(), DEBOUNCE);
            }
        }
    }

    fn dir_self_event(&mut self, id: &Id, kind: EventKind) {
        match kind {
            EventKind::Modify(ModifyKind::Metadata(_) | ModifyKind::Data(_))
            | EventKind::Access(_)
            | EventKind::Create(_) => {}
            _ => self.mark_up(id),
        }
    }

    fn entry_event(&mut self, id: &Id, name: Option<&str>, kind: EventKind) {
        let Some(name) = name else {
            // A non-UTF-8 name: re-list so the aggregated count stays current.
            self.mark_dirty(id.clone(), Mark::list(), DEBOUNCE);
            return;
        };
        let file = (id.0, id.1.join(name));
        match kind {
            // Metadata on directories is noise (atime, permissions); on known files it may
            // be a touch that changed the modification time.
            EventKind::Modify(ModifyKind::Metadata(_)) => {
                if self.files.contains_key(&file) {
                    self.probe_file(file);
                }
            }
            EventKind::Modify(ModifyKind::Data(_)) | EventKind::Access(_) => {
                if name == self.rules.pattern_file || name == self.rules.marker_file {
                    self.mark_dirty(id.clone(), Mark::list(), DEBOUNCE);
                } else {
                    self.probe_file(file);
                }
            }
            _ => self.mark_dirty(id.clone(), Mark::name(name), DEBOUNCE),
        }
    }

    /// Re-examine this directory from its parent's listing (or the root's identity).
    fn mark_up(&mut self, id: &Id) {
        if self.is_root(id) {
            self.mark_root(id.0);
        } else if let (Some(parent), Some(name)) = (id.1.parent(), name_of(&id.1)) {
            let mark = Mark::name(name);
            self.mark_dirty((id.0, parent.to_path_buf()), mark, DEBOUNCE);
        }
    }

    fn mark_root(&mut self, r: usize) {
        // A root identity check is a few stats; only a changed root triggers a walk.
        let id = (r, self.roots[r].logical.clone());
        self.mark_dirty(id, Mark::verify(), ROOT_CHECK_DELAY);
    }

    fn mark_dirty(&mut self, id: Id, mark: Mark, delay: Duration) {
        let due = Instant::now() + delay;
        match self.dirty.get_mut(&id) {
            Some((current, existing)) => {
                existing.merge(mark);
                if due < *current {
                    *current = due;
                    self.dirty_queue.push(Reverse((due, id)));
                }
            }
            None => {
                self.dirty.insert(id.clone(), (due, mark));
                self.dirty_queue.push(Reverse((due, id)));
            }
        }
    }

    // ------------------------------------------------------------------ reconciliation

    fn process_dirty(&mut self, now: Instant) {
        let mut due = Vec::new();
        while let Some(Reverse((at, _))) = self.dirty_queue.peek()
            && *at <= now
        {
            let Some(Reverse((at, id))) = self.dirty_queue.pop() else {
                break;
            };
            if self
                .dirty
                .get(&id)
                .is_some_and(|(current, _)| *current == at)
                && let Some((_, mark)) = self.dirty.remove(&id)
            {
                due.push((id, mark));
            }
        }
        // Parents first: a parent's listing may remove or re-key a dirty child.
        due.sort_by(|a, b| a.0.cmp(&b.0));
        for (id, mark) in due {
            self.enqueue(id, mark);
        }
    }

    /// Queue a reconciliation on its root's lane; a queued one for the same directory
    /// absorbs it (a stalled root collects at most one job per directory).
    fn enqueue(&mut self, id: Id, mark: Mark) {
        let shard = &mut self.shards[id.0];
        match shard.job_marks.get_mut(&id) {
            Some(existing) => existing.merge(mark),
            None => {
                shard.job_marks.insert(id.clone(), mark);
                shard.jobs.push_back(id);
            }
        }
    }

    fn pump_all(&mut self) {
        for r in 0..self.shards.len() {
            self.pump(r);
        }
    }

    /// Start the root's next directory unless its lane is still busy with one.
    fn pump(&mut self, r: usize) {
        while self.shards[r].flight.is_none() && !self.stopping() && self.fatal.is_none() {
            let work = match self.shards[r].stack.pop() {
                Some(work) => work,
                None => {
                    // Only the first reconciliation is the silent initial walk.
                    if self.shards[r].initial_started {
                        self.roots[r].initial = false;
                    }
                    let Some(id) = self.shards[r].jobs.pop_front() else {
                        self.roots[r].initial = false;
                        return;
                    };
                    self.shards[r].initial_started |= self.roots[r].initial;
                    let mark = self.shards[r].job_marks.remove(&id).unwrap_or_default();
                    if !self.is_root(&id) && !self.dirs.contains_key(&id) {
                        continue;
                    }
                    Work::Existing {
                        id,
                        mark,
                        inherited: None,
                        watch_checked: false,
                    }
                }
            };
            self.start(work);
        }
    }

    fn start(&mut self, work: Work) {
        match work {
            Work::Existing {
                id,
                mut mark,
                inherited,
                watch_checked,
            } => {
                let r = id.0;
                let is_root = self.is_root(&id);
                if let Some(inherited) = inherited
                    && let Some(node) = self.dirs.get_mut(&id)
                    && !Arc::ptr_eq(&node.inherited, &inherited)
                {
                    let local = node.local.as_ref().map_or(&[][..], |l| &l.0[..]);
                    node.patterns = policy::combine(&inherited, local);
                    node.inherited = inherited;
                    mark.all = true;
                }
                let node = self.dirs.get(&id);
                if node.is_none() && !is_root {
                    return;
                }
                let old = node.map(|n| (n.key.clone(), n.canonical.clone()));
                let list = node.is_some() && (mark.list || !is_root);
                // Register before listing, so files created meanwhile are not missed; the
                // registration waits for this inspection's fresh identity.
                let watch_first = list
                    && !watch_checked
                    && self.watch_limit.is_none()
                    && node.is_some_and(|n| {
                        self.wanted(&n.canonical) && !self.watched.contains_key(&n.canonical)
                    });
                let context = (list && !watch_first).then(|| self.list_context(&id, &mark));
                let target = match old {
                    Some(old) if !is_root => Target::Dir {
                        old,
                        root_canonical: self.roots[r].canonical.clone(),
                    },
                    old => Target::Root { old },
                };
                let request = InspectRequest {
                    logical: id.1.clone(),
                    target,
                    list: context,
                };
                self.submit_inspect(
                    r,
                    request,
                    Step::Inspect {
                        id,
                        mark,
                        watch_first,
                    },
                );
            }
            Work::New {
                id,
                canonical,
                key,
                symlink,
                inherited,
                owner_dead,
                seen,
            } => {
                let r = id.0;
                if !self.dirs.contains_key(&id) {
                    if let Some(owner) = self.roots[r].visited.get(&key).cloned()
                        && owner != id.1
                    {
                        let owner_id = (r, owner);
                        let claimed = self
                            .dirs
                            .get(&owner_id)
                            .filter(|node| node.key == key)
                            .map(|node| node.canonical.clone());
                        match claimed {
                            Some(owner_canonical) if !owner_dead => {
                                let path = owner_id.1.clone();
                                let wanted = key.clone();
                                let job = move |worker: &Worker| Done::Owner {
                                    root: r,
                                    live: lister::owner_live(
                                        &path,
                                        &owner_canonical,
                                        &wanted,
                                        worker,
                                    ),
                                };
                                if self.submit_walk(r, job) {
                                    let work = Work::New {
                                        id,
                                        canonical,
                                        key,
                                        symlink,
                                        inherited,
                                        owner_dead: false,
                                        seen,
                                    };
                                    self.shards[r].flight = Some(Step::Owner {
                                        work,
                                        owner: owner_id,
                                    });
                                }
                                return;
                            }
                            Some(_) => {}
                            None => self.mark_up(&owner_id),
                        }
                    }
                    if !self.create_dir(&id, canonical, key, symlink, inherited) {
                        return;
                    }
                }
                let Some(node) = self.dirs.get(&id) else {
                    return;
                };
                if seen.elapsed() > FRESH_FOR {
                    // The parent's lstat is old (a long sibling subtree came first): check the
                    // identity on the lane again before registering.
                    self.start(Work::Existing {
                        id,
                        mark: Mark::full(),
                        inherited: None,
                        watch_checked: false,
                    });
                    return;
                }
                // The parent's listing just lstat'ed this directory: register before listing.
                self.fresh.insert(node.canonical.clone(), node.key.clone());
                self.sync_watches();
                let mark = Mark::full();
                let context = self.list_context(&id, &mark);
                let request = InspectRequest {
                    logical: id.1.clone(),
                    target: Target::New,
                    list: Some(context),
                };
                self.submit_inspect(
                    r,
                    request,
                    Step::Inspect {
                        id,
                        mark,
                        watch_first: false,
                    },
                );
            }
        }
    }

    fn submit_walk(
        &mut self,
        r: usize,
        job: impl FnOnce(&Worker) -> Done + Send + 'static,
    ) -> bool {
        match self.shards[r].walk.submit(&self.sink, job) {
            Ok(()) => true,
            Err(error) => {
                self.lane_failed(&error);
                false
            }
        }
    }

    fn submit_inspect(&mut self, r: usize, request: InspectRequest, step: Step) {
        let job = move |worker: &Worker| Done::Inspect {
            root: r,
            inspected: lister::inspect(request, worker),
        };
        if self.submit_walk(r, job) {
            self.shards[r].flight = Some(step);
            self.shards[r].sent_at = self.recorded;
        }
    }

    fn list_context(&self, id: &Id, mark: &Mark) -> ListContext {
        let root = &self.roots[id.0];
        let node = &self.dirs[id];
        ListContext {
            rules: self.rules.clone(),
            containment: self.containment.clone(),
            extras: root.extras.clone(),
            root_logical: root.logical.clone(),
            root_canonical: root.canonical.clone(),
            is_root: self.is_root(id),
            mount_point: self.is_mount_point(id),
            canonical: node.canonical.clone(),
            inherited: node.inherited.clone(),
            local: node.local.clone(),
            excluded: node.excluded,
            known_files: node.files.clone(),
            known_dirs: node.subdirs.clone(),
            all: mark.all,
            names: mark.names.clone(),
            initial: root.initial,
        }
    }

    fn push(&mut self, work: Work) {
        let r = match &work {
            Work::Existing { id, .. } | Work::New { id, .. } => id.0,
        };
        self.shards[r].stack.push(work);
    }

    fn finish_inspect(&mut self, id: Id, mark: Mark, watch_first: bool, inspected: Inspected) {
        let Inspected { identity, listing } = inspected;
        let r = id.0;
        match identity {
            Identity::Root { sentinel, state } => {
                self.set_sentinel(r, sentinel);
                match state {
                    Err((reason, permission)) => {
                        self.sync_watches();
                        self.fail(&id, reason, permission);
                        return;
                    }
                    Ok((key, canonical, symlink)) => {
                        let changed = self.apply_root_identity(r, key.clone(), &canonical, symlink);
                        self.fresh.insert(canonical, key);
                        self.sync_watches();
                        if changed {
                            self.push(Work::Existing {
                                id,
                                mark: Mark::full(),
                                inherited: None,
                                watch_checked: false,
                            });
                            return;
                        }
                    }
                }
            }
            Identity::Dir(state) => match state {
                DirState::Gone | DirState::Outside => {
                    self.mark_up(&id);
                    return;
                }
                DirState::Fail(reason, permission) => {
                    self.fail(&id, reason, permission);
                    return;
                }
                DirState::Changed(canonical, key, symlink) => {
                    self.rekey(&id, canonical.clone(), key.clone(), symlink);
                    self.fresh.insert(canonical, key);
                    self.sync_watches();
                    let mut mark = mark;
                    mark.all = true;
                    mark.recursive = true;
                    self.push(Work::Existing {
                        id,
                        mark,
                        inherited: None,
                        watch_checked: true,
                    });
                    return;
                }
                DirState::Same => {
                    if let Some(node) = self.dirs.get(&id) {
                        self.fresh.insert(node.canonical.clone(), node.key.clone());
                    }
                }
            },
            Identity::New => {}
        }
        if watch_first {
            if let Some(node) = self.dirs.get(&id) {
                self.watch_dirty.insert(node.canonical.clone());
            }
            self.sync_watches();
            self.push(Work::Existing {
                id,
                mark,
                inherited: None,
                watch_checked: true,
            });
            return;
        }
        match listing {
            Listing::Skipped | Listing::Aborted => {}
            Listing::Failed {
                reason,
                permission,
                log,
            } => {
                if self.fail(&id, reason, permission)
                    && let Some(log) = log
                {
                    eprintln!("{log}");
                }
            }
            Listing::Listed(listed) => {
                let children = self.apply_listing(id, mark, *listed);
                for child in children.into_iter().rev() {
                    self.push(child);
                }
            }
        }
    }

    fn set_sentinel(&mut self, r: usize, found: Option<(PathBuf, DirKey)>) {
        let path = found.as_ref().map(|(p, _)| p.clone());
        if path != self.roots[r].sentinel {
            if let Some(old) = self.roots[r].sentinel.take() {
                self.detach(&old, |refs| {
                    refs.roots.remove(&r);
                });
            }
            if let Some(new) = &path {
                self.refs.entry(new.clone()).or_default().roots.insert(r);
                self.watch_dirty.insert(new.clone());
            }
            self.roots[r].sentinel = path;
        }
        if let Some((path, key)) = found {
            self.fresh.insert(path, key);
        }
    }

    /// True when the root node was created or re-keyed (walk everything).
    fn apply_root_identity(
        &mut self,
        r: usize,
        key: DirKey,
        canonical: &Path,
        symlink: bool,
    ) -> bool {
        let logical = self.roots[r].logical.clone();
        let id = (r, logical.clone());
        if self.roots[r].canonical.as_deref() != Some(canonical) {
            self.roots[r].extras = root_extras(&logical, Some(canonical));
            self.roots[r].canonical = Some(canonical.to_path_buf());
            // A root that (re)appeared may be the mount other containment roots live on.
            self.containment_next = Instant::now() + CONTAINMENT_REFRESH;
            self.request_containment();
        }
        let existing = self.dirs.get(&id).map(|n| {
            (
                n.key == key && n.canonical == canonical,
                n.symlink == symlink,
            )
        });
        match existing {
            Some((true, same_kind)) => {
                if !same_kind {
                    self.rekey(&id, canonical.to_path_buf(), key, symlink);
                }
                false
            }
            Some(_) => {
                self.rekey(&id, canonical.to_path_buf(), key, symlink);
                true
            }
            None => {
                let empty: Patterns = Arc::new(Vec::new());
                self.dirs.insert(
                    id.clone(),
                    DirNode {
                        canonical: canonical.to_path_buf(),
                        key: key.clone(),
                        symlink,
                        inherited: empty.clone(),
                        patterns: empty,
                        local: None,
                        excluded: false,
                        files: HashSet::new(),
                        subdirs: HashSet::new(),
                        non_utf8: 0,
                        refused: 0,
                        ignore_links: Vec::new(),
                    },
                );
                self.roots[r].visited.insert(key, logical);
                self.attach_node(&id, canonical, symlink);
                true
            }
        }
    }

    fn create_dir(
        &mut self,
        id: &Id,
        canonical: PathBuf,
        key: DirKey,
        symlink: bool,
        inherited: Patterns,
    ) -> bool {
        let root = id.0;
        let (Some(parent), Some(name)) = (id.1.parent(), name_of(&id.1)) else {
            return false;
        };
        let Some(parent_node) = self.dirs.get_mut(&(root, parent.to_path_buf())) else {
            return false;
        };
        parent_node.subdirs.insert(name.to_string());
        self.dirs.insert(
            id.clone(),
            DirNode {
                canonical: canonical.clone(),
                key: key.clone(),
                symlink,
                inherited: inherited.clone(),
                patterns: inherited,
                local: None,
                excluded: false,
                files: HashSet::new(),
                subdirs: HashSet::new(),
                non_utf8: 0,
                refused: 0,
                ignore_links: Vec::new(),
            },
        );
        self.roots[root].visited.insert(key, id.1.clone());
        self.attach_node(id, &canonical, symlink);
        true
    }

    /// The index half of a directory listing; returns the children to walk next.
    fn apply_listing(&mut self, id: Id, mut mark: Mark, listed: Listed) -> Vec<Work> {
        self.heartbeat();
        let root = id.0;
        let is_root = self.is_root(&id);
        let logical = id.1.clone();
        if !self.dirs.contains_key(&id) {
            return Vec::new();
        }
        let Listed {
            root_marker,
            excluded,
            local,
            dropped,
            ignore_links,
            want_files,
            want_dirs,
            errors,
            refused,
            non_utf8,
            present,
            known_files,
            known_dirs,
        } = listed;
        if is_root {
            if root_marker && !self.roots[root].marker_warned {
                eprintln!(
                    "lumastra-watcher: refusing empty \"{}\" marker at library root {} (would exclude the entire library)",
                    self.rules.marker_file,
                    logical.display()
                );
            }
            self.roots[root].marker_warned = root_marker;
        }
        if excluded {
            let (files, subdirs) = {
                let Some(node) = self.dirs.get_mut(&id) else {
                    return Vec::new();
                };
                node.excluded = true;
                node.local = Some((local, true));
                (mem::take(&mut node.files), mem::take(&mut node.subdirs))
            };
            for name in subdirs {
                self.remove_subtree(&(root, logical.join(&name)));
            }
            for name in files {
                self.forget_file(&(root, logical.join(&name)));
            }
            self.set_ignore_links(&id, ignore_links);
            self.set_counts(&id, 0, 0);
            self.clear_failure(&id);
            self.name_retries.remove(&id);
            return Vec::new();
        }
        self.set_ignore_links(&id, ignore_links);
        let patterns = {
            let Some(node) = self.dirs.get_mut(&id) else {
                return Vec::new();
            };
            if node.excluded {
                node.excluded = false;
                mark.all = true;
                mark.recursive = true;
            }
            let signature = (local, false);
            if node.local.as_ref() != Some(&signature) {
                if node.local.is_some() {
                    mark.all = true;
                    mark.recursive = true;
                }
                if dropped > 0 {
                    eprintln!(
                        "lumastra-watcher: ignore files in {} exceed the pattern limits; {dropped} line(s) dropped",
                        logical.display()
                    );
                }
                node.patterns = policy::combine(&node.inherited, &signature.0);
                node.local = Some(signature);
            }
            node.patterns.clone()
        };

        // Removals first, so a renamed directory's old watch is released before its new
        // path registers (inotify hands both paths the same wd). Only names known when the
        // listing was requested count: a file recorded since then was not in that listing.
        let (gone_files, gone_dirs) = {
            let Some(node) = self.dirs.get(&id) else {
                return Vec::new();
            };
            let file_names: HashSet<&str> = want_files.iter().map(|w| w.name.as_str()).collect();
            let dir_names: HashSet<&str> = want_dirs.iter().map(|w| w.name.as_str()).collect();
            let sent_at = self.shards[root].sent_at;
            let gone_files: Vec<String> = known_files
                .iter()
                .filter(|n| {
                    node.files.contains(*n)
                        && !file_names.contains(n.as_str())
                        && !errors.contains(*n)
                        && self
                            .files
                            .get(&(root, logical.join(n.as_str())))
                            .is_none_or(|state| state.recorded <= sent_at)
                })
                .cloned()
                .collect();
            let gone_dirs: Vec<String> = known_dirs
                .iter()
                .filter(|n| {
                    node.subdirs.contains(*n)
                        && !dir_names.contains(n.as_str())
                        && !errors.contains(*n)
                })
                .cloned()
                .collect();
            (gone_files, gone_dirs)
        };
        for name in gone_files {
            self.remove_known_file(&(root, logical.join(&name)));
        }
        for name in gone_dirs {
            self.remove_subtree(&(root, logical.join(&name)));
        }

        for want in want_files {
            let id = (root, logical.join(&want.name));
            let known = self
                .files
                .get(&id)
                .map(|state| (state.fingerprint, state.target.clone()));
            let link = want.link.map(|(_, fingerprint)| fingerprint);
            match known {
                Some((fingerprint, target)) => {
                    if want.check
                        && let Some((now_fp, now_target)) = want.observed
                        && (now_fp != fingerprint || now_target != target)
                    {
                        self.queue_pending(id, want.kind, Some(now_fp));
                    }
                }
                None if self.roots[root].initial => {
                    if let Some((fingerprint, target)) = want.observed {
                        self.record_file(id, fingerprint, target);
                    }
                }
                None => self.queue_pending(id, want.kind, link),
            }
        }

        let mut children = Vec::new();
        for want in want_dirs {
            let child = (root, logical.join(&want.name));
            match want.found {
                None => {
                    if mark.recursive {
                        children.push(Work::Existing {
                            id: child,
                            mark: mark_for_child(&mark),
                            inherited: Some(patterns.clone()),
                            watch_checked: false,
                        });
                    }
                }
                Some((canonical, key, symlink)) => {
                    let existing = self
                        .dirs
                        .get(&child)
                        .map(|n| n.key == key && n.canonical == canonical && n.symlink == symlink);
                    match existing {
                        Some(true) => {
                            if mark.recursive {
                                children.push(Work::Existing {
                                    id: child,
                                    mark: mark_for_child(&mark),
                                    inherited: Some(patterns.clone()),
                                    watch_checked: false,
                                });
                            }
                        }
                        Some(false) => {
                            self.rekey(&child, canonical.clone(), key.clone(), symlink);
                            // The listing just lstat'ed it.
                            self.fresh.insert(canonical, key);
                            children.push(Work::Existing {
                                id: child,
                                mark: Mark::full(),
                                inherited: Some(patterns.clone()),
                                watch_checked: false,
                            });
                        }
                        None => children.push(Work::New {
                            id: child,
                            canonical,
                            key,
                            symlink,
                            inherited: patterns.clone(),
                            owner_dead: false,
                            seen: Instant::now(),
                        }),
                    }
                }
            }
        }

        // Uninspectable entries (dangling symlinks, stat errors) keep their prior state and
        // count like refused symlinks; only those names are retried, the directory is fine.
        let mut unresolved: HashSet<String> = self
            .name_retries
            .get(&id)
            .map(|retry| {
                retry
                    .names
                    .iter()
                    .filter(|n| {
                        !(mark.all || mark.names.contains(*n)) && present.contains(n.as_str())
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        unresolved.extend(errors);
        self.set_counts(&id, non_utf8, refused + unresolved.len() as u64);
        self.clear_failure(&id);
        self.retry_names(&id, unresolved);
        children
    }

    fn retry_names(&mut self, id: &Id, names: HashSet<String>) {
        if names.is_empty() {
            self.name_retries.remove(id);
            return;
        }
        let now = Instant::now();
        match self.name_retries.get_mut(id) {
            Some(retry) => {
                retry.names = names;
                if now >= retry.next {
                    retry.backoff = (retry.backoff * 2).min(RETRY_MAX);
                    retry.next = now + retry.backoff;
                    self.retry_queue.push(Reverse((retry.next, id.clone())));
                }
            }
            None => {
                let next = now + RETRY_MIN;
                self.name_retries.insert(
                    id.clone(),
                    NameRetry {
                        names,
                        backoff: RETRY_MIN,
                        next,
                    },
                );
                self.retry_queue.push(Reverse((next, id.clone())));
            }
        }
    }

    /// A directory on another device than its parent directory.
    fn is_mount_point(&self, id: &Id) -> bool {
        let Some(parent) = id.1.parent() else {
            return false;
        };
        match (
            self.dirs.get(id).map(|n| &n.key),
            self.dirs.get(&(id.0, parent.to_path_buf())).map(|n| &n.key),
        ) {
            (Some(DirKey::Inode(dev, _)), Some(DirKey::Inode(parent_dev, _))) => dev != parent_dev,
            _ => false,
        }
    }
    fn set_ignore_links(&mut self, id: &Id, links: Vec<PathBuf>) {
        let Some(node) = self.dirs.get_mut(id) else {
            return;
        };
        if node.ignore_links == links {
            return;
        }
        let old = mem::replace(&mut node.ignore_links, links.clone());
        for real in old {
            self.detach_ignore_link(&real, id);
        }
        for real in links {
            if let Some(parent) = real.parent() {
                self.refs
                    .entry(parent.to_path_buf())
                    .or_default()
                    .aux
                    .insert(id.clone());
                self.watch_dirty.insert(parent.to_path_buf());
            }
            self.ignore_targets
                .entry(real)
                .or_default()
                .insert(id.clone());
        }
    }

    fn detach_ignore_link(&mut self, real: &Path, id: &Id) {
        if let Some(parent) = real.parent() {
            self.detach(parent, |refs| {
                refs.aux.remove(id);
            });
        }
        if let Some(dirs) = self.ignore_targets.get_mut(real) {
            dirs.remove(id);
            if dirs.is_empty() {
                self.ignore_targets.remove(real);
            }
        }
    }

    fn set_counts(&mut self, id: &Id, non_utf8: u64, refused: u64) {
        let Some(node) = self.dirs.get_mut(id) else {
            return;
        };
        let root = &mut self.roots[id.0];
        root.non_utf8 = root.non_utf8 + non_utf8 - node.non_utf8;
        if refused > node.refused {
            eprintln!(
                "lumastra-watcher: {refused} symlink(s) in {} skipped (target outside library roots or in a sensitive location)",
                id.1.display()
            );
        }
        root.refused = root.refused + refused - node.refused;
        node.non_utf8 = non_utf8;
        node.refused = refused;
    }

    fn rekey(&mut self, id: &Id, canonical: PathBuf, key: DirKey, symlink: bool) {
        let Some(node) = self.dirs.get_mut(id) else {
            return;
        };
        let old_canonical = mem::replace(&mut node.canonical, canonical.clone());
        let old_key = mem::replace(&mut node.key, key.clone());
        let old_symlink = mem::replace(&mut node.symlink, symlink);
        self.detach_node(id, &old_canonical, old_symlink);
        let visited = &mut self.roots[id.0].visited;
        if visited.get(&old_key) == Some(&id.1) {
            visited.remove(&old_key);
        }
        visited.insert(key, id.1.clone());
        self.attach_node(id, &canonical, symlink);
        if old_canonical == canonical {
            // Same path, different inode: the old kernel watch belongs to the old inode.
            self.force_rewatch.insert(canonical);
        }
    }

    fn remove_subtree(&mut self, id: &Id) {
        if let (Some(parent), Some(name)) = (id.1.parent(), name_of(&id.1))
            && let Some(parent_node) = self.dirs.get_mut(&(id.0, parent.to_path_buf()))
        {
            parent_node.subdirs.remove(name);
        }
        let ids: Vec<Id> = self
            .dirs
            .range(id.clone()..)
            .take_while(|(k, _)| k.0 == id.0 && k.1.starts_with(&id.1))
            .map(|(k, _)| k.clone())
            .collect();
        for dir in ids {
            let Some(node) = self.dirs.remove(&dir) else {
                continue;
            };
            for name in &node.files {
                self.forget_file(&(dir.0, dir.1.join(name)));
            }
            self.detach_node(&dir, &node.canonical, node.symlink);
            for real in &node.ignore_links {
                self.detach_ignore_link(real, &dir);
            }
            self.name_retries.remove(&dir);
            let root = &mut self.roots[dir.0];
            if root.visited.get(&node.key) == Some(&dir.1) {
                root.visited.remove(&node.key);
            }
            root.non_utf8 -= node.non_utf8;
            root.refused -= node.refused;
            self.failures.remove(&dir);
            self.dirty.remove(&dir);
        }
    }

    // ------------------------------------------------------------------- file state

    fn record_file(&mut self, id: FileId, fingerprint: Fingerprint, target: Option<PathBuf>) {
        self.recorded += 1;
        if let Some(target) = &target {
            self.attach_target(target, &id);
        }
        if let (Some(parent), Some(name)) = (id.1.parent(), name_of(&id.1))
            && let Some(node) = self.dirs.get_mut(&(id.0, parent.to_path_buf()))
        {
            node.files.insert(name.to_string());
        }
        let previous = self.files.insert(
            id.clone(),
            FileState {
                fingerprint,
                target: target.clone(),
                recorded: self.recorded,
            },
        );
        if let Some(old) = previous.and_then(|p| p.target)
            && Some(&old) != target.as_ref()
        {
            self.detach_target(&old, &id);
        }
    }

    fn remove_known_file(&mut self, id: &FileId) {
        if let (Some(parent), Some(name)) = (id.1.parent(), name_of(&id.1))
            && let Some(node) = self.dirs.get_mut(&(id.0, parent.to_path_buf()))
        {
            node.files.remove(name);
        }
        self.forget_file(id);
    }

    fn forget_file(&mut self, id: &FileId) {
        self.pending.remove(id);
        if let Some(state) = self.files.remove(id) {
            if let Some(target) = state.target {
                self.detach_target(&target, id);
            }
            self.emit("unlink", &id.1);
        }
    }

    fn emit(&self, event: &'static str, path: &Path) -> bool {
        match path.to_str() {
            Some(path) => self.output.send(Message::Event {
                event,
                path: path.to_string(),
            }),
            None => false,
        }
    }

    /// The scanner rules for a file as of now, from its directory's current state.
    fn eligible_now(&self, id: &FileId) -> Option<FileKind> {
        let parent = (id.0, id.1.parent()?.to_path_buf());
        let node = self.dirs.get(&parent)?;
        if node.excluded || self.failures.contains_key(&parent) {
            return None;
        }
        let name = name_of(&id.1)?;
        if node.subdirs.contains(name) {
            return None;
        }
        let kind = self.rules.file_kind(name)?;
        let relative =
            id.1.strip_prefix(&self.roots[id.0].logical)
                .ok()?
                .to_str()?;
        if policy::is_ignored(name, relative, &node.patterns, self.rules.max_accumulated) {
            return None;
        }
        Some(kind)
    }

    fn probe_file(&mut self, id: FileId) {
        // Already scheduled: skip the eligibility work (thousands of glob tests per write).
        if self.pending.contains_key(&id) {
            return;
        }
        if let Some(kind) = self.eligible_now(&id) {
            self.queue_pending(id, kind, None);
        }
    }

    fn ticket(&mut self) -> u64 {
        self.next_ticket += 1;
        self.next_ticket
    }

    fn queue_pending(&mut self, id: FileId, kind: FileKind, observed: Option<Fingerprint>) {
        if self.pending.contains_key(&id) {
            return;
        }
        if self.pending.len() >= PENDING_CAPACITY {
            self.request_full_rescan("pending write-stability queue overflow", false);
            return;
        }
        let now = Instant::now();
        let due = if observed.is_some() {
            now + self.stability
        } else {
            now
        };
        let ticket = self.ticket();
        self.pending.insert(
            id.clone(),
            Pending {
                kind,
                observed,
                stable_since: now,
                ticket,
                in_flight: false,
            },
        );
        self.pending_queue.push(Reverse((due, ticket, id)));
    }

    fn reschedule(&mut self, id: FileId, due: Instant) {
        let ticket = self.ticket();
        if let Some(pending) = self.pending.get_mut(&id) {
            pending.ticket = ticket;
            self.pending_queue.push(Reverse((due, ticket, id)));
        }
    }

    fn dispatch_probes(&mut self, now: Instant) {
        let mut budget = STAT_BATCH;
        // A root with a full stat lane (a hung mount) must not hold back the other roots.
        let mut deferred = Vec::new();
        while budget > 0 {
            let Some(Reverse((due, _, _))) = self.pending_queue.peek() else {
                break;
            };
            if *due > now {
                break;
            }
            let Some(Reverse((due, ticket, id))) = self.pending_queue.pop() else {
                break;
            };
            let Some(pending) = self.pending.get(&id) else {
                continue;
            };
            if pending.ticket != ticket || pending.in_flight {
                continue;
            }
            let r = id.0;
            if self.shards[r].probes >= STAT_QUEUE {
                deferred.push(Reverse((due, ticket, id)));
                continue;
            }
            let kind = pending.kind;
            let containment = self.containment.clone();
            let extras = self.roots[r].extras.clone();
            let path = id.clone();
            let job = move |worker: &Worker| {
                worker.enter(&path.1);
                let outcome = probe::probe(&path.1, kind, &containment, &extras);
                Done::Probe(ProbeResult {
                    id: path,
                    ticket,
                    outcome,
                })
            };
            match self.shards[r].stat.submit(&self.sink, job) {
                Ok(()) => {
                    self.shards[r].probes += 1;
                    budget -= 1;
                    if let Some(pending) = self.pending.get_mut(&id) {
                        pending.in_flight = true;
                    }
                }
                Err(error) => {
                    self.lane_failed(&error);
                    break;
                }
            }
        }
        self.pending_queue.extend(deferred);
    }

    fn apply_probe(&mut self, result: ProbeResult, now: Instant) {
        let ProbeResult {
            id,
            ticket,
            outcome,
        } = result;
        match self.pending.get_mut(&id) {
            Some(pending) if pending.ticket == ticket => pending.in_flight = false,
            _ => return,
        }
        let Probe::File {
            fingerprint,
            target,
        } = outcome
        else {
            self.pending.remove(&id);
            if self.files.contains_key(&id) {
                // Gone, refused or unreachable: the directory listing decides.
                self.mark_up(&id);
            }
            return;
        };
        if self.eligible_now(&id).is_none() {
            self.pending.remove(&id);
            return;
        }
        let Some(pending) = self.pending.get_mut(&id) else {
            return;
        };
        if pending.observed != Some(fingerprint) {
            // Still being written: sample again soon, so delivery follows the last write by
            // about the stability window rather than up to twice it.
            pending.observed = Some(fingerprint);
            pending.stable_since = now;
            self.reschedule(id, now + self.poll);
        } else if now.duration_since(pending.stable_since) >= self.stability {
            self.pending.remove(&id);
            self.emit_stable(id, fingerprint, target);
        } else {
            let due = pending.stable_since + self.stability;
            self.reschedule(id, due);
        }
    }

    fn emit_stable(&mut self, id: FileId, fingerprint: Fingerprint, target: Option<PathBuf>) {
        let event = match self.files.get(&id) {
            Some(known) if known.fingerprint == fingerprint && known.target == target => return,
            Some(_) => "change",
            None => "add",
        };
        // Only a delivered event updates the index; a dropped one is covered by the rescan.
        if self.emit(event, &id.1) {
            self.record_file(id, fingerprint, target);
        }
    }

    // --------------------------------------------------------------- failures & timers

    /// Returns true when the directory newly entered the failure set.
    fn fail(&mut self, id: &Id, reason: String, permission: bool) -> bool {
        let now = Instant::now();
        match self.failures.get_mut(id) {
            Some(failure) => {
                failure.reason = reason;
                failure.permission = permission;
                if now >= failure.next {
                    failure.backoff = (failure.backoff * 2).min(RETRY_MAX);
                    failure.next = now + failure.backoff;
                    self.retry_queue.push(Reverse((failure.next, id.clone())));
                }
                false
            }
            None => {
                let next = now + RETRY_MIN;
                self.failures.insert(
                    id.clone(),
                    Failure {
                        reason,
                        permission,
                        backoff: RETRY_MIN,
                        next,
                    },
                );
                self.retry_queue.push(Reverse((next, id.clone())));
                self.newly_failed.push(id.clone());
                true
            }
        }
    }

    fn clear_failure(&mut self, id: &Id) {
        self.failures.remove(id);
    }

    fn process_retries(&mut self, now: Instant) {
        while let Some(Reverse((at, _))) = self.retry_queue.peek()
            && *at <= now
        {
            let Some(Reverse((at, id))) = self.retry_queue.pop() else {
                break;
            };
            // A failed listing is retried for that directory only: its subtree kept its
            // watches, and new subdirectories found by the retry are walked anyway.
            if self.failures.get(&id).is_some_and(|f| f.next == at) {
                self.mark_dirty(id.clone(), Mark::all(), Duration::ZERO);
            }
            if let Some(retry) = self.name_retries.get(&id)
                && retry.next == at
            {
                let mark = Mark {
                    list: true,
                    names: retry.names.clone(),
                    ..Mark::default()
                };
                self.mark_dirty(id, mark, Duration::ZERO);
            }
        }
    }

    fn process_network(&mut self, now: Instant) {
        let Some(every) = self.network_every else {
            return;
        };
        for r in 0..self.roots.len() {
            if self.roots[r].next_network.is_some_and(|at| at <= now) {
                self.roots[r].next_network = Some(now + every);
                let id = (r, self.roots[r].logical.clone());
                self.mark_dirty(id, Mark::full(), Duration::ZERO);
            }
        }
    }

    fn mark_all_roots(&mut self) {
        for r in 0..self.roots.len() {
            let id = (r, self.roots[r].logical.clone());
            self.mark_dirty(id, Mark::full(), Duration::ZERO);
        }
    }

    fn process_full(&mut self, now: Instant) {
        if self.full_due.is_some_and(|at| at <= now) {
            self.full_due = None;
            self.last_full = Some(now);
            if mem::take(&mut self.rewatch_on_full) {
                self.rewatch_all();
            }
            self.mark_all_roots();
        }
    }

    fn process_recover(&mut self, now: Instant) {
        if !self.recover_due.is_some_and(|at| at <= now) {
            return;
        }
        // A backend error may invalidate registrations even when paths and inodes are unchanged.
        self.recover_due = None;
        self.last_recover = Some(now);
        self.rewatch_all();
        self.mark_all_roots();
    }

    fn rewatch_all(&mut self) {
        let watched: Vec<PathBuf> = self.watched.keys().cloned().collect();
        for path in watched {
            self.backend.unwatch(&path);
        }
        self.watched.clear();
        self.by_identity.clear();
        self.aux_watched.clear();
        self.aux_capped.clear();
        self.watch_dirty.extend(self.refs.keys().cloned());
    }

    /// Wanted directories whose registration failed (not the watch limit): retry with
    /// backoff from 5 s to 5 min.
    fn process_unwatched(&mut self, now: Instant) {
        if self.watch_limit.is_some() || self.unwatched.is_empty() {
            if self.unwatched.is_empty() {
                self.unwatched_due = None;
                self.unwatched_backoff = RETRY_MIN;
            }
            return;
        }
        let Some(due) = self.unwatched_due else {
            self.unwatched_due = Some(now + self.unwatched_backoff);
            return;
        };
        if due > now {
            return;
        }
        let retry: Vec<PathBuf> = self.unwatched.iter().cloned().collect();
        self.watch_dirty.extend(retry);
        self.sync_watches();
        if self.unwatched.is_empty() {
            self.unwatched_due = None;
            self.unwatched_backoff = RETRY_MIN;
        } else {
            self.unwatched_backoff = (self.unwatched_backoff * 2).min(RETRY_MAX);
            self.unwatched_due = Some(now + self.unwatched_backoff);
        }
    }

    /// A root whose lanes stopped returning is reported once and marks coverage partial;
    /// the other roots go on. Once it answers again a `rescan` covers what its walk could
    /// not see meanwhile (rate-limited like failure notices).
    fn check_stall(&mut self, now: Instant) {
        let limit = self.stall_after;
        for r in 0..self.shards.len() {
            let walk = self.shards[r].walk.stalled(&self.sink, limit);
            let stat = self.shards[r].stat.stalled(&self.sink, limit);
            let stalled = walk || stat;
            let root = self.roots[r].logical.display().to_string();
            let shard = &mut self.shards[r];
            shard.probe_stalled = stat;
            if stalled && !shard.stalled {
                eprintln!(
                    "lumastra-watcher: filesystem calls under {root} have not returned for {} s; the mount may be hung",
                    limit.as_secs()
                );
            } else if !stalled && shard.stalled {
                eprintln!("lumastra-watcher: filesystem under {root} responds again");
                if mem::take(&mut shard.reported) {
                    self.stall_rescan = true;
                }
                // Its paths that were not registered while it hung: retry them now.
                self.unwatched_due = Some(now);
                self.unwatched_backoff = RETRY_MIN;
            }
            let shard = &mut self.shards[r];
            shard.stalled = stalled;
            if stalled && !shard.reported && self.ready {
                shard.reported = true;
                // A flapping mount is reported again only after a while.
                if shard
                    .last_report
                    .is_some_and(|at| now.duration_since(at) < STALL_REPORT_EVERY)
                {
                    continue;
                }
                shard.last_report = Some(now);
                self.output.send(Message::Error {
                    message: format!(
                        "filesystem calls under {root} have not returned for {} s (hung mount?); live updates for this library root are paused",
                        limit.as_secs()
                    ),
                    fatal: false,
                    code: Some("io"),
                });
            }
        }
        let stalled = self.resolution.lane.stalled(&self.sink, limit);
        self.resolution.stalled = stalled;
        if stalled && !self.resolution.reported && self.ready {
            self.resolution.reported = true;
            self.output.send(Message::Error {
                message: format!(
                    "resolving containment roots or sensitive prefixes has not returned for {} s (hung mount?); symlinks are judged by the paths resolved so far",
                    limit.as_secs()
                ),
                fatal: false,
                code: Some("io"),
            });
        }
        if self.stall_rescan && self.ready {
            let due = *self.stall_rescan_due.get_or_insert_with(|| {
                next_backoff(self.last_stall_rescan, &mut self.stall_rescan_backoff, now)
            });
            if due <= now {
                self.stall_rescan = false;
                self.stall_rescan_due = None;
                self.last_stall_rescan = Some(now);
                self.output.send(Message::Rescan {
                    reason:
                        "filesystem observation incomplete: a stalled library root responds again"
                            .into(),
                });
            }
        }
    }

    /// `alive` from the main thread, also during the initial walk.
    fn heartbeat(&self) {
        let now = Instant::now();
        if now >= self.alive_next.get() {
            self.output.send(Message::Alive {
                seq: self.alive_seq.get(),
            });
            self.alive_seq.set(self.alive_seq.get() + 1);
            self.alive_next.set(now + self.alive_every);
        }
    }

    // ---------------------------------------------------------------------- watches

    fn attach_node(&mut self, id: &Id, canonical: &Path, symlink: bool) {
        self.refs
            .entry(canonical.to_path_buf())
            .or_default()
            .dirs
            .insert(id.clone());
        self.watch_dirty.insert(canonical.to_path_buf());
        if symlink && let Some(parent) = canonical.parent() {
            // The link target's parent notices the target disappearing and reappearing.
            self.refs
                .entry(parent.to_path_buf())
                .or_default()
                .aux
                .insert(id.clone());
            self.watch_dirty.insert(parent.to_path_buf());
            self.link_targets
                .entry(canonical.to_path_buf())
                .or_default()
                .insert(id.clone());
        }
    }

    fn detach_node(&mut self, id: &Id, canonical: &Path, symlink: bool) {
        self.detach(canonical, |refs| {
            refs.dirs.remove(id);
        });
        if symlink {
            if let Some(parent) = canonical.parent() {
                self.detach(parent, |refs| {
                    refs.aux.remove(id);
                });
            }
            if let Some(links) = self.link_targets.get_mut(canonical) {
                links.remove(id);
                if links.is_empty() {
                    self.link_targets.remove(canonical);
                }
            }
        }
    }

    fn attach_target(&mut self, target: &Path, id: &FileId) {
        if let Some(parent) = target.parent() {
            self.refs
                .entry(parent.to_path_buf())
                .or_default()
                .aux
                .insert(id.clone());
            self.watch_dirty.insert(parent.to_path_buf());
        }
        self.file_routes
            .entry(target.to_path_buf())
            .or_default()
            .insert(id.clone());
    }

    fn detach_target(&mut self, target: &Path, id: &FileId) {
        if let Some(parent) = target.parent() {
            self.detach(parent, |refs| {
                refs.aux.remove(id);
            });
        }
        if let Some(links) = self.file_routes.get_mut(target) {
            links.remove(id);
            if links.is_empty() {
                self.file_routes.remove(target);
            }
        }
    }

    fn detach(&mut self, physical: &Path, change: impl FnOnce(&mut Refs)) {
        if let Some(refs) = self.refs.get_mut(physical) {
            change(refs);
            if refs.is_empty() {
                self.refs.remove(physical);
            }
            self.watch_dirty.insert(physical.to_path_buf());
        }
    }

    fn wanted(&self, physical: &Path) -> bool {
        self.refs.get(physical).is_some_and(|r| !r.is_empty())
    }

    fn forget_watch(&mut self, physical: &Path) -> Option<DirKey> {
        let key = self.watched.remove(physical)?;
        self.aux_watched.remove(physical);
        if let Some(paths) = self.by_identity.get_mut(&key) {
            paths.remove(physical);
            if paths.is_empty() {
                self.by_identity.remove(&key);
            }
        }
        Some(key)
    }

    /// Everything that watches `physical`: re-list after a watch gap.
    fn mark_physical_dirty(&mut self, physical: &Path) {
        let Some(refs) = self.refs.get(physical) else {
            return;
        };
        let dirs: Vec<Id> = refs.dirs.iter().cloned().collect();
        let aux: Vec<Id> = refs.aux.iter().cloned().collect();
        let roots: Vec<usize> = refs.roots.iter().copied().collect();
        for id in dirs {
            self.mark_dirty(id, Mark::all(), DEBOUNCE);
        }
        for id in aux {
            self.mark_up(&id);
        }
        for r in roots {
            self.mark_root(r);
        }
    }

    /// The backend already removed the watch for `path` and every watch below it; a watch
    /// sharing one of those inodes lost its kernel wd too.
    fn backend_dropped(&mut self, path: &Path) {
        if !self.watched.contains_key(path) {
            return;
        }
        let removed: Vec<PathBuf> = self
            .watched
            .range(path.to_path_buf()..)
            .take_while(|(p, _)| p.starts_with(path))
            .map(|(p, _)| p.clone())
            .collect();
        let mut affected: HashSet<PathBuf> = HashSet::new();
        for p in removed {
            if let Some(key) = self.watched.get(&p)
                && let Some(shared) = self.by_identity.get(key)
            {
                affected.extend(shared.iter().cloned());
            }
            affected.insert(p);
        }
        for p in affected {
            self.forget_watch(&p);
            if self.wanted(&p) {
                self.watch_dirty.insert(p.clone());
                self.mark_physical_dirty(&p);
            }
        }
    }

    fn sync_watches(&mut self) {
        if self.watch_dirty.is_empty() && self.force_rewatch.is_empty() {
            self.fresh.clear();
            return;
        }
        let mut candidates: HashSet<PathBuf> = mem::take(&mut self.watch_dirty);
        candidates.extend(self.force_rewatch.iter().cloned());
        let mut to_unwatch = Vec::new();
        let mut to_watch: Vec<PathBuf> = Vec::new();
        for path in candidates {
            let wanted = self.wanted(&path);
            let watched = self.watched.contains_key(&path);
            let force = self.force_rewatch.remove(&path);
            if watched && (!wanted || force) {
                to_unwatch.push(path.clone());
            }
            if wanted && (!watched || force) {
                to_watch.push(path.clone());
            }
            if !wanted {
                self.unwatched.remove(&path);
                self.aux_capped.remove(&path);
            }
        }
        // Unwatch before watch: inotify reuses one wd per inode, so registering a renamed
        // directory's new path and then unwatching its old path would kill both.
        for path in to_unwatch {
            let Some(key) = self.forget_watch(&path) else {
                continue;
            };
            self.backend.unwatch(&path);
            let shared: Vec<PathBuf> = self
                .by_identity
                .get(&key)
                .map(|s| s.iter().cloned().collect())
                .unwrap_or_default();
            for other in shared {
                self.forget_watch(&other);
                if self.wanted(&other) {
                    self.mark_physical_dirty(&other);
                    to_watch.push(other);
                }
            }
        }
        let mut seen = HashSet::new();
        to_watch.retain(|p| seen.insert(p.clone()));
        // Library directories first, so out-of-library target parents never take their place.
        to_watch.sort_by_cached_key(|p| (self.aux_only(p), p.clone()));
        // Registration resolves the path in the kernel on this thread, so only a path a lane
        // stat'ed just now is registered directly; any other is stat'ed on its root's lane
        // first, and a stalled root's paths wait.
        for path in to_watch {
            match self.fresh.get(&path).cloned() {
                Some(key) => self.try_watch(path, key),
                None => self.request_preflight(path),
            }
        }
        self.fresh.clear();
    }

    /// Checks shared by every registration; false when the path must not be registered now.
    fn may_watch(&mut self, path: &Path) -> bool {
        if self.watched.contains_key(path) {
            return false;
        }
        if self.watch_limit.is_some() {
            self.unwatched.insert(path.to_path_buf());
            return false;
        }
        if self.aux_only(path) && self.aux_watched.len() >= self.aux_cap {
            if self.aux_capped.insert(path.to_path_buf()) && self.aux_capped.len() == 1 {
                eprintln!(
                    "lumastra-watcher: {} watches on symlink-target directories outside the library reached; further target changes are seen only by rescans",
                    self.aux_cap
                );
            }
            return false;
        }
        true
    }

    fn request_preflight(&mut self, path: PathBuf) {
        if self.preflight.contains(&path) || !self.may_watch(&path) {
            return;
        }
        let Some(refs) = self.refs.get(&path) else {
            return;
        };
        let roots: Vec<usize> = refs
            .dirs
            .iter()
            .map(|id| id.0)
            .chain(refs.aux.iter().map(|id| id.0))
            .chain(refs.roots.iter().copied())
            .collect();
        let Some(r) = roots.iter().copied().min() else {
            return;
        };
        if roots.iter().any(|r| self.shards[*r].stalled) {
            // Retried with the unwatched backoff once the root answers again.
            self.unwatched.insert(path);
            return;
        }
        let job_path = path.clone();
        let job = move |worker: &Worker| {
            let key = lister::preflight(&job_path, worker);
            Done::Preflight {
                root: r,
                path: job_path,
                key,
            }
        };
        match self.shards[r].stat.submit(&self.sink, job) {
            Ok(()) => {
                self.shards[r].preflights += 1;
                self.preflight.insert(path);
            }
            Err(error) => self.lane_failed(&error),
        }
    }

    fn try_watch(&mut self, path: PathBuf, key: DirKey) {
        if !self.may_watch(&path) {
            return;
        }
        let aux_only = self.aux_only(&path);
        match self.backend.watch(&path) {
            Ok(()) => {
                if aux_only {
                    self.aux_watched.insert(path.clone());
                }
                self.aux_capped.remove(&path);
                self.by_identity
                    .entry(key.clone())
                    .or_default()
                    .insert(path.clone());
                self.watched.insert(path.clone(), key);
                if self.unwatched.remove(&path) {
                    self.mark_physical_dirty(&path);
                }
            }
            Err(WatchError::Limit) => {
                self.enter_watch_limit();
                self.unwatched.insert(path);
            }
            Err(WatchError::NotFound) => {
                self.unwatched.insert(path);
            }
            Err(WatchError::Other(message)) => {
                if self.unwatched.insert(path.clone()) {
                    eprintln!(
                        "lumastra-watcher: cannot watch {}: {message}",
                        path.display()
                    );
                }
            }
        }
    }

    /// Watched only for symlink targets (no library directory, no root sentinel).
    fn aux_only(&self, physical: &Path) -> bool {
        self.refs
            .get(physical)
            .is_some_and(|r| r.dirs.is_empty() && r.roots.is_empty() && !r.aux.is_empty())
    }

    /// Wanted library directories that are not watched right now.
    fn unwatched_dirs(&self) -> usize {
        self.unwatched
            .iter()
            .filter(|p| self.refs.get(*p).is_some_and(|r| !r.dirs.is_empty()))
            .count()
    }

    fn enter_watch_limit(&mut self) {
        if self.watch_limit.is_none() {
            self.watch_limit = Some(Instant::now() + WATCH_LIMIT_RETRY);
            if !self.limit_retrying {
                self.limit_notice = true;
            }
        }
    }

    /// No 5 s loop against an exhausted limit: one attempt every five minutes.
    fn process_watch_limit(&mut self, now: Instant) {
        if !self.watch_limit.is_some_and(|at| at <= now) {
            return;
        }
        self.watch_limit = None;
        self.limit_retrying = true;
        let retry: Vec<PathBuf> = self.unwatched.iter().cloned().collect();
        self.watch_dirty.extend(retry);
        self.sync_watches();
        self.limit_retrying = false;
    }

    /// (watched, wanted) node directories, for the watch-limit message and status.
    fn watch_counts(&self) -> (usize, usize) {
        let mut watched = 0;
        let mut wanted = 0;
        for (path, refs) in &self.refs {
            if !refs.dirs.is_empty() {
                wanted += 1;
                if self.watched.contains_key(path) {
                    watched += 1;
                }
            }
        }
        (watched, wanted)
    }

    // ----------------------------------------------------------------------- notices

    fn flush_notices(&mut self, now: Instant, rescan: bool) {
        // Flapping directories must not turn into a rescan storm: failure notices share
        // the 5 s .. 5 min backoff (the first one follows within 250 ms).
        if rescan && !self.newly_failed.is_empty() {
            let due = *self.failure_notice_due.get_or_insert_with(|| {
                next_backoff(
                    self.last_failure_notice,
                    &mut self.failure_notice_backoff,
                    now,
                )
            });
            if due > now {
                return self.flush_other_notices(rescan);
            }
            self.failure_notice_due = None;
            self.last_failure_notice = Some(now);
        }
        let failed: Vec<Id> = mem::take(&mut self.newly_failed)
            .into_iter()
            .filter(|id| self.failures.contains_key(id))
            .collect();
        if let Some(first) = failed.first()
            && let Some(failure) = self.failures.get(first)
        {
            let message = if failed.len() == 1 {
                format!("{}: {}", first.1.display(), failure.reason)
            } else {
                format!(
                    "{} directories cannot be fully observed; first {}: {}",
                    failed.len(),
                    first.1.display(),
                    failure.reason
                )
            };
            let code = if failure.permission {
                "permission"
            } else {
                "io"
            };
            self.output.send(Message::Error {
                message,
                fatal: false,
                code: Some(code),
            });
            if rescan {
                self.output.send(Message::Rescan {
                    reason: "filesystem observation incomplete: directories cannot be listed"
                        .into(),
                });
            }
        }
        self.flush_other_notices(rescan);
    }

    fn flush_other_notices(&mut self, rescan: bool) {
        if mem::take(&mut self.limit_notice) {
            let (watched, wanted) = self.watch_counts();
            self.output.send(Message::Error {
                message: format!(
                    "raise fs.inotify.max_user_watches; {watched}/{wanted} dirs watched"
                ),
                fatal: false,
                code: Some("watch_limit"),
            });
            if rescan {
                self.output.send(Message::Rescan {
                    reason: "filesystem watch limit reached".into(),
                });
            }
        }
        for root in &mut self.roots {
            if root.non_utf8 != root.warned_non_utf8 {
                if root.non_utf8 > 0 {
                    eprintln!(
                        "lumastra-watcher: {} entries with non-UTF-8 names skipped under {}",
                        root.non_utf8,
                        root.logical.display()
                    );
                }
                root.warned_non_utf8 = root.non_utf8;
            }
        }
    }

    fn stalled_root_ids(&self) -> Vec<usize> {
        (0..self.shards.len())
            .filter(|r| self.shards[*r].stalled)
            .collect()
    }

    fn status_signature(&self) -> StatusSig {
        let unwatched = self.unwatched_dirs();
        let stalled_roots = self.stalled_root_ids();
        let stalled = self.shards.iter().any(|s| s.probe_stalled);
        StatusSig {
            partial: !self.failures.is_empty()
                || self.resolution.stalled
                || self.watch_limit.is_some()
                || unwatched > 0
                || stalled
                || !stalled_roots.is_empty(),
            unwatched,
            stalled,
            stalled_roots,
            watch_limit: self.watch_limit.is_some(),
            failed: self.failures.len(),
            sample: self
                .failures
                .keys()
                .take(FAILED_SAMPLE)
                .map(|id| id.1.clone())
                .collect(),
        }
    }

    pub fn status(&self) -> Status {
        let signature = self.status_signature();
        Status {
            coverage: if signature.partial { "partial" } else { "full" },
            watched_dirs: self.watch_counts().0,
            failed_dirs: signature.failed,
            failed_sample: signature
                .sample
                .iter()
                .filter_map(|p| p.to_str().map(str::to_string))
                .collect(),
            watch_limit: signature.watch_limit,
            unwatched_dirs: signature.unwatched,
            stalled_probes: signature.stalled,
            stalled_roots: signature
                .stalled_roots
                .iter()
                .filter_map(|r| self.roots[*r].logical.to_str().map(str::to_string))
                .collect(),
            non_utf8_skipped: self.roots.iter().map(|r| r.non_utf8).sum(),
            refused_symlinks: self.roots.iter().map(|r| r.refused).sum(),
            network_roots: self
                .roots
                .iter()
                .filter(|r| r.network)
                .filter_map(|r| r.logical.to_str().map(str::to_string))
                .collect(),
        }
    }

    fn maybe_status(&mut self, now: Instant) {
        if !self.ready {
            return;
        }
        let signature = self.status_signature();
        if self.status_sig.as_ref() != Some(&signature) {
            self.status_pending = true;
        }
        if !self.status_pending
            || self
                .status_sent
                .is_some_and(|at| now.duration_since(at) < STATUS_INTERVAL)
        {
            return;
        }
        if self.output.send(Message::Status(self.status())) {
            self.status_sent = Some(now);
            self.status_sig = Some(signature);
            self.status_pending = false;
        }
    }
}

fn mark_for_child(parent: &Mark) -> Mark {
    Mark {
        recursive: parent.recursive,
        all: parent.all,
        list: true,
        names: HashSet::new(),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{IgnoreFiles, OUTPUT_CAPACITY, Policy};
    use std::cell::RefCell;
    use std::rc::Rc;

    fn init(root: &Path) -> Init {
        Init {
            kind: "init".into(),
            version: crate::PROTOCOL_VERSION,
            paths: vec![root.to_path_buf()],
            network_paths: Vec::new(),
            network_reconcile_secs: 0,
            stability_ms: 500,
            poll_ms: 100,
            alive_ms: 10_000,
            policy: Policy {
                media_extensions: vec![".mkv".into()],
                audio_extensions: vec![".flac".into()],
                lyrics_extensions: vec![".lrc".into()],
                pruned_directory_names: vec!["extras".into()],
                pruned_directory_prefixes: vec!["@".into()],
                pruned_directory_suffixes: vec![".trickplay".into()],
                ignored_file_prefixes: vec!["._".into()],
                sample_word: "sample".into(),
                ignore_files: IgnoreFiles {
                    pattern_file: ".lumastraignore".into(),
                    marker_file: ".ignore".into(),
                    max_bytes: 65_536,
                    max_pattern_length: 512,
                    max_patterns_per_file: 1000,
                    max_accumulated_patterns: 5000,
                },
                containment_roots: vec![root.to_path_buf()],
                sensitive_prefixes: Vec::new(),
            },
        }
    }

    /// Mimics inotify: one wd per inode, and removing it kills every path sharing it.
    #[derive(Default)]
    struct FakeState {
        wd_of_inode: HashMap<u64, u32>,
        path_wd: HashMap<PathBuf, u32>,
        next: u32,
        limit: Option<usize>,
        attempts: usize,
        unwatches: usize,
        fail_paths: HashSet<PathBuf>,
    }

    impl FakeState {
        fn live(&self, path: &Path) -> bool {
            self.path_wd
                .get(path)
                .is_some_and(|wd| self.wd_of_inode.values().any(|w| w == wd))
        }
    }

    struct FakeBackend(Rc<RefCell<FakeState>>);

    impl WatchBackend for FakeBackend {
        fn watch(&mut self, path: &Path) -> Result<(), WatchError> {
            use std::os::unix::fs::MetadataExt;
            let mut state = self.0.borrow_mut();
            state.attempts += 1;
            if state.fail_paths.contains(path) {
                return Err(WatchError::Other("injected".into()));
            }
            let ino = fs::metadata(path).map_err(|_| WatchError::NotFound)?.ino();
            let wd = match state.wd_of_inode.get(&ino) {
                Some(wd) => *wd,
                None => {
                    if state.limit.is_some_and(|l| state.wd_of_inode.len() >= l) {
                        return Err(WatchError::Limit);
                    }
                    state.next += 1;
                    let wd = state.next;
                    state.wd_of_inode.insert(ino, wd);
                    wd
                }
            };
            state.path_wd.insert(path.to_path_buf(), wd);
            Ok(())
        }
        fn unwatch(&mut self, path: &Path) {
            let mut state = self.0.borrow_mut();
            state.unwatches += 1;
            if let Some(wd) = state.path_wd.remove(path) {
                state.wd_of_inode.retain(|_, w| *w != wd);
            }
        }
    }

    fn fake_engine(root: &Path) -> (Engine<FakeBackend>, Rc<RefCell<FakeState>>, Output) {
        let state = Rc::new(RefCell::new(FakeState::default()));
        let output = Output::new(OUTPUT_CAPACITY);
        let engine = Engine::new(init(root), FakeBackend(state.clone()), output.clone()).unwrap();
        (engine, state, output)
    }

    fn drain(output: &Output) -> Vec<serde_json::Value> {
        output.close();
        let mut bytes = Vec::new();
        crate::write_output(&mut bytes, output).unwrap();
        bytes
            .split(|b| *b == b'\n')
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_slice(l).unwrap())
            .collect()
    }

    #[test]
    fn rename_keeps_the_new_path_watched_when_the_old_path_is_released_later() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir_all(root.join("x/a")).unwrap();
        fs::create_dir(root.join("y")).unwrap();
        let (mut engine, state, _output) = fake_engine(&root);
        engine.initial_walk();
        assert!(state.borrow().live(&root.join("x/a")));
        fs::rename(root.join("x/a"), root.join("y/b")).unwrap();
        // The destination's listing registers b first: inotify hands it a's wd.
        engine.mark_dirty((0, root.join("y")), Mark::name("b"), Duration::ZERO);
        run(&mut engine, Instant::now() + Duration::from_secs(1));
        // Releasing a afterwards removes that shared wd; the engine must re-add b.
        engine.mark_dirty((0, root.join("x")), Mark::name("a"), Duration::ZERO);
        run(&mut engine, Instant::now() + Duration::from_secs(1));
        let state = state.borrow();
        assert!(!state.path_wd.contains_key(&root.join("x/a")));
        assert!(
            state.live(&root.join("y/b")),
            "renamed directory lost its watch"
        );
        assert!(engine.dirs.contains_key(&(0, root.join("y/b"))));
        assert!(!engine.dirs.contains_key(&(0, root.join("x/a"))));
    }

    #[test]
    fn backend_side_removal_rewatches_paths_sharing_the_inode() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir_all(root.join("x/a")).unwrap();
        fs::create_dir(root.join("y")).unwrap();
        let (mut engine, state, _output) = fake_engine(&root);
        engine.initial_walk();
        fs::rename(root.join("x/a"), root.join("y/b")).unwrap();
        engine.mark_dirty((0, root.join("y")), Mark::name("b"), Duration::ZERO);
        run(&mut engine, Instant::now() + Duration::from_secs(1));
        // notify processes MOVED_FROM x/a and drops the shared wd itself.
        {
            let mut s = state.borrow_mut();
            let wd = s.path_wd.remove(&root.join("x/a")).unwrap();
            s.wd_of_inode.retain(|_, w| *w != wd);
        }
        assert!(!state.borrow().live(&root.join("y/b")));
        let mut moved =
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From))).set_tracker(7);
        moved.paths.push(root.join("x/a"));
        engine.event(moved);
        run(&mut engine, Instant::now() + Duration::from_secs(1));
        assert!(state.borrow().live(&root.join("y/b")));
    }

    #[test]
    fn watch_limit_reports_partial_coverage_without_a_retry_loop() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        for dir in ["a", "b", "c"] {
            fs::create_dir(root.join(dir)).unwrap();
        }
        let (mut engine, state, output) = fake_engine(&root);
        state.borrow_mut().limit = Some(2);
        engine.initial_walk();
        engine.after_ready();
        let attempts = state.borrow().attempts;
        run(&mut engine, Instant::now() + Duration::from_secs(60));
        fs::create_dir(root.join("d")).unwrap();
        engine.mark_dirty((0, root.clone()), Mark::name("d"), Duration::ZERO);
        run(&mut engine, Instant::now() + Duration::from_secs(61));
        assert_eq!(
            state.borrow().attempts,
            attempts,
            "watch retried before 5 min"
        );
        let status = engine.status();
        assert_eq!(status.coverage, "partial");
        assert!(status.watch_limit);
        state.borrow_mut().limit = None;
        run(&mut engine, Instant::now() + Duration::from_secs(301));
        // The retried watches are preflighted on the lane; status follows within 5 s.
        run(&mut engine, Instant::now() + Duration::from_secs(307));
        assert!(!engine.status().watch_limit);
        assert_eq!(engine.status().watched_dirs, 5);
        let messages = drain(&output);
        let limit = messages
            .iter()
            .find(|m| m["code"] == "watch_limit")
            .expect("watch_limit error");
        let text = limit["message"].as_str().unwrap();
        assert!(
            text.starts_with("raise fs.inotify.max_user_watches; "),
            "{text}"
        );
        assert!(text.ends_with("/4 dirs watched"), "{text}");
        assert_eq!(
            messages
                .iter()
                .filter(|m| m["code"] == "watch_limit")
                .count(),
            1
        );
        // Queued status frames coalesce: the one still queued is the recovered state.
        let status = messages.iter().find(|m| m["type"] == "status").unwrap();
        assert_eq!(status["coverage"], "full");
        assert_eq!(status["watchLimit"], false);
    }

    #[test]
    fn pending_queue_is_bounded_and_overflow_requests_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let (mut engine, _state, output) = fake_engine(temp.path());
        engine.initial_walk();
        engine.after_ready();
        for i in 0..PENDING_CAPACITY + 1 {
            engine.queue_pending(
                (0, temp.path().join(format!("{i}.mkv"))),
                FileKind::Media,
                None,
            );
        }
        assert_eq!(engine.pending.len(), PENDING_CAPACITY);
        assert!(engine.full_due.is_some());
        assert!(drain(&output).iter().any(|m| m["type"] == "rescan"));
    }

    /// One tick at `at` that also waits for the lane work it started, like the
    /// synchronous engine did; work it schedules for later stays for the next tick.
    fn run(engine: &mut Engine<FakeBackend>, at: Instant) {
        let deadline = Instant::now() + Duration::from_secs(5);
        engine.tick(at);
        while !engine.idle() && Instant::now() < deadline {
            engine.wait_results(Duration::from_millis(10));
            engine.pump_all();
            engine.sync_watches();
        }
        engine.check_stall(at);
        engine.maybe_status(at);
    }

    fn settle(engine: &mut Engine<FakeBackend>, offset: Duration, output: &Output) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            engine.tick(Instant::now() + offset);
            if !engine.pending.is_empty() || !engine.idle() {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            if output.queued() > 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn network_roots_are_fully_reconciled_on_their_interval() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join("existing.mkv"), "old").unwrap();
        let state = Rc::new(RefCell::new(FakeState::default()));
        let output = Output::new(OUTPUT_CAPACITY);
        let mut config = init(&root);
        config.network_paths = vec![root.clone()];
        config.network_reconcile_secs = 60;
        let mut engine = Engine::new(config, FakeBackend(state), output.clone()).unwrap();
        engine.initial_walk();
        engine.after_ready();
        // No backend events arrive (as on NFS): only the periodic reconcile can notice.
        fs::remove_file(root.join("existing.mkv")).unwrap();
        fs::write(root.join("new.mkv"), "new").unwrap();
        run(&mut engine, Instant::now() + Duration::from_secs(30));
        assert!(engine.files.contains_key(&(0, root.join("existing.mkv"))));
        settle(&mut engine, Duration::from_secs(61), &output);
        settle(&mut engine, Duration::from_secs(62), &output);
        let messages = drain(&output);
        let has = |event: &str, name: &str| {
            messages.iter().any(|m| {
                m["type"] == "event"
                    && m["event"] == event
                    && m["path"] == root.join(name).to_str().unwrap()
            })
        };
        assert!(has("unlink", "existing.mkv"), "{messages:?}");
        assert!(has("add", "new.mkv"), "{messages:?}");
        assert_eq!(messages[0]["networkRoots"][0], root.to_str().unwrap());
    }

    #[test]
    fn kernel_rescan_reconciles_missed_events_and_prunes_junk() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join("existing.mkv"), "old").unwrap();
        fs::write(root.join("cover.jpg"), "image").unwrap();
        fs::create_dir(root.join("@eaDir")).unwrap();
        fs::write(root.join("@eaDir/junk.mkv"), "junk").unwrap();
        let (mut engine, _state, output) = fake_engine(&root);
        engine.initial_walk();
        engine.after_ready();
        assert_eq!(engine.files.len(), 1);
        assert!(!engine.dirs.contains_key(&(0, root.join("@eaDir"))));
        fs::remove_file(root.join("existing.mkv")).unwrap();
        fs::write(root.join("new.mkv"), "new").unwrap();
        engine.event(Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan));
        settle(&mut engine, Duration::from_secs(2), &output);
        settle(&mut engine, Duration::from_secs(3), &output);
        let messages = drain(&output);
        let rescan = messages.iter().position(|m| m["type"] == "rescan").unwrap();
        let unlink = messages
            .iter()
            .position(|m| m["event"] == "unlink")
            .unwrap();
        assert!(rescan < unlink);
        assert!(
            messages
                .iter()
                .any(|m| m["event"] == "add" && m["path"] == root.join("new.mkv").to_str().unwrap())
        );
    }

    fn file_event(path: &Path) -> String {
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn directory_moved_out_and_linked_back_keeps_its_inode_but_fails_containment() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let root = base.join("library");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/x.mkv"), "x").unwrap();
        fs::write(root.join("keep.mkv"), "k").unwrap();
        let (mut engine, _state, output) = fake_engine(&root);
        engine.initial_walk();
        engine.after_ready();
        fs::rename(root.join("a"), base.join("outside")).unwrap();
        symlink(base.join("outside"), root.join("a")).unwrap();
        // Same inode as before; only the canonical path shows it left the root.
        engine.mark_dirty((0, root.join("a")), Mark::all(), Duration::ZERO);
        run(&mut engine, Instant::now() + Duration::from_secs(1));
        run(&mut engine, Instant::now() + Duration::from_secs(2));
        assert!(!engine.dirs.contains_key(&(0, root.join("a"))));
        let messages = drain(&output);
        assert!(
            messages
                .iter()
                .any(|m| m["event"] == "unlink" && m["path"] == file_event(&root.join("a/x.mkv")))
        );
    }

    #[test]
    fn kernel_overflow_reregisters_every_watch() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir(root.join("a")).unwrap();
        let (mut engine, state, _output) = fake_engine(&root);
        engine.initial_walk();
        let attempts = state.borrow().attempts;
        engine.event(Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan));
        run(&mut engine, Instant::now() + Duration::from_secs(1));
        let state = state.borrow();
        assert!(state.unwatches >= 3, "{}", state.unwatches);
        assert!(state.attempts >= attempts + 3);
        assert!(state.live(&root.join("a")));
    }

    /// Occupies a lane like a call into a hung mount until the sender is dropped.
    fn block(lane: &mut Lane, sink: &Sink, done: Done) -> mpsc::Sender<()> {
        let (release, wait) = mpsc::channel::<()>();
        lane.submit(sink, move |_: &Worker| {
            let _ = wait.recv();
            done
        })
        .unwrap();
        release
    }

    /// A harmless stat-lane result.
    fn nothing(root: usize) -> Done {
        Done::Preflight {
            root,
            path: PathBuf::from("/nonexistent/preflight"),
            key: None,
        }
    }

    #[test]
    fn stalled_stat_marks_coverage_partial_and_reports_once() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let (mut engine, _state, output) = fake_engine(&root);
        engine.initial_walk();
        engine.after_ready();
        engine.stall_after = Duration::from_millis(50);
        let release = block(&mut engine.shards[0].stat, &engine.sink, nothing(0));
        std::thread::sleep(Duration::from_millis(80));
        let now = Instant::now();
        engine.tick(now);
        engine.tick(now + Duration::from_secs(1));
        let status = engine.status();
        assert!(status.stalled_probes);
        assert_eq!(
            status.stalled_roots,
            vec![root.to_str().unwrap().to_string()]
        );
        assert_eq!(status.coverage, "partial");
        drop(release);
        // The blocked job's (stray) result arrives; the root answers again.
        std::thread::sleep(Duration::from_millis(20));
        engine.tick(now + Duration::from_secs(2));
        engine.tick(now + Duration::from_secs(3));
        assert!(engine.status().stalled_roots.is_empty());
        let messages = drain(&output);
        let stalls = messages
            .iter()
            .filter(|m| m["type"] == "error" && m["code"] == "io")
            .count();
        assert_eq!(stalls, 1);
        assert!(
            messages.iter().any(|m| m["type"] == "rescan"),
            "{messages:?}"
        );
    }

    #[test]
    fn a_hung_resolution_does_not_block_the_other_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let state = Rc::new(RefCell::new(FakeState::default()));
        let output = Output::new(OUTPUT_CAPACITY);
        let mut config = init(&root);
        config.policy.sensitive_prefixes = vec![root.join("secret")];
        let mut engine = Engine::new(config, FakeBackend(state), output).unwrap();
        engine.stall_after = Duration::from_millis(50);
        // The shared lane (sensitive prefixes) is stuck; the root's own lane is not.
        let release = block(&mut engine.resolution.lane, &engine.sink, nothing(0));
        engine.initial_walk();
        assert!(engine.resolution.real_roots.iter().all(Option::is_some));
        assert!(engine.resolution.busy_sensitive[0]);
        assert!(engine.containment.sensitive(Path::new("/anything")));
        // initial_walk stops waiting after stall_after (50 ms); on a loaded runner the root
        // lanes may not have answered yet, and a busy root is (correctly) not asked again.
        let deadline = Instant::now() + Duration::from_secs(5);
        while engine.resolution.busy_roots.iter().any(|b| *b) && Instant::now() < deadline {
            engine.wait_results(Duration::from_millis(10));
        }
        assert!(engine.resolution.busy_roots.iter().all(|b| !*b));
        // A refresh asks the finished paths again but not the hung one.
        let before = engine.resolution.outstanding;
        engine.request_containment();
        assert_eq!(
            engine.resolution.outstanding,
            before + engine.resolution.roots.len()
        );
        run(&mut engine, Instant::now() + Duration::from_secs(1));
        assert!(engine.status().coverage == "partial");
        drop(release);
        let deadline = Instant::now() + Duration::from_secs(5);
        while engine.resolution.outstanding > 0 && Instant::now() < deadline {
            engine.wait_results(Duration::from_millis(10));
        }
        assert!(!engine.containment.sensitive(Path::new("/anything")));
    }

    #[test]
    fn the_initial_walk_queues_at_most_one_wake() {
        use std::sync::atomic::AtomicUsize;
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        for i in 0..50 {
            fs::create_dir(root.join(format!("d{i}"))).unwrap();
        }
        let (mut engine, _state, _output) = fake_engine(&root);
        // Nothing reads the raw queue during the walk: wakes would only displace events.
        let wakes = Arc::new(AtomicUsize::new(0));
        let counter = wakes.clone();
        engine.set_waker(Arc::new(move || {
            counter.fetch_add(1, Ordering::AcqRel);
            true
        }));
        engine.initial_walk();
        assert_eq!(engine.dirs.len(), 51);
        assert!(wakes.load(Ordering::Acquire) <= 1);
    }

    #[test]
    fn a_panicking_lane_job_is_fatal() {
        let temp = tempfile::tempdir().unwrap();
        let (mut engine, _state, _output) = fake_engine(temp.path());
        engine.initial_walk();
        engine.shards[0]
            .stat
            .submit(&engine.sink, |_: &Worker| -> Done { panic!("lane bug") })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while engine.fatal().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
            engine.tick(Instant::now());
        }
        assert_eq!(engine.fatal(), Some("a filesystem worker failed"));
    }

    #[test]
    fn a_hung_root_does_not_hold_back_another_root() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let (healthy, hung) = (base.join("healthy"), base.join("hung"));
        fs::create_dir(&healthy).unwrap();
        fs::create_dir(&hung).unwrap();
        let state = Rc::new(RefCell::new(FakeState::default()));
        let output = Output::new(OUTPUT_CAPACITY);
        let mut config = init(&healthy);
        config.paths.push(hung.clone());
        let mut engine = Engine::new(config, FakeBackend(state), output.clone()).unwrap();
        engine.stall_after = Duration::from_millis(50);
        // Both lanes of the hung root are stuck before the initial walk starts.
        // (The walk lane's stray result is never applied: the test ends first.)
        let walk = block(
            &mut engine.shards[1].walk,
            &engine.sink,
            Done::Owner {
                root: 1,
                live: true,
            },
        );
        let stat = block(&mut engine.shards[1].stat, &engine.sink, nothing(1));
        let started = Instant::now();
        engine.initial_walk();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(engine.stalled_roots(), 1);
        assert!(engine.dirs.contains_key(&(0, healthy.clone())));
        engine.after_ready();
        fs::write(healthy.join("new.mkv"), "x").unwrap();
        engine.mark_dirty((0, healthy.clone()), Mark::name("new.mkv"), Duration::ZERO);
        settle(&mut engine, Duration::from_secs(1), &output);
        settle(&mut engine, Duration::from_secs(2), &output);
        let messages = drain(&output);
        assert!(
            messages
                .iter()
                .any(|m| m["event"] == "add"
                    && m["path"] == healthy.join("new.mkv").to_str().unwrap()),
            "{messages:?}"
        );
        let status = messages
            .iter()
            .rev()
            .find(|m| m["type"] == "status")
            .unwrap();
        assert_eq!(status["stalledRoots"][0], hung.to_str().unwrap());
        drop((walk, stat));
    }

    #[test]
    fn coalescer_admits_one_queued_write_per_path_and_drops_access() {
        let coalescer = ModifyCoalescer::new();
        let (sender, receiver) = mpsc::sync_channel(16);
        let overflow = AtomicBool::new(false);
        let write = || {
            let mut event = Event::new(EventKind::Modify(ModifyKind::Data(
                notify::event::DataChange::Any,
            )));
            event.paths.push(PathBuf::from("/media/a.mkv"));
            Ok(event)
        };
        for _ in 0..5 {
            offer_raw(&sender, &overflow, &coalescer, write());
        }
        let mut open = Event::new(EventKind::Access(AccessKind::Open(AccessMode::Any)));
        open.paths.push(PathBuf::from("/media/a.mkv"));
        offer_raw(&sender, &overflow, &coalescer, Ok(open));
        let queued: Vec<_> = receiver.try_iter().collect();
        assert_eq!(queued.len(), 1);
        coalescer.release(&queued[0]);
        offer_raw(&sender, &overflow, &coalescer, write());
        assert_eq!(receiver.try_iter().count(), 1);
        assert!(!overflow.load(Ordering::Acquire));
    }

    #[test]
    fn raw_queue_overflow_latches_reconciliation() {
        let coalescer = ModifyCoalescer::new();
        let (sender, receiver) = mpsc::sync_channel(1);
        let overflow = AtomicBool::new(false);
        offer_raw(
            &sender,
            &overflow,
            &coalescer,
            Ok(Event::new(EventKind::Any)),
        );
        offer_raw(
            &sender,
            &overflow,
            &coalescer,
            Ok(Event::new(EventKind::Any)),
        );
        assert!(overflow.load(Ordering::Acquire));
        assert_eq!(receiver.try_iter().count(), 1);
    }

    #[test]
    fn flapping_failures_do_not_cause_a_rescan_storm() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let (mut engine, _state, output) = fake_engine(&root);
        engine.initial_walk();
        engine.after_ready();
        let start = Instant::now();
        for round in 0..20u64 {
            let id = (0, root.join(format!("d{round}")));
            engine.fail(&id, "flap".into(), false);
            engine.clear_failure(&id);
            engine.fail(&id, "flap".into(), false);
            run(
                &mut engine,
                start + Duration::from_millis(300 * (round + 1)),
            );
            engine.clear_failure(&id);
        }
        let rescans = drain(&output)
            .iter()
            .filter(|m| m["type"] == "rescan")
            .count();
        assert!(rescans <= 2, "{rescans} rescans in 6 s");
    }

    #[test]
    fn unwatched_directories_count_as_partial_and_are_retried() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir(root.join("a")).unwrap();
        let (mut engine, state, _output) = fake_engine(&root);
        state.borrow_mut().fail_paths.insert(root.join("a"));
        engine.initial_walk();
        engine.after_ready();
        let status = engine.status();
        assert_eq!(status.unwatched_dirs, 1);
        assert_eq!(status.coverage, "partial");
        state.borrow_mut().fail_paths.clear();
        let now = Instant::now();
        run(&mut engine, now + Duration::from_secs(1));
        assert_eq!(
            engine.status().unwatched_dirs,
            1,
            "retried before the backoff"
        );
        run(&mut engine, now + Duration::from_secs(7));
        assert_eq!(engine.status().unwatched_dirs, 0);
        assert!(state.borrow().live(&root.join("a")));
        assert_eq!(engine.status().coverage, "full");
    }

    #[test]
    fn symlink_target_watches_outside_the_library_are_capped() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let root = base.join("library");
        fs::create_dir(&root).unwrap();
        for name in ["one", "two", "three"] {
            fs::create_dir(base.join(name)).unwrap();
            fs::write(base.join(name).join("film.bin"), name).unwrap();
            symlink(
                base.join(name).join("film.bin"),
                root.join(format!("{name}.mkv")),
            )
            .unwrap();
        }
        let (mut engine, state, _output) = fake_engine(&root);
        engine.aux_cap = 2;
        engine.initial_walk();
        assert_eq!(engine.files.len(), 3);
        assert_eq!(engine.aux_watched.len(), 2);
        assert_eq!(engine.aux_capped.len(), 1);
        assert!(state.borrow().live(&root));
        assert_eq!(engine.status().coverage, "full");
    }
}

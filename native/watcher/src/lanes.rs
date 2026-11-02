// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Filesystem calls off the main loop. Each library root has its own lanes (one thread for
//! directory work, one for stats), so a hung mount stalls only the root it belongs to: the
//! main loop keeps taking events for the other roots and keeps sending `alive`.
//!
//! A lane runs its jobs in order and records progress after every filesystem call. A lane
//! with work but no progress for the stall deadline is reported as stalled; its thread
//! stays blocked in the kernel (it cannot be cancelled) and resumes when the mount answers.

use crate::lister::{DirKey, Inspected};
use crate::probe::ProbeResult;
use std::io;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

const LANE_STACK: usize = 512 * 1024;

/// Wakes the main loop; false when the wake could not be queued.
pub type Waker = Arc<dyn Fn() -> bool + Send + Sync>;

/// A finished lane job.
pub(crate) enum Done {
    Inspect {
        root: usize,
        inspected: Inspected,
    },
    /// Whether the directory that first claimed an identity still has it.
    Owner {
        root: usize,
        live: bool,
    },
    Probe(ProbeResult),
    /// A watch candidate stat'ed right before registration; None = not inspectable.
    Preflight {
        root: usize,
        path: PathBuf,
        key: Option<DirKey>,
    },
    /// The real path of a containment root (`sensitive == false`) or sensitive prefix.
    Resolved {
        lane: Option<usize>,
        sensitive: bool,
        index: usize,
        real: Option<PathBuf>,
    },
}

/// Shared by every lane: where results go and how the main loop is woken.
pub(crate) struct Sink {
    results: mpsc::Sender<Done>,
    wake: Option<Waker>,
    wake_pending: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    /// A lane job panicked: its root would wait for that result forever.
    panicked: Arc<AtomicBool>,
    epoch: Instant,
    hang: Option<PathBuf>,
}

impl Sink {
    pub fn new() -> (Self, mpsc::Receiver<Done>) {
        let (results, receiver) = mpsc::channel();
        let sink = Self {
            results,
            wake: None,
            wake_pending: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(AtomicBool::new(false)),
            panicked: Arc::new(AtomicBool::new(false)),
            epoch: Instant::now(),
            hang: test_hang(),
        };
        (sink, receiver)
    }

    pub fn set_waker(&mut self, waker: Waker) {
        self.wake = Some(waker);
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }

    pub fn panicked(&self) -> bool {
        self.panicked.load(Ordering::Acquire)
    }

    /// Called by the main loop before it drains results, so a later result wakes it again.
    pub fn rearm(&self) {
        self.wake_pending.store(false, Ordering::Release);
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn worker(&self, progress: Arc<AtomicU64>) -> Worker {
        Worker {
            progress,
            epoch: self.epoch,
            stop: self.stop.clone(),
            hang: self.hang.clone(),
        }
    }

    fn deliver(
        results: &mpsc::Sender<Done>,
        wake: Option<&Waker>,
        pending: &AtomicBool,
        done: Done,
    ) -> bool {
        if results.send(done).is_err() {
            return false;
        }
        // At most one wake is queued; the main loop drains every result per wake.
        if !pending.swap(true, Ordering::AcqRel) && !wake.is_some_and(|w| w()) {
            pending.store(false, Ordering::Release);
        }
        true
    }
}

/// Debug builds only: `LUMASTRA_WATCHER_TEST_HANG=<dir>` makes every lane job for a path
/// under `<dir>` block while `<dir>.hang` exists, like a call into a hung mount. The bridge
/// starts the child with PATH and LANG only, and release builds ignore the variable.
fn test_hang() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        std::env::var_os("LUMASTRA_WATCHER_TEST_HANG").map(PathBuf::from)
    } else {
        None
    }
}

/// The lane side of a job: progress reporting and the stop flag.
pub(crate) struct Worker {
    progress: Arc<AtomicU64>,
    epoch: Instant,
    stop: Arc<AtomicBool>,
    hang: Option<PathBuf>,
}

impl Worker {
    /// A filesystem call returned.
    pub fn progress(&self) {
        let now = u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.progress.store(now, Ordering::Release);
    }

    pub fn stopping(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }

    /// Start of a job on `path`. Only the debug test hook ever blocks here.
    pub fn enter(&self, path: &Path) {
        if let Some(prefix) = &self.hang
            && path.starts_with(prefix)
        {
            let mut flag = prefix.clone().into_os_string();
            flag.push(".hang");
            let flag = PathBuf::from(flag);
            while flag.exists() && !self.stopping() {
                thread::sleep(Duration::from_millis(20));
            }
        }
        self.progress();
    }
}

type Job = Box<dyn FnOnce(&Worker) -> Done + Send>;

/// One worker thread, started on first use, running jobs in submission order.
pub(crate) struct Lane {
    name: String,
    sender: Option<mpsc::Sender<Job>>,
    progress: Arc<AtomicU64>,
    busy: usize,
}

impl Lane {
    pub fn new(name: String) -> Self {
        Self {
            name,
            sender: None,
            progress: Arc::new(AtomicU64::new(0)),
            busy: 0,
        }
    }

    pub fn submit(
        &mut self,
        sink: &Sink,
        job: impl FnOnce(&Worker) -> Done + Send + 'static,
    ) -> io::Result<()> {
        if self.sender.is_none() {
            let (sender, jobs) = mpsc::channel::<Job>();
            let worker = sink.worker(self.progress.clone());
            let results = sink.results.clone();
            let wake = sink.wake.clone();
            let pending = sink.wake_pending.clone();
            let panicked = sink.panicked.clone();
            thread::Builder::new()
                .name(self.name.clone())
                .stack_size(LANE_STACK)
                .spawn(move || {
                    for job in jobs {
                        let Ok(done) = panic::catch_unwind(AssertUnwindSafe(|| job(&worker)))
                        else {
                            panicked.store(true, Ordering::Release);
                            if let Some(wake) = &wake {
                                wake();
                            }
                            break;
                        };
                        worker.progress();
                        if !Sink::deliver(&results, wake.as_ref(), &pending, done) {
                            break;
                        }
                    }
                })?;
            self.sender = Some(sender);
        }
        if self.busy == 0 {
            // An idle lane's last progress is old; the deadline starts with this job.
            self.progress.store(sink.now_ms(), Ordering::Release);
        }
        let sent = self
            .sender
            .as_ref()
            .is_some_and(|sender| sender.send(Box::new(job)).is_ok());
        if !sent {
            self.sender = None;
            return Err(io::Error::other(format!("{} stopped", self.name)));
        }
        self.busy += 1;
        Ok(())
    }

    /// A result of this lane arrived.
    pub fn done(&mut self) {
        self.busy = self.busy.saturating_sub(1);
    }

    #[cfg(test)]
    pub fn busy(&self) -> bool {
        self.busy > 0
    }

    /// Work is queued but no filesystem call returned for `limit`.
    pub fn stalled(&self, sink: &Sink, limit: Duration) -> bool {
        let last = self.progress.load(Ordering::Acquire);
        self.busy > 0
            && sink.now_ms().saturating_sub(last)
                >= u64::try_from(limit.as_millis()).unwrap_or(u64::MAX)
    }
}

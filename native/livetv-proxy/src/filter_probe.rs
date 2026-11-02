// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Process-owned HDR filter discovery. A cancelled HTTP waiter does not cancel the
//! shared probe; explicit shutdown cancels, kills and reaps its one bounded child.
use std::{
    collections::BTreeSet,
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::{Mutex, watch},
    task::JoinHandle,
};

pub const PROBE_FAILURE_TTL_MS: i64 = 60_000;
const MAX_PROBE_BYTES: usize = 4 * 1024 * 1024;
type Filters = Arc<BTreeSet<String>>;
type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
#[derive(Clone, Copy)]
pub struct ProbeLimits {
    pub timeout: Duration,
    pub max_bytes: usize,
}
impl Default for ProbeLimits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(10),
            max_bytes: MAX_PROBE_BYTES,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeError {
    Spawn {
        kind: std::io::ErrorKind,
        code: Option<i32>,
    },
    Read,
    OutputTooLarge,
    TimedOut,
    Cancelled,
    FailedExit,
}
struct Flight {
    id: u64,
    result: watch::Receiver<Option<Filters>>,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}
#[derive(Default)]
struct Cache {
    filters: Option<Filters>,
    failed_at: Option<i64>,
    last_failure: Option<ProbeError>,
    flight: Option<Flight>,
    generation: u64,
    closed: bool,
}
struct Inner {
    cache: Mutex<Cache>,
    clock: Clock,
    limits: ProbeLimits,
}
pub struct HdrFilterProbe {
    inner: Arc<Inner>,
}
impl Default for HdrFilterProbe {
    fn default() -> Self {
        Self::new(
            Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
                    .unwrap_or(0)
            }),
            ProbeLimits::default(),
        )
    }
}
impl HdrFilterProbe {
    pub fn new(clock: Clock, limits: ProbeLimits) -> Self {
        Self {
            inner: Arc::new(Inner {
                cache: Mutex::new(Cache::default()),
                clock,
                limits,
            }),
        }
    }
    pub async fn filters(&self, path: &str) -> Filters {
        let (id, mut result) = {
            let mut cache = self.inner.cache.lock().await;
            if cache.closed {
                return Arc::default();
            }
            if let Some(filters) = &cache.filters {
                return filters.clone();
            }
            if cache
                .failed_at
                .is_some_and(|at| (self.inner.clock)().saturating_sub(at) < PROBE_FAILURE_TTL_MS)
            {
                return Arc::default();
            }
            if let Some(flight) = &cache.flight {
                (flight.id, flight.result.clone())
            } else {
                cache.generation = cache.generation.wrapping_add(1);
                let id = cache.generation;
                let (tx, result) = watch::channel(None);
                let (stop, cancel) = watch::channel(false);
                let inner = self.inner.clone();
                let path = path.to_owned();
                let task = tokio::spawn(async move {
                    let outcome = run_probe(&path, inner.limits, cancel).await;
                    let published = {
                        let mut cache = inner.cache.lock().await;
                        cache.last_failure = outcome.as_ref().err().copied();
                        let filters = match outcome {
                            Ok(filters) if !cache.closed => {
                                let filters = Arc::new(filters);
                                cache.filters = Some(filters.clone());
                                filters
                            }
                            _ => {
                                cache.failed_at = Some((inner.clock)());
                                Arc::default()
                            }
                        };
                        cache.flight = None;
                        filters
                    };
                    let _ = tx.send(Some(published));
                });
                cache.flight = Some(Flight {
                    id,
                    result: result.clone(),
                    stop,
                    task,
                });
                (id, result)
            }
        };
        loop {
            let ready = result.borrow().clone();
            if let Some(filters) = ready {
                return filters;
            }
            if result.changed().await.is_err() {
                // A failed worker must not leave an eternally cached in-flight flag.
                let mut cache = self.inner.cache.lock().await;
                if cache.flight.as_ref().is_some_and(|f| f.id == id) {
                    cache.flight = None;
                    cache.failed_at = Some((self.inner.clock)());
                }
                return Arc::default();
            }
        }
    }
    pub async fn last_failure(&self) -> Option<ProbeError> {
        self.inner.cache.lock().await.last_failure
    }
    pub async fn close(&self) {
        let flight = {
            let mut cache = self.inner.cache.lock().await;
            cache.closed = true;
            cache.flight.take()
        };
        if let Some(flight) = flight {
            let _ = flight.stop.send(true);
            let _ = flight.task.await;
        }
    }
}
pub fn parse_filters(stdout: &[u8]) -> BTreeSet<String> {
    String::from_utf8_lossy(stdout)
        .split('\n')
        .filter_map(|line| {
            crate::js::trim(line)
                .split(crate::js::whitespace)
                .filter(|s| !s.is_empty())
                .nth(1)
        })
        .filter(|name| matches!(*name, "tonemapx" | "tonemap_vaapi" | "scale_vaapi"))
        .map(String::from)
        .collect()
}
async fn read_bounded(reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, ProbeError> {
    let mut bytes = Vec::new();
    reader
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ProbeError::Read)?;
    if bytes.len() > limit {
        Err(ProbeError::OutputTooLarge)
    } else {
        Ok(bytes)
    }
}
async fn run_probe(
    path: &str,
    limits: ProbeLimits,
    mut cancel: watch::Receiver<bool>,
) -> Result<BTreeSet<String>, ProbeError> {
    if *cancel.borrow() {
        return Err(ProbeError::Cancelled);
    }
    let mut child = Command::new(path)
        .args(["-hide_banner", "-filters"])
        .env_clear()
        .envs(crate::config::process_child_environment())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| ProbeError::Spawn {
            kind: error.kind(),
            code: error.raw_os_error(),
        })?;
    let (stdout, stderr) = match (child.stdout.take(), child.stderr.take()) {
        (Some(stdout), Some(stderr)) => (stdout, stderr),
        _ => {
            let _ = child.kill().await;
            return Err(ProbeError::Read);
        }
    };
    let outcome = {
        let work = async {
            let (stdout, _, status) = tokio::try_join!(
                read_bounded(stdout, limits.max_bytes),
                read_bounded(stderr, limits.max_bytes),
                async { child.wait().await.map_err(|_| ProbeError::Read) }
            )?;
            if !status.success() {
                return Err(ProbeError::FailedExit);
            }
            Ok(parse_filters(&stdout))
        };
        tokio::select! {
            result=work=>result,
            _=tokio::time::sleep(limits.timeout)=>Err(ProbeError::TimedOut),
            _=cancel.changed()=>Err(ProbeError::Cancelled),
        }
    };
    if outcome.is_err() {
        // kill() waits/reaps, unlike start_kill(). Keep the explicit await even
        // after a stream error or timeout so a slot is not released before exit.
        let _ = child.kill().await;
    }
    outcome
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicI64, AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    // A fork in another fixture can inherit a briefly open executable writer FD
    // before close-on-exec runs, making this fixture's exec fail with ETXTBSY.
    // Own the entire fixture lifetime; concurrent callers within one probe still
    // run concurrently. Production process creation has no serialization/retry.
    static EXECUTABLE_FIXTURES: Mutex<()> = Mutex::const_new(());
    struct Temp {
        path: PathBuf,
        _exclusive: tokio::sync::MutexGuard<'static, ()>,
    }
    impl Temp {
        async fn new() -> Self {
            let exclusive = EXECUTABLE_FIXTURES.lock().await;
            let path = std::env::temp_dir().join(format!(
                "native-filter-probe-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self {
                path,
                _exclusive: exclusive,
            }
        }
        fn script(&self, text: &str) -> String {
            let path = self.path.join("ffmpeg");
            std::fs::write(
                &path,
                format!(
                    "#!/bin/sh\nif [ \"${{1:-}}\" = --native-fixture-ready ]; then exit 0; fi\n{text}\n"
                ),
            )
            .unwrap();
            crate::test_support::seal_executable(&path, 0o700);
            // Another test's fork can briefly inherit this fixture's writer FD
            // before CLOEXEC closes it. Publish readiness only after an actual
            // exec succeeds; no later fork can inherit our already-closed FD.
            // This preparation mode exits before PID files, sleeps, or output.
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                match std::process::Command::new(&path)
                    .arg("--native-fixture-ready")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                {
                    Ok(status) => {
                        assert!(
                            status.success(),
                            "filter fixture readiness failed: {status}"
                        );
                        break;
                    }
                    Err(error)
                        if error.raw_os_error() == Some(26)
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("filter fixture was not executable: {error}"),
                }
            }
            path.to_string_lossy().into_owned()
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
    fn limits() -> ProbeLimits {
        ProbeLimits {
            timeout: Duration::from_secs(2),
            max_bytes: 4096,
        }
    }
    #[tokio::test]
    async fn concurrent_waiters_share_one_successful_probe_and_cache_even_empty_support() {
        let temp = Temp::new().await;
        let marker = temp.path.join("runs");
        let path=temp.script(&format!("printf 1 >> '{}'\nprintf ' T.. tonemapx V->V\\n ... scale_vaapi V->V\\n ... irrelevant V->V\\n'",marker.display()));
        let probe = HdrFilterProbe::new(Arc::new(|| 0), limits());
        let (a, b, c) = tokio::join!(
            probe.filters(&path),
            probe.filters(&path),
            probe.filters(&path)
        );
        assert_eq!(probe.last_failure().await, None);
        assert_eq!(
            *a,
            BTreeSet::from(["tonemapx".into(), "scale_vaapi".into()])
        );
        assert_eq!(a, b);
        assert_eq!(b, c);
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "1");
        let changed = temp.script("exit 1");
        assert_eq!(probe.filters(&changed).await, a);
        probe.close().await;
        assert!(probe.filters(&path).await.is_empty());
        let empty = HdrFilterProbe::new(Arc::new(|| 0), limits());
        let path = temp.script("exit 0");
        assert!(empty.filters(&path).await.is_empty());
        temp.script("printf ' T.. tonemapx V->V\\n'");
        assert!(empty.filters(&path).await.is_empty());
        empty.close().await;
    }
    #[tokio::test]
    async fn a_cancelled_waiter_does_not_cancel_the_shared_child() {
        let temp = Temp::new().await;
        let marker = temp.path.join("runs");
        let release = temp.path.join("release");
        let path = temp.script(&format!(
            "printf 1 >> '{}'\nwhile [ ! -f '{}' ]; do :; done\nprintf ' T.. tonemapx V->V\\n'",
            marker.display(),
            release.display()
        ));
        let probe = Arc::new(HdrFilterProbe::new(Arc::new(|| 0), limits()));
        let caller = probe.clone();
        let first_path = path.clone();
        let first = tokio::spawn(async move { caller.filters(&first_path).await });
        let started = tokio::time::timeout(Duration::from_secs(3), async {
            while !marker.exists() && !first.is_finished() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await;
        assert!(
            started.is_ok() && marker.exists(),
            "probe did not start: waiter finished={}, failure={:?}",
            first.is_finished(),
            probe.inner.cache.lock().await.last_failure
        );
        first.abort();
        let _ = first.await;
        std::fs::write(release, []).unwrap();
        assert!(
            probe.filters(&path).await.contains("tonemapx"),
            "shared probe failed: {:?}",
            probe.last_failure().await
        );
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "1");
        probe.close().await;
    }
    #[tokio::test]
    async fn failed_probe_retries_only_after_exact_failure_ttl() {
        let temp = Temp::new().await;
        let path = temp.script("exit 1");
        let clock = Arc::new(AtomicI64::new(0));
        let now = clock.clone();
        let probe = HdrFilterProbe::new(Arc::new(move || now.load(Ordering::SeqCst)), limits());
        assert!(probe.filters(&path).await.is_empty());
        temp.script("printf ' T.. tonemapx V->V\\n'");
        clock.store(59_999, Ordering::SeqCst);
        assert!(probe.filters(&path).await.is_empty());
        clock.store(60_000, Ordering::SeqCst);
        assert!(
            probe.filters(&path).await.contains("tonemapx"),
            "retry probe failed: {:?}",
            probe.last_failure().await
        );
        probe.close().await;
    }
    #[tokio::test]
    async fn timeout_and_oversized_output_are_bounded_and_children_reaped() {
        let temp = Temp::new().await;
        let pidfile = temp.path.join("pid");
        for (script, expected) in [
            ("exec sleep 30", ProbeError::TimedOut),
            (
                "while :; do printf '0123456789012345678901234567890123456789012345678901234567890123456789'; done",
                ProbeError::OutputTooLarge,
            ),
        ] {
            let path = temp.script(&format!(
                "printf '%s' \"$$\" > '{}'\n{script}",
                pidfile.display()
            ));
            let (_stop, cancel) = watch::channel(false);
            // The timeout includes OS startup of a newly written executable;
            // macOS can spend more than 100 ms before the shell writes its PID.
            // Keep a bounded startup budget while the sleeping child still runs
            // far longer, so timeout and actual reaping remain observable.
            let started = std::time::Instant::now();
            assert_eq!(
                run_probe(
                    &path,
                    ProbeLimits {
                        timeout: Duration::from_secs(2),
                        max_bytes: 128
                    },
                    cancel
                )
                .await,
                Err(expected)
            );
            // Well below the 30 s sleeper: the 2 s probe limit ended it, even on a loaded host.
            assert!(started.elapsed() < Duration::from_secs(15));
            let pid = std::fs::read_to_string(&pidfile).unwrap();
            let alive = std::process::Command::new("kill")
                .args(["-0", &pid])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(!alive, "filter child was not reaped");
        }
    }
    #[tokio::test]
    async fn shutdown_cancels_shared_probe_and_reaps_child() {
        let temp = Temp::new().await;
        let pidfile = temp.path.join("pid");
        let path = temp.script(&format!(
            "printf '%s' \"$$\" > '{}'\nexec sleep 30",
            pidfile.display()
        ));
        let probe = Arc::new(HdrFilterProbe::new(Arc::new(|| 0), limits()));
        let caller = probe.clone();
        let request = tokio::spawn(async move { caller.filters(&path).await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !pidfile.exists() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        probe.close().await;
        assert!(request.await.unwrap().is_empty());
        let pid = std::fs::read_to_string(pidfile).unwrap();
        assert!(
            !std::process::Command::new("kill")
                .args(["-0", &pid])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        );
    }
}

// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Host and process figures for the cluster heartbeat, read from procfs and the
//! cgroup v2 mount. Display only and fail-soft: an unreadable file omits its field,
//! so macOS, bare metal and cgroup v1 simply publish less.
use crate::config::Environment;
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// USER_HZ. Linux reports /proc/<pid>/stat times in these on every supported arch.
const CLOCK_TICKS_PER_SECOND: f64 = 100.0;
/// Bounds on the GPU scan of the proxy's children, so a large process table cannot
/// slow the heartbeat down.
const MAX_GPU_PIDS: usize = 64;
const MAX_FDS_PER_PID: usize = 256;

fn non_empty(value: Option<&String>) -> Option<String> {
    value
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// Kibibyte `Key:   123 kB` lines of /proc/meminfo or /proc/self/status, in bytes.
fn kib_field(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let (name, rest) = line.split_once(':')?;
        if name.trim() != key {
            return None;
        }
        rest.split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()?
            .checked_mul(1024)
    })
}

pub fn parse_meminfo(text: &str) -> (Option<u64>, Option<u64>) {
    (kib_field(text, "MemTotal"), kib_field(text, "MemAvailable"))
}

pub fn parse_vm_rss(status: &str) -> Option<u64> {
    kib_field(status, "VmRSS")
}

pub fn parse_loadavg(text: &str) -> Option<[f64; 3]> {
    let mut fields = text.split_whitespace().map(|v| v.parse::<f64>().ok());
    Some([fields.next()??, fields.next()??, fields.next()??])
}

/// utime + stime from /proc/self/stat. The command name may contain spaces and
/// parentheses, so fields are counted from the LAST ')'.
pub fn parse_cpu_ticks(stat: &str) -> Option<u64> {
    let after = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = after.split_whitespace().collect();
    // After the name, field 3 (state) is index 0; utime (14) and stime (15) follow.
    let utime = fields.get(11)?.parse::<u64>().ok()?;
    let stime = fields.get(12)?.parse::<u64>().ok()?;
    utime.checked_add(stime)
}

/// Stable per-host id: the Kubernetes node, else the boot id (hashed so the raw
/// value never leaves the host), else the hostname.
/// Same order and hash as src/shared/host-metrics.ts and the sonic sidecar, so the
/// cluster view puts every service on one machine on one host card: the hashed
/// kernel boot id first (shared by every container on the kernel, needs no
/// configuration), then `k8s:<node>`, then the hostname.
pub fn host_id(node_name: Option<&str>, boot_id: Option<&str>, hostname: &str) -> String {
    if let Some(boot) = boot_id.map(str::trim).filter(|b| !b.is_empty()) {
        let digest = ring::digest::digest(&ring::digest::SHA256, boot.as_bytes());
        let hex: String = digest.as_ref()[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        return format!("boot:{hex}");
    }
    if let Some(node) = node_name.map(str::trim).filter(|n| !n.is_empty()) {
        return format!("k8s:{node}");
    }
    format!("name:{hostname}")
}

/// `cpu.max` is "<quota> <period>" or "max <period>".
pub fn parse_cpu_max(text: &str) -> Option<f64> {
    let mut fields = text.split_whitespace();
    let quota = fields.next()?.parse::<f64>().ok()?;
    let period = fields.next()?.parse::<f64>().ok()?;
    (quota > 0.0 && period > 0.0).then(|| quota / period)
}

fn stat_value(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        (fields.next()? == key)
            .then(|| fields.next()?.parse().ok())
            .flatten()
    })
}

/// Engine class names as the heartbeat publishes them, from the i915 fdinfo names.
fn i915_engine_class(name: &str) -> Option<&'static str> {
    match name {
        "render" => Some("render"),
        "copy" => Some("copy"),
        "video" => Some("video"),
        "video-enhance" => Some("videoEnhance"),
        "compute" => Some("compute"),
        _ => None,
    }
}

/// Engine class names as the heartbeat publishes them, from the xe fdinfo names.
fn xe_engine_class(name: &str) -> Option<&'static str> {
    match name {
        "rcs" => Some("render"),
        "bcs" => Some("copy"),
        "vcs" => Some("video"),
        "vecs" => Some("videoEnhance"),
        "ccs" => Some("compute"),
        _ => None,
    }
}

/// One engine of one DRM client at one sample. i915 reports busy nanoseconds
/// (`total` None); xe reports busy cycles against a total cycle count.
#[derive(Clone, Copy, Debug)]
struct EngineSample {
    busy: u64,
    total: Option<u64>,
    capacity: u64,
}

/// Engines of one DRM client, keyed by the heartbeat class name.
type Engines = BTreeMap<&'static str, EngineSample>;

/// The DRM counters of the previous beat, the base for the engine percentages.
struct GpuSnapshot {
    at: Instant,
    clients: BTreeMap<(u32, u64), Engines>,
}

fn first_u64(value: &str) -> Option<u64> {
    value.split_whitespace().next()?.parse().ok()
}

/// Parses the DRM client usage stats of one `/proc/<pid>/fdinfo/<fd>` file into
/// `(drm-client-id, engines)`. Only i915 and xe are understood; another driver gives
/// a client with no engines. None when the client id is missing.
fn parse_drm_fdinfo(text: &str) -> Option<(u64, Engines)> {
    let mut driver = "";
    let mut client_id = None;
    let mut engine_ns = BTreeMap::new();
    let mut cycles = BTreeMap::new();
    let mut total_cycles = BTreeMap::new();
    let mut capacity = BTreeMap::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        if key == "drm-driver" {
            driver = value;
            continue;
        }
        let Some(number) = first_u64(value) else {
            continue;
        };
        if key == "drm-client-id" {
            client_id = Some(number);
        } else if let Some(name) = key.strip_prefix("drm-engine-capacity-") {
            capacity.insert(name, number);
        } else if let Some(name) = key.strip_prefix("drm-total-cycles-") {
            total_cycles.insert(name, number);
        } else if let Some(name) = key.strip_prefix("drm-cycles-") {
            cycles.insert(name, number);
        } else if let Some(name) = key.strip_prefix("drm-engine-") {
            engine_ns.insert(name, number);
        }
    }
    let client_id = client_id?;
    let mut engines = Engines::new();
    match driver {
        "i915" => {
            for (name, busy) in engine_ns {
                if let Some(class) = i915_engine_class(name) {
                    let capacity = capacity.get(name).copied().unwrap_or(1).max(1);
                    engines.insert(
                        class,
                        EngineSample {
                            busy,
                            total: None,
                            capacity,
                        },
                    );
                }
            }
        }
        "xe" => {
            for (name, busy) in cycles {
                if let (Some(class), Some(total)) = (xe_engine_class(name), total_cycles.get(name))
                {
                    let capacity = capacity.get(name).copied().unwrap_or(1).max(1);
                    engines.insert(
                        class,
                        EngineSample {
                            busy,
                            total: Some(*total),
                            capacity,
                        },
                    );
                }
            }
        }
        _ => {}
    }
    Some((client_id, engines))
}

/// Busy time of one engine over one interval, as a fraction of the interval, before
/// the instance count is divided out. A client new since the previous beat counts its
/// full i915 busy time, capped at the interval (it started within it). An xe client
/// new since the previous beat has no baseline, so it waits for the next beat.
fn busy_fraction(now: EngineSample, before: Option<EngineSample>, elapsed_ns: u64) -> Option<f64> {
    match (now.total, before) {
        (None, Some(before)) => Some(now.busy.checked_sub(before.busy)? as f64 / elapsed_ns as f64),
        (None, None) => Some(now.busy.min(elapsed_ns) as f64 / elapsed_ns as f64),
        (Some(total), Some(before)) => {
            let busy = now.busy.checked_sub(before.busy)?;
            let cycles = total.checked_sub(before.total?)?;
            (cycles > 0).then(|| busy as f64 / cycles as f64)
        }
        (Some(_), None) => None,
    }
}

/// Busy percent per engine class across all DRM clients since the previous beat,
/// clamped to 0..=100 and rounded to one decimal. Every class a client reported is
/// present, even at 0.0. Empty when the interval is zero.
fn engine_percent(
    previous: &BTreeMap<(u32, u64), Engines>,
    current: &BTreeMap<(u32, u64), Engines>,
    elapsed: Duration,
) -> BTreeMap<&'static str, f64> {
    let mut percent = BTreeMap::new();
    let elapsed_ns = u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX);
    if elapsed_ns == 0 {
        return percent;
    }
    for (key, engines) in current {
        for (&class, now) in engines {
            let share: &mut f64 = percent.entry(class).or_insert(0.0);
            let before = previous.get(key).and_then(|prev| prev.get(class)).copied();
            if let Some(fraction) = busy_fraction(*now, before, elapsed_ns) {
                // Instances of one engine class share the work, so divide by their count.
                *share += fraction / now.capacity as f64;
            }
        }
    }
    for share in percent.values_mut() {
        *share = ((*share * 100.0).clamp(0.0, 100.0) * 10.0).round() / 10.0;
    }
    percent
}

/// Rolling maximum over the last 24 h in one-minute buckets, the same window the
/// web and worker heartbeats use (cluster-node-runtime.ts PeakWindow).
pub struct PeakWindow {
    started: Instant,
    buckets: VecDeque<(u64, u64)>,
}
impl PeakWindow {
    const BUCKET: Duration = Duration::from_secs(60);
    const BUCKETS: u64 = 24 * 60;
    pub fn new(started: Instant) -> Self {
        Self {
            started,
            buckets: VecDeque::new(),
        }
    }
    pub fn record(&mut self, value: u64, at: Instant) {
        let minute = at.saturating_duration_since(self.started).as_secs() / Self::BUCKET.as_secs();
        match self.buckets.back_mut() {
            Some((last, max)) if *last == minute => *max = (*max).max(value),
            _ => self.buckets.push_back((minute, value)),
        }
        while let Some((first, _)) = self.buckets.front() {
            if minute.saturating_sub(*first) >= Self::BUCKETS {
                self.buckets.pop_front();
            } else {
                break;
            }
        }
    }
    pub fn max(&self) -> Option<u64> {
        self.buckets.iter().map(|(_, value)| *value).max()
    }
}

pub struct HostSampler {
    root: PathBuf,
    node_name: Option<String>,
    host_name: Option<String>,
    hostname: String,
    previous_cpu: Option<(u64, Instant)>,
    previous_gpu: Option<GpuSnapshot>,
    memory_peak: PeakWindow,
}
impl HostSampler {
    pub fn new(env: &Environment, hostname: String) -> Self {
        Self::with_root(env, hostname, PathBuf::from("/"))
    }
    fn with_root(env: &Environment, hostname: String, root: PathBuf) -> Self {
        let node_name = non_empty(env.get("K8S_NODE_NAME"));
        Self {
            root,
            host_name: node_name
                .clone()
                .or_else(|| non_empty(env.get("LUMASTRA_HOST_NAME"))),
            node_name,
            hostname,
            previous_cpu: None,
            previous_gpu: None,
            memory_peak: PeakWindow::new(Instant::now()),
        }
    }
    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.root.join(path)).ok()
    }
    pub fn host(&self) -> Value {
        let mut host = Map::new();
        host.insert(
            "id".into(),
            json!(host_id(
                self.node_name.as_deref(),
                self.read("proc/sys/kernel/random/boot_id").as_deref(),
                &self.hostname
            )),
        );
        if let Some(name) = &self.host_name {
            host.insert("name".into(), json!(name));
        }
        if let Some(text) = self.read("proc/meminfo") {
            let (total, available) = parse_meminfo(&text);
            if let Some(total) = total {
                host.insert("memTotalBytes".into(), json!(total));
            }
            if let Some(available) = available {
                host.insert("memAvailableBytes".into(), json!(available));
            }
        }
        if let Ok(count) = std::thread::available_parallelism() {
            host.insert("cpuCount".into(), json!(count.get()));
        }
        if let Some([one, five, fifteen]) =
            self.read("proc/loadavg").as_deref().and_then(parse_loadavg)
        {
            host.insert("load1".into(), json!(one));
            host.insert("load5".into(), json!(five));
            host.insert("load15".into(), json!(fifteen));
        }
        Value::Object(host)
    }
    /// cpuPercent is the rate since the previous call, so it is absent on the first.
    /// gpu is present only while a child holds a DRM fd; its engines need a previous beat.
    pub fn process(&mut self) -> Value {
        self.process_at(Instant::now())
    }
    fn process_at(&mut self, now: Instant) -> Value {
        let mut process = Map::new();
        if let Some(rss) = self
            .read("proc/self/status")
            .as_deref()
            .and_then(parse_vm_rss)
        {
            process.insert("rssBytes".into(), json!(rss));
        }
        if let Some(ticks) = self
            .read("proc/self/stat")
            .as_deref()
            .and_then(parse_cpu_ticks)
        {
            if let Some((before, at)) = self.previous_cpu {
                let seconds = now.duration_since(at).as_secs_f64();
                if seconds > 0.0 && ticks >= before {
                    let used = (ticks - before) as f64 / CLOCK_TICKS_PER_SECOND;
                    process.insert("cpuPercent".into(), json!(used / seconds * 100.0));
                }
            }
            self.previous_cpu = Some((ticks, now));
        }
        if let Some(gpu) = self.gpu(now) {
            process.insert("gpu".into(), gpu);
        }
        Value::Object(process)
    }
    /// Child pids of this process. Tokio spawns from worker threads, so every task's
    /// `children` file is read, not only the main thread's.
    fn child_pids(&self) -> Vec<u32> {
        let mut pids = BTreeSet::new();
        if let Ok(tasks) = std::fs::read_dir(self.root.join("proc/self/task")) {
            for task in tasks.flatten() {
                let Ok(tid) = task.file_name().into_string() else {
                    continue;
                };
                if let Some(text) = self.read(&format!("proc/self/task/{tid}/children")) {
                    pids.extend(
                        text.split_whitespace()
                            .filter_map(|pid| pid.parse::<u32>().ok()),
                    );
                }
            }
        }
        pids.into_iter().take(MAX_GPU_PIDS).collect()
    }
    /// The fds of one child that are DRM device nodes, looking at no more than
    /// `MAX_FDS_PER_PID` entries.
    fn drm_fds(&self, pid: u32) -> Vec<String> {
        let Ok(fds) = std::fs::read_dir(self.root.join(format!("proc/{pid}/fd"))) else {
            return Vec::new();
        };
        fds.take(MAX_FDS_PER_PID)
            .flatten()
            .filter(|entry| {
                std::fs::read_link(entry.path())
                    .is_ok_and(|target| target.to_str().is_some_and(|t| t.starts_with("/dev/dri/")))
            })
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect()
    }
    /// The child pids holding a DRM fd, and the engine counters per (pid, drm-client-id).
    /// Several fds of one client are read but counted once.
    fn scan_gpu(&self) -> (BTreeSet<u32>, BTreeMap<(u32, u64), Engines>) {
        let mut holders = BTreeSet::new();
        let mut clients = BTreeMap::new();
        for pid in self.child_pids() {
            for fd in self.drm_fds(pid) {
                holders.insert(pid);
                let Some(text) = self.read(&format!("proc/{pid}/fdinfo/{fd}")) else {
                    continue;
                };
                if let Some((client_id, engines)) = parse_drm_fdinfo(&text) {
                    clients.entry((pid, client_id)).or_insert(engines);
                }
            }
        }
        (holders, clients)
    }
    /// The `gpu` object, or None when no child holds a DRM fd. Every beat refreshes the
    /// snapshot, so the next beat's percentages cover one heartbeat interval.
    fn gpu(&mut self, now: Instant) -> Option<Value> {
        let (holders, clients) = self.scan_gpu();
        let engines = self.previous_gpu.as_ref().map(|previous| {
            engine_percent(
                &previous.clients,
                &clients,
                now.saturating_duration_since(previous.at),
            )
        });
        self.previous_gpu = Some(GpuSnapshot { at: now, clients });
        if holders.is_empty() {
            return None;
        }
        let mut gpu = Map::new();
        gpu.insert("clients".into(), json!(holders.len()));
        if let Some(engines) = engines.filter(|engines| !engines.is_empty()) {
            gpu.insert("engines".into(), json!(engines));
        }
        Some(Value::Object(gpu))
    }
    /// The cgroup v2 this process belongs to, else the mount root (private cgroup
    /// namespace). Used memory is the working set, as the web and worker report it; the
    /// peak is the highest working set of the last 24 h (not cgroup memory.peak, which
    /// counts page cache a streaming proxy keeps full).
    pub fn resources(&mut self) -> Option<Value> {
        let membership = self.read("proc/self/cgroup")?;
        let relative = membership
            .lines()
            .find_map(|line| line.strip_prefix("0::"))?
            .trim()
            .trim_start_matches('/');
        let mount = Path::new("sys/fs/cgroup");
        let directory = [mount.join(relative), mount.to_path_buf()]
            .into_iter()
            .find(|dir| self.root.join(dir).join("memory.current").is_file())?;
        let file = |name: &str| self.read(&directory.join(name).to_string_lossy());
        let current = file("memory.current")?.trim().parse::<u64>().ok()?;
        let inactive = file("memory.stat")
            .and_then(|text| stat_value(&text, "inactive_file"))
            .unwrap_or(0);
        let limit = file("memory.max")
            .and_then(|text| text.trim().parse::<u64>().ok())
            .filter(|limit| *limit > 0);
        let cores = file("cpu.max").as_deref().and_then(parse_cpu_max);
        let oom_kills = file("memory.events").and_then(|text| stat_value(&text, "oom_kill"));
        let used = current.saturating_sub(inactive);
        self.memory_peak.record(used, Instant::now());
        let mut resources = Map::new();
        resources.insert("memoryUsedBytes".into(), json!(used));
        if let Some(limit) = limit {
            resources.insert("memoryLimitBytes".into(), json!(limit));
        }
        if let Some(peak) = self.memory_peak.max() {
            resources.insert("memoryPeakBytes".into(), json!(peak));
        }
        if let Some(kills) = oom_kills {
            resources.insert("memoryOomKills".into(), json!(kills));
        }
        if let Some(cores) = cores {
            resources.insert("cpuLimitCores".into(), json!(cores));
        }
        Some(Value::Object(resources))
    }
    /// The base heartbeat fields plus this beat's figures.
    pub fn payload(&mut self, base: &Value) -> String {
        let mut payload = base.clone();
        payload["implementation"] = json!("rust");
        // The cluster view marks a beat older than 25 s stale while its 30 s key still lives.
        payload["sentAt"] = json!(crate::runtime_operations::iso_timestamp(
            crate::runtime_operations::now_ms()
        ));
        payload["host"] = self.host();
        payload["process"] = self.process();
        if let Some(resources) = self.resources() {
            payload["resources"] = resources;
        }
        payload.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn procfs_parsers_read_fixture_contents() {
        let meminfo = "MemTotal:       16314200 kB\nMemFree:  1 kB\nMemAvailable:    8157100 kB\n";
        assert_eq!(
            parse_meminfo(meminfo),
            (Some(16_314_200 * 1024), Some(8_157_100 * 1024))
        );
        assert_eq!(parse_meminfo("MemTotal: x kB\n"), (None, None));
        assert_eq!(
            parse_vm_rss("Name:\tproxy\nVmRSS:\t   51200 kB\n"),
            Some(51_200 * 1024)
        );
        assert_eq!(parse_vm_rss("Name:\tkthread\n"), None);
        assert_eq!(
            parse_loadavg("0.52 1.25 2.00 3/812 4242\n"),
            Some([0.52, 1.25, 2.0])
        );
        assert_eq!(parse_loadavg("0.52 1.25\n"), None);
        // A command name with spaces and a ')' must not shift the fields.
        let stat = "4242 (live tv) proxy) S 1 4242 4242 0 -1 4194560 100 0 0 0 250 75 0 0 20 0 9 0 100 0 0";
        assert_eq!(parse_cpu_ticks(stat), Some(325));
        assert_eq!(parse_cpu_ticks("4242 (proxy) S 1"), None);
        assert_eq!(parse_cpu_max("max 100000\n"), None);
        assert_eq!(parse_cpu_max("150000 100000\n"), Some(1.5));
        assert_eq!(parse_cpu_max("0 100000"), None);
    }
    #[test]
    fn host_id_prefers_hashed_boot_id_then_node_then_hostname() {
        // sha256("abc"), first 16 hex characters; the boot id is trimmed first and
        // wins over the node name (same rule as the TypeScript and Python sides).
        assert_eq!(
            host_id(Some("node-a"), Some("abc\n"), "box"),
            "boot:ba7816bf8f01cfea"
        );
        assert_eq!(host_id(None, Some("abc\n"), "box"), "boot:ba7816bf8f01cfea");
        assert_eq!(host_id(Some("node-a"), None, "box"), "k8s:node-a");
        assert_eq!(host_id(Some("node-a"), Some("  \n"), "box"), "k8s:node-a");
        assert_eq!(host_id(None, Some("  \n"), "box"), "name:box");
        assert_eq!(host_id(None, None, "box"), "name:box");
    }
    fn fixture_root(files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "proxy-host-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        for (path, contents) in files {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }
        root
    }
    #[test]
    fn payload_keeps_base_fields_and_adds_host_process_and_cgroup() {
        let root = fixture_root(&[
            ("proc/sys/kernel/random/boot_id", "abc\n"),
            ("proc/meminfo", "MemTotal: 2 kB\nMemAvailable: 1 kB\n"),
            ("proc/loadavg", "0.10 0.20 0.30 1/2 3\n"),
            ("proc/self/status", "VmRSS: 4 kB\n"),
            (
                "proc/self/stat",
                "1 (proxy) S 1 1 1 0 -1 0 0 0 0 0 10 5 0 0",
            ),
            ("proc/self/cgroup", "0::/kubepods/pod1\n"),
            ("sys/fs/cgroup/kubepods/pod1/memory.current", "1000\n"),
            (
                "sys/fs/cgroup/kubepods/pod1/memory.stat",
                "anon 1\ninactive_file 300\n",
            ),
            ("sys/fs/cgroup/kubepods/pod1/memory.max", "4096\n"),
            (
                "sys/fs/cgroup/kubepods/pod1/memory.events",
                "low 0\nhigh 0\nmax 3\noom 2\noom_kill 2\n",
            ),
            ("sys/fs/cgroup/kubepods/pod1/cpu.max", "200000 100000\n"),
        ]);
        let env = Environment::from([("LUMASTRA_HOST_NAME".into(), "rack-2".into())]);
        let mut sampler = HostSampler::with_root(&env, "box".into(), root.clone());
        let base = json!({"instanceId":"p1","role":"proxy","version":"v","startedAt":"t","hostname":"box"});
        let first: Value = serde_json::from_str(&sampler.payload(&base)).unwrap();
        for key in ["instanceId", "role", "version", "startedAt", "hostname"] {
            assert_eq!(first[key], base[key]);
        }
        assert_eq!(first["implementation"], "rust");
        let sent_at = first["sentAt"].as_str().unwrap();
        assert!(sent_at.ends_with('Z') && sent_at.len() == 24, "{sent_at}");
        assert_eq!(first["host"]["id"], "boot:ba7816bf8f01cfea");
        assert_eq!(first["host"]["name"], "rack-2");
        assert_eq!(first["host"]["memTotalBytes"], 2048);
        assert_eq!(first["host"]["memAvailableBytes"], 1024);
        assert!(first["host"]["cpuCount"].as_u64().unwrap() >= 1);
        assert_eq!(first["host"]["load15"], 0.3);
        assert_eq!(first["process"], json!({"rssBytes":4096}));
        assert_eq!(
            first["resources"],
            json!({"memoryUsedBytes":700,"memoryLimitBytes":4096,"memoryPeakBytes":700,"memoryOomKills":2,"cpuLimitCores":2.0})
        );
        std::fs::write(
            root.join("proc/self/stat"),
            "1 (proxy) S 1 1 1 0 -1 0 0 0 0 0 20 5 0 0",
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let second: Value = serde_json::from_str(&sampler.payload(&base)).unwrap();
        assert!(second["process"]["cpuPercent"].as_f64().unwrap() > 0.0);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn peak_window_keeps_the_highest_value_for_24_hours() {
        let start = Instant::now();
        let mut window = PeakWindow::new(start);
        assert_eq!(window.max(), None);
        window.record(500, start);
        window.record(900, start + Duration::from_secs(30));
        window.record(300, start + Duration::from_secs(3600));
        assert_eq!(window.max(), Some(900));
        // A day after the 900 bucket it ages out; the later 300 stays.
        window.record(100, start + Duration::from_secs(24 * 3600 + 60));
        assert_eq!(window.max(), Some(300));
    }
    #[test]
    fn missing_files_omit_fields_and_node_name_wins() {
        let root = fixture_root(&[]);
        let env = Environment::from([
            ("K8S_NODE_NAME".into(), "node-a".into()),
            ("LUMASTRA_HOST_NAME".into(), "ignored".into()),
        ]);
        let mut sampler = HostSampler::with_root(&env, "box".into(), root.clone());
        let payload: Value =
            serde_json::from_str(&sampler.payload(&json!({"role":"proxy"}))).unwrap();
        // No boot id in the fixture, so the node name is the id (prefixed like TS/Python).
        assert_eq!(payload["host"]["id"], "k8s:node-a");
        assert_eq!(payload["host"]["name"], "node-a");
        assert!(payload["host"].get("memTotalBytes").is_none());
        assert!(payload["host"].get("load1").is_none());
        assert_eq!(payload["process"], json!({}));
        assert!(payload.get("resources").is_none());
        let unnamed = HostSampler::with_root(&Environment::new(), "box".into(), root.clone());
        assert_eq!(unnamed.host()["id"], "name:box");
        assert!(unnamed.host().get("name").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    /// An fd symlink under `proc/<pid>/fd/`, plus the matching `fdinfo` directory so the
    /// test can write that fd's fdinfo next.
    fn link_fixture(root: &Path, path: &str, target: &str) {
        let link = root.join(path);
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(target, link).unwrap();
        let info = root.join(path.replacen("/fd/", "/fdinfo/", 1));
        std::fs::create_dir_all(info.parent().unwrap()).unwrap();
    }
    const I915_FIRST: &str = "pos:\t0\ndrm-driver:\ti915\ndrm-client-id:\t7\ndrm-engine-render:\t1000000000 ns\ndrm-engine-copy:\t0 ns\ndrm-engine-video:\t4000000000 ns\ndrm-engine-video-enhance:\t0 ns\ndrm-engine-compute:\t0 ns\ndrm-engine-capacity-video:\t2\n";
    const I915_SECOND: &str = "pos:\t0\ndrm-driver:\ti915\ndrm-client-id:\t7\ndrm-engine-render:\t3000000000 ns\ndrm-engine-copy:\t0 ns\ndrm-engine-video:\t9000000000 ns\ndrm-engine-video-enhance:\t0 ns\ndrm-engine-compute:\t0 ns\ndrm-engine-capacity-video:\t2\n";
    fn sampler_at(root: &Path) -> HostSampler {
        HostSampler::with_root(&Environment::new(), "box".into(), root.to_path_buf())
    }
    #[test]
    fn gpu_i915_busy_percent_divides_by_engine_capacity() {
        let root = fixture_root(&[("proc/self/task/100/children", "201\n")]);
        link_fixture(&root, "proc/201/fd/3", "/dev/dri/renderD128");
        std::fs::write(root.join("proc/201/fdinfo/3"), I915_FIRST).unwrap();
        let mut sampler = sampler_at(&root);
        let t0 = Instant::now();
        // The first beat has no baseline, so no engines.
        assert_eq!(sampler.process_at(t0)["gpu"], json!({"clients": 1}));
        std::fs::write(root.join("proc/201/fdinfo/3"), I915_SECOND).unwrap();
        let second = sampler.process_at(t0 + Duration::from_secs(10));
        // Render: 2 s busy in 10 s on one instance. Video: 5 s in 10 s on two instances.
        assert_eq!(
            second["gpu"],
            json!({"clients": 1, "engines": {
                "render": 20.0, "copy": 0.0, "video": 25.0, "videoEnhance": 0.0, "compute": 0.0
            }})
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn gpu_xe_busy_percent_is_cycles_over_total_cycles() {
        let root = fixture_root(&[("proc/self/task/100/children", "201\n")]);
        link_fixture(&root, "proc/201/fd/3", "/dev/dri/renderD128");
        std::fs::write(
            root.join("proc/201/fdinfo/3"),
            "drm-driver:\txe\ndrm-client-id:\t9\ndrm-cycles-rcs:\t1000\ndrm-total-cycles-rcs:\t50000\ndrm-cycles-vcs:\t1000\ndrm-total-cycles-vcs:\t10000\ndrm-engine-capacity-vcs:\t2\n",
        )
        .unwrap();
        let mut sampler = sampler_at(&root);
        let t0 = Instant::now();
        sampler.process_at(t0);
        std::fs::write(
            root.join("proc/201/fdinfo/3"),
            "drm-driver:\txe\ndrm-client-id:\t9\ndrm-cycles-rcs:\t6000\ndrm-total-cycles-rcs:\t70000\ndrm-cycles-vcs:\t4000\ndrm-total-cycles-vcs:\t20000\ndrm-engine-capacity-vcs:\t2\n",
        )
        .unwrap();
        // A client new since the last beat: xe has no baseline for it, so it adds nothing.
        link_fixture(&root, "proc/201/fd/4", "/dev/dri/renderD128");
        std::fs::write(
            root.join("proc/201/fdinfo/4"),
            "drm-driver:\txe\ndrm-client-id:\t11\ndrm-cycles-rcs:\t90000\ndrm-total-cycles-rcs:\t100000\n",
        )
        .unwrap();
        let second = sampler.process_at(t0 + Duration::from_secs(10));
        // Render: 5000 of 20000 cycles. Video: 3000 of 10000 cycles on two instances.
        assert_eq!(
            second["gpu"],
            json!({"clients": 1, "engines": {"render": 25.0, "video": 15.0}})
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn gpu_fds_sharing_a_client_id_count_once() {
        let root = fixture_root(&[("proc/self/task/100/children", "201\n")]);
        link_fixture(&root, "proc/201/fd/3", "/dev/dri/renderD128");
        link_fixture(&root, "proc/201/fd/4", "/dev/dri/renderD128");
        link_fixture(&root, "proc/201/fd/5", "/dev/null");
        std::fs::write(root.join("proc/201/fdinfo/3"), I915_FIRST).unwrap();
        std::fs::write(root.join("proc/201/fdinfo/4"), I915_FIRST).unwrap();
        let mut sampler = sampler_at(&root);
        let t0 = Instant::now();
        sampler.process_at(t0);
        std::fs::write(root.join("proc/201/fdinfo/3"), I915_SECOND).unwrap();
        std::fs::write(root.join("proc/201/fdinfo/4"), I915_SECOND).unwrap();
        let second = sampler.process_at(t0 + Duration::from_secs(10));
        // Same numbers as the single-fd case: video is 25.0, not doubled.
        assert_eq!(
            second["gpu"],
            json!({"clients": 1, "engines": {
                "render": 20.0, "copy": 0.0, "video": 25.0, "videoEnhance": 0.0, "compute": 0.0
            }})
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn gpu_is_absent_without_a_drm_fd() {
        let root = fixture_root(&[("proc/self/task/100/children", "201\n")]);
        link_fixture(&root, "proc/201/fd/0", "/dev/null");
        let mut sampler = sampler_at(&root);
        let t0 = Instant::now();
        assert!(sampler.process_at(t0).get("gpu").is_none());
        assert!(
            sampler
                .process_at(t0 + Duration::from_secs(10))
                .get("gpu")
                .is_none()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn gpu_finds_children_of_a_non_main_thread() {
        let root = fixture_root(&[
            ("proc/self/task/100/children", ""),
            ("proc/self/task/205/children", "201 202\n"),
        ]);
        link_fixture(&root, "proc/201/fd/3", "/dev/dri/renderD128");
        std::fs::write(root.join("proc/201/fdinfo/3"), I915_FIRST).unwrap();
        let mut sampler = sampler_at(&root);
        assert_eq!(
            sampler.process_at(Instant::now())["gpu"],
            json!({"clients": 1})
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn new_i915_clients_count_busy_time_capped_at_the_interval() {
        let fresh = EngineSample {
            busy: 30_000_000_000,
            total: None,
            capacity: 1,
        };
        assert_eq!(busy_fraction(fresh, None, 10_000_000_000), Some(1.0));
        let xe = EngineSample {
            busy: 5,
            total: Some(10),
            capacity: 1,
        };
        assert_eq!(busy_fraction(xe, None, 10_000_000_000), None);
    }
}

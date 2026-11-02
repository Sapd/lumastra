// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Best-effort operational reporting. Redis failures never unwind media handlers.
//! Coordination writes (cluster heartbeat, failure queue) belong to the TASK Valkey,
//! so the endpoint is `TASK_CACHE_URL`; `CACHE_URL` is not read. The URL's username,
//! password (percent-decoded) and `/<db>` path are honoured; malformed URLs use
//! localhost. `rediss:` is rejected rather than sending secrets over plaintext
//! while pretending TLS is enabled.

use crate::config::Environment;
pub use crate::runtime_media::FailureEventInput;
use serde_json::{Value, json};
use std::fmt;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

pub const FAILURE_QUEUE_KEY: &str = "livetv:failures:pending";
pub const FAILURE_QUEUE_MAX: usize = 500;
const LOCAL_QUEUE_MAX: usize = 64;
const REDIS_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REPLY_BYTES: usize = 16 * 1024;
const MAX_COMMAND_BYTES: usize = 256 * 1024;
const MAX_EVENT_BYTES: usize = 128 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperationsError(pub &'static str);
impl fmt::Display for OperationsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for OperationsError {}

pub const COORDINATION_URL_VAR: &str = "TASK_CACHE_URL";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RedisEndpoint {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub database: u32,
}
fn url_credential(raw: &str) -> Option<String> {
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| raw.to_owned());
    (!decoded.is_empty()).then_some(decoded)
}
impl RedisEndpoint {
    pub fn parse(raw: &str) -> Result<Self, OperationsError> {
        let parsed = match url::Url::parse(raw) {
            Ok(parsed) => parsed,
            Err(_) => {
                return Ok(Self {
                    host: "127.0.0.1".into(),
                    port: 6379,
                    ..Default::default()
                });
            }
        };
        if parsed.scheme() == "rediss" {
            return Err(OperationsError("redis_tls_not_supported"));
        }
        let path = parsed.path().trim_start_matches('/');
        // Same rule as the app's endpoint parser: no path is DB 0, a non-numeric one is unusable.
        let database = if path.is_empty() {
            0
        } else {
            path.parse()
                .map_err(|_| OperationsError("redis_database_invalid"))?
        };
        Ok(Self {
            host: parsed
                .host_str()
                .filter(|host| !host.is_empty())
                .unwrap_or("127.0.0.1")
                .into(),
            port: parsed.port().filter(|port| *port != 0).unwrap_or(6379),
            username: url_credential(parsed.username()),
            password: parsed.password().and_then(url_credential),
            database,
        })
    }
    /// AUTH (ACL form when a username is given) and SELECT, ahead of the payload.
    fn preamble(&self) -> Vec<Vec<String>> {
        let mut commands = Vec::new();
        if let Some(password) = &self.password {
            commands.push(match &self.username {
                Some(username) => vec!["AUTH".into(), username.clone(), password.clone()],
                None => vec!["AUTH".into(), password.clone()],
            });
        }
        if self.database != 0 {
            commands.push(vec!["SELECT".into(), self.database.to_string()]);
        }
        commands
    }
}

/// Only the single-line status/integer replies used by AUTH/SELECT/SET/DEL/RPUSH/LTRIM
/// are accepted. The entire connect/write/read exchange has one five-second cap.
pub async fn send_commands(endpoint: &RedisEndpoint, commands: &[Vec<String>]) -> bool {
    if commands.is_empty() {
        return true;
    }
    if commands.len() > 32 {
        return false;
    }
    let mut bytes = Vec::new();
    let preamble = endpoint.preamble();
    let expected = preamble.len() + commands.len();
    for command in preamble.iter().chain(commands) {
        if !encode_resp(command, &mut bytes) {
            return false;
        }
    }
    tokio::time::timeout(REDIS_TIMEOUT, async {
        let mut stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))
            .await
            .ok()?;
        stream.write_all(&bytes).await.ok()?;
        let mut pending = Vec::new();
        let mut received = 0;
        let mut total = 0;
        let mut chunk = [0u8; 1024];
        while received < expected {
            let count = stream.read(&mut chunk).await.ok()?;
            if count == 0 {
                return None;
            }
            total += count;
            if total > MAX_REPLY_BYTES {
                return None;
            }
            pending.extend_from_slice(&chunk[..count]);
            while let Some(end) = pending.windows(2).position(|pair| pair == b"\r\n") {
                let line = &pending[..end];
                match line.first() {
                    Some(b'+') => {}
                    Some(b':')
                        if std::str::from_utf8(&line[1..])
                            .ok()
                            .and_then(|v| v.parse::<i64>().ok())
                            .is_some() => {}
                    _ => return None,
                }
                received += 1;
                pending.drain(..end + 2);
                if received == expected {
                    return Some(());
                }
            }
        }
        Some(())
    })
    .await
    .ok()
    .flatten()
    .is_some()
}

fn encode_resp(args: &[String], out: &mut Vec<u8>) -> bool {
    if args.is_empty() || args.len() > 32 {
        return false;
    }
    let size = args
        .iter()
        .try_fold(32usize, |total, arg| total.checked_add(arg.len() + 32));
    if size.is_none_or(|size| out.len().saturating_add(size) > MAX_COMMAND_BYTES) {
        return false;
    }
    out.extend_from_slice(format!("*{}\r\n", args.len()).as_bytes());
    for arg in args {
        out.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
        out.extend_from_slice(arg.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    true
}

/// UTC ISO-8601 with the millisecond precision used by JavaScript Date.toISOString.
pub fn iso_timestamp(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    let seconds = (ms / 1000) % 86_400;
    let year = if year <= 9999 {
        format!("{year:04}")
    } else {
        format!("+{year:06}")
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60,
        ms % 1000
    )
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn random_id() -> Result<String, OperationsError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| OperationsError("event_id_unavailable"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    ))
}
fn hostname() -> String {
    let mut bytes = [0u8; 256];
    // SAFETY: writable buffer has the supplied length and is pre-zeroed, with a
    // spare terminator even on hosts that truncate without writing a NUL byte.
    if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len() - 1) } != 0 {
        return "unknown".into();
    }
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn sanitize_text(value: &str) -> String {
    value
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if [
                "authorization",
                "cookie",
                "password",
                "passwd",
                "api_key",
                "api-key",
                "apikey",
                "token",
                "secret",
            ]
            .iter()
            .any(|needle| lower.contains(needle))
            {
                return "[redacted sensitive diagnostic]".into();
            }
            line.split_inclusive(char::is_whitespace)
                .map(|part| {
                    if let Some(start) = part.find("://") {
                        let prefix = &part[..start];
                        let start = prefix
                            .rfind(|c: char| {
                                !c.is_ascii_alphanumeric() && c != '+' && c != '-' && c != '.'
                            })
                            .map_or(0, |i| i + 1);
                        format!(
                            "{}[redacted URL]{}",
                            &part[..start],
                            if part.ends_with(char::is_whitespace) {
                                " "
                            } else {
                                ""
                            }
                        )
                    } else {
                        part.to_owned()
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
pub(crate) fn tail(value: &str, limit: usize) -> String {
    // JavaScript slice() counts UTF-16 units. Keep that cap without producing an
    // unpaired surrogate when the boundary falls inside an astral character.
    let mut units = 0;
    let mut start = value.len();
    for (index, character) in value.char_indices().rev() {
        if units + character.len_utf16() > limit {
            break;
        }
        units += character.len_utf16();
        start = index;
    }
    value[start..].into()
}
fn sanitize_value(value: &Value, depth: usize, remaining: &mut usize) -> Value {
    if depth > 8 || *remaining == 0 {
        return Value::String("[truncated]".into());
    }
    *remaining -= 1;
    match value {
        Value::String(value) if value.len() > MAX_EVENT_BYTES => {
            Value::String("[truncated oversized diagnostic]".into())
        }
        Value::String(value) => Value::String(tail(&sanitize_text(value), 4096)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(32)
                .map(|value| sanitize_value(value, depth + 1, remaining))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .take(32)
                .map(|(key, value)| {
                    let lower = key.to_ascii_lowercase();
                    let sensitive = [
                        "authorization",
                        "cookie",
                        "password",
                        "token",
                        "secret",
                        "api_key",
                        "apikey",
                    ]
                    .iter()
                    .any(|part| lower.contains(part));
                    let key = if key.len() > 512 {
                        "[oversized key]".into()
                    } else {
                        tail(&sanitize_text(key), 128)
                    };
                    (
                        key,
                        if sensitive {
                            Value::String("[redacted]".into())
                        } else {
                            sanitize_value(value, depth + 1, remaining)
                        },
                    )
                })
                .collect(),
        ),
        value => value.clone(),
    }
}
fn failure_payload(mut input: FailureEventInput) -> Result<String, OperationsError> {
    if input.channel_id.is_empty()
        || input.channel_id.len() > 512
        || !["ingest", "egress", "adaptive-egress"].contains(&input.source.as_str())
        || !["spawn_failed", "crashed", "stalled", "exhausted"].contains(&input.outcome.as_str())
        || input.stderr_tail.len() > MAX_EVENT_BYTES
    {
        return Err(OperationsError("invalid_failure_event"));
    }
    input.stderr_tail = tail(&sanitize_text(&input.stderr_tail), 16_000);
    input.signal = input.signal.map(|value| tail(&sanitize_text(&value), 128));
    input.rung_id = input.rung_id.map(|value| tail(&sanitize_text(&value), 256));
    input.feed_id = input.feed_id.map(|value| tail(&sanitize_text(&value), 256));
    input.reason = input
        .reason
        .and_then(|reason| crate::failure_reason::known(&reason).map(str::to_owned));
    let mut remaining = 128;
    input.probe = sanitize_value(&input.probe, 0, &mut remaining);
    input.decision = sanitize_value(&input.decision, 0, &mut remaining);
    let mut full =
        serde_json::to_value(input).map_err(|_| OperationsError("failure_serialization_failed"))?;
    full["eventUid"] = random_id()?.into();
    full["occurredAt"] = iso_timestamp(now_ms()).into();
    let payload = serde_json::to_string(&full)
        .map_err(|_| OperationsError("failure_serialization_failed"))?;
    if payload.len() > MAX_EVENT_BYTES {
        return Err(OperationsError("failure_event_too_large"));
    }
    Ok(payload)
}

/// App↔proxy contract this build speaks. Mirrors LIVETV_PROXY_PROTOCOL in
/// src/shared/livetv-proxy-protocol.ts (a test below keeps them equal).
pub const PROXY_PROTOCOL: u32 = 1;
/// Written next to this binary by `npm run build:proxy` (LIVETV_PROXY_BUILD_FILE).
const PROXY_BUILD_FILE: &str = "livetv-proxy-build";

/// The proxy build id (16 hex characters) from `file`; None when missing or garbled.
fn proxy_build_id(file: &std::path::Path) -> Option<String> {
    let id = std::fs::read_to_string(file).ok()?.trim().to_owned();
    (id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then_some(id)
}

/// Heartbeat fields every beat repeats; Admin → Cluster compares protocol and build.
fn heartbeat_base(instance_id: &str, version: &str, host: &str, build: Option<&str>) -> Value {
    let mut base = json!({"instanceId":instance_id,"role":"proxy","version":version,"startedAt":iso_timestamp(now_ms()),"hostname":host,"proxyProtocol":PROXY_PROTOCOL});
    if let Some(build) = build {
        base["proxyBuild"] = json!(build);
    }
    base
}

pub struct RuntimeOperations {
    instance_id: String,
    sender: Option<mpsc::Sender<String>>,
    stopping: AtomicBool,
    stop: watch::Sender<bool>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    dropped: Arc<AtomicU64>,
}
impl RuntimeOperations {
    pub async fn start(env: &Environment) -> Result<Arc<Self>, OperationsError> {
        let host = hostname();
        let instance_id = match env.get("INSTANCE_ID").filter(|id| !id.is_empty()) {
            Some(instance_id) => instance_id.clone(),
            None => format!("{host}-{}", &random_id()?[..8]),
        };
        let endpoint = env
            .get(COORDINATION_URL_VAR)
            .filter(|url| !url.is_empty())
            .map(|url| RedisEndpoint::parse(url))
            .transpose()
            .or_else(|error| match error {
                // Like the TS proxy: reporting stays off rather than writing to the wrong DB.
                OperationsError("redis_database_invalid") => {
                    eprintln!(
                        "[RuntimeOperations] {COORDINATION_URL_VAR} has a non-numeric database; heartbeat and failure reporting are off"
                    );
                    Ok(None)
                }
                error => Err(error),
            })?;
        let (stop, _) = watch::channel(false);
        let dropped = Arc::new(AtomicU64::new(0));
        let (sender, receiver) = mpsc::channel(LOCAL_QUEUE_MAX);
        let operations = Arc::new(Self {
            instance_id: instance_id.clone(),
            sender: endpoint.as_ref().map(|_| sender),
            stopping: AtomicBool::new(false),
            stop,
            tasks: Mutex::new(Vec::new()),
            dropped: dropped.clone(),
        });
        let Some(endpoint) = endpoint else {
            return Ok(operations);
        };
        let version = env
            .get("APP_VERSION")
            .or_else(|| env.get("npm_package_version"))
            .cloned()
            .unwrap_or("unknown".into());
        let sampler = crate::runtime_host::HostSampler::new(env, host.clone());
        let build = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join(PROXY_BUILD_FILE)))
            .and_then(|file| proxy_build_id(&file));
        let base = heartbeat_base(&instance_id, &version, &host, build.as_deref());
        let heartbeat = tokio::spawn(heartbeat_task(
            endpoint.clone(),
            format!("cluster:node:{instance_id}"),
            base,
            sampler,
            operations.stop.subscribe(),
        ));
        let failures = tokio::spawn(failure_task(
            endpoint,
            receiver,
            dropped,
            operations.stop.subscribe(),
        ));
        operations
            .tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .extend([heartbeat, failures]);
        Ok(operations)
    }
    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }
    pub fn enabled(&self) -> bool {
        self.sender.is_some()
    }
    pub fn dropped_failures(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
    /// No network awaits, no unbounded spawn, and no exception can escape a media handler.
    pub fn report_failure(&self, input: FailureEventInput) -> bool {
        let Some(sender) = &self.sender else {
            return false;
        };
        if self.stopping.load(Ordering::Acquire) {
            return false;
        }
        let payload = match failure_payload(input) {
            Ok(payload) => payload,
            Err(_) => {
                self.drop_failure();
                return false;
            }
        };
        if sender.try_send(payload).is_err() {
            self.drop_failure();
            return false;
        }
        true
    }
    fn drop_failure(&self) {
        self.dropped.fetch_add(1, Ordering::Relaxed);
        eprintln!("[FailureSink] Failed to enqueue Live TV failure");
    }
    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.stop.send(true);
        let tasks = std::mem::take(
            &mut *self
                .tasks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        for mut task in tasks {
            if tokio::time::timeout(Duration::from_secs(6), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
                eprintln!("[RuntimeOperations] Shutdown task exceeded bounded drain");
            }
        }
    }
}
impl Drop for RuntimeOperations {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

async fn heartbeat_task(
    endpoint: RedisEndpoint,
    key: String,
    base: Value,
    mut sampler: crate::runtime_host::HostSampler,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        if *stop.borrow() {
            break;
        }
        let commands = [vec![
            "SET".into(),
            key.clone(),
            sampler.payload(&base),
            "EX".into(),
            "30".into(),
        ]];
        tokio::select! {
            _ = stop.changed() => break,
            ok = send_commands(&endpoint, &commands) => {
                if !ok { eprintln!("[ProxyHeartbeat] Heartbeat failed; will retry"); }
            }
        }
        tokio::select! { _ = stop.changed() => break, _ = tokio::time::sleep(Duration::from_secs(10)) => {} }
    }
    if !send_commands(&endpoint, &[vec!["DEL".into(), key]]).await {
        eprintln!("[ProxyHeartbeat] Cleanup failed; heartbeat expires after TTL");
    }
}
async fn failure_task(
    endpoint: RedisEndpoint,
    mut receiver: mpsc::Receiver<String>,
    dropped: Arc<AtomicU64>,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        let payload = tokio::select! { biased; _ = stop.changed() => break, payload = receiver.recv() => payload };
        let Some(payload) = payload else {
            return;
        };
        if !enqueue_failure(&endpoint, payload).await {
            dropped.fetch_add(1, Ordering::Relaxed);
            eprintln!("[FailureSink] Failed to persist Live TV failure");
        }
    }
    receiver.close();
    let drain = async {
        while let Some(payload) = receiver.recv().await {
            if !enqueue_failure(&endpoint, payload).await {
                dropped.fetch_add(1, Ordering::Relaxed);
                eprintln!("[FailureSink] Failed to persist Live TV failure during shutdown");
            }
        }
    };
    if tokio::time::timeout(REDIS_TIMEOUT, drain).await.is_err() {
        dropped.fetch_add(receiver.len() as u64 + 1, Ordering::Relaxed);
        eprintln!("[FailureSink] Bounded shutdown drain expired");
    }
}
async fn enqueue_failure(endpoint: &RedisEndpoint, payload: String) -> bool {
    send_commands(
        endpoint,
        &[
            vec!["RPUSH".into(), FAILURE_QUEUE_KEY.into(), payload],
            vec![
                "LTRIM".into(),
                FAILURE_QUEUE_KEY.into(),
                format!("-{FAILURE_QUEUE_MAX}"),
                "-1".into(),
            ],
        ],
    )
    .await
}

#[cfg(test)]
mod tests {
    #[test]
    fn protocol_matches_the_shared_typescript_constant() {
        let shared = include_str!("../../../src/shared/livetv-proxy-protocol.ts");
        assert!(
            shared.contains(&format!("LIVETV_PROXY_PROTOCOL = {PROXY_PROTOCOL};")),
            "PROXY_PROTOCOL differs from src/shared/livetv-proxy-protocol.ts"
        );
        assert!(shared.contains(&format!("LIVETV_PROXY_BUILD_FILE = '{PROXY_BUILD_FILE}';")));
    }
    #[test]
    fn heartbeat_base_carries_protocol_and_build_id() {
        let dir = std::env::temp_dir().join(format!("proxy-build-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(PROXY_BUILD_FILE);
        std::fs::write(&file, "e7292a9df2b9749b\n").unwrap();
        assert_eq!(proxy_build_id(&file).as_deref(), Some("e7292a9df2b9749b"));
        std::fs::write(&file, "not-a-build-id\n").unwrap();
        assert_eq!(proxy_build_id(&file), None);
        assert_eq!(proxy_build_id(&dir.join("missing")), None);

        let base = heartbeat_base("p1", "v1", "box", Some("e7292a9df2b9749b"));
        assert_eq!(base["proxyProtocol"], PROXY_PROTOCOL);
        assert_eq!(base["proxyBuild"], "e7292a9df2b9749b");
        assert_eq!(base["role"], "proxy");
        let without = heartbeat_base("p1", "v1", "box", None);
        assert!(without.get("proxyBuild").is_none());
    }

    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn timestamps_preserve_utc_milliseconds_and_leap_years() {
        assert_eq!(iso_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_timestamp(951_782_400_123), "2000-02-29T00:00:00.123Z");
        assert_eq!(iso_timestamp(1_792_281_600_999), "2026-10-18T00:00:00.999Z");
        assert_eq!(iso_timestamp(4_107_542_400_000), "2100-03-01T00:00:00.000Z");
    }
    #[test]
    fn redis_url_honours_username_password_encoding_and_database() {
        let endpoint =
            RedisEndpoint::parse("redis://task%40user:p%40ss%3Aw%2Fd@localhost:6380/9").unwrap();
        assert_eq!(endpoint.host, "localhost");
        assert_eq!(endpoint.port, 6380);
        assert_eq!(endpoint.username.as_deref(), Some("task@user"));
        assert_eq!(endpoint.password.as_deref(), Some("p@ss:w/d"));
        assert_eq!(endpoint.database, 9);
        let password_only = RedisEndpoint::parse("redis://:secret@valkey:6379").unwrap();
        assert_eq!(password_only.username, None);
        assert_eq!(password_only.password.as_deref(), Some("secret"));
        assert_eq!(password_only.database, 0);
        for (raw, database) in [
            ("redis://valkey", 0),
            ("redis://valkey/", 0),
            ("redis://valkey/2", 2),
        ] {
            assert_eq!(
                RedisEndpoint::parse(raw).unwrap().database,
                database,
                "{raw}"
            );
        }
        assert_eq!(
            RedisEndpoint::parse("redis://valkey/not-a-db").err(),
            Some(OperationsError("redis_database_invalid"))
        );
        let malformed = RedisEndpoint::parse("malformed").unwrap();
        assert_eq!(
            (malformed.host.as_str(), malformed.port),
            ("127.0.0.1", 6379)
        );
        assert_eq!(malformed.password, None);
        assert_eq!(
            RedisEndpoint::parse("rediss://localhost").err(),
            Some(OperationsError("redis_tls_not_supported"))
        );
        assert_eq!(
            RedisEndpoint::parse("redis://localhost:0").unwrap().port,
            6379
        );
    }
    async fn capture_one(reply: &'static str) -> (RedisEndpoint, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = RedisEndpoint {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            ..Default::default()
        };
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 2048];
            while !bytes.ends_with(b"$2\r\n-1\r\n") {
                let count = stream.read(&mut chunk).await.unwrap();
                assert_ne!(count, 0);
                bytes.extend_from_slice(&chunk[..count]);
            }
            stream.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (endpoint, server)
    }
    #[tokio::test]
    async fn acl_auth_and_select_precede_the_payload_in_order() {
        let (mut endpoint, server) = capture_one("+OK\r\n+OK\r\n:1\r\n+OK\r\n").await;
        endpoint.username = Some("task user".into());
        endpoint.password = Some("p@ss".into());
        endpoint.database = 3;
        assert!(enqueue_failure(&endpoint, "payload".into()).await);
        let request = server.await.unwrap();
        assert!(request.starts_with(
            "*3\r\n$4\r\nAUTH\r\n$9\r\ntask user\r\n$4\r\np@ss\r\n*2\r\n$6\r\nSELECT\r\n$1\r\n3\r\n*3\r\n$5\r\nRPUSH\r\n"
        ));
        // A failed SELECT is a failed write, never a silent write to DB 0.
        let (mut endpoint, server) =
            capture_one("-ERR DB index is out of range\r\n:1\r\n+OK\r\n").await;
        endpoint.database = 99;
        assert!(!enqueue_failure(&endpoint, "payload".into()).await);
        assert!(
            server
                .await
                .unwrap()
                .starts_with("*2\r\n$6\r\nSELECT\r\n$2\r\n99\r\n")
        );
        let (mut endpoint, server) = capture_one("+OK\r\n:1\r\n+OK\r\n").await;
        endpoint.password = Some("secret".into());
        assert!(enqueue_failure(&endpoint, "payload".into()).await);
        let request = server.await.unwrap();
        assert!(request.starts_with("*2\r\n$4\r\nAUTH\r\n$6\r\nsecret\r\n*3\r\n$5\r\nRPUSH"));
        assert!(!request.contains("SELECT"));
    }
    #[tokio::test]
    async fn reporting_ignores_cache_url_and_rejects_tls_task_valkey() {
        // CACHE_URL is the cache Valkey; coordination writes never go there.
        let env = Environment::from([("CACHE_URL".into(), "redis://127.0.0.1:1/0".into())]);
        let operations = RuntimeOperations::start(&env).await.unwrap();
        assert!(!operations.enabled());
        assert!(!operations.report_failure(FailureEventInput {
            channel_id: "ch-42".into(),
            source: "ingest".into(),
            outcome: "crashed".into(),
            exit_code: None,
            signal: None,
            rung_id: None,
            stderr_tail: String::new(),
            probe: Value::Null,
            decision: Value::Null,
            ..Default::default()
        }));
        assert_eq!(operations.dropped_failures(), 0);
        operations.shutdown().await;
        let env = Environment::from([
            ("CACHE_URL".into(), "rediss://cache".into()),
            (COORDINATION_URL_VAR.into(), "redis://127.0.0.1:1".into()),
        ]);
        let operations = RuntimeOperations::start(&env).await.unwrap();
        assert!(operations.enabled());
        operations.shutdown().await;
        let env = Environment::from([(COORDINATION_URL_VAR.into(), "rediss://task".into())]);
        assert_eq!(
            RuntimeOperations::start(&env).await.err(),
            Some(OperationsError("redis_tls_not_supported"))
        );
    }
    #[test]
    fn failure_events_redact_credentials_and_keep_stable_wire_contract() {
        let event = || {
            FailureEventInput { channel_id: "ch-42".into(), source: "ingest".into(), outcome: "crashed".into(), exit_code: Some(1), signal: None, rung_id: None, stderr_tail: "Opening https://user:password@example.test/private\nAuthorization: Bearer abc\nlast diagnostic".into(), probe: json!({"url":"http://user:secret@example.test/live", "token":"private", "codec":"h264"}), decision: Value::Null, ..Default::default() }
        };
        let first: Value = serde_json::from_str(&failure_payload(event()).unwrap()).unwrap();
        let second: Value = serde_json::from_str(&failure_payload(event()).unwrap()).unwrap();
        let serialized = first.to_string();
        for secret in ["password", "Bearer abc", "user:secret", "\"private\""] {
            assert!(!serialized.contains(secret));
        }
        assert_eq!(first["probe"]["codec"], "h264");
        assert_eq!(first["channelId"], "ch-42");
        assert_ne!(first["eventUid"], second["eventUid"]);
        assert_eq!(first["eventUid"].as_str().unwrap().len(), 36);
        assert!(first["occurredAt"].as_str().unwrap().ends_with('Z'));
        assert_eq!(
            tail(&"💫".repeat(16_000), 16_000).encode_utf16().count(),
            16_000
        );
    }
    #[tokio::test]
    async fn redis_pipeline_auth_errors_and_fragmented_replies_are_classified() {
        for (reply, expected) in [
            ("+OK\r\n:1\r\n+OK\r\n", true),
            ("-WRONGPASS denied\r\n:1\r\n+OK\r\n", false),
            ("$1000000\r\n", false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = RedisEndpoint {
                host: "127.0.0.1".into(),
                port: listener.local_addr().unwrap().port(),
                password: Some("secret".into()),
                ..Default::default()
            };
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 2048];
                let count = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                assert!(
                    request.contains("AUTH")
                        && request.contains("RPUSH")
                        && request.contains("LTRIM")
                );
                assert!(!request.contains("SELECT"));
                for byte in reply.bytes() {
                    if stream.write_all(&[byte]).await.is_err() {
                        break;
                    }
                }
            });
            assert_eq!(enqueue_failure(&endpoint, "payload".into()).await, expected);
            server.await.unwrap();
        }
    }
    #[tokio::test]
    async fn absent_cache_disables_network_tasks_and_shutdown_is_idempotent() {
        let operations = RuntimeOperations::start(&Environment::new()).await.unwrap();
        assert!(!operations.enabled());
        operations.shutdown().await;
        operations.shutdown().await;
    }

    #[tokio::test]
    async fn heartbeat_ttl_failure_pipeline_and_shutdown_cleanup_use_real_sockets() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (observed, mut requests) = mpsc::channel(3);
        let server = tokio::spawn(async move {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0u8; 2048];
                loop {
                    let count = stream.read(&mut chunk).await.unwrap();
                    assert_ne!(count, 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    let request = String::from_utf8_lossy(&bytes);
                    let complete = if request.contains("RPUSH") {
                        bytes.ends_with(b"$2\r\n-1\r\n")
                    } else if request.contains("SET") {
                        bytes.ends_with(b"$2\r\n30\r\n")
                    } else {
                        bytes.ends_with(b"fixture-proxy\r\n")
                    };
                    if complete {
                        break;
                    }
                    assert!(bytes.len() < MAX_COMMAND_BYTES);
                }
                let request = String::from_utf8(bytes).unwrap();
                assert!(request.starts_with("*2\r\n$6\r\nSELECT\r\n$1\r\n7\r\n"));
                let reply = if request.contains("RPUSH") {
                    "+OK\r\n:1\r\n+OK\r\n"
                } else {
                    "+OK\r\n+OK\r\n"
                };
                stream.write_all(reply.as_bytes()).await.unwrap();
                observed.send(request).await.unwrap();
            }
        });
        let env = Environment::from([
            (
                COORDINATION_URL_VAR.into(),
                format!("redis://127.0.0.1:{port}/7"),
            ),
            ("CACHE_URL".into(), "redis://127.0.0.1:1/0".into()),
            ("INSTANCE_ID".into(), "fixture-proxy".into()),
            ("APP_VERSION".into(), "fixture-version".into()),
        ]);
        let operations = RuntimeOperations::start(&env).await.unwrap();
        assert!(operations.report_failure(FailureEventInput {
            channel_id: "ch-42".into(),
            source: "egress".into(),
            outcome: "crashed".into(),
            exit_code: Some(1),
            signal: None,
            rung_id: Some("720p".into()),
            stderr_tail: "encoder failed".into(),
            probe: Value::Null,
            decision: Value::Null,
            ..Default::default()
        }));
        let mut captured = Vec::new();
        for _ in 0..2 {
            captured.push(
                tokio::time::timeout(Duration::from_secs(2), requests.recv())
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        operations.shutdown().await;
        captured.push(requests.recv().await.unwrap());
        server.await.unwrap();
        assert!(captured.iter().any(|request| request.contains("SET")
            && request.contains("cluster:node:fixture-proxy")
            && request.contains("\"role\":\"proxy\"")
            && request.contains("\"version\":\"fixture-version\"")
            && request.ends_with("$2\r\n30\r\n")));
        assert!(captured.iter().any(|request| request.contains("RPUSH")
            && request.contains("LTRIM")
            && request.contains("-500")));
        assert!(captured.iter().any(
            |request| request.contains("DEL") && request.contains("cluster:node:fixture-proxy")
        ));
    }

    #[tokio::test]
    async fn failure_reporting_applies_backpressure_without_spawning_per_event() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let env = Environment::from([(
            COORDINATION_URL_VAR.into(),
            format!("redis://127.0.0.1:{port}"),
        )]);
        let operations = RuntimeOperations::start(&env).await.unwrap();
        // The current-thread executor has not polled either background task yet.
        let mut accepted = 0;
        for _ in 0..LOCAL_QUEUE_MAX + 1 {
            accepted += usize::from(operations.report_failure(FailureEventInput {
                channel_id: "ch-42".into(),
                source: "ingest".into(),
                outcome: "spawn_failed".into(),
                exit_code: None,
                signal: None,
                rung_id: None,
                stderr_tail: String::new(),
                probe: Value::Null,
                decision: Value::Null,
                ..Default::default()
            }));
        }
        assert_eq!(accepted, LOCAL_QUEUE_MAX);
        assert_eq!(operations.dropped_failures(), 1);
        tokio::time::timeout(Duration::from_secs(7), operations.shutdown())
            .await
            .unwrap();
    }
}

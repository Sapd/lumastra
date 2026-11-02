// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Explicit, bounded test driver for the official native BullMQ client.
//! This is not a task owner or a production executor.

use bullmq::options::RedisConnectionOptions;
use bullmq::worker::{CancellationToken, WorkerEvent};
use bullmq::{
    FlowJob, FlowProducer, FlowProducerOptions, Job, JobOptions, JobProgress, ParentOptions, Queue,
    QueueEvents, QueueEventsOptions, QueueOptions, Worker, WorkerOptions,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

mod guarded;

const MAX_INPUT: u64 = 65_536;
const MAX_JOBS: usize = 32;

#[derive(Clone)]
struct Output(SyncSender<Option<Value>>);

impl Output {
    fn event(&self, event: Value) {
        // Do not let a paused parent grow the client's unbounded event queues.
        // The independent watchdog also bounds a wedged stdout writer.
        if self.0.try_send(Some(event)).is_err() {
            std::process::exit(74);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Produce {
    jobs: Vec<Add>,
    #[serde(default)]
    flow: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Add {
    name: String,
    data: Value,
    #[serde(default)]
    opts: JobOptions,
    #[serde(default)]
    children: Vec<Add>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Work {
    count: usize,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
    #[serde(default = "default_lock")]
    lock_ms: u64,
    #[serde(default = "default_renew")]
    renew_ms: u64,
    #[serde(default = "default_stall")]
    stall_ms: u64,
    #[serde(default)]
    close_after_ms: Option<u64>,
    #[serde(default)]
    cancel_after_ms: Option<u64>,
    // Test-only delayed confirmations exercise deadlines across real lease I/O.
    #[serde(default)]
    initial_renew_delay_ms: u64,
    #[serde(default)]
    final_renew_delay_ms: u64,
    #[serde(default)]
    periodic_renew_delay_ms: u64,
    #[serde(default)]
    completion_reply_delay_ms: u64,
}

fn default_timeout() -> u64 {
    15_000
}
fn default_lock() -> u64 {
    1_000
}
fn default_renew() -> u64 {
    200
}
fn default_stall() -> u64 {
    500
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn validate_target(url: &str, prefix: &str, queue: &str) -> Result<(), &'static str> {
    let url = Url::parse(url).map_err(|_| "invalid test connection")?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let database = url
        .path()
        .trim_start_matches('/')
        .parse::<u8>()
        .unwrap_or(0);
    if !matches!(url.scheme(), "redis" | "rediss") || !loopback || database == 0 {
        return Err("test connection must use loopback and a nonzero database");
    }
    let suffix = prefix.strip_prefix("lumastra-native-compat-").unwrap_or("");
    if !(16..=64).contains(&suffix.len()) || !suffix.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("test prefix must have a unique hexadecimal suffix");
    }
    if !queue.starts_with("compat-")
        || queue.len() > 96
        || !queue
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("invalid test queue name");
    }
    Ok(())
}

fn validate_jobs(jobs: &[Add], total: &mut usize, depth: usize) -> Result<(), &'static str> {
    if depth > 4 {
        return Err("flow nesting limit");
    }
    for job in jobs {
        *total += 1;
        if *total > MAX_JOBS
            || job.name.len() > 96
            || job.name.is_empty()
            || job.opts.attempts.unwrap_or(1) > 5
            || job.opts.delay.unwrap_or(0) > 5_000
            || job.opts.parent.is_some()
            || job
                .opts
                .job_id
                .as_ref()
                .is_some_and(|s| s.len() > 96 || s.is_empty() || s.contains(':'))
        {
            return Err("test job limit");
        }
        validate_jobs(&job.children, total, depth + 1)?;
    }
    Ok(())
}

fn flow_job(job: Add, queue: &str) -> FlowJob {
    FlowJob {
        name: job.name,
        queue_name: queue.to_owned(),
        data: job.data,
        opts: Some(job.opts),
        prefix: None,
        children: Some(
            job.children
                .into_iter()
                .map(|child| flow_job(child, queue))
                .collect(),
        ),
    }
}

async fn process_job(
    mut job: Job,
    token: CancellationToken,
    out: Output,
    queue_opts: Option<QueueOptions>,
) -> bullmq::Result<Value> {
    out.event(json!({"event":"processor-start", "id":job.id(), "attemptsMade":job.attempts_made(), "at":now()}));
    job.update_progress(JobProgress::Object(json!({"source":"rust", "percent":50})))
        .await?;
    let action = job
        .data()
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("echo")
        .to_owned();
    if action == "retry"
        && job.attempts_made()
            < job
                .data()
                .get("failUntil")
                .and_then(Value::as_u64)
                .unwrap_or(1) as u32
    {
        return Err(bullmq::Error::ProcessingError("fixture-transient".into()));
    }
    if action == "unrecoverable" {
        return Err(bullmq::Error::Unrecoverable("fixture-permanent".into()));
    }
    if action == "delay" && job.data().get("deferred") != Some(&Value::Bool(true)) {
        let mut data = job.data().clone();
        data["deferred"] = json!(true);
        job.update_data(data).await?;
        job.move_to_delayed(now() + 200).await?;
        return Err(bullmq::Error::Delayed);
    }
    if action == "waitchildren" && job.data().get("deferred") != Some(&Value::Bool(true)) {
        let opts = queue_opts.ok_or_else(|| {
            bullmq::Error::InvalidConfig("dynamic fixture requires queue options".into())
        })?;
        let queue = Queue::with_options(job.queue_name().unwrap_or(""), opts).await?;
        let mut data = job.data().clone();
        data["deferred"] = json!(true);
        job.update_data(data).await?;
        queue
            .add("dynamic-child", json!({"value":42}))
            .job_id(format!("{}-child", job.id()))
            .parent(ParentOptions {
                id: job.id().to_owned(),
                queue: job.queue_qualified_name().unwrap_or_default(),
                wait_children: None,
            })
            .await?;
        queue.close().await;
        if job.move_to_waiting_children(None).await? {
            return Err(bullmq::Error::WaitingChildren);
        }
    }
    if action == "sleep" || action == "hold" || action == "block" {
        let ms = job
            .data()
            .get("sleepMs")
            .and_then(Value::as_u64)
            .unwrap_or(1_500)
            .min(10_000);
        if action == "block" {
            // Negative control: a non-yielding future needs process quarantine.
            std::thread::sleep(Duration::from_millis(ms));
        } else {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
    }
    let children = job.get_children_values().await?;
    out.event(json!({"event":"processor-finished", "id":job.id(), "cancelled":token.is_cancelled(), "at":now()}));
    Ok(
        json!({"worker":"rust", "id":job.id(), "data":job.data(), "attemptsMade":job.attempts_made(), "children":children}),
    )
}

async fn operate(args: &[String], input: &str, out: Output) -> Result<(), &'static str> {
    if std::env::var("LUMASTRA_TASK_QUEUE_TEST").as_deref() != Ok("1") {
        return Err("explicit test opt-in required");
    }
    if args.len() != 4
        || !matches!(
            args[1].as_str(),
            "test-produce" | "test-worker" | "test-guarded-worker" | "test-events"
        )
    {
        return Err("expected explicit test command, prefix and queue");
    }
    let url = std::env::var("TEST_CACHE_URL").map_err(|_| "TEST_CACHE_URL required")?;
    validate_target(&url, &args[2], &args[3])?;
    let connection = RedisConnectionOptions::new().url(url);
    let queue_opts = QueueOptions::new()
        .connection(connection.clone())
        .prefix(&args[2]);
    if args[1] == "test-produce" {
        let req: Produce = serde_json::from_str(input).map_err(|_| "invalid produce input")?;
        validate_jobs(&req.jobs, &mut 0, 0)?;
        if req.flow {
            let producer = FlowProducer::with_options(
                FlowProducerOptions::new()
                    .connection(connection)
                    .prefix(&args[2]),
            )
            .await
            .map_err(|_| "flow connect failed")?;
            for add in req.jobs {
                let result = producer
                    .add(flow_job(add, &args[3]))
                    .await
                    .map_err(|_| "flow add failed")?;
                out.event(json!({"event":"produced", "id":result.job.id()}));
            }
            producer.close().await;
        } else {
            if req.jobs.iter().any(|job| !job.children.is_empty()) {
                return Err("children require flow mode");
            }
            let queue = Queue::with_options(&args[3], queue_opts)
                .await
                .map_err(|_| "queue connect failed")?;
            for add in req.jobs {
                let job = queue
                    .add(&add.name, add.data)
                    .options(add.opts)
                    .await
                    .map_err(|_| "queue add failed")?;
                out.event(json!({"event":"produced", "id":job.id()}));
            }
            queue.close().await;
        }
        return Ok(());
    }
    let req: Work = serde_json::from_str(input).map_err(|_| "invalid worker input")?;
    if req.count == 0
        || req.count > MAX_JOBS
        || !(100..=20_000).contains(&req.timeout_ms)
        || !(200..=5_000).contains(&req.lock_ms)
        || !(50..=req.lock_ms / 2).contains(&req.renew_ms)
        || !(100..=2_000).contains(&req.stall_ms)
        || req.close_after_ms.is_some_and(|n| n > req.timeout_ms)
        || req.cancel_after_ms.is_some_and(|n| n > req.timeout_ms)
        || req.initial_renew_delay_ms > 500
        || req.final_renew_delay_ms > 500
        || req.periodic_renew_delay_ms > 500
        || req.completion_reply_delay_ms > 500
    {
        return Err("test worker limits");
    }
    if args[1] == "test-events" {
        let events = QueueEvents::with_options(
            &args[3],
            QueueEventsOptions {
                connection,
                prefix: args[2].clone(),
                last_event_id: Some("0".into()),
                blocking_timeout: 100,
                ..Default::default()
            },
        )
        .await
        .map_err(|_| "events connect failed")?;
        let result = tokio::time::timeout(Duration::from_millis(req.timeout_ms), async {
            let mut completed = 0;
            while let Some(entry) = events.next_event().await {
                out.event(json!({"event":"queue-event", "name":entry.event.name(), "id":entry.event.job_id()}));
                if matches!(entry.event.name(), "completed" | "failed") { completed += 1; }
                if completed >= req.count { break; }
            }
        }).await;
        events.close().await;
        return result.map_err(|_| "events timed out");
    }
    let opts = WorkerOptions::new()
        .connection(connection)
        .prefix(&args[2])
        .concurrency(1)
        .lock_duration(Duration::from_millis(req.lock_ms))
        .lock_renew_time(Duration::from_millis(req.renew_ms))
        .stalled_interval(Duration::from_millis(req.stall_ms));
    if args[1] == "test-guarded-worker" {
        return guarded::work(&args[3], queue_opts, opts, req, out).await;
    }
    let processor_out = out.clone();
    let processor_queue_opts = queue_opts.clone();
    let worker = Worker::with_options(
        &args[3],
        move |job: Job, token: CancellationToken| {
            process_job(
                job,
                token,
                processor_out.clone(),
                Some(processor_queue_opts.clone()),
            )
        },
        opts,
    )
    .await
    .map_err(|_| "worker connect failed")?;
    let queue = Queue::with_options(&args[3], queue_opts)
        .await
        .map_err(|_| "queue connect failed")?;
    out.event(json!({"event":"ready"}));
    let started = tokio::time::Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(25));
    let result = loop {
        tokio::select! {
            event = worker.next_event() => {
                match event {
                    Some(WorkerEvent::Stalled {job_id}) => out.event(json!({"event":"stalled", "id":job_id})),
                    Some(WorkerEvent::Error(_)) => out.event(json!({"event":"worker-error"})),
                    Some(_) => {},
                    None => break Err("worker event stream closed"),
                }
            },
            _ = tick.tick() => {
                if req.close_after_ms.is_some_and(|n| started.elapsed().as_millis() >= u128::from(n)) {
                    let active = worker.active_count().await;
                    worker.close(100).await.map_err(|_| "worker close failed")?;
                    out.event(json!({"event":"close-returned", "activeBefore":active, "at":now()}));
                    // Observe detached processors after close, without claiming drain.
                    tokio::time::sleep(Duration::from_millis(1_000)).await;
                    break Ok(());
                }
                if started.elapsed().as_millis() >= u128::from(req.timeout_ms) { break Err("worker timed out"); }
                let counts = queue.get_job_counts().await.map_err(|_| "counts failed")?;
                if counts.completed + counts.failed >= req.count as u64 { break Ok(()); }
            }
        }
    };
    worker
        .close(1_000)
        .await
        .map_err(|_| "worker close failed")?;
    queue.close().await;
    result
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 2 && args[1] == "--version" {
        println!(
            "lumastra-task-queue {} (bullmq-official 1.4.0)",
            env!("CARGO_PKG_VERSION")
        );
        return;
    }
    if args.len() != 4
        || !matches!(
            args[1].as_str(),
            "test-produce" | "test-worker" | "test-guarded-worker" | "test-events"
        )
        || std::env::var("LUMASTRA_TASK_QUEUE_TEST").as_deref() != Ok("1")
    {
        eprintln!("No production mode: explicit test command and test opt-in required");
        std::process::exit(78);
    }
    // Bounded test process even if upstream I/O, shutdown, or stdout wedges.
    let hard_deadline = std::env::var("LUMASTRA_TASK_QUEUE_TEST_DEADLINE_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(30_000)
        .clamp(500, 30_000);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(hard_deadline));
        std::process::exit(124);
    });
    let (tx, rx) = sync_channel::<Option<Value>>(128);
    let writer = std::thread::spawn(move || {
        let mut stdout = std::io::stdout().lock();
        while let Ok(Some(event)) = rx.recv() {
            if serde_json::to_writer(&mut stdout, &event).is_err()
                || writeln!(stdout).is_err()
                || stdout.flush().is_err()
            {
                std::process::exit(74);
            }
        }
    });
    let mut input = String::new();
    let result = match std::io::stdin()
        .take(MAX_INPUT + 1)
        .read_to_string(&mut input)
    {
        Ok(_) if input.len() as u64 <= MAX_INPUT => {
            operate(&args, &input, Output(tx.clone())).await
        }
        _ => Err("test input exceeds limit or is not UTF-8"),
    };
    if let Err(message) = result {
        eprintln!("{message}");
    }
    let _ = tx.send(None);
    let _ = writer.join();
    std::process::exit(if result.is_ok() { 0 } else { 78 });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_production_targets_and_unowned_prefixes() {
        let prefix = "lumastra-native-compat-0123456789abcdef";
        assert!(validate_target("redis://127.0.0.1:6380/8", prefix, "compat-fixture").is_ok());
        for target in [
            "redis://127.0.0.1/0",
            "redis://prod.example/8",
            "http://127.0.0.1/8",
            "redis://localhost/",
            "redis://localhost/256",
        ] {
            assert!(validate_target(target, prefix, "compat-fixture").is_err());
        }
        assert!(validate_target("redis://localhost/8", "bull", "compat-fixture").is_err());
        assert!(validate_target("redis://localhost/8", prefix, "ordinary-queue").is_err());
    }
}

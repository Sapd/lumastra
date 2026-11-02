// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! A qualification executor using supported manual Worker/Job APIs.
//!
//! No upstream automatic processor tasks are spawned. A handler future belongs
//! to this stack frame and is dropped before drain returns. This establishes a
//! bounded async-handler boundary, not a durable generation fence for SQL,
//! progress, plugin processes, or external side effects.

use super::{Output, Work, now, process_job};
use bullmq::worker::CancellationToken;
use bullmq::{Job, Queue, QueueOptions, Worker, WorkerOptions};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::{Instant, sleep_until, timeout};

enum Outcome {
    Completed(Value),
    Lost,
    Drained,
}

struct Deadlines {
    cancel: Option<Instant>,
    stop: Instant,
    hard_stop: Instant,
    drain: bool,
}

impl Deadlines {
    fn reason(&self, admission: bool) -> Option<&'static str> {
        let time = Instant::now();
        if self.cancel.is_some_and(|deadline| time >= deadline) {
            return Some("cancel");
        }
        if time >= self.hard_stop {
            return Some(if self.drain {
                "drain-timeout"
            } else {
                "timeout"
            });
        }
        if admission && time >= self.stop {
            return Some("drain");
        }
        None
    }
}

fn interrupted(job: &Job, cancelled: &CancellationToken, out: &Output, reason: &str) -> Outcome {
    cancelled.cancel();
    out.event(json!({"event":"processor-aborted", "id":job.id(), "reason":reason, "cancelled":true, "at":now()}));
    Outcome::Drained
}

fn lost(job: &Job, cancelled: &CancellationToken, out: &Output) -> Outcome {
    cancelled.cancel();
    out.event(json!({"event":"ownership-lost", "id":job.id(), "cancelled":true, "at":now()}));
    Outcome::Lost
}

async fn renew(job: &Job, token: &str, req: &Work) -> bool {
    // Unlike the automatic worker renewer, this supported API rejects Lua 0.
    matches!(
        timeout(
            Duration::from_millis(req.renew_ms),
            job.extend_lock(token, req.lock_ms)
        )
        .await,
        Ok(Ok(()))
    )
}

async fn execute(
    job: &Job,
    req: &Work,
    out: &Output,
    deadlines: &Deadlines,
) -> Result<Outcome, &'static str> {
    let token = job.token().ok_or("manual claim missing lock token")?;
    let cancelled = CancellationToken::new();
    if let Some(reason) = deadlines.reason(true) {
        return Ok(interrupted(job, &cancelled, out, reason));
    }
    let owned = renew(job, token, req).await;
    if req.initial_renew_delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(req.initial_renew_delay_ms)).await;
    }
    // Cancellation may arrive while the real initial lease confirmation waits.
    if let Some(reason) = deadlines.reason(true) {
        return Ok(interrupted(job, &cancelled, out, reason));
    }
    if !owned {
        return Ok(lost(job, &cancelled, out));
    }
    let handler = process_job(job.clone(), cancelled.clone(), out.clone(), None);
    tokio::pin!(handler);
    // Schedule from each confirmation, avoiding interval Burst catch-up that
    // could starve a ready handler when successful Redis roundtrips are slow.
    let mut next_renew = Instant::now() + Duration::from_millis(req.renew_ms);
    let mut draining = false;
    let cancel_at = deadlines.cancel.unwrap_or(deadlines.hard_stop);
    loop {
        tokio::select! {
            biased;
            _ = sleep_until(cancel_at), if deadlines.cancel.is_some() => {
                return Ok(interrupted(job, &cancelled, out, "cancel"));
            }
            _ = sleep_until(deadlines.hard_stop) => {
                return Ok(interrupted(job, &cancelled, out, if deadlines.drain { "drain-timeout" } else { "timeout" }));
            }
            _ = sleep_until(deadlines.stop), if !draining => {
                draining = true;
                out.event(json!({"event":"drain-started", "id":job.id(), "at":now()}));
            }
            _ = sleep_until(next_renew) => {
                let owned = renew(job, token, req).await;
                if req.periodic_renew_delay_ms > 0 { tokio::time::sleep(Duration::from_millis(req.periodic_renew_delay_ms)).await; }
                next_renew = Instant::now() + Duration::from_millis(req.renew_ms);
                if let Some(reason) = deadlines.reason(false) { return Ok(interrupted(job, &cancelled, out, reason)); }
                if !owned { return Ok(lost(job, &cancelled, out)); }
            }
            value = &mut handler => {
                let value = value.map_err(|_| "guarded fixture handler failed")?;
                if let Some(reason) = deadlines.reason(false) { return Ok(interrupted(job, &cancelled, out, reason)); }
                let owned = renew(job, token, req).await;
                if req.final_renew_delay_ms > 0 { tokio::time::sleep(Duration::from_millis(req.final_renew_delay_ms)).await; }
                // Re-check after every await before proposing a terminal write.
                if let Some(reason) = deadlines.reason(false) { return Ok(interrupted(job, &cancelled, out, reason)); }
                if !owned { return Ok(lost(job, &cancelled, out)); }
                return Ok(Outcome::Completed(value));
            }
        }
    }
}

async fn complete(
    job: &mut Job,
    value: Value,
    req: &Work,
    deadlines: &Deadlines,
    out: &Output,
) -> Result<(), &'static str> {
    let encoded = value.to_string();
    let proposal = async {
        let result = job.move_to_completed(&encoded).await;
        if req.completion_reply_delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(req.completion_reply_delay_ms)).await;
        }
        result
    };
    let cancel_at = deadlines.cancel.unwrap_or(deadlines.hard_stop);
    let result = tokio::select! {
        biased;
        _ = sleep_until(cancel_at), if deadlines.cancel.is_some() => None,
        _ = sleep_until(deadlines.hard_stop) => None,
        reply = timeout(Duration::from_millis(req.renew_ms), proposal) => reply.ok(),
    };
    // A sent Redis command can commit after its future is cancelled. An expired
    // receipt is UNKNOWN, not a failed mutation that can safely be replayed.
    if !matches!(result, Some(Ok(()))) || deadlines.reason(false).is_some() {
        let reason = if matches!(result, Some(Err(_))) {
            "ack-error"
        } else {
            "ack-timeout-or-cancel"
        };
        out.event(
            json!({"event":"completion-uncertain", "id":job.id(), "reason":reason, "at":now()}),
        );
        return Err("completion receipt uncertain; reconcile before replay");
    }
    Ok(())
}

pub(super) async fn work(
    queue_name: &str,
    queue_opts: QueueOptions,
    opts: WorkerOptions,
    req: Work,
    out: Output,
) -> Result<(), &'static str> {
    // Control deadlines start before connection/claim, not after the handler starts.
    let start = Instant::now();
    let stop = start + Duration::from_millis(req.close_after_ms.unwrap_or(req.timeout_ms));
    let deadlines = Deadlines {
        cancel: req
            .cancel_after_ms
            .map(|ms| start + Duration::from_millis(ms)),
        stop,
        hard_stop: if req.close_after_ms.is_some() {
            stop + Duration::from_secs(1)
        } else {
            stop
        },
        drain: req.close_after_ms.is_some(),
    };
    let worker = Worker::with_options(
        queue_name,
        |_job: Job, _cancel: CancellationToken| async {
            Err(bullmq::Error::InvalidConfig(
                "automatic processor must never run".into(),
            ))
        },
        opts.manual_start(),
    )
    .await
    .map_err(|_| "manual worker connect failed")?;
    let queue = Queue::with_options(queue_name, queue_opts)
        .await
        .map_err(|_| "manual queue connect failed")?;
    out.event(json!({"event":"ready", "mode":"guarded-manual"}));
    let mut claimed = 0;
    let mut result = Ok(());
    while claimed < req.count && deadlines.reason(true).is_none() {
        let token = format!("{}-{claimed}", worker.id());
        let Some(mut job) = worker
            .get_next_job_nonblocking(&token)
            .await
            .map_err(|_| "manual claim failed")?
        else {
            tokio::time::sleep(Duration::from_millis(20)).await;
            continue;
        };
        claimed += 1;
        // Manual fetching emits Active; consume it so even a future bounded pool
        // does not accumulate upstream unbounded event-channel entries.
        while let Ok(Some(_)) = timeout(Duration::ZERO, worker.next_event()).await {}
        if !matches!(
            job.data()
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("echo"),
            "echo" | "sleep" | "hold" | "block"
        ) {
            result = Err(
                "guarded qualification supports echo/sleep only; retry policy is not implemented here",
            );
            break;
        }
        match execute(&job, &req, &out, &deadlines).await? {
            Outcome::Completed(value) => {
                if deadlines.reason(false).is_some() {
                    break;
                }
                if let Err(error) = complete(&mut job, value, &req, &deadlines, &out).await {
                    result = Err(error);
                    break;
                }
            }
            Outcome::Lost => {
                result = Err("guarded handler lost ownership");
                break;
            }
            Outcome::Drained => {
                if !deadlines.drain && deadlines.cancel.is_none() {
                    result = Err("guarded worker timed out");
                }
                break;
            }
        }
        if Instant::now() >= stop {
            break;
        }
    }
    // No handler future survives execute(). No automatic processor was started.
    worker
        .close(1_000)
        .await
        .map_err(|_| "manual worker close failed")?;
    queue.close().await;
    out.event(json!({"event":"close-returned", "liveHandlers":0, "at":now()}));
    if req.close_after_ms.is_none() && req.cancel_after_ms.is_none() && claimed != req.count {
        return Err("manual worker timed out");
    }
    result
}

// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! One-entry startup policy and cancellable media-playlist deadlines. No spawned
//! timer owns the request: dropping the response future cancels all future polls.
use crate::{http_contract::Rejection, media::MediaResponse};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub struct WaitLimits {
    pub poll: Duration,
    pub deadline: Duration,
}
impl Default for WaitLimits {
    fn default() -> Self {
        Self {
            poll: Duration::from_millis(250),
            deadline: Duration::from_secs(18),
        }
    }
}
#[derive(Default)]
pub struct WaitCounters {
    active: AtomicUsize,
}
impl WaitCounters {
    pub fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }
}
struct WaitGuard {
    counters: Arc<WaitCounters>,
    trace: Option<String>,
}
impl WaitGuard {
    fn start(counters: Arc<WaitCounters>, trace: Option<String>) -> Self {
        let active = counters.active.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(path) = &trace {
            println!(
                "{}",
                serde_json::json!({"event":"playlist_wait_start","path":path,"active":active})
            );
        }
        Self { counters, trace }
    }
}
impl Drop for WaitGuard {
    fn drop(&mut self) {
        let active = self.counters.active.fetch_sub(1, Ordering::SeqCst) - 1;
        if let Some(path) = &self.trace {
            println!(
                "{}",
                serde_json::json!({"event":"playlist_wait_end","path":path,"active":active})
            );
        }
    }
}
pub async fn wait_ready<F, G>(
    read: F,
    expired: G,
    counters: Arc<WaitCounters>,
    trace: Option<String>,
    limits: WaitLimits,
) -> MediaResponse
where
    F: Fn() -> MediaResponse,
    G: Fn() -> &'static str,
{
    let started = Instant::now();
    let mut guard = None;
    loop {
        let response = read();
        if !matches!(response, MediaResponse::Wait) {
            return response;
        }
        let elapsed = started.elapsed();
        if elapsed >= limits.deadline {
            return MediaResponse::Json(Rejection::error(404, expired()));
        }
        if guard.is_none() {
            guard = Some(WaitGuard::start(counters.clone(), trace.clone()));
        }
        tokio::time::sleep(limits.poll.min(limits.deadline - elapsed)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn dropping_a_pending_response_releases_waiter_and_timer() {
        let counters = Arc::new(WaitCounters::default());
        let observed = counters.clone();
        let request = tokio::spawn(async move {
            wait_ready(
                || MediaResponse::Wait,
                || "no_segments",
                observed,
                None,
                WaitLimits::default(),
            )
            .await;
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while counters.active() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        request.abort();
        let _ = request.await;
        assert_eq!(counters.active(), 0);
    }
}

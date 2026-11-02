// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Bounded, opt-in qualification of the real HTTP guard and a supplied FFmpeg.
//! Reads private configuration from stdin; URLs are never printed. Run only on
//! an explicitly authorized source. This does not exercise an Apple TV player.
//!
//! Built only with `--features soak`:
//! `cargo run --locked --release --features soak --example upstream_soak`.
//! Input (one JSON line): `url`, `ffmpeg`, `seconds` (30..900), `stderr` (a path that
//! must not exist yet; created 0600), optional `allow_private` (default false) and
//! `proxy` (default empty).
use lumastra_livetv_proxy::upstream::UpstreamGuard;
use serde::Deserialize;
use std::{
    io::BufRead,
    process::Stdio,
    time::{Duration, Instant},
};

/// `-readrate_initial_burst`: media read instantly at the start, so the wall-clock
/// run is this much shorter than the media duration.
const BURST_SECONDS: u64 = 12;

#[derive(Deserialize)]
struct Input {
    url: String,
    ffmpeg: String,
    seconds: u64,
    stderr: String,
    #[serde(default)]
    allow_private: bool,
    #[serde(default)]
    proxy: String,
}

fn private_stderr(path: &str) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let line = std::io::stdin()
        .lock()
        .lines()
        .next()
        .ok_or("missing configuration")??;
    // Never echo the input: it carries a private URL.
    let input: Input = serde_json::from_str(&line).map_err(|_| "invalid configuration")?;
    if !(30..=900).contains(&input.seconds) {
        return Err("duration must be 30..900 seconds".into());
    }
    let guard = UpstreamGuard::start(input.allow_private, &input.proxy)
        .await
        .map_err(|_| "relay startup failed")?;
    let url = guard.stream_url(&input.url).map_err(|_| "invalid source")?;
    let stderr = private_stderr(&input.stderr).map_err(|_| "stderr file must be new")?;
    let mut child = tokio::process::Command::new(input.ffmpeg)
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-threads",
            "2",
            "-readrate",
            "1",
            "-readrate_initial_burst",
            "12",
            "-live_start_index",
            "-6",
            "-i",
            &url,
            "-t",
            &(input.seconds + BURST_SECONDS).to_string(),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-f",
            "null",
            "-",
            "-progress",
            "pipe:1",
            "-stats_period",
            "5",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::from(stderr))
        .kill_on_drop(true)
        .spawn()?;
    let started = Instant::now();
    let status = tokio::time::timeout(
        Duration::from_secs(input.seconds + BURST_SECONDS + 60),
        child.wait(),
    )
    .await;
    let succeeded = match status {
        Ok(result) => result?.success(),
        Err(_) => {
            child.kill().await?;
            false
        }
    };
    let elapsed = started.elapsed();
    let guard_clean = guard.failure().is_none();
    guard.shutdown().await;
    if !succeeded {
        return Err("FFmpeg qualification failed; inspect private stderr".into());
    }
    if elapsed < Duration::from_secs(input.seconds) {
        return Err("FFmpeg ended before the requested duration".into());
    }
    if !guard_clean {
        return Err("upstream guard recorded a failure".into());
    }
    Ok(())
}

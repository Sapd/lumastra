// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use serde_json::json;
use std::io::{self, BufRead, Write};

const MAX_FIXTURE_LINE: usize = 64 * 1024;

fn operational_runtime() -> io::Result<tokio::runtime::Runtime> {
    // Tokio filesystem operations use its blocking pool. Its default 512-thread
    // ceiling is excessive for bounded media rings and small container PID limits.
    // Keep async workers independent so queued filesystem work cannot block IO.
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(
            std::thread::available_parallelism()
                .map_or(2, usize::from)
                .clamp(1, 8),
        )
        .max_blocking_threads(32)
        .enable_all()
        .build()
}

// Enforce the limit while reading: BufRead::lines/read_until alone could allocate
// without bound before a malicious or corrupt record's newline arrives.
fn evaluate_stream() -> io::Result<()> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut record = Vec::new();
    let mut oversized = false;
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            if !record.is_empty() || oversized {
                writeln!(output, "{}", json!({"error":"unterminated_fixture"}))?;
            }
            break;
        }
        let end = available.iter().position(|b| *b == b'\n');
        let count = end.map(|i| i + 1).unwrap_or(available.len());
        if !oversized {
            if record.len().saturating_add(count) > MAX_FIXTURE_LINE {
                record.clear();
                oversized = true;
            } else {
                record.extend_from_slice(&available[..count]);
            }
        }
        input.consume(count);
        if end.is_none() {
            continue;
        }
        let response = if oversized {
            json!({"error":"fixture_too_large"})
        } else {
            match serde_json::from_slice(&record) {
                Ok(value) => match lumastra_livetv_proxy::evaluate(&value) {
                    Ok(value) => json!({"result":value}),
                    Err(error) => json!({"error":error}),
                },
                Err(_) => json!({"error":"invalid_fixture"}),
            }
        };
        writeln!(output, "{response}")?;
        output.flush()?;
        record.clear();
        oversized = false;
    }
    Ok(())
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => println!("lumastra-livetv-proxy {}", env!("CARGO_PKG_VERSION")),
        Some("--contract-server") => {
            let Some(path) = std::env::args().nth(2) else {
                eprintln!("--contract-server requires a fixture path");
                std::process::exit(64);
            };
            let runtime = tokio::runtime::Runtime::new().expect("runtime initialization");
            if let Err(error) = runtime.block_on(lumastra_livetv_proxy::contract_server::run(&path))
            {
                eprintln!("contract server failed: {error}");
                std::process::exit(1);
            }
        }
        Some("--evaluate") => {
            if let Err(error) = evaluate_stream() {
                eprintln!("contract evaluator failed: {error}");
                std::process::exit(1);
            }
        }
        Some("--serve") => {
            let runtime = operational_runtime().expect("runtime initialization");
            let env = std::env::vars().collect();
            let result = runtime.block_on(lumastra_livetv_proxy::runtime_server::run(env));
            // Dropping the remaining tasks closes open connections and kills any child
            // a forced shutdown left behind (kill_on_drop), without waiting unbounded.
            runtime.shutdown_timeout(std::time::Duration::from_secs(1));
            if let Err(error) = result {
                eprintln!("Live TV proxy failed: {error}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!(
                "Native proxy is not ready for traffic; use --version, test-only --evaluate or --contract-server FIXTURE."
            );
            std::process::exit(78);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn blocking_work_stays_bounded_without_stalling_async_io() {
        let runtime = operational_runtime().unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        runtime.block_on(async {
            let jobs: Vec<_> = (0..96)
                .map(|_| {
                    let active = active.clone();
                    let peak = peak.clone();
                    tokio::task::spawn_blocking(move || {
                        let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(count, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        active.fetch_sub(1, Ordering::SeqCst);
                    })
                })
                .collect();
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            })
            .await
            .expect("async driver remains responsive");
            for job in jobs {
                job.await.unwrap();
            }
        });
        assert!(peak.load(Ordering::SeqCst) <= 32);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
}

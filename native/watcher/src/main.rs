// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use lumastra_watcher::{
    Engine, Init, Message, ModifyCoalescer, NullBackend, OUTPUT_CAPACITY, Output, PROTOCOL_VERSION,
    RAW_CAPACITY, Raw, make_watcher, raw_waker, read_frame, write_output,
};
use std::error::Error;
use std::fmt::Display;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant};

const LOOP_INTERVAL: Duration = Duration::from_millis(50);
const EVENT_BATCH: usize = 1024;
const WRITER_DRAIN: Duration = Duration::from_secs(1);

/// The reason the child stops; reported as a final fatal `error` frame.
struct Fatal {
    message: String,
    code: Option<&'static str>,
}

impl<E: Display> From<E> for Fatal {
    fn from(error: E) -> Self {
        Self {
            message: error.to_string(),
            code: None,
        }
    }
}

fn read_init(input: &mut impl BufRead) -> Result<Init, Box<dyn Error>> {
    let frame = read_frame(input)?.ok_or("missing init frame")?;
    let config: Init = serde_json::from_slice(&frame)?;
    config.validate()?;
    Ok(config)
}

/// Initial walk only; prints every eligible path as one JSON string per line.
fn snapshot() -> Result<(), Box<dyn Error>> {
    let config = read_init(&mut BufReader::new(io::stdin()))?;
    let mut engine = Engine::new(config, NullBackend, Output::new(OUTPUT_CAPACITY))?;
    engine.initial_walk_complete();
    if let Some(reason) = engine.fatal() {
        return Err(reason.into());
    }
    let mut out = BufWriter::new(io::stdout().lock());
    for path in engine.snapshot() {
        serde_json::to_writer(&mut out, &path)?;
        out.write_all(b"\n")?;
    }
    out.flush()?;
    Ok(())
}

fn run(output: &Output, shutdown: &Arc<AtomicBool>) -> Result<(), Fatal> {
    let mut input = BufReader::new(io::stdin());
    let config = read_init(&mut input)?;
    let control_failed = Arc::new(AtomicBool::new(false));
    {
        let shutdown = shutdown.clone();
        let control_failed = control_failed.clone();
        thread::Builder::new()
            .name("watcher-control".into())
            .spawn(move || {
                // Unknown/malformed control frames close the process rather than guessing.
                match read_frame(&mut input) {
                    Ok(Some(frame)) => {
                        if serde_json::from_slice::<serde_json::Value>(&frame)
                            .ok()
                            .is_none_or(|v| v != serde_json::json!({"type":"close"}))
                        {
                            eprintln!("invalid watcher control frame");
                            control_failed.store(true, Ordering::Release);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!("watcher control read failed: {error}");
                        control_failed.store(true, Ordering::Release);
                    }
                }
                shutdown.store(true, Ordering::Release);
            })?;
    }
    let (sender, events) = mpsc::sync_channel(RAW_CAPACITY);
    let overflow = Arc::new(AtomicBool::new(false));
    let coalescer = ModifyCoalescer::new();
    let watcher = make_watcher(sender.clone(), overflow.clone(), coalescer.clone())?;
    let mut engine = Engine::new(config, watcher, output.clone())?;
    engine.set_waker(raw_waker(sender));
    engine.set_shutdown(shutdown.clone());
    engine.initial_walk();
    if shutdown.load(Ordering::Acquire) {
        return finish(&control_failed);
    }
    if let Some(reason) = engine.fatal() {
        return Err(reason.into());
    }
    // A root on a hung mount has no watches yet; it is reported as stalled, not fatal.
    if !engine.has_watches() && engine.stalled_roots() == 0 {
        return Err(match engine.watch_limit_message() {
            Some(message) => Fatal {
                message,
                code: Some("watch_limit"),
            },
            None => "no filesystem subscriptions could be registered".into(),
        });
    }
    if !output.send_blocking(Message::Ready {
        version: PROTOCOL_VERSION,
    }) {
        return Err("watcher output closed".into());
    }
    engine.after_ready();
    while !shutdown.load(Ordering::Acquire) {
        match events.recv_timeout(LOOP_INTERVAL) {
            Ok(raw) => {
                for raw in std::iter::once(raw).chain(events.try_iter().take(EVENT_BATCH)) {
                    coalescer.release(&raw);
                    // A wake only means lane results are waiting; `tick` drains them.
                    if let Raw::Fs(event) = raw {
                        engine.handle(event);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("filesystem event source disconnected".into());
            }
        }
        if overflow.swap(false, Ordering::AcqRel) {
            engine.request_full_rescan("raw filesystem event queue overflow", true);
        }
        engine.tick(Instant::now());
        if let Some(reason) = engine.fatal() {
            return Err(reason.into());
        }
    }
    finish(&control_failed)
}

fn finish(control_failed: &AtomicBool) -> Result<(), Fatal> {
    if control_failed.load(Ordering::Acquire) {
        return Err("invalid watcher control protocol".into());
    }
    Ok(())
}

/// Runs the watcher; on exit the queued output (and a final fatal frame) gets up to one
/// second to reach the bridge.
fn child() -> i32 {
    let output = Output::new(OUTPUT_CAPACITY);
    let shutdown = Arc::new(AtomicBool::new(false));
    let (drained, writer_done) = mpsc::channel::<()>();
    let writer = {
        let output = output.clone();
        let shutdown = shutdown.clone();
        thread::Builder::new()
            .name("watcher-output".into())
            .spawn(move || {
                if let Err(error) = write_output(io::stdout().lock(), &output) {
                    eprintln!("lumastra-watcher: output failed: {error}");
                    shutdown.store(true, Ordering::Release);
                }
                output.close();
                let _ = drained.send(());
            })
    };
    let code = match writer {
        Err(error) => {
            eprintln!("lumastra-watcher: cannot start output thread: {error}");
            return 1;
        }
        Ok(_) => match run(&output, &shutdown) {
            Ok(()) => 0,
            Err(fatal) => {
                eprintln!("lumastra-watcher: {}", fatal.message);
                output.send(Message::Error {
                    message: fatal.message,
                    fatal: true,
                    code: fatal.code,
                });
                1
            }
        },
    };
    output.close();
    let _ = writer_done.recv_timeout(WRITER_DRAIN);
    code
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => std::process::exit(child()),
        [flag] if flag == "--version" => {
            println!(
                "lumastra-watcher {} protocol {PROTOCOL_VERSION}",
                env!("CARGO_PKG_VERSION")
            );
        }
        [flag] if flag == "--snapshot" => {
            if let Err(error) = snapshot() {
                eprintln!("lumastra-watcher: {error}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("unsupported watcher arguments");
            std::process::exit(2);
        }
    }
}

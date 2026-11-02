// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Bounded stdout queue. A message that does not fit is dropped and latches a rescan that
//! the writer emits only once every message queued before the drop has been written.

use crate::{MAX_LINE, Message};
use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

const OVERFLOW_REASON: &str = "watcher output queue overflow; events were dropped";

struct State {
    queue: VecDeque<Message>,
    overflow: Option<String>,
    closed: bool,
}

struct Inner {
    state: Mutex<State>,
    signal: Condvar,
    capacity: usize,
}

#[derive(Clone)]
pub struct Output {
    inner: Arc<Inner>,
}

impl Output {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State {
                    queue: VecDeque::with_capacity(capacity),
                    overflow: None,
                    closed: false,
                }),
                signal: Condvar::new(),
                capacity,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Queue without blocking; false means dropped or closed. Only a dropped event (or
    /// rescan) latches a rescan; `alive` and `status` replace a queued record of their kind.
    pub fn send(&self, message: Message) -> bool {
        let mut state = self.lock();
        if state.closed {
            return false;
        }
        if matches!(message, Message::Alive { .. } | Message::Status(_)) {
            let same = |queued: &Message| {
                std::mem::discriminant(queued) == std::mem::discriminant(&message)
            };
            if let Some(queued) = state.queue.iter_mut().rev().find(|q| same(q)) {
                *queued = message;
                return true;
            }
        }
        if state.queue.len() >= self.inner.capacity {
            if matches!(message, Message::Event { .. } | Message::Rescan { .. }) {
                state
                    .overflow
                    .get_or_insert_with(|| OVERFLOW_REASON.to_string());
            }
            return false;
        }
        state.queue.push_back(message);
        drop(state);
        self.inner.signal.notify_all();
        true
    }

    /// Wait for queue space; for control frames that must not be dropped (`ready`).
    pub fn send_blocking(&self, message: Message) -> bool {
        let mut state = self.lock();
        while !state.closed && state.queue.len() >= self.inner.capacity {
            state = self
                .inner
                .signal
                .wait_timeout(state, Duration::from_millis(100))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        if state.closed {
            return false;
        }
        state.queue.push_back(message);
        drop(state);
        self.inner.signal.notify_all();
        true
    }

    pub fn close(&self) {
        self.lock().closed = true;
        self.inner.signal.notify_all();
    }

    pub fn queued(&self) -> usize {
        self.lock().queue.len()
    }

    /// Next message, the latched rescan once the queue is empty, or None after close.
    fn next(&self) -> Option<(Message, bool)> {
        let mut state = self.lock();
        loop {
            if let Some(message) = state.queue.pop_front() {
                let drained = state.queue.is_empty() && state.overflow.is_none();
                return Some((message, drained));
            }
            if let Some(reason) = state.overflow.take() {
                return Some((Message::Rescan { reason }, true));
            }
            if state.closed {
                return None;
            }
            state = self
                .inner
                .signal
                .wait_timeout(state, Duration::from_millis(100))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

pub fn write_output(writer: impl Write, output: &Output) -> io::Result<()> {
    let mut writer = io::BufWriter::new(writer);
    loop {
        let next = output.next();
        output.inner.signal.notify_all();
        let Some((message, drained)) = next else {
            writer.flush()?;
            return Ok(());
        };
        let line = serde_json::to_vec(&message)?;
        if line.len() + 1 > MAX_LINE {
            output
                .lock()
                .overflow
                .get_or_insert_with(|| "watcher frame exceeded 1 MiB".to_string());
            continue;
        }
        writer.write_all(&line)?;
        writer.write_all(b"\n")?;
        if drained {
            writer.flush()?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(i: usize) -> Message {
        Message::Event {
            event: "add",
            path: format!("/media/{i}.mkv"),
        }
    }

    #[test]
    fn dropped_event_rescan_follows_already_queued_events() {
        let output = Output::new(4);
        for i in 0..4 {
            assert!(output.send(event(i)));
        }
        assert!(!output.send(event(4)));
        assert!(!output.send(event(5)));
        assert_eq!(output.queued(), 4);
        output.close();
        let mut bytes = Vec::new();
        write_output(&mut bytes, &output).unwrap();
        let lines: Vec<serde_json::Value> = bytes
            .split(|b| *b == b'\n')
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_slice(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 5);
        for (i, line) in lines.iter().take(4).enumerate() {
            assert_eq!(line["path"], format!("/media/{i}.mkv"));
        }
        assert_eq!(lines[4]["type"], "rescan");
    }

    #[test]
    fn alive_and_status_coalesce_and_never_latch_a_rescan() {
        let output = Output::new(3);
        assert!(output.send(Message::Alive { seq: 1 }));
        assert!(output.send(event(0)));
        assert!(output.send(Message::Alive { seq: 2 }));
        assert_eq!(output.queued(), 2);
        assert!(output.send(event(1)));
        // Full: an error frame is dropped without latching a rescan.
        assert!(!output.send(Message::Error {
            message: "x".into(),
            fatal: false,
            code: None
        }));
        output.close();
        let mut bytes = Vec::new();
        write_output(&mut bytes, &output).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("rescan"), "{text}");
        let first: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(first["seq"], 2);
    }

    #[test]
    fn writer_drains_concurrently_and_blocking_send_waits_for_space() {
        let output = Output::new(1);
        assert!(output.send(event(0)));
        let writer_output = output.clone();
        let writer = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            write_output(&mut bytes, &writer_output).unwrap();
            bytes
        });
        assert!(output.send_blocking(Message::Ready { version: 2 }));
        while output.queued() > 0 {
            std::thread::sleep(Duration::from_millis(5));
        }
        output.close();
        let bytes = writer.join().unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(!text.contains("rescan"));
        assert!(!output.send(event(1)));
    }
}

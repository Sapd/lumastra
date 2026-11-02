// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared Server-Sent Events helpers.
 *
 * Single source of truth for the keepalive interval, plus a small helper that
 * removes the hand-rolled `setInterval` + try/catch + clearInterval boilerplate
 * every SSE endpoint used to duplicate.
 *
 * Long-lived multiplexing streams (the per-user / runs / ingest buses) use the
 * fan-out loop in `sse-replay-hub.ts` instead; they still read
 * {@link SSE_KEEPALIVE_MS} so the interval stays consistent everywhere.
 */

/**
 * Keepalive interval (ms) for long-lived SSE streams.
 *
 * The binding constraint is the client transport's idle timeout — notably
 * HTTP/3 (QUIC), which closes an idle connection after ~30 s. A stream that
 * goes quiet between real events (e.g. a paused watch party, an idle run) would
 * otherwise be torn down mid-session. 10 s keeps the connection warm with margin
 * over common QUIC idle defaults; the TCP-side proxy timeouts (nginx
 * `proxy_read_timeout`, HAProxy `timeout server`) are all >= 3600 s and were
 * never the closer. Also comfortably inside the watch-together liveness window
 * (`CONNECTION_STALE_MS`, 90 s).
 */
export const SSE_KEEPALIVE_MS = 10_000;

/**
 * SSE keepalive comment frame. A `:`-prefixed line is an SSE comment —
 * `EventSource` ignores it entirely (fires no message/named event) — so it is a
 * safe way to push bytes through the transport/proxy chain to reset idle timers
 * without the client mistaking it for an event.
 */
const KEEPALIVE_FRAME = new TextEncoder().encode(': ping\n\n');

export interface SseKeepaliveOptions {
    /** Interval between keepalive frames (ms). Defaults to {@link SSE_KEEPALIVE_MS}. */
    intervalMs?: number;
    /** Called after each successful keepalive write (e.g. refresh a liveness marker). */
    onTick?: () => void;
    /**
     * Called once when a keepalive write throws — i.e. the client has gone and
     * the controller is closed. The ticker stops itself first; use this to run
     * any additional teardown the caller needs.
     */
    onDead?: () => void;
}

/**
 * Start a keepalive ticker that writes an SSE comment frame to `controller`
 * every {@link SseKeepaliveOptions.intervalMs} (default {@link SSE_KEEPALIVE_MS}).
 *
 * Returns a stop function (idempotent). If a write throws — the client
 * disconnected and the stream controller is closed — the ticker self-clears and
 * invokes `onDead` once.
 */
export function startSseKeepalive(
    controller: ReadableStreamDefaultController<Uint8Array>,
    opts: SseKeepaliveOptions = {},
): () => void {
    const intervalMs = opts.intervalMs ?? SSE_KEEPALIVE_MS;
    // intervalMs <= 0 disables the keepalive (matches the sse-replay-hub "0 = off"
    // convention). Return an inert stop() so callers need no special-casing.
    if (intervalMs <= 0) return () => {};

    let stopped = false;
    const timer = setInterval(() => {
        if (stopped) return;
        // A failed WRITE is the only reliable "client is gone" signal. Keep it
        // strictly separate from the user callback below so an unrelated onTick
        // bug can't be misread as a disconnect and tear down a healthy stream.
        try {
            controller.enqueue(KEEPALIVE_FRAME);
        } catch {
            stopped = true;
            clearInterval(timer);
            try {
                opts.onDead?.();
            } catch {
                // onDead is best-effort teardown — never let it escape the tick.
            }
            return;
        }
        // Runs only after a successful write; isolated so a throwing onTick does
        // not kill an otherwise-healthy connection.
        try {
            opts.onTick?.();
        } catch {
            // swallow — onTick failure is not a disconnect
        }
    }, intervalMs);

    return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
    };
}

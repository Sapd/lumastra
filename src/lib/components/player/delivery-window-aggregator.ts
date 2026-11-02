// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DeliveryWindowAggregator — the receiver's own delivery timer.
 *
 * Server-side segment timing measures a write into a 16 MB socket buffer: a
 * 7 MB segment "delivers" in 0.1 s while the viewer still has nothing. So the
 * only honest measurement of what a link actually carried has to be taken where
 * the bytes land. hls.js hands us per-fragment `LoadStats` timings; this folds
 * them into fixed 30 s windows so one telemetry row describes a stretch of the
 * session instead of one segment (per-segment rows would be thousands per hour
 * and would still need windowing to mean anything).
 *
 * Two deliberate choices, both pinned by tests:
 *  - Throughput is summed BYTES over summed TRANSFER time, not the mean of
 *    per-segment rates: the mean over-weights small segments and flatters a
 *    link that stalled on the big ones.
 *  - `wallMaxMs` / `ttfbMaxMs` / `minSegBps` are worst-cases. An operator
 *    looking at an incident needs the segment that went wrong; an average is
 *    exactly the thing that hides it.
 */

/** One completed fragment download, as timed by the receiver. */
export interface FragmentDeliverySample {
    /** Bytes actually received (`stats.loaded`). */
    bytes: number;
    /** Media seconds the fragment covers (`frag.duration`). */
    mediaSec: number;
    /** Whole request, request-start → last byte (includes TTFB). */
    requestMs: number;
    /** First byte → last byte. The interval that carried the bytes. */
    transferMs: number;
    /** Request-start → first byte. */
    ttfbMs: number;
    /** When the download finished, on the `performance.now()` clock. */
    endedAt: number;
}

/** One closed window, ready to be reported as a `delivery_window` event. */
export interface DeliveryWindow {
    /** Achieved bits per second across the window. */
    throughputBps: number;
    bytes: number;
    segments: number;
    mediaSec: number;
    /** Summed transfer time — the denominator of `throughputBps`. */
    transferMs: number;
    /** Worst whole-request time in the window. */
    wallMaxMs: number;
    /** Worst time-to-first-byte in the window. */
    ttfbMaxMs: number;
    /** Slowest single segment, in bits per second. */
    minSegBps: number;
}

/** Window length. Matches the AVPlayer reporter so the two are comparable. */
export const DELIVERY_WINDOW_MS = 30_000;

export class DeliveryWindowAggregator {
    /** `performance.now()` of the first sample in the open window; null = none. */
    private windowStart: number | null = null;
    private bytes = 0;
    private segments = 0;
    private mediaSec = 0;
    private transferMs = 0;
    private wallMaxMs = 0;
    private ttfbMaxMs = 0;
    private minSegBps = Number.POSITIVE_INFINITY;

    constructor(private readonly windowMs: number = DELIVERY_WINDOW_MS) {}

    /**
     * Feed one completed fragment download.
     *
     * Returns a closed window when `sample.endedAt` lands past the open
     * window's boundary (and that window held at least one segment); the
     * crossing sample then opens the next window rather than being folded into
     * the one it closed. Otherwise returns null.
     *
     * A sample with a non-positive `transferMs` is ignored outright: it carries
     * no measurable rate, and dividing by it would poison the whole window.
     */
    push(sample: FragmentDeliverySample): DeliveryWindow | null {
        // `>` (not `!(<= 0)`) so a NaN transferMs is rejected too.
        if (!(sample.transferMs > 0)) return null;

        let closed: DeliveryWindow | null = null;

        if (this.windowStart === null) {
            this.windowStart = sample.endedAt;
        } else if (sample.endedAt - this.windowStart >= this.windowMs) {
            closed = this.close();
            this.windowStart = sample.endedAt;
        }

        this.bytes += sample.bytes;
        this.segments += 1;
        this.mediaSec += sample.mediaSec;
        this.transferMs += sample.transferMs;
        this.wallMaxMs = Math.max(this.wallMaxMs, sample.requestMs);
        this.ttfbMaxMs = Math.max(this.ttfbMaxMs, sample.ttfbMs);
        this.minSegBps = Math.min(this.minSegBps, (sample.bytes * 8) / (sample.transferMs / 1000));

        return closed;
    }

    /**
     * Close the open window early — session end, or a play-session swap. Null
     * when nothing has been accumulated, so an idle session reports nothing
     * rather than a zero-byte window that would read as "the link died".
     */
    flush(): DeliveryWindow | null {
        if (this.segments === 0) {
            this.windowStart = null;
            return null;
        }
        const window = this.close();
        this.windowStart = null;
        return window;
    }

    /** Snapshot the accumulated window and reset the accumulators. */
    private close(): DeliveryWindow {
        const window: DeliveryWindow = {
            throughputBps: (this.bytes * 8) / (this.transferMs / 1000),
            bytes: this.bytes,
            segments: this.segments,
            mediaSec: this.mediaSec,
            transferMs: this.transferMs,
            wallMaxMs: this.wallMaxMs,
            ttfbMaxMs: this.ttfbMaxMs,
            // Finite by construction (segments >= 1 here), but never emit
            // Infinity into telemetry if that ever stops holding.
            minSegBps: Number.isFinite(this.minSegBps) ? this.minSegBps : 0,
        };

        this.bytes = 0;
        this.segments = 0;
        this.mediaSec = 0;
        this.transferMs = 0;
        this.wallMaxMs = 0;
        this.ttfbMaxMs = 0;
        this.minSegBps = Number.POSITIVE_INFINITY;

        return window;
    }
}

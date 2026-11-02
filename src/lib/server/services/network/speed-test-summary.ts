// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure result maths for the active network speed test.
 *
 * The client downloads an incompressible payload, timing itself, and posts the
 * raw counters here. This module turns those counters into the derived numbers
 * shown to the user / stored for diagnostics.
 *
 * Two shapes arrive here, distinguished by `mode`:
 *
 *  - `single` / `long` — ONE download, timed in 250 ms buckets. Throughput comes
 *    from the buckets' total, and an empty bucket is a stall.
 *  - `cadence` — 8 sequential 4 MiB fetches 2 s apart, mimicking an HLS segment
 *    pattern. Buckets are not sent; the per-request list is. Its `durationMs`
 *    includes the deliberate pauses, so the pauses must be excluded from the
 *    throughput denominator — otherwise every cadence run would report roughly
 *    half its real speed and the pauses would read as stalls.
 */

import { SPEED_TEST_CADENCE_GAP_MS } from '$lib/schemas/playback';
import type {
    SpeedTestMode,
    SpeedTestRequestInput,
    SpeedTestResultInput,
} from '$lib/schemas/playback';

export interface SpeedTestSummary {
    throughputBps: number;
    minBucketBps: number | null;
    stallMs: number;
    /** 1 for a single/long run, the per-request count for a cadence run. */
    requestCount: number;
    /** Cadence only — the worst first-byte across the run. */
    maxTtfbMs: number | null;
    /** Cadence only — the slowest individual request, in bits per second. */
    minRequestBps: number | null;
    /** The deliberate pause between cadence requests; null for one-shot modes. */
    gapMs: number | null;
}

/**
 * What the maths needs out of a posted result.
 *
 * `mode` is optional here (rather than taken straight from the schema output,
 * where it defaults to `'single'`) so a caller holding only the raw counters —
 * every pre-modes call site and test — still type-checks and still gets the
 * single-download maths.
 */
export type SpeedTestSummaryInput = Pick<
    SpeedTestResultInput,
    'bytesReceived' | 'durationMs' | 'ttfbMs' | 'buckets'
> & {
    mode?: SpeedTestMode;
    requests?: SpeedTestRequestInput[];
};

/** In-flight milliseconds for one request, floored at 1 to never divide by zero. */
function transferMsOf(r: { durationMs: number; ttfbMs: number }): number {
    return Math.max(r.durationMs - r.ttfbMs, 1);
}

/**
 * Summarise a completed (or aborted) speed test result.
 *
 * - `throughputBps` is measured over transfer time only, excluding TTFB, so a
 *   slow first byte doesn't drag down the reported bandwidth. For cadence it is
 *   the summed per-request BYTES over the summed per-request transfer windows —
 *   never the wall clock, which contains the 2 s pauses.
 * - `minBucketBps` / `stallMs` describe the 250 ms bucket series, so both are
 *   null / 0 for cadence, which sends no buckets.
 * - `minRequestBps` / `maxTtfbMs` describe the per-request series, so both are
 *   null for single and long, which have exactly one request.
 */
export function summariseSpeedTest(r: SpeedTestSummaryInput): SpeedTestSummary {
    const requests = r.requests ?? [];

    if (r.mode === 'cadence') {
        let bytes = 0;
        let inFlightMs = 0;
        let maxTtfbMs: number | null = null;
        let minRequestBps: number | null = null;
        for (const req of requests) {
            bytes += req.bytes;
            inFlightMs += transferMsOf(req);
            const bps = ((req.bytes * 8) / transferMsOf(req)) * 1000;
            if (minRequestBps === null || bps < minRequestBps) minRequestBps = bps;
            if (maxTtfbMs === null || req.ttfbMs > maxTtfbMs) maxTtfbMs = req.ttfbMs;
        }

        // Both sides of the division come from the per-request series: the bytes
        // the requests actually carried over the time they were actually in
        // flight. The schema pins `Σ requests[].bytes === bytesReceived`, so the
        // two agree on a valid payload — taking the sum anyway means the number
        // can never be computed from a total the timings do not account for.
        //
        // A cadence run with no requests is rejected by the schema (422), so the
        // empty case only guards a direct call: fall back to the wall-clock
        // maths rather than dividing a sum of nothing by a sum of nothing.
        const throughputBps = requests.length
            ? ((bytes * 8) / inFlightMs) * 1000
            : ((r.bytesReceived * 8) / transferMsOf(r)) * 1000;

        return {
            throughputBps,
            // Buckets are not part of a cadence run; the schema refuses one that
            // carries any, and a direct caller's are ignored rather than mixed in.
            minBucketBps: null,
            stallMs: 0,
            requestCount: requests.length,
            maxTtfbMs,
            minRequestBps,
            gapMs: SPEED_TEST_CADENCE_GAP_MS,
        };
    }

    const throughputBps = ((r.bytesReceived * 8) / transferMsOf(r)) * 1000;

    const rest = r.buckets.slice(1);
    let minBucketBps: number | null = null;
    let stallMs = 0;

    for (const bucket of rest) {
        const bucketBps = ((bucket.bytes * 8) / bucket.ms) * 1000;
        if (minBucketBps === null || bucketBps < minBucketBps) {
            minBucketBps = bucketBps;
        }
        if (bucket.bytes === 0) {
            stallMs += bucket.ms;
        }
    }

    return {
        throughputBps,
        minBucketBps,
        stallMs,
        requestCount: 1,
        maxTtfbMs: null,
        minRequestBps: null,
        gapMs: null,
    };
}

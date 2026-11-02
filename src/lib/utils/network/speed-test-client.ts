// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * speed-test-client.ts — the browser half of the active network measurement.
 *
 * `GET /api/network/speed-test` streams an incompressible payload and records
 * NOTHING about the transfer: a server-side timer would measure a socket write,
 * not the user's line. So the measurement is taken here, on the receiving end of
 * the wire, and posted to `/api/network/speed-test/results`, which derives
 * throughput / slowest-bucket / stall from these raw counters.
 *
 * Everything in this module is injectable (`fetchImpl`, `now`) so the timing
 * logic is unit-testable without a network and without a wall clock.
 */

import { apiUrl } from '$lib/shared/api-urls.js';
import {
    SPEED_TEST_CADENCE_CHUNK_BYTES,
    SPEED_TEST_CADENCE_GAP_MS,
    SPEED_TEST_CADENCE_REQUESTS,
    SPEED_TEST_DEFAULT_BYTES,
    SPEED_TEST_LONG_BYTES,
    SPEED_TEST_LONG_CAP_MS,
    SPEED_TEST_MAX_BYTES,
    SPEED_TEST_MIN_BYTES,
    type SpeedTestMode,
    type SpeedTestRequestInput,
} from '$lib/schemas/playback.js';

/** Width of one measurement bucket. Matches `summariseSpeedTest()`'s assumption. */
export const SPEED_TEST_BUCKET_MS = 250;

/**
 * Hard ceiling on one test. On a link slow enough to need 20 s for the payload
 * the answer is already known, and the bytes that did arrive carry it — so the
 * transfer is aborted and reported as `aborted: true` rather than left to run.
 */
export const SPEED_TEST_CAP_MS = 20_000;

/**
 * Bucket ceiling for the `single` profile (and each discarded cadence leg,
 * below). NOT the schema's limit — `speedTestResultSchema` accepts up to 240,
 * see {@link MAX_BUCKETS_LONG} — but a self-imposed one sized for the 20 s cap
 * above: 20 s / 250 ms is only 80 buckets, so 120 (30 s worth) leaves headroom.
 *
 * That headroom turns out to matter: the cap is a `setTimeout`, and a
 * SUSPENDED tab does not fire timers. It resumes minutes later, `finish()`
 * measures `elapsed` from the wall clock, and `durationMs` is clamped to
 * {@link MAX_REPORTED_MS} (120 s) rather than to 20 s. So this ceiling IS
 * reachable, and when it bites the bucket series describes only the FIRST 30 s
 * of a transfer whose `throughputBps` covers the whole reported duration. That
 * is the deliberate trade: a truncated series the server accepts beats a
 * complete one it 422s. Read a 120-bucket result as "the shape of the first
 * 30 s", not as the shape of the run. The `long` profile uses
 * {@link MAX_BUCKETS_LONG} (240) instead of this ceiling.
 */
const MAX_BUCKETS = 120;

/**
 * The `long` profile's 60 s cap at 250 ms is exactly 240 buckets — which is also
 * `speedTestResultSchema`'s ceiling. A longer run (a suspended tab) is truncated
 * to the first 60 s of shape for the same reason the 120 above exists.
 */
const MAX_BUCKETS_LONG = 240;

/**
 * `speedTestResultSchema` caps `durationMs` and `ttfbMs` at 120 s. A tab the OS
 * suspended mid-transfer can resume far past that, so both are clamped here
 * rather than discovered as a 422 when the measurement is posted.
 */
const MAX_REPORTED_MS = 120_000;

export interface SpeedTestProgress {
    bytesReceived: number;
    elapsedMs: number;
}

export interface SpeedTestMeasurement {
    bytesRequested: number;
    bytesReceived: number;
    durationMs: number;
    ttfbMs: number;
    aborted: boolean;
    buckets: { ms: number; bytes: number }[];
    /**
     * Per-fetch timings — present ONLY for a `cadence` run, which is what it is
     * measuring: eight separate fetches, not one stream. `single`/`long` leave
     * it undefined, which is also what the server's schema demands (`requests`
     * is rejected outright for those modes).
     *
     * The `mode` itself is deliberately NOT echoed back here: the caller chose
     * it, so it already has it, and it passes the same value to the results POST.
     */
    requests?: SpeedTestRequestInput[];
}

/**
 * Folds (arrival timestamp, chunk length) pairs into fixed-width buckets.
 *
 * Pure and clock-free — it is handed timestamps rather than reading one — which
 * is what makes the stall/ramp-up behaviour testable. A bucket series is the
 * whole point of the measurement: a link that is usually ample and periodically
 * collapses is a SHAPE, and a single average erases it.
 */
export class BucketRecorder {
    readonly #startedAt: number;
    readonly #bucketMs: number;
    /** Bytes per bucket index; gaps are filled with 0 as they are crossed. */
    readonly #bytes: number[] = [];

    readonly #maxBuckets: number;

    constructor(
        startedAt: number,
        bucketMs: number = SPEED_TEST_BUCKET_MS,
        maxBuckets: number = MAX_BUCKETS,
    ) {
        this.#startedAt = startedAt;
        this.#bucketMs = bucketMs;
        this.#maxBuckets = maxBuckets;
    }

    onChunk(now: number, bytes: number): void {
        const index = Math.max(0, Math.floor((now - this.#startedAt) / this.#bucketMs));
        while (this.#bytes.length <= index) this.#bytes.push(0);
        this.#bytes[index] += bytes;
    }

    /**
     * Close the series at `now`.
     *
     * Every bucket the clock fully crossed is emitted, empty ones included — an
     * empty COMPLETE bucket is exactly the evidence of a stall, and the server's
     * `stallMs` is the sum of those. The trailing partial bucket is emitted only
     * if it carried bytes: ending a transfer 40 ms into a bucket is not a stall,
     * and reporting it as one would add phantom stall time to every clean run.
     */
    finish(now: number): { ms: number; bytes: number }[] {
        const elapsed = Math.max(0, now - this.#startedAt);
        const complete = Math.floor(elapsed / this.#bucketMs);
        let lastWithBytes = -1;
        for (let i = 0; i < this.#bytes.length; i++) {
            if (this.#bytes[i] > 0) lastWithBytes = i;
        }
        const count = Math.min(Math.max(complete, lastWithBytes + 1), this.#maxBuckets);

        const buckets: { ms: number; bytes: number }[] = [];
        for (let i = 0; i < count; i++) {
            // `ms` is the part of this bucket the clock actually covered, floored
            // at 1: the wire schema requires an integer in 1…1000.
            const covered = Math.round(Math.min(this.#bucketMs, elapsed - i * this.#bucketMs));
            buckets.push({ ms: Math.max(1, covered), bytes: this.#bytes[i] ?? 0 });
        }
        return buckets;
    }
}

function clampRequestedBytes(bytes: number | undefined): number {
    if (bytes === undefined || !Number.isFinite(bytes)) return SPEED_TEST_DEFAULT_BYTES;
    return Math.min(SPEED_TEST_MAX_BYTES, Math.max(SPEED_TEST_MIN_BYTES, Math.floor(bytes)));
}

/** One download's raw numbers — a whole `single`/`long` run, or one cadence leg. */
interface OneDownload {
    bytesReceived: number;
    ttfbMs: number;
    durationMs: number;
    aborted: boolean;
    buckets: { ms: number; bytes: number }[];
}

/**
 * Fetch the payload once and time the receiving end.
 *
 * Shared by all three modes: `single`/`long` call it once, `cadence` calls it
 * {@link SPEED_TEST_CADENCE_REQUESTS} times. It resolves with a partial result
 * when `capMs` fires (`aborted: true`) because a leg that could not finish is the
 * answer rather than an error; it rejects only when nothing was measurable at all
 * (transport failure, non-2xx, unstreamable body).
 */
async function downloadOnce(o: {
    bytesRequested: number;
    capMs: number;
    maxBuckets: number;
    doFetch: typeof fetch;
    now: () => number;
    /** Called per arriving chunk with its size and arrival time. */
    onChunk?: (bytes: number, at: number) => void;
    /**
     * Whether to keep a bucket series at all. Default true; a `cadence` leg
     * passes false because its series is the per-request list instead — the
     * caller never reads `buckets`, so recording one would be work done only to
     * be thrown away. `false` makes the resulting `buckets: []` the single place
     * that decision is made, instead of every caller filtering it back out.
     */
    collectBuckets?: boolean;
}): Promise<OneDownload> {
    const controller = new AbortController();
    let capFired = false;
    const capTimer = setTimeout(() => {
        capFired = true;
        controller.abort();
    }, o.capMs);

    const startedAt = o.now();
    const recorder =
        o.collectBuckets === false
            ? null
            : new BucketRecorder(startedAt, SPEED_TEST_BUCKET_MS, o.maxBuckets);
    let bytesReceived = 0;
    let ttfbMs = 0;
    let sawFirstChunk = false;

    try {
        const response = await o.doFetch(
            apiUrl('internal', `/network/speed-test?bytes=${o.bytesRequested}`),
            {
                credentials: 'include',
                // A cached or revalidated response measures the cache, not the line.
                cache: 'no-store',
                signal: controller.signal,
            },
        );
        if (!response.ok) {
            throw new Error(`speed-test request failed with HTTP ${response.status}`);
        }
        if (!response.body) {
            throw new Error('speed-test response carried no readable body');
        }

        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const at = o.now();
            if (!sawFirstChunk) {
                sawFirstChunk = true;
                ttfbMs = Math.max(0, Math.round(at - startedAt));
            }
            bytesReceived += value.byteLength;
            recorder?.onChunk(at, value.byteLength);
            o.onChunk?.(value.byteLength, at);
        }
    } catch (err) {
        // Our own cap is a RESULT, not a failure — anything else is.
        if (!capFired) throw err;
    } finally {
        clearTimeout(capTimer);
    }

    const endedAt = o.now();
    const durationMs = Math.min(MAX_REPORTED_MS, Math.max(0, Math.round(endedAt - startedAt)));
    return {
        // These clamps keep a measurement acceptable to the server's ceilings and
        // cross-field refinements (`bytesReceived <= bytesRequested`,
        // `ttfbMs <= durationMs`, both durations <= 120 s) even if a proxy hands
        // us more bytes than were asked for, or a suspended tab resumes hours
        // later. Without the duration clamp such a run 422s instead of storing.
        bytesReceived: Math.min(bytesReceived, o.bytesRequested),
        durationMs,
        // NO byte ever arrived: the first byte did not arrive "instantly at
        // 0 ms", it never arrived. Reporting 0 here would render the collapsed
        // link this tool exists to catch as "first byte 0 ms" — the best
        // possible reading. The honest figure is the whole window we waited.
        ttfbMs: sawFirstChunk ? Math.min(ttfbMs, durationMs) : durationMs,
        aborted: capFired,
        buckets: recorder?.finish(endedAt) ?? [],
    };
}

export interface RunSpeedTestOptions {
    /**
     * Which profile to run. `single` (the default, and what a pre-modes caller
     * gets) is 16 MiB with a 20 s cap; `long` is 64 MiB with a 60 s cap;
     * `cadence` is 8 sequential 4 MiB fetches 2 s apart, mimicking HLS segment
     * pacing. The mode is NOT part of the returned measurement — see
     * {@link SpeedTestMeasurement.requests}.
     */
    mode?: SpeedTestMode;
    /** Only honoured for `single`: the other two profiles fix their own size. */
    bytes?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
    onProgress?: (p: SpeedTestProgress) => void;
    /**
     * The `cadence` pause. Injectable so the loop is testable without burning
     * 14 s of real time — and so a test can assert the gaps actually happened
     * rather than inferring them from a clock.
     */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Run 8 sequential 4 MiB fetches with 2 s pauses between them.
 *
 * The point is pacing, not volume: a link that passes a single bulk download and
 * still stutters during playback fails HERE, because HLS asks for a segment,
 * waits, and asks again — and a middlebox that throttles after an idle gap, or a
 * connection that must be re-established per request, only shows up in that
 * pattern.
 *
 * Buckets are NOT recorded: the per-request list IS the series, and the server
 * computes throughput over the summed in-flight windows so the deliberate pauses
 * never read as stalls. `durationMs` is the wall clock INCLUDING them, per the
 * wire contract.
 */
async function runCadence(o: {
    doFetch: typeof fetch;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    onProgress?: (p: SpeedTestProgress) => void;
}): Promise<SpeedTestMeasurement> {
    const bytesRequested = SPEED_TEST_CADENCE_REQUESTS * SPEED_TEST_CADENCE_CHUNK_BYTES;
    const runStartedAt = o.now();
    const requests: SpeedTestRequestInput[] = [];
    /**
     * Raw arrival total, for the progress bar only. It is deliberately NOT the
     * reported `bytesReceived`: the server refines
     * `sum(requests[].bytes) === bytesReceived` for a cadence run and 422s
     * otherwise, and a proxy that over-delivers one leg would make the raw total
     * exceed the per-leg figures (each clamped to the chunk size).
     */
    let progressBytes = 0;
    let aborted = false;

    for (let i = 0; i < SPEED_TEST_CADENCE_REQUESTS; i++) {
        // Before each request but the first: 7 gaps for 8 fetches, never a
        // trailing pause the user would just sit through.
        if (i > 0) await o.sleep(SPEED_TEST_CADENCE_GAP_MS);

        // Captured out here because the catch path needs it: a leg that THREW
        // has no `durationMs` of its own to report.
        const legStartedAt = o.now();
        let leg: OneDownload;
        try {
            leg = await downloadOnce({
                bytesRequested: SPEED_TEST_CADENCE_CHUNK_BYTES,
                capMs: SPEED_TEST_CAP_MS,
                maxBuckets: MAX_BUCKETS,
                collectBuckets: false,
                doFetch: o.doFetch,
                now: o.now,
                onChunk: (bytes, at) => {
                    progressBytes += bytes;
                    o.onProgress?.({
                        bytesReceived: progressBytes,
                        elapsedMs: Math.max(0, Math.round(at - runStartedAt)),
                    });
                },
            });
        } catch (err) {
            // Nothing measured at all — a 429, a dead link, an unstreamable body.
            // The caller has no result to show, so it must see the failure.
            if (requests.length === 0) throw err;
            // But legs that DID complete are evidence, and "five segments then a
            // 429" is a more useful row than no row: keep them and report the run
            // as aborted.
            //
            // The failed leg is RECORDED as a zero-byte entry rather than dropped,
            // matching the native clients: it is what makes `requestCount` say
            // where the run died instead of quietly reading as a shorter run. Its
            // whole wall time is reported as the first byte, for the same reason
            // the single path does — no byte arrived, so "0 ms" would render the
            // failure as the best possible result. Floored at 1 ms (an instant
            // rejection is still a leg that happened) and clamped to the schema's
            // ceiling; `ttfbMs === durationMs` satisfies the server's per-request
            // `ttfbMs <= durationMs` refinement, and 0 bytes leaves the
            // `sum(requests[].bytes) === bytesReceived` identity untouched.
            const legDurationMs = Math.min(
                MAX_REPORTED_MS,
                Math.max(1, Math.round(o.now() - legStartedAt)),
            );
            requests.push({ bytes: 0, ttfbMs: legDurationMs, durationMs: legDurationMs });
            aborted = true;
            break;
        }

        requests.push({
            bytes: leg.bytesReceived,
            ttfbMs: leg.ttfbMs,
            durationMs: leg.durationMs,
        });

        // A leg that hit its own cap ends the run: the remaining fetches would
        // add minutes and nothing the first failure has not already said.
        if (leg.aborted) {
            aborted = true;
            break;
        }
        // And the run as a whole cannot outgrow what `durationMs` can report —
        // 8 x 20 s + 7 x 2 s exceeds the schema's 120 s ceiling, so a slow link
        // would otherwise produce a clamped duration that silently understates
        // the run. Checked only when ANOTHER leg would follow: a run whose LAST
        // leg happens to cross the ceiling finished everything it set out to do,
        // and flagging that as `aborted` would call a complete run incomplete.
        if (i < SPEED_TEST_CADENCE_REQUESTS - 1 && o.now() - runStartedAt >= MAX_REPORTED_MS) {
            aborted = true;
            break;
        }
    }

    const durationMs = Math.min(MAX_REPORTED_MS, Math.max(0, Math.round(o.now() - runStartedAt)));
    const first = requests[0];
    // Summed from the list that is actually posted, not from the raw arrivals —
    // the server's cadence refinement requires exactly this identity.
    const bytesReceived = requests.reduce((sum, r) => sum + r.bytes, 0);
    return {
        bytesRequested,
        bytesReceived: Math.min(bytesReceived, bytesRequested),
        durationMs,
        // The run's TTFB is the FIRST request's — the worst one travels in the
        // list, and the server surfaces it as `maxTtfbMs`.
        ttfbMs: first ? Math.min(first.ttfbMs, durationMs) : durationMs,
        aborted,
        // Empty by contract: `summariseSpeedTest` ignores buckets for cadence.
        buckets: [],
        requests,
    };
}

/**
 * Download the speed-test payload and time the receiving end.
 *
 * Resolves with the measurement — including a partial one when the cap fired
 * (`aborted: true`), because a link that could not finish inside its profile's
 * cap is the answer rather than an error. Rejects only when nothing was
 * measurable at all: a transport failure, a non-2xx response, or a body that
 * cannot be streamed.
 */
export async function runSpeedTest(opts: RunSpeedTestOptions): Promise<SpeedTestMeasurement> {
    const mode = opts.mode ?? 'single';
    const now = opts.now ?? (() => Date.now());
    const doFetch = opts.fetchImpl ?? fetch;

    if (mode === 'cadence') {
        return runCadence({
            doFetch,
            now,
            sleep:
                opts.sleep ??
                ((ms) =>
                    new Promise<void>((resolve) => {
                        setTimeout(resolve, ms);
                    })),
            onProgress: opts.onProgress,
        });
    }

    // `long` fixes its own size: letting `bytes` shrink it would produce a row
    // labelled `long` that measured a quick run.
    const bytesRequested =
        mode === 'long' ? SPEED_TEST_LONG_BYTES : clampRequestedBytes(opts.bytes);
    const capMs = mode === 'long' ? SPEED_TEST_LONG_CAP_MS : SPEED_TEST_CAP_MS;
    const maxBuckets = mode === 'long' ? MAX_BUCKETS_LONG : MAX_BUCKETS;

    const runStartedAt = now();
    let progressBytes = 0;
    const one = await downloadOnce({
        bytesRequested,
        capMs,
        maxBuckets,
        doFetch,
        now,
        onChunk: (bytes, at) => {
            progressBytes += bytes;
            opts.onProgress?.({
                bytesReceived: progressBytes,
                elapsedMs: Math.max(0, Math.round(at - runStartedAt)),
            });
        },
    });

    return {
        bytesRequested,
        bytesReceived: one.bytesReceived,
        durationMs: one.durationMs,
        ttfbMs: one.ttfbMs,
        aborted: one.aborted,
        buckets: one.buckets,
    };
}

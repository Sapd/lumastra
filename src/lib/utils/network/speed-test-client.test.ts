// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test, vi, afterEach } from 'vitest';
import {
    BucketRecorder,
    runSpeedTest,
    SPEED_TEST_BUCKET_MS,
    SPEED_TEST_CAP_MS,
} from './speed-test-client';
import {
    speedTestBucketSchema,
    speedTestResultSchema,
    SPEED_TEST_CADENCE_CHUNK_BYTES,
    SPEED_TEST_CADENCE_GAP_MS,
    SPEED_TEST_CADENCE_REQUESTS,
    SPEED_TEST_DEFAULT_BYTES,
    SPEED_TEST_LONG_BYTES,
    SPEED_TEST_LONG_CAP_MS,
} from '$lib/schemas/playback';

describe('BucketRecorder', () => {
    test('folds chunks into 250 ms buckets by arrival time', () => {
        const r = new BucketRecorder(0);
        r.onChunk(0, 300);
        r.onChunk(100, 50);
        r.onChunk(400, 900);
        expect(r.finish(500)).toEqual([
            { ms: 250, bytes: 350 },
            { ms: 250, bytes: 900 },
        ]);
    });

    test('a 700 ms gap leaves an empty middle bucket (the stall is the evidence)', () => {
        const r = new BucketRecorder(0);
        r.onChunk(0, 1000);
        r.onChunk(700, 2000);
        expect(r.finish(750)).toEqual([
            { ms: 250, bytes: 1000 },
            { ms: 250, bytes: 0 },
            { ms: 250, bytes: 2000 },
        ]);
    });

    test('a partial trailing bucket is reported with its real duration when it carried bytes', () => {
        const r = new BucketRecorder(0);
        r.onChunk(10, 100);
        r.onChunk(520, 400);
        expect(r.finish(600)).toEqual([
            { ms: 250, bytes: 100 },
            { ms: 250, bytes: 0 },
            { ms: 100, bytes: 400 },
        ]);
    });

    test('an empty partial trailing bucket is dropped — ending mid-bucket is not a stall', () => {
        const r = new BucketRecorder(0);
        r.onChunk(10, 100);
        r.onChunk(300, 400);
        expect(r.finish(520)).toEqual([
            { ms: 250, bytes: 100 },
            { ms: 250, bytes: 400 },
        ]);
    });

    test('respects a non-default bucket width and a non-zero start', () => {
        const r = new BucketRecorder(1000, 100);
        r.onChunk(1050, 10);
        r.onChunk(1150, 20);
        expect(r.finish(1200)).toEqual([
            { ms: 100, bytes: 10 },
            { ms: 100, bytes: 20 },
        ]);
    });

    test('every emitted bucket satisfies the wire schema the server validates', () => {
        const r = new BucketRecorder(0);
        for (let i = 0; i < 40; i++) r.onChunk(i * 123, i * 10);
        const buckets = r.finish(40 * 123 + 7);
        expect(buckets.length).toBeGreaterThan(1);
        expect(buckets.length).toBeLessThanOrEqual(120);
        for (const bucket of buckets) {
            expect(speedTestBucketSchema.parse(bucket)).toEqual(bucket);
        }
    });

    test('uses the 250 ms default width', () => {
        expect(SPEED_TEST_BUCKET_MS).toBe(250);
        const r = new BucketRecorder(0);
        r.onChunk(249, 1);
        r.onChunk(250, 1);
        expect(r.finish(500)).toEqual([
            { ms: 250, bytes: 1 },
            { ms: 250, bytes: 1 },
        ]);
    });
});

/** A clock the fake stream advances as the reader pulls from it. */
function clockedFetch(
    chunks: { atMs: number; bytes: number }[],
    endMs: number,
    clock: { ms: number },
    seen: { url?: string; init?: RequestInit },
): typeof fetch {
    return ((url: string, init?: RequestInit) => {
        seen.url = url;
        seen.init = init;
        let i = 0;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (i >= chunks.length) {
                        clock.ms = endMs;
                        controller.close();
                        return;
                    }
                    const chunk = chunks[i++];
                    clock.ms = chunk.atMs;
                    controller.enqueue(new Uint8Array(chunk.bytes));
                },
            },
            // highWaterMark 0 so the stream never reads AHEAD of the consumer:
            // with the default (1) `pull` runs for chunk n+1 while the reader is
            // still resolving chunk n, and the clock would already have advanced
            // by the time the consumer timestamps the earlier chunk.
            { highWaterMark: 0 },
        );
        return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
}

describe('runSpeedTest', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('measures TTFB, total bytes, duration and buckets from the stream', async () => {
        const clock = { ms: 0 };
        const seen: { url?: string; init?: RequestInit } = {};
        const progress: { bytesReceived: number; elapsedMs: number }[] = [];
        const measurement = await runSpeedTest({
            fetchImpl: clockedFetch(
                [
                    { atMs: 120, bytes: 1000 },
                    { atMs: 400, bytes: 3000 },
                ],
                520,
                clock,
                seen,
            ),
            now: () => clock.ms,
            onProgress: (p) => progress.push({ ...p }),
        });

        expect(measurement).toEqual({
            bytesRequested: SPEED_TEST_DEFAULT_BYTES,
            bytesReceived: 4000,
            durationMs: 520,
            ttfbMs: 120,
            aborted: false,
            buckets: [
                { ms: 250, bytes: 1000 },
                { ms: 250, bytes: 3000 },
            ],
        });
        expect(progress).toEqual([
            { bytesReceived: 1000, elapsedMs: 120 },
            { bytesReceived: 4000, elapsedMs: 400 },
        ]);
    });

    test('requests the internal speed-test endpoint with credentials and the byte count', async () => {
        const clock = { ms: 0 };
        const seen: { url?: string; init?: RequestInit } = {};
        await runSpeedTest({
            bytes: 4 * 1024 * 1024,
            fetchImpl: clockedFetch([{ atMs: 10, bytes: 16 }], 20, clock, seen),
            now: () => clock.ms,
        });
        expect(seen.url).toBe('/api/network/speed-test?bytes=4194304');
        expect(seen.init?.credentials).toBe('include');
        expect(seen.init?.cache).toBe('no-store');
        expect(seen.init?.signal).toBeInstanceOf(AbortSignal);
    });

    test('clamps a requested size the server would reject', async () => {
        const clock = { ms: 0 };
        const seen: { url?: string; init?: RequestInit } = {};
        const measurement = await runSpeedTest({
            bytes: 999,
            fetchImpl: clockedFetch([{ atMs: 10, bytes: 16 }], 20, clock, seen),
            now: () => clock.ms,
        });
        expect(seen.url).toBe(`/api/network/speed-test?bytes=${1024 * 1024}`);
        expect(measurement.bytesRequested).toBe(1024 * 1024);
    });

    test('aborts at the cap and reports what arrived', async () => {
        vi.useFakeTimers();
        const seen: { url?: string; init?: RequestInit } = {};
        let started = 0;
        const fetchImpl = ((url: string, init?: RequestInit) => {
            seen.url = url;
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array(2048));
                    started++;
                    init?.signal?.addEventListener('abort', () => {
                        controller.error(new DOMException('Aborted', 'AbortError'));
                    });
                },
            });
            return Promise.resolve(new Response(body, { status: 200 }));
        }) as unknown as typeof fetch;

        const pending = runSpeedTest({ fetchImpl, now: () => Date.now() });
        await vi.advanceTimersByTimeAsync(SPEED_TEST_CAP_MS + 10);
        const measurement = await pending;

        expect(started).toBe(1);
        expect(measurement.aborted).toBe(true);
        expect(measurement.bytesReceived).toBe(2048);
        expect(measurement.durationMs).toBeGreaterThanOrEqual(SPEED_TEST_CAP_MS);
    });

    test('a run that received NOTHING reports its first byte as never, not instant', async () => {
        vi.useFakeTimers();
        // A body that never yields a chunk: the collapsed link this tool exists
        // to catch. Reporting ttfbMs 0 here would render as "first byte 0 ms".
        const fetchImpl = ((_url: string, init?: RequestInit) => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    init?.signal?.addEventListener('abort', () => {
                        controller.error(new DOMException('Aborted', 'AbortError'));
                    });
                },
            });
            return Promise.resolve(new Response(body, { status: 200 }));
        }) as unknown as typeof fetch;

        const pending = runSpeedTest({ fetchImpl, now: () => Date.now() });
        await vi.advanceTimersByTimeAsync(SPEED_TEST_CAP_MS + 10);
        const measurement = await pending;

        expect(measurement.bytesReceived).toBe(0);
        expect(measurement.aborted).toBe(true);
        expect(measurement.ttfbMs).toBe(measurement.durationMs);
        expect(measurement.ttfbMs).toBeGreaterThanOrEqual(SPEED_TEST_CAP_MS);
        // The body the UI posts must still satisfy the server's schema, including
        // the `ttfbMs <= durationMs` refinement and the 120-bucket ceiling.
        expect(speedTestResultSchema.parse(measurement)).toMatchObject({
            ttfbMs: measurement.durationMs,
            bytesReceived: 0,
        });
    });

    test('clamps a duration past the schema ceiling (a suspended tab resuming)', async () => {
        const clock = { ms: 0 };
        const seen: { url?: string; init?: RequestInit } = {};
        const measurement = await runSpeedTest({
            fetchImpl: clockedFetch([{ atMs: 10, bytes: 4096 }], 200_000, clock, seen),
            now: () => clock.ms,
        });
        expect(measurement.durationMs).toBe(120_000);
        expect(measurement.ttfbMs).toBe(10);
        expect(measurement.buckets.length).toBeLessThanOrEqual(120);
        expect(speedTestResultSchema.parse(measurement).durationMs).toBe(120_000);
    });

    test('rejects on a non-OK response rather than posting a fake measurement', async () => {
        const fetchImpl = (() =>
            Promise.resolve(new Response('nope', { status: 429 }))) as unknown as typeof fetch;
        await expect(runSpeedTest({ fetchImpl, now: () => 0 })).rejects.toThrow();
    });

    test('rejects when the transport fails outright', async () => {
        const fetchImpl = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
        await expect(runSpeedTest({ fetchImpl, now: () => 0 })).rejects.toThrow(/offline/);
    });

    test('never reports a TTFB beyond the measured duration', async () => {
        const clock = { ms: 0 };
        const seen: { url?: string; init?: RequestInit } = {};
        // The stream closes at the same instant the only chunk arrived.
        const measurement = await runSpeedTest({
            fetchImpl: clockedFetch([{ atMs: 300, bytes: 64 }], 300, clock, seen),
            now: () => clock.ms,
        });
        expect(measurement.ttfbMs).toBeLessThanOrEqual(measurement.durationMs);
        expect(measurement.bytesReceived).toBeLessThanOrEqual(measurement.bytesRequested);
    });
});

/**
 * A fetch that serves ONE response per call from a scripted list, advancing the
 * shared clock as each chunk is pulled — the cadence loop's 8 sequential
 * requests each get their own body.
 */
function sequencedFetch(
    perRequest: ({ chunks: { atMs: number; bytes: number }[]; endMs: number } | 'never-yields')[],
    clock: { ms: number },
    seen: string[],
): typeof fetch {
    let call = 0;
    return ((url: string, init?: RequestInit) => {
        seen.push(url);
        const script = perRequest[Math.min(call++, perRequest.length - 1)];
        if (script === 'never-yields') {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    init?.signal?.addEventListener('abort', () => {
                        controller.error(new DOMException('Aborted', 'AbortError'));
                    });
                },
            });
            return Promise.resolve(new Response(body, { status: 200 }));
        }
        let i = 0;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (i >= script.chunks.length) {
                        clock.ms = script.endMs;
                        controller.close();
                        return;
                    }
                    const chunk = script.chunks[i++];
                    clock.ms = chunk.atMs;
                    controller.enqueue(new Uint8Array(chunk.bytes));
                },
            },
            { highWaterMark: 0 },
        );
        return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
}

describe('runSpeedTest — long mode', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('asks for the 64 MiB payload', async () => {
        const clock = { ms: 0 };
        const seen: { url?: string; init?: RequestInit } = {};
        const measurement = await runSpeedTest({
            mode: 'long',
            fetchImpl: clockedFetch([{ atMs: 50, bytes: 8192 }], 900, clock, seen),
            now: () => clock.ms,
        });
        expect(seen.url).toBe(`/api/network/speed-test?bytes=${SPEED_TEST_LONG_BYTES}`);
        expect(measurement.bytesRequested).toBe(SPEED_TEST_LONG_BYTES);
        expect(measurement.requests).toBeUndefined();
    });

    test('an explicit byte count cannot shrink a long run below its profile', async () => {
        const clock = { ms: 0 };
        const seen: { url?: string; init?: RequestInit } = {};
        await runSpeedTest({
            mode: 'long',
            bytes: 2 * 1024 * 1024,
            fetchImpl: clockedFetch([{ atMs: 10, bytes: 64 }], 20, clock, seen),
            now: () => clock.ms,
        });
        expect(seen.url).toBe(`/api/network/speed-test?bytes=${SPEED_TEST_LONG_BYTES}`);
    });

    test('runs past the 20 s single cap and aborts at the 60 s one instead', async () => {
        vi.useFakeTimers();
        const fetchImpl = ((_url: string, init?: RequestInit) => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array(4096));
                    init?.signal?.addEventListener('abort', () => {
                        controller.error(new DOMException('Aborted', 'AbortError'));
                    });
                },
            });
            return Promise.resolve(new Response(body, { status: 200 }));
        }) as unknown as typeof fetch;

        let settled = false;
        const pending = runSpeedTest({ mode: 'long', fetchImpl, now: () => Date.now() }).then(
            (r) => {
                settled = true;
                return r;
            },
        );

        // The single-mode cap must NOT apply to a long run.
        await vi.advanceTimersByTimeAsync(SPEED_TEST_CAP_MS + 1000);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(SPEED_TEST_LONG_CAP_MS);
        const measurement = await pending;
        expect(measurement.aborted).toBe(true);
        expect(measurement.durationMs).toBeGreaterThanOrEqual(SPEED_TEST_LONG_CAP_MS);
        // 250 ms buckets over a 60 s cap is 240 — the schema's ceiling, not 120.
        expect(measurement.buckets.length).toBeLessThanOrEqual(240);
        expect(speedTestResultSchema.parse({ ...measurement, mode: 'long' }).mode).toBe('long');
    });
});

describe('runSpeedTest — cadence mode', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('makes 8 sequential 4 MiB requests with 7 pauses between them', async () => {
        const clock = { ms: 0 };
        const seen: string[] = [];
        const slept: number[] = [];
        // Each request: first byte 40 ms in, done 240 ms in, then the clock is
        // advanced by the fake sleep.
        let base = 0;
        const sequenced = ((url: string) => {
            seen.push(url);
            const start = base;
            let emitted = false;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (emitted) {
                            clock.ms = start + 240;
                            base = clock.ms;
                            controller.close();
                            return;
                        }
                        emitted = true;
                        clock.ms = start + 40;
                        controller.enqueue(new Uint8Array(SPEED_TEST_CADENCE_CHUNK_BYTES));
                    },
                },
                { highWaterMark: 0 },
            );
            return Promise.resolve(new Response(body, { status: 200 }));
        }) as unknown as typeof fetch;

        const progress: { bytesReceived: number; elapsedMs: number }[] = [];
        const measurement = await runSpeedTest({
            mode: 'cadence',
            fetchImpl: sequenced,
            now: () => clock.ms,
            onProgress: (p) => progress.push({ ...p }),
            sleep: async (ms) => {
                slept.push(ms);
                clock.ms += ms;
                base = clock.ms;
            },
        });

        expect(seen).toHaveLength(SPEED_TEST_CADENCE_REQUESTS);
        for (const url of seen) {
            expect(url).toBe(`/api/network/speed-test?bytes=${SPEED_TEST_CADENCE_CHUNK_BYTES}`);
        }
        // 8 requests means 7 gaps, not 8 — no trailing pause.
        expect(slept).toEqual(
            Array(SPEED_TEST_CADENCE_REQUESTS - 1).fill(SPEED_TEST_CADENCE_GAP_MS),
        );

        expect(measurement.requests).toHaveLength(SPEED_TEST_CADENCE_REQUESTS);
        expect(measurement.requests?.[0]).toEqual({
            bytes: SPEED_TEST_CADENCE_CHUNK_BYTES,
            ttfbMs: 40,
            durationMs: 240,
        });
        expect(measurement.bytesRequested).toBe(
            SPEED_TEST_CADENCE_REQUESTS * SPEED_TEST_CADENCE_CHUNK_BYTES,
        );
        expect(measurement.bytesReceived).toBe(
            SPEED_TEST_CADENCE_REQUESTS * SPEED_TEST_CADENCE_CHUNK_BYTES,
        );
        // Buckets are NOT sent for cadence — the per-request list is the series.
        expect(measurement.buckets).toEqual([]);
        // The run's TTFB is the FIRST request's, not the worst — `maxTtfbMs` is
        // the server's job, derived from the list.
        expect(measurement.ttfbMs).toBe(40);
        // Wall clock INCLUDES the pauses: 8 x 240 ms + 7 x 2000 ms.
        expect(measurement.durationMs).toBe(
            SPEED_TEST_CADENCE_REQUESTS * 240 + (SPEED_TEST_CADENCE_REQUESTS - 1) * 2000,
        );
        expect(measurement.aborted).toBe(false);
        // Progress is cumulative across the whole run, not per request.
        expect(progress).toHaveLength(SPEED_TEST_CADENCE_REQUESTS);
        expect(progress.at(-1)?.bytesReceived).toBe(
            SPEED_TEST_CADENCE_REQUESTS * SPEED_TEST_CADENCE_CHUNK_BYTES,
        );
        // The whole body must satisfy the server's schema, refinements included.
        expect(
            speedTestResultSchema.parse({ ...measurement, mode: 'cadence' }).requests,
        ).toHaveLength(SPEED_TEST_CADENCE_REQUESTS);
    });

    test('reports bytesReceived as the SUM of the posted list, even if a leg over-delivers', async () => {
        // The server refines `sum(requests[].bytes) === bytesReceived` for a
        // cadence run and 422s otherwise. A proxy handing back more than was
        // asked for must therefore not inflate the total past the per-leg figures
        // (each clamped to the chunk size).
        const clock = { ms: 0 };
        const seen: string[] = [];
        let base = 0;
        const fetchImpl = ((url: string) => {
            seen.push(url);
            const start = base;
            let emitted = false;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (emitted) {
                            clock.ms = start + 200;
                            base = clock.ms;
                            controller.close();
                            return;
                        }
                        emitted = true;
                        clock.ms = start + 20;
                        // 1 KiB MORE than the chunk that was requested.
                        controller.enqueue(new Uint8Array(SPEED_TEST_CADENCE_CHUNK_BYTES + 1024));
                    },
                },
                { highWaterMark: 0 },
            );
            return Promise.resolve(new Response(body, { status: 200 }));
        }) as unknown as typeof fetch;

        const measurement = await runSpeedTest({
            mode: 'cadence',
            fetchImpl,
            now: () => clock.ms,
            sleep: async (ms) => {
                clock.ms += ms;
                base = clock.ms;
            },
        });

        const summed = (measurement.requests ?? []).reduce((sum, r) => sum + r.bytes, 0);
        expect(measurement.bytesReceived).toBe(summed);
        expect(measurement.bytesReceived).toBe(
            SPEED_TEST_CADENCE_REQUESTS * SPEED_TEST_CADENCE_CHUNK_BYTES,
        );
        expect(measurement.buckets).toEqual([]);
        expect(speedTestResultSchema.parse({ ...measurement, mode: 'cadence' }).bytesReceived).toBe(
            summed,
        );
    });

    test('a request that never yields aborts the run and stops it early', async () => {
        vi.useFakeTimers();
        const seen: string[] = [];
        const slept: number[] = [];
        const clock = { ms: 0 };
        const fetchImpl = sequencedFetch(
            [
                { chunks: [{ atMs: 100, bytes: SPEED_TEST_CADENCE_CHUNK_BYTES }], endMs: 300 },
                { chunks: [{ atMs: 2400, bytes: SPEED_TEST_CADENCE_CHUNK_BYTES }], endMs: 2600 },
                'never-yields',
            ],
            clock,
            seen,
        );

        const pending = runSpeedTest({
            mode: 'cadence',
            fetchImpl,
            now: () => Date.now(),
            // The gap resolves immediately: the OUTER `advanceTimersByTimeAsync`
            // below is what drives the clock, and a nested one would deadlock.
            sleep: async (ms) => {
                slept.push(ms);
            },
        });
        await vi.advanceTimersByTimeAsync(SPEED_TEST_CAP_MS + 5000);
        const measurement = await pending;

        // Three requests were attempted; requests 4..8 were never made.
        expect(seen).toHaveLength(3);
        expect(measurement.requests).toHaveLength(3);
        expect(slept).toEqual([SPEED_TEST_CADENCE_GAP_MS, SPEED_TEST_CADENCE_GAP_MS]);
        expect(measurement.aborted).toBe(true);
        // The dead request reports its whole wait as its first byte, like the
        // single path — never "0 ms", which would read as the best case.
        const last = measurement.requests?.at(-1);
        expect(last?.bytes).toBe(0);
        expect(last?.ttfbMs).toBe(last?.durationMs);
        expect(last?.ttfbMs).toBeGreaterThanOrEqual(SPEED_TEST_CAP_MS);
        // bytesRequested stays the FULL profile even though the run stopped
        // early: it is what was asked for, and the server needs that ratio.
        expect(measurement.bytesRequested).toBe(
            SPEED_TEST_CADENCE_REQUESTS * SPEED_TEST_CADENCE_CHUNK_BYTES,
        );
        expect(measurement.bytesReceived).toBe(2 * SPEED_TEST_CADENCE_CHUNK_BYTES);
        expect(speedTestResultSchema.parse({ ...measurement, mode: 'cadence' }).aborted).toBe(true);
    });

    test('a run whose LAST leg crosses the reportable ceiling is complete, not aborted', async () => {
        // 8 x 14 s + 7 x 2 s = 126 s, so the wall clock passes the 120 s ceiling
        // during the FINAL leg. Every fetch the profile asks for was made, so the
        // run is finished — flagging it `aborted` would call it incomplete.
        const clock = { ms: 0 };
        const seen: string[] = [];
        let base = 0;
        const fetchImpl = ((url: string) => {
            seen.push(url);
            const start = base;
            let emitted = false;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (emitted) {
                            clock.ms = start + 14_000;
                            base = clock.ms;
                            controller.close();
                            return;
                        }
                        emitted = true;
                        clock.ms = start + 50;
                        controller.enqueue(new Uint8Array(SPEED_TEST_CADENCE_CHUNK_BYTES));
                    },
                },
                { highWaterMark: 0 },
            );
            return Promise.resolve(new Response(body, { status: 200 }));
        }) as unknown as typeof fetch;

        const measurement = await runSpeedTest({
            mode: 'cadence',
            fetchImpl,
            now: () => clock.ms,
            sleep: async (ms) => {
                clock.ms += ms;
                base = clock.ms;
            },
        });

        expect(seen).toHaveLength(SPEED_TEST_CADENCE_REQUESTS);
        expect(measurement.requests).toHaveLength(SPEED_TEST_CADENCE_REQUESTS);
        expect(measurement.aborted).toBe(false);
        // The duration is still clamped — that is a reporting ceiling, not a verdict.
        expect(measurement.durationMs).toBe(120_000);
        expect(speedTestResultSchema.parse({ ...measurement, mode: 'cadence' }).aborted).toBe(
            false,
        );
    });

    test('a mid-run transport failure keeps the legs that DID complete', async () => {
        // A 429 on leg 3 (the split GET limit) or a dropped connection used to
        // reject the whole run and throw away two good measurements.
        const clock = { ms: 0 };
        let call = 0;
        let base = 0;
        const fetchImpl = (() => {
            call++;
            if (call === 3) return Promise.reject(new Error('connection reset'));
            const start = base;
            let emitted = false;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (emitted) {
                            clock.ms = start + 300;
                            base = clock.ms;
                            controller.close();
                            return;
                        }
                        emitted = true;
                        clock.ms = start + 30;
                        controller.enqueue(new Uint8Array(SPEED_TEST_CADENCE_CHUNK_BYTES));
                    },
                },
                { highWaterMark: 0 },
            );
            return Promise.resolve(new Response(body, { status: 200 }));
        }) as unknown as typeof fetch;

        const measurement = await runSpeedTest({
            mode: 'cadence',
            fetchImpl,
            now: () => clock.ms,
            sleep: async (ms) => {
                clock.ms += ms;
                base = clock.ms;
            },
        });

        // Leg 3 failed, so 4..8 were never attempted — but the failed leg IS
        // recorded (as the native clients do), so `requestCount` says where the
        // run died rather than reading as a shorter, healthier run.
        expect(call).toBe(3);
        expect(measurement.requests).toHaveLength(3);
        expect(measurement.aborted).toBe(true);
        expect(measurement.buckets).toEqual([]);

        const failed = measurement.requests?.at(-1);
        expect(failed?.bytes).toBe(0);
        // No byte arrived, so the whole wait IS the first byte — never 0 ms,
        // which would render the failure as the best possible result. And the
        // server refines `ttfbMs <= durationMs` per request.
        expect(failed?.ttfbMs).toBe(failed?.durationMs);
        expect(failed?.durationMs).toBeGreaterThanOrEqual(1);

        // A zero-byte entry leaves the sum identity untouched.
        const summed = (measurement.requests ?? []).reduce((sum, r) => sum + r.bytes, 0);
        expect(measurement.bytesReceived).toBe(summed);
        expect(measurement.bytesReceived).toBe(2 * SPEED_TEST_CADENCE_CHUNK_BYTES);
        expect(
            speedTestResultSchema.parse({ ...measurement, mode: 'cadence' }).requests,
        ).toHaveLength(3);
    });

    test('a FIRST leg that fails still rejects — there is nothing to report', async () => {
        // Nothing was measured, so the caller must show its failure text rather
        // than store a row with an empty series (which the server 422s anyway).
        const fetchImpl = (() =>
            Promise.resolve(new Response('slow down', { status: 429 }))) as unknown as typeof fetch;
        let sleeps = 0;
        await expect(
            runSpeedTest({
                mode: 'cadence',
                fetchImpl,
                now: () => 0,
                sleep: async () => {
                    sleeps++;
                },
            }),
        ).rejects.toThrow(/429/);
        expect(sleeps).toBe(0);
    });

    test('stops and reports aborted when the run outgrows the reportable window', async () => {
        const clock = { ms: 0 };
        const seen: string[] = [];
        // Every request takes 19 s of wall clock, so the 120 s ceiling bites
        // long before the 8th.
        let base = 0;
        const fetchImpl = ((url: string) => {
            seen.push(url);
            const start = base;
            let emitted = false;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (emitted) {
                            clock.ms = start + 19_000;
                            base = clock.ms;
                            controller.close();
                            return;
                        }
                        emitted = true;
                        clock.ms = start + 30;
                        controller.enqueue(new Uint8Array(1024));
                    },
                },
                { highWaterMark: 0 },
            );
            return Promise.resolve(new Response(body, { status: 200 }));
        }) as unknown as typeof fetch;

        const measurement = await runSpeedTest({
            mode: 'cadence',
            fetchImpl,
            now: () => clock.ms,
            sleep: async (ms) => {
                clock.ms += ms;
                base = clock.ms;
            },
        });

        expect(seen.length).toBeLessThan(SPEED_TEST_CADENCE_REQUESTS);
        expect(measurement.aborted).toBe(true);
        expect(measurement.durationMs).toBe(120_000);
        expect(measurement.ttfbMs).toBeLessThanOrEqual(measurement.durationMs);
        expect(speedTestResultSchema.parse({ ...measurement, mode: 'cadence' }).durationMs).toBe(
            120_000,
        );
    });
});

// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { summariseSpeedTest } from './speed-test-summary';

describe('summariseSpeedTest', () => {
    it('computes throughput over transfer time, excluding TTFB', () => {
        const s = summariseSpeedTest({
            bytesReceived: 1_000_000,
            durationMs: 1_500,
            ttfbMs: 500,
            buckets: [],
        });
        expect(s.throughputBps).toBe(8_000_000);
    });
    it('reports the slowest non-first bucket and the stalled time', () => {
        const s = summariseSpeedTest({
            bytesReceived: 3_000_000,
            durationMs: 1_250,
            ttfbMs: 250,
            buckets: [
                { ms: 250, bytes: 1_000_000 },
                { ms: 250, bytes: 1_000_000 },
                { ms: 250, bytes: 0 },
                { ms: 250, bytes: 1_000_000 },
            ],
        });
        expect(s.minBucketBps).toBe(0);
        expect(s.stallMs).toBe(250);
    });
    it('has no minBucket with fewer than two buckets', () => {
        expect(
            summariseSpeedTest({
                bytesReceived: 10,
                durationMs: 10,
                ttfbMs: 0,
                buckets: [{ ms: 10, bytes: 10 }],
            }).minBucketBps,
        ).toBeNull();
    });
    it('never divides by zero when duration equals ttfb', () => {
        expect(
            summariseSpeedTest({ bytesReceived: 100, durationMs: 5, ttfbMs: 5, buckets: [] })
                .throughputBps,
        ).toBe(800_000);
    });
});

describe('summariseSpeedTest — single/long modes', () => {
    it('reports one request and no per-request numbers', () => {
        const s = summariseSpeedTest({
            mode: 'long',
            bytesReceived: 8_000_000,
            durationMs: 8_000,
            ttfbMs: 0,
            buckets: [],
        });
        expect(s.requestCount).toBe(1);
        expect(s.maxTtfbMs).toBeNull();
        expect(s.minRequestBps).toBeNull();
        expect(s.gapMs).toBeNull();
    });

    it('treats an absent mode as single', () => {
        const s = summariseSpeedTest({
            bytesReceived: 1_000_000,
            durationMs: 1_500,
            ttfbMs: 500,
            buckets: [],
        });
        expect(s.throughputBps).toBe(8_000_000);
        expect(s.requestCount).toBe(1);
    });
});

describe('summariseSpeedTest — cadence mode', () => {
    /**
     * Two 1 s transfers with a 2 s pause between them. The wall clock is 4.6 s,
     * but only the 2 s actually spent in flight may divide the bytes — a pause
     * is not a stall.
     */
    const CADENCE = {
        mode: 'cadence' as const,
        bytesReceived: 1_500_000,
        durationMs: 4_600,
        ttfbMs: 100,
        buckets: [],
        requests: [
            { bytes: 1_000_000, ttfbMs: 100, durationMs: 1_100 },
            { bytes: 500_000, ttfbMs: 500, durationMs: 1_500 },
        ],
    };

    it('divides the summed bytes by the summed in-flight time, not the wall clock', () => {
        // 1.5 MB · 8 = 12 Mbit over (1000 + 1000) ms = 6 Mbit/s.
        // The wall-clock answer would be 12e6 / 4500 * 1000 ≈ 2.67 Mbit/s.
        expect(summariseSpeedTest(CADENCE).throughputBps).toBe(6_000_000);
    });

    it('reports the request count, the worst request and the worst first byte', () => {
        const s = summariseSpeedTest(CADENCE);
        expect(s.requestCount).toBe(2);
        expect(s.minRequestBps).toBe(4_000_000); // 500 kB over 1 s
        expect(s.maxTtfbMs).toBe(500);
        expect(s.gapMs).toBe(2000);
    });

    it('stores no bucket numbers — cadence sends no buckets', () => {
        const s = summariseSpeedTest(CADENCE);
        expect(s.minBucketBps).toBeNull();
        expect(s.stallMs).toBe(0);
    });

    it('divides the SUMMED request bytes, not the posted total', () => {
        // The schema pins the two equal, so this can only arrive by a direct
        // call — and when they disagree the series the timings belong to wins.
        const s = summariseSpeedTest({ ...CADENCE, bytesReceived: 99_000_000 });
        expect(s.throughputBps).toBe(6_000_000);
    });

    it('ignores buckets even if a client sends them (the schema refuses them)', () => {
        const s = summariseSpeedTest({
            ...CADENCE,
            buckets: [
                { ms: 250, bytes: 100_000 },
                { ms: 250, bytes: 0 },
            ],
        });
        expect(s.minBucketBps).toBeNull();
        expect(s.stallMs).toBe(0);
    });

    it('handles a request that received nothing without dividing by zero', () => {
        const s = summariseSpeedTest({
            mode: 'cadence',
            bytesReceived: 1_000_000,
            durationMs: 23_000,
            ttfbMs: 100,
            buckets: [],
            requests: [
                { bytes: 1_000_000, ttfbMs: 100, durationMs: 1_100 },
                { bytes: 0, ttfbMs: 20_000, durationMs: 20_000 },
            ],
        });
        // Denominator is 1000 ms + the 1 ms floor for the dead request.
        expect(s.throughputBps).toBeCloseTo(((1_000_000 * 8) / 1001) * 1000, 3);
        expect(s.minRequestBps).toBe(0);
        expect(s.maxTtfbMs).toBe(20_000);
        expect(s.requestCount).toBe(2);
    });

    it('falls back to the buckets maths when cadence arrives with no requests', () => {
        // The schema rejects this shape (422), so it can only be reached by a
        // direct call — it must still produce a number rather than NaN.
        const s = summariseSpeedTest({
            mode: 'cadence',
            bytesReceived: 1_000_000,
            durationMs: 1_500,
            ttfbMs: 500,
            buckets: [],
            requests: [],
        });
        expect(s.throughputBps).toBe(8_000_000);
        expect(s.requestCount).toBe(0);
        expect(s.minRequestBps).toBeNull();
        expect(s.maxTtfbMs).toBeNull();
        expect(s.gapMs).toBe(2000);
    });
});

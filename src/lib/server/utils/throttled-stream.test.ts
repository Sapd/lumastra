// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { throttleNodeStream, kbpsToBytesPerSecond } from './throttled-stream';

/** Source emitting `count` chunks of `size` bytes. */
function source(count: number, size: number): Readable {
    return Readable.from(
        (function* () {
            for (let i = 0; i < count; i++) yield Buffer.alloc(size, 1);
        })(),
    );
}

/**
 * Drain a stream against a virtual clock: `sleep` advances time instead of
 * waiting, so pacing is asserted deterministically and the test stays fast.
 */
async function drainVirtual(
    stream: (now: () => number, sleep: (ms: number) => Promise<void>) => ReadableStream<Uint8Array>,
): Promise<{ bytes: number; elapsedMs: number }> {
    let clock = 0;
    const now = () => clock;
    const sleep = (ms: number) => {
        clock += ms;
        return Promise.resolve();
    };

    const reader = stream(now, sleep).getReader();
    let bytes = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value!.byteLength;
    }
    return { bytes, elapsedMs: clock };
}

describe('throttleNodeStream', () => {
    it('passes every byte through unchanged when unlimited', async () => {
        const { bytes, elapsedMs } = await drainVirtual((now, sleep) =>
            throttleNodeStream(source(10, 1000), 0, now, sleep),
        );
        expect(bytes).toBe(10_000);
        expect(elapsedMs).toBe(0);
    });

    it('delivers the full payload when throttled', async () => {
        const { bytes } = await drainVirtual((now, sleep) =>
            throttleNodeStream(source(20, 1000), 5000, now, sleep),
        );
        expect(bytes).toBe(20_000);
    });

    // The bucket refills on wall-clock time, so the achieved rate must hold
    // regardless of how the filesystem happened to chunk the reads.
    it('paces to approximately the configured rate', async () => {
        const rate = 1000; // bytes/sec
        // 5000 bytes at 1000 B/s, no initial burst, is ~5s of waiting.
        const { bytes, elapsedMs } = await drainVirtual((now, sleep) =>
            throttleNodeStream(source(5, 1000), rate, now, sleep),
        );
        expect(bytes).toBe(5000);
        expect(elapsedMs).toBeGreaterThanOrEqual(4750);
        expect(elapsedMs).toBeLessThanOrEqual(5250);
    });

    it('is chunk-size independent — same rate from different read granularity', async () => {
        const rate = 1000;
        const coarse = await drainVirtual((now, sleep) =>
            throttleNodeStream(source(4, 1000), rate, now, sleep),
        );
        const fine = await drainVirtual((now, sleep) =>
            throttleNodeStream(source(40, 100), rate, now, sleep),
        );
        expect(coarse.bytes).toBe(fine.bytes);
        expect(Math.abs(coarse.elapsedMs - fine.elapsedMs)).toBeLessThanOrEqual(100);
    });

    // Each response pays for its first byte: many short Range requests cannot dodge the cap.
    it('starts with an empty bucket: no initial burst', async () => {
        const { elapsedMs } = await drainVirtual((now, sleep) =>
            throttleNodeStream(source(1, 1000), 1000, now, sleep),
        );
        expect(elapsedMs).toBeGreaterThanOrEqual(900);
    });

    it('sequential short responses take as long as one long response', async () => {
        let total = 0;
        for (let i = 0; i < 4; i++) {
            const { elapsedMs } = await drainVirtual((now, sleep) =>
                throttleNodeStream(source(1, 500), 1000, now, sleep),
            );
            total += elapsedMs;
        }
        expect(total).toBeGreaterThanOrEqual(1900);
    });

    // A chunk bigger than the whole bucket must not deadlock against a capacity
    // it can never reach.
    it('delivers a chunk larger than the bucket capacity', async () => {
        const { bytes } = await drainVirtual((now, sleep) =>
            throttleNodeStream(source(1, 10_000), 1000, now, sleep),
        );
        expect(bytes).toBe(10_000);
    });

    it('destroys the source when the consumer cancels', async () => {
        const src = source(100, 1000);
        const destroy = vi.spyOn(src, 'destroy');
        const stream = throttleNodeStream(src, 1000);
        const reader = stream.getReader();
        await reader.read();
        await reader.cancel(new Error('client went away'));
        expect(destroy).toHaveBeenCalled();
    });

    it('propagates a source error', async () => {
        const src = new Readable({
            read() {
                this.destroy(new Error('disk fell over'));
            },
        });
        const reader = throttleNodeStream(src, 0).getReader();
        await expect(reader.read()).rejects.toThrow('disk fell over');
    });
});

describe('throttleNodeStream with a changing rate', () => {
    // The rate function is read on each refill, so a lease manager can raise or
    // lower the cap while the download runs.
    it('doubles throughput within a second of the rate going from 1000 to 2000 B/s', async () => {
        let clock = 0;
        const now = () => clock;
        const sleep = (ms: number) => {
            clock += ms;
            return Promise.resolve();
        };
        let rate = 1000;
        const reader = throttleNodeStream(source(60, 100), () => rate, now, sleep).getReader();
        const measure = async (chunks: number) => {
            const t0 = clock;
            for (let i = 0; i < chunks; i++) await reader.read();
            return (chunks * 100) / ((clock - t0) / 1000);
        };
        await measure(10); // settle
        const slow = await measure(10);
        rate = 2000;
        await measure(5); // let the new rate settle
        const fast = await measure(20);
        expect(slow).toBeGreaterThan(900);
        expect(slow).toBeLessThan(1100);
        expect(fast).toBeGreaterThan(1800);
        expect(fast).toBeLessThan(2200);
    });

    it('treats a rate function returning 0 as unlimited', async () => {
        const { bytes, elapsedMs } = await drainVirtual((now, sleep) =>
            throttleNodeStream(source(10, 1000), () => 0, now, sleep),
        );
        expect(bytes).toBe(10_000);
        expect(elapsedMs).toBe(0);
    });
});

describe('throttleNodeStream wait granularity', () => {
    it('never waits longer than 250 ms at once and keeps delivering at 85 B/s', async () => {
        const waits: number[] = [];
        let clock = 0;
        const sleep = (ms: number) => {
            waits.push(ms);
            clock += ms;
            return Promise.resolve();
        };
        const reader = throttleNodeStream(source(1, 2000), 85, () => clock, sleep).getReader();
        const arrivals: number[] = [];
        for (;;) {
            const { done } = await reader.read();
            if (done) break;
            arrivals.push(clock);
        }
        expect(Math.max(...waits)).toBeLessThanOrEqual(250);
        // a healthy stream shows bytes every few seconds, never one 20 s silence
        const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]!);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(300);
        // overall rate holds: 2000 B at 85 B/s is ~23.5 s
        expect(clock).toBeGreaterThan(22_000);
        expect(clock).toBeLessThan(25_000);
    });

    it('re-reads the rate between pieces of one chunk', async () => {
        let clock = 0;
        let rate = 100;
        const sleep = (ms: number) => {
            clock += ms;
            if (clock > 1000) rate = 10_000;
            return Promise.resolve();
        };
        const reader = throttleNodeStream(
            source(1, 5000),
            () => rate,
            () => clock,
            sleep,
        ).getReader();
        for (;;) if ((await reader.read()).done) break;
        // At a fixed 100 B/s this would take 50 s.
        expect(clock).toBeLessThan(5000);
    });

    it('a cancel during a sleep clears the timer and returns promptly', async () => {
        vi.useFakeTimers();
        let clear: ReturnType<typeof vi.spyOn> | undefined;
        try {
            const src = source(10, 1000);
            const reader = throttleNodeStream(src, 10).getReader();
            const pending = reader.read(); // sleeps 250 ms inside pull
            await vi.advanceTimersByTimeAsync(100);
            expect(vi.getTimerCount()).toBeGreaterThan(0);
            // Check the sleep's own timer is cleared: a global timer count also sees
            // unrelated timers and went red under full-suite load.
            clear = vi.spyOn(globalThis, 'clearTimeout');
            await reader.cancel(new Error('gone'));
            expect(clear).toHaveBeenCalled();
            // No timer is advanced: the read settles because the cancel woke the sleeper.
            const r = await pending;
            expect(r.done).toBe(true);
        } finally {
            clear?.mockRestore();
            vi.useRealTimers();
        }
    });
});

describe('kbpsToBytesPerSecond', () => {
    it('converts KB/s to bytes/sec', () => {
        expect(kbpsToBytesPerSecond(1024)).toBe(1024 * 1024);
    });

    // 0 is the documented "off" value and the default — it must not become a
    // 0 B/s cap that stalls every response forever.
    it('treats 0 and negatives as unlimited', () => {
        expect(kbpsToBytesPerSecond(0)).toBe(0);
        expect(kbpsToBytesPerSecond(-5)).toBe(0);
        expect(kbpsToBytesPerSecond(Number.NaN)).toBe(0);
    });
});

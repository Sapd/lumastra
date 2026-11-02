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
        // 5000 bytes at 1000 B/s, minus a 1s burst allowance, is ~4s of waiting.
        const { bytes, elapsedMs } = await drainVirtual((now, sleep) =>
            throttleNodeStream(source(5, 1000), rate, now, sleep),
        );
        expect(bytes).toBe(5000);
        expect(elapsedMs).toBeGreaterThanOrEqual(3500);
        expect(elapsedMs).toBeLessThanOrEqual(4500);
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

    // An idle client must be able to burst, or an HTTP transfer reads as a stall.
    it('allows an initial burst up to one second of allowance', async () => {
        const { elapsedMs } = await drainVirtual((now, sleep) =>
            throttleNodeStream(source(1, 1000), 1000, now, sleep),
        );
        expect(elapsedMs).toBe(0);
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

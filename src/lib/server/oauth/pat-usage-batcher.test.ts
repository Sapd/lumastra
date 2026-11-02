// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PatUsageBatcher } from './pat-usage-batcher.js';
import type { PatUsageBatch } from '../database/queries/pat-usage.queries.js';
const interval = 5 * 60_000;
afterEach(() => {
    vi.useRealTimers();
});
describe('PAT usage batching', () => {
    it('counts every concurrent use, writes once per five minutes and remembers the latest IP/time', async () => {
        vi.useFakeTimers();
        const write = vi.fn<(batch: PatUsageBatch) => Promise<void>>().mockResolvedValue();
        const batcher = new PatUsageBatcher(write, vi.fn());
        const initial = Date.now();
        await Promise.all(
            Array.from({ length: 100 }, () => batcher.record('test-hash', '192.0.2.1')),
        );
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0][0].uses).toBe(1);
        await vi.advanceTimersByTimeAsync(interval - 1);
        await batcher.record('test-hash', '192.0.2.2');
        expect(write).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[1][0]).toEqual({
            tokenHash: 'test-hash',
            uses: 100,
            clientIp: '192.0.2.2',
            usedAt: new Date(initial + interval - 1),
        });
        await vi.advanceTimersByTimeAsync(interval);
        expect(write).toHaveBeenCalledTimes(2); // idle cooldown expired without a write
        await batcher.record('test-hash');
        expect(write).toHaveBeenCalledTimes(3);
        await batcher.shutdown();
    });
    it('preserves failed increments and uses arriving while the first write is in flight', async () => {
        vi.useFakeTimers();
        let rejectWrite!: (error: Error) => void;
        const write = vi
            .fn<(batch: PatUsageBatch) => Promise<void>>()
            .mockImplementationOnce(
                () =>
                    new Promise<void>((_resolve, reject) => {
                        rejectWrite = reject;
                    }),
            )
            .mockResolvedValue();
        const batcher = new PatUsageBatcher(write, vi.fn());
        const first = batcher.record('test-hash', '192.0.2.1');
        await Promise.resolve();
        await batcher.record('test-hash', '192.0.2.2');
        rejectWrite(new Error('DB down'));
        await expect(first).rejects.toThrow('DB down');
        await vi.advanceTimersByTimeAsync(interval);
        expect(write.mock.calls[1][0].uses).toBe(2);
        expect(write.mock.calls[1][0].clientIp).toBe('192.0.2.2');
        await batcher.shutdown();
    });
    it('handles a synchronous writer failure and reports timer failures without losing the batch', async () => {
        vi.useFakeTimers();
        const onError = vi.fn();
        const write = vi
            .fn<(batch: PatUsageBatch) => Promise<void>>()
            .mockImplementationOnce(() => {
                throw new Error('sync failure');
            })
            .mockRejectedValueOnce(new Error('timer failure'))
            .mockResolvedValue();
        const batcher = new PatUsageBatcher(write, onError);
        await expect(batcher.record('test-hash')).rejects.toThrow('sync failure');
        await batcher.record('test-hash');
        await vi.advanceTimersByTimeAsync(interval);
        expect(onError).toHaveBeenCalledOnce();
        await batcher.shutdown();
        expect(write.mock.calls[2][0].uses).toBe(2);
    });
    it('flushes each token once on shutdown, including arrivals during an in-flight write', async () => {
        vi.useFakeTimers();
        let finish!: () => void;
        const write = vi
            .fn<(batch: PatUsageBatch) => Promise<void>>()
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        finish = resolve;
                    }),
            )
            .mockResolvedValue();
        const batcher = new PatUsageBatcher(write, vi.fn());
        const first = batcher.record('first');
        await Promise.resolve();
        await batcher.record('first');
        await batcher.record('second');
        await batcher.record('second');
        const shutdown = batcher.shutdown();
        finish();
        await first;
        await shutdown;
        await batcher.shutdown();
        expect(
            write.mock.calls
                .filter(([b]) => b.tokenHash === 'first')
                .reduce((n, [b]) => n + b.uses, 0),
        ).toBe(2);
        expect(
            write.mock.calls
                .filter(([b]) => b.tokenHash === 'second')
                .reduce((n, [b]) => n + b.uses, 0),
        ).toBe(2);
        const calls = write.mock.calls.length;
        await vi.advanceTimersByTimeAsync(2 * interval);
        expect(write).toHaveBeenCalledTimes(calls);
    });
});

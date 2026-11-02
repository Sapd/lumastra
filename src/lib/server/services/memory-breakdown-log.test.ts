// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import type v8 from 'node:v8';
vi.mock('./cluster-node-runtime.js', () => ({
    readCgroupSnapshot: vi.fn(async () => ({
        memoryUsedBytes: 700,
        memoryAnonBytes: 500,
        memoryFileBytes: 400,
        memoryActiveFileBytes: 100,
        memoryInactiveFileBytes: 300,
        memoryShmemBytes: 20,
        memorySlabBytes: 30,
        memoryFileDirtyBytes: 10,
    })),
}));

import { collectMemoryBreakdown, trackThreadHeap } from './memory-breakdown-log.js';

function heapInfo(usedMb: number, totalMb: number): v8.HeapInfo {
    return {
        used_heap_size: usedMb * 1_048_576,
        total_heap_size: totalMb * 1_048_576,
    } as v8.HeapInfo;
}

describe('collectMemoryBreakdown', () => {
    const untracks: Array<() => void> = [];
    afterEach(() => {
        for (const u of untracks.splice(0)) u();
        vi.useRealTimers();
    });

    it('reports the main heap and the remainder', async () => {
        const b = await collectMemoryBreakdown();
        expect(b.cgroup).toMatchObject({
            memoryUsedBytes: 700,
            memoryAnonBytes: 500,
            memoryFileBytes: 400,
            memoryActiveFileBytes: 100,
            memoryInactiveFileBytes: 300,
            memoryShmemBytes: 20,
            memorySlabBytes: 30,
            memoryFileDirtyBytes: 10,
        });
        expect(b.rssMb).toBeGreaterThan(0);
        expect(b.heapUsedMb).toBeGreaterThan(0);
        expect(b.heapTotalMb).toBeGreaterThanOrEqual(b.heapUsedMb);
        expect(Object.keys(b.heapSpacesMb)).toContain('old_space');
        expect(b.threads).toEqual([]);
        expect(b.untrackedMb).toBe(b.rssMb - b.heapTotalMb - b.externalMb);
    });

    it('includes tracked thread heaps and subtracts them from the remainder', async () => {
        untracks.push(
            trackThreadHeap('watcher', { getHeapStatistics: async () => heapInfo(40, 64) }),
        );
        const b = await collectMemoryBreakdown();
        expect(b.threads).toEqual([{ label: 'watcher', usedMb: 40, totalMb: 64 }]);
        expect(b.threadsHeapTotalMb).toBe(64);
        expect(b.untrackedMb).toBe(b.rssMb - b.heapTotalMb - b.externalMb - 64);
    });

    it('marks threads that cannot report instead of failing', async () => {
        untracks.push(trackThreadHeap('old-node', {}));
        untracks.push(
            trackThreadHeap('gone', {
                getHeapStatistics: async () => {
                    throw new Error('worker exited');
                },
            }),
        );
        const b = await collectMemoryBreakdown();
        expect(b.threads).toEqual([
            { label: 'old-node', unavailable: 'unsupported' },
            { label: 'gone', unavailable: 'error' },
        ]);
        expect(b.threadsHeapTotalMb).toBe(0);
    });

    it('does not wait forever on a wedged thread', async () => {
        vi.useFakeTimers();
        untracks.push(
            trackThreadHeap('wedged', { getHeapStatistics: () => new Promise(() => {}) }),
        );
        const pending = collectMemoryBreakdown();
        await vi.advanceTimersByTimeAsync(2_000);
        const b = await pending;
        expect(b.threads).toEqual([{ label: 'wedged', unavailable: 'timeout' }]);
    });

    it('stops reporting a thread once untracked', async () => {
        const untrack = trackThreadHeap('watcher', {
            getHeapStatistics: async () => heapInfo(1, 2),
        });
        untrack();
        expect((await collectMemoryBreakdown()).threads).toEqual([]);
    });

    it('reads a real worker thread heap', async () => {
        const worker = new Worker('setInterval(() => {}, 1000);', { eval: true });
        untracks.push(trackThreadHeap('real', worker));
        try {
            await new Promise<void>((resolve) => worker.once('online', () => resolve()));
            const [t] = (await collectMemoryBreakdown()).threads;
            expect(t.label).toBe('real');
            expect(t.unavailable).toBeUndefined();
            expect(t.totalMb).toBeGreaterThan(0);
        } finally {
            await worker.terminate();
        }
    });
});

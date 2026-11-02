// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Periodic process-memory breakdown log.
 *
 * Container RSS alone cannot say what holds the memory: prod's worker sits at
 * ~1.3 GB (preprod: ~330 MB) and steps up by ~600 MB for an hour at a time,
 * with no extra process or thread. This logs, every few minutes, how the
 * process's memory splits up:
 *
 *   - main-thread V8 heap (used/total, plus the large spaces)
 *   - `external` / `arrayBuffers` (Buffers, native allocations V8 knows about)
 *   - the JS heap of every tracked worker thread (isolated
 *     task runs) — each has its own isolate, invisible in the main heap numbers
 *   - the remainder (rss − everything above): native memory V8 does not track
 *
 * The native file watcher runs in a separate process; its RSS is outside this breakdown.
 *
 * Threads register themselves via `trackThreadHeap()`; a thread whose
 * `getHeapStatistics()` does not answer within a short timeout (wedged in a
 * synchronous NFS call, say) is reported as such instead of stalling the log.
 */

import v8 from 'node:v8';
import { readCgroupSnapshot, type CgroupSnapshot } from './cluster-node-runtime.js';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('MemoryBreakdown');

/** Every 5 minutes, first sample 60 s after start (boot baseline). */
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const FIRST_SAMPLE_DELAY_MS = 60_000;
const THREAD_STATS_TIMEOUT_MS = 2_000;

/** What a tracked thread must offer — `node:worker_threads` Worker (Node ≥ 22.16). */
export interface ThreadHeapSource {
    getHeapStatistics?(): Promise<v8.HeapInfo>;
}

interface TrackedThread {
    label: string;
    source: ThreadHeapSource;
}

const trackedThreads = new Map<symbol, TrackedThread>();

/**
 * Include a worker thread's heap in the breakdown. Returns the untrack
 * function; call it when the thread exits.
 */
export function trackThreadHeap(label: string, source: ThreadHeapSource): () => void {
    const key = Symbol(label);
    trackedThreads.set(key, { label, source });
    return () => {
        trackedThreads.delete(key);
    };
}

export interface ThreadHeapSample {
    label: string;
    usedMb?: number;
    totalMb?: number;
    /** Set when the stats could not be read. */
    unavailable?: 'unsupported' | 'timeout' | 'error';
}

export interface MemoryBreakdown {
    cgroup?: CgroupSnapshot;
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
    arrayBuffersMb: number;
    /** Used size per main-thread V8 heap space, only spaces ≥ 1 MB. */
    heapSpacesMb: Record<string, number>;
    threads: ThreadHeapSample[];
    threadsHeapTotalMb: number;
    /** rss − main heap total − external − thread heaps: native memory V8 does not see. */
    untrackedMb: number;
}

function mb(bytes: number): number {
    return Math.round(bytes / 1_048_576);
}

async function sampleThread(t: TrackedThread): Promise<ThreadHeapSample> {
    if (typeof t.source.getHeapStatistics !== 'function') {
        return { label: t.label, unavailable: 'unsupported' };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), THREAD_STATS_TIMEOUT_MS);
        timer.unref?.();
    });
    try {
        const result = await Promise.race([t.source.getHeapStatistics(), timeout]);
        if (result === 'timeout') return { label: t.label, unavailable: 'timeout' };
        return {
            label: t.label,
            usedMb: mb(result.used_heap_size),
            totalMb: mb(result.total_heap_size),
        };
    } catch {
        // The thread exited between listing and sampling, most likely.
        return { label: t.label, unavailable: 'error' };
    } finally {
        clearTimeout(timer);
    }
}

export async function collectMemoryBreakdown(): Promise<MemoryBreakdown> {
    const threads = await Promise.all([...trackedThreads.values()].map(sampleThread));
    const mem = process.memoryUsage();
    const heapSpacesMb: Record<string, number> = {};
    for (const space of v8.getHeapSpaceStatistics()) {
        const used = mb(space.space_used_size);
        if (used >= 1) heapSpacesMb[space.space_name] = used;
    }
    const threadsHeapTotalMb = threads.reduce((sum, t) => sum + (t.totalMb ?? 0), 0);
    const rssMb = mb(mem.rss);
    const heapTotalMb = mb(mem.heapTotal);
    const externalMb = mb(mem.external);
    return {
        cgroup: await readCgroupSnapshot(),
        rssMb,
        heapUsedMb: mb(mem.heapUsed),
        heapTotalMb,
        externalMb,
        arrayBuffersMb: mb(mem.arrayBuffers),
        heapSpacesMb,
        threads,
        threadsHeapTotalMb,
        untrackedMb: rssMb - heapTotalMb - externalMb - threadsHeapTotalMb,
    };
}

let intervalTimer: ReturnType<typeof setInterval> | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;

/** Start the periodic log. Idempotent. */
export function startMemoryBreakdownLog(opts: { role?: string; intervalMs?: number } = {}): void {
    if (intervalTimer || firstTimer) return;
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const logOnce = (): void => {
        collectMemoryBreakdown()
            .then((breakdown) => {
                logger.info('Process memory breakdown', { role: opts.role, ...breakdown });
            })
            .catch((err: unknown) => {
                logger.warn('Process memory breakdown failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            });
    };
    firstTimer = setTimeout(
        () => {
            firstTimer = null;
            logOnce();
            intervalTimer = setInterval(logOnce, intervalMs);
            intervalTimer.unref?.();
        },
        Math.min(FIRST_SAMPLE_DELAY_MS, intervalMs),
    );
    firstTimer.unref?.();
}

export function stopMemoryBreakdownLog(): void {
    if (firstTimer) clearTimeout(firstTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    firstTimer = null;
    intervalTimer = null;
}

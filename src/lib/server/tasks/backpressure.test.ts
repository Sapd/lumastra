// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Backpressure.
 *
 * BullMQ Queue is replaced with a minimal stub. No live infrastructure required.
 *
 * Run with: npx vitest run src/lib/server/tasks/backpressure.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { Backpressure, BackpressureError } from './backpressure.js';
import type { ResourceClass } from '@sapd/lumastra-plugin-sdk';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    LUMASTRA_QUEUE_DEPTH_CAP_CPU: 500,
    LUMASTRA_QUEUE_DEPTH_CAP_IO: 2_000,
    LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING: 10_000,
    LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE: 100,
    // Added with the ingest/bulk/analysis classes — backpressure.ts's classCaps
    // destructures all seven at module load, so the mock must export them.
    LUMASTRA_QUEUE_DEPTH_CAP_INGEST: 2_000,
    LUMASTRA_QUEUE_DEPTH_CAP_BULK: 500,
    LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS: 100,
    LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY: 10_000,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// ── Queue stub ────────────────────────────────────────────────────────────────

interface FakeJob {
    opts: { priority?: number };
    remove: ReturnType<typeof vi.fn>;
}

function makeQueueStub(depth: number, waitingJobs: FakeJob[] = []) {
    return {
        getJobCounts: vi.fn(async () => ({
            waiting: depth,
            prioritized: 0,
            delayed: 0,
        })),
        getJobs: vi.fn(async () => waitingJobs),
    };
}

function makeFakeJob(priority: number): FakeJob {
    return { opts: { priority }, remove: vi.fn(async () => {}) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Backpressure', () => {
    const cls: ResourceClass = 'maintenance'; // cap = 100

    describe('no bp config', () => {
        it('allows when bp is undefined', async () => {
            const queue = makeQueueStub(9_999);
            const bp = new Backpressure(() => queue as never);
            const result = await bp.check(cls, 5, undefined);
            expect(result.proceed).toBe(true);
        });
    });

    describe('below cap', () => {
        it('allows when depth < class cap and depth < task limit', async () => {
            const queue = makeQueueStub(50);
            const bp = new Backpressure(() => queue as never);
            const result = await bp.check(cls, 5, {
                onQueueDepthOver: 200,
                action: 'drop',
            });
            expect(result.proceed).toBe(true);
        });
    });

    describe('fail-fast', () => {
        it('throws BackpressureError at class cap', async () => {
            const queue = makeQueueStub(100); // exactly at cap of 100
            const bp = new Backpressure(() => queue as never);
            await expect(
                bp.check(cls, 5, { onQueueDepthOver: 200, action: 'fail-fast' }),
            ).rejects.toBeInstanceOf(BackpressureError);
        });

        it('BackpressureError has retryAfterMs', async () => {
            const queue = makeQueueStub(100);
            const bp = new Backpressure(() => queue as never);
            try {
                await bp.check(cls, 5, {
                    onQueueDepthOver: 200,
                    action: 'fail-fast',
                });
            } catch (err) {
                expect(err).toBeInstanceOf(BackpressureError);
                expect((err as BackpressureError).retryAfterMs).toBeGreaterThan(0);
            }
        });

        it('throws when depth >= task onQueueDepthOver (below class cap)', async () => {
            const queue = makeQueueStub(30);
            const bp = new Backpressure(() => queue as never);
            await expect(
                bp.check(cls, 5, { onQueueDepthOver: 30, action: 'fail-fast' }),
            ).rejects.toBeInstanceOf(BackpressureError);
        });
    });

    describe('drop', () => {
        it('returns proceed:false at class cap', async () => {
            const queue = makeQueueStub(100);
            const bp = new Backpressure(() => queue as never);
            const result = await bp.check(cls, 5, {
                onQueueDepthOver: 200,
                action: 'drop',
            });
            expect(result.proceed).toBe(false);
            expect(result.reason).toBe('backpressure-drop');
        });
    });

    describe('shed-oldest', () => {
        it('sheds priority>=7 jobs and proceeds when headroom opens', async () => {
            // First getDepth call: 100 (at cap). After shedding 5 jobs: 95 (under cap).
            const sheddableJobs = [7, 8, 9, 7, 10].map(makeFakeJob);
            let callCount = 0;
            const queue = {
                getJobCounts: vi.fn(async () => {
                    callCount++;
                    // First call: over cap. Second call (post-shed): under cap.
                    const depth = callCount === 1 ? 100 : 95;
                    return { waiting: depth, prioritized: 0, delayed: 0 };
                }),
                getJobs: vi.fn(async () => sheddableJobs),
            };
            const bp = new Backpressure(() => queue as never);
            const result = await bp.check(cls, 5, {
                onQueueDepthOver: 200,
                action: 'shed-oldest',
            });

            // All 5 sheddable jobs should have been removed.
            for (const job of sheddableJobs) {
                expect(job.remove).toHaveBeenCalled();
            }
            // After shedding, depth is 95 < 100 cap and < 200 task limit.
            expect(result.proceed).toBe(true);
        });

        it('denies when no sheddable jobs exist', async () => {
            // Only protected jobs (priority 1 and 5) in queue.
            const protectedJobs = [1, 5, 5, 1].map(makeFakeJob);
            const queue = makeQueueStub(100, protectedJobs);
            const bp = new Backpressure(() => queue as never);
            const result = await bp.check(cls, 5, {
                onQueueDepthOver: 200,
                action: 'shed-oldest',
            });

            for (const job of protectedJobs) {
                expect(job.remove).not.toHaveBeenCalled();
            }
            expect(result.proceed).toBe(false);
            expect(result.reason).toBe('backpressure-shed-oldest');
        });

        it('does not shed priority<7 jobs', async () => {
            const jobs = [5, 6, 7, 8].map(makeFakeJob);
            const queue = makeQueueStub(100, jobs);
            const bp = new Backpressure(() => queue as never);
            await bp.check(cls, 5, {
                onQueueDepthOver: 200,
                action: 'shed-oldest',
            });

            // Only priority 7 and 8 should be removed.
            expect(jobs[0].remove).not.toHaveBeenCalled(); // priority 5
            expect(jobs[1].remove).not.toHaveBeenCalled(); // priority 6
            expect(jobs[2].remove).toHaveBeenCalled(); // priority 7
            expect(jobs[3].remove).toHaveBeenCalled(); // priority 8
        });
    });

    // ── Wave 8.5: per-task-queue depth summing ─────────────────────────────────
    describe('with per-task queues (getClassQueues supplied)', () => {
        it('sums depth across every per-task queue in the class', async () => {
            // Three per-task queues at 40 each → total 120 > maintenance cap 100.
            const perTaskQueues = [makeQueueStub(40), makeQueueStub(40), makeQueueStub(40)];
            const classQueue = makeQueueStub(0); // legacy class queue is idle
            const bp = new Backpressure(
                () => classQueue as never,
                () => perTaskQueues as never[],
            );
            await expect(
                bp.check(cls, 5, {
                    onQueueDepthOver: 1_000,
                    action: 'fail-fast',
                }),
            ).rejects.toBeInstanceOf(BackpressureError);
            // The legacy class queue must NOT be consulted on the per-task path.
            expect(classQueue.getJobCounts).not.toHaveBeenCalled();
        });

        it('proceeds when the summed per-task depth is below the cap', async () => {
            const perTaskQueues = [makeQueueStub(10), makeQueueStub(10)];
            const bp = new Backpressure(
                () => makeQueueStub(0) as never,
                () => perTaskQueues as never[],
            );
            const result = await bp.check(cls, 5, {
                onQueueDepthOver: 1_000,
                action: 'drop',
            });
            expect(result.proceed).toBe(true);
        });
    });
});

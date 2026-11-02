// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for orphan-sweep.ts.
 * Queue and Valkey interactions are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Queue } from 'bullmq';
import type { ResourceClass } from '@sapd/lumastra-plugin-sdk';
import { OrphanSweep } from './orphan-sweep.js';

// Stable logger singleton so tests can assert on log.warn / log.info. The
// module under test calls Logger.for(...) once at import, so the spy object
// must be the same instance every call. Wrapped in vi.hoisted() because the
// vi.mock factory below is hoisted above this declaration — a plain const would
// be in the temporal dead zone when the factory runs.
const logSpy = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => logSpy,
    },
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

type FakeJob = {
    id: string;
    name: string;
    moveToCompleted: ReturnType<typeof vi.fn>;
};

function makeFakeJob(id: string, name = 'my-task'): FakeJob {
    return {
        id,
        name,
        moveToCompleted: vi.fn(async () => undefined),
    };
}

/**
 * Build a fake Queue. `waitingChildrenJobs` are jobs returned by getJobs(['waiting-children']).
 * `existingJobIds` are job IDs for which `getJob()` returns a truthy value (alive children).
 */
function makeFakeQueue(
    name: string,
    waitingChildrenJobs: FakeJob[],
    existingJobIds: string[] = [],
): Queue {
    return {
        name,
        getJobs: vi.fn(async () => waitingChildrenJobs),
        getJob: vi.fn(async (id: string) => {
            if (existingJobIds.includes(id)) {
                return {
                    id,
                    name: 'child-task',
                    getState: async () => 'active',
                };
            }
            return null;
        }),
    } as unknown as Queue;
}

interface FakeClient {
    zsets: Map<string, string[]>; // key → member list
    customCommand: ReturnType<typeof vi.fn>;
}

/**
 * Build a fake Valkey client.
 * @param zsets        key → SMEMBERS member list (the `:dependencies` SET).
 * @param existingKeys job-hash keys for which EXISTS returns 1 (child present).
 *                     Used by F5.2 to simulate Redis ground truth for a child
 *                     whose owning queue is not registered this boot.
 */
function makeClient(
    zsets: Map<string, string[]> = new Map(),
    existingKeys: Set<string> = new Set(),
): FakeClient {
    const client: FakeClient = {
        zsets,
        customCommand: vi.fn(async (cmd: string[]) => {
            const [op, key] = cmd;
            // BullMQ 5.x stores :dependencies as a SET — production reads it
            // via SMEMBERS (previously ZRANGE, which WRONGTYPE'd on the SET).
            if (op === 'SMEMBERS') {
                return zsets.get(key) ?? [];
            }
            // F5.2: EXISTS-probe of a child job-hash key when the child's queue
            // is unregistered. Returns 1 if the key is in existingKeys, else 0.
            if (op === 'EXISTS') {
                return existingKeys.has(key) ? 1 : 0;
            }
            return [];
        }),
    };
    return client;
}

function makeSweep(opts: { queues?: Map<ResourceClass, Queue>; client?: FakeClient }): OrphanSweep {
    const queues = opts.queues ?? new Map<ResourceClass, Queue>();
    const client = opts.client ?? makeClient();

    return new OrphanSweep(
        (cls: ResourceClass) => queues.get(cls),
        async () =>
            client as unknown as {
                customCommand: (cmd: string[]) => Promise<unknown>;
            },
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OrphanSweep', () => {
    beforeEach(() => {
        logSpy.info.mockClear();
        logSpy.warn.mockClear();
        logSpy.error.mockClear();
        logSpy.debug.mockClear();
    });

    describe('no waiting-children jobs', () => {
        it('returns zero swept and scans all provided queues', async () => {
            const ioQueue = makeFakeQueue('task:io', []);
            const queues = new Map<ResourceClass, Queue>([['io', ioQueue]]);
            const sweep = makeSweep({ queues });

            const result = await sweep.run();
            expect(result.swept).toBe(0);
            expect(result.queuesScanned).toBe(1);
        });

        it('returns zero swept when no queues provided', async () => {
            const sweep = makeSweep({});
            const result = await sweep.run();
            expect(result.swept).toBe(0);
            expect(result.queuesScanned).toBe(0);
        });
    });

    describe('waiting-children parent with all children gone', () => {
        it('force-completes the parent', async () => {
            const parentJob = makeFakeJob('parent_001');
            const ioQueue = makeFakeQueue('task:io', [parentJob], /* no alive children */ []);

            // `:dependencies` ZSET has one entry referencing a child in `task:io`.
            const zsets = new Map([
                ['bull:task:io:parent_001:dependencies', ['bull:task:io:child_gone']],
            ]);
            const client = makeClient(zsets);

            // child_gone is NOT in existingJobIds → getJob returns null.
            const queues = new Map<ResourceClass, Queue>([['io', ioQueue]]);
            const sweep = makeSweep({ queues, client });

            const result = await sweep.run();
            expect(result.swept).toBe(1);
            expect(parentJob.moveToCompleted).toHaveBeenCalledWith(
                { orphanSweep: true },
                '',
                false,
            );
        });
    });

    describe('waiting-children parent with some children still alive', () => {
        it('does NOT force-complete the parent', async () => {
            const parentJob = makeFakeJob('parent_002');
            // child_alive IS in existingJobIds.
            const ioQueue = makeFakeQueue('task:io', [parentJob], ['child_alive']);

            const zsets = new Map([
                ['bull:task:io:parent_002:dependencies', ['bull:task:io:child_alive']],
            ]);
            const client = makeClient(zsets);
            const queues = new Map<ResourceClass, Queue>([['io', ioQueue]]);
            const sweep = makeSweep({ queues, client });

            const result = await sweep.run();
            expect(result.swept).toBe(0);
            expect(parentJob.moveToCompleted).not.toHaveBeenCalled();
        });
    });

    describe('waiting-children with empty :dependencies ZSET', () => {
        it('does NOT force-complete (no tracked deps)', async () => {
            const parentJob = makeFakeJob('parent_003');
            const ioQueue = makeFakeQueue('task:io', [parentJob]);

            // Empty deps ZSET.
            const zsets = new Map([['bull:task:io:parent_003:dependencies', []]]);
            const client = makeClient(zsets);
            const queues = new Map<ResourceClass, Queue>([['io', ioQueue]]);
            const sweep = makeSweep({ queues, client });

            const result = await sweep.run();
            expect(result.swept).toBe(0);
            expect(parentJob.moveToCompleted).not.toHaveBeenCalled();
        });
    });

    describe('multiple resource classes scanned', () => {
        it('scans cpu and io queues independently', async () => {
            const cpuParent = makeFakeJob('parent_cpu');
            const ioParent = makeFakeJob('parent_io');

            // cpu parent: orphaned. io parent: alive child.
            const zsets = new Map([
                ['bull:task:cpu:parent_cpu:dependencies', ['bull:task:cpu:gone_child']],
                ['bull:task:io:parent_io:dependencies', ['bull:task:io:live_child']],
            ]);

            // live_child is alive in io queue.
            const cpuQueueUpdated = makeFakeQueue('task:cpu', [cpuParent], []);
            const ioQueueUpdated = makeFakeQueue('task:io', [ioParent], ['live_child']);

            const client = makeClient(zsets);
            const queues = new Map<ResourceClass, Queue>([
                ['cpu', cpuQueueUpdated],
                ['io', ioQueueUpdated],
            ]);
            const sweep = makeSweep({ queues, client });

            const result = await sweep.run();
            // Only cpu parent is swept.
            expect(result.swept).toBe(1);
            expect(result.queuesScanned).toBe(2);
            expect(cpuParent.moveToCompleted).toHaveBeenCalled();
            expect(ioParent.moveToCompleted).not.toHaveBeenCalled();
        });
    });

    describe('getJobs throws', () => {
        it('continues to next queue and does not throw', async () => {
            const ioQueue = {
                name: 'task:io',
                getJobs: vi.fn(async () => {
                    throw new Error('redis unavailable');
                }),
                getJob: vi.fn(async () => null),
            } as unknown as Queue;

            const queues = new Map<ResourceClass, Queue>([['io', ioQueue]]);
            const sweep = makeSweep({ queues });

            const result = await sweep.run();
            expect(result.swept).toBe(0);
            expect(result.queuesScanned).toBe(1);
        });
    });

    describe('job without id', () => {
        it('skips undefined job slots gracefully', async () => {
            const ioQueue = {
                name: 'task:io',
                // BullMQ sometimes hands back undefined slots.
                getJobs: vi.fn(async () => [null, undefined]),
                getJob: vi.fn(async () => null),
            } as unknown as Queue;

            const queues = new Map<ResourceClass, Queue>([['io', ioQueue]]);
            const sweep = makeSweep({ queues });

            await expect(sweep.run()).resolves.toMatchObject({ swept: 0 });
        });
    });

    // ── F5.1: pagination past the first 500 waiting-children ────────────────────
    describe('F5.1: paginates beyond the first 500 waiting-children jobs', () => {
        /**
         * Build a queue whose getJobs(['waiting-children'], start, end) returns a
         * slice of a backing array, mirroring BullMQ's start/end inclusive range
         * semantics. Lets us assert that the sweep actually pages past index 500.
         */
        function makePagingQueue(name: string, allJobs: FakeJob[]): Queue {
            return {
                name,
                getJobs: vi.fn(async (_types: string[], start: number, end: number) => {
                    // BullMQ getJobs end is inclusive.
                    return allJobs.slice(start, end + 1);
                }),
                getJob: vi.fn(async () => null), // all children gone
            } as unknown as Queue;
        }

        it('inspects and sweeps an orphan at index 600 (past the old 500 cap)', async () => {
            // 601 waiting-children jobs. Only the one at index 600 is orphaned
            // (has a gone dependency); the rest have empty deps so they're skipped.
            const jobs: FakeJob[] = [];
            const zsets = new Map<string, string[]>();
            for (let i = 0; i < 601; i++) {
                const job = makeFakeJob(`parent_${i}`);
                jobs.push(job);
                // Give every parent an empty deps set EXCEPT index 600.
                if (i === 600) {
                    zsets.set(`bull:task:io:parent_${i}:dependencies`, ['bull:task:io:child_gone']);
                } else {
                    zsets.set(`bull:task:io:parent_${i}:dependencies`, []);
                }
            }

            const ioQueue = makePagingQueue('task:io', jobs);
            const client = makeClient(zsets);
            const queues = new Map<ResourceClass, Queue>([['io', ioQueue]]);
            const sweep = makeSweep({ queues, client });

            const result = await sweep.run();

            // The orphan at index 600 must have been reached and swept.
            expect(result.swept).toBe(1);
            expect(jobs[600].moveToCompleted).toHaveBeenCalledWith(
                { orphanSweep: true },
                '',
                false,
            );
            // Two pages were requested: [0,499] then [500,999].
            expect(ioQueue.getJobs).toHaveBeenCalledTimes(2);
        });

        it('warns when the per-tick page cap (20 pages) is exceeded by a full final page', async () => {
            // A queue that always returns a full page of 500 jobs (never short)
            // forces the sweep to hit the 20-page cap. Use no deps so nothing is
            // swept — we only care that the cap warn fires.
            const fullPage: FakeJob[] = Array.from({ length: 500 }, (_v, i) =>
                makeFakeJob(`p_${i}`),
            );
            const alwaysFullQueue = {
                name: 'task:io',
                getJobs: vi.fn(async () => fullPage),
                getJob: vi.fn(async () => null),
            } as unknown as Queue;

            // Empty deps for every parent → isOrphanedParent returns false.
            const client = makeClient(new Map());
            const queues = new Map<ResourceClass, Queue>([['io', alwaysFullQueue]]);
            const sweep = makeSweep({ queues, client });

            await sweep.run();

            // Exactly 20 pages requested (the cap), then warn.
            expect(alwaysFullQueue.getJobs).toHaveBeenCalledTimes(20);
            expect(
                logSpy.warn.mock.calls.some(([msg]) => String(msg).includes('page cap reached')),
            ).toBe(true);
        });
    });

    // ── F5.2: unregistered child queue → Redis ground-truth probe (per-class) ───
    describe('F5.2: per-class child whose queue is unregistered → Redis EXISTS probe', () => {
        it('sweeps the parent when the child key is absent in Redis', async () => {
            const parentJob = makeFakeJob('parent_f52pc');
            // Parent lives on io; dependency references a child on the `cpu` class
            // queue, but we register ONLY io → getQueue('cpu') is undefined.
            const ioQueue = makeFakeQueue('task:io', [parentJob], []);
            const zsets = new Map([
                ['bull:task:io:parent_f52pc:dependencies', ['bull:task:cpu:child_gone']],
            ]);
            // existingKeys empty → EXISTS returns 0 → child genuinely gone.
            const client = makeClient(zsets, new Set());
            const queues = new Map<ResourceClass, Queue>([['io', ioQueue]]);
            const sweep = makeSweep({ queues, client });

            const result = await sweep.run();
            expect(result.swept).toBe(1);
            expect(parentJob.moveToCompleted).toHaveBeenCalled();
        });

        it('does NOT sweep when Redis says the child key is present', async () => {
            const parentJob = makeFakeJob('parent_f52pc2');
            const ioQueue = makeFakeQueue('task:io', [parentJob], []);
            const zsets = new Map([
                ['bull:task:io:parent_f52pc2:dependencies', ['bull:task:cpu:child_live']],
            ]);
            // EXISTS returns 1 for the child key → assume alive.
            const client = makeClient(zsets, new Set(['bull:task:cpu:child_live']));
            const queues = new Map<ResourceClass, Queue>([['io', ioQueue]]);
            const sweep = makeSweep({ queues, client });

            const result = await sweep.run();
            expect(result.swept).toBe(0);
            expect(parentJob.moveToCompleted).not.toHaveBeenCalled();
        });
    });

    // ── Wave 8.5: per-task-queue mode ──────────────────────────────────────────
    describe('per-task mode (FEATURE_PER_TASK_QUEUES on)', () => {
        function makePerTaskSweep(taskQueues: Map<string, Queue>, client: FakeClient): OrphanSweep {
            return new OrphanSweep(
                () => undefined, // per-class getQueue unused in per-task mode
                async () =>
                    client as unknown as {
                        customCommand: (cmd: string[]) => Promise<unknown>;
                    },
                {
                    tasks: () => [...taskQueues.keys()],
                    getQueueByTaskId: (taskId) => taskQueues.get(taskId),
                },
            );
        }

        it('scans per-task queues and force-completes an orphaned parent', async () => {
            const parentJob = makeFakeJob('parent_pt', 'series-sync');
            // Parent lives on series-sync's per-task queue; its one dependency
            // references a child on media-probe's per-task queue that is gone.
            const seriesQueue = makeFakeQueue('series-sync', [parentJob], []);
            const probeQueue = makeFakeQueue('media-probe', [], []); // child gone
            const zsets = new Map([
                [
                    'bull:task:t:series-sync:parent_pt:dependencies',
                    ['bull:task:t:media-probe:child_gone'],
                ],
            ]);
            const client = makeClient(zsets);
            const sweep = makePerTaskSweep(
                new Map([
                    ['series-sync', seriesQueue],
                    ['media-probe', probeQueue],
                ]),
                client,
            );

            const result = await sweep.run();
            expect(result.queuesScanned).toBe(2);
            expect(result.swept).toBe(1);
            expect(parentJob.moveToCompleted).toHaveBeenCalled();
        });

        it('does NOT complete when a per-task child is still alive', async () => {
            const parentJob = makeFakeJob('parent_pt2', 'series-sync');
            const seriesQueue = makeFakeQueue('series-sync', [parentJob], []);
            // child_live IS alive on the media-probe per-task queue.
            const probeQueue = makeFakeQueue('media-probe', [], ['child_live']);
            const zsets = new Map([
                [
                    'bull:task:t:series-sync:parent_pt2:dependencies',
                    ['bull:task:t:media-probe:child_live'],
                ],
            ]);
            const client = makeClient(zsets);
            const sweep = makePerTaskSweep(
                new Map([
                    ['series-sync', seriesQueue],
                    ['media-probe', probeQueue],
                ]),
                client,
            );

            const result = await sweep.run();
            expect(result.swept).toBe(0);
            expect(parentJob.moveToCompleted).not.toHaveBeenCalled();
        });

        // ── F5.2: unregistered child task → Redis ground-truth probe ────────────
        it('F5.2: sweeps when child task is unregistered AND Redis says key gone', async () => {
            const parentJob = makeFakeJob('parent_f52', 'series-sync');
            const seriesQueue = makeFakeQueue('series-sync', [parentJob], []);
            // Dependency references child on `deleted-plugin`'s per-task queue,
            // which is NOT in the tasks() map → getQueueByTaskId undefined.
            const zsets = new Map([
                [
                    'bull:task:t:series-sync:parent_f52:dependencies',
                    ['bull:task:t:deleted-plugin:child_gone'],
                ],
            ]);
            // existingKeys empty → EXISTS on the child job key returns 0 → gone.
            const client = makeClient(zsets, new Set());
            const sweep = makePerTaskSweep(
                new Map([['series-sync', seriesQueue]]), // deleted-plugin absent
                client,
            );

            const result = await sweep.run();
            expect(result.swept).toBe(1);
            expect(parentJob.moveToCompleted).toHaveBeenCalled();
            // The probe targeted the dependency entry verbatim (the job-hash key).
            expect(client.customCommand).toHaveBeenCalledWith([
                'EXISTS',
                'bull:task:t:deleted-plugin:child_gone',
            ]);
        });

        it('F5.2: does NOT sweep when child task is unregistered but Redis says key present', async () => {
            const parentJob = makeFakeJob('parent_f52b', 'series-sync');
            const seriesQueue = makeFakeQueue('series-sync', [parentJob], []);
            const zsets = new Map([
                [
                    'bull:task:t:series-sync:parent_f52b:dependencies',
                    ['bull:task:t:deleted-plugin:child_live'],
                ],
            ]);
            // EXISTS returns 1 for the child key → assume alive.
            const client = makeClient(zsets, new Set(['bull:task:t:deleted-plugin:child_live']));
            const sweep = makePerTaskSweep(new Map([['series-sync', seriesQueue]]), client);

            const result = await sweep.run();
            expect(result.swept).toBe(0);
            expect(parentJob.moveToCompleted).not.toHaveBeenCalled();
        });

        it('F5.2: unparseable dependency entries → assume alive (not swept) + warn', async () => {
            // Genuinely malformed entries that reach childJobExists: a bare prefix
            // (no taskId/jobId) and a non-prefixed string. Both hit the
            // "unrecognized per-task dependency entry format" warn and assume-alive.
            for (const badEntry of ['bull:task:t:', 'garbage']) {
                logSpy.warn.mockClear();
                const parentJob = makeFakeJob('parent_bad', 'series-sync');
                const seriesQueue = makeFakeQueue('series-sync', [parentJob], []);
                const zsets = new Map([
                    ['bull:task:t:series-sync:parent_bad:dependencies', [badEntry]],
                ]);
                const client = makeClient(zsets, new Set());
                const sweep = makePerTaskSweep(new Map([['series-sync', seriesQueue]]), client);

                const result = await sweep.run();
                expect(result.swept).toBe(0);
                expect(parentJob.moveToCompleted).not.toHaveBeenCalled();
                expect(
                    logSpy.warn.mock.calls.some(([msg]) =>
                        String(msg).includes('unrecognized per-task dependency entry format'),
                    ),
                ).toBe(true);
                // Unparseable entries must NOT trigger a Redis EXISTS probe.
                expect(client.customCommand).not.toHaveBeenCalledWith(['EXISTS', badEntry]);
            }
        });

        it('F5.2: empty dependency entry is sanitized upstream (not swept)', async () => {
            // An empty-string member is dropped by parseZRangeResult's filter(Boolean)
            // before childJobExists runs, so the parent has no tracked deps and is
            // left for BullMQ — not force-completed.
            const parentJob = makeFakeJob('parent_empty', 'series-sync');
            const seriesQueue = makeFakeQueue('series-sync', [parentJob], []);
            const zsets = new Map([['bull:task:t:series-sync:parent_empty:dependencies', ['']]]);
            const client = makeClient(zsets, new Set());
            const sweep = makePerTaskSweep(new Map([['series-sync', seriesQueue]]), client);

            const result = await sweep.run();
            expect(result.swept).toBe(0);
            expect(parentJob.moveToCompleted).not.toHaveBeenCalled();
        });
    });
});

vi.mock('../../../task-runtime/authority/queue-write.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../task-runtime/authority/queue-write.js')>()),
    withTaskQueueWrite: async <T>(
        _sql: unknown,
        _authority: unknown,
        _operation: unknown,
        write: () => Promise<T>,
    ): Promise<T> => write(),
}));
